#!/usr/bin/env node
/**
 * dsh-relay router — 多设备 SaaS 路由(替换 SSH 反向隧道单机直连)
 *
 * 架构:
 *   手机 → nginx /remote/<deviceId>/<path> → relay-router(本进程,默认 13444)
 *        → WebSocket 隧道 → 各 Mac bridge → 127.0.0.1:3080(dsh web)
 *
 * 两个角色,同一端口:
 *   ① bridge 注册:bridge 主动 WS 连 /_bridge,发 { type:"tunnel-register", deviceId, token }
 *      校验 JWT(HS256,DSH_ENTERPRISE_JWT_SECRET)→ 建立 deviceId → ws 映射。
 *   ② 手机访问:HTTP /remote/<deviceId>/<path> 与 WS upgrade(同前缀)
 *      校验 dsh_token cookie → 查映射 → 复用 bridge 的 http/ws-* 帧协议透明代理。
 *
 * 商业模式(配额):
 *   限速:按用户套餐令牌桶(free 1Mbps / pro·pro_max 8Mbps),响应与 WS 下行逐块 pacing。
 *   限量:月流量按用户内存累计(free 1GB / pro·pro_max 不限),超限 HTTP 402 / WS 拒升级。
 *   JWT claims 带 plan(sub=userId),router 不再额外调 /api/me(简单起见;可扩展)。
 *
 * 环境变量:
 *   DSH_ROUTER_PORT          监听端口(默认 13444,替换原 SSH 隧道占用)
 *   DSH_ROUTER_HOST          监听地址(默认 0.0.0.0)
 *   DSH_ENTERPRISE_JWT_SECRET JWT 密钥(必填;从 NAS .env 读,勿写死)
 *   DSH_ROUTER_QUOTA_FREE_MAX_BPS / *_MONTHLY_GB …(可选,覆盖默认配额)
 * 命令行:
 *   node src/index.mjs [--env-file /path/.env]   # --env-file 简易 KEY=VALUE 加载
 *
 * 帧协议与 dsh-bridge.mjs 完全一致(含 __chunk 分块信封重装)。
 */

import http from "node:http";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { verifyJwt } from "./jwt.mjs";
import { createQuotaManager } from "./quotas.mjs";

// ---------- 环境/配置 ----------

// 简易 .env 加载(KEY=VALUE,# 注释,单双引号剥掉);在读取 env 之前执行
{
  const idx = process.argv.indexOf("--env-file");
  const file = idx > -1 ? process.argv[idx + 1] : "";
  if (file) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      console.error(`[router] 无法读取 env 文件 ${file}: ${e.message}`);
      process.exit(1);
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      let k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}

const PORT = Number(process.env.DSH_ROUTER_PORT || 13444);
const HOST = process.env.DSH_ROUTER_HOST || "0.0.0.0";
const JWT_SECRET = process.env.DSH_ENTERPRISE_JWT_SECRET || "";
if (!JWT_SECRET) {
  console.error("[router] 缺少 DSH_ENTERPRISE_JWT_SECRET:请设环境变量或 --env-file(密钥在 NAS .env,勿写死)");
  process.exit(1);
}

// v2 开源本地认证(自部署模式):DSH_LOCAL_JWT_SECRET 与 DSH_LOCAL_ACCESS_KEYS 同时设置时启用。
//   - 自部署者不依赖闭源 enterprise 账号体系:bridge/App 用访问密钥调 POST /_login 换本地 JWT;
//   - router 校验 JWT 时依次尝试 enterprise 密钥与本地密钥;
//   - 开源自部署与 SaaS 可随时切换(客户端连接模式配置,见 dsh-remote-ui)。
const LOCAL_JWT_SECRET = process.env.DSH_LOCAL_JWT_SECRET || "";
const LOCAL_ACCESS_KEYS = (process.env.DSH_LOCAL_ACCESS_KEYS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const LOCAL_AUTH_ENABLED = Boolean(LOCAL_JWT_SECRET && LOCAL_ACCESS_KEYS.length);
if (LOCAL_JWT_SECRET && !LOCAL_ACCESS_KEYS.length) {
  console.warn("[router] 已设 DSH_LOCAL_JWT_SECRET 但无 DSH_LOCAL_ACCESS_KEYS,本地认证未启用");
}
if (LOCAL_AUTH_ENABLED) console.log("[router] 本地认证已启用(开源自部署模式,POST /_login)");

/** 依次用 enterprise/本地密钥校验 JWT;返回 claims 或 null。 */
function verifyAnyJwt(token) {
  const claims = verifyJwt(token, JWT_SECRET);
  if (claims) return claims;
  if (LOCAL_AUTH_ENABLED) return verifyJwt(token, LOCAL_JWT_SECRET);
  return null;
}

/** 签发本地 JWT(自部署访问密钥换取;HS256,2 小时)。 */
function signLocalJwt(sub, plan) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ sub, plan, iat: now, exp: now + 7200 });
  const sig = createHmac("sha256", LOCAL_JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

// v2:套餐配置可从 enterprise public-config 轮询(后台全局配置生效);
// 自部署/无 enterprise 时可留空(用 env 覆盖或默认值)。
const QUOTA_CONFIG_URL = (process.env.DSH_QUOTA_CONFIG_URL || "").replace(/\/+$/, "");
const QUOTA_REFRESH_MS = Math.max(60_000, Number(process.env.DSH_QUOTA_REFRESH_MS) || 300_000);

const quotaOverrides = {};
for (const plan of ["free", "pro", "pro_max"]) {
  const mb = Number(process.env[`DSH_ROUTER_QUOTA_${plan.toUpperCase()}_MAX_BPS`]);
  const gb = Number(process.env[`DSH_ROUTER_QUOTA_${plan.toUpperCase()}_MONTHLY_GB`]);
  if (Number.isFinite(mb) && mb > 0) quotaOverrides[plan] = { ...(quotaOverrides[plan] || {}), maxBps: mb };
  if (Number.isFinite(gb) && gb >= 0) quotaOverrides[plan] = { ...(quotaOverrides[plan] || {}), monthlyGb: gb };
}
const quotas = createQuotaManager({ quotaByPlan: quotaOverrides });

// v2:后台可配的在线设备数上限(pro_max),来自 public-config plans.pro_max.online
let onlineLimitByPlan = { pro_max: Number(process.env.DSH_ROUTER_PRO_MAX_ONLINE || 3) };

/** 拉取 enterprise public-config 刷新配额/在线数(失败静默,保持现值)。 */
async function refreshQuotaConfig() {
  if (!QUOTA_CONFIG_URL) return;
  try {
    const r = await fetch(`${QUOTA_CONFIG_URL}/api/public-config`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const pub = await r.json();
    quotas.updateQuotaFromPublicConfig(pub);
    const online = Number(pub?.plans?.pro_max?.online);
    if (Number.isFinite(online) && online > 0) onlineLimitByPlan.pro_max = online;
    console.log(`[router] 配额已刷新: ${Object.entries(quotas.QUOTA_BY_PLAN).map(([p, q]) => `${p}=${(q.maxBps / 125000).toFixed(1)}Mbps${q.monthlyGb > 0 ? `/${q.monthlyGb}GB` : "/不限"}`).join("  ")}`);
  } catch {
    /* 保持当前配置 */
  }
}

// 设备 id 格式:dev-<12hex>(与 bridge 稳定 identity 一致);也兼容旧 bridge-xxx(宽松)
const DEVICE_ID_RE = /^(dev-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,63})$/i;
const MAX_BODY_BYTES = 64 * 1024 * 1024; // 请求体上限 64MB(nginx client_max_body_size 200m 之下)
const HTTP_REPLY_TIMEOUT_MS = 150_000;   // 等 bridge 回包上限(bridge 上游自身 120s)
const WS_OPEN_TIMEOUT_MS = 20_000;       // 等 bridge ws-open 应答上限
const WS_MAX_PAYLOAD = 256 * 1024 * 1024;

// ---------- 头处理 ----------

// 转发给 bridge 前剥离的 hop-by-hop / 本地头(业务头由 bridge 的 sanitizeRequestHeaders 再清洗)
const STRIP_FWD_HEADERS = new Set([
  "host", "connection", "upgrade", "keep-alive", "transfer-encoding",
  "content-length", "te", "trailer", "proxy-connection", "cookie"
]);
// 回给手机前剥离的实体/传输头(content-length 由 router 重算;content-encoding 需透传:
// bridge 对响应做 gzip 压缩时,手机浏览器必须看到该头才能正确解压)
const STRIP_RES_HEADERS = new Set([
  "content-length", "transfer-encoding",
  "connection", "keep-alive", "upgrade"
]);

function sanitizeFwdHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (STRIP_FWD_HEADERS.has(lk)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function sanitizeResHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (STRIP_RES_HEADERS.has(lk)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function getCookie(req, name) {
  const c = req.headers.cookie || "";
  for (const part of c.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

// ---------- 分块信封重装(与 bridge makeFrameReceiver 同构) ----------

/** 返回 receive(raw, onFrame):普通帧直通;__chunk 攒齐后回传解析结果。 */
function makeFrameReceiver() {
  const bufs = new Map();
  return function receive(raw, onFrame) {
    let text;
    if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else text = String(raw);
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (obj && obj.__chunk) {
      const c = obj.__chunk;
      let acc = bufs.get(c.id);
      if (!acc) {
        acc = { n: c.n, parts: [] };
        bufs.set(c.id, acc);
      }
      acc.parts[c.i] = c.data;
      if (acc.parts.filter(Boolean).length === acc.n) {
        bufs.delete(c.id);
        try {
          onFrame(JSON.parse(acc.parts.join("")));
        } catch {
          /* 损坏分块,丢弃 */
        }
      }
      return;
    }
    onFrame(obj);
  };
}

// ---------- 工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonBody(status, obj) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(obj) };
}

/** 直接向未完成 upgrade 的 socket 写一个 HTTP 错误响应。 */
function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  try {
    const body = message || http.STATUS_CODES[status] || "error";
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}\r\n` +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" +
        body
    );
  } catch {
    /* ignore */
  }
  socket.destroy();
}

/** 读取请求体(上限 MAX_BODY_BYTES,超限抛错)。 */
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** 限速写响应体:令牌桶逐块 pacing,尊重背压。 */
async function writePaced(res, buf, bucket) {
  const CHUNK = 32 * 1024;
  for (let i = 0; i < buf.length; i += CHUNK) {
    const chunk = buf.subarray(i, i + CHUNK);
    const wait = bucket.take(chunk.length);
    if (wait > 0) await sleep(wait);
    if (res.destroyed || res.writableEnded) return;
    if (!res.write(chunk)) {
      await new Promise((r) => res.once("drain", r));
    }
  }
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

/** WS 下行 pacing:每会话一个发送队列,逐条按令牌桶发送。发给手机的是原始数据(非帧)。 */
function enqueueWsMsg(sess, frame) {
  sess.queue.push(frame);
  if (sess.draining) return;
  sess.draining = true;
  void (async () => {
    while (sess.queue.length) {
      const f = sess.queue.shift();
      const payload = f.binary ? Buffer.from(String(f.data ?? ""), "base64") : String(f.data ?? "");
      const bytes = f.binary ? payload.length : Buffer.byteLength(payload);
      const wait = sess.bucket.take(bytes);
      if (wait > 0) await sleep(wait);
      if (sess.ws.readyState === WebSocket.OPEN) {
        try {
          sess.ws.send(payload, { binary: !!f.binary });
        } catch {
          break;
        }
      } else break;
    }
    sess.draining = false;
  })();
}

// ---------- 状态 ----------

/** deviceId → { ws, deviceId, userId, plan, name, connectedAt } */
const devices = new Map();
/** frameId → { res, method, path, deviceId, userId, plan, t0 } */
const pendingHttp = new Map();
/** frameId → { req, socket, head, deviceId, userId, plan, timer } */
const pendingUpgrade = new Map();
/** frameId → { ws, deviceId, userId, plan, bucket, queue, draining } */
const tunnelSessions = new Map();

let frameSeq = 0;
function nextFrameId() {
  return `r${(++frameSeq).toString(36)}`;
}

function sendToBridge(dev, obj) {
  if (!dev || dev.ws.readyState !== WebSocket.OPEN) return false;
  try {
    dev.ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

// ---------- 错误页 ----------

function errorPage(req, res, status, title, detail, extraHtml = "") {
  const wantHtml = /html/i.test(req.headers.accept || "");
  if (!wantHtml) {
    const r = jsonBody(status, { error: { code: status === 402 ? "quota_exceeded" : status === 403 ? "forbidden" : "device_offline", message: detail } });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} · dsh-remote</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center}
h1{font-size:20px;margin:0 0 10px}.code{color:#f85149;font-size:13px}.msg{color:#8b949e;font-size:14px;line-height:1.7}
a{color:#2f81f7;text-decoration:none}
.up{display:inline-block;margin-top:14px;padding:10px 22px;border-radius:8px;background:#2f81f7;color:#fff;font-weight:600}
</style></head><body>
<div class="card"><h1>${title}</h1><div class="code">HTTP ${status}</div>
<p class="msg">${detail}</p>
${extraHtml}
<p class="msg"><a href="/app/?logout=1">返回登录</a> · <a href="javascript:location.reload()">刷新</a></p></div>
</body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

/** 402 升级引导:仅给百分比(不给具体 GB),引导去推广页。 */
function quotaUpgradeHtml(usedBytes, limitBytes) {
  const pct = limitBytes > 0 ? Math.min(100, Math.floor((usedBytes / limitBytes) * 100)) : 0;
  return `<p class="msg">本月流量已用 <b>${pct}%</b>,免费额度已用完。升级 PRO 不限流量,并解除带宽限制。</p>
<a class="up" href="/app/promo">查看升级方案</a>`;
}

// ---------- 请求路由 ----------

function parseRemote(urlPath) {
  const m = urlPath.match(/^\/remote\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  let deviceId;
  try {
    deviceId = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!DEVICE_ID_RE.test(deviceId)) return null;
  const path = m[2] || "/";
  if (path.includes("..") || path.includes("\\")) return null;
  return { deviceId, path };
}

/** 取「/remote/<deviceId>/<path>[?query]」,path 含查询串,保持原样转发。 */
function remotePathWithQuery(url) {
  return url.pathname + (url.search || "");
}

/** 解析路由:优先 /remote/<deviceId>/<path>;否则按 dsh_device cookie 路由(根路径,兼容 dsh web 绝对路径)。 */
function resolveRoute(req, url) {
  const m = url.pathname.match(/^\/remote\/([^/]+)(\/.*)?$/);
  if (m) {
    let deviceId;
    try {
      deviceId = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    if (!DEVICE_ID_RE.test(deviceId)) return null;
    const path = m[2] || "/";
    if (path.includes("..") || path.includes("\\")) return null;
    return { deviceId, path: path + (url.search || "") };
  }
  // 根路径兜底:按 dsh_device cookie 路由(手机登录后跳 / 时设置)
  const cookieDevice = getCookie(req, "dsh_device");
  if (!cookieDevice || !DEVICE_ID_RE.test(cookieDevice)) return null;
  return { deviceId: cookieDevice, path: url.pathname + (url.search || "") };
}

/** 认证 + 设备归属 + 配额 三板斧;通过返回 { claims, dev, quota }。 */
function authorizeRemote(req, deviceId) {
  const claims = verifyAnyJwt(getCookie(req, "dsh_token"));
  if (!claims) return { error: "unauthorized" };
  const dev = devices.get(deviceId);
  if (!dev || dev.ws.readyState !== WebSocket.OPEN) return { error: "offline" };
  if (String(dev.userId) !== String(claims.sub)) return { error: "forbidden" };
  const quota = quotas.checkQuota(claims.plan, claims.sub);
  if (!quota.ok) return { error: "quota", quota };
  return { claims, dev, quota };
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://router");
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }

  // 本地认证登录:POST /_login {key}(开源自部署模式)。
  // 校验 DSH_LOCAL_ACCESS_KEYS 中的访问密钥 → 签发本地 JWT(plan=pro_max,2 小时)。
  // 未启用本地认证时返回 404。
  if (req.method === "POST" && url.pathname === "/_login") {
    if (!LOCAL_AUTH_ENABLED) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "本地认证未启用(本服务为 SaaS 模式)" } }));
      return;
    }
    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.length) body = JSON.parse(raw.toString("utf8"));
    } catch {
      const r = jsonBody(400, { error: { code: "bad_json", message: "请求体必须是 JSON" } });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!LOCAL_ACCESS_KEYS.includes(key)) {
      const r = jsonBody(401, { error: { code: "invalid_access_key", message: "访问密钥无效" } });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }
    const token = signLocalJwt("local", "pro_max");
    const r = jsonBody(200, { token, plan: "pro_max", mode: "local" });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }

  // 实时设备列表:GET /_devices(同源只读)。校验 dsh_token JWT,只返回 JWT 所属用户
  // 当前 WebSocket 为 OPEN 的设备 id/name,不返回其他用户或连接内部信息。
  if (req.method === "GET" && url.pathname === "/_devices") {
    const claims = verifyAnyJwt(getCookie(req, "dsh_token"));
    if (!claims) {
      const r = jsonBody(401, { error: { code: "unauthorized", message: "登录状态无效或已过期" } });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }
    const list = [...devices.values()]
      .filter((d) => d.ws.readyState === WebSocket.OPEN && String(d.userId) === String(claims.sub))
      .map((d) => ({ id: d.deviceId, name: d.name || d.deviceId }));
    const r = jsonBody(200, { devices: list });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }

  // 流量用量:GET /_quota(同源只读)。校验 dsh_token JWT,返回生效套餐与月流量用量。
  // 免费用户据此展示"已用百分比"(不给具体 GB);pro/pro_max 不限流量(limit_bytes=0)。
  if (req.method === "GET" && url.pathname === "/_quota") {
    const claims = verifyAnyJwt(getCookie(req, "dsh_token"));
    if (!claims) {
      const r = jsonBody(401, { error: { code: "unauthorized", message: "登录状态无效或已过期" } });
      res.writeHead(r.status, r.headers);
      res.end(r.body);
      return;
    }
    const q = quotas.checkQuota(claims.plan, claims.sub);
    const pct = q.limitBytes > 0 ? Math.min(100, Math.floor((q.usedBytes / q.limitBytes) * 100)) : 0;
    const r = jsonBody(200, {
      quota: {
        plan: q.plan,
        limit_enabled: q.limitBytes > 0,
        used_bytes: q.usedBytes,
        limit_bytes: q.limitBytes,
        percent: pct
      }
    });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }

  const parsed = resolveRoute(req, url);
  if (!parsed) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found (router: 请使用 /remote/<deviceId>/<path>)");
    return;
  }
  const { deviceId, path } = parsed;
  const auth = authorizeRemote(req, deviceId);
  if (auth.error === "unauthorized") {
    res.writeHead(302, { Location: "/login/", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (auth.error === "offline") {
    errorPage(req, res, 502, "电脑端未连接", `设备 ${deviceId} 的 bridge 当前离线。请先在电脑上运行 dsh-bridge 隧道模式,再刷新本页。`);
    return;
  }
  if (auth.error === "forbidden") {
    errorPage(req, res, 403, "无权访问", "该设备不属于当前账号。");
    return;
  }
  if (auth.error === "quota") {
    const { usedBytes, limitBytes } = auth.quota;
    errorPage(req, res, 402, "本月流量已用完", "免费额度已用完,请升级 PRO 或等待下月重置。", quotaUpgradeHtml(usedBytes, limitBytes));
    return;
  }
  const { claims, dev } = auth;

  // 读请求体(上限内)→ 发帧给 bridge
  let bodyBuf = Buffer.alloc(0);
  try {
    bodyBuf = await readBody(req);
  } catch {
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "body_too_large", message: "请求体超过 64MB" } }));
    return;
  }

  quotas.recordTraffic(deviceId, bodyBuf.length, claims.sub); // 上行计入月流量

  const id = nextFrameId();
  const frame = {
    id,
    type: "http",
    method: req.method || "GET",
    path,
    headers: sanitizeFwdHeaders(req.headers),
    ...(bodyBuf.length ? { body: bodyBuf.toString("base64"), bodyBase64: true } : {})
  };
  pendingHttp.set(id, { res, method: req.method || "GET", path, deviceId, userId: claims.sub, plan: claims.plan, t0: Date.now() });
  if (!sendToBridge(dev, frame)) {
    pendingHttp.delete(id);
    errorPage(req, res, 502, "电脑端未连接", `设备 ${deviceId} 的 bridge 连接已断开。`);
    return;
  }
  const timer = setTimeout(() => {
    const p = pendingHttp.get(id);
    if (p && p.res === res && !res.writableEnded) {
      pendingHttp.delete(id);
      errorPage(req, res, 504, "上游超时", "bridge 未在限定时间内返回,请重试。");
    }
  }, HTTP_REPLY_TIMEOUT_MS);
  pendingHttp.set(id, { ...pendingHttp.get(id), timer });
  res.on("close", () => {
    const p = pendingHttp.get(id);
    if (p && p.res === res) {
      pendingHttp.delete(id);
      clearTimeout(p.timer);
    }
  });
});

// ---------- bridge 注册 + 手机 WS ----------

const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

bridgeWss.on("connection", (ws, req) => {
  let dev = null;
  const regTimer = setTimeout(() => {
    if (!dev) {
      try {
        ws.close(4001, "register timeout");
      } catch {
        ws.terminate();
      }
    }
  }, 20_000);
  const receive = makeFrameReceiver();
  ws.on("message", (raw) => {
    receive(raw, (frame) => {
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "tunnel-register") {
        const { deviceId, token, name } = frame;
        const claims = verifyAnyJwt(token);
        if (!claims) {
          try {
            ws.send(JSON.stringify({ type: "tunnel-register-err", code: "bad_token", message: "JWT 无效或过期" }));
            ws.close(4003, "bad token");
          } catch {
            ws.terminate();
          }
          return;
        }
        if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
          try {
            ws.send(JSON.stringify({ type: "tunnel-register-err", code: "bad_device", message: "deviceId 格式非法" }));
            ws.close(4002, "bad deviceId");
          } catch {
            ws.terminate();
          }
          return;
        }
        const existing = devices.get(deviceId);
        if (existing && existing.ws !== ws) {
          try {
            existing.ws.close(4000, "replaced by new connection");
          } catch {
            existing.ws.terminate();
          }
          cleanupDevice(existing);
        }
        dev = {
          ws,
          deviceId,
          userId: String(claims.sub),
          plan: claims.plan || "free",
          name: typeof name === "string" ? name : deviceId,
          connectedAt: Date.now()
        };
        // v2:pro_max 同时在线设备数上限(后台可配);超限拒绝新连接
        if (dev.plan === "pro_max") {
          const online = [...devices.values()].filter(
            (d) => d !== dev && d.ws.readyState === WebSocket.OPEN && String(d.userId) === String(claims.sub)
          ).length;
          if (online >= onlineLimitByPlan.pro_max) {
            try {
              ws.send(JSON.stringify({
                type: "tunnel-register-err",
                code: "online_limit",
                message: `Pro Max 同时在线设备数已达上限(${onlineLimitByPlan.pro_max}),请先在手机端设备列表断开/移除其他设备`
              }));
              ws.close(4004, "online limit");
            } catch {
              ws.terminate();
            }
            return;
          }
        }
        devices.set(deviceId, dev);
        clearTimeout(regTimer);
        try {
          ws.send(JSON.stringify({ type: "tunnel-register-ok", deviceId }));
        } catch {
          /* ignore */
        }
        console.log(`[router] bridge 注册: ${deviceId} (user=${dev.userId}, plan=${dev.plan}, name=${dev.name})`);
        return;
      }
      // 注册后的业务帧(bridge 回包)
      if (!dev) return;
      try {
        onBridgeFrame(dev, frame);
      } catch (e) {
        console.log(`[router] 帧处理错误(${dev.deviceId}): ${e.message}`);
      }
    });
  });
  ws.on("close", () => {
    clearTimeout(regTimer);
    if (dev) cleanupDevice(dev);
  });
  ws.on("error", () => {});
});

function cleanupDevice(dev) {
  if (devices.get(dev.deviceId) === dev) devices.delete(dev.deviceId);
  console.log(`[router] bridge 断开: ${dev.deviceId}`);
  for (const [id, p] of pendingHttp) {
    if (p.deviceId === dev.deviceId) {
      pendingHttp.delete(id);
      clearTimeout(p.timer);
      if (!p.res.writableEnded) {
        p.res.writeHead(502, { "content-type": "application/json" });
        p.res.end(JSON.stringify({ error: { code: "device_offline", message: "bridge 断开,请重试" } }));
      }
    }
  }
  for (const [id, pu] of pendingUpgrade) {
    if (pu.deviceId === dev.deviceId) {
      pendingUpgrade.delete(id);
      clearTimeout(pu.timer);
      rejectUpgrade(pu.socket, 502, "bridge 断开,请重试");
    }
  }
  for (const [id, sess] of tunnelSessions) {
    if (sess.deviceId === dev.deviceId) {
      tunnelSessions.delete(id);
      try {
        sess.ws.close(1012, "bridge offline");
      } catch {
        sess.ws.terminate();
      }
    }
  }
}

// ---------- bridge 回包分发 ----------

function onBridgeFrame(dev, frame) {
  const { id, type } = frame;
  if (id === undefined || id === null) return;

  if (type === "http") {
    const p = pendingHttp.get(id);
    if (!p) return;
    pendingHttp.delete(id);
    clearTimeout(p.timer);
    const q = quotas.checkQuota(p.plan, p.userId);
    if (!q.ok) {
      errorPage(p.req ?? p.res, p.res, 402, "本月流量已用完", "免费额度已用完,请升级 PRO 或等待下月重置。", quotaUpgradeHtml(q.usedBytes, q.limitBytes));
      return;
    }
    const buf = frame.bodyBase64
      ? Buffer.from(String(frame.body || ""), "base64")
      : Buffer.from(String(frame.body || ""), "utf8");
    quotas.recordTraffic(p.deviceId, buf.length, p.userId); // 下行计入月流量
    const status = Number(frame.status) || 502;
    const headers = sanitizeResHeaders(frame.headers || {});
    headers["content-length"] = String(buf.length);
    const hasBody = p.method !== "HEAD" && status >= 200 && status !== 204 && status !== 304;
    p.res.writeHead(status, headers);
    if (!hasBody || buf.length === 0) {
      p.res.end();
      return;
    }
    const bucket = quotas.bucketFor(p.plan, p.userId);
    void writePaced(p.res, buf, bucket);
    return;
  }

  if (type === "ws-open") {
    const pu = pendingUpgrade.get(id);
    if (!pu) return;
    pendingUpgrade.delete(id);
    clearTimeout(pu.timer);
    const dev2 = devices.get(pu.deviceId);
    if (!frame.ok) {
      rejectUpgrade(pu.socket, Number(frame.code) || 502, String(frame.reason || "上游 WebSocket 打开失败"));
      return;
    }
    const q = quotas.checkQuota(pu.plan, pu.userId);
    if (!q.ok) {
      rejectUpgrade(pu.socket, 402, "本月流量已用完");
      return;
    }
    if (pu.socket.destroyed) return; // 手机已断开
    tunnelWss.handleUpgrade(pu.req, pu.socket, pu.head, (ws) => {
      const sess = {
        ws,
        deviceId: pu.deviceId,
        userId: pu.userId,
        plan: pu.plan,
        bucket: quotas.bucketFor(pu.plan, pu.userId),
        queue: [],
        draining: false
      };
      tunnelSessions.set(id, sess);
      ws.on("message", (data, isBinary) => {
        const payload = isBinary ? Buffer.from(data).toString("base64") : data.toString();
        quotas.recordTraffic(pu.deviceId, isBinary ? Math.ceil((payload.length * 3) / 4) : Buffer.byteLength(payload), pu.userId);
        sendToBridge(dev2, { id, type: "ws-msg", data: payload, binary: isBinary });
      });
      ws.on("close", () => {
        tunnelSessions.delete(id);
        sendToBridge(dev2, { id, type: "ws-close", code: 1000 });
      });
      ws.on("error", () => {});
    });
    return;
  }

  if (type === "ws-msg") {
    const sess = tunnelSessions.get(id);
    if (!sess) return;
    const payload = frame.binary ? String(frame.data || "") : String(frame.data ?? "");
    quotas.recordTraffic(
      sess.deviceId,
      frame.binary ? Math.ceil((payload.length * 3) / 4) : Buffer.byteLength(payload),
      sess.userId
    );
    enqueueWsMsg(sess, frame);
    return;
  }

  if (type === "ws-close") {
    const sess = tunnelSessions.get(id);
    if (!sess) return;
    tunnelSessions.delete(id);
    try {
      sess.ws.close(frame.code && typeof frame.code === "number" ? frame.code : 1000, String(frame.reason || ""));
    } catch {
      sess.ws.terminate();
    }
  }
}

// ---------- upgrade 路由 ----------

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://router");
  } catch {
    socket.destroy();
    return;
  }

  // bridge 注册通道
  if (url.pathname === "/_bridge" || url.pathname === "/_bridge/") {
    bridgeWss.handleUpgrade(req, socket, head, (ws) => bridgeWss.emit("connection", ws, req));
    return;
  }

  // 手机 WS 隧道:/remote/<deviceId>/<path>
  const parsed = resolveRoute(req, url);
  if (!parsed) {
    rejectUpgrade(socket, 404, "not found");
    return;
  }
  const { deviceId, path } = parsed;
  const auth = authorizeRemote(req, deviceId);
  if (auth.error === "unauthorized") {
    rejectUpgrade(socket, 302, "未登录,请先 /login/ 登录");
    return;
  }
  if (auth.error === "offline") {
    rejectUpgrade(socket, 502, "电脑端未连接(设备 " + deviceId + " 的 bridge 当前离线)");
    return;
  }
  if (auth.error === "forbidden") {
    rejectUpgrade(socket, 403, "无权访问该设备");
    return;
  }
  if (auth.error === "quota") {
    rejectUpgrade(socket, 402, "本月流量已用完,请升级套餐");
    return;
  }
  const { claims, dev } = auth;

  const id = nextFrameId();
  const pu = {
    req,
    socket,
    head,
    deviceId,
    userId: claims.sub,
    plan: claims.plan,
    timer: null,
    path
  };
  pendingUpgrade.set(id, pu);
  pu.timer = setTimeout(() => {
    const cur = pendingUpgrade.get(id);
    if (cur === pu) {
      pendingUpgrade.delete(id);
      rejectUpgrade(pu.socket, 504, "bridge ws-open 应答超时");
    }
  }, WS_OPEN_TIMEOUT_MS);
  socket.on("close", () => {
    const cur = pendingUpgrade.get(id);
    if (cur === pu) {
      pendingUpgrade.delete(id);
      clearTimeout(pu.timer);
    }
  });
  sendToBridge(dev, { id, type: "ws-open", path, headers: sanitizeFwdHeaders(req.headers) });
});

// ---------- 启动 ----------

server.listen(PORT, HOST, () => {
  console.log(`[router] 监听 ${HOST}:${PORT}(HTTP /remote/<deviceId>/ + WS /_bridge)`);
  console.log(`[router] 配额: ${Object.entries(quotas.QUOTA_BY_PLAN).map(([p, q]) => `${p}=${(q.maxBps / 125000).toFixed(1)}Mbps${q.monthlyGb > 0 ? `/${q.monthlyGb}GB` : "/不限"}`).join("  ")}`);
  if (QUOTA_CONFIG_URL) {
    console.log(`[router] 配额来源: enterprise public-config(${QUOTA_CONFIG_URL}),每 ${QUOTA_REFRESH_MS / 1000}s 刷新`);
    void refreshQuotaConfig();
    setInterval(refreshQuotaConfig, QUOTA_REFRESH_MS);
  }
});

// 优雅退出
function shutdown() {
  console.log("[router] 关闭中...");
  try {
    for (const dev of devices.values()) dev.ws.close(1001, "router shutdown");
    for (const sess of tunnelSessions.values()) {
      try {
        sess.ws.close(1001, "router shutdown");
      } catch {
        sess.ws.terminate();
      }
    }
    for (const pu of pendingUpgrade.values()) rejectUpgrade(pu.socket, 503, "router shutdown");
    for (const p of pendingHttp.values()) {
      if (!p.res.writableEnded) {
        p.res.writeHead(503, { "content-type": "application/json" });
        p.res.end(JSON.stringify({ error: { code: "shutdown", message: "router 关闭" } }));
      }
    }
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

#!/usr/bin/env node
/**
 * dsh-remote router — 多设备 SaaS 路由(替换 SSH 反向隧道单机直连)
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
 * 认证:JWT claims 带 sub=userId,用于设备归属校验(一台设备只允许其绑定账号访问)。
 *
 * 环境变量:
 *   DSH_ROUTER_PORT          监听端口(默认 13444,替换原 SSH 隧道占用)
 *   DSH_ROUTER_HOST          监听地址(默认 0.0.0.0)
 *   DSH_ENTERPRISE_JWT_SECRET JWT 密钥(必填;从配置文件读,勿写死)
 *   DSH_INTERNAL_TOKEN        enterprise 内部里程碑上报密钥(可选;开启「成功使用/连接成功」统计)
 *   DSH_ENTERPRISE_INTERNAL_URL enterprise 内部端点基址(默认 http://127.0.0.1:13446)
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
import { createLogger } from "./logger.mjs";

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

// 日志输出:默认只写 stdout;设置 DSH_LOG_DIR 后同时落盘并按大小轮转。
// 必须在 .env 加载之后创建 —— DSH_LOG_DIR 通常写在 .env 里。
const logger = createLogger({ name: "router" });

const PORT = Number(process.env.DSH_ROUTER_PORT || 13444);
const HOST = process.env.DSH_ROUTER_HOST || "0.0.0.0";
const JWT_SECRET = process.env.DSH_ENTERPRISE_JWT_SECRET || "";
if (!JWT_SECRET) {
  logger.error("[router] 缺少 DSH_ENTERPRISE_JWT_SECRET:请设环境变量或 --env-file(密钥从配置文件读取,勿写死在代码里)");
  process.exit(1);
}

// v2 开源本地认证(自部署模式):DSH_LOCAL_JWT_SECRET 与 DSH_LOCAL_ACCESS_KEYS 同时设置时启用。
//   - 自部署者不依赖闭源 enterprise 账号体系:bridge/App 用访问密钥调 POST /_login 换本地 JWT;
//   - router 校验 JWT 时依次尝试 enterprise 密钥与本地密钥;
//   - 开源自部署与 SaaS 可随时切换(客户端连接模式配置,见 dsh-remote-web)。
const LOCAL_JWT_SECRET = process.env.DSH_LOCAL_JWT_SECRET || "";
const LOCAL_ACCESS_KEYS = (process.env.DSH_LOCAL_ACCESS_KEYS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const LOCAL_AUTH_ENABLED = Boolean(LOCAL_JWT_SECRET && LOCAL_ACCESS_KEYS.length);
if (LOCAL_JWT_SECRET && !LOCAL_ACCESS_KEYS.length) {
  logger.warn("[router] 已设 DSH_LOCAL_JWT_SECRET 但无 DSH_LOCAL_ACCESS_KEYS,本地认证未启用");
}
if (LOCAL_AUTH_ENABLED) logger.info("[router] 本地认证已启用(开源自部署模式,POST /_login)");

/**
 * bridge 重连日志抑制。
 * 客户端异常重连时,「注册/断开」会在短时间内刷出成千上万条,把真正的业务日志淹没。
 * 策略:每设备每方向,窗口内前 N 条逐条记;其余折叠,窗口结束时补一条汇总。
 *   DSH_LOG_CHURN_BURST=0 可关闭抑制(恢复逐条),默认 3。
 */
const CHURN_WINDOW_MS = 60_000;
const CHURN_BURST = Math.max(0, Number(process.env.DSH_LOG_CHURN_BURST ?? 3));
const churnState = new Map(); // `${deviceId}:${kind}` -> { windowStart, logged, suppressed }

function flushChurn(key, st) {
  if (st.suppressed > 0) {
    const [deviceId, kind] = key.split(":");
    logger.warn(`[router] bridge ${kind} 风暴汇总: ${deviceId} 在上一窗口内另有 ${st.suppressed} 次未逐条记录(客户端可能重连异常)`);
  }
  st.suppressed = 0;
  st.logged = 0;
  st.windowStart = Date.now();
}

function logBridgeChurn(deviceId, kind, detail) {
  const key = `${deviceId}:${kind}`;
  const now = Date.now();
  let st = churnState.get(key);
  if (!st) {
    st = { windowStart: now, logged: 0, suppressed: 0 };
    churnState.set(key, st);
  } else if (now - st.windowStart >= CHURN_WINDOW_MS) {
    flushChurn(key, st);
  }
  if (st.logged < CHURN_BURST) {
    st.logged += 1;
    // 保持与改动前完全相同的日志文案:`bridge 注册: dev-xxx (user=.., plan=.., name=..)`
    logger.info(`[router] bridge ${kind}: ${deviceId}${detail ? ` ${detail}` : ""}`);
  } else {
    st.suppressed += 1;
  }
}

// 周期性把「抑制中但窗口内不再有新事件」的设备汇总出去,避免最后一次汇总丢失。
const churnFlushTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, st] of churnState) {
    if (now - st.windowStart >= CHURN_WINDOW_MS && st.suppressed > 0) flushChurn(key, st);
  }
}, CHURN_WINDOW_MS);
churnFlushTimer.unref?.();

/**
 * 服务端里程碑上报(供「成功使用 / 连接成功」统计;服务端到服务端,无任何客户端上报)。
 * router 观察到用户真实跑通的关键节点后,向 enterprise 内部端点 POST 一次(每用户每 kind 仅首条):
 *   - devices:手机端拉取到非空设备列表(说明登录+设备可见)
 *   - remote:首次远程控制成功(某次上游 http/ws 请求真正打通,说明用户点进去用上了)
 * 环境变量:DSH_INTERNAL_TOKEN(与 enterprise 一致)/ DSH_ENTERPRISE_INTERNAL_URL(默认本机 13446)。
 * 失败静默,绝不影响业务路径。
 */
const INTERNAL_TOKEN = process.env.DSH_INTERNAL_TOKEN || "";
const ENTERPRISE_INTERNAL_URL = (process.env.DSH_ENTERPRISE_INTERNAL_URL || "http://127.0.0.1:13446").replace(/\/+$/, "");
const reportedMilestones = new Set(); // `${kind}:${userId}` 去重
function reportMilestone(userId, kind) {
  try {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0 || !INTERNAL_TOKEN) return;
    const key = `${kind}:${uid}`;
    if (reportedMilestones.has(key)) return;
    reportedMilestones.add(key);
    const url = `${ENTERPRISE_INTERNAL_URL}/api/internal/milestone`;
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: JSON.stringify({ user_id: uid, kind }),
      signal: AbortSignal.timeout(3000)
    }).catch(() => { /* 静默:enterprise 不可达不影响隧道 */ });
  } catch { /* ignore */ }
}

/**
 * 上报设备在线态给企业端(权威在线信号)。
 *
 * 为什么需要:企业端 `devices.online` 列历史上只置 1、无清 0 路径(实测 15/15 恒为在线),
 * 而 `last_seen_at` 只在 bridge 重新登记时更新 —— 长时间运行的 bridge 会被误判离线。
 * router 是**唯一真正知道 bridge 当前是否在线**的地方(内存 devices Map),因此在:
 *   ① bridge 注册成功 → 立刻上报 online=true;
 *   ② 断开(cleanupDevice)→ 上报 online=false;
 *   ③ 每 60s 给仍在线设备各补一次 true(**兼作心跳**,让企业端的 last_seen 新鲜度口径可用)。
 * 失败静默:企业端不可达绝不影响隧道业务。
 */
const PRESENCE_SWEEP_MS = 60_000;
function reportPresence(deviceId, userId, online) {
  try {
    const uid = Number(userId);
    if (!deviceId || !Number.isInteger(uid) || uid <= 0 || !INTERNAL_TOKEN) return;
    fetch(`${ENTERPRISE_INTERNAL_URL}/api/internal/device-presence`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: JSON.stringify({ device_id: String(deviceId), user_id: uid, online: online === true }),
      signal: AbortSignal.timeout(3000)
    }).catch(() => { /* 静默:企业端不可达不影响隧道 */ });
  } catch { /* ignore */ }
}

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

// 设备 id 格式:dev-<12hex>(与 bridge 稳定 identity 一致);也兼容旧 bridge-xxx(宽松)
const DEVICE_ID_RE = /^(dev-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,63})$/i;
/** 本中继支持的追加帧能力(注册 ack 下发给 bridge;决定它敢不敢用流式/中止帧)。 */
const ROUTER_FRAME_CAPS = ["http-stream"];

const MAX_BODY_BYTES = 64 * 1024 * 1024; // 请求体上限 64MB(nginx client_max_body_size 200m 之下)
const HTTP_REPLY_TIMEOUT_MS = 150_000;   // 等 bridge 回包上限(bridge 上游自身 120s)
const WS_OPEN_TIMEOUT_MS = 20_000;       // 等 bridge ws-open 应答上限
const WS_MAX_PAYLOAD = 256 * 1024 * 1024;

// ---------- 头处理 ----------

// 转发给 bridge 前剥离的 hop-by-hop / 本地头(业务头由 bridge 的 sanitizeRequestHeaders 再清洗)
const STRIP_FWD_HEADERS = new Set([
  "host", "connection", "upgrade", "keep-alive", "transfer-encoding",
  "content-length", "te", "trailer", "proxy-connection", "cookie",
  "x-dsh-remote-device" // channel 模式专用设备选择头,不透传给上游
]);
// 回给手机前剥离的实体/传输头(content-length 由 router 重算;content-encoding 需透传:
// bridge 对响应做 gzip 压缩时,手机浏览器必须看到该头才能正确解压)
const STRIP_RES_HEADERS = new Set([
  "content-length", "transfer-encoding",
  "connection", "keep-alive", "upgrade"
]);

/** 信封信号头检测(E2EE 密文帧;router 不解析 body,仅识别/计数)。 */
function isE2eeMarked(headers) {
  const ct = String(headers?.["content-type"] || "").toLowerCase();
  return ct.startsWith("application/vnd.dsh.e2ee-v2") || Boolean(headers?.["x-dsh-e2ee"]);
}

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

/**
 * 设备无关的静态资源兜底(2026-09-23)。
 *
 * 问题(用户实测的 manifest 404):`dsh web` 的 HTML 里有 `<base href="/">`,于是
 * `./manifest.webmanifest` **永远**解析成根路径 `/manifest.webmanifest`;而根路径要按
 * `dsh_device` cookie 才能路由到某一台设备。浏览器取 **PWA manifest** 时是不带凭据的
 * (manifest 抓取按规范以 credentials:omit 进行),所以根路径解析不到设备 → 404。
 *
 * 为什么由 router 自己发:manifest 内容与"哪台设备"无关(start_url 指向手机外壳 `/app/`),
 * 没必要为它挑一台设备 —— 何况这类请求本来就没凭据,替它选设备反而是越权风险。
 * 只在**解析不到设备**时兜底:能正常路由的请求一律原样转发上游,行为不变。
 */
const REMOTE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
  + '<rect width="64" height="64" rx="14" fill="#111827"/>'
  + '<path d="M20 44V20h9c7 0 12 4.6 12 12s-5 12-12 12h-9zm7-6h2c3.6 0 6-2.3 6-6s-2.4-6-6-6h-2v12z" fill="#f9fafb"/>'
  + "</svg>";
const DEVICE_FREE_ASSETS = new Map([
  ["/manifest.webmanifest", {
    type: "application/manifest+json; charset=utf-8",
    body: JSON.stringify({
      id: "/app/",
      name: "DSH 远程控制",
      short_name: "DSH 远程",
      description: "在手机上远程控制电脑上的 DeepSeek Harness",
      start_url: "/app/",
      scope: "/",
      display: "standalone",
      background_color: "#111827",
      theme_color: "#111827",
      icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }]
    })
  }],
  ["/favicon.svg", { type: "image/svg+xml; charset=utf-8", body: REMOTE_ICON_SVG }]
]);

/** 若该路径属于"设备无关静态资源",直接本地应答;否则返回 false(调用方继续走 404 流程)。 */
function serveDeviceFreeAsset(res, pathname) {
  const asset = DEVICE_FREE_ASSETS.get(pathname);
  if (!asset) return false;
  const body = Buffer.from(asset.body, "utf8");
  res.writeHead(200, {
    "content-type": asset.type,
    "content-length": String(body.length),
    "cache-control": "public, max-age=3600"
  });
  res.end(body);
  return true;
}

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

/** 写响应体,尊重背压。 */
async function writeBody(res, buf) {
  const CHUNK = 32 * 1024;
  for (let i = 0; i < buf.length; i += CHUNK) {
    const chunk = buf.subarray(i, i + CHUNK);
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

/** WS 下行:每会话一个发送队列,按顺序发出。发给手机的是原始数据(非帧)。 */
function enqueueWsMsg(sess, frame) {
  sess.queue.push(frame);
  if (sess.draining) return;
  sess.draining = true;
  void (async () => {
    while (sess.queue.length) {
      const f = sess.queue.shift();
      const payload = f.binary ? Buffer.from(String(f.data ?? ""), "base64") : String(f.data ?? "");
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
/** frameId → { ws, deviceId, userId, plan, queue, draining } */
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

/**
 * 判定「这是用户点进来的页面导航」——只有页面导航才做 302 引导回 APP 外壳。
 *
 * 依据（按可靠性排序）：
 *   ① Fetch Metadata（Chrome/Safari 新版）sec-fetch-mode=navigate + sec-fetch-dest=document/iframe；
 *   ② 回退到 Accept: text/html（老浏览器）。
 * 子资源（/assets/*.js、/plugins/*、图片）与 XHR 一律不走引导 —— 否则客户端会把一张
 * HTML 页面当成 JS/JSON 解析，表现成"界面白屏/报一堆解析错误"。
 */
function isDocNavigation(req) {
  const mode = String(req.headers["sec-fetch-mode"] || "").toLowerCase();
  const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
  if (mode || dest) {
    if (mode && mode !== "navigate") return false;
    if (dest && dest !== "document" && dest !== "iframe") return false;
    return true;
  }
  return /html/i.test(req.headers.accept || "");
}

/**
 * 会话/设备出问题时的**统一引导**：把用户送回 APP 外壳（设备列表或登录页），
 * 而不是甩一张报错页或一句纯文本 404（2026-09-19 用户反馈：
 * 「会话过期/设备离线时状态不对，应该跳回设备拉取的那个界面」「不能让用户直接遇到白屏报错」）。
 *
 * 为什么带上 reason / device：外壳页据此给出**能照做的一句话**（会话过期→去重新登录；
 * 设备离线→提醒电脑端 bridge 没在跑），而不是默默回到列表让用户猜发生了什么。
 * 为什么顺手清 dsh_device cookie：这台设备已经不可用（离线/不属于本账号/已删除），
 * 留着它会让"回到列表再点一次"又被打回同一个错误，形成打转。
 */
function guideToApp(res, reason, extra = {}) {
  const q = new URLSearchParams();
  q.set("reason", reason);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && String(v) !== "") q.set(k, String(v));
  }
  res.writeHead(302, {
    Location: `/app/?${q.toString()}`,
    "Cache-Control": "no-store",
    "Set-Cookie": "dsh_device=; Path=/; Max-Age=0; SameSite=Lax; Secure"
  });
  res.end();
}

function errorPage(req, res, status, title, detail, extraHtml = "") {
  const wantHtml = /html/i.test(req.headers.accept || "");
  if (!wantHtml) {
    const r = jsonBody(status, { error: { code: status === 403 ? "forbidden" : "device_offline", message: detail } });
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

/**
 * remote-channel 标记（dsh web 0.1.2-rc.1+ 在非回环域名下的传输改写）：
 * 客户端把 /api/* 、/sidebar*、/git*、/pet* 与 WS 统一改写为 /remote/<channel>/... 形态，
 * 并以 x-dsh-remote-device 头（HTTP）/ ?device= 参数（WS）/ dsh_device cookie 指明目标设备——
 * 相当于把设备选择从 URL 首段挪到 header/参数。中继需把这些“channel 请求”还原为普通
 * /remote/<device>/<原路径> 转发，否则首段会被当成设备号（如 “api”）→ 502 设备离线。
 *
 * "_e2ee" = E2EE 控制通道(协议 docs/e2ee-protocol.md §6.2):/remote/_e2ee/ctrl + 设备头
 * (channel 形态)或 /remote/<deviceId>/_e2ee/ctrl(device 形态)都归一为上游路径 /_e2ee/ctrl,
 * 由 bridge 在 /_e2ee/* 本地应答 §5.2 握手,router 只是把该 ws 当普通流透传、不解析。
 *
 * E2EE 密文与信封(content-type: application/vnd.dsh.e2ee-v2 / x-dsh-e2ee 头 /
 * ws-open query 的 e2ee= 参数)对 router 是**透明载荷**:不在 STRIP_* 头集合内、不解析 body、
 * 仅按“信封即信号”做计数观测(noteE2ee),帧协议与 http / ws-open / ws-msg / ws-close /
 * __chunk 分块逻辑全部照旧。
 */
const CHANNEL_MARKERS = new Set(["api", "sidebar", "git", "pet", "_e2ee"]);

/** E2EE 标记帧观测(透传 + 计数;不解析密文 body)。每 (kind, 设备) 首次打印一行。 */
const e2eeObserved = new Set();
function noteE2ee(dev, kind) {
  const key = `${kind}:${dev.deviceId}`;
  if (e2eeObserved.has(key)) return;
  e2eeObserved.add(key);
  logger.info(`[router] e2ee ${kind} 帧(设备 ${dev.deviceId}) → 信封密文透明转发(不解析)`);
}

/** 取「/remote/<deviceId>/<path>[?query]」,path 含查询串,保持原样转发。 */
function remotePathWithQuery(url) {
  return url.pathname + (url.search || "");
}

/** channel 形态下的设备选择:header(x-dsh-remote-device) → ?device= → dsh_device cookie。 */
function channelDeviceOf(req, url) {
  const h = req.headers["x-dsh-remote-device"];
  if (typeof h === "string" && h && DEVICE_ID_RE.test(h)) return h;
  const q = url.searchParams.get("device");
  if (q && DEVICE_ID_RE.test(q)) return q;
  const c = getCookie(req, "dsh_device");
  if (c && DEVICE_ID_RE.test(c)) return c;
  return null;
}

/** 解析路由：
 * 1) /remote/<channel>/<path> 且首段是 channel 标记 → channel 模式:设备从 header/参数/cookie 取,
 *    转发路径去掉 /remote 前缀并剥掉 device 参数;
 * 2) /remote/<deviceId>/<path> → 原行为;
 * 3) 根路径按 dsh_device cookie 兜底(兼容 dsh web 绝对路径)。 */
function resolveRoute(req, url) {
  const m = url.pathname.match(/^\/remote\/([^/]+)(\/.*)?$/);
  if (m) {
    const head = m[1];
    // channel 模式(客户端改写的 /remote/api|sidebar|git|pet/*):首段既是指示符也是路径首段,
    // 上游路径 = /<首段> + 余下路径(如 /remote/api/session/search → /api/session/search)
    if (CHANNEL_MARKERS.has(head)) {
      const deviceId = channelDeviceOf(req, url);
      if (!deviceId) return null; // 无设备凭据:交由上层按未登录/404 处理,勿报“设备 api 离线”
      const rest = m[2] || "/";
      if (rest.includes("..") || rest.includes("\\")) return null;
      const path = "/" + head + rest;
      const u2 = new URL(url.href);
      u2.searchParams.delete("device"); // 设备参数只用于选设备,不透传给上游
      return { deviceId, path: path + (u2.search || ""), channel: true };
    }
    let deviceId;
    try {
      deviceId = decodeURIComponent(head);
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

/** 认证 + 设备归属校验;通过返回 { claims, dev }。 */
function authorizeRemote(req, deviceId) {
  const claims = verifyAnyJwt(getCookie(req, "dsh_token"));
  if (!claims) return { error: "unauthorized" };
  const dev = devices.get(deviceId);
  if (!dev || dev.ws.readyState !== WebSocket.OPEN) return { error: "offline" };
  if (String(dev.userId) !== String(claims.sub)) return { error: "forbidden" };
  return { claims, dev };
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
      .map((d) => ({ id: d.deviceId, name: d.name || d.deviceId, caps: d.caps || [] })); // caps 纯透传(E2EE 能力,不校验不解释)
    if (list.length > 0) reportMilestone(claims.sub, "devices"); // 手机端成功拉到设备列表(首条上报)
    const r = jsonBody(200, { devices: list });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }

  const parsed = resolveRoute(req, url);
  if (!parsed) {
    // 设备无关的静态资源先兜底(manifest/favicon:浏览器取它们时不带凭据,永远解析不到设备)
    if ((req.method === "GET" || req.method === "HEAD") && serveDeviceFreeAsset(res, url.pathname)) return;
    // 根路径没有可用的设备凭据（dsh_device cookie 过期/被清）、或 /remote/<未知设备>：
    // 过去是一句纯文本 404 —— 用户在手机上看就是白屏。现在页面导航一律引导回设备列表。
    if (isDocNavigation(req)) {
      guideToApp(res, "unknown_device");
      return;
    }
    const r = jsonBody(404, { error: { code: "not_found", message: "未指定设备：请使用 /remote/<deviceId>/<path>，或先在 APP 里选择设备" } });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }
  const { deviceId, path } = parsed;
  const auth = authorizeRemote(req, deviceId);
  if (auth.error === "unauthorized") {
    // 页面导航 → 回 APP 外壳（设备列表或登录页）；接口/子资源 → JSON 401（不再 302 成 HTML）
    if (isDocNavigation(req)) {
      guideToApp(res, "expired");
      return;
    }
    const r = jsonBody(401, { error: { code: "unauthorized", message: "登录状态无效或已过期" } });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
    return;
  }
  if (auth.error === "offline") {
    if (isDocNavigation(req)) {
      guideToApp(res, "offline", { device: deviceId, name: devices.get(deviceId)?.name || "" });
      return;
    }
    errorPage(req, res, 502, "电脑端未连接", `设备 ${deviceId} 的 bridge 当前离线。请先在电脑上运行 dsh-bridge 隧道模式,再刷新本页。`);
    return;
  }
  if (auth.error === "forbidden") {
    if (isDocNavigation(req)) {
      guideToApp(res, "forbidden", { device: deviceId });
      return;
    }
    errorPage(req, res, 403, "无权访问", "该设备不属于当前账号。");
    return;
  }
  const { claims, dev } = auth;

  // E2EE:信封即信号 —— 标记头存在即说明正文是密文(透明转发,不解析;计数观测)
  if (isE2eeMarked(req.headers)) noteE2ee(dev, "http");

  // 读请求体(上限内)→ 发帧给 bridge
  let bodyBuf = Buffer.alloc(0);
  try {
    bodyBuf = await readBody(req);
  } catch {
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "body_too_large", message: "请求体超过 64MB" } }));
    return;
  }

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
      // 流式:手机侧断开(切页/锁屏/EventSource 主动 close)→ 通知 bridge 掐掉上游 SSE,
      // 否则电脑端会留下一条永远开着的连接(DSH 的 /plugins/events 不会自己结束)。
      if (p.streaming === true) sendToBridge(devices.get(p.deviceId), { id, type: "http-abort" });
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
        const { deviceId, token, name, caps } = frame;
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
          caps: Array.isArray(caps) ? caps.map(String).filter(Boolean) : [], // E2EE caps 原样记录(§6.2)
          connectedAt: Date.now()
        };
        devices.set(deviceId, dev);
        clearTimeout(regTimer);
        try {
          // caps:告诉 bridge 本中继支持哪些**追加**帧协议。
          // 为什么要有这一步:新 bridge 的 SSE 流式帧(http-chunk/http-end)对旧中继是不认识的,
          // 旧中继会把"仅头部"帧当成完整响应直接 end → SSE 变成"秒断+狂重连",比原来的
          // 120s 挂起更糟。所以能力由**中继**声明,bridge 没有这个 caps 就退回旧的整包缓冲行为。
          ws.send(JSON.stringify({ type: "tunnel-register-ok", deviceId, caps: ROUTER_FRAME_CAPS }));
        } catch {
          /* ignore */
        }
        logBridgeChurn(deviceId, "注册", `(user=${dev.userId}, plan=${dev.plan}, name=${dev.name})`);
        reportPresence(deviceId, dev.userId, true); // 权威在线信号:企业端据此刷新 last_seen/online
        return;
      }
      // 注册后的业务帧(bridge 回包)
      if (!dev) return;
      try {
        onBridgeFrame(dev, frame);
      } catch (e) {
        logger.error(`[router] 帧处理错误(${dev.deviceId}): ${e.message}`);
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
  logBridgeChurn(dev.deviceId, "断开", "");
  // 只有真的从 Map 里摘掉才上报离线(避免重复 close 把刚重连上的设备误标离线)
  if (!devices.has(dev.deviceId)) reportPresence(dev.deviceId, dev.userId, false);
  for (const [id, p] of pendingHttp) {
    if (p.deviceId === dev.deviceId) {
      pendingHttp.delete(id);
      clearTimeout(p.timer);
      if (!p.res.writableEnded) {
        // 流式响应:响应头早就发出去了,不能再写 502 JSON —— 直接收尾,让 EventSource 自己重连。
        if (p.streaming === true) {
          try { p.res.end(); } catch { /* ignore */ }
        } else {
          p.res.writeHead(502, { "content-type": "application/json" });
          p.res.end(JSON.stringify({ error: { code: "device_offline", message: "bridge 断开,请重试" } }));
        }
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

    // ── SSE 流式响应(2026-09-23)────────────────────────────────────────────
    // bridge 遇到 `text/event-stream` 时不再整包缓冲:先发**仅头部**帧(streaming:true),
    // 之后用 `http-chunk` 逐块推、`http-end` 收尾。
    // 为什么必须做:DSH 的 `/plugins/events`(HMR 事件通道)是**永不结束**的流,而旧协议
    // 只有"一个完整响应"帧 —— bridge 只能一直 await 到自己的 120s 上游超时才报错,
    // 手机端于是每次开页面都挂满两分钟,EventSource 再立刻重连,Network 里永远有一条转圈的请求。
    if (frame.streaming === true) {
      clearTimeout(p.timer);
      const sStatus = Number(frame.status) || 502;
      if (sStatus >= 200 && sStatus < 400) reportMilestone(p.userId, "remote");
      const sHeaders = sanitizeResHeaders(frame.headers || {});
      delete sHeaders["content-length"]; // 流式:长度未知,交给 chunked
      p.streaming = true;
      p.res.writeHead(sStatus, sHeaders);
      try { p.res.flushHeaders?.(); } catch { /* 立即把响应头推给手机,EventSource 好尽快 open */ }
      return; // ⚠️ 刻意**不删** pendingHttp:后续 chunk 还要靠它
    }

    pendingHttp.delete(id);
    clearTimeout(p.timer);
    const buf = frame.bodyBase64
      ? Buffer.from(String(frame.body || ""), "base64")
      : Buffer.from(String(frame.body || ""), "utf8");
    const status = Number(frame.status) || 502;
    if (status >= 200 && status < 400) reportMilestone(p.userId, "remote"); // 首次远程 http 真正打通
    const headers = sanitizeResHeaders(frame.headers || {});
    headers["content-length"] = String(buf.length);
    const hasBody = p.method !== "HEAD" && status >= 200 && status !== 204 && status !== 304;
    p.res.writeHead(status, headers);
    if (!hasBody || buf.length === 0) {
      p.res.end();
      return;
    }
    void writeBody(p.res, buf);
    return;
  }

  // ── SSE 流式:数据块 ───────────────────────────────────────────────────────
  if (type === "http-chunk") {
    const p = pendingHttp.get(id);
    if (!p || p.streaming !== true) return;
    const cbuf = frame.bodyBase64
      ? Buffer.from(String(frame.body || ""), "base64")
      : Buffer.from(String(frame.body || ""), "utf8");
    if (cbuf.length === 0) return;
    try {
      if (!p.res.destroyed && !p.res.writableEnded) p.res.write(cbuf);
    } catch { /* 手机已断开:交给 res.close / cleanupDevice 收尾 */ }
    return;
  }

  // ── SSE 流式:结束 ─────────────────────────────────────────────────────────
  if (type === "http-end") {
    const p = pendingHttp.get(id);
    if (!p || p.streaming !== true) return;
    pendingHttp.delete(id);
    try { if (!p.res.writableEnded) p.res.end(); } catch { /* ignore */ }
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
    if (pu.socket.destroyed) return; // 手机已断开
    reportMilestone(pu.userId, "remote"); // 首次远程 ws 隧道建立(点进设备成功用上)
    tunnelWss.handleUpgrade(pu.req, pu.socket, pu.head, (ws) => {
      const sess = {
        ws,
        deviceId: pu.deviceId,
        userId: pu.userId,
        plan: pu.plan,
        queue: [],
        draining: false
      };
      tunnelSessions.set(id, sess);
      ws.on("message", (data, isBinary) => {
        const payload = isBinary ? Buffer.from(data).toString("base64") : data.toString();
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
  const { claims, dev } = auth;

  // E2EE 标记数据流(ws-open query 带 e2ee=,§4.6):router 把参数原样透传给 bridge(它负责剥离),
  // 这里仅识别 + 计数观测,不解析任何载荷。
  if (url.searchParams.get("e2ee")) noteE2ee(dev, "ws");

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
  logger.info(`[router] 监听 ${HOST}:${PORT}(HTTP /remote/<deviceId>/ + WS /_bridge)`);
  logger.info(
    logger.filePath
      ? `[router] 日志落盘: ${logger.filePath}(单文件上限 ${process.env.DSH_LOG_MAX_MB || 10}MB,保留 ${process.env.DSH_LOG_KEEP ?? 5} 份)`
      : "[router] 未设置 DSH_LOG_DIR,日志仅输出到 stdout(不落盘)"
  );
});


// presence 心跳:每 60s 给仍在线设备各补一次 online=true(兼作 last_seen 心跳)。
// 企业端以「last_seen 新鲜度(180s TTL)」判定在线,故离线设备会在最多 3 分钟内自然掉落;
// 无在线设备时不发任何请求。unref:不阻塞进程退出(测试环境友好)。
const presenceSweep = setInterval(() => {
  if (devices.size === 0) return;
  for (const dev of devices.values()) reportPresence(dev.deviceId, dev.userId, true);
}, PRESENCE_SWEEP_MS);
presenceSweep.unref?.();

// 优雅退出
function shutdown() {
  logger.info("[router] 关闭中...");
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

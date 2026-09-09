#!/usr/bin/env node
/**
 * dsh-bridge — 电脑端守护进程:把手机流量桥接到本地 dsh web(127.0.0.1:3080)
 *
 * 架构(唯一模式,隧道模式):
 *   手机 ──nginx /remote/<deviceId>/──▶ relay-router ──WS 隧道(/ _bridge)──▶ 本进程 ──HTTP/WS──▶ dsh web
 *
 * 流程:
 *   1. 解析稳定 deviceId + ed25519 公钥(缺省生成并持久化到 .dsh-config.json)
 *   2. 账号认证拿 JWT(DSH_BRIDGE_TOKEN 或 手机号/邮箱+密码)
 *   3. 向账号 API 登记设备(POST /api/devices,带 device_id)
 *   4. 连 router / _bridge,注册 {type:"tunnel-register", deviceId, token};
 *      收到 router 转发的 http/ws-* 帧 → 处理 → 回包
 *
 * 帧协议(JSON;超大帧自动分块):
 *   ── 通用分块信封(任意方向) ──
 *     { "__chunk": { "id": <chunkId>, "n": <总块数>, "i": <第 i 块>, "data": <字符串分片> } }
 *     接收方按 chunkId 攒齐 n 块后 JSON.parse 拼接结果,再按 type 分发。
 *
 *   ── HTTP 透明代理 ──
 *     → { "id", "type":"http", "method", "path", "headers":{...}, "body":<base64>, "bodyBase64":true }
 *     ← { "id", "type":"http", "status", "headers":{...}, "body":<base64>, "bodyBase64":true }
 *     bridge 转发时:Host 由 fetch/ws 自动取上游 authority(127.0.0.1:3080,满足 loopback 围栏),
 *     显式剥离 Origin、Sec-Fetch-*、Cookie、Referer 等浏览器标记,保证通过 dsh web 的信任围栏。
 *
 *   ── WebSocket 透传(覆盖 /api/events.mux|host 下行流) ──
 *     → { "id", "type":"ws-open", "path", "headers":{...} }      ← { "id","type":"ws-open","ok":true|false,"code"?,"reason"? }
 *     → { "id", "type":"ws-msg",  "data":<文本|base64>, "binary"? }
 *     ← { "id", "type":"ws-msg",  "data":<文本|base64>, "binary"? }
 *     → { "id", "type":"ws-close", "code"?, "reason"? }          ← { "id","type":"ws-close","code"?,"reason"? }
 *     ws 会话以帧 id 为 key;隧道断开时全部关闭。
 *
 * 环境:
 *   DSH_BRIDGE_TUNNEL_URL  必填:relay-router 地址(如 ws://127.0.0.1:13444 或 wss://relay.example.com)
 *   DSH_BRIDGE_DEVICE_ID   覆盖稳定 deviceId(缺省读/写 .dsh-config.json 的 device_id)
 *   DSH_BRIDGE_UPSTREAM    上游 dsh web(默认 http://127.0.0.1:3080)
 *   DSH_BRIDGE_EMAIL       账号邮箱(与 DSH_BRIDGE_PASSWORD 一起自动登录拿 JWT;手机号用 DSH_BRIDGE_PHONE)
 *   DSH_BRIDGE_PHONE       账号手机号
 *   DSH_BRIDGE_PASSWORD    账号密码
 *   DSH_BRIDGE_TOKEN       JWT(直接给 token;优先级高于 手机号/邮箱+密码)
 *   DSH_BRIDGE_API         账号 API 地址(默认云端服务地址;自建模式无需设置)
 *   DSH_BRIDGE_LOCAL_KEY   开源自部署:访问密钥(设后经 router POST /_login 换本地 JWT,免账号体系)
 *   DSH_BRIDGE_HEARTBEAT_MS 隧道心跳间隔(默认 15000ms)
 *   DSH_MOBILE_ADAPTER   经隧道访问的官方 dsh web 移动端适配注入开关:0 关闭(默认开启,仅 ≤820px 生效)
 *
 * E2EE(Phase-2,见 docs/e2ee-protocol.md):
 *   - 账号模式(非 DSH_BRIDGE_LOCAL_KEY)启动时用 device-login 同一账号密码派生 MK(仅内存,
 *     不落盘);服务端 /api/e2ee-params 返回 enabled=false / 401 / 无密码 / 派生失败 → 明文 v1 回退。
 *   - 开关与状态写入 <relayDir>/.e2ee-state.json {enabled, reason, profile, epoch, caps};
 *     DSH_BRIDGE_E2EE=0 或配置 e2ee:false 可本地关闭;DSH_BRIDGE_E2EE_STATE 可覆盖状态文件路径。
 *   - 帧体带信封标记(content-type: application/vnd.dsh.e2ee-v2 或 x-dsh-e2ee)= 已加密:
 *     HTTP 解封→转发上游→响应封回;WS 逐消息封/解。任何解封失败显式
 *     502 + x-dsh-e2ee-error / ws-close 1008,绝不静默降级。
 *   - 控制通道 /_e2ee/ctrl(device/channel 形态)不连上游,跑 §5.2 握手(hello/ack/探针);
 *     数据流 ws-open 携带 &e2ee=<sessId>&w=<8B hex>,探针通过前不转发任何数据。
 */

import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomBytes, generateKeyPairSync, createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
// 移动端适配层(经隧道访问的官方 dsh web 窄屏注入;DSH_MOBILE_ADAPTER=0 可关闭,默认开启)
import { maybeInjectMobileAdapter } from "./mobile-adapter.mjs";
// E2EE(端到端加密)客户端基建(Phase-2):MK 派生/会话密钥/信封/握手/开关
// 仅在 runTunnel(账号模式)里初始化;被测试 import(未走 main)时保持禁用 → v1 路径不变。
import {
  E2eeError,
  E2eeService,
  ENVELOPE_CONTENT_TYPE,
  decodeHttpRequestPlain,
  encodeHttpResponsePlain,
  hasEnvelopeMarker,
  parseWsE2eeParams,
  writeE2eeStateFile
} from "./e2ee-client.mjs";

// ---------- 强制直连:清除代理环境变量 ----------
// 家庭网络常配 Clash 等代理(127.0.0.1:7890),node 的 ws/fetch 会继承
// http_proxy/https_proxy 导致到信令 WSS 的 TLS 握手失败(SSL_ERROR_SYSCALL)。
// bridge 必须直连 relay,不受本机代理影响。
for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
  delete process.env[k];
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(THIS_DIR, "..", "..");
// 配置路径:dsh-setup 总会显式传入 DSH_BRIDGE_CONFIG;npm 安装时默认落到 ~/.dsh-remote
const DEFAULT_CONFIG = path.join(
  ROOT.includes(`${path.sep}node_modules${path.sep}`) ? path.join(os.homedir(), ".dsh-remote") : ROOT,
  ".dsh-config.json"
);
const CONFIG_PATH = process.env.DSH_BRIDGE_CONFIG || DEFAULT_CONFIG;
// 隧道模式(唯一):bridge 主动 WS 连 relay-router 的 /_bridge
const TUNNEL_URL = (process.env.DSH_BRIDGE_TUNNEL_URL || "").replace(/\/+$/, "");
const TUNNEL_HEARTBEAT_MS = Math.max(100, Number(process.env.DSH_BRIDGE_HEARTBEAT_MS) || 15_000);
const UPSTREAM = process.env.DSH_BRIDGE_UPSTREAM || "http://127.0.0.1:3080";
// 默认云端服务地址（dsh-remote setup 会显式传入；自建模式无需账号 API）
const API_BASE = (process.env.DSH_BRIDGE_API || "https://n.risegao.cn:13443/relay-api").replace(/\/+$/, "");
const EMAIL = process.env.DSH_BRIDGE_EMAIL || "";
// 手机号优先;兼容旧的 DSH_BRIDGE_EMAIL(过渡期)
const PHONE = process.env.DSH_BRIDGE_PHONE || EMAIL;
const PASSWORD = process.env.DSH_BRIDGE_PASSWORD || "";
const TOKEN = process.env.DSH_BRIDGE_TOKEN || "";

// ---------- 本机稳定指纹(同机重装识别;供服务端自动顶替旧设备) ----------

/** 读取与安装无关的机器级唯一值:macOS IOPlatformUUID / Linux machine-id。 */
function machineUniqueId() {
  if (process.env.DSH_BRIDGE_MACHINE_FP) return String(process.env.DSH_BRIDGE_MACHINE_FP).slice(0, 64);
  if (process.platform === "darwin") {
    try {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf8", timeout: 5000 });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m && m[1]) return m[1];
    } catch { /* 兜底 */ }
  } else if (process.platform === "linux") {
    for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const s = fs.readFileSync(f, "utf8").trim();
        if (s) return s;
      } catch { /* 继续 */ }
    }
  }
  return ""; // 读不到(如容器) → 回退宿主名指纹
}
/** 稳定指纹:机器唯一值哈希;同机卸载重装后不变。 */
function machineFingerprint() {
  const base = machineUniqueId() || `${os.hostname()}|${os.platform()}`;
  return createHash("sha256").update(`dsh-remote/machine/v1:${base}`).digest("hex").slice(0, 32);
}
const MACHINE_FP = machineFingerprint();

/** 绑定/登录失败提示文件:供 dsh web 插件面板读取并展示(如“注册失败,已达到上限”)。 */
const BIND_ERROR_FILE = path.join(path.dirname(CONFIG_PATH), ".bind-error.json");
function persistBindError(payload) {
  try {
    fs.mkdirSync(path.dirname(BIND_ERROR_FILE), { recursive: true });
    fs.writeFileSync(BIND_ERROR_FILE, JSON.stringify({ ...payload, at: Date.now() }, null, 2), { mode: 0o600 });
  } catch { /* 非关键 */ }
}
function clearBindError() {
  try { fs.rmSync(BIND_ERROR_FILE, { force: true }); } catch { /* 非关键 */ }
}

// ---------- 稳定设备身份(.dsh-config.json) ----------

function loadLocalConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

function saveLocalConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn(`[bridge] 无法写配置 ${CONFIG_PATH}: ${e.message}`);
  }
}

/**
 * Harness 浏览器会话 Cookie(由 dsh-remote-web 插件在进程内换取后写入
 * <relayDir>/.harness-cookie.json)。新版 dsh web(0.1.2+)对每个请求校验该 Cookie,
 * 不带则 401 → 手机端白页;bridge 对所有上游 HTTP/WS 请求自动携带,让手机表现为已授权浏览器。
 */
const HARNESS_COOKIE_FILE = ".harness-cookie.json";
function harnessCookieOf() {
  try {
    const p = path.join(path.dirname(CONFIG_PATH), HARNESS_COOKIE_FILE);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j.cookie === "string" && j.cookie ? j.cookie : "";
  } catch {
    return "";
  }
}

/**
 * 解析稳定 deviceId:优先级 env DSH_BRIDGE_DEVICE_ID > argv[2] > 配置 device_id > 生成。
 * 生成格式 dev-<12hex> 并持久化到 .dsh-config.json,保证每台 Mac 重启后 id 不变。
 */
function resolveDeviceIdentity() {
  const envId = process.env.DSH_BRIDGE_DEVICE_ID || "";
  const argId = process.argv[3] || "";
  const cfg = loadLocalConfig();
  const pick = () => envId || argId || (typeof cfg.device_id === "string" && cfg.device_id ? cfg.device_id : "");
  const existing = pick();
  if (existing) return existing;
  const id = "dev-" + randomBytes(6).toString("hex"); // 12 hex
  cfg.device_id = id;
  saveLocalConfig(cfg);
  return id;
}

/** 设备 ed25519 公钥(账号设备登记用;缺省生成并持久化,格式与 dsh-setup 一致)。 */
function resolveDevicePubKey() {
  const cfg = loadLocalConfig();
  if (typeof cfg.device_public_key === "string" && cfg.device_public_key) return cfg.device_public_key;
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    cfg.device_public_key = publicKey.export({ type: "spki", format: "der" }).toString("hex");
    cfg.device_private_key = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");
    saveLocalConfig(cfg);
    return cfg.device_public_key;
  } catch (e) {
    console.warn(`[bridge] ed25519 密钥生成失败: ${e.message}(用临时公钥,设备 id 仍稳定)`);
    return "ed25519:" + randomBytes(16).toString("hex");
  }
}

const DEVICE_ID = resolveDeviceIdentity();
// 单条消息分块尺寸(任何一端都不会超限)。
const CHUNK_SIZE = 200 * 1024;
// 单个 HTTP 请求的兜底超时(秒)。dsh 的 prompt 等操作可能跑很久,给足余量。
const HTTP_TIMEOUT_MS = 120_000;

// ---------- E2EE 运行时(默认禁用;main() 启动时按配置/服务端开关初始化) ----------

/**
 * E2EE 服务实例。enabled=false 时所有帧处理走原 v1 明文路径;
 * 只有「账号模式 ∧ 配置未关闭 ∧ 服务端 e2ee.enabled ∧ 有密码且 MK 派生成功」才为 enabled。
 */
let e2ee = new E2eeService({ enabled: false, reason: "not_initialized" });
/** 控制通道(/_e2ee/ctrl)连接:frameId → { kind:"ctrl", sessId|null }(不连上游)。 */
const ctrlConns = new Map();

// 转发请求时剥离的浏览器/代理头(围栏只认 Host + Origin + Sec-Fetch-*):
//  - Host:fetch 自动取上游 authority(127.0.0.1:3080)→ loopback 围栏通过;
//    ws 库需要显式设置(见 buildWsHeaders)。
//  - Origin/Sec-Fetch-*/Referer:围栏里 cross-site / 异源 Origin 会被拒,必须剥掉。
//  - Cookie:手机侧的 cookie 属于手机域名,与 dsh web 无关,不应透传。
//  - content-length/transfer-encoding:由 fetch/ws 自己计算。
const STRIP_REQ_HEADERS = new Set([
  "host", "origin", "referer", "cookie", "connection", "upgrade",
  "keep-alive", "transfer-encoding", "content-length", "accept-encoding",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
  "te", "trailer", "proxy-connection", "x-forwarded-for", "x-forwarded-proto",
  "x-forwarded-host"
]);
// 回包时剥离的实体头:undici 已自动解压 body,content-encoding/length 会误导浏览器。
const STRIP_RES_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding",
  "connection", "keep-alive", "upgrade"
]);

console.log(`[bridge] 设备 ${DEVICE_ID} → 隧道 ${TUNNEL_URL}/_bridge`);
console.log(`[bridge] 上游 ${UPSTREAM}`);

// ============================================================
// 通用工具:分块收发(双向)
// ============================================================

let chunkSeq = 0;

/**
 * 构造「超长自动分块」的发送函数(隧道模式用;WebRTC 模式仍走 dcSend)。
 * rawSend 接收完整字符串(如 ws.send)。返回 send(obj) → boolean。
 */
export function makeChunkedSender(rawSend) {
  return function send(obj) {
    const s = JSON.stringify(obj);
    if (s.length <= CHUNK_SIZE) {
      try { rawSend(s); } catch { return false; }
      return true;
    }
    const cid = `c${++chunkSeq}`;
    let sent = true;
    for (let i = 0; i < s.length; i += CHUNK_SIZE) {
      const part = { __chunk: { id: cid, n: Math.ceil(s.length / CHUNK_SIZE), i: i / CHUNK_SIZE, data: s.slice(i, i + CHUNK_SIZE) } };
      try { rawSend(JSON.stringify(part)); } catch { sent = false; break; }
    }
    return sent;
  };
}

/** 把对象发上 DataChannel;超长自动分块。返回 true 表示已发送(含分块)。 */
export function dcSend(dc, obj) {
  if (!dc || dc.readyState !== "open") return false;
  return makeChunkedSender((s) => dc.send(s))(obj);
}

/** 兼容两种调用:handleXxx(dch, frame)(WebRTC) 或 handleXxx(sendFn, frame)(隧道)。 */
function toSender(dchOrSend) {
  return typeof dchOrSend === "function" ? dchOrSend : (obj) => dcSend(dchOrSend, obj);
}

/**
 * 接收侧:把一条原始 DataChannel 消息规整为完整帧。
 * 普通帧直接回传;分块帧攒齐后回传解析结果。需要挂在每个 channel 上:
 *   const recv = makeFrameReceiver();
 *   dch.onmessage = (ev) => recv(ev.data, (frame) => handleFrame(dch, frame));
 */
export function makeFrameReceiver() {
  const bufs = new Map(); // chunkId → { n, parts: string[] }
  return function receive(raw, onFrame) {
    let text;
    if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else text = String(raw);
    let obj;
    try { obj = JSON.parse(text); } catch { return; }
    if (obj && obj.__chunk) {
      const c = obj.__chunk;
      let acc = bufs.get(c.id);
      if (!acc) { acc = { n: c.n, parts: [] }; bufs.set(c.id, acc); }
      acc.parts[c.i] = c.data;
      if (acc.parts.filter(Boolean).length === acc.n) {
        bufs.delete(c.id);
        try { onFrame(JSON.parse(acc.parts.join(""))); } catch { /* 损坏分块,丢弃 */ }
      }
      return;
    }
    onFrame(obj);
  };
}

// ============================================================
// 头处理:围栏穿透
// ============================================================

/** 清洗手机发来的请求头:剥离浏览器标记,保留其余(供 fetch 转发)。 */
export function sanitizeRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (STRIP_REQ_HEADERS.has(lk)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** 清洗上游响应头:剥离实体/传输头,避免误导浏览器解码。 */
export function sanitizeResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (STRIP_RES_HEADERS.has(lk)) continue;
    if (v === undefined || v === null || v === "") continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** ws 库用的请求头:Host 显式写成上游 authority(loopback),其余同 sanitize。 */
export function buildWsHeaders(headers) {
  const up = new URL(UPSTREAM);
  const out = sanitizeRequestHeaders(headers);
  out.Host = up.host; // e.g. "127.0.0.1:3080"
  const ck = harnessCookieOf(); // 新版 dsh web 的浏览器会话 Cookie
  if (ck) out.Cookie = ck;
  return out;
}

// ============================================================
// 帧分发
// ============================================================

/** 处理一帧。type 缺省 → 旧协议(向后兼容)。 */
export async function handleFrame(dchOrSend, frame) {
  if (!frame || typeof frame !== "object") return;
  const { id, type } = frame;
  if (id === undefined || id === null) return;
  const send = toSender(dchOrSend);
  if (type === "http") return handleHttpFrame(send, frame);
  if (type === "ws-open") return handleWsOpen(send, frame);
  if (type === "ws-msg") return handleWsMessage(send, frame);
  if (type === "ws-close") return handleWsClose(send, frame);
  if (type === undefined) return handleLegacyFrame(send, frame); // 旧协议
  // 未知 type:忽略
}

// ---- HTTP 透明代理 ----

/** 校验上游路径,防 SSRF(禁止 userinfo/协议相对/绝对 URL/反斜杠/控制字符)。 */
function safePath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (/[\x00-\x1f\x7f\\]/.test(path)) return null;        // 控制字符/反斜杠(SSRF:无前导 / 已在上面拒绝,@ 在路径段里无害,如 /plugins/@deepseek-ai/)
  if (path.startsWith("//") || /^\/[^/]*:/.test(path)) return null; // 协议相对或 scheme
  return path;
}

const gzip = promisify(gzipCb);
// 可压缩的响应类型:JS/JSON/CSS/SVG/XML/纯文本。图片/视频/字体等二进制不压(压了也小不了)。
const COMPRESSIBLE_CT_RE = /javascript|json|css|svg|xml|text\//i;
const MIN_COMPRESS_BYTES = 1024;

/** 大小写不敏感取帧头(手机经 router 转发的头键大小写不保证)。 */
function headerValue(headers, name) {
  const lk = name.toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === lk) return Array.isArray(v) ? v.join(", ") : String(v);
  }
  return "";
}

/**
 * 决定是否把上游响应 gzip 压缩后回传(隧道带宽优化,手机远程控制打开更快)。
 * 保守策略:任一条件不满足都返回 null(原样回传):
 *   - 方法非 HEAD、状态非 204/304;
 *   - buf ≥ 1KB(太小不值得压);
 *   - 上游未编码(contentEncoding 为空;undici 已自动解压 body,这里只看原 header);
 *   - 请求 Accept-Encoding 含 gzip(手机浏览器必带;没有就不压,避免手机不会解压);
 *   - content-type 可压缩(排除 text/event-stream);
 *   - gzip 后确实更小(极小文件/不可压数据 gzip 反而更大,保守判断)。
 * 返回 { buf, headers }(headers 为需附加到响应头的键值)或 null。
 */
export async function maybeCompressResponse({ buf, contentType, contentEncoding, acceptEncoding, status, method }) {
  if (method === "HEAD") return null;
  if (status === 204 || status === 304) return null;
  if (!Buffer.isBuffer(buf) || buf.length < MIN_COMPRESS_BYTES) return null;
  if (contentEncoding) return null; // 上游已编码:body 语义不明,不叠压缩
  if (!String(acceptEncoding || "").toLowerCase().includes("gzip")) return null;
  const ct = String(contentType || "");
  if (!ct || ct.includes("text/event-stream") || !COMPRESSIBLE_CT_RE.test(ct)) return null;
  let out;
  try {
    out = await gzip(buf); // 异步压缩,不阻塞事件循环
  } catch {
    return null; // 压缩失败保守回退
  }
  if (out.length >= buf.length) return null; // 压完没变小
  return { buf: out, headers: { "content-encoding": "gzip" } };
}

async function doHttp(method, path, reqHeaders, body, isB64) {
  const safe = safePath(path);
  if (safe === null) throw new Error("非法路径");
  const url = `${UPSTREAM}${safe}`;
  const reqHdrs = sanitizeRequestHeaders(reqHeaders);
  const ck = harnessCookieOf(); // 新版 dsh web 的浏览器会话 Cookie(否则 401 白页)
  if (ck) reqHdrs.Cookie = ck;
  const init = { method, headers: reqHdrs };
  if (body !== undefined && body !== null && body !== "") {
    // 新协议 http 帧的 body 一律 base64;旧协议 body 是原始文本
    init.body = isB64 ? Buffer.from(String(body), "base64") : String(body);
  }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  let buf = Buffer.from(await res.arrayBuffer());
  // 移动端适配层:text/html(含 </head> 且匹配官方特征)在 gzip 前注入响应式 <style>/<script>;
  // 非 html / SSE / 二进制 / 上游已压缩等其余响应一律原样(env DSH_MOBILE_ADAPTER=0 关闭)。
  // sanitizeResponseHeaders 会剥 content-encoding(undici 已解压,原头会误导浏览器);
  // 若我们自行 gzip,必须在 sanitize 之后把 content-encoding: gzip 补回,手机才能正确解压。
  const headers = sanitizeResponseHeaders(Object.fromEntries(res.headers.entries()));
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) { // SSE 长连不缓冲不注入(见模块注释)
    const m = maybeInjectMobileAdapter({ buf, contentType });
    if (m.injected) {
      console.log(`[bridge] mobile-adapter 注入 ${path}: ${(buf.length / 1024).toFixed(0)}KB → ${(m.buf.length / 1024).toFixed(0)}KB`);
      buf = m.buf;
    }
  }
  const compressed = await maybeCompressResponse({
    buf,
    contentType,
    contentEncoding: res.headers.get("content-encoding") || "",
    acceptEncoding: headerValue(reqHeaders, "accept-encoding"),
    status: res.status,
    method
  });
  if (compressed) {
    console.log(`[bridge] gzip ${path}: ${(buf.length / 1024).toFixed(0)}KB → ${(compressed.buf.length / 1024).toFixed(0)}KB (${(100 * (1 - compressed.buf.length / buf.length)).toFixed(0)}% 减小)`);
    buf = compressed.buf;
    Object.assign(headers, compressed.headers);
  }
  return {
    status: res.status,
    headers,
    body: buf.toString("base64"),
    bodyBase64: true
  };
}

export async function handleHttpFrame(dchOrSend, frame) {
  const send = toSender(dchOrSend);
  const { id, method = "GET", path = "/", headers = {}, body, bodyBase64: isB64 } = frame;
  const t0 = Date.now();
  // E2EE 信封标记即信号(§4.3):有标记=加密,无标记=明文 v1。
  // 解封失败绝不静默降级 → 明文错误 + x-dsh-e2ee-error 头 + 日志。
  if (hasEnvelopeMarker(headers)) {
    if (!e2ee.enabled) {
      console.error(`[bridge] e2ee http ${method} ${path}: bridge 未启用 E2EE,拒绝解封(不静默降级)`);
      return sendE2eeHttpError(send, id, new E2eeError("e2ee_disabled", "bridge 端未启用端到端加密(请检查账号密码/服务端开关)"));
    }
    try {
      const bodyText = Buffer.from(String(body || ""), "base64").toString("utf8");
      let env;
      try {
        env = JSON.parse(bodyText);
      } catch {
        throw new E2eeError("bad_envelope", "帧体不是合法 E2EE 信封 JSON");
      }
      // 防重放 + 会话校验(unknown_session / not_verified / replay 在此抛出)
      const session = e2ee.guardHttpRequest(String(env?.s || ""), env);
      const opened = session.open({ kind: "http", dir: "p2b", env, counter: env?.c ?? 0 });
      const req = decodeHttpRequestPlain(opened.data);
      const reply = await doHttp(req.method, req.path, req.headers, req.bodyB64, true);
      const bodyBuffer = Buffer.from(reply.body, "base64");
      const plain = encodeHttpResponsePlain({ status: reply.status, headers: reply.headers, bodyBuffer });
      // 响应压缩已发生在 doHttp(明文侧,gzip 在加密前 §4.7);信封用 http-resp kind
      const respEnv = session.seal({ kind: "http-resp", dir: "b2p", counter: env?.c ?? 0, data: plain, reqNonceB64: String(env?.n || "") });
      send({
        id,
        type: "http",
        status: 200, // 外层一律 200,真实状态在信封明文 st 里(§4.3)
        headers: {
          "content-type": ENVELOPE_CONTENT_TYPE,
          "x-dsh-e2ee": `v=2;s=${env.s};k=http-resp`
        },
        body: Buffer.from(JSON.stringify(respEnv)).toString("base64"),
        bodyBase64: true
      });
      console.log(`[bridge] e2ee http ${req.method} ${req.path} → ${reply.status} (${Date.now() - t0}ms, 信封 ${(reply.body.length * 3 / 4 / 1024).toFixed(0)}KB)`);
      return;
    } catch (e) {
      console.error(`[bridge] e2ee http ${method} ${path} 解封失败: ${e.message || e}(不回退明文)`);
      return sendE2eeHttpError(send, id, e);
    }
  }
  try {
    const reply = await doHttp(method, path, headers, body, !!isB64);
    reply.id = id;
    reply.type = "http";
    send(reply);
    console.log(`[bridge] ${method} ${path} → ${reply.status} (${Date.now() - t0}ms, ${(reply.body.length * 3 / 4 / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.log(`[bridge] ${method} ${path} 上游错误: ${e.message}`);
    send({ id, type: "http", status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: String(e.message || e) })).toString("base64"), bodyBase64: true });
  }
}

/** E2EE 失败回包:明文(无信封标记)+ x-dsh-e2ee-error,绝不把无法解密的密文当正文转发。 */
function sendE2eeHttpError(send, id, err) {
  const code = err instanceof E2eeError ? err.code : "e2ee_failed";
  const message = `⚠ 无法解密/未加密(${code}): ${err?.message || code}`;
  send({
    id,
    type: "http",
    status: 502,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-dsh-e2ee-error": code
    },
    body: Buffer.from(JSON.stringify({ error: { code, message } })).toString("base64"),
    bodyBase64: true
  });
}

/** 旧协议(无 type):body 为原始文本,回包 body 为原始文本。 */
export async function handleLegacyFrame(dchOrSend, frame) {
  const send = toSender(dchOrSend);
  const { id, method = "GET", path = "/", body } = frame;
  const t0 = Date.now();
  try {
    const reply = await doHttp(method, path, { "content-type": "application/json" }, body, false);
    // 旧协议:body 转回文本(兼容 index.html 控制台)
    const text = Buffer.from(reply.body, "base64").toString("utf8");
    send({ id, status: reply.status, headers: reply.headers, body: text });
    console.log(`[bridge] legacy ${method} ${path} → ${reply.status} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`[bridge] legacy ${method} ${path} 上游错误: ${e.message}`);
    send({ id, status: 502, headers: {}, body: JSON.stringify({ error: String(e.message || e) }) });
  }
}

// ---- WebSocket 透传 ----

// ws 会话表:frame id → ws 客户端。DataChannel 断开时统一关闭。
//  - 普通/数据流:{ ws, opened, e2ee? };
//  - e2ee 数据流额外带 e2ee:{ s(E2eeSession), wsLabel, p2bLast, b2pLast };
//  - 控制通道(/_e2ee/ctrl)不连上游,单列 ctrlConns。
const wsSessions = new Map();

/** E2EE 错误码 → 手机可读文案(明文 e2ee-error;绝不静默)。 */
function e2eeCodeOf(err) {
  return err instanceof E2eeError ? err.code : "e2ee_failed";
}

function sendCtrlMsg(send, id, obj) {
  send({ id, type: "ws-msg", data: JSON.stringify(obj), binary: false });
}

function sendCtrlError(send, id, code, extra = "") {
  console.error(`[bridge] e2ee ctrl 错误: ${code}${extra ? " — " + extra : ""}`);
  sendCtrlMsg(send, id, { v: 2, type: "e2ee-error", code, ...(extra ? { message: extra } : {}) });
}

/** 控制通道 ws-open:不连上游,应答 ok 后按 §5.2 跑握手(hello/ack → 探针)。 */
function openControlWs(send, id) {
  if (!e2ee.enabled) {
    console.log(`[bridge] e2ee ctrl 被拒(桥端未启用): id=${id}`);
    send({ id, type: "ws-open", ok: false, code: 1008, reason: "e2ee_disabled:bridge 未启用端到端加密" });
    return;
  }
  wsSessions.delete(id);
  ctrlConns.set(id, { sessId: null });
  send({ id, type: "ws-open", ok: true });
  console.log(`[bridge] e2ee ctrl 通道已开 (id=${id}),等待 hello`);
}

/** 控制通道消息:明文 hello / AEAD 探针信封(§5.2)。 */
function handleCtrlMessage(send, id, rawText) {
  const conn = ctrlConns.get(id);
  if (!conn) return;
  let obj;
  try {
    obj = JSON.parse(rawText);
  } catch {
    sendCtrlError(send, id, "bad_msg", "非 JSON 控制消息");
    return;
  }
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "e2ee-hello") {
    try {
      const { session, ack } = e2ee.handleHello(obj);
      conn.sessId = session.sessId;
      sendCtrlMsg(send, id, ack);
    } catch (e) {
      sendCtrlError(send, id, e2eeCodeOf(e), e?.message || "");
    }
    return;
  }
  if (obj.v === 2 && obj.k === "ctrl") {
    // AEAD 探针(密文信封);失败 → bad_key 提示手机“密码/密钥不一致”,绝不静默
    if (!conn.sessId) {
      sendCtrlError(send, id, "unknown_session", "探针先于 hello");
      return;
    }
    try {
      const { reply } = e2ee.handleProbe(conn.sessId, obj);
      sendCtrlMsg(send, id, reply);
    } catch (e) {
      const code = e2eeCodeOf(e);
      // 探针解密失败对手机语义统一为 bad_key(§5.2;密码不一致/改密未更新)
      sendCtrlError(send, id, code === "auth_failed" || code === "bad_key" ? "bad_key" : code, e?.message || "");
    }
    return;
  }
  // 其余控制消息忽略
}

export async function handleWsOpen(dchOrSend, frame) {
  const send = toSender(dchOrSend);
  const { id, path = "/", headers = {} } = frame;
  // 控制通道(device 形态 /remote/<dev>/_e2ee/ctrl 与 channel 形态都归一到 /_e2ee/ctrl)
  if (path.startsWith("/_e2ee/")) {
    return openControlWs(send, id);
  }
  // e2ee 标记数据流:&e2ee=<sessId>&w=<8B hex>(§4.6);未启用/会话未验证 → 显式拒绝
  const tagged = parseWsE2eeParams(path);
  if (tagged) {
    if (!e2ee.enabled) {
      send({ id, type: "ws-open", ok: false, code: 1008, reason: "e2ee_disabled:bridge 未启用端到端加密(请用明文连接)" });
      return;
    }
    const session = e2ee.sessionOf(tagged.sessId);
    if (!session || !session.verified) {
      console.error(`[bridge] e2ee ws 拒绝(会话未解锁/未验证): ${path}`);
      send({ id, type: "ws-open", ok: false, code: 1008, reason: "e2ee_session_locked:请先解锁完成握手(检查密码)" });
      return;
    }
    // 探测前不转发任何数据(§4.6/§5.2:探针通过后数据流才可建);此时已验证 → 安全
  }
  if (wsSessions.has(id)) { try { wsSessions.get(id).ws.terminate(); } catch {} wsSessions.delete(id); }
  const safe = safePath(tagged ? tagged.upstreamPath : path);
  if (safe === null) { send({ id, type: "ws-open", ok: false, code: 400, reason: "非法路径" }); return; }
  const url = `${UPSTREAM.replace(/^http/, "ws")}${safe}`;
  const ws = new WebSocket(url, { headers: buildWsHeaders(headers), followRedirects: false });
  const session = { ws, opened: false };
  if (tagged && e2ee.enabled) {
    // 会话必须已 verified(上面已校验),给该流独立的收发密钥与方向计数
    session.e2ee = { s: e2ee.sessionOf(tagged.sessId), wsLabel: tagged.wsLabel, p2bLast: -1, b2pLast: -1 };
  }
  wsSessions.set(id, session);
  ws.on("open", () => {
    session.opened = true;
    console.log(`[bridge] ws-open ${session.e2ee ? "(e2ee) " : ""}${safe} (id=${id})`);
    send({ id, type: "ws-open", ok: true });
  });
  ws.on("message", (data, isBinary) => {
    // 上游 → 手机:加密流逐条封信封(b2p 独立计数);明文流原样透传
    if (session.e2ee) {
      try {
        const e2 = session.e2ee;
        e2.b2pLast += 1;
        const plain = isBinary ? Buffer.from(data) : Buffer.from(String(data), "utf8");
        const env = e2.s.seal({
          kind: "w",
          dir: "b2p",
          counter: e2.b2pLast,
          data: plain,
          t: isBinary ? 1 : 0,
          wsLabel: e2.wsLabel
        });
        send({ id, type: "ws-msg", data: JSON.stringify(env), binary: false });
      } catch (e) {
        console.error(`[bridge] e2ee ws 上游→手机 封包失败(id=${id}): ${e.message}`);
      }
      return;
    }
    const payload = isBinary ? Buffer.from(data).toString("base64") : data.toString();
    send({ id, type: "ws-msg", data: payload, binary: isBinary });
  });
  ws.on("close", (code, reason) => {
    if (!session.opened) return; // 未建立成功的会话由 error 路径收尾
    console.log(`[bridge] ws-close ${path} (id=${id}, code=${code})`);
    wsSessions.delete(id);
    send({ id, type: "ws-close", code: code ?? 1006, reason: reason?.toString() ?? "" });
  });
  ws.on("error", (e) => {
    console.log(`[bridge] ws-error ${path} (id=${id}): ${e.message || ""}`);
    if (!session.opened) {
      wsSessions.delete(id);
      send({ id, type: "ws-open", ok: false, code: 502, reason: String(e.message || "ws error") });
    }
  });
}

export function handleWsMessage(_dchOrSend, frame) {
  const { id, data, binary } = frame;
  const conn = ctrlConns.get(id);
  if (conn) {
    // 控制通道消息不走上游
    if (binary) {
      sendCtrlError(toSender(_dchOrSend), id, "bad_msg", "控制通道只接受文本消息");
      return;
    }
    handleCtrlMessage(toSender(_dchOrSend), id, String(data));
    return;
  }
  const session = wsSessions.get(id);
  if (!session || !session.opened || session.ws.readyState !== WebSocket.OPEN) return;
  if (session.e2ee) {
    // 加密流:逐条解封 → 原文转发上游;AEAD 失败 → 1008 关闭并回告(不静默降级)
    try {
      const env = JSON.parse(binary ? Buffer.from(data, "base64").toString("utf8") : String(data));
      const e2 = session.e2ee;
      if (!env || env.v !== 2 || env.k !== "w") throw new E2eeError("bad_envelope", "e2ee ws 消息不是 w 信封");
      if (!Number.isInteger(env.c) || env.c <= e2.p2bLast) throw new E2eeError("replay", `e2ee ws 计数重放/乱序 ${env.c}`);
      const opened = e2.s.open({ kind: "w", dir: "p2b", env, counter: env.c, wsLabel: e2.wsLabel });
      e2.p2bLast = env.c;
      if (opened.t === 1) session.ws.send(opened.data);
      else session.ws.send(opened.data.toString("utf8"));
    } catch (e) {
      console.error(`[bridge] e2ee ws 解封失败(id=${id}): ${e.message || e}(不回退明文,1008 关闭)`);
      try { session.ws.close(1008, "⚠ e2ee 消息无法解密"); } catch {}
      wsSessions.delete(id);
      try { toSender(_dchOrSend)({ id, type: "ws-close", code: 1008, reason: "⚠ e2ee 消息无法解密" }); } catch {}
    }
    return;
  }
  try {
    if (binary) session.ws.send(Buffer.from(data, "base64"));
    else session.ws.send(String(data));
  } catch (e) { console.log(`[bridge] ws-send err: ${e.message}`); }
}

export function handleWsClose(_dchOrSend, frame) {
  const { id, code, reason } = frame;
  const conn = ctrlConns.get(id);
  if (conn) {
    ctrlConns.delete(id);
    return;
  }
  const session = wsSessions.get(id);
  if (!session) return;
  try { session.ws.close(code && typeof code === "number" ? code : 1000, reason || ""); } catch {}
}

/** DataChannel 断开:关闭所有 ws 会话与控制通道。 */
export function closeAllWsSessions() {
  for (const session of wsSessions.values()) {
    try { session.ws.terminate(); } catch {}
  }
  wsSessions.clear();
  ctrlConns.clear();
}

// ============================================================
// 认证(SaaS: device-login; 开源自部署: 本地访问密钥 /_login)
// ============================================================

/** 本地认证(自部署):用访问密钥向 router POST /_login 换本地 JWT。 */
async function resolveLocalToken() {
  const key = process.env.DSH_BRIDGE_LOCAL_KEY || "";
  if (!key || !TUNNEL_URL) return "";
  try {
    // 从隧道地址推导同源 HTTP 入口:wss://host:port → https://host:port
    const u = new URL(TUNNEL_URL);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/_login";
    const r = await fetch(u.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key })
    });
    const d = await r.json();
    if (r.status === 200 && d.token) {
      console.log("[bridge] 本地认证成功(开源自部署),已获取 JWT");
      return d.token;
    }
    console.error(`[bridge] 本地认证失败(${r.status}): ${d.error?.message || "未知错误"}(请检查 DSH_BRIDGE_LOCAL_KEY)`);
    process.exit(1);
  } catch (e) {
    console.error(`[bridge] 无法连接本地认证 ${u?.toString?.() || TUNNEL_URL}: ${e.message}`);
    process.exit(1);
  }
}

async function resolveToken(refresh = false) {
  if (TOKEN && !refresh) { console.log("[bridge] 使用 DSH_BRIDGE_TOKEN"); return TOKEN; }
  // 开源自部署:访问密钥优先(不依赖闭源 enterprise 账号体系)
  if (process.env.DSH_BRIDGE_LOCAL_KEY && !refresh) return resolveLocalToken();
  if (PHONE && PASSWORD) {
    console.log(`[bridge] 用账号 ${PHONE} 登录换取 JWT...`);
    try {
      // 设备登录:登录接口已加图形验证码(bridge 无法人工输验证码),走免验证码的 device-login
      const r = await fetch(API_BASE + "/api/device-login", {
        method: "POST",
        headers: { "content-type": "application/json", ...(process.env.DSH_BRIDGE_SECRET ? { "x-dsh-bridge-secret": process.env.DSH_BRIDGE_SECRET } : {}) },
        body: JSON.stringify({ phone: PHONE, email: PHONE, password: PASSWORD })
      });
      const d = await r.json();
      if (r.status === 200 && d.token) {
        console.log("[bridge] 登录成功,已获取 JWT");
        return d.token;
      }
      console.error(`[bridge] 登录失败(${r.status}): ${d.error?.message || "未知错误"}`);
      console.error("[bridge] 请检查 DSH_BRIDGE_EMAIL / DSH_BRIDGE_PASSWORD,或直接设 DSH_BRIDGE_TOKEN");
      process.exit(1);
    } catch (e) {
      console.error(`[bridge] 无法连接账号 API ${API_BASE}: ${e.message}`);
      process.exit(1);
    }
  }
  if (TOKEN) {
    console.error("[bridge] DSH_BRIDGE_TOKEN 已失效且无账号密码可刷新,请更换 token 后重启");
    process.exit(1);
  }
  console.error("[bridge] 无认证配置:请设 DSH_BRIDGE_TOKEN / 手机号+密码,或开源自部署的 DSH_BRIDGE_LOCAL_KEY");
  process.exit(1);
}

// ============================================================
// 隧道模式:bridge 主动连 relay-router(多设备主用)
// ============================================================

let tunnelRetry = 0;

/** 把 DSH_BRIDGE_TUNNEL_URL 归一化为 router 注册端点(缺省补 / _bridge)。 */
function tunnelEndpoint(raw) {
  try {
    const u = new URL(raw);
    const p = u.pathname.replace(/\/+$/, "");
    u.pathname = p === "" || p === "/" ? "/_bridge" : p;
    return u.toString();
  } catch {
    return raw + "/_bridge";
  }
}

/** 账号设备表登记:手机端 /api/devices 才能看到本设备(带稳定 device_id)。自建模式无账号体系,跳过。 */
async function registerDeviceInAccount(token) {
  if (process.env.DSH_BRIDGE_LOCAL_KEY) return; // 自建模式:设备列表来自 router 实时 WS 注册表
  const pubKey = resolveDevicePubKey();
  try {
    const r = await fetch(API_BASE + "/api/devices", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        device_id: DEVICE_ID,
        device_name: os.hostname() || "dsh-bridge",
        pub_key: pubKey,
        machine_fp: MACHINE_FP // v6 同机识别:服务端据此自动顶替旧设备(重装不再被设备数卡死)
      })
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 201 || r.status === 200) {
      clearBindError();
      console.log(`[bridge] ✅ 设备已登记到账号: ${DEVICE_ID}`);
      return;
    }
    if (r.status === 409) {
      const code = d.error?.code || "";
      if (code === "device_limit_exceeded") {
        const msg = d.error?.message || "当前套餐最多绑定 1 台设备";
        persistBindError({ code, message: msg });
        console.error(`[bridge] 设备数已达上限: ${msg}`);
        console.error("   同机重装会自动顶替旧设备;仍失败请到手机端设备管理解绑旧设备后重启(免费每月可解绑 3 次)。");
      } else {
        persistBindError({ code, status: 409, message: d.error?.message || "绑定冲突" });
        console.error(`[bridge] 设备 ${DEVICE_ID} 绑定失败(${code || 409}): ${d.error?.message || "未知错误"}`);
      }
      process.exit(1);
    }
    persistBindError({ code: d.error?.code || `http_${r.status}`, status: r.status, message: d.error?.message || "设备登记失败" });
    console.warn(`[bridge] 设备登记失败(${r.status}): ${d.error?.message || "未知错误"}(手机端设备列表可能看不到本设备)`);
  } catch (e) {
    persistBindError({ code: "api_unreachable", message: `无法连接账号 API: ${e.message}` });
    console.warn(`[bridge] 无法连接账号 API ${API_BASE}: ${e.message}(手机端设备列表可能看不到本设备)`);
  }
}

function connectTunnel(token) {
  const endpoint = tunnelEndpoint(TUNNEL_URL);
  const ws = new WebSocket(endpoint, { followRedirects: false });
  const send = makeChunkedSender((s) => { if (ws.readyState === WebSocket.OPEN) ws.send(s); });
  let heartbeat;
  let pongReceived = true;

  ws.on("open", () => {
    tunnelRetry = 0;
    console.log(`[bridge] 隧道已连 ${endpoint},注册 ${DEVICE_ID}...`);
    try {
      // caps:bridge E2EE 能力上报(§6.2/§7.1;router 纯透传)。enabled=false → 空数组(明文回退)
      ws.send(JSON.stringify({ type: "tunnel-register", deviceId: DEVICE_ID, token, name: os.hostname() || "dsh-bridge", caps: e2ee.caps() }));
    } catch (e) { console.log(`[bridge] 注册发送失败: ${e.message}`); }
    heartbeat = setInterval(() => {
      if (!pongReceived) {
        console.log("[bridge] 隧道心跳超时,主动重连...");
        ws.terminate();
        return;
      }
      pongReceived = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }, TUNNEL_HEARTBEAT_MS);
  });
  ws.on("pong", () => { pongReceived = true; });
  ws.on("message", (raw) => {
    const receive = makeFrameReceiver();
    try {
      receive(raw, (frame) => {
        if (frame?.type === "tunnel-register-ok") {
          console.log(`[bridge] ✅ router 注册成功: ${DEVICE_ID},等待手机访问 /remote/${DEVICE_ID}/`);
          return;
        }
        if (frame?.type === "tunnel-register-err") {
          console.error(`[bridge] router 拒绝注册: ${frame.code} ${frame.message || ""}`);
          return;
        }
        handleFrame(send, frame);
      });
    } catch (e) { console.log(`[bridge] 隧道帧错误: ${e.message}`); }
  });
  ws.on("close", (code, reason) => {
    clearInterval(heartbeat);
    console.log(`[bridge] 隧道断开(code=${code}${reason ? ", " + reason : ""})`);
    closeAllWsSessions();
    const delay = Math.min(30_000, 2_000 * 2 ** tunnelRetry);
    tunnelRetry += 1;
    console.log(`[bridge] ${Math.round(delay / 1000)}s 后重连...`);
    setTimeout(async () => connectTunnel(code === 4003 ? await resolveToken(true) : token), delay);
  });
  ws.on("error", (e) => console.log(`[bridge] 隧道错误: ${e.message || ""}`));
}

/**
 * E2EE 启动初始化(账号模式):拉取服务端参数 → 用本机账号密码派生 MK(仅内存)。
 * 任何一步不满足都禁用 E2EE(reason 记录),bridge 走原 v1 明文路径,不影响隧道。
 * 启用结果写入 relayDir/.e2ee-state.json(供 Phase-4 UI 读取:{enabled, reason, ...})。
 * 状态文件路径策略:显式 DSH_BRIDGE_CONFIG / DSH_BRIDGE_E2EE_STATE 时落盘(生产必设),
 * 否则只打日志(避免污染仓库/非托管目录)。
 */
async function initE2ee(token) {
  const cfg = loadLocalConfig();
  const localMode = Boolean(process.env.DSH_BRIDGE_LOCAL_KEY); // 自建模式不启用(§6.6)
  const userDisabled = process.env.DSH_BRIDGE_E2EE === "0" || cfg.e2ee === false;
  const allowed = !localMode && !userDisabled;
  // 密码与 device-login 同源:env 优先,其次 .dsh-config.json(本机 0600 保存的账号密码)
  const password = PASSWORD || (typeof cfg.password === "string" && cfg.password ? cfg.password : "");
  e2ee = await E2eeService.init({ apiBase: API_BASE, token, password, allowed });
  const st = e2ee.state();
  const stateFileDir = process.env.DSH_BRIDGE_E2EE_STATE || path.dirname(CONFIG_PATH);
  if (process.env.DSH_BRIDGE_CONFIG || process.env.DSH_BRIDGE_E2EE_STATE) {
    writeE2eeStateFile(stateFileDir, { enabled: st.enabled, reason: st.reason, profile: st.profile, epoch: st.epoch, caps: e2ee.caps() });
  }
  if (st.enabled) {
    console.log(`[bridge] 🔒 E2EE 已启用(caps=[${e2ee.caps().join(",")}], profile=${st.profile}, epoch=${st.epoch});MK 仅驻内存`);
  } else {
    console.log(`[bridge] e2ee 未启用(${st.reason}) → 明文 v1 路径照常(能力不上报)`);
  }
}

async function runTunnel() {
  const token = await resolveToken();
  if (!token) {
    console.error("[bridge] 隧道模式需要账号认证:请设 DSH_BRIDGE_TOKEN,或 DSH_BRIDGE_PHONE+DSH_BRIDGE_PASSWORD");
    process.exit(1);
  }
  await initE2ee(token);
  await registerDeviceInAccount(token);
  connectTunnel(token);
  setTimeout(() => {
    console.log(`[bridge] 隧道模式运行中(上游 ${UPSTREAM},Ctrl-C 退出)`);
  }, 1000);
}

async function main() {
  // 隧道模式是唯一模式(WebRTC/信令已废弃删除)
  if (!TUNNEL_URL) {
    console.error("[bridge] 缺少 DSH_BRIDGE_TUNNEL_URL:隧道模式是唯一模式(请设 relay-router 地址)");
    process.exit(1);
  }
  return runTunnel();
}

// 直接运行(node dsh-bridge.mjs)时启动服务;被测试 import 时只导出协议函数。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

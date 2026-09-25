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
 *   ── WebSocket 透传(覆盖 /api/remote.mux|host 下行流) ──
 *     ⚠️ 修正(2026-09-20):此处原写 /api/events.mux —— 该路径在本版 DSH 里**不存在**
 *     (全包 grep 零命中),真路径是 /api/remote.mux(@deepseek-ai/dsh-api-gateway 的
 *     REMOTE_STREAM_MUX_PATH)。线上未出问题是因为本文件对路径**透明透传**、由浏览器决定
 *     请求哪个路径;但错的注释会把后来者带沟里(微信通道订阅事件流时会照着它写)。
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
 *
 * E2EE Phase-4(镜像页 shim,见 e2ee-shim.mjs / e2ee-shim-script.js):
 *   - doHttp 在 text/html 注入 mobile-adapter 之后、压缩/封包之前,对「e2ee.enabled ∧
 *     DSH_E2EE_SHIM≠0」的官方 dsh web 响应注入镜像页加密 shim(读 native.html 一次性
 *     交接单重建会话 → 拦截其 /api·/sidebar·/git·/pet 与数据 WS,信封密文化)。
 *   - 灰度默认关(e2ee.enabled=false)→ 不注入、镜像页保持既有明文路径(零行为)。
 */

import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { randomBytes, generateKeyPairSync, createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
// 移动端适配层(经隧道访问的官方 dsh web 窄屏注入;DSH_MOBILE_ADAPTER=0 可关闭,默认开启)
import { maybeInjectMobileAdapter } from "./mobile-adapter.mjs";
import { discoverUpstream, resolveUpstreamHint, FALLBACK_UPSTREAM } from "./upstream-discovery.mjs";
// 镜像页 E2EE 加密 shim(Phase-4):text/html 注入;DSH_E2EE_SHIM=0 可关闭,叠加 e2ee.enabled 灰度门
import { maybeInjectE2eeShim } from "./e2ee-shim.mjs";
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
  stripPlainWantHeader,
  wantsBinaryResponsePlain,
  writeE2eeStateFile
} from "./e2ee-client.mjs";
// 微信机器人通道(编排层):绑定控制面 + 出站通知路由 + 入站长轮询。
// ⚠️ 微信流量只走「腾讯 ilink ↔ 本机」,**不经我们的 relay**;DSH 事件走本机回环。
// 总开关 DSH_WECHAT=0(默认开启);未绑定时只起控制面,不起长轮询。
import { createWeChatRuntime } from "./wechat-runtime.mjs";

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
/**
 * 上游 dsh web 的地址。
 *
 * ⚠️ 这里**不能**只信环境变量 + 写死 3080（2026-09-23 两起用户实测）：
 *   ① `dsh web --port 8090` / `--port 0`（系统分配）→ 3080 没人听；
 *   ② **DSH Desktop**（Electron 壳 `dsh-plugin-desktop`）默认 43120，被占用还会 +1。
 * bridge 与 watcher 共用同一份发现实现（`upstream-discovery.mjs`）：
 *   显式环境变量 > `<relayDir>/.dsh-upstream`（插件半用 ctx.webServer.port 落盘）> DSH_WEB_URL
 *   > **动态发现**（本机 dsh 进程实际监听端口 + Desktop 端口区间，且每个候选都做身份校验）。
 *
 * 用 `let` 是因为：① 发现发生在启动之后（异步）；② 上游端口变了要能在**不重启 bridge** 的前提下跟上。
 */
const RELAY_DIR = path.dirname(CONFIG_PATH);
let UPSTREAM = (() => {
  const hint = resolveUpstreamHint({ relayDir: RELAY_DIR });
  return hint.url || FALLBACK_UPSTREAM;
})();
// 微信机器人通道总开关:DSH_WECHAT=0 关闭(默认开启)。控制面只 bind 回环,且必须带 bridge_secret。
const WECHAT_DISABLED = String(process.env.DSH_WECHAT || "") === "0";
// 默认云端服务地址（dsh-remote setup 会显式传入；自建模式无需账号 API）
const API_BASE = (process.env.DSH_BRIDGE_API || "https://n.risegao.cn:13443/relay-api").replace(/\/+$/, "");
const EMAIL = process.env.DSH_BRIDGE_EMAIL || "";
// 手机号优先;兼容旧的 DSH_BRIDGE_EMAIL(过渡期)
const PHONE = process.env.DSH_BRIDGE_PHONE || EMAIL;
const PASSWORD = process.env.DSH_BRIDGE_PASSWORD || "";
const TOKEN = process.env.DSH_BRIDGE_TOKEN || "";

// ---------- 本机稳定指纹(同机重装识别;供服务端自动顶替旧设备) ----------

/**
 * 读取与安装无关的机器级唯一值：macOS IOPlatformUUID / Linux machine-id / Windows MachineGuid。
 * 用途只有一个：同机卸载重装后被服务端认成同一台设备（自动顶替旧设备记录）。
 * 拿到的值**只在本机哈希**（见 machineFingerprint），原文绝不上报。
 */
function machineUniqueId() {
  if (process.env.DSH_BRIDGE_MACHINE_FP) return String(process.env.DSH_BRIDGE_MACHINE_FP).slice(0, 64);
  if (process.platform === "darwin") {
    // ⚠️ 必须用**绝对路径**：由 launchd 拉起时 PATH 来自 plist（实测 /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin），
    // **不含 /usr/sbin** —— 而 ioreg 恰好就在那里。用裸名会得到
    // "/bin/sh: ioreg: command not found"（真机日志实测），于是这里静默返回 ""，
    // 指纹退化成 hostname 哈希：用户改一次主机名就被服务端当成新设备 —— 与 Windows 那条是同一个 bug。
    for (const ioreg of ["/usr/sbin/ioreg", "ioreg"]) {
      try {
        const out = execSync(`${ioreg} -rd1 -c IOPlatformExpertDevice`, { encoding: "utf8", timeout: 5000 });
        const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
        if (m && m[1]) return m[1];
      } catch { /* 换下一个候选 */ }
    }
  } else if (process.platform === "linux") {
    for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const s = fs.readFileSync(f, "utf8").trim();
        if (s) return s;
      } catch { /* 继续 */ }
    }
  } else if (process.platform === "win32") {
    // Windows 既没有 IOPlatformUUID 也没有 machine-id，取注册表 MachineGuid
    //（Windows 安装时生成、之后稳定）—— 语义与 Linux 的 machine-id 一致：都是"每次安装一个"，
    // 所以"重装 dsh-remote 后仍认成同一台设备"这个唯一用途完全成立。
    //
    // 为什么不用 PowerShell/WMI 的 Win32_ComputerSystemProduct.UUID：
    //   · reg.exe 恒定存在于 System32，启动约 20ms；PowerShell 启动要几百毫秒；
    //   · PowerShell 在受限语言模式 / AppLocker 的企业机器上可能被策略直接禁掉，
    //     而拿不到指纹时只能退回 hostname（用户一改主机名就被当成新设备）—— 正是要修的问题；
    //   · 走 spawnSync 传数组参数，不经过 cmd.exe，因而没有引号/空格/中文路径的转义坑。
    // 同样不赌 PATH：优先 System32 下的绝对路径，取不到再退回裸名（macOS 那条就是这么栽的）。
    const regCandidates = [];
    if (process.env.SystemRoot) regCandidates.push(`${process.env.SystemRoot}\\System32\\reg.exe`);
    regCandidates.push("reg");
    for (const reg of regCandidates) {
      try {
        const r = spawnSync(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
          { encoding: "utf8", timeout: 5000, windowsHide: true });
        const m = r && r.status === 0
          ? /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,})/.exec(String(r.stdout || ""))
          : null;
        if (m && m[1]) return m[1];
      } catch { /* 换下一个候选 */ }
    }
  }
  return ""; // 读不到(如容器/受限环境) → 回退宿主名指纹
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

/**
 * bridge 运行状态文件:供 dsh web 插件面板判定「设备是否已在中继注册成功」(连接阶段 online)。
 * 面板用它把「bridge 进程在跑」与「设备已注册、手机端真的能用」区分开——后者才是用户关心的状态,
 * 只按进程存活判断会谎报可用。
 *   { device_id, started_at, account_bound_at, tunnel_registered_at, phase, last_error? }
 * 每次进程启动都 reset 一次:上一轮进程的成功记录不能代表当前这一轮。
 */
const BRIDGE_STATE_FILE = path.join(path.dirname(CONFIG_PATH), ".dsh-bridge-state.json");
function persistBridgeState(patch, opts = {}) {
  try {
    fs.mkdirSync(path.dirname(BRIDGE_STATE_FILE), { recursive: true });
    let base = {};
    if (!opts.reset) {
      try { base = JSON.parse(fs.readFileSync(BRIDGE_STATE_FILE, "utf8")) || {}; } catch { base = {}; }
    }
    fs.writeFileSync(BRIDGE_STATE_FILE, JSON.stringify({ ...base, ...patch, at: Date.now() }, null, 2), { mode: 0o600 });
  } catch { /* 非关键:面板侧还有日志/账号兜底判据 */ }
}

// ---------- 安装来源 / 版本(服务端设备行统计口径) ----------
// DSH_BRIDGE_INSTALL_SOURCE 由一键安装器(dsh-setup.mjs)注入 = npx;未设置表示这台电脑走的是
// 「插件市场装面板插件 + 插件自愈补装运行环境」那条路径 = plugin_market;白名单外一律 unknown。
const INSTALL_SOURCE_VALUES = new Set(["npx", "plugin_market"]);
function resolveInstallSource() {
  const v = String(process.env.DSH_BRIDGE_INSTALL_SOURCE || "").trim();
  if (INSTALL_SOURCE_VALUES.has(v)) return v;
  return v ? "unknown" : "plugin_market";
}
/** 安装版本:安装器注入的包版本优先,其次本包 package.json 版本(读不到留空)。 */
function resolveInstallVersion() {
  const v = String(process.env.DSH_BRIDGE_INSTALL_VERSION || "").trim();
  if (v) return v;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "";
  } catch { return ""; }
}
const INSTALL_SOURCE = resolveInstallSource();
const INSTALL_VERSION = resolveInstallVersion();

// ---------- 稳定设备身份(.dsh-config.json) ----------

function loadLocalConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

/**
 * 把文件权限收紧到「只有本人可读写」。
 *
 * ⚠️ Windows 上 `{ mode: 0o600 }` 是**空操作**（Windows 用 ACL，不是 POSIX mode 位）：
 * 实测 .dsh-config.json 拿到的是用户目录的默认**继承 ACL**（AreAccessRulesProtected=False），
 * 也就是说代码里那句 0600 对 Windows 用户完全没效果 —— 而文件里是**明文账号密码**。
 * 风险不在"同机他人可读"（默认 ACL 下其实读不到），而在**任何按文件复制的场景**
 * （备份/同步盘/杀软上报/崩溃转储/用户发给作者的支持包）都会连钥匙一起被带走，
 * 而文档里的"0600 请妥善保护"会让用户误以为 Windows 上已有这层保护。
 * 这里显式断开继承、只授予当前用户；失败只警告一次，绝不影响主流程。
 */
let hardenWarned = false;
function hardenFile(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* POSIX 上失败不致命 */ }
  if (process.platform !== "win32") return;
  const who = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  // 两个环境变量都取不到时**绝不能静默返回**：那会让人以为文件已加固，实际仍是继承 ACL。
  // 正常 Windows 会话不会走到这里（USERNAME 必然存在），但受限令牌/服务账户下有可能。
  if (!who) {
    if (!hardenWarned) {
      hardenWarned = true;
      console.warn(`⚠️ 无法收紧文件权限（USERDOMAIN/USERNAME 均未设置）：${file}`);
    }
    return;
  }
  let r;
  try {
    r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`],
      { windowsHide: true, encoding: "utf8", timeout: 8000 });
  } catch (e) { r = { status: -1, stderr: e.message }; }
  if (r.status !== 0 && !hardenWarned) {
    hardenWarned = true;
    console.warn(`⚠️ 收紧文件权限失败（${who}）：${String(r.stderr || "").trim() || `icacls 退出码 ${r.status}`}`);
    console.warn("   配置文件可能仍可被其它账户/备份工具读取，请自行确认其存放位置。");
  }
}

function saveLocalConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    hardenFile(CONFIG_PATH); // Windows 上 mode 是空操作 → 显式收紧 ACL（内含明文账号密码）
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
/** dsh web 因会话失效返回的 401 文案(见 @deepseek-ai/dsh-client-connection 的 writeUnauthorized)。 */
const HARNESS_UNAUTHORIZED_TEXT = "dsh web authentication required";
/** 撞到 401 时写的「作废」标记:插件在面板轮询时看到它就会立刻重换 Cookie(见 node 半 ensureHarnessCookie)。 */
const HARNESS_COOKIE_REVOKED_FILE = ".harness-cookie-revoked";
function markHarnessCookieRevoked() {
  try {
    const p = path.join(path.dirname(CONFIG_PATH), HARNESS_COOKIE_REVOKED_FILE);
    fs.writeFileSync(p, String(Date.now()), { mode: 0o600 });
  } catch { /* 忽略:标记只为加速自愈 */ }
}
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


/** 上游重新发现的冷却:失败请求可能连成片,不能每个都去 lsof/pgrep + 探端口。 */
const UPSTREAM_REFRESH_COOLDOWN_MS = 15_000;
let upstreamRefreshedAt = 0;
let upstreamRefreshInflight = null;
/**
 * 重新解析上游地址(带身份校验;显式 DSH_BRIDGE_UPSTREAM 时是恒等操作)。
 * 上游端口变了(Desktop 换端口 / dsh web 重启到别的端口)时,靠它自愈而不必重启 bridge。
 */
async function refreshUpstream(reason = "") {
  if (upstreamRefreshInflight) return upstreamRefreshInflight;
  const now = Date.now();
  if (now - upstreamRefreshedAt < UPSTREAM_REFRESH_COOLDOWN_MS) return UPSTREAM;
  upstreamRefreshedAt = now;
  upstreamRefreshInflight = (async () => {
    try {
      const found = await discoverUpstream({ relayDir: RELAY_DIR });
      if (found.url && found.url !== UPSTREAM) {
        console.log(`[bridge] 上游地址切换: ${UPSTREAM} → ${found.url}（来源 ${found.source}${reason ? `,${reason}` : ""}）`);
        UPSTREAM = found.url;
      }
      return UPSTREAM;
    } catch {
      return UPSTREAM;
    } finally {
      upstreamRefreshInflight = null;
    }
  })();
  return upstreamRefreshInflight;
}

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
  if (type === "http-abort") {
    // 手机侧断开了这条流(切页/锁屏):掐掉上游,别在电脑上留一条永不结束的 SSE 连接。
    const c = streamAborts.get(id);
    if (c) {
      streamAborts.delete(id);
      try { c.abort(); } catch { /* ignore */ }
    }
    return;
  }
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
 *   - `contentEncoding` 为空 —— ⚠️ 它指的是**手上这份 buf 的编码**,不是上游响应头的值:
 *     上游头的 "gzip" 在 undici 解压后依然留着(见下),照抄过来只会让我们白丢压缩收益;
 *     调用方必须传"buf 是否已编码",dsh-bridge 的 doHttp 因此**固定传空串**。
 *     若哪天 buf 真是一段未解压的字节流,调用方才应把对应编码传进来(函数会保守放弃压缩)。
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

/**
 * 进行中的 SSE 流:frameId → AbortController。
 * 手机侧断开时,中继会发 `http-abort`,这里据此掐掉上游(否则电脑上会留一条永不结束的连接)。
 */
const streamAborts = new Map();

/**
 * 中继在 `tunnel-register-ok` 里声明支持的**追加帧能力**。
 *
 * 为什么必须协商:browser→中继→bridge 是两段**独立升级**的链路。
 * 新 bridge 的流式帧(`http-chunk`/`http-end`)对**旧中继**是不认识的 —— 旧中继会把
 * "仅头部"帧当成一个完整的空响应直接 `end()`,SSE 于是变成"秒断 + 浏览器狂重连",
 * 比原来的 120 秒挂起**更糟**。所以能力由中继声明:拿不到 `http-stream` 就老实退回
 * 旧的整包缓冲行为(慢,但正确)。默认空集合 = 保守(连不上/旧中继都不冒险用新帧)。
 */
const routerCaps = new Set();

/**
 * SSE(`text/event-stream`)流式转发。
 *
 * 为什么必须流式:`doHttp` 是「整包 `await res.arrayBuffer()`」的语义,而 SSE **永不结束** ——
 * 实测 DSH 的 `/plugins/events`(client-hmr 的事件通道)每次页面加载都把这条请求挂满
 * bridge 的 120s 上游超时,然后报错;浏览器 EventSource 立刻重连,于是手机端 Network 里
 * **永远有一条转圈的请求**,页面也始终拿不到事件。
 *
 * 帧协议(对中继**追加**、与既有 `http` 帧并存;不认识 streaming 的旧中继只会忽略后续
 * chunk,退化成"空 body 后结束",不会把页面打挂):
 *   ← { id, type:"http",       status, headers, streaming:true }  仅头部,无 body
 *   ← { id, type:"http-chunk", seq, body, bodyBase64:true }       0..n 次
 *   ← { id, type:"http-end",   seq }                              流结束(含出错收尾)
 *   → { id, type:"http-abort" }                                   手机断开 → 掐上游
 *
 * ⚠️ E2EE 路径**不**走这里:信封是"一问一答"的结构,SSE 要逐块封/解需要另立协议;
 *    而现实里 SSE 由 `EventSource` 发出、shim 不接管它(不带头部信封标记),
 *    所以密文流根本不存在 —— 真要做时再单独设计,不要在这里偷偷降级成明文。
 *
 * @returns {Promise<{status:number, chunks:number, bytes:number, aborted?:boolean}>}
 */
async function doHttpStream(send, id, method, path, reqHeaders) {
  const safe = safePath(path);
  if (safe === null) throw new Error("非法路径");
  const reqHdrs = sanitizeRequestHeaders(reqHeaders);
  const ck = harnessCookieOf(); // 新版 dsh web 的浏览器会话 Cookie(否则 401 白页)
  if (ck) reqHdrs.Cookie = ck;
  const controller = new AbortController();
  streamAborts.set(id, controller);

  let res;
  try {
    res = await fetch(`${UPSTREAM}${safe}`, { method, headers: reqHdrs, signal: controller.signal });
  } catch (e) {
    streamAborts.delete(id);
    throw e; // 头部都还没发出去 → 交给调用方回一个普通错误帧
  }

  const status = res.status;
  // 头部帧:告诉中继"这是一条流",随后才逐块推 body
  send({
    id,
    type: "http",
    status,
    headers: sanitizeResponseHeaders(Object.fromEntries(res.headers.entries())),
    streaming: true
  });

  let seq = 0;
  let bytes = 0;
  try {
    const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        bytes += value.length;
        send({ id, type: "http-chunk", seq: ++seq, body: Buffer.from(value).toString("base64"), bodyBase64: true });
      }
    }
  } catch (e) {
    // 头部已经发出去了:这里**绝不能**抛(调用方会用普通帧回 502,而中继那边响应头已定,
    // 再写一次 head 会炸)。统一以 http-end 收尾,让 EventSource 按自己的节奏重连。
    const aborted = controller.signal.aborted === true;
    streamAborts.delete(id);
    send({ id, type: "http-end", seq, ...(aborted ? { aborted: true } : { error: String(e?.message || e) }) });
    return { status, chunks: seq, bytes, aborted };
  }
  streamAborts.delete(id);
  send({ id, type: "http-end", seq });
  return { status, chunks: seq, bytes };
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
  let res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  let buf = Buffer.from(await res.arrayBuffer());
  // 手机端 401「dsh web authentication required」自愈:
  //   dsh web 每次重启都会换签名密钥 → 插件代持的旧 Cookie 立即失效。撞到该 401 时
  //   ① 写「作废」标记(插件在面板轮询时秒级重换 Cookie);
  //   ② 若此刻 Cookie 已被插件换成新的(文件变了),**立刻用新 Cookie 重试一次** ——
  //      这样用户连一次错误页都看不到,不需要任何手动操作。
  if (res.status === 401) {
    const text = buf.length > 0 && buf.length < 4096 ? buf.toString("utf8") : "";
    if (text.includes(HARNESS_UNAUTHORIZED_TEXT)) {
      markHarnessCookieRevoked();
      const fresh = harnessCookieOf();
      if (fresh && fresh !== ck) {
        console.log("[bridge] 浏览器会话 Cookie 已失效,用新 Cookie 重试一次:", path);
        const retryHdrs = sanitizeRequestHeaders(reqHeaders);
        retryHdrs.Cookie = fresh;
        res = await fetch(url, { ...init, headers: retryHdrs, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        buf = Buffer.from(await res.arrayBuffer());
      } else {
        console.warn("[bridge] 浏览器会话 Cookie 已失效(已标记,等待插件重换):", path);
      }
    }
  }
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
    // E2EE 镜像页加密 shim(Phase-4):仅桥端 e2ee 启用时注入(e2ee.enabled=false → 零注入零行为)
    if (e2ee.enabled) {
      const s = maybeInjectE2eeShim({ buf, contentType });
      if (s.injected) {
        console.log(`[bridge] e2ee-shim 注入 ${path}: ${(buf.length / 1024).toFixed(0)}KB → ${(s.buf.length / 1024).toFixed(0)}KB`);
        buf = s.buf;
      }
    }
  }
  const compressed = await maybeCompressResponse({
    buf,
    contentType,
    // 🔴 必须传空:这里的 `buf` 是 **undici 已经解压过**的明文,不是上游线速字节。
    //    以前传的是 `res.headers.get("content-encoding")` —— 而 undici 解压之后**仍会把该头留着**
    //    (本文件 sanitizeResponseHeaders 的注释正是这么写的:"undici 已自动解压 body,
    //     content-encoding/length 会误导浏览器")。于是 maybeCompressResponse 看到 "gzip"
    //    就保守地 `return null`,**永不重压** —— 实测代价:线上 dsh web 的 `/plugins/??`
    //    聚合包本来 gzip 后 5.12MB,被原样发出 13.39MB(2.6×),免费档 1Mbps 下从 40 秒变成 100+ 秒。
    //    传空之后语义才是自洽的:"我手上这份 buf 是未编码的明文,可以压"。
    contentEncoding: "",
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

/**
 * 构造 e2ee http 响应帧（**导出给用例**：第三层 base64 的去留必须有测试钉住）。
 *
 * 【0.6.15】这里曾经是 `body: Buffer.from(JSON.stringify(respEnv)).toString("base64")`
 * + `bodyBase64: true` —— 也就是把整个信封 JSON 再 base64 一次。中继拿到它做的第一件事
 * 就是解回 UTF-8 再写给手机，所以这一层**纯属白花 33% 流量**，而且正好落在按流量计量的
 * bridge→中继 那条 WS 上（业主实测那条聚合包：12.69 MiB vs 直接发 UTF-8 的 9.5 MiB）。
 * 中继对两种形态都支持（`frame.bodyBase64` 真假之分），所以直接发 UTF-8 明文即可。
 *
 * @param {string|number} id 帧 id
 * @param {string} sessId E2EE 会话 id（只进标记头）
 * @param {object} respEnv 已封好的响应信封
 * @returns {{id:any,type:string,status:number,headers:object,body:string,bodyBase64:boolean}}
 */
export function e2eeHttpResponseFrame(id, sessId, respEnv) {
  return {
    id,
    type: "http",
    status: 200, // 外层一律 200,真实状态在信封明文 st 里(§4.3)
    headers: {
      "content-type": ENVELOPE_CONTENT_TYPE,
      "x-dsh-e2ee": `v=2;s=${sessId};k=http-resp`
    },
    body: JSON.stringify(respEnv),
    bodyBase64: false // ★ 第三层 base64 在这里被去掉（见上）
  };
}

export async function handleHttpFrame(dchOrSend, frame) {
  const send = toSender(dchOrSend);
  const { id, method = "GET", path = "/", headers = {}, body, bodyBase64: isB64 } = frame;
  const t0 = Date.now();
  // 桌面授权引导(方案A):POST /_e2ee/intro(device/channel 形态归一)—— 本地应答,不连上游
  if (method === "POST" && path === "/_e2ee/intro") {
    return answerIntro(send, id);
  }
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
      // 客户端是否声明"响应用二进制明文框架"（省掉正文那一层 base64，见 e2ee-client.mjs 长注释）。
      // 老客户端（native.html 的 WC-CORE / 企业版内置那份）不声明 → 照旧走 JSON，零影响。
      // ★ 这个头**无条件**摘掉再转发：它是端到端内部协商头，不是业务头，不该出现在上游请求里
      //   （哪怕客户端给了个我们看不懂的值，也不能原样漏给 dsh web）。
      const wantBinPlain = wantsBinaryResponsePlain(req.headers);
      const upstreamHeaders = stripPlainWantHeader(req.headers);
      const reply = await doHttp(req.method, req.path, upstreamHeaders, req.bodyB64, true);
      const bodyBuffer = Buffer.from(reply.body, "base64");
      const plain = encodeHttpResponsePlain({ status: reply.status, headers: reply.headers, bodyBuffer, binary: wantBinPlain });
      // 响应压缩已发生在 doHttp(明文侧,gzip 在加密前 §4.7);信封用 http-resp kind
      const respEnv = session.seal({ kind: "http-resp", dir: "b2p", counter: env?.c ?? 0, data: plain, reqNonceB64: String(env?.n || "") });
      // ★ 0.6.15：**不再**把整个信封 JSON 再 base64 一次（第三层）。理由见 e2eeHttpResponseFrame。
      send(e2eeHttpResponseFrame(id, env.s, respEnv));
      console.log(`[bridge] e2ee http ${req.method} ${req.path} → ${reply.status} (${Date.now() - t0}ms, 信封 ${(reply.body.length * 3 / 4 / 1024).toFixed(0)}KB)`);
      return;
    } catch (e) {
      console.error(`[bridge] e2ee http ${method} ${path} 解封失败: ${e.message || e}(不回退明文)`);
      return sendE2eeHttpError(send, id, e);
    }
  }
  try {
    // SSE 必须流式转发(否则会挂满 120s 超时,见 doHttpStream 注释)。
    // 客户端是 EventSource 时必带 Accept: text/event-stream,以此为准(不看路径白名单,免得漏)。
    if (routerCaps.has("http-stream") && String(headerValue(headers, "accept") || "").includes("text/event-stream")) {
      const s = await doHttpStream(send, id, method, path, headers);
      console.log(`[bridge] ${method} ${path} → SSE ${s.status} (${Date.now() - t0}ms, ${s.chunks} 块 / ${(s.bytes / 1024).toFixed(1)}KB${s.aborted ? ", 手机已断开" : ""})`);
      return;
    }
    const reply = await doHttp(method, path, headers, body, !!isB64);
    reply.id = id;
    reply.type = "http";
    send(reply);
    console.log(`[bridge] ${method} ${path} → ${reply.status} (${Date.now() - t0}ms, ${(reply.body.length * 3 / 4 / 1024).toFixed(0)}KB)`);
  } catch (e) {
    // 上游不可达是「端口可能变了」的最强信号（Desktop 换端口 / dsh web 重启到别的端口）：
    // 触发一次带冷却的重新发现，后续请求自动跟上，不必重启 bridge。
    void refreshUpstream("上游请求失败");
    console.log(`[bridge] ${method} ${path} 上游错误: ${e.message}`);
    send({ id, type: "http", status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: String(e.message || e) })).toString("base64"), bodyBase64: true });
  }
}

/** 桌面授权引导(方案A):POST /_e2ee/intro —— 桥端本地应答,不连上游。
 *  路由层已按 dsh_token cookie 完成同账号授权(device/channel 形态都只到本设备);
 *  这里仅当桥端 E2EE 启用时一次性下发派生 MK(内存转发,不落盘不写日志)。 */
function answerIntro(send, id) {
  let ok = false;
  let body;
  try {
    const g = e2ee.introGrant();
    body = { ok: true, v: 2, grant: "desktop-intro", mk: g.mk, profile: g.profile, epoch: g.epoch, ts: Date.now() };
    ok = true;
    console.log("[bridge] e2ee intro → 手机(同一账号,已授权;MK 仅内存一次性下发)");
  } catch (e) {
    const code = e instanceof E2eeError ? e.code : "e2ee_disabled";
    body = { ok: false, v: 2, error: { code, message: e?.message || "电脑端未启用端到端加密,无法授权引导" } };
    console.log(`[bridge] e2ee intro 被拒(${code}): ${e?.message || ""}`);
  }
  send({
    id,
    type: "http",
    status: ok ? 200 : 409,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: Buffer.from(JSON.stringify(body)).toString("base64"),
    bodyBase64: true
  });
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
    void refreshUpstream("上游请求失败(legacy)");
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
        // 登录成功 = 限流窗口已结束（服务端成功即清零），把退避提示删掉让 watcher 恢复正常节奏
        try { fs.rmSync(path.join(path.dirname(CONFIG_PATH), ".dsh-login-ratelimited"), { force: true }); } catch { /* 非关键 */ }
        return d.token;
      }
      if (r.status === 429) {
        // 服务端登录限流（每 IP 5 次失败 / 15 分钟）。**这不是密码错**：
        // 旧文案一律提示"请检查 DSH_BRIDGE_EMAIL / DSH_BRIDGE_PASSWORD"，把限流误报成凭据问题，
        // 用户会去反复改密码、反而把窗口拖长（2026-09-19 实测）。
        const waitMs = Number(d.retry_after_ms) > 0 ? Number(d.retry_after_ms) : 0;
        console.error(`[bridge] 登录被服务端限流（429）${waitMs ? `，约 ${Math.ceil(waitMs / 1000)} 秒后自动重试` : "，请稍后自动重试"}`);
        console.error("[bridge] 凭据没错，是这台机器的出口 IP 短时间登录失败过多被临时限制；无需改密码。");
        // 把"最早可重试时刻"落盘：watcher 据此退避，避免 10 秒一次空撞限流
        try {
          const until = Date.now() + (waitMs || 5 * 60 * 1000);
          fs.writeFileSync(path.join(path.dirname(CONFIG_PATH), ".dsh-login-ratelimited"), String(until));
        } catch { /* 非关键 */ }
        process.exit(3);
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
        machine_fp: MACHINE_FP, // v6 同机识别:服务端据此自动顶替旧设备(重装不再被设备数卡死)
        // 安装口径(服务端存到设备行,用于区分「市场安装/自愈补装」与「安装器 npx」):
        //   install_source: npx(安装器注入) | plugin_market(插件拉起/自愈,默认) | unknown(白名单外)
        install_source: INSTALL_SOURCE,
        install_version: INSTALL_VERSION,
        host_os: process.platform,
        host_arch: process.arch
      })
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 201 || r.status === 200) {
      clearBindError();
      persistBridgeState({ device_id: DEVICE_ID, account_bound_at: Date.now(), phase: "bound" });
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
    persistBridgeState({ device_id: DEVICE_ID, phase: "connecting" }); // 新一轮连接:上一轮的成功记录已过期
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
          // 记下中继声明的追加帧能力(旧中继不带 caps → 空集合 → 退回整包缓冲,见 routerCaps 注释)
          routerCaps.clear();
          for (const c of Array.isArray(frame.caps) ? frame.caps : []) routerCaps.add(String(c));
          // 中继注册成功 = 手机端此刻真的能进这台电脑:面板据此把阶段推进到 online(已连接 ✅)
          persistBridgeState({ device_id: DEVICE_ID, tunnel_registered_at: Date.now(), phase: "online", last_error: null });
          console.log(`[bridge] ✅ router 注册成功: ${DEVICE_ID},等待手机访问 /remote/${DEVICE_ID}/`);
          return;
        }
        if (frame?.type === "tunnel-register-err") {
          persistBridgeState({ phase: "error", last_error: { code: frame.code || "register_err", message: frame.message || "router 拒绝注册" } });
          console.error(`[bridge] router 拒绝注册: ${frame.code} ${frame.message || ""}`);
          return;
        }
        handleFrame(send, frame);
      });
    } catch (e) { console.log(`[bridge] 隧道帧错误: ${e.message}`); }
  });
  ws.on("close", (code, reason) => {
    routerCaps.clear(); // 换中继/断线:能力重新协商,期间一律退回保守行为
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

/**
 * 启动微信通道(控制面 + 已绑定时的事件通知/入站长轮询)。
 *
 * ★ 为什么**不 await**、且放在 connectTunnel 之后:
 *   微信侧是"锦上添花"的能力(发通知)。它必须**永远不能**拖慢或拖挂远程访问本身 ——
 *   所以先让隧道连上,再 fire-and-forget 起微信;任何异常只记日志,不冒泡、不 exit。
 *   与 e2ee/mobile-adapter 的定位一致:主链路优先。
 */
/** 给没自带前缀的微信日志补上 `[wechat] `;已带的原样返回(避免双重前缀)。 */
function tagWeChat(m) {
  const s = String(m);
  return s.startsWith("[") ? s : `[wechat] ${s}`;
}

/**
 * 微信通道的档位来源(免费/付费分层)。
 *
 * 取值 = 账号的**生效套餐**,服务端只有三种:free / pro / pro_max
 * (见企业端 auth.js 的 PLAN_PRIORITY;试用期服务端已折算成 pro,这里不必自己判断)。
 *
 * ★ 返回**两种契约**(见 docs/entitlements-contract.md §5/§6.1):
 *   · 服务端 `/api/me` 带了 `entitlements`(后台可配置的权益包)→ 返回**对象**
 *     `{plan, caps, limits, rev}`,runtime 以它为准判定能力 —— 这样「后台改配置 = 用户侧实时生效」
 *     才成立(无需发版)。caps/limits **原样透传**:权限判定以服务端为唯一真相源,
 *     客户端任何"二次加工/本地过滤"都会让展示与判定分叉,也会让后台配置失效(红线 §8.1/§8.2)。
 *   · 服务端**没带** `entitlements`(灰度期的旧服务端)→ 保持今天的行为、返回**字符串**档位:
 *     runtime 有上次的包就继续用它,一份包都没有才按内置表解析。新旧服务端都要能跑,
 *     所以这里不能只认新契约。
 *
 * ⚠️ 取不到时返回**空串**,而不是 "free":空串让 runtime 沿用上次成功取到的档位。
 *    一次网络抖动就把付过钱的用户降级成免费、还提示他去升级,比多给几分钟权限糟糕得多。
 * ⚠️ 自建部署直接给最高档:用户跑的是自己的服务器,不存在"会员"这回事,
 *    不能拿 SaaS 的分层去卡自建用户。
 */
/**
 * 档位查询专用的 token 缓存(理由见 resolveWechatTier 里的注释)。
 * TTL 取 5 分钟:远小于 JWT 有效期,又足以把「每 10 分钟一次定时校准 + 被拒即重查」
 * 全部挡在网络之外 —— 不缓存的话,免费用户连着发几条消息就会触发一串 device-login。
 */
const WECHAT_TIER_TOKEN_TTL_MS = 5 * 60_000;
let WECHAT_TIER_TOKEN = { value: "", at: 0 };
/**
 * 最近一次 `/api/me` 的账号快照(查档位时顺手记下来)。
 *
 * 为什么需要:微信通道要做"会员临近到期"提醒,而它**不该再单独打一次** `/api/me` ——
 * 档位每 10 分钟本来就会查一次,顺手记住即可。查失败时**保持上次的值**(与档位同一策略:
 * 一次网络抖动不该让提醒凭空消失或变成乱猜)。
 */
let WECHAT_ACCOUNT_SNAPSHOT = null;
/** 供微信通道取账号快照(到期提醒用)。没查过就返回 null → 上层什么都不发。 */
async function wechatAccountInfo() {
  return WECHAT_ACCOUNT_SNAPSHOT;
}

async function resolveWechatTier() {
  if (process.env.DSH_BRIDGE_LOCAL_KEY) return "pro_max";
  try {
    // ⚠️ `resolveToken()` **不带缓存**:账号模式下每调一次就重新 device-login 一次
    //    (见它的第一行,只有 DSH_BRIDGE_TOKEN / 自建模式才短路)。
    //    而档位会被反复查询:每 10 分钟一次定时校准 + 免费用户**每次被拒**都重查(最快 5 秒一次)。
    //    拿它直接查 = 用户连着发几条消息就把自己打到登录限流里 —— 而 /api/device-login
    //    是**按出口 IP 限流**的(15 分钟 5 次),连累的不只是他自己。
    //    所以这里自己缓存 token。
    const now = Date.now();
    if (!WECHAT_TIER_TOKEN.value || now - WECHAT_TIER_TOKEN.at > WECHAT_TIER_TOKEN_TTL_MS) {
      const t = await resolveToken();
      if (!t) return "";
      WECHAT_TIER_TOKEN = { value: t, at: now };
    }
    const r = await fetch(`${API_BASE}/api/me`, {
      headers: { authorization: `Bearer ${WECHAT_TIER_TOKEN.value}` },
      signal: AbortSignal.timeout(6000)
    });
    // token 过期/被吊销 → 丢掉缓存,下一次查询重新登录(而不是一直拿坏 token 打)
    if (r.status === 401 || r.status === 403) {
      WECHAT_TIER_TOKEN = { value: "", at: 0 };
      return "";
    }
    if (!r.ok) return "";
    const j = await r.json().catch(() => null);
    const u = (j && j.user) || null;
    // 顺手记账号快照(到期提醒用)。⚠️ 只在**真拿到了 user** 时覆盖 —— 否则保持上次。
    if (u) {
      WECHAT_ACCOUNT_SNAPSHOT = {
        plan: String(u.plan || ""),
        plan_ends_at: u.plan_ends_at ?? null,
        trial_expires_at: u.trial_expires_at ?? null
      };
    }
    // ★ 服务端权益包(契约 §5):有它就返回对象,runtime 以服务端 caps/limits 为准。
    //
    // 🔴 判据是「`caps` 是**数组**」,**空数组也算给了**(2026-09-23 修):
    //   后台「明确清空」某档(契约 §4.1 的 `EMPTY_CAPS_VALUE`,下发即 `caps: []`)表达的是
    //   **这个档位什么能力都没有**。如果这里把空数组当成"没给",runtime 就会沿用上次那份包
    //   (一份都没有时回退**内置表**)—— 于是"我清空了 pro"变成"pro 拿回内置的一整套付费能力",
    //   比后台意图**更多**权限。那是 fail-open,方向正好反了(契约 §8 红线 2)。
    //   所以:数组(含空) = 权威;不是数组/字段缺失 = 这次没拿到 → 退回字符串契约沿用上次。
    const ent = j && j.entitlements;
    if (ent && typeof ent === "object" && Array.isArray(ent.caps)) {
      return {
        // plan 也原样取服务端的值;只有权益包里缺 plan 时才退回 user.plan(同一份真相的旧字段)。
        plan: String(ent.plan || (u && u.plan) || ""),
        caps: ent.caps,
        // ⚠️ limits 缺失时必须给 null,**不能补 `{}`**:runtime 里 `{}` 是"有效的一张限制表",
        //    于是 messages_per_month 读成 0 = 不限 → 免费用户当场变成无限额度(等于放权)。
        //    null 才会让 runtime 沿用上次的值 / 回退内置表 —— 缺字段绝不等于放开(契约 §8.2 fail-closed)。
        limits: ent.limits && typeof ent.limits === "object" ? ent.limits : null,
        rev: String(ent.rev || "")
      };
    }
    // 没有权益包(旧服务端 / 灰度期)→ 保持旧契约:只给档位字符串。
    // runtime 收到字符串后:有上次的包就继续用它,一份包都没有才按内置表解析(冷启动兜底)。
    return String((u && u.plan) || "");
  } catch {
    return "";
  }
}

/**
 * App 入口(免费用户越界时给的转化链接)。
 * 由账号 API 地址推导:去掉 `/relay-api` 再加 `/app/` —— 与插件半的 DEFAULT_APP_URL 同一口径
 * (https://host:port/relay-api → https://host:port/app/)。
 */
function wechatAppUrl() {
  return `${API_BASE.replace(/\/relay-api\/?$/, "")}/app/`;
}

let wechatRuntime = null;
function startWeChat() {
  if (WECHAT_DISABLED) {
    console.log("[bridge] 微信通道已禁用(DSH_WECHAT=0)");
    return;
  }
  try {
    const relayDir = path.dirname(CONFIG_PATH);
    const cfg = loadLocalConfig();
    wechatRuntime = createWeChatRuntime({
      relayDir,
      // 上游地址在 runTunnel() 开头已完成动态发现（见 refreshUpstream），所以这里拿到的是真实端口。
      // ⚠️ 这是**取值**而非引用：运行中若上游端口又变了（自愈重发现），微信通道要等 bridge 重启才跟上；
      //    隧道转发那一侧不受影响（它每次都读最新的 UPSTREAM）。
      upstream: UPSTREAM,
      cookieOf: harnessCookieOf,
      secret: process.env.DSH_BRIDGE_SECRET || (typeof cfg.bridge_secret === "string" ? cfg.bridge_secret : ""),
      // 免费/付费分层:档位来自账号的生效套餐,App 链接是免费用户越界时的转化入口。
      tierProvider: resolveWechatTier,
      // 到期提醒的数据来源(复用上面那次 /api/me,不额外打网络)
      accountInfo: wechatAccountInfo,
      appUrl: wechatAppUrl(),
      // 模块自己的消息已带 `[wechat]` / `[wechat/events]` 前缀,这里**不能再加一次**
      // (真机日志里出现过 `[wechat] [wechat] 控制面已就绪`)。没前缀的兜底补一个。
      logger: {
        info: (m) => console.log(tagWeChat(m)),
        warn: (m) => console.warn(tagWeChat(m)),
        error: (m) => console.warn(tagWeChat(m)),
        debug: () => {},
        // WeChatChannel 构造时会给 token 登记脱敏;这里保持同样契约(日志不落 token)
        addSecret: () => {}
      }
    });
    wechatRuntime.start().catch((e) => {
      console.warn(`[bridge] 微信通道启动失败(不影响远程访问): ${redactText(e)}`);
    });
  } catch (e) {
    console.warn(`[bridge] 微信通道初始化失败(不影响远程访问): ${redactText(e)}`);
    wechatRuntime = null;
  }
}

/** 优雅退出微信通道(notifystop + 关控制面)。失败只记日志。 */
async function stopWeChat() {
  const rt = wechatRuntime;
  wechatRuntime = null;
  if (!rt) return;
  try {
    await rt.stop();
  } catch (e) {
    console.warn(`[bridge] 微信通道停止失败(忽略): ${redactText(e)}`);
  }
}

function redactText(e) {
  return String(e && e.message ? e.message : e).slice(0, 200);
}

async function runTunnel() {
  // 先动态确定上游再连隧道：上游端口不是 3080 时（DSH Desktop 默认 43120）这一步是关键 ——
  // 否则 bridge 会连上中继、手机也能打开页面，但每个请求都打到一个没人听的端口。
  await refreshUpstream("启动");
  console.log(`[bridge] 上游地址已确定: ${UPSTREAM}`);
  const token = await resolveToken();
  if (!token) {
    console.error("[bridge] 隧道模式需要账号认证:请设 DSH_BRIDGE_TOKEN,或 DSH_BRIDGE_PHONE+DSH_BRIDGE_PASSWORD");
    process.exit(1);
  }
  // 把刚拿到的 JWT 喂给档位查询的缓存:否则 startWeChat 里的档位校准会**再登录一次**
  // (真机日志实测:同一个桥接启动里出现两条并发的 device-login)。
  // 而 /api/device-login 是按出口 IP 限流的 —— 每次启动都多花一份登录额度没有道理。
  WECHAT_TIER_TOKEN = { value: token, at: Date.now() };
  // 新进程开始:重置状态文件(上一轮的成功记录不能代表这一轮,面板据此判定 online)
  persistBridgeState({ device_id: DEVICE_ID, started_at: Date.now(), phase: "connecting", last_error: null }, { reset: true });
  await initE2ee(token);
  await registerDeviceInAccount(token);
  connectTunnel(token);
  // 隧道已发起后再起微信:主链路优先,微信永不阻塞远程访问
  startWeChat();
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
  // ⚠️ 本文件此前**一个 process.on 都没有** —— 被 launchd/systemd/schtasks 杀掉时,
  // 微信长轮询不会收到信号,腾讯侧会一直以为通道在线(notifystop 永远不发)。
  // 只注册在 main() 里(被测试 import 时不污染测试进程)。
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bridge] 收到 ${sig},正在优雅退出...`);
    await stopWeChat();
    process.exit(0);
  };
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  // 【Windows 的关键一条】Windows 上 process.kill() 是**无条件 TerminateProcess**：
  // 上面的 SIGTERM/SIGINT 处理函数在 Windows 上**永远不会被执行**，
  // 于是 notifystop（微信通道下线通知）永远发不出去，腾讯侧一直以为通道还在线。
  // watcher 通过 IPC 发来的 shutdown 消息是 Windows 上唯一能真正跑到的优雅退出路径
  //（POSIX 上也一并走这条，比信号更可靠）。见 src/lifecycle.mjs 的 stopChildGracefully。
  process.on("message", (m) => {
    if (m && m.type === "shutdown") shutdown("IPC shutdown");
  });
  return runTunnel();
}

// 直接运行(node dsh-bridge.mjs)时启动服务;被测试 import 时只导出协议函数。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

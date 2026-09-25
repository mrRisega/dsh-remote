/**
 * 上游（dsh web）地址发现 —— **单一实现**，watcher（dsh-setup.mjs）与 bridge（dsh-bridge.mjs）共用。
 *
 * ## 为什么需要它
 *
 * 桥接链路的两端（watcher 的存活探测、bridge 的转发目标）原本把上游写死
 * `http://127.0.0.1:3080`（独立 `dsh web` 的默认端口）。但真实世界里端口是会变的：
 *
 *   · `dsh web --port 8090` / profile 里配了 port / `--port 0` 让系统分配空闲端口；
 *   · **DSH Desktop**（Electron 壳 `dsh-plugin-desktop`）默认监听 **43120**，且被占用时按 +1 递增；
 *   · `dsh web` 重启后端口可能不同。
 *
 * 2026-09-23 用户实测（DSH Desktop 2.0.4 + 插件 0.6.10）：上游在 43120，而 watcher 探 3080 →
 * **永远探不到 → bridge 永远不被派生 → 面板永久停在「正在启动 Bridge…」**，设备从未登记。
 * 这不是"某个用户环境特殊"，而是**所有改了端口的用户**都会踩的同一类问题，所以要有通用发现。
 *
 * ## 发现顺序（先便宜后昂贵，每一步都做**身份校验**）
 *
 *   1. `DSH_BRIDGE_UPSTREAM`（显式覆盖，部署/排障用）—— 唯一不做探测就采信的来源；
 *   2. `<relayDir>/.dsh-upstream`（**插件半**在宿主进程里用 `ctx.webServer.port` 落盘，最权威）；
 *   3. `DSH_WEB_URL` 的端口；
 *   4. **实测端口**：本进程的祖先进程 / 本机 dsh 进程正在 LISTEN 的端口（lsof / netstat）；
 *   5. 静态候选：3080 + DSH Desktop 的 43120 及其递增区间。
 *
 * ⚠️ 第 4、5 步必须**校验身份**：43120 之类的端口可能被别的本地程序占用，
 *    把 bridge 接到一个陌生人身上既不可用、也可能泄露数据。判据见 `looksLikeDshWeb`。
 *
 * ⚠️ 探测全部**并行**且有总预算：本地端口连接被拒是瞬时的，只有"端口在听但不回包"才会等到超时，
 *    串行探 12 个候选最坏要十几秒，会让 watcher 的轮询卡住。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 插件半落盘的上游地址文件名（与 packages/dsh-remote-web/lib/index.js 的常量同名同义）。 */
export const UPSTREAM_FILE = ".dsh-upstream";
/** 独立 `dsh web` 的默认端口（历史行为，最后的兜底）。 */
export const FALLBACK_UPSTREAM = "http://127.0.0.1:3080";
/** DSH Desktop（Electron 壳）的默认 Web 端口；被占用时它按 +1 递增，所以要扫一段区间。 */
export const DESKTOP_DEFAULT_PORT = 43120;
/** Desktop 端口区间扫多少个（43120..43120+11）。 */
export const DESKTOP_PORT_SCAN = 12;
/** 单个候选的探测超时（本地回环，超过它基本就是"在听但不回包"）。 */
const PROBE_TIMEOUT_MS = 900;

/** 规范化：去尾斜杠；非 http(s) 一律丢弃（返回空串）。 */
export function normalizeUpstream(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) return "";
  return raw.replace(/\/+$/, "");
}

/** 从字符串里取端口（拿不到返回 0）。 */
function portOf(value) {
  try {
    const n = Number(new URL(String(value)).port);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 1) 显式环境变量。 */
export function upstreamFromEnv(env = process.env) {
  return normalizeUpstream(env.DSH_BRIDGE_UPSTREAM);
}

/** 2) 插件半落盘的端口文件（插件不在场/首次安装时可能没有）。 */
export function upstreamFromFile(relayDir) {
  if (!relayDir) return "";
  try {
    return normalizeUpstream(fs.readFileSync(path.join(relayDir, UPSTREAM_FILE), "utf8"));
  } catch {
    return "";
  }
}

/** 3) DSH_WEB_URL 的端口（bridge 的 loopback 围栏只认 127.0.0.1，这里也统一回环地址）。 */
export function upstreamFromDshWebUrl(env = process.env) {
  const raw = String(env.DSH_WEB_URL || "").trim();
  if (!raw) return "";
  const port = portOf(raw);
  return port ? `http://127.0.0.1:${port}` : "";
}

/**
 * 按优先级取出"提示地址"（不做任何网络探测）。
 * @returns {{url: string, source: "env"|"file"|"dsh_web_url"|""}}
 */
export function resolveUpstreamHint({ relayDir = "", env = process.env } = {}) {
  const explicit = upstreamFromEnv(env);
  if (explicit) return { url: explicit, source: "env" };
  const fromFile = upstreamFromFile(relayDir);
  if (fromFile) return { url: fromFile, source: "file" };
  const fromWebUrl = upstreamFromDshWebUrl(env);
  if (fromWebUrl) return { url: fromWebUrl, source: "dsh_web_url" };
  return { url: "", source: "" };
}

// ---------- 实测端口（best effort，任何失败都只是少一个候选，绝不影响主流程） ----------

function tryExec(cmd, args, timeoutMs = 4000) {
  try {
    return String(execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] }) || "");
  } catch {
    return "";
  }
}

/** 某进程正在 LISTEN 的 TCP 端口。macOS/Linux 用 lsof，Windows 用 netstat -ano。 */
export function listeningPortsOfPid(pid, platform = process.platform) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return [];
  const ports = new Set();
  if (platform === "win32") {
    for (const line of tryExec("netstat", ["-ano"], 6000).split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      if (Number(cols[cols.length - 1]) !== n) continue;
      const m = /:(\d+)$/.exec(cols[1] || "");
      if (m) ports.add(Number(m[1]));
    }
    return [...ports];
  }
  const out = tryExec("lsof", ["-nP", "-a", "-p", String(n), "-iTCP", "-sTCP:LISTEN"], 5000);
  for (const line of out.split("\n")) {
    const m = /:(\d+)\s*\(LISTEN\)/.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

/** 祖先进程 pid（最多 6 层）：被插件/宿主拉起的 watcher、bridge 走这条路能找到宿主。 */
export function ancestorPids(startPid = process.pid, maxDepth = 6, platform = process.platform) {
  if (platform === "win32") return []; // Windows 无 ps；靠 netstat+pgrep 不可行，交给端口文件与静态候选
  const out = [];
  let pid = Number(startPid);
  for (let i = 0; i < maxDepth; i++) {
    const txt = tryExec("ps", ["-o", "ppid=", "-p", String(pid)], 2000).trim();
    const ppid = Number(txt);
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    out.push(ppid);
    pid = ppid;
  }
  return out;
}

/** 本机 dsh 相关进程（pgrep）—— Desktop 壳/独立 dsh web 都可能命中。 */
export function dshProcessPids(platform = process.platform) {
  if (platform === "win32") return [];
  const out = tryExec("pgrep", ["-f", "dsh"], 4000);
  return out
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid);
}

// ---------- 「本机所有回环监听端口」：NAS 上的救命稻草（0.6.15） ----------
//
// 【为什么必须加这一层】飞牛 fnOS 用户诊断（2026-09-25，插件 0.6.14）：
//   上游 dsh web: http://127.0.0.1:3080（默认值 3080（**未取到 dsh web 实际监听端口**），⚠️ 不可达）
//   他的 dsh web 实际在 **2298**（fnOS 应用里配的内部监听端口），而上面五条发现路径**全都没命中**：
//     · 插件半的 ctx.webServer.port 没取到（该环境下拿不到）；
//     · `lsof` 在 NAS 上**根本没装**；`pgrep -f dsh` 也可能没有；
//     · 静态候选只有 3080 与 Desktop 的 43120 区间 —— 2298 永远不在里面。
//   于是用户去改端口号（改成 20xx、又改回 3080）当然都没用：**没有任何一条路径会去试 2298**。
//
// 做法：直接把"这台机器上正在 LISTEN 的回环端口"全列出来当候选，再逐个做**身份校验**。
// 为什么敢全列：身份校验（`looksLikeDshWeb` / `looksLikeDshRemoteSelf`）会拒掉所有陌生服务，
// 多探几个端口只是几十毫秒；而漏掉一个端口就是"用户永远连不上"。

/** 解析 /proc/net/tcp 一行里的本地地址与状态（Linux 无依赖：不需要 ss/netstat/lsof）。 */
function parseProcNetLine(line) {
  const cols = String(line || "").trim().split(/\s+/);
  if (cols.length < 4) return null;
  const local = cols[1];
  const state = cols[3];
  const m = /^([0-9A-Fa-f]{1,32}):([0-9A-Fa-f]{1,4})$/.exec(local || "");
  if (!m) return null;
  return { hex: m[1], port: parseInt(m[2], 16), state: String(state).toUpperCase() };
}

/** 32 位小端 hex（/proc/net/tcp）→ IPv4 点分串。 */
function ipv4OfHex(hex) {
  const h = String(hex).padStart(8, "0").slice(-8);
  const bytes = [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((x) => parseInt(x, 16));
  return bytes.join(".");
}

/** 128 位 hex（/proc/net/tcp6）→ 是否回环（::1）。 */
function isIpv6LoopbackHex(hex) {
  const h = String(hex).toLowerCase().padStart(32, "0");
  // ::1 在 /proc 里按 4 组小端 32 位存放 → 末组为 01000000，其余全 0
  return /^0{24}01000000$/.test(h);
}

/** Linux：直接读 /proc/net/tcp{,6}（内核真值，NAS 上不需要任何外部命令）。 */
export function procNetLoopbackPorts() {
  const ports = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const row = parseProcNetLine(line);
      if (!row || row.state !== "0A") continue; // 0A = LISTEN
      const loop = file.endsWith("tcp6")
        ? isIpv6LoopbackHex(row.hex)
        : ipv4OfHex(row.hex).startsWith("127.");
      // 通配绑定（0.0.0.0 / ::）也收：dsh web 绑 0.0.0.0 时回环照样能连
      const wildcard = file.endsWith("tcp6") ? /^0+$/.test(String(row.hex)) : ipv4OfHex(row.hex) === "0.0.0.0";
      if (loop || wildcard) ports.add(row.port);
    }
  }
  return [...ports];
}

/** `ss -ltnH` 输出里的本地端口（Linux；部分精简系统没有 /proc，或反之）。 */
function ssLoopbackPorts() {
  const ports = new Set();
  const out = tryExec("ss", ["-ltnH"], 5000) || tryExec("ss", ["-ltn"], 5000);
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    // ss 的本地地址是第 4 列（State Recv-Q Send-Q Local Address:Port Peer Address:Port）
    const m = /[:.](\d+)$/.exec(cols[3] || "");
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

/** `netstat -ltn` 输出里的本地端口（BSD/GNU 两种格式都认）。 */
function netstatLoopbackPorts() {
  const ports = new Set();
  const out = (tryExec("netstat", ["-ltn"], 5000) || tryExec("netstat", ["-an"], 6000));
  for (const line of out.split("\n")) {
    if (!/listen/i.test(line) && !/^tcp/i.test(line)) continue;
    const m = /(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}[:.](\d+)|\[?::1?\]?[:.](\d+)/.exec(line);
    const p = m ? Number(m[1] || m[2]) : 0;
    if (p > 0 && p < 65536) ports.add(p);
  }
  return [...ports];
}

/** `lsof -nP -iTCP -sTCP:LISTEN` 输出里的本地端口（macOS/装了 lsof 的 Linux）。 */
function lsofLoopbackPorts() {
  const ports = new Set();
  const out = tryExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], 6000);
  for (const line of out.split("\n")) {
    const m = /(?:TCP\s+)?(?:\d{1,3}\.){3}\d{1,3}:(\d+)\s*\(LISTEN\)/.exec(line) || /TCP\s+\*:(\d+)/.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

/**
 * 本机所有回环（含通配绑定）LISTEN 端口，去重。
 * 多来源合并而不是"取第一个成功的"：NAS 上 lsof/ss/netstat/pgrep 各有缺失，
 * 只有合起来才够全；重复端口由 Set 消化，代价只是多读几个文件。
 */
export function allLoopbackListeningPorts(platform = process.platform) {
  const ports = new Set();
  const push = (list) => { for (const p of list) { const n = Number(p); if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n); } };
  if (platform === "win32") {
    for (const line of tryExec("netstat", ["-ano"], 6000).split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const m = /:(\d+)$/.exec(cols[1] || "");
      if (m) push([Number(m[1])]);
    }
    return [...ports];
  }
  if (platform === "linux") {
    push(procNetLoopbackPorts()); // 无依赖，优先
    push(ssLoopbackPorts());
  }
  push(lsofLoopbackPorts());
  push(netstatLoopbackPorts());
  return [...ports];
}

/**
 * 候选列表（已去重，按"可能性"排序），每项带**来源标注**（用于日志与测试断言）。
 * 顺序 = 提示里的端口 → 显式额外端口 → DSH_WEB_URL 的端口 → 祖先/dsh 进程实测监听端口
 *        → **本机所有回环监听端口** → 3080 → Desktop 默认端口区间。
 *
 * 「所有回环监听端口」排在静态候选之前：NAS 上 dsh web 的端口（实测 2298）**只可能**从这一层找到，
 * 排在 3080 之后就等于白加（3080 探测失败之前不会去试它，而静态候选有 12 个 Desktop 端口）。
 * 最后仍留静态候选兜底（宿主把端口藏得很深、/proc 也没有的极端情况）。
 * @returns {Array<{port:number, source:string}>}
 */
export function candidatePorts({ relayDir = "", env = process.env, extraPorts = [], platform = process.platform, listenPorts = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = (p, source) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0 || n >= 65536 || seen.has(n)) return;
    seen.add(n);
    out.push({ port: n, source });
  };
  const hint = resolveUpstreamHint({ relayDir, env });
  push(portOf(hint.url), hint.source || "hint");
  for (const p of extraPorts) push(p, "extra");
  push(portOf(upstreamFromDshWebUrl(env)), "dsh_web_url");
  const pids = [...new Set([process.pid, ...ancestorPids(process.pid, 6, platform), ...dshProcessPids(platform)])];
  for (const pid of pids) for (const p of listeningPortsOfPid(pid, platform)) push(p, "process");
  // ★ 本机所有回环 LISTEN 端口（0.6.15）：NAS 上 dsh web 在 2298 这类非默认端口时唯一的发现路径。
  //   调用方可以注入 listenPorts（测试用），避免用例依赖开发机真实监听表。
  const listen = Array.isArray(listenPorts) ? listenPorts : allLoopbackListeningPorts(platform);
  for (const p of listen) push(p, "listen");
  push(3080, "static");
  for (let i = 0; i < DESKTOP_PORT_SCAN; i++) push(DESKTOP_DEFAULT_PORT + i, "static");
  return out;
}

// ---------- 身份校验 ----------

/**
 * 这个地址**真的**是 dsh web 吗？
 *
 * 为什么必须有：候选探测会去敲 43120 这类可能被别的程序占用的端口。只看"端口有响应"就把
 * bridge 接上去，用户会得到一个"能连上但不工作"的怪状态，而且等于把这台机器的流量交给陌生服务。
 * 判据取 dsh web 自身的稳定特征（HTML/标题/鉴权文案），任一命中即通过。
 */
export const DSH_WEB_MARKERS = [
  "__ModuleLoader__",
  "dsh-client-modules",
  "deepseek harness",
  "dsh web authentication required",
  "dsh-remote"
];

export function looksLikeDshWeb(status, text) {
  const body = String(text || "").toLowerCase();
  if (!body) return false;
  if (status >= 500) return false;
  return DSH_WEB_MARKERS.some((m) => body.includes(m));
}

/** 本插件自己的路由（`GET /dsh-remote/self`）—— 只有"宿主这台 dsh web"才会应答。 */
export const DSH_REMOTE_SELF_PATH = "/dsh-remote/self";

/**
 * 身份校验的**第二判据**：本插件自己的 `/dsh-remote/self`。
 *
 * 为什么需要它：`looksLikeDshWeb` 依赖 dsh web 首页的 HTML 特征（`__ModuleLoader__` 等），
 * 而首页在有些部署下是**跳转/登录页/自定义门户**，特征一个字都不出现 —— 于是明明端口就是对的，
 * 却被判成"陌生服务"。`/dsh-remote/self` 由**本插件**注册在同一个 web server 上，
 * 返回 `{"ok":true,"version":…,"channel":…,"relayDir":…}`，是本机最硬的同一性证据
 * （它跑在同一条隧道上，能应答就说明这个端口就是宿主的 dsh web）。
 */
export function looksLikeDshRemoteSelf(status, text) {
  if (Number(status) !== 200) return false;
  const body = String(text || "");
  if (!body.includes("relayDir")) return false;
  return body.includes('"channel"') || body.includes('"runtimeReady"') || body.includes("dsh-remote");
}

/**
 * 探测一个候选：先 GET `/`（dsh web 首页特征），不中再 GET `/dsh-remote/self`（本插件特征）。
 * 两条判据任一命中即通过。
 * @returns {Promise<boolean>}
 */
export async function probeDshWeb(url, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl } = {}) {
  const target = normalizeUpstream(url);
  if (!target) return false;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return false;
  const once = async (path, check) => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        // redirect: manual —— 不跟随跳转（跳走的多半不是我们要的宿主）
        res = await doFetch(`${target}${path}`, { signal: ac.signal, redirect: "manual" });
      } finally {
        clearTimeout(timer);
      }
      const status = Number(res && res.status) || 0;
      if (status >= 500) return false;
      // 只读前 8KB 足够命中特征；读流失败按"不是"处理（宁可少一个候选，不可误接）
      let text = "";
      try {
        if (res.body && typeof res.body.getReader === "function") {
          const reader = res.body.getReader();
          const { value } = await reader.read();
          text = value ? Buffer.from(value).toString("utf8") : "";
          try { await reader.cancel(); } catch { /* ignore */ }
        } else if (typeof res.text === "function") {
          text = await res.text();
        }
      } catch { /* 读失败 → text 为空 → 判否 */ }
      return check(status, text.slice(0, 8192));
    } catch {
      return false;
    }
  };
  if (await once("/", looksLikeDshWeb)) return true;
  return once(DSH_REMOTE_SELF_PATH, looksLikeDshRemoteSelf);
}

/**
 * 发现上游地址（带身份校验）。
 *
 * @param {number[]} [extraPorts] 调用方已知的额外候选(排在静态候选之前;测试与特化部署用)。
 * @returns {Promise<{url: string, source: string, probed: number[], rejected: string[]}>}
 *          source: env | file | dsh_web_url | process | static | extra | fallback
 */
export async function discoverUpstream({
  relayDir = "",
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl,
  platform = process.platform,
  extraPorts = [],
  listenPorts = null,
  log
} = {}) {
  const hint = resolveUpstreamHint({ relayDir, env });
  // ① 显式环境变量:部署方说是什么就是什么(不探测,保持既有语义)
  if (hint.source === "env") return { url: hint.url, source: "env", probed: [], rejected: [] };
  // ② 提示地址先验证:文件/DSh_WEB_URL 都可能过期(宿主换端口/换了程序占用)
  if (hint.url && (await probeDshWeb(hint.url, { timeoutMs, fetchImpl }))) {
    return { url: hint.url, source: hint.source, probed: [portOf(hint.url)], rejected: [] };
  }

  // ③ 候选并行探测(本地端口,拒绝是瞬时的;并行是为了不让 watcher 卡住)
  const hintPort = portOf(hint.url);
  const entries = candidatePorts({ relayDir, env, platform, extraPorts, listenPorts }).filter((e) => e.port !== hintPort);
  const results = await Promise.all(entries.map(async (e) => ({ ...e, ok: await probeDshWeb(`http://127.0.0.1:${e.port}`, { timeoutMs, fetchImpl }) })));
  const hit = results.find((r) => r.ok);
  if (hit) {
    const url = `http://127.0.0.1:${hit.port}`;
    if (typeof log === "function") log(`[upstream] 动态发现上游 ${url}（来源 ${hit.source}；提示 ${hint.url || "无"} 不可用）`);
    return { url, source: hit.source, probed: entries.map((e) => e.port), rejected: hint.url ? [hint.url] : [] };
  }

  // ④ 都没找到:保持历史行为(3080),让上层按"上游没起来"正常重试
  return {
    url: hint.url || FALLBACK_UPSTREAM,
    source: hint.url ? hint.source : "fallback",
    probed: entries.map((e) => e.port),
    rejected: hint.url ? [hint.url] : []
  };
}

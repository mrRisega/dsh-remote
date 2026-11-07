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
 *
 * ## 2026-11-07 修复：别再乱敲本机所有端口（微信 CPU 高 + 登录慢）
 *
 * 旧实现把「本机所有回环 LISTEN 端口」（用户机实测 209 个）全部当候选逐个探测，
 * 其中包含**微信 PC 客户端**监听的端口 —— 发现一次就把微信敲一遍，用户侧表现为 CPU 升高；
 * 冷启动时几百个端口 × 900ms 超时也让登录卡 7–8 秒。
 *
 * 现在的纪律（"能发现非默认端口"的能力保留，只是不再乱敲）：
 *   1. **只探可能是 dsh 的端口**：hint → dsh/node 进程自己的监听端口 → **按归属进程名过滤**后的
 *      本机监听端口（白名单 node/dsh/deepseek/electron，且 IM 客户端进程名黑名单双保险）
 *      → 静态候选（3080、43120..）。拿不到进程名时**不再退化成全量探测**（宁可漏，不乱敲）。
 *   2. **更便宜**：探测超时 300ms、并发上限 16、**负缓存** 10 分钟（被判定"不是 dsh"的端口
 *      期间不再探测）、监听表枚举缓存 10s。
 *   3. **不阻塞请求路径**：`discoverUpstreamFast()` 只走 hint/缓存/进程端口（无全量探测）；
 *      `discoverUpstream()` 默认先返回 fast 结果，没命中时最多再等 `maxWaitMs`（默认 600ms）
 *      完成一次完整发现，否则把完整发现放后台、结果写缓存供下次用。
 *   4. **可观测**：日志只打 `source / probed / rejected / skipped` 计数，**不打端口清单**
 *      （skipped = 因"不是 node/dsh 进程"被跳过的端口数，含微信等 IM 客户端）。
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
/** 单个候选的探测超时（本地回环；旧值 900ms 会让冷启动明显变慢，2026-11-07 收到 300ms）。 */
export const PROBE_TIMEOUT_MS = 300;
/** 「不是 dsh」的负缓存时长（期间不再探测同一个端口）。 */
export const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
/** 已确认上游的缓存时长（端口漂移时最多这么久后重新发现）。 */
export const VERIFIED_CACHE_TTL_MS = 5 * 60 * 1000;
/** 候选探测并发上限（本地回环，16 足够；防止一次打出上百个连接）。 */
export const MAX_PROBE_CONCURRENCY = 16;
/** 「按进程名过滤后的本机监听端口」最多取多少个进候选（开发机 node 进程可能很多）。 */
export const LISTEN_PROBE_LIMIT = 24;
/** 候选总数超过这个数时**整层放弃 listen 扫描**（只探 hint/进程/静态）——防止一次发现打上百个请求。 */
export const MAX_PROBE_CANDIDATES = 20;
/** 监听表枚举缓存（lsof/ss 调用不算贵但也没必要每次发现都跑）。 */
const LISTEN_ENUM_TTL_MS = 10 * 1000;
/** 监听表"拿不到"的缓存（lsof 不存在时不必每次重试；稍后仍会再试）。 */
const LISTEN_ENUM_MISS_TTL_MS = 30 * 1000;

/** 已知 IM / 会议客户端的进程名黑名单：**即使名字像 node 也绝不探**（双保险）。 */
const IM_PROCESS_BLACKLIST = /wechat|weixin|wecom|wxwork|企业微信|微信|\bqq\b|dingtalk|dingding|feishu|lark|telegram|slack|discord|skype|whatsapp|\bteams\b|wemeet|tencent/i;
/** 可能是 dsh web 宿主的进程名（macOS lsof 的 COMMAND 会被截断到 9 字符；Windows 去掉 .exe）。 */
const DSH_LIKE_PROCESS = /^(?:node|nodejs|dsh|deepseek|electron)/i;

/**
 * 这个进程名是不是「可能是 dsh 的宿主」？
 * IM 客户端黑名单优先（`wechat-node` 这类名字也一律拒绝）。
 */
export function isDshLikeProcessName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (IM_PROCESS_BLACKLIST.test(n)) return false;
  return DSH_LIKE_PROCESS.test(n);
}

/** 是否是已知 IM/会议客户端（用于统计 skipped 与双保险排除）。 */
export function isIgnoredListenProcess(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  return IM_PROCESS_BLACKLIST.test(n);
}

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
    // windowsHide（C1）：这里会跑 netstat/lsof/ps 这类**控制台程序**。watcher/bridge 常以
    // 无控制台方式启动（launchd / 任务计划 wscript / 插件的 detached spawn），此时 Windows 会
    // 为子进程新分配一个可见控制台窗口 → 用户看到"一闪而过"的黑窗（诊断报告 04 §3.2 第二条）。
    // 上游探测在上游请求失败/ws-open 失败时每 15s 冷却反复触发（见 refreshUpstream），所以闪窗成串。
    // POSIX 上该选项被忽略。
    return String(execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) || "");
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

/** 本地地址是否可能通过 127.0.0.1 访问（回环或通配绑定）。 */
function isLoopbackListenName(name) {
  const v = String(name || "");
  if (v.includes("->")) return false; // 已建立连接的那一端，不是监听项
  return /^(?:127\.0\.0\.1|\[::1\]|\*|0\.0\.0\.0|\[::\]):\d+$/.test(v);
}

/** 解析 `lsof -nP -F pcn -iTCP -sTCP:LISTEN` 的字段化输出。 */
function parseLsofFieldListeners(out) {
  const rows = [];
  let pid = 0;
  let name = "";
  for (const line of String(out || "").split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") { pid = Number(val) || 0; name = ""; continue; }
    if (tag === "c") { name = val; continue; }
    if (tag !== "n") continue;
    if (!isLoopbackListenName(val)) continue;
    const m = /:(\d+)$/.exec(val);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    rows.push({ port, name: String(name).replace(/\.exe$/i, ""), pid });
  }
  return rows;
}

/** 解析 `lsof -nP -iTCP -sTCP:LISTEN` 的整行输出（老 lsof 兜底）。 */
function parseLsofPlainListeners(out) {
  const rows = [];
  for (const line of String(out || "").split("\n")) {
    if (!/LISTEN/.test(line)) continue;
    const head = /^(\S+)\s+(\d+)\s+/.exec(line);
    const addr = /(?:TCP\s+)?(127\.0\.0\.1|\[::1\]|\*|0\.0\.0\.0):(\d+)\s*\(LISTEN\)/.exec(line);
    if (!head || !addr) continue;
    const port = Number(addr[2]);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    rows.push({ port, name: head[1].replace(/\.exe$/i, ""), pid: Number(head[2]) });
  }
  return rows;
}

/**
 * 本机 LISTEN 端口 **连同归属进程名**（macOS/Linux 用 lsof；Linux 再兜底 `ss -ltnp`）。
 *
 * 为什么需要进程名（2026-11-07 微信 CPU 事故）：旧实现把本机所有 LISTEN 端口都当候选去敲，
 * 里面就有微信 PC 客户端的监听端口 —— 每发现一次就把微信敲一遍。现在只保留
 * 「进程名像 node/dsh/deepseek/electron」的端口；IM 客户端黑名单双保险。
 *
 * ⚠️ 拿不到进程名时返回 **null**（调用方绝不退化成"全量探测"—— 宁可漏一个端口，也不再乱敲）。
 * @returns {Array<{port:number,name:string,pid:number}>|null}
 */
export function listeningPortsWithProcess(platform = process.platform) {
  if (platform === "win32") {
    // Windows 拿"端口 + 进程名"要 netstat + tasklist 两次调用（几百 ms），且有 Desktop 静态候选兜底：
    // 本层只在 mac/Linux 提供；Windows 不猜、也不退化成全量探测。
    return null;
  }
  // ① lsof：macOS 自带，Linux 常见。
  //    优先 `-F pcn`（字段化输出）：本机实测比整行输出快 ~15ms，且解析不会被"COMMAND 带空格/截断"坑到。
  const rows = parseLsofFieldListeners(tryExec("lsof", ["-nP", "-F", "pcn", "-iTCP", "-sTCP:LISTEN"], 6000));
  if (rows.length) return rows;
  // 兼容极老 lsof（不认 -F 组合）→ 退回整行解析
  const plain = parseLsofPlainListeners(tryExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], 6000));
  if (plain.length) return plain;
  // ② Linux：ss -ltnp（有 -p 时能拿到 users:(("node",pid=...))）
  const ss = tryExec("ss", ["-ltnpH"], 5000) || tryExec("ss", ["-ltnp"], 5000);
  const ssRows = [];
  for (const line of ss.split("\n")) {
    if (!/LISTEN/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3] || "";
    const m = /(?:127\.0\.0\.1|\[::1\]|\*|0\.0\.0\.0|\[::\]):(\d+)$/.exec(local);
    const user = /users:\(\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    ssRows.push({ port, name: user ? user[1] : "", pid: user ? Number(user[2]) : 0 });
  }
  if (ssRows.length) return ssRows;
  return null; // 拿不到进程名：调用方不得退化成全量探测
}

/** 监听表枚举缓存（含"拿不到"的负结果；避免插件每次轮询都跑 lsof）。 */
let listenEnumCache = { at: 0, rows: null };
function cachedListenersWithProcess(platform) {
  const nowAt = Date.now();
  const ttl = listenEnumCache.rows ? LISTEN_ENUM_TTL_MS : LISTEN_ENUM_MISS_TTL_MS;
  if (nowAt - listenEnumCache.at < ttl) return listenEnumCache.rows;
  let rows = null;
  try { rows = listeningPortsWithProcess(platform); } catch { rows = null; }
  listenEnumCache = { at: nowAt, rows };
  return rows;
}

/**
 * 候选计划：返回候选列表 + 被跳过的端口数（skipped = 因"不是 node/dsh 进程"或 IM 黑名单跳过）。
 *
 * 顺序 = 提示里的端口 → 显式额外端口 → DSH_WEB_URL → 祖先/dsh 进程监听端口
 *        → **按进程名过滤后的本机监听端口** → 3080 → Desktop 默认端口区间。
 *
 * 「本机监听端口」这一层**必须**有进程名才收（见 listeningPortsWithProcess）；
 * 拿不到进程名就整层跳过（skipped 只统计被过滤掉的，不统计"拿不到进程名"）。
 *
 * @returns {{entries:Array<{port:number, source:string}>, skipped:number, truncated:number}}
 */
export function candidatePlan({
  relayDir = "",
  env = process.env,
  extraPorts = [],
  platform = process.platform,
  listenPorts = null,   // 仅测试/特殊部署：直接注入端口列表（绕过进程名过滤）
  listeners = null,     // 仅测试：注入 [{port,name,pid}] 以验证过滤/黑名单；false = 模拟"拿不到进程名"
  includeStatic = true,
  includeListen = true,
  /**
   * 是否枚举「祖先进程 / dsh 进程 / 逐 pid 的监听端口」。
   * fast 路径传 false：那一段每次要跑 ps 链 + pgrep + 每个 pid 一次 lsof（本机实测 ~180ms），
   * 而"进程端口"信息已经包含在 `includeListen` 的监听表里（带 pid/进程名），不必重复枚举。
   */
  includeProcess = true
} = {}) {
  const out = [];
  const seen = new Set();
  let skipped = 0;
  let truncated = 0;
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
  if (includeProcess) {
    const pids = [...new Set([process.pid, ...ancestorPids(process.pid, 6, platform), ...dshProcessPids(platform)])];
    for (const pid of pids) for (const p of listeningPortsOfPid(pid, platform)) push(p, "process");
  }
  if (includeListen) {
    if (Array.isArray(listenPorts)) {
      // 显式注入（测试/特殊部署）：不做进程名过滤，保持既有语义
      for (const p of listenPorts) push(p, "listen");
    } else {
      const rows = listeners === false ? null : (Array.isArray(listeners) ? listeners : cachedListenersWithProcess(platform));
      if (Array.isArray(rows)) {
        let accepted = 0;
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const name = String(row.name || "");
          if (isIgnoredListenProcess(name) || !isDshLikeProcessName(name)) { skipped += 1; continue; }
          if (accepted >= LISTEN_PROBE_LIMIT) { truncated += 1; continue; }
          const before = out.length;
          push(row.port, "listen");
          if (out.length > before) accepted += 1;
        }
      }
      // rows === null（拿不到进程名）→ 整层跳过：**绝不退化成全量探测**
    }
  }
  if (includeStatic) {
    push(3080, "static");
    for (let i = 0; i < DESKTOP_PORT_SCAN; i++) push(DESKTOP_DEFAULT_PORT + i, "static");
  }
  return { entries: out, skipped, truncated };
}

/**
 * 候选列表（兼容旧签名；只返回 entries）。需要 skipped/truncated 用 `candidatePlan()`。
 * @returns {Array<{port:number, source:string}>}
 */
export function candidatePorts(opts = {}) {
  return candidatePlan(opts).entries;
}

/**
 * 给"要真的去探测"的候选计划加**总量上限**：超过 `MAX_PROBE_CANDIDATES` 时整层放弃 listen 扫描，
 * 只保留 hint/进程/静态（这些是强信号，量级可控）。
 *
 * 为什么需要：开发机可能同时跑十几个 node 进程（各自 1–3 个监听端口），全探一遍就是几十个请求；
 * 但"漏掉一个端口"的代价远小于"每次发现都打几十个请求"（正是本次微信 CPU 事故的教训）。
 */
function planCandidatesForProbe(opts = {}) {
  const full = candidatePlan(opts);
  if (full.entries.length <= MAX_PROBE_CANDIDATES) return full;
  const minimal = candidatePlan({ ...opts, includeListen: false });
  return {
    entries: minimal.entries,
    skipped: minimal.skipped,
    truncated: minimal.truncated + Math.max(0, full.entries.length - minimal.entries.length),
    capApplied: true
  };
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
  /**
   * 探测一次。返回 `{http, matched}`：
   *   · `http=false` = 连 HTTP 响应都没拿到（拒绝/超时/DNS/读失败）—— 这个端口基本不是活的
   *   · `http=true`  = 拿到了 HTTP 响应（哪怕是 4xx/5xx/陌生页面）
   *
   * 为什么要区分（2026-11-07）：旧实现首探失败后还会再打 `/dsh-remote/self`，
   * 于是**每个死端口都要发 2 个请求**（大多数候选都是死的）→ 扫描请求量翻倍。
   * 现在：首探连 HTTP 都不是就直接判否，不再打第二个（省一半连接）。
   */
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
      if (!status) return { http: false, matched: false };
      if (status >= 500) return { http: true, matched: false };
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
      return { http: true, matched: check(status, text.slice(0, 8192)) };
    } catch {
      return { http: false, matched: false };
    }
  };
  const first = await once("/", looksLikeDshWeb);
  if (first.matched) return true;
  // 只有"确实拿到了 HTTP 响应但首页特征不中"才值得再问一次插件自己的 /dsh-remote/self
  // （首页可能是登录页/自定义门户；连 HTTP 都不通的端口没有任何理由再打一次）
  if (!first.http) return false;
  return (await once(DSH_REMOTE_SELF_PATH, looksLikeDshRemoteSelf)).matched;
}

// ---------- 探测缓存（负缓存防反复敲、已确认缓存给 fast 路径） ----------

/** port -> 判定"不是 dsh"的时间戳（10 分钟内不再探测）。 */
const negativeCache = new Map();
/** 最近一次**已验证**的上游（fast 路径直接采信/秒回）。 */
const verifiedCache = { url: "", source: "", at: 0 };
/** 正在后台跑的完整发现（超时返回时继续跑完，结果写缓存供下次用）。 */
let bgDiscoveryInflight = null;

function negativeKey(port) { return String(Number(port) || 0); }
function isNegativelyCached(port) {
  const key = negativeKey(port);
  const at = negativeCache.get(key);
  if (!at) return false;
  if (Date.now() - at > NEGATIVE_CACHE_TTL_MS) { negativeCache.delete(key); return false; }
  return true;
}
function rememberNegative(port) {
  const key = negativeKey(port);
  if (!key || key === "0") return;
  negativeCache.set(key, Date.now());
  if (negativeCache.size <= 512) return;
  // 有界：Map 保插入序，超限删最旧
  const first = negativeCache.keys().next();
  if (!first.done) negativeCache.delete(first.value);
}
function rememberVerified(url, source) {
  verifiedCache.url = String(url || "");
  verifiedCache.source = String(source || "");
  verifiedCache.at = Date.now();
}
function clearVerified() { verifiedCache.url = ""; verifiedCache.source = ""; verifiedCache.at = 0; }

/** 仅测试：清空所有进程内缓存（负缓存/已验证/监听表），避免用例互相污染。 */
export function __resetUpstreamCachesForTest() {
  negativeCache.clear();
  clearVerified();
  listenEnumCache = { at: 0, rows: null };
  bgDiscoveryInflight = null;
}

/** 仅测试：等后台完整发现跑完（没有在跑的则立即 resolve）。 */
export async function __waitUpstreamDiscoveryForTest() {
  if (bgDiscoveryInflight) { try { await bgDiscoveryInflight; } catch { /* 忽略 */ } }
}

/**
 * 已验证缓存是否仍然可用：**每次都用一次本地回环探测确认**（1–2ms，端口死了最多 300ms）。
 *
 * 为什么不"缓存内直接采信"（试过 30s 盲信）：dsh web 换端口后，盲信会把旧地址继续喂给
 * bridge 最多 30–45s，端口漂移自愈被拖慢。本地探测成本极低，换来的是"缓存绝不会把请求
 * 引到死端口"，更符合这个模块存在的意义。
 */
async function useVerifiedCache({ timeoutMs = PROBE_TIMEOUT_MS, fetchImpl } = {}) {
  if (!verifiedCache.url) return null;
  if (Date.now() - verifiedCache.at > VERIFIED_CACHE_TTL_MS) { clearVerified(); return null; }
  if (await probeDshWeb(verifiedCache.url, { timeoutMs, fetchImpl })) {
    verifiedCache.at = Date.now();
    return { url: verifiedCache.url, source: verifiedCache.source };
  }
  clearVerified();
  return null;
}

/** 限量并发 map（保持结果顺序；异常折成 undefined）。 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: max }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      try { out[i] = await fn(list[i], i); } catch { out[i] = undefined; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 日志：只打计数，**不打端口清单**（隐私/噪音；排障要清单时用 `dsh-remote doctor` 的探测结果）。 */
function logDiscovery(log, info) {
  if (typeof log !== "function") return;
  try {
    const { found, source, probed, rejected, skipped, note } = info || {};
    log(`[upstream] ${found ? "命中" : "未命中"} source=${source || "-"} probed=${probed || 0} rejected=${rejected || 0} skipped=${skipped || 0}${note ? `（${note}）` : ""}`);
  } catch { /* 日志失败不影响发现 */ }
}

/**
 * **快速发现**（供请求路径/热路径使用）：只用 hint / 已验证缓存 / 进程端口，
 * **不做全量端口枚举**，正常情况 <50ms。
 *
 * 顺序：`DSH_BRIDGE_UPSTREAM`（直接采信）→ 已验证缓存 → hint 单次校验 → 显式 extraPorts
 *       → 「祖先/dsh 进程 + 按进程名过滤后的本机监听端口」逐个校验（并发上限 16、300ms 超时、负缓存）。
 *
 * @returns {Promise<{url:string, source:string, probed:number[], rejected:string[], skipped:number, fast?:boolean}>}
 *          没找到时 `url=""`（调用方决定用 hint/回退值，或再调完整发现）。
 */
export async function discoverUpstreamFast({
  relayDir = "",
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl,
  platform = process.platform,
  extraPorts = [],
  listeners = null,
  log
} = {}) {
  const hint = resolveUpstreamHint({ relayDir, env });
  // ① 显式 env：部署方说是什么就是什么（保持既有语义，不探测）
  if (hint.source === "env") {
    return { url: hint.url, source: "env", probed: [], rejected: [], skipped: 0, fast: true };
  }
  // ② 已验证缓存（秒回；过期会重新校验一次）
  const cached = await useVerifiedCache({ timeoutMs, fetchImpl });
  if (cached) {
    return { url: cached.url, source: cached.source, probed: [], rejected: [], skipped: 0, fast: true, cached: true };
  }
  const rejected = [];
  // ③ hint 单次校验（端口文件可能过期，所以不盲信）
  if (hint.url) {
    if (await probeDshWeb(hint.url, { timeoutMs, fetchImpl })) {
      rememberVerified(hint.url, hint.source);
      return { url: hint.url, source: hint.source, probed: [portOf(hint.url)], rejected, skipped: 0, fast: true };
    }
    rejected.push(hint.url);
  }
  // ④ 进程端口 + 显式额外端口（**不含** static 兜底：13 个请求不该出现在请求路径上）
  const plan = planCandidatesForProbe({
    relayDir, env, platform, extraPorts, listeners,
    includeStatic: false, includeListen: true, includeProcess: false
  });
  const hintPort = portOf(hint.url);
  const entries = plan.entries.filter((e) => e.port !== hintPort && !isNegativelyCached(e.port));
  const outcomes = await mapLimit(entries, MAX_PROBE_CONCURRENCY, async (e) => {
    const ok = await probeDshWeb(`http://127.0.0.1:${e.port}`, { timeoutMs, fetchImpl });
    if (!ok) rememberNegative(e.port);
    return { ...e, ok };
  });
  const hit = outcomes.find((r) => r && r.ok);
  if (hit) {
    const url = `http://127.0.0.1:${hit.port}`;
    rememberVerified(url, hit.source);
    logDiscovery(log, { found: true, source: hit.source, probed: entries.length, rejected: rejected.length, skipped: plan.skipped, note: "fast" });
    return { url, source: hit.source, probed: entries.map((e) => e.port), rejected, skipped: plan.skipped, fast: true };
  }
  return { url: "", source: "", probed: entries.map((e) => e.port), rejected, skipped: plan.skipped, fast: true };
}

/**
 * **完整发现**（后台/诊断用）：fast 的全部来源 + 静态候选（3080、Desktop 区间）。
 *
 * 所有候选探测并发上限 16、单端口 300ms；被判定"不是 dsh"的端口进 10 分钟负缓存。
 * 命中后写已验证缓存（`discoverUpstreamFast` 下一次直接秒回）。
 *
 * @returns {Promise<{url:string, source:string, probed:number[], rejected:string[], skipped:number, truncated?:number}>}
 *          source: env | file | dsh_web_url | process | listen | extra | static | fallback
 */
export async function discoverUpstreamFull({
  relayDir = "",
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl,
  platform = process.platform,
  extraPorts = [],
  listenPorts = null,
  listeners = null,
  log
} = {}) {
  const hint = resolveUpstreamHint({ relayDir, env });
  if (hint.source === "env") {
    rememberVerified(hint.url, "env");
    return { url: hint.url, source: "env", probed: [], rejected: [], skipped: 0 };
  }
  const rejected = [];
  if (hint.url && (await probeDshWeb(hint.url, { timeoutMs, fetchImpl }))) {
    rememberVerified(hint.url, hint.source);
    return { url: hint.url, source: hint.source, probed: [portOf(hint.url)], rejected, skipped: 0 };
  }
  if (hint.url) rejected.push(hint.url);

  const plan = planCandidatesForProbe({ relayDir, env, platform, extraPorts, listenPorts, listeners });
  const hintPort = portOf(hint.url);
  const entries = plan.entries.filter((e) => e.port !== hintPort && !isNegativelyCached(e.port));
  const probedPorts = [];
  const outcomes = await mapLimit(entries, MAX_PROBE_CONCURRENCY, async (e) => {
    probedPorts.push(e.port);
    const ok = await probeDshWeb(`http://127.0.0.1:${e.port}`, { timeoutMs, fetchImpl });
    if (!ok) rememberNegative(e.port);
    return { ...e, ok };
  });
  const hit = outcomes.find((r) => r && r.ok);
  if (hit) {
    const url = `http://127.0.0.1:${hit.port}`;
    rememberVerified(url, hit.source);
    logDiscovery(log, { found: true, source: hit.source, probed: entries.length, rejected: rejected.length, skipped: plan.skipped });
    return { url, source: hit.source, probed: probedPorts, rejected, skipped: plan.skipped, truncated: plan.truncated };
  }
  logDiscovery(log, { found: false, source: hint.url ? hint.source : "fallback", probed: entries.length, rejected: rejected.length, skipped: plan.skipped });
  return {
    url: hint.url || FALLBACK_UPSTREAM,
    source: hint.url ? hint.source : "fallback",
    probed: probedPorts,
    rejected,
    skipped: plan.skipped,
    truncated: plan.truncated
  };
}

/**
 * 发现上游地址（**顶层 API，默认不阻塞**）。
 *
 * 语义（2026-11-07 提速）：
 *   1. 先跑 `discoverUpstreamFast()` —— 正常情况 <50ms 返回；
 *   2. fast 没命中时才做一次完整发现，但最多等 `maxWaitMs`（默认 600ms）：
 *      完成就返回完整结果；超时则返回 fast/hint 的结果（`pending:true`），完整发现转到后台，
 *      结果写缓存，供**下一次**调用秒回（并避免每个请求都重新全量探测）。
 *
 * 需要"一次调用就等到完整结果"（诊断/测试）时传 `{ wait: true }` 或直接用 `discoverUpstreamFull()`。
 *
 * @param {{wait?:boolean, maxWaitMs?:number}} [options]
 * @returns {Promise<{url: string, source: string, probed: number[], rejected: string[], skipped: number, pending?:boolean}>}
 *          source: env | file | dsh_web_url | process | listen | static | extra | fallback
 */
export async function discoverUpstream(options = {}) {
  if (options.wait === true || options.full === true) return discoverUpstreamFull(options);
  const maxWaitMs = Number.isFinite(Number(options.maxWaitMs)) ? Math.max(0, Number(options.maxWaitMs)) : 600;
  let fast = null;
  try {
    fast = await discoverUpstreamFast(options);
  } catch { fast = null; }
  if (fast && fast.url) return { ...fast, pending: false };

  // fast 没命中：给完整发现一个**有界**窗口（静态候选也就 13 个，正常远小于预算）
  let timer = null;
  let timedOut = false;
  const full = discoverUpstreamFull(options).catch(() => null);
  bgDiscoveryInflight = full.finally(() => { bgDiscoveryInflight = null; });
  const bounded = await Promise.race([
    full,
    new Promise((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(null); }, maxWaitMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    })
  ]);
  if (timer) { try { clearTimeout(timer); } catch { /* 忽略 */ } }
  if (bounded && bounded.url) return { ...bounded, pending: false };
  if (timedOut) {
    // 超时：完整发现继续在后台跑（结果进缓存）；本次先返回 fast/hint 结果
    void full;
  }
  const hint = resolveUpstreamHint({ relayDir: options.relayDir, env: options.env });
  return {
    url: (fast && fast.url) || hint.url || FALLBACK_UPSTREAM,
    source: (fast && fast.source) || hint.source || "fallback",
    probed: (fast && fast.probed) || [],
    rejected: (fast && fast.rejected) || [],
    skipped: (fast && fast.skipped) || 0,
    pending: true
  };
}

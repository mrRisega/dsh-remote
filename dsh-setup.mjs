#!/usr/bin/env node
/**
 * dsh-remote — 一键安装 + 配置 + 自启动（电脑端）
 *
 * 用法:
 *   dsh-remote [setup] [选项]                 一键安装（默认命令，无需任何参数）
 *   dsh-remote settings                        提示如何登录（独立设置页已移除，见 dsh web 面板）
 *   dsh-remote run                             前台运行 bridge（调试/守护）
 *   dsh-remote status                          查看配置与服务状态
 *   dsh-remote plugin [--uninstall]            手动安装/卸载 dsh web 远程控制插件
 *
 * setup 选项（全部可选）:
 *   --server <wss://host:port> --key <访问密钥>   自建模式（不填则连默认云端服务）
 *   --api <URL>                                 覆盖云端服务地址（高级）
 *   --no-autostart                              不安装开机自启服务
 *   --no-plugin                                 不安装 dsh web 插件
 *
 * 行为:
 *   1. 写入配置 <CONFIG_DIR>/.dsh-config.json（0600；npm 安装时为 ~/.dsh-remote/）
 *   2. 生成自启动服务（macOS launchd / Linux systemd），随 dsh web(3080) 存活自动保活
 *   3. 自动把远程控制插件装进 dsh web 设置页（若检测到 profile）
 *   4. 登录/连接配置在 dsh web → 设置 → 「远程控制」面板完成（SaaS 注册登录 / 自建切换）
 *      自建 CLI 用户也可用 `dsh-remote setup --server … --key …`（无需再打开设置页）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childStopped } from "./clients/dsh-remote/src/lifecycle.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url)); // 本包目录（仓库或 node_modules）
const IS_NPM_INSTALL = THIS_DIR.includes(`${path.sep}node_modules${path.sep}`);
// 配置目录：**两种形态统一放 ~/.dsh-remote**（npx/npm 安装时 node_modules 内不可写，故放用户目录；
// 仓库开发时也放同一处）。为什么不按形态分叉：插件半的默认配置目录本来就是 ~/.dsh-remote
// （见 packages/dsh-remote-web/lib/index.js 的 DEFAULT_RELAY_DIR），而激活块会把这里写进 relayDir。
// 两边不一致会出现「安装器把 .dsh-config.json 写进仓库根，插件却去 ~/.dsh-remote 找配置」→
// 面板显示成未登录/空配置，且安装器的状态文件散落进仓库工作区（实测踩到）。
// 需要隔离（测试 / 多账号 / 多实例）时用 DSH_RELAY_DIR 显式覆盖。
const CONFIG_DIR = process.env.DSH_RELAY_DIR || path.join(os.homedir(), ".dsh-remote");
const CONFIG_PATH = path.join(CONFIG_DIR, ".dsh-config.json");
// 默认云端服务地址（服务商 SaaS 入口；自建用户用 --server/--key 指向自己的 router）
const DEFAULT_API = "https://n.risegao.cn:13443/relay-api";
const DEFAULT_APP_URL = "https://n.risegao.cn:13443/app/";
const REPO_URL = "https://github.com/mrRisega/dsh-remote";

// ---------- 平台（0.6.7 起支持 Windows） ----------
const IS_WIN = process.platform === "win32";
/**
 * Windows 自启动 = 任务计划程序（Task Scheduler）里的登录任务。
 * 为什么不是「启动文件夹快捷方式」：生成 .lnk 需要额外依赖或 COM 调用，而 schtasks 系统自带，
 * 且**不需要管理员**就能为当前用户建 ONLOGON 任务（默认「仅在用户登录时运行」，不存密码）。
 */
const WIN_TASK_NAME = "dsh-remote-bridge";
/**
 * watcher / bridge 的 pid 文件（Windows 必需）。
 * Windows 没有 pgrep/ps，插件半（dsh-remote-web）与安装器都靠这两个文件发现进程：
 * watcher = 本安装器 `run` 子命令的进程，bridge = 它拉起的 dsh-bridge.mjs 子进程。
 */
const WATCHER_PID_FILE = ".dsh-watcher.pid";
const BRIDGE_PID_FILE = ".dsh-bridge.pid";

// ---------- 运行时自物化（npm/npx 安装 → 固化到配置目录，脱离 npx 缓存） ----------
// npx 每次安装的缓存目录（~/.npm/_npx/<hash>）不固定：缓存一旦清理，指向它的自启动服务
// 就会像“找不到模块”一样崩溃。因此 npm 形态安装时把 dsh-setup.mjs + clients + 依赖(ws)
// 固化到 CONFIG_DIR（~/.dsh-remote），自启动服务只指向这个稳定路径。
// 插件（dsh-remote-web；2026-09 前为 dsh-remote-ui）的“运行环境已就绪”判断同样以 CONFIG_DIR/dsh-setup.mjs 为准。

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(THIS_DIR, "package.json"), "utf8")).version || "";
  } catch { return ""; }
}

/** 向上查找依赖树里的 ws（npx 布局通常提升到缓存根 node_modules，npm 布局则内嵌）。 */
function findDepWs(startDir) {
  let d = startDir;
  while (true) {
    const cand = path.join(d, "node_modules", "ws");
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

/** 同步运行时文件时一并覆盖的客户端脚本（bridge 会把这些直接发给手机/桌面，必须与装置器一致）。 */
const RUNTIME_CLIENT_FILES = ["mobile-adapter.mjs", "dsh-bridge.mjs", "e2ee-shim.mjs", "e2ee-client.mjs", "e2ee-shim-script.js", "mobile-adapter.test.mjs"];

/**
 * 把"客户端脚本"补齐到配置目录。
 *
 * ⚠️ 2026-09-15 实测的坑：只按**版本号**判断"要不要同步"是不够的 ——
 * 手机端遮罩 bug 的修复落在 `clients/dsh-remote/mobile-adapter.mjs` 里（bridge 会把它注入官方页面后
 * 直接发给手机）。用户升级到新版本时，若配置目录里那份旧脚本没被覆盖，
 * **修复就永远到不了手机**（现场表现：改了、发了版，用户还是整屏阴影）。
 * 所以这里按**内容**比对：只要与装置器手里的不一致就覆盖（幂等、无副作用）。
 * @returns {number} 实际覆盖的文件数
 */
function syncRuntimeClientFiles() {
  const destRoot = path.join(CONFIG_DIR, "clients", "dsh-remote");
  let n = 0;
  for (const name of RUNTIME_CLIENT_FILES) {
    const src = path.join(THIS_DIR, "clients", "dsh-remote", name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(destRoot, name);
    try {
      if (fs.existsSync(dst) && fs.readFileSync(src).equals(fs.readFileSync(dst))) continue; // 一致 → 不动
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      n += 1;
    } catch { /* 单个文件失败不影响整体 */ }
  }
  return n;
}

function ensureRuntimeCopy() {
  // 仓库开发形态：装置器要使用**仓库里这份**（实时生效），但配置目录里的运行时副本
  // 仍必须与之一致 —— 否则 bridge 会把陈旧脚本发给手机（上面的 syncRuntimeClientFiles 说明）。
  if (!IS_NPM_INSTALL) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const srcSetup = path.join(THIS_DIR, "dsh-setup.mjs");
    const dstSetup = path.join(CONFIG_DIR, "dsh-setup.mjs");
    try { if (!fs.existsSync(dstSetup) || !fs.readFileSync(srcSetup).equals(fs.readFileSync(dstSetup))) fs.copyFileSync(srcSetup, dstSetup); } catch { /* ignore */ }
    const n = syncRuntimeClientFiles();
    if (n > 0) console.log(`✅ 运行时: 已同步 ${n} 个客户端脚本到 ${CONFIG_DIR}`);
    return;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const ver = pkgVersion();
  const setupTarget = path.join(CONFIG_DIR, "dsh-setup.mjs");
  if (setupTarget === path.join(THIS_DIR, "dsh-setup.mjs")) return; // 已在配置目录内执行
  const verFile = path.join(CONFIG_DIR, ".dsh-setup-version");
  let cur = "";
  try { cur = fs.readFileSync(verFile, "utf8").trim(); } catch { /* 首次 */ }
  if (fs.existsSync(setupTarget) && cur === ver) {
    // 版本没变也要确保客户端脚本一致（版本号相同但脚本被修过的情况真实存在）
    const n = syncRuntimeClientFiles();
    if (n > 0) console.log(`✅ 运行时: 已同步 ${n} 个客户端脚本到 ${CONFIG_DIR}`);
    return;
  }
  fs.cpSync(path.join(THIS_DIR, "dsh-setup.mjs"), setupTarget);
  fs.cpSync(path.join(THIS_DIR, "clients"), path.join(CONFIG_DIR, "clients"), { recursive: true, force: true });
  const wsSrc = findDepWs(THIS_DIR);
  if (wsSrc) {
    fs.mkdirSync(path.join(CONFIG_DIR, "node_modules"), { recursive: true });
    fs.cpSync(wsSrc, path.join(CONFIG_DIR, "node_modules", "ws"), { recursive: true, force: true });
  }
  fs.writeFileSync(verFile, ver);
  console.log(`✅ 运行时: ${CONFIG_DIR}`);
}
/** 打印用法（唯一实现：提前退出与末尾分派共用，避免两处漂移）。 */
function printHelp() {
  console.log(`dsh-remote — 手机远程控制 dsh web（隧道模式）

用法:
  dsh-remote              一键安装（默认命令，无需任何参数；含插件与自启动）
  dsh-remote settings     显示登录/连接配置指引（独立设置页已移除）
  dsh-remote run          前台运行 bridge（调试）
  dsh-remote status       查看配置与服务状态
  dsh-remote plugin       手动安装 dsh web 远程控制插件（--uninstall 卸载）
  dsh-remote repair       修复插件挂载（dsh web 起不来时用；只碰 profile，不联网）
  dsh-remote --help       显示本用法（等同 dsh-remote help）

自建模式（可选）:
  dsh-remote setup --server wss://你的域名:端口 --key 访问密钥

登录/连接配置: 打开 dsh web → 设置 → 「远程控制」→ 注册或登录手机号即可
（自建用户切「自建服务」标签或直接用上方 setup 命令，无需另开页面）。
文档: ${REPO_URL}
`);
}

// 认识的参数（只给 flag 也要能装上去，所以不认识时才拦）。
const KNOWN_FLAGS = new Set([
  "--api", "--server", "--key", "--profile",
  "--no-autostart", "--no-plugin", "--no-restart", "--uninstall"
]);

// ⚠️ 这一整块必须挡在 ensureRuntimeCopy() **之前**：它会往 ~/.dsh-remote 同步运行时脚本。
// 看用法、或参数拼错，都不该改动用户磁盘 —— 此前 `dsh-remote --help` 会一路走到 setup，
// 什么都不问就开始安装。
{
  const first = process.argv[2];
  if (first === "-h" || first === "--help" || first === "help") {
    printHelp();
    process.exit(0);
  }
  if (first && first.startsWith("-") && !KNOWN_FLAGS.has(first)) {
    console.error(`❌ 未知参数: ${first}`);
    console.error("   直接安装就用 dsh-remote（不带参数）；查看用法用 dsh-remote --help。");
    process.exit(1);
  }
}
try { ensureRuntimeCopy(); } catch (e) { console.warn(`⚠️ 运行时固化跳过: ${e.message}`); }

/** 自启动服务应指向的 dsh-setup.mjs：优先配置目录内的固化副本，否则当前执行文件。 */
function runtimeSetupPath() {
  const local = path.join(CONFIG_DIR, "dsh-setup.mjs");
  try {
    fs.accessSync(local, fs.constants.R_OK);
    return local;
  } catch { /* 未固化（如仓库开发）→ 用当前文件 */ }
  return fileURLToPath(import.meta.url);
}

// ---------- 工具 ----------

function sh(cmd, timeoutMs = 15000, cwd = undefined) {
  try {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, ...(cwd ? { cwd } : {}) });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "", code: 0 };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), code: e.status ?? -1 };
  }
}

/** 解析真实可执行路径（launchd/systemd 需要真实文件 + 可执行位）。 */
function resolveExecutable(p) {
  try {
    const real = fs.realpathSync(p);
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch { return null; }
}

function preferredNode() {
  const candidates = [
    process.env.DSH_SETUP_NODE20 || "",
    process.env.DSH_SETUP_NODE || "",
    process.execPath
  ].filter(Boolean);
  for (const p of candidates) {
    const real = resolveExecutable(p);
    if (real) return real;
  }
  return process.execPath;
}
const NODE_BIN = preferredNode();

/**
 * 自启动服务里注入的 PATH。
 * 必须含 /usr/sbin 与 /sbin:bridge 会用 ioreg 之类系统命令探测本机信息,
 * 缺少这两个目录时 launchd 服务日志里会刷 `ioreg: command not found`(用户反馈实测)。
 */
const SERVICE_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// ---------- 安装口径（随 bridge 环境变量注入；服务端存到设备行，用于区分安装来源） ----------
/**
 * install_source：本文件即「一键安装器」→ 默认 npx（用户自己跑 `npx @mrrisega/dsh-remote` 的那条路径）。
 * 插件市场那条路径由插件半自愈补装：插件 spawn 本安装器时显式传入
 * DSH_BRIDGE_INSTALL_SOURCE=plugin_market，这里原样透传（外部注入 > 硬编码默认）。
 * install_version：优先取外部注入（插件/在线更新器），否则取本包 package.json 版本。
 */
const INSTALL_SOURCE = String(process.env.DSH_BRIDGE_INSTALL_SOURCE || "").trim() || "npx";
const INSTALL_VERSION = String(process.env.DSH_BRIDGE_INSTALL_VERSION || "").trim() || pkgVersion();

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
  if (!who) return;
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

// ---------- 配置读写 ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  hardenFile(CONFIG_PATH); // Windows 上 mode 是空操作 → 必须显式收紧 ACL（内含明文账号密码）
}

// ---------- 公共配置（从服务端取域名，服务商可随时更换） ----------
async function fetchPublicConfig(apiBase) {
  try {
    const r = await fetch(apiBase + "/api/public-config", { signal: AbortSignal.timeout(6000) });
    if (r.ok) return await r.json();
  } catch {}
  return {};
}

/** 从账号 API 地址推导隧道 WebSocket 地址：https://host/relay-api → wss://host */
function deriveTunnelUrl(apiUrl) {
  return apiUrl.replace(/\/relay-api\/?$/, "").replace(/^https/, "wss");
}

/**
 * 模式归一化（SaaS 权威）：清掉自建残留(local_key/假 tunnel_url)，api_url 与
 * tunnel_url 一律按云端权威地址重算。防止"切过自建后又登云端"时残留配置把
 * bridge 带到错误服务器（此前手机永远看不到设备的根因之一）。
 */
function applySaaSMode(cfg) {
  delete cfg.local_key;
  delete cfg.server; // 旧字段兜底
  cfg.api_url = String(cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  cfg.tunnel_url = deriveTunnelUrl(cfg.api_url);
  return cfg;
}

/** 归一化自建服务器地址：缺省补 wss://，去掉末尾 / */
function normalizeTunnelUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^wss?:/i.test(u)) u = "wss://" + u;
  return u;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

// ---------- 自启动服务生成与热启动 ----------
/** 自启动服务 label（macOS LaunchAgent / Linux systemd 共用同一个名字）。 */
const BRIDGE_LABEL = "com.dshremote.bridge";

function autostartFilePath() {
  if (process.platform === "darwin")
    return path.join(os.homedir(), `Library/LaunchAgents/${BRIDGE_LABEL}.plist`);
  if (process.platform === "linux")
    return path.join(os.homedir(), ".config/systemd/user/dsh-bridge.service");
  return null;
}

/** 同步睡眠（生成 launchd 状态轮询用；不引第三方依赖）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* 极端环境不支持 → 退化为忙等一小会 */ const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

/**
 * 运行 schtasks（Windows 任务计划程序）。
 * **不走 sh()**：/TR 里必然带引号（node 路径与脚本路径都可能含空格），
 * 经 cmd.exe 转一层会把嵌套引号绞碎；spawnSync 直接把 argv 交给 CreateProcess，
 * 由 Node 负责转义，参数原样到达 schtasks。
 */
function schtasks(args, timeoutMs = 15000) {
  try {
    const r = spawnSync("schtasks", args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    return {
      ok: r.status === 0,
      code: r.status,
      stdout: String(r.stdout || ""),
      stderr: String(r.stderr || (r.error && r.error.message) || ""),
    };
  } catch (e) {
    return { ok: false, code: -1, stdout: "", stderr: e.message };
  }
}

/** 写 pid 文件（Windows 进程发现用；失败不致命，插件半还有 PowerShell 兜底扫描）。 */
function writePidFile(name, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG_DIR, name), String(pid));
  } catch { /* 非关键 */ }
}

function removePidFile(name) {
  try { fs.rmSync(path.join(CONFIG_DIR, name), { force: true }); } catch { /* 非关键 */ }
}

function readPidFile(name) {
  try {
    const n = Number(String(fs.readFileSync(path.join(CONFIG_DIR, name), "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * 注册 Windows 登录任务（幂等：先删再建）。
 * /DELAY 0000:15：登录后等 15 秒再起，避免与桌面环境抢启动时机
 * （watcher 本身就会等 dsh web 的 3080 端口，晚起没有任何副作用）。
 * ⚠️ 已知限制（如实告知，不假装完美）：ONLOGON 任务在用户会话里运行，登录时会有一个控制台窗口；
 * 想彻底隐藏需要"不管用户是否登录都运行"(存密码/S4U) 或第三方隐藏器，都需要额外凭据或依赖，
 * 故这里只做「能自启」，并在安装汇总里说明用户可在任务计划程序里勾「隐藏」。
 */
let winTaskCache = null;

function writeWindowsTask() {
  const node = NODE_BIN;
  const setup = runtimeSetupPath();
  const tr = `"${node}" "${setup}" run`;
  if (tr.length > 255) {
    console.log(`⚠️ 自启动命令过长（${tr.length} 字符，schtasks 上限 261）：${tr}`);
    console.log("   建议把 dsh-remote 装到更短的路径，或用 `dsh-remote run` 手动运行 bridge。");
  }
  schtasks(["/Delete", "/TN", WIN_TASK_NAME, "/F"]); // 幂等清理（不存在也只是非 0 退出，不影响后续
  const created = schtasks(["/Create", "/TN", WIN_TASK_NAME, "/TR", tr, "/SC", "ONLOGON", "/DELAY", "0000:15", "/F"]);
  if (!created.ok) {
    winTaskCache = false;
    console.warn(`⚠️ 自启动任务注册失败: ${(created.stderr || created.stdout).trim() || `schtasks 退出码 ${created.code}`}`);
    console.warn("   可手动执行 `dsh-remote run` 运行 bridge（功能完全一样，只是不随登录自启）。");
    return null;
  }
  winTaskCache = true;
  return `任务计划程序 / ${WIN_TASK_NAME}`; // 汇总里展示的"路径"
}

/** 查询 Windows 登录任务是否已注册（退出码 0 = 存在；不解析本地化输出）。 */
function windowsTaskInstalled() {
  return schtasks(["/Query", "/TN", WIN_TASK_NAME]).ok;
}

/**
 * 本次进程内查询一次登录任务是否已注册（汇总里多处要用，避免反复起 schtasks）。
 * 注册/删除任务时同步刷新缓存，保证汇总看到的是最终状态。
 */
function winTaskOk() {
  if (winTaskCache === null) winTaskCache = windowsTaskInstalled();
  return winTaskCache;
}

function writeAutostartFile() {
  const runCmd = `"${NODE_BIN}" "${runtimeSetupPath()}" run`;
  if (process.platform === "darwin") {
    const plistPath = autostartFilePath();
    // LimitLoadToSessionType 是**必需项**，不是可选优化：
    //   · macOS 26 上 gui/<uid> 会进入 on-demand-only 模式，RunAtLoad/KeepAlive 全部失效
    //     （只登记不派生，runs=0，日志报 "pending spawn, domain in on-demand-only mode"）；
    //     迁到 user/<uid> domain 才能恢复派生与崩溃自愈。
    //   · 而不带该键时 `launchctl bootstrap user/<uid>` 直接失败（实测 rc=5 Input/output error）。
    //   · 带上 [Aqua, Background] 后 user/<uid> 与 gui/<uid> 都能正常装载（macOS 14/26 均实测）。
    // 仍保留 RunAtLoad/KeepAlive：user domain 下它们是真生效的（实测 kill -9 后自动重建）。
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${BRIDGE_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE_BIN}</string><string>${runtimeSetupPath()}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><array><string>Aqua</string><string>Background</string></array>
  <key>StandardOutPath</key><string>${path.join(CONFIG_DIR, ".dsh-bridge.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(CONFIG_DIR, ".dsh-bridge.log")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${SERVICE_PATH}</string><key>DSH_BRIDGE_INSTALL_SOURCE</key><string>${INSTALL_SOURCE}</string><key>DSH_BRIDGE_INSTALL_VERSION</key><string>${INSTALL_VERSION}</string></dict>
</dict></plist>`;
    // ~/Library/LaunchAgents 在全新账户/精简系统上可能不存在,必须先建目录,
    // 否则 writeFileSync 抛 ENOENT 直接把安装流程打断(用户反馈里也踩过类似的路径问题)。
    try {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist);
    } catch (e) {
      console.warn(`⚠️ 自启动服务写入失败: ${e.message}（可稍后用 \`dsh-remote install\` 重试）`);
      return null;
    }
    return plistPath; // 路径在最终汇总里统一展示(避免同一信息打印两遍)
  }
  if (process.platform === "linux") {
    const dir = path.join(os.homedir(), ".config/systemd/user");
    fs.mkdirSync(dir, { recursive: true });
    const unit = `[Unit]\nDescription=dsh-remote bridge (auto-starts with dsh web)\n\n[Service]\nExecStart=${runCmd}\nRestart=on-failure\nRestartSec=5\nEnvironment=PATH=${SERVICE_PATH}\nEnvironment=DSH_BRIDGE_INSTALL_SOURCE=${INSTALL_SOURCE}\nEnvironment=DSH_BRIDGE_INSTALL_VERSION=${INSTALL_VERSION}\n\n[Install]\nWantedBy=default.target\n`;
    const unitPath = autostartFilePath();
    fs.writeFileSync(unitPath, unit);
    return unitPath; // 路径在最终汇总里统一展示
  }
  if (IS_WIN) return writeWindowsTask();
  console.log(`⚠️ 当前平台（${process.platform}）暂不支持自启动，请手动运行 \`dsh-remote run\``);
  return null;
}

/**
 * 读取 launchd job 状态。
 * deferred = launchd 登记了但**从未派生**（macOS 26 的 on-demand-only 特征）；
 * 光看 "state = not running" 无法区分"被系统挂起"与"正常退出"，必须单独识别才能给出正确建议。
 */
function launchdState(target) {
  const pr = sh(`launchctl print ${target}`);
  if (!pr.ok) return { exists: false, running: false, pid: null, deferred: false, raw: "" };
  const raw = pr.stdout;
  const running = /state\s*=\s*running/.test(raw);
  const m = raw.match(/pid\s*=\s*(\d+)/);
  const runs = raw.match(/runs\s*=\s*(\d+)/);
  return {
    exists: true,
    running,
    pid: running && m ? Number(m[1]) : null,
    runs: runs ? Number(runs[1]) : 0,
    deferred: /pended nondemand spawn/.test(raw) || /on-demand-only/.test(raw),
    raw
  };
}

/**
 * 轮询等待 job 起来。
 * launchd 派生是异步的：bootstrap 成功后立刻 print 必然看到 not running（旧实现因此误报"启动失败"）。
 * 明确"被挂起且没有派生"时提前放弃（等满也没用），否则给足 ~8 秒。
 */
function waitLaunchdRunning(target, tries = 20, gapMs = 400) {
  let st = launchdState(target);
  for (let i = 0; i < tries; i += 1) {
    st = launchdState(target);
    if (st.running) return st;
    // 已登记、没在跑、又没被挂起（runs>0 说明派生过）→ 是启动后立刻退出，不必等满
    if (st.exists && st.runs > 0 && !st.deferred) break;
    if (i >= 2 && st.exists && !st.deferred && st.runs === 0) break; // 登记了却一次都没派生 → 被挂起
    sleepSync(gapMs);
  }
  return st;
}

/** 终极兜底：脱离 launchd 直接后台拉起 bridge（至少"现在能用"，但没有开机自启/崩溃自愈）。 */
function spawnDetachedBridge() {
  try {
    const logPath = path.join(CONFIG_DIR, ".dsh-bridge.log");
    const out = fs.openSync(logPath, "a");
    const child = spawn(NODE_BIN, [runtimeSetupPath(), "run"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env
    });
    child.unref();
    fs.closeSync(out);
    return { ok: Boolean(child.pid), pid: child.pid || null };
  } catch (e) {
    return { ok: false, pid: null, error: e.message };
  }
}

/**
 * macOS：按「可自愈优先」的阶梯启动 bridge。
 *   ① user/<uid>  ← 首选。macOS 26 上唯一支持 RunAtLoad/KeepAlive 的 domain（可崩溃自愈）
 *   ② gui/<uid> + kickstart  ← 兼容兜底。bootstrap 只登记不派生时用 kickstart 强拉一次；
 *      但实测 kickstart 只解决"这一次"，进程被杀后不会重建（KeepAlive 已被系统绕过）→ 如实告知
 *   ③ 后台进程  ← 连 launchd 都托管不了时保证可用
 */
function startBridgeDarwin(plistPath) {
  const uid = process.getuid();
  const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
  let lastDetail = "";
  for (const domain of [`user/${uid}`, `gui/${uid}`]) {
    const target = `${domain}/${BRIDGE_LABEL}`;
    // 清掉另一个 domain 的历史注册，避免两处并存导致重复实例
    for (const d of [`user/${uid}`, `gui/${uid}`]) {
      if (d !== domain) sh(`launchctl bootout ${d}/${BRIDGE_LABEL}`);
    }
    sh(`launchctl bootout ${target}`);
    let boot = sh(`launchctl bootstrap ${domain} ${q(plistPath)}`);
    if (!boot.ok) {
      // 老写法兜底（部分系统上 load -w 仍可用）
      sh(`launchctl unload ${q(plistPath)}`);
      boot = sh(`launchctl load -w ${q(plistPath)}`);
    }
    if (!boot.ok) {
      lastDetail = (boot.stderr || boot.stdout).trim() || "launchctl bootstrap 失败";
      continue;
    }
    // bootstrap 只是登记；立刻 kickstart 一次，确保"这一次"一定起来
    // （on-demand-only 的 gui domain 下这是唯一能拉起的手段）
    sh(`launchctl kickstart -k ${target}`);
    const st = waitLaunchdRunning(target);
    if (st.running) {
      // 被挂起（deferred）过一次 = 本机 launchd 不保证崩溃自愈，必须如实报告，不能报成完全成功
      const selfHealing = !st.deferred;
      return { ok: true, status: "running", pid: st.pid, domain, selfHealing, detail: selfHealing ? "" : "本机 launchd 处于 on-demand-only，进程退出后不会自动重建" };
    }
    lastDetail = st.deferred
      ? `launchd 拒绝派生（domain ${domain} 处于 on-demand-only 模式）`
      : (st.exists ? `已登记但未运行（runs=${st.runs}）` : "已登记但查不到状态");
  }
  const d = spawnDetachedBridge();
  if (d.ok) {
    return {
      ok: false,
      status: "degraded-detached",
      pid: d.pid,
      domain: null,
      selfHealing: false,
      detail: "launchd 无法托管本机 bridge，已改为后台进程运行（现在可用，但不会开机自启、崩溃后不自动恢复）"
    };
  }
  return { ok: false, status: "failed", detail: `launchd 与后台进程均启动失败：${lastDetail}` };
}

function restartBridgeService() {
  if (IS_WIN) {
    if (!windowsTaskInstalled()) writeWindowsTask(); // 静默补生成(调用方会汇总展示)
    // /Run 只是"现在跑一次"；等 pid 文件出现才算真的起来了（schtasks 的退出码只说明任务被触发）
    const r = schtasks(["/Run", "/TN", WIN_TASK_NAME]);
    if (!r.ok) return { ok: false, status: "failed", detail: (r.stderr || r.stdout).trim() || `schtasks /Run 退出码 ${r.code}` };
    for (let i = 0; i < 20; i += 1) {
      const pid = readPidFile(WATCHER_PID_FILE);
      if (pid && pidAlive(pid)) return { ok: true, status: "running", pid };
      sleepSync(400);
    }
    return {
      ok: false,
      status: "degraded-detached",
      detail: "已触发自启动任务，但没等到 bridge 守护进程（dsh web 可能还没运行；打开 dsh web 后会自动接上）",
    };
  }
  const svcFile = autostartFilePath();
  if (svcFile && !fs.existsSync(svcFile)) {
    writeAutostartFile(); // 静默补生成(调用方会汇总展示路径)
  }
  if (process.platform === "darwin") {
    const plistPath = autostartFilePath();
    if (!fs.existsSync(plistPath)) return { ok: false, status: "not-installed", detail: "plist 不存在" };
    return startBridgeDarwin(plistPath);
  }
  if (process.platform === "linux") {
    const r = sh(`systemctl --user restart dsh-bridge`);
    if (!r.ok) return { ok: false, status: "failed", detail: (r.stderr || r.stdout).trim() || "systemctl restart 失败" };
    const a = sh(`systemctl --user is-active dsh-bridge`);
    return a.ok && a.stdout.trim() === "active"
      ? { ok: true, status: "running", pid: null }
      : { ok: false, status: "failed", detail: (a.stdout || a.stderr).trim() };
  }
  return { ok: false, status: "unsupported", detail: `平台 ${process.platform} 不支持自启动` };
}

/**
 * dsh web 是否正在运行（127.0.0.1:3080）。
 * bridge 本身依赖 dsh web 才工作：dsh web 没开时 bridge 起来也会立刻退出，
 * 所以「装完当下 bridge 没在跑」是**正常状态**，不能当失败吓用户（见 install 汇总）。
 */
async function isDshWebUp(timeoutMs = 1200) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    await fetch("http://127.0.0.1:3080/", { signal: ac.signal });
    clearTimeout(timer);
    return true;
  } catch { return false; }
}

/**
 * 解析 dsh web profile 目录（安装与插件管理共用同一口径）。
 */
function resolveProfileDir(argv = []) {
  const i = argv.indexOf("--profile");
  return i > -1 && argv[i + 1]
    ? argv[i + 1]
    : process.env.DSH_PROFILE_DIR || path.join(os.homedir(), ".dsh", "profiles", "web");
}

/**
 * 监听 127.0.0.1:3080 的进程 pid（= dsh web）。
 * macOS/Linux：lsof → pgrep；Windows：netstat -ano 取 LISTENING 行的最后一列
 * （netstat 是系统自带，比每次都起 PowerShell 快得多）。
 */
function dshWebPid() {
  if (IS_WIN) {
    const r = sh('netstat -ano | findstr ":3080"');
    for (const line of String(r.stdout || "").split("\n")) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) return Number(m[1]);
    }
    return null;
  }
  const l = sh("lsof -nP -iTCP:3080 -sTCP:LISTEN -t 2>/dev/null || true");
  const pid = String(l.stdout || "").trim().split(/\s+/).filter(Boolean)[0];
  if (pid && /^\d+$/.test(pid)) return Number(pid);
  const p = sh("pgrep -f 'dsh web' 2>/dev/null | head -1");
  const p2 = String(p.stdout || "").trim();
  return /^\d+$/.test(p2) ? Number(p2) : null;
}

/**
 * 进程启动时刻（毫秒）。
 * 用 `ps -o lstart=`（如 "Sun Sep 13 13:54:43 2026"）——它**不含年份以外的 TZ 差异**，
 * 比 `ps -o etimes=` 稳（后者在部分平台不可用），比 /proc 通用。
 */
function processStartMs(pid) {
  try {
    const r = sh(`ps -o lstart= -p ${Number(pid)}`);
    const t = Date.parse(String(r.stdout || "").trim());
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

/**
 * 重启 dsh web。
 * dsh web 由**用户手工或 launchd** 跑着，插件是进程启动时装载的，所以更新插件后必须重启它才有面板。
 * 阶梯：launchd job（macOS）→ systemd user unit（Linux）→ 原命令行自拉起 → 交给用户手动。
 */
function dshWebLaunchdJob() {
  const l = sh("launchctl list 2>/dev/null | grep -i dsh | grep -v dshremote || true");
  for (const line of String(l.stdout || "").split("\n")) {
    const label = line.trim().split(/\s+/).pop();
    if (label && /dsh/i.test(label)) return label;
  }
  return null;
}

function restartDshWeb() {
  // ⚠️ process.getuid 只在 macOS 分支里取：Windows 上**没有这个函数**，
  // 旧写法把它放在函数首行无条件调用 → 安装流程在 Windows 直接 TypeError 中断。
  if (process.platform === "darwin") {
    const uid = process.getuid();
    const job = dshWebLaunchdJob();
    if (job) {
      const r = sh(`launchctl kickstart -k gui/${uid}/${job}`);
      if (r.ok) return { ok: true, how: `launchctl kickstart ${job}` };
    }
  }
  if (process.platform === "linux") {
    const r = sh("systemctl --user restart dsh-web 2>/dev/null || systemctl --user restart dsh 2>/dev/null");
    if (r.ok) return { ok: true, how: "systemctl --user restart dsh-web" };
  }
  if (IS_WIN) return restartDshWebWindows();
  // 兜底：沿用原命令行重启（只在能拿到真实 node 入口时做，npx 缓存路径不可靠）
  const pid = dshWebPid();
  if (!pid) return { ok: false, how: "", detail: "未找到 dsh web 进程" };
  const cmd = String(sh(`ps -o command= -p ${pid}`).stdout || "").trim();
  if (!cmd || /node_modules\/\.bin|_npx/.test(cmd)) {
    return { ok: false, how: "", detail: "无法获取可复用的启动命令（可能是经 npx 启动），请手动重启" };
  }
  try {
    const child = spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: "ignore", cwd: os.homedir() });
    child.unref();
    return { ok: true, how: "原命令行重新拉起" };
  } catch (e) {
    return { ok: false, how: "", detail: e.message };
  }
}

/**
 * Windows：重启 dsh web（沿用原命令行自拉起）。
 *
 * 与插件半的重启助手同源思路：**先校验新进程拉得起来，再动旧进程**；用 node 跑一个 .mjs 助手，
 * 不经过任何 shell（Windows 没有 /bin/sh，cmd.exe 的引号规则又极易把带空格的 node/入口路径绞碎）。
 * 拿不到命令行（例如经 npx 启动）时如实拒绝，让用户手动重启，绝不"杀掉却起不来"。
 */
function restartDshWebWindows() {
  const pid = dshWebPid();
  if (!pid) return { ok: false, how: "", detail: "未找到监听 3080 的进程（dsh web 没在运行？）" };
  const cmdline = windowsProcessCommandLine(pid);
  if (!cmdline) return { ok: false, how: "", detail: "无法获取 dsh web 的启动命令行，请手动重启" };
  if (/_npx|node_modules\\\.bin|node_modules\/\.bin/.test(cmdline)) {
    return { ok: false, how: "", detail: "dsh web 是经 npx 启动的，无法安全复用命令行，请手动重启" };
  }
  const argv = parseWindowsCommandLine(cmdline);
  if (!argv.length || !fs.existsSync(argv[0])) {
    return { ok: false, how: "", detail: "dsh web 的启动命令无法解析为可执行程序，请手动重启" };
  }
  const helper = path.join(CONFIG_DIR, ".dsh-restart-dshweb.mjs");
  const plan = JSON.stringify({ pid, argv, log: path.join(CONFIG_DIR, ".dsh-restart.log") });
  const src = `import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const PLAN = ${plan};
function logLine(m) { try { appendFileSync(PLAN.log, "\\n[" + new Date().toISOString() + "] " + m + "\\n"); } catch (e) {} }
if (!existsSync(PLAN.argv[0])) { logLine("重启中止：可执行文件不存在 " + PLAN.argv[0]); process.exit(1); }
function alive(p) { try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; } }
logLine("dsh web 重启助手启动：旧 pid=" + PLAN.pid);
await delay(1000);
try { process.kill(PLAN.pid); } catch (e) {}
const deadline = Date.now() + 30000;
while (Date.now() < deadline && alive(PLAN.pid)) await delay(200);
if (alive(PLAN.pid)) spawnSync("taskkill", ["/PID", String(PLAN.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
let out = "ignore";
try { out = openSync(PLAN.log, "a"); } catch (e) {}
const child = spawn(PLAN.argv[0], PLAN.argv.slice(1), { detached: true, stdio: ["ignore", out, out], windowsHide: true });
child.on("error", (e) => logLine("重新拉起失败：" + e.message));
child.unref();
if (typeof out === "number") { try { closeSync(out); } catch (e) {} }
logLine("已重新拉起 dsh web：pid=" + String(child.pid));
`;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(helper, src);
    const child = spawn(NODE_BIN, [helper], { detached: true, stdio: "ignore", cwd: os.homedir(), windowsHide: true });
    child.on("error", () => { /* 有 error 监听：绝不能把宿主/安装器打挂 */ });
    child.unref();
    return { ok: true, how: "Windows 重启助手（原命令行自拉起）" };
  } catch (e) {
    return { ok: false, how: "", detail: e.message };
  }
}

/** 读某进程的完整命令行（PowerShell CIM；取不到返回空串）。 */
function windowsProcessCommandLine(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf8", timeout: 8000, windowsHide: true });
    return String(r.stdout || "").trim();
  } catch { return ""; }
}

/**
 * 把 Windows 命令行拆成 argv（按 CreateProcess/CRT 的引号规则）。
 * 不引第三方依赖；处理 `"a b" c`、`a\b c`、`"a\"b"` 等常见形态即可。
 */
function parseWindowsCommandLine(cmd) {
  const out = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (ch === "\\" && cmd[i + 1] === '"') { cur += '"'; i += 1; started = true; continue; }
    if (ch === '"') { inQuote = !inQuote; started = true; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (started) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

function installAutostart() {
  const svcPath = writeAutostartFile();
  const r = restartBridgeService();
  // 不再在这里直接打印(信息在 install 汇总里给一次),身份由调用方持有
  return { path: svcPath, status: r };
}

// ---------- settings：旧独立设置页已移除（引导到 dsh web 插件面板） ----------
// 云服务用户在 dsh web → 设置 → 「远程控制」面板即可注册/登录（自建切换也在此面板）；
// 独立设置页(127.0.0.1:3499)与面板功能完全重复、且暴露自建表单给普通用户造成困惑,已移除。
// 保留 `dsh-remote settings` 命令为“引导提示”,避免旧脚本/旧文档直接调它时报错。
function settingsHint() {
  console.log(`
dsh-remote：独立的本地设置页已移除。

请直接在 dsh web 里完成登录/连接配置（无需任何命令）：
  打开 dsh web → 设置 → 「远程控制」→ 注册或登录手机号即可（自建模式切换也在该面板）。

自建用户若偏好命令行，可用：
  dsh-remote setup --server wss://你的域名:端口 --key 访问密钥
`);
}

/**
 * 账号指纹：账号 / 模式 / 设备身份任一变化都意味着"必须用新凭据重新登记"。
 * 为什么需要：bridge 的 DSH_BRIDGE_PHONE/PASSWORD 是**进程启动时**从环境变量固化的，
 * 配置改了并不会影响已在跑的进程 —— 这是"切换账号后设备仍留在旧账号"的根因之一。
 */
function accountFingerprint(cfg) {
  const c = cfg || {};
  return [c.local_key ? "local" : "saas", c.phone || c.email || "", String(c.device_id || ""), String(c.local_key || "")].join("|");
}

/**
 * 服务端登录限流的"最早可重试时刻"（bridge 在收到 429 时落盘）。
 * 为什么需要：限流窗口是 15 分钟，而 watcher 每 10 秒就会重新拉起 bridge ——
 * 不读这个文件就是 90 次空撞（日志刷屏、还可能拖长窗口）。它只是**退避提示**，绝不阻止正常启动。
 */
const LOGIN_RATELIMIT_FILE = ".dsh-login-ratelimited";
function loginRateLimitUntil() {
  const f = path.join(CONFIG_DIR, LOGIN_RATELIMIT_FILE);
  try {
    const until = Number(String(fs.readFileSync(f, "utf8")).trim());
    if (Number.isFinite(until) && until > Date.now()) return until;
    fs.rmSync(f, { force: true }); // 已过期：清掉，恢复正常启动
  } catch { /* 无文件 = 未限流 */ }
  return 0;
}

// ---------- run：前台跑 bridge（带配置 + 自启动 watcher） ----------
async function runBridge() {
  // 去重（所有平台）：自启动服务、登录任务、插件半的脱离进程兜底都可能拉起 watcher，
  // 两个 bridge 会抢同一个设备登记 → 以 pid 文件为准，已有守护在跑就直接退出。
  {
    const other = readPidFile(WATCHER_PID_FILE);
    if (other && other !== process.pid && pidAlive(other)) {
      console.log(`[dsh-remote] 已有一个 bridge 守护在运行（pid=${other}），本进程直接退出，避免重复实例。`);
      return;
    }
  }
  let cfg = loadConfig();
  let warnedNoLogin = false;
  /** 当前 bridge 子进程使用的账号指纹（账号/模式/设备身份任一变化 → 重启子进程）。 */
  let bridgeAccountFp = "";
  /** 限流提示只打一次，避免刷屏。 */
  let warnedRateLimit = false;

  // watcher：检测 dsh web（127.0.0.1:3080）存活，存活才启动 bridge
  const checkUpstream = () => new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    fetch("http://127.0.0.1:3080/")
      .then(() => { clearTimeout(t); resolve(true); })
      .catch(() => { clearTimeout(t); resolve(false); });
  });

  console.log("[dsh-remote] 等待 dsh web（127.0.0.1:3080）启动...");
  let bridgeProc = null;
  let starting = false;

  const ensureBridge = async () => {
    if (starting) return;
    // 每次循环重读配置：设置页登录/切换模式后无需重启守护即可生效
    cfg = loadConfig();
    const saas = Boolean((cfg.phone || cfg.email) && cfg.password);
    let local = Boolean(cfg.local_key);
    if (!saas && !local) {
      if (!warnedNoLogin) {
        warnedNoLogin = true;
        console.log("⚠️ 尚未登录：请打开 dsh web → 设置 → 「远程控制」，注册/登录手机号（或切到自建模式）后自动启动。");
      }
      return;
    }
    warnedNoLogin = false;
    if (local && !cfg.tunnel_url) {
      console.log("⚠️ 自建模式缺少服务器地址：请用 `dsh-remote setup --server wss://host:port --key <密钥>` 重新配置。");
      return;
    }
    if (saas) {
      // SaaS 权威归一化：清掉任何自建残留，tunnel/api 始终指向云端地址
      applySaaSMode(cfg);
      local = false;
      saveConfig(cfg);
    } else if (local && !cfg.tunnel_url) {
      cfg.tunnel_url = deriveTunnelUrl(cfg.api_url || DEFAULT_API);
    }
    const apiUrl = saas ? (cfg.api_url || DEFAULT_API) : "";

    // 账号/模式/设备身份变了 → 必须重启 bridge（它的凭据是启动时从环境变量固化的）。
    // 没有这一条时：面板切了账号、旧 bridge 却继续用旧账号跑，新账号的设备列表里看不到这台机器
    //（2026-09-19 实测事故）。
    const fp = accountFingerprint(cfg);
    if (!childStopped(bridgeProc) && bridgeAccountFp && bridgeAccountFp !== fp) {
      console.log("[dsh-remote] 账号配置已变化 → 重启 bridge 让新账号生效...");
      try { bridgeProc.kill(); } catch { /* 已退出 */ }
      bridgeAccountFp = "";
      return; // 下一轮（10s 内）用新配置重新拉起
    }

    // 服务端登录限流窗口内不反复拉起 bridge（凭据没错，改了也没用）
    const rlUntil = loginRateLimitUntil();
    if (rlUntil > Date.now()) {
      if (!warnedRateLimit) {
        warnedRateLimit = true;
        console.log(`[dsh-remote] 登录被服务端限流，约 ${Math.ceil((rlUntil - Date.now()) / 1000)} 秒后自动重试（凭据无需修改）。`);
      }
      return;
    }
    warnedRateLimit = false;

    const alive = await checkUpstream();
    if (alive && childStopped(bridgeProc)) {
      starting = true;
      console.log("[dsh-remote] dsh web 在线，启动 bridge...");
      // 清除代理环境变量（bridge 需直连 relay，不受本机代理影响）
      const childEnv = {
        ...process.env,
        DSH_BRIDGE_CONFIG: CONFIG_PATH,
        DSH_BRIDGE_TUNNEL_URL: cfg.tunnel_url,
        // 安装口径透传给 bridge（bridge 把它随设备登记请求一起上报给账号 API）
        DSH_BRIDGE_INSTALL_SOURCE: INSTALL_SOURCE,
        DSH_BRIDGE_INSTALL_VERSION: INSTALL_VERSION,
        ...(saas ? { DSH_BRIDGE_PHONE: (cfg.phone || cfg.email || ""), DSH_BRIDGE_PASSWORD: cfg.password, DSH_BRIDGE_API: apiUrl, DSH_BRIDGE_SECRET: cfg.bridge_secret || "" } : {}),
        ...(local ? { DSH_BRIDGE_LOCAL_KEY: cfg.local_key } : {})
      };
      for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
        delete childEnv[k];
      }
      bridgeProc = spawn(NODE_BIN,
        [path.join(THIS_DIR, "clients/dsh-remote/dsh-bridge.mjs")],
        { env: childEnv, stdio: "inherit" });
      bridgeProc.on("exit", () => {
        removePidFile(BRIDGE_PID_FILE);
        console.log("[dsh-remote] bridge 退出，等待重启...");
      });
      // Windows：落 pid 文件，供插件半发现进程（Windows 没有 pgrep/ps）。
      // 插件半启动 bridge 走的就是本函数，所以这里写一次两边都覆盖到。
      writePidFile(BRIDGE_PID_FILE, bridgeProc.pid); // 供插件半发现进程（Windows 无 pgrep；POSIX 用于脱离进程兜底的去重）
      bridgeAccountFp = fp; // 记下这个子进程用的是哪套凭据，配置一变就重启它
      setTimeout(() => { starting = false; }, 5000);
    } else if (!alive && bridgeProc && bridgeProc.exitCode === null) {
      console.log("[dsh-remote] dsh web 离线，停止 bridge...");
      bridgeProc.kill();
    }
  };

  // watcher 自身的 pid 也要落盘（插件半据此判断"守护在跑"并避免重复拉起）
  {
    writePidFile(WATCHER_PID_FILE, process.pid);
    const cleanup = () => { removePidFile(WATCHER_PID_FILE); removePidFile(BRIDGE_PID_FILE); };
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
      try { process.on(sig, () => { cleanup(); process.exit(0); }); } catch { /* 该信号在本平台不可注册 */ }
    }
  }

  await ensureBridge();
  setInterval(ensureBridge, 10000); // 每 10s 检查
  console.log("[dsh-remote] 守护运行中（Ctrl-C 退出）");
}

// ---------- setup：一键安装（默认云端服务；--server/--key 走自建） ----------
async function setup(argv) {
  const api = argValue(argv, "--api");
  const server = argValue(argv, "--server");
  const key = argValue(argv, "--key");
  const noAutostart = hasFlag(argv, "--no-autostart");
  const noPlugin = hasFlag(argv, "--no-plugin");
  const noRestart = hasFlag(argv, "--no-restart");
  const selfHosted = Boolean(server || key);

  let cfg = loadConfig();

  if (selfHosted) {
    if (!server || !key) {
      console.error("❌ 自建模式需要 --server（wss://host:port）与 --key（访问密钥）两个参数。");
      process.exit(1);
    }
    cfg.tunnel_url = normalizeTunnelUrl(server);
    cfg.local_key = String(key).trim();
    delete cfg.phone; delete cfg.password;
    saveConfig(cfg);

    // 校验：用访问密钥向 router 换本地 JWT（连不通立即报错）
    const u = new URL(cfg.tunnel_url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/_login";
    try {
      const r = await fetch(u.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: cfg.local_key }),
        signal: AbortSignal.timeout(8000)
      });
      const d = await r.json().catch(() => ({}));
      if (r.status !== 200 || !d.token) {
        console.error(`❌ 访问密钥校验失败（${r.status}）: ${d.error?.message || "未知错误"}`);
        process.exit(1);
      }
      console.log("✅ 已连接你的 relay-router，访问密钥有效。");
    } catch (e) {
      console.error(`❌ 无法连接 ${u.toString()}: ${e.message}`);
      console.error("   请确认服务器地址、端口与 TLS 配置（自建需 https/wss 入口）。");
      process.exit(1);
    }
  } else {
    // 默认云端服务：无需任何参数；登录在设置页完成
    cfg.api_url = (api || cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
    if (!cfg.tunnel_url) cfg.tunnel_url = deriveTunnelUrl(cfg.api_url);
    // 自动获取服务端下发的 bridge_secret（device-login 共享密钥，一键安装开箱即用）
    if (!cfg.bridge_secret) {
      const pub = await fetchPublicConfig(cfg.api_url);
      if (pub.bridge_secret) cfg.bridge_secret = String(pub.bridge_secret);
    }
    saveConfig(cfg);
  }

  let svc = { path: null, status: { ok: true, status: "skipped", detail: "--no-autostart" } };
  if (!noAutostart) {
    svc = installAutostart();
  } else {
    console.log("ℹ --no-autostart：跳过自启动服务安装（可用 `dsh-remote run` 手动运行 bridge）。");
  }
  const st = svc.status;

  // 自动安装 dsh web 插件（非致命：失败只提示，不阻断安装）
  let pluginResult = null;
  if (!noPlugin) {
    try {
      pluginResult = await pluginCmd([]);
    } catch (e) {
      console.warn(`⚠️ 插件安装未完成：${e.message}`);
    }
  }

  // 插件是**进程启动时**装载的：刚装进 profile 的插件，运行中的 dsh web 里并没有
  // （既没有 /dsh-remote/* 路由，也没有「设置 → 远程控制」面板项）。
  // 这里做一个确定性判断：进程启动时间早于插件落盘时间 → 必须重启 dsh web 才生效。
  const pluginDir = path.join(resolveProfileDir(argv), PLUGIN_LOCAL_DIR);
  const pluginMtime = fs.existsSync(path.join(pluginDir, "lib", "index.js"))
    ? fs.statSync(path.join(pluginDir, "lib", "index.js")).mtimeMs
    : 0;
  let webPid = null;
  let needRestart = false;
  let hotMounted = false;
  let runningSeen = ""; // 探测窗口里看到过的运行中插件版本(超时时用于给出准确提示)
  const webUp = await isDshWebUp();
  if (webUp) {
    webPid = dshWebPid();
    const startedAt = webPid ? processStartMs(webPid) : 0;
    needRestart = Boolean(pluginMtime && startedAt && startedAt < pluginMtime);
    // patch 激活形态:harness 的 HMR 监听 profile patch 文件,存盘后约 1 秒重新 compose。
    // 所以这里**先等热挂载**,等到了就完全不需要重启(用户只需刷新页面拿浏览器半)。
    if (needRestart && pluginResult && pluginResult.hotPatch) {
      // HMR 通常 1~3 秒完成,但插件节点半还要起服务、注册路由,机器繁忙时会到十几秒;
      // ⚠️ 判据必须是**运行中的插件版本 == 我们刚装上的版本**,不能只看"接口是否 200" ——
      // 旧版本插件本来就有这个接口,接口通不代表新代码已装载(实测踩到:profile 已是 0.6.4,
      // 运行中仍报 beta.10,而探测却认为"热挂载成功")。
      const wantVersion = pkgVersion();
      // 先**主动触发**一次 HMR：patch 文件是唯一被监听的对象。
      // 注意边界（实测）：这招对"插件首次出现在 patch 行里"有效（行从无到有 = 真变化，
      // 约 1~3 秒装载）；但对"同一插件换了新版本"**无效** —— patch 行内容没变，
      // 而且加载器按 URL 缓存模块，改写插件文件本身不会重新装载。后者必须重启 dsh web。
      // 因此下面按**版本**轮询，等不到就如实让用户重启。
      try {
        const patchPath = path.join(resolveProfileDir(argv), "cordis.patch.yml");
        const cur = fs.readFileSync(patchPath, "utf8");
        fs.writeFileSync(patchPath, cur);
      } catch { /* 忽略：轮询会给出结论 */ }
      for (let i = 0; i < 45; i += 1) {
        const r = await fetch("http://127.0.0.1:3080/dsh-remote/self", { signal: AbortSignal.timeout(900) })
          .catch(() => null);
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          const running = j && typeof j.version === "string" ? j.version : "";
          if (running && running === wantVersion) { hotMounted = true; break; }
          // 接口通但版本还是旧的 → HMR 还没换过来(或没触发),继续等
          runningSeen = running || runningSeen;
        }
        sleepSync(700);
      }
      if (hotMounted) needRestart = false;
    }
  }
  // 需要就用**最省事的方式**替用户重启:插件装完还要用户自己琢磨怎么重启,是这一步唯一的手工负担
  let restartResult = null;
  if (needRestart && !noRestart && webUp) {
    console.log("");
    console.log("ℹ 检测到运行中的 dsh web 早于本次插件安装 —— 插件只在进程启动时装载，");
    console.log("  所以「设置 → 远程控制」面板暂时还没出现。正在为你重启 dsh web（2 秒后执行，Ctrl-C 可跳过）…");
    sleepSync(2000);
    restartResult = restartDshWeb();
    if (restartResult.ok) {
      // 等它回来再确认端口确实在听(避免"重启完其实没起来"还要用户自己发现)
      for (let i = 0; i < 20; i += 1) {
        if (await isDshWebUp(800)) break;
        sleepSync(700);
      }
    }
    console.log(restartResult.ok
      ? `✅ 已重启 dsh web（${restartResult.how}）`
      : `⚠️ 自动重启失败: ${restartResult.detail}`);
  }

  const pub = await fetchPublicConfig(cfg.api_url || DEFAULT_API);
  // 服务状态字符串是给插件面板解析的稳定契约(running / 未运行),不要改口径。
  // 三分支:running / 未运行(有原因) / 未安装(跳过或平台不支持)——最后一种既不能显示"运行中",
  // 也不能显示"未运行(原因)",它压根没装(此前会打出自相矛盾的"(当前平台不支持) — ✅ 运行中")。
  const svcSkipped = st.status === "skipped" || st.status === "unsupported" || !svc.path;
  // 第三态:起来了、但本机 launchd 不保证崩溃自愈(on-demand-only 的 gui domain 只能靠 kickstart 拉起),
  // 必须与"完全正常"分开说 —— 否则用户以为有自启,进程一崩就永久掉线且找不到原因。
  // Windows 没有 launchd，这条判断对它不成立（否则会把 win32 误报成"本机不支持崩溃自愈"）。
  const svcFragile = !IS_WIN && !svcSkipped && st.ok && st.selfHealing === false;
  const svcDegraded = st.status === "degraded-detached";
  // Windows：自启动 = 任务计划程序里的登录任务。口径与 macOS/Linux 不同
  // （"任务已注册" ≠ "进程此刻在跑"），所以单独给文案，避免复用"未被系统托管"这种会误导的措辞。
  const winTask = IS_WIN && winTaskOk();
  const svcState = IS_WIN
    ? (st.status === "skipped"
        ? "未安装（本次显式跳过）"
        : (!winTask
            ? "未注册（登录任务创建失败，可用 `dsh-remote run` 手动运行 bridge）"
            : (st.ok ? `✅ 已注册，守护进程在运行${st.pid ? ` (pid=${st.pid})` : ""}` : "✅ 已注册（登录后自动运行；dsh web 打开时会立刻接上）")))
    : (svcSkipped
        ? (st.status === "skipped" ? "未安装（本次显式跳过）" : "未安装（当前平台不支持自启动）")
        : (st.ok
            ? `✅ 运行中${st.pid ? ` (pid=${st.pid})` : ""}${svcFragile ? "，但本机不支持崩溃自愈" : ""}`
            : (svcDegraded ? "⚠️ 未被系统托管（已用后台进程兜底）" : `未运行 (${st.detail || st.status})`)));
  const L = [];
  L.push("✅ 安装完成");
  if (selfHosted) {
    L.push(`   服务器: ${cfg.tunnel_url}`);
    L.push(`   手机端: 打开 ${cfg.tunnel_url.replace(/^ws/, "https")}/app/ ，用访问密钥登录`);
  } else {
    L.push(`   远程控制地址: ${pub.app_url || DEFAULT_APP_URL}`);
  }
  L.push(svcSkipped
    ? `   自启动服务: ${svcState}，可用 \`dsh-remote run\` 手动运行 bridge`
    : `   自启动服务: ${svc.path} — ${svcState}`);
  // 唯一一处"下一步"引导(上面各阶段不再重复打印同样的话)
  if (svcSkipped) {
    // 没装自启动服务,就没有"服务状态"可谈,更不该给出"打开 dsh web 就会自动启动"的承诺
    L.push("");
    L.push("ℹ 未安装自启动服务：需要时执行 `dsh-remote run`（前台运行 bridge），或重新安装以启用自启动。");
  } else if (!st.ok && !webUp) {
    // dsh web 没开时 bridge 起来即退,这是正常状态;要说清"什么时候会自己好",而不是甩一句"启动失败"
    L.push("");
    L.push("ℹ 检测到 dsh web 当前没有运行，所以 bridge 还没接上（正常，不是安装出错）。");
    L.push("   打开 dsh web 后 bridge 会自动启动，无需任何命令。");
    L.push("   如果 dsh web 已经开着但看不到本机，先重启 dsh web 让插件生效。");
  } else if (!st.ok) {
    L.push("");
    if (IS_WIN) {
      // Windows：登录任务已注册，只是此刻 bridge 守护还没就绪（dsh web 刚起、或还没登录账号）
      L.push(`ℹ bridge 守护还没就绪: ${st.detail || st.status}`);
      L.push(`   已注册登录任务「${WIN_TASK_NAME}」，下次登录会自动运行；`);
      L.push("   也可以现在执行 `dsh-remote run` 前台运行 bridge（Ctrl-C 退出）。");
      L.push(`   日志: ${CONFIG_DIR}\\.dsh-bridge.log`);
    } else if (svcDegraded) {
      // launchd 托管失败但进程活着:能立刻用,只是没有自启/自愈。如实说明,别让用户以为有自启。
      L.push(`⚠️ ${st.detail}`);
      L.push(`   bridge 已在后台运行${st.pid ? `（pid=${st.pid}）` : ""}，现在就能用；`);
      L.push("   但重启电脑或进程退出后不会自动恢复，需要时执行 `dsh-remote run`。");
    } else {
      L.push(`⚠️ bridge 未能启动: ${st.detail || st.status}`);
      L.push(`   可查看日志: ${CONFIG_DIR}/.dsh-bridge.log`);
    }
  } else if (svcFragile) {
    // 起来了但靠 kickstart 拉起的 → 明确告知"进程退出后不会自动重建"
    L.push("");
    L.push("ℹ 本机 launchd 处于 on-demand-only 模式（macOS 26 起会出现），系统不会自动派生自启动服务，");
    L.push("   安装脚本已手动把它拉起来一次，现在可用；但**进程退出后不会自动重建**。");
    L.push("   建议升级到最新版 dsh-remote（已针对该模式改用 user domain 启动，可恢复自动重建）。");
  }
  if (selfHosted) {
    L.push("");
    L.push("   下一步: 手机端用访问密钥登录即可（bridge 登录后自动启动）。");
  } else if (hotMounted) {
    L.push("");
    L.push("   下一步: 插件已热加载（无需重启 dsh web）——刷新一下浏览器页面，");
    L.push("          再打开 设置 → 「远程控制」→ 注册/登录手机号即可。");
  } else if (needRestart && restartResult && restartResult.ok) {
    L.push("");
    L.push("   下一步: dsh web 已重启，直接打开 http://127.0.0.1:3080 → 设置 → 「远程控制」→ 注册/登录手机号。");
  } else if (needRestart && pluginResult && pluginResult.hotPatch && pluginResult.changed) {
    // patch 已写入但探测窗口内没等到面板接口:热加载很可能还在进行(插件节点半启动+注册路由)。
    // 这种情况**不能**直接让用户重启 —— 先让他等几秒刷新,再给兜底方案。
    L.push("");
    if (runningSeen) {
      L.push(`ℹ 插件已按热加载方式登记，但运行中的 dsh web 仍在用旧版本（${runningSeen} → 期望 ${pkgVersion()}）：`);
      L.push("   刷新页面即可（浏览器半会跟着更新）；若刷新后功能仍不对，再重启一次 dsh web。");
    } else {
      L.push("ℹ 插件已按热加载方式登记（patch 已写入），若「设置 → 远程控制」还没出现：");
      L.push("   等几秒后刷新页面即可；仍未出现再重启一次 dsh web（命令见 README）。");
    }
  } else if (needRestart) {
    // 需要重启但没做成功:必须给出**可照抄**的命令,而不是只说"请重启"
    L.push("");
    L.push("⚠️ 还需要重启一次 dsh web，插件面板才会出现（插件只在进程启动时装载）。");
    L.push("   请手动执行（任选其一）：");
    L.push("     launchctl kickstart -k gui/$(id -u)/com.dshweb.dev     # 用 launchd 托管时");
    L.push("     kill $(lsof -ti tcp:3080 -sTCP:LISTEN) && dsh web --no-open   # 手动启动时");
    L.push("   重启后：打开 http://127.0.0.1:3080 → 设置 → 「远程控制」→ 注册/登录手机号。");
  } else {
    L.push("");
    L.push("   下一步: 打开 dsh web → 设置 → 「远程控制」→ 注册/登录手机号即可（无需任何命令）。");
  }
  console.log("\n" + L.join("\n") + "\n");
}

// ---------- plugin：安装/卸载 dsh web 远程控制插件 ----------
/** 当前插件名（2026-09 由 dsh-remote-ui 更名；dsh-remote-web = dsh-remote 的 dsh web 插件半）。 */
const PLUGIN_ID = "dsh-remote-web";
/** 更名前的历史插件名（≤0.4.9）：升级安装/卸载时一并清理，避免旧 id 残留导致重复激活。 */
const PLUGIN_LEGACY_IDS = ["dsh-remote-ui"];
/** 当前名 + 全部历史名。 */
const PLUGIN_ALL_IDS = [PLUGIN_ID, ...PLUGIN_LEGACY_IDS];
const PLUGIN_MARKER_START = `# >>> ${PLUGIN_ID} (managed by dsh-remote plugin; do not edit)`;
const PLUGIN_MARKER_END = `# <<< ${PLUGIN_ID}`;
/** 插件在 profile 内的固定本地目录(安装时整目录拷贝)。 */
const PLUGIN_LOCAL_DIR = `${PLUGIN_ID}-plugin`;
/** 片段是否涉及本插件(当前名或任一历史名)。 */
const pluginRef = (s) => PLUGIN_ALL_IDS.some((id) => s.includes(id));

/**
 * include 块。name 必须是【裸包名】'${PLUGIN_ID}'（≤0.4.9 为 'dsh-remote-ui'）：
 *  - 加载器据此 import 节点半(${PLUGIN_ID} 由 node_modules 链接解析);
 *  - dsh 客户端模块系统(@deepseek-ai/dsh-client-modules)用 require.resolve(
 *    '<name>/package.json') 从 profile 解析该包并读取 package.json 的
 *    dsh.client 声明 → 注入浏览器半(设置面板 UI)。相对文件路径入口只会加载
 *    节点半、不会注入 UI —— 0.3.7/0.3.8 曾因此丢设置页。
 * 链接由安装器自建(node_modules/${PLUGIN_ID} → 拷贝出的目录),不依赖 pnpm/npm。
 */
function pluginBlock(relayDir) {
  return `${PLUGIN_MARKER_START}
- insert:
    - id: ${PLUGIN_ID}
      name: '${PLUGIN_ID}'
      config:
        relayDir: '${relayDir}'
${PLUGIN_MARKER_END}`;
}

/** 移除 patch 中所有引用本插件（当前或历史名）的条目块（含其前置注释），返回剩余内容。 */
function stripPluginEntries(patch) {
  const lines = patch.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^- insert:\s*$/.test(line)) {
      // insert 块 = 该行 + 后续「缩进」行；空行/注释行属于下一个条目，不并入
      const block = [line];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith(" ") || lines[j].startsWith("\t"))) {
        block.push(lines[j]);
        j++;
      }
      if (pluginRef(block.join("\n"))) {
        // 连带删除块前的连续注释（旧版条目说明 / 管理标记），以及块后的收尾标记行
        while (out.length && /^\s*#/.test(out[out.length - 1])) out.pop();
        if (j < lines.length && /^\s*#/.test(lines[j]) && pluginRef(lines[j])) j++;
        i = j;
        continue;
      }
      out.push(...block);
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * 语义化版本比较（只处理本仓库用到的形态：X.Y.Z 与 X.Y.Z-<pre>.<n>）。
 * 为什么需要：装置器必须判断"本地这份包 vs profile 里已装的那份"谁更新 ——
 * 用字符串比较会把 0.6.6-beta.2 与 0.6.5 比错（预设版低于同号正式版），
 * 于是要么跳过本该做的升级、要么把新版降级。任一侧解析不了返回 null（调用方保守处理）。
 * @returns {number|null} a>b → 1；a<b → -1；相等 → 0；无法解析 → null
 */
function compareVersionStrings(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || "").trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;   // 预设版 < 同号正式版（semver §11）
  if (!y.pre) return -1;
  const len = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < len; i += 1) {
    const p1 = x.pre[i];
    const p2 = y.pre[i];
    if (p1 === undefined) return -1;
    if (p2 === undefined) return 1;
    const n1 = /^\d+$/.test(p1) ? Number(p1) : null;
    const n2 = /^\d+$/.test(p2) ? Number(p2) : null;
    if (n1 !== null && n2 !== null) { if (n1 !== n2) return n1 > n2 ? 1 : -1; continue; }
    if (n1 !== null) return -1;
    if (n2 !== null) return 1;
    if (p1 !== p2) return p1 > p2 ? 1 : -1;
  }
  return 0;
}

/**
 * 解析 patch 文本里的 insert 行 id（与 dshmarket 同口径的极简解析，不引 YAML 依赖）。
 * 用途有二：① 判断本插件是否已激活（幂等）；② **写完校验**——patch 文件形态非法时
 * dsh web 会直接启动失败，所以每次写入后必须重新解析确认结果仍是「一行一条的 insert 列表」。
 * @returns {{ids: string[], badLines: string[]}} badLines 非空 = 文件形态不合法
 */
function parsePatchInsertIds(text) {
  const ids = [];
  const badLines = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    // 先剥注释与尾部空白;注意 id 行在块内是缩进的(`    - id: xxx`),不能要求顶格
    const line = raw.replace(/#.*$/, "").replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "[]") continue;                               // 新 profile 的空文档占位
    if (/^-\s*insert:\s*$/.test(trimmed)) continue;              // insert 块头(可缩进)
    const m = /^-\s*id:\s*(\S+)\s*$/.exec(trimmed);            // 条目行(可缩进)
    if (m) { ids.push(m[1]); continue; }
    // 其余缩进行属于某个条目的字段(name/config/...),合法;顶层非列表行才是异常形态
    if (/^\s+\S/.test(line)) continue;
    badLines.push(trimmed);
  }
  return { ids, badLines };
}

/**
 * 写入 patch 前校验基座形态。
 * 只接受「空/仅占位/现有条目」三种基座；发现异常内容就**拒写**（绝不把一个本来还能用的
 * profile 弄坏 —— 改动前先确认目标文件是可安全追加的形态，而不是先写再看结果）。
 * @returns {{ok: boolean, reason?: string, cleaned: string, insertedIds: string[]}}
 */
function validatePatchBase(text) {
  const { ids, badLines } = parsePatchInsertIds(text);
  if (badLines.length) {
    return { ok: false, reason: `patch 文件含无法识别的行（未做改动）: ${badLines[0].slice(0, 60)}`, cleaned: "", insertedIds: ids };
  }
  // 去掉空文档占位 `[]`（它在条目之前会让整份文档变成「数组套列表」而解析失败）
  const cleaned = String(text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "[]").join("\n").trim();
  return { ok: true, cleaned, insertedIds: ids };
}

/**
 * patch 文本是否是「合法的顶层 YAML 数组文档」。
 *
 * 为什么必须判：dsh 侧解析 cordis.patch.yml 时**要求顶层是数组**，而
 * **纯注释文档的 YAML 解析结果是 `null`（不是空数组）**，于是 dsh 直接启动失败：
 *   `Error: dsh: overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries`
 * 官方空 profile 模板（dsh-app-boot）正是「注释 + `[]`」——`[]` 这个占位符不能省。
 * 现场（2026-09-18 Windows 用户实测）：卸载把插件条目摘掉后只剩顶部注释，dsh web 再也起不来。
 */
/** 顶层（无缩进）非注释行 = YAML 的结构行；缩进行属于上一条目。 */
function patchStructuralLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !/^\s*#/.test(l) && !/^[ \t]/.test(l));
}

/** 是否是合法的顶层数组文档（`[]` 占位，或若干 `-` 开头的顶层条目）。 */
function isPatchArrayDocument(text) {
  const roots = patchStructuralLines(text);
  return roots.length > 0 && roots.every((l) => l === "[]" || l.startsWith("-"));
}

/** 只有注释/空行 → YAML 解析成 null（不是空数组），必须补 `[]` 占位，否则 dsh 起不来。 */
function needsArrayPlaceholder(text) {
  return patchStructuralLines(text).length === 0;
}

/**
 * 写回 patch 文档，并**保证结果仍是合法顶层数组**：条目被删光时补回 `[]` 占位。
 * 卸载、摘 include、回滚都必须走这里 —— 任何一条写路径漏了这步，用户就会拿到
 * 一个「dsh web 起不来且面板也进不去」的 profile（只能靠 CLI 自救）。
 */
function writePatchDocument(patchFile, text) {
  const body = String(text ?? "").replace(/\s+$/, "") + "\n";
  // ⚠️ 只在「一个结构行都不剩」时补 —— 不能因为"看起来不像数组"就乱补，
  //    那会把本来好的文件写坏（把 `[]` 追加到已有 insert 块后面 → YAML 直接报错）。
  const fixed = needsArrayPlaceholder(body) ? `${body}[]\n` : body;
  writePatchAtomic(patchFile, fixed);
  return fixed;
}

/** 安全写回 patch（原子：先写同目录临时文件再 rename，避免中途被打断留下半截文件）。 */
function writePatchAtomic(patchFile, text) {
  const tmp = `${patchFile}.dsh-remote.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, patchFile);
}

/**
 * 原子地写入插件 patch 激活行；写后**重新解析校验**，不合法立即回滚。
 * 返回 {ok, changed, reason?, basePatch}
 *
 * ⚠️ 硬约束：**本函数绝不能在插件已在 dsh.profile.bundles 时写入 patch 行**。
 * 两个激活点同时存在时，dsh web 启动即 `duplicate loader entry id: dsh-remote-web`
 * 并导致「plugin tree failed to load」——整个插件树加载失败（实测日志）。
 * 因此所有 return 之前都要保证：要么只有 patch 行、要么只有 bundles 条目。
 */
function ensurePatchActivation(patchFile, pluginLocalDir, pkgFile, opts = {}) {
  const original = fs.readFileSync(patchFile, "utf8");
  const pkgBundles = () => {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      return (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))
        ? pkg.dsh.profile.bundles.filter((b) => PLUGIN_ALL_IDS.includes(b)) : [];
    } catch { return []; }
  };
  // 插件已在 bundles 时默认**不**写 patch 行（两条激活路径互斥，否则 duplicate id 崩树）。
  // 但有两个例外必须主动改写激活点：
  //   · forcePatch：源码已被我们换成本地这份（升级场景）→ 必须转 patch 行才能热加载；
  //   · 插件市场形态（bundles 里的条目由包管理器管）→ 保持 bundles，不碰。
  const inBundles = pkgBundles();
  if (inBundles.length && !opts.forcePatch) {
    return { ok: false, reason: "插件已由 dsh.profile.bundles 声明（保持单一激活点，不写 patch 行）", changed: false, bundleOnly: true, basePatch: original };
  }
  if (inBundles.length && opts.forcePatch) {
    // 自己动手摘掉 bundles 条目（不依赖调用方的执行顺序），再走 patch 行激活
    removeBundleEntry(pkgFile);
    if (pkgBundles().length) {
      return { ok: false, reason: "无法移除 dsh.profile.bundles 中的本插件条目", changed: false, basePatch: original };
    }
  }
  const base = validatePatchBase(original);
  if (!base.ok) return { ok: false, reason: base.reason, changed: false, basePatch: original };
  const hasOurRow = base.insertedIds.some((id) => PLUGIN_ALL_IDS.includes(id));
  if (hasOurRow) {
    const bundleRemoved = removeBundleEntry(pkgFile);
    if (bundleRemoved) console.log("✅ 已从 dsh.profile.bundles 移除重复激活点（激活统一走 patch 行）");
    // 已有条目也要**自我修正**：配置目录变了（换安装方式 / 之前写错）时 relayDir 必须跟着更新，
    // 否则面板会一直去旧目录找 .dsh-config.json（表现就是"未登录 / 空配置"）。
    const want = pluginBlock(CONFIG_DIR);
    const wantDir = (/relayDir: '([^']*)'/.exec(want) || [])[1] || "";
    if (wantDir && !original.includes(`relayDir: '${wantDir}'`)) {
      const base2 = validatePatchBase(stripPluginEntries(original));
      if (base2.ok) {
        const merged2 = `${base2.cleaned ? base2.cleaned + "\n" : ""}\n${want}\n`;
        const chk = parsePatchInsertIds(merged2);
        if (!chk.badLines.length && chk.ids.filter((id) => id === PLUGIN_ID).length === 1) {
          writePatchDocument(patchFile, merged2);
          console.log(`✅ 已同步激活行的 relayDir → ${wantDir}`);
          return { ok: true, changed: true, basePatch: original };
        }
      }
      console.warn("⚠️ 激活行的 relayDir 与当前配置目录不一致，但未能安全改写（保持原样）");
    }
    return { ok: true, changed: bundleRemoved, basePatch: original };
  }
  // 写前再次校验我们的块本身可解析（id 行必须能被 parsePatchInsertIds 认出来）
  // ⚠️ relayDir 必须传**配置目录**(CONFIG_DIR, 即 ~/.dsh-remote),不是插件安装目录:
  // 面板要读的是该目录下的 .dsh-config.json(账号/中继配置);传成 pluginLocalDir 会让面板
  // 对着插件源码目录找配置 → 界面显示成"未登录 / 空配置"(实测踩到)。
  const block = pluginBlock(CONFIG_DIR);
  if (!parsePatchInsertIds(block).ids.includes(PLUGIN_ID)) {
    return { ok: false, reason: "生成的激活块自身不合法", changed: false, basePatch: original };
  }
  const merged = `${base.cleaned ? base.cleaned + "\n" : ""}\n${block}\n`;
  // 写后校验：整份文件必须仍是干净的 insert 列表，且我们的 id 恰好出现一次
  const check = parsePatchInsertIds(merged);
  if (check.badLines.length || check.ids.filter((id) => id === PLUGIN_ID).length !== 1) {
    return { ok: false, reason: "合并后的 patch 校验未通过（未做改动）", changed: false, basePatch: original };
  }
  writePatchDocument(patchFile, merged);
  const after = fs.readFileSync(patchFile, "utf8");
  const verify = parsePatchInsertIds(after);
  if (verify.badLines.length || verify.ids.filter((id) => id === PLUGIN_ID).length !== 1) {
    writePatchDocument(patchFile, original); // 回滚
    return { ok: false, reason: "写入后校验失败，已回滚", changed: false, basePatch: original };
  }
  removeBundleEntry(pkgFile); // 单一激活点：bundles 里不能再有本插件
  // 双保险：上面那次移除若没生效（并发写 package.json / 解析失败），**回滚本次 patch 行**，
  // 宁可退回 bundles 形态（需重启）也绝不留"两处激活"→ dsh web 启动会 duplicate id 崩掉。
  if (pkgBundles().length) {
    writePatchDocument(patchFile, original);
    return { ok: false, reason: "bundles 条目未能移除，已回滚 patch 行以免重复激活", changed: false, bundleOnly: true, basePatch: original };
  }
  return { ok: true, changed: true, basePatch: original };
}

/** 清理 patch 中引用本插件的条目块（含前置注释/收尾标记）。返回是否发生变更。 */
function stripIncludeEntries(patchFile, patch, reason) {
  const next = stripPluginEntries(patch);
  if (next === patch) return false;
  writePatchDocument(patchFile, next);
  console.log(`✅ 已移除 ${patchFile} 中的冗余 include（${reason}；激活点必须唯一，避免重复 ID 崩溃）`);
  return true;
}

/**
 * 归一化 patch 基座：去掉 dsh 新 profile 默认的空文档占位行 `[]`。 * 默认 cordis.patch.yml 是「顶部注释 + []」，若保留 [] 再往下拼 `- insert:`，
 * YAML 会报 “end of the stream or a document separator is expected”（dsh web 启动即崩）。
 * 返回内容不含结尾换行；[] 行只在独立成行时视为占位，不影响真正的条目。
 */
function normalizePatchBase(patch) {
  return String(patch ?? "")
    .split("\n")
    .filter((l) => !/^\[\s*\]\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * 把插件整目录拷贝进 profile 的固定子目录并返回该目录。
 * 源(本包 packages/${PLUGIN_ID})可能在 npx 临时缓存里,因此必须拷到 profile 内持久化,
 * include 用相对路径直接指向拷贝出的入口,不写依赖、不跑任何包管理器。
 */
function copyPluginIntoProfile(profileDir, pluginDir) {
  // 清理历史名残留目录（≤0.4.9 的 dsh-remote-ui-plugin），避免与新版并存
  for (const id of PLUGIN_LEGACY_IDS) {
    try { fs.rmSync(path.join(profileDir, `${id}-plugin`), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const dest = path.join(profileDir, PLUGIN_LOCAL_DIR);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(pluginDir, dest, {
    recursive: true,
    // 注意：插件源(npx 缓存 / npm 全局)本身就位于某个 node_modules 之下，
    // 过滤必须基于“相对插件目录”的路径片段，绝不能整条 src 路径包含判断，
    // 否则会把插件文件全过滤掉、拷出空目录(此前反复“插件入口缺失”的总根因)。
    filter: (src) => {
      if (src === pluginDir) return true;
      const rel = path.relative(pluginDir, src);
      return !String(rel).split(path.sep).some((seg) => seg === "node_modules" || seg === ".git" || seg === ".DS_Store");
    }
  });
  return dest;
}

/** 把插件挂到 <profile>/node_modules/<PLUGIN_ID>(裸包名解析需要),指向拷贝目录;缺失/指错时重建。 */
/**
 * 判定 `node_modules/<PLUGIN_ID>` 是否**真的可用**。
 *
 * 判据绝不是"函数有没有抛错" —— 这是 0.6.7-beta.1 在 Windows 上翻车的根因：
 * 非特权进程 + 开发者模式关闭时，`fs.symlinkSync(target, path, "dir")` 会**既不抛错也产不出可用链接**
 * （实测：用户目录下留下一个空目录；%TEMP% 下什么都不留；同一位置两次运行一次报成功一次抛 UNKNOWN）。
 * 于是"用 try/catch 探测能力"这个前提在 Windows 上根本不成立，写在其 catch 里的 junction 兜底永不执行。
 *
 * 这里只认 dsh 自己那条解析路径能不能走通：
 *   ① 读得到 package.json 且 name 正确（cordis 加载器 + @deepseek-ai/dsh-client-modules 靠它读 dsh.client）；
 *   ② 读得到 lib/index.js（节点半入口）；
 *   ③ 要么 realpath 指回本地拷贝目录（链接形态），要么入口内容与本地拷贝逐字节一致（整目录拷贝形态）。
 */
function pluginLinkUsable(nmPlugin, pluginLocalDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(nmPlugin, "package.json"), "utf8"));
    if (pkg.name !== PLUGIN_ID) return false;
    if (!fs.existsSync(path.join(nmPlugin, "lib", "index.js"))) return false;
  } catch { return false; }

  let real = "";
  try { real = fs.realpathSync(nmPlugin); } catch { /* 悬空链接 */ }
  if (real) {
    try { if (real === fs.realpathSync(pluginLocalDir)) return true; } catch { /* 本地目录不在 → 看内容 */ }
  }
  try {
    return fs.readFileSync(path.join(nmPlugin, "lib", "index.js"), "utf8")
      === fs.readFileSync(path.join(pluginLocalDir, "lib", "index.js"), "utf8");
  } catch { return false; }
}

/**
 * 把插件挂到 `<profile>/node_modules/<PLUGIN_ID>`。
 *
 * 规格：已就绪返回 false（幂等）、重建成功返回 true、**任何情况下都没能挂好就抛错**。
 * 抛错是刻意的 —— 调用方必须据此中止安装：写进 patch 的激活行会让 dsh web 按裸包名解析这个目录，
 * 解析不到就 `Cannot find package '...\node_modules\dsh-remote-web\index.js'`，
 * 而 cordis 的插件树加载失败 = **整个 dsh web 起不来**（用户连面板都打不开，没有自助修复入口）。
 * 宁可不装，也不能写出一个起不来的 profile。
 */
function ensurePluginLinked(profileDir, pluginLocalDir) {
  const nmDir = path.join(profileDir, "node_modules");
  const nmPlugin = path.join(nmDir, PLUGIN_ID);
  if (!fs.existsSync(path.join(pluginLocalDir, "package.json"))) {
    throw new Error(`本地插件拷贝缺失或不完整：${pluginLocalDir}（应含 package.json）`);
  }
  fs.mkdirSync(nmDir, { recursive: true });
  // 清理历史名链接（node_modules/dsh-remote-ui），避免解析到旧拷贝
  for (const id of PLUGIN_LEGACY_IDS) {
    try { fs.rmSync(path.join(nmDir, id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (pluginLinkUsable(nmPlugin, pluginLocalDir)) return false; // 已就绪（拷贝形态也算就绪）

  // ⚠️ Windows 上**不要用 symlinkSync(...,'dir')**：非特权进程下它产不出可用链接，
  //    而且抛不抛错不确定、失败时还会留下空目录残留 —— 兜底链会因此整条失效（实测）。
  //    junction（目录联接）免特权、realpath 正确、require.resolve 与 ESM 裸包名解析都正常。
  const attempts = process.platform === "win32"
    ? [
        ["junction", () => fs.symlinkSync(path.resolve(pluginLocalDir), nmPlugin, "junction")], // junction 只接受绝对路径
        ["copy", () => fs.cpSync(pluginLocalDir, nmPlugin, { recursive: true })],
      ]
    : [
        ["dir", () => fs.symlinkSync(pluginLocalDir, nmPlugin, "dir")],
        ["copy", () => fs.cpSync(pluginLocalDir, nmPlugin, { recursive: true })],
      ];

  const failures = [];
  for (const [how, run] of attempts) {
    // 每支开始前先清残留：上一支"没抛错但留了个空目录"时，不清就会让下一支撞 EEXIST 而失败
    //（这正是原实现三级兜底退化成一级的原因）。
    try { fs.rmSync(nmPlugin, { recursive: true, force: true }); } catch { /* ignore */ }
    let err = null;
    try { run(); } catch (e) { err = e; }
    if (pluginLinkUsable(nmPlugin, pluginLocalDir)) return true;
    failures.push(`${how}: ${err ? err.message : "未抛错但落盘结果不可用（读不到 package.json / lib/index.js）"}`);
  }
  throw new Error(`插件挂载失败：${nmPlugin}\n   ${failures.join("\n   ")}`);
}


/**
 * 独立验收：复刻 dsh 客户端模块系统的真实动作 —— 从 profile 目录按**裸包名**解析到本插件。
 *
 * 与 pluginLinkUsable 是两道独立的闸门：前者看文件在不在、是不是真指向目标；
 * 这条走 Node 的解析器（exports 字段、symlink 跟随、pnpm 布局），是"面板能不能被注入"的前提
 * （@deepseek-ai/dsh-client-modules 就是 require.resolve('<name>/package.json') 读 dsh.client）。
 */
function probePluginResolve(profileDir) {
  const base = path.join(profileDir, "__dsh_resolve_probe.cjs");
  // 必须**另起一个 node 进程**做这次解析，不能在本进程里 require.resolve：
  // 实测（Node 25 / macOS）：本进程里只要先失败过一次裸包名解析（例如"修复前诊断"那次），
  // 链接随后修好了，同一个进程里的裸包名解析**仍会持续失败**（子路径却正常）——
  // 进程内的解析缓存会把假阴性一直带下去，让"修复后验收"误判成没修好、拒绝恢复激活。
  // 另起进程同时也更忠实：dsh 启动时就是在一个全新进程里解析这些裸包名的。
  const script = [
    'const { createRequire } = require("node:module");',
    `const req = createRequire(${JSON.stringify(base)});`,
    "process.stdout.write(JSON.stringify({",
    `  pkgPath: req.resolve(${JSON.stringify(`${PLUGIN_ID}/package.json`)}),`,
    `  entry: req.resolve(${JSON.stringify(PLUGIN_ID)})`,
    "}));",
  ].join("\n");
  try {
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (r.error) return { ok: false, reason: `无法启动解析探测进程：${r.error.message}` };
    if (r.status !== 0) {
      const line = String(r.stderr || "").split("\n").find((l) => /MODULE_NOT_FOUND|ERR_|Error/.test(l)) || "解析失败";
      return { ok: false, reason: line.trim().slice(0, 200) };
    }
    const out = JSON.parse(String(r.stdout || "{}"));
    const pkg = JSON.parse(fs.readFileSync(out.pkgPath, "utf8"));
    return {
      ok: true,
      pkgPath: out.pkgPath,
      entry: out.entry,
      name: pkg.name,
      clientPlatform: (pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform) || "",
    };
  } catch (e) {
    return { ok: false, reason: `${e.code || e.name}: ${e.message}` };
  }
}

/**
 * 描述插件在 profile 里的挂载形态（供 status / repair 输出）。
 * 用户报障时这三行就能区分"链接坏了"与"别的毛病"——不必再靠猜。
 * @returns {{localExists:boolean, exists:boolean, usable:boolean, kind:"missing"|"broken"|"linked"|"copy"|"no-local-copy"}}
 */
function describePluginLink(profileDir) {
  const nmPlugin = path.join(profileDir, "node_modules", PLUGIN_ID);
  const localDir = path.join(profileDir, PLUGIN_LOCAL_DIR);
  const localExists = fs.existsSync(path.join(localDir, "package.json"));
  if (!fs.existsSync(nmPlugin)) return { localExists, exists: false, usable: false, kind: localExists ? "missing" : "no-local-copy" };
  const usable = pluginLinkUsable(nmPlugin, localDir);
  let isLink = false;
  try { isLink = fs.lstatSync(nmPlugin).isSymbolicLink(); } catch { /* ignore */ }
  return { localExists, exists: true, usable, kind: usable ? (isLink ? "linked" : "copy") : "broken" };
}

/** package.json 写入 file: 依赖(让后续任何 pnpm/npm install 也认可该插件,不会删链接)。 */
function declarePluginDep(pkgFile) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.dependencies = pkg.dependencies || {};
  for (const id of PLUGIN_LEGACY_IDS) { delete pkg.dependencies[id]; }
  pkg.dependencies[PLUGIN_ID] = `file:./${PLUGIN_LOCAL_DIR}`;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}

/** 把 PLUGIN_ID 加入 dsh.profile.bundles（幂等；顺带移除历史名条目）。返回是否发生变更。 */
function ensureBundleEntry(pkgFile) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : null;
  if (bundles && bundles.includes(PLUGIN_ID)) {
    const hadLegacy = bundles.some((b) => PLUGIN_LEGACY_IDS.includes(b));
    if (hadLegacy) {
      pkg.dsh.profile.bundles = bundles.filter((b) => !PLUGIN_LEGACY_IDS.includes(b));
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
      return true;
    }
    return false;
  }
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = (bundles || []).filter((b) => !PLUGIN_LEGACY_IDS.includes(b) && b !== PLUGIN_ID);
  pkg.dsh.profile.bundles.push(PLUGIN_ID);
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

/** 从 dsh.profile.bundles 移除本插件（当前或历史名，幂等）。返回是否发生变更。 */
function removeBundleEntry(pkgFile) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : null;
  if (!bundles) return false;
  const filtered = bundles.filter((b) => !PLUGIN_ALL_IDS.includes(b));
  if (filtered.length === bundles.length) return false;
  pkg.dsh.profile.bundles = filtered;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  return true;
}

/**
 * 把我们手上这份插件包落到 profile 并激活（唯一激活点 = patch 行 → 热加载）。
 * 两条路径共用：① 无依赖或 file: 依赖（我们自己管源码）；② 市场装法但本地版本更新。
 * @returns {{hotPatch:boolean, changed:boolean, basePatch?:string}|undefined}
 */
function activateLocalCopy(profileDir, pkgFile, patchFile, pluginDir, patch, pkg, opts = {}) {
  const pluginLocalDir = copyPluginIntoProfile(profileDir, pluginDir);
  // forcePatch 由 ensurePatchActivation 内部处理（摘 bundles → 写 patch 行），
  // 这样不依赖调用顺序：源码既已换成本地这份，激活点就必须跟着改，否则装完仍看不到新版。

  const entryFile = path.join(pluginLocalDir, "lib", "index.js");
  if (!fs.existsSync(entryFile)) {
    console.error(`❌ 插件入口缺失：${entryFile}（本包不完整？请用官方源重装：npx --registry=https://registry.npmjs.org @mrrisega/dsh-remote@latest）`);
    process.exit(1);
  }
  // ⚠️ 顺序与"失败即中止"都是刻意的（0.6.7-beta.1 Windows 实测事故）：
  //   老代码把 ensurePluginLinked 的返回值丢掉、patch 照写、还打印「✅ 插件已就绪」，
  //   于是用户拿到的是**起不来的 dsh web**（cordis 按裸包名解析到空目录 → plugin tree failed to load，
  //   整个 dsh web 启动失败，而面板/插件市场都在那个进程里 → 用户没有任何自助修复入口）。
  //   现在：先挂载 → 独立验收 → 才写依赖与激活行；任何一步不过就中止，绝不留下坏 profile。
  try {
    ensurePluginLinked(profileDir, pluginLocalDir);   // node_modules 链接(name 才能被解析)
  } catch (e) {
    console.error(`❌ ${e.message}`);
    console.error("   已中止安装：继续写 patch 会让 dsh web 因插件树加载失败而完全无法启动。");
    console.error("   请把上面的错误整段反馈给作者（含平台 / 是否管理员 / 开发者模式是否开启）。");
    process.exit(1);
  }
  const probe = probePluginResolve(profileDir);
  if (!probe.ok) {
    console.error(`❌ 验收失败：dsh 无法从 profile 按裸包名解析 ${PLUGIN_ID}（${probe.reason}）`);
    console.error("   已中止安装（未写 patch）：否则 dsh web 会因插件树加载失败而完全无法启动。");
    process.exit(1);
  }
  declarePluginDep(pkgFile);                        // file: 依赖(包管理器 install 不误删)
  const r = ensurePatchActivation(patchFile, pluginLocalDir, pkgFile, { forcePatch: !!opts.forcePatch });
  if (r.ok) {
    console.log(`✅ 插件已就绪: ${pluginLocalDir}${opts.forcePatch ? "（激活点已转为 patch 行，装完即热加载）" : ""}`);
    return { hotPatch: true, changed: r.changed, basePatch: r.basePatch };
  }
  if (r.bundleOnly) {
    console.log("ℹ 该插件已由 dsh.profile.bundles 声明（保持单一激活点，不重复写入 patch 行）");
  } else {
    console.warn(`⚠️ 无法写入 patch 激活行（${r.reason}），改为 bundles 形态（需重启 dsh web 生效）`);
    ensureBundleEntry(pkgFile);
  }
  return { hotPatch: false, changed: true, basePatch: patch };
}

/**
 * 插件安装(pluginCmd 非卸载分支)收敛策略 —— 2026-09-06「重复 ID 崩溃」根治；
 * 2026-09 插件由 dsh-remote-ui 更名 dsh-remote-web，本函数同时兼容清理旧名残留。
 *
 * ⚠️ 2026-09-13 调整:「恰好一处激活」仍然成立,但**激活点二选一**:
 *   · dsh-setup 安装(file: 依赖 + 自建 node_modules 链接)→ 激活点 = 用户级 cordis.patch.yml
 *     的一行 insert。理由:harness 的 web profile 是 `patchReload: "live"`,会加载
 *     `@deepseek-ai/cordis-plugin-hmr` 监听该文件,**存盘后约 1 秒重新 compose 并动态装载**,
 *     用户不需要重启 dsh web(只需刷新页面拿到浏览器半)。插件市场自己也是这套机制。
 *   · 插件市场安装(github:/npm: 依赖,源码归市场管)→ 激活点 = dsh.profile.bundles
 *     (插件自带 bundle patch)。bundles 只在启动时读、没有 watcher,所以这一路仍需重启。
 * 两条路都**只保留一个激活点**:写 patch 就同时从 bundles 移除,反之清掉 include,
 * 绝不两处并存(那正是历史上 dsh web 启动即报「重复 ID」崩溃的原因)。
 */

/** 读取 profile 内已安装插件的版本（市场/包管理器装法）。 */
function readInstalledPluginVersion(profileDir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, "node_modules", name, "package.json"), "utf8")).version;
  } catch { return null; }
}

/**
 * 识别 profile 用哪个包管理器（市场装法「一键更新」要用它改源码）。
 *
 * ⚠️ 不能用 `sh("command -v pnpm && echo pnpm || echo npm")`：`sh()` 走 execSync，
 * Windows 下是 cmd.exe，而 `command` 是 POSIX 内建 → 永远命中 `||` 分支，
 * **Windows 上永远选 npm**。而 dsh profile 是 pnpm 管理的（pnpm-workspace.yaml + 虚拟 store），
 * 用 npm 去改同一个 node_modules 会写出与 pnpm 不同的布局（污染/冲突风险）。
 * 现在：先用**声明文件**判断（最可靠、零子进程），再用 where/which 探测可执行文件；
 * 兜底选 pnpm 而不是 npm —— dsh profile 默认就是 pnpm，选错方向的代价不对称。
 */
function detectPackageManager(profileDir) {
  try {
    if (fs.existsSync(path.join(profileDir, "pnpm-lock.yaml"))
      || fs.existsSync(path.join(profileDir, "pnpm-workspace.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(profileDir, "package-lock.json"))) return "npm";
  } catch { /* 读不到就往下探测 */ }
  const has = (bin) => {
    try {
      return process.platform === "win32"
        ? spawnSync("where", [bin], { stdio: "ignore", windowsHide: true }).status === 0
        : spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
    } catch { return false; }
  };
  if (has("pnpm")) return "pnpm";
  if (has("npm")) return "npm";
  return "pnpm";
}

/**
 * 市场装法下把插件包升到最新。
 *
 * 2026-09-13 实测的坑：用户在插件面板点「一键更新」时，本函数原先的调用方（marketManaged 分支）
 * 只清 include、不动源码，日志写着"已保持市场管理的源码不变"，命令 exit 0、界面显示"安装完成"，
 * 但插件包始终停在旧版本 —— 用户看到的就是"一键更新到不了最新版"。
 *
 * 规格判断：registry 规格（^0.6.3 / 0.6.3 / >=…）用 `add <name>@latest`；
 * github:/git+/file:/https: 之类用 `update <name>` 让包管理器重新解析引用（例如 git HEAD）。
 */
function upgradeMarketManagedPlugin(profileDir, name, dep) {
  const spec = String(dep ?? "").trim();
  const isRegistryRange = /^[\^~><=v\d]/.test(spec);
  const pm = detectPackageManager(profileDir);
  const args = isRegistryRange ? `add ${name}@latest` : `update ${name}`;
  const cmd = `${pm} ${args}`;
  const r = sh(cmd, 180000, profileDir);
  if (!r.ok) console.warn(`⚠️ ${cmd} 失败：${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" / ")}`);
  return { ok: r.ok, cmd };
}

function convergePluginActivation(profileDir, pkgFile, patchFile, pluginDir, patch) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const legacyDep = PLUGIN_LEGACY_IDS.map((id) => pkg.dependencies && pkg.dependencies[id]).find((v) => v !== undefined);
  const dep = (pkg.dependencies && pkg.dependencies[PLUGIN_ID]) ?? legacyDep;
  const inBundles = !!(pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    && pkg.dsh.profile.bundles.some((b) => PLUGIN_ALL_IDS.includes(b)));
  const marketManaged = dep && !String(dep).startsWith("file:"); // github:/npm: 等由市场/包管理器管源码
  const managedByUs = !dep || String(dep).startsWith("file:");   // 无依赖或 file: 拷贝 → 我们管

  if (marketManaged && inBundles) {
    // 插件市场安装形态：源码归市场/包管理器管 → 只清历史 include，但**必须主动升级到最新**，
    // 否则「一键更新」会报成功却什么都没做（2026-09-13 实测）。
    stripIncludeEntries(patchFile, patch, "插件市场安装形态无需用户 include");
    const depName = PLUGIN_ALL_IDS.find((id) => pkg.dependencies && pkg.dependencies[id] !== undefined) || PLUGIN_ID;
    const before = readInstalledPluginVersion(profileDir, depName);
    // ⚠️ 关键：装置器**手上这份包的版本**才是权威（用户跑的就是它）。
    // 以前这里无条件"去 npm 装 market 渠道的最新版"，于是本地跑 0.6.6-beta.2 时，
    // profile 里市场装的 0.6.5 被判成"已是最新"→ 什么都不做（测试自己就踩到：
    // 「✅ 插件包已是市场最新版（0.6.5）」，明明带的是 beta）。
    // 现在：本地严格更新 → 直接落本地包（顺带把激活点换成 patch 行，拿到热加载）；
    // 相等 → 不做；本地更旧 → 不动（绝不降级）。
    const localVer = pkgVersion();
    const cmpLocal = compareVersionStrings(localVer, before);
    if (cmpLocal !== null && cmpLocal > 0) {
      console.log(`ℹ 本地包更新（${before ?? "未装"} → ${localVer}），落本地版本并改用热加载激活…`);
      return activateLocalCopy(profileDir, pkgFile, patchFile, pluginDir, patch, pkg, { forcePatch: true });
    }
    if (cmpLocal !== null && cmpLocal < 0) {
      console.log(`ℹ profile 里已是更新版本（${before} > ${localVer}），保持不动（不降级）。`);
      return;
    }
    console.log(`ℹ 插件市场安装形态（bundles+dependency）：源码归包管理器管，正在升级到最新…（安装前 ${before ?? "未知"}）`);
    const { ok, cmd } = upgradeMarketManagedPlugin(profileDir, depName, dep);
    const after = readInstalledPluginVersion(profileDir, depName);
    if (ok && after && after !== before) {
      console.log(`✅ 插件包已升级：${before ?? "?"} → ${after}`);
      console.log("   该形态经 dsh.profile.bundles 激活，只在启动时读取 —— 请重启 dsh web 生效。");
    } else if (ok && after) {
      console.log(`✅ 插件包已是市场最新版（${after}）。`);
      console.log("   若面板仍显示旧版本，请重启 dsh web（bundles 只在启动时读取）。");
    } else {
      console.log(`⚠️ 插件包升级未成功（当前 ${after ?? "未知"}）。可手动执行：`);
      console.log(`   cd ${profileDir} && ${cmd}`);
    }
    return;
  }

  // 源码归我们（无依赖或 file: 依赖）→ 必然用本地这份，激活点也必须是 patch 行（热加载）。
  if (managedByUs) return activateLocalCopy(profileDir, pkgFile, patchFile, pluginDir, patch, pkg, { forcePatch: true });


  // 异常形态：有非 file: 依赖但不在 bundles（无法靠 bundle patch 激活）
  console.log(`ℹ 检测到依赖 ${PLUGIN_ID}(${dep}) 但未声明在 dsh.profile.bundles——插件不会激活。`);
  console.log("   请在 dsh 插件市场重新添加该插件，或先执行 `dsh-remote plugin --uninstall` 再一键安装。");
}

async function pluginCmd(argv) {
  const uninstall = hasFlag(argv, "--uninstall");
  const profileDir = resolveProfileDir(argv);
  const pkgFile = path.join(profileDir, "package.json");
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  const pluginDir = path.join(THIS_DIR, "packages", PLUGIN_ID);

  if (!fs.existsSync(pkgFile) || !fs.existsSync(patchFile)) {
    console.error(`❌ 未找到 dsh web profile（${profileDir}）。`);
    console.error("   请先安装 DeepSeek Harness（npx @deepseek-ai/dsh web）并初始化默认 profile。");
    process.exit(1);
  }
  if (!fs.existsSync(pluginDir)) {
    console.error(`❌ 本包缺少 packages/${PLUGIN_ID}（${pluginDir}）。`);
    process.exit(1);
  }

  const patch = fs.readFileSync(patchFile, "utf8");

  if (uninstall) {
    // 移除 patch 中的插件条目（兼容旧版无标记条目；旧名 dsh-remote-ui 一并清理）
    // 用原子写回:卸载同样不能在 profile 配置上留下半截文件
    if (!stripIncludeEntries(patchFile, patch, "卸载清理")) {
      console.log(`ℹ patch 中未发现 ${PLUGIN_ID}（或历史名）条目。`);
    }
    // 清理本地目录与链接：当前名 + 历史名(dsh-remote-ui-plugin / node_modules/dsh-remote-ui)
    for (const id of PLUGIN_ALL_IDS) {
      fs.rmSync(path.join(profileDir, `${id}-plugin`), { recursive: true, force: true });
      fs.rmSync(path.join(profileDir, "node_modules", id), { recursive: true, force: true });
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      let removed = false;
      for (const id of PLUGIN_ALL_IDS) {
        if (pkg.dependencies && pkg.dependencies[id] !== undefined) { delete pkg.dependencies[id]; removed = true; }
      }
      if (removed) fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
    } catch { /* ignore */ }
    // 同步移除 bundles 声明，避免“bundles 引用已删除包 → dsh web 启动报错”
    try {
      if (removeBundleEntry(pkgFile)) console.log(`✅ 已从 dsh.profile.bundles 移除 ${PLUGIN_ID}`);
    } catch { /* ignore */ }
    console.log("✅ 卸载完成。重启 dsh web 生效。");
    return;
  }

  // 安装：收敛到"恰好一处激活"（热挂载 patch 行 或 bundles，二选一），绝不与市场/历史 include 并存
  //
  // ⚠️ 必须 **return 结果**：setup() 依赖它判断激活形态(false/undefined = 走 bundles,需重启),
  // 少了这个 return,安装后就不会去验证热挂载,白白多报一次"需要重启"(实测踩到)。
  return convergePluginActivation(profileDir, pkgFile, patchFile, pluginDir, patch);

  // 引导语只在 setup 汇总里打印一次(这里不再重复;单独跑 `dsh-remote plugin` 也无需引导)
}

/**
 * 打印插件挂载诊断三行（供 status / repair 共用）。
 * 用户报障时这三行就能区分「链接坏了」与「别的毛病」，不必靠猜：
 *   link = 有没有真挂上（junction / 符号链接 / 整目录拷贝 / BROKEN）
 *   resolve = dsh 的裸包名解析能不能走通（浏览器半注入面板就靠它）
 *   client = dsh.client.platform 声明在不在
 */
function printPluginDiagnostics(profileDir) {
  const nmPlugin = path.join(profileDir, "node_modules", PLUGIN_ID);
  const link = describePluginLink(profileDir);
  const probe = probePluginResolve(profileDir);
  const kindText = { linked: "已挂载（链接）", copy: "已挂载（整目录拷贝）", broken: "BROKEN（存在但读不到内容）", missing: "缺失", "no-local-copy": "缺失（本地插件目录也没有）" }[link.kind] || link.kind;
  console.log(`   [link]    ${nmPlugin}\n             → ${kindText}`);
  console.log(`   [resolve] ${PLUGIN_ID}/package.json → ${probe.ok ? probe.pkgPath : `失败（${probe.reason}）`}`);
  console.log(`   [client]  dsh.client.platform = ${probe.ok ? (probe.clientPlatform || "缺失") : "（解析失败，无法确认）"}`);
  return { link, probe };
}

/**
 * `dsh-remote repair` —— 只修 profile 里的插件挂载，不碰运行环境 / 不联网 / 不碰自启动。
 *
 * 为什么需要这个独立入口：插件挂载坏掉时 dsh web **整个起不来**（cordis 插件树加载失败），
 * 而设置面板与插件市场都在那个进程里 —— 用户没有任何自助修复入口，只剩命令行。
 * 执行顺序刻意是"先保命、再修复、最后恢复激活"：
 *   ① patch 里引用了本插件但挂载不可用 → **先把 include 摘掉**（profile 立刻恢复可启动）；
 *   ② 再重建挂载（失败会抛错，但①的结果保留 → 用户至少能打开 dsh web）；
 *   ③ 只有①②都成功，才把激活行写回去。
 */
function repairProfile(argv = []) {
  const profileDir = resolveProfileDir(argv);
  const pkgFile = path.join(profileDir, "package.json");
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  const localDir = path.join(profileDir, PLUGIN_LOCAL_DIR);
  if (!fs.existsSync(pkgFile) || !fs.existsSync(patchFile)) {
    console.error(`❌ 未找到 dsh web profile（${profileDir}）。`);
    console.error("   先确认 dsh web 装好并初始化过 profile，或用 --profile <目录> 指定。");
    process.exit(1);
  }
  console.log(`dsh-remote repair — ${profileDir}`);
  const before = printPluginDiagnostics(profileDir);
  if (!before.link.localExists) {
    console.error(`❌ 本地插件目录缺失（${localDir}）：无法就地修复。`);
    console.error("   请重新安装：npx @mrrisega/dsh-remote@latest");
    process.exit(1);
  }

  const patch = fs.readFileSync(patchFile, "utf8");
  const referenced = parsePatchInsertIds(patch).ids.some((id) => PLUGIN_ALL_IDS.includes(id));
  if (referenced && !before.link.usable) {
    // 保命动作：先摘掉激活行，让 dsh web 至少能启动（此时插件不可用，但用户进得去、能重装）
    stripIncludeEntries(patchFile, patch, "挂载不可用，先摘掉 include 保命");
    try { removeBundleEntry(pkgFile); } catch { /* ignore */ }
    console.log("🛟 挂载不可用 → 已先摘掉插件激活行（dsh web 现在应该能启动了）。");
  }

  try {
    ensurePluginLinked(profileDir, localDir);
  } catch (e) {
    console.error(`❌ 重建挂载失败：${e.message}`);
    console.error("   profile 已处于「能启动、插件未激活」状态；请把上面错误反馈给作者。");
    process.exit(1);
  }
  const after = printPluginDiagnostics(profileDir);
  if (!after.probe.ok) {
    console.error("❌ 挂载已重建，但 dsh 仍解析不到本插件 —— 请把上面的输出反馈给作者。");
    process.exit(1);
  }
  const srcPluginDir = path.join(THIS_DIR, "packages", PLUGIN_ID);
  if (!fs.existsSync(srcPluginDir)) {
    console.error(`❌ 本包缺少 packages/${PLUGIN_ID}，无法就地恢复激活行。`);
    console.error("   请重新安装：npx @mrrisega/dsh-remote@latest");
    process.exit(1);
  }
  convergePluginActivation(profileDir, pkgFile, patchFile, srcPluginDir, fs.readFileSync(patchFile, "utf8"));
  console.log("✅ 挂载与激活已修复 —— 重启一次 dsh web 生效。");
}

// ---------- main ----------
// 无命令名（或首个参数以 - 开头）时默认执行 setup —— 这样 `dsh-remote --no-autostart`
// 这类「只给 flag」的用法才能装上去。
//
// 但有两个例外必须挡在前面：
//   ① -h/--help：用户想先看用法,绝不该顺手把东西装上(此前会走 setup,直接安装);
//   ② 不认识的 flag：拼错参数时静默安装比报错更糟,宁可停下来说清楚。
const raw = process.argv[2];
const cmd = raw && !raw.startsWith("-") ? raw : "setup";
const args = raw && !raw.startsWith("-") ? process.argv.slice(3) : process.argv.slice(2);
if (cmd === "setup" || cmd === "install") await setup(args);
else if (cmd === "settings") settingsHint();
else if (cmd === "run") await runBridge();
else if (cmd === "plugin") await pluginCmd(process.argv.slice(3));
else if (cmd === "repair") repairProfile(process.argv.slice(3));
else if (cmd === "status") {
  const cfg = loadConfig();
  const local = Boolean(cfg.local_key);
  console.log("配置文件:", CONFIG_PATH);
  console.log("连接模式:", local ? `自建服务（${cfg.tunnel_url || "未设置服务器地址"}）` : `SaaS 云端服务（${cfg.phone || "未配置账号"}）`);
  console.log("API:", cfg.api_url || (local ? "（自建模式无需账号 API）" : DEFAULT_API));
  console.log("远程地址/登录: 打开 dsh web → 设置 → 「远程控制」查看与操作");
  // 插件挂载诊断：报障时一眼看出是"链接坏了"还是"别的毛病"
  const profileDir = resolveProfileDir([]);
  if (fs.existsSync(path.join(profileDir, "package.json"))) {
    console.log("插件挂载:");
    printPluginDiagnostics(profileDir);
  } else {
    console.log(`插件挂载: 未找到 profile（${profileDir}）`);
  }
} else {
  printHelp();
  process.exit(1);
}

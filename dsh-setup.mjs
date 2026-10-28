#!/usr/bin/env node
/**
 * dsh-remote — 一键安装 + 配置 + 自启动（电脑端）
 *
 * 用法:
 *   dsh-remote [setup] [选项]                 一键安装（默认命令，无需任何参数）
 *   dsh-remote settings                        提示如何登录（独立设置页已移除，见 dsh web 面板）
 *   dsh-remote run                             前台运行 bridge（调试/守护）
 *   dsh-remote status                          查看配置与服务状态
 *   dsh-remote plugin [--uninstall]            手动安装/卸载 dsh web 远程访问插件
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
 *   3. 自动把远程访问插件装进 dsh web 设置页（若检测到 profile）
 *   4. 登录/连接配置在 dsh web → 设置 → 「远程访问」面板完成（SaaS 注册登录 / 自建切换）
 *      自建 CLI 用户也可用 `dsh-remote setup --server … --key …`（无需再打开设置页）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childStopped, stopChildGracefully } from "./clients/dsh-remote/src/lifecycle.mjs";
import { discoverUpstream, resolveUpstreamHint, FALLBACK_UPSTREAM } from "./clients/dsh-remote/upstream-discovery.mjs";
import { normalizeRefCode, applyRefCodeToConfig } from "./clients/dsh-remote/src/channel-ref.mjs";

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
// DSH_RELAY_DEFAULT_API 可覆盖（测试脚本指向本地死端口，避免兜底路径打到生产）。
const DEFAULT_API = String(process.env.DSH_RELAY_DEFAULT_API || "").trim()
  || "https://n.risegao.cn:13443/relay-api";
const DEFAULT_APP_URL = "https://n.risegao.cn:13443/app/";
const REPO_URL = "https://github.com/mrRisega/dsh-remote";

// ---------- 平台（0.6.7 起支持 Windows） ----------
/**
 * 有效平台：`DSH_SETUP_PLATFORM` 可覆盖（**只用于测试**，让 win32 分支能在 macOS/Linux 上被
 * 行为级跑一遍；生产不设置 → 与 `process.platform` 完全一致，行为不变）。
 *
 * 为什么值得开这个口子：Windows 的进程发现 / 自检扫描在开发机上根本跑不到，而它们恰恰是
 * 最贵的一类 bug —— 2026-10 那次「活着的 bridge 被判成没运行 → 反复 taskkill → bridge_wedged」
 * 里，win32 的两条扫描分支（`Name='node.exe'` 过滤 + doctor 的 tasklist 无命令行）**从来没被真正执行过**。
 */
const SETUP_PLATFORM = String(process.env.DSH_SETUP_PLATFORM || process.platform).toLowerCase();
const IS_WIN = SETUP_PLATFORM === "win32";
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
/**
 * C2 互踢根治：bridge 判定"本机已有同 deviceId 的另一个 bridge"时的退出码（必须与
 * dsh-bridge.mjs 里的 DUPLICATE_INSTANCE_EXIT_CODE 一致），以及 watcher 收到它之后的暂停时长。
 *
 * 为什么 watcher 要暂停而不是照常 10s 重拉：互踢的本质是"两个实例抢同一个 deviceId"，
 * 重拉的唯一效果是**把对方也顶掉**（对方同样重连），形成 2~3.5s 周期的乒乓（生产日志实测
 * dev-a50dced9cc19 327 次/10min）。本机已有实例在跑时，让位才是对的；5 分钟后若对方已经
 * 退出（用户重装/升级收尾），本守护自然恢复。
 */
const DUPLICATE_INSTANCE_EXIT_CODE = 4;
const DUPLICATE_BRIDGE_BACKOFF_MS = 5 * 60 * 1000;
/**
 * 设备绑定「永久性失败」的退避（契约 docs/device-overquota-lock-contract.md §6.3/§6.4）。
 *
 * bridge 遇到服务端 `device_bind_cap`（防滥用硬上限）会写 `.bind-error.json` 并以**专用退出码 5**
 * 退出：这是永久性失败 —— 用户不去手机端解绑就不会好。旧逻辑与普通失败共用 exit(1)，
 * watcher 于是每 10s 拉起一次、每 10s 撞一次 409（日志刷屏、白耗一次 device-login 额度）。
 * 现在按 10s→1min→5min→15min 指数退避（封顶 30min）；`.bind-error.json` 的**内容签名**变化
 * （换账号 / 解绑后重试得到了不同结论 / 提示被清掉）时复位，用户处理完不必等满退避窗口。
 */
const DEVICE_BIND_CAP_EXIT_CODE = 5;
const BIND_CAP_BACKOFF_MS = [10_000, 60_000, 300_000, 900_000];
const BIND_CAP_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** bridge 写的「设备登记失败提示」（面板读它展示原因；watcher 用它的签名判断是否需要复位退避）。 */
const BIND_ERROR_FILE = path.join(CONFIG_DIR, ".bind-error.json");

/**
 * `.bind-error.json` 的稳定签名：只取 code/device_id/message，**不含 at** ——
 * bridge 每次重试都会刷新 at，拿它当变化依据等于"永远变化"，退避会形同虚设。
 */
function bindErrorSignature() {
  try {
    const j = JSON.parse(fs.readFileSync(BIND_ERROR_FILE, "utf8")) || {};
    return [j.code || "", j.device_id || "", j.message || ""].join("|");
  } catch { return ""; }
}

/** 第 step 次（从 1 开始）退出码 5 后的退避时长：10s→1min→5min→15min，之后翻倍到封顶 30min。 */
function bindCapBackoffMs(step) {
  const list = BIND_CAP_BACKOFF_MS;
  const n = Math.max(1, Number(step) || 1);
  if (n <= list.length) return Math.min(BIND_CAP_BACKOFF_MAX_MS, list[n - 1]);
  return BIND_CAP_BACKOFF_MAX_MS;
}

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

/**
 * 同步运行时文件时一并覆盖的客户端脚本（bridge 会把这些直接发给手机/桌面，必须与装置器一致）。
 * ⚠️ `src/lifecycle.mjs` 也在表里：本安装器**自己**import 它（进程优雅停机的共用实现），
 * 漏同步就会出现「入口脚本在、依赖不在」的半装运行时（插件半据此判定「运行环境已就绪」，
 * 却永远起不来 bridge —— 2026-09-23 用户反馈的现场）。`src/channel-ref.mjs` 同理（本安装器也 import）。
 */
const RUNTIME_CLIENT_FILES = ["mobile-adapter.mjs", "dsh-bridge.mjs", "e2ee-shim.mjs", "e2ee-client.mjs", "e2ee-shim-script.js", "mobile-adapter.test.mjs", "wechat-channel.mjs", "dsh-events.mjs", "wechat-runtime.mjs", "src/lifecycle.mjs", "src/channel-ref.mjs"];

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
  dsh-remote plugin       手动安装 dsh web 远程访问插件（--uninstall 卸载）
  dsh-remote repair       修复插件挂载（dsh web 起不来时用；只碰 profile，不联网）
  dsh-remote doctor       一条命令自检「为什么连不上」（只读；含上游/进程/微信/日志尾部）
  dsh-remote --help       显示本用法（等同 dsh-remote help）

目标 profile（默认：**本机 Web 版 + 桌面端一起装**）:
  不带 --profile 时，会把插件装进本机**已有的** Web 版与桌面端 profile（谁在用就装给谁，
  避免"命令跑完了、桌面端却没有面板"这类装错地方的坑）；机器上的实验/自动化 profile 不会被动。
  dsh-remote --profile desktop    只装进 DeepSeek Harness **桌面端**
                                  （~/.dsh/profiles/desktop）
  dsh-remote --profile web        只装进 Web 版
  桌面端也可以在应用内「插件」页直接安装 dsh-remote-web —— 那是官方路径，也最省事。
  ⚠️ 桌面端与 Web 版共享 ~/.dsh（会话/设置/凭据），但**插件互相隔离**，两边要各自安装。

自建模式（可选）:
  dsh-remote setup --server wss://你的域名:端口 --key 访问密钥

可选参数:
  --ref <标识>    指定接入标识（可选，用于路由/灰度分组）

登录/连接配置: 打开 dsh web → 设置 → 「远程访问」→ 注册或登录手机号即可
（自建用户切「自建服务」标签或直接用上方 setup 命令，无需另开页面）。
文档: ${REPO_URL}
`);
}

// 认识的参数（只给 flag 也要能装上去，所以不认识时才拦）。
const KNOWN_FLAGS = new Set([
  "--api", "--server", "--key", "--profile", "--ref",
  "--no-autostart", "--no-plugin", "--no-restart", "--uninstall", "--force"
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
// `doctor` 承诺"只读"：它连运行时脚本同步都不做 —— 否则"自检"会先往用户磁盘写 9 个文件，
// 与承诺不符（也会把"我什么都没改却多了文件"变成新的困惑）。
if (process.argv[2] !== "doctor") {
  try { ensureRuntimeCopy(); } catch (e) { console.warn(`⚠️ 运行时固化跳过: ${e.message}`); }
}

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
    // windowsHide：POSIX 上被忽略；Windows 上避免 execSync 经 cmd.exe 执行控制台程序时闪窗/弹窗。
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, windowsHide: true, ...(cwd ? { cwd } : {}) });
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

/**
 * 宿主是否跑在 **Electron 的 Node 模式**下（DeepSeek Harness 桌面端的 Host 就是）。
 *
 * 桌面端 `process.execPath` 是 **Electron 应用二进制**而不是 node：不带
 * `ELECTRON_RUN_AS_NODE=1` 直接拿它跑脚本，得到的不是「跑脚本的 node」，而是
 * **又启动一个桌面端应用实例**。自启动服务是系统在应用退出后拉起的，踩到这里
 * 的表现是「服务登记成功、进程秒退、bridge 永远起不来」，与 0.6.15 那次端口故障
 * 一样难排查 —— 所以必须在**写服务定义时**就把变量带上。
 */
const IS_ELECTRON_HOST = Boolean(process.versions && process.versions.electron);

/**
 * DeepSeek Harness **桌面端自带 Node** 的稳定落点候选。
 *
 * 为什么需要：桌面端主打的正是**机器上没有系统 node** 的用户；而自启动服务要活过
 * 桌面端的退出、甚至升级/重装（`.app` 路径会变、可能被换掉）。桌面端把自带运行时装在
 * **用户目录** `~/.dsh/dsh-runtimes/…`，它不随应用包更新而移动 —— 所以只要它存在，
 * 就该优先于任何指向 `.app` 内部的路径。
 *
 * 目录布局随桌面端版本演进（可能多套一层 runtime/node），故按多个候选探测；
 * `resolveExecutable()` 会过滤掉不存在的路径，多列无害。
 * @returns {string[]} 候选可执行文件绝对路径（可能都不存在）。
 */
function desktopRuntimeNodeCandidates() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "node.exe" : "node";
  const out = [];
  // ① 稳定落点：装在**用户目录**，桌面端升级/重装都不动它。
  //    ⚠️ 真实布局是 `dependencies/node/bin/<exe>`（2026-10-07 拆官方 0.2.0-rc.2 DMG 实测：
  //    `…/Resources/runtime/primary-runtime/dependencies/node/bin/node` → Node v24.21.0）。
  //    其余几个是兼容不同版本的兜底；resolveExecutable() 会过滤掉不存在的路径，多列无害。
  const roots = [
    process.env.DSH_DESKTOP_RUNTIME_DIR || "",
    path.join(os.homedir(), ".dsh", "dsh-runtimes", "dsh-primary-runtime"),
    path.join(os.homedir(), ".dsh", "dsh-runtimes", "primary-runtime"),
  ].filter(Boolean);
  for (const root of roots) {
    out.push(
      path.join(root, "dependencies", "node", "bin", exe),
      path.join(root, "bin", exe),
      path.join(root, "node", "bin", exe),
      path.join(root, "runtime", "bin", exe),
    );
  }
  // ② 应用自己把自带 node 的路径交给子进程（其 `runtime/bin/node` shim 就是靠这个变量）——
  //    平台无关，且是"应用自己说的"，比我们猜路径可靠。
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) out.push(process.env.DSH_DESKTOP_NODE_EXECUTABLE);
  // ③ 最后才是指向应用包内部的绝对路径：它是**真实存在的 node**，但会随桌面端更新换路径，
  //    所以排在稳定落点之后（自启动服务登记它属于"聊胜于无"，好过登记 Electron 本体）。
  if (isWin) {
    const local = process.env.LOCALAPPDATA || "";
    if (local) out.push(path.join(local, "Programs", "DeepSeek Harness", "resources", "runtime", "primary-runtime", "dependencies", "node", exe));
  } else {
    out.push(
      "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node",
      "/Applications/DSH Desktop.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node",
    );
  }
  return out;
}

function preferredNode() {
  // 先归一化"自己的可执行文件"，用来判断最终选中的解释器是否就是 Electron 本体。
  const selfReal = resolveExecutable(process.execPath) || process.execPath;
  const candidates = [
    process.env.DSH_SETUP_NODE20 || "",
    process.env.DSH_SETUP_NODE || "",
    // 桌面端（Electron 宿主）：**真实 node 优先**。服务要活过桌面应用的退出与更新
    //（.app 路径会变、可能被换掉），登记一个真实 node 才稳；找不到才回落 Electron 自身，
    // 那时由 SERVICE_NODE_ENV 补上 ELECTRON_RUN_AS_NODE=1 把它变成 node。
    ...(IS_ELECTRON_HOST
      ? [
          // 桌面端自带 Node 的**稳定**落点：装在用户目录（~/.dsh/dsh-runtimes/…），
          // 桌面端升级/重装都不动它 —— 比 .app 内部路径更该登记进自启动服务。
          ...desktopRuntimeNodeCandidates(),
          "/opt/homebrew/opt/node@20/bin/node", "/usr/local/opt/node@20/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node",
        ]
      : []),
    process.execPath
  ].filter(Boolean);
  for (const p of candidates) {
    const real = resolveExecutable(p);
    if (real) return { bin: real, electron: IS_ELECTRON_HOST && real === selfReal };
  }
  return { bin: process.execPath, electron: IS_ELECTRON_HOST };
}
const INTERPRETER = preferredNode();
const NODE_BIN = INTERPRETER.bin;
/** 解释器是 Electron 二进制时必须注入的变量（真实 node 时为空对象，行为与本改动前一致）。 */
const SERVICE_NODE_ENV = INTERPRETER.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
/** plist `EnvironmentVariables` 里追加的条目（真实 node 时为空串 → 模板逐字节不变）。 */
const SERVICE_NODE_ENV_PLIST = Object.entries(SERVICE_NODE_ENV)
  .map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("");
/** systemd unit 里追加的 `Environment=` 行（真实 node 时为空串 → 模板逐字节不变）。 */
const SERVICE_NODE_ENV_UNIT = Object.entries(SERVICE_NODE_ENV)
  .map(([k, v]) => `Environment=${k}=${v}\n`).join("");
/**
 * 供**子进程 spawn** 用的环境（继承当前环境 + 解释器变量）。
 * 本文件里凡是用 NODE_BIN 拉起子进程的地方都要带上它。
 */
function nodeEnv(extra) {
  return { ...process.env, ...SERVICE_NODE_ENV, ...(extra || {}) };
}

/**
 * 自启动服务里注入的 PATH。
 * 必须含 /usr/sbin 与 /sbin:bridge 会用 ioreg 之类系统命令探测本机信息,
 * 缺少这两个目录时 launchd 服务日志里会刷 `ioreg: command not found`(用户反馈实测)。
 */
const SERVICE_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// ---------- 安装约定（随 bridge 环境变量注入；服务端存到设备行，用于区分安装来源） ----------
/**
 * install_source：本文件即「一键安装器」→ 默认 npx（用户自己跑 `npx @mrrisega/dsh-remote` 的那条路径）。
 * 插件市场那条路径由插件半自愈补装：插件 spawn 本安装器时显式传入
 * DSH_BRIDGE_INSTALL_SOURCE=plugin_market，这里原样透传（外部注入 > 硬编码默认）。
 * install_version：优先取外部注入（插件/在线更新器），否则取本包 package.json 版本。
 * harness_version：**只能由外部注入** —— 宿主（DeepSeek Harness）版本要从宿主进程的 argv /
 *   安装目录推出来，而安装器是独立进程，推不出来。插件会在宿主进程内问出来再传进来；
 *   用户直接跑 `npx @mrrisega/dsh-remote` 时没有这个值 → 留空（= 未上报，绝不猜一个错的）。
 */
const INSTALL_SOURCE = String(process.env.DSH_BRIDGE_INSTALL_SOURCE || "").trim() || "npx";
const INSTALL_VERSION = String(process.env.DSH_BRIDGE_INSTALL_VERSION || "").trim() || pkgVersion();
const HARNESS_VERSION = String(process.env.DSH_BRIDGE_HARNESS_VERSION || "").trim();

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

// ---------- 配置读写 ----------
/** 配置读失败只报一次（每 10s 一轮的 ensureBridge 会把同一行刷成噪音）。 */
let configReadWarned = false;
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    // ⚠️ 静默返回 {} 是历史行为（首次安装时文件确实不存在）。但**读失败不能与"没登录"混淆**：
    // 配置文件存在却读不出来（杀软占用 / OneDrive 同步中 / EPERM / 半写）时，指纹会瞬间变成
    // `saas|||`，旧逻辑据此按"账号变了"停掉 bridge → 下一轮再拉起 → 反复重启（诊断报告 04 §4.3）。
    // 这里只补"可观测"（写一次原因），重启抑制由 accountFingerprint 的连续确认负责。
    if (e && e.code !== "ENOENT" && !configReadWarned) {
      configReadWarned = true;
      console.warn(`⚠️ 读取配置失败（${e.code || e.message}）：${CONFIG_PATH} —— 本轮按空配置处理，但不据此重启 bridge。`);
    }
    return {};
  }
}
/**
 * 保存配置。
 *
 * 【C8 原子写】旧实现是"先截断再写"（writeFileSync 直接覆盖）：saas 模式**每 10 秒**重写一次，
 * 而插件半（设置页/切账号/备份）也在写同一个文件 —— Windows 上被杀软扫描/OneDrive 同步放大成
 * "读到半截 JSON" → loadConfig 静默 {} → 指纹抖动 → bridge 反复重启。
 *
 * 现在写成 `<config>.<pid>.tmp` 再 rename 覆盖（rename 在同一目录内是原子的）：
 * 读的一方要么看到旧内容、要么看到新内容，永远读不到半截。
 * 失败安全：Windows 上目标文件被杀软/备份工具持有句柄时 rename 可能 EBUSY/EPERM ——
 * 先短暂重试，仍失败就退回直接写（宁可丢原子性，也绝不写不进去把配置搞丢）。
 */
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = JSON.stringify(cfg, null, 2);
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    for (let i = 0; i < 3 && !renamed; i += 1) {
      try { fs.renameSync(tmp, CONFIG_PATH); renamed = true; }
      catch (e) { if (i === 2) throw e; sleepSync(30); }
    }
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉不致命 */ }
    fs.writeFileSync(CONFIG_PATH, body, { mode: 0o600 }); // 兜底：绝不让保存失败
  }
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

/**
 * 运行期留痕：写/删 pid 文件这类"非关键"动作失败时**必须留一行**（追加到安装日志）。
 *
 * 为什么不再静默 `catch {}`：pid 文件是插件半发现进程的唯一入口（Windows 无 pgrep/ps）。
 * 它一旦"莫名消失"，现场能看到的只有「bridge 未运行」——而**为什么**消失（EBUSY / 杀软 /
 * 权限 / 并发截断）一点线索都没有。2026-10 那次排查里，这一层缺失直接把方向带偏。
 * 日志本身写失败也不得影响业务（磁盘满/目录不可写 → 静默放弃）。
 */
function logSetupIssue(line) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(path.join(CONFIG_DIR, ".dsh-setup-install.log"),
      `\n[${new Date().toISOString()}] [dsh-setup] ${line}\n`);
  } catch { /* 日志失败不得影响业务 */ }
}

/** 写 pid 文件（Windows 进程发现用；失败不致命，插件半还有 PowerShell 兜底扫描，但必须留痕）。 */
function writePidFile(name, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONFIG_DIR, name), String(pid));
  } catch (e) {
    logSetupIssue(`写 pid 文件失败（${name}，pid=${pid}）：${e && (e.code || e.message)}`);
  }
}

/**
 * 删除 pid 文件。
 *
 * `expectPid`：**只在文件内容等于它时才删**（不传 = 旧语义「无条件删」，仅留给确实要清理
 * 整份残留的场景；本文件 `run()` 里的所有调用点都必须传）。
 *
 * 为什么必须校验归属：pid 文件是"谁持有谁负责"的：父进程无条件删会把**别的实例（或孤儿）**
 * 的 pid 文件删掉，状态立刻变成「进程还活着、pid 文件没了」。2026-10 事故的根因链第 2 步
 * 正是这个：新 bridge 撞本地实例锁秒退 → watcher 的 exit 钩子无条件删 `.dsh-bridge.pid` →
 * 真正持有隧道的孤儿 bridge 从面板上"消失" → 被判成"没运行" → 反复重启 → `bridge_wedged`。
 */
function removePidFile(name, expectPid = null) {
  const file = path.join(CONFIG_DIR, name);
  try {
    if (expectPid != null) {
      const cur = readPidFile(name);
      if (cur !== expectPid) return; // 不是我们的（或已被别人改写/删除）→ 一个字节都不动
    }
    fs.rmSync(file, { force: true });
  } catch (e) {
    logSetupIssue(`删除 pid 文件失败（${name}）：${e && (e.code || e.message)}`);
  }
}

function readPidFile(name) {
  try {
    const n = Number(String(fs.readFileSync(path.join(CONFIG_DIR, name), "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * 取某 pid 的**完整命令行**（跨平台）。取不到 → 空串（调用方一律按"不认识这个进程"处理）。
 *
 * Windows 分支是本次修复的关键之一：旧实现只有 `ps -p <pid> -o command=`，而 Windows
 * 没有 `ps`（`sh()` 走 cmd.exe）⇒ `looksLikeWatcher/looksLikeBridge` 在 Windows 上**恒 false**
 * ⇒ 接管/回收上一任进程这两条安全回收路径在 Windows 上**从不生效**。这里改用
 * `windowsProcessCommandLine()`（PowerShell CIM 按 ProcessId 点查，与 bridge 自己
 * `instanceLockVerdict` 用的是同族手法）。
 */
function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (IS_WIN) return windowsProcessCommandLine(pid);
  const r = sh(`ps -p ${pid} -o command=`);
  return r.ok ? String(r.stdout || "") : "";
}

/**
 * 这个 pid 看起来**真的**是 watcher 吗？
 *
 * 为什么必须查:pid 文件可能过期，而 pid 会被系统**回收给无关进程**。
 * 去重逻辑信任 `pidAlive()` 只会导致"我多退一次"（安全方向）；但监管者接管时要
 * **主动结束**那个 pid —— 盲杀一个被回收的无关进程是故障。所以动它之前先认一下命令行。
 */
function looksLikeWatcher(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return /dsh-setup\.mjs/.test(processCommandLine(pid));
}

/**
 * 这个 pid 是不是我们的 **bridge 子进程**（不是 watcher、也不是别的 node）。
 *
 * 为什么要单独判：接管时我们要回收"上一任遗留的 bridge"，而 pid 可能已被系统回收给无关进程 ——
 * 对无关进程发 SIGKILL 是不可接受的。所以对命令行做**双重**校验：
 * 必须同时出现 bridge 脚本名与 clients/dsh-remote 路径片段。
 * （Windows 分支见 `processCommandLine`：Electron 宿主下拉起的 bridge 可能不叫 node.exe，
 * 所以**不能**靠镜像名判断，只能靠命令行。）
 */
function looksLikeBridge(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmd = processCommandLine(pid);
  return /dsh-bridge\.mjs/.test(cmd) && /clients[\\/]dsh-remote/.test(cmd);
}

/**
 * 该不该回收这个"上一任留下的 bridge 子进程"（纯函数 —— 便于直接测）。
 *
 * 只有**确认它就是我们的 bridge 脚本**才敢动它；是自己、已死、非整数一律不动。
 * 这条判断代价很高（误杀无关进程 / 漏杀导致两个实例抢同一微信账号的消息），所以抽出来单测。
 */
function shouldReapLeftoverBridge({ pid, selfPid = 0, alive = false, isBridgeScript = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === selfPid) return false;
  if (!alive) return false;
  return Boolean(isBridgeScript);
}

/**
 * 去重决策（纯函数 —— 这条判断的代价很高，必须能被直接测）。
 *
 *   · "run"      → 没有别的守护（或就是自己），正常跑
 *   · "takeover" → 有别的守护，但**本进程是监管者(launchd)拉起的**：请它让位，我们接管
 *   · "yield"    → 有别的守护，本进程是手动/插件脱离进程拉起的：直接退出，避免两个 bridge
 *                  抢同一个设备登记
 *
 * 为什么"被监管者拉起"必须走 takeover 而不是 yield：
 *   KeepAlive 每次重拉都秒退 → 监管者判为崩溃并节流 → 插件的自愈认定"服务坏了"→
 *   bootout 摘掉作业（入口判定成立时连 plist 一起删）→ **自启动彻底消失**（真机实测）。
 */
function dedupDecision({ existingPid = null, selfPid = 0, supervisor = "" } = {}) {
  if (!existingPid || existingPid === selfPid) return "run";
  return supervisor ? "takeover" : "yield";
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/* ── C2：孤儿 bridge 清扫（命令行校验，绝不误杀）─────────────────────────────────
 *
 * 为什么 pid 文件回收（上面的 shouldReapLeftoverBridge）还不够：pid 文件只覆盖"上一任 watcher
 * 写过的那个 pid"。真实场景里还有两类抓不到的孤儿（诊断报告 04 §4.4）：
 *   ① watcher 被 TerminateProcess / 关闭控制台收掉时，bridge 子进程被 reparent 成孤儿继续持有隧道；
 *   ② 0.7.2 的升级覆盖写运行时**不停旧进程**，旧 bridge 继续用旧脚本跑。
 * 两种孤儿都与新 bridge 同 deviceId → 中继 close(4000) 互踢（生产上 3 台 Win 设备长期乒乓，全 0.7.2）。
 *
 * 安全边界（误杀无关进程是不可接受的）：
 *   · 只认**命令行同时包含** `dsh-bridge.mjs` 与**本运行时** `clients/dsh-remote` 路径的进程
 *     （与 looksLikeBridge 同一套纪律；还额外要求是本 THIS_DIR 的运行时，避免碰到另一个配置目录/用户）；
 *   · 取不到命令行（ps/PowerShell 不可用）→ 一个都不杀。失败方向必须是"漏杀"而不是"误杀"。
 */
function isThisRuntimeBridgeCmd(cmd) {
  const c = String(cmd || "");
  if (!/dsh-bridge\.mjs/.test(c)) return false;
  const needle = path.join(THIS_DIR, "clients", "dsh-remote");
  // 命令行里的分隔符可能与本机 path.sep 不同（Windows 上两者都可能出现）→ 归一化后比较
  const norm = (v) => v.replace(/[\\/]+/g, "/").toLowerCase();
  return norm(c).includes(norm(needle));
}

/**
 * Windows：一次性 PowerShell CIM **全量枚举**进程的 {pid, name, cmd}。
 *
 * 返回值的三态是**契约**（doctor 的"假证据"就是被两态混用坑出来的）：
 *   · `null`  → **扫描不可用**（无 PowerShell / 超时 / 退出码非 0 / JSON 解析失败）
 *   · `[]`    → 扫描成功，但确实一个进程都没有（或输出为空）
 *   · 数组    → 扫描成功，逐项 `{ pid, name, cmd }`
 *
 * 🔴 为什么不按镜像名过滤（旧实现是 `-Filter "Name='node.exe'"`）：
 *   桌面端（Electron）宿主起的 watcher 镜像名**一定不是** node.exe
 *（`process.execPath` = 桌面端 exe），bridge 的镜像名则取决于本机有没有真 node
 *（`preferredNode()` 回落 Electron 时为桌面端 exe）。按 node.exe 过滤 ⇒ 这类进程
 * **永远扫不到** ⇒ 活着的孤儿 bridge 清不掉、doctor 恒报 0/0。
 *   全量枚举 + 命令行匹配的代价是 PowerShell 多返回一些行（一次性 8s 上限），换来
 * "与镜像名彻底解耦"——与 bridge 自己的单实例锁判定（按 ProcessId 查 CommandLine）同族手法。
 */
function windowsCimProcesses() {
  if (!IS_WIN) return null;
  const script = [
    "try { $p = Get-CimInstance Win32_Process }",
    "catch { $p = Get-WmiObject Win32_Process }",
    "$p | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (r && r.error) return null;                                          // ENOENT（没 PowerShell）等
    if (r && typeof r.status === "number" && r.status !== 0) return null;   // 命令失败 ≠ 没有进程
    const raw = String((r && r.stdout) || "").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const out = [];
    for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
      const pid = Number(p && p.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      out.push({ pid, name: String((p && p.Name) || ""), cmd: String((p && p.CommandLine) || "") });
    }
    return out;
  } catch { return null; } // 无 PowerShell / 解析失败 → 调用方按"扫描不可用"处理，绝不输出 0
}

/** 列出本机属于**本运行时**的 bridge 进程 pid（命令行校验；扫描不可用/取不到命令行 → 空数组）。 */
function listRuntimeBridgePids() {
  const pids = [];
  if (IS_WIN) {
    // 全量 CIM 枚举（**不按镜像名过滤**：Electron 宿主拉起的进程可能不叫 node.exe）
    const procs = windowsCimProcesses();
    if (!procs) return pids; // 扫描不可用 → 一个都不杀（失败方向必须是漏杀，不能误杀）
    for (const p of procs) {
      // isThisRuntimeBridgeCmd 的严格性保持不变：命令行必须同时含 dsh-bridge.mjs 与
      // **本运行时**的 clients/dsh-remote 路径（另一个运行时目录的进程不动，避免跨配置目录误杀）
      if (isThisRuntimeBridgeCmd(p.cmd)) pids.push(p.pid);
    }
    return pids;
  }
  const r = sh("pgrep -fl 'dsh-bridge\\.mjs'");
  if (!r.ok) return pids;
  for (const line of String(r.stdout || "").split("\n")) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    if (isThisRuntimeBridgeCmd(m[2])) pids.push(Number(m[1]));
  }
  return pids;
}

/**
 * 清扫孤儿 bridge（接管/退出时调用）。返回被结束的 pid 列表。
 * @param {{ fast?: boolean }} opts fast=true 时不等待（退出钩子里只剩 3s 预算）
 */
function sweepStrayBridges({ fast = false } = {}) {
  const strays = listRuntimeBridgePids().filter((pid) => pid !== process.pid);
  const killed = [];
  for (const pid of strays) {
    try { process.kill(pid, "SIGTERM"); killed.push(pid); } catch { /* 已退出 */ }
  }
  if (!fast) {
    for (const pid of strays) {
      const dl = Date.now() + 3000;
      while (Date.now() < dl && pidAlive(pid)) sleepSync(100);
      if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
    }
  }
  return killed;
}

/**
 * 注册 Windows 登录任务（幂等：先删再建）。
 * /DELAY 0000:15：登录后等 15 秒再起，避免与桌面环境抢启动时机
 * （watcher 本身就会等 dsh web 的 3080 端口，晚起没有任何副作用）。
 *
 * 【修复「黑色空白命令行窗口」】早期版本把 `node dsh-setup.mjs run` 直接交给任务计划程序，
 * 并把它当成"只能忍受"的限制 —— 这不是限制，是 bug：
 *   · 任务计划程序在**交互会话**里启动进程，不会给 CREATE_NO_WINDOW，
 *     控制台程序（node.exe）于是必然弹出一个黑色空白窗口；用户关掉它 = 杀掉 watcher，
 *     而 dsh web 的自愈轮次又会把它拉回来 → 表现为"窗口关不掉、一直重开"，体验极差。
 *   · 零依赖的彻底隐藏办法：任务只负责起 `wscript.exe`，脚本里用
 *     `WScript.Shell.Run cmd, 0, False`（窗口样式 0 = 不显示；不等待 = node 成为独立进程）。
 *     wscript.exe 与 VBScript 是 Windows 自带组件，**不需要凭据、不需要 S4U/存密码、
 *     不需要第三方隐藏器**（旧注释误判为必须付出这些代价，实测不成立）。
 *   · watcher 仍由它自己写 `.dsh-watcher.pid`，所以 pid 判活/幂等完全不受这层包装影响。
 *   · 极少数机器被组策略禁用 Windows Script Host → 注册失败时自动退回直接启动，
 *     保证「能自启」这条底线不丢（代价是那种机器上仍会有窗口，但不至于完全没自启）。
 * 旧版本注册的可见任务会被这里的 /Delete + /Create 一并迁移成隐藏形式（重装/一键更新即生效）。
 */
let winTaskCache = null;

/** 隐藏启动器(.vbs)路径：放配置目录，随重装覆盖。 */
function winHiddenLauncherPath() {
  return path.join(CONFIG_DIR, "launch-hidden.vbs");
}

/**
 * 生成隐藏启动器 —— `wscript.exe //B <此文件>` 会在完全隐藏的窗口里执行
 * `"<node>" "<setup>" run`。
 * 转义要点：VBScript 的字符串字面量内嵌 `"` 要写成 `""`，故先把整个命令行的引号翻倍。
 */
function writeWinHiddenLauncher(node, setup) {
  const vbsPath = winHiddenLauncherPath();
  const commandLine = `"${node}" "${setup}" run`; // 真正要执行的命令行
  const literal = commandLine.replace(/"/g, '""'); // 嵌进 VBS 字符串字面量后
  // 解释器是 Electron（桌面端宿主且机器上没有真实 node）时，必须先设 ELECTRON_RUN_AS_NODE=1：
  // 否则 wscript 拉起的不是 bridge 守护，而是**又开一个桌面端应用**。
  // VBScript 侧的写法是往进程环境里塞，再 Run（不能像 shell 那样内联前缀）。
  const envLines = Object.entries(SERVICE_NODE_ENV).map(([k, v]) => `sh.Environment("PROCESS")("${k}") = "${v}"`);
  const runLines = envLines.length > 0
    ? [`Set sh = CreateObject("WScript.Shell")`, ...envLines, `sh.Run "${literal}", 0, False`]
    : [`CreateObject("WScript.Shell").Run "${literal}", 0, False`];
  const src = [
    "' dsh-remote 自动生成（勿手改，重装会覆盖）",
    "' 隐藏启动 bridge 守护：窗口样式 0 = 不显示窗口；False = 不等待，node 成为独立进程。",
    ...runLines,
    "",
  ].join("\r\n");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(vbsPath, src, "utf8");
  return vbsPath;
}

function writeWindowsTask() {
  const node = NODE_BIN;
  const setup = runtimeSetupPath();
  // 首选 wscript 包装（无黑窗）；写不了 .vbs 就退回直接启动（有窗，但保底能自启）
  let direct = `"${node}" "${setup}" run`;
  // 解释器是 Electron 时，直接启动这条路没有 .vbs 可以设环境变量，只能借 cmd 的 `set`
  // （schtasks 的 /TR 只接受一条命令行，不能内联 env）。
  if (Object.keys(SERVICE_NODE_ENV).length > 0) {
    const sets = Object.entries(SERVICE_NODE_ENV).map(([k, v]) => `set ${k}=${v}`).join(" && ");
    direct = `cmd.exe /c ${sets} && "${node}" "${setup}" run`;
  }
  let tr = direct;
  let hidden = false;
  try {
    tr = `wscript.exe //B "${writeWinHiddenLauncher(node, setup)}"`;
    hidden = true;
  } catch (e) {
    console.warn(`⚠️ 无法生成隐藏启动器（${e.message}），自启动时会显示命令行窗口。`);
  }
  if (tr.length > 255) {
    console.log(`⚠️ 自启动命令过长（${tr.length} 字符，schtasks 上限 261）：${tr}`);
    console.log("   建议把 dsh-remote 装到更短的路径，或用 `dsh-remote run` 手动运行 bridge。");
  }
  schtasks(["/Delete", "/TN", WIN_TASK_NAME, "/F"]); // 幂等清理（不存在也只是非 0 退出，不影响后续
  let created = schtasks(["/Create", "/TN", WIN_TASK_NAME, "/TR", tr, "/SC", "ONLOGON", "/DELAY", "0000:15", "/F"]);
  if (!created.ok && hidden) {
    // 组策略禁用 Windows Script Host 等 → 退回直接启动，别让"自启"整个失效
    console.warn(`⚠️ 隐藏方式注册失败（${(created.stderr || created.stdout).trim() || `退出码 ${created.code}`}），改用直接启动。`);
    tr = direct;
    hidden = false;
    created = schtasks(["/Create", "/TN", WIN_TASK_NAME, "/TR", tr, "/SC", "ONLOGON", "/DELAY", "0000:15", "/F"]);
  }
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
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${SERVICE_PATH}</string>${SERVICE_NODE_ENV_PLIST}${PINNED_UPSTREAM ? `<key>DSH_BRIDGE_UPSTREAM</key><string>${PINNED_UPSTREAM}</string>` : ""}<key>DSH_BRIDGE_INSTALL_SOURCE</key><string>${INSTALL_SOURCE}</string><key>DSH_BRIDGE_INSTALL_VERSION</key><string>${INSTALL_VERSION}</string><key>DSH_BRIDGE_HARNESS_VERSION</key><string>${HARNESS_VERSION}</string></dict>
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
    const unit = `[Unit]\nDescription=dsh-remote bridge (auto-starts with dsh web)\n\n[Service]\nExecStart=${runCmd}\nRestart=on-failure\nRestartSec=5\nEnvironment=PATH=${SERVICE_PATH}\n${SERVICE_NODE_ENV_UNIT}Environment=DSH_BRIDGE_INSTALL_SOURCE=${INSTALL_SOURCE}\nEnvironment=DSH_BRIDGE_INSTALL_VERSION=${INSTALL_VERSION}\nEnvironment=DSH_BRIDGE_HARNESS_VERSION=${HARNESS_VERSION}\n\n[Install]\nWantedBy=default.target\n`;
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
 * 等 label **真的从 launchd 里摘干净**。
 *
 * 🔴 2026-10-11 实测的坑：`launchctl bootout` 是**异步**的 —— 紧接着 bootstrap 同一个 label 会
 * 随机失败（`Bootstrap failed: 5: Input/output error`），表现为"安装时灵时不灵"：
 * 手工在两条命令之间加个 sleep 就 100% 成功，安装器里没等就大约一半失败 →
 * 失败后走 `spawnDetachedBridge()` 兜底 → 用户看到"⚠️ 未被系统托管 / 不会开机自启"。
 * 所以 bootout 之后必须轮询到 `launchctl print` 真的查不到，再 bootstrap。
 */
function waitLaunchdGone(target, tries = 12, gapMs = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (!sh(`launchctl print ${target}`).ok) return true;
    sleepSync(gapMs);
  }
  return false;
}

/**
 * 轮询等待 job 起来。
 * launchd 派生是异步的：bootstrap 成功后立刻 print 必然看到 not running（旧实现因此误报"启动失败"）。
 * 明确"被挂起且没有派生"时提前放弃（等满也没用），否则给足 ~8 秒。
 */
function waitLaunchdRunning(target, tries = 25, gapMs = 400) {
  let st = launchdState(target);
  for (let i = 0; i < tries; i += 1) {
    st = launchdState(target);
    if (st.running) return st;
    /* 🔴 2026-10-11 修：刚 bootstrap/kickstart 后 launchd 会先进入**过渡态**
       （`state = xpcproxy` / `spawn scheduled` / `pending`），此时 runs 还是 0。
       旧判据"登记了却一次都没派生 → 判定被挂起"在 1.2 秒后就放弃，于是
       `installAutostart()` 误报"launchd 无法托管本机 bridge"，转而拉起一个**脱离进程** ——
       用户看到的是"安装没装好/不会开机自启"，而实际上 launchd 下一秒就把它拉起来了
       （现场实测：state=xpcproxy，几秒后 state=running）。
       现在：过渡态一律继续等；只有"确实派生过又退出"或"等满窗口都没起来"才算失败。 */
    const transitional = /state\s*=\s*(xpcproxy|spawn scheduled|pending|running\s*\()/i.test(String(st.raw || ""));
    if (transitional) { sleepSync(gapMs); continue; }
    // 已派生过、现在没在跑、也没被挂起 → 是启动后立刻退出（真失败），不必等满
    if (st.exists && st.runs > 0 && !st.deferred) break;
    // 登记了却一次都没派生，且已经等了足够久（给足 4 秒让 launchd 调度）→ 判为被挂起
    if (i >= 10 && st.exists && !st.deferred && st.runs === 0) break;
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
      env: nodeEnv(),
      // Windows 上 detached 即 DETACHED_PROCESS：子进程**不继承父控制台**，
      // 控制台程序（node.exe）会因此拿到一个**全新的可见窗口**。
      // 必须显式 windowsHide 才会带上 CREATE_NO_WINDOW（POSIX 上该选项被忽略）。
      windowsHide: true
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
/**
 * 🔴 标签占用保护（2026-10-10 故障）：`com.dshremote.bridge` 这个 launchd label 是**全局唯一**的，
 *   谁 bootstrap 谁就接管它。当天跑测试时，某个用例用**假 HOME + 真 launchctl** 把测试临时目录的
 *   plist 登记到了同一个 label 上 → **真桥被顶掉**、远程访问中断，而日志里看不出任何异常。
 *
 *   所以 bootstrap 之前先问一句：这个 label 现在登记的 plist 是**本 relayDir 的**那份吗？
 *   · 不是（别人家的）→ **拒绝接管**并明确报错。要强行接管得显式设
 *     `DSH_BRIDGE_ALLOW_LABEL_TAKEOVER=1`（给人留后门，但默认安全）。
 *   · 查不出来（launchctl 不可用/未登记）→ 照旧继续，不误伤正常安装。
 */
function labelOwnedByOtherDir(plistPath, domain) {
  try {
    const r = sh(`launchctl print ${domain}/${BRIDGE_LABEL}`);
    if (!r.ok) return null;                       // 未登记 → 不是"别人家的"
    const cur = String(r.stdout || "").match(/^\s*path = (.+)$/m);
    if (!cur) return null;                        // 读不出路径 → 不拦
    const a = cur[1].trim();
    const b = String(plistPath).trim();
    return a === b ? false : a;                   // 返回"占用者的 plist 路径"= 别人家的
  } catch { return null; }
}

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
    // 先确认这个 label 不是别人（别的 relayDir）的，否则**拒绝接管**——见 labelOwnedByOtherDir
    const foreign = labelOwnedByOtherDir(plistPath, domain);
    if (foreign && String(process.env.DSH_BRIDGE_ALLOW_LABEL_TAKEOVER || "") !== "1") {
      return {
        ok: false,
        status: "label-owned-by-other",
        detail: `${domain}/${BRIDGE_LABEL} 已被另一个 relayDir 占用（${foreign}）—— 拒绝接管。`
          + `真要用本目录接管，请先停掉那边的桥，或显式设 DSH_BRIDGE_ALLOW_LABEL_TAKEOVER=1。`,
      };
    }
    sh(`launchctl bootout ${target}`);
    waitLaunchdGone(target);   // 关键：不等干净就 bootstrap → 随机 "5: Input/output error"
    let boot = sh(`launchctl bootstrap ${domain} ${q(plistPath)}`);
    if (!boot.ok) {
      // 摘除竞态可能还没结束：再等一拍重试一次（仍失败才走老写法兜底）
      sleepSync(600);
      waitLaunchdGone(target, 6, 200);
      boot = sh(`launchctl bootstrap ${domain} ${q(plistPath)}`);
    }
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
    // 【0.6.15】飞牛 fnOS / 群晖这类 NAS 上**没有 user systemd 会话**（插件跑在系统服务里，
    // 没有 XDG_RUNTIME_DIR）→ `systemctl --user` 只会报 "Failed to connect to bus"，
    // 于是这一支原本必然失败、且没有任何兜底。现在：有会话就用 systemd（可自愈），
    // 没有就退到脱离进程（spawnDetachedBridge，与 macOS 的兜底同一条路径）。
    const hasUserSystemd = Boolean(process.env.XDG_RUNTIME_DIR) && sh("systemctl --user show-environment").ok;
    if (hasUserSystemd) {
      const r = sh(`systemctl --user restart dsh-bridge`);
      if (r.ok) {
        const a = sh(`systemctl --user is-active dsh-bridge`);
        if (a.ok && a.stdout.trim() === "active") return { ok: true, status: "running", pid: null };
        return { ok: false, status: "failed", detail: (a.stdout || a.stderr).trim() };
      }
      // 有会话却重启失败：继续往下走脱离进程兜底，绝不留一个"重启失败但没有任何进程"的空档
    }
    const d = spawnDetachedBridge();
    if (d.ok) {
      return {
        ok: true,
        status: "degraded-detached",
        pid: d.pid,
        detail: hasUserSystemd
          ? "systemd --user 重启失败，已改为后台进程运行（现在可用；systemd 恢复后下一次重启会回到托管）"
          : "本机没有 user systemd 会话（NAS/容器常见），已改为后台进程运行（现在可用，但不会开机自启）",
      };
    }
    return { ok: false, status: "failed", detail: d.error || "systemd 与后台进程均启动失败" };
  }
  return { ok: false, status: "unsupported", detail: `平台 ${process.platform} 不支持自启动` };
}

/**
 * 上游 dsh web 地址（bridge 的转发目标 + watcher 的「dsh web 在线吗」判据**同一个来源**）。
 *
 * 【2026-09-23 用户实测故障】这里原本处处写死 `http://127.0.0.1:3080`：只要用户的 dsh web
 * 不在默认端口（`dsh web --port 8090`、profile 里配了 port、或 `--port 0` 让系统分配空闲端口），
 * watcher 的在线探测就**永远**失败 → bridge 永远不启动，而面板只会说「正在启动 Bridge…」。
 * 优先级：显式环境变量 > **运行时动态发现** > 插件半留下的端口文件 > DSH_WEB_URL > 默认 3080。
 *
 * 为什么还要「动态发现」这一层（2026-09-23 第二起实测，DSH Desktop）：
 *   DSH Desktop（Electron 壳 `dsh-plugin-desktop`）默认把 Web 服务放在 **43120**，被占用还会 +1；
 *   而端口文件要等**插件半**加载后才有。于是「端口文件还没写」或「写的是上一轮的旧端口」时，
 *   光靠文件仍会永久探错端口。发现逻辑（含 DSH 进程实际监听端口 + Desktop 端口区间 + 身份校验）
 *   统一在 clients/dsh-remote/upstream-discovery.mjs，watcher 与 bridge 共用同一份实现。
 */
const UPSTREAM_FILE = ".dsh-upstream";

/**
 * 本次安装要**钉住**的上游（null = 不钉，运行时按 env → .dsh-upstream → 探测 取值）。
 * 见 desktopAppPort() 的注释：插件装进多个 profile 后，各宿主会互相覆盖 `.dsh-upstream`。
 */
// 🔴 2026-10-25 事故：以前把安装进程里的 DSH_BRIDGE_UPSTREAM（一个**当时的动态端口**）写进
// launchd plist，之后 dsh 每次重启换端口，plist 里的旧端口就成了永久生效的"显式指定"，
// 守护/桥永远连不上 → 设备掉线。现在默认**不钉**（运行时按 插件写的 .dsh-upstream → 探测 取值）；
// 仅当部署方显式要求（DSH_BRIDGE_PIN_UPSTREAM=1）时才沿用旧行为。
let PINNED_UPSTREAM = (() => {
  const pinFlag = String(process.env.DSH_BRIDGE_PIN_UPSTREAM || "").trim().toLowerCase();
  if (pinFlag !== "1" && pinFlag !== "true" && pinFlag !== "on") return null;
  return String(process.env.DSH_BRIDGE_UPSTREAM || "").trim().replace(/\/+$/, "") || null;
})();

/**
 * 探测桌面端（Electron 应用）当前监听的**回环端口**。
 *
 * 为什么需要（2026-10-11 实测故障）：插件同时装进 web 与 desktop 后，**每个宿主**都会在装载时
 * 把自己 `ctx.webServer.port` 写进 `<relayDir>/.dsh-upstream` —— 谁最后写谁生效。于是桥的上游
 * 会在两个应用之间来回跳：那次桥跑去连了 Web 版的 3080，而用户面对的是桌面端 19387，
 * 表现就是"命令跑完了但没装上 / 手机连上看到的不是我在用的界面"。
 * 装桌面端时把端口**钉进自启动配置**（环境变量优先级最高），两个宿主就抢不动了。
 */
function desktopAppPort() {
  if (process.platform !== "darwin") return null;
  try {
    const r = sh("lsof -nP -iTCP -sTCP:LISTEN -a -c DeepSeek 2>/dev/null");
    for (const line of String(r.stdout || "").split("\n")) {
      const m = line.match(/(?:127\.0\.0\.1|\[::1\]):(\d+)\s/);
      if (m) return Number(m[1]);
    }
  } catch { /* 拿不到就算了，退回运行时探测 */ }
  return null;
}
/** 运行时动态发现到的上游（优于可能过期的端口文件；进程内缓存）。 */
let discoveredUpstream = "";
function upstreamUrl() {
  const explicit = String(process.env.DSH_BRIDGE_UPSTREAM || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (discoveredUpstream) return discoveredUpstream;
  try {
    const fromFile = String(fs.readFileSync(path.join(CONFIG_DIR, UPSTREAM_FILE), "utf8")).trim();
    if (/^https?:\/\/[^\s]+$/i.test(fromFile)) return fromFile.replace(/\/+$/, "");
  } catch { /* 没写过（旧版/首次）→ 往下回退 */ }
  const web = String(process.env.DSH_WEB_URL || "").trim();
  if (web) {
    try {
      const u = new URL(web);
      if (u.port) return `http://127.0.0.1:${u.port}`; // bridge 的 loopback 围栏只认 127.0.0.1
    } catch { /* 非 URL：忽略 */ }
  }
  return FALLBACK_UPSTREAM;
}
/** 上游端口（诊断/日志用；取不到就回退 3080）。 */
function upstreamPort() {
  try { return Number(new URL(upstreamUrl()).port) || 3080; } catch { return 3080; }
}

/** 发现结果缓存与冷却：避免每轮轮询都去 lsof/pgrep + 逐个端口探测。 */
let upstreamDiscoveryAt = 0;
let upstreamDiscoveryInflight = null;
const UPSTREAM_DISCOVERY_COOLDOWN_MS = 15_000;

/**
 * 动态发现上游（带身份校验），成功后写入 `discoveredUpstream` 供全局复用。
 * @param {boolean} force 忽略冷却（探测失败后的重试用）
 */
async function refreshUpstreamDiscovery(force = false) {
  if (upstreamDiscoveryInflight) return upstreamDiscoveryInflight;
  const now = Date.now();
  if (!force && now - upstreamDiscoveryAt < UPSTREAM_DISCOVERY_COOLDOWN_MS) return upstreamUrl();
  upstreamDiscoveryAt = now;
  upstreamDiscoveryInflight = (async () => {
    try {
      const found = await discoverUpstream({ relayDir: CONFIG_DIR, log: (m) => console.log(`[dsh-remote] ${m}`) });
      // 「提示地址验证通过」与「候选命中」都值得记下来；fallback（什么都没找到）不污染现有判断
      if (found.url && found.source !== "fallback") discoveredUpstream = found.url;
      return upstreamUrl();
    } catch {
      return upstreamUrl();
    } finally {
      upstreamDiscoveryInflight = null;
    }
  })();
  return upstreamDiscoveryInflight;
}

/** 上游是否**有响应**（判据刻意宽松：4xx/5xx 也算"端口在听"，那种情况问题在别处）。 */
async function upstreamReachable(url = upstreamUrl(), timeoutMs = 1200) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    await fetch(url + "/", { signal: ac.signal });
    clearTimeout(timer);
    return true;
  } catch { return false; }
}

/**
 * dsh web 是否正在运行（端口以 upstreamUrl() 为准，**绝不写死 3080**）。
 * bridge 本身依赖 dsh web 才工作：dsh web 没开时 bridge 起来也会立刻退出，
 * 所以「装完当下 bridge 没在跑」是**正常状态**，不能当失败吓用户（见 install 汇总）。
 *
 * 探测失败时会**主动做一次动态发现**再试一次 —— 这一条正是 DSH Desktop 场景的关键：
 * 上游在 43120（Desktop 默认，占用还会 +1），而端口文件可能还没写或写着上一轮的旧端口。
 */
async function isDshWebUp(timeoutMs = 1200) {
  if (await upstreamReachable(upstreamUrl(), timeoutMs)) return true;
  // 🔴 2026-10-25（设备掉线实测）：Electron 每次启动可能换端口。端口文件由 dsh web 内的插件
  //   在每次启动时重写，比进程内的 discoveredUpstream 缓存新 —— 先直接试文件，别被旧缓存挡住。
  try {
    const fromFile = String(fs.readFileSync(path.join(CONFIG_DIR, UPSTREAM_FILE), "utf8")).trim();
    if (/^https?:\/\/[^\s]+$/i.test(fromFile)) {
      const normalized = fromFile.replace(/\/+$/, "");
      if (normalized !== upstreamUrl() && (await upstreamReachable(normalized, timeoutMs))) {
        discoveredUpstream = normalized;
        return true;
      }
    }
  } catch { /* 没有端口文件：继续走动态发现 */ }
  const before = upstreamUrl();
  const after = await refreshUpstreamDiscovery(true);
  if (after === before) return false;
  return upstreamReachable(after, timeoutMs);
}

/** 已知的 DSH profile 名（`--profile web` / `--profile desktop` 这种写法要能用）。 */
const KNOWN_PROFILE_NAMES = ["web", "desktop"];
/** profile 名 → 目录（与 dsh 自己的 `$DSH_HOME/profiles/<name>` 约定一致）。 */
function profileDirOfName(name) {
  return path.join(os.homedir(), ".dsh", "profiles", name);
}
/** 目标目录是否就是**桌面端**保留的 profile（由 Electron 应用独占管理）。 */
function isDesktopProfileDir(dir) {
  return path.resolve(dir) === path.resolve(profileDirOfName("desktop"));
}

/**
 * 解析目标 profile 目录（安装与插件管理共用同一约定）。
 *
 * 三种写法都支持：
 *   · `--profile web` / `--profile desktop` → `~/.dsh/profiles/<name>`
 *     （新增：DeepSeek Harness 桌面端的 profile 就叫 `desktop`）
 *   · `--profile <任意路径>`                → 原样当目录用（老行为，保持不变）
 *   · `DSH_PROFILE_DIR` 环境变量            → 与 `--profile` 同约定
 * 缺省仍是 Web 版 profile，行为与改动前完全一致。
 */
function resolveProfileDir(argv = []) {
  const i = argv.indexOf("--profile");
  const explicit = i > -1 && argv[i + 1] ? argv[i + 1] : process.env.DSH_PROFILE_DIR;
  if (!explicit) return profileDirOfName("web");
  if (KNOWN_PROFILE_NAMES.includes(explicit)) return profileDirOfName(explicit);
  return explicit;
}

/**
 * 从任意 argv 里挑出 profile 选择参数。
 *
 * 为什么需要：安装主流程 `setup()` 的 argv 里可能带 `--profile desktop`，但它内部调用
 * `pluginCmd()` 时原本传的是空数组 —— 于是"指定 desktop profile"会被静默忽略、
 * 插件仍然装进 Web 版 profile（桌面端用户装了却看不到面板，且极难自查）。
 */
/**
 * DeepSeek Harness **桌面应用**是否正在运行。
 *
 * 🔴 2026-10-11 故障：我在应用运行中改写了 `~/.dsh/profiles/desktop/` 里的插件文件，
 *    应用随即**自己退出/重启**（用户："怎么又触发了 dsh 的关闭"）。安装器自己的提示早就写着
 *    「请先**完全退出** DeepSeek Harness 应用再安装（应用独占该 profile）」—— 这条必须由程序强制，
 *    不能靠"我记得"。
 * 检测方式：macOS 上桌面应用的进程名就是 `DeepSeek`（lsof/pgrep 实测），另加 App 包路径兜底。
 */
function dshDesktopAppRunning() {
  // 显式覆盖（测试隔离 / 探测误报时的逃生口）：DSH_DESKTOP_APP_RUNNING=0|1
  const override = String(process.env.DSH_DESKTOP_APP_RUNNING || "").trim();
  if (override === "0" || override === "1") return override === "1";
  if (process.platform !== "darwin") return false;
  try {
    // 实测（2026-10-11）：`pgrep -x DeepSeek` 与 `pgrep -f "...app/Contents/MacOS"` 都匹配不到，
    // 必须用下面的写法（`Contents/MacOS/DeepSeek` 或短名 `DeepSeek Harness.app` 均可命中）。
    const a = sh("pgrep -f 'Contents/MacOS/DeepSeek'");
    if (a.ok && String(a.stdout || "").trim()) return true;
    const b = sh("lsof -nP -iTCP:19387 -sTCP:LISTEN");
    return Boolean(b.ok && /LISTEN/.test(String(b.stdout || "")));
  } catch { return false; }
}

/**
 * 探测本机**已存在**的 profile（可装载 = 同时有 package.json 与 cordis.patch.yml）。
 * desktop 排在前面：用户主用的是桌面应用，多个 profile 一起装时它是"首选/权威"那个。
 */
function detectProfileDirs() {
  const root = path.join(os.homedir(), ".dsh", "profiles");
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .filter((n) => fs.existsSync(path.join(root, n, "package.json")) && fs.existsSync(path.join(root, n, "cordis.patch.yml")));
  } catch { return []; }
  names.sort((a, b) => (a === "desktop" ? -1 : b === "desktop" ? 1 : a.localeCompare(b)));
  return names.map((n) => ({ name: n, dir: profileDirOfName(n) }));
}

/**
 * 本次要操作的 profile 列表。
 *
 * 用户约定（2026-10-11）：「默认安装的时候也能同步安装给 desktop」。
 * 以前不带 `--profile` 时**写死装 web** —— 桌面端用户执行官方那条 `npx @mrrisega/dsh-remote@beta`
 * 之后，插件全进了 Web 版 profile，而用户面对的是桌面应用 → 面板永远不出现，且极难自查。
 *
 * · `--profile X` / `DSH_PROFILE_DIR` → 只动那一个（脚本化与既有用法不变）
 * · 都不给 → **本机所有已存在的 profile**（desktop 优先）
 * · 一个都没探测到 → 退回 web（保留"首次安装"的引导文案）
 */
function targetProfileDirs(argv = []) {
  const i = argv.indexOf("--profile");
  if (i > -1 && argv[i + 1]) return [{ name: argv[i + 1], dir: resolveProfileDir(argv) }];
  if (process.env.DSH_PROFILE_DIR) return [{ name: "env", dir: process.env.DSH_PROFILE_DIR }];
  const all = detectProfileDirs();
  if (!all.length) return [{ name: "web", dir: profileDirOfName("web") }];
  /* 默认装哪些？**不是"全部"** —— 机器上常有过实验/自动化用的 profile（headless、web02…），
     往那些里面塞插件是越界。规则：
       · 已知的面向用户的 profile（web / desktop）：**有就装**（这是用户的核心诉求：默认也要给 desktop）
       · 其他 profile：**只有本来就已经装了插件**才继续管（升级不能悄悄漏掉它）
       · 上面并集为空（例如只有 headless 一种）→ 退回"全部已存在"，避免什么都不装 */
  const chosen = all.filter((p) => KNOWN_PROFILE_NAMES.includes(p.name)
    || fs.existsSync(path.join(p.dir, PLUGIN_LOCAL_DIR)));
  return chosen.length ? chosen : all;
}

function profileArgvOf(argv = []) {
  const i = argv.indexOf("--profile");
  return i > -1 && argv[i + 1] ? ["--profile", argv[i + 1]] : [];
}

/**
 * 目标 profile 是桌面端时给出的前置提醒（安装前调用）。
 *
 * 桌面端的 `profiles/desktop` 由 Electron 应用**独占**：应用运行时它会持有 profile 写锁，
 * 且运行中的进程不会重新装载我们刚写进去的插件。所以要么完全退出应用再装，要么
 * 直接在应用内的「插件」页安装（那是官方路径，无需退出）。
 * 这里只做提醒，不阻断 —— 用户可能正是在"应用已退出"的状态下跑安装器。
 */
function warnIfDesktopProfile(dir) {
  if (!isDesktopProfileDir(dir)) return;
  console.log("");
  console.log("ℹ️ 目标 profile 是 DeepSeek Harness **桌面端**的保留 profile（~/.dsh/profiles/desktop）。");
  console.log("   · 请先**完全退出** DeepSeek Harness 应用再安装（应用独占该 profile，运行中写入不会被装载）；");
  console.log("   · 装完后重新打开应用即可。更省事的做法是在应用内「插件」页直接安装 dsh-remote-web；");
  console.log("   · 桌面端与 Web 版共用 ~/.dsh 下的会话/设置/凭据，但**插件互相隔离**，两边需要各自安装。");
  console.log("");
}

/**
 * 监听本机 dsh web 端口的进程 pid（= dsh web）。端口取 upstreamPort()（不再写死 3080）。
 * macOS/Linux：lsof → pgrep；Windows：netstat -ano 取 LISTENING 行的最后一列
 * （netstat 是系统自带，比每次都起 PowerShell 快得多）。
 */
function dshWebPid() {
  const port = upstreamPort();
  if (IS_WIN) {
    const r = sh(`netstat -ano | findstr ":${port}"`);
    for (const line of String(r.stdout || "").split("\n")) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) return Number(m[1]);
    }
    return null;
  }
  const l = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`);
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
  if (!pid) return { ok: false, how: "", detail: `未找到监听 ${upstreamPort()} 的进程（dsh web 没在运行？）` };
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
    const child = spawn(NODE_BIN, [helper], { detached: true, stdio: "ignore", cwd: os.homedir(), windowsHide: true, env: nodeEnv() });
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
// 云服务用户在 dsh web → 设置 → 「远程访问」面板即可注册/登录（自建切换也在此面板）；
// 独立设置页(127.0.0.1:3499)与面板功能完全重复、且暴露自建表单给普通用户造成困惑,已移除。
// 保留 `dsh-remote settings` 命令为“引导提示”,避免旧脚本/旧文档直接调它时报错。
function settingsHint() {
  console.log(`
dsh-remote：独立的本地设置页已移除。

请直接在 dsh web 里完成登录/连接配置（无需任何命令）：
  打开 dsh web → 设置 → 「远程访问」→ 注册或登录手机号即可（自建模式切换也在该面板）。

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

/* ── 账号指纹"变化确认"（C8）────────────────────────────────────────────────────
 *
 * 🔴 为什么不能"指纹一变就重启 bridge"（诊断报告 04 §4.3）：
 *   `loadConfig()` 读失败会静默返回 `{}`，此时指纹 = `saas|||`，与真实值不等 ——
 *   旧逻辑据此按"账号变了"停 bridge，下一轮再拉起，于是每 10~20s 重启一次；
 *   Windows 上被杀软扫描/OneDrive 同步/文件占用放大的"读抖动"就是这样变成重启循环的。
 *
 * 修法：指纹变化必须**连续 2 轮**（ensureBridge 每 10s 一轮）看到同一个新值，
 * 或该新值已持续 ≥5s，才认为"真的变了"。单轮的 `{}` 抖动会被下一轮复位清掉。
 * 抽成纯函数是因为这条判断的代价很实在（每误判一次就断一次隧道），必须能被直接测。
 */
const FINGERPRINT_CONFIRM_ROUNDS = 2;
const FINGERPRINT_CONFIRM_MS = 5000;

/** 记一次"疑似新指纹"：同一个 fp 连击计数，换值则重新从 1 开始。 */
function noteFingerprintCandidate(prev, fp, now = Date.now()) {
  if (!prev || prev.value !== fp) return { value: fp, rounds: 1, since: now };
  return { value: fp, rounds: prev.rounds + 1, since: prev.since };
}

/** 这个"疑似变化"是否已经确认（连续 2 轮，或持续 ≥5s）。 */
function fingerprintChangeConfirmed(cand, now = Date.now()) {
  if (!cand || !cand.value) return false;
  return cand.rounds >= FINGERPRINT_CONFIRM_ROUNDS || now - cand.since >= FINGERPRINT_CONFIRM_MS;
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

/* ── 守护启动锁：把"一堆守护同时被拉起"的惊群收敛成串行 ─────────────────────────────
 *
 * 🔴 2026-09-26 真机故障（dsh web 启动故障的连带伤害）：一次重启窗口里同时出现了
 *    **6 个 `dsh-setup.mjs run` 守护 + 6 个 bridge**，全部用同一个 deviceId 去 router 注册，
 *    互相把对方顶掉 —— bridge 日志刷满
 *      `隧道断开(code=4000, replaced by new connection)` → `2s 后重连` → 再被顶掉，
 *    手机侧表现为隧道无限抖动、随机不可用。
 *    成因是 `runBridge()` 的去重是**先读 pid 文件、后写 pid 文件**：N 个实例在同一瞬间启动时，
 *    每个都读到"还没有别人" → 一起活下来。launchd 的 `com.dshremote.bridge`(KeepAlive) 与
 *    插件自愈拉起的脱离进程又都会各自拉一个，正好构成惊群。
 *
 * 修法：进入去重逻辑**之前**先抢一把原子锁（`wx` = 排他创建）。抢到的人才继续走原来的
 *       supervisor 判定；抢不到的人只在"被监管者"时才稍等（它必须能接管），否则直接让位。
 *      锁文件带 `pid:时间戳`，超过 STALE 就视为残留（进程被强杀时留下的），可安全抢占 ——
 *      **绝不允许一把陈旧的锁把 bridge 永久挡在门外**。
 */
const WATCHER_SPAWN_LOCK = ".dsh-watcher-spawn.lock";
const SPAWN_LOCK_STALE_MS = 30_000;
const SPAWN_LOCK_WAIT_MS = 15_000;

function tryAcquireSpawnLock() {
  const f = path.join(CONFIG_DIR, WATCHER_SPAWN_LOCK);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const fd = fs.openSync(f, "wx");           // 排他创建：要么拿到，要么 EEXIST
    fs.writeSync(fd, `${process.pid}:${Date.now()}`);
    fs.closeSync(fd);
    return true;
  } catch {
    // 已存在：可能是残留（强杀留下的），也可能是真有人在启动
    try {
      const [pidStr, tsStr] = String(fs.readFileSync(f, "utf8")).split(":");
      const pid = Number(pidStr);
      const ts = Number(tsStr);
      const stale = !Number.isFinite(ts) || Date.now() - ts > SPAWN_LOCK_STALE_MS || !pidAlive(pid);
      if (stale) {
        fs.rmSync(f, { force: true });
        const fd = fs.openSync(f, "wx");
        fs.writeSync(fd, `${process.pid}:${Date.now()}`);
        fs.closeSync(fd);
        return true;
      }
    } catch { /* 读不到/抢不到 → 当作没拿到 */ }
    return false;
  }
}

function releaseSpawnLock() {
  const f = path.join(CONFIG_DIR, WATCHER_SPAWN_LOCK);
  try {
    const owner = Number(String(fs.readFileSync(f, "utf8")).split(":")[0]);
    if (owner === process.pid) fs.rmSync(f, { force: true });  // 只删自己那把
  } catch { /* 没锁/已被抢 → 忽略 */ }
}

// ---------- run：前台跑 bridge（带配置 + 自启动 watcher） ----------
/** 以插件写入的 .dsh-upstream 为准校正进程内的旧上游环境变量（dsh 换端口后不再连旧端口）。 */
function reconcileUpstreamEnvFromFile() {
  try {
    const fileUp = String(fs.readFileSync(path.join(CONFIG_DIR, UPSTREAM_FILE), "utf8")).trim().replace(/\/+$/, "");
    const envUp = String(process.env.DSH_BRIDGE_UPSTREAM || "").trim().replace(/\/+$/, "");
    if (envUp && /^https?:\/\/[^\s]+$/i.test(fileUp) && fileUp !== envUp) {
      console.log(`[dsh-remote] 忽略旧的上游地址 ${envUp} → 使用插件写入的最新地址 ${fileUp}（防端口漂移掉线）`);
      process.env.DSH_BRIDGE_UPSTREAM = fileUp;
      discoveredUpstream = fileUp;
    }
  } catch { /* 无文件：保持原行为 */ }
}

async function runBridge() {
  // 启动/每次拉起前都按插件写入的端口校正继承来的旧 env（旧 plist 可能钉着安装时的端口）
  reconcileUpstreamEnvFromFile();
  // 去重（所有平台）：自启动服务、登录任务、插件半的脱离进程兜底都可能拉起 watcher，
  // 两个 bridge 会抢同一个设备登记 → 以 pid 文件为准。
  //
  // ⚠️ 但**被监管者（launchd）拉起的那个实例绝不能再"直接退出"**。
  //    真机实测的后果链：KeepAlive 每次重拉 → 本进程秒退 → 监管者判为崩溃并节流
  //    （`launchctl print` 显示 `state = spawn scheduled`）→ 插件的自愈据此认定"服务坏了"
  //    → `bootout` 摘掉作业（入口判定成立时连 plist 一起删）→
  //    **自启动彻底消失，连 `launchctl kickstart` 都报"域里找不到该服务"**，
  //    只剩插件面板的「启动」能救回来。
  //    被监管者拉起 = 我们才是那个该活下来的实例 → 请游离实例让位，然后接管。
  {
    // 抢启动锁（见上方长注释）：把同时被拉起的多个实例串行化，杜绝"大家都读到没有别人"。
    const supervised = String(process.env.XPC_SERVICE_NAME || "");
    let locked = tryAcquireSpawnLock();
    if (!locked && supervised) {
      // 被监管者必须能接管：等一会儿再抢（游离实例写完 pid 文件就会释放）
      const deadline = Date.now() + SPAWN_LOCK_WAIT_MS;
      while (!locked && Date.now() < deadline) { sleepSync(150); locked = tryAcquireSpawnLock(); }
    }
    if (!locked) {
      console.log("[dsh-remote] 另一个守护正在启动（启动锁被占用），本进程直接退出，避免重复实例。");
      return;
    }
    const other = readPidFile(WATCHER_PID_FILE);
    if (other && other !== process.pid && pidAlive(other)) {
      const supervisor = String(process.env.XPC_SERVICE_NAME || "");
      const decision = dedupDecision({ existingPid: other, selfPid: process.pid, supervisor });
      if (decision === "takeover") {
        console.log(`[dsh-remote] 检测到游离守护（pid=${other}）——本进程由 ${supervisor} 监管，请它让位后接管。`);
        // ⚠️ pid 可能已被系统回收给无关进程：必须确认它**真的**是 watcher 才敢动它，
        //    否则宁可当作过期 pid 直接接管（下面 writePidFile 会覆盖掉）。
        if (looksLikeWatcher(other)) {
          try { process.kill(other, "SIGTERM"); } catch { /* 已退出 */ }
          // 等它自己退（它的退出钩子会清理 pid 文件并停掉它的 bridge）。最多 5 秒 ——
          // 不能等太久，否则监管者又看到一次"迟迟没起来"。
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && pidAlive(other)) sleepSync(100);
          if (pidAlive(other)) { try { process.kill(other, "SIGKILL"); } catch { /* 已退出 */ } }
        }
        writePidFile(WATCHER_PID_FILE, process.pid);
      } else {
        console.log(`[dsh-remote] 已有一个 bridge 守护在运行（pid=${other}），本进程直接退出，避免重复实例。`);
        releaseSpawnLock();
        return;
      }
    }
    // 🔒 关键顺序：**先把自己的 pid 落盘，再释放启动锁**。
    //    否则"释放锁 → 下面 1373 行才 writePidFile"之间又是一个空窗，第二个实例会读到
    //    "没有别人" → 惊群只是被缩小、并没有消除。1373 行那次写入保持原样（它还负责注册退出清理）。
    writePidFile(WATCHER_PID_FILE, process.pid);
    releaseSpawnLock();
    // ── 回收「上一任留下的 bridge 子进程」────────────────────────────────────
    //
    // 🔴 真机 bug（2026-09-23 用户实测）：一条微信指令**回两条**。
    //    成因链：接管时把老 watcher SIGTERM（它只"请"子进程退出、最多等 3 秒就自己 exit），
    //    而 bridge 此刻常正卡在 35 秒的 getUpdates 长轮询里 —— 来不及退 → 变成孤儿继续跑；
    //    若老 watcher 是被 SIGKILL 干掉的（等超 5 秒那条路），连"请"都不会发生。
    //    两个 bridge 各自持有自己的 updatesBuf、各自轮询同一个微信账号 ⇒ 同一条消息被消费两次、
    //    回两条。所以**接管之后必须显式清掉上一任的子进程**，不能只靠"它应该会自己退"。
    //
    // 安全边界：pid 可能已被系统回收给无关进程 —— 必须确认它**真的**是我们的 bridge 脚本才动手
    //（与 looksLikeWatcher 同一套纪律）。插件半的「脱离进程兜底」也会拉起 bridge，
    // 但那种情况**没有** watcher 在跑（有 watcher 就不会走兜底），所以这里回收不会误伤正常形态。
    {
      const leftover = readPidFile(BRIDGE_PID_FILE);
      const reap = shouldReapLeftoverBridge({
        pid: leftover,
        selfPid: process.pid,
        alive: leftover ? pidAlive(leftover) : false,
        isBridgeScript: leftover ? looksLikeBridge(leftover) : false
      });
      if (reap) {
        console.log(`[dsh-remote] 回收上一任遗留的 bridge 子进程（pid=${leftover}）——避免两个实例抢同一账号的消息。`);
        try { process.kill(leftover, "SIGTERM"); } catch { /* 已退出 */ }
        const dl = Date.now() + 4000;
        while (Date.now() < dl && pidAlive(leftover)) sleepSync(100);
        if (pidAlive(leftover) && looksLikeBridge(leftover)) {
          try { process.kill(leftover, "SIGKILL"); } catch { /* 已退出 */ }
        }
        // 只删**刚才确认属于我们的**那个 pid（内容已核对过是 leftover）；不无条件删整份文件
        removePidFile(BRIDGE_PID_FILE, leftover);
      }
    }
    // ── C2：清扫「pid 文件之外的孤儿 bridge」（命令行校验，绝不误杀）──────────────
    //
    // pid 文件只能覆盖"上一任 watcher 写过的那个 pid"。真实世界里还有两类抓不到的孤儿：
    //   ① watcher 被 TerminateProcess / 关闭控制台收掉 → bridge 被 reparent 成孤儿继续持有隧道；
    //   ② 0.7.2 升级覆盖运行时**不停旧进程** → 旧 bridge 继续用旧脚本跑。
    // 它们与新 bridge 共用同一 deviceId → 中继 close(4000) 互踢（生产 3 台 Win 设备长期乒乓，全 0.7.2）。
    // 走到这里说明**本机此刻只有本守护**（去重已通过），所以任何"本运行时的 bridge"都是上一代的遗留。
    {
      const strays = sweepStrayBridges();
      if (strays.length) {
        console.log(`[dsh-remote] 已清扫 ${strays.length} 个孤儿 bridge 进程（pid ${strays.join(", ")}）——避免与新实例互踢。`);
      }
    }
  }
  let cfg = loadConfig();
  let warnedNoLogin = false;
  /** 当前 bridge 子进程使用的账号指纹（账号/模式/设备身份任一变化 → 重启子进程）。 */
  let bridgeAccountFp = "";
  /** C8：疑似变化但还没确认的新指纹（连续 2 轮/≥5s 才确认，防 loadConfig 静默 {} 抖动）。 */
  let pendingFp = null;
  /** C2：bridge 判为「本机已有另一个实例」后的暂停拉起截止时刻。 */
  let duplicateBridgeBackoffUntil = 0;
  /** 暂停提示只打一次，避免每 10s 刷屏。 */
  let warnedDuplicateBridge = false;
  /** 限流提示只打一次，避免刷屏。 */
  let warnedRateLimit = false;
  /** 设备绑定硬上限（bridge 退出码 5）的指数退避状态（契约 §6.4）。 */
  let bindCapBackoffStep = 0;
  let bindCapBackoffUntil = 0;
  let bindCapErrorSig = "";
  /** 退避提示只打一次，避免刷屏。 */
  let warnedBindCap = false;

  // watcher：检测 dsh web 是否存活（端口动态解析，绝不写死 3080），存活才启动 bridge。
  // 走 isDshWebUp()：探测失败会自动做一次动态发现（DSH Desktop 的 43120 / 自定义端口都靠它）。
  const checkUpstream = () => isDshWebUp(2000);

  // 先做一次动态发现再打印/派生：否则日志会长期写着错误的端口（用户实测就卡在
  // 「等待 dsh web（127.0.0.1:3080）启动...」而真实上游在 43120）。
  await refreshUpstreamDiscovery(true);
  console.log(`[dsh-remote] 等待 dsh web（${upstreamUrl()}）启动...`);
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
        console.log("⚠️ 尚未登录：请打开 dsh web → 设置 → 「远程访问」，注册/登录手机号（或切到自建模式）后自动启动。");
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
    //（2026-09-19 实测故障）。
    const fp = accountFingerprint(cfg);
    if (!childStopped(bridgeProc) && bridgeAccountFp && bridgeAccountFp !== fp) {
      // C8：**连续确认**才重启（理由见 noteFingerprintCandidate 上方的长注释）。
      // 单独一次读到 `{}`（文件被占用/半写/杀软扫描）不构成"账号变了"，下一轮自然复位。
      pendingFp = noteFingerprintCandidate(pendingFp, fp);
      if (!fingerprintChangeConfirmed(pendingFp)) {
        if (pendingFp.rounds === 1) {
          // 不打印指纹内容：它含手机号/设备 id（日志会被用户复制到群里）
          console.log("[dsh-remote] 账号配置疑似变化，先观察一轮再决定是否重启 bridge（防配置读抖动）。");
        }
        return;
      }
      pendingFp = null;
      console.log("[dsh-remote] 账号配置已变化 → 重启 bridge 让新账号生效...");
      await stopChildGracefully(bridgeProc); // 先请它优雅退出，跑完微信通道下线通知
      bridgeAccountFp = "";
      duplicateBridgeBackoffUntil = 0; // 用户明确换了账号：清掉"让位"暂停，立即用新凭据拉起
      bindCapBackoffStep = 0; bindCapBackoffUntil = 0; bindCapErrorSig = ""; // 换账号 = 绑定前提已变：设备绑定退避一并复位
      return; // 下一轮（10s 内）用新配置重新拉起
    }
    // 指纹又回到一致（或本来就没变）→ 之前的"疑似变化"作废，绝不让它跨轮累积。
    pendingFp = null;

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

    // C2：bridge 连续 2 次收到 code=4000 已判定"本机还有另一个同 deviceId 的实例"并退出（code=4）。
    // 那段时间内本守护**不再拉起**：拉起只会把对方顶掉，继续乒乓互踢。
    if (Date.now() < duplicateBridgeBackoffUntil) {
      if (!warnedDuplicateBridge) {
        warnedDuplicateBridge = true;
        console.log(`[dsh-remote] 本机已有另一个同 deviceId 的 bridge（互踢保护）→ 本守护暂停拉起约 ${Math.ceil((duplicateBridgeBackoffUntil - Date.now()) / 60000)} 分钟。`);
        console.log("   若这是升级/重装留下的旧实例，可执行 `dsh-remote doctor` 或重启一次 dsh web 让它退出。");
      }
      return;
    }
    warnedDuplicateBridge = false;

    // 设备绑定硬上限（bridge 退出码 5）：永久性失败 → 指数退避，别每 10s 空撞一次。
    // 复位：`.bind-error.json` 的内容签名变了（换账号 / 用户解绑后重试得到不同结论 / 提示被清掉）。
    // 提示只打一次；退避窗口内直接返回、不拉起 bridge（也不占用一次 device-login 额度）。
    const bindSig = bindErrorSignature();
    if (bindSig !== bindCapErrorSig) {
      if (bindCapBackoffUntil > Date.now()) {
        console.log("[dsh-remote] 设备登记失败提示已变化（解绑/换账号/服务端结论变了）→ 重置设备绑定退避，立即重试。");
      }
      bindCapErrorSig = bindSig;
      bindCapBackoffStep = 0;
      bindCapBackoffUntil = 0;
    }
    if (Date.now() < bindCapBackoffUntil) {
      if (!warnedBindCap) {
        warnedBindCap = true;
        console.log(`[dsh-remote] 设备绑定已达上限（bridge code=${DEVICE_BIND_CAP_EXIT_CODE}）→ 本守护暂停拉起约 ${Math.ceil((bindCapBackoffUntil - Date.now()) / 1000)} 秒（指数退避，最长 30 分钟）。`);
        console.log("   请在手机端「管理电脑」解绑不再使用的设备；解绑后会自动恢复，无需重启。");
      }
      return;
    }
    warnedBindCap = false;

    reconcileUpstreamEnvFromFile(); // dsh 可能刚重启并换了端口：拉起前再以最新端口文件为准
    const alive = await checkUpstream();
    if (alive && childStopped(bridgeProc)) {
      starting = true;
      // dsh 重启可能换端口（Electron 每次启动端口可能变）：拉起前**强制重新发现**，
      // 否则 discoveredUpstream 缓存旧端口 → bridge 连不上上游 → 设备掉线（2026-10-25 实测）。
      await refreshUpstreamDiscovery(true);
      console.log("[dsh-remote] dsh web 在线，启动 bridge...");
      // 清除代理环境变量（bridge 需直连 relay，不受本机代理影响）
      const childEnv = {
        ...process.env,
        DSH_BRIDGE_CONFIG: CONFIG_PATH,
        DSH_BRIDGE_TUNNEL_URL: cfg.tunnel_url,
        // 上游端口显式传给 bridge：它自己在旧版本里也回退到写死的 3080（见 dsh-bridge.mjs 的 UPSTREAM）。
        DSH_BRIDGE_UPSTREAM: upstreamUrl(),
        // 安装约定透传给 bridge（bridge 把它随设备登记请求一起上报给账号 API）
        DSH_BRIDGE_INSTALL_SOURCE: INSTALL_SOURCE,
        DSH_BRIDGE_INSTALL_VERSION: INSTALL_VERSION,
        // 宿主版本：外部注入（插件在宿主进程内问出来的），安装器只是搬运工；没有就是空串
        DSH_BRIDGE_HARNESS_VERSION: HARNESS_VERSION,
        ...(saas ? { DSH_BRIDGE_PHONE: (cfg.phone || cfg.email || ""), DSH_BRIDGE_PASSWORD: cfg.password, DSH_BRIDGE_API: apiUrl, DSH_BRIDGE_SECRET: cfg.bridge_secret || "" } : {}),
        ...(local ? { DSH_BRIDGE_LOCAL_KEY: cfg.local_key } : {})
      };
      for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
        delete childEnv[k];
      }
      // stdio 的第 4 个 fd 是 IPC 通道：Windows 上 kill() 是**无条件终止**，信号处理函数不会执行，
      // 只有它能让我们在停 bridge 之前请它跑完退出钩子（notifystop）—— 见 stopChildGracefully。
      bridgeProc = spawn(NODE_BIN,
        [path.join(THIS_DIR, "clients/dsh-remote/dsh-bridge.mjs")],
        {
          env: nodeEnv(childEnv),
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          // 🔴 C1 黑窗根治（2026-10-20 诊断 W1，生产截图 04）：这里**必须**带 windowsHide。
          // 原理同 spawnDetachedBridge 的注释：watcher 自己常以"无控制台"方式被拉起
          //（launchd / 任务计划里的 wscript / 插件的 detached spawn）。无控制台的父进程
          // spawn 一个控制台程序（node.exe）却不给 CREATE_NO_WINDOW 时，Windows 会**为子进程
          // 新分配一个可见控制台窗口**；而 bridge 的 stdout/stderr 又被 watcher 指向日志文件，
          // 于是用户看到的就是一个**空白黑窗**。bridge 崩溃 → watcher 每 10s 重拉 → 每 10s 弹一个。
          // POSIX 上该选项被忽略。
          windowsHide: true
        });
      // 记下这个子进程的 pid：退出钩子删 pid 文件时必须核对归属（见 removePidFile 注释）。
      // 为什么不能直接用 bridgeProc.pid：bridgeProc 之后会被下一次 spawn 覆盖，而旧子进程的
      // exit 回调仍会跑 —— 那时若去删"当前"pid 文件，就会把新实例的 pid 文件删掉。
      const spawnedBridgePid = bridgeProc.pid;
      bridgeProc.on("exit", (code) => {
        // ⚠️ 只删**属于这个子进程**的 pid 文件（内容 == 它的 pid）。
        // 旧实现无条件删：新 bridge 撞本地实例锁秒退（code=4）是**常态事件**，每次都把
        // 真正活着的那条 bridge（孤儿）的 pid 文件删掉 → 面板「bridge 未运行」→ 反复重启
        // → bridge_wedged。这是 2026-10 事故根因链的第 2 步。
        removePidFile(BRIDGE_PID_FILE, spawnedBridgePid);
        // C2 互踢根治的 watcher 半边：bridge 连续 2 次收到 code=4000（= 本机已有同 deviceId 的
        // 另一个 bridge 把本连接顶掉）后会以"重复实例"退出码优雅退出（见 dsh-bridge.mjs）。
        // 这种退出**绝不能**照常 10s 重拉：本机已经有另一个实例在跑，重拉只会继续乒乓互踢。
        if (code === DUPLICATE_INSTANCE_EXIT_CODE) {
          // 🔴 2026-10-25：升级/重启后常见「上一代 bridge 变成孤儿继续占着单实例锁」，
          //   新 bridge 因此退出 code=4。旧逻辑一律暂停 5 分钟 → 设备在线要等 5 分钟（用户实测掉线）。
          //   现在先**清扫同运行时的孤儿 bridge**；扫到了说明冲突已解除，3 秒后立即重试；
          //   扫不到（多半真有另一个 watcher 的活实例）才按 5 分钟退避，避免乒乓互踢。
          let swept = [];
          try { swept = sweepStrayBridges(); } catch { /* 清扫失败不致命 */ }
          if (swept.length > 0) {
            duplicateBridgeBackoffUntil = Date.now() + 3000;
            console.log(`[dsh-remote] bridge 因同实例冲突退出（code=${code}），已清扫 ${swept.length} 个孤儿 bridge（pid ${swept.join(", ")}）→ 3 秒后重试。`);
            return;
          }
          duplicateBridgeBackoffUntil = Date.now() + DUPLICATE_BRIDGE_BACKOFF_MS;
          console.log(`[dsh-remote] bridge 检测到同 deviceId 的另一个实例并退出（code=${code}）——本守护暂停 ${Math.round(DUPLICATE_BRIDGE_BACKOFF_MS / 60000)} 分钟后再试，避免两个实例反复互踢。`);
          return;
        }
        // 设备绑定硬上限（退出码 5，契约 §6.3/§6.4）：永久性失败 → 指数退避重试，
        // 绝不沿用"10s 后照常重拉"（那会每 10s 撞一次 409，日志刷屏且白耗登录额度）。
        if (code === DEVICE_BIND_CAP_EXIT_CODE) {
          const sig = bindErrorSignature();
          if (sig && sig !== bindCapErrorSig) {
            bindCapErrorSig = sig;
            bindCapBackoffStep = 1;
            console.log("[dsh-remote] 设备绑定失败提示已变化 → 重置设备绑定退避。");
          } else {
            bindCapBackoffStep = Math.min(bindCapBackoffStep + 1, 99);
          }
          const waitMs = bindCapBackoffMs(bindCapBackoffStep);
          bindCapBackoffUntil = Date.now() + waitMs;
          warnedBindCap = false;
          console.log(`[dsh-remote] bridge 因设备绑定达到硬上限退出（code=${code}，第 ${bindCapBackoffStep} 次）——本守护 ${Math.round(waitMs / 1000)} 秒后再试（指数退避，最长 30 分钟）。`);
          console.log("   请在手机端「管理电脑」解绑不再使用的设备；解绑后自动恢复，无需重启。");
          return;
        }
        console.log("[dsh-remote] bridge 退出，等待重启...");
      });
      // Windows：落 pid 文件，供插件半发现进程（Windows 没有 pgrep/ps）。
      // 插件半启动 bridge 走的就是本函数，所以这里写一次两边都覆盖到。
      writePidFile(BRIDGE_PID_FILE, bridgeProc.pid); // 供插件半发现进程（Windows 无 pgrep；POSIX 用于脱离进程兜底的去重）
      bridgeAccountFp = fp; // 记下这个子进程用的是哪套凭据，配置一变就重启它
      setTimeout(() => { starting = false; }, 5000);
    } else if (!alive && bridgeProc && bridgeProc.exitCode === null) {
      console.log("[dsh-remote] dsh web 离线，停止 bridge...");
      // dsh 重启后端口可能变化：清掉进程内缓存，下一轮优先用插件新写的端口文件探测
      discoveredUpstream = "";
      await stopChildGracefully(bridgeProc); // 同上：Windows 上 kill() 跑不到退出钩子
    }
  };

  // watcher 自身的 pid 也要落盘（插件半据此判断"守护在跑"并避免重复拉起）
  {
    writePidFile(WATCHER_PID_FILE, process.pid);
    /**
     * 退出清理：**只删属于自己的 pid 文件**。
     * watcher 文件属于本进程；bridge 文件属于**本进程拉起的那个子进程**。
     * 无条件删（旧行为）会把孤儿/别的实例的 pid 文件删掉 → 状态变成「进程还活着、pid 文件没了」，
     * 正是本次事故根因链的第 2 步；失败方向必须是"残留一份过期文件"（插件按 pidAlive 会判掉），
     * 而不是"删掉别人活着的证据"。
     */
    const cleanup = () => {
      removePidFile(WATCHER_PID_FILE, process.pid);
      const childPid = bridgeProc && bridgeProc.pid;
      if (Number.isInteger(childPid) && childPid > 0) removePidFile(BRIDGE_PID_FILE, childPid);
    };
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
      try {
        process.on(sig, () => {
          // 先请 bridge 优雅退出，再给自己留出它跑完退出钩子（notifystop）的时间。
          // 尤其重要：Windows 上 kill() 是无条件终止，bridge 根本没有机会做收尾。
          if (bridgeProc && bridgeProc.connected) {
            try { bridgeProc.send({ type: "shutdown" }); } catch { /* 通道已断，只能随父进程一起被回收 */ }
          }
          cleanup();
          // 🔴 但**只"请"是不够的**（2026-09-23 真机 bug：一条微信指令回两条）：
          //    bridge 此刻常正卡在 35s 的 getUpdates 长轮询里，3 秒根本退不完；
          //    老 watcher 一 exit，子进程就被 reparent 成孤儿、继续轮询同一个微信账号 →
          //    与新 bridge 抢消息（一条被消费两次、回两条）。所以退出前必须**确保它真的死了**。
          setTimeout(() => {
            if (bridgeProc && bridgeProc.exitCode === null) {
              try { bridgeProc.kill("SIGTERM"); } catch { /* 已退出 */ }
            }
          }, 1500);
          setTimeout(() => {
            if (bridgeProc && bridgeProc.exitCode === null) {
              try { bridgeProc.kill("SIGKILL"); } catch { /* 已退出 */ }
            }
            // C2：退出时顺手清掉本运行时的全部 bridge 残留（fast：不等待）。
            // 否则 Windows 上 watcher 被收掉后 bridge 可能成孤儿、继续与新实例互踢。
            try { sweepStrayBridges({ fast: true }); } catch { /* 清扫失败不影响退出 */ }
            process.exit(0);
          }, 3000);
        });
      } catch { /* 该信号在本平台不可注册 */ }
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
  // 接入标识（可选）：本次带合法 `--ref <数字>`（或环境变量 DSH_REF）才写入；没带/非法 →
  // **保留**配置里已有的值。⚠️ saveConfig 是整对象覆盖写，所以必须在刚 loadConfig() 的这份
  // 对象上合并再写回 —— 绝不能新建对象，否则升级装一次就把上一次的归因清空了。
  // 非法值静默忽略：归因是附加信息，绝不能因此让安装失败。
  cfg = applyRefCodeToConfig(cfg, argv);

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
    // ⚠️ 顺序要紧：**先**探测并钉住上游，**再**写自启动文件 ——
    // 否则 plist 里不会带上 DSH_BRIDGE_UPSTREAM（实测踩到：打印说已钉住，plist 里却没有）。
    try {
      const pluginTargets = targetProfileDirs(argv);
      if (!PINNED_UPSTREAM && pluginTargets.some((t) => t.name === "desktop")) {
        const p = desktopAppPort();
        if (p) {
          // 🔴 2026-10-25：这里只能写运行时端口文件；**不能**回填 PINNED_UPSTREAM ——
          // 它会被写进 launchd plist 变成永久显式指定，dsh 换端口后守护/桥永远连旧端口
          // （用户实测 upstream_unreachable）。
          try { fs.writeFileSync(path.join(CONFIG_DIR, UPSTREAM_FILE), `http://127.0.0.1:${p}` + "\n"); } catch { /* 忽略 */ }
          console.log(`ℹ 桌面端在 127.0.0.1:${p} 监听 → 已写入运行时上游端口（不再钉进自启动配置）`);
        }
      }
    } catch { /* 探测失败不阻断安装 */ }
    svc = installAutostart();
  } else {
    console.log("ℹ --no-autostart：跳过自启动服务安装（可用 `dsh-remote run` 手动运行 bridge）。");
  }
  const st = svc.status;

  // 自动安装 dsh web 插件（非致命：失败只提示，不阻断安装）
  let pluginResult = null;
  if (!noPlugin) {
    try {
      // ⚠️ 必须把 `--profile` **透传下去**：否则 `--profile desktop`（桌面端）会被静默忽略，
      // 插件装进 Web 版 profile，而用户面对的是桌面端 —— 面板永远不出现。
      // 未指定 --profile 时目标是本机全部 profile：桌面端提醒与后续判定都要按同一份列表来
      const pluginTargets = targetProfileDirs(argv);
      for (const t of pluginTargets) warnIfDesktopProfile(t.dir);
      pluginResult = await pluginCmd(profileArgvOf(argv));
    } catch (e) {
      console.warn(`⚠️ 插件安装未完成：${e.message}`);
    }
  }

  // 插件是**进程启动时**装载的：刚装进 profile 的插件，运行中的 dsh web 里并没有
  // （既没有 /dsh-remote/* 路由，也没有「设置 → 远程访问」面板项）。
  // 这里做一个确定性判断：进程启动时间早于插件落盘时间 → 必须重启 dsh web 才生效。
  const primaryProfileDir = targetProfileDirs(argv)[0].dir;   // desktop 优先 = 用户面对的那个宿主
  const pluginDir = path.join(primaryProfileDir, PLUGIN_LOCAL_DIR);
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
        const r = await fetch(upstreamUrl() + "/dsh-remote/self", { signal: AbortSignal.timeout(900) })
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
    console.log("  所以「设置 → 远程访问」面板暂时还没出现。正在为你重启 dsh web（2 秒后执行，Ctrl-C 可跳过）…");
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
  // 服务状态字符串是给插件面板解析的稳定契约(running / 未运行),不要改约定。
  // 三分支:running / 未运行(有原因) / 未安装(跳过或平台不支持)——最后一种既不能显示"运行中",
  // 也不能显示"未运行(原因)",它压根没装(此前会打出自相矛盾的"(当前平台不支持) — ✅ 运行中")。
  const svcSkipped = st.status === "skipped" || st.status === "unsupported" || !svc.path;
  // 第三态:起来了、但本机 launchd 不保证崩溃自愈(on-demand-only 的 gui domain 只能靠 kickstart 拉起),
  // 必须与"完全正常"分开说 —— 否则用户以为有自启,进程一崩就永久掉线且找不到原因。
  // Windows 没有 launchd，这条判断对它不成立（否则会把 win32 误报成"本机不支持崩溃自愈"）。
  const svcFragile = !IS_WIN && !svcSkipped && st.ok && st.selfHealing === false;
  const svcDegraded = st.status === "degraded-detached";
  // Windows：自启动 = 任务计划程序里的登录任务。约定与 macOS/Linux 不同
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
    L.push(`   远程访问地址: ${pub.app_url || DEFAULT_APP_URL}`);
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
    L.push("          再打开 设置 → 「远程访问」→ 注册/登录手机号即可。");
  } else if (needRestart && restartResult && restartResult.ok) {
    L.push("");
    L.push("   下一步: dsh web 已重启，直接打开 " + upstreamUrl() + " → 设置 → 「远程访问」→ 注册/登录手机号。");
  } else if (needRestart && pluginResult && pluginResult.hotPatch && pluginResult.changed) {
    // patch 已写入但探测窗口内没等到面板接口:热加载很可能还在进行(插件节点半启动+注册路由)。
    // 这种情况**不能**直接让用户重启 —— 先让他等几秒刷新,再给兜底方案。
    L.push("");
    if (runningSeen) {
      L.push(`ℹ 插件已按热加载方式登记，但运行中的 dsh web 仍在用旧版本（${runningSeen} → 期望 ${pkgVersion()}）：`);
      L.push("   刷新页面即可（浏览器半会跟着更新）；若刷新后功能仍不对，再重启一次 dsh web。");
    } else {
      L.push("ℹ 插件已按热加载方式登记（patch 已写入），若「设置 → 远程访问」还没出现：");
      L.push("   等几秒后刷新页面即可；仍未出现再重启一次 dsh web（命令见 README）。");
    }
  } else if (needRestart) {
    // 需要重启但没做成功:必须给出**可照抄**的命令,而不是只说"请重启"
    L.push("");
    L.push("⚠️ 还需要重启一次 dsh web，插件面板才会出现（插件只在进程启动时装载）。");
    L.push("   请手动执行（任选其一）：");
    L.push("     launchctl kickstart -k gui/$(id -u)/com.dshweb.dev     # 用 launchd 托管时");
    L.push(`     kill $(lsof -ti tcp:${upstreamPort()} -sTCP:LISTEN) && dsh web --no-open   # 手动启动时`);
    L.push(`   重启后：打开 ${upstreamUrl()} → 设置 → 「远程访问」→ 注册/登录手机号。`);
  } else {
    L.push("");
    L.push("   下一步: 打开 dsh web → 设置 → 「远程访问」→ 注册/登录手机号即可（无需任何命令）。");
  }
  console.log("\n" + L.join("\n") + "\n");
}

// ---------- plugin：安装/卸载 dsh web 远程访问插件 ----------
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
 * 解析 patch 文本里的 insert 行 id（与 dshmarket 同约定的极简解析，不引 YAML 依赖）。
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
  // ★★ 稳定形态 = **只由 `dsh.profile.bundles` 激活**,我们**不再往 patch 里写激活行**。
  //
  // 2026-09-22 实测故障:`duplicate loader entry id: dsh-remote-web` →
  //   `dsh: plugin tree failed to load` → **dsh web 启动即挂**(用真实启动复现)。
  // 根因是**两处激活同时存在**:
  //   (a) 插件自带的 bundle 在 `package.json` 的 `dsh.profile.bundles` 里;
  //   (b) 我们写进 profile `cordis.patch.yml` 的激活行又声明了同一个 id。
  //
  // 旧实现走的是**反方向**——"删 bundles 条目、留 patch 行"(见下方已删的 removeBundleEntry 调用),
  // 还为此写了复杂的回滚。但**自动维护流程会把插件自带 bundle 周期性写回**,
  // 于是"删了又回来"→ 又变两处 → 再次崩。只要方向是反的,这个 bug 就会反复出现。
  //
  // 所以现在改成:**bundle 归包管理器/维护流程管,我们绝不动它**;
  // 我们只保证自己**不再制造第二个激活点**,并顺手把历史遗留的重复 patch 行清掉。
  const inBundles = pkgBundles();
  if (inBundles.length) {
    const stripped = stripPluginEntries(original);
    if (stripped !== original) {
      writePatchDocument(patchFile, stripped);
      console.log("✅ 已移除 profile patch 中与本插件重复的激活行（激活统一走 dsh.profile.bundles，避免 duplicate id 崩树）");
      return { ok: true, changed: true, bundleOnly: true, basePatch: original };
    }
    return { ok: false, reason: "插件已由 dsh.profile.bundles 声明（保持单一激活点，不写 patch 行）", changed: false, bundleOnly: true, basePatch: original };
  }
  // 到这里说明 bundles 里没有本插件 —— 此时 patch 行是**唯一**激活点,必须写(升级/热加载场景)。
  // `forcePatch` 仍然保留语义:它只影响"bundles 为空时"的行为,不再能覆盖上面那条硬约束。
  const base = validatePatchBase(original);
  if (!base.ok) return { ok: false, reason: base.reason, changed: false, basePatch: original };
  const hasOurRow = base.insertedIds.some((id) => PLUGIN_ALL_IDS.includes(id));
  if (hasOurRow) {
    // ⚠️ 走到这里说明 **bundles 里没有本插件**(上面 inBundles 为空的早退已排除两处激活的形态),
    //   所以 patch 行就是唯一激活点,可以安心保留它 —— 这里**不再**去动 bundles。
    //   (旧实现在这里调 removeBundleEntry,方向是反的:见本函数顶部注释。)
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
    return { ok: true, changed: false, basePatch: original };
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
  // ⚠️ 这里**不再** removeBundleEntry:能走到这行说明 bundles 里本来就没有本插件
  //   (inBundles 为空的早退已保证),删是空操作;而且方向是反的 —— 见函数顶部注释。
  //   写前/写后双校验已经确保"我们的 id 在 patch 里恰好一次",这就是唯一激活点。
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
 * 插件目录里**必须存在且非空**的文件。缺任何一个都说明这次拷贝是"半个插件"。
 *
 * 🔴 为什么必须有这一步（2026-09-26 23:46 真实故障）：当时是"先 rmSync 整个 dest、再逐文件 cpSync"，
 *    而 dsh 恰好在这个空窗里启动 → `package.json` 已经声明 bundle，但 `cordis.patch.yml` 还没拷到
 *    → dsh 读 overlay 直接 `ENOENT: no such file or directory` 退出，**整个 GUI 起不来**：
 *
 *        Error: dsh: failed to read overlay
 *        .../node_modules/dsh-remote-web/cordis.patch.yml: ENOENT
 *
 *    拷贝完成时间 23:46:05，dsh 报错时间 23:46:03 —— 差 2 秒。
 *    所以"拷完必须先自检，再切换"不是优化，是**防止宿主起不来**的硬闸门。
 */
const PLUGIN_REQUIRED_FILES = ["package.json", "lib/index.js", "lib/client.js", "cordis.patch.yml"];

/** 校验某个插件目录是否"完整可加载"；返回缺失/为空的相对路径数组（空数组 = 通过）。 */
function missingPluginFiles(dir) {
  const missing = [];
  for (const rel of PLUGIN_REQUIRED_FILES) {
    try {
      const st = fs.statSync(path.join(dir, rel));
      if (!st.isFile() || st.size === 0) missing.push(`${rel}(空)`);
    } catch {
      missing.push(rel);
    }
  }
  return missing;
}

/**
 * 把插件整目录拷贝进 profile 的固定子目录并返回该目录。
 * 源(本包 packages/${PLUGIN_ID})可能在 npx 临时缓存里,因此必须拷到 profile 内持久化,
 * include 用相对路径直接指向拷贝出的入口,不写依赖、不跑任何包管理器。
 *
 * 🔴 **原子覆盖（2026-09-26 故障后的硬要求）**：
 *   1. 先整份拷到同级的 `.staging-<pid>`，**全程不碰 dest** —— dsh 任何时刻读到的
 *      要么是完整的旧版、要么是完整的新版；
 *   2. 拷完**校验**必需文件（见 `PLUGIN_REQUIRED_FILES`），不通过就丢弃 staging、抛错、
 *      **保留旧版可用**；
 *   3. 再 `renameSync` 原子切换（同目录内 rename 是原子操作，空窗只有两次 syscall 之间，
 *      相比旧实现"整个拷贝过程都处于半空状态"是数量级的改善）；
 *   4. 切换失败 → 立刻把 backup 改回 dest；成功 → 删 backup。
 *
 * 另外清掉上次被强杀留下的 `.staging-*` / `.backup-*`，不留垃圾。
 */
// ── 桌面端「暫存安装」：应用运行中不能改写它的 profile（会把它弄退出/重启），
// 但用户点「一键更新」必须能装到桌面端。做法：先整份拷到 ~/.dsh-remote/pending-plugin/ 并写 marker，
// 由常驻的 bridge 在检测到应用退出后自动原子替换 profile 内的插件目录（见 dsh-bridge.mjs）。
const PENDING_PLUGIN_MARKER = path.join(CONFIG_DIR, ".plugin-update-pending.json");
const PENDING_PLUGIN_DIR = path.join(CONFIG_DIR, "pending-plugin");

/** 暂存一份插件更新（供 bridge 在应用退出后安装）。返回 marker 对象。 */
function stagePluginUpdateForProfile(profileDir, pluginDir) {
  fs.rmSync(PENDING_PLUGIN_DIR, { recursive: true, force: true });
  fs.mkdirSync(PENDING_PLUGIN_DIR, { recursive: true });
  const cpOpts = {
    recursive: true,
    filter: (src) => {
      if (src === pluginDir) return true;
      const rel = String(path.relative(pluginDir, src));
      const segs = rel.split(path.sep);
      if (segs.some((seg) => seg === ".git" || seg === ".DS_Store")) return false;
      const inBundledRuntime = segs[0] === "runtime";
      if (!inBundledRuntime && segs.some((seg) => seg === "node_modules")) return false;
      return true;
    }
  };
  fs.cpSync(pluginDir, PENDING_PLUGIN_DIR, cpOpts);
  for (const rel of PLUGIN_REQUIRED_FILES) {
    const f = path.join(PENDING_PLUGIN_DIR, rel);
    if (!fs.existsSync(f)) throw new Error(`暂存校验失败：缺少 ${rel}`);
  }
  const version = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8")).version;
  const marker = {
    version,
    profileDir,
    pluginDirName: PLUGIN_LOCAL_DIR,
    stageDir: PENDING_PLUGIN_DIR,
    stagedAt: Date.now()
  };
  fs.writeFileSync(PENDING_PLUGIN_MARKER, JSON.stringify(marker, null, 2) + "\n");
  return marker;
}

function copyPluginIntoProfile(profileDir, pluginDir) {
  // 清理历史名残留目录（≤0.4.9 的 dsh-remote-ui-plugin），避免与新版并存
  for (const id of PLUGIN_LEGACY_IDS) {
    try { fs.rmSync(path.join(profileDir, `${id}-plugin`), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const dest = path.join(profileDir, PLUGIN_LOCAL_DIR);
  const stage = `${dest}.staging-${process.pid}`;
  const backup = `${dest}.backup-${process.pid}`;
  const cpOpts = {
    recursive: true,
    // 注意：插件源(npx 缓存 / npm 全局)本身就位于某个 node_modules 之下，
    // 过滤必须基于“相对插件目录”的路径片段，绝不能整条 src 路径包含判断，
    // 否则会把插件文件全过滤掉、拷出空目录(此前反复“插件入口缺失”的总根因)。
    //
    // 🔴 2026-10-10 修：**插件自带的 runtime/node_modules 不能被剔掉**。
    //   旧规则是"任何一段叫 node_modules 就过滤"，这条原本只想剔掉插件自己的依赖目录
    //   （那些由 profile 的包管理器管），却把 `runtime/node_modules/ws` 一起剔了 ——
    //   而那份运行时正是"只有插件半"的机器**自愈补装时的来源**。剔掉它 = 自愈出来的运行环境
    //   缺 ws（bridge 顶层 `import WebSocket from "ws"`）→ 一启动就崩，还"自检通过"。
    //   现在：`runtime/` 之内一律保留；只过滤 runtime 之外的 node_modules。
    filter: (src) => {
      if (src === pluginDir) return true;
      const rel = String(path.relative(pluginDir, src));
      const segs = rel.split(path.sep);
      if (segs.some((seg) => seg === ".git" || seg === ".DS_Store")) return false;
      const inBundledRuntime = segs[0] === "runtime";
      if (!inBundledRuntime && segs.some((seg) => seg === "node_modules")) return false;
      return true;
    }
  };

  // 0) 清掉上次被强杀（或本次同 pid 重入）留下的临时目录
  for (const d of [stage, backup]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

  // 1) 拷到 staging —— **绝不动 dest**
  try {
    fs.cpSync(pluginDir, stage, cpOpts);
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`插件拷贝失败（已保留原目录不动）：${e && e.message ? e.message : e}`);
  }

  // 2) 自检：必需文件一个都不能少（这一步就是 23:46 那次故障的闸门）
  const missing = missingPluginFiles(stage);
  if (missing.length > 0) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(
      `插件拷贝不完整，缺少必需文件：${missing.join("、")}（已保留原目录不动，避免宿主读 overlay 失败起不来）`
    );
  }

  // 3) 原子切换
  try {
    if (fs.existsSync(dest)) fs.renameSync(dest, backup);
    try {
      fs.renameSync(stage, dest);
    } catch (e) {
      if (fs.existsSync(backup)) { try { fs.renameSync(backup, dest); } catch { /* 尽力回滚 */ } }
      throw e;
    }
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* ignore */ }
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`插件切换失败（旧版仍在原位）：${e && e.message ? e.message : e}`);
  }
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
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000, windowsHide: true, env: nodeEnv() });
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
 * 把我们手上这份插件包落到 profile 并激活。
 *
 * ★ 2026-09-22 方向反转：激活点**优先由 `dsh.profile.bundles` 承担**，我们不再写 patch 行。
 *   旧实现为了"装完即热加载"而摘掉 bundles、改走 patch 行；但**自动维护流程会把插件自带
 *   bundle 周期性写回** bundles，于是"删了又回来"→ 两处激活 → dsh web 启动即
 *   `duplicate loader entry id: dsh-remote-web` 崩树。
 *   现在稳定方向 = **bundle 归包管理器管、我们不动它**；代价是失去热加载，
 *   由**安装器随后触发的重启**来让新版生效（`hotPatch:false` → 调用方会重启）。
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
  // ⚠️ 顺序与"失败即中止"都是刻意的（0.6.7-beta.1 Windows 实测故障）：
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
    // 走到这里 = 插件**不在** bundles,所以 patch 行是唯一激活点,可以热加载。
    console.log(`✅ 插件已就绪: ${pluginLocalDir}（激活点为本插件的 patch 行，装完即热加载）`);
    return { hotPatch: true, changed: r.changed, basePatch: r.basePatch };
  }
  if (r.bundleOnly) {
    // 稳定形态：bundle 归包管理器管，我们不写第二个激活点。代价是无热加载 → 调用方会重启。
    console.log("ℹ 插件已由 dsh.profile.bundles 激活（保持单一激活点，不重复写 patch 行；重启后生效）");
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
  const targets = targetProfileDirs(argv);
  const multi = targets.length > 1;
  if (multi) {
    console.log(`ℹ 未指定 --profile：同步到本机**全部 ${targets.length} 个 profile**（${targets.map((t) => t.name).join(" → ")}）`);
  }
  let last = null;
  let ok = 0;
  let skippedRunning = 0;
  let stagedRunning = 0;
  const force = hasFlag(argv, "--force");
  for (const t of targets) {
    // ⚠️ 桌面应用在运行时**绝不改写它的 profile**：应用会因此退出/重启（2026-10-11 实测故障）
    if (t.name === "desktop" && !force && dshDesktopAppRunning()) {
      console.log(`⚠️ DeepSeek Harness 应用正在运行 → 不直接改写它的 profile（会把它弄退出/重启）。`);
      try {
        const staged = stagePluginUpdateForProfile(t.dir, path.join(THIS_DIR, "packages", PLUGIN_ID));
        stagedRunning += 1;
        console.log(`   ✅ 新版本 ${staged.version} 已暂存：**退出 DeepSeek Harness 后会自动安装**，重新打开应用即生效（无需终端）。`);
      } catch (e) {
        console.log(`   ⚠️ 暂存失败：${e && e.message ? e.message : e}`);
        console.log(`   请完全退出应用后重跑本命令，或在应用内「插件」页安装/更新 dsh-remote-web。`);
        skippedRunning += 1;
      }
      continue;
    }
    if (multi) console.log(`\n── profile: ${t.name}（${t.dir}）`);
    const r = await pluginApplyTo(t.dir, uninstall, multi);
    if (r === "skip") continue;
    ok += 1;
    if (r !== undefined && r !== null) last = r;
  }
  if (ok === 0 && skippedRunning === 0) process.exit(1);
  if (stagedRunning > 0) console.log(`ℹ 桌面端插件已暂存（${stagedRunning} 个）：退出 DeepSeek Harness 后由后台服务自动安装，重开应用生效。`);
  if (skippedRunning > 0) console.log(`ℹ 本次跳过了 ${skippedRunning} 个 profile（应用在运行）；桥与运行环境不受影响。`);
  return last;
}

/** 对**单个** profile 执行插件安装/卸载（原 pluginCmd 主体，逐字保留行为）。 */
async function pluginApplyTo(profileDir, uninstall, multi) {
  const pkgFile = path.join(profileDir, "package.json");
  const patchFile = path.join(profileDir, "cordis.patch.yml");
  const pluginDir = path.join(THIS_DIR, "packages", PLUGIN_ID);

  if (!fs.existsSync(pkgFile) || !fs.existsSync(patchFile)) {
    console.error(`${multi ? "⚠️ 跳过（未找到 profile）" : "❌ 未找到 profile"}（${profileDir}）。`);
    if (isDesktopProfileDir(profileDir)) {
      // 桌面端 profile 由 Electron 应用**自己初始化**：npm 版 `dsh` 明确拒绝管理它
      // （apps/cli 的 rejectElectronProfile），所以 Web 版那句 "npx @deepseek-ai/dsh web"
      // 在桌面端**不成立**，照抄只会让用户白折腾。这里必须给桌面端专属的三步。
      console.error("   桌面端 profile 由 DeepSeek Harness 应用自己创建，不能像 Web 版那样用 npx 造出来：");
      console.error("   ① 先启动一次 DeepSeek Harness 应用，让它初始化该 profile；");
      console.error("   ② 完全退出应用（应用独占该 profile，运行中安装不会被装载）；");
      console.error("   ③ 再执行本次安装：dsh-remote --profile desktop");
      console.error("   更省事的官方路径：直接在应用内「插件」页安装 dsh-remote-web。");
    } else {
      console.error("   请先安装 DeepSeek Harness（npx @deepseek-ai/dsh web）并初始化默认 profile。");
    }
    if (multi) return "skip";
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
/**
 * `dsh-remote doctor` —— **一条命令回答「为什么连不上」**（只读，不改任何东西）。
 *
 * 【为什么产品上必须有它】2026-09-25 排查两条用户反馈（fb_7b4ee6ec9862 / fb_4cc2c9df749c）时，
 * 判断"bridge 到底有没有被拉起来"花了大量时间，而且**只能靠翻日志行数估时间** ——
 * 因为当时的日志连时间戳都没有，用户端也没有任何一个入口能把
 * 「上游端口 / 守护状态 / 事件订阅 / 待补发队列」一次性说清楚。
 * 那两个用户都是 linux + 「starting / bridge 未运行」，而我们的自愈当时在 Linux 上**根本没有实现**
 * （见 0.6.15 的 startBridgeLinux）：如果有一份这样的自检，用户自己 10 秒就能看出问题在哪。
 *
 * 输出四段：① 身份与版本 ② 上游（含来源与探测结论） ③ 进程与自启动 ④ 通道（微信/加密/待补发）
 * ⑤ 日志尾部（带时间戳）。任何一项失败都只影响那一行，绝不中断整份自检。
 *
 * @param {string[]} argv 额外参数（--profile <dir> 透传给插件挂载诊断）
 */
async function doctorCmd(argv = []) {
  const mask = (s) => (s ? String(s).slice(0, 3) + "****" + String(s).slice(-2) : "");
  const ms = (t) => (t ? new Date(Number(t)).toISOString().replace("T", " ").slice(0, 19) : "-");
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
  };

  console.log("dsh-remote 自检（doctor，只读，不改任何东西）");
  // 平台：若被 DSH_SETUP_PLATFORM 覆盖（仅测试用），如实标注 —— 否则"平台 darwin 却走了 win32 扫描"会非常难解释
  const platformLabel = SETUP_PLATFORM === process.platform
    ? `${process.platform}/${process.arch}`
    : `${SETUP_PLATFORM}/${process.arch}（DSH_SETUP_PLATFORM 覆盖；实际 ${process.platform}）`;
  console.log("时间:", new Date().toISOString(), "| 平台:", platformLabel, "| node:", process.version);
  console.log("配置目录:", CONFIG_DIR);

  // ── ① 插件与运行环境版本 ────────────────────────────────────────────────
  const pluginPkg = readJson(path.join(CONFIG_DIR, "node_modules", PLUGIN_ID, "package.json"))
    || readJson(new URL("./packages/dsh-remote-web/package.json", import.meta.url));
  const setupVersion = readText(path.join(CONFIG_DIR, ".dsh-setup-version")).trim();
  console.log("\n① 版本");
  console.log(`   插件        : ${pluginPkg && pluginPkg.version ? "v" + pluginPkg.version : "（读不到）"}`);
  console.log(`   运行环境     : ${setupVersion ? "v" + setupVersion : "（未固化 / 未知）"}`);
  console.log(`   运行环境入口 : ${fs.existsSync(runtimeSetupPath()) ? runtimeSetupPath() : "缺失！"}`);
  try {
    const profileDir = resolveProfileDir(argv);
    if (fs.existsSync(path.join(profileDir, "package.json"))) printPluginDiagnostics(profileDir);
    else console.log(`   [plugin]  未找到 profile（${profileDir}）`);
  } catch (e) { console.log(`   [plugin]  诊断失败：${e.message}`); }

  // ── ② 上游 dsh web（bridge 要连的那个本机地址） ──────────────────────────
  console.log("\n② 上游 dsh web");
  const hint = resolveUpstreamHint({ relayDir: CONFIG_DIR });
  const probed = await discoverUpstream({ relayDir: CONFIG_DIR, log: (m) => console.log(`   ${m}`) });
  console.log(`   提示来源     : ${hint.url ? `${hint.url}（${hint.source}）` : "（无）"}`);
  console.log(`   最终采用     : ${probed.url}（${probed.source}）`);
  console.log(`   身份校验     : ${probed.source === "fallback" ? "⚠️ 未找到在听的 dsh web（会一直重试）" : "✅ 已确认为本机 dsh web"}`);
  if (probed.probed && probed.probed.length) console.log(`   探测过的端口 : ${probed.probed.join(", ")}`);

  // ── ③ 守护与 bridge 进程 ───────────────────────────────────────────────
  console.log("\n③ 进程与自启动");
  const watcherPid = readPidFile(WATCHER_PID_FILE);
  const bridgePid = readPidFile(BRIDGE_PID_FILE);
  console.log(`   watcher pid  : ${watcherPid || "-"}${watcherPid ? (alive(watcherPid) ? "（在跑）" : "（已死，pid 文件过期）") : ""}`);
  console.log(`   bridge pid   : ${bridgePid || "-"}${bridgePid ? (alive(bridgePid) ? "（在跑）" : "（已死，pid 文件过期）") : ""}`);
  // 进程扫描（平台各自的方式）：只报**扫描拿到的真实数据**；扫不到就说"扫描不可用"。
  //
  // 🔴 旧实现是本次「假证据」的直接来源：Windows 侧用
  //   `tasklist /FI "IMAGENAME eq node.exe" /FO CSV` 拿镜像名列表，再用
  //   /dsh-setup\.mjs/、/dsh-bridge\.mjs/ 去过滤 **CSV 行** —— 而 tasklist 的输出里
  //   **根本没有命令行**，于是两个计数在 Windows 上**恒为 0/0**，与真实情况毫无关系。
  //   2026-10 那次排查正是被这条"证据"带向「进程真的没起来」的错误方向。
  // 现在：Windows 复用 CIM 全量枚举（windowsCimProcesses，**带 CommandLine、不按镜像名过滤**），
  //   按命令行分别统计 watcher / bridge，并打出 pid + 解释器名 + 命令行摘要；
  //   扫描不可用（没 PowerShell / 超时 / 命令失败）时**显式打印「扫描不可用」**，
  //   绝不输出一个会被误读成"没有进程"的 0。
  try {
    if (IS_WIN) {
      const procs = windowsCimProcesses();
      if (!procs) {
        console.log("   实测进程     : 扫描不可用（PowerShell/CIM 取不到进程列表：可能没装 PowerShell、被策略禁用或超时）");
        console.log("   ⚠️ 这条**不能**当作「进程没在跑」的证据 —— 只看上面的 pid 文件结论与日志尾部。");
      } else {
        const watchers = procs.filter((p) => /dsh-setup\.mjs/.test(p.cmd));
        const bridges = procs.filter((p) => /dsh-bridge\.mjs/.test(p.cmd)).filter((p) => !/dsh-setup/.test(p.cmd));
        console.log(`   实测进程     : watcher ${watchers.length} 个 / bridge ${bridges.length} 个（CIM 全量扫描，按命令行识别）`);
        for (const [kind, list] of [["watcher", watchers], ["bridge", bridges]]) {
          for (const p of list) {
            const brief = p.cmd.length > 160 ? `${p.cmd.slice(0, 157)}...` : p.cmd;
            console.log(`   · ${kind} pid=${p.pid} 解释器=${p.name || "?"} 命令行=${brief || "（取不到）"}`);
          }
        }
        if (watchers.length && !bridges.length) console.log("   ⚠️ 守护在跑、bridge 没起来 —— 这类情况看日志尾部（通常是在等 dsh web 或登录限流）");
        if (!watchers.length && !bridges.length) {
          console.log("   ⚠️ 一个进程都没在跑。手动起一次看报错：`dsh-remote run`（前台，能直接看到输出）");
        }
      }
    } else {
      const r = sh("pgrep -fl 'dsh-setup.mjs|dsh-bridge.mjs' 2>/dev/null");
      if (!r.ok && r.code !== 1) {
        // pgrep 退出码 1 = "没有匹配的进程"（合法的 0），其它码 = 工具不可用（不能当 0 读）
        console.log(`   实测进程     : 扫描不可用（pgrep 退出码 ${r.code}：本机没有 pgrep 或被禁用）`);
      } else {
        const lines = String(r.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l && !/pgrep/.test(l));
        const watchers = lines.filter((l) => /dsh-setup\.mjs/.test(l));
        const bridges = lines.filter((l) => /dsh-bridge\.mjs/.test(l)).filter((l) => !/dsh-setup/.test(l));
        console.log(`   实测进程     : watcher ${watchers.length} 个 / bridge ${bridges.length} 个`);
        if (watchers.length && !bridges.length) console.log("   ⚠️ 守护在跑、bridge 没起来 —— 这类情况看日志尾部（通常是在等 dsh web 或登录限流）");
        if (!watchers.length && !bridges.length) {
          console.log("   ⚠️ 一个进程都没在跑。手动起一次看报错：`dsh-remote run`（前台，能直接看到输出）");
        }
      }
    }
  } catch (e) { console.log(`   实测进程     : 扫描不可用（${e.message}）`); }
  if (process.platform === "linux") {
    const hasUser = Boolean(process.env.XDG_RUNTIME_DIR);
    console.log(`   自启动       : systemd --user ${hasUser ? "（有 runtime dir）" : "（无 XDG_RUNTIME_DIR → 本机没有 user systemd，插件会用后台进程兜底）"}`);
    if (hasUser) {
      const r = sh("systemctl --user is-active dsh-bridge");
      console.log(`   systemd 状态 : ${r.ok ? r.stdout.trim() : (r.stderr || "").trim() || "查不到"}`);
    }
  }

  // ── ④ 通道：E2EE / 微信 / 待补发 ───────────────────────────────────────
  console.log("\n④ 通道");
  const e2ee = readJson(path.join(CONFIG_DIR, ".e2ee-state.json"));
  console.log(`   端到端加密   : ${e2ee ? (e2ee.enabled ? `已启用（${e2ee.reason || "ok"}）` : `未启用（${e2ee.reason || "?"}）`) : "（无状态文件 = 明文）"}`);
  const wx = readJson(path.join(CONFIG_DIR, ".wechat-state.json"));
  if (!wx) {
    console.log("   微信通道     : 未使用（无状态文件）");
  } else {
    const outbox = Array.isArray(wx.pending_outbox) ? wx.pending_outbox.length : 0;
    const faults = wx.last_fault && wx.last_fault.code ? `${wx.last_fault.code}（${ms(wx.last_fault.at)}）` : "无";
    console.log(`   微信通道     : ${wx.bound ? "已绑定" : "未绑定"} | 最近成功推送 ${ms(wx.last_push_ok_at)}`);
    console.log(`   待补发通知   : ${outbox ? `⚠️ ${outbox} 条（下次在微信里发一句话就会补上）` : "0 条"}`);
    console.log(`   最近订阅异常 : ${faults}`);
    console.log(`   当前会话     : ${wx.current_session_title || "-"}（${wx.current_session_id || "-"}）`);
    console.log(`   最近完成     : ${wx.last_completed_session_title || "-"}（${ms(wx.last_completed_at)}）`);
    if (outbox) console.log(`   ℹ️ 入站消息的形状（字段名，用于定位 context_token 缺失）：${wx.inbound_shape || "（还没记到）"}`);
  }
  const cfg = loadConfig();
  console.log(`   账号         : ${mask(cfg.phone) || (cfg.local_key ? "自建（本地密钥）" : "（未登录）")}`);
  console.log(`   中继/API     : ${cfg.tunnel_url || "-"} ${cfg.api_url ? `| ${cfg.api_url}` : ""}`);

  // ── ⑤ 日志尾部（现在每行都有时间戳，直接能对时间） ─────────────────────
  console.log("\n⑤ 日志尾部（bridge + 安装）");
  for (const name of [".dsh-bridge.log", ".dsh-setup-install.log"]) {
    const p = path.join(CONFIG_DIR, name);
    if (!fs.existsSync(p)) { console.log(`   ${name}: （无）`); continue; }
    let tail = "";
    try {
      const st = fs.statSync(p);
      const len = Math.min(st.size, 8 * 1024);
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      fs.closeSync(fd);
      tail = buf.toString("utf8");
    } catch { /* 读不了就当没有 */ }
    const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-12);
    console.log(`   --- ${name}（末尾 ${lines.length} 行 / ${p}）---`);
    for (const l of lines) console.log("   " + l.slice(0, 220));
    console.log("");
  }
  console.log("结论怎么读：① 版本对不上 → 面板点「一键修复 / 重装运行环境」；");
  console.log("           ② 上游 fallback → 把 dsh web 起在本机可回环访问的端口（插件会自动发现）；");
  console.log("           ③ 没有任何进程 → 先手动 `dsh-remote run` 看前台输出；");
  console.log("           ④ 待补发 > 0 → 在微信里随便发一句话即可补收。");
}

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
else if (cmd === "doctor") await doctorCmd(process.argv.slice(3));
else if (cmd === "status") {
  const cfg = loadConfig();
  const local = Boolean(cfg.local_key);
  console.log("配置文件:", CONFIG_PATH);
  console.log("连接模式:", local ? `自建服务（${cfg.tunnel_url || "未设置服务器地址"}）` : `SaaS 云端服务（${cfg.phone || "未配置账号"}）`);
  console.log("API:", cfg.api_url || (local ? "（自建模式无需账号 API）" : DEFAULT_API));
  // 接入标识（安装时 --ref 写入）：运维自查用；没设置就不打这一行，保持默认输出稳定。
  {
    const refCode = normalizeRefCode(cfg.ref_code);
    if (refCode) console.log("接入标识:", refCode);
  }
  console.log("远程地址/登录: 打开 dsh web → 设置 → 「远程访问」查看与操作");
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

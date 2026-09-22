// dsh-remote-web — node half (host plugin)（2026-09 由 dsh-remote-ui 更名 dsh-remote-web；卸载/清理兼容旧名）
//
// 提供 /dsh-remote/* 同源 HTTP 路由，供浏览器半的「远程访问」设置面板调用：
//   - 读写配置目录下 .dsh-config.json（0600）
//   - 查询/启停 bridge（launchctl，plist 缺失时自动生成，逻辑与 dsh-setup.mjs 一致）
//   - 代理 relay API（captcha / register / login / public-config），直连、不走系统代理；
//     另代理企业端一次性访问密钥 / 授权设备（/api/auth-key、/api/mobile-sessions、…/revoke、
//     DELETE …/:id、POST …/purge，Bearer）供面板「📱 远程访问」卡使用
//   - 自管理 self*（版本可见 / 新版检测 / 一键在线更新 / 彻底卸载）：插件市场没有更新卸载按钮，
//     面板内即官方管理入口；更新=后台 npx 按 dist-tag(默认 latest,DSH_UPDATE_TAG 可切 beta/alpha)（幂等补齐运行环境并重启 bridge）；
//     彻底卸载=profile 插件清理（uninstallSelf）+ 运行时清理（uninstallRuntime：停 bridge 自启动 /
//     删 plist|unit / 杀残留进程 / 清空配置目录 ~/.dsh-remote），0.4.7 起回归真正「未安装」状态
//   - 运行时自愈：缺运行环境自动后台安装、登录后自动拉起 bridge（0.4.2 起）
//   - 登录后自动闭环（0.6.4）：GET /dsh-remote/bridge-status 下发连接阶段
//     （no_account/no_runtime/installing/starting/connecting/online/error），并在返回前自动补装运行环境、
//     拉起 bridge、清理卡死标记（带退避）；区分「bridge 进程在跑」与「设备已在中继注册成功（online）」。
//     面板用 2~3s 短轮询自动推进到 online（无需点按钮/刷新页面），error 才给重试与诊断信息；
//     另 POST /dsh-remote/connect/retry 手动重试、POST <api>/api/install-report 上报安装口径
//     （install_source/version + host_os/arch，详见 installSourceOf）。
//   - 0.1.2+ ?token 浏览器鉴权会话代持（0.4.1 起）
//
// 不依赖任何第三方包：只使用 node 内置模块与 cordis 注入的 webServer 服务。
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, accessSync, chmodSync, openSync, closeSync, readSync, fstatSync, rmSync, renameSync, statSync, constants as fsConstants } from "node:fs";
import { join, dirname, sep, delimiter } from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 本插件在 host 侧的服务依赖。 */
export const inject = ["webServer"];

// ---------- 平台抽象层（0.6.7：Windows 支持） ----------
//
// 为什么单独抽一层：本插件整套「服务状态 / 启停」原本按 macOS/Linux 写死
// （launchctl / systemctl / pgrep / ps / /bin/sh），在 Windows 上运行期直接炸：
//   · process.getuid() 在 Windows 不存在（不是返回 undefined，是**没有这个函数**）
//     → /dsh-remote/status 与 /bridge-status 双双 500，面板永久停在「查询中…」；
//   · spawn("npx.cmd") 不带 shell（Node ≥20.12 起）同步抛 EINVAL → 运行环境永远补不上；
//   · spawn("/bin/sh") 在 Windows 报 ENOENT，且当时没有 'error' 监听 → 未捕获异常打挂 dsh web。
// 下面所有平台判断一律走 osPlatform()，绝不直接读 process.platform——这样测试可以用
// DSH_RELAY_PLATFORM=win32 在 macOS/Linux 开发机上把 Windows 分支真正跑一遍（见 test/windows-compat.test.mjs）。

/**
 * 当前运行平台（win32/darwin/linux/…）。
 * DSH_RELAY_PLATFORM 仅供测试/诊断模拟其它平台，生产环境不设置；调用时读取（非模块加载时固定）。
 */
function osPlatform() {
  return String(process.env.DSH_RELAY_PLATFORM || "").trim() || process.platform;
}
/** 是否 Windows：无 launchd/systemd、无 pgrep/ps、无 /bin/sh、npx 是 .cmd。 */
function isWindows() {
  return osPlatform() === "win32";
}
function isDarwin() {
  return osPlatform() === "darwin";
}

/**
 * 当前进程 uid。**Windows 没有 process.getuid**（typeof !== "function"），
 * 旧实现无条件调用它，导致所有读状态的接口 500。取不到一律返回 null，
 * 调用方按「本平台无 launchd domain」处理。
 */
function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** 同步睡眠（不引第三方依赖；Windows 没有 `sleep` 命令）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 极端环境退化为忙等 */ }
  }
}

/** quote 成 POSIX shell 单引号字面量（仅 darwin/linux 的 sh 调用用）。 */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/** 默认配置目录（可被 entry config 的 relayDir / DSH_RELAY_DIR 环境变量覆盖）。 */
const DEFAULT_RELAY_DIR = process.env.DSH_RELAY_DIR || join(homedir(), ".dsh-remote");
// 默认云端服务地址（SaaS 入口；自建用户在设置页/面板切换）。
// DSH_RELAY_DEFAULT_API 只改「配置里根本没写 api_url」时的兜底：测试脚本把它指向本地死端口，
// 这样任何**在临时目录被拆掉之后**才跑到的后台请求（如装机上报的重试）都不会打生产。
// 真实事故形态见 test/wechat-bind-telemetry.test.mjs 的注释：用例拆目录 → 读到空配置 → 回落生产。
const DEFAULT_API = String(process.env.DSH_RELAY_DEFAULT_API || "").trim()
  || "https://n.risegao.cn:13443/relay-api";
const DEFAULT_APP_URL = "https://n.risegao.cn:13443/app/";

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

// ---------- 小工具 ----------

/** 执行 shell 命令，不抛异常，返回 { ok, stdout, stderr, code }。 */
function sh(cmd) {
  try {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    return { ok: true, stdout: String(stdout ?? ""), stderr: "", code: 0 };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), code: e.status ?? -1 };
  }
}

/** 解析真实可执行路径（launchd 需要真实文件 + 可执行位）。 */
function resolveExecutable(p) {
  try {
    const real = realpathSync(p);
    accessSync(real, fsConstants.X_OK);
    return real;
  } catch {
    return null;
  }
}

/** 优先 node@20（node-datachannel 兼容性），回退当前 node。 */
function preferredNode() {
  const candidates = [
    "/opt/homebrew/opt/node@20/bin/node",
    "/usr/local/opt/node@20/bin/node",
    process.env.DSH_SETUP_NODE20 || "",
  ].filter(Boolean);
  for (const p of candidates) {
    const real = resolveExecutable(p);
    if (real) return real;
  }
  return resolveExecutable(process.execPath) || process.execPath;
}

const NODE_BIN = preferredNode();

/**
 * 解析 npx 的调用方式。DeepSeek App 拉起 dsh web 时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
 * （没有 /opt/homebrew/bin 等），裸 `npx` 会 spawn ENOENT 而静默失败——必须按绝对路径找，
 * 且子进程 env 的 PATH 要把当前 node 所在目录补在最前（npx 的 #!/usr/bin/env node 依赖它）。
 *
 * 【0.6.7 Windows 修复】Windows 上 npx 是批处理 npx.cmd：
 *   · Node ≥20.12（CVE-2024-27980 的修复）起，`spawn("npx.cmd")` 不带 shell 会**同步抛 EINVAL**，
 *     于是运行环境永远补不上（生产遥测里 install_failed/fail_code=npx_cmd_unavailable 全在 win32）；
 *   · 首选「用当前 node 直接跑 npm 自带的 npx-cli.js」——完全不经过 cmd.exe，没有空格/引号/
 *     中文路径陷阱，也不需要 shell:true；
 *   · 找不到 npx-cli.js 才退回 npx.cmd + shell:true（参数是常量，无注入面）。
 * @returns {{command:string, args:string[], shell:boolean, kind:string}}
 *          args 是前置参数（如 npx-cli.js 的路径），调用方接上自己的参数即可。
 */
function npxInvocation() {
  // 显式覆盖优先（测试注入假 npx；生产通常不设）
  const overrideDir = process.env.DSH_SETUP_NPX_DIR || "";
  const nodeDir = dirname(process.execPath);
  if (isWindows()) {
    // npm 自带 CLI 的位置：Node 官方 Windows 安装在 <node>\node_modules\npm\bin\npx-cli.js，
    // 也有把 npm 放在同级 lib\node_modules 下的布局，一并尝试。
    const cliCandidates = [
      ...(overrideDir ? [join(overrideDir, "node_modules", "npm", "bin", "npx-cli.js")] : []),
      join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"),
      join(nodeDir, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    ];
    for (const p of cliCandidates) {
      if (existsSync(p)) return { command: process.execPath, args: [p], shell: false, kind: "node-npx-cli" };
    }
    // 退回 .cmd：Windows 上**必须** shell:true，否则 EINVAL（这是 0.6.6 及更早的死因）
    const cmdDirs = [overrideDir, nodeDir, process.env.APPDATA ? join(process.env.APPDATA, "npm") : ""].filter(Boolean);
    for (const d of cmdDirs) {
      const real = resolveExecutable(join(d, "npx.cmd"));
      if (real) return { command: real, args: [], shell: true, kind: "npx-cmd" };
    }
    return { command: "npx.cmd", args: [], shell: true, kind: "npx-cmd-bare" };
  }
  const dirs = [
    overrideDir,
    nodeDir,                             // 与当前 node 同目录（homebrew/usr/local 均可覆盖）
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/opt/node@20/bin",
    "/usr/local/opt/node@20/bin",
    "/usr/bin",
  ].filter(Boolean);
  for (const d of dirs) {
    const real = resolveExecutable(join(d, "npx"));
    if (real) return { command: real, args: [], shell: false, kind: "npx" };
  }
  return { command: "npx", args: [], shell: false, kind: "npx-bare" }; // 全找不到 → 退回裸名（普通 shell 场景仍可用）
}

/** 子进程环境：把 node 目录补进 PATH（npx 及其 shebang 需要），可附加额外变量。 */
function spawnEnv(extra) {
  const nodeDir = dirname(process.execPath);
  const base = process.env.PATH || "";
  // PATH 分隔符必须按平台取（Windows 是 ";"，POSIX 是 ":"）：写死 ":" 会把整条 PATH
  // 在 Windows 上拼成一个不存在的路径，node/npx 全部找不到。
  // 追加的 POSIX 目录只在类 Unix 上有意义，Windows 上不追加。
  const posixDirs = isWindows() ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  const PATH = [nodeDir, base, ...posixDirs].filter(Boolean).join(delimiter);
  return { ...process.env, PATH, ...(extra || {}) };
}

/**
 * 派生后台子进程并**始终挂 'error' 监听**。
 *
 * 背景（Windows 实测致命）：没有 'error' 监听器的 ChildProcess，一旦启动失败
 * （ENOENT/EINVAL/EPERM）就会把 error 事件抛成**未捕获异常**，直接打挂宿主 dsh web。
 * 面板的「重启 DeepSeek harness」按钮就是这么把 dsh web 打死的（spawn("/bin/sh") 在 Windows ENOENT）。
 *
 * @returns {{child: import("node:child_process").ChildProcess|null, error: Error|null}}
 *          error 非空 = 同步启动失败（参数非法/被策略拒绝）；异步失败由 onError 回调兜底。
 */
function safeSpawn(command, args, opts = {}) {
  const { onError, ...spawnOpts } = opts;
  let child;
  try {
    child = spawn(command, args, spawnOpts);
  } catch (e) {
    return { child: null, error: e };
  }
  // 兜底监听：既用于上报，也用于「吞掉」本可打挂宿主的未捕获 error 事件。
  child.on("error", (e) => {
    try { onError?.(e); } catch { /* 回调自身出错不得影响宿主 */ }
  });
  return { child, error: null };
}

/**
 * 派生后台子进程并等它「真的起来了」再返回。
 * 异步启动失败（ENOENT）不抛异常、只在下一个 tick 发 'error' 事件——不等就会误报成功
 * （旧实现的「已调度重启」就是在 spawn 失败的情况下照样返回成功）。
 * @returns {Promise<{child, error}>}
 */
function spawnAndConfirm(command, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, opts);
    } catch (e) {
      resolve({ child: null, error: e });
      return;
    }
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      resolve({ child, error });
    };
    child.once("error", (e) => settle(e));
    child.once("spawn", () => settle(null));
    child.on("error", () => { /* 已 settle 之后的 error 只吞掉，绝不外抛 */ });
  });
}

// ---------- 后台子进程标记（防重入 + 宿主重启自愈） ----------
// marker 内容 = JSON {pid, at}：pid 供“宿主重启后立即清理死进程残留”判断；
// 兼容旧格式（纯时间戳数字 → 只按超时清理）。

function readMarkerInfo(filePath) {
  // ⚠️ `raw` 必须声明在 try **之外**：它下面还要用。此前写成 `const raw = …` 在 try 块内，
  // 于是"旧格式（纯时间戳数字）标记"会在这里抛 ReferenceError ——
  // 所有调用点都被 try/catch 吞掉，表现是**旧格式标记永远不会被清理**（潜伏缺陷，0.6.9 修）。
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8").trim();
    const j = JSON.parse(raw);
    if (Number.isInteger(j?.pid) || Number.isInteger(j?.at)) return j;
  } catch { /* 非 JSON → 数字时间戳或空 */ }
  const t = Number(raw || "0");
  return Number.isFinite(t) && t > 0 ? { pid: null, at: t } : null;
}

function writeMarker(filePath, pid) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ pid: pid ?? null, at: Date.now() }), { mode: 0o600 });
}

/** pid 是否存活（ESRCH=已死）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null; // 未知 → 由超时规则兜底
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM" ? true : false; // EPERM=存在但无权限
  }
}

/**
 * 清理残留标记：宿主 dsh web 在后台安装/更新期间被重启/强杀时，子进程清理回调随之丢失，
 * 若只按“30 分钟超时”清理，用户会在这半小时内反复遇到“已有更新进行中/正在安装”。
 * 现在：记录 pid → 重启后立刻清掉已死进程的标记；pid 不可读的旧标记仍按超时兜底。
 */
function sweepStaleMarkers(relayDir) {
  const now = Date.now();
  for (const [name, logName, kind] of [
    [PROVISION_MARKER, AUTO_INSTALL_LOG, "install"],
    [UPDATE_MARKER, UPDATE_LOG, "update"],
  ]) {
    const p = join(relayDir, name);
    let info;
    try { info = readMarkerInfo(p); } catch { continue; }
    if (!info) continue;
    const dead = pidAlive(info.pid);
    const expired = now - info.at > STALE_MARKER_MS;
    // 【0.6.9 新增】进程**活着但长时间没有推进** → 先结束它再清标记。
    // 诊断报告 P2：旧实现只看「进程还在不在」，挂死的进程因此永远不被结束，用户每次重试都堆一个。
    if (dead !== false) {
      const idle = progressIdleMs(relayDir, logName, info.at);
      if (idle > stallIdleMs(kind)
        && killStalledChild(relayDir, logName, info, kind, "宿主启动清理")) {
        stopProgressWatch(kind === "update" ? UPDATE_WATCH_KEY : `install:${relayDir}`);
        try { rmSync(p, { force: true }); } catch { /* ignore */ }
        continue;
      }
    }
    if (dead === false || (dead === null && expired)) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
      appendLogLine(relayDir, AUTO_INSTALL_LOG,
        `[dsh-remote-web] 清理残留标记 ${name}（pid=${info.pid ?? "?"}, at=${new Date(info.at).toISOString()}${dead === false ? ", 进程已死" : ", 已超时"}）`);
    }
  }
}

/**
 * 复用面板已有的 2~3s 轮询，顺手驱动「卡住的更新」自愈（诊断报告 F5）。
 *
 * 补装之所以能自愈，靠的是「每次轮询都再试一次」（ensureConnection → ensureRuntime）；
 * 而更新路径原先只有一次性 fire-and-forget（全文只有一个调用点），**一旦第一次卡住就再没有任何后续**。
 * 这里把同一套引擎平移到更新上：轮询时若发现「标记在、但日志很久没变」，
 * 就结束进程 + 清标记 + 如实记一条失败（面板据此给「重试」，而不是永久转圈）。
 */
function healStalledJobs(relayDir) {
  try {
    const marker = join(relayDir, UPDATE_MARKER);
    if (!existsSync(marker)) return false;
    const info = readMarkerInfo(marker);
    const idle = progressIdleMs(relayDir, UPDATE_LOG, info && info.at);
    if (idle <= stallIdleMs("update")) return false; // 还在推进：不打扰
    const killed = killStalledChild(relayDir, UPDATE_LOG, info, "update", "面板轮询发现长时间无输出");
    stopProgressWatch(UPDATE_WATCH_KEY);
    try { rmSync(marker, { force: true }); } catch { /* ignore */ }
    noteUpdateFailure(relayDir, `更新进程长时间没有响应（已 ${Math.round(idle / 1000)} 秒无输出），已结束并清理，可以重试`, "update_stalled");
    telemetryRecord(relayDir, "update_failed", { fail_code: "update_stalled" });
    appendLogLine(relayDir, UPDATE_LOG, `[update] 看门狗：已 ${Math.round(idle / 1000)}s 无输出 → 结束进程(${killed ? "已结束" : "进程已不在"})并清标记`);
    return true;
  } catch { return false; }
}

/** 读取 JSON body。 */
async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: true };
  }
}

/** 统一 JSON 响应。 */
function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ---------- 配置读写（与 dsh-setup.mjs 同一份 .dsh-config.json） ----------

function configPathOf(relayDir) {
  return join(relayDir, ".dsh-config.json");
}

function loadConfig(relayDir) {
  try {
    return JSON.parse(readFileSync(configPathOf(relayDir), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(relayDir, cfg) {
  mkdirSync(dirname(configPathOf(relayDir)), { recursive: true });
  // mode 0o600：与 dsh-setup.mjs 一致（文件已存在时 writeFileSync 不改权限，显式 chmod 兜底）
  writeFileSync(configPathOf(relayDir), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  hardenFile(configPathOf(relayDir)); // Windows 上 mode 是空操作 → 显式收紧 ACL（内含明文账号密码）
  try {
    chmodSync(configPathOf(relayDir), 0o600);
  } catch {
    /* 非关键 */
  }
}

/**
 * SaaS 模式权威归一化（与 dsh-setup.mjs 同规则）：
 * 清除自建残留(local_key/假 tunnel_url)，api_url 与 tunnel_url 一律按云端权威地址重算。
 * 解决“切过自建(填了假地址)后，再登/重装云端账号仍连错服务器、手机看不到设备”的残留配置问题。
 */
function applySaaSMode(cfg) {
  delete cfg.local_key;
  delete cfg.server;
  cfg.api_url = String(cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  cfg.tunnel_url = cfg.api_url.replace(/\/relay-api\/?$/, "").replace(/^https/, "wss");
  return cfg;
}

// ---------- Harness 浏览器会话代持(0.1.2-rc.1+ 的 ?token 鉴权) ----------

/**
 * 新版 dsh web(0.1.2-rc.1+)启动会打印带 ?token= 的 URL,并只给"换到了会话 Cookie"的浏览器放行,
 * 其余请求一律 401(手机经隧道因此白页)。本插件与 Harness 同进程:
 *  - 通过 ctx.connection 服务拿到本进程 launch token(authenticatedUrl 自带 token);
 *  - 在本地向 /?token=… 发起 token 交换,捕获下发的 dsh-auth-* 会话 Cookie;
 *  - 写入 <relayDir>/.harness-cookie.json,bridge 上游转发时自动携带,让手机表现为已授权浏览器。
 * 老版本(无该鉴权)下 connection 服务没有 authenticatedUrl → 静默跳过,行为不变。
 */
const HARNESS_COOKIE_FILE = ".harness-cookie.json";
/**
 * 手机端 401「dsh web authentication required; reopen the URL printed by dsh web」的根因就在这里：
 * 该 Cookie 由本插件在进程内经 ?token= 换取后交给 bridge 代持，**dsh web 每次重启都会换签名密钥**，
 * 旧 Cookie 立即失效。旧实现只在启动后重试 20 次(约 60s)就放弃、之后 6 小时才刷新一次 ——
 * 一旦启动那一刻 connection 服务还没就绪（或用户按引导重启 harness 后插件先于服务就绪），
 * Cookie 就会长时间不可用，手机端看到那段英文提示且**无法自行恢复**（他打不开电脑上打印的 URL）。
 * 现在改为：① 启动后持续重试 10 分钟；② 每 30 分钟主动刷新；③ 面板每次查状态时按需补齐；
 * ④ bridge 撞到 401 会写「作废」标记，插件下次查状态立即重取。四处叠加后用户无需任何操作。
 */
const HARNESS_AUTH_RETRY_MS = 3000;
const HARNESS_AUTH_RETRY_WINDOW_MS = 10 * 60 * 1000; // 持续尝试 10 分钟,不再 60s 后放弃
const HARNESS_AUTH_REFRESH_MS = 30 * 60 * 1000;      // 主动刷新周期(本地一次 fetch,成本可忽略)
const HARNESS_COOKIE_STALE_MS = 30 * 60 * 1000;      // 超过视为陈旧 → 按需重取
const HARNESS_COOKIE_REVOKED_FILE = ".harness-cookie-revoked"; // bridge 撞 401 时写的标记

/** 读取响应里的 set-cookie(兼容 getSetCookie / get 两种实现)。 */
function setCookieOf(res) {
  try {
    if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie().join("; ");
  } catch { /* ignore */ }
  return res.headers.get("set-cookie") || "";
}

async function mintHarnessCookie(ctx, relayDir) {
  if (UNINSTALLED_DIRS.has(relayDir)) return false; // 已彻底卸载：不再代持会话、不再重建配置目录
  try {
    const port = ctx.webServer?.port;
    if (!port) return false;
    // 不能把 "connection" 写进 inject(0.1.1 无该服务会拖死激活),只能运行时 try 获取
    let holder;
    try { holder = ctx.get("connection"); } catch { holder = void 0; }
    if (!holder && ctx.connection !== void 0) { try { holder = ctx.connection; } catch { /* ignore */ } }
    const svc = holder && typeof holder.authenticatedUrl === "function"
      ? holder
      : holder && holder.connection && typeof holder.connection.authenticatedUrl === "function"
        ? holder.connection
        : null;
    if (!svc) return false; // 老版本无浏览器鉴权 → 无需 cookie
    const tokenUrl = svc.authenticatedUrl(`http://127.0.0.1:${port}`);
    const res = await fetch(tokenUrl, { redirect: "manual", signal: AbortSignal.timeout(6000) });
    const cookie = setCookieOf(res).split(";")[0].trim();
    if (!cookie || !cookie.startsWith("dsh-auth-")) return false;
    // 竞态兜底：fetch 期间用户点击了「彻底卸载」→ 不得重建已被清空的配置目录
    if (UNINSTALLED_DIRS.has(relayDir)) return false;
    const out = { authority: `127.0.0.1:${port}`, cookie, mintedAt: Date.now() };
    mkdirSync(dirname(configPathOf(relayDir)), { recursive: true });
    writeFileSync(join(relayDir, HARNESS_COOKIE_FILE), JSON.stringify(out, null, 2), { mode: 0o600 });
    hardenFile(join(relayDir, HARNESS_COOKIE_FILE)); // 会话 Cookie ≈ dsh web 的完整访问权，同样要收紧
    return true;
  } catch {
    return false;
  }
}

/** 读取当前 Cookie 文件状态:{cookie, authority, mintedAt} 或 null。 */
function readHarnessCookie(relayDir) {
  try {
    const j = JSON.parse(readFileSync(join(relayDir, HARNESS_COOKIE_FILE), "utf8"));
    return j && typeof j.cookie === "string" && j.cookie ? j : null;
  } catch {
    return null;
  }
}

let harnessMintInflight = false;
let harnessMintLastAt = 0;

/**
 * 按需确保 Cookie 可用(去重 + 限频):
 *   缺失 / 超过 HARNESS_COOKIE_STALE_MS / bridge 写了作废标记 → 重取一次。
 * 被 /dsh-remote/status 与 /dsh-remote/bridge-status 调用(面板轮询 2.5~30s),
 * 因此只要面板开着,手机端 401 会在秒级内自愈;不需要用户做任何事。
 * @param {object} ctx cordis 上下文
 * @param {string} relayDir 配置目录
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<boolean>} 本次是否确认 Cookie 可用
 */
async function ensureHarnessCookie(ctx, relayDir, opts) {
  const force = !!(opts && opts.force);
  const revoked = existsSync(join(relayDir, HARNESS_COOKIE_REVOKED_FILE));
  if (!force && !revoked) {
    const cur = readHarnessCookie(relayDir);
    if (cur && Date.now() - Number(cur.mintedAt || 0) < HARNESS_COOKIE_STALE_MS) return true;
  }
  if (harnessMintInflight) return false;              // 去重:同一时刻只换一次
  if (Date.now() - harnessMintLastAt < 5000) return false; // 限频:5s 内不重复换
  harnessMintInflight = true;
  harnessMintLastAt = Date.now();
  try {
    const ok = await mintHarnessCookie(ctx, relayDir);
    if (ok || revoked) {
      try { rmSync(join(relayDir, HARNESS_COOKIE_REVOKED_FILE), { force: true }); } catch { /* ignore */ }
    }
    if (!ok && revoked) console.warn("[dsh-remote-web] 浏览器会话 Cookie 已被 dsh web 作废,重取失败,下次查状态再试");
    return ok;
  } finally {
    harnessMintInflight = false;
  }
}

/** 后台调度:启动后持续重试(10 分钟窗口) + 每 30 分钟主动刷新(与插件生命周期同进退)。 */
function scheduleHarnessMint(ctx, relayDir) {
  const startedAt = Date.now();
  const bootIv = setInterval(() => {
    if (Date.now() - startedAt > HARNESS_AUTH_RETRY_WINDOW_MS) { clearInterval(bootIv); return; }
    void ensureHarnessCookie(ctx, relayDir, { force: true }).catch(() => {});
  }, HARNESS_AUTH_RETRY_MS);
  bootIv.unref?.();
  void ensureHarnessCookie(ctx, relayDir, { force: true }).catch(() => {}); // 立刻来一次
  const refreshIv = setInterval(() => {
    void ensureHarnessCookie(ctx, relayDir).catch(() => {});
  }, HARNESS_AUTH_REFRESH_MS);
  refreshIv.unref?.();
  return () => {
    clearInterval(bootIv);
    clearInterval(refreshIv);
  };
}

// ---------- 桌面运行环境就绪判定 / 系统级操作开关 ----------

/**
 * 桌面运行环境是否就绪：固化运行时 `<relayDir>/dsh-setup.mjs` 存在即视为就绪。
 * 这是「bridge 能不能跑」的唯一权威判据，也是 launchd 自启动指向的入口脚本
 * （见 writeAutostartFile）——插件市场只装「插件半」时该文件不存在，必须先补装。
 */
function runtimeReady(relayDir) {
  return existsSync(join(relayDir, "dsh-setup.mjs"));
}

/**
 * 系统级操作总开关（测试隔离）：置位后不做 launchctl / npx 安装 / 杀进程等一切真实系统操作。
 * 生产环境绝不设置；测试与 CI 必须设置，否则用例会去碰本机真实的 bridge 自启动服务。
 */
function skipsSystemOps() {
  return process.env.DSH_RELAY_SKIP_SERVICE === "1";
}

// ---------- bridge 服务状态 / 启停（launchctl，macOS） ----------

function launchAgentPath() {
  if (isDarwin()) return join(homedir(), "Library/LaunchAgents/com.dshremote.bridge.plist");
  return null;
}

/**
 * launchd 作业 target（`gui/<uid>/<label>`）。
 * **Windows/Linux 上没有 launchctl、也没有 process.getuid**——旧实现无条件调
 * `process.getuid()`，在 Windows 上直接 TypeError（这正是面板两个读状态接口 500 的根因）。
 * 现在：非 macOS 或取不到 uid 一律返回 null，调用方必须先判空。
 */
/**
 * launchd 域名阶梯（**必须与 dsh-setup.mjs 一致**）。
 *
 * 事故（2026-09-19 实测）：安装器按 macOS 26 的修复把作业装在 **`user/<uid>`** 域
 * （gui 域会被系统置为 on-demand-only，RunAtLoad/KeepAlive 失效），
 * 但插件这边只认 `gui/<uid>` → 切换账号时那次"重启 bridge"实际执行的是
 *   launchctl bootout gui/501/com.dshremote.bridge   → 找不到
 *   launchctl bootstrap gui/501 <plist>              → 失败
 * 结果：旧 bridge 继续用**旧账号**跑，新账号的设备列表里永远看不到这台机器。
 * 现在两边用同一条阶梯：user/<uid> 优先，gui/<uid> 兜底。
 */
function launchDomains() {
  if (!isDarwin()) return [];
  const uid = currentUid();
  return uid === null ? [] : [`user/${uid}`, `gui/${uid}`];
}
/** 所有可能承载本服务的 launchd target（按优先级）。 */
function launchTargets() {
  return launchDomains().map((d) => `${d}/com.dshremote.bridge`);
}
function launchTarget() {
  return launchTargets()[0] || null; // 首选域（user/<uid>）
}

/**
 * 检查 launchd 服务状态。
 *
 * 【0.6.2 关键修复】`launchctl print` 只要成功，它的 `state` 就是权威，**不得**再回退
 * `launchctl list`。原因：plist 指向不存在的入口脚本时，KeepAlive 会让作业陷入
 * 「秒退→立刻重拉」的崩溃循环，而在重拉的瞬间 `launchctl list` 的 PID 列会闪现一个
 * **已经死掉**的 pid（实测 `launchctl list` = `40213 1 com.dshremote.bridge`，
 * 同时 `ps -p 40213` 为空、`launchctl print` = `state = spawn scheduled`）。
 * 旧实现据此谎报 running=true，后果有二：
 *   1) 面板显示「运行中」，用户以为 bridge 在跑（实际从未注册成功）；
 *   2) scheduleRuntime 判定「已在运行」→ 自愈 watcher 永久停摆，再也不补运行环境。
 * 现在：print 的 state 为准 + 附带 runs/lastExitCode/crashing 供面板与自愈解释原因；
 * 仅在 print 本身不可用时才回退 list，且回退路径要求 pid 真实存活。
 */
const NO_LAUNCHD = { running: false, pid: null, state: "", runs: null, lastExitCode: null, crashing: false };

function launchdStatus() {
  // 非 macOS 没有 launchctl（Windows 上连 process.getuid 都没有）：直接返回「无此服务」，
  // 不再去 shell 里调一个不存在的命令——这既避免 500，也避免每次轮询白起一个 cmd.exe。
  if (!isDarwin()) return { ...NO_LAUNCHD };
  // 逐域查询：安装器可能把作业装在 user/<uid>，插件以前只看 gui/<uid> → 会把"正在运行"看成"未运行"。
  for (const target of launchTargets()) {
    const st = launchdStatusIn(target);
    if (st.running || st.crashing || st.state) return st;
  }
  return { ...NO_LAUNCHD };
}

function launchdStatusIn(target) {
  const pr = sh(`launchctl print ${target}`);
  if (pr.ok) {
    const stateMatch = pr.stdout.match(/state\s*=\s*([^\n]+)/);
    const state = stateMatch ? stateMatch[1].trim() : "";
    const pidMatch = pr.stdout.match(/(?:^|\n)\s*pid\s*=\s*(\d+)/);
    const runsMatch = pr.stdout.match(/runs\s*=\s*(\d+)/);
    const exitMatch = pr.stdout.match(/last exit code\s*=\s*(-?\d+)/);
    const runs = runsMatch ? Number(runsMatch[1]) : null;
    const lastExitCode = exitMatch ? Number(exitMatch[1]) : null;
    const running = state === "running";
    // 崩溃循环：作业在 launchd 里可见但没在跑，且上次退出码非 0（KeepAlive 会无限重拉）
    const crashing = !running && runs !== null && runs > 0 && lastExitCode !== null && lastExitCode !== 0;
    return { running, pid: running && pidMatch ? Number(pidMatch[1]) : null, state, runs, lastExitCode, crashing };
  }
  const ls = sh("launchctl list | grep com.dshremote.bridge");
  if (ls.ok) {
    const pidStr = ls.stdout.trim().split(/\s+/)[0];
    if (pidStr && pidStr !== "-" && /^\d+$/.test(pidStr)) {
      const pid = Number(pidStr);
      // list 的 PID 列在崩溃循环中会出现已死进程 → 必须校验存活才敢报运行
      if (pidAlive(pid) !== false) return { running: true, pid, state: "running", runs: null, lastExitCode: null, crashing: false };
    }
  }
  return { running: false, pid: null, state: "", runs: null, lastExitCode: null, crashing: false };
}

// ---------- Windows：bridge 进程发现（0.6.7） ----------
//
// Windows 没有 pgrep/ps/launchctl，而 bridge 在 Windows 上也不由服务管理器托管
// （dsh-setup.mjs 明确不生成 Windows 自启动）。所以进程发现按「pid 文件优先、PowerShell 兜底」两级：
//   ① pid 文件：插件自己 spawn 的 watcher、以及 `dsh-remote run` 跑起来的 watcher/bridge
//      都会把 pid 落到配置目录（见 dsh-setup.mjs 的 writePidFile）。读文件 + process.kill(pid,0)
//      判活，零 shell 开销——面板 2~3s 轮询一次也扛得住。
//   ② PowerShell 扫 node.exe 的命令行：兼容「用户跑的是没写 pid 文件的旧版运行时」。
//      这条路径要起一个 powershell.exe（数百毫秒），故结果带 TTL 缓存，绝不被轮询打爆。

const WATCHER_PID_FILE = ".dsh-watcher.pid";
const BRIDGE_PID_FILE = ".dsh-bridge.pid";
/** Windows 自启动任务名（与 dsh-setup.mjs 的 WIN_TASK_NAME 必须一致）。 */
const WIN_TASK_NAME = "dsh-remote-bridge";
const WIN_SCAN_TTL_MS = 5000;

/** 读 pid 文件（内容为纯数字 pid；缺失/损坏返回 null）。 */
function readPidFile(relayDir, name) {
  try {
    const n = Number(String(readFileSync(join(relayDir, name), "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * 用 PowerShell 列出所有 node.exe 的 pid/父 pid/命令行。
 * 走 -EncodedCommand（UTF-16LE base64）：命令行里带引号/中文/空格时不会被 PowerShell 自己的
 * 引号解析吃掉，也不需要经过 shell。Get-CimInstance 不可用时回退 Get-WmiObject（Win7/精简系统）。
 */
let winProcScanCache = { at: 0, procs: [] };
function windowsNodeProcesses() {
  if (Date.now() - winProcScanCache.at < WIN_SCAN_TTL_MS) return winProcScanCache.procs;
  const script = [
    "try { $p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" }",
    "catch { $p = Get-WmiObject Win32_Process -Filter \"Name='node.exe'\" }",
    "$p | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let procs = [];
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    const raw = String(r.stdout || "").trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const p of (Array.isArray(parsed) ? parsed : [parsed])) {
        const pid = Number(p && p.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        procs.push({
          pid,
          ppid: Number(p.ParentProcessId) || null,
          commandLine: String((p && p.CommandLine) || ""),
        });
      }
    }
  } catch { procs = []; } // 无 PowerShell / 解析失败 → 静默降级为空（不阻断状态查询）
  winProcScanCache = { at: Date.now(), procs };
  return procs;
}

/**
 * Windows 登录任务（任务计划程序）是否已注册——由 dsh-setup.mjs 安装/一键更新时注册，
 * 插件只读不写。带 60s 缓存：面板 2~3s 轮询一次状态，不能每轮都起一个 schtasks。
 */
let winTaskCache = { at: 0, ok: false };
function windowsTaskRegistered() {
  if (Date.now() - winTaskCache.at < 60_000) return winTaskCache.ok;
  let ok = false;
  try {
    const r = spawnSync("schtasks", ["/Query", "/TN", WIN_TASK_NAME], { windowsHide: true, encoding: "utf8", timeout: 8000 });
    ok = r.status === 0;
  } catch { ok = false; }
  winTaskCache = { at: Date.now(), ok };
  return ok;
}

/** Windows 版 manualStatus：pid 文件优先，PowerShell 兜底。语义与 POSIX 版一致。 */
function windowsManualStatus(relayDir) {
  const watcher = [];
  const bridge = [];
  const allBridge = [];
  const push = (arr, pid) => { if (pid && !arr.includes(pid)) arr.push(pid); };
  const wPid = readPidFile(relayDir, WATCHER_PID_FILE);
  const bPid = readPidFile(relayDir, BRIDGE_PID_FILE);
  if (wPid && pidAlive(wPid) !== false && wPid !== process.pid) push(watcher, wPid);
  if (bPid && pidAlive(bPid) !== false && bPid !== process.pid) { push(bridge, bPid); push(allBridge, bPid); }
  // 兜底扫描只在 pid 文件一无所获时进行：避免每次轮询都起一个 PowerShell。
  if (!watcher.length && !bridge.length) {
    for (const p of windowsNodeProcesses()) {
      if (p.pid === process.pid || p.pid === wPid || p.pid === bPid) continue;
      if (/dsh-setup\.mjs/.test(p.commandLine)) push(watcher, p.pid);
      else if (/dsh-bridge\.mjs/.test(p.commandLine)) { push(bridge, p.pid); push(allBridge, p.pid); }
    }
  }
  return { watcher, bridge, allBridge };
}

/** 检查手动运行的 watcher（dsh-setup.mjs run）与 bridge 子进程（排除 launchd 托管链）。 */
function manualStatus(relayDir) {
  if (isWindows()) return windowsManualStatus(relayDir || DEFAULT_RELAY_DIR);
  const launchdPid = launchdStatus().pid;
  const out = (() => {
    const r = sh("pgrep -fl 'dsh-setup.mjs|dsh-bridge.mjs'");
    return r.ok ? r.stdout : "";
  })();
  const watcher = [];
  const bridge = [];
  // 全部 bridge 子进程（含 launchd 托管链里的）：连接阶段判定「bridge 进程真的在跑」用它。
  // launchd 作业本身跑的是 watcher（dsh-setup.mjs run），它再拉起 dsh-bridge.mjs 子进程——
  // 只看 launchd.running 会把「watcher 在、bridge 子进程没起来」误判成「进程在跑」。
  const allBridge = [];
  // 取候选进程的父 pid，判断是否属于 launchd 托管链
  const parentOf = (pid) => {
    const r = sh(`ps -o ppid= -p ${pid}`);
    const m = r.ok && r.stdout.trim().match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  };
  for (const line of out.split("\n")) {
    if (/pgrep/.test(line)) continue; // 排除 execSync 的 sh -c 包装进程
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pid === launchdPid) continue;
    const launchdManaged = launchdPid !== null && parentOf(pid) === launchdPid;
    if (/dsh-setup\.mjs/.test(m[2])) {
      if (!launchdManaged) watcher.push(pid);
      continue;
    }
    if (/dsh-bridge\.mjs/.test(m[2])) {
      allBridge.push(pid);
      if (!launchdManaged) bridge.push(pid); // launchd 托管的 bridge 子进程（原语义：不计入 manual.bridge）
    }
  }
  return { watcher, bridge, allBridge };
}

// ---------- 插件市场一键全功能：缺桌面运行环境时自动后台安装 dsh-remote ----------

const PROVISION_MARKER = ".dsh-setup-installing";
const AUTO_INSTALL_LOG = ".dsh-setup-install.log";
const STALE_MARKER_MS = 30 * 60 * 1000; // 超过该时长视为上次进程残留，插件启动时清理
/**
 * 「本次运行环境是插件自愈补装的」记录文件（install_source 判据）：
 * 插件市场只装面板插件时，桌面运行环境由插件后台 `npx @mrrisega/dsh-remote` 补上，
 * 这条路径归为 install_source=plugin_market；由用户自己跑安装器的（plist 里带
 * DSH_BRIDGE_INSTALL_SOURCE=npx）归为 npx。见 installSourceOf()。
 */
const PROVISIONED_MARKER = ".dsh-provisioned-by-plugin";
/**
 * 自愈 watcher 轮询间隔（默认 12s）。DSH_RELAY_SELFHEAL_MS 可覆盖——仅供测试把
 * 崩溃循环自愈链路压到亚秒级验证，生产不必设置。调用时读取（而非模块加载时固定），
 * 测试才能在 import 之后再改。
 */
function selfhealIntervalMs() {
  return Math.max(200, Number(process.env.DSH_RELAY_SELFHEAL_MS) || 12_000);
}

/** 向日志追加一行（多个子进程写同一日志用 append 模式，互不覆盖）。 */
function appendLogLine(relayDir, name, line) {
  try {
    const fd = openSync(join(relayDir, name), "a");
    try {
      writeFileSync(fd, `\n${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch { /* 非关键 */ }
}

/**
 * 清理“进程残留”标记的实现见上方小工具区 sweepStaleMarkers（pid 存活 + 超时双保险）。
 */

/** 插件市场只装了 UI 插件;若桌面缺 dsh-remote 运行环境(dsh-setup.mjs=bridge/自启动),
 * 由插件在后台自动执行一次 `npx @mrrisega/dsh-remote` 补齐,用户无需手动跑命令。
 * 已有环境(包括手动 npx 装过)直接跳过。返回 true=已就绪。
 * 注意：默认优先官方源——镜像(npmmirror)可能滞后于刚发布的版本，装到旧版会把
 * 已被 0.4.5 移除的“用户 include”重新写回 profile（历史上造成 dsh web 重复 ID 崩溃）。 */
/**
 * 补装失败退避（2026-09-15 生产事故）。
 *
 * 背景：Windows 用户补装 `npx @mrrisega/dsh-remote` 持续失败时，自愈调度每轮都重试，
 * 生产遥测里看到单机 12 秒一次、累计 606 次的失败风暴（1659 次 install_failed 全在 Windows）。
 * 这既刷屏日志、也让真实失败原因淹没在噪声里。
 *
 * 策略：连续失败后按 30s → 2m → 10m 退避（封顶 10 分钟）；用户点「一键修复 / 一键更新」时
 * 显式放行（resetProvisionRetry），保证人工操作永远能立即重试。
 */
const PROVISION_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];

function provisionRetryGate(relayDir) {
  const key = String(relayDir);
  let st = provisionRetry.get(key);
  if (!st) { st = { fails: 0, nextAt: 0 }; provisionRetry.set(key, st); }
  if (Date.now() < st.nextAt) {
    return { ok: false, waitMs: st.nextAt - Date.now(), fails: st.fails };
  }
  return { ok: true, st };
}

function noteProvisionFailure(relayDir) {
  const key = String(relayDir);
  const st = provisionRetry.get(key) || { fails: 0, nextAt: 0 };
  st.fails += 1;
  const wait = PROVISION_RETRY_BACKOFF_MS[Math.min(st.fails, PROVISION_RETRY_BACKOFF_MS.length) - 1];
  st.nextAt = Date.now() + wait;
  provisionRetry.set(key, st);
  return { fails: st.fails, waitMs: wait };
}

function noteProvisionSuccess(relayDir) {
  provisionRetry.delete(String(relayDir));
}

/** 用户显式要求重试（一键修复/一键更新）→ 清掉退避，让这次一定真的执行。 */
function resetProvisionRetry(relayDir) {
  provisionRetry.delete(String(relayDir));
}

function ensureRuntime(relayDir) {
  if (UNINSTALLED_DIRS.has(relayDir)) return false; // 已彻底卸载：不再自动安装运行环境
  if (runtimeReady(relayDir)) return true;
  if (skipsSystemOps()) return false; // 测试隔离：绝不在用例里 spawn 真实 npx 安装
  const gate = provisionRetryGate(relayDir);
  if (!gate.ok) {
    // 退避中：不重复 spawn（避免失败风暴）。面板会据 provisionRetryInfo() 显示"上次失败、X 后可重试"。
    return false;
  }
  const marker = join(relayDir, PROVISION_MARKER);
  if (existsSync(marker)) return false; // 正在安装中
  try {
    mkdirSync(relayDir, { recursive: true });
    const log = join(relayDir, AUTO_INSTALL_LOG);
    const watchKey = `install:${relayDir}`;
    const clear = () => {
      stopProgressWatch(watchKey);
      try { rmSync(marker, { force: true }); } catch { /* ignore */ }
    };
    // 补装失败（spawn 都起不来）时统一收尾：清安装标记 + 记日志 + 进退避 + 匿名遥测。
    // 没有这条兜底，spawn 的异步 'error' 会变成未捕获异常打挂宿主（旧实现在 Windows 上正是如此）。
    const failSpawn = (e, kind) => {
      clear();
      appendLogLine(relayDir, AUTO_INSTALL_LOG, `[auto-install] 启动 npx 失败(${kind}): ${e.message}`);
      noteProvisionFailure(relayDir);
      telemetryRecord(relayDir, "install_failed", { fail_code: telemetryFailCodeFromError(e) });
    };
    let stalledInstall = false; // 本轮是否因"长时间无输出"被判卡住（归因用）
    const npx = npxInvocation();
    const { child, error } = safeSpawn(npx.command, [...npx.args, "--yes", UPDATE_SPEC], {
      detached: true,
      // Windows 上跑 npx.cmd 必须经 shell（Node ≥20.12 起否则 EINVAL）；走 node+npx-cli.js 时不需要。
      shell: npx.shell,
      // Windows：别让 Node 给子进程开一个控制台窗口（POSIX 上该选项被忽略）
      windowsHide: true,
      // DSH_BRIDGE_INSTALL_SOURCE：本机运行环境是插件自愈补的 → 安装器原样透传到 plist/bridge env，
      // 于是设备行上的 install_source 如实记成 plugin_market（而不是安装器默认的 npx）。
      env: spawnEnv({ npm_config_registry: "https://registry.npmjs.org", DSH_BRIDGE_INSTALL_SOURCE: "plugin_market" }),
      stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
      onError: (e) => failSpawn(e, npx.kind),
    });
    if (error || !child) {
      failSpawn(error || new Error("spawn 未返回子进程"), npx.kind);
      return false;
    }
    writeMarker(marker, child.pid); // 记 pid：宿主重启后可立即清理死进程残留
    // 【0.6.9 关键修复】补装同样要有无输出看门狗。
    // 这一条直接对应"面板注册完成、设备却没有上报"的装机流失：npx 拉取在"连得上但传不动"的
    // 链路上会**挂起**（进程活着、永远不产出 exit），旧实现只在"pid 死 或 标记超 10 分钟"时才清理，
    // 于是卡住的安装能吃满 10 分钟退避窗口、反复失败；用户看到的是"正在安装…"永远不动。
    startProgressWatch(watchKey, {
      relayDir, logName: AUTO_INSTALL_LOG, kind: "install",
      getChild: () => child,
      onStall: (idle) => {
        stalledInstall = true;
        appendLogLine(relayDir, AUTO_INSTALL_LOG,
          `[auto-install] 已 ${Math.round(idle / 1000)}s 无输出 → 判定卡住，结束该进程并按失败处理（下一轮会重试）`);
      },
    });
    // 记下「本机运行环境是插件自愈补的」：登录后的 /api/install-report 与 bridge 设备登记
    // 都据此上报 install_source=plugin_market（区分用户自己跑 npx 安装器的那条路径）。
    try {
      writeFileSync(join(relayDir, PROVISIONED_MARKER),
        JSON.stringify({ at: Date.now(), version: PLUGIN_VERSION, source: "plugin_market" }));
    } catch { /* 非关键：上报时按缺省判据降级 */ }
    // 匿名遥测：补装生命周期（install_started → runtime_ready / install_failed(fail_code)）。
    // 失败原因只归类到白名单 fail_code，绝不外发原始错误文本（可能含路径/主机名/用户名）。
    const tb = telemetryBook(relayDir);
    tb.installStartedAt = Date.now();
    telemetryRecord(relayDir, "install_started");
    child.on("exit", (code) => {
      clear();
      appendLogLine(relayDir, AUTO_INSTALL_LOG, `[auto-install] npx 退出 code=${code ?? "?"}`);
      if (code === 0 && runtimeReady(relayDir)) {
        noteProvisionSuccess(relayDir);
        telemetryRuntimeReady(relayDir); // 退出码 0 ≠ 装好了
      } else {
        // 退出码非 0、卡住超时、或退出码 0 但安装脚本没落盘（装到一半/装错包）→ 都算失败并进入退避
        const code2 = stalledInstall ? "runtime_install_timeout"
          : (code === 0 ? "install_script_missing" : telemetryFailCodeFromText(readTail(log)));
        const back = noteProvisionFailure(relayDir);
        appendLogLine(relayDir, AUTO_INSTALL_LOG,
          `[auto-install] 第 ${back.fails} 次失败（归因 ${code2}），${Math.round(back.waitMs / 1000)}s 后才会重试`);
        telemetryRecord(relayDir, "install_failed", { fail_code: code2 });
      }
    });
    child.on("error", (e) => {
      clear();
      appendLogLine(relayDir, AUTO_INSTALL_LOG, `[auto-install] 启动失败: ${e.message}`);
      console.warn(`[dsh-remote-web] 自动安装子进程启动失败: ${e.message}`);
      noteProvisionFailure(relayDir);
      telemetryRecord(relayDir, "install_failed", { fail_code: telemetryFailCodeFromError(e) });
    });
    child.unref();
    console.log(`[dsh-remote-web] 检测到缺少桌面运行环境,已在后台自动安装(日志: ${log}),完成后将自动启动 bridge`);
    return false;
  } catch (e) {
    console.warn(`[dsh-remote-web] 自动安装启动失败: ${e.message}`);
    try { rmSync(marker, { force: true }); } catch { /* ignore */ }
    noteProvisionFailure(relayDir);
    telemetryRecord(relayDir, "install_failed", { fail_code: telemetryFailCodeFromError(e) });
    return false;
  }
}

/** 生成 plist（与 dsh-setup.mjs writeAutostartFile 同构），返回路径。 */
function writeAutostartFile(relayDir) {
  const plistPath = launchAgentPath();
  if (!plistPath) return null;
  const setupUrl = join(relayDir, "dsh-setup.mjs");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshremote.bridge</string>
  <key>ProgramArguments</key>
  <array><string>${NODE_BIN}</string><string>${setupUrl}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${join(relayDir, ".dsh-bridge.log")}</string>
  <key>StandardErrorPath</key><string>${join(relayDir, ".dsh-bridge.log")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string><key>DSH_BRIDGE_INSTALL_SOURCE</key><string>${installSourceOf(relayDir)}</string><key>DSH_BRIDGE_INSTALL_VERSION</key><string>${PLUGIN_VERSION}</string></dict>
</dict></plist>`;
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, { mode: 0o644 });
  return plistPath;
}

/**
 * 自启动 plist 里的入口脚本是否已不存在（不存在 = launchd 必然陷入崩溃循环）。
 * 只解析 ProgramArguments 里的第一个 .mjs 参数，不引入 plist 解析依赖。
 */
function plistEntryMissing() {
  const plistPath = launchAgentPath();
  if (!plistPath || !existsSync(plistPath)) return false;
  let raw = "";
  try { raw = readFileSync(plistPath, "utf8"); } catch { return false; }
  const m = raw.match(/<string>([^<]*\.mjs)<\/string>/);
  if (!m) return false;
  return !existsSync(m[1]);
}

/**
 * 摘掉「指向不存在入口脚本」的自启动项，止住 launchd 崩溃循环。
 *
 * 现场（0.6.1 及更早）：只装插件半的用户在面板点「启动 bridge」或首次登录时，
 * startBridge 会无条件生成指向 `<relayDir>/dsh-setup.mjs` 的 plist 并 bootstrap，
 * 而该文件并不存在 → launchd KeepAlive 无限重拉（日志 20+ 次 MODULE_NOT_FOUND、
 * `runs = 23 / last exit code = 1`）。此时仅删 plist 文件没用：作业已加载在 launchd 里，
 * 必须 bootout 才会停。判据严格限定为「入口脚本确实缺失」，绝不碰正常停止的服务。
 * @returns {boolean} 是否执行了清理
 */
function reapBrokenAutostart(relayDir) {
  if (skipsSystemOps()) return false;
  // 只有 macOS 有 launchd 自启动项可摘；Windows/Linux 走的是 systemd/无自启动，判据不适用。
  if (!isDarwin()) return false;
  if (!plistEntryMissing()) return false;
  const st = launchdStatus();
  if (!st.running && !st.crashing && !st.state) return false; // 作业未被 launchd 加载、无可摘的东西
  for (const target of launchTargets()) sh(`launchctl bootout ${target}`);
  try { rmSync(launchAgentPath(), { force: true }); } catch { /* 非关键 */ }
  appendLogLine(relayDir, AUTO_INSTALL_LOG,
    `[dsh-remote-web] 已摘除失效自启动：plist 入口 ${join(relayDir, "dsh-setup.mjs")} 不存在`
    + `（launchd state=${st.state || "?"}, runs=${st.runs ?? "?"}, lastExit=${st.lastExitCode ?? "?"}）→ 转入后台补装运行环境`);
  return true;
}

/** 写 pid 文件（Windows 进程发现用；写不了不致命，还有 PowerShell 兜底扫描）。 */
function writePidFile(relayDir, name, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, name), String(pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 结束一个进程（Windows 用 taskkill 连子进程一起收；POSIX 用给定信号）。 */
function killPid(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (isWindows()) {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8", timeout: 8000 });
    return r.status === 0 || pidAlive(pid) === false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return pidAlive(pid) !== true; // ESRCH = 本来就不在了，也算成功
  }
}

/**
 * 「脱离进程」方式启动 bridge（Windows 必用；macOS/Linux 在 launchd/systemd 托管不了时兜底）。
 *
 * Windows 上没有服务管理器自启动；macOS 上 launchd 被系统置为 on-demand-only（gui 域）时也托管不住。
 * 此时插件直接把 watcher（`node <relayDir>/dsh-setup.mjs run`）作为脱离进程拉起：
 * 这与用户手动跑 `dsh-remote run` 是**同一条代码路径**，watcher 自己盯着 127.0.0.1:3080，
 * dsh web 活着就拉起 dsh-bridge.mjs、dsh web 退出就把 bridge 停掉。
 * 代价（如实告知用户）：不随开机自启；但 dsh web 每次启动后插件都会在自愈轮次里重新拉起它。
 */
function startBridgeDetached(relayDir, fallbackReason = "") {
  if (skipsSystemOps()) return { ok: false, status: "skipped", detail: "测试隔离（DSH_RELAY_SKIP_SERVICE=1）：跳过真实服务操作" };
  if (!runtimeReady(relayDir)) {
    ensureRuntime(relayDir);
    return {
      ok: false,
      status: "provisioning",
      runtimeMissing: true,
      detail: "桌面运行环境（bridge）尚未安装，已在后台自动安装，完成后会自动启动 bridge——请稍候刷新面板（也可点下方「一键更新」查看进度）",
    };
  }
  // 幂等：watcher 已在跑就别再拉第二个（否则会有两个 bridge 抢同一个设备登记）
  const existing = readPidFile(relayDir, WATCHER_PID_FILE);
  if (existing && pidAlive(existing) !== false) {
    return { ok: true, status: "running", pid: existing };
  }
  const setup = join(relayDir, "dsh-setup.mjs");
  if (!existsSync(setup)) return { ok: false, status: "not-installed", detail: `运行环境入口脚本不存在（${setup}）` };
  const log = join(relayDir, ".dsh-bridge.log");
  let out = "ignore";
  try { out = openSync(log, "a"); } catch { /* 打不开日志：退化到丢弃输出，不阻断启动 */ }
  const { child, error } = safeSpawn(process.execPath, [setup, "run"], {
    detached: true,
    cwd: homedir(),
    env: spawnEnv({ DSH_BRIDGE_INSTALL_SOURCE: installSourceOf(relayDir), DSH_BRIDGE_INSTALL_VERSION: PLUGIN_VERSION }),
    stdio: ["ignore", out, out],
    windowsHide: true,
    onError: (e) => appendLogLine(relayDir, AUTO_INSTALL_LOG, `[dsh-remote-web] Windows 启动 bridge 失败: ${e.message}`),
  });
  if (typeof out === "number") { try { closeSync(out); } catch { /* 已随子进程继承，父进程这份可以关 */ } }
  if (error || !child) {
    const msg = (error || new Error("spawn 未返回子进程")).message;
    return { ok: false, status: "failed", detail: `启动 bridge 失败: ${msg}` };
  }
  writePidFile(relayDir, WATCHER_PID_FILE, child.pid);
  child.unref();
  return {
    ok: true,
    status: "running",
    pid: child.pid,
    // 如实区分两条路径：装过（且平台支持）就有自启动；否则只有"重开 dsh web 自动拉起"这一层保障
    detail: isWindows() && windowsTaskRegistered()
      ? "已在后台启动 bridge 守护（已注册登录任务，下次登录会自动运行）"
      : `已在后台启动 bridge 守护${fallbackReason ? `（${fallbackReason}；不随开机自启，重开 dsh web 时插件会自动拉起）` : "（不随开机自启，重开 dsh web 时插件会自动拉起）"}`,
  };
}

/** 停止「脱离进程」方式运行的 bridge（结束 watcher 与其 bridge 子进程，并清掉 pid 文件）。 */
function stopBridgeDetached(relayDir, opts = {}) {
  // 账号切换时用 force：即使处于测试隔离模式也要把进程停掉（否则"换个账号"在测试里走不通），
  // 但隔离模式下仍只用信号结束**本插件记录的** pid，不碰任何系统服务。
  if (skipsSystemOps() && !opts.force) return { ok: false, status: "skipped", detail: "测试隔离（DSH_RELAY_SKIP_SERVICE=1）：跳过真实服务操作" };
  const targets = [];
  for (const name of [WATCHER_PID_FILE, BRIDGE_PID_FILE]) {
    const pid = readPidFile(relayDir, name);
    if (pid && pidAlive(pid) !== false && !targets.includes(pid)) targets.push(pid);
  }
  for (const pid of targets) killPid(pid, "SIGKILL");
  for (const name of [WATCHER_PID_FILE, BRIDGE_PID_FILE]) {
    try { rmSync(join(relayDir, name), { force: true }); } catch { /* 非关键 */ }
  }
  // 复核：pid 文件之外可能还有用户手动跑起来、或用旧版运行时起的进程
  const manual = manualStatus(relayDir);
  const still = [...new Set([...manual.watcher, ...manual.bridge])];
  return {
    ok: still.length === 0,
    status: still.length ? "failed" : "stopped",
    pid: null,
    detail: still.length ? `仍有 ${still.length} 个 bridge 相关进程未结束（pid ${still.join(", ")}）` : void 0,
  };
}

/** 启动 bridge：确保运行环境就绪 + plist 存在 → launchctl bootstrap（回退 load -w）。 */
function startBridge(relayDir) {
  if (UNINSTALLED_DIRS.has(relayDir)) {
    // 已彻底卸载：面板/自愈在重启前可能仍在内存中，禁止再把自启动与 plist 拉回来
    return { ok: false, status: "uninstalled", detail: "插件已彻底卸载，重启 dsh web 后生效" };
  }
  if (isWindows()) return startBridgeDetached(relayDir);
  const plistPath = launchAgentPath();
  if (!plistPath) {
    return {
      ok: false,
      status: "unsupported",
      detail: `当前平台（${osPlatform()}）暂不支持自启动服务，请手动运行 \`dsh-remote run\``,
    };
  }
  if (skipsSystemOps()) return { ok: false, status: "skipped", detail: "测试隔离（DSH_RELAY_SKIP_SERVICE=1）：跳过真实服务操作" };
  // 【0.6.2 关键修复】运行环境缺失时绝不 bootstrap：写一个指向不存在脚本的 plist
  // 只会让 launchd 进入 KeepAlive 崩溃循环——面板还可能因瞬时 pid 谎报「已启动」。
  // 正确做法：先把运行环境补起来（后台 npx），就绪后由 scheduleRuntime / 面板再次启动。
  if (!runtimeReady(relayDir)) {
    ensureRuntime(relayDir);
    return {
      ok: false,
      status: "provisioning",
      runtimeMissing: true,
      detail: "桌面运行环境（bridge）尚未安装，已在后台自动安装，完成后会自动启动 bridge——请稍候刷新面板（也可点下方「一键更新」查看进度）",
    };
  }
  // plist 存在但入口不是当前运行环境（relayDir 变更/旧安装）→ 重写，避免又指到失效路径
  if (existsSync(plistPath) && !readFileSync(plistPath, "utf8").includes(join(relayDir, "dsh-setup.mjs"))) {
    writeAutostartFile(relayDir);
  }
  if (!existsSync(plistPath)) writeAutostartFile(relayDir);
  if (!existsSync(plistPath)) return { ok: false, status: "not-installed", detail: "plist 生成失败" };
  // 与 dsh-setup.mjs 同一条域阶梯：user/<uid> 优先（macOS 26 上唯一支持 RunAtLoad/KeepAlive 的域），
  // gui/<uid> 兜底（只能靠 kickstart 拉这一次，不保证崩溃自愈）。
  let lastDetail = "";
  for (const domain of launchDomains()) {
    const target = `${domain}/com.dshremote.bridge`;
    // 清掉**另一个**域的历史注册，避免两处并存导致重复实例（与安装器同构）
    for (const other of launchDomains()) {
      if (other !== domain) sh(`launchctl bootout ${other}/com.dshremote.bridge`);
    }
    sh(`launchctl bootout ${target}`);
    let boot = sh(`launchctl bootstrap ${domain} ${shQuote(plistPath)}`);
    if (!boot.ok) {
      sh(`launchctl unload ${shQuote(plistPath)}`);
      boot = sh(`launchctl load -w ${shQuote(plistPath)}`);
    }
    if (!boot.ok) { lastDetail = (boot.stderr || boot.stdout).trim() || `launchctl bootstrap ${domain} 失败`; continue; }
    // bootstrap 只是登记：立刻 kickstart 一次，确保"这一次"一定起来
    sh(`launchctl kickstart -k ${target}`);
    const st = launchdStatusIn(target);
    if (st.running) return { ok: true, status: "running", pid: st.pid, domain };
    lastDetail = st.state ? `已登记但未运行（state=${st.state}, runs=${st.runs ?? "?"}）` : "已登记但查不到状态";
  }
  // launchd 都托管不了（macOS 26 的 on-demand-only / 权限异常等）→ 退化为脱离进程，
  // 与 Windows 走同一条路径：绝不出现"重启失败但用户无感、旧账号继续跑"这种静默失败。
  const d = startBridgeDetached(relayDir, `launchd 无法托管（${lastDetail || "未知原因"}）`);
  return d.ok ? d : { ok: false, status: "failed", detail: `${lastDetail}；脱离进程兜底也失败：${d.detail}` };
}

/**
 * 运行时自愈 watcher：补齐桌面运行环境 + 环境就绪后自动拉起 bridge。
 *
 * 【0.6.2 顺序修复】运行环境检查提到最前，且必须先于「账号就绪」与「服务是否在跑」：
 *   - 旧版先判 `st.running` 才判运行环境，而崩溃循环中的作业会被误判为 running
 *     → watcher `done = true` 永久停摆，自动补装（ensureRuntime）再也不会执行，
 *     这正是「市场装完插件、bridge 却起不来」且永不恢复的直接原因；
 *   - 补装运行环境不该等用户先登录：市场安装只给到插件半，登录那一刻就会 startBridge。
 */
function scheduleRuntime(relayDir) {
  let done = false;
  // 本进程启动时是否缺运行环境：缺 → 补齐完成后需要重启 DeepSeek harness 才算「安装完成」。
  let awaitingRestartHint = !runtimeReady(relayDir);
  const iv = setInterval(() => {
    if (done) { clearInterval(iv); return; }
    if (UNINSTALLED_DIRS.has(relayDir)) { done = true; clearInterval(iv); return; } // 已彻底卸载：自愈 watcher 停摆
    try {
      if (!runtimeReady(relayDir)) {
        reapBrokenAutostart(relayDir); // 先摘掉指向不存在脚本的自启动，止住崩溃循环
        ensureRuntime(relayDir);       // 后台 npx 补齐（marker 防重入）；就绪后下一轮自动拉起
        telemetryRuntimeProbe(relayDir); // 匿名遥测：补装超时归类（runtime_install_timeout）
        return;
      }
      telemetryRuntimeProbe(relayDir); // 匿名遥测：环境刚补齐 → runtime_ready（每进程一次）
      if (awaitingRestartHint) {
        awaitingRestartHint = false;
        // 运行环境刚在本进程内补齐 —— **不需要重启 harness**：
        //   · bridge 是独立 launchd 进程，补齐后自愈调度会直接把它拉起；
        //   · 插件本体走 patch 热加载，装完即生效。
        // 以前这里会 markRestartPending("first-install") 弹出"需要重启 DeepSeek harness"横幅，
        // 在热加载落地后已经变成纯粹的误导（用户实测反馈），故移除。
      }
      const cfg = loadConfig(relayDir);
      const hasAcct = Boolean((cfg.phone || cfg.email) && cfg.password) || Boolean(cfg.local_key);
      if (!hasAcct) return;
      // 运行环境已在，看服务是否已在运行（runtime 可能位于 npx 缓存/固化目录，不必重复安装）
      const st = launchdStatus();
      if (st.running) { done = true; clearInterval(iv); return; }
      // Windows 没有 launchd：以「watcher 进程在跑」为就绪判据。否则 launchdStatus 永远是 false，
      // done 永远不置位，watcher 会一直空转（虽然 startBridge 幂等，但每轮都白跑一次进程发现）。
      if (isWindows() && manualStatus(relayDir).watcher.length > 0) { done = true; clearInterval(iv); return; }
      startBridge(relayDir); // 环境在但服务没起 → 拉起
    } catch { /* 下一轮再试 */ }
  }, selfhealIntervalMs());
  iv.unref?.();
  return () => clearInterval(iv);
}

/** 停止 bridge：macOS/Linux 走 launchctl bootout；Windows 结束 watcher/bridge 进程。 */
function stopBridge(relayDir) {
  if (isWindows()) return stopBridgeDetached(relayDir);
  // 测试隔离：置位时绝不对真实 launchd/systemd 下手（切换账号也会走到这里，
  // 少了这一条，用例就会去 bootout 开发者本机上真实运行的 bridge —— 实测过的污染风险）。
  if (skipsSystemOps()) return { ok: false, status: "skipped", detail: "测试隔离（DSH_RELAY_SKIP_SERVICE=1）：跳过真实服务操作" };
  const targets = launchTargets();
  if (!targets.length) return { ok: false, status: "unsupported", detail: `当前平台（${osPlatform()}）没有 launchd 服务可停，请手动结束 \`dsh-remote run\` 进程` };
  // 两个域都要停：作业可能由安装器装在 user/<uid>，而旧版插件只会去 gui/<uid> 找不到（实测事故）
  let lastErr = "";
  for (const target of targets) {
    const r = sh(`launchctl bootout ${target}`);
    if (!r.ok) lastErr = (r.stderr || r.stdout).trim();
  }
  const st = launchdStatus();
  return { ok: !st.running, status: st.running ? "failed" : "stopped", pid: null, detail: st.running ? (lastErr || "停止失败").trim() : void 0 };
}

// ---------- 彻底卸载：bridge 自启动 / 残留进程 / 配置目录 ----------

/**
 * 已执行「彻底卸载」的 relayDir 集合。卸载动作本身不改代码，但 dsh web 重启前本插件仍在内存中：
 * 自愈调度（scheduleRuntime/ensureRuntime/startBridge）与浏览器会话代持（mintHarnessCookie）
 * 若继续执行，会把刚清空的配置目录 / 自启动服务重新拉起来——故卸载后本进程内一律停摆，
 * 直到 dsh web 重启（profile 引用已移除，插件整体不再加载）或重新激活（apply 时清除）。
 */
const UNINSTALLED_DIRS = new Set();
/** 补装失败退避状态（relayDir → {fails, nextAt}）；见 provisionRetryGate。 */
const provisionRetry = new Map();

/** 标记某 relayDir 已完成彻底卸载（其后续自愈/代持调度全部停摆）。 */
function markUninstalled(relayDir) {
  if (relayDir) UNINSTALLED_DIRS.add(relayDir);
}

/**
 * 彻底卸载 —— 「运行时/bridge」部分：把本机 dsh-remote 运行时回归到未安装状态。
 * 执行顺序（每步独立 try/catch，单项失败不致命，不影响后续步骤；结果以标志位返回）：
 *   1) 停掉自启动服务并移除自启动文件：macOS launchctl bootout com.dshremote.bridge +
 *      删 ~/Library/LaunchAgents/com.dshremote.bridge.plist；Linux systemctl --user
 *      stop/disable dsh-bridge（+ 删 ~/.config/systemd/user/dsh-bridge.service）。
 *      ⚠ 必须先停服务再删配置目录：否则 launchd KeepAlive / systemd Restart 会立刻
 *      重启一个「指向已被删除文件」的进程；
 *   2) 杀掉仍存活的手动 watcher/bridge 进程（launchd/systemd 托管的进程已随 bootout 结束，
 *      manualStatus() 本身也排除了本进程与 launchd 托管链）；
 *   3) rm -rf 配置目录 relayDir（账号/设备密钥/.dsh-config.json/.harness-cookie.json/
 *      固化运行时 dsh-setup.mjs + clients 等全部残留）。
 * 安全护栏：
 *   - DSH_RELAY_SKIP_SERVICE=1（测试隔离开关，生产勿设）：跳过 1/2 的一切系统级操作，
 *     只清理配置目录——避免测试真的去 launchctl / systemctl / kill 真实服务；
 *   - 自启动文件只处理「属于当前 HOME 的 plist/unit」，误配/测试环境不碰同名真实服务；
 *   - 配置目录删除前校验：不是 "/"、不是家目录、不是 dsh web profile 目录或其父级（防误删用户数据）。
 */
function uninstallRuntime(relayDir, protectedPath) {
  const out = {
    stoppedService: false, // 自启动服务原本在运行且已停止
    removedPlist: false,   // 自启动文件（plist / systemd unit）已删除
    killedPids: [],        // 额外结束的残留进程 pid 列表
    removedDir: false,     // 配置目录 relayDir 已整目录清空
    servicePlatform: isDarwin() ? "launchd" : isWindows() ? "windows-detached" : osPlatform() === "linux" ? "systemd" : "none",
  };
  const skipService = process.env.DSH_RELAY_SKIP_SERVICE === "1";
  if (!skipService) {
    // a) 停服务 + 移除自启动文件
    try {
      if (isDarwin()) {
        // 只处理「plist 位于当前 HOME」的服务：本插件/dsh-setup.mjs 安装的服务一定在此
        const plistPath = launchAgentPath();
        if (plistPath && existsSync(plistPath)) {
          // crashing 也要 bootout：崩溃循环中的作业在 launchd 里仍是「已加载」，
          // 只删 plist 文件它照样被 KeepAlive 反复重拉（见 launchdStatus 注释）。
          const st = launchdStatus();
          if (st.running || st.crashing) {
            const r = stopBridge(relayDir); // launchctl bootout → KeepAlive 一并失效
            out.stoppedService = r.ok;
          }
          rmSync(plistPath, { force: true });
          out.removedPlist = !existsSync(plistPath);
        }
      } else if (isWindows()) {
        // Windows：自启动 = 任务计划程序里的登录任务（dsh-setup.mjs 注册）。
        // 卸载必须把任务一起删掉，否则下次登录又会被拉起来 —— 用户会以为"卸载没生效"。
        const before = manualStatus(relayDir);
        if (before.watcher.length || before.bridge.length) {
          const r = stopBridgeWindows(relayDir);
          out.stoppedService = r.ok;
        }
        try {
          const r = spawnSync("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"], { windowsHide: true, encoding: "utf8", timeout: 15000 });
          out.removedPlist = r.status === 0 || /cannot find|找不到|不存在/i.test(String(r.stdout || "") + String(r.stderr || ""));
        } catch { /* 任务不存在/无权限：不致命，残留可由用户手动清理 */ }
      } else if (osPlatform() === "linux") {
        // systemd --user 用户态服务，与 dsh-setup.mjs 安装的 dsh-bridge 同名
        const isActive = sh("systemctl --user is-active dsh-bridge");
        if (isActive.ok && String(isActive.stdout).trim() === "active") {
          sh("systemctl --user stop dsh-bridge");
          const after = sh("systemctl --user is-active dsh-bridge");
          out.stoppedService = !(after.ok && String(after.stdout).trim() === "active");
        }
        sh("systemctl --user disable dsh-bridge"); // 幂等；失败不致命
        const unitPath = join(homedir(), ".config", "systemd", "user", "dsh-bridge.service");
        if (existsSync(unitPath)) {
          try { rmSync(unitPath, { force: true }); } catch { /* 非关键 */ }
          sh("systemctl --user daemon-reload");
          out.removedPlist = !existsSync(unitPath);
        }
      }
    } catch { /* 服务清理失败不致命：目录照常清理，剩余残留可由用户手动处理 */ }
    // b) 杀残留手动进程（launchd 托管的已随 bootout 结束；manualStatus 排除本进程）
    try {
      const manual = manualStatus(relayDir);
      const targets = [...manual.watcher, ...manual.bridge];
      for (const pid of targets) {
        try { process.kill(pid, "SIGTERM"); out.killedPids.push(pid); } catch { /* EPERM/ESRCH 忽略 */ }
      }
      if (targets.length) {
        sleepSync(1000); // 同步等待进程退出（Windows 没有 sleep 命令，改用 Atomics.wait）
        for (const pid of targets) {
          if (pidAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
          }
        }
      }
    } catch { /* ignore */ }
  }
  // c) 清空配置目录（账号/密钥/会话 cookie/固化运行时等全部残留）
  try {
    const isRoot = dirname(relayDir) === relayDir;                     // "/" 或盘符根
    const isHome = relayDir === homedir();
    const hitsProfile = Boolean(protectedPath) && (
      relayDir === protectedPath || relayDir.startsWith(protectedPath + sep)
      || protectedPath.startsWith(relayDir + sep)
    ); // 配置目录误指向 dsh web profile → 绝不整目录删除
    if (relayDir && !isRoot && !isHome && !hitsProfile && existsSync(relayDir)) {
      rmSync(relayDir, { recursive: true, force: true });
      out.removedDir = !existsSync(relayDir);
    }
  } catch { /* 目录正被占用等：删除失败不致命（残留可由用户手动删除） */ }
  return out;
}

// ---------- DeepSeek harness 重启（0.6.2：首次安装/更新后必须重启才能加载插件本体） ----------
//
// 为什么需要：dsh web 的插件（宿主半 + 浏览器半）都是在**进程启动时**装载的。
// 市场点击安装只把文件写进 profile，当前进程里既没有 /dsh-remote/* 路由、也没有面板入口，
// 必须重启 DeepSeek harness 才生效（面板与 bridge 才能真正可用）。
// 本段提供：① 持久化「待重启」状态（跨进程判定重启是否真的发生过）；
//           ② 一条可靠的重启实现（优先交回监管者，其次自拉起）；③ 面板按钮用的路由。

const RESTART_STATE_FILE = ".dsh-restart-state.json";
const RESTART_SCRIPT_FILE = ".dsh-restart-harness.sh";   // macOS/Linux：/bin/sh 脚本
const RESTART_HELPER_FILE = ".dsh-restart-harness.mjs"; // Windows：node 助手（无 /bin/sh）
const RESTART_LOG_FILE = ".dsh-restart.log";

/**
 * 当前 dsh web 进程身份（pid + 启动时刻）。模块加载时算一次并固定：
 * 若每次调用重算，`Date.now() - uptime*1000` 的毫秒漂移会让同一个进程算出不同的 id，
 * 结清逻辑就会误判「已经重启过」而错误撤下提示。
 */
const BOOT_ID = `${process.pid}-${Math.round(Date.now() - process.uptime() * 1000)}`;

function bootId() {
  return BOOT_ID;
}

/** 读取「待重启」状态；文件缺失/损坏一律视为无需重启。 */
function readRestartState(relayDir) {
  try {
    const raw = JSON.parse(readFileSync(join(relayDir, RESTART_STATE_FILE), "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch { /* 无文件 / 损坏 */ }
  return { pending: false };
}

function writeRestartState(relayDir, state) {
  try {
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(join(relayDir, RESTART_STATE_FILE), JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  } catch { /* 写盘失败不致命：面板退化为不提示 */ }
}

/**
 * 标记「需要用户动一下」的状态。kind = refresh(插件被运行时改写,刷新页面即可)。
 * 历史 kind(first-install / update)已废弃:热加载落地后,装插件与在线更新都不再需要重启 harness。
 */
function markRestartPending(relayDir, kind, reason) {
  const cur = readRestartState(relayDir);
  if (cur.pending && cur.kind === kind) return cur; // 幂等：同一原因不反复重写
  const next = { pending: true, kind, reason, at: Date.now(), bootId: bootId(), installedBy: cur.installedBy || "" };
  writeRestartState(relayDir, next);
  return next;
}

/**
 * 插件装载时调用：bootId 与记录中的不同 = 中间确实重启过一次 → 结清「待重启」状态。
 * @returns {{cleared:boolean, state:object}}
 */
function settleRestartState(relayDir) {
  const cur = readRestartState(relayDir);
  if (!cur.pending) return { cleared: false, state: cur };
  if (cur.bootId && cur.bootId === bootId()) return { cleared: false, state: cur }; // 同一进程：仍待重启
  const state = { pending: false, kind: "", reason: "", at: cur.at || 0, bootId: bootId(), lastRestartedAt: Date.now() };
  writeRestartState(relayDir, state);
  return { cleared: true, state };
}

/**
 * 插件文件是否**晚于本进程启动**才落盘（= 运行中被市场安装/在线更新改写过）。
 * 依据：本插件自身 package.json 的 mtime 对比 dsh web 进程启动时刻（2s 容差）。
 */
function pluginInstalledAfterBoot() {
  try {
    const here = fileURLToPath(import.meta.url);            // <profile>/node_modules/<pkg>/lib/index.js
    const pkgFile = join(dirname(dirname(here)), "package.json");
    const mtimeMs = statSync(pkgFile).mtimeMs;
    const bootMs = Date.now() - process.uptime() * 1000;
    if (!(mtimeMs > bootMs + 2000)) return false;
    // ⚠️ 只看时间戳会**误报**:安装器补装/在线更新会把同样的文件重写一遍(哪怕是同一个版本),
    // 时间戳变新 → 被当成"有新插件要装载" → 弹出"需要重启/刷新"横幅(用户实测踩到:
    // 自愈补装把 profile 副本重写了一次,运行中的旧代码就写下了"需要重启")。
    // 真正该提示用户的只有一件事:**磁盘上的插件版本与本进程装载的版本不同**。
    // 版本相同 → 运行中的代码就是目标版本,什么都不用做。
    const diskVersion = String(JSON.parse(readFileSync(pkgFile, "utf8")).version || "");
    const runningVersion = String(PLUGIN_VERSION || "");
    return Boolean(diskVersion && runningVersion && diskVersion !== runningVersion);
  } catch { return false; }
}

/** 本进程的启动命令（重启时原样复用：node 路径 + dsh 参数 + 工作目录）。 */
function selfCommand() {
  return { node: process.execPath, args: process.argv.slice(1), cwd: process.cwd() };
}

/** macOS：从 `launchctl list` 里找出托管本进程（pid 精确匹配）的作业标签。 */
function launchdLabelForPid(pid) {
  const r = sh("launchctl list");
  if (!r.ok) return "";
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(-?\d+)\s+(\S+)$/);
    if (m && Number(m[1]) === pid) return m[3];
  }
  return "";
}

/** Linux：从 /proc/self/cgroup 里找出托管本进程的 systemd 单元。 */
function systemdUnitForSelf() {
  try {
    const cg = readFileSync("/proc/self/cgroup", "utf8");
    const m = cg.match(/\/([A-Za-z0-9_.@-]+\.service)/);
    return m ? m[1] : "";
  } catch { return ""; }
}

/**
 * 生成重启脚本（延迟执行，先把 HTTP 响应让浏览器收完）。
 * mode=launchd/systemd：交给监管者重启最干净（KeepAlive/Restart 会拉起新进程）；
 * mode=relaunch：没有监管者时自行拉起同一条命令行（detached 新会话，脱离将被 kill 的旧进程）。
 */
function buildRestartScript(mode, target, cmd, relayDir) {
  const log = join(relayDir, RESTART_LOG_FILE);
  const head = `#!/bin/sh\n# dsh-remote 自动生成：重启 DeepSeek harness（mode=${mode}）\necho "[$(date '+%F %T')] restart mode=${mode} target=${target || "-"} pid=${process.pid}" >> '${log}'\nsleep 1\n`;
  if (mode === "launchd") {
    return `${head}exec launchctl kickstart -k '${target}' >> '${log}' 2>&1\n`;
  }
  if (mode === "systemd") {
    return `${head}exec systemctl --user restart '${target}' >> '${log}' 2>&1\n`;
  }
  const quote = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
  const argv = [cmd.node, ...cmd.args].map(quote).join(" ");
  // 先优雅退出旧进程，超时再强杀；随后在新会话里拉起同一条命令
  return `${head}kill -TERM ${process.pid} 2>/dev/null\n`
    + `i=0\nwhile [ $i -lt 60 ]; do kill -0 ${process.pid} 2>/dev/null || break; i=$((i+1)); sleep 0.5; done\n`
    + `kill -KILL ${process.pid} 2>/dev/null\n`
    + `cd ${quote(cmd.cwd)} || exit 1\n`
    + `exec ${argv} >> '${log}' 2>&1\n`;
}

/**
 * Windows 重启助手（0.6.7 新增）——**必须**是 .mjs 而不是 /bin/sh 脚本。
 *
 * 现场（0.6.6 及更早，用户实测）：restartHarness 生成 `#!/bin/sh` 脚本再 `spawn("/bin/sh")`，
 * Windows 没有 /bin/sh → ENOENT；而那个 ChildProcess 又没挂 'error' 监听
 * → 未捕获异常直接终止 dsh web。更糟的是代码先把「已调度重启」写进日志并返回成功，
 * 用户看到"成功"、进程却已经没了（残留物 `.dsh-restart.log` 里正是 `mode=relaunch helper=undefined`）。
 *
 * 现在：用当前 node 跑本文件（不走任何 shell，参数原样传递，路径含空格/中文都不出问题），
 * 且**先校验新进程能拉起来再动旧进程**——宁可重启失败，也不能把自己杀掉却起不来。
 */
function buildRestartHelperSource(cmd, relayDir) {
  const plan = JSON.stringify({
    pid: process.pid, node: cmd.node, args: cmd.args, cwd: cmd.cwd,
    log: join(relayDir, RESTART_LOG_FILE),
  });
  return `// dsh-remote 自动生成：重启 DeepSeek harness（Windows 助手；由插件写入并 detached 执行）
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PLAN = ${plan};
function logLine(msg) {
  try { appendFileSync(PLAN.log, "\\n[" + new Date().toISOString() + "] " + msg + "\\n"); } catch (e) { /* 日志写不了不阻断重启 */ }
}

// ① 先确认新进程真的拉得起来，再动旧进程（旧实现最大的风险是"杀掉却起不来"）
if (PLAN.cwd && !existsSync(PLAN.cwd)) { logLine("重启中止：工作目录不存在 " + PLAN.cwd); process.exit(1); }
if (PLAN.cwd) process.chdir(PLAN.cwd); // 先切回原工作目录：入口若是相对路径也能被正确解析
if (!existsSync(PLAN.node)) { logLine("重启中止：node 不存在 " + PLAN.node); process.exit(1); }
const entry = PLAN.args[0];
if (!entry || !existsSync(entry)) { logLine("重启中止：dsh 入口不存在 " + entry); process.exit(1); }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

logLine("restart helper 启动：mode=relaunch(win32) 旧 pid=" + PLAN.pid);
await delay(1000); // 先把 HTTP 响应让浏览器收完

// ② 结束旧进程（Windows 上 process.kill 即 TerminateProcess）
try { process.kill(PLAN.pid); } catch (e) { /* 可能已自行退出 */ }
const deadline = Date.now() + 30000;
while (Date.now() < deadline && alive(PLAN.pid)) await delay(200);
if (alive(PLAN.pid)) {
  logLine("旧进程 30s 未退出，改用 taskkill /T /F");
  spawnSync("taskkill", ["/PID", String(PLAN.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
  await delay(500);
}

// ③ 用同一条命令行自拉起（脱离本助手，助手退出后它继续跑）
let out = "ignore";
try { out = openSync(PLAN.log, "a"); } catch (e) { /* 退化到丢弃输出 */ }
const child = spawn(PLAN.node, PLAN.args, {
  cwd: PLAN.cwd, detached: true, stdio: ["ignore", out, out], windowsHide: true,
});
child.on("error", (e) => logLine("重新拉起失败：" + e.message));
child.unref();
if (typeof out === "number") { try { closeSync(out); } catch (e) {} }
logLine("已重新拉起 dsh web：pid=" + String(child.pid));
`;
}

/**
 * 重启 DeepSeek harness（dsh web）。
 * 只重启「承载本插件的那个进程」（pid 匹配到的监管者或自身），绝不触碰 bridge。
 * @returns {Promise<{ok:boolean, status:string, mode?:string, detail?:string, script?:string, log?:string}>}
 */
async function restartHarness(relayDir, opts = {}) {
  if (skipsSystemOps()) return { ok: false, status: "skipped", detail: "测试隔离（DSH_RELAY_SKIP_SERVICE=1）：跳过真实重启" };
  const cmd = selfCommand();
  let mode = "relaunch";
  let target = "";
  if (isDarwin()) {
    const label = launchdLabelForPid(process.pid);
    const uid = currentUid();
    if (label && uid !== null) { mode = "launchd"; target = `gui/${uid}/${label}`; }
  } else if (osPlatform() === "linux") {
    const unit = systemdUnitForSelf();
    if (unit) { mode = "systemd"; target = unit; }
  }
  // Windows 一律走 .mjs 助手（无监管者，也不存在 /bin/sh）
  const script = isWindows() ? buildRestartHelperSource(cmd, relayDir) : buildRestartScript(mode, target, cmd, relayDir);
  // 匿名遥测：重启 DeepSeek harness（自动倒计时或手动按钮都经这里）——触发一次记一条。
  // 放在 dry-run 之前：测试/诊断用的 dry-run 也走同一条入口，便于用例锁死这条埋点。
  telemetryRecord(relayDir, "harness_restart");
  telemetryFlushSoon(relayDir); // 本进程约 1~2 秒后就会被替换：尽量当下把这条发出去（发不出去留盘上，下次装载补发）
  if (opts.dryRun || process.env.DSH_RELAY_RESTART_DRYRUN === "1") {
    // 测试/诊断用：只返回将要执行的脚本，不做任何真实动作
    return { ok: true, status: "dry-run", mode, target, script, log: join(relayDir, RESTART_LOG_FILE) };
  }
  const scriptPath = join(relayDir, isWindows() ? RESTART_HELPER_FILE : RESTART_SCRIPT_FILE);
  try {
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(scriptPath, script, { mode: 0o700 });
    const log = join(relayDir, RESTART_LOG_FILE);
    // 非 macOS 平台没有 /bin/sh；Windows 用 node 直接跑 .mjs 助手。
    const runner = isWindows() ? process.execPath : "/bin/sh";
    const out = openSync(log, "a");
    // 【0.6.7 关键修复】必须等「真的派生成功」再报成功：spawn 失败是**异步** 'error' 事件，
    // 旧实现不等就返回 ok:true（Windows 上 /bin/sh ENOENT 时正是如此）→ 用户看到"成功"、
    // 进程其实已经没了。spawnAndConfirm 同时保证永远有 'error' 监听，绝不打挂宿主。
    const { child, error } = await spawnAndConfirm(runner, [scriptPath], {
      detached: true,
      cwd: homedir(),
      env: spawnEnv(),
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    try { closeSync(out); } catch { /* 已随子进程继承，父进程这份可以关 */ }
    if (error || !child) {
      const msg = (error || new Error("spawn 未返回子进程")).message;
      appendLogLine(relayDir, RESTART_LOG_FILE, `[restart] 调度失败：${msg}（未执行任何重启动作，dsh web 仍在运行）`);
      return { ok: false, status: "failed", mode, target, log, detail: `调度重启失败: ${msg}` };
    }
    child.unref();
    appendLogLine(relayDir, RESTART_LOG_FILE, `[restart] 已调度重启：mode=${mode}${target ? " target=" + target : ""} helper=${child.pid}`);
    return {
      ok: true,
      status: "restarting",
      mode,
      target,
      pid: child.pid,
      log,
      detail: mode === "launchd" ? "已交由 launchd 重启（约 2~5 秒）"
        : mode === "systemd" ? "已交由 systemd 重启（约 2~5 秒）"
        : "无监管者，已用同一条命令行自拉起（约 2~5 秒）",
    };
  } catch (e) {
    return { ok: false, status: "failed", detail: `调度重启失败: ${e.message}` };
  }
}

// ---------- relay API 代理（直连，不走系统代理；undici 默认忽略代理环境变量） ----------

async function relayFetch(relayDir, pathname, init) {
  const cfg = loadConfig(relayDir);
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  const url = `${api}${pathname}`;
  try {
    // 6s 超时：relay 不可达时快速降级，不拖慢面板
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
    // 企业端拒绝当前 JWT（过期/轮换）→ 立刻让 token 缓存失效，下一次请求重新认证
    if (res.status === 401 || res.status === 403) invalidateRelayToken(relayDir);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: { error: { message: `relay 不可达: ${e.message}` } } };
  }
}

// ---------- bridge_secret 自愈（device-login 共享密钥） ----------

/**
 * 企业端 POST /api/device-login 强制校验 `x-dsh-bridge-secret`（缺失/失效 → 401 "需要有效设备密钥"），
 * 密钥由服务端公开配置 /api/public-config 下发、与 dsh-setup.mjs 的 `bridge_secret` 同源。
 *
 * 一键安装器（npx @mrrisega/dsh-remote → dsh-setup.mjs）会在安装时取一次并写入 .dsh-config.json；
 * 但**只装插件**的路径（dsh plugin add / 插件市场安装）没有这一步，于是：
 *   首次安装 → 打开设置面板立即登录 → 面板请求 /dsh-remote/access-key & mobile-sessions
 *   → relayToken 拿不到 token（401 需要设备密钥）→ 面板显示「尚未登录」（其实是密钥缺失）
 * 直到后台自愈（scheduleRuntime → ensureRuntime 跑一次 npx 安装器）把 bridge_secret 写回配置，
 * 或用户手动刷新页面才恢复——这正是「首次安装后立即登录，二维码/设备列表报红字」的根因。
 *
 * 这里在插件侧补上同一份自愈：缺密钥就取一次、落盘并缓存；失败短退避后可再试，不阻塞面板。
 */
let bridgeSecretCache = { dir: "", secret: "", failedAt: 0 };
const BRIDGE_SECRET_RETRY_MS = 15_000;

/** 读取配置里已保存的 bridge_secret（无则空串）。 */
function readBridgeSecret(relayDir) {
  try {
    return String(loadConfig(relayDir).bridge_secret || "").trim();
  } catch {
    return "";
  }
}

/**
 * 取 device-login 共享密钥：配置已有 → 直接用；否则向企业端公开配置取一次并写回配置（内存缓存兜底）。
 * @param {string} relayDir 配置目录
 * @param {object} [cfgOverride] 尚未落盘的配置（登录请求刚写入 phone/password 时用），仅用于判断模式
 * @param {{force?: boolean, timeoutMs?: number}} [opts] force=true 跳过本地文件/缓存强制重取；
 *        timeoutMs 限制单次公开配置请求耗时（登录路径用更短的上限，避免拖慢登录响应）
 * @returns {Promise<string>} 密钥（取不到为空串，调用方按“中继未就绪”降级，不抛错）
 */
async function bridgeSecretOf(relayDir, cfgOverride, opts) {
  const force = !!(opts && opts.force);
  if (!force) {
    const local = readBridgeSecret(relayDir);
    if (local) {
      bridgeSecretCache = { dir: relayDir, secret: local, failedAt: 0 };
      return local;
    }
    if (bridgeSecretCache.dir === relayDir && bridgeSecretCache.secret) return bridgeSecretCache.secret;
    if (bridgeSecretCache.dir === relayDir && Date.now() - bridgeSecretCache.failedAt < BRIDGE_SECRET_RETRY_MS) return ""; // 负缓存：别把公开配置打爆
  }
  const cfg = cfgOverride && typeof cfgOverride === "object" ? { ...loadConfig(relayDir), ...cfgOverride } : loadConfig(relayDir);
  if (cfg.local_key) return ""; // 自建模式走 /_login，不用设备密钥
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  const timeoutMs = Number((opts && opts.timeoutMs) || 0) > 0 ? Number(opts.timeoutMs) : 6000;
  let secret = "";
  try {
    const r = await fetch(`${api}/api/public-config`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const d = await r.json();
      secret = String((d && d.bridge_secret) || "").trim();
    }
  } catch { /* 网络抖动：负缓存短退避后再试 */ }
  if (!secret) {
    bridgeSecretCache = { dir: relayDir, secret: "", failedAt: Date.now() };
    return "";
  }
  bridgeSecretCache = { dir: relayDir, secret, failedAt: 0 };
  // 落盘（与 dsh-setup.mjs 同一份配置）：即使本进程退出，下次启动也不再缺密钥/不再是旧密钥
  let healed = false;
  try {
    const cur = loadConfig(relayDir);
    if (!cur.bridge_secret || (force && cur.bridge_secret !== secret)) {
      cur.bridge_secret = secret;
      saveConfig(relayDir, cur);
      healed = true;
    }
  } catch { /* 写盘失败不致命：内存缓存本次进程内仍生效 */ }
  // 密钥是「从无到有」补上的：已经在跑的 bridge 是用空密钥起的，隧道认证同样会失败——
  // 后台重启一次让它带上密钥（一次性事件，失败只记日志不打断面板请求）。
  if (healed && !UNINSTALLED_DIRS.has(relayDir)) {
    setTimeout(() => {
      try {
        const st = launchdStatus();
        if (!st.running) return;
        const r = startBridge(relayDir);
        console.log(`[dsh-remote-web] 已补记 bridge_secret，后台重启 bridge 使其生效: ${r.status}`);
      } catch (e) {
        console.warn(`[dsh-remote-web] 补记 bridge_secret 后重启 bridge 失败: ${e.message}`);
      }
    }, 50).unref?.();
  }
  return secret;
}

// ---------- 账号 / 用量 / 邀请代理（我的信息、额度提示、邀请记录） ----------

/** token 获取失败的原因（供 UI 区分“未登录”与“中继未就绪”，不再一律谎报“尚未登录”）。 */
const AUTH_NO_CREDENTIALS = "no_credentials";       // 本机没存账号/自建密钥 → 该去登录
const AUTH_BAD_CREDENTIALS = "bad_credentials";     // 账号密码被企业端拒绝 → 该重新登录
const AUTH_RELAY_UNREACHABLE = "relay_unreachable"; // 网络/5xx/超时 → 稍后重试
const AUTH_RELAY_NOT_READY = "relay_not_ready";     // 凭证齐全但企业端未接受（缺失/轮换中的设备密钥等）→ 稍后重试

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * relay token 短期缓存（60s）：连接阶段的 2~3s 短轮询会反复取 token，若每次都走 device-login
 * （即账号密码认证），就会**每几秒打一次企业端认证接口**——审计日志刷屏、可能触发限流，且纯属浪费。
 *   - TTL 60s：远短于 JWT 自身有效期；账号密码/共享密钥变更最多 60s 生效；
 *   - 键含 api_url + 账号 + 模式：换账号、切自建/云端、换服务端会自动 miss；
 *   - 并发合并（relayTokenInflight）：同一时刻多个请求共用一次认证；
 *   - 只缓存成功结果；企业端回 401/403（JWT 过期/轮换）时 relayFetch 立即 invalidateRelayToken。
 */
const RELAY_TOKEN_TTL_MS = 60_000;
const relayTokenCache = new Map();    // relayDir → { key, token, exp, status }
const relayTokenInflight = new Map(); // relayDir → { key, promise }
/** 缓存键：同一台机器换了账号/服务端/模式时自动失效，避免把别人的 token 用错地方。 */
function relayTokenKeyOf(cfg) {
  return [
    (cfg.api_url || DEFAULT_API).replace(/\/+$/, ""),
    cfg.local_key ? "local" : "saas",
    cfg.local_key ? String(cfg.local_key).slice(0, 8) : (cfg.phone || cfg.email || ""),
  ].join("|");
}
/** 丢弃某 relayDir 的 token 缓存（账号变更、退出登录、企业端拒绝 JWT 时调用）。 */
function invalidateRelayToken(relayDir) {
  if (!relayDir) return;
  relayTokenCache.delete(relayDir);
  deviceProbeCache.delete(relayDir); // 认证失效时「设备探活」结论同样过期（否则 15s 内不会重试）
}
/**
 * 账号设备表探活缓存（见 accountDeviceBound）：企业端每次 GET /api/devices 都会写一行活跃明细
 * （user_activity），因此绝不跟着 2.5s 的 UI 轮询打——15s 一次，且只在与中继注册证据缺失时才探。
 */
const DEVICE_PROBE_TTL_MS = 15_000;
const deviceProbeCache = new Map(); // relayDir → { at, value }

/** 单次 device-login：返回 { ok, status, token, code, detail }（不抛错，便于按原因降级/重试）。 */
async function deviceLoginOnce(api, cfg, secret) {
  try {
    const r = await fetch(`${api}/api/device-login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { "x-dsh-bridge-secret": secret } : {}) },
      body: JSON.stringify({ phone: cfg.phone, email: cfg.phone, password: cfg.password }),
      signal: AbortSignal.timeout(6000)
    });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch { d = null; }
    return {
      ok: r.ok,
      status: r.status,
      token: (d && d.token) || "",
      code: (d && d.error && d.error.code) || "",
      detail: (d && d.error && (d.error.message || d.error.code)) || "",
    };
  } catch (e) {
    return { ok: false, status: 0, token: "", code: "", detail: e.message };
  }
}

/** 单次本地认证（自建模式）：POST {隧道同源}/_login。 */
async function localLoginOnce(cfg, api) {
  const fallbackApi = (api || cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  try {
    const u = new URL(cfg.tunnel_url || fallbackApi.replace(/^https?/, "wss"));
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/_login";
    const r = await fetch(u.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: cfg.local_key }),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return { ok: false, status: r.status, token: "", code: "", detail: "" };
    const d = await r.json();
    return { ok: true, status: 200, token: (d && d.token) || "", code: "", detail: "" };
  } catch (e) {
    return { ok: false, status: 0, token: "", code: "", detail: e.message };
  }
}

/**
 * 获取短期 relay token:SaaS → device-login;本地模式 → /_login(从隧道地址推导同源)。
 * 与旧版差异：① 缺 device-login 共享密钥时自愈补齐；② 服务端轮换密钥(401/403)自动重取重试；
 * ③ 网络抖动/5xx 退避重试一次；④ 失败时给出**可判定原因**而非空串（消除“尚未登录”误报）。
 * @returns {Promise<{token:string, reason:string, status:number, detail:string}>}
 */
async function relayTokenWithReason(relayDir, cfgOverride, opts = {}) {
  const cfg = cfgOverride && typeof cfgOverride === "object" ? { ...loadConfig(relayDir), ...cfgOverride } : loadConfig(relayDir);
  const key = relayTokenKeyOf(cfg);
  const now = Date.now();
  const hit = relayTokenCache.get(relayDir);
  if (!opts.force && hit && hit.key === key && hit.token && now < hit.exp) {
    return { token: hit.token, reason: "", status: hit.status || 200, detail: "", cached: true };
  }
  // 并发合并：同一时刻的多个请求（状态轮询 / 二维码 / 设备列表 / 上报）共用一次认证
  const flying = relayTokenInflight.get(relayDir);
  if (!opts.force && flying && flying.key === key) return flying.promise;
  const promise = relayTokenUncached(relayDir, cfg, cfgOverride).then((res) => {
    if (res && res.token) {
      relayTokenCache.set(relayDir, { key, token: res.token, exp: Date.now() + RELAY_TOKEN_TTL_MS, status: res.status || 200 });
    } else {
      relayTokenCache.delete(relayDir); // 失败不缓存：下一轮立刻重试
    }
    relayTokenInflight.delete(relayDir);
    return res;
  }, (e) => {
    relayTokenInflight.delete(relayDir);
    throw e;
  });
  relayTokenInflight.set(relayDir, { key, promise });
  return promise;
}

/** 未缓存的真实取 token 逻辑（relayTokenWithReason 的缓存/合并外壳在这里之上一层）。 */
async function relayTokenUncached(relayDir, cfg, cfgOverride) {
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  if (cfg.local_key) {
    let r = await localLoginOnce(cfg, api);
    if (!r.token && (r.status === 0 || r.status >= 500)) { await sleep(350); r = await localLoginOnce(cfg, api); }
    if (r.token) return { token: r.token, reason: "", status: r.status, detail: "" };
    return {
      token: "",
      reason: r.status === 401 || r.status === 403 ? AUTH_BAD_CREDENTIALS : AUTH_RELAY_UNREACHABLE,
      status: r.status,
      detail: r.detail,
    };
  }
  if (!cfg.phone || !cfg.password) return { token: "", reason: AUTH_NO_CREDENTIALS, status: 0, detail: "" };

  let secret = await bridgeSecretOf(relayDir, cfgOverride);
  let r = await deviceLoginOnce(api, cfg, secret);
  // 带了密钥仍被拒 → 可能是服务端轮换了共享密钥：丢弃缓存强制重取一次再试
  if (!r.token && (r.status === 401 || r.status === 403) && secret) {
    const fresh = await bridgeSecretOf(relayDir, cfgOverride, { force: true });
    if (fresh && fresh !== secret) r = await deviceLoginOnce(api, cfg, fresh);
  }
  // 网络抖动/超时/5xx：短退避重试一次（首次安装后中继握手偶发失败很常见）
  if (!r.token && (r.status === 0 || r.status >= 500)) {
    await sleep(350);
    r = await deviceLoginOnce(api, cfg, await bridgeSecretOf(relayDir, cfgOverride));
  }
  if (r.token) return { token: r.token, reason: "", status: r.status, detail: "" };
  if (r.code === "bad_credentials") return { token: "", reason: AUTH_BAD_CREDENTIALS, status: r.status, detail: r.detail };
  // 凭证齐全但企业端没给 token（设备密钥缺失/轮换中、限流、其它 4xx）→ 可重试，不谎报“未登录”
  if (r.status === 0 || r.status >= 500) return { token: "", reason: AUTH_RELAY_UNREACHABLE, status: r.status, detail: r.detail };
  return { token: "", reason: AUTH_RELAY_NOT_READY, status: r.status, detail: r.detail };
}

/** 兼容旧调用方（反馈/账号/配额等只需 token 字符串）。 */
async function relayToken(relayDir) {
  const r = await relayTokenWithReason(relayDir).catch(() => ({ token: "" }));
  return r.token || "";
}

/** 我的信息:SaaS 账号的生效套餐/到期日/邀请码(经 /api/me)。 */
async function relayAccount(relayDir) {
  const token = await relayToken(relayDir);
  if (!token) return null;
  const r = await relayFetch(relayDir, "/api/me", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok || !r.body || !r.body.user) return null;
  const u = r.body.user;
  return {
    phone: maskPhone(u.phone || ""),
    plan: u.plan || "free",
    plan_source: u.plan_source || "plan",
    plan_ends_at: u.plan_ends_at ?? null,
    trial_expires_at: u.trial_expires_at ?? null,
    invite_code: u.invite_code || "",
    invited_by: u.invited_by ?? null
  };
}

/** 流量用量:router /_quota(免费用户百分比提示)。 */
async function relayQuota(relayDir) {
  const token = await relayToken(relayDir);
  if (!token) return null;
  const cfg = loadConfig(relayDir);
  // router 同源:apiUrl(https://host/relay-api) → https://host;本地模式从 tunnel_url 推导
  let origin = "";
  if (cfg.tunnel_url) {
    const u = new URL(cfg.tunnel_url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    origin = u.origin;
  } else {
    const u = new URL((cfg.api_url || DEFAULT_API));
    origin = u.origin;
  }
  try {
    const r = await fetch(`${origin}/_quota`, {
      headers: { cookie: `dsh_token=${encodeURIComponent(token)}` },
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.quota || null;
  } catch {
    return null;
  }
}

/** 我的邀请记录(登录态):有效邀请 + 奖励。 */
async function relayInviteRecords(relayDir) {
  const token = await relayToken(relayDir);
  if (!token) return null;
  const r = await relayFetch(relayDir, "/api/invite-records", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok || !r.body) return null;
  return { records: r.body.records || [], rewards: r.body.rewards || [] };
}

// ---------- 交流群二维码（后台配置，公开读取） ----------

/**
 * 交流群二维码/客服微信：企业端配置经公开配置 /api/public-config 的 community 字段下发
 * （community.qrcode 形如 "/qr/group-qr.png"）。面板与反馈页展示「加入交流群」用。
 *
 * 面板跑在电脑本机 dsh web（http://127.0.0.1:3080），相对路径无法直接当 <img src>，
 * 故这里按企业端公开约定拼成绝对地址：<api_url><qrcode>（与手机端 PWA 的 API_BASE + qr 一致）。
 * 30s 内存缓存：面板与反馈卡都会取，避免重复打公开配置。
 */
const COMMUNITY_TTL_MS = 30_000;
let communityCache = { dir: "", at: 0, data: null };

async function communityInfo(relayDir) {
  if (communityCache.data && communityCache.dir === relayDir && Date.now() - communityCache.at < COMMUNITY_TTL_MS) {
    return communityCache.data;
  }
  const cfg = loadConfig(relayDir);
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  const r = await relayFetch(relayDir, "/api/public-config");
  const b = r.ok && r.body && typeof r.body === "object" ? r.body : {};
  const c = b.community && typeof b.community === "object" ? b.community : {};
  const raw = String(c.qrcode || "").trim();
  const qrcode = raw && !/^https?:/i.test(raw) ? api + (raw.startsWith("/") ? raw : `/${raw}`) : raw;
  const data = { qrcode, wechat: String(c.wechat || "") };
  communityCache = { dir: relayDir, at: Date.now(), data };
  return data;
}

// ---------- 一次性访问密钥 / 已授权设备代理（E1 企业端新增 auth-key / mobile-sessions） ----------

/** 从 relay 响应里尽量提取人类可读错误信息（兼容 {error:{message}} / {error:".."} / {message} / 纯文本）。 */
function relayErrorMessage(r) {
  const b = r && typeof r === "object" ? r.body : null;
  if (b && typeof b === "object") {
    if (typeof b.error === "string" && b.error) return b.error;
    if (b.error && typeof b.error === "object") {
      if (typeof b.error.message === "string" && b.error.message) return b.error.message;
    }
    if (typeof b.message === "string" && b.message) return b.message;
  }
  if (typeof b === "string" && b.trim()) return b.trim();
  const st = r && r.status;
  return st ? `企业端请求失败（HTTP ${st}）` : "企业端不可达，请稍后重试";
}

/** 未登录（无账号/自建密钥）时的统一返回文案。 */
function notLoggedInJson() {
  return { ok: false, error: "尚未登录：请先在「账号」卡片登录手机号账号（或切换到自建服务）后重试", hint: "login_required" };
}

/**
 * 凭证齐全但拿不到 relay token 时的统一返回：区分「密码失效需重新登录」与「中继暂未就绪可重试」。
 * 关键：不再把中继未就绪/设备密钥缺失谎报成“尚未登录”（旧版 UI 因此显示误导性红字）。
 */
function relayAuthFailureJson(reason, detail) {
  if (reason === AUTH_NO_CREDENTIALS) return { status: 401, body: notLoggedInJson() };
  if (reason === AUTH_BAD_CREDENTIALS) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "本机保存的账号密码已被中继拒绝（可能已在别处修改过密码）：请用新密码重新登录「账号」卡片后重试",
        hint: "relogin_required",
        retryable: false,
        detail: String(detail || ""),
      },
    };
  }
  const unreachable = reason === AUTH_RELAY_UNREACHABLE;
  return {
    status: 503,
    body: {
      ok: false,
      error: unreachable
        ? "中继服务暂时不可达（网络波动或中继正在重启），请稍后重试"
        : "账号已登录，但中继连接尚未就绪（正在建立安全通道），请稍后重试",
      hint: unreachable ? "relay_unreachable" : "relay_not_ready",
      retryable: true,
      detail: String(detail || ""),
    },
  };
}

/**
 * 取 relay token 或直接回错误响应（面板代理统一入口）。
 * @returns {Promise<string>} token；为空串表示已写出错误响应（调用方直接 return）
 */
async function relayTokenOrReject(relayDir, res, cfgOverride) {
  const a = await relayTokenWithReason(relayDir, cfgOverride).catch((e) => ({
    token: "",
    reason: AUTH_RELAY_UNREACHABLE,
    status: 0,
    detail: e && e.message,
  }));
  if (a.token) return a.token;
  const { status, body } = relayAuthFailureJson(a.reason, a.detail);
  console.warn(`[dsh-remote-web] 取 relay token 失败(${a.reason}/${a.status}): ${a.detail || "无详情"}`);
  sendJson(res, status, body);
  return "";
}

/**
 * 透传企业端响应体：契约字段可能在顶层或 data 子对象里（容错）。
 * 返回扁平对象；数组字段只取首层数组。
 */
function flattenRelayBody(r) {
  const b = r && typeof r === "object" && r.body && typeof r.body === "object" ? r.body : {};
  const d = b.data && typeof b.data === "object" ? { ...b.data, ...b } : b;
  return d;
}

/**
 * GET /dsh-remote/access-key → 创建一次性访问密钥（企业端 POST /api/auth-key，Bearer device-login token）。
 * 契约容错：url 必须可用；qr_data_url 取不到时返回 null（UI 只展示链接并说明“二维码暂不可用”，不报错）。
 */
async function proxyCreateAccessKey(relayDir, res) {
  const token = await relayTokenOrReject(relayDir, res);
  if (!token) return;
  const r = await relayFetch(relayDir, "/api/auth-key", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const d = flattenRelayBody(r);
  const url = typeof d.url === "string" ? d.url.trim() : "";
  if (!r.ok || !url) {
    // url 不可用是硬失败（企业端契约缺陷）；错误码/状态透传给 UI 展示
    const err = r.ok && !url ? "企业端未返回可用的访问地址（缺 url）" : relayErrorMessage(r);
    return sendJson(res, (r && r.status) || 502, { ok: false, error: err, relayStatus: (r && r.status) || 0 });
  }
  return sendJson(res, 200, {
    ok: true,
    url,
    key: d.key ?? null,
    expires_at: d.expires_at ?? null,
    ttl_ms: d.ttl_ms ?? null,
    qr_data_url: d.qr_data_url ?? null,
    relayStatus: (r && r.status) || 200,
  });
}

/**
 * GET /dsh-remote/mobile-sessions → 已授权设备列表（企业端 GET /api/mobile-sessions，Bearer）。
 */
async function proxyMobileSessions(relayDir, res) {
  const token = await relayTokenOrReject(relayDir, res);
  if (!token) return;
  const r = await relayFetch(relayDir, "/api/mobile-sessions", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const d = flattenRelayBody(r);
  const sessions = Array.isArray(d.sessions) ? d.sessions : [];
  if (!r.ok) {
    return sendJson(res, (r && r.status) || 502, { ok: false, error: relayErrorMessage(r), relayStatus: (r && r.status) || 0, sessions });
  }
  return sendJson(res, 200, { ok: true, sessions, relayStatus: (r && r.status) || 200 });
}

/**
 * POST /dsh-remote/mobile-sessions/revoke（body {id}）→ 取消配对（企业端 POST /api/mobile-sessions/:id/revoke，Bearer）。
 */
async function proxyRevokeMobileSession(relayDir, req, res) {
  const body = await readJsonBody(req);
  if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
  const id = String(body.id ?? "").trim();
  if (!id) return sendJson(res, 400, { ok: false, error: "缺少参数 id（会话 ID）" });
  const token = await relayTokenOrReject(relayDir, res);
  if (!token) return;
  const r = await relayFetch(relayDir, `/api/mobile-sessions/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const d = flattenRelayBody(r);
  // 兼容两种成功形态：HTTP ok，或 body.ok === true（允许企业端 200 + ok:false 表示业务失败）
  const ok = !!(r.ok && d.ok !== false);
  if (!ok) {
    return sendJson(res, (r && r.status) || 502, { ok: false, error: relayErrorMessage(r), relayStatus: (r && r.status) || 0 });
  }
  return sendJson(res, 200, { ok: true, relayStatus: (r && r.status) || 200 });
}

/**
 * DELETE /dsh-remote/mobile-sessions/delete（body {id}）→ 删除本机该设备的授权记录
 * （企业端 DELETE /api/mobile-sessions/:id，Bearer：本人整行删除并拉黑 jti）。
 */
async function proxyDeleteMobileSession(relayDir, req, res) {
  const body = await readJsonBody(req);
  if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
  const id = String(body.id ?? "").trim();
  if (!id) return sendJson(res, 400, { ok: false, error: "缺少参数 id（会话 ID）" });
  const token = await relayTokenOrReject(relayDir, res);
  if (!token) return;
  const r = await relayFetch(relayDir, `/api/mobile-sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const d = flattenRelayBody(r);
  const ok = !!(r.ok && d.ok !== false);
  if (!ok) {
    return sendJson(res, (r && r.status) || 502, { ok: false, error: relayErrorMessage(r), relayStatus: (r && r.status) || 0 });
  }
  return sendJson(res, 200, { ok: true, relayStatus: (r && r.status) || 200 });
}

/**
 * POST /dsh-remote/mobile-sessions/purge → 清理本人所有已解绑（revoked）记录
 * （企业端 POST /api/mobile-sessions/purge，Bearer）。
 */
async function proxyPurgeMobileSessions(relayDir, res) {
  const token = await relayTokenOrReject(relayDir, res);
  if (!token) return;
  const r = await relayFetch(relayDir, "/api/mobile-sessions/purge", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const d = flattenRelayBody(r);
  const ok = !!(r.ok && d.ok !== false);
  if (!ok) {
    return sendJson(res, (r && r.status) || 502, { ok: false, error: relayErrorMessage(r), relayStatus: (r && r.status) || 0 });
  }
  const removed = Number.isInteger(d.removed) ? d.removed : null;
  const payload = { ok: true, relayStatus: (r && r.status) || 200 };
  if (removed !== null) payload.removed = removed;
  return sendJson(res, 200, payload);
}

// ---------- 综合状态 ----------

/**
 * 读取 bridge 写入的 E2EE 开关状态（<relayDir>/.e2ee-state.json，写入方见
 * clients/dsh-remote/e2ee-client.mjs 的 writeE2eeStateFile：{enabled, reason, profile, epoch, caps, at}）。
 * 归一化后只透出固定展示字段（enabled/reason/profile/epoch/caps），at 等调试字段不外泄；
 * 文件缺失/损坏一律视为「未启用（明文回退）」——面板据此显示普通安全连接。
 */
export function readE2eeStateFile(relayDir) {
  const none = () => ({ enabled: false, reason: "no_state_file", profile: "", epoch: 0, caps: [] });
  try {
    const f = join(relayDir, ".e2ee-state.json");
    if (!existsSync(f)) return none();
    const s = JSON.parse(readFileSync(f, "utf8"));
    if (!s || typeof s !== "object") return none();
    return {
      enabled: s.enabled === true,
      reason: typeof s.reason === "string" && s.reason ? s.reason : "",
      profile: typeof s.profile === "string" ? s.profile : "",
      epoch: Number.isInteger(s.epoch) && s.epoch >= 0 ? s.epoch : 0,
      caps: Array.isArray(s.caps) ? s.caps.filter((c) => typeof c === "string") : [],
    };
  } catch {
    return none();
  }
}

/**
 * 手机号脱敏(隐私审计 2026-09):面板/镜像 UI 一律不下发明文手机号。
 * 明文只在 bridge 本机 config / 服务端账号体系内流转,浏览器侧仅见掩码。
 */
function maskPhone(p) {
  const s = String(p || "");
  return s.length >= 7 ? s.slice(0, 3) + "****" + s.slice(-4) : (s ? s.slice(0, 1) + "****" : "");
}

async function composeStatus(relayDir) {
  const cfg = loadConfig(relayDir);
  const launchd = launchdStatus();
  const manual = manualStatus(relayDir);
  // 注册/绑定失败提示(bridge 写 .bind-error.json;面板据此展示“已达上限/需解绑”引导)
  let bindError = null;
  try {
    const f = join(relayDir, ".bind-error.json");
    if (existsSync(f)) bindError = JSON.parse(readFileSync(f, "utf8"));
  } catch { /* 无/损坏忽略 */ }
  // 远程地址（public-config 的 app_url，取不到用默认）
  const pub = await relayFetch(relayDir, "/api/public-config");
  const pubBody = pub.ok && pub.body && typeof pub.body === "object" ? pub.body : {};
  const remoteUrl = pubBody.app_url || DEFAULT_APP_URL;
  const apiUrl = pubBody.api_url || cfg.api_url || DEFAULT_API;
  return {
    ok: true,
    config: {
      phone: maskPhone(cfg.phone || ""),
      hasPhone: Boolean(cfg.phone),
      hasPassword: Boolean(cfg.password),
      deviceId: cfg.device_id || "",
      apiUrl,
      mode: cfg.local_key ? "local" : "saas",   // 连接模式:saas(公网) | local(自建)
      selfHostUrl: cfg.tunnel_url ? cfg.tunnel_url.replace(/^wss?:\/\//, "").replace(/\/+$/, "") : "",
      hasLocalKey: Boolean(cfg.local_key),
    },
    remoteUrl,
    relayReachable: pub.ok,
    service: {
      plistExists: Boolean(launchAgentPath() && existsSync(launchAgentPath())),
      // 平台与服务管理器：面板据此给出平台正确的文案（Windows 没有"自启动服务"这回事，
      // 也不该把 bridge 说成 launchd/systemd 服务）
      platform: osPlatform(),
      serviceManager: isDarwin() ? "launchd" : isWindows() ? "detached" : osPlatform() === "linux" ? "systemd" : "none",
      // Windows：登录任务（任务计划程序）是否已注册——面板据此给"能不能开机自启"的准确说法
      autostartTask: isWindows() ? windowsTaskRegistered() : null,
      launchd,
      manual,
      running: launchd.running || manual.bridge.length > 0,
      // 桌面运行环境（固化运行时 dsh-setup.mjs）是否就绪：面板据此区分
      // 「运行环境没装（正在自动补装）」与「装了但没跑」，不再把崩溃循环显示成「运行中」。
      runtimeReady: runtimeReady(relayDir),
      bindError,
      // E2EE 开关状态（bridge 写 .e2ee-state.json；文件缺失 = 未启用明文）：
      // {enabled, reason, profile, epoch, caps}，供面板「📱 远程访问」卡展示加密状态。
      e2ee: readE2eeStateFile(relayDir),
    },
    // 是否需要重启 DeepSeek harness（首次安装 / 在线更新后必须重启才加载插件本体）：
    // {pending, kind: first-install|update, reason, at}，供面板顶部醒目提示 + 重启按钮。
    restart: readRestartState(relayDir),
    // 连接阶段（登录后自动闭环：环境 → bridge 进程 → 设备已在中继注册）：
    // 面板用它显示「正在准备运行环境…/正在启动 Bridge…/正在连接中继…/已连接 ✅」，
    // 并用 /dsh-remote/bridge-status 以 2~3s 短轮询自动推进（无需用户点按钮或刷新页面）。
    connect: await composeConnect(relayDir, { cfg, launchd, manual }),
    // 隐私审计(2026-09):不再下发真实 hostname(移除 host 字段)——设备标识统一走 deviceId/服务端登记名
  };
}

// ---------- 用户反馈代理（反馈 API 与账号服务同源，走 /relay-api/） ----------

/**
 * 反馈 API 基址：feedback_url（自建/兼容实现）> 账号 API 基址（默认生产 relay-api）。
 * 反馈端点路径与账号 API 同构：{base}/api/feedback*。
 */
function feedbackApiOf(cfg) {
  return (cfg.feedback_url || cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
}

/** 读取请求体（上限 64KB，与反馈服务一致）。 */
async function readBodyBuffer(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) {
      const e = new Error("body too large");
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * 把 /dsh-remote/feedback/* 代理到反馈 API（同源 /relay-api/）：
 *   - 自动附加本机稳定身份 X-Dsh-Device（device_id）与 X-Dsh-Phone（已登录手机号）
 *   - 透传浏览器带的 Authorization（thread_token，存于浏览器 localStorage）
 *   - 不转发 cookie/浏览器标记；反馈服务不可达时降级 502 JSON
 */
// 账号 JWT 缓存（反馈请求高频，避免每次 device-login 刷审计日志）；过期前复用
let fbTokenCache = { token: "", exp: 0 };
async function feedbackAuthToken(relayDir) {
  if (fbTokenCache.token && Date.now() < fbTokenCache.exp) return fbTokenCache.token;
  const t = await relayToken(relayDir).catch(() => "");
  if (t) fbTokenCache = { token: t, exp: Date.now() + 100 * 60 * 1000 };
  else fbTokenCache = { token: "", exp: 0 };
  return t;
}
async function proxyFeedback(relayDir, req, res, pathname) {
  const cfg = loadConfig(relayDir);
  const api = feedbackApiOf(cfg);
  const suffix = pathname.replace(/^\/dsh-remote\/feedback/, "") || "/";
  // 相对路径解析：保留基址的路径前缀（如 /relay-api），避免 new URL 绝对路径吞掉 base path
  const base = api.endsWith("/") ? api : `${api}/`;
  const url = new URL(suffix.replace(/^\//, ""), base);
  const headers = {
    "x-dsh-device": cfg.device_id || "",
    "x-dsh-client": `dsh-remote-web/${PLUGIN_VERSION}`,
  };
  if (cfg.phone) headers["x-dsh-phone"] = String(cfg.phone);
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    headers.authorization = auth;
  } else if (cfg.local_key || (cfg.phone && cfg.password)) {
    // 登录态统一免验证码：节点半自动附加账号 JWT（服务端对有效 JWT 免验证码）
    const t = await feedbackAuthToken(relayDir);
    if (t) headers.authorization = `Bearer ${t}`;
  }
  const method = req.method || "GET";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    let buf;
    try {
      buf = await readBodyBuffer(req);
    } catch (e) {
      return sendJson(res, e.status || 413, { ok: false, error: "请求体过大" });
    }
    if (buf.length) {
      const ct = req.headers["content-type"] || "application/json";
      init.body = buf;
      headers["content-type"] = ct;
    }
  }
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    // 401（token 失效）→ 清缓存，下次请求自动刷新
    if (r.status === 401) fbTokenCache = { token: "", exp: 0 };
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
    return body;
  } catch (e) {
    return sendJson(res, 502, { ok: false, error: `反馈服务不可达: ${e.message}`, hint: "请确认反馈服务已启动，或检查 .dsh-config.json 的 feedback_url" });
  }
}

// ---------- 自管理：版本 / 在线更新 / 彻底卸载（面板内“版本与更新”卡片） ----------

/** 插件 id / 包名（2026-09 由 dsh-remote-ui 更名）。 */
const PLUGIN_ID = "dsh-remote-web";
/** 更名前 id（≤0.4.9）：彻底卸载/清理时一并移除，防旧拷贝残留。 */
const PLUGIN_LEGACY_IDS = ["dsh-remote-ui"];
const PLUGIN_ALL_IDS = [PLUGIN_ID, ...PLUGIN_LEGACY_IDS];
/** 插件自身发布版本（与 dsh-remote 根包同步递增）。 */
const PLUGIN_VERSION = "0.6.10-beta.3";
const UPDATE_LOG = ".dsh-update.log";
const UPDATE_MARKER = ".dsh-update-running";

/**
 * 更新通道（发布策略）：普通用户只拉稳定 dist-tag `latest`；预发(alpha/beta)由作者/内测
 * 通过 `DSH_UPDATE_TAG=beta`（或显式版本号）拉取。迭代一律先发 beta/alpha，稳定后才升 latest。
 */
/**
 * 「无输出看门狗」——更新与补装共用（0.6.9）。
 *
 * 0.6.8 诊断报告的核心结论：旧的三套卡死治理（sweepStaleMarkers / runOnlineUpdate 的陈旧判定 /
 * 镜像回退）**判据全选错了** —— 它们问的是"标记还在不在 / 进程还活不活"，没有一套在问
 * "它还在不在往前推进"。而中国网络访问 registry.npmjs.org 的**典型**失败形态恰恰是**挂起**
 * （TCP 连得上、传输不动）：进程活着、标记是新的、却永远不产出任何事件（没有 exit、没有新日志）。
 * 于是镜像回退只在"快速失败"这一种形态下生效，最常见的那种零覆盖 ——
 * 用户看到的是永久「更新中 / 正在安装」，而装机数就是不涨。
 *
 * 判据换成**日志文件多久没有新增字节**：进度信号是现成的（两条路径本来就把子进程输出写进日志），
 * 而且用 mtime 判定在**宿主重启后依然有效**（内存里的看门狗做不到这点）。
 * 超时 → 判定卡住 → 结束该子进程 → 走与 exit≠0 **完全相同**的回退路径。
 * 阈值可用 DSH_UPDATE_IDLE_MS / DSH_INSTALL_IDLE_MS 覆盖（仅供测试把链路压到亚秒级）。
 */
function stallPollMs() {
  const n = Number(process.env.DSH_STALL_POLL_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}
/** 无输出多久判定卡住；默认 120s（给慢链路留余量，又不让用户干等到天荒地老）。 */
function stallIdleMs(kind) {
  const env = kind === "update" ? process.env.DSH_UPDATE_IDLE_MS : process.env.DSH_INSTALL_IDLE_MS;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/** 日志文件自 `since` 以来多久没变化（毫秒）。取不到文件时退化为"距 since 的时长"。 */
function progressIdleMs(relayDir, logName, since) {
  try {
    return Date.now() - statSync(join(relayDir, logName)).mtimeMs;
  } catch {
    return Date.now() - (Number(since) || Date.now());
  }
}

/** 进度看板：key → { startedAt, lastProgressAt, lastSize, stalled, kind, timer }（供面板读"已用时/是否卡住"）。 */
const progressWatch = new Map();

/**
 * 给一个后台子进程装上无输出看门狗。
 * @param {string} key 唯一键（'update' / 'install:<relayDir>'）
 * @param {{relayDir:string, logName:string, getChild:()=>any, onStall?:(idleMs:number)=>void, kind:"update"|"install"}} opts
 */
function startProgressWatch(key, opts) {
  stopProgressWatch(key);
  const { relayDir, logName, getChild, onStall, kind } = opts;
  const logFile = join(relayDir, logName);
  const st = { startedAt: Date.now(), lastProgressAt: Date.now(), lastSize: -1, stalled: false, kind, timer: null };
  progressWatch.set(key, st);
  const timer = setInterval(() => {
    let size = -1;
    try { size = statSync(logFile).size; } catch { size = -1; } // 文件还没有 = 也没有任何输出
    if (size !== st.lastSize) { st.lastSize = size; st.lastProgressAt = Date.now(); return; } // 有新增输出 = 在推进
    const idle = Date.now() - st.lastProgressAt;
    if (idle < stallIdleMs(kind)) return;
    st.stalled = true;
    clearInterval(timer);
    timer.unref?.();
    // ① 先结束子进程：它会触发 'exit'，从而走与"退出码非 0"完全相同的回退/报错路径
    try { getChild()?.kill(); } catch { /* 已退出 */ }
    // ② 再通知调用方记日志（顺序固定：kill 是必须发生的动作，日志是告知）
    try { onStall?.(idle); } catch { /* 回调出错不得影响关闭 */ }
  }, stallPollMs());
  timer.unref?.();
  st.timer = timer;
  return st;
}

function stopProgressWatch(key) {
  const st = progressWatch.get(key);
  if (st?.timer) clearInterval(st.timer);
  progressWatch.delete(key);
}

/** 供面板/诊断读取的进度信息（没有进行中的任务时返回 null）。 */
function progressInfoOf(key) {
  const st = progressWatch.get(key);
  if (!st) return null;
  const now = Date.now();
  return {
    elapsedMs: now - st.startedAt,
    idleMs: now - st.lastProgressAt,
    stalled: Boolean(st.stalled),
    idleThresholdMs: stallIdleMs(st.kind),
  };
}

/**
 * 结束"标记里记着、但已经不推进"的子进程。
 * 诊断报告 P2：挂死的子进程**从不被结束**（`child.kill()` 在插件半全文无匹配，标记里的 pid
 * 只被用来"判活"、从未被用来"结束"）→ 用户重试几次就在机器上堆几个挂死的 node 进程，无人回收。
 * 判据同样不能用 pidAlive（挂起的进程是"活"的），要结合"日志多久没变化"。
 */
function killStalledChild(relayDir, logName, info, kind, why) {
  const pid = Number(info && info.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pidAlive(pid) !== true) return false;                     // 已经死了：交给标记清理逻辑
  const idle = progressIdleMs(relayDir, logName, info && info.at);
  if (idle < stallIdleMs(kind)) return false;                   // 还在推进：不碰它
  const ok = killPid(pid, "SIGKILL");                            // Windows 上走 taskkill /T /F
  appendLogLine(relayDir, AUTO_INSTALL_LOG,
    `[dsh-remote-web] 结束卡住的${kind === "update" ? "更新" : "运行环境安装"}进程 pid=${pid}（${why}；已 ${Math.round(idle / 1000)}s 无输出）`);
  return ok;
}

/**
 * 更新通道（0.6.9 修：诊断报告 P3「通道默认值不自洽」）。
 * 原实现无条件拉 `latest`：**预发版装机的用户在面板点「一键更新」= 降级或什么都不做**，
 * 而面板既不显示当前通道、也不沿用当前通道 —— 作者/内测用户点出一个方向相反的操作且无从判断。
 * 现在：显式设置优先（DSH_UPDATE_TAG，用于主动切通道），否则**沿用装机通道**
 * （当前是预发版 → beta；正式版 → latest）。
 */
function updateChannel() {
  const explicit = String(process.env.DSH_UPDATE_TAG || "").trim().replace(/^@/, "");
  if (explicit) return explicit;
  return /-/.test(String(PLUGIN_VERSION || "")) ? "beta" : "latest";
}
const UPDATE_TAG = updateChannel();
const UPDATE_SPEC = `@mrrisega/dsh-remote@${UPDATE_TAG}`;
/** 看门狗在 progressWatch 里的键（更新只有一个，用常量；补装按 relayDir 区分）。 */
const UPDATE_WATCH_KEY = "update";
/**
 * 被用户取消的更新（按 relayDir）。
 * 为什么需要：取消会 kill 子进程 → 触发 'exit' → 那里的"换源重试"逻辑会**立刻重新 spawn**，
 * 把标记写回来，用户看到的是"点了取消还在更新"。这个集合就是给重试链装的总闸。
 */
const updateCancelledDirs = new Set();

/** 抓一次 npm dist-tags（官方源优先，失败回退 npmmirror；纯服务端无 CORS 限制）。 */
async function fetchDistTags() {
  for (const reg of ["https://registry.npmjs.org/@mrrisega/dsh-remote", "https://registry.npmmirror.com/@mrrisega/dsh-remote"]) {
    try {
      const res = await fetch(reg, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json();
      const tags = j && j["dist-tags"] ? j["dist-tags"] : {};
      if (Object.keys(tags).length) return tags;
    } catch { /* 试下一个源 */ }
  }
  return {};
}

/** 在「当前通道」与 latest 之间取更高者（**更新与"检查更新"必须用同一口径**，否则面板会说"已是最新"而更新却装新版）。 */
function pickBestTag(tags) {
  const t = tags || {};
  const channelVer = typeof t[UPDATE_TAG] === "string" ? t[UPDATE_TAG] : "";
  const latestVer = typeof t.latest === "string" ? t.latest : "";
  if (!latestVer) return { tag: UPDATE_TAG, version: channelVer, why: "线上没有 latest 通道信息" };
  if (!channelVer) return { tag: "latest", version: latestVer, why: "当前通道无对应版本，改用 latest" };
  const cmp = compareVersions(latestVer, channelVer);
  if (cmp !== null && cmp > 0) {
    return { tag: "latest", version: latestVer, why: `latest(${latestVer}) 高于当前通道 ${UPDATE_TAG}(${channelVer})` };
  }
  return { tag: UPDATE_TAG, version: channelVer, why: `当前通道 ${UPDATE_TAG}(${channelVer}) 不低于 latest(${latestVer})` };
}

/** 查询"对我而言"的最新版本号（口径同 pickBestTag）。 */
async function npmLatestVersion() {
  return pickBestTag(await fetchDistTags()).version;
}

/**
 * 决定本次更新**真正该装的 tag**：在「当前通道」与 `latest` 之间**取更高者**。
 *
 * 为什么不无条件跟随通道（诊断报告 P3 的另一半）：开发期内 beta 领先（跟随 beta 是对的），
 * 但**正式版一旦发布，latest 就反超**；此时死跟 beta 会让内测用户卡在一个旧 beta 上，
 * 点「一键更新」什么都不发生 —— 那正是报告里说的"方向相反的操作"。
 * 取更高者同时满足两种情况：既不会把 beta 装机降级到稳定版，也不会让它错过已发布的稳定版。
 * 取不到 tag（断网/超时）时保守回退到当前通道，绝不因此阻断更新。
 * @returns {{tag:string, version:string, why:string}}
 */
async function resolveUpdateTarget() {
  try {
    return pickBestTag(await fetchDistTags());
  } catch {
    return { tag: UPDATE_TAG, version: "", why: "无法读取 npm 通道信息，按当前通道执行" };
  }
}

/**
 * 语义化版本比较（只处理本仓库用到的形态：`X.Y.Z` 与 `X.Y.Z-<pre>.<n>`）。
 * 为什么需要它：面板判断"有没有新版本"不能只用 `latest !== current` ——
 * 预设版之间（beta.10 → beta.11）无法比较大小，而且预设版在 semver 里**低于**同号正式版
 * （0.6.4 < 0.6.4），朴素不等判断会把"已经装了预设版"误判成落后。
 * @returns {number} a>b → 1；a<b → -1；相等 → 0
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || "").trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null; // 无法解析 → 交给调用方保守处理
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;   // 有预设版 < 无预设版（semver §11）
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
    if (n1 !== null) return -1; // 数字标识符 < 字母标识符
    if (n2 !== null) return 1;
    if (p1 !== p2) return p1 > p2 ? 1 : -1;
  }
  return 0;
}

/**
 * 最近一次在线更新的失败信息（内存态，TTL 10 分钟）。
 *
 * 为什么需要它：此前"一键更新/一键修复"点了没反应 —— spawn 是异步的，npx 解析失败时
 * 同步分支仍然返回 `{ok:true}`，而错误只写进 `.dsh-update.log`；前端看到 ok:true 就显示
 * 「更新已开始」，2 秒后轮询到 marker 被清（running:false）便显示「已更新完成」——
 * 版本没变、运行环境仍缺失，界面上没有任何失败提示（用户实测：点了没反应）。
 * 现在失败原因进内存态并可查询，前端在"没成功"时能如实报错。
 */
const updateFailures = new Map(); // relayDir → { at, detail, failCode }
const UPDATE_FAILURE_TTL_MS = 10 * 60 * 1000;

function noteUpdateFailure(relayDir, detail, failCode) {
  updateFailures.set(String(relayDir), { at: Date.now(), detail: String(detail || "未知原因"), failCode: failCode || "unknown" });
}

function recentUpdateFailure(relayDir) {
  const rec = updateFailures.get(String(relayDir));
  if (!rec) return null;
  if (Date.now() - rec.at > UPDATE_FAILURE_TTL_MS) { updateFailures.delete(String(relayDir)); return null; }
  return rec;
}

/** 以 detached 子进程执行 `npx --yes <UPDATE_SPEC>`（env 可覆盖 npm 源/更新通道）。
 * @returns {{child, error}} 由 safeSpawn 返回——永远挂了 'error' 监听，启动失败不会打挂宿主。
 */
function spawnUpdater(relayDir, extraEnv, onError, spec = UPDATE_SPEC) {
  const log = join(relayDir, UPDATE_LOG);
  const npx = npxInvocation();
  return safeSpawn(npx.command, [...npx.args, "--yes", spec], {
    detached: true,
    cwd: homedir(),
    // Windows 上跑 npx.cmd 必须经 shell（Node ≥20.12 起否则 EINVAL）；走 node+npx-cli.js 时不需要。
    shell: npx.shell,
    windowsHide: true, // Windows：不弹控制台窗口（POSIX 上该选项被忽略）
    // PATH 补 node 目录：App 最小 PATH 下也能跑 npx；同时保持本机既有的安装来源口径
    // （在线更新会重跑安装器并重写 plist，若不带来源就会把 plugin_market 误记成 npx）。
    env: spawnEnv({ DSH_BRIDGE_INSTALL_SOURCE: installSourceOf(relayDir), ...(extraEnv || {}) }),
    stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
    onError,
  });
}

/**
 * 后台执行在线一键更新：npx 按 dist-tag(默认 latest)（幂等自愈：补运行环境/更新 bridge/收敛 include）。
 * 稳健性：
 *   - npx 用绝对路径 + PATH 补全解析（App 拉起的 dsh web PATH 最小化时不再 ENOENT 静默失败）；
 *   - 【官方源优先】镜像(npmmirror)滞后时会把旧版(如 0.4.4)当成最新安装，旧 pluginCmd 会把
 *     已被移除的“用户 include”重新写回 profile → dsh web 重启重复 ID 崩溃。故先试官方源，
 *     失败(国内网络)才回退用户默认镜像源；
 *   - marker 记录 pid，子进程退出/出错即清理；宿主重启后由 sweepStaleMarkers 立即清掉死进程残留。
 */
async function runOnlineUpdate(relayDir) {
  try {
    mkdirSync(relayDir, { recursive: true });
    const marker = join(relayDir, UPDATE_MARKER);
    if (existsSync(marker)) {
      // 残留 marker（进程被强杀/上次异常退出）会让点击**永久**被拒，前端还会把它当成
      // "正在跟踪进度"而只转圈不报错。超过 10 分钟一律视为陈旧并清理。
      let stale = false;
      try { stale = Date.now() - statSync(marker).mtimeMs > 10 * 60 * 1000; } catch { /* ignore */ }
      if (stale) {
        try { rmSync(marker, { force: true }); } catch { /* ignore */ }
        appendLogLine(relayDir, UPDATE_LOG, "[update] 清理超过 10 分钟的陈旧 in-progress 标记");
      } else {
        return { ok: false, detail: "已有更新在进行中，请稍候（若长时间无进展，最多 10 分钟后可重试）" };
      }
    }
    updateCancelledDirs.delete(relayDir); // 新一轮开始：清掉上次的取消闸
    // 【0.6.9】目标 tag 在「当前通道」与 latest 之间取更高者（见 resolveUpdateTarget 注释）：
    // 既不把内测装机降级到稳定版，也不让它错过已发布的正式版。
    const target = await resolveUpdateTarget();
    const spec = `@mrrisega/dsh-remote@${target.tag}`;
    appendLogLine(relayDir, UPDATE_LOG,
      `[update] 开始在线更新 ${spec}（通道 ${UPDATE_TAG}；${target.why}）(${new Date().toISOString()})`);
    telemetryRecord(relayDir, "update_started"); // 匿名遥测：在线更新开始

    let retried = false;
    let stalled = false; // 本轮是否因"长时间无输出"被判定卡住（决定失败归因与是否回退）
    const clear = () => {
      stopProgressWatch(UPDATE_WATCH_KEY);
      try { rmSync(marker, { force: true }); } catch { /* ignore */ }
    };
    // 启动失败（ENOENT/EINVAL…）的收尾：清 marker + 记日志 + 记失败原因（面板可查询）+ 匿名遥测。
    // 抽出来给「同步失败」与「异步 'error' 事件」共用，保证任何一种失败都不会变成未捕获异常。
    const failUpdaterSpawn = (e) => {
      appendLogLine(relayDir, UPDATE_LOG, `[update] 子进程启动失败: ${e.message}`);
      clear();
      const fc = telemetryFailCodeFromError(e);
      noteUpdateFailure(relayDir, e.message, fc); // ← 面板可查询，不再只躺在日志里
      telemetryRecord(relayDir, "update_failed", { fail_code: fc });
    };
    const run = () => {
      if (updateCancelledDirs.has(relayDir)) { updateCancelledDirs.delete(relayDir); return null; } // 已取消：不再重试
      // 第一次：官方 npm 源；失败(exit≠0 **或长时间无输出**)才回退用户默认源（通常为国内镜像）
      stalled = false;
      const holder = { child: null };
      const { child, error } = spawnUpdater(
        relayDir, retried ? {} : { npm_config_registry: "https://registry.npmjs.org" }, failUpdaterSpawn, spec);
      if (error || !child) {
        if (error) failUpdaterSpawn(error);
        return null;
      }
      holder.child = child;
      writeMarker(marker, child.pid);
      // 【0.6.9 关键修复】无输出看门狗：中国网络访问 npm 官方源的典型失败形态是**挂起**
      // （进程活着、永远不产出 exit），旧实现只看"退出码非 0"，于是回退永不触发、标记永不清除、
      // 用户永久停在「更新中」。这里以"日志多久没新增字节"为判据，卡住即结束进程 →
      // 自然而然地走下面 exit≠0 的同一条回退路径。
      startProgressWatch(UPDATE_WATCH_KEY, {
        relayDir, logName: UPDATE_LOG, kind: "update",
        getChild: () => holder.child,
        onStall: (idle) => {
          stalled = true;
          appendLogLine(relayDir, UPDATE_LOG,
            `[update] 已 ${Math.round(idle / 1000)}s 无输出 → 判定卡住，结束该进程${retried ? "（已重试过，不再回退）" : "，回退默认源(npmmirror 等)重试"}…`);
        },
      });
      child.on("exit", (code) => {
        stopProgressWatch(UPDATE_WATCH_KEY);
        // 用户取消导致的退出：既不重试、也不记失败（取消不是失败）
        if (updateCancelledDirs.has(relayDir)) {
          updateCancelledDirs.delete(relayDir);
          appendLogLine(relayDir, UPDATE_LOG, "[update] 已取消：不再换源重试");
          return;
        }
        if (!retried && (code !== 0 || stalled)) {
          retried = true;
          appendLogLine(relayDir, UPDATE_LOG,
            `[update] ${stalled ? "官方源长时间无输出" : `官方源安装失败(exit=${code})`}，回退默认源(npmmirror 等)重试…`);
          run();
          return;
        }
        appendLogLine(relayDir, UPDATE_LOG, `[update] npx 退出 code=${code ?? "?"}（${retried ? "默认源" : "官方源"}）`);
        clear();
        // 在线更新改写了插件/运行环境文件 → 版本对不上时由 pluginInstalledAfterBoot() 自动识别，
        // 面板会提示"刷新页面"。这里**不再**写"需要重启 DeepSeek harness"的待重启标记：
        // 插件走 patch 热加载、bridge 是独立进程，重启 harness 已无必要（用户实测反馈）。
        // 成功不发事件（update_started 已发过，失败才发 update_failed；白名单里没有 update_done，
        // 硬发只会被服务端静默丢弃）。
        if (code !== 0 || stalled) {
          const tail = readTail(join(relayDir, UPDATE_LOG));
          // 卡住是一种**独立的失败形态**，必须有自己的归因码 —— 旧实现只在 exit≠0 时记失败，
          // 所以遥测里永远看不到"卡死"这一类，规模被持续低估（诊断报告 F2）。
          const fc = stalled ? "update_stalled" : telemetryFailCodeFromText(tail);
          // 只把最后的可读片段给用户看（不含完整路径/用户名）；分类码仍按白名单上报
          const lastLine = String(tail || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] || "";
          noteUpdateFailure(relayDir, stalled
            ? "更新进程长时间没有任何输出（已判定卡住并结束），通常是本机到 npm 官方源的链路不通"
            : (lastLine || `安装进程退出码 ${code}`), fc);
          telemetryRecord(relayDir, "update_failed", { fail_code: fc });
        } else {
          updateFailures.delete(String(relayDir)); // 成功即清掉旧失败
        }
      });
      child.unref();
      return child;
    };
    const child = run();
    // spawn 是异步的：解析失败时 pid 可能是 undefined。此时**不能**同步返回 ok:true，
    // 否则前端会显示"更新已开始"、随后看到 running:false 便报"已完成"（实测的静默失败）。
    if (!child || !child.pid) {
      const rec = recentUpdateFailure(relayDir);
      return { ok: false, detail: (rec && rec.detail) || "无法启动更新进程（npx 不可用？）", failCode: rec ? rec.failCode : "unknown" };
    }
    return { ok: true, pid: child.pid, log: join(relayDir, UPDATE_LOG), channel: UPDATE_TAG, targetTag: target.tag, targetVersion: target.version };
  } catch (e) {
    try { rmSync(join(relayDir, UPDATE_MARKER), { force: true }); } catch { /* ignore */ }
    telemetryRecord(relayDir, "update_failed", { fail_code: telemetryFailCodeFromError(e) });
    return { ok: false, detail: String(e.message || e) };
  }
}

/** 读日志尾部(更新进度展示)。 */
function tailOf(filePath, lines = 24) {
  try {
    const all = readFileSync(filePath, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch { return ""; }
}

/**
 * 判断 patch 文本是否是「合法的顶层 YAML 数组文档」。
 *
 * 为什么必须判（2026-09-18 Windows 用户实测的致命事故）：dsh 解析 cordis.patch.yml 时
 * **要求顶层是数组**，而**纯注释文档的 YAML 解析结果是 `null` 而不是空数组**，于是 dsh 直接：
 *   `Error: dsh: overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries`
 * 官方空 profile 模板是「注释 + `[]`」——`[]` 这个占位符不能省。
 * 卸载把插件条目摘掉后若只剩注释，用户就再也起不来 dsh web（面板也进不去，只能靠 CLI 自救）。
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

/** 摘掉本插件的 patch 条目：管理标记块 + 无标记的 `- insert:` 块（当前名与历史名都清）。 */
function stripOwnEntriesFromPatch(patch) {
  // ① 管理标记块（dsh-setup 写入的形式）
  // 结尾标记后面可能还有残留文字（历史变体），用 [^\n]* 吃掉整行，避免留下半截内容
  const out = String(patch ?? "").replace(/\n?# >>> dsh-remote-(?:web|ui)[^\n]*\n[\s\S]*?# <<< dsh-remote-(?:web|ui)[^\n]*\n?/g, "\n");
  // ② 无标记的 insert 块（旧版 / 其它工具写入的形式，历史事故里出现过）。
  //    只摘标记块是不够的：目录已删而 patch 仍引用 → dsh 插件树加载失败 → 整个 dsh web 起不来。
  const lines = out.split("\n");
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    if (/^- insert:\s*$/.test(lines[i])) {
      const block = [lines[i]];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith(" ") || lines[j].startsWith("\t"))) { block.push(lines[j]); j += 1; }
      if (PLUGIN_ALL_IDS.some((id) => new RegExp(`\\b${id}\\b`).test(block.join("\n")))) {
        while (kept.length && /^\s*#/.test(kept[kept.length - 1])) kept.pop(); // 连带条目上方的说明注释
        i = j;
        continue;
      }
      kept.push(...block);
      i = j;
      continue;
    }
    kept.push(lines[i]);
    i += 1;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * 原子写回 patch，并保证结果仍是合法顶层数组：条目被删光时补回 `[]` 占位。
 * ⚠️ 只在「一个结构行都不剩」时补 —— 不能因为"看起来不像数组"就乱补，
 *    那会把本来好的文件写坏（例如把 `[]` 追加到已有 insert 块后面 → YAML 直接报错）。
 */
function writePatchDocument(patchFile, text) {
  const body = String(text ?? "").replace(/\s+$/, "") + "\n";
  const fixed = needsArrayPlaceholder(body) ? `${body}[]\n` : body;
  const tmp = `${patchFile}.dsh-remote.tmp`;
  writeFileSync(tmp, fixed);
  renameSync(tmp, patchFile);
  return fixed;
}

/**
 * 「运行时清理助手」源码（卸载用；由插件生成、detached 执行）。
 *
 * 为什么必须是独立进程（2026-09-18 用户实测的僵死事故）：
 *   uninstallRuntime() 里有 spawnSync("schtasks"/"powershell"/"taskkill")，同步子进程调用会把
 *   **dsh web 的事件循环整个钉死** —— 不只是这一个请求不返回，手机端隧道、其它页面、所有 API
 *   一起停摆，表现为「端口在听、连接建立、但永不响应」。而 spawnSync 的 timeout 在 Windows 上
 *   **并不可靠**（实测被策略拦截的进程 18s+ 仍未返回），所以不能把 timeout 当设计依据：
 *   真正的解法是不要把同步子进程调用留在宿主进程里。
 *
 * 助手做的是「宁可少做也不卡住」的有界清理：杀残留进程 → 删自启动 → 清配置目录，每步独立 try/catch。
 */
function buildRuntimeCleanupHelper(relayDir, protectedPath) {
  const plan = JSON.stringify({
    relayDir,
    protectedPath: protectedPath || "",
    platform: osPlatform(),
    taskName: WIN_TASK_NAME,
    pidFiles: [WATCHER_PID_FILE, BRIDGE_PID_FILE],
    plistPath: join(homedir(), "Library", "LaunchAgents", "com.dshremote.bridge.plist"),
    unitPath: join(homedir(), ".config", "systemd", "user", "dsh-bridge.service"),
    log: join(tmpdir(), "dsh-remote-uninstall.log"),
  });
  return `// dsh-remote 自动生成：彻底卸载的「运行时清理」部分（独立进程执行，避免阻塞 dsh web）
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

const PLAN = ${plan};
// 与主进程一致的测试隔离开关：置位时**绝不做任何真实系统操作**（不碰 launchctl/systemctl/schtasks/taskkill），
// 但仍清空配置目录 —— 否则用例会去动开发者本机真实的自启动服务（历史事故，见 setup-output 用例的护栏）。
const SKIP_SYSTEM_OPS = process.env.DSH_RELAY_SKIP_SERVICE === "1";
function log(m) { try { appendFileSync(PLAN.log, "\\n[" + new Date().toISOString() + "] " + m + "\\n"); } catch (e) { /* 日志失败不阻断清理 */ } }
function run(cmd, args, timeout) {
  try { const r = spawnSync(cmd, args, { windowsHide: true, encoding: "utf8", timeout }); return r.status === 0; }
  catch (e) { log("命令失败 " + cmd + ": " + e.message); return false; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function readPid(name) {
  try { const n = Number(String(readFileSync(join(PLAN.relayDir, name), "utf8")).trim()); return Number.isInteger(n) && n > 0 ? n : null; }
  catch (e) { return null; }
}
log("运行时清理开始（platform=" + PLAN.platform + "，relayDir=" + PLAN.relayDir + "）");
if (SKIP_SYSTEM_OPS) log("测试隔离（DSH_RELAY_SKIP_SERVICE=1）：跳过一切真实系统操作");

// ① 结束 watcher / bridge 残留进程
for (const name of (SKIP_SYSTEM_OPS ? [] : PLAN.pidFiles)) {
  const pid = readPid(name);
  if (!pid || pid === process.pid) continue;
  if (!alive(pid)) { log(name + " 里的 pid " + pid + " 已不在"); continue; }
  if (PLAN.platform === "win32") run("taskkill", ["/PID", String(pid), "/T", "/F"], 8000);
  else { try { process.kill(pid, "SIGTERM"); } catch (e) { /* 已退出 */ } }
  log("已结束 " + name + " 的进程 pid=" + pid);
}

// ② 移除自启动（按平台）
if (SKIP_SYSTEM_OPS) {
  log("跳过自启动清理（测试隔离）");
} else if (PLAN.platform === "win32") {
  run("schtasks", ["/Delete", "/TN", PLAN.taskName, "/F"], 15000);
  log("已请求删除登录任务 " + PLAN.taskName);
} else if (PLAN.platform === "darwin") {
  if (existsSync(PLAN.plistPath)) {
    run("launchctl", ["bootout", "gui/" + (typeof process.getuid === "function" ? process.getuid() : 0) + "/com.dshremote.bridge"], 8000);
    try { rmSync(PLAN.plistPath, { force: true }); } catch (e) { /* 非关键 */ }
    log("已移除自启动 plist");
  }
} else if (PLAN.platform === "linux") {
  run("systemctl", ["--user", "stop", "dsh-bridge"], 8000);
  run("systemctl", ["--user", "disable", "dsh-bridge"], 8000);
  try { if (existsSync(PLAN.unitPath)) rmSync(PLAN.unitPath, { force: true }); } catch (e) { /* 非关键 */ }
  log("已移除 systemd 用户服务");
}

// ③ 清空配置目录（账号/密钥/会话 cookie/固化运行时）——安全护栏与主进程一致
try {
  const isRoot = dirname(PLAN.relayDir) === PLAN.relayDir;
  const isHome = PLAN.relayDir === homedir();
  const hitsProfile = Boolean(PLAN.protectedPath) && (
    PLAN.relayDir === PLAN.protectedPath
    || PLAN.relayDir.startsWith(PLAN.protectedPath + sep)
    || PLAN.protectedPath.startsWith(PLAN.relayDir + sep));
  if (PLAN.relayDir && !isRoot && !isHome && !hitsProfile && existsSync(PLAN.relayDir)) {
    rmSync(PLAN.relayDir, { recursive: true, force: true });
    log("已清空配置目录");
  } else {
    log("跳过配置目录清理（护栏命中或目录不存在）");
  }
} catch (e) { log("配置目录清理失败: " + e.message); }
log("运行时清理结束");
`;
}

/**
 * 把「运行时清理」交给一个 detached 子进程（不阻塞宿主事件循环）。
 * @returns {{ok:boolean, pid:number|null, log:string, detail:string}}
 */
function spawnRuntimeCleanupDetached(relayDir, protectedPath) {
  const logPath = join(tmpdir(), "dsh-remote-uninstall.log");
  try {
    // 助手放**系统临时目录**而不是 relayDir：它自己就要删 relayDir，
    // 把正在运行的脚本放在待删目录里既别扭又可能在 Windows 上因文件占用而失败。
    const helperPath = join(tmpdir(), `dsh-remote-uninstall-${process.pid}-${Date.now()}.mjs`);
    writeFileSync(helperPath, buildRuntimeCleanupHelper(relayDir, protectedPath));
    const { child, error } = safeSpawn(process.execPath, [helperPath], {
      detached: true, cwd: homedir(), stdio: "ignore", windowsHide: true,
      onError: (e) => console.warn(`[dsh-remote-web] 运行时清理子进程启动失败: ${e.message}`),
    });
    if (error || !child) {
      return { ok: false, pid: null, log: logPath, detail: (error || new Error("spawn 未返回子进程")).message };
    }
    child.unref();
    return { ok: true, pid: child.pid, log: logPath, detail: "已在后台清理" };
  } catch (e) {
    return { ok: false, pid: null, log: logPath, detail: e.message };
  }
}

/** 账号指纹：账号 / 模式 / 设备身份任一变化都意味着"必须用新凭据重新登记"。 */
function accountFingerprintOf(cfg) {
  const c = cfg || {};
  return [c.local_key ? "local" : "saas", c.phone || c.email || "", String(c.device_id || "")].join("|");
}

/**
 * 账号（或模式/设备身份）变化后，**必须让 bridge 用新凭据重新登记**。
 *
 * 事故（2026-09-19 实测）：从 A 账号切到 B 账号后，配置已经改了、device_id 也清了，
 * 但**正在运行的 bridge 是启动时把账号/密码固化在环境变量里的**，它不会自己换账号；
 * 而那次"重启 bridge"又因 launchd 域名不一致（插件只认 gui/<uid>，安装器装在 user/<uid>）静默失败
 * → 设备继续留在 A 账号，B 账号的设备列表里永远看不到这台机器。
 *
 * 这里做三件事：① 停掉旧 bridge（含两个 launchd 域与脱离进程两种形态）；
 * ② 删掉旧账号留下的状态文件（否则面板据 phase=online + 旧 device_id 谎报"已连接"，
 * 自愈也就永远不会去纠正）；③ 交给调用方随后重新启动。
 */
function resetBridgeForAccountChange(relayDir, why) {
  const stopped = stopBridge(relayDir);
  // 脱离进程形态（launchd 托管不住时的兜底）也要收干净，否则它会用旧凭据继续跑
  try { stopBridgeDetached(relayDir, { force: true }); } catch { /* 非关键 */ }
  try {
    if (bridgeStateFile(relayDir)) {
      rmSync(join(relayDir, BRIDGE_STATE_FILE), { force: true });
      appendLogLine(relayDir, AUTO_INSTALL_LOG, `[dsh-remote-web] ${why}：已清除过期的 bridge 状态记录（旧账号的注册证据作废）`);
    }
  } catch { /* 非关键 */ }
  return stopped;
}

/**
 * 运行中的 bridge 是否属于「当前账号」。
 * 判据：bridge 状态文件记录的 device_id 必须与配置里的一致；配置里没有 device_id
 * （= 刚切过账号、旧身份已作废）而状态里还有 → 说明跑的是**上一个账号**的 bridge。
 * @returns {boolean} true=属于当前账号；false=过期（必须重启）；未记录 device_id 时按旧行为返回 true
 */
function bridgeMatchesCurrentAccount(relayDir, cfg) {
  const state = bridgeStateFile(relayDir);
  if (!state || !state.device_id) return true;          // 无记录可判：不改变既有行为
  const want = String((cfg || loadConfig(relayDir)).device_id || "");
  if (!want) return false;                              // 配置里身份已清空 = 旧 bridge 的注册已作废
  return want === String(state.device_id);
}

/** 彻底卸载第 2 步 —— profile 插件清理（兼容市场“拒绝改写用户补丁”）：移除 include、依赖、bundle、本地目录与链接。 */
function uninstallSelf(relayDir, profileDir, patchFile, pkgFile) {
  const out = { removedPatch: false, removedDep: false, removedDir: false, removedBundle: false };
  try {
    const patch = readFileSync(patchFile, "utf8");
    const cleaned = stripOwnEntriesFromPatch(patch); // 兼容当前与历史（dsh-remote-ui）两种名
    if (cleaned !== patch) { writePatchDocument(patchFile, cleaned); out.removedPatch = true; }
  } catch { /* 无 patch 忽略 */ }
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    if (pkg.dependencies) {
      let removed = false;
      for (const id of PLUGIN_ALL_IDS) {
        if (pkg.dependencies[id] !== undefined) { delete pkg.dependencies[id]; removed = true; }
      }
      if (removed) out.removedDep = true;
    }
    const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null;
    if (bundles) {
      const filtered = bundles.filter((b) => !PLUGIN_ALL_IDS.includes(b));
      if (filtered.length !== bundles.length) {
        pkg.dsh.profile.bundles = filtered;
        out.removedBundle = true;
      }
    }
    if (out.removedDep || out.removedBundle) writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  } catch { /* 无 package.json 忽略 */ }
  try {
    for (const id of PLUGIN_ALL_IDS) {
      rmSync(join(profileDir, `${id}-plugin`), { recursive: true, force: true });
      rmSync(join(profileDir, "node_modules", id), { recursive: true, force: true });
    }
    out.removedDir = true;
  } catch { /* ignore */ }
  return out;
}

// ---------- 路由 ----------

/** 路由表：{method, path, handler}。 */
// ---------- 登录后自动闭环：连接阶段（运行环境 → bridge 进程 → 设备已在中继注册=online） ----------

/**
 * 现场观察：新用户注册后手机端 /api/devices 常是空列表，
 * 多人反复点「生成访问链接」（auth.key_create 10~23 次）而 device.bind 始终为 0——他们的电脑端
 * bridge 从未连上过中继。典型路径：注册 → 手机端拿不到设备 → 反复轮询 → 放弃。
 *
 * 缺口不是某个按钮坏了，而是「登录 → 设备已在中继注册成功」这条链路既不可见也不自动：
 * 用户看不出卡在哪一步（运行环境没装？bridge 没起？还是没注册上中继？），也不知道要不要刷新页面。
 *
 * 本段把链路拆成可查询的阶段（GET /dsh-remote/bridge-status），并刻意区分两个极易混淆的状态：
 *   - starting ：「bridge 进程已在跑」——只说明进程起来了；
 *   - online   ：「设备已在中继注册成功」——手机端能看到并进入这台电脑，这才是用户要的「能用了」。
 * 阶段推进所需的动作（补装运行环境 / 拉起 bridge / 可重试错误退避重试）全部由 ensureConnection
 * 在轮询里自动完成，用户零操作、零刷新；只有「彻底失败」才给按钮，且永远留一条可走的路。
 */
const BRIDGE_LOG_FILE = ".dsh-bridge.log";
const BRIDGE_STATE_FILE = ".dsh-bridge-state.json";
const BIND_ERROR_FILE = ".bind-error.json";
/** 安装标记超时（进程已死或超 10 分钟）→ 视为卡死，清掉标记重新补装（否则 marker 会把补装永久挡住）。 */
const INSTALL_STALE_MS = 10 * 60 * 1000;
/** 设备登记失败提示只在一小时内当作「当前故障」（.bind-error.json 是持久文件，成功时才被清掉）。 */
const BIND_ERROR_FRESH_MS = 60 * 60 * 1000;
/** 自动重试退避（毫秒）：可重试错误按此节奏自动重试，用尽后停在 60s（仍会自动重试，不出现死胡同）。 */
const CONNECT_BACKOFF_MS = [2000, 4000, 8000, 16_000, 30_000, 60_000];

/** 连接阶段文案（面向非技术用户；node 半算好，面板直接显示，避免两端各写一套）。 */
const CONNECT_TEXT = {
  no_account: "请先登录手机号账号（下方「🔑 账号」卡片），登录后会自动完成剩余步骤",
  no_runtime: "正在准备运行环境（首次约 1~2 分钟）…",
  installing: "正在准备运行环境（首次约 1~2 分钟）…",
  starting: "正在启动 Bridge…",
  connecting: "正在连接中继…",
  online: "已连接 ✅ 现在可以用手机扫码访问",
  error: "连接失败，请按下方提示处理",
};
const CONNECT_PHASES = ["no_account", "no_runtime", "installing", "starting", "connecting", "online", "error"];

/** 每个 relayDir 的连接状态簿（尝试次数 / 退避 / 上报节流）：放内存，进程重启即重置。 */
const connectBooks = new Map();
function connectBook(relayDir) {
  let b = connectBooks.get(relayDir);
  if (!b) {
    b = { attempts: 0, lastAttemptAt: 0, reportAt: 0 };
    connectBooks.set(relayDir, b);
  }
  return b;
}
/** 已尝试 attempts 次后的退避时长。 */
function connectBackoffMs(attempts) {
  const i = Math.min(Math.max(attempts, 0), CONNECT_BACKOFF_MS.length - 1);
  return CONNECT_BACKOFF_MS[i];
}
/** 本机是否已有可用账号凭据（SaaS 账号或自建访问密钥）——没有就谈不上自动连接，先引导登录。 */
function hasAccountCreds(cfg) {
  return Boolean((cfg.phone || cfg.email) && cfg.password) || Boolean(cfg.local_key);
}

/** 读文件尾部（日志可能很长，只取末尾用于判定最近一次连接结果）。 */
function readTail(filePath, maxBytes = 64 * 1024) {
  try {
    const fd = openSync(filePath, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch { return ""; }
}

/** 读取 bridge 写的状态文件（新版 bridge 会写；旧版没有 → 走日志/账号兜底判据）。 */
function bridgeStateFile(relayDir) {
  try {
    const j = JSON.parse(readFileSync(join(relayDir, BRIDGE_STATE_FILE), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

/**
 * 从 bridge 日志尾部判定「最近一次连接是否注册成功」。
 * 依据 dsh-bridge.mjs 的既有输出：`✅ 设备已登记到账号` / `✅ router 注册成功`；
 * 出现新一轮连接（`隧道已连`）或登记失败/拒绝时，之前那次成功不再代表当前状态。
 */
function bridgeLogState(relayDir) {
  const tail = readTail(join(relayDir, BRIDGE_LOG_FILE));
  if (!tail) return { tunnelRegistered: false, accountBound: false, lastError: "" };
  let tunnelRegistered = false;
  let accountBound = false;
  let lastError = "";
  for (const raw of tail.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/✅\s*router 注册成功/.test(line)) { tunnelRegistered = true; lastError = ""; continue; }
    if (/✅\s*设备已登记到账号/.test(line)) { accountBound = true; lastError = ""; continue; }
    if (/隧道已连|\[dsh-remote\] dsh web 在线，启动 bridge|bridge 退出/.test(line)) {
      tunnelRegistered = false;
      accountBound = false;
      continue;
    }
    if (/拒绝注册|注册发送失败|设备登记失败|无法连接账号 API|设备数已达上限/.test(line)) {
      tunnelRegistered = false;
      accountBound = false;
      lastError = line.slice(0, 300);
    }
  }
  return { tunnelRegistered, accountBound, lastError };
}

/** 读取设备登记失败提示（bridge 在 409/网络失败时写 .bind-error.json）。 */
function readBindError(relayDir) {
  try {
    const f = join(relayDir, BIND_ERROR_FILE);
    if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

/** 运行环境安装状态：installing=安装子进程在跑；stale=标记超时/进程已死（可清掉重来）。 */
function installStateOf(relayDir) {
  const marker = join(relayDir, PROVISION_MARKER);
  if (!existsSync(marker)) return { installing: false, stale: false, at: 0 };
  const info = readMarkerInfo(marker) || {};
  const at = Number(info.at) || 0;
  const pidDead = info.pid ? pidAlive(Number(info.pid)) === false : false;
  const stale = pidDead || (at > 0 && Date.now() - at > INSTALL_STALE_MS);
  return { installing: !stale, stale, at };
}

/** 清掉卡死的安装标记（下轮 ensureRuntime 才能重新拉起补装）。 */
function clearStaleInstallMarker(relayDir) {
  try {
    rmSync(join(relayDir, PROVISION_MARKER), { force: true });
    appendLogLine(relayDir, AUTO_INSTALL_LOG, "[dsh-remote-web] 清理卡死的安装标记（安装进程已退出或超时），将重新补装运行环境");
    return true;
  } catch { return false; }
}

/** 账号设备表里是否已登记本机 device_id（手机端 /api/devices 能看到的那一份）+ 节流缓存。 */
async function accountDeviceBound(relayDir, cfg) {
  const deviceId = String(cfg.device_id || "");
  if (!deviceId) return { bound: false, reason: "no_device_id" };
  const cached = deviceProbeCache.get(relayDir);
  if (cached && Date.now() - cached.at < DEVICE_PROBE_TTL_MS) return cached.value;
  const done = (value) => { deviceProbeCache.set(relayDir, { at: Date.now(), value }); return value; };
  const token = await relayToken(relayDir).catch(() => "");
  if (!token) return done({ bound: false, reason: "no_token" });
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  try {
    const r = await fetch(`${api}/api/devices`, {
      headers: { authorization: `Bearer ${token}`, "x-dsh-client": `dsh-remote-web/${PLUGIN_VERSION}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) invalidateRelayToken(relayDir); // JWT 过期/轮换 → 下次重新认证
      return done({ bound: false, reason: `http_${r.status}` });
    }
    const body = await r.json().catch(() => null);
    const list = Array.isArray(body?.devices) ? body.devices : Array.isArray(body) ? body : [];
    const bound = list.some((d) => String(d?.id || d?.device_id || "") === deviceId);
    return done({ bound, reason: bound ? "" : "not_in_list", count: list.length });
  } catch (e) {
    return done({ bound: false, reason: `unreachable: ${e.message}` });
  }
}

/**
 * 计算当前连接阶段（纯读，不做任何系统操作）。
 * 阶段：no_account | no_runtime | installing | starting | connecting | online | error
 * 判据严格区分「进程在跑」与「已在中继注册」：
 *   online 需要 bridge 进程在跑 **且** 有中继注册证据（状态文件 > 日志 > 账号设备表）。
 */
async function composeConnect(relayDir, opts = {}) {
  const cfg = opts.cfg || loadConfig(relayDir);
  const launchd = opts.launchd || launchdStatus();
  const manual = opts.manual || manualStatus(relayDir);
  const book = connectBook(relayDir);
  const now = Date.now();
  const hasAcct = hasAccountCreds(cfg);
  const runtime = runtimeReady(relayDir);
  const inst = installStateOf(relayDir);
  const bridgePids = Array.isArray(manual.allBridge) ? manual.allBridge : [];
  const bridgeRunning = Boolean(launchd.running || bridgePids.length > 0 || (manual.bridge || []).length > 0);
  const bindError = readBindError(relayDir);
  const bindFresh = Boolean(bindError && (!bindError.at || now - Number(bindError.at) < BIND_ERROR_FRESH_MS));
  const log = bridgeLogState(relayDir);
  const state = bridgeStateFile(relayDir);
  const deviceId = String(cfg.device_id || "");

  // ── 中继注册证据（只有 bridge 进程在跑时才算「现在能用」） ──
  // ⚠️ 先判「这个 bridge 是不是当前账号的」：账号切换后进程不会自己换凭据，
  // 旧账号留下的状态文件（phase=online + 旧 device_id）会让面板谎报「已连接」，
  // 自愈也就永远不会去重启它（2026-09-19 实测事故）。
  const accountCurrent = bridgeMatchesCurrentAccount(relayDir, cfg);
  let registered = false;
  let registerSource = "";
  if (runtime && bridgeRunning && accountCurrent) {
    if (state && state.phase === "online" && Number(state.tunnel_registered_at) > 0) {
      registered = true; registerSource = "state";
    } else if (log.tunnelRegistered) {
      registered = true; registerSource = "tunnel";
    } else if (state && Number(state.account_bound_at) > 0) {
      registered = true; registerSource = "state_account";
    } else if (log.accountBound) {
      registered = true; registerSource = "account";
    } else if (hasAcct) {
      const probe = await accountDeviceBound(relayDir, cfg);
      if (probe.bound) { registered = true; registerSource = "account_api"; }
    }
  }

  let phase;
  let error = null;
  let detail = "";
  let retryable = true;
  if (UNINSTALLED_DIRS.has(relayDir)) {
    phase = "error"; retryable = false;
    error = { code: "uninstalled", message: "本插件已彻底卸载，重启 dsh web 后不再自动启动 bridge" };
    detail = error.message;
  } else if (!hasAcct) {
    phase = "no_account"; retryable = false;
    detail = "尚未登录账号：登录后会自动补装运行环境 → 启动 bridge → 连接中继，全程无需其他操作。";
  } else if (!runtime) {
    if (inst.stale) {
      phase = "error";
      error = {
        code: "install_stuck",
        message: "运行环境安装没有完成（上次安装进程已退出或超时），已清理残留标记并准备重新安装",
      };
      detail = error.message;
    } else {
      phase = inst.installing ? "installing" : "no_runtime";
      detail = inst.installing
        ? "正在后台安装运行环境（bridge 本体），首次约 1~2 分钟，装完会自动启动。"
        : "检测到缺少运行环境，正在后台自动安装（首次约 1~2 分钟），无需任何操作。";
    }
  } else if (!bridgeRunning) {
    if (launchd.crashing) {
      phase = "error";
      error = {
        code: "launchd_crash",
        message: `后台服务反复启动失败（launchd state=${launchd.state || "?"}，lastExit=${launchd.lastExitCode ?? "?"}）`,
      };
      detail = "已自动清理失效的自启动项并重新拉起，稍候会自动恢复。";
    } else if (bindFresh && bindError) {
      phase = "error";
      error = { code: bindError.code || "bind_failed", message: bindError.message || "设备登记失败" };
      detail = "bridge 因设备登记失败退出，已进入自动重试；请按提示处理后重试。";
    } else {
      phase = "starting";
      detail = launchd.running
        ? "后台服务已启动，正在等待 bridge 进程就绪…"
        : "正在启动后台服务（bridge），通常几秒内完成，无需任何操作。";
    }
  } else if (registered) {
    phase = "online";
    detail = registerSource === "account_api" || registerSource === "account" || registerSource === "state_account"
      ? "设备已登记到你的账号：手机端「设备列表」能看到这台电脑，扫码/打开链接即可进入。"
      : "bridge 已注册到中继：手机端扫码/打开链接即可进入这台电脑。";
  } else if (bindFresh && bindError) {
    phase = "error";
    error = { code: bindError.code || "bind_failed", message: bindError.message || "设备登记失败" };
    detail = bindError.code === "device_limit_exceeded"
      ? "已达本套餐设备数上限：同机重装会自动顶替旧设备；仍失败请到手机端「设备管理」解绑旧设备后点「重试」。"
      : "请确认网络与账号状态后点「重试」；仍不成功可点「复制诊断信息」发给客服。";
  } else if (!accountCurrent) {
    // 进程在跑，但它是**上一个账号**的 bridge：必须重启才能用新账号登记
    phase = "starting";
    detail = "检测到后台 bridge 仍是上一个账号的身份（账号切换后需要重启它才能用新账号重新登记），正在自动重启…";
  } else {
    phase = "connecting";
    detail = "bridge 进程已在运行，正在等待设备注册到中继…通常几秒内完成。";
  }

  const wait = connectBackoffMs(book.attempts);
  const elapsed = book.lastAttemptAt ? now - book.lastAttemptAt : wait;
  const autoRetrying = phase !== "online" && phase !== "no_account" && retryable !== false;
  const nextRetryInMs = autoRetrying ? Math.max(0, wait - elapsed) : 0;
  const conn = {
    phase,
    online: phase === "online",
    text: CONNECT_TEXT[phase] || "正在连接…",
    detail,
    retryable: retryable !== false,
    deviceId,
    runtimeReady: runtime,
    installing: inst.installing,
    installStale: inst.stale,
    bridgeRunning,
    accountCurrent, // 运行中的 bridge 是否属于当前账号（false = 上一个账号的进程还在跑）
    bridgePids,
    launchdState: launchd.state || "",
    launchdCrashLoop: Boolean(launchd.crashing),
    registered,
    registerSource,
    attempts: book.attempts,
    nextRetryInMs,
    error,
    bindError: bindFresh && bindError ? { code: bindError.code || "", message: bindError.message || "" } : null,
    logPath: join(relayDir, BRIDGE_LOG_FILE),
    installLogPath: join(relayDir, AUTO_INSTALL_LOG),
  };
  conn.diagnostics = buildConnectDiagnostics(relayDir, conn, log);
  return conn;
}

/** 可复制的诊断信息（面板「复制诊断信息」按钮）：版本 / relayDir / 阶段 / 最近错误 / 进程状态 / 日志路径。 */
function buildConnectDiagnostics(relayDir, conn, log) {
  return [
    "dsh-remote 连接诊断",
    `插件版本: ${PLUGIN_VERSION}`,
    `配置目录: ${relayDir}`,
    `连接阶段: ${conn.phase}（${conn.text}）`,
    `设备 ID: ${conn.deviceId || "（未生成）"}`,
    `运行环境: ${conn.runtimeReady ? "已就绪" : "缺失"}${conn.installing ? "（后台安装中）" : ""}${conn.installStale ? "（安装标记已超时）" : ""}`,
    `bridge 进程: ${conn.bridgeRunning ? "在运行" : "未运行"}（pid=${conn.bridgePids && conn.bridgePids.length ? conn.bridgePids.join(",") : "-"}，launchd state=${conn.launchdState || "-"}，崩溃循环=${conn.launchdCrashLoop ? "是" : "否"}）`,
    `中继注册: ${conn.registered ? "已注册（" + conn.registerSource + "）" : "未注册"}`,
    `bridge 账号: ${conn.accountCurrent === false ? "⚠️ 仍是上一个账号的身份（需重启 bridge 重新登记）" : "当前账号"}`,
    `最近错误: ${conn.error ? conn.error.code + ": " + conn.error.message : (log && log.lastError ? log.lastError : "无")}`,
    `自动重试: 已尝试 ${conn.attempts} 次${conn.nextRetryInMs ? `，约 ${Math.ceil(conn.nextRetryInMs / 1000)} 秒后重试` : ""}`,
    `bridge 日志: ${conn.logPath}`,
    `安装日志: ${conn.installLogPath}`,
    `时间: ${new Date().toISOString()}`,
  ].join("\n");
}

/**
 * 自动闭环的动作执行（幂等、内部退避）：
 *   ① 缺运行环境 → ensureRuntime（后台 npx 补装；卡死的安装标记先清掉）；
 *   ② 不再缺环境但没账号 → 什么都不做（先把登录引导交给 UI）；
 *   ③ 有账号但 bridge 没在跑 → startBridge（运行环境缺失时它自己会拒绝并转补装）。
 * 由面板的短轮询驱动（GET /dsh-remote/bridge-status），因此用户在登录后不需要点任何按钮、
 * 也不需要刷新页面；退避避免失败时把 launchctl/npx 打成风暴。
 */
function ensureConnection(relayDir, opts = {}) {
  if (UNINSTALLED_DIRS.has(relayDir)) return null;
  // 顺手治一次「卡住的更新」（复用面板已有的轮询，不需要新定时器 —— 诊断报告 F5）
  healStalledJobs(relayDir);
  const book = connectBook(relayDir);
  if (opts.force) { book.attempts = 0; book.lastAttemptAt = 0; }
  const now = Date.now();
  if (!opts.force && book.lastAttemptAt && now - book.lastAttemptAt < connectBackoffMs(book.attempts)) return null;
  const cfg = loadConfig(relayDir);
  if (!hasAccountCreds(cfg)) return null; // 未登录：不补装也不拉服务，先让用户登录
  if (!runtimeReady(relayDir)) {
    if (installStateOf(relayDir).stale) clearStaleInstallMarker(relayDir);
    book.lastAttemptAt = now;
    book.attempts += 1;
    ensureRuntime(relayDir);
    return { action: "provision" };
  }
  const launchd = launchdStatus();
  const manual = manualStatus(relayDir);
  if (launchd.running || (manual.allBridge || []).length || (manual.bridge || []).length) {
    // 进程在跑 ≠ 跑对了账号：切换账号后旧 bridge 会一直用旧凭据，
    // 只看"有没有进程"会让自愈永久停摆（实测事故）。这里多判一次账号归属。
    if (!bridgeMatchesCurrentAccount(relayDir, cfg)) {
      book.lastAttemptAt = now;
      book.attempts += 1;
      resetBridgeForAccountChange(relayDir, "bridge 身份与当前账号不符");
      const r = startBridge(relayDir);
      appendLogLine(relayDir, AUTO_INSTALL_LOG,
        `[dsh-remote-web] 检测到旧账号的 bridge 仍在运行，已重启以用当前账号重新登记（${r.status || "?"}）`);
      return { action: "restart", result: r };
    }
    book.attempts = 0; // 进程已在跑：退避计数归零，后续只等注册
    book.lastAttemptAt = now;
    return { action: "none" };
  }
  if (launchd.crashing) reapBrokenAutostart(relayDir);
  book.lastAttemptAt = now;
  book.attempts += 1;
  const r = startBridge(relayDir);
  if (r && r.ok === false) {
    appendLogLine(relayDir, AUTO_INSTALL_LOG,
      `[dsh-remote-web] 自动启动 bridge 未成功(${r.status || "?"}): ${r.detail || ""}`);
  }
  return { action: "start", result: r };
}

// ---------- 匿名装机/连接遥测（客户端半；契约与隐私边界见 docs/telemetry.md） ----------
//
// 背景（2026-09 生产诊断）：11 个新注册用户里只有 3 个把设备连上——6 人电脑端从未安装、2 人装了但
// bridge 没连上。而「装不上」的人没有任何账号、也就没有任何数据，「本地 OK、新机器失败」因此无法归因。
// 本通道只补这一段装机/连接事实，且必须守住开源项目的隐私边界：
//
//   · 完全匿名：不带 Authorization、不带任何账号标识；install_id 是本机随机 UUID（非硬件派生、
//     重装即变，不可跨机器关联）；
//   · 只发白名单事件（TELEMETRY_EVENT_NAMES）与白名单 fail_code（TELEMETRY_FAIL_CODES），
//     原始错误文本一律不透传（它可能含路径/主机名）；
//   · 允许的字段**只有**：install_id / 事件名 / fail_code / 插件版本 / **宿主 DSH 版本** /
//     **更新通道** / os(process.platform) / arch(process.arch) / node(仅主版本号)——唯一构造点是
//     telemetryEventOf()。宿主版本与通道都是**非识别性的版本串**（形如 0.1.5-rc.2 / beta），
//     它们回答的是"这个插件跑在哪个 DSH 上、走的哪条发布通道"，不指向任何个人或机器；
//   · 禁止采集（代码与 docs/telemetry.md 双写死）：手机号、邮箱、账号 ID、任何会话内容或文件内容、
//     真实 hostname / 用户名 / 文件路径、密码与密钥、设备指纹(machine_fp)、原始 IP、精确地理位置；
//   · 可关闭：DSH_REMOTE_TELEMETRY=0 → 完全关闭（不生成 install_id、不落任何文件、不发任何请求）；
//   · 全程静默：任何异常都被吞掉，绝不影响面板 / bridge / 连接流程与用户可见行为。
//
// 契约（服务端冻结）：POST <api_url>/api/telemetry/events，headers
//   { content-type: application/json, x-dsh-client: dsh-remote/<PLUGIN_VERSION> }（无 Authorization），
//   body { install_id, source: "plugin", events: [{ name, at, version, harness_version, channel, os, arch, node, fail_code? }] }，
//   单批 ≤ 20 条、body ≤ 32KB。
//   `version` = 插件自身版本；`harness_version` = 插件**运行所在的 DSH 宿主**版本（运行时探测，未知为 ""），
//   两者都不是一回事 —— 2026-09 生产问题的根因就是只有前者、答不出"是不是 DSH 兼容性问题"。
//   `harness_version` / `channel` 必须匹配服务端 TELEMETRY_MISC_RE = /^[A-Za-z0-9._-]{0,32}$/，
//   否则会被服务端**静默清空**：所以这里先自判，不合法就发 ""（未知），绝不发一个被改写过的值。

/**
 * 事件名白名单：只用这些，其它一律不发。
 * 2026-09 新增 wechat_bound / wechat_unbound：微信机器人通道的**绑定态跳变**（两态模型，
 * 见 docs/wechat-bot-channel.md §9）—— 这一对该不该有人用、用了之后会不会掉，此前完全看不见。
 * 与服务端 TELEMETRY_EVENTS 必须**逐字对齐**（少一个 = 服务端静默丢弃，事件看起来"没上报"）。
 */
const TELEMETRY_EVENT_NAMES = new Set([
  "install_started", "install_failed", "runtime_ready", "bridge_started", "bridge_registered",
  "tunnel_disconnected", "first_remote_ok", "plugin_loaded", "panel_opened", "harness_restart",
  "update_started", "update_failed",
  "wechat_bound", "wechat_unbound",
]);
/**
 * fail_code 白名单 —— **必须与服务端 TELEMETRY_FAIL_CODES 完全一致**。
 * 两个用途：① 构造事件时校验（白名单外会被清成空串，等于归因白做）；
 * ② 受信边界：只有枚举值能出网络，原始错误文本永不上报。
 * 2026-09-15 教训：新增归因码时忘了同步这里，1659 次 Windows 失败仍然只会显示 unknown。
 */
const TELEMETRY_FAIL_CODES = new Set([
  "node_missing", "node_too_old", "npm_unreachable", "npm_eacces", "platform_unsupported",
  "runtime_install_timeout", "launchd_failed", "bridge_exit", "bind_conflict", "bind_device_limit",
  "npx_cmd_unavailable", "registry_timeout", "install_script_missing", "npx_exit_nonzero", "npx_output_encoding", "update_stalled",
  "unknown",
]);
/** node 半只发 source=plugin。 */
const TELEMETRY_SOURCE = "plugin";
const TELEMETRY_INSTALL_ID_FILE = ".telemetry-install-id";
const TELEMETRY_QUEUE_FILE = ".telemetry-queue.json";
const TELEMETRY_ONCE_FILE = ".telemetry-once.json";
/** 本地队列上限（0600）：超出丢最旧，避免长离线机器把磁盘堆满。 */
const TELEMETRY_QUEUE_MAX = 200;
/** 单批事件上限 / body 上限（契约冻结）。 */
const TELEMETRY_BATCH_MAX = 20;
const TELEMETRY_BODY_MAX = 32 * 1024;
/** 每 60s 或队列 ≥5 条时批量发送。 */
const TELEMETRY_FLUSH_MS = 60_000;
const TELEMETRY_FLUSH_THRESHOLD = 5;
/** 失败退避（30s → 2m → 10m → 1h；落在 60s 心跳网格上），累计 6 次仍失败则丢弃该批。 */
const TELEMETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];
const TELEMETRY_MAX_ATTEMPTS = 6;

/**
 * 发送心跳间隔（毫秒）。DSH_REMOTE_TELEMETRY_MS 仅供本仓库测试/诊断把节奏压到亚秒级
 * （生产不必设置，与 DSH_RELAY_SELFHEAL_MS 同一约定）；调用时读取，import 之后再改也生效。
 */
function telemetryFlushMs() {
  const v = Number(process.env.DSH_REMOTE_TELEMETRY_MS);
  return Number.isFinite(v) && v > 0 ? Math.max(10, v) : TELEMETRY_FLUSH_MS;
}

/**
 * 遥测开关：DSH_REMOTE_TELEMETRY=0/false/off/no → 完全关闭（不生成 install_id、不落文件、不发请求）；
 * 默认开启（=1/true 显式开启）。
 * 另外：DSH_RELAY_SKIP_SERVICE=1（测试/诊断隔离，见 skipsSystemOps）时同样不发送——
 * 本仓库的测试脚本全局设了该变量，用例绝不能把匿名事件发到真实生产端点。
 */
function telemetryEnabled() {
  if (skipsSystemOps()) return false;
  const v = String(process.env.DSH_REMOTE_TELEMETRY ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * 第 attempt 次失败后到下次重试的退避时长（毫秒）：30s → 2m → 10m → 1h（封顶）。
 * 设置了 DSH_REMOTE_TELEMETRY_MS 时按同一比例缩放（仅供本仓库测试把整条重试链压到亚秒级；
 * 生产绝不设置该变量，生产值就是上面这串）。
 */
function telemetryBackoffMs(attempt) {
  const base = TELEMETRY_BACKOFF_MS[Math.min(Math.max(attempt, 0), TELEMETRY_BACKOFF_MS.length - 1)];
  const v = Number(process.env.DSH_REMOTE_TELEMETRY_MS);
  const scale = Number.isFinite(v) && v > 0 ? Math.max(10, v) / TELEMETRY_FLUSH_MS : 1;
  // 缩放下限 200ms：把整条重试链压到亚秒级时(仅测试/诊断设置该变量),
  // 若下限低到 10ms,退避窗口会比一次 await 还短,让“窗口内不重试”这类断言变成
  // 靠调度运气。200ms 既能让 6 次退避在数秒内跑完,又足以稳定观测。
  // 生产不设该变量(scale=1),base 最小 30s,不受此下限影响。
  return Math.max(200, Math.round(base * scale));
}

/** 每个 relayDir 的遥测簿：内存队列 + 心跳句柄 + 退避/去重状态（进程重启即重置）。 */
const telemetryBooks = new Map();
function telemetryBook(relayDir) {
  let b = telemetryBooks.get(relayDir);
  if (!b) {
    b = {
      queue: null,          // null=尚未从磁盘读回
      timer: null,          // 心跳定时器（unref，不阻塞进程退出）
      kickPending: false,   // 已排队一次「立即发送」
      sending: false,
      attempts: 0,          // 当前批次连续失败次数
      nextAt: 0,            // 退避解禁时间
      closed: false,        // 插件已停摆（dispose）→ 不再调度发送
      fired: new Set(),     // 本进程已发过的事件名（每进程每阶段只发一次）
      runtimeMissingSeen: false,
      installStartedAt: 0,
      tunnelDown: false,    // 同一掉线周期只发一条 tunnel_disconnected
      wasRegistered: false,
    };
    telemetryBooks.set(relayDir, b);
  }
  return b;
}

/**
 * 只在配置目录**已存在**时落盘：遥测绝不为自己的统计去创建配置目录（否则会改变
 * 「本机是否装过运行时」的既有语义——例如彻底卸载用例里 relayDir 本不该存在）。
 * 目录还没出现时事件只留在内存里等下一次心跳，装好了/登录后目录出现即恢复持久化。
 */
function telemetryDirReady(relayDir) {
  try { return Boolean(relayDir) && existsSync(relayDir); } catch { return false; }
}

/**
 * 本机 install_id：<relayDir>/.telemetry-install-id（0600），首次 crypto.randomUUID()，之后复用。
 * 它是**随机 UUID**（非硬件派生、不含机器信息、换机/重装即变），因此不可跨机器关联到同一个人。
 * 生成/落盘失败 → 返回 null（本次不发，静默，不阻断任何流程）。
 */
function telemetryInstallId(relayDir) {
  if (!telemetryEnabled()) return null;   // 关闭：连 ID 都不生成（更不落盘）
  if (!telemetryDirReady(relayDir)) return null;
  const file = join(relayDir, TELEMETRY_INSTALL_ID_FILE);
  try {
    const cur = readFileSync(file, "utf8").trim();
    if (/^[0-9A-Za-z-]{16,64}$/.test(cur)) return cur;
  } catch { /* 首次生成 */ }
  try {
    const id = randomUUID();
    try {
      writeFileSync(file, id, { mode: 0o600, flag: "wx" }); // wx：并发时不会互相覆盖
    } catch {
      const cur = readFileSync(file, "utf8").trim();        // 别的进程刚生成 → 复用它
      if (cur) return cur;
      throw new Error("install_id 写入失败");
    }
    try { chmodSync(file, 0o600); } catch { /* 权限位不生效不影响使用 */ }
    return id;
  } catch {
    return null; // 生成失败 → 本次不发
  }
}

/** 读回本地队列（懒加载；只接受白名单事件名，杜绝外来/损坏内容被转发）。 */
function telemetryLoadQueue(relayDir, book) {
  if (Array.isArray(book.queue)) return book.queue;
  book.queue = [];
  try {
    const raw = JSON.parse(readFileSync(join(relayDir, TELEMETRY_QUEUE_FILE), "utf8"));
    const list = Array.isArray(raw?.events) ? raw.events : [];
    book.queue = list.filter((ev) => ev && typeof ev === "object" && TELEMETRY_EVENT_NAMES.has(String(ev.name)));
  } catch { book.queue = []; }
  return book.queue;
}

/** 落盘本地队列（0600；写不进去也不影响主流程——退化为只在内存里排队）。 */
function telemetrySaveQueue(relayDir, book) {
  try {
    if (!telemetryDirReady(relayDir)) return;
    const file = join(relayDir, TELEMETRY_QUEUE_FILE);
    writeFileSync(file, JSON.stringify({ v: 1, events: book.queue || [] }), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* 非关键 */ }
  } catch { /* 非关键 */ }
}

/** 从队列移除已送达/已放弃的一批（按引用比较，避免并发写入被误删）。 */
function telemetryDrop(relayDir, book, batch) {
  const queue = telemetryLoadQueue(relayDir, book);
  for (const ev of batch) {
    const i = queue.indexOf(ev);
    if (i >= 0) queue.splice(i, 1);
  }
  telemetrySaveQueue(relayDir, book);
}

/** 一次性事件标记（跨进程、跨重启只发一次，如 first_remote_ok）读/写。 */
function telemetryOnceFlags(relayDir) {
  try {
    const j = JSON.parse(readFileSync(join(relayDir, TELEMETRY_ONCE_FILE), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch { return {}; }
}
function telemetryMarkOnce(relayDir, name) {
  try {
    if (!telemetryDirReady(relayDir)) return;
    writeFileSync(join(relayDir, TELEMETRY_ONCE_FILE),
      JSON.stringify({ ...telemetryOnceFlags(relayDir), [name]: Date.now() }), { mode: 0o600 });
  } catch { /* 非关键 */ }
}

/**
 * 微信通道「上次观测到的 bound」的跨进程记忆键（与 first_remote_ok 共用同一份
 * .telemetry-once.json，0600）。**刻意不新增第二个落盘机制**：这份文件就是本文件里
 * "跨进程只记一次/只记一个值"的既有约定，绑定的基线属于同一类事实。
 * 取值：1 = 上次看到已绑定，0 = 上次看到未绑定，键不存在 = **从未观测过**（null）。
 */
const TELEMETRY_WECHAT_BOUND_KEY = "wechat_bound_state";
/**
 * 读回绑定的基线（上次观测值）。键不存在 / 文件缺失 / 损坏 → null（= 从未观测）。
 * 这里**不能**把 null 当成 false：null 是"没观测过"（首次观测要播种基线、不发事件），
 * false 是"观测过且未绑定"（之后的 true 才算跳变）。两者混淆会系统性虚高绑定数。
 */
function telemetryWeChatBoundBaseline(relayDir) {
  const v = telemetryOnceFlags(relayDir)[TELEMETRY_WECHAT_BOUND_KEY];
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  return null;
}
/** 落盘本次观测到的 bound（0600，写不进去静默）。写失败 → 退化为"每次都是首次观测"：宁可少报，绝不重复计数。 */
function telemetryMarkWeChatBound(relayDir, bound) {
  try {
    if (!telemetryDirReady(relayDir)) return;
    writeFileSync(join(relayDir, TELEMETRY_ONCE_FILE),
      JSON.stringify({ ...telemetryOnceFlags(relayDir), [TELEMETRY_WECHAT_BOUND_KEY]: bound ? 1 : 0 }), { mode: 0o600 });
  } catch { /* 非关键 */ }
}

/**
 * 版本类字符串的清洗。服务端只接受 TELEMETRY_MISC_RE = /^[A-Za-z0-9._-]{0,32}$/，
 * 不匹配的字符串字段会被**静默清空**（数据看起来"没上报"而不是"上报错了"）。
 * 所以这里先判：合法且非空 → 原样发；否则发 ""（= 未知）。
 * **绝不改造原始值**——被截断/替换过的版本号比"未知"更糟：它会污染归因，且无从分辨。
 */
const TELEMETRY_TOKEN_RE = /^[A-Za-z0-9._-]{1,32}$/;
function telemetryToken(v) {
  const s = String(v ?? "");
  return TELEMETRY_TOKEN_RE.test(s) ? s : "";
}

/**
 * 宿主（DSH / DeepSeek Harness）版本 —— **运行时经验获取，不猜、不硬编码**。
 *
 * 为什么必须有（2026-09 生产问题）：注册 48 人只有 27 人成功，但这个问题当天**答不出来** ——
 * 遥测里的 `version` 是**插件自己**的版本，插件跑在哪个 DSH 上从来没上报过。这类数据**不能回填**，
 * 只能从改版后的新装机开始积累。
 *
 * 取值来源（唯一）：本进程的**主模块** process.argv[1]。dsh CLI 的入口是 `<pkg>/lib/bin.js`
 * （bin 名 `dsh` → 软链 → `<...>/@deepseek-ai/dsh/lib/bin.js`），而 DSH 自己就是用
 * `<pkg>/lib/../package.json` 读版本的（dsh/lib/bin.js 的 readVersion()），所以"入口的上一级
 * package.json"是**宿主保证的布局**，不是我们的假设。
 * 本机实测（dsh 0.1.5-rc.2，真实 `dsh web` 进程的 argv）：
 *   argv[1] = /opt/homebrew/bin/dsh（软链）
 *   → realpathSync = /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
 *   → ../package.json = { "name": "@deepseek-ai/dsh", "version": "0.1.5-rc.2" } → 采到 "0.1.5-rc.2"
 * 为什么不用另外三条路（都实测过）：
 *   · 环境变量：DSH 进程**不设置任何 DSH_* 版本变量**（实测 `ps eww`：只有 PATH/HOME/proxy 那几个，
 *     连 DSH_HOME 都没有）→ 无从取值；
 *   · 起 `dsh --version` 子进程：要拉起一个 node（慢），PATH 里没有 dsh 时还要兜底，且**可能挂住** ——
 *     违反"遥测不得阻塞/挂起"的前提，直接排除；
 *   · cordis 上下文 / 模块解析：宿主只 provide 了 `dshHomePath`，没有版本服务；profile 的
 *     node_modules 里也**没有** @deepseek-ai/dsh（实测），require.resolve 够不到宿主包。
 * 代价只是读一个本地小 JSON：不起进程、不联网、不可能挂住。任何异常 / 非 dsh 启动
 * （Electron、被嵌入、直接 node 跑别的脚本、测试进程）→ 返回 ""（未知），绝不抛、绝不阻塞遥测。
 */
const HARNESS_PACKAGE_NAME = "@deepseek-ai/dsh";

/** 由主模块路径解析宿主版本；读不到 / 不是 DSH / 版本串不合法（含空）→ ""。 */
function harnessVersionFromEntry(entry) {
  try {
    const real = realpathSync(String(entry || ""));   // 软链（/opt/homebrew/bin/dsh）先落回真实文件，否则"上一级"会指错目录
    const manifest = JSON.parse(readFileSync(join(dirname(real), "..", "package.json"), "utf8"));
    if (!manifest || manifest.name !== HARNESS_PACKAGE_NAME) return "";  // 不是 DSH 启动（如 Electron / 测试进程）
    return telemetryToken(manifest.version);
  } catch {
    return "";                                        // 非关键：读不到就是"未知"
  }
}

/** 本进程运行所在的宿主版本（未知 = ""）。每次调用现读：事件量很小，且绝不该缓存出过期结论。 */
function harnessVersion() {
  return harnessVersionFromEntry(process.argv[1]);
}

/**
 * 【唯一的 payload 构造点】把事件名 + 少量上下文编译成一条遥测事件。
 * 字段仅限契约白名单：name / fail_code / at / version / harness_version / channel / os / arch / node。
 * 这里**绝不**写入手机号、邮箱、账号 ID、会话或文件内容、hostname、用户名、文件路径、
 * 密码/密钥、machine_fp、IP、地理位置等任何可识别信息（见 docs/telemetry.md「不采集什么」）。
 * 返回 null = 事件名不在白名单 → 调用方一律不发。
 */
function telemetryEventOf(name, extra = {}) {
  if (!TELEMETRY_EVENT_NAMES.has(name)) return null;
  const ev = {
    name,
    at: Date.now(),
    version: PLUGIN_VERSION,                                    // 插件自身版本（≠ 宿主版本）
    harness_version: harnessVersion(),                          // 宿主 DSH 版本（运行时探测；未知 = ""）
    channel: telemetryToken(UPDATE_TAG),                        // 更新通道 latest/beta（与"一键更新"同源；未知 = ""）
    os: process.platform,                                       // 仅平台名（darwin/linux/win32），非主机名
    arch: process.arch,                                         // 仅架构（arm64/x64）
    node: String(process.versions?.node || "").split(".")[0],   // 仅主版本号，如 "22"
  };
  if (name === "install_failed" || name === "update_failed") {
    const code = String(extra.fail_code || "");
    ev.fail_code = TELEMETRY_FAIL_CODES.has(code) ? code : "unknown"; // 白名单外 → unknown
  }
  return ev;
}

/** 从既有日志/错误文本归类 fail_code（白名单内）；原始文本绝不外发（可能含路径/主机名）。 */
function telemetryFailCodeFromText(text) {
  const t = String(text || "");
  // 顺序有意义：从"最具体"到"最泛"。
  // 2026-09-15：Windows 装机失败此前**全部**落到 unknown（1659 次 install_failed 无法定位），
  // 所以把真实会遇到的形态拆开。仍然只上报枚举，原始文本不出机器（见下方注释与隐私测试）。
  // ① Windows 上 `npx.cmd` 根本调不起来（不是内部命令 / 找不到 cmd / EINVAL 等）
  if (/npx(\.cmd)?\s+(is not recognized|不是内部或外部命令)|不是内部或外部命令|无法将.*识别为/i.test(t)) return "npx_cmd_unavailable";
  if (/EINVAL|spawn .*\.cmd/i.test(t)) return "npx_cmd_unavailable";
  // ② 拿到的包不对：404 / 版本被 deprecate / 装完仍没有安装脚本
  if (/404|Not Found - GET|ETARGET|No matching version/i.test(t)) return "install_script_missing";
  // ③ 纯网络层问题（含 npm ERR! network / 超时 / TLS）
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ECONNREFUSED|ENETUNREACH|ECONNRESET|ERR_SOCKET_TIMEOUT|npm ERR! network|registry\.npmjs\.org.*(timeout|timed out)|超时/i.test(t)) {
    return "registry_timeout";
  }
  if (/network|registry|EAI|socket hang up/i.test(t)) return "npm_unreachable";
  // ④ 权限（含只读目录 / 沙箱拦截）
  if (/EACCES|EPERM|permission denied|权限不足|read-only file system/i.test(t)) return "npm_eacces";
  if (/platform|不支持的平台/i.test(t)) return "platform_unsupported";
  if (/too old|版本过低|engine|Unsupported engine/i.test(t)) return "node_too_old";
  if (/ENOENT|not found|No such file|Cannot find module/i.test(t)) return "node_missing";
  // ⑤ 输出是乱码（Windows GBK 代码页下 npm 输出可能整段不可读）→ 谁都没法归因，单独标出来
  if (/[\uFFFD]/.test(t)) return "npx_output_encoding";
  // ⑥ 兜底：进程确实退出了非零码，但日志里没有可识别的特征 —— 标成 npx_exit_nonzero，
  // 与"启动都没起来"（npx_cmd_unavailable / node_missing）区分开，便于下轮定位。
  return "npx_exit_nonzero";
}
/** 子进程启动失败（spawn error）→ fail_code。 */
function telemetryFailCodeFromError(e) {
  const code = String(e?.code || "");
  if (code === "ENOENT") return "node_missing";   // 连 node/npx 可执行文件都找不到 = 本机没有 node
  if (code === "EACCES") return "npm_eacces";
  return telemetryFailCodeFromText(e?.message);
}

/** 启动发送心跳（懒启动；unref 不阻塞进程退出）。 */
function telemetryTickerStart(relayDir) {
  const book = telemetryBook(relayDir);
  if (book.timer || book.closed) return;
  const t = setInterval(() => { void telemetryFlush(relayDir); }, telemetryFlushMs());
  t.unref?.();
  book.timer = t;
}

/** 排队一次「立即发送」（下一轮事件循环执行；不阻塞调用方）。 */
function telemetryFlushSoon(relayDir) {
  const book = telemetryBook(relayDir);
  if (book.kickPending || book.closed || !telemetryEnabled()) return;
  book.kickPending = true;
  const t = setTimeout(() => { book.kickPending = false; void telemetryFlush(relayDir); }, 0);
  t.unref?.();
}

/**
 * 入队一条事件：白名单 → 队列（上限 200 丢最旧）→ 落盘 → 队列 ≥5 条立即发送，否则等 60s 心跳。
 * 全程 try/catch 静默：遥测绝不能影响面板 / bridge / 连接流程或用户可见行为。
 * @returns {boolean} 是否入队
 */
function telemetryRecord(relayDir, name, extra = {}) {
  try {
    if (!telemetryEnabled()) return false;   // 关闭：不落文件、不入队、不发请求
    const ev = telemetryEventOf(name, extra);
    if (!ev) return false;                   // 白名单外一律不发
    const book = telemetryBook(relayDir);
    if (book.closed) return false;
    const queue = telemetryLoadQueue(relayDir, book);
    queue.push(ev);
    if (queue.length > TELEMETRY_QUEUE_MAX) queue.splice(0, queue.length - TELEMETRY_QUEUE_MAX); // 丢最旧
    telemetrySaveQueue(relayDir, book);
    telemetryTickerStart(relayDir);
    if (queue.length >= TELEMETRY_FLUSH_THRESHOLD) telemetryFlushSoon(relayDir);
    return true;
  } catch {
    return false;
  }
}

/** 每进程只发一次的事件（plugin_loaded / panel_opened / bridge_started / bridge_registered）。 */
function telemetryOnce(relayDir, name, extra) {
  if (!telemetryEnabled()) return false;
  const book = telemetryBook(relayDir);
  if (book.fired.has(name)) return false;
  book.fired.add(name);
  return telemetryRecord(relayDir, name, extra);
}

/** 跨进程只发一次的事件（first_remote_ok：持久化标记，先落标记再入队，宁可丢一条也不重复）。 */
function telemetryOnceEver(relayDir, name, extra) {
  if (!telemetryEnabled()) return false;
  if (telemetryOnceFlags(relayDir)[name]) return false;
  telemetryMarkOnce(relayDir, name);
  return telemetryRecord(relayDir, name, extra);
}

/** 运行环境就绪（每进程一次）。 */
function telemetryRuntimeReady(relayDir) {
  if (!telemetryEnabled()) return false;
  const book = telemetryBook(relayDir);
  if (book.fired.has("runtime_ready")) return false;
  book.fired.add("runtime_ready");
  return telemetryRecord(relayDir, "runtime_ready");
}

/**
 * 运行环境探针（在补装 watcher 与面板轮询里顺手调用，不额外起定时器）：
 *   - 现在缺运行环境 → 记下「本进程见过缺失」，并在超过 INSTALL_STALE_MS 仍缺时归因为
 *     install_failed(runtime_install_timeout)（每进程一次）；
 *   - 之前见过缺失、现在已就绪 → runtime_ready（每进程一次）。
 */
function telemetryRuntimeProbe(relayDir) {
  if (!telemetryEnabled()) return;
  try {
    const book = telemetryBook(relayDir);
    if (runtimeReady(relayDir)) {
      if (book.runtimeMissingSeen) telemetryRuntimeReady(relayDir);
      return;
    }
    book.runtimeMissingSeen = true;
    if (book.installStartedAt && Date.now() - book.installStartedAt > INSTALL_STALE_MS && !book.fired.has("install-timeout")) {
      book.fired.add("install-timeout");
      telemetryRecord(relayDir, "install_failed", { fail_code: "runtime_install_timeout" });
    }
  } catch { /* 静默 */ }
}

/**
 * 「当前隧道是否断连中」判据（仅供遥测）：bridge 日志里最后一次「隧道断开」晚于最后一次
 * 「隧道已连 / ✅ router 注册成功」即为断连中。只看行序，不读任何内容。
 */
function telemetryTunnelDown(relayDir) {
  const lines = readTail(join(relayDir, BRIDGE_LOG_FILE)).split("\n");
  let up = -1;
  let down = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/✅\s*router 注册成功|隧道已连/.test(line)) up = i;
    else if (/隧道断开/.test(line)) down = i;
  }
  return down > up && down >= 0;
}

/** 「本机设备在账号设备表可见」（first_remote_ok 的第二个条件）：状态文件 / 日志 / 账号接口三选一。 */
function telemetryAccountVisible(relayDir, conn) {
  const src = String(conn?.registerSource || "");
  if (src === "account_api" || src === "account" || src === "state_account") return true;
  const state = bridgeStateFile(relayDir);
  if (state && Number(state.account_bound_at) > 0) return true;   // bridge POST /api/devices 成功留下的证据
  return Boolean(bridgeLogState(relayDir).accountBound);
}

/**
 * 连接阶段观察（复用既有阶段引擎，不新造状态机）：阶段推进到 starting / online 时各发一次
 * （每进程每阶段只发一次，避免 2~3s 轮询把事件刷爆），掉线时发一条 tunnel_disconnected
 * （同一掉线周期去重）。由持有 conn 的路由调用。
 */
function telemetryObserveConnect(relayDir, conn) {
  if (!telemetryEnabled() || !conn) return;
  try {
    const phase = String(conn.phase || "");
    // bridge_started = bridge 进程被拉起（面板阶段 starting）
    if (phase === "starting") telemetryOnce(relayDir, "bridge_started");
    // bridge_registered = 设备已在中继注册成功（面板阶段 online）——这才是「真正可用」
    if (phase === "online" || conn.registered) telemetryOnce(relayDir, "bridge_registered");
    // tunnel_disconnected = bridge 掉线：日志里最后一次是「隧道断开」，或注册证据由真变假
    const book = telemetryBook(relayDir);
    const dropped = telemetryTunnelDown(relayDir) || (book.wasRegistered === true && !conn.registered);
    if (dropped) {
      if (!book.tunnelDown) {
        book.tunnelDown = true;
        telemetryRecord(relayDir, "tunnel_disconnected");
      }
    } else {
      book.tunnelDown = false; // 已恢复/未掉线 → 复位，下一轮掉线可再记一条
    }
    if (conn.registered) book.wasRegistered = true;
    // first_remote_ok = 本机首次观察到 online 且本机设备在账号设备表可见（跨进程只发一次）
    if (phase === "online" && conn.registered && telemetryAccountVisible(relayDir, conn)) {
      telemetryOnceEver(relayDir, "first_remote_ok");
    }
  } catch { /* 静默 */ }
}

/**
 * 批量发送一批（≤20 条、≤32KB；调用方一律不 await）。成功出队；失败按 30s→2m→10m→1h 退避，
 * 累计 6 次仍失败丢弃该批——不永久堆积、不阻塞任何主流程。
 * 匿名：只有 content-type 与 x-dsh-client，**不带 Authorization**（服务端也不接受账号关联）。
 */
async function telemetryFlush(relayDir) {
  const book = telemetryBook(relayDir);
  try {
    if (!telemetryEnabled() || book.closed) return;
    if (book.sending) return;
    if (Date.now() < book.nextAt) return;        // 退避中：等下一轮心跳到点再看
    const queue = telemetryLoadQueue(relayDir, book);
    if (!queue.length) return;
    const installId = telemetryInstallId(relayDir);
    if (!installId) return;                      // install_id 生成失败 → 本次不发
    const build = (list) => JSON.stringify({ install_id: installId, source: TELEMETRY_SOURCE, events: list });
    let batch = queue.slice(0, TELEMETRY_BATCH_MAX);
    let body = build(batch);
    while (batch.length > 1 && Buffer.byteLength(body, "utf8") > TELEMETRY_BODY_MAX) {
      batch = batch.slice(0, batch.length - 1);  // body 超 32KB：收缩批次（正常远小于该上限）
      body = build(batch);
    }
    if (Buffer.byteLength(body, "utf8") > TELEMETRY_BODY_MAX) {
      telemetryDrop(relayDir, book, batch);      // 单条就超限 → 丢弃该批（防御性）
      return;
    }
    const cfg = loadConfig(relayDir);
    const api = String(cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
    book.sending = true;
    let ok = false;
    try {
      const r = await fetch(`${api}/api/telemetry/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dsh-client": `dsh-remote/${PLUGIN_VERSION}`,   // 契约冻结：dsh-remote/<version>（非 dsh-remote-web）
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      ok = Boolean(r && r.ok);
    } catch { ok = false; }                       // 网络失败 → 静默退避（老服务端 404 同理）
    book.sending = false;
    if (ok) {
      telemetryDrop(relayDir, book, batch);
      book.attempts = 0;
      book.nextAt = 0;
      return;
    }
    book.attempts += 1;
    if (book.attempts >= TELEMETRY_MAX_ATTEMPTS) {
      telemetryDrop(relayDir, book, batch);       // 上限 6 次仍失败 → 丢弃该批
      book.attempts = 0;
      book.nextAt = 0;
      return;
    }
    book.nextAt = Date.now() + telemetryBackoffMs(book.attempts - 1);
  } catch {
    book.sending = false;                         // 任何异常：静默
  }
}

/**
 * 插件装载时的遥测初始化：读回磁盘队列（上次进程遗留的事件不丢，例如重启前那条 harness_restart）
 * 并启动发送心跳。DSH_REMOTE_TELEMETRY=0 时连读都不读 → 零文件零请求。
 */
function telemetryStart(relayDir) {
  try {
    if (!telemetryEnabled()) return;
    const book = telemetryBook(relayDir);
    book.closed = false;
    const queue = telemetryLoadQueue(relayDir, book);
    telemetryTickerStart(relayDir);
    if (queue.length) telemetryFlushSoon(relayDir);
  } catch { /* 静默 */ }
}

/** 插件停摆（dispose）→ 停掉心跳，之后不再调度发送（磁盘队列留给下次装载）。 */
function telemetryStop(relayDir) {
  try {
    const b = telemetryBooks.get(relayDir);
    if (!b) return;
    b.closed = true;
    if (b.timer) { clearInterval(b.timer); b.timer = null; }
  } catch { /* 静默 */ }
}

/**
 * 微信机器人通道的**绑定态跳变** → 匿名遥测（两态模型：未绑定 / 已绑定，见 docs/wechat-bot-channel.md §9）。
 *
 * 触发点：每一次把面板请求代理到 bridge 控制面之后顺手调用一次（本文件唯一的调用点）——
 *   **不新增定时器、不新增轮询**，只复用面板本来就会发生的读取节奏。
 *
 * 只报**跳变**：
 *   unbound → bound    = wechat_bound
 *   bound   → unbound  = wechat_unbound
 * 稳态（连续多次读到同一个 bound）**一条都不发**：面板在扫码/绑定期间会反复轮询 status，
 * 若按"每次读到 bound:true 就记一条"，同一台机器的一次绑定会被刷成几十条，指标直接失去意义。
 *
 * ★ 首次观测**不是**跳变：进程启动后第一次读到这个文件时，若它已经是 bound:true，说明这次绑定
 *   可能发生在几天前（宿主/面板过一段时间才会被打开）—— 此时只**播种基线**、不发事件。
 *   把"启动时就已经绑好"当成新绑定，会把历史存量每天都虚报一遍（这是最容易做错、也最难发现的一种虚高）。
 *   基线与"是否观测过"记在既有的跨进程文件 .telemetry-once.json（0600，与 first_remote_ok 同一份）：
 *   复用已有持久化约定，既不另造机制，也绝不去写 bridge 拥有的 .wechat-state.json。
 *
 * 隐私边界：只取 `bound` 一个布尔量，事件本体仍是 telemetryEventOf() 那 9 个字段（版本/os/arch/node…）。
 *   **绝不**上报 bot_id、bot_token、被绑定的微信用户标识、手机号或 .wechat-state.json 里的任何其它字段
 *   ——这些字段在本函数里连读都不读。
 * 静默边界：文件缺失 / 内容损坏 / 权限不足 / 半写（JSON 截断）= **本次没有观测**，
 *   既不抛异常进面板路由，也**不当作 unbound**（把它当 unbound 会在下次读到 false→true 之外的假跳变）。
 * 开关：DSH_REMOTE_TELEMETRY=0 → 直接返回，连文件都不读、连基线都不落（与其余遥测同一语义）。
 *
 * @returns {boolean|null} 本次观测到的 bound；未观测（开关关闭 / 读不出）为 null
 */
function telemetryObserveWeChat(relayDir) {
  try {
    if (!telemetryEnabled()) return null;          // 关闭：零读取、零落盘、零请求
    let state = null;
    try {
      state = JSON.parse(readFileSync(join(relayDir, WECHAT_STATE_FILE), "utf8"));
    } catch {
      return null;                                  // 缺失 / 损坏 / 半写：本次没有观测（不是 unbound）
    }
    if (!state || typeof state !== "object" || typeof state.bound !== "boolean") return null;
    const bound = state.bound;
    const baseline = telemetryWeChatBoundBaseline(relayDir);
    if (baseline === bound) return bound;           // 稳态：不重复计数
    telemetryMarkWeChatBound(relayDir, bound);      // 先落基线再入队：宁可丢一条，也绝不重复计数
    if (baseline === null) return bound;            // 首次观测：只播种基线（见上方 ★）
    telemetryRecord(relayDir, bound ? "wechat_bound" : "wechat_unbound");
    return bound;
  } catch {
    return null;                                    // 遥测异常绝不冒泡到面板 / bridge 流程
  }
}

/** 内部接口（仅供本仓库测试与隐私审计；不属于插件对外契约，也不被面板/浏览器半使用）。 */
export const __telemetryInternals = {
  enabled: telemetryEnabled,
  record: (relayDir, name, extra) => telemetryRecord(relayDir, name, extra),
  flush: (relayDir) => telemetryFlush(relayDir),
  installId: (relayDir) => telemetryInstallId(relayDir),
  queueOf: (relayDir) => telemetryLoadQueue(relayDir, telemetryBook(relayDir)).slice(),
  eventOf: (name, extra) => telemetryEventOf(name, extra),
  // 归因函数也暴露出来：Windows 装机失败此前全落到 unknown，需要能被用例逐条锁住
  failCodeFromText: (text) => telemetryFailCodeFromText(text),
  failCodeFromError: (e) => telemetryFailCodeFromError(e),
  // 宿主版本探测与字符串清洗也暴露出来：这两条是"能不能答出兼容性问题"的关键，
  // 必须能被用例逐条锁住（含未知/非法值的降级行为）。
  harnessVersion: () => harnessVersion(),
  harnessVersionFromEntry: (entry) => harnessVersionFromEntry(entry),
  harnessToken: (v) => telemetryToken(v),
  updateTag: UPDATE_TAG,
  eventNames: [...TELEMETRY_EVENT_NAMES],
  failCodes: [...TELEMETRY_FAIL_CODES],
  // 微信通道绑定态观测（跳变判定 + 基线落盘）也暴露出来：这是"首次观测 != 跳变"这条
  // 最容易被写错、且写错就会让绑定数系统性虚高的规则，必须能被用例直接逐条锁住。
  observeWeChat: (relayDir) => telemetryObserveWeChat(relayDir),
  wechatBoundBaseline: (relayDir) => telemetryWeChatBoundBaseline(relayDir),
  queueMax: TELEMETRY_QUEUE_MAX,
  batchMax: TELEMETRY_BATCH_MAX,
  bodyMax: TELEMETRY_BODY_MAX,
  stateOf: (relayDir) => {
    const b = telemetryBook(relayDir);
    return { attempts: b.attempts, nextAt: b.nextAt, sending: b.sending, queueLen: telemetryLoadQueue(relayDir, b).length };
  },
  reset: (relayDir) => {
    const b = telemetryBooks.get(relayDir);
    if (b && b.timer) clearInterval(b.timer);
    telemetryBooks.delete(relayDir);
  },
};

/**
 * 安装信息上报（插件侧通道）：登录后把本机安装信息发给企业端，供「已登录用户升级插件后刷新版本号」
 * 之类的口径统计。无账号凭据不上报；失败静默（绝不阻塞面板、不弹错误）。
 * 契约：POST <api_url>/api/install-report，头 `authorization: Bearer <device-login JWT>`，
 * body { device_id?, install_source, install_version, host_os, host_arch }，成功 200 {ok:true}；
 * 404/400 一律忽略（老服务端没有该接口时不能报错）。
 */
const INSTALL_REPORT_FILE = ".dsh-install-report.json";
const INSTALL_REPORT_TTL_MS = 24 * 3600 * 1000;
const INSTALL_SOURCES = new Set(["npx", "plugin_market"]);
/** 本机安装来源判据：环境变量 > 插件自愈记录 > 有运行环境即安装器部署 > 默认插件路径。 */
function installSourceOf(relayDir) {
  const env = String(process.env.DSH_BRIDGE_INSTALL_SOURCE || "").trim();
  if (INSTALL_SOURCES.has(env)) return env;
  if (existsSync(join(relayDir, PROVISIONED_MARKER))) return "plugin_market";
  if (runtimeReady(relayDir)) return "npx";
  return "plugin_market";
}
async function reportInstallOnce(relayDir, cfgOverride, opts = {}) {
  const cfg = cfgOverride || loadConfig(relayDir);
  if (!hasAccountCreds(cfg)) return { ok: false, skipped: "no_credentials" };
  const source = installSourceOf(relayDir);
  const version = PLUGIN_VERSION;
  const marker = join(relayDir, INSTALL_REPORT_FILE);
  if (!opts.force) {
    try {
      const prev = JSON.parse(readFileSync(marker, "utf8"));
      if (prev && prev.version === version && prev.source === source && Date.now() - Number(prev.at || 0) < INSTALL_REPORT_TTL_MS) {
        return { ok: true, skipped: "already_reported" };
      }
    } catch { /* 首次上报 */ }
  }
  const token = await relayToken(relayDir).catch(() => "");
  if (!token) return { ok: false, skipped: "no_token" };
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  const body = {
    ...(cfg.device_id ? { device_id: String(cfg.device_id) } : {}),
    install_source: source,
    install_version: version,
    host_os: process.platform,
    host_arch: process.arch,
  };
  try {
    const r = await fetch(`${api}/api/install-report`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-dsh-client": `dsh-remote-web/${version}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    // 老服务端没有该接口（404）或字段不认（400）→ 忽略，绝不影响 UI
    if (r.status === 400 || r.status === 404) return { ok: false, skipped: `http_${r.status}` };
    if (!r.ok) return { ok: false, status: r.status };
    try { writeFileSync(marker, JSON.stringify({ at: Date.now(), version, source })); } catch { /* 非关键 */ }
    return { ok: true, status: r.status, install_source: source, install_version: version };
  } catch (e) {
    return { ok: false, skipped: `unreachable: ${e.message}` };
  }
}
/** 上报节流入口（fire-and-forget）：失败最多 60s 再试一次；成功则按 version/source 去重。 */
function maybeReportInstall(relayDir, opts = {}) {
  const book = connectBook(relayDir);
  const now = Date.now();
  if (!opts.force && book.reportAt && now - book.reportAt < 60_000) return;
  book.reportAt = now;
  // 认证走 relayTokenWithReason（60s token 缓存 + 并发合并），因此启动/登录/轮询多次调用
  // 也只会打一次 device-login，不会放大企业端认证请求。
  reportInstallOnce(relayDir, null, opts).catch(() => { /* 静默失败：不影响 UI */ });
}

// ---------- 微信机器人通道（bridge 控制面代理） ----------
//
// 微信通道**不在本进程里**：它跑在 bridge（clients/dsh-remote/wechat-runtime.mjs）中，那里只
// bind 127.0.0.1 的控制面。发现方式与鉴权（docs/wechat-bot-channel.md §3/§8/§10）：
//   · 端口：<relayDir>/.wechat-control.json = {port,pid,started_at,header} —— **不含任何密钥**；
//   · 密钥：<relayDir>/.dsh-config.json 的 bridge_secret（与 bridge 同源），放进
//     `x-dsh-bridge-secret` 头，**只在宿主进程内使用，绝不下发浏览器**。
//
// 本半边只做代理：面板 → /dsh-remote/wechat/* → 控制面 /wechat/*。转发回来的一切按键名再脱敏一次
// （任何名字含 token 的字段一律丢弃）——bridge 侧已有 sanitizeAccount，这里是第二道闸门，
// 即使上游某天回归了漏脱敏、或新增了字段，浏览器也拿不到 bot_token（§8「面板 API 永不回显 token」）。
const WECHAT_CONTROL_FILE = ".wechat-control.json";
const WECHAT_CONTROL_HEADER = "x-dsh-bridge-secret";
/**
 * 微信通道的**面板状态文件** `{ bound, bot_id, bound_at, connected_at, last_push_ok_at, last_error }`
 * （bridge 侧写、0600；绑定模型只有「已绑定 / 未绑定」两态，见 docs/wechat-bot-channel.md §9）。
 * 宿主半边**只读不写** —— 它是 bridge 的财产；本半边只借 `bound` 这一个布尔量做匿名遥测的跳变判定
 * （其余字段一个都不读、更不可能外发，见下方 telemetryObserveWeChat 的隐私边界）。
 */
const WECHAT_STATE_FILE = ".wechat-state.json";

/** 控制面单次调用超时（本地回环，正常在毫秒级；超时 = bridge 卡住或端口被别的东西占了）。 */
function wechatControlTimeoutMs() {
  const n = Number(process.env.DSH_WECHAT_CONTROL_TIMEOUT_MS || 0);
  return Number.isFinite(n) && n > 0 ? n : 6000;
}
/**
 * `GET /wechat/bind/poll` 是**长轮询**（bridge 侧一次可以挂到 35s 才回，见 wechat-channel.mjs 的
 * QR_LONG_POLL_TIMEOUT_MS）。对这一个路由沿用「短超时」会制造**假超时**——bridge 明明在正常等待
 * 扫码，面板却报「后台服务卡住了」，用户会去重启一个完全正常的后台服务。故只给它放宽，
 * 其余路由一律短超时（那种超时是真的卡住了）。
 */
const WECHAT_POLL_TIMEOUT_MS = 40_000;

/** pid 是否还活着（EPERM = 存在但属于别人 → 视为活着）。 */
function wechatProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

/**
 * 读控制面发现文件。**不抛**：任何异常都翻成 {error:{code,error}} —— 因为每种失败对应的用户动作
 * 都不同（启动后台服务 / 重启 / 一键更新），绝不能塌成一句「失败」。
 * @returns {{port:number,pid:number}|{error:{code:string,error:string}}}
 */
function readWeChatControl(relayDir) {
  let raw;
  try {
    raw = readFileSync(join(relayDir, WECHAT_CONTROL_FILE), "utf8");
  } catch {
    return {
      error: {
        code: "no_control_file",
        error: "本机后台服务还没有运行微信机器人通道（找不到发现文件），通常是两个原因之一：后台服务没启动，或它的版本比面板旧、不支持微信机器人。请先到「📱 远程访问」面板启动后台服务；若已在运行，点那里的「一键更新」升级后再回到本页。",
      },
    };
  }
  let info = null;
  try { info = JSON.parse(raw); } catch { info = null; }
  const port = info && Number.isInteger(info.port) ? info.port : 0;
  if (!info || typeof info !== "object" || port <= 0 || port > 65535) {
    return {
      error: {
        code: "bad_control_file",
        error: `微信机器人通道的发现文件（${WECHAT_CONTROL_FILE}）内容无法识别，可能是写入中断或文件损坏。到「📱 远程访问」面板重启一次后台服务即可重建它，然后回到本页重试。`,
      },
    };
  }
  // 发现文件是**上一次**进程写下的：bridge 退出后它会残留。这时如实说「残留」，
  // 而不是让用户对着「连接被拒绝」去猜——两种情况的处置动作不一样。
  const pid = Number.isInteger(info.pid) && info.pid > 0 ? info.pid : 0;
  if (pid && !wechatProcessAlive(pid)) {
    return {
      error: {
        code: "stale_control_file",
        error: `微信机器人通道的发现文件是上一次后台服务留下的（进程 ${pid} 已不在），现在没有进程在监听。到「📱 远程访问」面板启动/重启后台服务后回到本页重试。`,
      },
    };
  }
  return { port, pid };
}

/**
 * 递归丢弃任何**名字里含 token** 的字段（§8：面板 API 永不回显 bot_token）。
 * 只按键名过滤，其它字段照原样透传 —— 面板需要的字段一个不少。
 */
function scrubWeChatTokens(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubWeChatTokens(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    if (/token/i.test(key)) continue;
    out[key] = scrubWeChatTokens(value[key], depth + 1);
  }
  return out;
}

/**
 * 把一次面板请求代理到 bridge 控制面。
 *
 * @param {string} relayDir 配置目录
 * @param {string} routePath 控制面路径（如 "/wechat/status"）
 * @param {{method?:string, body?:any, timeoutMs?:number}} [init]
 * @returns {Promise<{ok:true, body:any}|{ok:false, status:number, code:string, error:string}>}
 *   失败一律带**各不相同**的人话文案（code 供面板/测试分流）；绝不把密钥或上游原始错误回给浏览器。
 */
async function wechatControlCall(relayDir, routePath, init) {
  const ctl = readWeChatControl(relayDir);
  if (ctl.error) return { ok: false, status: 503, code: ctl.error.code, error: ctl.error.error };

  const secret = readBridgeSecret(relayDir);
  if (!secret) {
    // 没有密钥就不能调用控制面（bridge 侧同样会 403）。如实说是「本机还没拿到设备密钥」，
    // 而不是伪装成连接故障——此时用户要做的动作是去登录 / 一键更新，不是重启。
    return {
      ok: false,
      status: 503,
      code: "no_secret",
      error: "本机配置里还没有设备密钥（bridge_secret），无法安全地调用后台服务的微信通道。请先到「📱 远程访问」面板登录一次（密钥会自动补齐），或点那里的「一键更新」重装运行环境，然后回到本页重试。",
    };
  }

  const opts = init || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : wechatControlTimeoutMs();
  const hasBody = opts.body !== undefined && opts.body !== null;
  const headers = { accept: "application/json", [WECHAT_CONTROL_HEADER]: secret };
  if (hasBody) headers["content-type"] = "application/json";

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${ctl.port}${routePath}`, {
      method: opts.method || "GET",
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = String((e && e.name) || "");
    const cause = String((e && e.cause && e.cause.code) || (e && e.code) || "");
    if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(name)) {
      return {
        ok: false,
        status: 504,
        code: "timeout",
        error: `等待后台服务的微信通道响应超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。它可能正忙、卡住了，或端口被别的东西占住了。稍后重试；一直这样请到「📱 远程访问」面板重启后台服务。`,
      };
    }
    if (cause === "ECONNREFUSED") {
      return {
        ok: false,
        status: 502,
        code: "refused",
        error: "后台服务的微信通道没有在监听（连接被拒绝）——多半是它刚刚重启完，或者已经退出了。等几秒再试；仍未恢复请到「📱 远程访问」面板重启后台服务。",
      };
    }
    return {
      ok: false,
      status: 502,
      code: "unreachable",
      error: `连接后台服务的微信通道失败${cause ? `（${cause}）` : ""}。请确认「📱 远程访问」面板里的后台服务正在运行，然后重试。`,
    };
  }

  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const upstreamError = body && typeof body === "object" && typeof body.error === "string" ? body.error : "";

  // 鉴权/版本这类「上游说不出缘由」的失败，由本半边给出可据以行动的文案；
  // 上游自己的业务错误（配对码不合法、二维码取不到…）则原样透传——那是写给用户看的原文。
  if (res.status === 401) {
    return {
      ok: false,
      status: 502,
      code: "unauthorized",
      error: "后台服务拒绝了这次调用（设备密钥不匹配）。密钥可能刚被轮换，或后台服务是用旧密钥启动的。到「📱 远程访问」面板点一次「一键更新」补齐并重启后台服务，然后回到本页重试。",
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      status: 502,
      code: "forbidden",
      error: "后台服务没有配置设备密钥，因此关闭了微信通道的控制面（这是安全默认：没有密钥就拒绝一切，而不是放行）。到「📱 远程访问」面板点「一键更新」补齐运行环境与密钥后重试。",
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: 502,
      code: "no_such_route",
      error: "后台服务不认识这个微信通道接口，说明它比当前面板旧。到「📱 远程访问」面板点「一键更新」升级后台服务，然后回到本页重试。",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: 502,
      code: `upstream_${res.status}`,
      error: upstreamError || `后台服务的微信通道返回了 HTTP ${res.status}，没有给出原因。稍后重试；一直这样点「📱 远程访问」里的「一键更新」升级后台服务。`,
    };
  }
  if (body === null || typeof body !== "object") {
    return {
      ok: false,
      status: 502,
      code: "bad_response",
      error: "后台服务的微信通道返回了无法解析的内容（不是 JSON），多半是版本不匹配。到「📱 远程访问」面板点「一键更新」升级后台服务后重试。",
    };
  }
  return { ok: true, body: scrubWeChatTokens(body) };
}

/** 代理一次微信通道调用并回写响应（成功体原样透传；失败体统一 {ok:false, code, error}）。 */
async function sendWeChatProxy(relayDir, res, routePath, init) {
  const r = await wechatControlCall(relayDir, routePath, init);
  // 匿名遥测：顺手观测一次绑定态（只认跳变，稳态不重复计数；DSH_REMOTE_TELEMETRY=0 时是零副作用 no-op）。
  // 放在这里而不是只放 status 路由：bind/verify 与 unbind 也会让 bridge 改写状态文件，
  // 那时面板可能还没轮到下一次轮询 —— 把观测点挂在唯一的代理出口上，六条路由一个不漏。
  telemetryObserveWeChat(relayDir);
  if (r.ok) return sendJson(res, 200, r.body);
  return sendJson(res, r.status, { ok: false, code: r.code, error: r.error });
}

function registerRoutes(ctx, relayDir) {
  // 本插件所在 profile(由插件自身文件位置推导,覆盖市场 git 安装与本地 include 两种形态)
  let profileDir = join(homedir(), ".dsh", "profiles", "web");
  try {
    const here = fileURLToPath(import.meta.url);
    // 依次尝试两种安装布局（当前名优先，历史名兜底）；split()[0] 未命中时返回原串，需显式判断后再试下一种
    let m = here.split("/dsh-remote-web-plugin/")[0];
    if (m === here) m = here.split("/node_modules/dsh-remote-web/")[0];
    if (m === here) m = here.split("/dsh-remote-ui-plugin/")[0];
    if (m === here) m = here.split("/node_modules/dsh-remote-ui/")[0];
    if (m !== here) profileDir = m;
  } catch { /* 保持默认 */ }
  const routes = [
    // 自管理：版本信息 / 检查更新 / 一键更新 / 更新日志 / 彻底卸载
    {
      method: "GET",
      path: "/dsh-remote/self",
      handler: async (_req, res) => {
        const runtimeReady = existsSync(join(relayDir, "dsh-setup.mjs"));
        // channel：当前更新通道（面板要显示出来 —— 否则预发版用户会点出一个方向相反的操作）
        sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, channel: UPDATE_TAG, runtimeReady, relayDir });
      },
    },
    {
      // 取消「正在进行的更新」：结束挂死的更新子进程 + 清标记。
      // 面板在「疑似卡住」时提供这个按钮 —— 此前用户面对的是没有时间、没有日志、没有按钮的 spinner。
      // 注意：取消**不写 update_failed 遥测**（用户主动取消不是失败），只在本地留一条可查询记录。
      method: "POST",
      path: "/dsh-remote/self/update/cancel",
      handler: async (_req, res) => {
        updateCancelledDirs.add(relayDir); // 先落闸：kill 会触发 exit，那里的重试逻辑必须看到"已取消"
        const marker = join(relayDir, UPDATE_MARKER);
        const info = readMarkerInfo(marker);
        const pid = Number(info && info.pid);
        let killed = false;
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid) === true) killed = killPid(pid, "SIGKILL");
        stopProgressWatch(UPDATE_WATCH_KEY);
        let cleared = false;
        try { rmSync(marker, { force: true }); cleared = !existsSync(marker); } catch { /* ignore */ }
        appendLogLine(relayDir, UPDATE_LOG, `[update] 用户取消：结束进程(${killed ? "已结束" : "无活动进程"})，清标记(${cleared ? "成功" : "失败"})`);
        if (cleared) noteUpdateFailure(relayDir, "更新已被取消，可以重新点「一键更新」再试一次", "user_cancelled");
        sendJson(res, 200, { ok: true, killed, cleared, detail: cleared ? "已取消" : "取消失败：标记未能清除" });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/self/update-check",
      handler: async (_req, res) => {
        const latest = await npmLatestVersion();
        const current = PLUGIN_VERSION;
        // 正规比较：注册表版本**严格大于**本地版本才算有更新。
        // 这样 0.6.4 < 0.6.4（正式版发布后预设版会正确提示升级），
        // 而 0.6.4-beta.10 < 0.6.4 也能正确判断；解析不了时退回朴素不等（保守提示）。
        const cmp = compareVersions(latest, current);
        const outdated = cmp === null ? Boolean(latest && latest !== current) : cmp > 0;
        sendJson(res, 200, { ok: true, current, latest, outdated });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/self/update",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, ...(await runOnlineUpdate(relayDir)) });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/self/update-log",
      handler: async (_req, res) => {
        const failure = recentUpdateFailure(relayDir);
        const markerInfo = readMarkerInfo(join(relayDir, UPDATE_MARKER));
        const running = existsSync(join(relayDir, UPDATE_MARKER));
        const live = progressInfoOf(UPDATE_WATCH_KEY);
        const idleMs = running ? progressIdleMs(relayDir, UPDATE_LOG, markerInfo && markerInfo.at) : 0;
        const idleThresholdMs = stallIdleMs("update");
        sendJson(res, 200, {
          ok: true,
          running,
          channel: UPDATE_TAG,
          log: tailOf(join(relayDir, UPDATE_LOG)),
          // 供前端在"没成功"时如实报错（此前失败只写日志，界面显示"已完成"）
          failure: failure ? { detail: failure.detail, failCode: failure.failCode, at: failure.at } : null,
          version: PLUGIN_VERSION,
          // 【0.6.9】让「卡住」在界面上可见：已用时 / 距上次日志变化多久 / 是否超过阈值。
          // 用日志 mtime 判定 —— 宿主重启后依然有效（实测：重启也清不掉的永久「更新中」）。
          startedAt: (markerInfo && markerInfo.at) || (live && live.startedAt) || 0,
          elapsedMs: running && markerInfo ? Date.now() - markerInfo.at : (live ? live.elapsedMs : 0),
          idleMs,
          idleThresholdMs,
          stalled: Boolean(running && idleMs > idleThresholdMs) || Boolean(live && live.stalled)
        });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/self/uninstall",
      handler: async (_req, res) => {
        // 彻底卸载 = ① 插件 profile 清理（快、纯 fs、可预期）② 运行时/bridge 清理（慢、要调外部命令）
        //
        // ⚠️ 顺序是刻意的，别改回去（2026-09-18 用户实测的僵死事故）：
        //   旧实现把**慢的** uninstallRuntime 排在最前、uninstallSelf 排在其后，于是
        //   uninstallRuntime 里任何一次 spawnSync 卡住（Windows 沙箱拦 schtasks，而 spawnSync 的
        //   timeout 在 Windows 上并不可靠，实测 18s+ 未返回），uninstallSelf 就**永远不执行**
        //   → 用户看到「点了卸载、插件纹丝不动」，而且整个 dsh web 僵死（端口在听、无响应）。
        //   现在：先做真正"卸载掉插件"的部分 → 立刻关掉自愈 → 立刻回响应 → 慢步骤交独立子进程。
        let prof = { removedPatch: false, removedDep: false, removedBundle: false, removedDir: false };
        try {
          prof = uninstallSelf(relayDir, profileDir, join(profileDir, "cordis.patch.yml"), join(profileDir, "package.json"));
        } catch (e) {
          console.warn(`[dsh-remote-web] 卸载插件引用失败: ${e.message}`);
        }
        // 必须在慢步骤之前置位：否则慢步骤期间自愈有机会把 bridge / 配置目录再拉回来
        markUninstalled(relayDir);
        // 运行时清理交给独立进程：宿主事件循环绝不做同步子进程调用
        const cleanup = spawnRuntimeCleanupDetached(relayDir, profileDir);
        const cleanupMode = cleanup.ok ? "deferred" : "in-process";
        const bits = [];
        if (prof.removedPatch || prof.removedDep || prof.removedBundle || prof.removedDir) bits.push("插件引用与本地文件已移除");
        bits.push(cleanup.ok
          ? "bridge 自启动项与本地配置目录（账号/密钥/固化运行时等）正在后台清理"
          : `bridge 自启动项与配置目录的后台清理未能启动（${cleanup.detail}），已改在本进程内清理`);
        bits.push("请重启 dsh web 后完全卸载生效（本插件与「远程访问」面板将消失）；如需再次使用，在插件市场重新安装即可。");
        sendJson(res, 200, {
          ok: true,
          ...prof, // removedPatch / removedDep / removedBundle / removedDir(profile 插件目录)
          runtimeCleanup: cleanupMode,
          cleanupLog: cleanup.log,
          relayDir,
          detail: bits.join("；"),
        });
        // 兜底：助手起不来（relayDir 不可写 / node 起不来）时才在进程内清理。
        // **必须放在响应之后**：这条路径会阻塞事件循环，绝不能让用户先等它。
        if (!cleanup.ok) {
          setTimeout(() => {
            try { uninstallRuntime(relayDir, profileDir); }
            catch { /* 非致命：残留可由用户手动清理 */ }
          }, 50).unref?.();
        }
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/status",
      handler: async (_req, res) => {
        // 按需补齐浏览器会话 Cookie(不 await:状态接口不能被本地换 Cookie 拖慢)。
        // 面板轮询会持续触达本接口 → 手机端的 401 会在秒级内自愈。
        void ensureHarnessCookie(ctx, relayDir).catch(() => {});
        sendJson(res, 200, await composeStatus(relayDir));
      },
    },
    // 连接阶段短轮询端点（面板 2~3s 一次，非 online 时自动推进；online 后退避到 15s）。
    // 返回前先执行自动闭环动作（缺环境→补装 / 有账号没进程→拉起 / 卡死标记→清理），
    // 于是「登录后自动连上」不需要任何按钮或刷新；每步都自带退避，失败不会打成风暴。
    {
      method: "GET",
      path: "/dsh-remote/bridge-status",
      handler: async (_req, res) => {
        ensureConnection(relayDir);
        maybeReportInstall(relayDir);
        void ensureHarnessCookie(ctx, relayDir).catch(() => {}); // 同上:手机端授权会话自愈
        telemetryRuntimeProbe(relayDir); // 匿名遥测：运行环境刚补齐 → runtime_ready（不额外起定时器）
        const connect = await composeConnect(relayDir);
        telemetryObserveConnect(relayDir, connect); // 匿名遥测：bridge_started / bridge_registered / 掉线
        sendJson(res, 200, { ok: true, connect });
      },
    },
    // 面板打开（浏览器半在「远程访问」栏目首次渲染时调一次）：每进程只记一次。
    // 只发事件名，不含任何账号/内容/设备信息；DSH_REMOTE_TELEMETRY=0 时静默丢弃。
    {
      method: "POST",
      path: "/dsh-remote/telemetry/panel-opened",
      handler: async (_req, res) => {
        telemetryOnce(relayDir, "panel_opened");
        sendJson(res, 200, { ok: true });
      },
    },
    // 手动重试（error 阶段的「重试」按钮）：清掉退避计数立刻再走一遍闭环。
    {
      method: "POST",
      path: "/dsh-remote/connect/retry",
      handler: async (_req, res) => {
        const action = ensureConnection(relayDir, { force: true });
        maybeReportInstall(relayDir, { force: true });
        await sleep(600); // 给 launchctl 一点进入运行态的时间，重试点下去立刻能看到「正在启动 Bridge…」
        const connect = await composeConnect(relayDir);
        telemetryObserveConnect(relayDir, connect); // 匿名遥测：同 bridge-status（去重后不会重复计数）
        sendJson(res, 200, { ok: true, retried: true, action: action && action.action ? action.action : "none", connect });
      },
    },
    // ── 🤖 微信机器人通道（设置页「🤖 微信机器人」栏目） ──────────────────────
    // 这六条只做代理：真正的协议与扫码状态机在 bridge 里（docs/wechat-bot-channel.md §3/§10）。
    // 失败一律是 5xx + {ok:false, code, error:<人话>}：面板按 code/文案分流，绝不塌成「失败」两个字。
    // 路由与契约一一对应，不多也不少（多出来的字段都可能变成 bot_token 的泄漏面）。
    {
      method: "GET",
      path: "/dsh-remote/wechat/status",
      handler: async (_req, res) => {
        await sendWeChatProxy(relayDir, res, "/wechat/status");
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/wechat/bind/start",
      handler: async (_req, res) => {
        await sendWeChatProxy(relayDir, res, "/wechat/bind/start", { method: "POST" });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/wechat/bind/poll",
      handler: async (_req, res) => {
        // 长轮询：只有这一条放宽超时（理由见 WECHAT_POLL_TIMEOUT_MS）
        await sendWeChatProxy(relayDir, res, "/wechat/bind/poll", { timeoutMs: WECHAT_POLL_TIMEOUT_MS });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/wechat/bind/verify",
      handler: async (req, res) => {
        // 只转发手机微信上那串数字配对码；不认识的字段一律不带过去（控制面只认 {code}）。
        const body = await readJsonBody(req);
        if (body.__parseError) {
          return sendJson(res, 400, { ok: false, code: "bad_request", error: "配对码提交的数据不是合法 JSON，请重新输入。" });
        }
        const code = String(body.code == null ? "" : body.code).trim();
        await sendWeChatProxy(relayDir, res, "/wechat/bind/verify", { method: "POST", body: { code } });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/wechat/bind/cancel",
      handler: async (_req, res) => {
        await sendWeChatProxy(relayDir, res, "/wechat/bind/cancel", { method: "POST" });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/wechat/unbind",
      handler: async (_req, res) => {
        await sendWeChatProxy(relayDir, res, "/wechat/unbind", { method: "POST" });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/account",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, account: await relayAccount(relayDir) });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/quota",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, quota: await relayQuota(relayDir) });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/invite-records",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, ...(await relayInviteRecords(relayDir)) });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/remote-url",
      handler: async (_req, res) => {
        const pub = await relayFetch(relayDir, "/api/public-config");
        const body = pub.ok && pub.body && typeof pub.body === "object" ? pub.body : {};
        sendJson(res, 200, {
          ok: true,
          remoteUrl: body.app_url || DEFAULT_APP_URL,
          relayReachable: pub.ok,
          publicConfig: body
        });
      },
    },
    // 交流群二维码（设置面板「加入交流群」按钮 + 用户反馈页展示；未配置返回空串，UI 不展示入口）
    {
      method: "GET",
      path: "/dsh-remote/community",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, ...(await communityInfo(relayDir)) });
      },
    },
    // 一次性访问密钥（📱 远程访问卡）：GET 即创建新 key，企业端 POST /api/auth-key（Bearer）
    {
      method: "GET",
      path: "/dsh-remote/access-key",
      handler: async (_req, res) => {
        await proxyCreateAccessKey(relayDir, res);
      },
    },
    // 已授权设备列表（企业端 POST /api/mobile-sessions，Bearer）
    {
      method: "GET",
      path: "/dsh-remote/mobile-sessions",
      handler: async (_req, res) => {
        await proxyMobileSessions(relayDir, res);
      },
    },
    // 取消已授权设备配对（企业端 POST /api/mobile-sessions/:id/revoke，Bearer）
    {
      method: "POST",
      path: "/dsh-remote/mobile-sessions/revoke",
      handler: async (req, res) => {
        await proxyRevokeMobileSession(relayDir, req, res);
      },
    },
    // 删除已授权设备记录（整行删除并拉黑 jti；企业端 DELETE /api/mobile-sessions/:id，Bearer）
    {
      method: "DELETE",
      path: "/dsh-remote/mobile-sessions/delete",
      handler: async (req, res) => {
        await proxyDeleteMobileSession(relayDir, req, res);
      },
    },
    // 清理本人全部已解绑（revoked）记录（企业端 POST /api/mobile-sessions/purge，Bearer）
    {
      method: "POST",
      path: "/dsh-remote/mobile-sessions/purge",
      handler: async (_req, res) => {
        await proxyPurgeMobileSessions(relayDir, res);
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/config",
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
        const cfg = loadConfig(relayDir);
        const mode = body.mode === "local" ? "local" : "saas";
        if (mode === "local") {
          // 自建模式:服务器地址 + 访问密钥(免账号体系;随时可切回 SaaS)
          const selfHostUrl = String(body.selfHostUrl ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
          const localKey = String(body.localKey ?? "").trim();
          if (!selfHostUrl || !localKey) return sendJson(res, 400, { ok: false, error: "自建模式需要服务器地址与访问密钥" });
          cfg.tunnel_url = `wss://${selfHostUrl}`;
          cfg.local_key = localKey;
        } else {
          const phone = String(body.phone ?? "").trim();
          const password = String(body.password ?? "");
          if (!phone || !password) return sendJson(res, 400, { ok: false, error: "手机号与密码必填" });
          const accountChanged = (cfg.phone || cfg.email || "") !== phone || Boolean(cfg.email && cfg.email !== phone);
          cfg.phone = phone;
          cfg.password = password;
          delete cfg.email;
          if (accountChanged) {
            delete cfg.device_id;
            delete cfg.device_private_key;
            delete cfg.device_public_key;
          }
          // SaaS 权威归一化：清除自建残留(local_key/假 tunnel_url)，api/tunnel 一律按云端重算
          applySaaSMode(cfg);
          // device-login 共享密钥自愈：只装插件的路径没有安装器那一步，缺密钥会导致
          // 「首次安装后立即登录」时面板拿不到二维码/设备列表（旧版要等后台自愈或手动刷新）。
          // 这里在启动 bridge 之前补齐，bridge 首次启动即可带上密钥。
          if (!cfg.bridge_secret) {
            // 3s 上限：这次取密钥在登录响应路径上，宁可先放行（后续请求还会自愈）也不拖慢登录
            const secret = await bridgeSecretOf(relayDir, cfg, { timeoutMs: 3000 });
            if (secret) cfg.bridge_secret = secret;
          }
        }
        // 账号/模式变化 → 先停掉旧 bridge 并作废它的注册证据，否则新账号永远等不到这台设备
        const accountFpBefore = accountFingerprintOf(loadConfig(relayDir));
        saveConfig(relayDir, cfg);
        invalidateRelayToken(relayDir); // 账号可能变了：丢弃旧 token 缓存，立即用新账号认证
        if (accountFingerprintOf(cfg) !== accountFpBefore) resetBridgeForAccountChange(relayDir, "账号/模式已变更");
        const bridgeRestart = startBridge(relayDir);
        // 登录成功即上报本机安装信息（企业端用于「升级插件后刷新版本号」口径）；失败静默。
        maybeReportInstall(relayDir, { force: true });
        sendJson(res, 200, { ok: true, bridgeRestart, ...(await composeStatus(relayDir)) });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/logout",
      handler: async (_req, res) => {
        // 退出登录：清除本机保存的账号(邮箱/密码)，并**立刻停掉 bridge**。
        // 为什么必须停：bridge 的凭据是启动时固化的，不停就会继续用旧账号的隧道对外服务 ——
        // 用户以为"已退出登录"，实际上手机端仍能访问这台电脑（安全语义不成立）。
        const cfg = loadConfig(relayDir);
        delete cfg.phone;
        delete cfg.password;
        delete cfg.device_id;          // 设备身份一并作废：下次登录会生成新身份并重新登记
        delete cfg.device_private_key;
        delete cfg.device_public_key;
        saveConfig(relayDir, cfg);
        resetBridgeForAccountChange(relayDir, "退出登录");
        invalidateRelayToken(relayDir); // 退出登录：token 缓存立即失效
        sendJson(res, 200, { ok: true, ...(await composeStatus(relayDir)) });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/harness/restart",
      handler: async (_req, res) => {
        // 首次安装/在线更新后重启 DeepSeek harness：插件本体与浏览器半在进程启动时装载，
        // 不重启则面板入口与 /dsh-remote/* 路由都不会出现。只重启承载本插件的进程。
        const r = await restartHarness(relayDir);
        const payload = { ...(await composeStatus(relayDir)), ...r };
        if (!r.ok) payload.error = r.detail || r.status || "重启失败";
        sendJson(res, r.ok ? 200 : 500, payload);
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/start",
      handler: async (_req, res) => {
        const r = startBridge(relayDir);
        // 【0.6.2】composeStatus 自带 ok:true（那是「状态查询成功」），必须先展开再覆盖，
        // 否则不管启动成没成功都回 ok:true → 面板一律弹「✅ bridge 已启动」。
        // 失败时额外带上 error：浏览器半的 api() 优先用它做提示文案，避免只看到「HTTP 500」。
        const payload = { ...(await composeStatus(relayDir)), ...r };
        if (!r.ok) payload.error = r.detail || r.status || "启动失败";
        sendJson(res, r.ok ? 200 : 500, payload);
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/stop",
      handler: async (_req, res) => {
        const r = stopBridge(relayDir);
        const payload = { ...(await composeStatus(relayDir)), ...r };
        if (!r.ok) payload.error = r.detail || r.status || "停止失败";
        sendJson(res, r.ok ? 200 : 500, payload);
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/sms-code",
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
        let phone = String(body.phone ?? "").trim();
        if (!phone) {
          // 隐私审计(2026-09):账号卡修改密码不再下发明文手机号——服务端以本机账号为准
          phone = String((loadConfig(relayDir).phone) || "").trim();
        }
        if (!phone) return sendJson(res, 400, { ok: false, error: "手机号必填" });
        const r = await relayFetch(relayDir, "/api/sms-code", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone, ...(body.captcha_id !== undefined ? { captcha_id: String(body.captcha_id), captcha_answer: String(body.captcha_answer ?? "") } : {}) }),
        });
        sendJson(res, r.status || 502, { ok: r.ok, status: r.status, body: r.body });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/password/reset",
      handler: async (req, res) => {
        // 公开 POST /api/password/reset（无需 Bearer）：短信验证码重置密码。
        // 成功 → 企业端使该账号全部授权设备/会话失效（含 E2EE 派生口令）。
        const body = await readJsonBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
        let phone = String(body.phone ?? "").trim();
        if (!phone) {
          // 隐私审计(2026-09):同上,账号卡改密不传明文手机号,服务端回填本机账号
          phone = String((loadConfig(relayDir).phone) || "").trim();
        }
        const smsCode = String(body.sms_code ?? "").trim();
        const newPassword = String(body.new_password ?? body.password ?? "");
        if (!phone || !smsCode || !newPassword) return sendJson(res, 400, { ok: false, error: "手机号、短信验证码与新密码必填" });
        const r = await relayFetch(relayDir, "/api/password/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone, sms_code: smsCode, new_password: newPassword }),
        });
        // 透传企业端 ok/error（成功 200 {ok:true}；失败保留 status 与错误体）
        sendJson(res, r.status || 502, { ok: r.ok, status: r.status, body: r.body });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/captcha",
      handler: async (_req, res) => {
        // 代理 relay /api/captcha。live 契约：200 JSON {captcha_id, svg}；
        // 兼容旧服务端可能返回的图片（content-type 以 image/ 开头时原样透传）。
        const cfg = loadConfig(relayDir);
        const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
        try {
          const r = await fetch(`${api}/api/captcha`, { signal: AbortSignal.timeout(6000) });
          const type = r.headers.get("content-type") || "";
          const buf = Buffer.from(await r.arrayBuffer());
          if (!r.ok) {
            sendJson(res, r.status, { ok: false, error: "验证码获取失败", relayStatus: r.status });
            return;
          }
          if (type.startsWith("image/")) {
            res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
            res.end(buf);
            return;
          }
          // JSON（{captcha_id, svg}）原样透传
          res.writeHead(200, { "content-type": type || "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(buf);
        } catch (e) {
          sendJson(res, 502, { ok: false, error: `验证码服务不可达: ${e.message}` });
        }
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/register",
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
        const phone = String(body.phone ?? "").trim();
        const smsCode = String(body.sms_code ?? "").trim();
        const password = String(body.password ?? "");
        if (!phone || !smsCode || !password) return sendJson(res, 400, { ok: false, error: "手机号、短信验证码与密码必填" });
        // 全量透传 body（不挑字段）：注册来源 reg_source（面板=panel_register／手机端网页=remoteweb_register）
        // 等扩展字段必须原样进企业端，否则「用户从哪注册的」这类增长口径会全部丢失。
        const payload = { ...body, phone, sms_code: smsCode, password };
        delete payload.__parseError;
        const captchaId = body.captcha_id ?? body.captchaId;
        const captchaAnswer = body.captcha_answer ?? body.captcha;
        if (captchaId !== void 0) payload.captcha_id = String(captchaId);
        if (captchaAnswer !== void 0) payload.captcha_answer = String(captchaAnswer);
        const r = await relayFetch(relayDir, "/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        // 透传 relay 响应体（成功 {token,user} / 失败 {error:{message}}）
        sendJson(res, r.status || 502, { ok: r.ok, status: r.status, body: r.body });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/login",
      handler: async (req, res) => {
        const body = await readJsonBody(req);
        if (body.__parseError) return sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
        const phone = String(body.phone ?? "").trim();
        const password = String(body.password ?? "");
        if (!phone || !password) return sendJson(res, 400, { ok: false, error: "手机号与密码必填" });
        // 登录接口已加图形验证码,透传 captcha 字段
        const payload = { phone, password };
        if (body.captcha_id !== undefined) payload.captcha_id = String(body.captcha_id);
        if (body.captcha_answer !== undefined) payload.captcha_answer = String(body.captcha_answer);
        const r = await relayFetch(relayDir, "/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        sendJson(res, r.status || 502, { ok: r.ok, status: r.status, body: r.body });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/feedback-config",
      handler: async (_req, res) => {
        const cfg = loadConfig(relayDir);
        const api = feedbackApiOf(cfg);
        let reachable = false;
        try {
          const r = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(3000) });
          reachable = r.ok;
        } catch {
          reachable = false;
        }
        sendJson(res, 200, {
          ok: true,
          feedbackUrl: api,
          reachable,
          deviceId: cfg.device_id || "",
          phone: maskPhone(cfg.phone || ""), // 隐私:浏览器端只见掩码(代理提交时服务端另附真号)
          // 登录态（已配置账号或自建密钥）→ 节点半自动附加 JWT，免图形验证码
          auth: cfg.local_key || (cfg.phone && cfg.password) ? "account" : "anonymous"
        });
      },
    },
    {
      method: "ALL",
      path: "/dsh-remote/feedback",
      prefix: true,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        await proxyFeedback(relayDir, req, res, url.pathname + url.search);
      },
    },
  ];

  const disposers = [];
  for (const route of routes) {
    const dispose = ctx.webServer.register({
      kind: route.prefix ? "prefix" : "exact",
      path: route.path,
      handler: (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const match = route.prefix
          ? url.pathname === route.path || url.pathname.startsWith(route.path + "/")
          : url.pathname === route.path;
        const methodOk = route.method === "ALL" || req.method === route.method;
        if (!match || !methodOk) {
          res.writeHead(404);
          res.end();
          return;
        }
        Promise.resolve(route.handler(req, res)).catch((e) => {
          ctx.logger?.warn?.(`dsh-remote-web: ${route.method} ${route.path} failed: ${e?.stack || e}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e?.message || e) });
          else res.end();
        });
        return; // webserver 不需要返回值；返回 void 保持 node:http 语义
      },
    });
    disposers.push(dispose);
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * 插件主体：注册 /dsh-remote/* 路由。
 * @param ctx - host cordis context（注入 webServer）。
 * @param config - entry config（可选 relayDir）。
 */
export function apply(ctx, config = {}) {
  const relayDir = config.relayDir || process.env.DSH_RELAY_DIR || DEFAULT_RELAY_DIR;
  // 全新激活（dsh web 重启后插件重新加载，或卸载后再次安装）→ 解除上次的「已卸载」停摆标记
  UNINSTALLED_DIRS.delete(relayDir);
  // 匿名遥测：装载即初始化（读回上次进程遗留的磁盘队列，例如重启前那条 harness_restart，
  // 并启动 60s 发送心跳），随后记一条 plugin_loaded（每进程一次）。
  // DSH_REMOTE_TELEMETRY=0 → 这里连读都不读：零文件、零请求、零 install_id。
  telemetryStart(relayDir);
  telemetryOnce(relayDir, "plugin_loaded");
  // 清理上次进程残留的安装/更新 marker（宿主被重启/强杀时子进程清理回调会丢失）
  sweepStaleMarkers(relayDir);
  // 「待重启」状态结清 + 运行时安装检测：
  //   - bootId 变了 = 这次装载发生在新进程里 → 重启已完成，撤下提示；
  //   - 插件文件晚于本进程启动才落盘（市场安装/在线更新在运行中改写）→ 当前进程里
  //     根本没有本插件的路由与面板，必须重启 DeepSeek harness 才能生效。
  const settled = settleRestartState(relayDir);
  if (settled.cleared) {
    ctx.logger?.info?.("dsh-remote-web: 检测到 DeepSeek harness 已重启，撤下「需要重启」提示");
  }
  if (!readRestartState(relayDir).pending && pluginInstalledAfterBoot()) {
    // 唯一还需要用户动一下的情形:插件文件晚于本进程启动才落盘(= 运行中被市场安装/在线更新改写),
    // 此时本进程里没有本插件的路由与面板。**先让用户刷新页面**(客户端半随之更新);
    // 只有刷新后仍无面板才需要重启(那时多半是 profile patch 行没被 HMR 读到)。
    // 不再对"首次安装/在线更新完成"提示重启:插件走 patch 热加载、bridge 是独立进程,重启 harness 无必要。
    markRestartPending(relayDir, "refresh", "插件已更新，刷新页面即可生效");
    ctx.logger?.info?.("dsh-remote-web: 插件文件晚于本次进程启动 → 提示刷新页面");
  }
  ctx.effect(() => registerRoutes(ctx, relayDir), "dsh-remote-web: /dsh-remote routes");
  // 0.1.2-rc.1+ 浏览器会话代持：换取 Harness 会话 Cookie 供 bridge 上游携带（手机点设备不再 401 白页）
  ctx.effect(() => scheduleHarnessMint(ctx, relayDir), "dsh-remote-web: harness browser-session mint");
  // 插件市场一键全功能:缺桌面运行环境则自动安装,登录后自动拉起 bridge(不依赖用户跑 npx)
  ctx.effect(() => scheduleRuntime(relayDir), "dsh-remote-web: runtime self-provision");
  // 匿名遥测：插件停摆（卸载/重载）时停掉发送心跳；磁盘队列留给下次装载补发。
  ctx.effect(() => () => telemetryStop(relayDir), "dsh-remote-web: telemetry flush ticker");
  // 【0.6.2】市场安装路径的「装到用户电脑上」第一步：插件加载即后台补装桌面运行环境
  // （bridge + 自启动），不再等用户先登录、也不再依赖 launchd 状态判断是否「已在运行」。
  // 已就绪时是零副作用 no-op；正在安装中/已卸载时 ensureRuntime 自身幂等挡下。
  const provisioned = ensureRuntime(relayDir);
  if (!provisioned && !runtimeReady(relayDir)) {
    ctx.logger?.info?.(`dsh-remote-web: 桌面运行环境缺失，已在后台自动安装（relayDir=${relayDir}）`);
    telemetryRuntimeProbe(relayDir); // 匿名遥测：记下「本进程见过运行环境缺失」（装好后发 runtime_ready）
  }
  // 插件启动即上报本机安装信息（install_source/version + 主机 OS/架构；仅有账号凭据时上报，失败静默）。
  // 面板登录成功（POST /dsh-remote/config）时会再上报一次，覆盖「已登录用户升级插件」的口径。
  maybeReportInstall(relayDir);
  ctx.logger?.info?.(`dsh-remote-web: /dsh-remote routes ready (relayDir=${relayDir})`);
}

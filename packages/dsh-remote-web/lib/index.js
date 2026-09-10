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
//   - 0.1.2+ ?token 浏览器鉴权会话代持（0.4.1 起）
//
// 不依赖任何第三方包：只使用 node 内置模块与 cordis 注入的 webServer 服务。
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, accessSync, chmodSync, openSync, closeSync, rmSync, constants as fsConstants } from "node:fs";
import { join, dirname, sep } from "node:path";
import { execSync, spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

/** 本插件在 host 侧的服务依赖。 */
export const inject = ["webServer"];

/** 默认配置目录（可被 entry config 的 relayDir / DSH_RELAY_DIR 环境变量覆盖）。 */
const DEFAULT_RELAY_DIR = process.env.DSH_RELAY_DIR || join(homedir(), ".dsh-remote");
// 默认云端服务地址（SaaS 入口；自建用户在设置页/面板切换）
const DEFAULT_API = "https://n.risegao.cn:13443/relay-api";
const DEFAULT_APP_URL = "https://n.risegao.cn:13443/app/";

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
 * 解析 npx 绝对路径。DeepSeek App 拉起 dsh web 时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
 * （没有 /opt/homebrew/bin 等），裸 `npx` 会 spawn ENOENT 而静默失败——必须按绝对路径找，
 * 且子进程 env 的 PATH 要把当前 node 所在目录补在最前（npx 的 #!/usr/bin/env node 依赖它）。
 */
function npxCommand() {
  const name = process.platform === "win32" ? "npx.cmd" : "npx";
  const dirs = [
    dirname(process.execPath),           // 与当前 node 同目录（homebrew/usr/local 均可覆盖）
    process.env.DSH_SETUP_NPX_DIR || "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/opt/node@20/bin",
    "/usr/local/opt/node@20/bin",
    "/usr/bin",
  ].filter(Boolean);
  for (const d of dirs) {
    const real = resolveExecutable(join(d, name));
    if (real) return real;
  }
  return name; // 全找不到 → 退回裸名（普通 shell 场景仍可用）
}

/** 子进程环境：把 node 目录补进 PATH（npx 及其 shebang 需要），可附加额外变量。 */
function spawnEnv(extra) {
  const nodeDir = dirname(process.execPath);
  const base = process.env.PATH || "";
  const PATH = [nodeDir, base, "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"].filter(Boolean).join(":");
  return { ...process.env, PATH, ...(extra || {}) };
}

// ---------- 后台子进程标记（防重入 + 宿主重启自愈） ----------
// marker 内容 = JSON {pid, at}：pid 供“宿主重启后立即清理死进程残留”判断；
// 兼容旧格式（纯时间戳数字 → 只按超时清理）。

function readMarkerInfo(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
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
  for (const name of [PROVISION_MARKER, UPDATE_MARKER]) {
    const p = join(relayDir, name);
    let info;
    try { info = readMarkerInfo(p); } catch { continue; }
    if (!info) continue;
    const dead = pidAlive(info.pid);
    const expired = now - info.at > STALE_MARKER_MS;
    if (dead === false || (dead === null && expired)) {
      try { rmSync(p, { force: true }); } catch { /* ignore */ }
      appendLogLine(relayDir, AUTO_INSTALL_LOG,
        `[dsh-remote-web] 清理残留标记 ${name}（pid=${info.pid ?? "?"}, at=${new Date(info.at).toISOString()}${dead === false ? ", 进程已死" : ", 已超时"}）`);
    }
  }
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
const HARNESS_AUTH_RETRY_MS = 3000;
const HARNESS_AUTH_RETRY_MAX = 20; // 最多约 60s 等 connection 服务就绪
const HARNESS_AUTH_REFRESH_MS = 6 * 3600 * 1000;

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
    return true;
  } catch {
    return false;
  }
}

/** 后台调度:启动重试直到换取成功,成功后每 6h 刷新(与插件生命周期同进退)。 */
function scheduleHarnessMint(ctx, relayDir) {
  let succeeded = false;
  let retries = 0;
  const attempt = async () => {
    if (succeeded) return;
    if (await mintHarnessCookie(ctx, relayDir)) succeeded = true;
  };
  const bootIv = setInterval(() => {
    if (succeeded || ++retries > HARNESS_AUTH_RETRY_MAX) {
      clearInterval(bootIv);
      return;
    }
    void attempt();
  }, HARNESS_AUTH_RETRY_MS);
  bootIv.unref?.();
  const refreshIv = setInterval(() => {
    void mintHarnessCookie(ctx, relayDir).catch(() => {});
  }, HARNESS_AUTH_REFRESH_MS);
  refreshIv.unref?.();
  return () => {
    clearInterval(bootIv);
    clearInterval(refreshIv);
  };
}

// ---------- bridge 服务状态 / 启停（launchctl，macOS） ----------

function launchAgentPath() {
  if (platform() === "darwin") return join(homedir(), "Library/LaunchAgents/com.dshremote.bridge.plist");
  return null;
}

function launchTarget() {
  return `gui/${process.getuid()}/com.dshremote.bridge`;
}

/** 检查 launchd 服务状态（state=running + pid；兜底 launchctl list）。 */
function launchdStatus() {
  const target = launchTarget();
  const pr = sh(`launchctl print ${target}`);
  if (pr.ok && /state\s*=\s*running/.test(pr.stdout)) {
    const m = pr.stdout.match(/pid\s*=\s*(\d+)/);
    return { running: true, pid: m ? Number(m[1]) : null };
  }
  const ls = sh(`launchctl list | grep com.dshremote.bridge`);
  if (ls.ok) {
    const pidStr = ls.stdout.trim().split(/\s+/)[0];
    if (pidStr && pidStr !== "-" && /^\d+$/.test(pidStr)) return { running: true, pid: Number(pidStr) };
  }
  return { running: false, pid: null };
}

/** 检查手动运行的 watcher（dsh-setup.mjs run）与 bridge 子进程（排除 launchd 托管链）。 */
function manualStatus() {
  const launchdPid = launchdStatus().pid;
  const out = (() => {
    const r = sh("pgrep -fl 'dsh-setup.mjs|dsh-bridge.mjs'");
    return r.ok ? r.stdout : "";
  })();
  const watcher = [];
  const bridge = [];
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
    if (launchdPid !== null && parentOf(pid) === launchdPid) continue; // launchd 托管的 bridge 子进程
    if (/dsh-setup\.mjs/.test(m[2])) watcher.push(pid);
    else if (/dsh-bridge\.mjs/.test(m[2])) bridge.push(pid);
  }
  return { watcher, bridge };
}

// ---------- 插件市场一键全功能：缺桌面运行环境时自动后台安装 dsh-remote ----------

const PROVISION_MARKER = ".dsh-setup-installing";
const AUTO_INSTALL_LOG = ".dsh-setup-install.log";
const STALE_MARKER_MS = 30 * 60 * 1000; // 超过该时长视为上次进程残留，插件启动时清理

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
function ensureRuntime(relayDir) {
  if (UNINSTALLED_DIRS.has(relayDir)) return false; // 已彻底卸载：不再自动安装运行环境
  if (existsSync(join(relayDir, "dsh-setup.mjs"))) return true;
  const marker = join(relayDir, PROVISION_MARKER);
  if (existsSync(marker)) return false; // 正在安装中
  try {
    mkdirSync(relayDir, { recursive: true });
    const log = join(relayDir, AUTO_INSTALL_LOG);
    const child = spawn(npxCommand(), ["--yes", UPDATE_SPEC], {
      detached: true,
      env: spawnEnv({ npm_config_registry: "https://registry.npmjs.org" }),
      stdio: ["ignore", openSync(log, "a"), openSync(log, "a")]
    });
    writeMarker(marker, child.pid); // 记 pid：宿主重启后可立即清理死进程残留
    const clear = () => { try { rmSync(marker, { force: true }); } catch { /* ignore */ } };
    child.on("exit", (code) => {
      clear();
      appendLogLine(relayDir, AUTO_INSTALL_LOG, `[auto-install] npx 退出 code=${code ?? "?"}`);
    });
    child.on("error", (e) => {
      clear();
      appendLogLine(relayDir, AUTO_INSTALL_LOG, `[auto-install] 启动失败: ${e.message}`);
      console.warn(`[dsh-remote-web] 自动安装子进程启动失败: ${e.message}`);
    });
    child.unref();
    console.log(`[dsh-remote-web] 检测到缺少桌面运行环境,已在后台自动安装(日志: ${log}),完成后将自动启动 bridge`);
    return false;
  } catch (e) {
    console.warn(`[dsh-remote-web] 自动安装启动失败: ${e.message}`);
    try { rmSync(marker, { force: true }); } catch { /* ignore */ }
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
  <key>StandardOutPath</key><string>${join(relayDir, ".dsh-bridge.log")}</string>
  <key>StandardErrorPath</key><string>${join(relayDir, ".dsh-bridge.log")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict></plist>`;
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist, { mode: 0o644 });
  return plistPath;
}

/** 启动 bridge：确保 plist 存在 → launchctl bootstrap（回退 load -w）。 */
function startBridge(relayDir) {
  if (UNINSTALLED_DIRS.has(relayDir)) {
    // 已彻底卸载：面板/自愈在重启前可能仍在内存中，禁止再把自启动与 plist 拉回来
    return { ok: false, status: "uninstalled", detail: "插件已彻底卸载，重启 dsh web 后生效" };
  }
  const plistPath = launchAgentPath();
  if (!plistPath) return { ok: false, status: "unsupported", detail: "仅支持 macOS" };
  if (!existsSync(plistPath)) writeAutostartFile(relayDir);
  if (!existsSync(plistPath)) return { ok: false, status: "not-installed", detail: "plist 生成失败" };
  const target = launchTarget();
  const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
  sh(`launchctl bootout ${target}`);
  let boot = sh(`launchctl bootstrap gui/${process.getuid()} ${q(plistPath)}`);
  if (!boot.ok) {
    sh(`launchctl unload ${q(plistPath)}`);
    boot = sh(`launchctl load -w ${q(plistPath)}`);
  }
  if (!boot.ok) return { ok: false, status: "failed", detail: (boot.stderr || boot.stdout).trim() || "launchctl 启动失败" };
  const st = launchdStatus();
  return { ok: st.running, status: st.running ? "running" : "failed", pid: st.pid, detail: st.running ? void 0 : "服务未进入运行态" };
}

/** 运行时自愈 watcher:账号就绪后若环境缺失则自动安装;装好/重启后自动拉起 bridge。 */
function scheduleRuntime(relayDir) {
  let done = false;
  const iv = setInterval(() => {
    if (done) { clearInterval(iv); return; }
    if (UNINSTALLED_DIRS.has(relayDir)) { done = true; clearInterval(iv); return; } // 已彻底卸载：自愈 watcher 停摆
    try {
      const cfg = loadConfig(relayDir);
      const hasAcct = Boolean((cfg.phone || cfg.email) && cfg.password) || Boolean(cfg.local_key);
      if (!hasAcct) return;
      // 先看服务是否已在运行（runtime 可能位于 npx 缓存/固化目录，不必重复安装）
      const st = launchdStatus();
      if (st.running) { done = true; clearInterval(iv); return; }
      const setupUrl = join(relayDir, "dsh-setup.mjs");
      if (!existsSync(setupUrl)) {
        ensureRuntime(relayDir); // 什么环境都没有 → 后台 npx 安装一次
        return;
      }
      startBridge(relayDir); // 环境在但服务没起 → 拉起
    } catch { /* 下一轮再试 */ }
  }, 12_000);
  iv.unref?.();
  return () => clearInterval(iv);
}

/** 停止 bridge：launchctl bootout。 */
function stopBridge() {
  const target = launchTarget();
  const r = sh(`launchctl bootout ${target}`);
  const st = launchdStatus();
  return { ok: !st.running, status: st.running ? "failed" : "stopped", pid: null, detail: st.running ? (r.stderr || "停止失败").trim() : void 0 };
}

// ---------- 彻底卸载：bridge 自启动 / 残留进程 / 配置目录 ----------

/**
 * 已执行「彻底卸载」的 relayDir 集合。卸载动作本身不改代码，但 dsh web 重启前本插件仍在内存中：
 * 自愈调度（scheduleRuntime/ensureRuntime/startBridge）与浏览器会话代持（mintHarnessCookie）
 * 若继续执行，会把刚清空的配置目录 / 自启动服务重新拉起来——故卸载后本进程内一律停摆，
 * 直到 dsh web 重启（profile 引用已移除，插件整体不再加载）或重新激活（apply 时清除）。
 */
const UNINSTALLED_DIRS = new Set();

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
    servicePlatform: platform() === "darwin" ? "launchd" : platform() === "linux" ? "systemd" : "none",
  };
  const skipService = process.env.DSH_RELAY_SKIP_SERVICE === "1";
  if (!skipService) {
    // a) 停服务 + 移除自启动文件
    try {
      if (platform() === "darwin") {
        // 只处理「plist 位于当前 HOME」的服务：本插件/dsh-setup.mjs 安装的服务一定在此
        const plistPath = launchAgentPath();
        if (plistPath && existsSync(plistPath)) {
          if (launchdStatus().running) {
            const r = stopBridge(); // launchctl bootout → KeepAlive 一并失效
            out.stoppedService = r.ok;
          }
          rmSync(plistPath, { force: true });
          out.removedPlist = !existsSync(plistPath);
        }
      } else if (platform() === "linux") {
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
      const manual = manualStatus();
      const targets = [...manual.watcher, ...manual.bridge];
      for (const pid of targets) {
        try { process.kill(pid, "SIGTERM"); out.killedPids.push(pid); } catch { /* EPERM/ESRCH 忽略 */ }
      }
      if (targets.length) {
        try { execSync("sleep 1", { timeout: 3000 }); } catch { /* 等待进程退出 */ }
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

// ---------- relay API 代理（直连，不走系统代理；undici 默认忽略代理环境变量） ----------

async function relayFetch(relayDir, pathname, init) {
  const cfg = loadConfig(relayDir);
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  const url = `${api}${pathname}`;
  try {
    // 6s 超时：relay 不可达时快速降级，不拖慢面板
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
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

// ---------- v2 账号/配额/邀请代理（我的信息 与 免费额度提示） ----------

/** token 获取失败的原因（供 UI 区分“未登录”与“中继未就绪”，不再一律谎报“尚未登录”）。 */
const AUTH_NO_CREDENTIALS = "no_credentials";       // 本机没存账号/自建密钥 → 该去登录
const AUTH_BAD_CREDENTIALS = "bad_credentials";     // 账号密码被企业端拒绝 → 该重新登录
const AUTH_RELAY_UNREACHABLE = "relay_unreachable"; // 网络/5xx/超时 → 稍后重试
const AUTH_RELAY_NOT_READY = "relay_not_ready";     // 凭证齐全但企业端未接受（缺失/轮换中的设备密钥等）→ 稍后重试

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
async function relayTokenWithReason(relayDir, cfgOverride) {
  const cfg = cfgOverride && typeof cfgOverride === "object" ? { ...loadConfig(relayDir), ...cfgOverride } : loadConfig(relayDir);
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
  const manual = manualStatus();
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
      launchd,
      manual,
      running: launchd.running || manual.bridge.length > 0,
      bindError,
      // E2EE 开关状态（bridge 写 .e2ee-state.json；文件缺失 = 未启用明文）：
      // {enabled, reason, profile, epoch, caps}，供面板「📱 远程访问」卡展示加密状态。
      e2ee: readE2eeStateFile(relayDir),
    },
    // 隐私审计(2026-09):不再下发真实 hostname(移除 host 字段)——设备标识统一走 deviceId/服务端登记名
  };
}

// ---------- 用户反馈代理（反馈 API 由 relay-enterprise 提供，同源 /relay-api/） ----------

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
 * 把 /dsh-remote/feedback/* 代理到反馈 API（relay-enterprise 同源 /relay-api/）：
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
const PLUGIN_VERSION = "0.6.1-beta.1";
const UPDATE_LOG = ".dsh-update.log";
const UPDATE_MARKER = ".dsh-update-running";

/**
 * 更新通道（发布策略）：普通用户只拉稳定 dist-tag `latest`；预发(alpha/beta)由作者/内测
 * 通过 `DSH_UPDATE_TAG=beta`（或显式版本号）拉取。迭代一律先发 beta/alpha，稳定后才升 latest。
 */
const UPDATE_TAG = (process.env.DSH_UPDATE_TAG || "latest").replace(/^@/, "");
const UPDATE_SPEC = `@mrrisega/dsh-remote@${UPDATE_TAG}`;

/** 查询所选通道(npm dist-tag)最新版（官方源优先，失败回退 npmmirror；纯服务端无 CORS 限制）。 */
async function npmLatestVersion() {
  for (const reg of ["https://registry.npmjs.org/@mrrisega/dsh-remote", "https://registry.npmmirror.com/@mrrisega/dsh-remote"]) {
    try {
      const res = await fetch(reg, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json();
      const tags = j && j["dist-tags"] ? j["dist-tags"] : {};
      if (typeof tags[UPDATE_TAG] === "string") return tags[UPDATE_TAG];
    } catch { /* 试下一个源 */ }
  }
  return "";
}

/** 以 detached 子进程执行 `npx --yes <UPDATE_SPEC>`（env 可覆盖 npm 源/更新通道）。 */
function spawnUpdater(relayDir, extraEnv) {
  const log = join(relayDir, UPDATE_LOG);
  return spawn(npxCommand(), ["--yes", UPDATE_SPEC], {
    detached: true,
    cwd: homedir(),
    env: spawnEnv(extraEnv), // PATH 补 node 目录：App 最小 PATH 下也能跑 npx
    stdio: ["ignore", openSync(log, "a"), openSync(log, "a")]
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
function runOnlineUpdate(relayDir) {
  try {
    mkdirSync(relayDir, { recursive: true });
    const marker = join(relayDir, UPDATE_MARKER);
    if (existsSync(marker)) return { ok: false, detail: "已有更新在进行中，请稍候" };
    appendLogLine(relayDir, UPDATE_LOG, `[update] 开始在线更新 ${UPDATE_SPEC} (${new Date().toISOString()})`);

    let retried = false;
    const clear = () => { try { rmSync(marker, { force: true }); } catch { /* ignore */ } };
    const run = () => {
      // 第一次：官方 npm 源；失败(exit≠0/网络)才回退用户默认源（通常为国内镜像）
      const child = spawnUpdater(relayDir, retried ? {} : { npm_config_registry: "https://registry.npmjs.org" });
      writeMarker(marker, child.pid);
      child.on("exit", (code) => {
        if (!retried && code !== 0) {
          retried = true;
          appendLogLine(relayDir, UPDATE_LOG, `[update] 官方源安装失败(exit=${code})，回退默认源(npmmirror 等)重试…`);
          run();
          return;
        }
        appendLogLine(relayDir, UPDATE_LOG, `[update] npx 退出 code=${code ?? "?"}（${retried ? "默认源" : "官方源"}）`);
        clear();
      });
      child.on("error", (e) => {
        appendLogLine(relayDir, UPDATE_LOG, `[update] 子进程启动失败: ${e.message}`);
        clear();
      });
      child.unref();
      return child;
    };
    const child = run();
    return { ok: true, pid: child.pid, log: join(relayDir, UPDATE_LOG) };
  } catch (e) {
    try { rmSync(join(relayDir, UPDATE_MARKER), { force: true }); } catch { /* ignore */ }
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

/** 彻底卸载第 2 步 —— profile 插件清理（兼容市场“拒绝改写用户补丁”）：移除 include、依赖、bundle、本地目录与链接。 */
function uninstallSelf(relayDir, profileDir, patchFile, pkgFile) {
  const out = { removedPatch: false, removedDep: false, removedDir: false, removedBundle: false };
  try {
    const patch = readFileSync(patchFile, "utf8");
    // 兼容当前与历史（dsh-remote-ui）两种管理标记
    const cleaned = patch
      .replace(/\n?# >>> dsh-remote-(?:web|ui) .*?# <<< dsh-remote-(?:web|ui)\s*/s, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n";
    if (cleaned !== patch) { writeFileSync(patchFile, cleaned); out.removedPatch = true; }
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
        sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, runtimeReady, relayDir });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/self/update-check",
      handler: async (_req, res) => {
        const latest = await npmLatestVersion();
        const current = PLUGIN_VERSION;
        sendJson(res, 200, { ok: true, current, latest, outdated: !!latest && latest !== current });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/self/update",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, ...runOnlineUpdate(relayDir) });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/self/update-log",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, running: existsSync(join(relayDir, UPDATE_MARKER)), log: tailOf(join(relayDir, UPDATE_LOG)) });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/self/uninstall",
      handler: async (_req, res) => {
        // 彻底卸载 = ① 运行时/bridge 清理（停自启动 → 杀残留 → 清空配置目录，顺序防 KeepAlive 复活）
        //           + ② 插件 profile 清理（include 块/依赖/bundle/本地目录与链接，解锁市场卸载）
        const rt = uninstallRuntime(relayDir, profileDir);
        const prof = uninstallSelf(relayDir, profileDir, join(profileDir, "cordis.patch.yml"), join(profileDir, "package.json"));
        // 卸载后本进程内（直到重启）自愈/代持调度一律停摆，不再重建配置目录或拉起 bridge
        markUninstalled(relayDir);
        const bits = [];
        if (prof.removedPatch || prof.removedDep || prof.removedBundle || prof.removedDir) bits.push("插件引用与本地文件已移除");
        if (rt.stoppedService) bits.push("bridge 自启动服务已停止");
        if (rt.removedPlist) bits.push("自启动项已删除");
        if (rt.killedPids.length) bits.push(`已结束 ${rt.killedPids.length} 个残留进程`);
        if (rt.removedDir) bits.push("配置目录已清空（账号/密钥/固化运行时等）");
        bits.push("请重启 dsh web 后完全卸载生效（本插件与「远程访问」面板将消失）；如需再次使用，在插件市场重新安装即可。");
        sendJson(res, 200, {
          ok: true,
          ...prof, // removedPatch / removedDep / removedBundle / removedDir(profile 插件目录)
          servicePlatform: rt.servicePlatform,
          stoppedService: rt.stoppedService,
          removedPlist: rt.removedPlist,
          killedPids: rt.killedPids,
          relayDirRemoved: rt.removedDir, // 配置目录 relayDir 已整目录清空
          relayDir,
          detail: bits.join("；"),
        });
      },
    },
    {
      method: "GET",
      path: "/dsh-remote/status",
      handler: async (_req, res) => {
        sendJson(res, 200, await composeStatus(relayDir));
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
        saveConfig(relayDir, cfg);
        const bridgeRestart = startBridge(relayDir);
        sendJson(res, 200, { ok: true, bridgeRestart, ...(await composeStatus(relayDir)) });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/logout",
      handler: async (_req, res) => {
        // 退出登录:清除本机保存的账号(邮箱/密码),bridge 下次重启将不再自动登录
        const cfg = loadConfig(relayDir);
        delete cfg.phone;
        delete cfg.password;
        saveConfig(relayDir, cfg);
        sendJson(res, 200, { ok: true, ...(await composeStatus(relayDir)) });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/start",
      handler: async (_req, res) => {
        const r = startBridge(relayDir);
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, status: r.status, pid: r.pid, detail: r.detail, ...(await composeStatus(relayDir)) });
      },
    },
    {
      method: "POST",
      path: "/dsh-remote/stop",
      handler: async (_req, res) => {
        const r = stopBridge();
        sendJson(res, r.ok ? 200 : 500, { ok: r.ok, status: r.status, detail: r.detail, ...(await composeStatus(relayDir)) });
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
        const payload = { phone, sms_code: smsCode, password };
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
  // 清理上次进程残留的安装/更新 marker（宿主被重启/强杀时子进程清理回调会丢失）
  sweepStaleMarkers(relayDir);
  ctx.effect(() => registerRoutes(ctx, relayDir), "dsh-remote-web: /dsh-remote routes");
  // 0.1.2-rc.1+ 浏览器会话代持：换取 Harness 会话 Cookie 供 bridge 上游携带（手机点设备不再 401 白页）
  ctx.effect(() => scheduleHarnessMint(ctx, relayDir), "dsh-remote-web: harness browser-session mint");
  // 插件市场一键全功能:缺桌面运行环境则自动安装,登录后自动拉起 bridge(不依赖用户跑 npx)
  ctx.effect(() => scheduleRuntime(relayDir), "dsh-remote-web: runtime self-provision");
  ctx.logger?.info?.(`dsh-remote-web: /dsh-remote routes ready (relayDir=${relayDir})`);
}

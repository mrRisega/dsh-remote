// dsh-remote-ui — node half (host plugin)
//
// 提供 /dsh-remote/* 同源 HTTP 路由，供浏览器半的配置面板调用：
//   - 读写 dsh-remote-open/.dsh-config.json（0600）
//   - 查询/启停 bridge（launchctl，plist 缺失时自动生成，逻辑与 dsh-setup.mjs 一致）
//   - 代理 relay API（captcha / register / login / public-config），直连、不走系统代理
//   - 自管理 self*（版本可见 / 新版检测 / 一键在线更新 / 彻底卸载）：插件市场没有更新卸载按钮，
//     面板内即官方管理入口；更新=后台 npx @mrrisega/dsh-remote@latest（幂等补齐运行环境并重启 bridge）
//   - 运行时自愈：缺运行环境自动后台安装、登录后自动拉起 bridge（0.4.2 起）
//   - 0.1.2+ ?token 浏览器鉴权会话代持（0.4.1 起）
//
// 不依赖任何第三方包：只使用 node 内置模块与 cordis 注入的 webServer 服务。
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, accessSync, chmodSync, openSync, closeSync, rmSync, constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { homedir, hostname, platform } from "node:os";
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
        `[dsh-remote-ui] 清理残留标记 ${name}（pid=${info.pid ?? "?"}, at=${new Date(info.at).toISOString()}${dead === false ? ", 进程已死" : ", 已超时"}）`);
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
 * 已有环境(包括手动 npx 装过)直接跳过。返回 true=已就绪。 */
function ensureRuntime(relayDir) {
  if (existsSync(join(relayDir, "dsh-setup.mjs"))) return true;
  const marker = join(relayDir, PROVISION_MARKER);
  if (existsSync(marker)) return false; // 正在安装中
  try {
    mkdirSync(relayDir, { recursive: true });
    const log = join(relayDir, AUTO_INSTALL_LOG);
    const child = spawn(npxCommand(), ["--yes", "@mrrisega/dsh-remote"], {
      detached: true,
      env: spawnEnv(),
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
      console.warn(`[dsh-remote-ui] 自动安装子进程启动失败: ${e.message}`);
    });
    child.unref();
    console.log(`[dsh-remote-ui] 检测到缺少桌面运行环境,已在后台自动安装(日志: ${log}),完成后将自动启动 bridge`);
    return false;
  } catch (e) {
    console.warn(`[dsh-remote-ui] 自动安装启动失败: ${e.message}`);
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

// ---------- v2 账号/配额/邀请代理（我的信息 与 免费额度提示） ----------

/** 获取短期 relay token:SaaS → device-login;本地模式 → /_login(从隧道地址推导同源)。 */
async function relayToken(relayDir) {
  const cfg = loadConfig(relayDir);
  const api = (cfg.api_url || DEFAULT_API).replace(/\/+$/, "");
  if (cfg.local_key) {
    // 本地认证:POST {tunnel 同源}/_login
    const u = new URL(cfg.tunnel_url || api.replace(/^https?/, "wss"));
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "/_login";
    const r = await fetch(u.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: cfg.local_key }),
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return "";
    const d = await r.json();
    return d.token || "";
  }
  if (!cfg.phone || !cfg.password) return "";
  const r = await fetch(`${api}/api/device-login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.bridge_secret ? { "x-dsh-bridge-secret": cfg.bridge_secret } : {}) },
    body: JSON.stringify({ phone: cfg.phone, email: cfg.phone, password: cfg.password }),
    signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) return "";
  const d = await r.json();
  return d.token || "";
}

/** 我的信息:SaaS 账号的生效套餐/到期日/邀请码(经 /api/me)。 */
async function relayAccount(relayDir) {
  const token = await relayToken(relayDir);
  if (!token) return null;
  const r = await relayFetch(relayDir, "/api/me", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok || !r.body || !r.body.user) return null;
  const u = r.body.user;
  return {
    phone: u.phone || "",
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

// ---------- 综合状态 ----------

async function composeStatus(relayDir) {
  const cfg = loadConfig(relayDir);
  const launchd = launchdStatus();
  const manual = manualStatus();
  // 远程地址（public-config 的 app_url，取不到用默认）
  const pub = await relayFetch(relayDir, "/api/public-config");
  const pubBody = pub.ok && pub.body && typeof pub.body === "object" ? pub.body : {};
  const remoteUrl = pubBody.app_url || DEFAULT_APP_URL;
  const apiUrl = pubBody.api_url || cfg.api_url || DEFAULT_API;
  return {
    ok: true,
    config: {
      phone: cfg.phone || "",
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
    },
    host: hostname(),
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
    "x-dsh-client": "dsh-remote-ui/0.1.0",
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

/** 插件自身发布版本（与 dsh-remote 根包同步递增）。 */
const PLUGIN_VERSION = "0.4.5";
const UPDATE_LOG = ".dsh-update.log";
const UPDATE_MARKER = ".dsh-update-running";

/** 查询 npm 最新版（官方源优先，失败回退 npmmirror；纯服务端无 CORS 限制）。 */
async function npmLatestVersion() {
  for (const reg of ["https://registry.npmjs.org/@mrrisega/dsh-remote", "https://registry.npmmirror.com/@mrrisega/dsh-remote"]) {
    try {
      const res = await fetch(reg, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j["dist-tags"] && typeof j["dist-tags"].latest === "string") return j["dist-tags"].latest;
    } catch { /* 试下一个源 */ }
  }
  return "";
}

/** 以 detached 子进程执行 `npx --yes @mrrisega/dsh-remote@latest`（env 可覆盖 npm 源）。 */
function spawnUpdater(relayDir, extraEnv) {
  const log = join(relayDir, UPDATE_LOG);
  return spawn(npxCommand(), ["--yes", "@mrrisega/dsh-remote@latest"], {
    detached: true,
    cwd: homedir(),
    env: spawnEnv(extraEnv), // PATH 补 node 目录：App 最小 PATH 下也能跑 npx
    stdio: ["ignore", openSync(log, "a"), openSync(log, "a")]
  });
}

/**
 * 后台执行在线一键更新：npx @mrrisega/dsh-remote@latest（幂等自愈：补运行环境/更新 bridge/重写 include）。
 * 稳健性：
 *   - npx 用绝对路径 + PATH 补全解析（App 拉起的 dsh web PATH 最小化时不再 ENOENT 静默失败）；
 *   - 默认 npx 源（国内常为 npmmirror）未同步到最新版导致失败时，自动用官方 npm 源重试一次；
 *   - marker 记录 pid，子进程退出/出错即清理；宿主重启后由 sweepStaleMarkers 立即清掉死进程残留。
 */
function runOnlineUpdate(relayDir) {
  try {
    mkdirSync(relayDir, { recursive: true });
    const marker = join(relayDir, UPDATE_MARKER);
    if (existsSync(marker)) return { ok: false, detail: "已有更新在进行中，请稍候" };
    appendLogLine(relayDir, UPDATE_LOG, `[update] 开始在线更新 @mrrisega/dsh-remote@latest (${new Date().toISOString()})`);

    let retried = false;
    const clear = () => { try { rmSync(marker, { force: true }); } catch { /* ignore */ } };
    const run = () => {
      const child = spawnUpdater(relayDir, retried ? { npm_config_registry: "https://registry.npmjs.org" } : {});
      writeMarker(marker, child.pid);
      child.on("exit", (code) => {
        if (!retried && code !== 0) {
          retried = true;
          appendLogLine(relayDir, UPDATE_LOG, `[update] 默认源安装失败(exit=${code})，改用官方 npm 源重试…`);
          run();
          return;
        }
        appendLogLine(relayDir, UPDATE_LOG, `[update] npx 退出 code=${code ?? "?"}（默认源${retried ? "/官方源" : ""}）`);
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

/** 彻底卸载（兼容市场“拒绝改写用户补丁”的场景）：移除 include、依赖、bundle、本地目录与链接。 */
function uninstallSelf(relayDir, profileDir, patchFile, pkgFile) {
  const out = { removedPatch: false, removedDep: false, removedDir: false, removedBundle: false };
  try {
    const patch = readFileSync(patchFile, "utf8");
    const cleaned = patch
      .replace(/\n?# >>> dsh-remote-ui .*?# <<< dsh-remote-ui\s*/s, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n";
    if (cleaned !== patch) { writeFileSync(patchFile, cleaned); out.removedPatch = true; }
  } catch { /* 无 patch 忽略 */ }
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    if (pkg.dependencies && pkg.dependencies["dsh-remote-ui"]) { delete pkg.dependencies["dsh-remote-ui"]; out.removedDep = true; }
    const bundles = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null;
    if (bundles) {
      const i = bundles.indexOf("dsh-remote-ui");
      if (i >= 0) { bundles.splice(i, 1); out.removedBundle = true; }
    }
    if (out.removedDep || out.removedBundle) writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  } catch { /* 无 package.json 忽略 */ }
  try {
    rmSync(join(profileDir, "dsh-remote-ui-plugin"), { recursive: true, force: true });
    rmSync(join(profileDir, "node_modules", "dsh-remote-ui"), { recursive: true, force: true });
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
    // 依次尝试两种安装布局；split()[0] 未命中时返回原串，需显式判断后再试下一种
    let m = here.split("/dsh-remote-ui-plugin/")[0];
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
        const r = uninstallSelf(relayDir, profileDir, join(profileDir, "cordis.patch.yml"), join(profileDir, "package.json"));
        sendJson(res, 200, { ok: true, ...r, detail: "已移除插件引用与本地文件，重启 dsh web 后完全卸载生效" });
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
        const phone = String(body.phone ?? "").trim();
        if (!phone) return sendJson(res, 400, { ok: false, error: "手机号必填" });
        const r = await relayFetch(relayDir, "/api/sms-code", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone, ...(body.captcha_id !== undefined ? { captcha_id: String(body.captcha_id), captcha_answer: String(body.captcha_answer ?? "") } : {}) }),
        });
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
          phone: cfg.phone || "",
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
          ctx.logger?.warn?.(`dsh-remote-ui: ${route.method} ${route.path} failed: ${e?.stack || e}`);
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
  // 清理上次进程残留的安装/更新 marker（宿主被重启/强杀时子进程清理回调会丢失）
  sweepStaleMarkers(relayDir);
  ctx.effect(() => registerRoutes(ctx, relayDir), "dsh-remote-ui: /dsh-remote routes");
  // 0.1.2-rc.1+ 浏览器会话代持：换取 Harness 会话 Cookie 供 bridge 上游携带（手机点设备不再 401 白页）
  ctx.effect(() => scheduleHarnessMint(ctx, relayDir), "dsh-remote-ui: harness browser-session mint");
  // 插件市场一键全功能:缺桌面运行环境则自动安装,登录后自动拉起 bridge(不依赖用户跑 npx)
  ctx.effect(() => scheduleRuntime(relayDir), "dsh-remote-ui: runtime self-provision");
  ctx.logger?.info?.(`dsh-remote-ui: /dsh-remote routes ready (relayDir=${relayDir})`);
}

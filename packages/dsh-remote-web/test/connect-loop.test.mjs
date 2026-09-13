// 「登录后自动闭环」回归（node 半，0.6.4）。
//
// 现场（2026-09 生产数据，id 42~52 共 11 个真实注册用户）：只有 3 人最终绑定了设备，其余 8 人的
// 电脑端 bridge 从未连上过中继；多人反复点「生成访问链接」（auth.key_create 10~23 次）而
// device.bind 始终为 0。典型路径：注册 → 手机端 /api/devices 拿到空列表 → 反复轮询 → 放弃。
//
// 缺口是「登录 → 设备已在中继注册成功」这条链路既不可见也不自动。本用例锁死：
//   ① 零操作闭环：GET /dsh-remote/bridge-status 在返回前自动补装运行环境 / 拉起 bridge（带退避）；
//   ② 阶段可查询且区分「进程在跑(starting)」与「已注册到中继(online)」——后者才是「能用了」；
//   ③ 中继注册判据三层：bridge 状态文件 > 日志(✅ router 注册成功) > 账号设备表(GET /api/devices)；
//   ④ 失败不留死胡同：崩溃循环/卡死安装 → error + retryable + 可复制的诊断信息，POST /connect/retry
//      清退避立刻重试；
//   ⑤ 安装信息上报：登录后 POST /api/install-report（Bearer + install_source/version/host_*）；
//   ⑥ 注册来源透传：/dsh-remote/register 全量透传 body（reg_source 等字段不丢）。
//
// 走真实分支（unset DSH_RELAY_SKIP_SERVICE），但 PATH 上的 launchctl/pgrep/ps/npx 全是假命令，
// 绝不碰本机真实服务（与 runtime-provision.test.mjs 同一手法）。
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "secret-connect-1";

/** 轮询等待条件成立（避免固定 sleep 在并行/高负载下假失败）。 */
async function waitFor(fn, { timeout = 4000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 假 launchctl：记录调用，并按环境变量回放 print/list（与真机输出同构）。 */
const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
case "$1" in
  print)
    printf 'state = %s\\n' "$DSH_TEST_STATE"
    printf 'pid = %s\\n' "$DSH_TEST_PID"
    printf 'runs = %s\\n' "$DSH_TEST_RUNS"
    printf 'last exit code = %s\\n' "$DSH_TEST_EXIT"
    ;;
  list)
    printf '%s\\n' "$DSH_TEST_LIST"
    ;;
esac
exit 0
`;
/** 假 pgrep：$DSH_TEST_PGREP 有值就回放（模拟「bridge 进程在跑」）。 */
const FAKE_PGREP = `#!/bin/sh
if [ -n "$DSH_TEST_PGREP" ]; then printf '%s\\n' "$DSH_TEST_PGREP"; exit 0; fi
exit 1
`;
const FAKE_PS = `#!/bin/sh
printf '1\\n'
exit 0
`;
/** 假 npx：只记录参数，绝不做真实安装。 */
const FAKE_NPX = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_NPX_LOG"
exit 0
`;

/** 假账号 API：public-config / device-login / devices / install-report / register。 */
function startFakeRelay(opts = {}) {
  const seen = [];
  const devices = { list: opts.devices === undefined ? [] : opts.devices };
  const installReports = [];
  let mobileSessionsStatus = 200;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
    }
    seen.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization || "", body });
    if (req.method === "GET" && url.pathname === "/api/public-config") {
      return send(200, { service: "dsh-remote", app_url: "https://app.test/", api_url: `http://127.0.0.1:${srv.address().port}`, bridge_secret: SECRET });
    }
    if (req.method === "POST" && url.pathname === "/api/device-login") {
      if ((req.headers["x-dsh-bridge-secret"] || "") !== SECRET) return send(401, { error: { code: "unauthorized", message: "需要有效设备密钥" } });
      return send(200, { token: "jwt-connect" });
    }
    if (req.method === "GET" && url.pathname === "/api/devices") {
      if (!(req.headers.authorization || "").startsWith("Bearer ")) return send(401, { error: { code: "invalid_token" } });
      return send(200, { devices: devices.list });
    }
    if (req.method === "POST" && url.pathname === "/api/install-report") {
      installReports.push({ authorization: req.headers.authorization || "", body });
      if (opts.installReportStatus && opts.installReportStatus !== 200) return send(opts.installReportStatus, { error: { code: "nope" } });
      return send(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/mobile-sessions") {
      if (mobileSessionsStatus !== 200) return send(mobileSessionsStatus, { error: { code: "invalid_token", message: "无效或过期的 token" } });
      return send(200, { ok: true, sessions: [] });
    }
    if (req.method === "POST" && url.pathname === "/api/register") return send(201, { ok: true, token: "jwt-reg" });
    return send(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    srv, seen, installReports, port: srv.address().port,
    setDevices(list) { devices.list = list; },
    setMobileSessionsStatus(s) { mobileSessionsStatus = s; },
    count(p) { return seen.filter((s) => s.path === p).length; },
  })));
}

/**
 * 隔离环境：假 HOME（plist 落这里）+ 假 launchctl/pgrep/ps/npx + 临时 relayDir。
 * runtime=false 时不预置 dsh-setup.mjs（模拟「插件市场只装了面板插件」）。
 */
async function setup({ runtime = true, state = "stopped", pid = "0", runs = 0, exitCode = 0, pgrep = "" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-connect-"));
  const fakeHome = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  const launchLog = path.join(root, "launchctl.log");
  const npxLog = path.join(root, "npx.log");
  await writeFile(launchLog, "");
  await writeFile(npxLog, "");
  for (const [name, script] of [["launchctl", FAKE_LAUNCHCTL], ["pgrep", FAKE_PGREP], ["ps", FAKE_PS], ["npx", FAKE_NPX]]) {
    await writeFile(path.join(fakeBin, name), script);
    await chmodSync(path.join(fakeBin, name), 0o755);
  }
  if (runtime) await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub");

  const saved = {};
  for (const k of ["HOME", "PATH", "DSH_TEST_LAUNCH_LOG", "DSH_TEST_NPX_LOG", "DSH_TEST_STATE", "DSH_TEST_PID",
    "DSH_TEST_RUNS", "DSH_TEST_EXIT", "DSH_TEST_LIST", "DSH_TEST_PGREP", "DSH_RELAY_SKIP_SERVICE",
    "DSH_SETUP_NPX_DIR", "DSH_RELAY_SELFHEAL_MS", "DSH_BRIDGE_INSTALL_SOURCE"]) {
    saved[k] = process.env[k];
  }
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = launchLog;
  process.env.DSH_TEST_NPX_LOG = npxLog;
  process.env.DSH_TEST_STATE = state;
  process.env.DSH_TEST_PID = pid;
  process.env.DSH_TEST_RUNS = String(runs);
  process.env.DSH_TEST_EXIT = String(exitCode);
  process.env.DSH_TEST_LIST = "";
  if (pgrep) process.env.DSH_TEST_PGREP = pgrep; else delete process.env.DSH_TEST_PGREP;
  delete process.env.DSH_BRIDGE_INSTALL_SOURCE;
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  delete process.env.DSH_RELAY_SKIP_SERVICE; // 走真实分支，但系统命令全是假的
  process.env.DSH_RELAY_SELFHEAL_MS = "60000"; // 让后台 watcher 不参与用例节奏

  return {
    root, fakeHome, fakeBin, relayDir, launchLog, npxLog,
    plistPath: path.join(fakeHome, "Library", "LaunchAgents", "com.dshremote.bridge.plist"),
    setState(next) { process.env.DSH_TEST_STATE = next; },
    setPgrep(v) { if (v) process.env.DSH_TEST_PGREP = v; else delete process.env.DSH_TEST_PGREP; },
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 装载插件路由（收集 disposer：否则自愈定时器会跨用例继续跑）。 */
function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  const logs = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info(m) { logs.push(String(m)); }, warn(m) { logs.push(String(m)); } },
  }, { relayDir });
  routes.logs = logs;
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

async function writeConfig(relayDir, relayPort, extra = {}) {
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", device_id: "dev-connect",
    api_url: `http://127.0.0.1:${relayPort}`, bridge_secret: SECRET,
    ...extra,
  }));
}

const readOrEmpty = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };
const bridgeStatus = async (base) => (await (await fetch(`${base}/dsh-remote/bridge-status`)).json());

test("未登录：不补装、不拉服务，阶段=no_account（先引导登录，而不是空转）", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: false });
  try {
    await writeConfig(env.relayDir, relay.port, { phone: "", password: "" });
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.equal(r.ok, true);
      assert.equal(r.connect.phase, "no_account");
      assert.equal(r.connect.retryable, false, "未登录不是错误，不该出现重试入口");
      assert.match(r.connect.text, /请先登录/);
      // 未登录不得做任何「服务级」动作（拉起 bridge / launchctl 变更）——运行环境补装是插件加载即开始的，
      // 与登录无关（0.6.2 起的既有行为），这里只锁「登录态才拉服务」这条边界。
      // （launchctl print 只是状态查询，允许出现。）
      const launchLog = await readOrEmpty(env.launchLog);
      assert.ok(!/bootstrap|bootout|kickstart|unload/.test(launchLog), "未登录不得触发服务启停，实际：" + launchLog);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("缺运行环境：/bridge-status 自动后台补装，阶段=no_runtime/installing 且写下 plugin_market 记录", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: false }); // 市场只装了面板插件：没有 dsh-setup.mjs
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.ok(["no_runtime", "installing"].includes(r.connect.phase), "阶段应为缺环境/安装中，实际 " + r.connect.phase);
      assert.equal(r.connect.runtimeReady, false);
      assert.match(r.connect.text, /正在准备运行环境/, "文案要面向非技术用户说明在准备运行环境");
      assert.ok(await waitFor(async () => (await readOrEmpty(env.npxLog)).includes("@mrrisega/dsh-remote")), "应后台触发一次 npx 补装");
      assert.ok(existsSync(path.join(env.relayDir, ".dsh-provisioned-by-plugin")), "应记录「本机运行环境由插件自愈补装」→ install_source=plugin_market");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("运行环境就绪但服务没起：轮询自动 bootstrap（零操作），阶段=starting", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: true, state: "stopped" });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "starting");
      assert.match(r.connect.text, /正在启动 Bridge/);
      const log = await readOrEmpty(env.launchLog);
      assert.match(log, /bootstrap/, "应自动拉起 bridge（launchctl bootstrap），实际：" + log);
      const plist = await readOrEmpty(env.plistPath);
      assert.match(plist, /DSH_BRIDGE_INSTALL_VERSION/, "plist 应带安装版本（bridge 随设备登记上报）");
      assert.match(plist, /DSH_BRIDGE_INSTALL_SOURCE/, "plist 应带安装来源");
      assert.equal(r.connect.registered, false, "进程刚起时不能谎报「已注册」");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("进程在跑但账号还没这台设备：阶段=connecting（进程在跑 ≠ 能用）", async () => {
  const relay = await startFakeRelay({ devices: [] });
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "connecting");
      assert.equal(r.connect.bridgeRunning, true, "bridge 进程在跑");
      assert.equal(r.connect.registered, false, "但设备尚未注册到中继 → 不能显示「已连接」");
      assert.match(r.connect.text, /正在连接中继/);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("设备已登记到账号（手机端能看到）：阶段=online，且 /status 里也带同一份 connect", async () => {
  const relay = await startFakeRelay({ devices: [{ id: "dev-connect", device_name: "mbp", online: true }] });
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "online", "设备已在账号设备表 → 手机端可见即可用");
      assert.equal(r.connect.registered, true);
      assert.equal(r.connect.registerSource, "account_api");
      assert.match(r.connect.text, /已连接 ✅ 现在可以用手机扫码访问/);
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.connect.phase, "online", "/status 也应下发连接阶段（面板 30s 轮询同样能刷新）");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("bridge 日志显示已注册到中继：直接 online，且不再打账号设备表（省审计/请求）", async () => {
  const relay = await startFakeRelay({ devices: [] });
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    await writeFile(path.join(env.relayDir, ".dsh-bridge.log"),
      "[dsh-remote] dsh web 在线，启动 bridge...\n[bridge] 隧道已连 wss://relay.test/_bridge,注册 dev-connect...\n[bridge] ✅ router 注册成功: dev-connect,等待手机访问 /remote/dev-connect/\n");
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "online");
      assert.equal(r.connect.registerSource, "tunnel");
      assert.equal(relay.count("/api/devices"), 0, "有日志证据时不必再探账号设备表");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("启动崩溃循环：阶段=error + 可重试 + 诊断信息齐全；POST /connect/retry 清退避立刻再试", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: true, state: "spawn scheduled", runs: 23, exitCode: 1 });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "error");
      assert.equal(r.connect.retryable, true, "崩溃循环必须可重试，不能是死胡同");
      assert.equal(r.connect.error.code, "launchd_crash");
      assert.match(r.connect.error.message, /反复启动失败/);
      const diag = r.connect.diagnostics;
      for (const key of ["插件版本", "配置目录", "连接阶段", "运行环境", "最近错误", "bridge 日志", env.relayDir]) {
        assert.ok(diag.includes(key), `诊断信息应包含「${key}」，实际：\n${diag}`);
      }
      assert.equal(r.connect.attempts, 1, "已经自动尝试过一次（拉起 bridge）");
      const before = (await readOrEmpty(env.launchLog)).split("\n").filter((l) => l.includes("bootstrap")).length;

      const retried = await (await fetch(`${base}/dsh-remote/connect/retry`, { method: "POST" })).json();
      assert.equal(retried.ok, true);
      assert.equal(retried.connect.attempts, 1, "手动重试应清掉退避计数后重新计数（1=本次重试）");
      const after = (await readOrEmpty(env.launchLog)).split("\n").filter((l) => l.includes("bootstrap")).length;
      assert.ok(after > before, `「重试」按钮应真的再拉起一次（bootstrap ${before} → ${after}）`);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("安装卡死（标记超时/进程已死）：/status 如实报 error，短轮询随即清掉标记重新补装（不留死胡同）", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: false });
  try {
    process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 隔离模式：ensureRuntime 不 spawn 真实 npx，便于稳定观察标记清理
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      // 上次安装的残留标记：进程早已不存在（pid=999999）+ 超时（20 分钟前）
      const marker = path.join(env.relayDir, ".dsh-setup-installing");
      await writeFile(marker, JSON.stringify({ pid: 999999, at: Date.now() - 20 * 60 * 1000 }));
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.connect.phase, "error", "/status 如实反映卡死，而不是一直显示「安装中」骗用户");
      assert.equal(st.connect.error.code, "install_stuck");
      assert.equal(st.connect.retryable, true);
      assert.match(st.connect.detail, /清理|重新安装/);

      // 短轮询端点带回自愈：清掉卡死标记 → 重新进入补装流程（下轮就会重新 npx）
      const r = await bridgeStatus(base);
      assert.equal(existsSync(marker), false, "卡死标记应被清掉，否则自动补装被永久挡住");
      assert.ok(["no_runtime", "installing"].includes(r.connect.phase), "实际 " + r.connect.phase);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("登录后上报安装信息：install_source=plugin_market/npx + version/os/arch，Bearer 走 device-login JWT", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port, { phone: "", password: "" }); // 先未登录
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const noAuth = await (await fetch(`${base}/dsh-remote/bridge-status`)).json();
      assert.equal(noAuth.connect.phase, "no_account");
      assert.equal(relay.count("/api/install-report"), 0, "没有账号凭据时不得上报");

      // 面板内登录成功（POST /dsh-remote/config）→ 立刻上报
      const cfg = await (await fetch(`${base}/dsh-remote/config`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "13800000000", password: "pw" }),
      })).json();
      assert.equal(cfg.ok, true);
      assert.ok(await waitFor(() => relay.installReports.length === 1), "登录后应上报一次安装信息");
      const rep = relay.installReports[0];
      assert.equal(rep.authorization, "Bearer jwt-connect", "必须带 device-login JWT");
      assert.equal(rep.body.install_source, "npx", "有运行环境且非插件自愈 → 安装器部署(npx)");
      assert.equal(rep.body.install_version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
      assert.equal(rep.body.host_os, process.platform);
      assert.equal(rep.body.host_arch, process.arch);
      // device_id 可选（契约 {device_id?, ...}）：换账号时本机 device_id 会被重新生成，此时不上报
      assert.ok(!("device_id" in rep.body) || /^dev-/.test(String(rep.body.device_id)));
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("插件自愈补装的机器：install_source 记成 plugin_market（区分「市场安装」与「安装器 npx」）", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    await writeFile(path.join(env.relayDir, ".dsh-provisioned-by-plugin"), JSON.stringify({ at: Date.now(), source: "plugin_market" }));
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      await fetch(`${base}/dsh-remote/config`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "13800000000", password: "pw" }),
      });
      assert.ok(await waitFor(() => relay.installReports.length >= 1), "应上报安装信息");
      assert.equal(relay.installReports[0].body.install_source, "plugin_market");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("老服务端没有 /api/install-report（404）：静默忽略，绝不影响面板", async () => {
  const relay = await startFakeRelay({ installReportStatus: 404 });
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const cfg = await (await fetch(`${base}/dsh-remote/config`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "13800000000", password: "pw" }),
      })).json();
      assert.equal(cfg.ok, true, "上报失败不得影响登录响应");
      // 404 = 老服务端没有该接口 → 静默忽略（不写去重标记，于是启动时那次 + 登录这次都会尝试）
      assert.ok(await waitFor(() => relay.count("/api/install-report") >= 1), "应真的尝试过一次上报");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("连接轮询不放大认证：多次 /bridge-status + /status 只打一次 device-login（60s token 缓存 + 并发合并）", async () => {
  const relay = await startFakeRelay({ devices: [{ id: "dev-connect", device_name: "mbp" }] });
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      for (let i = 0; i < 3; i++) await bridgeStatus(base);
      await fetch(`${base}/dsh-remote/status`);
      await fetch(`${base}/dsh-remote/status`);
      assert.equal(relay.count("/api/device-login"), 1, "认证接口只应被调用一次（面板每 2~3s 轮询一次状态，绝不能每次都认证）");
      const last = await bridgeStatus(base);
      assert.equal(last.connect.phase, "online", "缓存命中不影响阶段判定");
      assert.equal(relay.count("/api/device-login"), 1, "后续轮询仍复用缓存 token");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("JWT 被企业端拒绝（401）：token 缓存立即失效，下一次轮询重新认证（不会一直拿坏 token 撞墙）", async () => {
  const relay = await startFakeRelay({ devices: [] });
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      await bridgeStatus(base);
      const before = relay.count("/api/device-login");
      assert.ok(before >= 1, "首次轮询应完成一次认证");

      relay.setMobileSessionsStatus(401); // 企业端拒绝当前 JWT（过期/轮换）
      await fetch(`${base}/dsh-remote/mobile-sessions`);
      relay.setMobileSessionsStatus(200);

      await bridgeStatus(base);
      assert.ok(relay.count("/api/device-login") > before, "401 之后必须重新认证，而不是继续用坏 token");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("注册来源透传：/dsh-remote/register 全量转发 body（reg_source=panel_register 等字段不丢）", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: true, state: "running", pid: String(process.pid) });
  try {
    await writeConfig(env.relayDir, relay.port, { phone: "", password: "" });
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: "13800000000", sms_code: "218937", password: "password123",
          reg_source: "panel_register", invite_code: "A8K2M4XQ",
          captcha_id: "cap-1", captcha_answer: "1234",
        }),
      })).json();
      assert.equal(r.ok, true);
      const reg = relay.seen.filter((s) => s.path === "/api/register").pop();
      assert.ok(reg, "应转发到企业端 /api/register");
      assert.equal(reg.body.reg_source, "panel_register", "注册来源必须透传（增长口径）");
      assert.equal(reg.body.invite_code, "A8K2M4XQ", "未知/扩展字段不得被丢弃");
      assert.equal(reg.body.captcha_id, "cap-1");
      assert.equal(reg.body.captcha_answer, "1234");
      assert.equal(reg.body.sms_code, "218937");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

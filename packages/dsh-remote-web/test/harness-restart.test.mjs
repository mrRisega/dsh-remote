// 「插件装载 / 刷新 / 重启」回归（0.6.2 新增，0.6.4-beta.9 语义修订）。
//
// 产品诉求（用户原话）：
//   1. 安装完成后桌面端 UI 直接可用；
//   2. 常驻入口最底下要有「重启 dsh web」按钮（排查用，始终可达）；
//   3. 需要用户动一下时，该提示要出现在上方显眼位置。
//
// ⚠️ 0.6.4-beta.9 语义修订（用户反馈「能热加载了，这个设置窗口就不需要了」）：
//   插件已改为 profile patch **热加载**装载（HMR 监听 cordis.patch.yml，存盘约 1 秒生效），
//   运行环境(bridge)又是独立 launchd 进程 —— 所以「装插件 / 在线更新完成」都**不再需要重启
//   DeepSeek harness**，那条横幅确实是误导。现在只在一种情形提示用户：
//   **磁盘上的插件文件比当前进程新**（= 运行中被市场安装/在线更新改写），文案是
//   「插件已更新，刷新页面即可生效」，并且**不自动重启**（刷新零风险，重启会打断用户会话）。
//
// 机制：dsh web 的插件（宿主半 + 浏览器半）都在**进程启动时**装载，市场安装/在线更新只是把文件
// 写进 profile，当前进程里既没有 /dsh-remote/* 路由也没有面板入口 → 必须重启才生效。
// 因此插件需要：① 持久化「待重启」状态并跨进程结清；② 一条可靠的重启实现（优先交回监管者，
// 否则用原命令行自拉起）；③ 面板顶部醒目提示 + 底部常驻按钮。
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { apply } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readOrEmpty = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };

/** 轮询等待条件成立（固定 sleep 在整包并行/高负载下会假失败）。 */
async function waitFor(fn, { timeout = 4000, step = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 假 launchctl：list 可回放指定 pid/label，print 报未运行（避免任何真实系统状态影响用例）。 */
const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
if [ "$1" = list ]; then printf '%s\\n' "$DSH_TEST_LIST"; fi
if [ "$1" = print ]; then printf 'state = not running\\n'; fi
exit 0
`;

async function setup({ list = "" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-restart-"));
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  await writeFile(path.join(fakeBin, "launchctl"), FAKE_LAUNCHCTL);
  await chmodSync(path.join(fakeBin, "launchctl"), 0o755);
  for (const n of ["pgrep", "ps"]) { await writeFile(path.join(fakeBin, n), "#!/bin/sh\nexit 0\n"); await chmodSync(path.join(fakeBin, n), 0o755); }
  await writeFile(path.join(fakeBin, "npx"), "#!/bin/sh\nexit 0\n"); await chmodSync(path.join(fakeBin, "npx"), 0o755);

  const saved = {};
  for (const k of ["HOME", "PATH", "DSH_TEST_LAUNCH_LOG", "DSH_TEST_LIST", "DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_SELFHEAL_MS",
    "DSH_RELAY_RESTART_DRYRUN", "DSH_SETUP_NPX_DIR"]) saved[k] = process.env[k];
  // HOME 必须一起伪造：本用例会 unset DSH_RELAY_SKIP_SERVICE 去走真实分支，
  // 而插件的自启动 plist 路径写作 join(homedir(), "Library/LaunchAgents/…")。
  // 不伪造 HOME 就会把**指向测试临时目录**的 plist 覆盖到开发者真实的
  // ~/Library/LaunchAgents/com.dshremote.bridge.plist（实测污染，且临时目录随即被删 →
  // 真实 bridge 自启动彻底失效）。这是测试对开发者机器的破坏，必须隔离。
  const fakeHome = path.join(root, "home");
  await mkdir(path.join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = path.join(root, "launchctl.log");
  process.env.DSH_TEST_LIST = list;
  process.env.DSH_RELAY_SELFHEAL_MS = "5000";
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  delete process.env.DSH_RELAY_SKIP_SERVICE;
  return {
    root, relayDir,
    stateFile: path.join(relayDir, ".dsh-restart-state.json"),
    async restore() {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeConfig(relayDir, extra = {}) {
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", api_url: "http://127.0.0.1:1", ...extra,
  }));
}

function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
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

// ─────────────────────────── 宿主半：状态机 ───────────────────────────

test("首次安装（运行环境在本进程内补齐）→ **不再**提示重启 harness（热加载后已无必要）", async () => {
  const env = await setup();
  try {
    await writeConfig(env.relayDir);
    // 市场刚装完：桌面运行环境还没补齐
    assert.equal(existsSync(path.join(env.relayDir, "dsh-setup.mjs")), false);
    process.env.DSH_RELAY_SELFHEAL_MS = "200";
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const before = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(before.restart.pending, false, "运行环境补齐前不该有提示");

      // 模拟后台 npx 安装完成：固化运行时落盘
      await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
      await sleep(400); // 给自愈调度一轮时间(以前这一轮会 markRestartPending)

      const after = await (await fetch(`${base}/dsh-remote/status`)).json();
      // bridge 是独立 launchd 进程、插件走 patch 热加载 → 补齐运行环境不需要重启 harness。
      // 旧行为(提示"首次安装需要重启 DeepSeek harness")已被用户实测判定为误导,故断言必须为 false。
      assert.equal(after.restart.pending, false,
        "运行环境补齐**不该**再提示重启 harness（热加载 + 独立 bridge 进程）");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

test("补装把**同版本**插件重写一遍 → 不得提示（用户实测的误报）", async () => {
  // 事故复盘:安装器/自愈补装会把 profile 副本整目录重写,即使是**同一个版本**。
  // 旧实现只看"插件文件 mtime 晚于进程启动"→ 误判成"有新插件要装载"→ 弹出需要重启/刷新的横幅,
  // 而用户刷新后横幅还在(因为第二次补装又写了一遍)、最后靠重启才消失。
  // 现在判的是「磁盘版本 != 运行版本」,版本相同就什么都不提示。
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function pluginInstalledAfterBoot("), src.indexOf("/** 本进程的启动命令"));
  assert.match(fn, /diskVersion !== runningVersion/, "必须比较版本,而不是只看时间戳");
  assert.match(fn, /PLUGIN_VERSION/, "必须用本进程装载的版本号做比较");
});

test("插件文件晚于本进程启动 → 提示「刷新页面」，且**不**自动重启", async () => {
  const env = await setup();
  try {
    await writeConfig(env.relayDir);
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const cur = await (await fetch(`${base}/dsh-remote/status`)).json();
      // 用**真实的 bootId** 写回状态:否则 settleRestartState 会判定"这是上个进程写的 = 已重启过"
      // 而把提示结清(那样就测不到"同进程内保留提示"这条语义了)。
      await writeFile(env.stateFile, JSON.stringify({
        pending: true, kind: "refresh", reason: "插件已更新，刷新页面即可生效",
        at: Date.now() - 3000, bootId: cur.restart.bootId
      }));

      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.restart.pending, true, "插件被运行时改写 → 应提示");
      assert.equal(st.restart.kind, "refresh", "kind 必须是 refresh（刷新语义，不是重启）");
      assert.match(String(st.restart.reason), /刷新页面/);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

test("重启已完成（bootId 变化）→ 自动撤下提示；同一进程内不撤", async () => {
  // 场景 A：状态来自「上一个进程」→ 本次装载即视为重启完成 → 撤下
  const a = await setup();
  try {
    await writeConfig(a.relayDir);
    await writeFile(path.join(a.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(a.stateFile, JSON.stringify({ pending: true, kind: "first-install", reason: "首次安装需要重启 DeepSeek harness", at: Date.now() - 60000, bootId: "1-1" }));
    const routes = boot(a.relayDir);
    const { host, base } = await serve(routes);
    try {
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.restart.pending, false, "新进程装载 = 重启已发生 → 提示应消失");
      assert.ok(JSON.parse(readFileSync(a.stateFile, "utf8")).lastRestartedAt > 0, "应记录最近一次重启时间");
    } finally { host.close(); routes.dispose(); }
  } finally { await a.restore(); }

  // 场景 B：settleRestartState **只在 bootId 变化时**才结清提示。
  // 用"不存在的 bootId"来验证同一条语义：状态存在、且 bootId 与当前进程不同 → 必被结清；
  // 反过来（bootId 相同）保留 —— 后者不依赖任何真实进程时长，避免时序脆弱。
  // 之前这里自己按 `pid-uptime` 公式推 bootId，会因进程存活时长的毫秒级漂移偶发不等 → 用例随机失败。
  const b = await setup();
  try {
    await writeConfig(b.relayDir);
    await writeFile(path.join(b.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(b.stateFile, JSON.stringify({
      pending: true, kind: "refresh", reason: "插件已更新，刷新页面即可生效",
      at: Date.now() - 3000, bootId: "999999-1" // 一定不是本进程
    }));
    const routes = boot(b.relayDir);
    const { host, base } = await serve(routes);
    try {
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.restart.pending, false, "bootId 不同 = 已经重启过 → 提示必须结清");
      assert.ok(JSON.parse(readFileSync(b.stateFile, "utf8")).lastRestartedAt > 0, "应记录结清时间");
    } finally { host.close(); routes.dispose(); }
  } finally { await b.restore(); }
});

// ─────────────────────────── 宿主半：重启实现 ───────────────────────────

test("重启实现：无监管者 → 用原命令行自拉起（脚本含 pid/argv/cwd，先 TERM 再 KILL）", async () => {
  const env = await setup({ list: "999\t0\tcom.example.unrelated" }); // list 里没有我们的 pid → 无监管者
  try {
    await writeConfig(env.relayDir);
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    process.env.DSH_RELAY_RESTART_DRYRUN = "1"; // 只生成脚本，不真重启
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const body = await (await fetch(`${base}/dsh-remote/harness/restart`, { method: "POST" })).json();
      assert.equal(body.ok, true);
      assert.equal(body.status, "dry-run");
      assert.equal(body.mode, "relaunch", "没有监管者时应自拉起");
      assert.ok(body.script.includes(`kill -TERM ${process.pid}`), "应先优雅退出旧进程");
      assert.ok(body.script.includes("kill -KILL"), "超时后应强杀");
      assert.ok(body.script.includes(process.execPath), "应复用同一条命令行（node 路径）");
      assert.ok(body.script.includes(process.argv[1]), "应复用同一个 dsh 入口");
      assert.ok(body.script.includes(`cd '${process.cwd()}'`), "应保持工作目录");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

test("重启实现：被 launchd 托管 → 交回监管者（kickstart -k，pid 精确匹配，不误伤别的服务）", async () => {
  const env = await setup({ list: `${process.pid}\t0\tcom.user.dshweb\n999\t0\tcom.example.unrelated` });
  try {
    await writeConfig(env.relayDir);
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    process.env.DSH_RELAY_RESTART_DRYRUN = "1";
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const body = await (await fetch(`${base}/dsh-remote/harness/restart`, { method: "POST" })).json();
      if (process.platform !== "darwin") {
        assert.equal(body.mode, "relaunch", "非 macOS 不检测 launchd");
      } else {
        assert.equal(body.mode, "launchd");
        assert.equal(body.target, `gui/${process.getuid()}/com.user.dshweb`, "只重启「pid 等于本进程」的那个作业");
        assert.ok(body.script.includes("launchctl kickstart -k"), "应交给 launchd 重启");
        assert.ok(!body.script.includes("com.example.unrelated"), "绝不触碰无关服务");
      }
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

test("测试隔离开关：DSH_RELAY_SKIP_SERVICE=1 → 绝不真实重启", async () => {
  const env = await setup();
  try {
    await writeConfig(env.relayDir);
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const res = await fetch(`${base}/dsh-remote/harness/restart`, { method: "POST" });
      const body = await res.json();
      assert.equal(res.status, 500);
      assert.equal(body.ok, false);
      assert.equal(body.status, "skipped");
      assert.match(String(body.error), /跳过真实重启/);
      assert.equal(existsSync(path.join(env.relayDir, ".dsh-restart-harness.sh")), false, "隔离模式下不得落任何重启脚本");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

// ─────────────────────────── 浏览器半：UI ───────────────────────────

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function walk(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
function find(tree, predicate) { let m; walk(tree, (n) => { if (!m && predicate(n)) m = n; }); return m; }
function findAll(tree, predicate) { const out = []; walk(tree, (n) => { if (predicate(n)) out.push(n); }); return out; }
function textHas(tree, substr) { return !!find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes(substr))); }

/** vm 沙箱加载浏览器半，statusBody 决定面板看到的状态。 */
function loadPlugin(statusBody) {
  let moduleFactory;
  const registered = new Map();
  const requests = [];
  const states = [];
  let hook = 0;
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const index = hook++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (v) => { states[index] = typeof v === "function" ? v(states[index]) : v; }];
    },
    useEffect() {}, useCallback(fn) { return fn; }, useSyncExternalStore(_s, g) { return g(); },
  };
  const response = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  const makeEl = (tag) => ({
    tag, children: [], style: {}, className: "", attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; }, appendChild(c) { this.children.push(c); },
  });
  const doc = { createElement(t) { return makeEl(t); }, head: makeEl("head"), body: makeEl("body"), querySelector() { return null; }, querySelectorAll() { return []; } };
  class MutationObserverMock { observe() {} disconnect() {} }
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } }, open() { return null; }, location: { reload() {} } },
    document: doc,
    localStorage: { _s: new Map(), getItem(k) { return this._s.has(k) ? this._s.get(k) : null; }, setItem(k, v) { this._s.set(k, String(v)); }, removeItem(k) { this._s.delete(k); } },
    MutationObserver: MutationObserverMock,
    navigator: { clipboard: { writeText: async () => {} } },
    location: { reload() {} },
    fetch(p, o = {}) {
      requests.push({ path: p, method: o.method || "GET" });
      if (p === "/dsh-remote/status") return response(200, statusBody);
      return response(200, { ok: true });
    },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; },
    Set, Symbol,
  };
  vm.runInNewContext(SOURCE, sandbox);
  moduleFactory((name) => { assert.equal(name, "react"); return react; })
    .apply({ slots: { inject(_n, cb) { cb(); }, register(meta, component) { registered.set(meta.id, component); return () => {}; } } });
  return { requests, states, render() { hook = 0; return registered.get("dsh-remote")({ close() {} }); } };
}

// 现在唯一会提示用户的状态是 kind=refresh（插件文件被运行时改写 → 刷新页面即可）
const STATUS_REFRESH = {
  ok: true, config: { phone: "13800000000", deviceId: "dev-x" },
  service: { running: true, runtimeReady: true, launchd: {} },
  restart: { pending: true, kind: "refresh", reason: "插件已更新，刷新页面即可生效", at: Date.now() },
};
const STATUS_IDLE = {
  ok: true, config: { phone: "13800000000", deviceId: "dev-x" },
  service: { running: true, runtimeReady: true, launchd: {} },
  restart: { pending: false },
};

test("UI：插件更新后 → 顶部提示「刷新页面即可生效」+ 刷新按钮（不再喊重启 harness）", () => {
  const plugin = loadPlugin({
    ok: true,
    config: { phone: "13800000000", deviceId: "dev-x" },
    service: { running: true, runtimeReady: true, launchd: {} },
    restart: { pending: true, kind: "refresh", reason: "插件已更新，刷新页面即可生效" },
  });
  plugin.states[0] = STATUS_REFRESH; // mock 的 useEffect 不执行 → 直接注入面板状态
  const tree = plugin.render();
  assert.ok(textHas(tree, "插件已更新，刷新页面即可生效"), "顶部应出现刷新提示");
  // 不能再说"需要重启 DeepSeek harness" —— 热加载后那是误导（用户实测反馈）
  assert.ok(!textHas(tree, "需要重启 DeepSeek harness"), "不应再出现「需要重启 DeepSeek harness」");
  const alert = find(tree, (n) => n.props && n.props.className === "dru-restart-alert");
  assert.ok(alert, "应有醒目提示块（dru-restart-alert）");
  // 主按钮应是「刷新页面」
  const refreshBtn = find(tree, (n) => n.props && String(n.props.className || "").includes("dru-btn-primary") &&
    (n.children || []).some((c) => typeof c === "string" && c.includes("刷新页面")));
  assert.ok(refreshBtn, "提示块内主按钮应是「刷新页面」");
  // 重启按钮仍可达（兜底），但不再是主按钮
  assert.ok(textHas(tree, "重启 dsh web"), "应保留「重启 dsh web」作为兜底入口");
});

test("UI：常驻入口最底部始终有「重启 DeepSeek harness」按钮；不需要重启时也不消失", () => {
  const plugin = loadPlugin({
    ok: true,
    config: { phone: "13800000000", deviceId: "dev-x" },
    service: { running: true, runtimeReady: true, launchd: {} },
    restart: { pending: false },
  });
  plugin.states[0] = STATUS_IDLE;
  const tree = plugin.render();
  assert.ok(!textHas(tree, "刷新页面即可生效"), "不需要动作时不该出现顶部提示");
  const foot = find(tree, (n) => n.props && n.props.className === "dru-restart-foot");
  assert.ok(foot, "底部应常驻重启按钮区（dru-restart-foot）");
  assert.ok(textHas(foot, "重启 dsh web"), "常驻区应含重启按钮文案（排查兜底，始终可达）");
});

test("UI：点「重启 dsh web」→ 调用 /dsh-remote/harness/restart", async () => {
  const plugin = loadPlugin({
    ok: true,
    config: { phone: "13800000000", deviceId: "dev-x" },
    service: { running: true, runtimeReady: true, launchd: {} },
    restart: { pending: true, kind: "refresh", reason: "插件已更新，刷新页面即可生效" },
  });
  plugin.states[0] = STATUS_REFRESH;
  const tree = plugin.render();
  // 顶部提示块内的兜底重启按钮（常驻脚注里也有一个）
  const alert = find(tree, (n) => n.props && n.props.className === "dru-restart-alert");
  const btn = find(alert, (n) => n.props && String(n.props.className || "").includes("dru-btn") &&
    (n.children || []).some((c) => typeof c === "string" && c.includes("重启 dsh web")));
  assert.ok(btn, "顶部提示块内应能定位到重启按钮");
  btn.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/harness/restart" && r.method === "POST"),
    "点击后应 POST /dsh-remote/harness/restart，实际 " + JSON.stringify(plugin.requests));
});



// 「首次安装需要重启 DeepSeek harness」回归（0.6.2 新增）。
//
// 产品诉求（用户原话）：
//   1. 安装完成后桌面端 UI 直接可用，并提示「首次安装需要重启 DeepSeek harness」，旁边给「重启」按钮；
//   2. 常驻入口最底下要有「重启 DeepSeek harness」按钮；
//   3. 首次打开（尚未重启）时，该按钮要出现在上方显眼位置。
//
// 机制：dsh web 的插件（宿主半 + 浏览器半）都在**进程启动时**装载，市场安装/在线更新只是把文件
// 写进 profile，当前进程里既没有 /dsh-remote/* 路由也没有面板入口 → 必须重启才生效。
// 因此插件需要：① 持久化「待重启」状态并跨进程结清；② 一条可靠的重启实现（优先交回监管者，
// 否则用原命令行自拉起）；③ 面板顶部醒目提示 + 底部常驻按钮。
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const k of ["PATH", "DSH_TEST_LAUNCH_LOG", "DSH_TEST_LIST", "DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_SELFHEAL_MS",
    "DSH_RELAY_RESTART_DRYRUN", "DSH_SETUP_NPX_DIR"]) saved[k] = process.env[k];
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

test("首次安装（运行环境在本进程内补齐）→ 自动标记「需要重启」并在 /status 下发", async () => {
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
      assert.equal(before.restart.pending, false, "运行环境补齐前不该提示重启");

      // 模拟后台 npx 安装完成：固化运行时落盘
      await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
      await waitFor(async () => readFile(env.stateFile, "utf8").then(() => true).catch(() => false));

      const after = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(after.restart.pending, true, "运行环境刚补齐 → 应提示需要重启 DeepSeek harness");
      assert.equal(after.restart.kind, "first-install");
      assert.match(String(after.restart.reason), /首次安装需要重启 DeepSeek harness/);
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

  // 场景 B：状态由**当前进程**写下（用户还没点重启，只是刷新了页面 / 插件重新装载）→ 必须保留。
  // 走真实链路：插件自己写 pending（运行环境在本进程内补齐），再在同一进程内重新装载一次。
  const b = await setup();
  try {
    await writeConfig(b.relayDir);
    process.env.DSH_RELAY_SELFHEAL_MS = "200";
    const routes1 = boot(b.relayDir);
    const { host: host1, base: base1 } = await serve(routes1);
    await writeFile(path.join(b.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await waitFor(async () => readFile(b.stateFile, "utf8").then(() => true).catch(() => false));
    const st1 = await (await fetch(`${base1}/dsh-remote/status`)).json();
    assert.equal(st1.restart.pending, true, "运行环境补齐后应标记待重启");
    host1.close();
    routes1.dispose();

    // 同一进程内再次装载（等价于页面刷新 / 插件重新 apply）：bootId 未变 → 提示必须还在
    const routes2 = boot(b.relayDir);
    const { host: host2, base: base2 } = await serve(routes2);
    try {
      const st2 = await (await fetch(`${base2}/dsh-remote/status`)).json();
      assert.equal(st2.restart.pending, true, "同一进程内（还没真重启）不得误撤提示");
      assert.equal(st2.restart.bootId, st1.restart.bootId, "bootId 应在同一进程内稳定不变");
    } finally { host2.close(); routes2.dispose(); }
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

const STATUS_FIRST_INSTALL = {
  ok: true, config: { phone: "13800000000", deviceId: "dev-x" },
  service: { running: true, runtimeReady: true, launchd: {} },
  restart: { pending: true, kind: "first-install", reason: "首次安装需要重启 DeepSeek harness" },
};
const STATUS_UPDATE = {
  ok: true, config: { phone: "13800000000", deviceId: "dev-x" },
  service: { running: true, runtimeReady: true, launchd: {} },
  restart: { pending: true, kind: "update", reason: "已在线更新，需要重启 DeepSeek harness 生效" },
};
const STATUS_IDLE = {
  ok: true, config: { phone: "13800000000", deviceId: "dev-x" },
  service: { running: true, runtimeReady: true, launchd: {} },
  restart: { pending: false },
};

test("UI：待重启 → 顶部醒目提示「首次安装需要重启 DeepSeek harness」+ 重启按钮", () => {
  const plugin = loadPlugin({
    ok: true,
    config: { phone: "13800000000", deviceId: "dev-x" },
    service: { running: true, runtimeReady: true, launchd: {} },
    restart: { pending: true, kind: "first-install", reason: "首次安装需要重启 DeepSeek harness" },
  });
  plugin.states[0] = STATUS_FIRST_INSTALL; // mock 的 useEffect 不执行 → 直接注入面板状态
  const tree = plugin.render();
  assert.ok(textHas(tree, "首次安装需要重启 DeepSeek harness"), "顶部应出现首次安装重启提示");
  const alert = find(tree, (n) => n.props && n.props.className === "dru-restart-alert");
  assert.ok(alert, "应有醒目提示块（dru-restart-alert）");
  const btns = findAll(tree, (n) => n.props && String(n.props.className || "").includes("dru-btn") &&
    (n.children || []).some((c) => typeof c === "string" && c.includes("重启 DeepSeek harness")));
  assert.ok(btns.length >= 2, "提示块内 + 底部常驻各一个重启按钮，实际 " + btns.length);
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
  assert.ok(!textHas(tree, "首次安装需要重启 DeepSeek harness"), "不需要重启时不该出现顶部提示");
  const foot = find(tree, (n) => n.props && n.props.className === "dru-restart-foot");
  assert.ok(foot, "底部应常驻重启按钮区（dru-restart-foot）");
  assert.ok(textHas(foot, "重启 DeepSeek harness"), "常驻区应含重启按钮文案");
});

test("UI：点「重启」→ 调用 /dsh-remote/harness/restart", async () => {
  const plugin = loadPlugin({
    ok: true,
    config: { phone: "13800000000", deviceId: "dev-x" },
    service: { running: true, runtimeReady: true, launchd: {} },
    restart: { pending: true, kind: "update", reason: "已在线更新，需要重启 DeepSeek harness 生效" },
  });
  plugin.states[0] = STATUS_UPDATE;
  const tree = plugin.render();
  // 顶部提示块内的那个按钮（常驻脚注里也有一个）
  const alert = find(tree, (n) => n.props && n.props.className === "dru-restart-alert");
  const btn = find(alert, (n) => n.props && String(n.props.className || "").includes("dru-btn") &&
    (n.children || []).some((c) => typeof c === "string" && c.includes("重启 DeepSeek harness")));
  assert.ok(btn, "顶部提示块内应能定位到重启按钮");
  btn.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/harness/restart" && r.method === "POST"),
    "点击后应 POST /dsh-remote/harness/restart，实际 " + JSON.stringify(plugin.requests));
});

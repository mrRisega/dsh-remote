// 「设备连上即出手机端入口」回归（浏览器半，0.7.10 / W1-T1 + W1-T2）。
//
// 背景（2026-11 复盘，业主质疑"这个功能应该已经有了"）：
//   二维码链路本身**早就存在**（GET /dsh-remote/access-key → qr_data_url → 25s 自动轮换 →
//   进入 online 自动重取）。缺的不是功能，是两件事：
//   ① **没连上也在出码**：生产里 100 人反复取一次性密钥（中位 4 次、最高 205 次），
//      而本机 bridge 从未在中继注册 —— 密钥接口走账号 API，不依赖 bridge 是否注册，
//      于是面板照常签发、用户扫了却进不去，只能刷新/重试，每次又签一把新的。
//   ② **收尾没人管**：安装引导停在「注册/登录手机号」，用户在电脑端登录完就以为结束了，
//      129 人设备在线却从未在手机端登录（C1）。二维码只存在于这个面板里，且没说"拿手机扫它"。
//
// 本用例锁死改动后的状态机：
//   ① 旧 host（响应无 connect 字段）→ 行为与改动前完全一致（登录即取 key、出二维码）；
//   ② 阶段已知且非 online → **不重复签发**、不出二维码，给「连上后自动出现」的说明；
//   ③ 推进到 online → 自动出二维码 + 三步激活引导 + 「复制链接发到手机」；
//   ④ mobile_sessions 出现未取消会话 → 引导收敛成一行 ✅ 已激活（这是唯一的完成信号）；
//   ⑤ 从 online 掉线 → 立刻撤掉失效二维码（不留"扫了也进不去"的码）；
//   ⑥ 连接失败分档：上游不通 / 端口占用 / 权限 / PATH(npx) / Node / 网络 → 各有原因判断；
//   ⑦ 失败块里「一键修复」直连 POST /dsh-remote/self/update（同一个重装动作，不用往下翻卡）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function walk(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
function find(tree, predicate) {
  let match;
  walk(tree, (node) => { if (!match && predicate(node)) match = node; });
  return match;
}
function textHas(tree, substr) {
  return !!find(tree, (node) => (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}
function nodeWithText(tree, substr) {
  return find(tree, (node) => typeof node.props?.onClick === "function"
    && (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const NOT_LOGGED = { ok: true, config: { phone: "", hasPhone: false, mode: "saas", deviceId: "" }, service: { running: false }, remoteUrl: "https://app.test/" };
const LOGGED = { ok: true, config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" }, service: { running: false }, remoteUrl: "https://app.test/" };
const KEY_URL = "https://app.test/a/K1";
const ACTIVE_SESSION = [{ id: "ms_1", label: "iPhone 15", os: "iOS", browser: "Safari", created_at: 1700000000000, last_seen_at: 1700000600000, revoked_at: null }];

function connectPayload(phase, extra) {
  return Object.assign({
    phase,
    online: phase === "online",
    text: {
      no_account: "请先登录手机号账号（下方「🔑 账号」卡片），登录后会自动完成剩余步骤",
      no_runtime: "正在准备运行环境（首次约 1~2 分钟）…",
      installing: "正在准备运行环境（首次约 1~2 分钟）…",
      starting: "正在启动 Bridge…",
      connecting: "正在连接中继…",
      online: "已连接 ✅ 现在可以用手机扫码访问",
      error: "连接失败，请按下方提示处理",
    }[phase],
    detail: "",
    retryable: true,
    deviceId: "dev-x",
    runtimeReady: true,
    installing: phase === "installing",
    bridgeRunning: phase !== "starting" && phase !== "no_runtime",
    registered: phase === "online",
    registerSource: phase === "online" ? "account_api" : "",
    attempts: 0,
    nextRetryInMs: 0,
    error: null,
    logPath: "/home/u/.dsh-remote/.dsh-bridge.log",
    installLogPath: "/home/u/.dsh-remote/.dsh-setup-install.log",
    diagnostics: "dsh-remote 连接诊断\n连接阶段: " + phase,
  }, extra || {});
}

/** 迷你 React（真实 useEffect + 可控假定时器），与 connect-ui / login-selfheal-ui 同一手法。 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const injects = new Map();
  const requests = [];
  const clipboard = [];
  const states = [];
  let hook = 0;
  let effectCursor = 0;
  let effectSlots = [];
  let pending = [];

  let clock = 0;
  let timerSeq = 1;
  const timers = new Map();
  const job = (fn) => { try { fn(); } catch (e) { /* 由断言暴露 */ } };
  const fakeSetTimeout = (fn, ms) => { const id = timerSeq++; timers.set(id, { at: clock + (Number(ms) || 0), fn, every: 0 }); return id; };
  const fakeSetInterval = (fn, ms) => { const id = timerSeq++; const every = Math.max(1, Number(ms) || 1); timers.set(id, { at: clock + every, fn, every }); return id; };
  const fakeClear = (id) => { timers.delete(id); };
  async function advance(ms) {
    const target = clock + ms;
    for (let guard = 0; guard < 2000; guard++) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) break;
      const [id, t] = due;
      clock = t.at;
      if (t.every) t.at = clock + t.every; else timers.delete(id);
      job(t.fn);
      await flush();
    }
    clock = target;
    await flush(); await flush();
  }

  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const index = hook++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useEffect(fn, deps) {
      const index = effectCursor++;
      const prev = effectSlots[index];
      const changed = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) pending.push({ index, fn, deps: deps ? [...deps] : deps });
    },
    useCallback(fn) { return fn; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };

  const response = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  let statusBody = opts.status || NOT_LOGGED;
  let connBody = opts.connect === undefined ? null : connectPayload(opts.connect);
  let connCalls = 0;
  let keyCalls = 0;
  let sessCalls = 0;
  let sessions = opts.sessions || [];

  const makeEl = () => ({
    tag: "div", children: [], style: {}, className: "", attributes: {}, textContent: "",
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { this.children.push(c); },
    addEventListener() {}, removeEventListener() {},
  });
  const doc = {
    hidden: false,
    createElement: makeEl,
    head: makeEl(),
    body: makeEl(),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    addEventListener() {},
    removeEventListener() {},
  };
  class MutationObserverMock { constructor() {} observe() {} disconnect() {} }
  const localStorage = {
    _s: new Map(),
    getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
    setItem(k, v) { this._s.set(k, String(v)); },
    removeItem(k) { this._s.delete(k); },
  };

  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } }, open() { return null; } },
    document: doc,
    localStorage,
    MutationObserver: MutationObserverMock,
    navigator: { clipboard: { writeText: async (t) => { clipboard.push(String(t)); } } },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClear,
    setInterval: fakeSetInterval,
    clearInterval: fakeClear,
    fetch(path, options = {}) {
      requests.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
      if (path === "/dsh-remote/status") return response(200, statusBody);
      if (path === "/dsh-remote/bridge-status") {
        connCalls += 1;
        return response(200, connBody ? { ok: true, connect: connBody } : { ok: true });
      }
      if (path === "/dsh-remote/connect/retry") return response(200, { ok: true, retried: true, connect: connBody || null });
      if (path === "/dsh-remote/self/update") return response(202, { ok: true, channel: "latest" });
      if (path === "/dsh-remote/self") return response(200, { ok: true, version: "0.7.10", runtimeReady: true });
      if (path === "/dsh-remote/self/update-log") return response(200, { ok: true, running: false, log: "" });
      if (path === "/dsh-remote/self/update-check") return response(200, { ok: true, current: "0.7.10", latest: "0.7.10", outdated: false });
      if (path === "/dsh-remote/access-key") {
        keyCalls += 1;
        return response(200, { ok: true, url: KEY_URL, key: "K1", expires_at: Date.now() + 1800000, ttl_ms: 1800000, qr_data_url: "data:image/png;base64,AAAA" });
      }
      if (path === "/dsh-remote/mobile-sessions") {
        sessCalls += 1;
        return response(200, { ok: true, sessions });
      }
      if (path === "/dsh-remote/account") return response(200, { ok: true, account: { phone: "138****0000", plan: "free", plan_source: "plan" } });
      if (path === "/dsh-remote/quota") return response(200, { ok: true, quota: null });
      if (path === "/dsh-remote/remote-url") return response(200, { ok: true, remoteUrl: "https://app.test/", publicConfig: {} });
      return response(200, { ok: true });
    },
    Set, Symbol, Date, JSON, Math, Number, String, Object, Array, console,
  };

  vm.runInNewContext(SOURCE, sandbox);
  const plugin = moduleFactory((name) => {
    assert.equal(name, "react");
    return react;
  });
  plugin.apply({
    slots: {
      inject(name, cb) { injects.set(name, cb); cb(); },
      register(meta, component) { registered.set(meta.id, component); return () => {}; },
    },
  });

  return {
    requests, states, clipboard,
    counts() { return { connCalls, keyCalls, sessCalls }; },
    render() {
      hook = 0; effectCursor = 0; pending = [];
      const tree = registered.get("dsh-remote")({ close() {} });
      const todos = pending; pending = [];
      for (const t of todos) {
        const prev = effectSlots[t.index];
        if (prev && typeof prev.cleanup === "function") job(prev.cleanup);
        const cleanup = t.fn();
        effectSlots[t.index] = { deps: t.deps, cleanup: typeof cleanup === "function" ? cleanup : null };
      }
      return tree;
    },
    async settle(times = 3) {
      for (let i = 0; i < times; i++) { this.render(); await flush(); await flush(); }
      return this.render();
    },
    advance,
    async login() {
      statusBody = LOGGED;
      await advance(30_000); // 等 30s 状态轮询把登录态带进面板
      return this.settle();
    },
    setConnect(phase, extra) { connBody = connectPayload(phase, extra); },
    setConnectRaw(body) { connBody = body; },
    setSessions(list) { sessions = list; },
  };
}

/** 二维码是否被渲染出来（img[alt=远程访问二维码]）。 */
function qrShown(tree) {
  return !!find(tree, (n) => n.props?.alt === "远程访问二维码");
}

test("向后兼容：旧 host（/bridge-status 无 connect 字段）→ 登录后照旧签发访问链接并出二维码", async () => {
  const plugin = loadPlugin({ connect: undefined });
  await plugin.settle();
  let tree = await plugin.login();
  assert.ok(plugin.counts().keyCalls >= 1, "旧 host 判断不了阶段 → 必须维持原行为（登录即取一次密钥）");
  assert.ok(qrShown(tree), "旧 host 上二维码应照旧渲染");
  assert.ok(find(tree, (n) => n.children?.includes(KEY_URL)), "旧 host 上访问链接应照旧展示");
});

test("设备未连上（starting）：不再重复签发密钥、不出二维码，改给「连上后自动出现」的说明", async () => {
  const plugin = loadPlugin({ connect: "starting" });
  await plugin.settle();
  let tree = await plugin.login();
  // 首次渲染时 phase 未知 → 允许取一次（向后兼容路径）；此后阶段已知且非 online，不得再取。
  const keyAfterLogin = plugin.counts().keyCalls;
  await plugin.advance(80_000); // 跨过 25s 轮换 ×3
  tree = await plugin.settle();
  assert.equal(plugin.counts().keyCalls, keyAfterLogin, "非 online 阶段不得按 25s 轮换继续签发密钥");
  assert.ok(!qrShown(tree), "设备没连上时不得渲染二维码（扫了也进不去）");
  assert.ok(!find(tree, (n) => n.children?.includes(KEY_URL)), "设备没连上时不得展示访问链接");
  assert.ok(textHas(tree, "连上后二维码/访问链接会自动出现在这里"), "要说明「连上后会自动出现、无需刷新」");
  assert.ok(!textHas(tree, "生成访问链接"), "不得再给一个「生成访问链接」按钮诱导用户空签");
  assert.ok(textHas(tree, "立即检测连接"), "要保留一条可操作项（立即检测连接），不留死胡同");
});

test("推进到 online：自动出二维码 + 三步激活引导 + 「复制链接发到手机」", async () => {
  const plugin = loadPlugin({ connect: "connecting" });
  await plugin.settle();
  let tree = await plugin.login();
  assert.ok(!qrShown(tree), "connecting 阶段不应出二维码");

  plugin.setConnect("online");
  await plugin.advance(2600);
  tree = await plugin.settle();
  assert.ok(qrShown(tree), "online 后应自动渲染二维码（无需刷新/无需点按钮）");
  assert.ok(textHas(tree, "3 步用上手机"), "第一屏要有激活引导标题");
  assert.ok(textHas(tree, "本机已连接"), "步骤 1 应显示本机已连接");
  assert.ok(textHas(tree, "用手机摄像头/微信扫下面的二维码"), "步骤 2 要明确「拿手机扫这个码」");
  assert.ok(textHas(tree, "手机打开后即完成登录"), "步骤 3 要说清「打开即完成」");
  assert.ok(textHas(tree, "不扫码也可以：手机浏览器打开 https://app.test/"), "要给出不扫码的第二种入口（app 地址）");
  const copyBtn = nodeWithText(tree, "复制链接发到手机");
  assert.ok(copyBtn, "要有一键「复制链接发到手机」");
  copyBtn.props.onClick();
  await flush(); await flush();
  assert.deepEqual(plugin.clipboard, [KEY_URL], "复制按钮应把访问链接写进剪贴板");
});

test("手机已登录（mobile_sessions 有未取消会话）→ 激活引导收敛成一行 ✅ 已激活，三步消失", async () => {
  const plugin = loadPlugin({ connect: "online", sessions: ACTIVE_SESSION });
  await plugin.settle();
  const tree = await plugin.login();
  assert.ok(textHas(tree, "已激活：手机已经登录过这台电脑"), "已激活态应给完成反馈（这是唯一的完成信号）");
  assert.ok(!textHas(tree, "3 步用上手机"), "已激活后不再显示三步引导");
  assert.ok(textHas(tree, "要给另一台手机用"), "要留一句「再给另一台手机用怎么办」");
});

test("从 online 掉线：立刻撤掉失效二维码（不留「扫了也进不去」的码）", async () => {
  const plugin = loadPlugin({ connect: "online" });
  await plugin.settle();
  let tree = await plugin.login();
  await plugin.settle();
  assert.ok(qrShown(tree), "online 时先出二维码");

  plugin.setConnect("error", {
    error: { code: "bridge_exit", message: "后台服务进程已退出" },
    detail: "正在自动重启后台服务…",
  });
  await plugin.advance(16000); // online → 15s 慢轮询
  tree = await plugin.settle();
  assert.ok(!qrShown(tree), "掉线后不得继续展示二维码");
  assert.ok(!find(tree, (n) => n.children?.includes(KEY_URL)), "掉线后不得继续展示访问链接");
  assert.ok(textHas(tree, "连上后二维码/访问链接会自动出现在这里"), "改为说明「连上后自动出现」");
});

test("连接失败分档：上游不通 / 端口占用 / 权限 / PATH(npx) / Node / 网络 各有原因判断", async () => {
  const cases = [
    {
      name: "上游 dsh web 没起",
      extra: { upstreamReachable: false, upstreamError: "connect ECONNREFUSED 127.0.0.1:3080", error: { code: "upstream_unreachable", message: "bridge 要连的本机 dsh web 地址探测不通" } },
      expect: "找不到这台电脑上的 dsh web",
    },
    {
      name: "端口被占用",
      extra: { error: { code: "bridge_exit", message: "Error: listen EADDRINUSE: address already in use 127.0.0.1:3080" } },
      expect: "端口被别的程序占用了",
    },
    {
      name: "权限不足",
      extra: { error: { code: "install_failed", message: "npm install 失败：EACCES permission denied" } },
      expect: "没有写入权限",
    },
    {
      name: "PATH / npx",
      extra: { error: { code: "npx_cmd_unavailable", message: "'npx' 不是内部或外部命令，也不是可运行的程序" } },
      expect: "本机找不到安装命令",
    },
    {
      name: "Node 缺失",
      extra: { error: { code: "node_missing", message: "spawn node ENOENT" } },
      expect: "本机没有 Node.js，或版本太低",
    },
    {
      name: "网络 / 软件源",
      extra: { error: { code: "npm_unreachable", message: "npm ERR! network ETIMEDOUT registry.npmjs.org" } },
      expect: "网络或软件源连不上",
    },
  ];
  for (const c of cases) {
    const plugin = loadPlugin({ connect: "error" });
    plugin.setConnect("error", Object.assign({ detail: "", attempts: 2, nextRetryInMs: 5000 }, c.extra));
    await plugin.settle();
    const tree = await plugin.login();
    assert.ok(textHas(tree, "🔧 原因判断：" + c.expect), `「${c.name}」应给出原因判断「${c.expect}」`);
  }
});

test("失败块「一键修复」→ POST /dsh-remote/self/update（同一个重装动作，不用往下翻卡找）", async () => {
  const plugin = loadPlugin({ connect: "error" });
  plugin.setConnect("error", { error: { code: "bridge_wedged", message: "后台守护已运行 120 秒仍拉不起 bridge" }, attempts: 2, nextRetryInMs: 5000 });
  await plugin.settle();
  let tree = await plugin.login();

  const repairBtn = nodeWithText(tree, "一键修复 / 重装运行环境");
  assert.ok(repairBtn, "失败块里必须有「一键修复 / 重装运行环境」主按钮");
  repairBtn.props.onClick();
  await flush(); await flush();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/self/update" && r.method === "POST"),
    "点一键修复应 POST /dsh-remote/self/update");

  tree = await plugin.settle();
  assert.ok(textHas(tree, "已开始重装运行环境"), "启动修复后要有明确反馈（不是点了没反应）");
});

test("锁定态不出「一键修复」：主行动是升级 Pro Max（额度问题不是故障）", async () => {
  const plugin = loadPlugin({ connect: "error" });
  plugin.setConnect("error", {
    error: { code: "device_locked", message: "本机已被锁定（超出当前套餐设备额度）" },
    locked: { message: "本机已被锁定（当前套餐可同时使用 1 台）", limit: 1, upgradeTo: "pro_max" },
    detail: "升级 Pro Max 可多台设备同时使用；或到手机端「管理电脑」解绑其他设备后本机会自动解锁。",
  });
  await plugin.settle();
  const tree = await plugin.login();
  assert.ok(textHas(tree, "升级 Pro Max"), "锁定态主行动应是升级 Pro Max");
  assert.ok(!textHas(tree, "一键修复 / 重装运行环境"), "锁定不是故障，不该诱导重装修复");
  assert.ok(!textHas(tree, "🔧 原因判断"), "锁定态用专用文案，不走故障分档");
});

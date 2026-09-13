// 【自动化】「自动重启 dsh web」的安全回归（浏览器半，0.6.4）。
//
// 目标：**确实需要重启时**，用户不必自己点按钮 —— 面板发现待重启后自己倒计时重启，重启后自动恢复页面
// （复用既有 restartHarness + waitHarnessBack：轮询到 harness 回来即自动刷新）。
//
// ⚠️ 0.6.4-beta.9 起：kind="refresh"（插件被运行时改写 → 只需刷新页面）**不再自动重启**，
// 因为刷新是零风险动作、重启会打断用户正在进行的会话。因此本用例用 kind="update"
// （非 refresh）来构造"确实需要重启"的场景，以覆盖倒计时链路。
// 但「自动重启进程」是危险动作，本用例锁死四条安全阀：
//   ① 只在面板可见时计时（用户没在看就不动）；
//   ② 15 秒倒计时内可一键取消，取消标记按本次事件（restart.at）持久化，同一事件不再自动重启；
//   ③ 面板上有其他操作在跑（busy≠""）时暂停计时，不打断用户正在做的事；
//   ④ 只重启一次（重启后 pending 结清即停）；无待重启时一个请求都不发。
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
  return find(tree, (node) => typeof node.props?.onClick === "function" && (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const NOT_LOGGED = { ok: true, config: { phone: "", hasPhone: false, mode: "saas", deviceId: "" }, service: { running: false }, remoteUrl: "https://app.test/" };
const LOGGED = { ok: true, config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" }, service: { running: true }, remoteUrl: "https://app.test/" };
const KEY_URL = "https://app.test/a/K1";
const SESSIONS = [{ id: "ms_1", label: "iPhone 15", os: "iOS", browser: "Safari", created_at: 1700000000000, last_seen_at: 1700000600000, revoked_at: null }];
function statusWithRestart(pending, at) {
  // kind 用 "update"(非 refresh):只有这一路才走自动重启倒计时;
  // kind="refresh" 的面板只提示刷新页面(见 harness-restart.test.mjs)。
  return Object.assign({}, LOGGED, { restart: { pending: !!pending, kind: "update", reason: "需要重启 dsh web 才能载入新插件", at: at || 0 } });
}

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
  const listeners = new Map();

  let clock = 0;
  let timerSeq = 1;
  const timers = new Map();
  const job = (fn) => { try { fn(); } catch (e) { /* 内部错误由断言暴露 */ } };
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
  let restartCalls = 0;
  const connBody = null;
  let connCalls = 0;
  let keyCalls = 0;
  let sessCalls = 0;

  const makeEl = () => ({
    tag: "div", children: [], style: {}, className: "", attributes: {}, textContent: "",
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { this.children.push(c); },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  });
  const doc = {
    hidden: false,
    createElement: makeEl,
    head: makeEl(),
    body: makeEl(),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  class MutationObserverMock { constructor() {} observe() {} disconnect() {} }
  const localStorage = {
    // 支持预置存储(验证「取消标记跨刷新生效」:getItem 走真实读取路径)
    _s: new Map(Object.entries(opts.localStorage || {})),
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
      if (path === "/dsh-remote/bridge-status") { connCalls += 1; return response(200, { ok: true }); }
      if (path === "/dsh-remote/harness/restart") {
        restartCalls += 1;
        // 重启后 harness 会带着新的 bootId 回来:模拟「待重启已结清」
        statusBody = Object.assign({}, statusBody, { restart: { pending: false, kind: "", reason: "", at: statusBody.restart?.at || 0 } });
        return response(200, Object.assign({}, statusBody, { ok: true, mode: "launchd" }));
      }
      if (path === "/dsh-remote/access-key") {
        keyCalls += 1;
        return response(200, { ok: true, url: KEY_URL, key: "K1", expires_at: Date.now() + 1800000, ttl_ms: 1800000, qr_data_url: "data:image/png;base64,AAAA" });
      }
      if (path === "/dsh-remote/mobile-sessions") {
        sessCalls += 1;
        return response(200, { ok: true, sessions: opts.sessions || SESSIONS });
      }
      if (path === "/dsh-remote/captcha") return response(200, { captcha_id: "cap-1", svg: "<svg></svg>" });
      if (path === "/dsh-remote/register") return response(201, { ok: true, token: "jwt-reg" });
      if (path === "/dsh-remote/config") return response(200, statusBody);
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
    counts() { return { connCalls, keyCalls, sessCalls, restartCalls }; },
    /** 改写状态响应(模拟 pending 被结清/用户取消后再次出现等)。 */
    setStatus(body) { statusBody = body; },
    /** 渲染一轮并执行本轮需要运行的 effects（含 cleanup）。 */
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
    /** 登录成功（面板读到登录态）→ 登录态 effect 重跑，自动开始推进连接。 */
    async login() {
      statusBody = LOGGED;
      await advance(30_000); // 等 30s 状态轮询把登录态带进面板
      return this.settle();
    },
    /** 连接阶段推进（node 半短轮询的应答变化）。 */
    setConnect(phase, extra) { connBody = connectPayload(phase, extra); },
    setConnectRaw(body) { connBody = body; },
    hide() { doc.hidden = true; },
    show() { doc.hidden = false; for (const fn of listeners.get("visibilitychange") || []) job(fn); },
  };
}



test("待重启 + 面板可见 → 15 秒后自动重启(用户零操作),重启后 pending 结清即停止", async () => {
  const plugin = loadPlugin({ status: statusWithRestart(true, 1111) });
  let tree = await plugin.settle();
  assert.ok(textHas(tree, "需要重启 dsh web 才能载入新插件"), "应显示待重启横幅");
  assert.ok(textHas(tree, "秒后自动重启"), "应显示自动重启倒计时文案");
  assert.equal(plugin.counts().restartCalls, 0, "倒计时期间不得提前重启");

  await plugin.advance(14000);
  assert.equal(plugin.counts().restartCalls, 0, "14 秒时还没到点");
  await plugin.advance(2000);
  assert.equal(plugin.counts().restartCalls, 1, "15 秒到点应自动重启一次");

  tree = await plugin.settle();
  assert.ok(!textHas(tree, "秒后自动重启"), "重启后不应残留倒计时");
  await plugin.advance(60000);
  assert.equal(plugin.counts().restartCalls, 1, "pending 结清后不得反复重启");
});

test("点「取消自动重启」→ 不再自动重启,且标记按事件持久化(刷新后仍不自动重启)", async () => {
  const plugin = loadPlugin({ status: statusWithRestart(true, 2222) });
  const tree = await plugin.settle();
  const cancelBtn = nodeWithText(tree, "取消自动重启");
  assert.ok(cancelBtn, "倒计时期间必须提供取消入口");
  cancelBtn.props.onClick();
  assert.ok(textHas(plugin.render(), "已取消自动重启"), "取消后应有明确反馈");

  await plugin.advance(120000);
  assert.equal(plugin.counts().restartCalls, 0, "取消后不得自动重启");

  // 模拟用户刷新页面:同一 pending 事件(at=2222)仍不自动重启
  const plugin2 = loadPlugin({ status: statusWithRestart(true, 2222), localStorage: { "dsh-remote-auto-restart-cancelled": "2222" } });
  await plugin2.settle();
  await plugin2.advance(120000);
  assert.equal(plugin2.counts().restartCalls, 0, "刷新后仍尊重取消标记");

  // 但下一次安装/更新(新的 at)应重新自动触发
  const plugin3 = loadPlugin({ status: statusWithRestart(true, 3333), localStorage: { "dsh-remote-auto-restart-cancelled": "2222" } });
  await plugin3.settle();
  await plugin3.advance(16000);
  assert.equal(plugin3.counts().restartCalls, 1, "新的待重启事件应重新自动重启");
});

test("面板不可见 → 倒计时暂停;回到前台继续", async () => {
  const plugin = loadPlugin({ status: statusWithRestart(true, 4444) });
  await plugin.settle();
  plugin.hide();
  await plugin.advance(60000);
  assert.equal(plugin.counts().restartCalls, 0, "页面隐藏时绝不能在用户没看到的情况下重启进程");
  plugin.show();
  await plugin.advance(16000);
  assert.equal(plugin.counts().restartCalls, 1, "回到前台应继续倒计时并最终重启");
});

test("无待重启 → 一个请求都不发;横幅不出现", async () => {
  const plugin = loadPlugin({ status: LOGGED });
  const tree = await plugin.settle();
  await plugin.advance(60000);
  assert.equal(plugin.counts().restartCalls, 0);
  assert.ok(!textHas(tree, "自动重启"), "无待重启时不应出现自动重启文案");
});

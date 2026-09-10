// 首次安装后「立即登录」面板自愈 的回归（浏览器半，真实 useEffect + 假定时器）。
//
// 现场：登录成功（loggedIn 翻真）后，面板立刻请求二维码与已授权设备列表；此时中继握手可能还没就绪
// （bridge 刚被重启、device-login 共享密钥刚补齐/正在轮换），旧版只显示一次红字、**不重试**，
// 必须手动刷新页面才恢复。本用例锁死新的自愈行为：
//   ① 登录后自动发起 access-key + mobile-sessions；
//   ② 首次失败(503 retryable) → 黄字「自动重试」+「立即重试」按钮（不吓人、可操作）；
//   ③ 退避到点自动重试 → 成功即自动清除提示、渲染二维码与设备列表（无需刷新页面）；
//   ④ 未登录时绝不请求企业端、也不出现误导性红字。
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
/** 取包含某文案的节点（用于点它的 onClick）。 */
function nodeWithText(tree, substr) {
  return find(tree, (node) => typeof node.props?.onClick === "function" && (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOT_LOGGED = { ok: true, config: { phone: "", hasPhone: false, mode: "saas", deviceId: "dev-x" }, service: { running: false }, remoteUrl: "https://app.test/" };
const LOGGED = { ok: true, config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" }, service: { running: true }, remoteUrl: "https://app.test/" };
const KEY_URL = "https://app.test/a/K1";
const SESSIONS = [{ id: "ms_1", label: "iPhone 15", os: "iOS", browser: "Safari", created_at: 1700000000000, last_seen_at: 1700000600000, revoked_at: null }];

/**
 * 迷你 React（真实 useEffect：依赖比较 + 提交后执行 + cleanup）+ 可控假定时器。
 * @param {object} opts - { failAccessKey:[次数], failSessions:[次数], status: 状态响应 }
 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const injects = new Map();
  const requests = [];
  const states = [];
  let hook = 0;
  let effectCursor = 0;
  let effectSlots = [];
  let pending = [];

  // ── 假定时器（可精确推进退避窗口） ──
  let clock = 0;
  let timerSeq = 1;
  const timers = new Map();
  const job = (fn) => { try { fn(); } catch (e) { /* 忽略：被测代码内部错误由断言暴露 */ } };
  const fakeSetTimeout = (fn, ms) => { const id = timerSeq++; timers.set(id, { at: clock + (Number(ms) || 0), fn, every: 0 }); return id; };
  const fakeSetInterval = (fn, ms) => { const id = timerSeq++; const every = Math.max(1, Number(ms) || 1); timers.set(id, { at: clock + every, fn, every }); return id; };
  const fakeClear = (id) => { timers.delete(id); };
  async function advance(ms) {
    const target = clock + ms;
    for (let guard = 0; guard < 400; guard++) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
      if (!due) break;
      const [id, t] = due;
      clock = t.at;
      if (t.every) t.at = clock + t.every; else timers.delete(id);
      job(t.fn);
      await flush(); await flush();
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

  // 企业端代理响应：可控失败次数 + 默认成功
  let statusBody = opts.status || NOT_LOGGED;
  let keyFails = opts.failAccessKey || 0;
  let sessFails = opts.failSessions || 0;
  let keyCalls = 0;
  let sessCalls = 0;
  const response = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  const NOT_READY = opts.failBody || { ok: false, error: "账号已登录，但中继连接尚未就绪（正在建立安全通道），请稍后重试", hint: "relay_not_ready", retryable: true };
  const FAIL_STATUS = opts.failStatus || 503;

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
    addEventListener() {}, removeEventListener() {},
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
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClear,
    setInterval: fakeSetInterval,
    clearInterval: fakeClear,
    fetch(path, options = {}) {
      requests.push({ path, method: options.method || "GET" });
      if (path === "/dsh-remote/status") return response(200, statusBody);
      if (path === "/dsh-remote/access-key") {
        keyCalls += 1;
        if (keyCalls <= keyFails) return response(FAIL_STATUS, NOT_READY);
        return response(200, { ok: true, url: KEY_URL, key: "K1", expires_at: Date.now() + 1800000, ttl_ms: 1800000, qr_data_url: "data:image/png;base64,AAAA" });
      }
      if (path === "/dsh-remote/mobile-sessions") {
        sessCalls += 1;
        if (sessCalls <= sessFails) return response(FAIL_STATUS, NOT_READY);
        return response(200, { ok: true, sessions: SESSIONS });
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
    requests,
    states,
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
    advance,
    /** 渲染 → 让在途请求落地 → 再渲染（返回最新树），模拟真实的重渲染节奏。 */
    async settle(times = 2) {
      let tree = null;
      for (let i = 0; i < times; i++) {
        tree = this.render();
        await flush(); await flush();
      }
      return this.render();
    },
    /** 模拟「账号登录成功」：改写状态响应 + 推进 30s 轮询心跳，让面板看到登录态。 */
    async login() {
      statusBody = LOGGED;
      await advance(30_000);
      return this.settle();
    },
    counts() { return { keyCalls, sessCalls }; },
  };
}

test("未登录：不请求企业端、不出误导性红字；登录后自动拉取二维码与设备列表", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle(); // 挂载 → refresh() 读状态

  assert.ok(!plugin.requests.some((r) => r.path === "/dsh-remote/access-key"), "未登录不得请求二维码接口");
  assert.ok(!plugin.requests.some((r) => r.path === "/dsh-remote/mobile-sessions"), "未登录不得请求设备列表");
  assert.ok(textHas(tree, "登录下方「🔑 账号」卡片中的手机号账号后"), "未登录应给登录引导而非报错");
  assert.ok(!textHas(tree, "尚未登录"), "未登录也不该出现接口报错红字");

  tree = await plugin.login();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/access-key"), "登录后应自动请求一次性访问地址");
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/mobile-sessions"), "登录后应自动请求已授权设备列表");
  assert.ok(find(tree, (n) => n.props?.src === "data:image/png;base64,AAAA"), "登录后应直接渲染二维码");
});

test("登录瞬间中继未就绪：首次失败自动重试，退避到点即恢复（无需刷新页面）", async () => {
  const plugin = loadPlugin({ failAccessKey: 1, failSessions: 1 });
  let tree = await plugin.settle();
  tree = await plugin.login();

  // 首次失败：黄字提示 + 可点的「立即重试」，而不是死红字（旧版行为）
  assert.equal(plugin.counts().keyCalls, 1, "登录后第一次请求二维码");
  assert.equal(plugin.counts().sessCalls, 1, "登录后第一次请求设备列表");
  assert.ok(textHas(tree, "中继连接尚未就绪"), "失败应给「中继连接尚未就绪」的可重试提示");
  assert.ok(textHas(tree, "秒后自动重试"), "应说明会自动重试");
  assert.ok(nodeWithText(tree, "立即重试"), "提示旁应提供「立即重试」按钮");
  assert.ok(!find(tree, (n) => n.props?.src === "data:image/png;base64,AAAA"), "首次失败时还没有二维码");

  // 退避 1.2s 后自动重试 → 成功 → 提示清除、二维码与设备列表就位
  await plugin.advance(1300);
  assert.equal(plugin.counts().keyCalls, 2, "退避到点应自动重试二维码");
  assert.equal(plugin.counts().sessCalls, 2, "退避到点应自动重试设备列表");

  tree = await plugin.settle();
  assert.ok(find(tree, (n) => n.props?.src === "data:image/png;base64,AAAA"), "重试成功后应渲染二维码");
  assert.ok(textHas(tree, "已授权设备 1"), "重试成功后设备列表应加载完成（无需手动展开/刷新）");
  assert.ok(!textHas(tree, "中继连接尚未就绪"), "成功后应自动清除重试提示");
  assert.ok(!textHas(tree, "加载已授权设备失败"), "成功路径上不得残留红字错误");
});

test("点「立即重试」：不等退避窗口，立刻重发并恢复", async () => {
  const plugin = loadPlugin({ failAccessKey: 1, failSessions: 1 });
  await plugin.settle();
  const tree0 = await plugin.login();
  assert.equal(plugin.counts().keyCalls, 1);

  const retryBtn = nodeWithText(tree0, "立即重试");
  assert.ok(retryBtn, "应能找到「立即重试」按钮");
  retryBtn.props.onClick();
  const tree = await plugin.settle();

  assert.equal(plugin.counts().keyCalls, 2, "手动重试应立即重发二维码请求");
  assert.ok(find(tree, (n) => n.props?.src === "data:image/png;base64,AAAA"), "手动重试后应渲染二维码");
});

test("持续失败：退避重试上限后停在红字并保留「立即重试」，不无限刷请求", async () => {
  const plugin = loadPlugin({ failAccessKey: 99, failSessions: 99 });
  await plugin.settle();
  await plugin.login();
  await plugin.advance(2000);   // 第 1 次自动重试
  await plugin.advance(4000);   // 第 2 次
  await plugin.advance(8000);   // 第 3 次
  await plugin.advance(60_000); // 之后不再自动重试（除 25s 轮换）
  const after = plugin.counts();
  assert.ok(after.sessCalls <= 4, `设备列表重试应有上限（实际 ${after.sessCalls}）`);
  const tree = await plugin.settle();
  assert.ok(nodeWithText(tree, "立即重试"), "失败后应保留可操作的重试入口");
});

test("不可重试失败（401 密码失效 / 未登录）：直接红字提示，不做无意义重试", async () => {
  const plugin = loadPlugin({
    failAccessKey: 99,
    failSessions: 99,
    failStatus: 401,
    failBody: { ok: false, error: "本机保存的账号密码已被中继拒绝：请用新密码重新登录", hint: "relogin_required", retryable: false },
  });
  await plugin.settle();
  await plugin.login();
  assert.equal(plugin.counts().sessCalls, 1);

  await plugin.advance(10_000); // 远超退避窗口（但短于 25s 的二维码周期轮换）
  assert.equal(plugin.counts().sessCalls, 1, "不可重试类失败不得自动重发（设备列表）");
  assert.equal(plugin.counts().keyCalls, 1, "不可重试类失败不得自动重发（二维码）");
  await plugin.advance(20_000); // 25s 轮换后设备列表仍不自动重发（仅二维码按周期换新）
  assert.equal(plugin.counts().sessCalls, 1, "设备列表没有周期轮换，失败后不得空转");

  const tree = await plugin.settle();
  assert.ok(textHas(tree, "加载已授权设备失败：本机保存的账号密码已被中继拒绝"), "应显示真实原因红字");
  assert.ok(textHas(tree, "获取一次性访问地址失败：本机保存的账号密码已被中继拒绝"), "二维码卡同样显示真实原因");
  assert.ok(!textHas(tree, "秒后自动重试"), "不可重试时不应出现自动重试提示");
});

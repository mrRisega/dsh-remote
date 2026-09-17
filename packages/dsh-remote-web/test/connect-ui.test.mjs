// 「登录后自动闭环」UI 回归（浏览器半，0.6.4；真实 useEffect + 可控假定时器 + 可控 document.hidden）。
//
// 现场：注册后手机端一直是空设备列表，用户在设置面板反复点「生成访问链接」
// 却始终没有 device.bind——他们看不到「到底卡在哪一步」，也不知道要不要刷新页面。
// 本用例锁死面板侧的自动闭环：
//   ① 登录后立刻进入启动/连接流程（2.5s 短轮询自动推进，不需要点任何按钮）；
//   ② 阶段推进到 online → UI 自动变成「已连接 ✅ 现在可以用手机扫码访问」，并自动重取二维码与
//      已授权设备列表（全程不刷新页面）；
//   ③ error 阶段必须有可操作项：重试 / 复制诊断信息 / 日志路径（不留死胡同）；
//   ④ document.hidden 时短轮询暂停（后台标签页不空转），回前台立即补一次；online 后退避到 15s；
//   ⑤ 面板注册带注册来源 reg_source=panel_register（增长口径）。
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
/** 按 placeholder 取输入框并注入值（走真实 onChange，与用户输入同路径）。 */
function typeInto(tree, placeholder, value) {
  const el = find(tree, (node) => node.type === "input" && node.props && node.props.placeholder === placeholder);
  assert.ok(el, "应找到 placeholder 为「" + placeholder + "」的输入框");
  el.props.onChange({ target: { value } });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const NOT_LOGGED = { ok: true, config: { phone: "", hasPhone: false, mode: "saas", deviceId: "" }, service: { running: false }, remoteUrl: "https://app.test/" };
const LOGGED = { ok: true, config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" }, service: { running: false }, remoteUrl: "https://app.test/" };
const KEY_URL = "https://app.test/a/K1";
const SESSIONS = [{ id: "ms_1", label: "iPhone 15", os: "iOS", browser: "Safari", created_at: 1700000000000, last_seen_at: 1700000600000, revoked_at: null }];

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
    diagnostics: "dsh-remote 连接诊断\n插件版本: 0.6.3\n连接阶段: " + phase,
  }, extra || {});
}

/**
 * 迷你 React（真实 useEffect：依赖比较 + 提交后执行 + cleanup）+ 可控假定时器 +
 * 可控 document.hidden / visibilitychange（用于验证「隐藏即暂停、回前台立即刷新」）。
 */
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
  let connBody = opts.connect === undefined ? null : connectPayload(opts.connect);
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
      if (path === "/dsh-remote/connect/retry") {
        return response(200, { ok: true, retried: true, connect: connBody || null });
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
    counts() { return { connCalls, keyCalls, sessCalls }; },
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

test("登录后自动进入连接流程：无需点按钮，短轮询 2.5s 自动推进并显示阶段文案", async () => {
  const plugin = loadPlugin({ connect: "starting" });
  let tree = await plugin.settle();
  assert.equal(plugin.counts().connCalls, 0, "未登录不该轮询连接阶段");

  tree = await plugin.login();
  assert.ok(textHas(tree, "正在启动 Bridge…"), "登录后应自动显示「正在启动 Bridge…」");
  const after = plugin.counts().connCalls;
  assert.ok(after >= 1, "登录后应立即拉一次连接阶段");

  // 短轮询自动推进：2.5s 一轮（用户什么都不用做）
  await plugin.advance(2600);
  assert.ok(plugin.counts().connCalls > after, "非 online 阶段应 2.5s 短轮询自动推进");
  tree = plugin.render();
  assert.ok(textHas(tree, "正在启动 Bridge…"), "阶段文案应持续可见");
});

test("阶段推进到 online：UI 自动变化并自动重取二维码/设备列表（无需刷新页面）", async () => {
  const plugin = loadPlugin({ connect: "connecting" });
  await plugin.settle();
  let tree = await plugin.login();
  assert.ok(textHas(tree, "正在连接中继…"), "先显示「正在连接中继…」");
  const keyBefore = plugin.counts().keyCalls;
  const sessBefore = plugin.counts().sessCalls;

  // node 半下一次返回 online（设备已在中继注册成功）
  plugin.setConnect("online");
  await plugin.advance(2600);
  tree = await plugin.settle();

  assert.ok(textHas(tree, "已连接 ✅ 现在可以用手机扫码访问"), "阶段推进后 UI 应自动变成「已连接 ✅」");
  assert.ok(plugin.counts().keyCalls > keyBefore, "进入 online 应自动重取一次性访问链接（不用点「生成访问链接」）");
  assert.ok(plugin.counts().sessCalls > sessBefore, "进入 online 应自动刷新已授权设备列表");
  assert.ok(find(tree, (n) => n.props?.src === "data:image/png;base64,AAAA"), "应直接渲染出可扫码的二维码");
  assert.ok(textHas(tree, "设备已登记到你的账号"), "应说明设备已登记到账号（手机端能看到）");
  assert.ok(!textHas(tree, "正在连接中继…"), "旧阶段文案应被自动替换");
});

test("error 阶段：给出重试 + 复制诊断信息 + 日志路径，点重试走 /connect/retry（不留死胡同）", async () => {
  const plugin = loadPlugin({
    connect: "error",
    status: LOGGED,
  });
  plugin.setConnect("error", {
    error: { code: "launchd_crash", message: "后台服务反复启动失败（launchd state=spawn scheduled，lastExit=1）" },
    detail: "已自动清理失效的自启动项并重新拉起，稍候会自动恢复。",
    attempts: 3,
    nextRetryInMs: 8000,
  });
  await plugin.settle();
  let tree = await plugin.login();

  assert.ok(textHas(tree, "后台服务反复启动失败"), "应显示可读的失败原因");
  assert.ok(textHas(tree, "已自动重试 3 次"), "应告诉用户已自动重试过（不是让用户干等）");
  assert.ok(textHas(tree, "秒后自动再试"), "应给出自动重试倒计时");
  assert.ok(textHas(tree, ".dsh-bridge.log"), "应给出「查看日志」的路径");
  const retryBtn = nodeWithText(tree, "重试");
  const diagBtn = nodeWithText(tree, "复制诊断信息");
  assert.ok(retryBtn, "error 阶段必须提供「重试」按钮");
  assert.ok(diagBtn, "error 阶段必须提供「复制诊断信息」按钮");

  // 复制诊断信息 → 剪贴板拿到 node 半拼好的诊断块
  diagBtn.props.onClick();
  await flush(); await flush();
  assert.equal(plugin.clipboard.length, 1, "应把诊断信息写进剪贴板");
  assert.match(plugin.clipboard[0], /dsh-remote 连接诊断/);
  assert.match(plugin.clipboard[0], /连接阶段: error/);

  // 点重试 → POST /dsh-remote/connect/retry，并按新状态重渲染
  plugin.setConnect("starting");
  retryBtn.props.onClick();
  await flush(); await flush();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/connect/retry" && r.method === "POST"), "点重试应调用 /dsh-remote/connect/retry");
  tree = await plugin.settle();
  assert.ok(textHas(tree, "正在启动 Bridge…"), "重试后应显示新的阶段状态");
});

test("轮询策略：document.hidden 时暂停短轮询，回前台立即补一次；online 后退避到 15s", async () => {
  const plugin = loadPlugin({ connect: "connecting" });
  await plugin.settle();
  await plugin.login();
  const base = plugin.counts().connCalls;

  // 后台标签页：完全不发请求（不空转）
  plugin.hide();
  await plugin.advance(20_000);
  assert.equal(plugin.counts().connCalls, base, "页面隐藏时不得继续轮询");

  // 回前台：立即补一次（用户切回来就看到最新状态，不需要刷新页面）
  plugin.show();
  await flush(); await flush();
  assert.equal(plugin.counts().connCalls, base + 1, "回前台应立刻刷新一次");

  // 仍非 online → 继续 2.5s 短轮询
  const fast = plugin.counts().connCalls;
  await plugin.advance(2600);
  assert.ok(plugin.counts().connCalls > fast, "非 online 阶段应继续 2.5s 短轮询");

  // 进入 online → 退避：12s 窗口内最多再补一次（2.5s 节奏会打 4~5 次），随后按 15s 慢节奏保活
  plugin.setConnect("online");
  await plugin.advance(2600);
  const onlineCalls = plugin.counts().connCalls;
  await plugin.advance(12_000);
  const extra = plugin.counts().connCalls - onlineCalls;
  assert.ok(extra <= 2, `online 后应退避（12s 内实际 ${extra} 次）`);
  await plugin.advance(16_000);
  assert.ok(plugin.counts().connCalls > onlineCalls + extra, "online 后仍应按 ~15s 节奏保活（新设备扫码后列表能自动出现）");
});

test("面板注册带注册来源 reg_source=panel_register（增长口径：电脑端 vs 手机端网页注册）", async () => {
  const plugin = loadPlugin({ status: NOT_LOGGED });
  let tree = await plugin.settle();
  const regTab = nodeWithText(tree, "注册");
  assert.ok(regTab, "应有「注册」标签");
  regTab.props.onClick();
  tree = await plugin.settle();

  typeInto(tree, "11 位手机号", "13800000000");
  typeInto(tree, "至少 8 位", "password123");
  typeInto(tree, "再次输入密码", "password123");
  typeInto(tree, "6 位验证码", "218937");
  tree = await plugin.settle();

  // 提交按钮（不是上面的「注册」标签页）：className 带 dru-btn-primary 且文本恰为「注册」
  const submit = find(tree, (n) => typeof n.props?.onClick === "function"
    && String(n.props.className || "").includes("dru-btn-primary")
    && (n.children || []).some((c) => c === "注册"));
  assert.ok(submit, "应能找到注册提交按钮");
  submit.props.onClick();
  await flush(); await flush();

  const req = plugin.requests.filter((r) => r.path === "/dsh-remote/register").pop();
  assert.ok(req, "应提交 /dsh-remote/register");
  assert.equal(req.body.reg_source, "panel_register", "面板注册必须带 reg_source=panel_register");
  assert.equal(req.body.phone, "13800000000");
});

test("旧版 host（响应无 connect 字段）：回退既有文案，行为不变", async () => {
  const plugin = loadPlugin({ status: LOGGED });
  plugin.setConnectRaw(undefined); // /bridge-status 返回 {ok:true}（没有 connect）
  await plugin.settle();
  const tree = await plugin.login();
  assert.ok(textHas(tree, "等待设备连接"), "没有 connect 时回退到既有「等待设备连接」文案");
  assert.ok(!textHas(tree, "正在启动 Bridge…"), "不应伪造阶段文案");
});

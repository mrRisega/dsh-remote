// 📄 购买协议**不在插件面板展示** —— **浏览器半**（lib/client.js 面板）行为回归。
//
// 需求变更（业主 2026-10-24）：面板的续费/购买按钮下方**不要**再出现
// 「购买即表示同意《会员服务购买协议》」这句话 —— 协议只在**手机端支付扫码前**（支付页）展示。
// 上一轮（task-17）在 client.js 里加的两处链接（账号卡购买按钮下方、连接偏慢双路块升级路旁）
// 已连同相关常量/渲染函数/样式一并删除；node 半 `GET /dsh-remote/purchase-agreement` 代理**保留**
// （手机端/其它端后续可复用，其 URL 优先级/安全过滤/降级契约见 purchase-agreement-proxy.test.mjs）。
//
// 本文件锁「不该出现」这件事（四条路径都要覆盖）：
//   ① 免费用户账号卡：升级 PRO 按钮在，但协议文案/链接/旧样式类都不在，也不再请求协议地址；
//   ② 会员账号卡：续费会员按钮下同样没有这句协议文案（业主点名的位置）；
//   ③ 连接偏慢双路块：升级（购买）路旁没有协议链接；
//   ④ 未登录：本来就没有购买入口，也不该有任何协议痕迹/请求。
//   ⑤ 源码级回归锁：client.js 里不得再残留协议渲染痕迹（防止以后又被"顺手加回来"）。
//
// 做法与 community-invite-ui.test.mjs 一致：真脚本 + vm + 迷你 React（真实 useEffect）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
// 复制自 community-invite-ui 的迷你 React harness 里，交流群/弹层接口仍有默认夹具，统一给一个假二维码地址。
const QR_ABS = "https://relay.test/relay-api/qr/group-qr.png";

/**
 * 面板树里所有「购买协议」痕迹：协议文案 / 协议链接 / 旧样式类。
 * 期望结果恒为空数组 —— 这正是业主这次要的"面板上不再出现这句话"。
 */
function agreementTraces(tree) {
  const out = [];
  walk(tree, (n) => {
    if (!n || typeof n !== "object") return;
    const cls = String((n.props && n.props.className) || "");
    if (cls === "dru-legal" || cls === "dru-legal-a" || cls.startsWith("dru-legal ")) out.push({ kind: "class", node: n });
    if (n.type === "a" && n.props && /purchase-agreement/i.test(String(n.props.href || ""))) out.push({ kind: "href", node: n });
    for (const c of n.children || []) {
      if (typeof c !== "string") continue;
      if (/购买协议|会员服务购买协议|购买即表示同意/.test(c)) out.push({ kind: "text", text: c });
    }
  });
  return out;
}
/** 断言整棵面板树里没有任何协议痕迹（失败时把命中项打印出来，便于定位是谁加回来的）。 */
function assertNoAgreementInPanel(tree) {
  const hits = agreementTraces(tree);
  assert.equal(hits.length, 0, `面板里不得再出现购买协议文案/链接，实际命中: ${JSON.stringify(hits.slice(0, 4))}`);
  assert.equal(textHas(tree, "购买即表示同意"), false, "业主明确要求：不要「购买即表示同意…」这句话");
  assert.equal(textHas(tree, "会员服务购买协议"), false);
}

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

/**
 * 迷你 React（真实 useEffect）+ 假定时器；fetch 覆盖 /dsh-remote/* 面板接口。
 * @param {object} opts - community：/dsh-remote/community 的返回值（默认已配置二维码）
 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const injects = new Map();
  const requests = [];

  let clock = 0;
  let timerSeq = 1;
  const timers = new Map();
  const job = (fn) => { try { fn(); } catch (e) { /* 断言会暴露问题 */ } };
  const fakeSetTimeout = (fn, ms) => { const id = timerSeq++; timers.set(id, { at: clock + (Number(ms) || 0), fn, every: 0 }); return id; };
  const fakeSetInterval = (fn, ms) => { const id = timerSeq++; const every = Math.max(1, Number(ms) || 1); timers.set(id, { at: clock + every, fn, every }); return id; };
  const fakeClear = (id) => { timers.delete(id); };

  // ── 迷你 React：真实 useState/useEffect + 递归渲染函数组件(FeedbackCard 等嵌套组件) ──
  // 每个组件实例按「树中位置路径」持有自己的 hook 槽位(近似 React 的位置化协调),故子组件状态
  // 可跨渲染保持;effects 在对应子树展开后执行(cleanup 语义与 React 一致)。
  const scopes = new Map(); // key -> { hook, effectCursor, slots, pending }
  const scopeStack = [];
  const currentScope = () => scopeStack[scopeStack.length - 1];

  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const sc = currentScope();
      const index = sc.hook++;
      if (!(index in sc.state)) sc.state[index] = typeof initial === "function" ? initial() : initial;
      return [sc.state[index], (value) => { sc.state[index] = typeof value === "function" ? value(sc.state[index]) : value; }];
    },
    useEffect(fn, deps) {
      const sc = currentScope();
      const index = sc.effectCursor++;
      const prev = sc.effects[index];
      const changed = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) sc.pending.push({ index, fn, deps: deps ? [...deps] : deps });
    },
    useCallback(fn) { return fn; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };

  /** 渲染一棵树:函数组件递归展开(含 effects),普通节点保留并递归子节点。 */
  function renderNode(node, path) {
    if (node == null) return node;
    if (Array.isArray(node)) return node.map((n, i) => renderNode(n, path + "/" + i));
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const name = node.type.name || "anon";
      const key = path + ":" + name;
      const sc = scopes.get(key) || { hook: 0, effectCursor: 0, state: [], effects: [], pending: [] };
      sc.hook = 0; sc.effectCursor = 0; sc.pending = [];
      scopes.set(key, sc);
      scopeStack.push(sc);
      let out;
      try {
        out = node.type(node.props || {});
      } finally {
        scopeStack.pop();
      }
      const expanded = renderNode(out, key);
      const todos = sc.pending;
      sc.pending = [];
      for (const t of todos) {
        const prev = sc.effects[t.index];
        if (prev && typeof prev.cleanup === "function") job(prev.cleanup);
        const cleanup = t.fn();
        sc.effects[t.index] = { deps: t.deps, cleanup: typeof cleanup === "function" ? cleanup : null };
      }
      return expanded;
    }
    return { ...node, children: (node.children || []).map((c, i) => renderNode(c, path + "/" + i)) };
  }

  const community = opts.community !== undefined ? opts.community : { ok: true, qrcode: QR_ABS, wechat: "dsh-remote-support" };
  const status = opts.status || {
    ok: true,
    config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" },
    service: { running: true },
    remoteUrl: "https://relay.test/app/",
  };
  const response = (s, body) => Promise.resolve({ ok: s >= 200 && s < 300, status: s, text: async () => JSON.stringify(body) });

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

  const sessionStorage = {
    _s: new Map(),
    getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
    setItem(k, v) { this._s.set(k, String(v)); },
    removeItem(k) { this._s.delete(k); },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } }, open() { return null; } },
    document: doc,
    localStorage,
    sessionStorage,
    location: { origin: "https://127.0.0.1:3080", href: "https://127.0.0.1:3080/" },
    MutationObserver: MutationObserverMock,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClear,
    setInterval: fakeSetInterval,
    clearInterval: fakeClear,
    fetch(path, options = {}) {
      requests.push({ path, method: options.method || "GET" });
      if (path === "/dsh-remote/status") return response(200, status);
      if (path === "/dsh-remote/account") return response(200, opts.account !== undefined ? { ok: true, account: opts.account } : { ok: true });
      if (path === "/dsh-remote/community") return response(200, community);
      if (path === "/dsh-remote/community-invite/status") {
        if (opts.inviteReject) return Promise.reject(new Error("network down"));
        if (opts.inviteStatus && opts.inviteStatus !== 200) return response(opts.inviteStatus, { ok: false, error: "boom" });
        return response(200, opts.invite !== undefined ? opts.invite : {
          ok: true, show: true, reason: "ok", used_seconds: 7300, required_seconds: 7200, qr_url: QR_ABS,
        });
      }
      if (path === "/dsh-remote/community-invite/shown") {
        if (opts.inviteShownFail) return response(500, { ok: false, error: "report failed" });
        return response(200, { ok: true });
      }
      if (path === "/dsh-remote/purchase-agreement") {
        if (opts.agreementReject) return Promise.reject(new Error("public-config down"));
        if (opts.agreementStatus && opts.agreementStatus !== 200) return response(opts.agreementStatus, { ok: false });
        return response(200, opts.agreement !== undefined ? opts.agreement : { ok: true, url: AGREEMENT_ABS });
      }
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
    sessionStorage,
    statusRequests: () => requests.filter((r) => r.path === "/dsh-remote/community-invite/status"),
    agreementRequests: () => requests.filter((r) => r.path === "/dsh-remote/purchase-agreement"),
    shownRequests: () => requests.filter((r) => r.path === "/dsh-remote/community-invite/shown"),
    /** 渲染 → 让在途请求落地 → 再渲染（返回最新树）。 */
    async settle(times = 2) {
      let tree = null;
      for (let i = 0; i < times; i++) { tree = this.render(); await flush(); await flush(); }
      return this.render();
    },
    render() {
      const root = { type: registered.get("dsh-remote"), props: { close() {} }, children: [] };
      return renderNode(root, "root");
    },
  };
}


test("① 免费用户账号卡：升级 PRO 按钮仍在，但协议文案/链接/旧样式全都不再出现，也不再请求协议地址", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle(4);
  // 购买入口（升级按钮）必须还在 —— 这次只删协议文案，不动购买能力
  assert.ok(nodeWithText(tree, "🚀 升级 PRO"), "免费用户的「🚀 升级 PRO」按钮必须保留");
  // 协议痕迹一个都不能有
  assertNoAgreementInPanel(tree);
  // 客户端也不再为了这句话去问 node 半（面板里已经没有消费者了）
  assert.equal(plugin.agreementRequests().length, 0, "面板已不再展示协议，就不该再请求 /dsh-remote/purchase-agreement");
});

test("② 会员账号卡（业主点名场景）：续费会员按钮下方不再有「购买即表示同意…」", async () => {
  const plugin = loadPlugin({
    account: { plan: "pro", plan_source: "subscription", plan_ends_at: 1893456000000, invite_code: "ABC12345" },
  });
  const tree = await plugin.settle(4);
  assert.ok(nodeWithText(tree, "🔄 续费会员"), "前提：会员的续费入口在（这正是业主看到那句话的位置）");
  assertNoAgreementInPanel(tree);
});

test("③ 连接偏慢双路块：升级（购买）路旁也没有协议链接，协议地址零请求", async () => {
  const plugin = loadPlugin({
    status: {
      ok: true,
      config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" },
      service: { running: true },
      // 触发 connSlow：服务端已自动重试 ≥3 次（见 client.js connSlow 判定）
      connect: { phase: "connecting", attempts: 3, text: "正在自动重试连接" },
      remoteUrl: "https://relay.test/app/",
    },
  });
  const tree = await plugin.settle(4);
  const dual = find(tree, (n) => n.props && n.props.className === "dru-dual");
  assert.ok(dual, "前提：慢连接时双路块应出现（购买路仍在）");
  assert.equal(find(dual, (n) => n.props && n.props.className === "dru-legal-a"), undefined,
    "双路块的购买路旁不得再有协议链接");
  assertNoAgreementInPanel(tree);
  assert.equal(plugin.agreementRequests().length, 0);
});

test("④ 未登录：没有购买入口，也没有任何协议痕迹/请求", async () => {
  const plugin = loadPlugin({
    status: {
      ok: true,
      config: { phone: "", hasPhone: false, mode: "saas", deviceId: "dev-x" },
      service: { running: false },
      remoteUrl: "https://relay.test/app/",
    },
  });
  const tree = await plugin.settle(4);
  assert.equal(nodeWithText(tree, "🚀 升级 PRO"), undefined, "未登录没有购买入口");
  assertNoAgreementInPanel(tree);
  assert.equal(plugin.agreementRequests().length, 0);
});

test("⑤ 源码级回归锁：client.js 里不得再残留协议渲染痕迹（node 半代理保留）", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const src = rf(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const sym of ["dru-legal", "renderAgreementLink", "购买即表示同意", "会员服务购买协议", "PURCHASE_AGREEMENT_FALLBACK", "loadPurchaseAgreementUrl"]) {
    assert.equal(src.includes(sym), false, `client.js 不得再出现「${sym}」——面板不再展示购买协议（协议只在手机端支付页展示）`);
  }
  // node 半的代理仍在（不要顺手删掉：手机端/其它端后续可复用，且 proxy 用例锁着它的契约）
  const idx = rf(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(idx.includes('path: "/dsh-remote/purchase-agreement"'), "node 半 /dsh-remote/purchase-agreement 代理必须保留");
  assert.ok(SOURCE.length > 0);
});

test("⑥ 只删文案、不动购买能力：点「升级 PRO」仍走既有购买流程（请求 /dsh-remote/access-key）", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle(4);
  const btn = nodeWithText(tree, "🚀 升级 PRO");
  assert.ok(btn, "升级按钮必须还在");
  btn.props.onClick();
  await plugin.settle(2);
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/access-key"),
    "购买入口仍走既有 openUpgradeAuth（生成一次性访问链接 → 打开套餐页）；删的只是协议文案");
  tree = plugin.render();
  assertNoAgreementInPanel(tree);
});

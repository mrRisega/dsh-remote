// 📄 会员服务购买协议链接 —— **浏览器半**（lib/client.js 面板）行为回归。
//
// 背景（业主 2026-10-23，客户端 0.7.5-beta.1）：购买/升级入口必须带《会员服务购买协议》链接。
// 桌面端购买入口有两条（都在「账号卡」与「连接偏慢双路块」里），两者都要摆链接：
//   · 「🚀 升级 PRO / 转正式 / 续费会员」主按钮下方（账号卡）
//   · 「连接偏慢」双路块里的升级按钮旁（只在该块有购买路时出现）
//
// 本文件锁：
//   ① 链接存在、文案/新标签/安全属性正确；
//   ② URL 优先级：node 半下发的 `public-config.agreement_url` 覆盖兜底；
//   ③ 安全过滤：node 半给了非法协议（javascript:/data:/相对）→ 客户端**再**过滤回兜底；
//   ④ 失败软着陆：node 半接口 500/网络异常 → 链接仍用兜底常量存在，购买按钮不受影响；
//   ⑤ 未登录不展示（购买入口本来就只在登录后出现）。
//
// 做法与 community-invite-ui.test.mjs 一致：真脚本 + vm + 迷你 React（真实 useEffect）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const AGREEMENT_ABS = "https://relay.test/relay-api/api/purchase-agreement";              // node 半下发的（模拟 public-config 配的）
const AGREEMENT_FALLBACK = "https://n.risegao.cn:13443/relay-api/api/purchase-agreement"; // 固定兜底常量
// 复制自 community-invite-ui 的迷你 React harness 里，交流群/弹层接口仍有默认夹具，统一给一个假二维码地址。
const QR_ABS = "https://relay.test/relay-api/qr/group-qr.png";

/** 购买协议的 <a>（按 className 定位；要求带 href）。 */
function agreementLink(tree) {
  return find(tree, (n) => n.props && n.props.className === "dru-legal-a" && typeof n.props.href === "string");
}
function linkTexts(node) {
  return (node.children || []).filter((c) => typeof c === "string").join("");
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

test("① 登录后账号卡购买入口旁有协议链接：新标签打开 + 文案/属性正确，URL 用 node 半下发的地址", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle(4);
  const a = agreementLink(tree);
  assert.ok(a, "购买/升级入口旁必须能看到《会员服务购买协议》链接");
  assert.equal(a.props.href, AGREEMENT_ABS, "URL 优先用 node 半下发的 public-config.agreement_url");
  assert.equal(a.props.target, "_blank", "必须在新标签打开（不在面板里跳走）");
  assert.match(String(a.props.rel || ""), /noopener/, "rel 必须带 noopener（反钓鱼面）");
  assert.match(String(a.props.rel || ""), /noreferrer/, "rel 应带 noreferrer");
  assert.equal(a.type, "a", "必须是真正的链接（可复制地址/中键打开），不是 button");
  assert.match(linkTexts(a), /《会员服务购买协议》/, "链接文案必须是《会员服务购买协议》");
  // 购买/升级按钮仍然在（链接不替代购买）
  assert.ok(nodeWithText(tree, "🚀 升级 PRO") || nodeWithText(tree, "🔄 续费会员") || nodeWithText(tree, "🚀 转正式 PRO"),
    "购买/续费主按钮必须仍在（协议链接只是补充）");
  assert.equal(plugin.agreementRequests().length, 1, "每页面会话只问一次协议地址");
});

test("② 优先级：node 半下发 public-config 配的地址 → 覆盖兜底常量", async () => {
  const plugin = loadPlugin({ agreement: { ok: true, url: "https://relay.test/custom/agreement.html", source: "public_config" } });
  const tree = await plugin.settle(4);
  const a = agreementLink(tree);
  assert.ok(a);
  assert.equal(a.props.href, "https://relay.test/custom/agreement.html", "服务端配置优先于兜底");
});

test("③ 安全过滤：node 半给了非法协议/相对路径 → 客户端丢弃并回兜底（<a href> 不能吃 javascript:）", async () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example/agreement", "/relay-api/x", ""]) {
    const plugin = loadPlugin({ agreement: { ok: true, url: bad } });
    const tree = await plugin.settle(4);
    const a = agreementLink(tree);
    assert.ok(a, `非法 URL 时链接仍应存在（用兜底）: ${JSON.stringify(bad)}`);
    assert.equal(a.props.href, AGREEMENT_FALLBACK, `非法 URL 必须回兜底: ${JSON.stringify(bad)}`);
  }
});

test("④ 失败软着陆：node 半 500 / 网络异常 → 链接仍存在且用兜底，购买按钮不受影响", async () => {
  for (const opts of [{ agreementStatus: 500 }, { agreementReject: true }]) {
    const plugin = loadPlugin(opts);
    const tree = await plugin.settle(4);
    const a = agreementLink(tree);
    assert.ok(a, "协议接口挂了也不能让链接消失（这是法律/产品硬要求）");
    assert.equal(a.props.href, AGREEMENT_FALLBACK, "失败时用固定兜底 URL");
    assert.equal(a.props.target, "_blank");
    assert.ok(nodeWithText(tree, "🚀 升级 PRO") || nodeWithText(tree, "🔄 续费会员") || nodeWithText(tree, "🚀 转正式 PRO"),
      "失败不影响购买流程：主按钮照常渲染");
  }
});

test("⑤ 「连接偏慢」双路块里的购买路旁也有协议链接，且与账号卡同一 URL", async () => {
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
  assert.ok(dual, "前提：慢连接时双路块应出现");
  const inDual = find(dual, (n) => n.props && n.props.className === "dru-legal-a" && typeof n.props.href === "string");
  assert.ok(inDual, "双路块的购买（升级）路旁必须有协议链接");
  assert.equal(inDual.props.href, AGREEMENT_ABS);
  // 账号卡那份也在 → 同页两处；两处 href 一致（同一个来源，不能各写各的）
  const all = [];
  walk(tree, (n) => { if (n.props && n.props.className === "dru-legal-a" && typeof n.props.href === "string") all.push(n); });
  assert.ok(all.length >= 2, `应至少两处（账号卡 + 双路块），实际 ${all.length}`);
  for (const a of all) assert.equal(a.props.href, AGREEMENT_ABS, "同一页面各处 URL 必须一致");
});

test("⑥ 未登录 → 不展示协议链接、也不请求协议地址（购买入口不存在时不该出现）", async () => {
  const plugin = loadPlugin({
    status: {
      ok: true,
      config: { phone: "", hasPhone: false, mode: "saas", deviceId: "dev-x" },
      service: { running: false },
      remoteUrl: "https://relay.test/app/",
    },
  });
  const tree = await plugin.settle(4);
  assert.equal(agreementLink(tree), undefined, "未登录没有购买入口，自然不该出现协议链接");
  assert.equal(plugin.agreementRequests().length, 0, "未登录不该请求协议地址");
});

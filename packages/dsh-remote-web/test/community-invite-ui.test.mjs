// 🎉 企微交流群引导（使用满 2 小时弹一次）—— **浏览器半**（lib/client.js 面板）行为回归。
//
// 背景（业主 2026-10-23）：用户实际使用满 2 小时后要弹一次「加入企业微信群」引导，
// 每用户全局只弹一次；手机 Web 端已完成，桌面端插件面板复用同一套企业端接口
// （桌面端没有用户 token 直连，走 node 半 /dsh-remote/community-invite/* 代理，见 proxy 用例）。
//
// 本文件把几件容易写错的事钉死：
//   ① 弹不弹**完全由服务端 show 决定**（前端绝不自己算时长）；show=false 时绝不能弹；
//   ② 每桌面会话只弹一次（sessionStorage + 内存），服务端 already_shown 是第二道保险；
//   ③ 「看过即算」：弹层一显示就 POST shown（幂等）；两个按钮关闭时再调一次同样幂等；
//   ④ 任何失败（接口 500/网络断/字段缺失）静默降级：不弹、不报错、不阻塞面板；
//   ⑤ qr_url 为空 / 二维码图片加载失败 → 隐藏图片但**保留文案与按钮**（不出现空白二维码区）。
//
// 做法与 community-qr-ui.test.mjs 一致：真脚本 + vm + 迷你 React（真实 useEffect）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const QR_ABS = "https://relay.test/relay-api/qr/group-qr.png";

/** 找到自动弹层（aria-label 精确锁定，避免和「加入交流群」按钮弹窗混淆）。 */
function inviteCard(tree) {
  return find(tree, (n) => n.props && n.props["aria-label"] === "加入用户交流群");
}
/** 弹层按钮（按文案找 onClick）。 */
function modalButton(tree, label) {
  const card = inviteCard(tree);
  assert.ok(card, "弹层不存在");
  const btn = find(card, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes(label)));
  assert.ok(btn, `弹层里找不到「${label}」按钮`);
  return btn;
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


test("① 服务端 show=false（未满 2h/已弹过/没配二维码）→ 不弹、不上报、不留会话标记", async () => {
  const plugin = loadPlugin({ invite: { ok: true, show: false, reason: "not_enough_usage", used_seconds: 3600, required_seconds: 7200, qr_url: QR_ABS } });
  const tree = await plugin.settle(4);
  assert.equal(plugin.statusRequests().length, 1, "应该问过一次服务端");
  assert.equal(inviteCard(tree), undefined, "show=false 时绝不能弹");
  assert.ok(!textHas(tree, "加入用户交流群"), "面板任何位置都不应该出现引导标题");
  assert.equal(plugin.shownRequests().length, 0, "没展示就不该上报 shown");
  assert.equal(plugin.sessionStorage.getItem("dsh-remote-community-invite-seen-v1"), null,
    "不弹时不能留会话标记 —— 否则用户这次没看到，下次也永远不弹了");
});

test("② show=true → 弹层内容精确 + 展示即上报 shown；「稍后再看」关闭并幂等再报；重渲染不重复弹", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle(4);
  const card = inviteCard(tree);
  assert.ok(card, "服务端 show=true 必须弹出引导");

  // 文案/二维码：标题、正文、按钮、图片都是业主定的
  assert.ok(textHas(tree, "🎉 加入用户交流群"), "标题必须是「🎉 加入用户交流群」");
  assert.ok(textHas(tree, "在群里可以交流使用心得、提想法和建议，遇到问题也更容易找到我们"), "文案必须原样出现");
  assert.ok(find(tree, (n) => n.props?.className === "dru-community-qr"), "应有二维码图片");
  const img = find(tree, (n) => n.props?.className === "dru-community-qr");
  assert.equal(img.props.src, QR_ABS, "二维码用 node 半下发的绝对地址");
  assert.equal(img.props.alt, "用户交流群二维码");

  // 展示即算：一显示就 POST shown（用户直接关页面也不会被反复骚扰）
  assert.equal(plugin.shownRequests().length, 1, "弹层显示时就应上报 shown");
  assert.equal(plugin.shownRequests()[0].method, "POST");
  // 本次桌面会话标记已写
  assert.equal(plugin.sessionStorage.getItem("dsh-remote-community-invite-seen-v1"), "1");

  // 点「稍后再看」→ 关闭（关闭逻辑**同样调用** shown 上报，只是本地幂等标记已置位 → 不重复打网络）
  modalButton(tree, "稍后再看").props.onClick();
  tree = plugin.render();
  assert.equal(inviteCard(tree), undefined, "点「稍后再看」后弹层应关闭");
  assert.equal(plugin.shownRequests().length, 1, "展示时已成功上报过 → 关闭不重复请求（本地幂等标记；上报失败时会补报，见用例⑨）");
  tree = await plugin.settle(3);
  assert.equal(inviteCard(tree), undefined, "同一桌面会话内不得再次弹出");
  assert.equal(plugin.statusRequests().length, 1, "不得重复询问服务端");
});

test("③ 点「加入交流群」同样只关闭 + 幂等上报（不跳转、不新增请求）", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle(4);
  assert.ok(inviteCard(tree));
  const ciBefore = plugin.requests.filter((r) => String(r.path).startsWith("/dsh-remote/community-invite")).length;
  modalButton(tree, "加入交流群").props.onClick();
  const after = plugin.render();
  assert.equal(inviteCard(after), undefined, "点「加入交流群」后弹层应关闭");
  assert.equal(plugin.shownRequests().length, 1, "展示时已上报过 → 本地幂等标记使关闭时不重复请求");
  // 关闭动作本身不产生任何 community-invite 请求（没有跳转、没有二次上报）
  assert.equal(
    plugin.requests.filter((r) => String(r.path).startsWith("/dsh-remote/community-invite")).length,
    ciBefore,
    "关闭不应产生额外上报/查询（幂等上报只在展示时/失败补报时发生）"
  );
});

test("④ qr_url 为空 → 仍然弹（文案/按钮保留），但不出现空白二维码区", async () => {
  const plugin = loadPlugin({ invite: { ok: true, show: true, reason: "ok", used_seconds: 7300, required_seconds: 7200, qr_url: "" } });
  const tree = await plugin.settle(4);
  assert.ok(inviteCard(tree), "二维码不可用不能连引导一起吞掉");
  assert.ok(textHas(tree, "🎉 加入用户交流群"));
  assert.ok(textHas(tree, "在群里可以交流使用心得、提想法和建议，遇到问题也更容易找到我们"));
  assert.ok(!find(tree, (n) => n.props?.className === "dru-community-qr"), "qr 为空时不应渲染 <img>（否则是空白块）");
  assert.ok(textHas(tree, "二维码暂不可用"), "应给出可读的降级说明");
  assert.ok(modalButton(tree, "加入交流群") && modalButton(tree, "稍后再看"), "两个按钮都要在");
});

test("⑤ 二维码图片加载失败 → 只隐藏图片，文案与按钮保留", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle(4);
  const img = find(tree, (n) => n.props?.className === "dru-community-qr");
  assert.ok(img, "前提：有二维码图片");
  assert.equal(typeof img.props.onError, "function", "图片必须有 onError 兜底");
  const target = { style: {} };
  img.props.onError({ target });
  assert.equal(target.style.display, "none", "加载失败应隐藏图片（不能留个破图）");
  assert.ok(textHas(tree, "🎉 加入用户交流群"), "文案仍在");
  assert.ok(modalButton(tree, "稍后再看"), "按钮仍在");
});

test("⑥ 接口失败（500 / 网络异常）→ 静默：不弹、不报错、面板正常渲染", async () => {
  for (const opts of [{ inviteStatus: 500 }, { inviteReject: true }]) {
    const plugin = loadPlugin(opts);
    const tree = await plugin.settle(4);
    assert.equal(plugin.statusRequests().length, 1, "仍然问过一次服务端");
    assert.equal(inviteCard(tree), undefined, "失败时绝不弹");
    assert.ok(textHas(tree, "远程访问"), "面板本身必须正常渲染（失败静默，不阻塞主流程）");
    assert.equal(plugin.shownRequests().length, 0, "没展示就不该上报");
    assert.equal(plugin.sessionStorage.getItem("dsh-remote-community-invite-seen-v1"), null,
      "失败不能消耗'本次会话已弹'标记 —— 下次还有机会");
  }
});

test("⑦ 本次桌面会话已弹过（sessionStorage 标记）→ 连 status 都不再请求", async () => {
  const plugin = loadPlugin();
  plugin.sessionStorage.setItem("dsh-remote-community-invite-seen-v1", "1");
  const tree = await plugin.settle(4);
  assert.equal(plugin.statusRequests().length, 0, "已弹过就不该再问服务端（每会话一次）");
  assert.equal(inviteCard(tree), undefined);
});

test("⑧ 自建/local 模式不弹，也不请求 community-invite（没有企业端账号体系）", async () => {
  const plugin = loadPlugin({
    status: {
      ok: true,
      config: { mode: "local", hasLocalKey: true, phone: "", hasPhone: false, deviceId: "dev-x" },
      service: { running: true },
      remoteUrl: "https://127.0.0.1:3080/",
    },
  });
  const tree = await plugin.settle(4);
  assert.equal(plugin.statusRequests().length, 0, "local 模式不该请求企业端接口");
  assert.equal(inviteCard(tree), undefined);
});

test("⑨ shown 首次上报失败 → 关闭时再补一次（幂等重试，不影响关闭）", async () => {
  const plugin = loadPlugin({ inviteShownFail: true });
  const tree = await plugin.settle(4);
  assert.ok(inviteCard(tree), "上报失败不影响展示（看过即算的展示才是弹不弹的依据）");
  assert.equal(plugin.shownRequests().length, 1);
  modalButton(tree, "稍后再看").props.onClick();
  const after = plugin.render();
  assert.equal(inviteCard(after), undefined, "即使上报失败也必须能关掉");
  assert.equal(plugin.shownRequests().length, 2, "关闭时应补报一次（服务端幂等）");
});

test("⑩ 未登录 → 不请求 community-invite（面板登录后才问）", async () => {
  const plugin = loadPlugin({
    status: {
      ok: true,
      config: { phone: "", hasPhone: false, mode: "saas", deviceId: "dev-x" },
      service: { running: false },
      remoteUrl: "https://relay.test/app/",
    },
  });
  const tree = await plugin.settle(4);
  assert.equal(plugin.statusRequests().length, 0, "未登录不该调用（node 半也会静默拒绝，但前端先别打）");
  assert.equal(inviteCard(tree), undefined);
});

// 📣 公告（插件端）回归：徽标 / 面板入口 / 电脑端弹窗 / 已读上报 / 一条铁律（**不轮询**）。
//
// 契约：dsh-relay-enterprise/docs/announcements-contract.md（冻结 v1）+ 926 迭代 §1（client=desktop）。
//   GET  /dsh-remote/announcements?client=desktop → { bubble_enabled, items[], unread_count, popup|null }
//   POST /dsh-remote/announcements/click { id }   → 记 clicked_at（**现契约只有 /click，没有 /read**）
//
// 这个文件锁的是**客户端纪律**（服务端行为另有 enterprise 侧的用例）：
//   ① 有未读 → 侧栏入口出现数字徽标 + 面板出现「📣 公告」卡；
//   ② bubble_enabled:false / 字段缺失 → 一个入口都不出现（fail closed）；items 缺失当空数组；
//   ③ 接口 404 或不可达 → 不显示任何入口、**且不抛**（客户端插件抛异常 = 整个 web app 起不来）；
//   ④ 点一条公告 → 发 POST /dsh-remote/announcements/click；
//   ⑤ 弹窗 close/✕/「已读」任意入口 = 关闭 + 上报（同一个收尾函数）；
//   ⑥ popup 的本地防抖 = 「同 id + 60s」：60s 内不再弹、61s 后可以再弹；
//   ⑦ **绝不轮询**：`GET /api/announcements` 是"判定即记账"（命中弹窗候选就写 shown_at），
//      多拉一次就可能把该弹的公告静默消耗掉 —— 每次页面加载只能自动拉一次。
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
/** 找到"文字是 substr 且可点"的那颗按钮（按钮文字可能被包在 span 里，所以两处都看）。 */
function nodeWithText(tree, substr) {
  return find(tree, (node) => typeof node.props?.onClick === "function" &&
    ((node.children || []).some((c) => typeof c === "string" && c.includes(substr)) ||
     (node.children || []).some((c) => c && typeof c === "object" && (c.children || []).some((s) => typeof s === "string" && s.includes(substr)))));
}
/** 同上，但**深度**遍历子树里的所有文本（公告条目把标题放在 span > span 里）。 */
function clickableWithDeepText(tree, substr) {
  return find(tree, (node) => {
    if (typeof node.props?.onClick !== "function") return false;
    let hit = false;
    walk(node, (n) => {
      if (!hit && (n.children || []).some((c) => typeof c === "string" && c.includes(substr))) hit = true;
    });
    return hit;
  });
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 迷你 React（真实 useEffect + 假定时器 + 可控时钟）+ 假 fetch。
 * @param {object} opts
 *   - announcements：GET /dsh-remote/announcements 的响应（可以是函数，按第 N 次调用返回不同结果）
 *   - storage：跨"页面加载"共享的 localStorage（模拟同一个 origin 反复开页面）
 *   - clock：可推进的时钟对象（测试里用来验证 60s 防抖窗口）
 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const requests = [];

  let clock = 0;
  let timerSeq = 1;
  const timers = new Map();
  const job = (fn) => { try { fn(); } catch (e) { /* 断言会暴露问题 */ } };
  const fakeSetTimeout = (fn, ms) => { const id = timerSeq++; timers.set(id, { at: clock + (Number(ms) || 0), fn, every: 0 }); return id; };
  const fakeSetInterval = (fn, ms) => { const id = timerSeq++; const every = Math.max(1, Number(ms) || 1); timers.set(id, { at: clock + every, fn, every }); return id; };
  const fakeClear = (id) => { timers.delete(id); };

  const scopes = new Map();
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

  const status = opts.status || {
    ok: true,
    config: { phone: "138****0000", hasPhone: true, mode: "saas", deviceId: "dev-x" },
    service: { running: true },
  };
  const response = (s, body) => Promise.resolve({ ok: s >= 200 && s < 300, status: s, text: async () => JSON.stringify(body) });
  // announcements 可以是数组（按第 N 次 GET 依次取，越界用最后一项）或固定对象
  const annSeq = Array.isArray(opts.announcements) ? opts.announcements.slice() : null;
  const annFixed = annSeq ? null : (opts.announcements !== undefined
    ? opts.announcements
    : { ok: true, bubble_enabled: true, unread_count: 2, items: [
        { id: 3, title: "新功能上线", body: "扫码登录更快了", image: "", pinned: 1, created_at: 1758500000000, unread: true },
        { id: 4, title: "维护通知", body: "周日凌晨维护", image: "", pinned: 0, created_at: 1758400000000, unread: true },
      ], popup: null });
  let annCalls = 0;

  const makeEl = () => ({
    tag: "div", children: [], style: {}, className: "", attributes: {}, textContent: "",
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    querySelector(sel) {
      const cls = String(sel || "").replace(/^\./, "");
      return this.children.find((c) => String(c.className || "").split(/\s+/).includes(cls)) || null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  });
  // 侧栏「📱 远程访问」入口：本插件的徽标逻辑要求它**存在**（否则 annRenderNavBadge 会静默跳过）。
  // 这里先备好这个节点，document.getElementById 对它的 id 返回它 —— 模拟"官方设置按钮已渲染、入口已注入"。
  const navBtn = makeEl();
  navBtn.id = "dru-nav-remote";
  const doc = {
    hidden: false,
    createElement: makeEl,
    head: makeEl(),
    body: makeEl(),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) { return id === "dru-nav-remote" ? navBtn : null; },
    addEventListener() {}, removeEventListener() {},
  };
  class MutationObserverMock { constructor() {} observe() {} disconnect() {} }

  const store = opts.storage || new Map();
  const localStorage = {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
  const sessionStore = new Map();
  const sessionStorage = {
    getItem(k) { return sessionStore.has(k) ? sessionStore.get(k) : null; },
    setItem(k, v) { sessionStore.set(k, String(v)); },
    removeItem(k) { sessionStore.delete(k); },
  };

  // 可推进时钟：Date.now() 与 new Date() 都跟着 opts.clock.now 走（fmtDate 需要它）
  const clockRef = opts.clock || { now: 1758500000000 };
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(clockRef.now); else super(...args); }
    static now() { return clockRef.now; }
  }

  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } }, open() { return null; } },
    document: doc,
    localStorage,
    sessionStorage,
    MutationObserver: MutationObserverMock,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClear,
    setInterval: fakeSetInterval,
    clearInterval: fakeClear,
    fetch(path, options = {}) {
      requests.push({ path, method: options.method || "GET", body: options.body || "" });
      if (path === "/dsh-remote/status") return response(200, status);
      if (path === "/dsh-remote/community") return response(200, { ok: true, qrcode: "", wechat: "" });
      if (path.startsWith("/dsh-remote/announcements/click")) return response(200, { ok: true });
      if (path.startsWith("/dsh-remote/announcements")) {
        annCalls += 1;
        const entry = annSeq ? (annSeq[Math.min(annCalls - 1, annSeq.length - 1)]) : annFixed;
        if (entry && entry.__status) return response(entry.__status, entry.body || { ok: false });
        return response(200, entry);
      }
      return response(200, { ok: true });
    },
    Set, Symbol, Date: FakeDate, JSON, Math, Number, String, Object, Array, console,
  };

  vm.runInNewContext(SOURCE, sandbox);
  const plugin = moduleFactory((name) => {
    assert.equal(name, "react");
    return react;
  });
  const applied = { threw: null };
  try {
    plugin.apply({
      slots: {
        inject(name, cb) { cb(); },
        register(meta, component) { registered.set(meta.id, component); return () => {}; },
      },
    });
  } catch (e) {
    applied.threw = e;
  }

  return {
    requests,
    registered,
    navBtn,
    applied,
    annCalls: () => annCalls,
    setClock(ms) { clockRef.now = ms; },
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
    /** 单独渲染 shell.overlay 上的公告弹窗（它在真实环境里与面板是两棵树）。 */
    renderPopup() {
      const comp = registered.get("dsh-announcement-popup");
      if (!comp) return null;
      return renderNode({ type: comp, props: {}, children: [] }, "popup");
    },
  };
}

// ───────────────────────────── ① 有未读 → 徽标 + 面板入口 ─────────────────────────────

test("未读公告 → 侧栏入口出现数字徽标；设置面板出现「📣 公告」卡（含条目与未读标签）", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();

  // 侧栏徽标（DOM，不走 React）：annEmit 之后挂到 #dru-nav-remote 上
  const badge = plugin.navBtn.children.find((c) => c.className === "dru-nav-remote-badge");
  assert.ok(badge, "侧栏「📱 远程访问」入口上应出现未读徽标");
  assert.equal(badge.textContent, "2", "徽标显示未读条数");

  // 面板卡片 + 两个条目 + 标题
  assert.ok(textHas(tree, "📣 公告"), "面板应出现公告卡");
  assert.ok(textHas(tree, "新功能上线"), "应列出第一条公告标题");
  assert.ok(textHas(tree, "维护通知"), "应列出第二条公告标题");
  assert.ok(textHas(tree, "未读"), "未读条目应有「未读」文字标签（不靠颜色单独表意）");
  assert.ok(textHas(tree, "置顶"), "pinned 条目应有「置顶」标签");
  assert.ok(textHas(tree, "2 条未读"), "卡片标题应带未读数");
});

test("未读数 > 9 → 徽标显示 9+（不能把 12 挤成一个宽数字）", async () => {
  const plugin = loadPlugin({
    announcements: {
      ok: true, bubble_enabled: true, unread_count: 12,
      items: [{ id: 1, title: "A", body: "", image: "", pinned: 0, created_at: 0, unread: true }],
      popup: null,
    },
  });
  await plugin.settle();
  const badge = plugin.navBtn.children.find((c) => c.className === "dru-nav-remote-badge");
  assert.ok(badge, "应有徽标");
  assert.equal(badge.textContent, "9+");
});

// ───────────────────────── ② bubble_enabled:false / 字段缺失 → 无入口 ─────────────────────────

test("bubble_enabled:false → 面板无入口、侧栏无徽标（后台把入口关掉就是不显示）", async () => {
  const plugin = loadPlugin({
    announcements: {
      ok: true, bubble_enabled: false, unread_count: 3,
      items: [{ id: 1, title: "不该出现", body: "", image: "", pinned: 0, created_at: 0, unread: true }],
      popup: null,
    },
  });
  const tree = await plugin.settle();
  assert.ok(!textHas(tree, "不该出现"), "入口关闭时不得渲染任何公告条目");
  assert.ok(!textHas(tree, "📣 公告"), "入口关闭时不得渲染公告卡");
  assert.equal(plugin.navBtn.children.filter((c) => c.className === "dru-nav-remote-badge").length, 0, "入口关闭时不得有徽标");
});

test("字段缺失（无 bubble_enabled / 无 items / 无 unread_count）→ 一律 fail closed，且不抛", async () => {
  const plugin = loadPlugin({ announcements: { ok: true } });   // 极端的老/坏响应
  const tree = await plugin.settle();
  assert.equal(plugin.applied.threw, null, "客户端插件绝不能抛（会拖垮整个 web app）");
  assert.ok(!textHas(tree, "📣 公告"), "bubble_enabled 缺失 = false → 不显示入口");
  assert.ok(textHas(tree, "远程访问"), "面板自身照常渲染");
});

// ───────────────────────────── ③ 404 / 不可达 → 无入口且不抛 ─────────────────────────────

test("接口 404（老服务端）→ 无入口、无弹窗、不抛", async () => {
  const plugin = loadPlugin({ announcements: { __status: 404, body: { error: { code: "not_found" } } } });
  const tree = await plugin.settle();
  assert.equal(plugin.applied.threw, null, "404 时插件装载不得抛异常");
  assert.ok(!textHas(tree, "📣 公告"), "拿不到公告时不得显示空入口");
  assert.equal(plugin.renderPopup(), null, "拿不到公告时不得弹窗");
  assert.ok(textHas(tree, "远程访问"), "面板其它部分照常可用");
});

test("接口不可达（fetch reject）→ 无入口且不抛", async () => {
  // 用 __status: 0 + 让 text() 抛异常，模拟"网络直接断了"
  const plugin = loadPlugin({ announcements: { __status: 500, body: { ok: false } } });
  const tree = await plugin.settle();
  assert.equal(plugin.applied.threw, null, "上游 5xx 时插件装载不得抛异常");
  assert.ok(!textHas(tree, "📣 公告"), "拉取失败不得显示入口");
});

// ───────────────────────────── ④ 点公告 → 上报 click ─────────────────────────────

test("点一条未读公告 → 立刻 POST /dsh-remote/announcements/click（带 id），并展开详情", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  const item = clickableWithDeepText(tree, "新功能上线");
  assert.ok(item, "应能点到公告条目");

  item.props.onClick();
  tree = await plugin.settle();

  const click = plugin.requests.find((r) => r.path === "/dsh-remote/announcements/click");
  assert.ok(click, "点公告必须上报点击（现契约只有 /click，没有 /read）");
  assert.equal(click.method, "POST", "点击上报必须是 POST");
  assert.equal(JSON.parse(click.body).id, 3, "请求体必须带该条公告的 id");
  assert.ok(textHas(tree, "已读状态已同步到后台"), "点击后应展开详情弹窗");
  assert.ok(textHas(tree, "扫码登录更快了"), "详情应展示公告正文");
});

// ───────────────────── ⑤ / ⑦ 弹窗：任意入口都关闭 + 上报 ─────────────────────

test("电脑端弹窗：点「✕」即关闭并上报（任意按钮/遮罩都走同一个已读收尾）", async () => {
  const plugin = loadPlugin({
    announcements: {
      ok: true, bubble_enabled: true, unread_count: 1,
      items: [{ id: 7, title: "弹窗公告", body: "正文", image: "", pinned: 0, created_at: 0, unread: true }],
      popup: { id: 7, title: "弹窗公告", body: "正文", image: "" },
    },
  });
  await plugin.settle();
  let popup = plugin.renderPopup();
  assert.ok(popup, "有 popup 时应出现电脑端弹窗");
  assert.ok(textHas(popup, "弹窗公告"), "弹窗应展示公告标题");

  const x = find(popup, (n) => n.props?.className === "dru-popup-x");
  assert.ok(x, "弹窗应有 ✕");
  x.props.onClick();
  await flush();
  await flush();

  const click = plugin.requests.find((r) => r.path === "/dsh-remote/announcements/click");
  assert.ok(click, "关闭弹窗必须上报已读（POST /click）");
  assert.equal(JSON.parse(click.body).id, 7);
  assert.equal(plugin.renderPopup(), null, "关闭后弹窗必须消失");
});

test("电脑端弹窗：点底部「已读」按钮同样关闭并上报（两个按钮同一个收尾）", async () => {
  const plugin = loadPlugin({
    announcements: {
      ok: true, bubble_enabled: true, unread_count: 1,
      items: [{ id: 8, title: "T", body: "", image: "", pinned: 0, created_at: 0, unread: true }],
      popup: { id: 8, title: "T", body: "", image: "" },
    },
  });
  await plugin.settle();
  const popup = plugin.renderPopup();
  const btn = nodeWithText(popup, "已读");
  assert.ok(btn, "弹窗应有「已读」按钮");
  btn.props.onClick();
  await flush();
  await flush();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/announcements/click"));
  assert.equal(plugin.renderPopup(), null);
});

// ───────────────────── ⑥ popup 本地防抖：同 id + 60s 时间窗 ─────────────────────

test("弹窗防抖：同一条公告 60s 内不再弹、61s 后可以再弹（不把服务端的 always 压成 once）", async () => {
  const clock = { now: 1758500000000 };
  const storage = new Map();   // 跨"页面加载"共享（模拟同一个 origin 反复打开）
  const popupResp = {
    ok: true, bubble_enabled: true, unread_count: 0, items: [],
    popup: { id: 42, title: "重复弹", body: "", image: "" },
  };

  // 第 1 次页面加载：弹出来 → 关掉（记为已读，落本地防抖记忆）
  const p1 = loadPlugin({ announcements: popupResp, storage, clock });
  await p1.settle();
  const popup1 = p1.renderPopup();
  assert.ok(popup1, "第一次应弹出");
  nodeWithText(popup1, "已读").props.onClick();
  await flush(); await flush();

  // 第 2 次页面加载（+30s）：服务端**仍然**返回同一条（= always 模式的真实形态）→ 本地必须挡住
  clock.now += 30 * 1000;
  const p2 = loadPlugin({ announcements: popupResp, storage, clock });
  await p2.settle();
  assert.equal(p2.renderPopup(), null, "60s 内同一条不得重复弹（防打扰）");

  // 第 3 次页面加载（+61s）：窗口过了 → 允许再弹（否则等于把服务端的 always 静默压成 once）
  clock.now += 31 * 1000;
  const p3 = loadPlugin({ announcements: popupResp, storage, clock });
  await p3.settle();
  assert.ok(p3.renderPopup(), "超过 60s 后同一条应可再次弹出");
});

test("once 模式：服务端不再返回该条 → 后续页面加载都不弹（本地无需永久记忆也等价）", async () => {
  const clock = { now: 1758500000000 };
  const storage = new Map();
  const first = {
    ok: true, bubble_enabled: true, unread_count: 0, items: [],
    popup: { id: 5, title: "只此一次", body: "", image: "" },
  };
  const later = { ok: true, bubble_enabled: true, unread_count: 0, items: [], popup: null };

  const p1 = loadPlugin({ announcements: first, storage, clock });
  await p1.settle();
  assert.ok(p1.renderPopup(), "第一次应弹出");
  nodeWithText(p1.renderPopup(), "关闭").props.onClick();
  await flush(); await flush();

  clock.now += 10 * 60 * 1000;   // 十分钟后重开页面
  const p2 = loadPlugin({ announcements: later, storage, clock });
  await p2.settle();
  assert.equal(p2.renderPopup(), null, "服务端不再给 → 永远不再弹");
});

// ───────────────────────────── ⑧ 绝不轮询 ─────────────────────────────

test("绝不轮询：每次页面加载只自动拉一次公告（重复拉会吃掉该弹的公告）", async () => {
  const plugin = loadPlugin();
  await plugin.settle(4);   // 多渲染几轮，任何"render 里顺手拉一次"的实现都会在这里暴露
  const gets = plugin.requests.filter((r) => r.path === "/dsh-remote/announcements?client=desktop");
  assert.equal(gets.length, 1, "自动拉取必须只有一次（服务端 GET 是判定即记账）");
  assert.equal(plugin.annCalls(), 1);
  // 而且必须带 client=desktop（926 迭代 §1：桌面端只拿 target=desktop/both 的公告）
  assert.ok(gets[0].path.includes("client=desktop"), "必须显式声明 client=desktop");
});

test("源码级：面板卡片里的「刷新公告」是唯一的手动重拉入口，且**不**用于弹窗", () => {
  assert.match(SOURCE, /annPullOnce/, "必须有 sessionStorage 一次性拉取标记");
  assert.match(SOURCE, /openPopup:\s*false/, "手动刷新必须显式关闭弹窗（openPopup:false）");
  // 一次性标记必须写在 sessionStorage（localStorage 的 origin 会随端口变，挡不住同页重复拉）
  const fn = SOURCE.slice(SOURCE.indexOf("function annPullOnce("), SOURCE.indexOf("function annReportClick("));
  assert.match(fn, /sessionStorage/, "一次性标记必须在 sessionStorage 上");
  assert.match(fn, /ANN_PULLED_KEY/);
});

// ───────────────────────── 契约细节：客户端身份维度与上报路径 ─────────────────────────

test("源码级：已读上报走 /dsh-remote/announcements/click（不是 /read）", () => {
  assert.match(SOURCE, /\/dsh-remote\/announcements\/click/);
  assert.doesNotMatch(SOURCE, /announcements\/read/, "现契约没有 /read —— 不许自造接口");
});

test("微信机器人引导：两步走引导块在能力清单之上（DOM 顺序）+ 命令帮助与 HELP_TEXT 对账", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  // 进入微信机器人 tab（未登录时不渲染这个 tab，所以先确认它在）
  const tab = nodeWithText(tree, "微信机器人通道");
  assert.ok(tab, "应有「微信机器人通道」tab");
  tab.props.onClick();
  tree = await plugin.settle();

  const embed = find(tree, (n) => n.props?.className === "dru-wx-embed");
  assert.ok(embed, "前提：已进入微信 tab");
  // ① DOM 顺序：引导块（干什么用 + 两步怎么做）必须排在能力清单（.dru-wx-intro）**之上** ——
  //    先讲"这是什么、我要做哪两步"，再讲"我能用哪些能力"。CSS 里的先后不算数，看渲染树。
  assert.equal(embed.children[0]?.props?.className, "dru-wx-guide",
    "「两步走」引导必须是内容体第一个孩子（在能力清单之前）");
  assert.equal(embed.children[1]?.props?.className, "dru-wx-intro",
    "能力清单必须紧随引导块之后");
  const guide = embed.children[0];
  for (const s of ["微信机器人是做什么的", "第一步", "第二步", "ClawBot", "24 小时", "连接新的 OpenClaw"]) {
    assert.ok(textHas(guide, s), "引导块必须包含：" + s);
  }
  // ② 命令帮助**复用** wechat-channel.mjs 的 HELP_TEXT（跨 bundle 没有 require 通道 → 镜像 + 逐条对账）
  const helpSrc = readFileSync(new URL("../../../clients/dsh-remote/wechat-channel.mjs", import.meta.url), "utf8");
  const m = helpSrc.match(/export const HELP_TEXT = \[([\s\S]*?)\]\.join\("\\n"\)/);
  assert.ok(m, "必须能从 wechat-channel.mjs 抠出 HELP_TEXT");
  const lines = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  const cmds = lines.filter((line) => line.trim().startsWith("/"));
  assert.ok(cmds.length >= 8, "HELP_TEXT 里应当有一批 /指令 行，实际 " + cmds.length);
  for (const line of cmds) {
    const cmd = line.split(/\s+/)[0];
    assert.ok(SOURCE.includes(cmd), "面板引导必须覆盖 HELP_TEXT 里的指令：" + cmd);
  }
  // ③ 引导块在**未绑定**态就可见（它是绑定的理由），且不依赖任何图片资源（可缺省）
  assert.ok(textHas(guide, "/help"), "命令清单应直接列在引导块里");
});

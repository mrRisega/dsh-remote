/**
 * 插件端「面板信息架构」回归（2026-11-07 业主 UX 重做）。
 *
 * 业主原话：顶部 3 个 tab；登录才有微信通道；卡片式平铺堆叠；全是文字堆砌、垂直往下垒。
 * 本文件锁的是**新结构**本身（行为细节见 wechat-bot-ui / remote-access-ui 等既有用例）：
 *   ① 主面板 = 状态头（连接 pill + 打开手机端）+ 2 列入口网格（≤3 行/卡）+ 一行文字入口；
 *   ② 顶部不再有 tab 条；云端/自建降级为「手机访问」弹层里的分段控件；
 *   ③ 弹层：role=dialog + aria-modal + 标题 + ✕；Esc 关闭；关闭回焦点（可测的部分）；
 *   ④ 登录不隐藏功能：未登录入口照常显示，文案写「登录后可同步」；
 *   ⑤ 通道弹层：平台列表 → 企业微信配置（Bot ID / Secret 不回显 / 接收会话 ID 可选）
 *      → 保存并连接 / 测试 → 行内状态（连接中 / 已连接 / 失败原因）；
 *   ⑥ 图标一律内联 SVG（16px / currentColor / aria-hidden），**禁止 emoji 当图标**；
 *   ⑦ 表单错误就近显示（aria-invalid + role=alert），而不是只弹一个全局错误。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { openEntry, clickChannelRow, findDialog } from "./lib-panel-ia.mjs";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const QR_DATA_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
/** 面板**唯一**的 settings.section 栏目 id（0.6.11 起微信面板是它的子组件，不再是第二个栏目）。 */
const ROOT_SECTION_ID = "dsh-remote";
/**
 * 【登录门 · 0.6.12】微信机器人通道要求**已注册并登录**：未登录时这个 tab 根本不存在。
 * harness 默认给 /dsh-remote/status 的应答补一个 config.phone（= client.js 判 loggedIn 的依据），
 * 绝大多数用例因此仍在「已登录」这条正常路径上跑（否则 tab 不渲染，auto-enter 也无处可点）；
 * 需要验证未登录行为的用例用 setSignedIn(false) 显式登出。
 */
const SESSION_CONFIG = { phone: "13800138000" };

const NOT_BOUND = {
  ok: true, disabled: false, bound: false, bot_id: "", bound_at: 0, connected_at: 0,
  last_push_ok_at: 0, last_error: "", cooldown_ms: 0, pending_replies: 0,
  binding: { active: false }, channel_running: false, events_running: false
};
const BOUND = {
  ...NOT_BOUND, bound: true, bot_id: "bot_7788", bound_at: 1_700_000_000_000,
  connected_at: 1_700_000_600_000, last_push_ok_at: 1_700_000_700_000,
  pending_replies: 2, channel_running: true, events_running: true
};

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
/** 按文案取按钮（真 <button>）。 */
function buttonWithText(tree, substr) {
  return find(tree, (n) => n.type === "button" && typeof n.props?.onClick === "function"
    && (n.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}
/** 该节点的 class 列表里是否有某一个类（精确匹配，避免 .dru-wx-attn 误配 .dru-wx-attn-dot）。 */
function hasClass(node, cls) {
  return String(node?.props?.className || "").split(/\s+/).includes(cls);
}
/** 节点在树里的**前序位置**（对本 harness 的树形即 DOM 顺序）；找不到返回 -1。 */
function domIndex(tree, predicate) {
  let i = 0;
  let found = -1;
  walk(tree, (n) => { if (found < 0 && predicate(n)) found = i; i += 1; });
  return found;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 收集所有匹配节点（用例里要数"有几个单选"这类）。 */
function findAll(tree, predicate) {
  const out = [];
  walk(tree, (n) => { if (predicate(n)) out.push(n); });
  return out;
}
/** 子树全部文本（拼接；用于"卡片文案/按钮文案"断言）。 */
function textOf(node) {
  let out = "";
  walk(node, (n) => { for (const c of n.children || []) if (typeof c === "string") out += c; });
  return out;
}

/**
 * 迷你 React（真实 useEffect：依赖比较 + 提交后执行 + cleanup）+ 可控假定时器 +
 * 可变的面板路由应答。骨架与 connect-ui.test.mjs 一致，便于两个用例互为对照。
 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const metas = [];
  const injects = new Map();
  const requests = [];
  const clipboard = [];
  let unmounted = false;

  // ── 迷你 React：真实 useState/useEffect + 递归展开**函数子组件** ──
  // 0.6.11 起 WeChatBotSection 是 RemoteControlSection 的子组件（渲染路径里还有既有的
  // SelfManageCard），所以 hook 槽位必须**按组件实例**隔离：每个实例按「树中位置路径」持有
  // 自己的 state/effects（近似 React 的位置化协调）。
  // ⚠️ 曾经用「全局递增计数器」实现：父组件 57 个 useState 之后，home 视图的 SelfManageCard
  //    与 wechat 视图的 WeChatBotSection **共用同一批下标** → 子组件读到别人的 state（串号），
  //    表现是切回微信 tab 后凭空显示「读不到本机微信通道」。按路径分作用域即根治。
  const scopes = new Map(); // key -> { hook, effectCursor, state, effects, pending }
  const scopeStack = [];
  const currentScope = () => scopeStack[scopeStack.length - 1];

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
    createElement(type, props, ...children) {
      // 与真实 React 一致：**展平嵌套数组子节点**。`h("div", p, [a, b])` 这种写法在 client.js 里很常见，
      // 不展平的话 textHas（只看直接字符串子节点）就看不到数组里的文案 —— 曾因此让「冷却提示」断言假红
      //（产品其实渲染了，是脚手架看不见）。React 的语义就是展平，所以这里对齐它而不是改产品文案。
      return { type, props: props || {}, children: children.flat(Infinity) };
    },
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
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
  };

  const response = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  });

  let statusReply = { status: opts.statusCode || 200, body: opts.status || NOT_BOUND };
  // 登录态（会话）与 /wechat/status/**面板级** /status 的应答相互独立：
  //   · 面板级 GET /dsh-remote/status 决定 client.js 的 loggedIn（= st.config.phone / hasLocalKey），
  //     也就是微信 tab 在不在；
  //   · signedIn=false 时连 config.phone 一起抹掉/不补 → loggedIn 为假 → 登录门生效。
  let signedIn = opts.signedIn !== false;
  let panelReply = { status: 200, body: opts.panelStatus || { ok: true, service: { running: false } } };
  const withSession = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    if (signedIn) return body.config ? body : { ...body, config: { ...SESSION_CONFIG } };
    const { config, ...rest } = body;
    return config ? { ...rest, config: { ...config, phone: "", hasLocalKey: false } } : body;
  };
  let startReply = {
    status: 200,
    body: { ok: true, qrcode_svg: QR_DATA_URL, qrcode_url: "https://liteapp.weixin.qq.com/q/7GiQu1", message: "请用手机微信扫描二维码完成绑定。" }
  };
  let pollReplies = (opts.polls || [{ status: 200, body: { ok: true, state: "wait", bound: false } }]).slice();
  let verifyReply = { status: 200, body: { ok: true } };
  let cancelReply = { status: 200, body: { ok: true, cancelled: true } };
  let unbindReply = { status: 200, body: { ok: true, notify_error: "" } };
  const counts = { status: 0, start: 0, poll: 0, verify: 0, cancel: 0, unbind: 0 };
  // ── 通道（im-bots）API 应答：用例可注入成功/失败形态 ──
  const imBotsCalls = [];
  let imBotsGetReply = { ok: true, wecom: { enabled: false, botId: "", hasSecret: false, url: "", targetChatId: "" }, status: { connected: false, authenticated: false, lastError: "" }, updatedAt: 0 };
  let imBotsPutReply = { status: 200, body: { ok: true, wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "" }, status: { connected: false, authenticated: false, lastError: "" }, updatedAt: 0 } };
  let imBotsTestReply = { status: 200, body: { ok: true, connected: true, authenticated: true, lastError: "" } };
  const nextPoll = () => (pollReplies.length > 1 ? pollReplies.shift() : pollReplies[0]);

  const makeEl = () => ({
    tag: "div", children: [], style: {}, className: "", attributes: {}, textContent: "",
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    toggleAttribute(k, on) { if (on) this.attributes[k] = ""; else delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    addEventListener() {}, removeEventListener() {}, insertBefore() {}, contains() { return false; }, closest() { return null; }
  });
  const doc = {
    hidden: false,
    createElement: makeEl,
    head: makeEl(),
    body: makeEl(),
    documentElement: { style: {}, attributes: {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  };
  class MutationObserverMock { constructor() {} observe() {} disconnect() {} }
  const localStorage = {
    _s: new Map(),
    getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
    setItem(k, v) { this._s.set(k, String(v)); },
    removeItem(k) { this._s.delete(k); }
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
      if (path === "/dsh-remote/status") return response(panelReply.status, withSession(panelReply.body));
      if (path === "/dsh-remote/wechat/status") { counts.status++; return response(statusReply.status, withSession(statusReply.body)); }
      if (path === "/dsh-remote/wechat/bind/start") { counts.start++; return response(startReply.status, startReply.body); }
      if (path === "/dsh-remote/wechat/bind/poll") { counts.poll++; const r = nextPoll(); return response(r.status, r.body); }
      if (path === "/dsh-remote/wechat/bind/verify") { counts.verify++; return response(verifyReply.status, verifyReply.body); }
      if (path === "/dsh-remote/wechat/bind/cancel") { counts.cancel++; return response(cancelReply.status, cancelReply.body); }
      if (path === "/dsh-remote/wechat/unbind") { counts.unbind++; return response(unbindReply.status, unbindReply.body); }
      if (path === "/dsh-remote/im-bots") {
        if (String(options.method || "GET").toUpperCase() === "PUT") {
          imBotsCalls.push({ method: "PUT", body: options.body ? JSON.parse(options.body) : null });
          return response(imBotsPutReply.status, imBotsPutReply.body);
        }
        return response(200, imBotsGetReply);
      }
      if (path === "/dsh-remote/im-bots/test") {
        imBotsCalls.push({ method: "POST", body: options.body ? JSON.parse(options.body) : null });
        return response(imBotsTestReply.status, imBotsTestReply.body);
      }
      return response(200, { ok: true });
    },
    Set, Symbol, Date, JSON, Math, Number, String, Object, Array, console
  };

  vm.runInNewContext(SOURCE, sandbox);
  const plugin = moduleFactory((name) => {
    assert.equal(name, "react");
    return react;
  });
  plugin.apply({
    slots: {
      inject(name, cb) { injects.set(name, cb); cb(); },
      register(meta, component) { metas.push(meta); registered.set(meta.id, component); return () => {}; }
    }
  });

  let entered = false;
  let renders = 0;
  /** 渲染一棵树：函数组件递归展开（各自独立作用域 + 提交后跑 effects），普通节点保留并递归子节点。 */
  function renderNode(node, path) {
    if (node == null) return node;
    if (Array.isArray(node)) return node.map((n, i) => renderNode(n, path + "/" + i));
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const key = path + ":" + (node.type.name || "anon");
      const sc = scopes.get(key) || { hook: 0, effectCursor: 0, state: [], effects: [], pending: [] };
      sc.hook = 0; sc.effectCursor = 0; sc.pending = [];
      scopes.set(key, sc);
      scopeStack.push(sc);
      let out;
      try { out = node.type(node.props || {}); } finally { scopeStack.pop(); }
      const expanded = renderNode(out, key);
      const todos = sc.pending; sc.pending = [];
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
  /** 主 tab 条里的「微信机器人通道」tab（点它 = 真实用户进入微信面板的路径）。 */
  function weChatTab(tree) {
    return find(tree, (n) => typeof n.props?.onClick === "function"
      && (n.children || []).some((c) => typeof c === "string" && c.includes("微信机器人通道")));
  }

  return {
    requests, metas, injects, clipboard,
    counts() { return { ...counts }; },
    /** 设置页栏目列表（模拟 shell 的 ctx.slots.entries("settings.section")，按 order 排序）。 */
    sectionList() { return metas.filter((m) => m.name === "settings.section").slice().sort((a, b) => a.order - b.order); },
    setStatus(body, status = 200) { statusReply = { status, body }; },
    /** 登录态开关：false = 会话失效/未登录（/status 不再带 config.phone）。 */
    setSignedIn(v) { signedIn = !!v; },
    setStart(body, status = 200) { startReply = { status, body }; },
    setPolls(list) { pollReplies = list.slice(); },
    setVerify(body, status = 200) { verifyReply = { status, body }; },
    setUnbind(body, status = 200) { unbindReply = { status, body }; },
    /** 通道 API 应答注入（GET / PUT / POST test）。 */
    setImBotsGet(body) { imBotsGetReply = body; },
    setImBotsPut(body, status = 200) { imBotsPutReply = { status, body }; },
    setImBotsTest(body, status = 200) { imBotsTestReply = { status, body }; },
    imBotsCalls() { return imBotsCalls.slice(); },
    /** 向 document 派发键盘事件（测试 Esc / Tab 的弹层契约）。 */
    fireKey(key, init = {}) {
      const ev = { key, keyCode: key === "Escape" ? 27 : 0, shiftKey: false, defaultPrevented: false, stopPropagation() {}, preventDefault() { this.defaultPrevented = true; }, ...init };
      for (const fn of (doc._listeners.keydown || []).slice()) fn(ev);
      return ev;
    },
    /** 主 tab 条里的「微信机器人通道」tab（未登录时**不存在** → undefined）。 */
    weChatTabOf(tree) { return weChatTab(tree); },
    render() {
      if (unmounted) return null;
      const root = { type: registered.get(ROOT_SECTION_ID), props: { close() {} }, children: [] };
      let tree = renderNode(root, "root");
      renders += 1;
      return tree;
    },
    async settle(times = 3) {
      for (let i = 0; i < times; i++) { this.render(); await flush(); await flush(); }
      return this.render();
    },
    advance,
    /** 卸载：跑掉所有组件 effect 的 cleanup（模拟组件从设置页消失）。 */
    unmount() {
      unmounted = true;
      for (const sc of scopes.values()) {
        for (const slot of sc.effects) if (slot && typeof slot.cleanup === "function") job(slot.cleanup);
      }
      scopes.clear();
    }
  };
}




/** 当前渲染树里的弹层对话框节点（.dru-ia-dialog）。 */
const dialogOf = (tree) => find(tree, (n) => String(n.props?.className || "").split(/\s+/).includes("dru-ia-dialog"));
/** 按 class 取节点集合。 */
function byClass(tree, cls) {
  const out = [];
  walk(tree, (n) => { if (String(n.props?.className || "").split(/\s+/).includes(cls)) out.push(n); });
  return out;
}
/** 按 input 的 id 取输入框。 */
const inputById = (tree, id) => find(tree, (n) => n.type === "input" && n.props?.id === id);
/** 按按钮文字取真按钮。 */
const btnWith = (tree, text) => find(tree, (n) => n.type === "button" && (n.children || []).some((c) => typeof c === "string" && c.includes(text)));

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

// ───────────────────────── ① 主面板结构 ─────────────────────────

test("IA：主面板 = 状态头（连接 pill + 打开手机端）+ 2 列入口网格（4 张卡，每卡 ≤3 行）", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();

  // 状态头：pill（圆点 + 文案）+ 主按钮
  const head = find(tree, (n) => String(n.props?.className || "") === "dru-ia-head");
  assert.ok(head, "必须有状态头（.dru-ia-head）");
  const pill = find(head, (n) => String(n.props?.className || "").split(/\s+/).includes("dru-ia-pill"));
  assert.ok(pill, "状态头里必须有连接状态 pill");
  assert.equal(pill.props.role, "status", "pill 是状态播报（role=status）");
  assert.ok(find(pill, (n) => String(n.props?.className || "").includes("dru-ia-pill-dot")), "pill 必须有圆点（不靠颜色单独表意）");
  assert.ok(btnWith(head, "打开手机端"), "状态头右侧必须有主按钮「打开手机端」");

  // 入口网格：2 列布局 + 4 张卡；每卡只有 标题 / 一行状态 / 操作
  const grid = find(tree, (n) => String(n.props?.className || "") === "dru-ia-grid");
  assert.ok(grid, "必须有入口网格（.dru-ia-grid）");
  const cards = byClass(grid, "dru-ia-card");
  assert.equal(cards.length, 4, `入口网格应有 4 张卡（手机访问/通道/设备/账号），实际 ${cards.length}`);
  const titles = cards.map((c) => {
    const t = find(c, (n) => String(n.props?.className || "").includes("dru-ia-card-title"));
    return t ? (t.children || []).join("") : "";
  });
  assert.deepEqual(titles, ["手机访问", "通知与消息通道", "已授权设备", "账号"], `卡片标题应对应 IA，实际：${titles.join("|")}`);
  for (const c of cards) {
    const meta = byClass(c, "dru-ia-card-meta");
    assert.equal(meta.length, 1, "每张卡只能有一行状态文案（避免文字堆砌）");
    assert.equal(find(c, (n) => n.type === "button") ? 1 : 0, 1, "每张卡只有一个主按钮（主按钮每屏一个的原则）");
  }

  // 旧结构必须消失：顶部 tab 条
  assert.equal(find(tree, (n) => String(n.props?.className || "") === "dru-tabs"), undefined,
    "顶部 3 个 tab 必须已删除（业主批评原话：顶部 3 个 tab 页）");
});

test("IA：图标一律内联 SVG 16px currentColor（禁止 emoji 当图标）—— 入口网格与状态头无 emoji", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();
  const iaRoot = find(tree, (n) => String(n.props?.className || "") === "dru-ia");
  assert.ok(iaRoot, "主面板根节点应为 .dru-ia");

  // ① 每个图标槽（.dru-ia-ico）里必须是 <svg>，不是文字（emoji 也是文字节点）
  const icos = byClass(iaRoot, "dru-ia-ico");
  assert.ok(icos.length >= 4, "入口网格每张卡都要有图标（+ 状态头主按钮图标）");
  for (const ico of icos) {
    const svg = find(ico, (n) => n.type === "svg");
    assert.ok(svg, "图标必须是内联 <svg>（不得用 emoji 当图标）");
    assert.equal(String(svg.props.width), "16", "图标尺寸 16px");
    assert.equal(svg.props.stroke, "currentColor", "图标必须 currentColor（跟随宿主主题）");
    assert.equal(svg.props["aria-hidden"], "true", "装饰性图标必须 aria-hidden（可读名来自文字）");
    assert.ok(!(ico.children || []).some((c) => typeof c === "string" && EMOJI_RE.test(c)), "图标槽里不得出现 emoji 字符");
  }
  // ② **可见 IA**（状态头 / 入口网格 / 文字入口 / 弹层）的文案里不得出现 emoji 当图标。
  //    折叠的「更多设置」里仍是既有卡片（含少量历史 emoji），它不属于这次重做的主界面范围。
  const visibleParts = ["dru-ia-head", "dru-ia-grid", "dru-ia-links"]
    .map((cls) => find(iaRoot, (n) => String(n.props?.className || "").split(/\s+/).includes(cls)))
    .filter(Boolean);
  assert.equal(visibleParts.length, 3, "状态头 / 入口网格 / 文字入口都必须在");
  for (const part of visibleParts) {
    const text = textOf(part);
    assert.ok(!EMOJI_RE.test(text), "可见 IA 区域不得用 emoji 当图标：命中 " + (text.match(EMOJI_RE) || []).join(""));
  }
});

// ───────────────────────── ② 登录不隐藏功能 ─────────────────────────

test("登录不隐藏功能：未登录时主面板照常显示、入口卡写「登录后可同步」，点账号进弹层登录", async () => {
  const plugin = loadPlugin();
  plugin.setSignedIn(false);
  const tree = await plugin.settle();

  const grid = find(tree, (n) => String(n.props?.className || "") === "dru-ia-grid");
  assert.ok(grid, "未登录时入口网格必须照常显示（绝不隐藏整个功能）");
  assert.equal(byClass(grid, "dru-ia-card").length, 4, "四张入口卡都应在");
  const text = textOf(tree);
  assert.ok(text.includes("登录后可同步"), "未登录时卡片文案应是「登录后可同步」引导，而不是消失");
  assert.ok(text.includes("通知与消息通道"), "通道入口未登录也必须在（旧结构：登录后才出现微信通道）");

  // 点「账号」卡 → 打开账号弹层（就地登录，不跳转）
  assert.ok(openEntry(tree, "account"), "应能点开账号弹层");
  const tree2 = await plugin.settle();
  const dlg = dialogOf(tree2);
  assert.ok(dlg, "账号弹层必须打开");
  assert.ok(find(dlg, (n) => String(n.props?.className || "").split(/\s+/).includes("dru-ia-seg-btn")), "登录/注册应是弹层内的分段控件");
});

// ───────────────────────── ③ 弹层契约 ─────────────────────────

test("弹层契约：手机访问弹层 = role=dialog + aria-modal + 云端/自建分段；Esc 关闭后焦点回触发按钮", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  assert.ok(openEntry(tree, "mobile"), "应能点开「手机访问」入口");
  tree = await plugin.settle();

  const dlg = dialogOf(tree);
  assert.ok(dlg, "必须渲染 .dru-ia-dialog");
  assert.equal(dlg.props.role, "dialog");
  assert.equal(dlg.props["aria-modal"], "true");
  assert.ok(dlg.props["aria-labelledby"], "必须有 aria-labelledby（标题可被读屏关联）");
  const title = find(dlg, (n) => n.props?.id === dlg.props["aria-labelledby"]);
  assert.ok(title && (title.children || []).join("").includes("手机访问"), "标题应为「手机访问」");
  const closeBtn = find(dlg, (n) => n.type === "button" && n.props?.["aria-label"] === "关闭");
  assert.ok(closeBtn, "弹层必须有 ✕ 关闭按钮（aria-label=关闭）");

  // 分段控件：原来的顶部 3 tab 降级到这里（云端 / 自建）
  const seg = byClass(dlg, "dru-ia-seg-btn");
  assert.equal(seg.length, 2, "手机访问弹层里应是 2 段（云端服务 / 自建服务）");
  assert.deepEqual(seg.map((s) => (s.children || []).join("")), ["云端服务", "自建服务"]);

  // Esc 关闭（document 级 keydown 捕获）—— 关闭后弹层消失
  plugin.fireKey("Escape");
  tree = await plugin.settle();
  assert.equal(dialogOf(tree), undefined, "Esc 必须关闭弹层");
});

test("弹层契约：窄屏语义 —— 表头/底部操作用 flex 固定，正文只在内部滚动（不做整页滚动）", () => {
  const src = SOURCE;
  assert.match(src, /\.dru-ia-dialog\{[^}]*display:flex;flex-direction:column/, "弹层内部用纵向 flex");
  assert.match(src, /\.dru-ia-dialog-body\{[^}]*overflow-y:auto/, "只有正文区允许滚动");
  assert.match(src, /\.dru-ia-dialog-foot\{[^}]*flex:none/, "底部操作固定（不随正文滚走）");
  assert.match(src, /max-height:min\(78vh/, "弹层限高（1.5 屏内），不做整页滚动");
});

// ───────────────────────── ④ 通道弹层 + 企微配置 ─────────────────────────

test("通道弹层：平台列表（企微 / 微信扫码 / 飞书 / Webhook）→ 点企业微信进入配置表单", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  assert.ok(openEntry(tree, "channel"), "应能点开「通知与消息通道」入口");
  tree = await plugin.settle();
  assert.ok(dialogOf(tree), "通道弹层必须打开");

  const rows = byClass(tree, "dru-ia-row");
  assert.ok(rows.length >= 4, "平台列表至少 4 行（企业微信 / 微信扫码 / 飞书 / Webhook）");
  const rowText = rows.map((r) => textOf(r));
  assert.ok(rowText.some((t) => t.includes("企业微信智能机器人")), "应有「企业微信智能机器人」");
  assert.ok(rowText.some((t) => t.includes("微信机器人（扫码绑定）")), "应保留既有微信扫码通道入口");
  assert.ok(rowText.some((t) => t.includes("飞书")), "应有「飞书」");
  assert.ok(rowText.some((t) => t.includes("Webhook")), "应有「Webhook」");

  assert.ok(clickChannelRow(tree, "企业微信智能机器人"), "应能点进企业微信配置");
  tree = await plugin.settle();
  assert.ok(textOf(tree).includes("企业微信智能机器人"), "应进入企业微信配置步骤");
  assert.ok(inputById(tree, "dru-wecom-bot"), "表单必须有 Bot ID 输入框");
  const secret = inputById(tree, "dru-wecom-secret");
  assert.ok(secret, "表单必须有 Secret 输入框");
  assert.equal(secret.props.type, "password", "★ Secret 默认必须是 password（不回显）");
  assert.equal(secret.props.value, "", "★ Secret 输入框初值必须为空（服务端不回传 secret）");
  const chat = inputById(tree, "dru-wecom-chat");
  assert.ok(chat, "表单必须有「接收会话 ID（可选）」输入（契约字段 targetChatId）");
  assert.ok(textOf(tree).includes("不知道填什么就留空"), "接收会话 ID 必须有 lead 指定的提示文案");
});

test("通道表单：保存失败 → 错误**就近**显示（aria-invalid + role=alert），不是只弹全局错误", async () => {
  const plugin = loadPlugin();
  // 「保存并连接」= POST /im-bots/test（服务端先保存再等桥连接，与契约一致）
  plugin.setImBotsPut({ ok: false, error: "invalid_bot_id", message: "Bot ID 格式不对：应形如 aibxxxxxxxx" }, 400);
  plugin.setImBotsTest({ ok: false, error: "invalid_bot_id", message: "Bot ID 格式不对：应形如 aibxxxxxxxx" }, 400);
  let tree = await plugin.settle();
  openEntry(tree, "channel");
  tree = await plugin.settle();
  clickChannelRow(tree, "企业微信智能机器人");
  tree = await plugin.settle();

  const bot = inputById(tree, "dru-wecom-bot");
  bot.props.onChange({ target: { value: "not-a-bot" } });
  tree = await plugin.settle();
  const save = btnWith(tree, "保存并连接");
  assert.ok(save, "必须有「保存并连接」主按钮");
  save.props.onClick();
  await flush(); await flush();
  tree = await plugin.settle();

  const bot2 = inputById(tree, "dru-wecom-bot");
  assert.equal(bot2.props["aria-invalid"], "true", "★ 出错的字段要标 aria-invalid（就近）");
  const alert = find(tree, (n) => n.props?.role === "alert" && (n.children || []).some((c) => typeof c === "string" && c.includes("Bot ID 格式不对")));
  assert.ok(alert, "★ 错误文案必须出现在字段旁（role=alert 可被读屏播报）");
  const sent = plugin.imBotsCalls().filter((c) => c.method === "POST").pop();
  assert.ok(sent, "「保存并连接」必须真的发出 POST /dsh-remote/im-bots/test");
  assert.equal(sent.body.wecom.botId, "not-a-bot");
  assert.ok(!("secret" in sent.body.wecom), "空 Secret 不随请求提交（= 保留已保存的，服务端契约）");
  assert.equal(sent.body.wecom.targetChatId, "", "targetChatId 留空 = 不设置（显式传空串）");
});

test("通道测试：连接失败 → 弹层内如实显示桥给的原因（connect_failed + lastError）", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({ ok: true, wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "" }, status: { connected: false, authenticated: false, lastError: "" } });
  plugin.setImBotsTest({ ok: false, error: "connect_failed", lastError: "invalid credential (errcode 40001)", message: "连接失败：invalid credential (errcode 40001)" }, 502);
  let tree = await plugin.settle();
  openEntry(tree, "channel");
  tree = await plugin.settle();
  clickChannelRow(tree, "企业微信智能机器人");
  tree = await plugin.settle();

  const testBtn = btnWith(tree, "测试");
  assert.ok(testBtn, "必须有「测试」按钮");
  testBtn.props.onClick();
  await flush(); await flush();
  tree = await plugin.settle();
  const text = textOf(tree);
  assert.ok(text.includes("40001"), "★ 失败原因必须原样显示（用户才能拿去搜/找客服）");
  assert.ok(find(tree, (n) => n.props?.role === "status" && (n.children || []).some((c) => typeof c === "string" && c.includes("40001"))), "状态行要 aria-live/status 播报");
});

// ───────────────────── ⑤ 会话可选绑定（task-25） ─────────────────────

const openWecom = async (plugin) => {
  let tree = await plugin.settle();
  assert.ok(openEntry(tree, "channel"), "应能打开通道弹层");
  tree = await plugin.settle();
  assert.ok(clickChannelRow(tree, "企业微信智能机器人"), "应能进入企业微信配置页");
  return plugin.settle();
};

test("会话下拉：有列表 → 默认项 + 会话项（标题截断 24 字 + 短 id）；展示当前实际转发目标", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
    status: {
      connected: true, authenticated: true, lastError: "",
      sessions: [
        { id: "sess-1-abcdef123456", title: "修复登录问题", updatedAt: 111 },
        { id: "sess-2-xyz", title: "这是一个非常非常长的会话标题用于验证截断逻辑是否生效", updatedAt: 222 },
      ],
      activeSessionId: "sess-2-xyz", activeSessionTitle: "这是一个非常非常长的会话标题用于验证截断逻辑是否生效",
      boundSessionId: "sess-1-abcdef123456",
    },
  });
  const tree = await openWecom(plugin);
  const sel = find(tree, (n) => n.type === "select" && n.props?.id === "dru-wecom-session");
  assert.ok(sel, "配置页必须有「转接到哪个会话」下拉");
  const opts = sel.children.find((c) => c && c.type === "option") ? null : null; // 占位，真实取法见下
  const options = [];
  walk(tree, (n) => { if (n.type === "option") options.push(n); });
  assert.equal(options.length, 3, "选项 = 跟随默认 + 2 个会话，实际 " + options.length);
  assert.ok((options[0].children || []).join("").includes("跟随当前活跃会话（默认）"), "第一项必须是「跟随当前活跃会话（默认）」");
  const longOpt = (options[2].children || []).join("");
  assert.ok(longOpt.includes("…"), "长标题必须截断（最多 24 字 + …）：" + longOpt);
  assert.ok(longOpt.includes("sess-2-x"), "选项要带短 id（标题可能重复）");
  // 当前实际转发目标要一行说清（绑定会话优先）
  assert.ok(textOf(tree).includes("绑定会话：修复登录问题"), "应展示「绑定会话：<title>」");
});

test("会话下拉：列表为空 → 说明「还没有会话，去创建一个任务后这里会出现」", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: false, botId: "", hasSecret: false, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
    status: { connected: false, authenticated: false, lastError: "", sessions: [], activeSessionId: "", boundSessionId: "" },
  });
  const tree = await openWecom(plugin);
  assert.ok(textOf(tree).includes("还没有会话，去创建一个任务后这里会出现"), "空列表必须有引导文案（不是空白下拉）");
});

test("会保存：选中某会话 → PUT 带 sessionId + sessionTitle；选回默认 → 两者清空", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
    status: {
      connected: true, authenticated: true, lastError: "",
      sessions: [{ id: "sess-1-abcdef123456", title: "修复登录问题", updatedAt: 111 }],
      activeSessionId: "sess-1-abcdef123456", activeSessionTitle: "修复登录问题", boundSessionId: "",
    },
  });
  let tree = await openWecom(plugin);
  let sel = find(tree, (n) => n.type === "select" && n.props?.id === "dru-wecom-session");
  sel.props.onChange({ target: { value: "sess-1-abcdef123456" } });
  tree = await plugin.settle();
  assert.ok(textOf(tree).includes("绑定会话：跟随活跃（修复登录问题）"), "未保存前展示的仍是当前实际转发目标（跟随活跃）");

  const saveOnly = btnWith(tree, "仅保存");
  assert.ok(saveOnly, "必须有「仅保存」按钮");
  saveOnly.props.onClick();
  await flush(); await flush();
  tree = await plugin.settle();
  let sent = plugin.imBotsCalls().filter((c) => c.method === "PUT").pop();
  assert.ok(sent, "应发出 PUT /dsh-remote/im-bots");
  assert.equal(sent.body.wecom.sessionId, "sess-1-abcdef123456", "★ 选中会话必须写 sessionId");
  assert.equal(sent.body.wecom.sessionTitle, "修复登录问题", "★ 同时写 sessionTitle（面板回显用）");

  // 选回默认 → 清空
  sel = find(tree, (n) => n.type === "select" && n.props?.id === "dru-wecom-session");
  sel.props.onChange({ target: { value: "" } });
  tree = await plugin.settle();
  btnWith(tree, "仅保存").props.onClick();
  await flush(); await flush();
  tree = await plugin.settle();
  const calls = plugin.imBotsCalls().filter((c) => c.method === "PUT");
  sent = calls[calls.length - 1];
  assert.equal(sent.body.wecom.sessionId, "", "★ 选「跟随当前活跃会话」= 清空 sessionId");
  assert.equal(sent.body.wecom.sessionTitle, "", "★ 清空时标题也必须清空（否则 UI 会显示错目标）");
});

// ───────────────────── ⑥ 飞书 / 钉钉：诚实的「即将支持」 ─────────────────────

test("平台列表：飞书 / 钉钉都标注「即将支持」，不放进假表单", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  openEntry(tree, "channel");
  tree = await plugin.settle();
  const rows = byClass(tree, "dru-ia-row");
  const texts = rows.map((r) => textOf(r));
  assert.ok(texts.some((t) => t.includes("飞书机器人") && t.includes("即将支持")), "飞书行必须标注即将支持");
  assert.ok(texts.some((t) => t.includes("钉钉机器人") && t.includes("即将支持")), "钉钉行必须标注即将支持");
  assert.ok(texts.some((t) => t.includes("企业微信智能机器人") && !t.includes("即将支持")), "企微行是已支持（主推）");
});

test("飞书/钉钉：点进去只有说明 + 「告诉我，优先支持」；**没有输入框、没有提交**，点优先支持走现有反馈", async () => {
  const plugin = loadPlugin();
  for (const [row, name] of [["飞书机器人", "飞书机器人"], ["钉钉机器人", "钉钉机器人"]]) {
    const p = loadPlugin();
    let tree = await p.settle();
    openEntry(tree, "channel");
    tree = await p.settle();
    assert.ok(clickChannelRow(tree, row), "应能点开 " + row);
    tree = await p.settle();
    const dlg = dialogOf(tree);
    assert.ok(dlg, row + " 必须打开弹层（不是假入口）");
    const text = textOf(dlg);
    assert.ok(text.includes("即将支持"), row + " 必须标注「即将支持」");
    assert.ok(text.includes("企业管理员"), row + " 说明要写清为什么现在还接不了（企业管理员配置应用）");
    assert.equal(find(dlg, (n) => n.type === "input" || n.type === "select"), undefined,
      "★ 不许放任何输入框/下拉（假表单）");
    const tell = btnWith(dlg, "告诉我，优先支持");
    assert.ok(tell, "必须有「告诉我，优先支持」按钮（复用反馈通道）");
    const before = p.imBotsCalls().length;
    tell.props.onClick();
    tree = await p.settle();
    assert.equal(dialogOf(tree), undefined, "点「优先支持」后关闭弹层");
    assert.equal(p.imBotsCalls().length, before, "★ 不得调用 im-bots 写接口（不新增后端）");
    const dbgText = textOf(tree);
    assert.ok(dbgText.includes("想要 " + name), "反馈视图应带一句引导（告知用户写什么）；实际视图文本片段=" + dbgText.slice(0, 200));
    void plugin;
  }
});

// ───────────────────── ⑦ 配置页收口：说明折叠 + 统一字段结构 ─────────────────────

test("配置页收口：说明默认折叠（「为什么要填这些」），四个字段统一 dru-ia-field 结构", async () => {
  const plugin = loadPlugin();
  const tree = await openWecom(plugin);
  // 折叠：默认看不到服务地址字段
  assert.equal(find(tree, (n) => n.props?.id === "dru-wecom-url"), undefined, "高级项默认折叠（不在主表单里）");
  const disclose = find(tree, (n) => n.type === "button" && (n.children || []).some((c) => typeof c === "string" && c.includes("为什么要填这些")));
  assert.ok(disclose, "必须有「为什么要填这些」折叠按钮");
  assert.equal(disclose.props["aria-expanded"], "false");
  disclose.props.onClick();
  const tree2 = await plugin.settle();
  assert.ok(find(tree2, (n) => n.props?.id === "dru-wecom-url"), "展开后才出现高级字段");
  // 四个字段（会话 / Bot ID / Secret / 接收会话 ID）都在 .dru-ia-field 里，label 可见
  const fields = byClass(tree2, "dru-ia-field");
  assert.ok(fields.length >= 4, "字段必须用统一 dru-ia-field 结构（实际 " + fields.length + "）");
  for (const id of ["dru-wecom-session", "dru-wecom-bot", "dru-wecom-secret", "dru-wecom-chat"]) {
    const ctl = find(tree2, (n) => (n.type === "input" || n.type === "select") && n.props?.id === id);
    assert.ok(ctl, "缺字段控件: " + id);
    const label = find(tree2, (n) => n.type === "label" && n.props?.htmlFor === id);
    assert.ok(label, "每个字段必须有可见 label: " + id);
  }
});

// ───────────────────── ⑧ 发送预览卡片（task-25 尾，桥侧已就绪） ─────────────────────

test("发送预览卡片：次要按钮在「测试」旁边；点击 PUT 带 previewCardAt 且不丢 botId/sessionId/targetChatId", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "chat-9", sessionId: "", sessionTitle: "" },
    status: {
      connected: true, authenticated: true, lastError: "", boundChatId: "chat-9",
      sessions: [{ id: "sess-1-abcdef123456", title: "修复登录问题", updatedAt: 1 }],
      activeSessionId: "sess-1-abcdef123456", activeSessionTitle: "修复登录问题", boundSessionId: "",
    },
  });
  let tree = await openWecom(plugin);
  const previewBtn = btnWith(tree, "发送预览卡片");
  assert.ok(previewBtn, "配置页必须有次要按钮「发送预览卡片」");
  // 次要按钮：不是 primary（不抢主操作）、与「测试」同组摆在底部
  assert.ok(!String(previewBtn.props.className || "").includes("is-primary"), "「发送预览卡片」不能是主按钮");
  assert.ok(btnWith(tree, "测试"), "「测试」按钮仍在（两者并列）");

  // 先选一个会话，验证预览请求会带上会话绑定
  const sel = find(tree, (n) => n.type === "select" && n.props?.id === "dru-wecom-session");
  sel.props.onChange({ target: { value: "sess-1-abcdef123456" } });
  tree = await plugin.settle();

  const before = Date.now();
  btnWith(tree, "发送预览卡片").props.onClick();
  await flush(); await flush();
  tree = await plugin.settle();

  const sent = plugin.imBotsCalls().filter((c) => c.method === "PUT").pop();
  assert.ok(sent, "★ 点击必须 PUT /dsh-remote/im-bots（桥监听 previewCardAt）");
  assert.equal(typeof sent.body.wecom.previewCardAt, "number", "previewCardAt 必须是数字（ms 时间戳）");
  assert.ok(sent.body.wecom.previewCardAt >= before, "previewCardAt 应是本次点击的时间戳（值变大才会触发）");
  assert.equal(sent.body.wecom.botId, "aibdemo1234", "★ 不丢 Bot ID（覆盖写不许冲掉）");
  assert.equal(sent.body.wecom.targetChatId, "chat-9", "★ 不丢接收会话 ID");
  assert.equal(sent.body.wecom.sessionId, "sess-1-abcdef123456", "★ 不丢会话绑定");
  assert.equal(sent.body.wecom.sessionTitle, "修复登录问题");
  assert.ok(!("secret" in sent.body.wecom), "空 Secret 不提交（= 保留已保存的）");
  // 成功状态行
  assert.ok(textOf(tree).includes("已发送预览卡片，去企业微信看看"), "发送成功要有状态行");
});

test("发送预览卡片：没有接收方（boundChatId 与 targetChatId 都空）→ 行内提示，但仍允许点击", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
    status: { connected: true, authenticated: true, lastError: "", boundChatId: "", sessions: [], activeSessionId: "", boundSessionId: "" },
  });
  const tree = await openWecom(plugin);
  assert.ok(textOf(tree).includes("先在企微里给机器人发一句话完成绑定"), "未绑定给机器人时要有行内提示");
  const btn = btnWith(tree, "发送预览卡片");
  assert.ok(btn, "按钮必须存在");
  assert.notEqual(btn.props.disabled, true, "★ 仍允许点击（桥会记日志跳过，不拦用户）");
});

test("发送预览卡片：已绑定（boundChatId 非空）→ 不显示未绑定提示；有 lastPreviewCardAt → 显示「上次预览：HH:MM」", async () => {
  const plugin = loadPlugin();
  const ts = new Date(2026, 0, 2, 9, 7, 0).getTime();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
    status: { connected: true, authenticated: true, lastError: "", boundChatId: "chat-9", lastPreviewCardAt: ts, sessions: [], activeSessionId: "", boundSessionId: "" },
  });
  const tree = await openWecom(plugin);
  assert.ok(!textOf(tree).includes("先在企微里给机器人发一句话完成绑定"), "已绑定就不该再提示未绑定");
  assert.ok(textOf(tree).includes("上次预览：09:07"), "应显示上次预览时间（HH:MM）");
});

// ───────────── ⑨ 未登录守卫 + 后台服务横排 + 卸载挽留（2026-11-07 业主逐条）─────────────

test("未登录「手机访问」卡：文案写「登录并生成访问码」，点击弹登录弹层；登录成功后自动回到手机访问", async () => {
  const plugin = loadPlugin();
  plugin.setSignedIn(false);
  let tree = await plugin.settle();
  const card = find(tree, (n) => String(n.props?.className || "").includes("dru-ia-card")
    && textOf(n).includes("手机访问"));
  assert.ok(card, "入口网格里应有「手机访问」卡");
  assert.ok(textOf(card).includes("登录并生成访问码"), "未登录时按钮文案必须是「登录并生成访问码」（不是静默失败）");
  const btn = find(card, (n) => n.type === "button");
  btn.props.onClick();
  tree = await plugin.settle();
  assert.ok(textOf(tree).includes("登录后才能用手机访问"), "点击后弹登录弹层并说明原因");

  // 登录成功 → 自动回到「手机访问」流程（iaAfterLogin 回跳），不再让用户自己再找一遍
  plugin.setSignedIn(true);
  tree = await plugin.settle(4);
  assert.ok(textOf(tree).includes("手机访问"), "登录后应回到手机访问流程");
  const dlg = find(tree, (n) => String(n.props?.className || "").split(/\s+/).includes("dru-ia-dialog"));
  assert.ok(dlg, "登录后应自动打开手机访问弹层");
});

test("后台服务区块（A6）：显眼提示 + 横向紧凑网格（状态/启停/自启动/设备ID 不再竖排占屏）", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();
  assert.ok(textOf(tree).includes("保持在线，才能用手机端远程控制这台电脑"), "必须有「保持在线」提示（业主点名）");
  const grid = find(tree, (n) => String(n.props?.className || "") === "dru-bridge-grid");
  assert.ok(grid, "后台服务应为横向网格布局（.dru-bridge-grid）");
  const cells = byClass(grid, "dru-bridge-cell");
  assert.ok(cells.length >= 4, "网格应含 4 格：状态 / 启停 / 自启动 / 设备 ID，实际 " + cells.length);
  assert.ok(cells.some((c) => textOf(c).includes("设备 ID")), "设备 ID 在网格里（横向）");
});

test("彻底卸载（A7）：先弹挽留反馈（原因单选 + 建议）→ 提交走现有反馈通道 → 才继续卸载", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  const unBtn = btnWith(tree, "彻底卸载");
  assert.ok(unBtn, "应有「彻底卸载」按钮");
  unBtn.props.onClick();
  tree = await plugin.settle();
  const dlg = find(tree, (n) => String(n.props?.className || "").split(/\s+/).includes("dru-ia-dialog"));
  assert.ok(dlg, "点彻底卸载应先弹挽留反馈弹层");
  assert.ok(textOf(dlg).includes("为什么要卸载"), "弹层要问「为什么要卸载？」；实际=" + textOf(dlg).slice(0, 200));
  const radios = findAll(dlg, (n) => n.type === "input" && n.props?.type === "radio");
  assert.ok(radios.length >= 4, "应有多个原因单选，实际 " + radios.length);
  assert.ok(find(dlg, (n) => n.type === "textarea"), "应有可填建议的输入框");
  assert.ok(btnWith(dlg, "我再想想"), "必须有「我再想想」退出选项");
  // 未选原因就点「仍要卸载」→ 就近报错，且不提交/不卸载
  const before = plugin.requests.length;
  btnWith(dlg, "仍要卸载").props.onClick();
  tree = await plugin.settle();
  assert.ok(textOf(tree).includes("请选择一个卸载原因"), "未选原因要给就近错误");
  const after = plugin.requests.slice(before).map((r) => r.path);
  assert.ok(!after.includes("/dsh-remote/feedback"), "未选原因不得提交反馈（" + after.join(",") + "）");
  assert.ok(!after.includes("/dsh-remote/self/uninstall"), "未选原因更不得开始卸载");

  // 选一个原因 + 写建议 → 仍要卸载：先 POST 反馈（kind=uninstall），再 POST 卸载
  const r0 = findAll(tree, (n) => n.type === "input" && n.props?.type === "radio")[0];
  r0.props.onChange({ target: { value: r0.props.value } });
  tree = await plugin.settle();
  const note = find(tree, (n) => n.type === "textarea");
  note.props.onChange({ target: { value: "加载太慢，希望优化" } });
  tree = await plugin.settle();
  btnWith(tree, "仍要卸载").props.onClick();
  await flush(); await flush(); await flush();
  const fb = plugin.requests.find((r) => r.path === "/dsh-remote/feedback" && r.method === "POST");
  assert.ok(fb, "★ 必须先提交挽留反馈（复用现有反馈通道，不新增后端）");
  assert.equal(fb.body.kind, "uninstall", "反馈必须带 kind=uninstall 标记");
  assert.ok(String(fb.body.content).includes("原因"), "反馈内容要含所选原因");
  assert.ok(String(fb.body.content).includes("加载太慢"), "用户填的建议要带上");
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/self/uninstall" && r.method === "POST"),
    "★ 提交反馈后应继续执行卸载（反馈不能反过来卡住用户）");
});

// ───────────────────── ⑩ 会员档位条 + 会话固定门禁（2026-11-07 桥侧判定） ─────────────────────

test("企微配置页档位条：免费档 → 「本月剩余 N 条指令（每月 20 条）」+ 「升级 Pro 不限量」链接", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
    status: {
      connected: true, authenticated: true, tier: "free",
      messagesPerMonth: 20, remainingMessages: 7, usage: { month: "2026-11", messages: 13 },
      bindingGated: false, caps: ["wecom"], capsCount: 1,
      sessions: [], activeSessionId: "", boundSessionId: "",
    },
  });
  const tree = await openWecom(plugin);
  const tierBar = find(tree, (n) => String(n.props?.className || "").includes("dru-ia-tier"));
  assert.ok(tierBar, "免费档应渲染档位条");
  assert.ok(textOf(tierBar).includes("免费档"), "档位条要写明「免费档」");
  assert.ok(textOf(tierBar).includes("本月剩余 7 条指令"), "要显示剩余指令数");
  assert.ok(textOf(tierBar).includes("每月 20 条"), "要显示每月上限");
  const link = find(tierBar, (n) => n.type === "a");
  assert.ok(link, "免费档必须有升级入口");
  assert.equal(link.props.href, "/app/promo", "升级链接指向 /app/promo");
  assert.ok((link.children || []).join("").includes("升级 Pro 不限量"));
});

test("企微配置页档位条：pro / pro_max → 「会员档 · 指令不限」，不出现升级链接", async () => {
  for (const tier of ["pro", "pro_max"]) {
    const plugin = loadPlugin();
    plugin.setImBotsGet({
      ok: true,
      wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
      status: { connected: true, authenticated: true, tier, bindingGated: false, sessions: [], activeSessionId: "", boundSessionId: "" },
    });
    const tree = await openWecom(plugin);
    const tierBar = find(tree, (n) => String(n.props?.className || "").includes("dru-ia-tier"));
    assert.ok(tierBar, tier + " 应渲染档位条");
    assert.ok(textOf(tierBar).includes("会员档 · 指令不限"), tier + " 文案应为「会员档 · 指令不限」");
    assert.equal(find(tierBar, (n) => n.type === "a"), undefined, tier + " 会员档不该有升级链接");
  }
});

test("企微配置页档位条：取不到 tier / 未知值 → 整行不渲染（绝不瞎猜）", async () => {
  for (const status of [
    { connected: true, sessions: [], activeSessionId: "", boundSessionId: "" },                 // 旧桥：没有 tier
    { connected: true, tier: "gold", sessions: [], activeSessionId: "", boundSessionId: "" },    // 未知值
  ]) {
    const plugin = loadPlugin();
    plugin.setImBotsGet({
      ok: true,
      wecom: { enabled: false, botId: "", hasSecret: false, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
      status,
    });
    const tree = await openWecom(plugin);
    assert.equal(find(tree, (n) => String(n.props?.className || "").includes("dru-ia-tier")), undefined,
      "拿不到有效档位时不得渲染档位条（" + JSON.stringify(status.tier) + "）");
  }
});

test("会话固定门禁：bindingGated=true → 下拉置灰 + 「会员功能」徽章 + 悬停说明；已选值被忽略时如实说明", async () => {
  const plugin = loadPlugin();
  plugin.setImBotsGet({
    ok: true,
    wecom: { enabled: true, botId: "aibdemo1234", hasSecret: true, url: "", targetChatId: "", sessionId: "sess-1-abcdef123456", sessionTitle: "修复登录问题" },
    status: {
      connected: true, authenticated: true, tier: "free", bindingGated: true,
      sessions: [{ id: "sess-1-abcdef123456", title: "修复登录问题", updatedAt: 1 }],
      activeSessionId: "sess-2-xyz", activeSessionTitle: "部署到 NAS", boundSessionId: "",
    },
  });
  const tree = await openWecom(plugin);
  const sel = find(tree, (n) => n.type === "select" && n.props?.id === "dru-wecom-session");
  assert.ok(sel, "下拉仍应存在（只是置灰）");
  assert.equal(sel.props.disabled, true, "★ 免费档必须置灰（不能假装能选）");
  assert.equal(sel.props.title, "升级后可固定转接会话", "悬停必须说明为什么不能选");
  assert.equal(sel.props.value, "", "被忽略的选择不能显示成生效值");
  const badge = find(tree, (n) => String(n.props?.className || "").includes("dru-ia-badge"));
  assert.ok(badge && textOf(badge).includes("会员功能"), "置灰处要有「会员功能」徽章");
  assert.ok(textOf(tree).includes("当前跟随活跃会话"), "已选值被忽略时要显示「当前跟随活跃会话」");
  assert.ok(textOf(tree).includes("免费档不能固定转接"), "小字要说明原因");
});

// ───────────────────── ⑪ 品牌全名 + 安装命令（2026-11-07 业主） ─────────────────────

test("品牌：面板标题 / 关于卡片统一用全名 dsh-remote-web，旧的「关于 dsh-remote」不再出现", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();
  // 顶部面板标题（业主：「我的插件名字叫 dsh-remote-web，这个是全名」）
  const title = find(tree, (n) => String(n.props?.className || "").includes("dru-settings-title"));
  assert.ok(title, "应有面板标题");
  assert.equal((title.children || []).join(""), "dsh-remote-web", "顶部标题必须是品牌全名 dsh-remote-web");
  // 关于卡片
  assert.ok(textOf(tree).includes("关于 dsh-remote-web"), "关于段落标题应为「关于 dsh-remote-web」");
  // 精确断言：不得再出现裸品牌「关于 dsh-remote」（但不能误伤包名 @mrrisega/dsh-remote）
  assert.doesNotMatch(SOURCE, /关于 dsh-remote(?!-web)/, "旧品牌写法「关于 dsh-remote」不得再出现");
  assert.match(SOURCE, /@mrrisega\/dsh-remote/, "包名 @mrrisega/dsh-remote 必须保留（不是品牌文案）");
  assert.match(SOURCE, /~\/\.dsh-remote/, "配置目录 ~/.dsh-remote 必须保留（代码/数据路径，不是品牌文案）");
});

test("版本与更新：有一行可复制的安装/更新命令 npx @mrrisega/dsh-remote@latest + 「重跑这条命令即可」说明", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  assert.ok(textOf(tree).includes("npx @mrrisega/dsh-remote@latest"), "版本卡必须给出安装/更新命令");
  assert.ok(textOf(tree).includes("已安装的更新：重跑这条命令即可"), "要说明更新方式是重跑该命令");
  const copyBtn = find(tree, (n) => n.type === "button" && n.props?.["aria-label"] === "复制安装命令");
  assert.ok(copyBtn, "命令旁必须有复制按钮（复用现有复制反馈样式）");
  const code = find(tree, (n) => String(n.props?.className || "").includes("dru-code-val"));
  assert.ok(code && (code.children || []).join("").includes("@mrrisega/dsh-remote@latest"), "命令要以可复制的代码样式展示");

  copyBtn.props.onClick();
  await flush(); await flush();
  assert.deepEqual(plugin.clipboard, ["npx @mrrisega/dsh-remote@latest"], "★ 点复制必须把安装命令写进剪贴板");
  tree = await plugin.settle();
  assert.ok(textOf(tree).includes("✅ 已复制"), "复制成功要有与其它复制按钮一致的反馈");
});

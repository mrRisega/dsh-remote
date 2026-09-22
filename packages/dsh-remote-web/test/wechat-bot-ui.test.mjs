// 「🤖 微信机器人通道」面板回归（浏览器半 client.js，**远程访问面板里的第三个 tab**）。
//
// 【0.6.11 变更】微信面板不再是独立的 settings.section 栏目（第二个栏目已删），而是「📱 远程访问」
// 面板主 tab 条里的第三个 tab。所以本文件有两处关键调整：
//   ① 栏目注册断言：settings.section 里**只有** dsh-remote 一个（不再有 dsh-remote-wechat）；
//   ② harness 改为渲染 dsh-remote 根组件 → 递归展开函数子组件（WeChatBotSection）→ 且首次渲染后
//      自动点一下「微信机器人通道」tab（真实用户路径）再断言。覆盖的仍是同一个组件的行为。
//
// 覆盖（对应 docs/wechat-bot-channel.md §8 安全 / §9 两态模型 / §10 绑定流程）：
//   ① 入口：不再有独立栏目；tab 条（home 与 wechat 两个视图共用）含「微信机器人通道」+ 绿色图标；
//   ② 主题不变量：--dru-* 令牌只在既有三个选择器上声明，新增样式只引用令牌、不落 :root/body；
//   ③ 二维码：直接把 bridge 下发的 qrcode_svg（data: URL）喂给 <img src>，零 QR 库、零外部资源；
//   ④ 配对码：need_verify_code 为真时**必须**出现数字输入框并能提交（这一步真机上很容易漏）；
//   ⑤ 轮询：确认/失败/取消/卸载即停；expired 给出「刷新二维码」；未知状态按可重试继续；
//   ⑥ 解绑必须二次确认（解绑=所有微信通知立刻停止，不能一点就走）；
//   ⑦ 控制面缺失（bridge 没跑/版本旧）要说清楚怎么办，**绝不**留一个永久 spinner；
//   ⑧ 无障碍：真 <button>、aria-live 播报、不靠颜色单独表意。
//
// 【0.6.12 新增】产品引导（业主口径：「动效引导」+ 微信通道要求已注册并登录）：
//   ⑨ 首屏导览：未绑定时内容体最上面三行讲清用途（推送 / 回数字拍板 / 微信里交代任务），
//      DOM 顺序在「连接微信机器人」之前，且是小字紧凑排版（不把按钮挤出首屏）；
//   ⑩ 登录门：未登录**不渲染**微信 tab，登录后当场出现（不刷新页面）；会话在 tab 开着时失效
//      → 不渲染微信内容、view 回落 home，绝不留空面板；
//   ⑪ 动效引导：未绑定时连接按钮带 .dru-wx-attn（慢呼吸 + 装饰点 aria-hidden），
//      样式表有 prefers-reduced-motion:reduce 关闭规则，绑定后动效全部消失。
// ⚠️ harness 默认「已登录」（/status 补 config.phone）；未登录场景用 setSignedIn(false) ——
//    见 SESSION_CONFIG 上的注释。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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
    addEventListener() {}, removeEventListener() {}
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
    navigator: { clipboard: { writeText: async () => {} } },
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
    requests, metas, injects,
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
    /** 主 tab 条里的「微信机器人通道」tab（未登录时**不存在** → undefined）。 */
    weChatTabOf(tree) { return weChatTab(tree); },
    render() {
      if (unmounted) return null;
      const root = { type: registered.get(ROOT_SECTION_ID), props: { close() {} }, children: [] };
      let tree = renderNode(root, "root");
      renders += 1;
      if (!entered) {
        // 真实用户路径：先进 📱 远程访问（home），再点第三个 tab（微信面板就在面板内，不是独立栏目）。
        // ⚠️ 登录态来自 /dsh-remote/status，**第一次渲染时 st 还是 null**（= 未登录）→ 自然没有 tab。
        //    所以这里不是「第一帧就必须有点击目标」，而是「状态读到之后必须能用」：先等一帧。
        const tab = weChatTab(tree);
        if (tab) {
          entered = true;
          tab.props.onClick();
          tree = renderNode(root, "root");
        } else if (!signedIn) {
          entered = true; // 未登录：本来就不该有微信 tab（见登录门用例）
        } else if (renders > 1) {
          // 登录门：**已登录**且状态已读到之后，这个 tab 必须在（不变量不放松）。
          assert.fail("已登录时远程访问面板的主 tab 条里必须有「微信机器人通道」tab");
        }
      }
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

/** 点「连接微信机器人」→ 拿到二维码的绑定视图。 */
async function enterBinding(plugin) {
  let tree = await plugin.settle();
  const btn = buttonWithText(tree, "连接微信机器人");
  assert.ok(btn, "未绑定时必须有「连接微信机器人」按钮");
  btn.props.onClick();
  tree = await plugin.settle();
  return tree;
}

// ───────────────────────────────────────────────────────────────────────────

test("入口：settings.section 里**只有**「📱 远程访问」一个栏目，不再有 dsh-remote-wechat", () => {
  const plugin = loadPlugin();
  const list = plugin.sectionList();
  const ids = list.map((m) => m.id);
  // 【0.6.11 改断言】旧断言 deepEqual(ids, ["dsh-remote", "dsh-remote-wechat"]) + order 31 + label 含
  // 「🤖 微信机器人」编码的是**旧行为**（微信面板作为第二个设置栏目）。业主口径：「不要给它单独弄
  // 一个菜单，直接放到『远程控制』面板里面」→ 第二个栏目已删，这里改为断言「只有一个栏目」。
  assert.deepEqual(ids, [ROOT_SECTION_ID], `设置页只应有一个栏目，实际：${ids.join(",")}`);
  assert.equal(list.length, 1, "settings.section 注册次数必须恰好是 1（不多不少）");
  const only = list[0];
  assert.equal(only.name, "settings.section");
  assert.equal(only.order, 30);
  assert.equal(typeof only.label, "function");
  const label = only.label();
  assert.ok(String(label).includes("远程访问"), `栏目名应含「远程访问」，实际：${label}`);
  assert.ok(String(label).includes("📱"), "栏目名应带 📱 图标");
  // 「不再有第二个栏目」在源码层面也必须成立（防止有人把 d2 加回来）
  assert.doesNotMatch(SOURCE, /dsh-remote-wechat/, "不得再把微信面板注册成第二个 settings.section 栏目");
  assert.doesNotMatch(SOURCE, /id: "dsh-remote-wechat"/);
  // disposer 仍然只返回 d1 那一个（register 一次 → 只 dispose 一次）
  const dispose = plugin.injects.get("settings.section")();
  assert.equal(typeof dispose, "function", "setting.section 的 inject 回调必须返回 disposer");
});

test("tab 条（home 与 wechat 共用）：第三个 tab 是「微信机器人通道」+ 微信绿泡泡图标；能进也能出", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle(); // 首次渲染自动点在微信 tab 上
  // 进入微信视图后 tab 条**仍在**（否则用户被关在微信页里出不来）
  let strip = find(tree, (n) => n.props?.className === "dru-tabs" && n.props?.role === "tablist");
  assert.ok(strip, "微信视图里也必须渲染主 tab 条（否则无法返回）");

  // 三个 tab：云端服务 / 自建服务 / 微信机器人通道
  const tabs = [];
  walk(tree, (n) => { if (n.props?.role === "tab") tabs.push(n); });
  const labels = tabs.map((t) => (t.children || []).filter((c) => typeof c === "string").join(""));
  assert.deepEqual(labels, ["☁️ 云端服务", "🖥 自建服务", "微信机器人通道"], `主 tab 条应有三个 tab，实际：${labels.join("|")}`);

  // 绿泡泡图标：装饰性 span.dru-wx-ico + aria-hidden（可访问名字来自文字标签）
  const ico = find(tree, (n) => n.props?.className === "dru-wx-ico");
  assert.ok(ico, "微信 tab 上必须有 .dru-wx-ico 绿泡泡图标");
  assert.equal(ico.props["aria-hidden"], "true", "图标是装饰性的 → aria-hidden");
  assert.equal(ico.type, "span");
  assert.ok((ico.children || []).some((c) => typeof c === "string" && c.includes("💬")), "图标里应有 💬 气泡字符");

  // 选中态：微信 tab active / aria-selected=true，两个模式 tab 都不 active（aria 与视觉同源）
  const wxTab = tabs[2];
  assert.match(wxTab.props.className, /dru-tab active/, "在微信视图里微信 tab 必须是 active");
  assert.equal(wxTab.props["aria-selected"], "true");
  assert.equal(tabs[0].props["aria-selected"], "false", "模式 tab 在微信视图里不得选中");
  assert.equal(tabs[1].props["aria-selected"], "false");
  assert.equal(tabs[0].props.tabIndex, 0, "tab 必须可聚焦（键盘可操作）");
  assert.equal(wxTab.props["aria-selected"], "true", "aria-selected 与 .active 同源");

  // 微信视图里没有第二个 .dru-settings-section 套娃（内嵌态省掉外壳）
  assert.equal(tree.props.className, "dru-settings-section", "面板根仍是唯一的 .dru-settings-section");
  assert.equal(find(tree, (n) => n.props?.className === "dru-settings-section" && n !== tree), undefined,
    "内嵌态不得再嵌一层 .dru-settings-section");

  // 出得去：点「🖥 自建服务」→ 回到 home（模式 tab 点击必须把 view 复位成 home）
  tabs[1].props.onClick();
  tree = plugin.render();
  assert.equal(find(tree, (n) => n.props?.className === "dru-wx-embed"), undefined,
    "点模式 tab 后必须离开微信视图（微信内容不再渲染）");
  const modeTab = find(tree, (n) => n.props?.role === "tab" && (n.children || []).includes("🖥 自建服务"));
  assert.equal(modeTab.props["aria-selected"], "true", "点自建服务后它应成为选中态（且 view 回到 home）");
  assert.equal(find(tree, (n) => n.props?.role === "tab" && (n.children || []).some((c) => typeof c === "string" && c.includes("微信机器人通道"))).props["aria-selected"], "false",
    "离开微信视图后微信 tab 不得再是选中态");
  // 进得去：再点回微信 tab
  const back = find(tree, (n) => n.props?.role === "tab" && (n.children || []).some((c) => typeof c === "string" && c.includes("微信机器人通道")));
  back.props.onClick();
  const again = plugin.render();
  assert.ok(textHas(again, "未绑定") || textHas(again, "已绑定"), "再点回来仍是微信机器人内容");
  assert.equal(find(again, (n) => n.props?.className === "dru-wx-ico") ? true : false, true, "tab 条（含绿泡泡）仍在");
});

test("绿泡泡与零外部资源（源码级）：.dru-wx-ico 是微信品牌绿、不新增任何外部资源/依赖", () => {
  // 图标颜色：微信品牌绿 #07c160（业主口径：「增加上微信的绿泡泡小图标」）
  assert.match(SOURCE, /\.dru-wx-ico\{[^}]*color:#07c160/, "绿泡泡必须是微信品牌绿 #07c160");
  // 装饰性：节点上 aria-hidden（可读名字来自同 tab 的文字标签，见上一条用例）
  assert.match(SOURCE, /className: "dru-wx-ico", "aria-hidden": "true"/, "图标节点必须 aria-hidden");
  assert.match(SOURCE, /"微信机器人通道"/, "tab 必须有真实文字标签（不靠颜色/图标单独表意）");
  // 图标 = 一个 emoji 字符 + 一条 CSS 规则，不加载任何外部资源（字体/图片/脚本/样式）
  assert.doesNotMatch(SOURCE, /@import/, "不得 @import 外部样式");
  assert.doesNotMatch(SOURCE, /url\(\s*["']?https?:/, "CSS 里不得引用远程 url(...)");
  assert.doesNotMatch(SOURCE, /createElement\("link"\)|createElement\('link'\)/, "不得注入外部 <link>");
  assert.doesNotMatch(SOURCE, /createElement\("script"\)|createElement\('script'\)/, "不得注入外部 <script>");
  assert.doesNotMatch(SOURCE, /qrcodejs|qrcode-generator|davidshimjs|jsqr|nayuki|qrcode\.min\.js/i, "不得引入 QR 库");
  // 依赖侧同样零新增：dsh-remote-web 没有（也不得有）任何运行时依赖
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dependencies || {}, {}, "dsh-remote-web 不得有运行时依赖（零依赖不变量）");
});

test("主题不变量：根节点带 .dru-settings-section + data-dru-theme；新增样式只引用令牌、不落 :root/body", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();
  // 本组件（WeChatBotSection）现在是 embedded 的**子组件**，所以「根节点」＝面板根
  // RemoteControlSection（唯一那个 .dru-settings-section）。令牌照旧挂在这一层，内嵌组件继承。
  assert.equal(tree.props.className, "dru-settings-section", "根节点必须带 .dru-settings-section（--dru-* 令牌挂在这里）");
  assert.equal(tree.props["data-dru-theme"], "light", "根节点必须带 data-dru-theme（JS 解析出的宿主主题）");
  assert.equal(tree.props.role, "region");
  // 内嵌态：微信内容体自己不再带 .dru-settings-section（否则就是 settings-section 套娃），
  // 但**仍然**带 data-dru-theme（组件根的不变量照旧成立），且不新增任何令牌声明点。
  const embed = find(tree, (n) => n.props?.className === "dru-wx-embed");
  assert.ok(embed, "内嵌态应渲染 .dru-wx-embed 内容体");
  assert.equal(embed.props.className.includes("dru-settings-section"), false, "内嵌态不得再嵌一层 .dru-settings-section");
  assert.equal(embed.props["data-dru-theme"], "light", "内嵌态根节点仍带 data-dru-theme");
  assert.equal(embed.props.role, "region");
  assert.equal(embed.props["aria-label"], "微信机器人通道");

  // 微信那段新样式：只能 var(--dru-*)，不得自己声明令牌，也不得挂 :root/body
  const start = SOURCE.indexOf("── 🤖 微信机器人（「📱 远程访问」面板里的第三个 tab：微信机器人通道） ──");
  const end = SOURCE.indexOf("── 用户反馈模块 ──", start);
  assert.ok(start > 0 && end > start, "应能定位到微信的样式块");
  const block = SOURCE.slice(start, end);
  assert.doesNotMatch(block, /--dru-[a-z0-9-]+\s*:/, "新样式不得**声明**令牌（只许引用）");
  assert.doesNotMatch(block, /:root|\bbody\b/, "新样式不得挂在 :root/body 上（会污染整个 GUI）");
  assert.match(block, /var\(--dru-/, "新样式应复用既有令牌");
  // 令牌声明只允许出现在那三个选择器上（原有注释所述的不变量）
  assert.match(SOURCE, /"\.dru-settings-section,\.dru-popup,\.dru-nav-remote\{"/, "亮色令牌块的选择器不得扩大");
  assert.doesNotMatch(SOURCE, /":root\{/);
});

// ── 0.6.12：核心功能导览 / 登录门 / 动效引导 ────────────────────────────────

test("首屏导览：未绑定时就在最上面（DOM 顺序在「连接微信机器人」之前），三句话说清这是干什么用的", async () => {
  const plugin = loadPlugin();
  const tree = await plugin.settle();
  const embed = find(tree, (n) => n.props?.className === "dru-wx-embed");
  assert.ok(embed, "前提：已进入微信 tab");

  const intro = find(tree, (n) => n.props?.className === "dru-wx-intro");
  assert.ok(intro, "微信 tab 顶部必须有用途导览块（.dru-wx-intro）—— 这是绑定的理由，必须绑之前就看得见");
  // 语义：说明性文字（role=note + 可读名字），不是又一个按钮/工具栏
  assert.equal(intro.props.role, "note");
  assert.ok(intro.props["aria-label"], "导览块要有可读的名字");
  // 排版：小标题 + 若干行短句，不许变成大横幅
  const rows = [];
  walk(intro, (n) => { if (n.props?.className === "dru-wx-intro-row") rows.push(n); });
  assert.ok(rows.length >= 3 && rows.length <= 8, `导览应是 3~8 行短句，实际 ${rows.length} 行`);

  // 每项能力各说各的（缺一不可）—— 现在按能力清单渲染，允许带 ✅/🔒 前缀
  assert.ok(textHas(intro, "完成") && textHas(intro, "出错") && textHas(intro, "停下"),
    "① 要说清「任务完成 / 出错 / 停下」这些时刻");
  assert.ok(textHas(intro, "推送"), "① 要明说是**推送到微信**（不用守着电脑）");
  assert.ok(textHas(intro, "回一个数字"), "② 要明说「在微信里回一个数字」就完成决定");
  assert.ok(textHas(intro, "拍板"), "② 要交代这是需要你拍板的时刻");
  assert.ok(textHas(intro, "继续已有任务"), "③ 要明说免费也能继续已有任务（回复即续接）");
  assert.ok(textHas(intro, "开新任务"), "③ 要明说「在微信里开新任务」是会员能力");
  assert.ok(textHas(intro, "切换会话"), "③ 要明说「切换会话」是会员能力");
  // ★ 分层必须如实写在面板上：免费用户要能看出**付费多什么**（业主："增加一个对比展示"）。
  //   面板里含糊其辞 → 用户绑完去微信发句话拿到付费提示 → 只会觉得产品骗人。
  assert.ok(textHas(intro, "会员"), "必须标出哪些是会员能力（不能含糊）");
  assert.ok(textHas(intro, "额度"), "免费档要写明每月消息额度（业主：免费给每月 N 条）");
  // 未绑定/未读到状态时不显示锁，免得闪一下
  assert.ok(!textHas(intro, "🔒") || textHas(intro, "会员"), "锁必须配「会员」字样，不能只给一个符号");

  // DOM 顺序：导览在「连接微信机器人」按钮之前（用户先看懂用途，再看到按钮）
  const introAt = domIndex(tree, (n) => n.props?.className === "dru-wx-intro");
  const btnAt = domIndex(tree, (n) => n.type === "button" && (n.children || []).some((c) => typeof c === "string" && c.includes("连接微信机器人")));
  assert.ok(introAt >= 0 && btnAt >= 0, "导览与连接按钮都必须存在");
  assert.ok(introAt < btnAt, `导览必须排在连接按钮之前（导览 #${introAt}，按钮 #${btnAt}）`);
  // 而且导览是内容体的**第一个**孩子：不会把连接按钮推到需要滚动才看得见的地方
  // （harness 渲染时会对普通节点做浅拷贝，所以拿树里的同一个节点比，不比组件里的原对象）
  assert.equal(embed.children[0], find(embed, (n) => n.props?.className === "dru-wx-intro"),
    "导览必须是内嵌内容体的第一个孩子（连接按钮仍在首屏）");
  // 紧凑小字（不是宣传横幅）：样式里明确给了小字号
  assert.match(SOURCE, /\.dru-wx-intro-row\{[^}]*font-size:12px/, "导览行必须是小字（不挤占首屏）");

  // 已绑定态同样保留导览（常驻用途说明，不占按钮、不影响状态卡）
  plugin.setStatus(BOUND);
  const refreshBtn = buttonWithText(tree, "刷新状态");
  assert.ok(refreshBtn, "未绑定卡上应有「刷新状态」按钮（用它把新状态读回来）");
  refreshBtn.props.onClick();
  const boundTree = await plugin.settle();
  assert.ok(find(boundTree, (n) => n.props?.className === "dru-wx-intro"), "已绑定态也应保留用途导览");
  assert.ok(textHas(boundTree, "已绑定"));
});

test("登录门：未登录时**没有**「微信机器人通道」tab（只剩两个模式 tab）；登录后当场出现，不用刷新页面", async () => {
  const plugin = loadPlugin({ signedIn: false });
  let tree = await plugin.settle();

  // 未登录：tab 不存在（harness 的 auto-enter 也因此不会发生）
  assert.equal(plugin.weChatTabOf(tree), undefined, "未登录时不得渲染「微信机器人通道」tab");
  const labelsOf = (t) => {
    const tabs = [];
    walk(t, (n) => { if (n.props?.role === "tab") tabs.push(n); });
    return tabs.map((x) => (x.children || []).filter((c) => typeof c === "string").join(""));
  };
  assert.deepEqual(labelsOf(tree), ["☁️ 云端服务", "🖥 自建服务"], "未登录时主 tab 条只剩两个模式 tab");
  assert.equal(find(tree, (n) => n.props?.className === "dru-wx-embed"), undefined, "未登录时不得渲染微信内容");
  // 不是空面板：账号/登录区就在 home
  assert.ok(textHas(tree, "登录"), "未登录时应看到登录/账号区（不是空白）");

  // 登录（/status 带上 config.phone）→ 不刷新页面，tab 当场出现
  plugin.setSignedIn(true);
  tree = await plugin.settle();
  const tab = plugin.weChatTabOf(tree);
  assert.ok(tab, "登录成功后微信 tab 必须自己出现（不需要刷新页面）");
  assert.deepEqual(labelsOf(tree), ["☁️ 云端服务", "🖥 自建服务", "微信机器人通道"], "登录后 tab 条恢复三个 tab");
  assert.ok(find(tree, (n) => n.props?.className === "dru-wx-ico"), "微信绿泡泡图标照旧");

  // 且点得进去、内容正常
  tab.props.onClick();
  tree = await plugin.settle();
  assert.ok(find(tree, (n) => n.props?.className === "dru-wx-embed"), "登录后点 tab 应进入微信机器人内容");
  assert.ok(textHas(tree, "未绑定") || textHas(tree, "已绑定"), "内容读到状态（不是空面板）");
});

test("登录门（防御）：微信 tab 开着时会话失效 → 不渲染微信内容、回落到 home，绝不留空面板", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle(); // auto-enter：已进入微信 tab
  assert.ok(find(tree, (n) => n.props?.className === "dru-wx-embed"), "前提：已在微信 tab 里");
  assert.ok(find(tree, (n) => n.props?.["aria-label"] === "微信机器人通道"), "前提：微信 region 在渲染");

  // 会话在 tab 开着的时候过期：/status 不再带 config.phone（登出 / 被踢下线 / 换账号）
  plugin.setSignedIn(false);
  plugin.setStatus(NOT_BOUND);
  tree = await plugin.settle();

  // ① 微信内容一个都不渲染（没有内容体、没有那个 region）
  assert.equal(find(tree, (n) => n.props?.className === "dru-wx-embed"), undefined, "登出后不得再渲染微信内容体");
  assert.equal(find(tree, (n) => n.props?.role === "region" && n.props?.["aria-label"] === "微信机器人通道"), undefined,
    "登出后不得再渲染「微信机器人通道」region");
  // ② 也不是空白：已经回落到 home（账号/登录卡 + 主 tab 条都在）
  assert.ok(find(tree, (n) => n.props?.role === "tablist"), "应回到 home 的 tab 条");
  assert.ok(textHas(tree, "登录") && textHas(tree, "注册"), "home 的账号卡（登录/注册）应在场，不留空面板");
  assert.ok(textHas(tree, "后台服务") || textHas(tree, "远程访问"), "home 的其它卡片也应在场");
  // ③ 微信 tab 自身也消失（登录门一致）
  assert.equal(plugin.weChatTabOf(tree), undefined, "登出后微信 tab 必须消失");

  // ④ 重新登录：user 不用刷新页面就能回到微信 tab
  plugin.setSignedIn(true);
  tree = await plugin.settle();
  const tab = plugin.weChatTabOf(tree);
  assert.ok(tab, "重新登录后微信 tab 应再次出现");
  tab.props.onClick();
  tree = await plugin.settle();
  assert.ok(find(tree, (n) => n.props?.className === "dru-wx-embed"), "重新登录后可以正常再进微信 tab");
});

test("动效引导（未绑定）：连接按钮带 .dru-wx-attn、装饰点 aria-hidden；样式表有 prefers-reduced-motion 关闭规则；绑定后消失", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();

  const connect = buttonWithText(tree, "连接微信机器人");
  assert.ok(connect, "未绑定态要有「连接微信机器人」按钮");
  assert.ok(hasClass(connect, "dru-wx-attn"), "未绑定时连接按钮要带动效引导类 .dru-wx-attn");
  // 无障碍：动效只是强调 —— 按钮文字与同卡片的文字提示本身已经把「要做什么」说清楚了
  assert.ok(textHas(tree, "还没连接"), "未绑定态必须有文字提示（不许只靠动效表意）");
  const dot = find(tree, (n) => hasClass(n, "dru-wx-attn-dot"));
  assert.ok(dot, "未绑定态应有装饰性呼吸圆点（与按钮同一份引导）");
  assert.equal(dot.props["aria-hidden"], "true", "纯装饰节点必须 aria-hidden");

  // 样式表：CSS 动画（@keyframes，零外部资源）+ 明确的「减弱动态效果」豁免
  const start = SOURCE.indexOf("── 🤖 微信机器人（「📱 远程访问」面板里的第三个 tab：微信机器人通道） ──");
  const end = SOURCE.indexOf("── 用户反馈模块 ──", start);
  const block = SOURCE.slice(start, end);
  assert.match(block, /\.dru-wx-attn\{[^}]*animation:/, "引导必须是 CSS 动画");
  assert.match(block, /@keyframes\s+dru-wx-breathe/, "@keyframes 必须就地在样式块里声明（不引外部资源）");
  assert.match(block, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^}]*\.dru-wx-attn[^}]*animation:\s*none/,
    "prefers-reduced-motion: reduce 必须关掉动画（无障碍硬要求）");
  assert.match(block, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[^}]*\.dru-wx-attn-dot[^}]*animation:\s*none/,
    "装饰圆点的动画也要在 prefers-reduced-motion 下关掉");
  // 节流：呼吸要「慢」（≥2s 一轮），不是刺眼的快闪
  const period = /\.dru-wx-attn\{[^}]*?(\d+(?:\.\d+)?)s/.exec(block);
  assert.ok(period && Number(period[1]) >= 2, `呼吸周期必须够慢（≥2s），实际：${period && period[1]}`);
  assert.doesNotMatch(block, /animation:[^;"}]*\binfinite[^;"}]*\b(?:alternate-reverse|reverse)\b/, "不得做来回翻转式闪烁");
  // 颜色只用既有令牌：动效相关规则里不得出现颜色字面量
  for (const line of block.split("\n")) {
    if (!/dru-wx-attn|dru-wx-breathe|dru-wx-pulse/.test(line)) continue;
    assert.doesNotMatch(line, /#[0-9a-fA-F]{3,8}\b/, `动效样式不得硬编码颜色，只能用 --dru-* 令牌：${line.trim()}`);
  }

  // 已绑定：引导与动效一并消失（状态卡取代未绑定引导）
  plugin.setStatus(BOUND);
  buttonWithText(tree, "刷新状态").props.onClick(); // 让面板重读状态（refresh → tick）
  tree = await plugin.settle();
  assert.ok(textHas(tree, "已绑定"), "绑定后应是已绑定状态卡");
  assert.equal(buttonWithText(tree, "连接微信机器人"), undefined, "已绑定后不得再有「连接微信机器人」按钮");
  assert.equal(find(tree, (n) => hasClass(n, "dru-wx-attn")), undefined, "已绑定后不得再有任何 .dru-wx-attn 动效节点");
  assert.equal(find(tree, (n) => hasClass(n, "dru-wx-attn-dot")), undefined, "已绑定后不得再有呼吸圆点");
});

test("未绑定：说明用途 + 「连接微信机器人」按钮；点了之后从 qrcode_svg 直接渲染二维码（零 QR 库/零外部资源）", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  assert.ok(textHas(tree, "未绑定"), "未绑定态要有明确结论");
  assert.ok(textHas(tree, "回一个数字"), "要说清「在微信里回一个数字就能决定」");
  assert.ok(textHas(tree, "关键节点") || textHas(tree, "放行"), "要说清会推什么（需要你拍板/报错/停下）");

  tree = await enterBinding(plugin);
  const img = find(tree, (n) => n.type === "img");
  assert.ok(img, "绑定中必须渲染二维码图片");
  assert.equal(img.props.src, QR_DATA_URL, "img.src 必须是 bridge 下发的 qrcode_svg（data: URL）本身");
  assert.equal(img.props.className, "dru-wx-qr");
  assert.ok(img.props.alt && /二维码/.test(img.props.alt), "图片要有可读的 alt");
  assert.ok(textHas(tree, "请用手机微信"), "要有「请用手机微信扫码」的提示");

  // 零 QR 库 / 零外部资源：不引第三方编码器，组件区域里不出现任何 http(s) 外链
  assert.doesNotMatch(SOURCE, /qrcodejs|qrcode-generator|davidshimjs|jsqr|nayuki|qrcode\.min\.js/i, "不得引入 QR 库");
  assert.doesNotMatch(SOURCE, /createElement\("script"\)|createElement\('script'\)/, "不得注入外部脚本");
  const compStart = SOURCE.indexOf("function WeChatBotSection(");
  const compEnd = SOURCE.indexOf("// ── 插件入口 ──", compStart);
  const comp = SOURCE.slice(compStart, compEnd);
  assert.ok(comp.length > 500, "应能定位到微信栏目组件");
  assert.doesNotMatch(comp, /https?:\/\//, "组件里不得出现外部资源地址（二维码只能来自 bridge 的 data: URL）");
});

test("扫码阶段：poll 依次推进 wait → scaned，且 1.5s 一轮、同一次只有一个请求在飞", async () => {
  const plugin = loadPlugin({
    polls: [
      { status: 200, body: { ok: true, state: "wait", bound: false } },
      { status: 200, body: { ok: true, state: "scaned", bound: false } }
    ]
  });
  let tree = await enterBinding(plugin);
  assert.ok(textHas(tree, "等待手机扫码"), "初始应提示等待扫码");

  await plugin.advance(1600);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, 1, "1.5s 应恰好推进一次（不是并发猛打）");

  await plugin.advance(1600);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, 2);
  assert.ok(textHas(tree, "已扫码"), "scaned 应提示「已扫码，请在手机上确认」");
});

test("配对码：need_verify_code 为真 → 出现数字输入框；提交后 POST {code} 并继续轮询", async () => {
  const plugin = loadPlugin({
    polls: [
      { status: 200, body: { ok: true, state: "need_verifycode", need_verify_code: true, bound: false } }
    ]
  });
  let tree = await enterBinding(plugin);
  await plugin.advance(1600);
  tree = await plugin.settle();

  const input = find(tree, (n) => n.type === "input" && n.props?.inputMode === "numeric");
  assert.ok(input, "need_verify_code 为真时必须出现配对码输入框（这一步真机上极易漏）");
  assert.ok(textHas(tree, "配对码"), "要说明这串数字来自手机微信");

  // 非数字：不提交，给出可读提示
  input.props.onChange({ target: { value: "abc" } });
  tree = await plugin.settle();
  const submit = buttonWithText(tree, "提交配对码");
  assert.ok(submit, "必须有「提交配对码」按钮");
  submit.props.onClick();
  tree = await plugin.settle();
  assert.equal(plugin.counts().verify, 0, "非数字不得提交");
  assert.ok(textHas(tree, "1~8 位数字"), "应就地说明格式要求");

  // 真数字：重新输入并提交
  const input2 = find(plugin.render(), (n) => n.type === "input" && n.props?.inputMode === "numeric");
  input2.props.onChange({ target: { value: "1234" } });
  tree = await plugin.settle();
  buttonWithText(tree, "提交配对码").props.onClick();
  tree = await plugin.settle();
  const hit = plugin.requests.filter((r) => r.path === "/dsh-remote/wechat/bind/verify").pop();
  assert.ok(hit, "应请求 /dsh-remote/wechat/bind/verify");
  assert.equal(hit.method, "POST");
  assert.deepEqual(hit.body, { code: "1234" }, "必须把手机上的数字原样带回");
  assert.ok(textHas(tree, "已提交"), "提交后要有反馈（否则用户会重复点）");
});

test("轮询停止①：confirmed —— 立即停轮询、切到已绑定视图并重取状态", async () => {
  const plugin = loadPlugin({
    polls: [{ status: 200, body: { ok: true, state: "confirmed", bound: true } }]
  });
  let tree = await enterBinding(plugin);
  plugin.setStatus(BOUND); // bridge 此时已落盘凭据
  await plugin.advance(1600);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, 1);
  assert.ok(textHas(tree, "已绑定"), "确认后应切到已绑定视图");
  assert.ok(textHas(tree, "bot_7788"), "应显示机器人 ID");

  const before = plugin.counts().poll;
  await plugin.advance(20_000);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, before, "confirmed 之后不得再轮询 binding（后台服务不该被打）");
});

test("轮询停止②：失败 —— 宿主代理报错时停下并原文照登", async () => {
  const plugin = loadPlugin({
    polls: [{ status: 400, body: { ok: false, code: "upstream_400", error: "轮询失败:二维码已失效，请重新发起绑定。" } }]
  });
  let tree = await enterBinding(plugin);
  await plugin.advance(1600);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, 1);
  assert.ok(textHas(tree, "二维码已失效"), "失败原因要如实显示，不能只说「失败」");
  const before = plugin.counts().poll;
  await plugin.advance(20_000);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, before, "失败后必须停止轮询");
  assert.ok(buttonWithText(tree, "刷新二维码") || buttonWithText(tree, "换一张二维码"), "失败后要给出可操作的出路");
});

test("轮询停止③：取消 —— 点「取消连接」后不再轮询，且通知 bridge 取消", async () => {
  const plugin = loadPlugin();
  let tree = await enterBinding(plugin);
  await plugin.advance(1600);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, 1);

  buttonWithText(tree, "取消连接").props.onClick();
  tree = await plugin.settle();
  assert.equal(plugin.counts().cancel, 1, "应通知 bridge 取消这次绑定");
  const before = plugin.counts().poll;
  await plugin.advance(20_000);
  tree = await plugin.settle();
  assert.equal(plugin.counts().poll, before, "取消后必须停止轮询");
  assert.ok(textHas(tree, "已取消"), "取消要给出明确结果");
  assert.ok(textHas(tree, "未绑定") || textHas(tree, "连接微信机器人"), "应回到未绑定视图");
});

test("轮询停止④：卸载 —— 组件从设置页消失后立刻停表", async () => {
  const plugin = loadPlugin();
  await enterBinding(plugin);
  await plugin.advance(1600);
  assert.equal(plugin.counts().poll, 1);
  plugin.unmount();
  await plugin.advance(20_000);
  assert.equal(plugin.counts().poll, 1, "卸载后不得继续轮询（否则关掉设置页还在打后台服务）");
});

test("expired：告知二维码已过期，并给「刷新二维码」；不再对着作废的码轮询", async () => {
  const plugin = loadPlugin({
    polls: [{ status: 200, body: { ok: true, state: "expired", bound: false } }]
  });
  let tree = await enterBinding(plugin);
  await plugin.advance(1600);
  tree = await plugin.settle();
  assert.ok(textHas(tree, "二维码已过期"), "要如实说二维码过期了");
  assert.ok(buttonWithText(tree, "刷新二维码"), "过期后必须能一键换一张新码");
  const before = plugin.counts().poll;
  await plugin.advance(20_000);
  assert.equal(plugin.counts().poll, before, "过期的码扫不出任何东西，继续轮询只是假装在等");
});

test("已绑定：两态模型 —— 健康提示只说「已绑定」，另加 ID/时间/最近错误；解绑要二次确认", async () => {
  const plugin = loadPlugin({
    status: { ...BOUND, last_error: "sendmessage 失败:session timeout", cooldown_ms: 3_600_000 }
  });
  let tree = await plugin.settle();
  assert.ok(textHas(tree, "已绑定"), "应显示已绑定");
  assert.ok(textHas(tree, "bot_7788"), "应显示机器人 ID");
  assert.ok(textHas(tree, "绑定时间"), "应显示绑定时间");
  // 健康字段是**提示**，绝不能变成第三种绑定状态
  assert.ok(textHas(tree, "最近一次推送失败"), "要如实显示最近一次推送失败");
  assert.ok(textHas(tree, "不改变绑定状态"), "必须写明健康提示不改变绑定状态");
  assert.ok(!textHas(tree, "未绑定"), "已绑定时不得同时出现「未绑定」");
  assert.ok(textHas(tree, "冷却"), "冷却中要说清楚（否则用户以为通知坏了）");

  // 解绑：第一次点击只是进入确认，不发请求
  const unbindBtn = buttonWithText(tree, "解绑");
  assert.ok(unbindBtn, "应有「解绑」按钮");
  unbindBtn.props.onClick();
  tree = await plugin.settle();
  assert.equal(plugin.counts().unbind, 0, "解绑必须先确认，不能一点就走");
  assert.ok(buttonWithText(tree, "确认解绑"), "应出现「确认解绑」");
  assert.ok(textHas(tree, "立即停止"), "要讲清解绑的后果");

  // 反悔：不发请求
  buttonWithText(tree, "先不解绑").props.onClick();
  tree = await plugin.settle();
  assert.equal(plugin.counts().unbind, 0);
  assert.ok(buttonWithText(tree, "解绑"));

  // 再来一次并确认
  buttonWithText(tree, "解绑").props.onClick();
  tree = await plugin.settle();
  plugin.setStatus(NOT_BOUND);
  buttonWithText(tree, "确认解绑").props.onClick();
  tree = await plugin.settle();
  assert.equal(plugin.counts().unbind, 1, "确认后才真的解绑");
  assert.equal(plugin.requests.filter((r) => r.path === "/dsh-remote/wechat/unbind").pop().method, "POST");
  assert.ok(textHas(tree, "已解绑"), "解绑成功后要有明确反馈");
});

test("控制面缺失（bridge 没跑/版本旧）：如实说明 + 可重试 + 不留永久 spinner", async () => {
  const plugin = loadPlugin({
    statusCode: 503,
    status: { ok: false, code: "no_control_file", error: "本机后台服务还没有运行微信机器人通道（找不到发现文件）…请先到「📱 远程访问」面板启动后台服务。" }
  });
  const tree = await plugin.settle();
  assert.ok(textHas(tree, "还没有运行微信机器人通道"), "要把真实原因显示出来");
  assert.ok(textHas(tree, "远程访问"), "要告诉用户去哪里处理");
  assert.ok(textHas(tree, "原因代码：no_control_file"), "失败要带可排查的 code");
  assert.ok(buttonWithText(tree, "重试"), "失败态必须能重试");
  assert.ok(!find(tree, (n) => n.props?.className === "dru-spin"), "失败后不得继续转圈");

  // 修好之后点重试 → 立刻恢复
  plugin.setStatus(NOT_BOUND);
  buttonWithText(plugin.render(), "重试").props.onClick();
  const tree2 = await plugin.settle();
  assert.ok(textHas(tree2, "未绑定"), "重试成功后应回到正常视图");
});

test("无障碍：真 <button>、状态区 aria-live 播报、按钮有文字标签", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  const btns = [];
  walk(tree, (n) => { if (n.type === "button") btns.push(n); });
  assert.ok(btns.length >= 2, "至少要有「连接微信机器人」与「刷新状态」两个真按钮");
  for (const b of btns) {
    assert.equal(b.props.type, "button", "必须是真 <button type=button>（不是可点的 div）");
    assert.ok((b.children || []).some((c) => typeof c === "string" && c.trim()), "按钮必须有可见文字");
  }
  const live = find(tree, (n) => n.props && n.props["aria-live"] === "polite" && n.props.role === "status");
  assert.ok(live, "状态变化要有 aria-live 播报位");

  // 绑定态：阶段行也要能被读屏播报
  tree = await enterBinding(plugin);
  const phaseRow = find(tree, (n) => n.props?.className === "dru-wx-phase");
  assert.ok(phaseRow, "应有绑定阶段行");
  assert.equal(phaseRow.props["aria-live"], "polite");
  assert.equal(phaseRow.props.role, "status");
});

test("★★ 面板能力镜像必须与运行时判定表一致（否则面板会承诺微信里做不到的事）", async () => {
  // 这条守的是「话术与权限一致」：面板说免费能用什么，微信里就必须真的能用。
  // 面板多写一项 → 用户绑完去微信一试就拿到付费提示 → 只会觉得产品骗人。
  const rt = await import("../../../clients/dsh-remote/wechat-runtime.mjs");
  const grab = (name) => {
    const m = new RegExp(`var ${name} = (\\[[^\\]]*\\])`).exec(SOURCE);
    assert.ok(m, `client.js 顶层应有 ${name}（测试靠它跟运行时对账）`);
    return JSON.parse(m[1]);
  };
  const mirrorFree = grab("WECHAT_FREE_CAPS");
  const mirrorPaid = grab("WECHAT_PAID_CAPS");
  const q = /var WECHAT_FREE_MSGS_PER_MONTH = (\d+)/.exec(SOURCE);
  assert.ok(q, "client.js 顶层应有 WECHAT_FREE_MSGS_PER_MONTH");
  const mirrorMsgs = Number(q[1]);

  // ① 免费档必须**逐项相等** —— 这是最容易出错、后果最重的一侧
  assert.deepEqual([...mirrorFree].sort(), [...rt.WECHAT_CAPABILITY_TABLE.free].sort(),
    "★面板的免费能力必须与运行时判定表逐项相同");

  // ② 面板列的付费能力必须都被运行时真正授权（粗粒度也算，用前缀规则判）
  for (const cap of mirrorPaid) {
    assert.ok(rt.grantsCap(rt.WECHAT_CAPABILITY_TABLE.pro, cap),
      `面板声称会员有 ${cap}，但运行时并没有授权它`);
  }

  // ③ 展示用的每一条文案都要挂在一个真实的能力上（不许出现"没有对应闸门"的承诺）
  const known = new Set([...mirrorFree, ...mirrorPaid]);
  const labelSrc = /var WECHAT_CAP_LABELS = (\[[\s\S]*?\]);/.exec(SOURCE);
  assert.ok(labelSrc, "client.js 应有 WECHAT_CAP_LABELS");
  const labels = JSON.parse(labelSrc[1].replace(/([{,]\s*)(\w+):/g, '$1"$2":').replace(/'/g, '"'));
  assert.ok(labels.length >= 4, `能力文案太少（${labels.length} 条），导览会说不清能干什么`);
  for (const row of labels) {
    assert.ok(known.has(row.cap), `文案挂在未知能力上：${row.cap}`);
    assert.ok(row.free || row.paid, `${row.cap} 既没有免费文案也没有付费文案`);
  }

  // ④ 额度数字必须与运行时一致（面板写 20、实际给 5 是最容易被投诉的那种不一致）
  assert.equal(mirrorMsgs, Number(rt.WECHAT_TIER_LIMITS.free.messages_per_month),
    "★面板展示的每月额度必须与运行时限制相同");
});

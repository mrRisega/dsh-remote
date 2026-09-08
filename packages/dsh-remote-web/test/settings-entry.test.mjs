// dsh-remote-web 浏览器半回归（2026-09 前名 dsh-remote-ui）：面板入口迁移进「设置」页 settings.section 官方扩展点。
// 覆盖：栏目注册（id/order/label）、侧边栏入口与浮动面板移除、账号区无「切换账号」、
// 「关于 dsh-remote」说明卡片、退出登录/切换连接账号清理反馈线程凭据、首次安装红点引导。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else walk(child, visit);
  }
}

function find(tree, predicate) {
  let match;
  walk(tree, (node) => { if (!match && predicate(node)) match = node; });
  return match;
}

/** 任意文本子节点包含子串（用于动态拼接文案，如「已授权设备 N」）。 */
function textHas(tree, substr) {
  return !!find(tree, (node) => (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}

/** 极简 DOM 元素假件（够 client.js 的红点注入用）。 */
function makeEl(tag) {
  return {
    tag,
    className: "",
    attributes: {},
    style: {},
    children: [],
    parentNode: null,
    listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(t, f) { this.listeners[t] = f; },
    removeEventListener(t, f) { delete this.listeners[t]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    },
    querySelector(sel) {
      const cls = sel.charAt(0) === "." ? sel.slice(1) : "";
      return this.children.find((c) => c.className === cls) || null;
    },
  };
}

/**
 * 在 vm 沙箱中加载 client.js 并 apply，返回可控句柄。
 * @param {object} opts - navCells（document.querySelectorAll("button") 返回值，可后续 push）、
 *                        localStorageSeed（预置 key/value）。
 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const metas = new Map();
  const injects = new Map();
  const requests = [];
  const removed = [];
  const states = [];
  let hook = 0;

  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const index = hook++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useEffect() {},
    useCallback(fn) { return fn; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };

  const response = (status, body) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  const allCreated = [];
  const doc = {
    createElement(tag) { const el = makeEl(tag); allCreated.push(el); return el; },
    head: makeEl("head"),
    body: makeEl("body"),
    querySelector(sel) {
      const cls = sel.charAt(0) === "." ? sel.slice(1) : "";
      return allCreated.find((el) => el.className === cls) || null;
    },
    querySelectorAll(sel) { return sel === "button" ? (opts.navCells || []) : []; },
  };

  let lastObserver = null;
  class MutationObserverMock {
    constructor(cb) { this.cb = cb; lastObserver = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }

  const localStorage = {
    _store: new Map(Object.entries(opts.localStorageSeed || {})),
    getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
    setItem(k, v) { this._store.set(k, String(v)); },
    removeItem(k) { removed.push(k); this._store.delete(k); },
  };

  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } } },
    document: doc,
    localStorage,
    MutationObserver: MutationObserverMock,
    fetch(path, options = {}) {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
      if (path === "/dsh-remote/captcha") return response(200, { captcha_id: "cap-1", svg: "<svg></svg>" });
      if (path === "/dsh-remote/logout") {
        return response(200, { ok: true, config: { phone: "", deviceId: "dev-x" }, service: { running: false } });
      }
      if (path === "/dsh-remote/status") {
        return response(200, { ok: true, config: { phone: "", deviceId: "dev-x" }, service: { running: false } });
      }
      return response(200, { body: { ok: true } });
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    Set,
    Symbol,
  };

  vm.runInNewContext(SOURCE, sandbox);
  const plugin = moduleFactory((name) => {
    assert.equal(name, "react");
    return react;
  });
  plugin.apply({ slots: {
    inject(name, cb) { injects.set(name, cb); cb(); }, // 立即执行（模拟槽已声明、可注册）
    register(meta, component) {
      metas.set(meta.id, meta);
      registered.set(meta.id, component);
      return () => {};
    },
  } });

  return {
    registered, metas, injects, requests, removed, states, localStorage,
    lastObserver: () => lastObserver,
    renderSection() { hook = 0; return registered.get("dsh-remote")({ close() {} }); },
  };
}

test("入口迁移：注册 settings.section 栏目（id/order/label），移除侧边栏入口与浮动面板", () => {
  const plugin = loadPlugin();

  // 不再注入侧边栏入口槽
  assert.equal(plugin.injects.has("sidebar.footer.action"), false, "侧边栏入口槽不应再注入");

  // settings.section 官方扩展点：id=dsh-remote、order=30（> Agent 预设 20，位于其下方）、label=📱 远程访问
  assert.ok(plugin.injects.has("settings.section"), "应注入 settings.section 扩展点");
  const disposeSection = plugin.injects.get("settings.section")();
  assert.equal(typeof disposeSection, "function", "register 应返回 disposer");
  const meta = plugin.metas.get("dsh-remote");
  assert.ok(meta, "栏目条目应以 id=dsh-remote 注册");
  assert.equal(meta.name, "settings.section");
  assert.equal(meta.order, 30);
  assert.equal(typeof meta.label, "function");
  const label = meta.label();
  assert.ok(String(label).includes("远程访问"), `栏目名应含「远程访问」，实际: ${label}`);
  assert.ok(String(label).includes("📱"), "栏目名应带 📱 远程访问图标（手机访问语义）");
  assert.ok(!String(label).includes("远程控制"), "栏目名不应再残留旧称「远程控制」");

  // shell.overlay 仅保留满意度弹窗，浮动面板已移除
  assert.ok(plugin.injects.has("shell.overlay"));
  plugin.injects.get("shell.overlay")();
  assert.ok(plugin.registered.has("dsh-feedback-popup"), "满意度弹窗应保留在 shell.overlay");
  assert.equal(plugin.registered.has("dsh-remote-panel"), false, "浮动配置面板不应再注册");
});

test("登录态账号区：无「切换账号」，有「退出登录」，头部/关于卡文案为「远程访问」", () => {
  const plugin = loadPlugin();
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-test" }, service: { running: false } };
  let tree = plugin.renderSection();

  // 栏目头部：标题「远程访问」+ 副文案（人在哪都能用，免公网 IP）
  assert.ok(find(tree, (n) => n.children?.includes("远程访问")), "头部标题应为「远程访问」");
  assert.ok(find(tree, (n) => n.children?.includes("通过手机或另一台电脑远程使用同一份 dsh web，人在哪都能用（免公网 IP）")), "应渲染新副文案（人在哪都能用，免公网 IP）");

  // 账号区按钮
  assert.ok(find(tree, (n) => n.children?.includes("退出登录")), "应保留「退出登录」");
  assert.ok(!find(tree, (n) => n.children?.includes("切换账号")), "「切换账号」按钮应移除");

  // 关于 dsh-remote 说明卡片（面板底部，v0.5+ 价值要点）
  assert.ok(find(tree, (n) => n.children?.includes("📖 关于 dsh-remote")), "应渲染「关于 dsh-remote」卡片标题");
  const points = [
    "📱 远程访问：用手机或另一台电脑的浏览器，随时随地使用同一份 dsh web——人在哪都能用（免公网 IP、免内网穿透）；官方托管中继，4G/5G 即用，也可自建服务。",
    "🛠 电脑端一键安装：bridge 与「远程访问」面板一次到位——云端/自建切换、账号登录、bridge 启停、一次性扫码访问、已授权设备管理、意见反馈都在这里。",
    "🔒 安全与通道：HTTP / WebSocket 全量透传，一次性访问密钥认证，面板实时显示设备与已授权设备列表；服务端可配置流量配额。",
    "🛡 端到端流量保护：可选对通道做端到端加密保护，传输全程不暴露本机公网 IP（详见项目 README「安全」说明）。",
  ];
  for (const p of points) {
    assert.ok(find(tree, (n) => n.children?.includes(p)), `说明卡片应含要点: ${p.slice(0, 12)}…`);
  }

  // 面板主体仍在（连接模式 tab 不受影响）
  assert.ok(find(tree, (n) => n.children?.includes("☁️ 云端服务")), "云端服务 tab 应保留");
  assert.ok(find(tree, (n) => n.children?.includes("🖥 自建服务")), "自建服务 tab 应保留");

  // 📱 远程访问卡 / 📲 已授权设备卡在云端视图中渲染（bridge 未运行 → “等待设备连接”）
  assert.ok(find(tree, (n) => n.children?.includes("等待设备连接")), "无 bridge 时应显示「等待设备连接」状态行");
  assert.ok(textHas(tree, "已授权设备"), "应渲染「已授权设备」管理按钮");
});

test("退出登录清除用户反馈线程凭据（localStorage dsh-feedback-threads）", async () => {
  const plugin = loadPlugin({ localStorageSeed: { "dsh-feedback-threads": '[{"id":"fb_1","token":"tok-abc","at":1}]' } });
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-test" }, service: { running: false } };

  let tree = plugin.renderSection();
  const logoutBtn = find(tree, (n) => n.children?.includes("退出登录"));
  assert.ok(logoutBtn, "应找到「退出登录」按钮");
  logoutBtn.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/logout"), "退出登录应请求 /dsh-remote/logout");
  assert.ok(plugin.removed.includes("dsh-feedback-threads"), "退出登录应清除 dsh-feedback-threads 凭据");
  assert.equal(plugin.localStorage.getItem("dsh-feedback-threads"), null, "本地不应再持有线程凭据");
});

test("首次安装红点：设置页导航栏目出现后注入，点击后写 key、移除红点并停止监听", () => {
  const navCells = [];
  const navCell = makeEl("button");
  navCell.className = "VOzbGW_navCell"; // shell hashed 类名（含 navCell 子串）
  navCell.textContent = "📱 远程访问";
  const plugin = loadPlugin({ navCells });

  // apply 时设置页未打开：观察器就位、无红点
  assert.ok(plugin.lastObserver(), "应创建 MutationObserver");
  assert.equal(plugin.lastObserver().disconnected, undefined, "未点击前观察器不应断开");
  assert.equal(navCell.children.length, 0, "栏目未渲染前不应有红点");

  // 设置页打开：栏目按钮进入 DOM → mutation 回调注入红点
  navCells.push(navCell);
  plugin.lastObserver().cb([]);
  assert.equal(navCell.style.position, "relative", "红点需要 relative 定位容器");
  assert.equal(navCell.children.length, 1, "应注入一个红点");
  assert.equal(navCell.children[0].className, "dru-reddot");
  assert.equal(navCell.children[0].attributes["aria-hidden"], "true");

  // 再次触发观察器：幂等，不重复注入
  plugin.lastObserver().cb([]);
  assert.equal(navCell.children.length, 1, "重复扫描不应重复注入红点");

  // 点击栏目/红点 → 写 localStorage key、红点移除、观察器断开
  assert.equal(typeof navCell.listeners.click, "function", "栏目按钮应挂点击监听");
  navCell.listeners.click();
  assert.equal(plugin.localStorage.getItem("dsh-remote-seen-dot"), "1", "点击后应写入 seen key");
  assert.equal(plugin.lastObserver().disconnected, true, "点击后观察器应断开");
  assert.equal(navCell.children.length, 0, "点击后红点应移除");
});

test("红点已看过（localStorage 有 key）时不注入，重启 DSH Web 不复发", () => {
  const navCells = [];
  const navCell = makeEl("button");
  navCell.className = "VOzbGW_navCell";
  navCell.textContent = "📱 远程访问";
  navCells.push(navCell);
  // 预置 seen key（模拟“首次点击后重启”）
  const plugin = loadPlugin({ navCells, localStorageSeed: { "dsh-remote-seen-dot": "1" } });
  assert.equal(plugin.lastObserver(), null, "已看过时不应创建 MutationObserver");
  assert.equal(navCell.children.length, 0, "已看过时不应再注入红点");
});

test("源码约束：无侧边栏入口/浮动面板/切换账号；命名统一为「远程访问」；新增访问密钥/设备路由", () => {
  // 只断言“代码形态”不存在（注释里允许出现说明文字）
  assert.doesNotMatch(SOURCE, /slots\.inject\("sidebar\.footer\.action"/);
  assert.doesNotMatch(SOURCE, /dru-backdrop\{/);
  assert.doesNotMatch(SOURCE, /切换账号/);
  assert.doesNotMatch(SOURCE, /dsh-remote-panel/);
  assert.doesNotMatch(SOURCE, /远程控制/);   // 旧称呼「远程控制」不再出现（含 label/头部/说明）
  assert.match(SOURCE, /settings\.section/);
  assert.match(SOURCE, /dsh-remote-seen-dot/);
  assert.match(SOURCE, /fbClearThreads/);
  assert.match(SOURCE, /关于 dsh-remote/);
  assert.match(SOURCE, /免公网 IP/);           // 关于卡 v0.5+ 价值要点
  assert.match(SOURCE, /端到端/);
  assert.match(SOURCE, /已授权设备/);
  assert.match(SOURCE, /dsh-remote\/access-key/);
  assert.match(SOURCE, /dsh-remote\/mobile-sessions/);
  assert.match(SOURCE, /order: 30/);
  // 清理时机：退出登录成功回调内、登录账号变化时、切换自建服务时
  assert.match(SOURCE, /post\("\/dsh-remote\/logout"\)\.then\(function \(body\) \{[\s\S]*?fbClearThreads\(\);/);
  assert.match(SOURCE, /if \(prevPhone !== phone\.trim\(\)\) fbClearThreads\(\);/);
  assert.match(SOURCE, /post\("\/dsh-remote\/config", \{ mode: "local"[\s\S]*?fbClearThreads\(\);/);
});

// 📱 远程访问 UI 回归（浏览器半）：一次性访问密钥卡、状态行、已授权设备管理与取消配对二次确认、
// 升级/续费带登录态打开。复用 settings-entry 的 vm 沙箱 + mock react 风格，只驱动真实点击/请求路径。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** 深度遍历：兼容任意层级的数组子节点（card()/多级数组渲染会形成多层嵌套）。 */
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

/** 文本子节点包含子串（用于动态拼接文案断言）。 */
function textHas(tree, substr) {
  return !!find(tree, (node) => (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}

const NOW = Date.now();
const KEY_URL = "https://app.test/a/K1";
const SESSIONS_1 = [
  { id: "ms_1", label: "iPhone 15", os: "iOS", browser: "Safari", created_at: NOW - 86400000, last_seen_at: NOW - 60000, revoked_at: null },
  { id: "ms_2", label: "Pixel 8", os: "Android", browser: "Chrome", created_at: NOW - 3600000, last_seen_at: null, revoked_at: NOW - 1800000 },
];

/** vm 加载 client.js 并 apply；fetch 可注入企业端同源代理响应。 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
  const injects = new Map();
  const requests = [];
  const opened = [];
  const states = [];
  let hook = 0;
  let sessionsCalls = 0;

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
  const makeEl = (tag) => ({
    tag,
    children: [],
    style: {},
    className: "",
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    appendChild(c) { this.children.push(c); },
  });
  const doc = {
    createElement(tag) { const el = makeEl(tag); allCreated.push(el); return el; },
    head: makeEl("head"),
    body: makeEl("body"),
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  class MutationObserverMock { constructor() {} observe() {} disconnect() {} }

  const localStorage = {
    _store: new Map(),
    getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
    setItem(k, v) { this._store.set(k, String(v)); },
    removeItem(k) { this._store.delete(k); },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } },
      open(url) { opened.push(url); return null; },
    },
    document: doc,
    localStorage,
    MutationObserver: MutationObserverMock,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch(path, options = {}) {
      requests.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
      if (path === "/dsh-remote/status") {
        return response(200, { ok: true, config: { phone: "13800000000", deviceId: "dev-x", mode: "saas" }, service: { running: true }, remoteUrl: "https://app.test/" });
      }
      if (path === "/dsh-remote/access-key") {
        return response(200, { ok: true, url: KEY_URL, key: "K1", expires_at: NOW + 30 * 60 * 1000, ttl_ms: 1800000, qr_data_url: "data:image/png;base64,AAAA" });
      }
      if (path === "/dsh-remote/mobile-sessions") {
        sessionsCalls++;
        return response(200, { ok: true, sessions: sessionsCalls === 1 ? SESSIONS_1 : [] }); // 取消配对后的刷新 → 空列表
      }
      if (path === "/dsh-remote/mobile-sessions/revoke") {
        return response(200, { ok: true });
      }
      if (path === "/dsh-remote/account") return response(200, { ok: true, account: { phone: "13800000000", plan: "free", plan_source: "plan", invite_code: "ABC12345" } });
      return response(200, { ok: true });
    },
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
    inject(name, cb) { injects.set(name, cb); cb(); },
    register(meta, component) { registered.set(meta.id, component); return () => {}; },
  } });

  return {
    registered,
    requests,
    opened,
    states,
    render() { hook = 0; return registered.get("dsh-remote")({ close() {} }); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("📱 远程访问卡：bridge 在线 → 绿点文案；登录态点「生成访问链接」→ url/复制/直接打开/二维码/倒计时齐备", async () => {
  const plugin = loadPlugin();
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-x" }, service: { running: true } };
  let tree = plugin.render();

  // 状态行：bridge 运行 → “已连接（可远程访问）”
  assert.ok(textHas(tree, "已连接（可远程访问）"), "bridge 在线状态文案应显示");
  assert.ok(find(tree, (n) => n.children?.includes("📱 远程访问")), "应渲染「📱 远程访问」卡标题");

  // 未生成 key 的空态按钮 → 点击触发 /dsh-remote/access-key
  const genBtn = find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes("生成访问链接")));
  assert.ok(genBtn, "应提供「生成访问链接」按钮");
  genBtn.props.onClick();
  await flush();
  await flush();

  tree = plugin.render();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/access-key" && r.method === "GET"), "应 GET /dsh-remote/access-key");
  // 大字地址 + 复制 + 直接打开 + 刷新按钮
  assert.ok(find(tree, (n) => n.children?.includes(KEY_URL)), "应展示一次性访问地址");
  assert.ok(find(tree, (n) => n.children?.includes("复制")), "应提供「复制」按钮");
  assert.ok(find(tree, (n) => n.children?.includes("直接打开")), "应提供「直接打开」按钮");
  assert.ok(find(tree, (n) => n.children?.includes("刷新二维码/访问链接")), "应提供手动刷新按钮");
  // 二维码 img 直取服务端 qr_data_url（客户端不自绘）
  const qr = find(tree, (n) => n.props?.src === "data:image/png;base64,AAAA");
  assert.ok(qr && qr.props?.alt === "远程访问二维码", "应渲染服务端返回的二维码 <img>");
  // 到期倒计时/有效至文案
  assert.ok(textHas(tree, "有效至") && textHas(tree, "剩余"), "应显示「有效至 HH:MM:SS / 剩余 xx:xx」倒计时");
  assert.ok(textHas(tree, "访问一次后失效"), "应说明一次性/30 分钟语义");
});

test("已授权设备：展开列表（label/os/browser/时间）→ 取消配对二次确认 → 成功提示并刷新", async () => {
  const plugin = loadPlugin();
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-x" }, service: { running: true } };
  let tree = plugin.render();

  // 展开：按钮「已授权设备 …」→ GET /dsh-remote/mobile-sessions
  const openBtn = find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("已授权设备")));
  assert.ok(openBtn, "应提供「已授权设备 N」按钮");
  openBtn.props.onClick();
  await flush();
  await flush();

  tree = plugin.render();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/mobile-sessions"), "展开应拉取已授权设备列表");
  assert.ok(textHas(tree, "iPhone 15"), "列表应显示设备 label");
  assert.ok(textHas(tree, "iOS · Safari"), "列表应显示 os/browser");
  assert.ok(textHas(tree, "已取消配对"), "revoked 设备应带「已取消配对」标记");
  assert.ok(textHas(tree, "首次配对"), "应显示配对时间");

  // 取消配对：第一次点击进入确认态（不请求）
  const revokeBtn = find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("取消配对")));
  assert.ok(revokeBtn, "行尾应有「取消配对」按钮");
  revokeBtn.props.onClick();
  tree = plugin.render();
  assert.ok(textHas(tree, "再点一次确认取消配对"), "二次确认文案应出现");
  assert.ok(!plugin.requests.some((r) => r.path === "/dsh-remote/mobile-sessions/revoke"), "首次点击不应发请求");

  // 第二次点击 → POST revoke {id} → 提示 + 刷新列表（空）
  find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("再点一次确认取消配对"))).props.onClick();
  await flush();
  await flush();
  await flush();

  const rev = plugin.requests.find((r) => r.path === "/dsh-remote/mobile-sessions/revoke");
  assert.ok(rev, "确认后应 POST /dsh-remote/mobile-sessions/revoke");
  assert.deepEqual(rev.body, { id: "ms_1" });
  tree = plugin.render();
  assert.ok(textHas(tree, "已取消，对方需重新扫码/登录"), "应提示已取消，对方需重新扫码/登录");
  assert.ok(textHas(tree, "暂无已授权设备（手机扫码后出现）"), "刷新后空态文案应出现");
});

test("升级/续费按钮：点击 → GET /dsh-remote/access-key → window.open(url)（带登录态打开）", async () => {
  const plugin = loadPlugin();
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-x" }, service: { running: true } };
  let tree = plugin.render();

  const upgrade = find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes("升级 PRO")));
  assert.ok(upgrade, "免费用户应显示「🚀 升级 PRO」按钮");
  upgrade.props.onClick();
  await flush();
  await flush();

  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/access-key"), "升级/续费应先取一次性访问 url");
  assert.ok(plugin.opened.includes(KEY_URL), "应以 window.open 打开一次性访问地址（带登录态）");
  assert.ok(textHas(plugin.render(), "带登录态"), "应出现「带登录态」说明文案");
});

test("二维码缺失容错 + 未登录引导文案（源码级约束）", () => {
  // 契约容错：qr_data_url 缺省 → 展示链接/复制/打开并说明“二维码暂不可用”，不报错
  assert.match(SOURCE, /二维码生成中 \/ 暂不可用/);
  assert.match(SOURCE, /qr_data_url/);
  assert.match(SOURCE, /window\.open/);
  // 自动刷新/状态轮询定时器与清理
  assert.match(SOURCE, /KEY_AUTO_REFRESH_MS = 25000/);
  assert.match(SOURCE, /STATUS_POLL_MS = 5000/);
  assert.match(SOURCE, /clearInterval\(rotateIv\)/);
  assert.match(SOURCE, /clearInterval\(pollIv\)/);
  // 文案与行为关键词
  assert.match(SOURCE, /已取消，对方需重新扫码\/登录/);
  assert.match(SOURCE, /再点一次确认取消配对/);
  assert.match(SOURCE, /暂无已授权设备（手机扫码后出现）/);
  assert.match(SOURCE, /等待设备连接/);
  assert.match(SOURCE, /已连接（可远程访问）/);
  assert.match(SOURCE, /带登录态/);
  assert.match(SOURCE, /通过手机或另一台电脑远程使用同一份 dsh web/);
});

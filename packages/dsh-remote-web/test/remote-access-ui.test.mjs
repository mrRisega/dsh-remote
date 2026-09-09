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

function findAll(tree, predicate) {
  const out = [];
  walk(tree, (node) => { if (predicate(node)) out.push(node); });
  return out;
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
        // 默认：首次给列表，后续刷新给空（模拟已全部清理）；测试可传 opts.sessions 固定列表
        const list = opts.sessions !== undefined ? opts.sessions : (sessionsCalls === 1 ? SESSIONS_1 : []);
        return response(200, { ok: true, sessions: list });
      }
      if (path === "/dsh-remote/mobile-sessions/revoke") {
        return response(200, { ok: true });
      }
      if (path === "/dsh-remote/mobile-sessions/delete") {
        return response(200, { ok: true });
      }
      if (path === "/dsh-remote/mobile-sessions/purge") {
        return response(200, { ok: true, removed: 1 });
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
  assert.ok(textHas(tree, "用一次即失效"), "应说明一次性/30 分钟语义（精简一句）");
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

test("已授权设备行内操作：活跃行有 取消配对+删除记录，已取消行有 删除记录；删除记录二次确认 → DELETE delete {id}", async () => {
  const plugin = loadPlugin({ sessions: SESSIONS_1 }); // 固定列表：操作后重拉仍保留，便于断言行内按钮
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-x" }, service: { running: true } };
  let tree = plugin.render();
  const openBtn = find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("已授权设备")));
  openBtn.props.onClick();
  await flush();
  await flush();
  tree = plugin.render();

  // 行内按钮：活跃行（ms_1）应有「取消配对」+「删除记录」；已取消行（ms_2）只应有「删除记录」
  const delBtns = findAll(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("删除记录")));
  assert.ok(delBtns.length >= 2, "每行（含已取消/历史）都应有「删除记录」按钮");
  assert.ok(find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("取消配对"))),
    "活跃行应有「取消配对」按钮");
  // 底部有「清理已解绑」入口（卡片底部）
  assert.ok(textHas(tree, "清理已解绑"), "卡片底部应提供「清理已解绑」");

  // 删除 ms_1：第一次点击进入确认态（不请求）
  delBtns[0].props.onClick();
  tree = plugin.render();
  assert.ok(textHas(tree, "再点一次确认删除记录"), "删除记录需二次确认");
  assert.ok(!plugin.requests.some((r) => r.path === "/dsh-remote/mobile-sessions/delete"), "首次点击不应发 DELETE");

  // 第二次点击 → DELETE /dsh-remote/mobile-sessions/delete {id} → 提示 + 刷新列表
  const listBefore = plugin.requests.filter((r) => r.path === "/dsh-remote/mobile-sessions").length;
  find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("再点一次确认删除记录"))).props.onClick();
  await flush();
  await flush();
  await flush();
  const del = plugin.requests.find((r) => r.path === "/dsh-remote/mobile-sessions/delete");
  assert.ok(del, "确认后应 DELETE /dsh-remote/mobile-sessions/delete");
  assert.equal(del.method, "DELETE");
  assert.deepEqual(del.body, { id: "ms_1" }, "行内删除应带上该行 session id");
  assert.ok(plugin.requests.filter((r) => r.path === "/dsh-remote/mobile-sessions").length > listBefore, "删除后应重拉设备列表");
  tree = plugin.render();
  assert.ok(textHas(tree, "已删除该设备的记录"), "删除成功应有可读提示");
});

test("已授权设备：卡片底部「清理已解绑」→ 二次确认 → POST purge → 提示条数 + 刷新列表", async () => {
  const plugin = loadPlugin({ sessions: SESSIONS_1 });
  plugin.states[0] = { config: { phone: "13800000000", deviceId: "dev-x" }, service: { running: true } };
  let tree = plugin.render();
  const openBtn = find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("已授权设备")));
  openBtn.props.onClick();
  await flush();
  await flush();
  tree = plugin.render();

  // 底部 purge 按钮：带 1 条已解绑计数
  const purgeBtn = find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("清理已解绑")));
  assert.ok(purgeBtn, "卡片底部应有「清理已解绑」按钮");
  purgeBtn.props.onClick();
  tree = plugin.render();
  assert.ok(textHas(tree, "再点一次确认清理已解绑"), "清理已解绑需二次确认");
  assert.ok(!plugin.requests.some((r) => r.path === "/dsh-remote/mobile-sessions/purge"), "首次点击不应发请求");

  const listBefore = plugin.requests.filter((r) => r.path === "/dsh-remote/mobile-sessions").length;
  find(tree, (n) => typeof n.props?.onClick === "function" && (n.children || []).some((c) => typeof c === "string" && c.includes("再点一次确认清理已解绑"))).props.onClick();
  await flush();
  await flush();
  await flush();
  const purge = plugin.requests.find((r) => r.path === "/dsh-remote/mobile-sessions/purge");
  assert.ok(purge, "确认后应 POST /dsh-remote/mobile-sessions/purge");
  assert.equal(purge.method, "POST");
  assert.ok(plugin.requests.filter((r) => r.path === "/dsh-remote/mobile-sessions").length > listBefore, "清理后应重拉设备列表");
  tree = plugin.render();
  assert.ok(textHas(tree, "已清理 1 条已解绑记录"), "应提示清理条数（可读）");
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
  assert.match(SOURCE, /STATUS_POLL_MS = 30000/); // 审计降频:原 5s→30s,页面隐藏暂停
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
  // 已授权设备管理（delete/purge 代理路由与按钮）
  assert.match(SOURCE, /dsh-remote\/mobile-sessions\/delete/);
  assert.match(SOURCE, /dsh-remote\/mobile-sessions\/purge/);
  assert.match(SOURCE, /删除记录/);
  assert.match(SOURCE, /清理已解绑/);
  assert.match(SOURCE, /再点一次确认删除记录/);
  assert.match(SOURCE, /再点一次确认清理已解绑/);
  // 文案精简：二维码说明压成一句、右侧长段压成一句
  assert.match(SOURCE, /扫码即进入，30 分钟有效、用一次即失效。/);
  assert.match(SOURCE, /打开链接\/扫码进入即登录态；同设备重复扫码只更新授权，不新增设备。/);
  assert.doesNotMatch(SOURCE, /每次生成的链接 30 分钟有效、访问一次后失效/);
  assert.doesNotMatch(SOURCE, /手机上打开链接点「进入」即可像在本机一样使用 dsh web/);
});

// ---------- 端到端加密（E2EE，Phase-5）状态徽标 ----------

const E2EE_STATE = {
  enabled: { enabled: true, reason: "ok", profile: "pbkdf2-sha256-600k", epoch: 1, caps: ["e2ee-v2"] },
  serverDisabled: { enabled: false, reason: "server_disabled", profile: "", epoch: 0, caps: [] },
  paramsUnreachable: { enabled: false, reason: "params_unreachable", profile: "", epoch: 0, caps: [] },
  localDisabled: { enabled: false, reason: "disabled_by_config", profile: "", epoch: 0, caps: [] },
  deriveFailed: { enabled: false, reason: "derive_failed", profile: "", epoch: 0, caps: [] },
  unknownReason: { enabled: false, reason: "brand_new_reason_x", profile: "", epoch: 0, caps: [] },
};

function stateWith(service) {
  return { config: { phone: "13800000000", deviceId: "dev-x", mode: "saas" }, service, remoteUrl: "https://app.test/" };
}

function e2eeLine(tree) {
  return find(tree, (n) => n.props && typeof n.props.className === "string" && n.props.className.indexOf("dru-e2ee-line") === 0);
}

test("E2EE 徽标：已启用 → “🔒 端到端加密已启用（手机解锁后生效）”（service.e2ee 字段驱动）", () => {
  const plugin = loadPlugin();
  plugin.states[0] = stateWith({ running: true, e2ee: E2EE_STATE.enabled });
  const tree = plugin.render();
  const line = e2eeLine(tree);
  assert.ok(line, "启用态应在「📱 远程访问」卡渲染加密状态行");
  assert.match(String(line.props.className), /ok/, "启用态状态行应为绿色（ok）标记");
  assert.ok(textHas(tree, "🔒 端到端加密已启用"), "应显示“端到端加密已启用”徽标文案");
  assert.ok(textHas(tree, "手机解锁后生效"), "应提示“手机解锁后生效”（bridge 就绪、手机解锁后方生效）");
});

test("E2EE 徽标：未启用原因映射可读文案（服务端关闭 / 参数不可达 / 本地关闭 / 改密 / 未知兜底）", () => {
  const cases = [
    [E2EE_STATE.serverDisabled, "端到端加密暂不可用（当前为普通安全连接 HTTPS）"],
    [E2EE_STATE.paramsUnreachable, "当前为普通安全连接（HTTPS）"],
    [E2EE_STATE.localDisabled, "当前为普通安全连接（HTTPS）"],
    [E2EE_STATE.deriveFailed, "账号密码已变更"],
    [E2EE_STATE.unknownReason, "当前为普通安全连接（HTTPS）"], // 未知 reason → 兜底
  ];
  for (const [e2ee, text] of cases) {
    const plugin = loadPlugin();
    plugin.states[0] = stateWith({ running: true, e2ee });
    const tree = plugin.render();
    assert.ok(textHas(tree, text), `reason=${e2ee.reason} 应映射为可读文案: ${text}`);
    const line = e2eeLine(tree);
    assert.ok(line && !/ ok/.test(String(line.props.className)), `reason=${e2ee.reason} 非启用态不应带 ok 标记`);
  }
});

test("E2EE 徽标：未登录 / host 未下发 e2ee → 不打扰（不渲染状态行）", () => {
  // 未登录（config 无 phone）即便 bridge 上报 enabled 也不打扰
  const anon = loadPlugin();
  anon.states[0] = { config: { deviceId: "dev-x", mode: "saas" }, service: { running: true, e2ee: E2EE_STATE.enabled } };
  assert.equal(e2eeLine(anon.render()), undefined, "未登录不应渲染 E2EE 状态行");
  assert.ok(!textHas(anon.render(), "手机解锁后生效"), "未登录不应出现加密徽标文案");

  // 已登录但 service 无 e2ee（旧 host / 未下发）→ 不渲染
  const oldHost = loadPlugin();
  oldHost.states[0] = stateWith({ running: true });
  assert.equal(e2eeLine(oldHost.render()), undefined, "未下发 service.e2ee 时不应渲染状态行");
});

test("E2EE 徽标（源码级约束）：client 含徽标字段/文案与 reason 映射表", () => {
  assert.match(SOURCE, /service\.e2ee/);
  assert.match(SOURCE, /\.e2ee-state\.json/);
  assert.match(SOURCE, /🔒 端到端加密已启用（手机解锁后生效）/);
  assert.match(SOURCE, /端到端加密暂不可用（当前为普通安全连接 HTTPS）/);
  assert.doesNotMatch(SOURCE, /等待服务端开启 E2EE/);   // 已正式开启，不再出现“灰度等待”措辞
  assert.match(SOURCE, /当前为普通安全连接（HTTPS）/);
  assert.match(SOURCE, /server_disabled/);
  assert.match(SOURCE, /params_unreachable/);
  assert.match(SOURCE, /disabled_by_config/);
  assert.match(SOURCE, /derive_failed/);
  assert.match(SOURCE, /describeE2ee/);
  assert.match(SOURCE, /dru-e2ee-line/);
});

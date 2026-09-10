// 交流群二维码（运营配置）在插件侧的两处展示回归：
//   ① 设置面板：「💬 加入交流群」按钮 → 点击弹出二维码大图（未配置后台码 → 按钮不存在）；
//   ② 用户反馈页：底部直接展示企微交流群二维码 + 文案。
// 数据来源：node 半 GET /dsh-remote/community（读公开配置 community.qrcode 并拼绝对地址）。
// 采用真实 useEffect（依赖比较 + 提交后执行），与 login-selfheal-ui.test.mjs 同一套 vm 挂载方式。
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { apply } from "../lib/index.js";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const QR_PATH = "/qr/group-qr.png";
const API_URL = "https://relay.test/relay-api";
const QR_ABS = API_URL + QR_PATH;

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
      requests.push({ path, method: options.method || "GET" });
      if (path === "/dsh-remote/status") return response(200, status);
      if (path === "/dsh-remote/community") return response(200, community);
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

test("node 半 /dsh-remote/community：读公开配置 community.qrcode 并拼成企业端绝对地址", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-community-"));
  const relay = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith("/api/public-config")) {
      return send(200, {
        service: "dsh-remote",
        app_url: "https://relay.test/app/",
        api_url: API_URL,
        community: { qrcode: QR_PATH, wechat: "dsh-remote-support" },
      });
    }
    send(404, { error: { code: "not_found" } });
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const port = relay.address().port;
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", api_url: `http://127.0.0.1:${port}`, bridge_secret: "s",
  }));
  const routes = new Map();
  apply({ webServer: { register(rt) { routes.set(rt.path, rt.handler); return () => {}; } }, effect(reg) { return reg(); }, logger: { info() {}, warn() {} } }, { relayDir: tempDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const h = routes.get(url.pathname);
    (h || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${host.address().port}`;
    const r = await (await fetch(`${base}/dsh-remote/community`)).json();
    assert.equal(r.ok, true);
    // 相对路径按「api_url + 路径」拼绝对地址(与手机端 PWA 的 API_BASE + qr 同一约定)
    assert.equal(r.qrcode, `http://127.0.0.1:${port}${QR_PATH}`);
    assert.equal(r.wechat, "dsh-remote-support");
  } finally {
    host.close();
    relay.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("设置面板:后台已配置 → 「加入交流群」按钮出现;点击弹出二维码大图;关闭后收起", async () => {
  const plugin = loadPlugin();
  let tree = await plugin.settle();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/community"), "面板应拉取交流群配置");

  const btn = nodeWithText(tree, "加入交流群");
  assert.ok(btn, "应出现「💬 加入交流群」按钮");
  assert.ok(!find(tree, (n) => n.props?.className === "dru-community-qr"), "未点击时不应有弹窗");

  btn.props.onClick();
  tree = plugin.render();
  assert.ok(find(tree, (n) => n.props?.className === "dru-community-qr"), "点击后应弹出二维码");
  const img = find(tree, (n) => n.props?.className === "dru-community-qr");
  assert.equal(img.props.src, QR_ABS, "二维码用 node 半下发的绝对地址");
  assert.equal(img.props.alt, "企微交流群二维码");
  assert.ok(textHas(tree, "加入企微交流群"), "弹窗应有标题");
  assert.ok(textHas(tree, "扫码入群"), "弹窗应有入群说明");

  // 关闭:点「关闭」→ 弹窗消失
  const closeBtn = nodeWithText(tree, "关闭");
  assert.ok(closeBtn, "弹窗应有「关闭」按钮");
  closeBtn.props.onClick();
  tree = plugin.render();
  assert.ok(!find(tree, (n) => n.props?.className === "dru-community-qr"), "关闭后弹窗应消失");
});

test("设置面板:后台未配置二维码 → 不展示任何入口（不留空壳按钮）", async () => {
  const plugin = loadPlugin({ community: { ok: true, qrcode: "", wechat: "" } });
  const tree = await plugin.settle();
  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/community"), "仍应尝试拉取");
  assert.ok(!nodeWithText(tree, "加入交流群"), "未配置时不展示按钮");
  assert.ok(!find(tree, (n) => n.props?.className === "dru-community-qr"), "未配置时不展示二维码");
});

test("用户反馈页:底部展示企微交流群二维码（含客服微信兜底文案）", async () => {
  const plugin = loadPlugin();
  await plugin.settle();
  // 进入「用户反馈」视图
  let tree = plugin.render();
  const entry = nodeWithText(tree, "用户反馈");
  assert.ok(entry, "应有「用户反馈」入口");
  entry.props.onClick();
  tree = await plugin.settle();

  assert.ok(textHas(tree, "加入企微交流群"), "反馈页应展示交流群标题");
  const img = find(tree, (n) => n.props?.className === "dru-community-qr");
  assert.ok(img, "反馈页应展示二维码图片");
  assert.equal(img.props.src, QR_ABS);
  assert.ok(textHas(tree, "dsh-remote-support"), "应展示客服微信兜底文案");
});

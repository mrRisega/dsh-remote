// 🔒 修改密码（已登录 SaaS，短信验证码重置）：
//  - node 半代理：POST /dsh-remote/password/reset → 企业端公开 /api/password/reset（无需 Bearer，透传 ok/error）；
//  - 浏览器半：账号卡「修改密码」小表单（手机号以当前账号为准 + 图形验证码 + 短信验证码 + 新密码≥8），
//    成功后本地登出（清反馈线程凭据）并提示用新密码重新登录（登录会覆盖桌面端 config 密码）。
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
const NODE_SOURCE = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

// ---------- node 半：/dsh-remote/password/reset 代理路由 ----------

test("修改密码代理：POST /dsh-remote/password/reset → 企业端 /api/password/reset（无 Bearer，透传 ok/error）", async () => {
  let upstream;
  const seen = [];
  const relay = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || "", body: JSON.parse(raw || "{}") });
    if (url.pathname === "/api/password/reset") {
      if (JSON.parse(raw).sms_code === "bad-code") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "sms_code_invalid", message: "短信验证码错误或已过期" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-pwd-test-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    api_url: `http://127.0.0.1:${relay.address().port}`
  }));

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir: tempDir });
  const host = http.createServer((req, res) => routes.get(new URL(req.url, "http://x").pathname)(req, res));
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));

  try {
    // 成功路径：公开接口无需 Bearer，原样转发 {phone,sms_code,new_password}
    const okRes = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/password/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13800000000", sms_code: "218937", new_password: "newpass123" }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true, "成功应透传 ok:true");
    assert.deepEqual(upstream = seen[0], {
      method: "POST",
      path: "/api/password/reset",
      auth: "",
      body: { phone: "13800000000", sms_code: "218937", new_password: "newpass123" },
    }, "转发到企业端 /api/password/reset，且不带任何 Bearer");

    // 失败路径：企业端 error 原样透传（含状态码与错误体）
    const badRes = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/password/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13800000000", sms_code: "bad-code", new_password: "newpass123" }),
    });
    assert.equal(badRes.status, 400, "企业端失败状态码应透传");
    const badBody = await badRes.json();
    assert.equal(badBody.ok, false);
    assert.equal(badBody.body.error.code, "sms_code_invalid", "企业端错误体应透传（UI 可读提示）");

    // 缺参校验
    const missing = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/password/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13800000000" }),
    });
    assert.equal(missing.status, 400);
  } finally {
    host.close();
    relay.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------- 浏览器半：账号卡「修改密码」小表单点击流 ----------

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
function textHas(tree, substr) {
  return !!find(tree, (node) => (node.children || []).some((c) => typeof c === "string" && c.includes(substr)));
}

function makeEl(tag) {
  return {
    tag, className: "", attributes: {}, style: {}, children: [], parentNode: null, listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(t, f) { this.listeners[t] = f; },
    appendChild(c) { c.parentNode = this; this.children.push(c); },
    querySelector() { return null; },
  };
}

/** vm 沙箱加载 client.js 并 apply；fetch 可按路径注入。opts.fetch 覆盖默认（返回 response(status,body)）。 */
function loadPlugin(opts = {}) {
  let moduleFactory;
  const registered = new Map();
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

  const doc = {
    createElement(tag) { return makeEl(tag); },
    head: makeEl("head"),
    body: makeEl("body"),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };

  const localStorage = {
    _store: new Map(Object.entries(opts.localStorageSeed || {})),
    getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
    setItem(k, v) { this._store.set(k, String(v)); },
    removeItem(k) { removed.push(k); this._store.delete(k); },
  };

  const defaultFetch = (pathname, options = {}) => {
    requests.push({ path: pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (pathname === "/dsh-remote/captcha") return response(200, { captcha_id: "cap-pwd-1", svg: "<svg></svg>" });
    if (pathname === "/dsh-remote/sms-code") return response(200, { ok: true, status: 200, body: { ok: true, test_code: "123456" } });
    if (pathname === "/dsh-remote/password/reset") {
      return opts.resetFail
        ? response(200, { ok: false, status: 400, body: { error: { code: "sms_code_invalid", message: "短信验证码错误或已过期" } } })
        : response(200, { ok: true, status: 200, body: { ok: true } });
    }
    if (pathname === "/dsh-remote/logout") {
      return response(200, { ok: true, config: { phone: "", deviceId: "dev-x" }, service: { running: false } });
    }
    if (pathname === "/dsh-remote/status") {
      return response(200, { ok: true, config: { phone: "", deviceId: "dev-x" }, service: { running: false } });
    }
    return response(200, { ok: true });
  };
  const fetchImpl = opts.fetch || defaultFetch;

  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } } },
    document: doc,
    localStorage,
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    fetch: fetchImpl,
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
    inject(name, cb) { injects.set(name, cb); cb(); },
    register(meta, component) { registered.set(meta.id, component); return () => {}; },
  } });

  return {
    registered,
    requests,
    removed,
    states,
    render() { hook = 0; return registered.get("dsh-remote")({ close() {} }); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const LOGGED_IN = { config: { phone: "13800000000", deviceId: "dev-x", mode: "saas" }, service: { running: true }, remoteUrl: "https://app.test/" };

/** 驱动「修改密码」完整成功流并返回 plugin（请求记录已就绪）。 */
async function runResetFlow(opts = {}) {
  const plugin = loadPlugin({ localStorageSeed: { "dsh-feedback-threads": '[{"id":"fb_1","token":"tok-abc","at":1}]' }, ...opts });
  plugin.states[0] = LOGGED_IN;
  let tree = plugin.render();

  // 账号卡应出现「修改密码」入口
  const entry = find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes("修改密码")));
  assert.ok(entry, "已登录账号卡应提供「🔒 修改密码」入口");
  entry.props.onClick();
  await flush();
  await flush();
  tree = plugin.render();

  // 小表单展开：图形验证码 + 手机号(当前账号,不可改) + 新密码提示
  assert.ok(textHas(tree, "修改后所有已授权设备与会话将失效，需重新登录与解锁"), "应提示设备/会话失效与重新登录解锁");
  const phoneBox = find(tree, (n) => n.props?.value === "13800000000" && n.props?.disabled === true);
  assert.ok(phoneBox, "手机号应预填当前账号且不可修改");

  // 图形验证码 + 获取短信验证码
  const capInput = find(tree, (n) => n.props?.placeholder === "图中数字");
  assert.ok(capInput, "应展示图形验证码输入框");
  capInput.props.onChange({ target: { value: "654321" } });
  tree = plugin.render();
  find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes("获取验证码"))).props.onClick();
  await flush();
  await flush();

  const smsReq = plugin.requests.find((r) => r.path === "/dsh-remote/sms-code");
  assert.ok(smsReq, "应请求 /dsh-remote/sms-code（复用短信防刷路径）");
  assert.deepEqual(smsReq.body, { phone: "13800000000", captcha_id: "cap-pwd-1", captcha_answer: "654321" });

  // 填写短信验证码 + 新密码(≥8) → 确认修改
  tree = plugin.render();
  find(tree, (n) => n.props?.placeholder === "6 位验证码").props.onChange({ target: { value: "123456" } });
  tree = plugin.render();
  find(tree, (n) => n.props?.placeholder === "至少 8 位").props.onChange({ target: { value: "newpass123" } });
  tree = plugin.render();
  find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes("确认修改密码"))).props.onClick();
  await flush();
  await flush();
  await flush();
  await flush();
  return plugin;
}

test("修改密码成功流：sms-code → password/reset → 本地登出（清反馈线程凭据）→ 提示用新密码重新登录", async () => {
  const plugin = await runResetFlow();

  const resetReq = plugin.requests.find((r) => r.path === "/dsh-remote/password/reset");
  assert.ok(resetReq, "应 POST /dsh-remote/password/reset");
  assert.equal(resetReq.method, "POST");
  assert.deepEqual(resetReq.body, { phone: "13800000000", sms_code: "123456", new_password: "newpass123" },
    "应提交 {phone,sms_code,new_password}");

  assert.ok(plugin.requests.some((r) => r.path === "/dsh-remote/logout"), "重置成功后应本地登出（清旧口令配置）");
  assert.ok(plugin.removed.includes("dsh-feedback-threads"), "重置成功登出应清除本机反馈线程凭据");

  const tree = plugin.render();
  assert.ok(textHas(tree, "密码已修改成功"), "应给出成功提示");
  assert.ok(textHas(tree, "新密码"), "应提示用新密码登录");
  assert.ok(textHas(tree, "重新登录"), "应提示重新登录（登录会覆盖本地 config 密码）");
  assert.ok(!find(tree, (n) => (n.children || []).some((c) => typeof c === "string" && c.includes("确认修改密码"))),
    "成功后小表单应收起并回到未登录账号卡");
});

test("修改密码失败路径：企业端错误透传为可读提示，不登出", async () => {
  const plugin = await runResetFlow({ resetFail: true });

  assert.ok(!plugin.requests.some((r) => r.path === "/dsh-remote/logout"), "失败时不应本地登出");
  const tree = plugin.render();
  assert.ok(textHas(tree, "短信验证码错误或已过期"), "应展示企业端透传的可读错误");
  assert.ok(textHas(tree, "修改失败"), "错误应带「修改失败」前缀");
});

test("源码约束：账号区含「修改密码」入口、reset 代理路由、新密码≥8 与重新登录提示", () => {
  // 浏览器半
  assert.match(SOURCE, /修改密码/);
  assert.match(SOURCE, /🔒 修改密码/);
  assert.match(SOURCE, /dsh-remote\/password\/reset/);
  assert.match(SOURCE, /new_password/);
  assert.match(SOURCE, /新密码至少 8 位/);
  assert.match(SOURCE, /pwdNew\.length < 8/);
  assert.match(SOURCE, /所有已授权设备与会话将失效/);
  assert.match(SOURCE, /重新登录/);
  assert.match(SOURCE, /E2EE/);
  assert.match(SOURCE, /fbClearThreads\(\)/);
  // 修改密码的短信验证码复用 /dsh-remote/sms-code（含图形验证码防刷）
  assert.match(SOURCE, /post\("\/dsh-remote\/sms-code"/);
  assert.match(SOURCE, /captcha_invalid/);
  // node 半代理路由
  assert.match(NODE_SOURCE, /path: "\/dsh-remote\/password\/reset"/);
  assert.match(NODE_SOURCE, /\/api\/password\/reset/);
  assert.doesNotMatch(NODE_SOURCE, /"\/dsh-remote\/password\/reset"[\s\S]{0,600}authorization/, "重置为公开接口，不应附加 Bearer");
});

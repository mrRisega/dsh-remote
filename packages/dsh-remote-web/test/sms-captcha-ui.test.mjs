import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

test("账号状态未返回前只显示加载态且不暴露配置路径", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /st === null/);
  assert.match(source, /正在读取远控状态/);
  assert.match(source, /st\.config\.deviceId/);
  assert.doesNotMatch(source, /configPath/);
  assert.match(source, /st !== null && !loggedIn/);
});

test("短信防刷要求图形验证码时，注册面板展示验证码并随重试提交", async () => {
  let moduleFactory;
  const registered = new Map();
  const requests = [];
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

  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { moduleFactory = spec.factory; } } },
    document: {
      createElement() { return { setAttribute() {}, textContent: "" }; },
      head: { appendChild() {} },
      body: {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    localStorage: {
      _store: new Map(),
      getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
      setItem(k, v) { this._store.set(k, String(v)); },
      removeItem(k) { this._store.delete(k); },
    },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    fetch(path, options = {}) {
      requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
      if (path === "/dsh-remote/captcha") return response(200, { captcha_id: "cap-1", svg: "<svg></svg>" });
      if (path === "/dsh-remote/sms-code" && requests.filter((r) => r.path === path).length === 1) {
        return response(400, { body: { error: { code: "captcha_invalid", message: "验证码错误或已过期" } } });
      }
      return response(200, { body: { ok: true, test_code: "123456" } });
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    Set,
    Symbol,
  };

  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox);
  const plugin = moduleFactory((name) => {
    assert.equal(name, "react");
    return react;
  });
  plugin.apply({ slots: {
    inject(_name, register) { register(); },
    register(meta, component) { registered.set(meta.id, component); return () => {}; },
  } });

  // 面板入口已迁入设置页 settings.section 栏目（id=dsh-remote），不再有侧边栏入口/浮动面板
  const section = registered.get("dsh-remote");
  assert.ok(section, "settings.section 栏目组件应已注册");
  const render = () => { hook = 0; return section({ close() {} }); };

  states[0] = { config: { phone: "", deviceId: "dev-test" }, service: { running: false, plistExists: true } };
  let tree = render();
  find(tree, (node) => node.children?.includes("注册")).props.onClick();
  tree = render();
  find(tree, (node) => node.props?.placeholder === "11 位手机号").props.onChange({ target: { value: "13800000000" } });
  tree = render();
  find(tree, (node) => node.children?.includes("获取验证码")).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));

  tree = render();
  const captchaInput = find(tree, (node) => node.props?.placeholder === "图中数字");
  assert.ok(captchaInput, "服务端要求图形验证码后应显示输入框");
  captchaInput.props.onChange({ target: { value: "654321" } });
  tree = render();
  find(tree, (node) => node.children?.includes("获取验证码")).props.onClick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests.at(-1), {
    path: "/dsh-remote/sms-code",
    body: { phone: "13800000000", captcha_id: "cap-1", captcha_answer: "654321" },
  });
});

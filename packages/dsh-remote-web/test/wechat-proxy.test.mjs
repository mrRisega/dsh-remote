// 微信机器人通道 —— **插件宿主半边**（lib/index.js）代理契约回归。
//
// 背景（docs/wechat-bot-channel.md §3/§8/§10）：微信通道跑在 bridge 里，只在 127.0.0.1 上
// 开一个控制面。面板不能直接碰它（跨端口 + 密钥 + 浏览器不该看见密钥），所以宿主半边做代理：
//
//   面板 /dsh-remote/wechat/*  ──代理──▶  控制面 127.0.0.1:<port>/wechat/*
//                                          ↑ 头 x-dsh-bridge-secret: <config.bridge_secret>
//
// 这个文件锁死三件事，它们都是「出过事的那种」细节：
//   ① 路由一一对应 + 密钥头真的被带上（少带 = 控制面 401，用户看到的是"绑定不了"）；
//   ② 每一种失败（没发现文件 / 文件损坏 / 残留 pid / 连接被拒 / 401 / 403 / 404 / 超时 /
//      没密钥 / 非 JSON）都要变成**各不相同的人话** —— 一句「失败」会让用户去重启一个完全正常的服务；
//   ③ 响应里**永远没有 token**（§8「面板 API 永不回显 bot_token」）。这里连 .wechat-account.json
//      都不许读 —— 用一条源码级断言钉死。
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

const SECRET = "sec-wechat-abc123";
/** 控制面契约里唯一的密钥头（与 wechat-runtime.mjs 的 CONTROL_HEADER 同值）。 */
const HDR = "x-dsh-bridge-secret";
const QR_DATA_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

/** 面板路由 → 控制面路由（契约一一对应，测试与实现各自写一遍，改一边就会红）。 */
const ROUTE_MAP = [
  { panel: "/dsh-remote/wechat/status", method: "GET", control: "GET /wechat/status" },
  { panel: "/dsh-remote/wechat/bind/start", method: "POST", control: "POST /wechat/bind/start" },
  { panel: "/dsh-remote/wechat/bind/poll", method: "GET", control: "GET /wechat/bind/poll" },
  { panel: "/dsh-remote/wechat/bind/verify", method: "POST", control: "POST /wechat/bind/verify" },
  { panel: "/dsh-remote/wechat/bind/cancel", method: "POST", control: "POST /wechat/bind/cancel" },
  { panel: "/dsh-remote/wechat/unbind", method: "POST", control: "POST /wechat/unbind" },
];

const UNBOUND_STATUS = {
  ok: true, disabled: false, bound: false, bot_id: "", bound_at: 0, connected_at: 0,
  last_push_ok_at: 0, last_error: "", cooldown_ms: 0, pending_replies: 0,
  binding: { active: false }, channel_running: false, events_running: false
};

/**
 * 假控制面：行为对齐 clients/dsh-remote/wechat-runtime.mjs 的 #handleControl
 * （同一条 401/403/404 语义、同一组路由）。opts 用来按需制造各种失败。
 */
function startFakeControl(opts = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch { body = null; }
      seen.push({ method: req.method, path: url.pathname, header: req.headers[HDR] || "", body, accept: req.headers.accept || "", contentType: req.headers["content-type"] || "" });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
      if (opts.garbage) { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>not json</html>"); return; }
      if (opts.notFound) return send(404, { ok: false, error: "no such route" });
      if (opts.noSecretAtBridge) return send(403, { ok: false, error: "bridge_secret 未配置,控制面已禁用" });
      const expected = opts.secret === undefined ? SECRET : opts.secret;
      if (!expected) return send(403, { ok: false, error: "bridge_secret 未配置,控制面已禁用" });
      if ((req.headers[HDR] || "") !== expected) return send(401, { ok: false, error: "unauthorized" });
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "GET /wechat/status": return send(200, opts.statusBody || UNBOUND_STATUS);
        case "POST /wechat/bind/start":
          // 真实契约：beginBind 失败 → 400 + {ok:false, error:<人话>}
          if (opts.bindStartError) return send(400, { ok: false, error: opts.bindStartError });
          return send(200, { ok: true, qrcode_svg: QR_DATA_URL, qrcode_url: "https://liteapp.weixin.qq.com/q/7GiQu1", message: "请用手机微信扫描二维码完成绑定。" });
        case "GET /wechat/bind/poll": return send(200, { ok: true, state: "wait", bound: false });
        case "POST /wechat/bind/verify": return send(200, { ok: true, code: body && body.code });
        case "POST /wechat/bind/cancel": return send(200, { ok: true, cancelled: true });
        case "POST /wechat/unbind": return send(200, { ok: true, notify_error: "" });
        default: return send(404, { ok: false, error: `no such route: ${route}` });
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port })));
}

/** 占一个端口再放掉 → 得到一个必定没有监听者的 loopback 端口（制造 ECONNREFUSED）。 */
function deadPort() {
  const srv = http.createServer(() => {});
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  }));
}

/** 起一个真进程再等它退出 → 得到一个**确定已经不在**的 pid（不能用魔数，pid 可能真的存在）。 */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(Number.isInteger(r.pid) && r.pid > 0, "应能拿到一个已退出进程的 pid");
  return r.pid;
}

async function tempRelayDir(cfg = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-wx-proxy-"));
  // api_url 指向本地死端口：插件的后台自愈/装机上报绝不允许打到生产中继（见 scripts/test-net-guard.cjs）
  await writeFile(path.join(dir, ".dsh-config.json"), JSON.stringify({ device_id: "dev-wx", api_url: "http://127.0.0.1:9", ...cfg }));
  return dir;
}

async function writeControlFile(dir, obj) {
  await writeFile(path.join(dir, ".wechat-control.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
}

/** 装载插件路由（与 quota-absent.test.mjs 同一套 boot 方式），返回本地 http 面板入口。 */
async function bootHost(relayDir) {
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

async function call(base, panelPath, method = "GET", body) {
  const res = await fetch(`${base}${panelPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  try { parsed = JSON.parse(await res.text()); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

/** 起一个完整环境：假控制面 + 配置 + 发现文件 + 面板宿主。 */
async function boot(opts = {}) {
  const control = await startFakeControl(opts.control || {});
  const dir = await tempRelayDir(opts.config === undefined ? { bridge_secret: SECRET } : opts.config);
  if (opts.noControlFile !== true) {
    const pointer = opts.controlPointer === undefined ? { port: control.port, pid: process.pid, started_at: Date.now(), header: HDR } : opts.controlPointer;
    await writeControlFile(dir, pointer);
  }
  const host = await bootHost(dir);
  return {
    control, dir, ...host,
    async close() {
      host.host.close();
      control.srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────

test("宿主代理：六条面板路由一一映射到控制面路由，并带上 x-dsh-bridge-secret", async () => {
  const env = await boot();
  try {
    for (const r of ROUTE_MAP) {
      const before = env.control.seen.length;
      const out = await call(env.base, r.panel, r.method, r.method === "POST" ? { code: "123456" } : undefined);
      assert.equal(out.status, 200, `${r.panel} 应 200（实际 ${out.status}: ${JSON.stringify(out.body)}）`);
      const hit = env.control.seen[before];
      assert.ok(hit, `${r.panel} 必须打到控制面`);
      assert.equal(`${hit.method} ${hit.path}`, r.control, `${r.panel} → 控制面路由必须一一对应`);
      assert.equal(hit.header, SECRET, `每一次代理都必须带 ${HDR}（少了控制面会 401）`);
    }
    // 成功时上游响应体原样透传（面板据此渲染二维码/状态）
    const st = await call(env.base, "/dsh-remote/wechat/status");
    assert.equal(st.body.bound, false);
    const start = await call(env.base, "/dsh-remote/wechat/bind/start", "POST");
    assert.equal(start.body.qrcode_svg, QR_DATA_URL, "二维码 data URL 必须原样透传（面板直接 <img src>）");
  } finally {
    await env.close();
  }
});

test("宿主代理：verify 只转发 {code}，多余字段（含 token）一律不带过去", async () => {
  const env = await boot();
  try {
    const out = await call(env.base, "/dsh-remote/wechat/bind/verify", "POST", {
      code: "4321", bot_token: "SHOULD-NEVER-BE-FORWARDED", extra: { nested: true }
    });
    assert.equal(out.status, 200);
    const hit = env.control.seen[env.control.seen.length - 1];
    assert.equal(hit.path, "/wechat/bind/verify");
    assert.deepEqual(hit.body, { code: "4321" }, "控制面只认 {code}；白名单转发，绝不做原样透传");
    assert.equal(hit.contentType, "application/json");
  } finally {
    await env.close();
  }
});

test("宿主代理：响应里**没有 token**（含嵌套字段），且从不读 .wechat-account.json", async () => {
  const leaks = {
    ...UNBOUND_STATUS,
    bound: true, bot_id: "bot_1", bound_at: 1700000000000,
    bot_token: "BOT-TOKEN-LEAK-1",
    account: { token: "NESTED-TOKEN-LEAK-2", botId: "bot_1" },
    nested: [{ access_token: "NESTED-TOKEN-LEAK-3" }]
  };
  const env = await boot({ control: { statusBody: leaks } });
  try {
    // 埋一个"金丝雀"：宿主半边若去读 .wechat-account.json，这里立刻会露出来
    await writeFile(path.join(env.dir, ".wechat-account.json"), JSON.stringify({ token: "CANARY-FROM-ACCOUNT-FILE" }));

    const st = await call(env.base, "/dsh-remote/wechat/status");
    const serialized = JSON.stringify(st.body);
    assert.doesNotMatch(serialized, /token/i, `响应体里不得出现任何 token 字段：${serialized}`);
    assert.ok(!serialized.includes("BOT-TOKEN-LEAK-1"), "不得回显 bot_token");
    assert.ok(!serialized.includes("NESTED-TOKEN-LEAK-2"), "嵌套对象里的 token 也要被剥掉");
    assert.ok(!serialized.includes("NESTED-TOKEN-LEAK-3"), "数组里的 token 也要被剥掉");
    assert.ok(!serialized.includes("CANARY-FROM-ACCOUNT-FILE"), "宿主半边不得读 .wechat-account.json");
    // 该留的字段一个不能少（脱敏不能顺手把可用字段也删了）
    assert.equal(st.body.bound, true);
    assert.equal(st.body.bot_id, "bot_1");
    assert.equal(st.body.bound_at, 1700000000000);

    // bind/start 同样过滤
    const start = await call(env.base, "/dsh-remote/wechat/bind/start", "POST");
    assert.doesNotMatch(JSON.stringify(start.body), /token/i);
  } finally {
    await env.close();
  }
});

test("宿主代理：源码级铁律 —— 不碰 .wechat-account.json，且六条路由齐备", () => {
  assert.doesNotMatch(INDEX_SRC, /wechat-account/, "宿主半边不得读取 .wechat-account.json（里面有明文 bot_token）");
  for (const r of ROUTE_MAP) {
    assert.ok(INDEX_SRC.includes(`"${r.panel}"`), `应注册路由 ${r.panel}`);
    assert.ok(INDEX_SRC.includes(`"${r.control.split(" ")[1]}"`), `应代理到控制面 ${r.control}`);
  }
  assert.match(INDEX_SRC, /x-dsh-bridge-secret/, "密钥头必须来自同一个常量");
});

test("宿主代理：每一种失败都给出**各不相同**的人话（绝不塌成一句「失败」）", async () => {
  const seen = [];
  const record = (label, status, body) => {
    assert.equal(status >= 500 || status === 400, true, `${label} 失败应是 4xx/5xx（实际 ${status}）`);
    assert.equal(body && body.ok, false, `${label} 失败体必须 ok:false`);
    assert.equal(typeof body.code, "string");
    assert.equal(typeof body.error, "string");
    seen.push({ label, ...body });
  };

  // ① 没有发现文件（bridge 没跑 / 版本旧）
  {
    const env = await boot({ noControlFile: true });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("no_control_file", r.status, r.body);
    assert.equal(r.body.code, "no_control_file");
    await env.close();
  }
  // ② 发现文件损坏
  {
    const env = await boot({ controlPointer: "{ this is not json" });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("bad_control_file", r.status, r.body);
    assert.equal(r.body.code, "bad_control_file");
    await env.close();
  }
  // ③ 发现文件是上次进程留下的（pid 已不在）
  {
    const dead = await boot({ controlPointer: { port: 1, pid: deadPid(), started_at: 1, header: HDR } });
    const r = await call(dead.base, "/dsh-remote/wechat/status");
    record("stale_control_file", r.status, r.body);
    assert.equal(r.body.code, "stale_control_file");
    await dead.close();
  }
  // ④ 连接被拒绝（端口上没有监听者）
  {
    const port = await deadPort();
    const env = await boot({ controlPointer: { port, pid: process.pid, started_at: Date.now(), header: HDR } });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("refused", r.status, r.body);
    assert.equal(r.body.code, "refused");
    await env.close();
  }
  // ⑤ 401：本机密钥与控制面不匹配
  {
    const env = await boot({ control: { secret: "a-totally-different-secret" } });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("unauthorized", r.status, r.body);
    assert.equal(r.body.code, "unauthorized");
    await env.close();
  }
  // ⑥ 403：控制面没配密钥（安全默认：拒绝一切）
  {
    const env = await boot({ control: { noSecretAtBridge: true } });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("forbidden", r.status, r.body);
    assert.equal(r.body.code, "forbidden");
    await env.close();
  }
  // ⑦ 404：控制面版本旧，不认识该路由
  {
    const env = await boot({ control: { notFound: true } });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("no_such_route", r.status, r.body);
    assert.equal(r.body.code, "no_such_route");
    await env.close();
  }
  // ⑧ 超时：控制面挂住不回
  {
    const env = await boot({ control: { delayMs: 800 } });
    const prev = process.env.DSH_WECHAT_CONTROL_TIMEOUT_MS;
    process.env.DSH_WECHAT_CONTROL_TIMEOUT_MS = "200";
    try {
      const r = await call(env.base, "/dsh-remote/wechat/status");
      record("timeout", r.status, r.body);
      assert.equal(r.body.code, "timeout");
    } finally {
      if (prev === undefined) delete process.env.DSH_WECHAT_CONTROL_TIMEOUT_MS;
      else process.env.DSH_WECHAT_CONTROL_TIMEOUT_MS = prev;
      await env.close();
    }
  }
  // ⑨ 本机还没有设备密钥（不能伪装成连接故障）
  {
    const env = await boot({ config: { device_id: "dev-no-secret" } });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("no_secret", r.status, r.body);
    assert.equal(r.body.code, "no_secret");
    await env.close();
  }
  // ⑩ 上游返回的不是 JSON
  {
    const env = await boot({ control: { garbage: true } });
    const r = await call(env.base, "/dsh-remote/wechat/status");
    record("bad_response", r.status, r.body);
    assert.equal(r.body.code, "bad_response");
    await env.close();
  }

  // 每条文案必须互不相同、且不是「失败」两个字了事
  const messages = seen.map((s) => s.error);
  assert.equal(new Set(messages).size, messages.length, `失败文案必须两两不同：\n${messages.join("\n")}`);
  for (const s of seen) {
    assert.ok(s.error.length >= 20, `${s.label} 的文案过于笼统：${s.error}`);
    assert.notEqual(s.error.trim(), "失败");
    assert.doesNotMatch(s.error, /^error$/i);
  }
  // 处置动作也要能分辨出来：有的要"启动/重启后台服务"，有的要"一键更新"，有的要"登录"
  assert.match(seen.find((s) => s.code === "stale_control_file").error, /重启后台服务/);
  assert.match(seen.find((s) => s.code === "unauthorized").error, /一键更新/);
  assert.match(seen.find((s) => s.code === "no_secret").error, /登录/);
});

test("宿主代理：上游的业务错误（400 + error 文案）原样透传，不吞成通用错误", async () => {
  const env = await boot({ control: { bindStartError: "已经绑定过了;如需更换请先解绑" } });
  try {
    const r = await call(env.base, "/dsh-remote/wechat/bind/start", "POST");
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "upstream_400");
    assert.equal(r.body.error, "已经绑定过了;如需更换请先解绑", "上游写给用户看的文案必须原样送达");
  } finally {
    await env.close();
  }
});

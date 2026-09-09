// 插件 node 半新增代理回归：/dsh-remote/access-key | mobile-sessions | mobile-sessions/revoke
// | mobile-sessions/delete | mobile-sessions/purge
// （企业端 E1 契约：POST /api/auth-key、GET /api/mobile-sessions、POST /api/mobile-sessions/:id/revoke、
//  DELETE /api/mobile-sessions/:id、POST /api/mobile-sessions/purge，Bearer device-login JWT）
// 覆盖：Bearer 透传、字段扁平化、未登录 401、qr 缺失容错、上游错误透传。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const EXPIRES = 1893456000000;
const QR = "data:image/png;base64,AAAA";

/** 假企业端：记录收到的请求（method/path/authorization），按场景回包。 */
function startFakeRelay(opts = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const rec = { method: req.method, path: url.pathname, authorization: req.headers.authorization || "" };
    seen.push(rec);
    if (req.method === "POST" && url.pathname === "/api/device-login") return send(200, { token: "jwt-abc" });
    if (req.method === "POST" && url.pathname === "/api/auth-key") {
      if (opts.authKeyFail) return send(500, { error: { message: "server boom" } });
      const body = { ok: true, key: "K1", url: "https://app.test/a/K1", expires_at: EXPIRES, ttl_ms: 1800000 };
      if (!opts.noQr) body.qr_data_url = QR;
      return send(200, body);
    }
    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/mobile-sessions") {
      return send(200, {
        ok: true,
        sessions: [
          { id: "ms_1", label: "iPhone 15", os: "iOS", browser: "Safari", created_at: 1700000000000, last_seen_at: 1700000600000, revoked_at: null },
          { id: "ms_2", label: "Pixel", os: "Android", browser: "Chrome", created_at: 1700000000000, last_seen_at: null, revoked_at: 1700001000000 },
        ],
      });
    }
    if (req.method === "POST" && url.pathname === "/api/mobile-sessions/ms_1/revoke") return send(200, { ok: true });
    if (req.method === "POST" && url.pathname === "/api/mobile-sessions/ghost/revoke") return send(404, { error: { message: "not_found" } });
    if (req.method === "DELETE" && url.pathname === "/api/mobile-sessions/ms_1") return send(200, { ok: true });
    if (req.method === "DELETE" && url.pathname === "/api/mobile-sessions/ghost") return send(404, { error: { message: "not_found" } });
    if (req.method === "POST" && url.pathname === "/api/mobile-sessions/purge") return send(200, { ok: true, removed: 2 });
    send(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port })));
}

/** 以假 relay 为 api_url 装载插件路由（boot），返回 http server base 与收集的 routes。 */
async function bootRelay(relayPort, cfgExtra = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-aks-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000",
    password: "pw",
    device_id: "dev-aks",
    api_url: `http://127.0.0.1:${relayPort}`,
    ...cfgExtra,
  }));
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}`, tempDir };
}

test("access-key 路由：创建一次性密钥并透传字段（含 qr_data_url），Bearer 已带上", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const r = await (await fetch(`${base}/dsh-remote/access-key`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://app.test/a/K1");
    assert.equal(r.key, "K1");
    assert.equal(r.expires_at, EXPIRES);
    assert.equal(r.ttl_ms, 1800000);
    assert.equal(r.qr_data_url, QR);
    const up = relay.seen.find((s) => s.path === "/api/auth-key");
    assert.equal(up.method, "POST");
    assert.equal(up.authorization, "Bearer jwt-abc", "应携带 device-login JWT");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("access-key 容错：企业端未返回 qr_data_url 时仍成功，qr 字段为 null", async () => {
  const relay = await startFakeRelay({ noQr: true });
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const r = await (await fetch(`${base}/dsh-remote/access-key`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://app.test/a/K1");
    assert.equal(r.qr_data_url, null, "qr 缺失不致命（UI 只展示链接/复制/打开）");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mobile-sessions 路由：列表透传，Bearer 已带上", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const r = await (await fetch(`${base}/dsh-remote/mobile-sessions`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.sessions[0].label, "iPhone 15");
    assert.equal(r.sessions[0].os, "iOS");
    const up = relay.seen.find((s) => s.path === "/api/mobile-sessions");
    assert.equal(up.method, "GET"); // 列表为 GET；POST 仅用于 auth-key/revoke
    assert.equal(up.authorization, "Bearer jwt-abc");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mobile-sessions/revoke 路由：body {id} 转发到 /api/mobile-sessions/:id/revoke，成功返回 ok", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const r = await (await fetch(`${base}/dsh-remote/mobile-sessions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ms_1" }),
    })).json();
    assert.equal(r.ok, true);
    const up = relay.seen.find((s) => s.path === "/api/mobile-sessions/ms_1/revoke");
    assert.ok(up, "应转发到 /api/mobile-sessions/ms_1/revoke");
    assert.equal(up.authorization, "Bearer jwt-abc");

    // 缺 id → 400
    const bad = await (await fetch(`${base}/dsh-remote/mobile-sessions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /id/);
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mobile-sessions/delete 路由：DELETE body {id} 转发到企业端 DELETE /api/mobile-sessions/:id（拉黑 jti）", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const r = await (await fetch(`${base}/dsh-remote/mobile-sessions/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ms_1" }),
    })).json();
    assert.equal(r.ok, true);
    const up = relay.seen.find((s) => s.path === "/api/mobile-sessions/ms_1" && s.method === "DELETE");
    assert.ok(up, "应转发到企业端 DELETE /api/mobile-sessions/ms_1");
    assert.equal(up.authorization, "Bearer jwt-abc");

    // 缺 id → 400；不存在的会话 → 透传 404 文案
    const bad = await (await fetch(`${base}/dsh-remote/mobile-sessions/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /id/);

    const ghost = await (await fetch(`${base}/dsh-remote/mobile-sessions/delete`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ghost" }),
    })).json();
    assert.equal(ghost.ok, false);
    assert.match(String(ghost.error), /not_found/);
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("mobile-sessions/purge 路由：POST → 企业端 POST /api/mobile-sessions/purge，removed 透传", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const r = await (await fetch(`${base}/dsh-remote/mobile-sessions/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    assert.equal(r.ok, true);
    assert.equal(r.removed, 2, "企业端返回的 removed 清理条数应透传");
    const up = relay.seen.find((s) => s.path === "/api/mobile-sessions/purge");
    assert.ok(up, "应转发到 /api/mobile-sessions/purge");
    assert.equal(up.method, "POST");
    assert.equal(up.authorization, "Bearer jwt-abc");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("未登录（无账号配置）→ 五条路由统一 401 提示登录，不请求企业端", async () => {
  const relay = await startFakeRelay();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-aks-401-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({ api_url: `http://127.0.0.1:${relay.port}` }));
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${host.address().port}`;
    for (const [method, p] of [["GET", "/dsh-remote/access-key"], ["GET", "/dsh-remote/mobile-sessions"]]) {
      const r = await (await fetch(`${base}${p}`, { method })).json();
      assert.equal(r.ok, false);
      assert.equal((await (await fetch(`${base}${p}`, { method }))).status, 401, `${p} 应返回 401`);
      assert.match(String(r.error), /尚未登录/);
    }
    for (const [method, p] of [
      ["POST", "/dsh-remote/mobile-sessions/revoke"],
      ["DELETE", "/dsh-remote/mobile-sessions/delete"],
      ["POST", "/dsh-remote/mobile-sessions/purge"],
    ]) {
      const r = await (await fetch(`${base}${p}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ms_1" }),
      })).json();
      assert.equal(r.ok, false);
      assert.match(String(r.error), /尚未登录/);
    }
    assert.ok(!relay.seen.some((s) => s.path.startsWith("/api/auth-key") || s.path.startsWith("/api/mobile-sessions")), "未登录不应请求企业端");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("上游错误透传：auth-key 5xx 时包装 ok:false + 服务端 error.message", async () => {
  const relay = await startFakeRelay({ authKeyFail: true });
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const res = await fetch(`${base}/dsh-remote/access-key`);
    assert.equal(res.status, 500, "应透传上游状态码");
    const r = await res.json();
    assert.equal(r.ok, false);
    assert.match(String(r.error), /server boom/);
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

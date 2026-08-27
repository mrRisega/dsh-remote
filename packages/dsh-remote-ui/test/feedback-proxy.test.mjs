// 插件 node 半「用户反馈代理」回归：/dsh-remote/feedback/* 转发到独立反馈服务，
// 自动附加设备身份与手机号、透传 thread_token，且反馈服务不可达时优雅降级。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

/** 起一个假反馈服务（记录收到的头与体，回显 echo）。 */
function startFakeFeedback() {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    seen.push(rec);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: rec }));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port }));
  });
}

test("反馈代理：附加设备身份/手机号，透传 thread_token", async () => {
  const fb = await startFakeFeedback();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-fb-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    device_id: "dev-testproxy123",
    phone: "13800000000",
    feedback_url: `http://127.0.0.1:${fb.port}`,
  }));

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });

  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname) || routes.get("/dsh-remote/feedback");
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/feedback/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer thread-token-abc" },
      body: JSON.stringify({ category: "bug", content: "测试" }),
    });
    assert.equal(res.status, 201);
    const echo = (await res.json()).echo;
    assert.equal(echo.url, "/api/feedback");
    assert.equal(echo.headers["x-dsh-device"], "dev-testproxy123");
    assert.equal(echo.headers["x-dsh-phone"], "13800000000");
    assert.equal(echo.headers["x-dsh-client"], "dsh-remote-ui/0.1.0");
    assert.equal(echo.headers.authorization, "Bearer thread-token-abc");
    assert.equal(echo.body.category, "bug");

    // GET 透传查询串
    const getRes = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/feedback/api/feedback/fb_abc?x=1`);
    assert.equal(getRes.status, 201);
    assert.equal(fb.seen[1].url, "/api/feedback/fb_abc?x=1");
  } finally {
    host.close();
    fb.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("反馈配置：默认走 api_url（生产 relay-api 同源反馈端点），可达性正确", async () => {
  const fb = await startFakeFeedback();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-fbcfg-"));
  // 不写 feedback_url：应回退到 api_url（反馈端点与账号 API 同基址）
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    device_id: "dev-cfgcheck",
    phone: "13900000000",
    api_url: `http://127.0.0.1:${fb.port}/relay-api`,
  }));

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });

  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname) || routes.get("/dsh-remote/feedback");
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/feedback-config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.reachable, true);
    assert.equal(body.deviceId, "dev-cfgcheck");
    assert.equal(body.phone, "13900000000");
    // 代理把 /dsh-remote/feedback/api/feedback/captcha 映射到 {api_url}/api/feedback/captcha
    const cap = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/feedback/api/feedback/captcha`);
    assert.equal(cap.status, 201);
    assert.equal(fb.seen[1].url, "/relay-api/api/feedback/captcha");
  } finally {
    host.close();
    fb.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("反馈代理：反馈服务不可达时 502 降级，不影响其他路由", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-fbdown-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    device_id: "dev-down",
    feedback_url: "http://127.0.0.1:19998", // 死端口
  }));

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });

  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname) || routes.get("/dsh-remote/feedback");
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/feedback/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "bug", content: "x" }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /反馈服务不可达/);
  } finally {
    host.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

// 插件 node 半「我的信息」代理回归：/dsh-remote/account|quota|invite-records
// 经假 relay(device-login→JWT) 与假 router(/_quota) 验证。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

/** 假 relay:device-login 发 token,带 token 的 /api/me 返回用户,邀请记录返回记录。 */
function startFakeRelay() {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && url.pathname === "/api/device-login") {
      return send(200, { token: "jwt-abc" });
    }
    if (url.pathname === "/api/me" && req.headers.authorization === "Bearer jwt-abc") {
      return send(200, { user: { phone: "13800000000", plan: "pro", plan_source: "subscription", plan_ends_at: 1893456000000, invite_code: "ABC12345", invited_by: null } });
    }
    if (url.pathname === "/api/invite-records" && req.headers.authorization === "Bearer jwt-abc") {
      return send(200, { records: [{ id: 1, invitee_phone: "13811112222" }], rewards: [{ id: 1, rule_n: 3, rule_days: 15 }] });
    }
    send(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}

/** 假 router:_quota 校验 dsh_token cookie。 */
function startFakeRouter() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/_quota")) {
      const cookie = req.headers.cookie || "";
      if (!cookie.includes("jwt-abc")) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ quota: { plan: "pro", limit_enabled: false, used_bytes: 100, limit_bytes: 0, percent: 0 } }));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}

test("我的信息:account/quota/invite-records 经假 relay 与假 router 正确代理", async () => {
  const relay = await startFakeRelay();
  const router = await startFakeRouter();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-acct-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000",
    password: "pw",
    device_id: "dev-testacct123",
    api_url: `http://127.0.0.1:${relay.port}`,
    tunnel_url: `ws://127.0.0.1:${router.port}`,
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
  const base = `http://127.0.0.1:${host.address().port}`;

  try {
    const acct = await (await fetch(`${base}/dsh-remote/account`)).json();
    assert.equal(acct.ok, true);
    assert.equal(acct.account.plan, "pro");
    assert.equal(acct.account.plan_ends_at, 1893456000000);
    assert.equal(acct.account.invite_code, "ABC12345");

    const quota = await (await fetch(`${base}/dsh-remote/quota`)).json();
    assert.equal(quota.ok, true);
    assert.equal(quota.quota.limit_enabled, false);
    assert.equal(quota.quota.percent, 0);

    const inv = await (await fetch(`${base}/dsh-remote/invite-records`)).json();
    assert.equal(inv.records.length, 1);
    assert.equal(inv.rewards[0].rule_days, 15);
  } finally {
    host.close();
    relay.srv.close();
    router.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

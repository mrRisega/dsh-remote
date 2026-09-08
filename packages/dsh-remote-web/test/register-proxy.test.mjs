import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

test("注册代理向 relay 透传短信验证码", async () => {
  let upstreamBody;
  const relay = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    upstreamBody = JSON.parse(raw);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "test-token", user: { phone: upstreamBody.phone } }));
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-test-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    api_url: `http://127.0.0.1:${relay.address().port}`
  }));

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });

  const host = http.createServer((req, res) => routes.get(new URL(req.url, "http://x").pathname)(req, res));
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13800000000", sms_code: "218937", password: "password123" })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(upstreamBody, {
      phone: "13800000000",
      sms_code: "218937",
      password: "password123"
    });
  } finally {
    host.close();
    relay.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

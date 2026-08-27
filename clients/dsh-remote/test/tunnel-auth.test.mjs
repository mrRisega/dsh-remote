import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "dsh-bridge.mjs");

test("router 以 4003 拒绝过期 JWT 后重新登录再连接", async () => {
  let loginCount = 0;
  const api = http.createServer((req, res) => {
    const body = req.url === "/api/device-login"
      ? { token: `token-${++loginCount}` }
      : req.url === "/api/devices"
        ? { device: { id: "dev-000000000001" } }
        : { error: "not found" };
    res.writeHead(req.url === "/api/devices" ? 201 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  const registrations = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const gotTwo = new Promise((resolve) => {
    wss.on("connection", (ws) => ws.once("message", (raw) => {
      registrations.push(JSON.parse(raw.toString()).token);
      if (registrations.length === 1) ws.close(4003, "bad token");
      if (registrations.length === 2) resolve();
    }));
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-test-"));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
      DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
      DSH_BRIDGE_PHONE: "test-account",
      DSH_BRIDGE_PASSWORD: "test-password",
      DSH_BRIDGE_DEVICE_ID: "dev-000000000001",
      DSH_BRIDGE_CONFIG: path.join(tempDir, "config.json")
    },
    stdio: "ignore"
  });

  try {
    await Promise.race([
      gotTwo,
      delay(5_000, null, { ref: false }).then(() => { throw new Error("bridge 未在 5 秒内重连"); })
    ]);
    assert.deepEqual(registrations, ["token-1", "token-2"]);
    assert.equal(loginCount, 2);
  } finally {
    child.kill();
    wss.close();
    api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("router 不再响应心跳时主动断开半开隧道并重连", async () => {
  const api = http.createServer((req, res) => {
    const body = req.url === "/api/device-login"
      ? { token: "token" }
      : { device: { id: "dev-000000000002" } };
    res.writeHead(req.url === "/api/devices" ? 201 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  let registrations = 0;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
  await new Promise((resolve) => wss.once("listening", resolve));
  const reconnected = new Promise((resolve) => {
    wss.on("connection", (ws) => ws.once("message", () => {
      if (++registrations === 2) resolve();
    }));
  });

  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
      DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
      DSH_BRIDGE_HEARTBEAT_MS: "100",
      DSH_BRIDGE_PHONE: "test-account",
      DSH_BRIDGE_PASSWORD: "test-password",
      DSH_BRIDGE_DEVICE_ID: "dev-000000000002"
    },
    stdio: "ignore"
  });

  try {
    await Promise.race([
      reconnected,
      delay(4_000, null, { ref: false }).then(() => { throw new Error("bridge 未主动重连半开隧道"); })
    ]);
    assert.equal(registrations, 2);
  } finally {
    child.kill();
    wss.close();
    api.close();
  }
});

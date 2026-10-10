// 设备登记上报约定回归（2026-10 版本分析需求）。
//
// 【为什么必须有】生产反馈只能看到「插件版本」（install_version），从来拿不到
//   「宿主 DeepSeek Harness 版本」—— 于是「是不是 DSH 升级导致的兼容性故障」这个问题
//   在后台**答不出来**（数据不能回填，只能从新版开始积累）。
//   宿主版本由插件在**宿主进程里**问出来（harnessVersion()），经 DSH_BRIDGE_HARNESS_VERSION
//   传给 bridge；bridge 自己（独立进程）推不出来。本用例走真实 bridge 进程 + 假账号 API，
//   逐字断言**桥到底往 /api/devices 发了什么**。
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

test("设备登记：harness_version（宿主版本）与 install_version（插件版本）必须分别如实上报", async () => {
  let seen = null;
  const api = http.createServer((req, res) => {
    if (req.url === "/api/device-login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "token-1" }));
      return;
    }
    if (req.url === "/api/devices") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { seen = JSON.parse(raw); } catch { seen = { parseError: raw }; }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ device: { id: "dev-000000000002" } }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-device-report-"));
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
      DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
      DSH_BRIDGE_PHONE: "test-account",
      DSH_BRIDGE_PASSWORD: "test-password",
      DSH_BRIDGE_DEVICE_ID: "dev-000000000002",
      DSH_BRIDGE_CONFIG: path.join(tempDir, "config.json"),
      // 插件在宿主进程里探测到的宿主版本 → 经环境变量注入 bridge
      DSH_BRIDGE_HARNESS_VERSION: "0.2.0-rc.2",
      DSH_BRIDGE_INSTALL_VERSION: "0.7.0-beta.2",
      DSH_BRIDGE_INSTALL_SOURCE: "plugin_market",
    },
    stdio: "ignore",
  });

  try {
    for (let i = 0; i < 60 && !seen; i += 1) await delay(100, null, { ref: false });
    assert.ok(seen, "bridge 应在 6 秒内完成设备登记（POST /api/devices）");
    assert.equal(seen.harness_version, "0.2.0-rc.2", "★宿主版本必须进登记请求（这是本次需求的核心）");
    assert.equal(seen.install_version, "0.7.0-beta.2", "插件版本照旧上报，两个数都要有");
    assert.equal(seen.install_source, "plugin_market");
    assert.equal(seen.device_id, "dev-000000000002");
    assert.ok(seen.host_os && seen.host_arch, "平台/架构照旧");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    await new Promise((r) => wss.close(r));
    await new Promise((r) => api.close(r));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("设备登记：老插件不注入 DSH_BRIDGE_HARNESS_VERSION 时，字段必须是空串（不是缺字段、更不是猜）", async () => {
  let seen = null;
  const api = http.createServer((req, res) => {
    if (req.url === "/api/device-login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "token-1" }));
      return;
    }
    if (req.url === "/api/devices") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { seen = JSON.parse(raw); } catch { seen = null; }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ device: { id: "dev-000000000003" } }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-device-report-"));
  const env = { ...process.env };
  delete env.DSH_BRIDGE_HARNESS_VERSION;   // 模拟老插件
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...env,
      DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
      DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
      DSH_BRIDGE_PHONE: "test-account",
      DSH_BRIDGE_PASSWORD: "test-password",
      DSH_BRIDGE_DEVICE_ID: "dev-000000000003",
      DSH_BRIDGE_CONFIG: path.join(tempDir, "config.json"),
    },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 60 && !seen; i += 1) await delay(100, null, { ref: false });
    assert.ok(seen, "bridge 仍应完成设备登记");
    assert.equal(seen.harness_version, "", "取不到就上报空串（= 未上报），绝不猜一个错的版本");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    await new Promise((r) => wss.close(r));
    await new Promise((r) => api.close(r));
    await rm(tempDir, { recursive: true, force: true });
  }
});

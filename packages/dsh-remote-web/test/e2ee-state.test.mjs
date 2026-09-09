// 插件 node 半 E2EE 状态读取（Phase-5）：composeStatus 读取 relayDir/.e2ee-state.json →
// /dsh-remote/status 的 service.e2ee = {enabled, reason, profile, epoch, caps}；文件缺失/损坏=未启用明文。
// 覆盖：readE2eeStateFile 归一化单测 + 真实 apply 路由集成（写状态文件 → status 带回；删文件 → 默认明文）。
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply, readE2eeStateFile } from "../lib/index.js";

const E2EE_DEFAULT = { enabled: false, reason: "no_state_file", profile: "", epoch: 0, caps: [] };

test("readE2eeStateFile：缺失/损坏 → 默认明文；有效状态归一化（at 等调试字段不外泄）", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-e2ee-read-"));
  try {
    // 1) 文件缺失 → 默认（未启用明文）
    assert.deepEqual(readE2eeStateFile(tempDir), E2EE_DEFAULT);

    // 2) 损坏 JSON / 非对象 → 默认
    await writeFile(path.join(tempDir, ".e2ee-state.json"), "{oops", "utf8");
    assert.deepEqual(readE2eeStateFile(tempDir), E2EE_DEFAULT);
    await writeFile(path.join(tempDir, ".e2ee-state.json"), "42", "utf8");
    assert.deepEqual(readE2eeStateFile(tempDir), E2EE_DEFAULT);

    // 3) 有效状态：只透出固定展示字段，enabled/caps 等按布尔/字符串严格归一化
    await writeFile(path.join(tempDir, ".e2ee-state.json"), JSON.stringify({
      enabled: true,
      reason: "ok",
      profile: "pbkdf2-sha256-600k",
      epoch: 3,
      caps: ["e2ee-v2", 7, null, "e2ee-http"],
      at: Date.now(), // 调试字段
    }), "utf8");
    assert.deepEqual(readE2eeStateFile(tempDir), {
      enabled: true,
      reason: "ok",
      profile: "pbkdf2-sha256-600k",
      epoch: 3,
      caps: ["e2ee-v2", "e2ee-http"],
    });

    // 4) 畸形字段兜底：enabled 非布尔→false；reason 非字符串→空；epoch 负数/字符串→0
    await writeFile(path.join(tempDir, ".e2ee-state.json"), JSON.stringify({
      enabled: "yes",
      reason: 123,
      profile: null,
      epoch: -1,
      caps: "e2ee-v2",
    }), "utf8");
    assert.deepEqual(readE2eeStateFile(tempDir), {
      enabled: false,
      reason: "",
      profile: "",
      epoch: 0,
      caps: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** 假账号 API：只回 public-config（composeStatus 取 app_url 用），其余 404。 */
function startFakeRelay() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/api/public-config") {
      res.end(JSON.stringify({ app_url: "https://app.test/app/", api_url: `http://127.0.0.1:${srv.address().port}/relay-api` }));
      return;
    }
    res.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

/** 装载插件路由 + 假 launchctl/pgrep/ps（避免触碰真实系统服务），返回 host http server 与 base。 */
async function bootPlugin(relayDir) {
  const fakeBin = path.join(relayDir, "fakebin");
  await mkdir(fakeBin, { recursive: true });
  const noop = "#!/bin/sh\nexit 0\n";
  for (const name of ["launchctl", "pgrep", "ps"]) {
    const p = path.join(fakeBin, name);
    await writeFile(p, noop);
    await chmod(p, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath}`;

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}`, fakeBin, oldPath };
}

test("composeStatus：.e2ee-state.json 启用 → /dsh-remote/status 的 service.e2ee；删除 → 默认明文", async () => {
  const relay = await startFakeRelay();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-e2ee-status-"));
  const stateFile = path.join(tempDir, ".e2ee-state.json");
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000",
    device_id: "dev-e2ee",
    api_url: `http://127.0.0.1:${relay.address().port}/relay-api`,
  }));
  const boot = await bootPlugin(tempDir);
  try {
    // 1) bridge 已启用 E2EE（写状态文件）→ status 携带归一化 service.e2ee
    await writeFile(stateFile, JSON.stringify({
      enabled: true, reason: "ok", profile: "pbkdf2-sha256-600k", epoch: 2, caps: ["e2ee-v2"], at: Date.now(),
    }));
    let status = await (await fetch(`${boot.base}/dsh-remote/status`)).json();
    assert.equal(status.ok, true);
    assert.deepEqual(status.service.e2ee, {
      enabled: true, reason: "ok", profile: "pbkdf2-sha256-600k", epoch: 2, caps: ["e2ee-v2"],
    });

    // 2) bridge 未启用（服务端灰度关）→ 原样上报 reason，供面板映射可读文案
    await writeFile(stateFile, JSON.stringify({ enabled: false, reason: "server_disabled", profile: "", epoch: 0, caps: [] }));
    status = await (await fetch(`${boot.base}/dsh-remote/status`)).json();
    assert.equal(status.service.e2ee.enabled, false);
    assert.equal(status.service.e2ee.reason, "server_disabled");

    // 3) 文件缺失 = 未启用明文（默认兜底）
    await rm(stateFile, { force: true });
    status = await (await fetch(`${boot.base}/dsh-remote/status`)).json();
    assert.deepEqual(status.service.e2ee, E2EE_DEFAULT);
  } finally {
    boot.host.close();
    relay.close();
    process.env.PATH = boot.oldPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});

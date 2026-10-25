// 设备超额锁定 —— bridge 侧行为回归（契约 docs/device-overquota-lock-contract.md §6）。
//
// 【为什么必须有】旧实现收到「设备不可用」只做两件事之一：
//   · 旧版 409 device_limit_exceeded → persistBindError + process.exit(1)；
//   · router tunnel-register-err → 写 state.last_error 然后**照常 2s 后重连**。
// 两者都是"空转"：watcher 每 10s 重拉 / 隧道每 2s 重撞，用户看到的是「设备列表里明明有这台电脑，
// 但手机永远连不上」，日志还被刷屏。本用例走真实 bridge 进程 + 假账号 API + 假 router，
// 逐条钉住新契约：
//   ① 锁定态**不退出进程**、写 phase=locked 详情、不重连隧道（只 30s 轮询 GET /api/devices）；
//   ② 解锁（locked=false）→ 立即重连；设备行不存在（手机端解绑）→ 先登记再连；
//   ③ 旧版 409 device_limit_exceeded 同样转等待（向后兼容，不再 exit(1)）；
//   ④ device_bind_cap → 专用退出码 5 + .bind-error.json 带 device_id 等详情（watcher 据此指数退避）。
//
// ⚠️ 只连 127.0.0.1（test:bridge 带 test-net-guard）；轮询间隔用 DSH_BRIDGE_LOCK_POLL_MS 压到亚秒级。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "dsh-bridge.mjs");
const DEVICE_ID = "dev-000000000001";
const LOCK_POLL_MS = "80";

const sleep = (ms) => delay(ms, null, { ref: false });
async function waitFor(fn, { timeout = 5000, step = 40, label = "" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`等待超时${label ? `（${label}）` : ""}`);
    await sleep(step);
  }
}
function jsonOf(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * 起一个假账号 API + 假 router；`scenario` 决定 register/getDevices/ws 的剧本。
 * @returns {Promise<{child, api, wss, port, stateFile, bindErrorFile, counts, close}>}
 */
async function launch(scenario) {
  const counts = { register: 0, get: 0, login: 0, ws: 0 };
  const registrations = [];
  const api = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/device-login") {
      counts.login += 1;
      return send(200, { token: `tok-${counts.login}` });
    }
    if (req.url === "/api/devices" && req.method === "POST") {
      counts.register += 1;
      return send(...scenario.onRegister(counts.register, req));
    }
    if (req.url === "/api/devices" && req.method === "GET") {
      counts.get += 1;
      return send(...scenario.onGetDevices(counts.get, req));
    }
    return send(404, { error: { code: "not_found", message: "not found" } });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", (ws) => {
    counts.ws += 1;
    ws.once("message", (raw) => {
      try { registrations.push(JSON.parse(raw.toString())); } catch { registrations.push({ raw: String(raw) }); }
      scenario.onRegisterWs(ws, registrations.length);
    });
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-device-locked-"));
  const configFile = path.join(tempDir, "config.json");
  await writeFile(configFile, "{}");
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
      DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
      DSH_BRIDGE_UPSTREAM: "http://127.0.0.1:1", // 不做端口发现：本用例只测锁定逻辑
      DSH_BRIDGE_PHONE: "test-account",
      DSH_BRIDGE_PASSWORD: "test-password",
      DSH_BRIDGE_DEVICE_ID: DEVICE_ID,
      DSH_BRIDGE_CONFIG: configFile,
      DSH_BRIDGE_LOCK_POLL_MS: LOCK_POLL_MS,
      DSH_WECHAT: "0", // 微信通道与本用例无关，别让它发起额外的网络请求
      DSH_REMOTE_TELEMETRY: "0",
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += String(c); });

  const relayDir = path.dirname(configFile);
  return {
    child,
    api,
    wss,
    counts,
    registrations,
    stderrText: () => stderr,
    stateFile: path.join(relayDir, ".dsh-bridge-state.json"),
    bindErrorFile: path.join(relayDir, ".bind-error.json"),
    async close() {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      await new Promise((r) => wss.close(r));
      await new Promise((r) => api.close(r));
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

/** 201 响应体（契约 §4.2 形状）：device + locked + policy。 */
const okRegister = () => [201, {
  device: { id: DEVICE_ID },
  locked: false,
  policy: { plan: "free", limit: 1, online: 1, unlock_monthly: 3, registered: 1, locked_count: 0, upgrade_to: "pro_max", lock_enabled: true }
}];
const lockedFrame = {
  type: "tunnel-register-err",
  code: "device_locked",
  message: "已超出当前套餐设备额度，升级 Pro Max 可多台设备同时使用",
  plan: "free",
  limit: 1,
  upgrade_to: "pro_max"
};
const okFrame = { type: "tunnel-register-ok", caps: [] };

test("锁定态：不退出、写 phase=locked 详情、期间不重连；解锁后自动重连", async () => {
  const ctx = await launch({
    // 第一次隧道注册 → 被 router 以 device_locked 拒绝；之后才允许成功
    onRegisterWs(ws, n) {
      if (n === 1) ws.send(JSON.stringify(lockedFrame));
      else ws.send(JSON.stringify(okFrame));
    },
    onRegister: () => okRegister(),
    // 前两拍仍锁定（验证"等待期间不重连"），第三拍起解锁
    onGetDevices(getCount) {
      return [200, {
        devices: [{ id: DEVICE_ID, device_name: "test-host", locked: getCount < 3 }],
        policy: { plan: "free", limit: 1, registered: 2, locked_count: getCount < 3 ? 1 : 0, upgrade_to: "pro_max", lock_enabled: true }
      }];
    }
  });
  try {
    // ① 锁定态：进程活着 + 状态文件 phase=locked + locked 详情（面板据此显示升级引导）
    await waitFor(() => {
      const st = jsonOf(ctx.stateFile);
      return st && st.phase === "locked" && st.locked && st.locked.limit === 1;
    }, { label: "phase=locked" });
    assert.equal(ctx.child.exitCode, null, "锁定态**不得退出进程**（旧实现 exit(1) 是空转）");
    const st = jsonOf(ctx.stateFile);
    assert.equal(st.locked.plan, "free");
    assert.equal(st.locked.upgrade_to, "pro_max");
    assert.match(String(st.locked.message), /额度/);
    assert.equal(st.last_error, null, "锁定不是「注册错误」，last_error 必须清空");

    // ② .bind-error.json 富化（契约 §6.3/§8.4）：带 device_id/plan/limit/upgrade_to
    await waitFor(() => existsSync(ctx.bindErrorFile), { label: "bind-error" });
    const be = jsonOf(ctx.bindErrorFile);
    assert.equal(be.code, "device_locked");
    assert.equal(be.device_id, DEVICE_ID);
    assert.equal(be.plan, "free");
    assert.equal(be.limit, 1);
    assert.equal(be.upgrade_to, "pro_max");

    // ③ 等待期间**不重连隧道**（只轮询 /api/devices；轮询带 Bearer token）
    await waitFor(() => ctx.counts.get >= 2, { label: "poll >= 2" });
    assert.equal(ctx.registrations.length, 1, "锁定等待期间不得重连隧道（否则每 2s 白撞一次 router）");
    assert.equal(ctx.child.exitCode, null, "等待期间进程必须活着");

    // ④ 解锁 → 自动重连（第二次 WS 注册）
    await waitFor(() => ctx.registrations.length === 2, { label: "解锁后重连" });
    assert.equal(ctx.registrations[0].deviceId, DEVICE_ID);
    await waitFor(() => {
      const cur = jsonOf(ctx.stateFile);
      return cur && cur.phase === "online";
    }, { label: "重连后 phase=online" });
    assert.equal(existsSync(ctx.bindErrorFile), false, "解锁重连成功后应清掉 .bind-error.json");
  } finally {
    await ctx.close();
  }
});

test("等待期间设备行被解绑（列表里没有本机）→ 先重新登记再重连", async () => {
  const ctx = await launch({
    onRegisterWs(ws, n) {
      if (n === 1) ws.send(JSON.stringify(lockedFrame));
      else ws.send(JSON.stringify(okFrame));
    },
    onRegister: () => okRegister(),
    onGetDevices() {
      // 手机端把本机解绑了：列表里没有本机 → bridge 必须 registerDeviceInAccount 后重连
      return [200, { devices: [], policy: { plan: "free", limit: 1, registered: 0, locked_count: 0, upgrade_to: "pro_max", lock_enabled: true } }];
    }
  });
  try {
    await waitFor(() => {
      const st = jsonOf(ctx.stateFile);
      return st && st.phase === "locked";
    }, { label: "phase=locked" });
    await waitFor(() => ctx.counts.register >= 2, { label: "重新登记" });
    await waitFor(() => ctx.registrations.length === 2, { label: "重连" });
    assert.equal(ctx.child.exitCode, null);
  } finally {
    await ctx.close();
  }
});

test("旧版服务端 409 device_limit_exceeded：不再 exit(1) 空转，改为轮询等待后重连", async () => {
  const ctx = await launch({
    onRegisterWs(ws) { ws.send(JSON.stringify(okFrame)); },
    // 旧服务端：按套餐额度拒绝登记（新契约下已改为「可超绑 + 锁定」，这里验证向后兼容）
    onRegister() {
      return [409, { error: { code: "device_limit_exceeded", message: "当前套餐最多绑定 1 台设备，请先解绑旧设备" } }];
    },
    // 解绑后本机变为可用
    onGetDevices() {
      return [200, { devices: [{ id: DEVICE_ID, locked: false }], policy: { plan: "free", limit: 1, registered: 1, locked_count: 0, upgrade_to: "pro_max", lock_enabled: true } }];
    }
  });
  try {
    await waitFor(() => {
      const st = jsonOf(ctx.stateFile);
      return st && st.phase === "locked";
    }, { label: "旧 409 → phase=locked" });
    assert.equal(ctx.child.exitCode, null, "旧版 409 必须转为等待，不得 exit(1)");
    // 旧服务端不返回 limit：从文案「最多绑定 1 台」里尽力解析（面板文案要能说 N 台）
    const st = jsonOf(ctx.stateFile);
    assert.equal(st.locked.limit, 1, "应从旧版文案解析出额度，避免面板显示「N 台」占位");
    await waitFor(() => ctx.registrations.length === 1, { label: "解锁后首次连隧道" });
    assert.equal(ctx.child.exitCode, null);
  } finally {
    await ctx.close();
  }
});

test("device_bind_cap：写 .bind-error.json + 专用退出码 5（watcher 据此指数退避）", async () => {
  const ctx = await launch({
    onRegisterWs() { /* 不应连上：登记就失败了 */ },
    onRegister() {
      return [409, { error: { code: "device_bind_cap", message: "已绑定设备数已达上限(50 台)，请先在手机端「管理电脑」解绑" } }];
    },
    onGetDevices() { return [200, { devices: [] }]; }
  });
  try {
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 8000);
      ctx.child.once("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 5, "device_bind_cap 必须用专用退出码 5 退出（不能与瞬时失败共用 exit 1）");
    const be = jsonOf(ctx.bindErrorFile);
    assert.ok(be, "必须写 .bind-error.json 供面板展示");
    assert.equal(be.code, "device_bind_cap");
    assert.equal(be.device_id, DEVICE_ID, "详情里的 device_id 不能丢（P0：面板/诊断靠它定位）");
    assert.equal(ctx.counts.ws, 0, "登记失败时不该去连隧道");
  } finally {
    await ctx.close();
  }
});

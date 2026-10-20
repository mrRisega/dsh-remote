/**
 * C2 / C5 回归：bridge 的「互踢根治」与「心跳/退避」契约。
 *
 * 背景（2026-10-20 用户群故障诊断，报告 00 §6.2 / 04 §四）：
 *   · R2：隧道 30 秒级断连，今天断开 6,561 次 / 322 台设备（活跃设备 90%），
 *     75.2% 的隧道会话活不到 60s —— 心跳 15s + **丢 1 次 pong 就断** 是主因之一；
 *   · 互踢：中继在"同 deviceId 新连接注册"时 close(4000) 顶掉旧连接，而旧实现**收到 4000
 *     仍然 2s 后重连** → 两个实例以 2~3.5s 周期乒乓（生产 dev-a50dced9cc19 327 次/10min）；
 *   · 同机单实例保护缺失：孤儿 bridge / 升级后未退的旧 bridge 都能起第二份。
 *
 * 本文件锁三层：
 *   ① 纯函数策略（4000 长退避/退出、普通退避上限 10s + 抖动、心跳连续 2 次丢 pong）；
 *   ② 单实例锁的判定纪律（死 pid/无关进程抢锁、真 bridge 阻塞、看不清时放行）；
 *   ③ 端到端：真的起两个 bridge，第二个必须**启动即退出（退出码 4）**。
 */
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

import {
  DUPLICATE_INSTANCE_EXIT_CODE,
  DUPLICATE_RECONNECT_BASE_MS,
  HEARTBEAT_MAX_MISSED_PONGS,
  MAX_RECONNECT_DELAY_MS,
  RECONNECT_JITTER_MS,
  RECONNECT_JITTER_MIN_BASE_MS,
  TUNNEL_HEARTBEAT_DEFAULT_MS,
  heartbeatStep,
  instanceLockVerdict,
  reconnectPlan,
} from "../dsh-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "dsh-bridge.mjs");

// ─────────────────────── ① 心跳（C5）───────────────────────

test("C5 心跳：间隔从 15s 调到 20-25s，且连续丢 2 次 pong 才断", () => {
  assert.ok(TUNNEL_HEARTBEAT_DEFAULT_MS >= 20_000 && TUNNEL_HEARTBEAT_DEFAULT_MS <= 25_000,
    `心跳间隔必须在 20-25s（实际 ${TUNNEL_HEARTBEAT_DEFAULT_MS}）`);
  assert.equal(HEARTBEAT_MAX_MISSED_PONGS, 2, "必须容忍连续 2 次丢 pong（旧实现丢 1 次就断）");

  // 有 pong：正常发下一拍
  assert.deepEqual(heartbeatStep({ pongReceived: true, missedPongs: 0 }), { missedPongs: 0, terminate: false, ping: true });
  // 第 1 次没等到 pong：**不能断**，继续探测（旧契约在这里就 terminate 了）
  assert.deepEqual(heartbeatStep({ pongReceived: false, missedPongs: 0 }), { missedPongs: 1, terminate: false, ping: true });
  // 第 2 次仍未 pong：判定隧道已死
  assert.deepEqual(heartbeatStep({ pongReceived: false, missedPongs: 1 }), { missedPongs: 2, terminate: true, ping: false });
  // 中间任何一次收到 pong，计数清零
  assert.equal(heartbeatStep({ pongReceived: true, missedPongs: 1 }).missedPongs, 0);
});

// ─────────────────────── ② 重连退避（C2 + C5）───────────────────────

test("C2 互踢：close 4000 第一次长退避（30-60s），连续第 2 次直接退出", () => {
  const first = reconnectPlan({ code: 4000, retry: 0, consecutive4000: 0, rand: () => 0.5 });
  assert.equal(first.exit, false, "第一次被顶不能退出（可能是短暂升级重叠，长退避让对方站稳）");
  assert.equal(first.consecutive4000, 1);
  assert.ok(first.delayMs >= DUPLICATE_RECONNECT_BASE_MS, `第一次退避必须 ≥30s（实际 ${first.delayMs}）`);
  assert.ok(first.delayMs <= DUPLICATE_RECONNECT_BASE_MS * 2, `第一次退避上限 60s（实际 ${first.delayMs}）`);

  const second = reconnectPlan({ code: 4000, retry: 3, consecutive4000: first.consecutive4000, rand: () => 0.5 });
  assert.equal(second.exit, true, "连续第 2 次 4000 → 必须退出（再重连只会继续互踢）");
  assert.equal(second.delayMs, 0);

  // 普通断线会清零计数：一次 4000 + 一次 1006 不构成"连续 2 次"
  assert.equal(reconnectPlan({ code: 1006, retry: 1, consecutive4000: 1 }).consecutive4000, 0);
});

test("C5 普通退避：上限 30s→10s，且加 0-3s 抖动避免同步重连尖峰", () => {
  // 第一档（2s）保持确定值：测试里「bridge 5 秒内必须重连」的硬期限不能被随机数撞破
  const d0 = reconnectPlan({ code: 1006, retry: 0, rand: () => 0.99 });
  assert.equal(d0.delayMs, 2_000);
  assert.ok(MAX_RECONNECT_DELAY_MS <= 10_000, "上限必须降到 10s（旧上限 30s 让瞬时断网恢复过慢）");
  // 高档位：base + 0~3s 抖动，且总时长不超过上限 + 抖动
  for (const retry of [2, 3, 4, 9]) {
    const lo = reconnectPlan({ code: 1006, retry, rand: () => 0 });
    const hi = reconnectPlan({ code: 1006, retry, rand: () => 0.999 });
    const base = Math.min(MAX_RECONNECT_DELAY_MS, 2_000 * 2 ** retry);
    assert.equal(lo.delayMs, base, `retry=${retry} 无抖动时等于 base`);
    assert.ok(hi.delayMs >= base && hi.delayMs < base + RECONNECT_JITTER_MS + 1, `retry=${retry} 抖动必须 0~3s（实际 ${hi.delayMs - base}ms）`);
    assert.ok(base >= RECONNECT_JITTER_MIN_BASE_MS, "高档位才加抖动（首档保持确定性）");
  }
  // 档位封顶后再怎么重试也不涨
  assert.equal(reconnectPlan({ code: 1006, retry: 20, rand: () => 0 }).delayMs, MAX_RECONNECT_DELAY_MS);
});

// ─────────────────────── ③ 单实例锁判定（C2）───────────────────────

test("C2 单实例锁判定：死 pid/无关进程抢锁，真 bridge 阻塞，看不清时放行（失败安全）", () => {
  assert.equal(instanceLockVerdict({ selfPid: 10, pid: 0, alive: false }), "steal", "没有锁 → 抢");
  assert.equal(instanceLockVerdict({ selfPid: 10, pid: 10, alive: true, isOurBridge: true }), "steal", "自己那把旧锁 → 抢");
  assert.equal(instanceLockVerdict({ selfPid: 10, pid: 99, alive: false }), "steal", "pid 已死 → 陈旧锁可抢（绝不能永久挡住启动）");
  assert.equal(instanceLockVerdict({ selfPid: 10, pid: 99, alive: true, isOurBridge: false }), "steal", "pid 被回收给无关进程 → 抢");
  assert.equal(instanceLockVerdict({ selfPid: 10, pid: 99, alive: true, isOurBridge: true }), "blocked", "命令行确认是本 bridge → 已有实例，本实例退出");
  assert.equal(instanceLockVerdict({ selfPid: 10, pid: 99, alive: true, isOurBridge: false, commandKnown: false }), "unknown",
    "取不到命令行 → 不阻塞启动（多开由 4000 长退避/退出兜底），也不误删别人的锁");
});

// ─────────────────────── ④ 端到端：第二个实例启动即退出 ───────────────────────

test("C2 端到端：同一配置目录的第二个 bridge 启动即退出（退出码 4），不会去抢 deviceId", async () => {
  let loginCount = 0;
  const api = http.createServer((req, res) => {
    const body = req.url === "/api/device-login"
      ? { token: `token-${++loginCount}` }
      : req.url === "/api/devices"
        ? { device: { id: "dev-0000000000aa" } }
        : { error: "not found" };
    res.writeHead(req.url === "/api/devices" ? 201 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const registered = new Promise((resolve) => {
    wss.on("connection", (ws) => ws.once("message", () => resolve()));
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-guard-"));
  const env = {
    ...process.env,
    DSH_BRIDGE_API: `http://127.0.0.1:${api.address().port}`,
    DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${wss.address().port}`,
    DSH_BRIDGE_PHONE: "test-account",
    DSH_BRIDGE_PASSWORD: "test-password",
    DSH_BRIDGE_DEVICE_ID: "dev-0000000000aa",
    DSH_BRIDGE_CONFIG: path.join(tempDir, "config.json"),
    DSH_WECHAT: "0",        // 本用例只测隧道与锁；关掉微信通道避免无关轮询
    DSH_BRIDGE_E2EE: "0"    // 同理：不起 E2EE 初始化
  };
  let first = null;
  try {
    first = spawn(process.execPath, [BRIDGE], { env, stdio: ["ignore", "pipe", "pipe"] });
    first.stdout.on("data", () => {});
    first.stderr.on("data", () => {});
    await Promise.race([
      registered,
      delay(8_000, null, { ref: false }).then(() => { throw new Error("第一个 bridge 未在 8 秒内注册隧道"); })
    ]);

    // 第二个实例：同一 DSH_BRIDGE_CONFIG（同 relayDir）→ 锁被第一个占着，必须启动即退出
    const second = spawn(process.execPath, [BRIDGE], { env, stdio: ["ignore", "pipe", "pipe"] });
    let errText = "";
    second.stderr.on("data", (b) => { errText += b.toString(); });
    const exitCode = await Promise.race([
      new Promise((resolve) => second.on("exit", (code) => resolve(code))),
      delay(10_000, null, { ref: false }).then(() => "timeout")
    ]);
    try { second.kill("SIGKILL"); } catch { /* 已退出 */ }
    assert.equal(exitCode, DUPLICATE_INSTANCE_EXIT_CODE,
      `第二个实例必须以退出码 ${DUPLICATE_INSTANCE_EXIT_CODE} 退出（实际 ${exitCode}）——否则两个实例同 deviceId 互踢`);
    assert.match(errText, /已有另一个 bridge/, `日志要说明为什么退出：${errText.slice(0, 500)}`);
    assert.equal(loginCount, 1, "被挡下的第二个实例不得再去登录账号 API（登录接口按出口 IP 限流）");
  } finally {
    if (first) { try { first.kill("SIGKILL"); } catch { /* 已退出 */ } }
    wss.close();
    api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

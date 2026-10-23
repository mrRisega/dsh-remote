#!/usr/bin/env node
/**
 * 心跳自适应回归（2026-10-23）。
 *
 * 生产事故（手机频繁断线主因链 #3）：
 *   固定 20s 心跳 + 固定"丢 2 个 pong 就重连"。DSH 主线程被大任务/大响应占住时，pong 在
 *   socket 事件里排不上队 → 连续两拍判死 → 重建隧道 → 手机侧全部在途请求断开、页面重连。
 *   全站 13706 次/天 bridge 断开里有一大批是这么来的。
 *
 * 本文件锁「纯函数」契约（真机/集成行为由 bridge 日志与 test:bridge 全量保证）：
 *   ① 健康链路完全保留旧契约（丢 2 拍才断）；
 *   ② 本机事件循环延迟高 / RTT 慢 / 已在中断中 → 判定窗口放宽；
 *   ③ 放宽有上限（默认 4 拍 / 环境变量可调），不会退化成永不重连；
 *   ④ DSH_BRIDGE_HEARTBEAT_ADAPT=0 可退回旧契约。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HEARTBEAT_LAG_BUSY_MS,
  HEARTBEAT_MAX_MISSED_CAP_DEFAULT,
  HEARTBEAT_MAX_MISSED_PONGS,
  HEARTBEAT_RTT_SLOW_MS,
  TUNNEL_HEARTBEAT_DEFAULT_MS,
  __setEventLoopLagForTest,
  adaptiveHeartbeat,
  currentEventLoopLagMs,
  heartbeatStep
} from "../dsh-bridge.mjs";

const BASE = TUNNEL_HEARTBEAT_DEFAULT_MS;

test("① 健康链路 = 旧契约：收到 pong 就归零，连续 2 拍没 pong 才断", () => {
  const pong = adaptiveHeartbeat({ pongReceived: true, missedPongs: 5, rttMs: 40, eventLoopLagMs: 1 });
  assert.equal(pong.missedPongs, 0);
  assert.equal(pong.terminate, false);
  assert.equal(pong.intervalMs, BASE, "健康链路 ping 间隔不变");
  assert.equal(pong.maxMissed, HEARTBEAT_MAX_MISSED_PONGS);

  const one = adaptiveHeartbeat({ pongReceived: false, missedPongs: 0, rttMs: 40, eventLoopLagMs: 1 });
  assert.equal(one.missedPongs, 1);
  assert.equal(one.terminate, false, "丢 1 拍不断（旧行为是丢 1 就断）");

  const two = adaptiveHeartbeat({ pongReceived: false, missedPongs: 1, rttMs: 40, eventLoopLagMs: 1 });
  assert.equal(two.missedPongs, 2);
  assert.equal(two.terminate, true, "健康链路下连续 2 拍没 pong 仍按旧契约判死");

  // 与旧纯函数 heartbeatStep 在健康链路下结论一致
  for (const missed of [0, 1, 2, 3]) {
    const a = adaptiveHeartbeat({ pongReceived: false, missedPongs: missed, rttMs: 40, eventLoopLagMs: 0 });
    const b = heartbeatStep({ pongReceived: false, missedPongs: missed });
    assert.equal(a.terminate, b.terminate, `健康链路 missed=${missed} 的判定必须与旧契约一致`);
  }
});

test("② 本机繁忙（事件循环延迟 ≥500ms）→ 多给一拍，瞬时卡顿不再判死", () => {
  const plan = adaptiveHeartbeat({ pongReceived: false, missedPongs: 0, rttMs: 40, eventLoopLagMs: HEARTBEAT_LAG_BUSY_MS });
  assert.equal(plan.maxMissed, HEARTBEAT_MAX_MISSED_PONGS + 1);
  assert.ok(plan.reasons.includes("event_loop_busy"));
  assert.equal(plan.terminate, false);
  // 第 2 拍仍不断（这正是生产里 DSH 主线程卡 3~5 秒的场景）
  const second = adaptiveHeartbeat({ pongReceived: false, missedPongs: 1, rttMs: 40, eventLoopLagMs: HEARTBEAT_LAG_BUSY_MS });
  assert.equal(second.terminate, false, "繁忙时第 2 拍不得判死");
  // 第 3 拍才断
  const third = adaptiveHeartbeat({ pongReceived: false, missedPongs: 2, rttMs: 40, eventLoopLagMs: HEARTBEAT_LAG_BUSY_MS });
  assert.equal(third.terminate, true);
});

test("③ 慢链路（RTT ≥1s）→ 间隔拉长 + 多给一拍；两者叠加有上限", () => {
  const slow = adaptiveHeartbeat({ pongReceived: false, missedPongs: 0, rttMs: HEARTBEAT_RTT_SLOW_MS, eventLoopLagMs: 0 });
  assert.ok(slow.maxMissed > HEARTBEAT_MAX_MISSED_PONGS);
  assert.ok(slow.intervalMs > BASE, "慢链路 ping 间隔应拉长（减少额外负载）");
  assert.ok(slow.intervalMs <= 60_000);
  assert.ok(slow.reasons.includes("rtt_slow"));

  // 繁忙 + 慢链路 + 已在中断中 → 上限封顶，不会无限放宽
  const worst = adaptiveHeartbeat({
    pongReceived: false,
    missedPongs: 1,
    rttMs: 5000,
    eventLoopLagMs: 3000,
    maxMissedCap: HEARTBEAT_MAX_MISSED_CAP_DEFAULT
  });
  assert.equal(worst.maxMissed, HEARTBEAT_MAX_MISSED_CAP_DEFAULT);
  assert.equal(worst.terminate, false);
  const capped = adaptiveHeartbeat({ pongReceived: false, missedPongs: 3, rttMs: 5000, eventLoopLagMs: 3000 });
  assert.equal(capped.maxMissed, HEARTBEAT_MAX_MISSED_CAP_DEFAULT);
  assert.equal(capped.terminate, true, "到了上限那一拍必须判死（不能永不重连）");
});

test("④ DSH_BRIDGE_HEARTBEAT_ADAPT=0 等价语义：完全退回固定窗口", () => {
  const plan = adaptiveHeartbeat({
    pongReceived: false,
    missedPongs: 1,
    rttMs: 5000,
    eventLoopLagMs: 3000,
    adaptive: false
  });
  assert.equal(plan.maxMissed, HEARTBEAT_MAX_MISSED_PONGS);
  assert.equal(plan.intervalMs, BASE);
  assert.equal(plan.terminate, true, "退回旧契约：第 2 拍即判死");
});

test("⑤ 事件循环延迟探针（测试钩子）", () => {
  assert.equal(currentEventLoopLagMs(), 0);
  __setEventLoopLagForTest(800);
  assert.equal(currentEventLoopLagMs(), 800);
  __setEventLoopLagForTest(-5);
  assert.equal(currentEventLoopLagMs(), 0);
});

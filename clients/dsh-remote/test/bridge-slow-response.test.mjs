#!/usr/bin/env node
/**
 * B0 观测（2026-11-08）：慢响应计时口径。
 *
 * 生产问题：首屏资源从 PC 出来只有 3–16KB/s，但原日志只有 "→ 200 (3200ms, 1700KB)"，
 * 分不清慢在宿主首包 / 读体 / gzip / 注入 / **排队等隧道**（后者是本轮最要紧的一段）。
 *
 * 锁三条：
 *   ① 发送器的 `onFlushed` 在整条数据帧**所有分片都 rawSend 完**之后才回调（否则计时会偏小）；
 *   ② 慢响应行格式包含五段耗时、且**不把查询串写进日志**（与埋点/中继日志口径一致）；
 *   ③ timings 用不可枚举属性挂回回包对象 —— `JSON.stringify(reply)` 不带它，隧道帧字节不变。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatSlowResponse, makePrioritySender, slowRespLogOptions } from "../dsh-bridge.mjs";

const BRIDGE_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dsh-bridge.mjs");

function fakeSocket() {
  const frames = [];
  let pending = 0;
  return {
    frames,
    rawSend(s) { frames.push(s); pending += s.length; },
    bufferedAmount: () => pending,
    drain(bytes = Infinity) { pending = Math.max(0, pending - bytes); return pending; }
  };
}

function makeScheduler() {
  const queue = [];
  return {
    schedule: (fn) => queue.push(fn),
    setTimer: (fn) => queue.push(fn),
    tick() { const fn = queue.shift(); if (!fn) return false; fn(); return true; },
    pending: () => queue.length
  };
}

test("B0①：onFlushed 在**全部**分片发完后才回调（且只回调一次）", () => {
  const sock = fakeSocket();
  const sched = makeScheduler();
  const sender = makePrioritySender({
    rawSend: sock.rawSend,
    bufferedAmount: sock.bufferedAmount,
    schedule: sched.schedule,
    setTimer: sched.setTimer
  });

  const big = { id: "r1", type: "http", body: "A".repeat(300 * 1024) };
  const total = JSON.stringify(big).length;
  let flushAt = -1;
  let flushCount = 0;
  sender.send(big, { id: "r1", onFlushed: () => { flushAt = sock.frames.length; flushCount += 1; } });
  assert.ok(sock.frames.length >= 1, "第一片当场发出");
  // 大帧不会当轮发完
  for (let i = 0; i < 5000 && sched.pending() > 0; i += 1) { sock.drain(4 * 1024 * 1024); sched.tick(); }
  assert.equal(flushCount, 1, "必须只回调一次");
  const chunks = Math.ceil(total / (64 * 1024));
  assert.equal(flushAt, chunks, `回调时所有分片都应已发出（回调于第 ${flushAt} 条，应为 ${chunks}）`);
});

test("B0②：慢响应行五段齐全、去查询串、队列厚度可见", () => {
  const line = formatSlowResponse({
    method: "GET",
    path: "/plugins/??@a/x.js,@b/y.js&rev=deadbeef",
    status: 200,
    totalMs: 3200,
    timings: { ttfbMs: 120, readMs: 80, injectMs: 0, gzipMs: 40 },
    queueWaitMs: 2900,
    queue: { queued: 3, queuedBytes: 2270000 },
    outBytes: 1740800
  });
  assert.match(line, /^\[bridge\] 慢响应: GET \/plugins\/ /, "必须以固定前缀开头、路径去查询串");
  assert.ok(!line.includes("rev="), `日志不得含查询串：${line}`);
  assert.match(line, /总 3200ms/);
  assert.match(line, /上游首包 120ms/);
  assert.match(line, /读体 80ms/);
  assert.match(line, /注入 0ms/);
  assert.match(line, /gzip 40ms/);
  assert.match(line, /入队→发完 2900ms/);
  assert.match(line, /队列 3条\/2270000B/);
  assert.match(line, /下行 1700KB/);
});

test("B0③：slowRespLogOptions 默认值与 env 解析（非法值回默认）", () => {
  assert.deepEqual(slowRespLogOptions({}), { thresholdMs: 2000, windowMs: 3000 });
  assert.deepEqual(slowRespLogOptions({ DSH_BRIDGE_SLOW_RESP_MS: "500", DSH_BRIDGE_SLOW_LOG_MS: "0" }), { thresholdMs: 500, windowMs: 0 });
  assert.deepEqual(slowRespLogOptions({ DSH_BRIDGE_SLOW_RESP_MS: "abc" }), { thresholdMs: 2000, windowMs: 3000 });
  assert.deepEqual(slowRespLogOptions({ DSH_BRIDGE_SLOW_RESP_MS: "-5" }), { thresholdMs: 2000, windowMs: 3000 });
});

test("B0④：timings 不可枚举 —— 不会混进隧道帧（协议字节不变）", () => {
  // 源码契约：必须用 defineProperty(..., enumerable:false)；不允许把 timings 塞进可枚举字段
  const src = fs.readFileSync(BRIDGE_SRC, "utf8");
  assert.match(src, /Object\.defineProperty\(reply, "timings", \{ value: timings, enumerable: false \}\)/);
  // 行为验证：不可枚举属性不会出现在 JSON（= 隧道帧的序列化方式）里
  const reply = { status: 200, headers: {}, body: "AA==", bodyBase64: true };
  Object.defineProperty(reply, "timings", { value: { ttfbMs: 1, readMs: 2, injectMs: 3, gzipMs: 4 }, enumerable: false });
  const wire = JSON.stringify({ id: "r1", type: "http", ...reply });
  assert.ok(!wire.includes("timings"), `隧道帧不得带 timings：${wire}`);
  assert.ok(wire.includes('"body":"AA=="'));
});

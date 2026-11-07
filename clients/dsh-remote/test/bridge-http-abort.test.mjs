#!/usr/bin/env node
/**
 * B2 取消死请求（2026-11-08）。
 *
 * 生产问题：手机放弃（nginx 499 / 切页 / 锁屏）后，普通大响应仍会被 bridge 读完、gzip 完、
 * **继续灌进隧道**，占住数据队列队头把同设备后续请求堵在后面（2026-11-07 事故里 77 次 499
 * 每次都这么放大，最坏让 0 字节请求陪跑 97.6s）。
 *
 * 修复两端配合：
 *   · 中继：`res.on("close")` 时**普通响应也**发 `http-abort`（可 `DSH_ROUTER_ABORT_DEAD=0` 回滚）；
 *   · 桥：`http-abort` → abort 上游 fetch + `sender.drop(id)` 丢掉隧道里还没发的分片。
 *
 * 本文件锁四条：
 *   ① `drop(id)` 之后该响应的剩余分片不再发出，且**其余条目的相对顺序不变**（严格 FIFO 不破）；
 *   ② 被取消的条目不会回调 `onFlushed`（不许拿"取消"当"发完"去记耗时）；
 *   ③ `http-abort` 到桥 → 上游 fetch 被 abort、`drop` 被调用、**不回 502**、inflight 归零；
 *   ④ `DSH_BRIDGE_ABORT_DEAD=0` / 非法值解析（纯函数）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

// ⚠️ 必须在 import dsh-bridge.mjs **之前**把上游指到一个本地假服务：
//    UPSTREAM 是模块加载时读 env 的；测试 ③ 需要一个"永不回完 body"的上游，才能证明
//    `http-abort` 真的中止了 fetch（而不是等 120s 超时）。
const slowUpstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.write('{"partial":'); // 不 end：模拟大响应正在产出的中途
});
await new Promise((r) => slowUpstream.listen(0, "127.0.0.1", r));
process.env.DSH_BRIDGE_UPSTREAM = `http://127.0.0.1:${slowUpstream.address().port}`;
after(() => {
  try { slowUpstream.closeAllConnections?.(); } catch { /* ignore */ }
  try { slowUpstream.close(); } catch { /* ignore */ }
});

const { abortDeadEnabled, makePrioritySender, __httpInflightForTest, handleFrame, handleHttpFrame } =
  await import("../dsh-bridge.mjs");

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

function newSender() {
  const sock = fakeSocket();
  const sched = makeScheduler();
  const sender = makePrioritySender({
    rawSend: sock.rawSend,
    bufferedAmount: sock.bufferedAmount,
    schedule: sched.schedule,
    setTimer: sched.setTimer
  });
  return { sock, sched, sender };
}

test("B2①：drop(id) 丢掉剩余分片；其余条目顺序不变；不回调 onFlushed", () => {
  const { sock, sched, sender } = newSender();
  let flushedBig = 0;

  // 一条 400KB 的大响应（多片）先入队，之后才入队一个小响应
  sender.send({ id: "big", type: "http", body: "A".repeat(400 * 1024) }, {
    id: "big",
    onFlushed: () => { flushedBig += 1; }
  });
  sender.send({ id: "small", type: "http", body: "ok" }, { id: "small" });
  // 让大帧只发出前几片就停手（模拟"隧道很慢"）
  sched.tick();
  const beforeDrop = sock.frames.length;

  sender.drop("big");
  // drop 之后：大帧剩余分片一片都不许再发
  for (let i = 0; i < 5000 && sched.pending() > 0; i += 1) { sock.drain(0); sched.tick(); }
  const after = sock.frames.slice(beforeDrop).map((s) => JSON.parse(s));
  assert.ok(after.every((f) => f.__chunk === undefined), `取消后不得再发大帧分片：${JSON.stringify(after).slice(0, 200)}`);
  const small = after.find((f) => f.id === "small");
  assert.ok(small, "取消大帧后，后面排队的小响应必须被发出（队头被腾空）");
  assert.equal(flushedBig, 0, "被取消的条目不得回调 onFlushed（否则会把取消记成发完）");
});

test("B2②：drop 只删指定 id，其它条目的相对顺序原样保留（FIFO 不破）", () => {
  const { sock, sched, sender } = newSender();
  sender.send({ id: "a", type: "http", body: "A".repeat(300 * 1024) }, { id: "a" });
  sender.send({ id: "b", type: "http", body: "b1" }, { id: "b" });
  sender.send({ id: "c", type: "http", body: "c1" }, { id: "c" });
  sched.tick(); // 大帧发出第 1 片

  sender.drop("a"); // 取消正在传的 a
  for (let i = 0; i < 5000 && sched.pending() > 0; i += 1) { sock.drain(4 * 1024 * 1024); sched.tick(); }

  const ids = sock.frames.map((s) => { const o = JSON.parse(s); return o.__chunk ? "__chunk" : o.id; });
  const firstB = ids.indexOf("b");
  const firstC = ids.indexOf("c");
  assert.ok(firstB >= 0 && firstC >= 0, "b / c 都必须发出");
  assert.ok(firstB < firstC, `b 必须仍在 c 之前（入队顺序不因取消而变）：${ids.join(",")}`);
  // a 的条目被整条删除：不应有 a 的**整帧**
  assert.ok(!ids.includes("a"), "被取消的 a 不得再出现");
});

test("B2③：http-abort 到桥 → abort 上游 fetch + drop(id) + 不回 502（端到端到 fetch）", async () => {
  // 上游由文件顶部的 slowUpstream 提供（永不回完 body），才能验证 abort 真的生效
  const sent = [];
  const drops = [];
  const sendFn = Object.assign(
    (obj) => { sent.push(obj); return true; },
    { drop: (id) => { drops.push(id); return 1; }, stats: () => ({ queued: 0, queuedBytes: 0, controlQueued: 0 }) }
  );

  const p = handleHttpFrame(sendFn, { id: "ab1", type: "http", method: "GET", path: "/api/slow" });
  // 等到 controller 登记（= 已经进入 fetch 之前的那一步）
  const t0 = Date.now();
  while (__httpInflightForTest() < 1 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(__httpInflightForTest(), 1, "在飞请求必须被登记，才能被取消");

  await handleFrame(sendFn, { id: "ab1", type: "http-abort" });
  const t1 = Date.now();
  await p; // 取消后必须快速 resolve，而不是等 120s 超时
  assert.ok(Date.now() - t1 < 2000, "取消后必须立刻结束");
  assert.deepEqual(drops, ["ab1"], "必须丢掉该 id 在隧道里还没发的分片");
  assert.ok(!sent.some((f) => f.type === "http" && f.status === 502), `取消不得回 502 帧：${JSON.stringify(sent)}`);
  assert.equal(__httpInflightForTest(), 0, "取消后 inflight 必须归零（不能泄漏 controller）");
});

test("B2④：abortDeadEnabled 解析（0/false/off 才关；非法值当开）", () => {
  for (const v of ["0", "false", "OFF", "no", "disabled"]) assert.equal(abortDeadEnabled({ DSH_BRIDGE_ABORT_DEAD: v }), false, v);
  for (const v of ["1", "true", "on", "yes", "anything"]) assert.equal(abortDeadEnabled({ DSH_BRIDGE_ABORT_DEAD: v }), true, v);
});

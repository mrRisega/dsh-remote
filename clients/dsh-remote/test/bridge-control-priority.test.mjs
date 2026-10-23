#!/usr/bin/env node
/**
 * 隧道发送侧「控制帧快速通道」回归（2026-10-23）。
 *
 * 生产事故（手机连不上/断线主因链 #1）：
 *   手机首屏的 /plugins/?? 聚合包最大 16.33MB。旧发送器把它切成 200KB 分块后在**同一个
 *   tick 里连续 ws.send**：内核发送缓冲一满，剩余分块全堆进 ws 的内存队列（弱网下十几秒
 *   的量）。这期间 router 发来的 ws-open，bridge 只需几毫秒就能回，但**回包被排在 16MB
 *   分块后面** → router 20s 超时（ws_open_timeout），页面一直转圈。
 *
 * 本文件用假 socket + 可控调度器锁三条契约：
 *   ① 大帧传输中插入的 ws-open 回包，在**下一轮**就被发出（不会排到整帧传完之后）；
 *   ② 发送缓冲高水位以上时停手，控制帧前面最多只有「高水位 + 一片」待发字节；
 *   ③ 分块信封仍能被接收侧 makeFrameReceiver 完整还原（协议未被改坏）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_FRAME_TYPES,
  TUNNEL_BULK_HWM_DEFAULT,
  isControlFrame,
  makeFrameReceiver,
  makePrioritySender,
  tunnelBulkOptionsFromEnv
} from "../dsh-bridge.mjs";

/** 假 socket：记录每一帧，可选"慢速排空"模型（bufferedAmount 缓慢下降）。 */
function fakeSocket({ drainPerTick = Infinity } = {}) {
  const frames = [];
  let pending = 0;
  return {
    frames,
    rawSend(s) {
      frames.push(s);
      pending += s.length;
    },
    bufferedAmount: () => pending,
    /** 模拟一次内核把缓冲排掉一些。 */
    drain(bytes = drainPerTick) {
      pending = Math.max(0, pending - bytes);
      return pending;
    },
    get pending() { return pending; }
  };
}

function makeScheduler() {
  const queue = [];
  return {
    schedule: (fn) => { queue.push({ fn, kind: "immediate" }); },
    setTimer: (fn) => { queue.push({ fn, kind: "timer" }); },
    /** 跑一个排队的回调（模拟一个事件循环轮次）。 */
    tick() {
      const job = queue.shift();
      if (!job) return false;
      job.fn();
      return true;
    },
    runAll(limit = 5000) {
      let n = 0;
      while (n < limit && this.tick()) n += 1;
      return n;
    },
    pending: () => queue.length
  };
}

/** 从已发帧里还原出每个分块信封所属的逻辑帧（用真实接收侧实现，顺便守住协议）。 */
function reassemble(frames) {
  const out = [];
  const recv = makeFrameReceiver();
  for (const raw of frames) recv(raw, (frame) => out.push(frame));
  return out;
}

test("契约①：大响应传输中插入的 ws-open 回包在下一轮就发出（不排到整帧之后）", () => {
  const sock = fakeSocket();
  const sched = makeScheduler();
  const sender = makePrioritySender({
    rawSend: sock.rawSend,
    bufferedAmount: sock.bufferedAmount,
    bulkHighWater: TUNNEL_BULK_HWM_DEFAULT,
    chunkSize: 64 * 1024,
    schedule: sched.schedule,
    setTimer: sched.setTimer
  });

  /** 快速链路：每轮把内核缓冲排空（同时证明"高水位以上才停手"不影响正常链路）。 */
  const tickDrain = () => { sock.drain(2 * 1024 * 1024); return sched.tick(); };

  // 一条 4MB 的大响应（≈64 个分块）
  const big = { id: "big", type: "http", status: 200, body: "A".repeat(4 * 1024 * 1024), bodyBase64: true };
  assert.equal(sender.send(big), true);
  assert.equal(sock.frames.length, 1, "第一片当场发出");
  const chunksTotal = Math.ceil(JSON.stringify(big).length / (64 * 1024));
  assert.ok(chunksTotal >= 60, `应被切成很多片（实际 ${chunksTotal}）`);

  // 让事件循环转几轮（还没传完）
  for (let i = 0; i < 5; i += 1) assert.equal(tickDrain(), true);
  const sentBefore = sock.frames.length;
  assert.ok(sentBefore >= 4 && sentBefore < chunksTotal, `此时应只发了一小部分（${sentBefore}/${chunksTotal}）`);

  // router 的 ws-open 到达 → bridge 处理 → 回包入控制车道
  sender.send({ id: "w1", type: "ws-open", ok: true, fast: true });
  const sentAfterControl = sock.frames.length;
  const pos = sock.frames.findIndex((s) => s.includes('"id":"w1"') && s.includes('"ok":true'));
  assert.ok(pos >= 0, "控制帧必须已经发出");
  assert.equal(pos, sentAfterControl - 1, "控制帧应当**立刻**发出（不等当前轮次的剩余分块）");
  assert.ok(pos < sentBefore + 3, `控制帧位置 ${pos} 必须远早于大帧剩余分块（已发 ${sentBefore}）`);

  // 继续跑完
  for (let i = 0; i < 5000 && sched.pending() > 0; i += 1) tickDrain();
  assert.equal(sock.frames.length, chunksTotal + 1);
  const frames = reassemble(sock.frames);
  assert.equal(frames.length, 2, "大帧 + ws-open 两帧都应能被接收侧还原");
  const bigFrame = frames.find((f) => f.id === "big");
  const ctrlFrame = frames.find((f) => f.id === "w1");
  assert.ok(bigFrame && ctrlFrame, "两条逻辑帧都要还原出来");
  assert.equal(ctrlFrame.ok, true);
  assert.equal(bigFrame.body.length, big.body.length, "分块重组后正文逐字节一致");
});

test("契约②：发送缓冲高水位以上时停手（控制帧不会被埋进几十秒的队列）", () => {
  // 慢链路：每发一片，缓冲就积压 100KB（> 64KB 高水位）
  const sock = fakeSocket();
  const sched = makeScheduler();
  const sender = makePrioritySender({
    rawSend: sock.rawSend,
    bufferedAmount: sock.bufferedAmount,
    bulkHighWater: 64 * 1024,
    chunkSize: 64 * 1024,
    schedule: sched.schedule,
    setTimer: sched.setTimer
  });

  const big = { id: "big2", type: "http", body: "B".repeat(1024 * 1024) };
  sender.send(big);
  // 第一片发出后 bufferedAmount = 片长(>64KB) → 下一轮必须停手等排空
  sched.tick();
  const afterFirst = sock.frames.length;
  sched.tick();
  assert.equal(sock.frames.length, afterFirst, "超过高水位时不得继续灌分块（只能等排空）");
  assert.ok(sender.stats().waits >= 1, "应记录过背压等待");

  // 此时控制帧到达：它仍然必须立刻出去（控制车道不受批量车道背压影响）
  sock.drain(10 * 1024 * 1024); // 缓冲排空
  const beforeControl = sock.frames.length;
  sender.send({ id: "w2", type: "ws-open", ok: false, code: 1008, reason: "test" });
  const pos = sock.frames.findIndex((s) => s.includes('"id":"w2"'));
  assert.equal(pos, beforeControl, "排空后第一时间发控制帧（之前的背压不能把它排到分块后面）");
});

test("契约③：大帧传输中小帧优先（交互不被整帧传输拖住）；close() 丢弃未发内容", () => {
  const sock = fakeSocket();
  const sched = makeScheduler();
  const sender = makePrioritySender({
    rawSend: sock.rawSend,
    bufferedAmount: sock.bufferedAmount,
    schedule: sched.schedule,
    setTimer: sched.setTimer
  });
  // 大帧刚发出第一片（之后每轮只发一片）
  sender.send({ id: "big3", type: "http", body: "C".repeat(512 * 1024) });
  // 传输中插入两条小帧（交互消息 / SSE 块）：必须插在大帧的下一片之前，而不是排在整帧之后
  sender.send({ id: "i1", type: "ws-msg", data: "hello" });
  sender.send({ id: "i2", type: "http-chunk", body: "chunk" });
  const ids = sock.frames.map((s) => {
    const o = JSON.parse(s);
    return o.__chunk ? "__chunk" : o.id;
  });
  assert.deepEqual(ids.slice(0, 3), ["__chunk", "i1", "i2"], "小帧必须插在大帧的下一片之前");
  assert.equal(sender.stats().bigChunks, 1, "此时大帧只发了 1 片");

  // close 后：未发内容丢弃，后续 send 返回 false（重连后不能把旧分片发到新连接上）
  const sock2 = fakeSocket();
  const sched2 = makeScheduler();
  const sender2 = makePrioritySender({
    rawSend: sock2.rawSend,
    bufferedAmount: sock2.bufferedAmount,
    schedule: sched2.schedule,
    setTimer: sched2.setTimer
  });
  sender2.send({ id: "big4", type: "http", body: "D".repeat(512 * 1024) });
  const before = sock2.frames.length;
  sender2.close();
  assert.equal(sender2.send({ id: "after", type: "ws-msg", data: "x" }), false, "close 后不再受理");
  sched2.runAll();
  assert.equal(sock2.frames.length, before, "close 后不得再发剩余分片");
});

test("控制帧类型/环境变量解析（纯函数）", () => {
  for (const t of ["ws-open", "ws-close", "http-abort", "http-end"]) {
    assert.equal(isControlFrame({ id: 1, type: t }), true, `${t} 必须走控制车道`);
  }
  for (const t of ["http", "ws-msg", "http-chunk"]) {
    assert.equal(isControlFrame({ id: 1, type: t }), false, `${t} 不该抢控制车道`);
  }
  assert.equal(isControlFrame(null), false);
  assert.deepEqual(CONTROL_FRAME_TYPES.slice(0, 2), ["ws-open", "ws-close"]);

  assert.equal(tunnelBulkOptionsFromEnv({}).bulkHighWater, TUNNEL_BULK_HWM_DEFAULT);
  assert.equal(tunnelBulkOptionsFromEnv({ DSH_BRIDGE_TUNNEL_BULK_HWM_KB: "32" }).bulkHighWater, 32 * 1024);
  assert.equal(tunnelBulkOptionsFromEnv({ DSH_BRIDGE_TUNNEL_CHUNK_KB: "16" }).chunkSize, 16 * 1024);
  assert.equal(tunnelBulkOptionsFromEnv({ DSH_BRIDGE_TUNNEL_CHUNK_KB: "abc" }).chunkSize, 64 * 1024, "非法值回默认");
});

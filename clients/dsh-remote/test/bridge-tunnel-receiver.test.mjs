#!/usr/bin/env node
/**
 * 隧道入站分片重组（P0-1，2026-11-08）。
 *
 * 生产缺陷：`connectTunnel` 的 `ws.on("message")` 处理器里**每条消息**都新建一个
 * `makeFrameReceiver()`。而 `__chunk` 的 n 片是 n 条独立 WS 消息 ⇒ 攒片状态（bufs）
 * 随消息一起丢 ⇒ 跨消息分片永远拼不齐，中继发来的大帧（大请求体等）在桥侧被静默丢弃。
 * 中继侧一直是**连接级**单实例（index.mjs 在 connection 回调里建一次）。
 *
 * 本文件锁三条：
 *   ① 一个连接级 dispatcher 喂多条消息 → 能还原一条完整帧（跨消息重组）；
 *   ② 多条分块序列交错到达 → 各自独立还原（状态是 Map，不是单槽）；
 *   ③ 源码契约：`connectTunnel` 里只允许建一次接收器（且不得再出现 makeFrameReceiver()）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTunnelFrameDispatcher, makeFrameReceiver } from "../dsh-bridge.mjs";

const BRIDGE_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dsh-bridge.mjs");

/** 把一条大帧按 chunkSize 切成 `__chunk` 消息（与 makePrioritySender.enqueueData 同款信封）。 */
function splitFrame(obj, chunkSize, chunkId = "cx") {
  const text = JSON.stringify(obj);
  if (text.length <= chunkSize) return [text];
  const n = Math.ceil(text.length / chunkSize);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(JSON.stringify({ __chunk: { id: chunkId, n, i, data: text.slice(i * chunkSize, (i + 1) * chunkSize) } }));
  }
  return out;
}

test("P0-1①：跨 WS 消息的分片，用**同一个**连接级 dispatcher 能完整重组", () => {
  const got = [];
  const dispatch = createTunnelFrameDispatcher((f) => got.push(f));

  const big = { id: "r1", type: "http", method: "POST", path: "/api/upload", body: "A".repeat(5000), bodyBase64: true };
  const parts = splitFrame(big, 1000);
  assert.ok(parts.length >= 5, `应切成多片（实际 ${parts.length}）`);

  // 一条消息一片地喂（生产就是这种情况：每片是一次独立 ws.send）
  for (const p of parts) {
    assert.equal(got.length, 0, "喂齐之前不应回调");
    dispatch(p);
  }
  assert.equal(got.length, 1, "跨消息必须能还原成一帧");
  assert.equal(got[0].id, "r1");
  assert.equal(got[0].path, "/api/upload");
  assert.equal(got[0].body.length, big.body.length, "重组后正文逐字节一致");
  assert.equal(got[0].body, big.body);
});

test("P0-1②：两条分块序列交错到达，各自独立还原（状态是 Map 而非单槽）", () => {
  const got = [];
  const dispatch = createTunnelFrameDispatcher((f) => got.push(f));

  const a = { id: "a", type: "http", body: "a".repeat(2500) };
  const b = { id: "b", type: "http", body: "b".repeat(2500) };
  const pa = splitFrame(a, 700, "ca");
  const pb = splitFrame(b, 700, "cb");

  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i += 1) {
    if (pa[i]) dispatch(pa[i]);
    if (pb[i]) dispatch(pb[i]);
  }
  assert.equal(got.length, 2, "两条序列都应还原");
  const fa = got.find((f) => f.id === "a");
  const fb = got.find((f) => f.id === "b");
  assert.equal(fa.body, a.body);
  assert.equal(fb.body, b.body);
});

test("P0-1③：未分片的普通帧直通（行为不变）", () => {
  const got = [];
  const dispatch = createTunnelFrameDispatcher((f) => got.push(f));
  dispatch(JSON.stringify({ id: "w1", type: "ws-open", ok: true }));
  assert.deepEqual(got, [{ id: "w1", type: "ws-open", ok: true }]);
});

test("P0-1④：非 JSON / 损坏分块不得抛（连接不能因为坏帧整个断掉）", () => {
  const got = [];
  const dispatch = createTunnelFrameDispatcher((f) => got.push(f));
  dispatch("not-json{");
  dispatch(JSON.stringify({ __chunk: { id: "bad", n: 2, i: 0, data: "{" } }));
  assert.equal(got.length, 0);
  dispatch(JSON.stringify({ id: "ok", type: "http-chunk" }));
  assert.equal(got.length, 1, "坏帧之后仍要继续工作");
});

/** 从 `function foo(` 起始位置取出到匹配右花括号为止的函数体（朴素花括号计数，避开字符串里的括号够用）。 */
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > 0, `必须能找到 ${signature}`);
  const open = src.indexOf("{", start);
  assert.ok(open > start, `${signature} 必须有大括号`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${signature} 花括号不闭合`);
}

test("P0-1⑤：源码契约 —— connectTunnel 里接收器只能建一次，且不得在 message 回调里 new", () => {
  const src = fs.readFileSync(BRIDGE_SRC, "utf8");
  const body = extractFunction(src, "function connectTunnel(token)");
  // 只看代码：注释里会引用这个函数名（解释历史缺陷），不能算违规
  const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.match(code, /createTunnelFrameDispatcher\(/, "必须用连接级 dispatcher");
  assert.doesNotMatch(
    code,
    /makeFrameReceiver\s*\(/,
    "connectTunnel 内不得直接 new makeFrameReceiver()（每条消息新建会让跨消息 __chunk 永远拼不齐 —— 2026-11-08 P0-1）"
  );
  // 且 dispatcher 只建一次（在 ws.on("message") 之前）
  const messageHandler = body.indexOf('ws.on("message"');
  assert.ok(messageHandler > 0, '必须找到 ws.on("message")');
  assert.ok(
    body.lastIndexOf("createTunnelFrameDispatcher(", messageHandler) > 0,
    'dispatcher 必须在 ws.on("message") 之前创建（连接级单实例）'
  );
  // makeFrameReceiver 本身不能改变协议：仍是 (raw,onFrame) 形状，供 dispatcher/测试共用
  const recv = makeFrameReceiver();
  assert.equal(typeof recv, "function");
});

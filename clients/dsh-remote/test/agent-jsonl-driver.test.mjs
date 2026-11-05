#!/usr/bin/env node
/**
 * 通用 jsonl 驱动契约测试（M2 第 4 周）—— 证明"驱动不认识任何一家 CLI"。
 *
 * 用一个**玩具 mapLine**（不是 Claude、不是 Codex）来验证驱动的全部通用能力：
 *   分帧（空行/超长）→ 坏 JSON → mapLine → 信封（v/seq）→ sink/onEvent/onUnknown。
 *
 * 这条用例是"接第二家只换 mapLine"这个架构承诺的**可执行证据**：
 * 驱动里没有任何 harness 专有分支，换 mapper 就能跑另一家。
 *
 * 用法: node --test clients/dsh-remote/test/agent-jsonl-driver.test.mjs
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createJsonlDriver, createJsonlSink, frameLine, parseLineJson } from "../agent/events.mjs";

const NOW = 1_700_000_000_000;

/** 玩具 mapper：只有 ping/end/boom 三种行为，与任何真实 CLI 无关。 */
const toyMap = (obj, ctx) => {
  if (obj.type === "ping") {
    return { ok: true, events: [{ v: 1, type: "status", at: ctx.now(), status: "working" }] };
  }
  if (obj.type === "end") {
    return { ok: true, events: [{ v: 1, type: "turn.end", at: ctx.now(), reason: obj.reason || "completed" }] };
  }
  if (obj.type === "boom") throw new Error("mapper exploded");
  return { ok: false, reason: `unknown-type:${obj.type}` };
};

test("驱动可以完全脱离 Claude/Codex 使用（玩具 mapper 就能跑）", () => {
  const d = createJsonlDriver({ mapLine: toyMap, now: () => NOW, driverName: "toy" });
  const out = d.writeLine('{"type":"ping"}');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "status");
  assert.equal(out[0].at, NOW);
  assert.equal(out[0].v, 1);
  assert.equal(out[0].seq, 1);
  assert.equal(d.stats().driverName, "toy");
});

test("seq 跨行、跨事件连续自增", () => {
  const d = createJsonlDriver({ mapLine: toyMap, now: () => NOW });
  d.writeLine('{"type":"ping"}');
  d.writeLine('{"type":"end"}');
  d.writeLine('{"type":"ping"}');
  const events = [];
  const d2 = createJsonlDriver({ mapLine: toyMap, now: () => NOW, onEvent: (e) => events.push(e) });
  d2.writeLine('{"type":"ping"}');
  d2.writeLine('{"type":"end"}');
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
});

test("分帧：空行计 empty、超长行计 tooLong、坏 JSON 计 badJson —— 都不抛错", () => {
  const d = createJsonlDriver({ mapLine: toyMap, now: () => NOW, maxLineBytes: 50 });
  assert.deepEqual(d.writeLine("   "), []);
  assert.deepEqual(d.writeLine(JSON.stringify({ type: "ping", pad: "x".repeat(100) })), []);
  assert.deepEqual(d.writeLine("{not json"), []);
  const s = d.stats();
  assert.equal(s.empty, 1);
  assert.equal(s.tooLong, 1);
  assert.equal(s.badJson, 1);
  assert.equal(s.events, 0);
});

test("未知形状：计数 + onUnknown 回调（拿得到原因与原始行）", () => {
  const seen = [];
  const d = createJsonlDriver({
    mapLine: toyMap,
    now: () => NOW,
    onUnknown: (reason, raw) => seen.push({ reason, raw })
  });
  d.writeLine('{"type":"mystery","x":1}');
  const s = d.stats();
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.unknownReasons, { "unknown-type:mystery": 1 });
  assert.equal(seen.length, 1);
  assert.match(seen[0].reason, /unknown-type/);
  assert.match(seen[0].raw, /mystery/);
});

test("mapLine 自己抛错 → 兜住，记 mapperErrors，不向上抛", () => {
  let called = 0;
  const d = createJsonlDriver({
    mapLine: toyMap,
    now: () => NOW,
    onUnknown: () => {
      called += 1;
    }
  });
  assert.doesNotThrow(() => d.writeLine('{"type":"boom"}'));
  const s = d.stats();
  assert.equal(s.mapperErrors, 1);
  assert.equal(s.unknown, 1);
  assert.match(Object.keys(s.unknownReasons)[0], /mapper-error/);
  assert.equal(called, 1);
});

test("onUnknown / onEvent 抛错也不影响后续采集", () => {
  const d = createJsonlDriver({
    mapLine: toyMap,
    now: () => NOW,
    onUnknown: () => {
      throw new Error("回调炸了");
    },
    onEvent: () => {
      throw new Error("回调炸了");
    }
  });
  assert.doesNotThrow(() => d.writeLine('{"type":"nope"}'));
  assert.doesNotThrow(() => d.writeLine('{"type":"ping"}'));
  assert.equal(d.stats().events, 1);
});

test("sink 串联：事件按序落盘；sink 未启用时静默跳过", () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "jsonl-driver-"));
  try {
    const off = createJsonlSink({});
    const d0 = createJsonlDriver({ mapLine: toyMap, sink: off, now: () => NOW });
    assert.doesNotThrow(() => d0.writeLine('{"type":"ping"}'));
    assert.equal(off.stats().events, 0);

    const file = path.join(dir, "e.jsonl");
    const sink = createJsonlSink({ filePath: file });
    const d = createJsonlDriver({ mapLine: toyMap, sink, now: () => NOW });
    d.writeLine('{"type":"ping"}');
    d.writeLine('{"type":"end"}');
    const lines = fsSync.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((x) => x.type), ["status", "turn.end"]);
    assert.deepEqual(lines.map((x) => x.seq), [1, 2]);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("落盘失败静默：驱动照常返回事件（磁盘满不能影响会话）", () => {
  const sink = createJsonlSink({
    filePath: "/nope/x.jsonl",
    fs: {
      appendFileSync: () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
    }
  });
  const d = createJsonlDriver({ mapLine: toyMap, sink, now: () => NOW });
  const out = d.writeLine('{"type":"ping"}');
  assert.equal(out.length, 1, "事件仍需产出");
  assert.equal(sink.stats().writeErrors, 1);
});

test("缺少 mapLine 在创建时立即报错（配置错误不要拖到运行期）", () => {
  assert.throws(() => createJsonlDriver({}), /缺少 mapLine/);
});

test("frameLine / parseLineJson：纯函数契约", () => {
  assert.deepEqual(frameLine("  "), { ok: false, reason: "empty" });
  assert.equal(frameLine("{}", { maxLineBytes: 1 }).reason, "too-long");
  assert.equal(parseLineJson("{bad").reason, "bad-json");
  assert.equal(parseLineJson("42").reason, "not-object");
  assert.equal(parseLineJson('{"a":1}').obj.a, 1);
});

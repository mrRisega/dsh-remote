#!/usr/bin/env node
/**
 * 事件映射最小集契约测试（M2 第 3 周 B 项）。
 *
 * 守四件事（每条都对应一个真实风险）：
 *   ① **每类真实 stream-json 行都能映射**（夹具直接抄自第 1 周实测输出形态）；
 *   ② **未知形状不许崩**：未知 type/subtype、坏 JSON、超长行 → 计数丢弃，不抛错；
 *   ③ **不记录命令原文**：tool.call 只带输入字节数；tool.result 只带截断预览；
 *   ④ **落盘失败静默**：sink 写盘抛错只计数 + 告警一次，绝不把异常抛回会话。
 *
 * 用法: node --test clients/dsh-remote/test/agent-events.test.mjs
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_MAX_LINE_BYTES,
  EVENT_TYPES,
  createEventMapper,
  createJsonlSink,
  mapStreamJsonLine,
  turnReasonOf
} from "../agent/events.mjs";

const NOW = 1_700_000_000_000;
const at = () => NOW;

const line = (obj) => JSON.stringify(obj);

/** 真实 claude 2.1.318 的 `system/init` 行（裁剪后，保留关键字段）。 */
const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/tmp/proj",
  session_id: "sess-1",
  tools: ["Bash", "Read", "Write"],
  mcp_servers: [],
  model: "some-model",
  permissionMode: "default"
};

test("status：system/init → status(working) + 会话/权限模式/工具数（不带 model）", () => {
  const r = mapStreamJsonLine(line(INIT), { now: at });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.type, EVENT_TYPES.STATUS);
  assert.equal(ev.status, "working");
  assert.equal(ev.sessionId, "sess-1");
  assert.equal(ev.permissionMode, "default");
  assert.equal(ev.toolCount, 3);
  assert.equal(ev.model, undefined, "不落 model（可能暴露网关配置，也不给日志增噪）");
  assert.equal(ev.at, NOW);
  assert.equal(ev.v, 1);
});

test("status：钩子生命周期（hook_started / hook_response）→ status(hook)，不带 output 内容", () => {
  const a = mapStreamJsonLine(line({
    type: "system", subtype: "hook_started", hook_event: "PermissionRequest", hook_id: "h1", session_id: "s"
  }), { now: at });
  assert.equal(a.events[0].status, "hook");
  assert.equal(a.events[0].hookPhase, "started");
  assert.equal(a.events[0].hookEvent, "PermissionRequest");

  const b = mapStreamJsonLine(line({
    type: "system", subtype: "hook_response", hook_event: "PermissionRequest",
    output: "{\"hookSpecificOutput\":{\"decision\":\"allow\"}}", session_id: "s"
  }), { now: at });
  assert.equal(b.events[0].hookPhase, "finished");
  assert.equal(JSON.stringify(b.events[0]).includes("hookSpecificOutput"), false, "钩子原样输出不进事件");
});

test("status：api_retry → status(retrying)；thinking_tokens 直接忽略（不算 unknown）", () => {
  const retry = mapStreamJsonLine(line({ type: "system", subtype: "api_retry", attempt: 2, retry_delay_ms: 500 }), { now: at });
  assert.equal(retry.events[0].status, "retrying");
  assert.equal(retry.events[0].attempt, 2);

  const think = mapStreamJsonLine(line({ type: "system", subtype: "thinking_tokens", tokens: 10 }), { now: at });
  assert.deepEqual(think, { ok: true, events: [] }, "thinking_tokens 一条会话几十条，落盘没价值");
});

test("status：未知 system subtype → ok:false（上层计数丢弃，不崩）", () => {
  const r = mapStreamJsonLine(line({ type: "system", subtype: "brand_new_thing" }), { now: at });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown-system-subtype/);
});

test("status：permission_denied（实测 2.1.318 的拒绝回执）→ status(denied) + 理由，不带命令原文", () => {
  // 夹具抄自真实输出（只裁剪了 uuid/时间相关字段）
  const raw = {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "call_00_x",
    decision_reason_type: "hook",
    decision_reason: "已按拒绝处理",
    message: "已按拒绝处理",
    session_id: "sess-1"
  };
  const r = mapStreamJsonLine(line(raw), { now: at });
  assert.equal(r.ok, true, "这是实测存在的真实事件，不能算 unknown");
  const ev = r.events[0];
  assert.equal(ev.type, EVENT_TYPES.STATUS);
  assert.equal(ev.status, "denied");
  assert.equal(ev.toolName, "Bash");
  assert.equal(ev.toolCallId, "call_00_x");
  assert.equal(ev.reasonType, "hook");
  assert.match(ev.reason, /拒绝/);
  assert.equal(JSON.stringify(ev).includes("rm -rf"), false);
});

test("message.delta：assistant 完整文本 → final:true", () => {
  const r = mapStreamJsonLine(line({
    type: "assistant",
    message: { content: [{ type: "text", text: "命令的原始输出：ok" }] }
  }), { now: at });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, EVENT_TYPES.MESSAGE_DELTA);
  assert.equal(r.events[0].text, "命令的原始输出：ok");
  assert.equal(r.events[0].final, true);
});

test("message.delta：stream_event 的 text_delta → final:false（流式增量）", () => {
  const r = mapStreamJsonLine(line({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "命" } }
  }), { now: at });
  assert.equal(r.events[0].type, EVENT_TYPES.MESSAGE_DELTA);
  assert.equal(r.events[0].final, false);
  assert.equal(r.events[0].text, "命");

  const other = mapStreamJsonLine(line({ type: "stream_event", event: { type: "message_start" } }), { now: at });
  assert.equal(other.ok, false);
});

test("tool.call：只带 id/name/kind/输入字节数 —— **绝不带命令原文**", () => {
  const command = "curl -H 'Authorization: Bearer sk-secret' http://example.com";
  const r = mapStreamJsonLine(line({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "我来执行" },
        { type: "tool_use", id: "call_1", name: "Bash", input: { command, description: "fetch" } }
      ]
    }
  }), { now: at });
  assert.equal(r.events.length, 2);
  const call = r.events[1];
  assert.equal(call.type, EVENT_TYPES.TOOL_CALL);
  assert.equal(call.toolCallId, "call_1");
  assert.equal(call.name, "Bash");
  assert.equal(call.kind, "execute");
  assert.ok(call.inputBytes > 0);
  const dump = JSON.stringify(call);
  assert.equal(dump.includes("sk-secret"), false, "命令原文绝不能进事件");
  assert.equal(dump.includes("curl"), false, "命令原文绝不能进事件");
});

test("tool.call：文件类工具 → kind=edit/read/search", () => {
  const mk = (name) =>
    mapStreamJsonLine(line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "c", name, input: { file_path: "/tmp/a.txt" } }] }
    }), { now: at }).events[0];
  assert.equal(mk("Write").kind, "edit");
  assert.equal(mk("Read").kind, "read");
  assert.equal(mk("Grep").kind, "search");
  assert.equal(mk("SomeNewTool").kind, "other", "未知工具落 other，不猜");
});

test("tool.result：string / 数组 content 都能取文本；is_error 透传；预览截断", () => {
  const str = mapStreamJsonLine(line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call_1", is_error: false, content: "hello" }] }
  }), { now: at });
  assert.equal(str.events[0].type, EVENT_TYPES.TOOL_RESULT);
  assert.equal(str.events[0].toolCallId, "call_1");
  assert.equal(str.events[0].isError, false);
  assert.equal(str.events[0].outputBytes, 5);
  assert.equal(str.events[0].outputPreview, "hello");

  const arr = mapStreamJsonLine(line({
    type: "user",
    message: {
      content: [{
        type: "tool_result", tool_use_id: "call_2", is_error: true,
        content: [{ type: "text", text: "hook-denied: 验证用拒绝" }]
      }]
    }
  }), { now: at });
  assert.equal(arr.events[0].isError, true);
  assert.match(arr.events[0].outputPreview, /hook-denied/);

  const long = mapStreamJsonLine(line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c", content: "x".repeat(5000) }] }
  }), { now: at, maxPreviewChars: 100 });
  assert.equal(long.events[0].outputBytes, 5000);
  assert.equal(long.events[0].outputPreview.length, 100, "预览必须截断");

  const off = mapStreamJsonLine(line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c", content: "secret-output" }] }
  }), { now: at, maxPreviewChars: 0 });
  assert.equal(off.events[0].outputPreview, "", "maxPreviewChars=0 时完全不带输出内容");
});

test("turn.end：success → completed；is_error → error；max_turns / interrupted / aborted", () => {
  assert.equal(turnReasonOf({ subtype: "success", is_error: false }), "completed");
  assert.equal(turnReasonOf({ subtype: "success", terminal_reason: "aborted" }), "aborted");
  assert.equal(turnReasonOf({ subtype: "success", terminal_reason: "interrupted" }), "interrupted");
  assert.equal(turnReasonOf({ subtype: "error_during_execution", is_error: true }), "error");
  assert.equal(turnReasonOf({ subtype: "error_max_turns", is_error: true }), "error");
  assert.equal(turnReasonOf({ subtype: "x", is_error: false }), "x");

  const r = mapStreamJsonLine(line({
    type: "result", subtype: "success", is_error: false,
    duration_ms: 1234, num_turns: 2, session_id: "sess-1", result: "完成"
  }), { now: at });
  const ev = r.events[0];
  assert.equal(ev.type, EVENT_TYPES.TURN_END);
  assert.equal(ev.reason, "completed");
  assert.equal(ev.durationMs, 1234);
  assert.equal(ev.numTurns, 2);
  assert.equal(ev.sessionId, "sess-1");
  assert.equal(JSON.stringify(ev).includes("完成"), false, "最终文本靠 message.delta，不重复塞进 turn.end");
});

test("坏输入：未知 type / 坏 JSON / 空行 / 超长行 —— 全部返回 ok:false 或空，不抛错", () => {
  assert.equal(mapStreamJsonLine(line({ type: "brand_new" }), { now: at }).reason, "unknown-type:brand_new");
  assert.equal(mapStreamJsonLine("{not json", { now: at }).reason, "bad-json");
  assert.equal(mapStreamJsonLine("   ", { now: at }).reason, "empty");
  assert.equal(mapStreamJsonLine("42", { now: at }).reason, "not-object");

  const huge = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1000) }] } });
  const r = mapStreamJsonLine(huge, { now: at, maxLineBytes: 100 });
  assert.equal(r.reason, "too-long");
  assert.ok(DEFAULT_MAX_LINE_BYTES > 100);
});

test("mapper：seq 自增 + byType/byReason 统计 + onEvent 回调", () => {
  const seen = [];
  const m = createEventMapper({ now: at, onEvent: (e) => seen.push(e) });
  m.writeLine(line(INIT));
  m.writeLine(line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
  m.writeLine(line({ type: "result", subtype: "success", is_error: false }));
  m.writeLine("{bad");
  m.writeLine(line({ type: "nope" }));

  const s = m.stats();
  assert.equal(s.lines, 5);
  assert.equal(s.events, 3);
  assert.equal(s.badJson, 1);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.unknownReasons, { "unknown-type:nope": 1 }, "未识别原因要能排障");
  assert.equal(s.byType[EVENT_TYPES.STATUS], 1);
  assert.equal(s.byType[EVENT_TYPES.MESSAGE_DELTA], 1);
  assert.equal(s.byType[EVENT_TYPES.TURN_END], 1);
  assert.equal(s.byReason.completed, 1);
  assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3], "seq 连续自增");
});

test("mapper：坏行不中断后续行（一行意外输出不能把整条会话采集带死）", () => {
  const m = createEventMapper({ now: at });
  m.writeLine("not json at all");
  m.writeLine(line({ type: "result", subtype: "success", is_error: false }));
  assert.equal(m.stats().events, 1);
  assert.equal(m.stats().badJson, 1);
});

test("sink：不给 filePath → 默认不启用，什么都不写", () => {
  const sink = createJsonlSink({});
  assert.equal(sink.enabled, false);
  assert.equal(sink.write({ type: "status" }), false);
  assert.equal(sink.stats().events, 0);
});

test("sink：真写 jsonl（append-only，一行一事件，可回读）", () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-events-"));
  const file = path.join(dir, "events.jsonl");
  try {
    const sink = createJsonlSink({ filePath: file, now: at });
    assert.equal(sink.enabled, true);
    assert.equal(sink.write({ v: 1, seq: 1, type: "status" }), true);
    assert.equal(sink.write({ v: 1, seq: 2, type: "turn.end" }), true);
    const lines = fsSync.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { v: 1, seq: 1, type: "status" });
    assert.equal(sink.stats().events, 2);
    assert.ok(sink.stats().bytes > 0);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("sink：落盘失败**静默**（计数 + 只告警一次，绝不抛回会话）", () => {
  const logs = [];
  let writes = 0;
  const sink = createJsonlSink({
    filePath: "/definitely/not/writable/events.jsonl",
    now: at,
    log: (e) => logs.push(e),
    fs: {
      appendFileSync: () => {
        writes += 1;
        throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      }
    }
  });
  assert.doesNotThrow(() => sink.write({ type: "status" }));
  assert.doesNotThrow(() => sink.write({ type: "status" }));
  assert.equal(writes, 2);
  const s = sink.stats();
  assert.equal(s.writeErrors, 2);
  assert.equal(s.lastError, "ENOSPC");
  assert.equal(logs.length, 1, "只告警一次，不刷屏");
  assert.equal(logs[0].event, "events.sink-error");
});

test("mapper + sink 串联：写入文件的事件与返回值一致", () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-events2-"));
  const file = path.join(dir, "e.jsonl");
  try {
    const sink = createJsonlSink({ filePath: file, now: at });
    const m = createEventMapper({ sink, now: at });
    const out = m.writeLine(line({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "rm -rf x" } }] }
    }));
    assert.equal(out.length, 1);
    const written = JSON.parse(fsSync.readFileSync(file, "utf8").trim());
    assert.equal(written.toolCallId, "c1");
    assert.equal(JSON.stringify(written).includes("rm -rf"), false);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

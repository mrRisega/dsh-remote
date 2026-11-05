#!/usr/bin/env node
/**
 * OpenCode（HTTP/SSE）适配契约测试（M2 第 5 周）。
 *
 * ## 夹具来源（官方，逐字对照）
 *
 * | 夹具 | 出处 |
 * |---|---|
 * | `Event` 联合、`message.part.updated`、`permission.updated`、`session.status/idle/error`、`Part`/`ToolState`/`Permission` 字段 | npm 包 `@opencode-ai/sdk@1.19.5` 的 `dist/gen/types.gen.d.ts`（官方发布产物） |
 * | `GET /event` 是 SSE、`POST /session/:id/permissions/:permissionID`、`prompt_async` | <https://opencode.ai/docs/server/> |
 *
 * > 本机**未安装** OpenCode ⇒ 末尾真实探测用例会 SKIP；映射是按官方类型定义写的，**没有真实流校准**。
 *
 * 用法: node --test clients/dsh-remote/test/agent-opencode.test.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import test from "node:test";

import {
  OPENCODE_EVENTS,
  OPENCODE_IGNORED_EVENTS,
  OPENCODE_BIN_ENV,
  attachOpenCodeSse,
  buildOpenCodeCandidates,
  createOpenCodeDriver,
  createSseParser,
  detectOpenCode,
  mapOpenCodeLine,
  mapOpenCodeObject,
  parseSseBlock,
  unwrapOpenCodeEvent
} from "../agent/opencode.mjs";

const NOW = 1_700_000_000_000;
const at = () => NOW;
const evt = (type, properties) => ({ type, properties });
const line = (obj) => JSON.stringify(obj);

/** 官方 `Part`/`ToolState` 形状的夹具（字段名逐字对照 SDK types）。 */
const TEXT_PART = {
  id: "prt_text_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "正在分析代码"
};
const TOOL_RUNNING = {
  id: "prt_tool_1", sessionID: "ses_1", messageID: "msg_1", type: "tool",
  callID: "call_1", tool: "bash",
  state: { status: "running", input: { command: "curl -H 'Authorization: Bearer sk-secret' https://x" }, time: { start: 1 } }
};
const TOOL_DONE = {
  ...TOOL_RUNNING,
  state: { status: "completed", input: {}, output: "HTTP/2 200", title: "bash", metadata: {}, time: { start: 1, end: 2 } }
};
const TOOL_ERROR = {
  ...TOOL_RUNNING,
  state: { status: "error", input: {}, error: "command failed", time: { start: 1, end: 2 } }
};
const PERMISSION = {
  id: "perm_1", type: "bash", pattern: "rm -rf *", sessionID: "ses_1", messageID: "msg_1",
  callID: "call_1", title: "Run rm -rf build", metadata: {}, time: { created: 1 }
};

test("事件词表：认识的事件与忽略清单覆盖官方 Event 联合的关键项", () => {
  assert.ok(OPENCODE_EVENTS.includes("message.part.updated"));
  assert.ok(OPENCODE_EVENTS.includes("permission.updated"));
  assert.ok(OPENCODE_IGNORED_EVENTS.includes("message.updated"));
  assert.ok(OPENCODE_IGNORED_EVENTS.includes("session.created"));
});

test("server.connected → status(connected)", () => {
  const r = mapOpenCodeObject(evt("server.connected", {}), { now: at });
  assert.equal(r.events[0].status, "connected");
});

test("/global/event 的 {directory,payload} 包装能自动解包", () => {
  const wrapped = { directory: "/repo", payload: evt("session.idle", { sessionID: "ses_1" }) };
  assert.equal(unwrapOpenCodeEvent(wrapped).type, "session.idle");
  const r = mapOpenCodeObject(wrapped, { now: at });
  assert.equal(r.events[0].type, "turn.end");
  assert.equal(r.events[0].reason, "completed");
});

test("session.status：busy→working / idle→idle / retry→retrying(带 attempt 与 next)", () => {
  assert.equal(mapOpenCodeObject(evt("session.status", { sessionID: "s", status: { type: "busy" } }), { now: at }).events[0].status, "working");
  assert.equal(mapOpenCodeObject(evt("session.status", { sessionID: "s", status: { type: "idle" } }), { now: at }).events[0].status, "idle");
  const retry = mapOpenCodeObject(evt("session.status", { sessionID: "s", status: { type: "retry", attempt: 2, next: 5000 } }), { now: at });
  assert.equal(retry.events[0].status, "retrying");
  assert.equal(retry.events[0].attempt, 2);
  assert.equal(retry.events[0].retryDelayMs, 5000);
});

test("session.idle → turn.end(completed)（文档语义：会话空闲=回合结束）", () => {
  const r = mapOpenCodeObject(evt("session.idle", { sessionID: "ses_1" }), { now: at });
  assert.equal(r.events[0].type, "turn.end");
  assert.equal(r.events[0].reason, "completed");
  assert.equal(r.events[0].isError, false);
});

test("session.error → turn.end(error)：带 error name 与 message 预览", () => {
  const r = mapOpenCodeObject(evt("session.error", {
    sessionID: "ses_1",
    error: { name: "ApiError", data: { message: "rate limited" } }
  }), { now: at });
  assert.equal(r.events[0].type, "turn.end");
  assert.equal(r.events[0].reason, "error");
  assert.equal(r.events[0].isError, true);
  assert.equal(r.events[0].errorName, "ApiError");
  assert.match(r.events[0].errorMessage, /rate limited/);
});

test("message.part.updated(text)：有 delta 用增量（final=false），无 delta 用全文（final=true）", () => {
  const delta = mapOpenCodeObject(evt("message.part.updated", { part: TEXT_PART, delta: "正在" }), { now: at });
  assert.equal(delta.events[0].type, "message.delta");
  assert.equal(delta.events[0].final, false);
  assert.equal(delta.events[0].text, "正在");

  const full = mapOpenCodeObject(evt("message.part.updated", { part: TEXT_PART }), { now: at });
  assert.equal(full.events[0].final, true);
  assert.equal(full.events[0].text, "正在分析代码");
});

test("message.part.updated(reasoning) → status(thinking) 只带字节数", () => {
  const part = { id: "prt_r", sessionID: "s", messageID: "m", type: "reasoning", text: "I should rm -rf", time: { start: 1 } };
  const r = mapOpenCodeObject(evt("message.part.updated", { part }), { now: at });
  assert.equal(r.events[0].status, "thinking");
  assert.ok(r.events[0].textBytes > 0);
  assert.equal(JSON.stringify(r.events).includes("rm -rf"), false);
});

test("tool part(running) → tool.call：工具名映射 kind、只带输入字节数、不落命令原文", () => {
  const r = mapOpenCodeObject(evt("message.part.updated", { part: TOOL_RUNNING }), { now: at });
  const ev = r.events[0];
  assert.equal(ev.type, "tool.call");
  assert.equal(ev.toolCallId, "call_1");
  assert.equal(ev.name, "bash");
  assert.equal(ev.kind, "execute");
  assert.ok(ev.inputBytes > 0);
  assert.equal(JSON.stringify(ev).includes("sk-secret"), false, "命令原文不落");
});

test("tool part(completed/error) → tool.result：isError 与截断预览", () => {
  const done = mapOpenCodeObject(evt("message.part.updated", { part: TOOL_DONE }), { now: at });
  assert.equal(done.events[0].type, "tool.result");
  assert.equal(done.events[0].isError, false);
  assert.match(done.events[0].outputPreview, /HTTP\/2 200/);

  const bad = mapOpenCodeObject(evt("message.part.updated", { part: TOOL_ERROR }), { now: at });
  assert.equal(bad.events[0].isError, true);
  assert.match(bad.events[0].outputPreview, /command failed/);
});

test("permission.updated → status(waiting_approval)：不落 title/pattern（可能含命令）", () => {
  const r = mapOpenCodeObject(evt("permission.updated", PERMISSION), { now: at });
  const ev = r.events[0];
  assert.equal(ev.status, "waiting_approval");
  assert.equal(ev.requestId, "perm_1");
  assert.equal(ev.permType, "bash");
  assert.equal(ev.toolCallId, "call_1");
  const dump = JSON.stringify(ev);
  assert.equal(dump.includes("rm -rf"), false, "pattern 不落");
  assert.equal(dump.includes("Run rm -rf build"), false, "title 不落");
});

test("permission.replied → status(approval_replied)", () => {
  const r = mapOpenCodeObject(evt("permission.replied", { sessionID: "s", permissionID: "perm_1", response: "once" }), { now: at });
  assert.equal(r.events[0].status, "approval_replied");
  assert.equal(r.events[0].requestId, "perm_1");
  assert.equal(r.events[0].response, "once");
});

test("忽略清单里的事件 → 0 事件；未知类型 → ok:false（计 unknown）", () => {
  for (const t of ["message.updated", "session.created", "file.edited", "todo.updated", "pty.exited"]) {
    assert.deepEqual(mapOpenCodeObject(evt(t, {}), { now: at }), { ok: true, events: [] }, `${t} 应忽略`);
  }
  assert.equal(mapOpenCodeObject(evt("brand.new.event", {}), { now: at }).reason, "unknown-type:brand.new.event");
  assert.equal(mapOpenCodeLine("not json", { now: at }).reason, "bad-json");
  assert.equal(mapOpenCodeObject({}, { now: at }).reason, "not-event");
});

test("驱动：一段真实形状的 SSE 事件序列 → unknown=0、5 类事件齐", () => {
  const d = createOpenCodeDriver({ now: at });
  const lines = [
    line(evt("server.connected", {})),
    line(evt("message.part.updated", { part: TEXT_PART, delta: "正在" })),
    line(evt("message.part.updated", { part: TOOL_RUNNING })),
    line(evt("message.part.updated", { part: TOOL_DONE })),
    line(evt("permission.updated", PERMISSION)),
    line(evt("session.idle", { sessionID: "ses_1" }))
  ];
  const events = [];
  for (const l of lines) events.push(...d.writeLine(l));
  const s = d.stats();
  assert.equal(s.driverName, "opencode-sse");
  assert.equal(s.unknown, 0);
  assert.deepEqual(events.map((e) => e.type), ["status", "message.delta", "tool.call", "tool.result", "status", "turn.end"]);
  assert.equal(s.byType["tool.call"], 1);
});

// ── SSE 桥接（本模块的核心差异点） ─────────────────────────────────

test("SSE 解析：一个 block、多个 block、跨 chunk 半截、CRLF、注释心跳", () => {
  const p = createSseParser();
  assert.equal(p.push("data: {\"type\":\"server.connected\",\"properties\":{}}\n\n").length, 1);
  const two = p.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
  assert.deepEqual(two.map((m) => m.data), [{ a: 1 }, { b: 2 }]);

  // 跨 chunk：先来半截
  assert.deepEqual(p.push("data: {\"type\":\"sess"), []);
  const rest = p.push("ion.idle\",\"properties\":{}}\n\n");
  assert.equal(rest.length, 1);
  assert.equal(rest[0].data.type, "session.idle");

  // CRLF + 注释行（心跳）
  const crlf = p.push(": keepalive\r\ndata: {\"x\":1}\r\n\r\n");
  assert.deepEqual(crlf.map((m) => m.data), [{ x: 1 }]);
  assert.equal(p.buffered(), "");
});

test("SSE 解析：多行 data 用换行拼接；坏 JSON 返回 data:null 且不抛", () => {
  const multi = parseSseBlock('event: msg\ndata: {"a":\ndata: 1}');
  assert.deepEqual(multi.data, { a: 1 });
  const bad = parseSseBlock("data: {not json");
  assert.equal(bad.data, null);
  assert.match(bad.raw, /not json/);
  assert.equal(parseSseBlock(": only heartbeat"), null);
});

test("SSE 解析：flush 处理没有结尾空行的最后一块", () => {
  const p = createSseParser();
  p.push('data: {"last":true}');
  assert.deepEqual(p.push(""), []);
  const out = p.flush();
  assert.deepEqual(out.map((m) => m.data), [{ last: true }]);
});

test("attachOpenCodeSse：把 SSE 流接到驱动上（含坏块计数、detach、end flush）", () => {
  const stream = new EventEmitter();
  const d = createOpenCodeDriver({ now: at });
  const logs = [];
  const sse = attachOpenCodeSse({ stream, driver: d, log: (e) => logs.push(e) });

  stream.emit("data", 'data: {"type":"server.connected","properties":{}}\n\n');
  stream.emit("data", 'data: {"type":"session.idle","properties":{"sessionID":"s"}}\n\n');
  stream.emit("data", ": heartbeat\n\n"); // 心跳不产生消息
  stream.emit("data", "data: {bad json\n\n"); // 坏块
  stream.emit("end");

  const s = d.stats();
  assert.equal(s.events, 2, "两条有效事件");
  assert.equal(s.unknown, 0, "坏 SSE 块在桥接层就被拦下，不进驱动 unknown");
  assert.deepEqual(sse.stats(), { chunks: 4, badBlocks: 1 });
  assert.equal(logs[0].event, "sse.bad-json");

  // detach 后不再喂
  sse.detach();
  stream.emit("data", 'data: {"type":"server.connected","properties":{}}\n\n');
  assert.equal(d.stats().events, 2);
});

// ── CLI 探测（假实现） ────────────────────────────────────────────

const SERVE_HELP = "Usage: opencode serve [options]\n  --port <number>      Port to listen on (default: 4096)\n  --hostname <string>\n  --cors <origin>\n";

function makeFs(overrides = {}) {
  const enoent = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return {
    existsSync: () => false,
    statSync: () => enoent(),
    realpathSync: (p) => p,
    readdirSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    ...overrides
  };
}

function fakeSpawn({ version = "1.19.5", help = SERVE_HELP } = {}) {
  return (command, args) => {
    if (args.includes("--version")) return { status: 0, stdout: `${version}\n`, stderr: "" };
    if (args.includes("serve") && args.includes("--help")) return { status: 0, stdout: help, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("候选：显式 env / PATH 解软链 / npm 包 bin 目录扫描（.js 走 node）", () => {
  const c = buildOpenCodeCandidates({
    env: { [OPENCODE_BIN_ENV]: "/custom/opencode", PATH: "/usr/bin" },
    platform: "linux",
    execPath: "/usr/bin/node",
    fs: makeFs({
      statSync: () => ({ isFile: () => true, mode: 0o755 }),
      readdirSync: () => ["opencode", "opencode.js"]
    }),
    npmRoot: "/usr/lib/node_modules",
    isExecutable: (p) => p === "/usr/bin/opencode" || p.endsWith("/opencode"),
    realpath: (p) => (p === "/usr/bin/opencode" ? "/real/opencode" : p)
  });
  const kinds = c.map((x) => x.kind);
  // npm 目录扫描顺序取决于 readdir 顺序：原生二进制与 .js 入口都可能先出，断言集合即可
  assert.deepEqual([...kinds].sort(), ["explicit", "npm-native", "npm-node", "path"]);
  assert.equal(c[1].command, "/real/opencode");
  const nodeEntry = c.find((x) => x.kind === "npm-node");
  assert.ok(nodeEntry.argsPrefix[0].endsWith("opencode.js"));
  // npm 包不存在时 readdir 抛错也不崩
  const empty = buildOpenCodeCandidates({ env: {}, fs: makeFs(), npmRoot: "/none", isExecutable: () => false });
  assert.deepEqual(empty, []);
});

test("探测：server API 可用 → ok + mode=approval + approvalChannel=http", () => {
  const r = detectOpenCode({
    env: { [OPENCODE_BIN_ENV]: "/fake/opencode", PATH: "" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: fakeSpawn(),
    npmRoot: ""
  });
  assert.equal(r.ok, true);
  assert.equal(r.version.text, "1.19.5");
  assert.equal(r.caps.serverApi, true);
  assert.equal(r.caps.sse, true);
  assert.equal(r.caps.permissionReply, true);
  assert.equal(r.mode, "approval");
  assert.equal(r.approvalChannel, "http");
  assert.equal(r.capsEvidence.matched.port, true);
});

test("探测：CLI 缺失 → cli-missing；版本认不出 → version-unknown；serve --help 失败 → warning", () => {
  const missing = detectOpenCode({ env: { PATH: "" }, platform: "linux", fs: makeFs(), spawnSync: fakeSpawn(), npmRoot: "" });
  assert.equal(missing.status, "cli-missing");

  const unknown = detectOpenCode({
    env: { [OPENCODE_BIN_ENV]: "/fake/opencode" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: () => ({ status: 0, stdout: "weird", stderr: "" }),
    npmRoot: ""
  });
  assert.equal(unknown.status, "version-unknown");

  const capsFail = detectOpenCode({
    env: { [OPENCODE_BIN_ENV]: "/fake/opencode" },
    platform: "linux",
    fs: makeFs(),
    npmRoot: "",
    spawnSync: (command, args) => {
      if (args.includes("--version")) return { status: 0, stdout: "1.19.5", stderr: "" };
      return { status: 2, stdout: "", stderr: "boom" };
    }
  });
  assert.equal(capsFail.ok, true);
  assert.equal(capsFail.caps.serverApi, false);
  assert.ok(capsFail.warnings.some((w) => w.code === "caps-probe-failed"));
});

test("本机 opencode 真实探测（未安装则 SKIP）", { skip: (() => {
  try {
    const r = nodeSpawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0 ? false : "本机未安装 opencode CLI";
  } catch {
    return "本机未安装 opencode CLI";
  }
})() }, () => {
  const r = detectOpenCode({ env: { ...process.env, [OPENCODE_BIN_ENV]: "" }, platform: process.platform, npmRoot: "" });
  assert.equal(r.ok, true);
  assert.match(r.version.text, /^\d+\.\d+\.\d+$/);
  assert.equal(r.caps.serverApi, true);
});

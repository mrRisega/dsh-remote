#!/usr/bin/env node
/**
 * Gemini CLI（ACP）适配契约测试（M2 第 5 周）。
 *
 * ## 夹具来源（全部官方，逐字摘录；ACP v1 文档）
 *
 * | 夹具 | 出处 |
 * |---|---|
 * | `session/update` 的 `agent_message_chunk` / `plan` / `notice` 样本 | <https://agentclientprotocol.com/protocol/v1/prompt-turn> |
 * | `tool_call` / `tool_call_update` / `session/request_permission` 样本 | <https://agentclientprotocol.com/protocol/v1/tool-calls> |
 * | `session/prompt` 响应 `{"result":{"stopReason":"end_turn"}}` | <https://agentclientprotocol.com/protocol/v1/prompt-turn> |
 * | stopReason 闭集（end_turn/max_tokens/max_turn_requests/refusal/cancelled） | 同上 "Stop reasons" |
 * | stdio 传输"一行一条 JSON-RPC" | <https://agentclientprotocol.com/protocol/v1/transports> |
 * | 能力位（`--experimental-acp`） | 本机 `gemini --help`（`gemini 0.31.0`，Homebrew 安装，实测） |
 *
 * ## 本机探测
 *
 * 末尾条件用例：本机装了 gemini（0.31.0）就真跑 `gemini --version` + `gemini --help`（**不调模型**），
 * 断言 ACP 能力位；没装则 SKIP。
 *
 * 用法: node --test clients/dsh-remote/test/agent-gemini.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import test from "node:test";

import {
  ACP_SESSION_UPDATE_VARIANTS,
  ACP_TOOL_KINDS,
  GEMINI_BIN_ENV,
  buildGeminiCandidates,
  createGeminiDriver,
  detectGemini,
  mapGeminiLine,
  mapGeminiObject,
  stopReasonOf
} from "../agent/gemini.mjs";

const NOW = 1_700_000_000_000;
const at = () => NOW;
const line = (obj) => JSON.stringify(obj);

/** ACP JSON-RPC 通知外壳（官方 transports：一行一条 JSON-RPC）。 */
const notif = (method, params) => ({ jsonrpc: "2.0", method, params });
const sessionUpdate = (update) => notif("session/update", { sessionId: "sess_abc123def456", update });

test("ACP 词表：sessionUpdate 变体与工具 kind 与官方文档一致", () => {
  assert.ok(ACP_SESSION_UPDATE_VARIANTS.includes("agent_message_chunk"));
  assert.ok(ACP_SESSION_UPDATE_VARIANTS.includes("tool_call_update"));
  assert.ok(ACP_SESSION_UPDATE_VARIANTS.includes("usage_update"));
  assert.deepEqual([...ACP_TOOL_KINDS], ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
});

test("非 JSON-RPC 行 → ok:false（防止 stderr/日志混进 stdout）", () => {
  assert.equal(mapGeminiObject({ type: "assistant" }, { now: at }).reason, "not-jsonrpc");
  assert.equal(mapGeminiLine("hello", { now: at }).reason, "bad-json");
  assert.equal(mapGeminiLine("", { now: at }).reason, "empty");
});

test("agent_message_chunk → message.delta(final:false)（ACP 是流式增量）", () => {
  // 官方样本（prompt-turn）：content 是单个 ContentBlock
  const r = mapGeminiObject(sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_agent_c42b9",
    content: { type: "text", text: "I'll analyze your code for potential issues." }
  }), { now: at });
  assert.equal(r.ok, true);
  const ev = r.events[0];
  assert.equal(ev.type, "message.delta");
  assert.equal(ev.final, false);
  assert.match(ev.text, /analyze your code/);
});

test("agent_thought_chunk → status(thinking) 只带字节数（推理内容不落）", () => {
  const r = mapGeminiObject(sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "I should run rm -rf build" }
  }), { now: at });
  assert.equal(r.events[0].status, "thinking");
  assert.ok(r.events[0].textBytes > 0);
  assert.equal(JSON.stringify(r.events).includes("rm -rf"), false);
});

test("user_message_chunk → 忽略（不是 Agent 输出）", () => {
  const r = mapGeminiObject(sessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }), { now: at });
  assert.deepEqual(r, { ok: true, events: [] });
});

test("tool_call → tool.call（kind/status/输入字节数；title 不落）", () => {
  // 官方样本（tool-calls）：title "Reading configuration file"、name read_file、kind read、status pending
  const r = mapGeminiObject(sessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call_001",
    title: "Reading configuration file",
    name: "read_file",
    kind: "read",
    status: "pending",
    rawInput: { path: "/repo/config.yml" }
  }), { now: at });
  const ev = r.events[0];
  assert.equal(ev.type, "tool.call");
  assert.equal(ev.toolCallId, "call_001");
  assert.equal(ev.name, "read_file");
  assert.equal(ev.kind, "read");
  assert.equal(ev.status, "pending");
  assert.ok(ev.inputBytes > 0);
  assert.equal(JSON.stringify(ev).includes("Reading configuration file"), false, "title 可能夹带命令，不落");
  assert.equal(JSON.stringify(ev).includes("/repo/config.yml"), false, "rawInput 内容不落");
});

test("tool_call_update：in_progress 不产事件；completed/failed → tool.result", () => {
  const progress = mapGeminiObject(sessionUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "call_001", status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "Found 3 configuration files..." } }]
  }), { now: at });
  assert.deepEqual(progress, { ok: true, events: [] }, "in_progress 增量不产生事件（避免重复）");

  const done = mapGeminiObject(sessionUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "call_001", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Found 3 configuration files" } }]
  }), { now: at });
  assert.equal(done.events[0].type, "tool.result");
  assert.equal(done.events[0].isError, false);
  assert.match(done.events[0].outputPreview, /Found 3 configuration files/);

  const failed = mapGeminiObject(sessionUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "call_002", status: "failed"
  }), { now: at });
  assert.equal(failed.events[0].isError, true);
});

test("plan → status(plan) 带条数/完成数", () => {
  const r = mapGeminiObject(sessionUpdate({
    sessionUpdate: "plan",
    entries: [
      { status: "completed", description: "a" },
      { status: "in_progress", description: "b" }
    ]
  }), { now: at });
  assert.equal(r.events[0].status, "plan");
  assert.equal(r.events[0].planItems, 2);
  assert.equal(r.events[0].planDone, 1);
});

test("notice / usage_update → status；available_commands_update 等 → 忽略而不是 unknown", () => {
  assert.equal(mapGeminiObject(sessionUpdate({ sessionUpdate: "notice", message: "限流中" }), { now: at }).events[0].status, "notice");
  assert.equal(mapGeminiObject(sessionUpdate({ sessionUpdate: "usage_update" }), { now: at }).events[0].status, "usage");
  for (const v of ["available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "compaction_update"]) {
    const r = mapGeminiObject(sessionUpdate({ sessionUpdate: v }), { now: at });
    assert.deepEqual(r, { ok: true, events: [] }, `${v} 应忽略`);
  }
});

test("session/request_permission → status(waiting_approval)：只暴露协议枚举，不暴露 title/命令", () => {
  // 官方样本（tool-calls）
  const r = mapGeminiObject({
    jsonrpc: "2.0",
    id: 5,
    method: "session/request_permission",
    params: {
      sessionId: "sess_abc123def456",
      toolCall: { toolCallId: "call_001", title: "Run bash -lc rm -rf build", kind: "execute" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" }
      ]
    }
  }, { now: at });
  const ev = r.events[0];
  assert.equal(ev.type, "status");
  assert.equal(ev.status, "waiting_approval");
  assert.equal(ev.requestId, "5", "JSON-RPC id 就是回执 id");
  assert.equal(ev.toolCallId, "call_001");
  assert.equal(ev.toolKind, "execute");
  assert.deepEqual(ev.optionKinds, ["allow_once", "reject_once"]);
  assert.equal(JSON.stringify(ev).includes("rm -rf"), false, "审批文案不得落命令原文");
});

test("session/prompt 响应：stopReason → turn.end（含全部 5 种）", () => {
  const cases = {
    end_turn: "completed",
    max_tokens: "max-tokens",
    max_turn_requests: "max-turns",
    refusal: "refused",
    cancelled: "aborted"
  };
  for (const [raw, mapped] of Object.entries(cases)) {
    const r = mapGeminiObject({ jsonrpc: "2.0", id: 2, result: { stopReason: raw } }, { now: at });
    assert.equal(r.events[0].type, "turn.end");
    assert.equal(r.events[0].reason, mapped);
    assert.equal(r.events[0].rawStopReason, raw);
    assert.equal(stopReasonOf(raw), mapped);
  }
});

test("JSON-RPC 错误响应 → status(error)；未知 method → ok:false", () => {
  const err = mapGeminiObject({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "internal" } }, { now: at });
  assert.equal(err.events[0].status, "error");
  assert.equal(err.events[0].scope, "jsonrpc");
  assert.equal(err.events[0].message, "internal");

  assert.equal(mapGeminiObject(notif("session/brand_new", {}), { now: at }).reason, "unknown-method:session/brand_new");
  assert.equal(mapGeminiObject({ jsonrpc: "2.0" }, { now: at }).reason, "unknown-shape");
});

test("驱动：一条真实 ACP 流（多行 JSON-RPC）→ 5 类事件、unknown=0", () => {
  const d = createGeminiDriver({ now: at });
  const stream = [
    line(notif("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working…" } } })),
    line(notif("session/update", { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "bash", kind: "execute", status: "pending", rawInput: { command: "ls -la" } } })),
    line(notif("session/update", { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] } })),
    line({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } })
  ];
  const events = [];
  for (const l of stream) events.push(...d.writeLine(l));
  const s = d.stats();
  assert.equal(s.driverName, "gemini-acp");
  assert.equal(s.unknown, 0);
  assert.equal(s.badJson, 0);
  assert.deepEqual(events.map((e) => e.type), ["message.delta", "tool.call", "tool.result", "turn.end"]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(JSON.stringify(events).includes("ls -la"), false, "命令原文不落");
});

// ── CLI 探测（假实现） ────────────────────────────────────────────

const HELP_WITH_EXPERIMENTAL = "Usage: gemini [options]\n  --experimental-acp  Starts the agent in ACP mode  [boolean]\n  --output-format <format>\n";
const HELP_WITH_ACP = "Usage: gemini [options]\n  --acp  Starts the agent in ACP mode\n";

function makeFs(overrides = {}) {
  const enoent = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return { existsSync: () => false, statSync: () => enoent(), realpathSync: (p) => p, ...overrides };
}

function fakeSpawn({ version = "0.31.0", help = HELP_WITH_EXPERIMENTAL } = {}) {
  return (command, args) => {
    if (args.includes("--version")) return { status: 0, stdout: `${version}\n`, stderr: "" };
    if (args.includes("--help")) return { status: 0, stdout: help, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("候选：显式 env（.js→node）/ PATH 解软链 / npm 全局 bundle/gemini.js", () => {
  const js = "/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js";
  const c = buildGeminiCandidates({
    env: { [GEMINI_BIN_ENV]: "/custom/gemini", PATH: "/usr/bin" },
    platform: "linux",
    execPath: "/usr/bin/node",
    fs: makeFs({ statSync: () => ({ isFile: () => true }) }),
    npmRoot: "/usr/lib/node_modules",
    isExecutable: (p) => p === "/usr/bin/gemini" || p === js,
    realpath: (p) => (p === "/usr/bin/gemini" ? "/cellar/gemini" : p)
  });
  assert.deepEqual(c.map((x) => x.kind), ["explicit", "path", "npm-node"]);
  assert.equal(c[1].command, "/cellar/gemini");
  assert.deepEqual(c[2].argsPrefix, [js]);
});

test("探测：ACP 可用（--experimental-acp）→ ok + mode=approval + experimental 警告", () => {
  const r = detectGemini({
    env: { [GEMINI_BIN_ENV]: "/fake/gemini", PATH: "" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: fakeSpawn(),
    npmRoot: ""
  });
  assert.equal(r.ok, true);
  assert.equal(r.version.text, "0.31.0");
  assert.equal(r.caps.acp, true);
  assert.equal(r.caps.acpFlag, "--experimental-acp");
  assert.equal(r.caps.acpApproval, true);
  assert.equal(r.mode, "approval");
  assert.equal(r.approvalChannel, "acp-jsonrpc");
  assert.ok(r.warnings.some((w) => w.code === "acp-experimental"));
});

test("探测：新 flag --acp 也算 ACP 可用（且不产生 experimental 警告）", () => {
  const r = detectGemini({
    env: { [GEMINI_BIN_ENV]: "/fake/gemini" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: fakeSpawn({ help: HELP_WITH_ACP }),
    npmRoot: ""
  });
  assert.equal(r.caps.acp, true);
  assert.equal(r.caps.acpFlag, "--acp");
  assert.equal(r.warnings.some((w) => w.code === "acp-experimental"), false);
});

test("探测：无 ACP → notify-only；CLI 缺失 → cli-missing；版本认不出 → version-unknown", () => {
  const noAcp = detectGemini({
    env: { [GEMINI_BIN_ENV]: "/fake/gemini" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: fakeSpawn({ help: "Usage: gemini\n  --output-format <format>" }),
    npmRoot: ""
  });
  assert.equal(noAcp.caps.acp, false);
  assert.equal(noAcp.mode, "notify-only");

  const missing = detectGemini({ env: { PATH: "" }, platform: "linux", fs: makeFs(), spawnSync: fakeSpawn(), npmRoot: "" });
  assert.equal(missing.status, "cli-missing");

  const unknown = detectGemini({
    env: { [GEMINI_BIN_ENV]: "/fake/gemini" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: () => ({ status: 0, stdout: "weird", stderr: "" }),
    npmRoot: ""
  });
  assert.equal(unknown.status, "version-unknown");
});

test("探测：--help 失败不致命（ok，但 caps.acp=false + warning）", () => {
  const r = detectGemini({
    env: { [GEMINI_BIN_ENV]: "/fake/gemini" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: (command, args) => {
      if (args.includes("--version")) return { status: 0, stdout: "0.31.0", stderr: "" };
      return { status: 2, stdout: "", stderr: "help boom" };
    },
    npmRoot: ""
  });
  assert.equal(r.ok, true);
  assert.equal(r.caps.acp, false);
  assert.ok(r.warnings.some((w) => w.code === "caps-probe-failed"));
});

// ── 本机真实探测（装了就跑；不调模型） ─────────────────────────────

const REAL_GEMINI = (() => {
  try {
    const r = nodeSpawnSync("gemini", ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0 ? { ok: true, raw: String(r.stdout).trim() } : { ok: false, raw: String(r.stdout || r.stderr).trim() };
  } catch {
    return { ok: false, raw: "" };
  }
})();

test(
  "本机 gemini 真实探测（未安装则 SKIP）：版本 + ACP 能力位",
  { skip: REAL_GEMINI.ok ? false : `本机未安装 gemini CLI（${REAL_GEMINI.raw || "无"}）` },
  () => {
    const r = detectGemini({ env: { ...process.env, [GEMINI_BIN_ENV]: "" }, platform: process.platform, npmRoot: "" });
    assert.equal(r.ok, true, `探测失败: ${JSON.stringify(r.attempts || r.reason)}`);
    assert.match(r.version.text, /^\d+\.\d+\.\d+$/, "版本号必须能解析");
    assert.equal(r.caps.acp, true, "本机 help 里应有 ACP 开关");
    assert.ok(["--acp", "--experimental-acp"].includes(r.caps.acpFlag));
    // 本机 0.31.0 实测是 --experimental-acp
    assert.equal(r.caps.acpFlag, "--experimental-acp", "本机 0.31.0 实测 ACP 开关名");
  }
);

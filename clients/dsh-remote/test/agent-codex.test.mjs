#!/usr/bin/env node
/**
 * Codex 适配骨架契约测试（M2 第 4 周）。
 *
 * ## 夹具来源（全部官方，逐字摘录；不要凭记忆改）
 *
 * | 夹具 | 出处 |
 * |---|---|
 * | `OFFICIAL_SAMPLE`（5 行 JSONL） | <https://learn.chatgpt.com/docs/non-interactive-mode> 的 **Sample JSON stream** 代码块 |
 * | item / 字段形状（command_execution、file_change、mcp_tool_call、web_search、todo_list、error…） | `openai/codex` → `codex-rs/exec/src/exec_events.rs`（权威 Rust 定义）+ `sdk/typescript/src/items.ts`（同款 TS 类型） |
 * | 顶层事件枚举（8 种） | 同上 `ThreadEvent`；官方文档 "Event types include …" |
 * | 能力位（`--json` / `--output-schema` / `--approve-for-me`） | 本机 `codex exec --help`（`codex-cli 0.150.1`）实测 |
 *
 * ## 本机探测
 *
 * 末尾有一条**条件用例**：本机装了 codex 就真跑 `codex --version` + `codex exec --help`
 * （**不调用模型**，不耗额度）；没装则 SKIP。结果用于在报告里记录真实版本与能力位。
 *
 * 用法: node --test clients/dsh-remote/test/agent-codex.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  CODEX_BIN_ENV,
  buildCodexCandidates,
  createCodexDriver,
  createCodexMapper,
  detectCodex,
  mapCodexLine,
  mapCodexObject
} from "../agent/codex.mjs";
import { CODEX_CAPABILITIES, CODEX_ITEM_TYPES, CODEX_TOP_EVENTS } from "../agent/codex.mjs";
import { byteLength } from "../agent/events.mjs";

const NOW = 1_700_000_000_000;
const at = () => NOW;
const line = (obj) => JSON.stringify(obj);

/**
 * **官方文档样本（逐字摘录）** —— 来源见文件头。
 * 注意第 1 行是官方原样的 thread_id；不要改它（改了就不再是"真实样本"）。
 */
const OFFICIAL_SAMPLE = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}'
];

test("官方事件/条目枚举与我们的常量一致（防止把文档抄漏）", () => {
  assert.deepEqual([...CODEX_TOP_EVENTS], [
    "thread.started", "turn.started", "turn.completed", "turn.failed",
    "item.started", "item.updated", "item.completed", "error"
  ]);
  assert.ok(CODEX_ITEM_TYPES.includes("command_execution"));
  assert.ok(CODEX_ITEM_TYPES.includes("mcp_tool_call"));
  assert.equal(CODEX_CAPABILITIES.externalApprovalHook, false, "exec 没有审批回调开关（本机 help 实测）");
});

test("官方样本第 1 行：thread.started → status(working) + threadId", () => {
  const r = mapCodexLine(OFFICIAL_SAMPLE[0], { now: at });
  assert.equal(r.ok, true);
  assert.equal(r.events[0].type, "status");
  assert.equal(r.events[0].status, "working");
  assert.equal(r.events[0].phase, "thread");
  assert.equal(r.events[0].threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
});

test("官方样本第 2 行：turn.started → status(working, phase=turn)", () => {
  const r = mapCodexLine(OFFICIAL_SAMPLE[1], { now: at });
  assert.equal(r.events[0].type, "status");
  assert.equal(r.events[0].phase, "turn");
});

test("官方样本第 3 行：item.started command_execution → tool.call（只带命令字节数，不带原文）", () => {
  const r = mapCodexLine(OFFICIAL_SAMPLE[2], { now: at });
  assert.equal(r.events.length, 1);
  const ev = r.events[0];
  assert.equal(ev.type, "tool.call");
  assert.equal(ev.name, "shell");
  assert.equal(ev.kind, "execute");
  assert.equal(ev.toolCallId, "item_1");
  assert.equal(ev.inputBytes, byteLength("bash -lc ls"));
  assert.equal(JSON.stringify(ev).includes("bash -lc ls"), false, "命令原文不能进事件");
});

test("官方样本第 4 行：item.completed agent_message → message.delta(final=true)", () => {
  const r = mapCodexLine(OFFICIAL_SAMPLE[3], { now: at });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, "message.delta");
  assert.equal(r.events[0].final, true);
  assert.match(r.events[0].text, /Repo contains docs/);
});

test("官方样本第 5 行：turn.completed → turn.end(completed) + usage（缺失字段按 0）", () => {
  const r = mapCodexLine(OFFICIAL_SAMPLE[4], { now: at });
  const ev = r.events[0];
  assert.equal(ev.type, "turn.end");
  assert.equal(ev.reason, "completed");
  assert.equal(ev.isError, false);
  assert.equal(ev.usage.inputTokens, 24763);
  assert.equal(ev.usage.cachedInputTokens, 24448);
  assert.equal(ev.usage.outputTokens, 122);
  assert.equal(ev.usage.reasoningOutputTokens, 0);
  assert.equal(ev.usage.cacheWriteInputTokens, 0, "官方样本没这个字段 → 默认 0（未核实线上是否总给）");
});

test("整条官方样本流跑 Codex 驱动：5 类事件齐、unknown=0、seq 连续", () => {
  const d = createCodexDriver({ now: at });
  const produced = [];
  for (const l of OFFICIAL_SAMPLE) produced.push(...d.writeLine(l));
  const s = d.stats();
  assert.equal(s.driverName, "codex");
  assert.equal(s.unknown, 0);
  assert.equal(s.badJson, 0);
  assert.deepEqual(produced.map((e) => e.type), ["status", "status", "tool.call", "message.delta", "turn.end"]);
  assert.deepEqual(produced.map((e) => e.seq), [1, 2, 3, 4, 5]);
});

test("command_execution 完成：exit_code=0 → 成功；非 0/未知 status → isError", () => {
  const okLine = line({
    type: "item.completed",
    item: {
      id: "c1", type: "command_execution", command: "npm test", status: "completed",
      exit_code: 0, aggregated_output: "all green"
    }
  });
  const ok = mapCodexLine(okLine, { now: at });
  const res = ok.events.find((e) => e.type === "tool.result");
  assert.equal(res.isError, false);
  assert.equal(res.exitCode, 0);
  assert.equal(res.outputBytes, byteLength("all green"));
  assert.equal(res.outputPreview, "all green");

  const bad = mapCodexObject({
    type: "item.completed",
    item: { id: "c2", type: "command_execution", command: "false", status: "completed", exit_code: 1, aggregated_output: "boom" }
  }, { now: at });
  assert.equal(bad.events.find((e) => e.type === "tool.result").isError, true);

  // 【未核实】Rust 枚举有 declined、TS 类型没有 → 按失败处理
  const declined = mapCodexObject({
    type: "item.completed",
    item: { id: "c3", type: "command_execution", command: "rm x", status: "declined", aggregated_output: "" }
  }, { now: at });
  assert.equal(declined.events.find((e) => e.type === "tool.result").isError, true);
});

test("有状态驱动：started 与 completed 成对出现时 tool.call 只发一次", () => {
  const d = createCodexDriver({ now: at });
  d.writeLine(line({
    type: "item.started",
    item: { id: "x1", type: "command_execution", command: "ls", status: "in_progress" }
  }));
  const out2 = d.writeLine(line({
    type: "item.completed",
    item: { id: "x1", type: "command_execution", command: "ls", status: "completed", exit_code: 0, aggregated_output: "a" }
  }));
  assert.deepEqual(out2.map((e) => e.type), ["tool.result"], "completed 不再重复 tool.call");
  assert.equal(d.stats().byType["tool.call"], 1);
});

test("file_change（仅在 completed 发出）→ tool.call + tool.result；文件数进事件、路径不落", () => {
  const r = mapCodexLine(line({
    type: "item.completed",
    item: {
      id: "f1", type: "file_change", status: "completed",
      changes: [{ path: "/repo/secret-a.ts", kind: "update" }, { path: "/repo/secret-b.ts", kind: "add" }]
    }
  }), { now: at });
  const call = r.events.find((e) => e.type === "tool.call");
  const res = r.events.find((e) => e.type === "tool.result");
  assert.equal(call.kind, "edit");
  assert.equal(call.fileCount, 2);
  assert.equal(res.isError, false);
  assert.equal(JSON.stringify(r.events).includes("secret-a.ts"), false, "文件路径不落日志");
});

test("mcp_tool_call：started → tool.call(mcp:server/tool)；completed 成功/失败 → tool.result", () => {
  const started = mapCodexLine(line({
    type: "item.started",
    item: { id: "m1", type: "mcp_tool_call", server: "fs", tool: "read", arguments: { path: "/x" }, status: "in_progress" }
  }), { now: at });
  assert.equal(started.events[0].name, "mcp:fs/read");
  assert.ok(started.events[0].inputBytes > 0);

  const ok = mapCodexLine(line({
    type: "item.completed",
    item: {
      id: "m1", type: "mcp_tool_call", server: "fs", tool: "read", arguments: {}, status: "completed",
      result: { content: [{ type: "text", text: "file body" }], structured_content: null }
    }
  }), { now: at });
  const okRes = ok.events.find((e) => e.type === "tool.result");
  assert.equal(okRes.isError, false);
  assert.equal(okRes.outputBytes, byteLength("file body"));

  const bad = mapCodexLine(line({
    type: "item.completed",
    item: { id: "m2", type: "mcp_tool_call", server: "fs", tool: "read", arguments: {}, status: "failed", error: { message: "permission denied" } }
  }), { now: at });
  const badRes = bad.events.find((e) => e.type === "tool.result");
  assert.equal(badRes.isError, true);
  assert.match(badRes.outputPreview, /permission denied/);
});

test("web_search → tool.call(fetch)；完成带结果数、不带查询原文", () => {
  const started = mapCodexLine(line({
    type: "item.started", item: { id: "w1", type: "web_search", query: "secret query text" }
  }), { now: at });
  assert.equal(started.events[0].kind, "fetch");
  assert.equal(JSON.stringify(started.events).includes("secret query text"), false);

  const done = mapCodexLine(line({
    type: "item.completed", item: { id: "w1", type: "web_search", query: "q", results: [{}, {}] }
  }), { now: at });
  assert.equal(done.events.find((e) => e.type === "tool.result").resultCount, 2);
});

test("reasoning → status(thinking) 只带字节数；有状态驱动去重", () => {
  const r = mapCodexLine(line({ type: "item.started", item: { id: "r1", type: "reasoning", text: "I should run rm -rf" } }), { now: at });
  assert.equal(r.events[0].status, "thinking");
  assert.equal(r.events[0].textBytes, byteLength("I should run rm -rf"));
  assert.equal(JSON.stringify(r.events).includes("rm -rf"), false, "推理内容不落");

  const d = createCodexDriver({ now: at });
  d.writeLine(line({ type: "item.started", item: { id: "r1", type: "reasoning", text: "x" } }));
  const second = d.writeLine(line({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "x" } }));
  assert.deepEqual(second, [], "同一 reasoning 不发两次 thinking");
});

test("todo_list → status(plan) 带条数与完成数", () => {
  const r = mapCodexLine(line({
    type: "item.completed",
    item: { id: "t1", type: "todo_list", items: [{ text: "a", completed: true }, { text: "b", completed: false }] }
  }), { now: at });
  assert.equal(r.events[0].status, "plan");
  assert.equal(r.events[0].planItems, 2);
  assert.equal(r.events[0].planDone, 1);
});

test("错误两种：item error → status(item)；顶层 error → status(stream)；turn.failed → turn.end(error)", () => {
  const itemErr = mapCodexLine(line({ type: "item.completed", item: { id: "e1", type: "error", message: "boom item" } }), { now: at });
  assert.equal(itemErr.events[0].status, "error");
  assert.equal(itemErr.events[0].scope, "item");

  const streamErr = mapCodexLine(line({ type: "error", message: "boom stream" }), { now: at });
  assert.equal(streamErr.events[0].status, "error");
  assert.equal(streamErr.events[0].scope, "stream");

  const failed = mapCodexLine(line({ type: "turn.failed", error: { message: "model overloaded" } }), { now: at });
  assert.equal(failed.events[0].type, "turn.end");
  assert.equal(failed.events[0].reason, "error");
  assert.match(failed.events[0].errorMessage, /model overloaded/);
});

test("collab_tool_call（Rust 有、TS 无 → 未核实）也能映射成 tool.call，不崩", () => {
  const r = mapCodexLine(line({
    type: "item.started",
    item: { id: "cb1", type: "collab_tool_call", tool: "spawn_agent", prompt: "do x", status: "in_progress" }
  }), { now: at });
  assert.equal(r.events[0].name, "collab:spawn_agent");
  assert.equal(r.events[0].kind, "other");
});

test("item.updated 忽略（增量语义未核实）；agent_message 的 started 不发事件", () => {
  assert.deepEqual(mapCodexLine(line({
    type: "item.updated", item: { id: "c9", type: "command_execution", command: "ls", status: "in_progress" }
  }), { now: at }).events, []);
  assert.deepEqual(mapCodexLine(line({
    type: "item.started", item: { id: "a1", type: "agent_message", text: "partial" }
  }), { now: at }).events, []);
});

test("未知形状：未知顶层 type / 未知 item type / 坏 JSON / 超长行 —— 全不崩", () => {
  assert.equal(mapCodexLine(line({ type: "thread.paused" }), { now: at }).reason, "unknown-type:thread.paused");
  assert.equal(
    mapCodexLine(line({ type: "item.started", item: { id: "z", type: "teleport" } }), { now: at }).reason,
    "unknown-item-type:teleport"
  );
  assert.equal(mapCodexLine("{bad", { now: at }).reason, "bad-json");
  assert.equal(mapCodexLine(line({ type: "turn.started", pad: "x".repeat(200) }), { now: at, maxLineBytes: 50 }).reason, "too-long");
  assert.equal(mapCodexLine(line({ type: "item.started" }), { now: at }).reason, "item-without-payload");

  // 驱动层：未知计数不崩，后续行照常
  const d = createCodexDriver({ now: at });
  d.writeLine(line({ type: "thread.paused" }));
  d.writeLine(OFFICIAL_SAMPLE[1]);
  const s = d.stats();
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.unknownReasons, { "unknown-type:thread.paused": 1 });
  assert.equal(s.events, 1);
});

test("隐私总检查：官方样本 + 常见工具行映射后，任何事件都不含命令/查询原文", () => {
  const samples = [
    ...OFFICIAL_SAMPLE,
    line({ type: "item.started", item: { id: "c", type: "command_execution", command: "curl -H 'Authorization: Bearer sk-xyz' https://x", status: "in_progress" } }),
    line({ type: "item.started", item: { id: "w", type: "web_search", query: "how to delete prod db" } }),
    line({ type: "item.started", item: { id: "m", type: "mcp_tool_call", server: "s", tool: "t", arguments: { secret: "sk-abc" } } })
  ];
  const d = createCodexDriver({ now: at });
  const all = [];
  for (const l of samples) all.push(...d.writeLine(l));
  const dump = JSON.stringify(all);
  for (const needle of ["bash -lc ls", "sk-xyz", "sk-abc", "delete prod db", "Authorization"]) {
    assert.equal(dump.includes(needle), false, `事件里不应出现 ${needle}`);
  }
});

// ── CLI 探测（假实现；真机探测见文件末尾条件用例） ──────────────────────────

const HELP_TEXT = [
  "Run Codex non-interactively",
  "  --json",
  "  -o, --output-last-message <FILE>",
  "  --output-schema <FILE>",
  "  --sandbox <SANDBOX_MODE>",
  "  --approve-for-me",
  "  --dangerously-bypass-approvals-and-sandbox"
].join("\n");

function makeFs(overrides = {}) {
  const enoent = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return { existsSync: () => false, statSync: () => enoent(), realpathSync: (p) => p, ...overrides };
}

function fakeSpawn({ version = "codex-cli 0.150.1", help = HELP_TEXT } = {}) {
  return (command, args) => {
    if (args.includes("--version")) return { status: 0, stdout: `${version}\n`, stderr: "" };
    if (args.includes("exec") && args.includes("--help")) return { status: 0, stdout: help, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("候选：显式 env 的 .js 用 node 跑；PATH 解软链；npm 全局 codex.js 兜底", () => {
  const js = "/usr/lib/node_modules/@openai/codex/bin/codex.js";
  const c = buildCodexCandidates({
    env: { [CODEX_BIN_ENV]: "/custom/codex", PATH: "/usr/bin", DSH_AGENT_NPM_ROOT: "" },
    platform: "linux",
    execPath: "/usr/bin/node",
    fs: makeFs({ statSync: (p) => ({ isFile: () => p === js, mode: 0o755 }) }),
    npmRoot: "/usr/lib/node_modules",
    isExecutable: (p) => p === "/usr/bin/codex" || p === js,
    realpath: (p) => (p === "/usr/bin/codex" ? "/real/codex" : p)
  });
  assert.deepEqual(c.map((x) => x.kind), ["explicit", "path", "npm-node"]);
  assert.equal(c[1].command, "/real/codex");
  assert.equal(c[2].command, "/usr/bin/node");
  assert.deepEqual(c[2].argsPrefix, [js]);

  const jsExplicit = buildCodexCandidates({
    env: { [CODEX_BIN_ENV]: "/custom/codex.js" },
    execPath: "/usr/bin/node",
    fs: makeFs(),
    npmRoot: ""
  });
  assert.equal(jsExplicit[0].kind, "explicit-node");
});

test("探测：正常路径 → ok + notify-only + caps 来自 exec --help", () => {
  const r = detectCodex({
    env: { [CODEX_BIN_ENV]: "/fake/codex", PATH: "" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: fakeSpawn(),
    npmRoot: ""
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "ok");
  assert.equal(r.mode, "notify-only", "exec 不能回调审批 → 只通知");
  assert.equal(r.version.text, "0.150.1");
  assert.equal(r.caps.jsonOutput, true);
  assert.equal(r.caps.structuredOutput, true);
  assert.equal(r.caps.externalApprovalHook, false);
  assert.equal(r.caps.approvalsAutoReview, true);
});

test("探测：CLI 不存在 → cli-missing；有候选但版本认不出 → version-unknown", () => {
  const missing = detectCodex({
    env: { PATH: "" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: fakeSpawn(),
    npmRoot: ""
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "cli-missing");

  const unknown = detectCodex({
    env: { [CODEX_BIN_ENV]: "/fake/codex", PATH: "" },
    platform: "linux",
    fs: makeFs(),
    spawnSync: () => ({ status: 0, stdout: "weird", stderr: "" }),
    npmRoot: ""
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, "version-unknown");
  assert.equal(unknown.attempts.length, 1);
});

test("探测：exec --help 失败不致命（ok 但要带 warning，jsonOutput 视为未确认）", () => {
  const r = detectCodex({
    env: { [CODEX_BIN_ENV]: "/fake/codex" },
    platform: "linux",
    fs: makeFs(),
    npmRoot: "",
    spawnSync: (command, args) => {
      if (args.includes("--version")) return { status: 0, stdout: "codex-cli 0.150.1", stderr: "" };
      return { status: 2, stdout: "", stderr: "help boom" };
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.version.text, "0.150.1");
  assert.equal(r.caps.jsonOutput, false, "没探到就不得声称支持");
  assert.ok(r.warnings.some((w) => w.code === "caps-probe-failed"));
});

test("探测：Windows 只认 codex.exe（不把 codex.cmd 当候选）", () => {
  const seen = [];
  buildCodexCandidates({
    env: { PATH: "C:\\Users\\x\\AppData\\Roaming\\npm" },
    platform: "win32",
    fs: makeFs(),
    npmRoot: "",
    isExecutable: (p) => {
      seen.push(path.basename(p));
      return /codex\.exe$/i.test(p);
    }
  });
  assert.deepEqual(seen, ["codex.exe"]);
});

// ── 本机真实探测（装了就跑；不调用模型、不耗额度） ──────────────────────────

const REAL_CODEX = (() => {
  try {
    const r = nodeSpawnSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (r.status === 0 && /codex/i.test(String(r.stdout || ""))) return { ok: true, raw: String(r.stdout).trim() };
    return { ok: false, raw: String(r.stdout || r.stderr || "").trim() };
  } catch {
    return { ok: false, raw: "" };
  }
})();

test(
  "本机 codex 真实探测（未安装则 SKIP）：版本 + exec --help 能力位",
  { skip: REAL_CODEX.ok ? false : `本机未安装 codex CLI（探测结果: ${REAL_CODEX.raw || "无"}）` },
  () => {
    const r = detectCodex({
      env: { ...process.env, [CODEX_BIN_ENV]: "" },
      platform: process.platform,
      npmRoot: "" // 只走 PATH：真实文件系统 + 真实 spawn，不 mock
    });
    assert.equal(r.ok, true, `探测失败: ${JSON.stringify(r.attempts || r.reason)}`);
    assert.equal(r.cli.kind, "path");
    assert.match(r.version.text, /^\d+\.\d+\.\d+$/, "版本号必须能解析（codex-cli X.Y.Z）");
    assert.equal(r.mode, "notify-only");
    assert.equal(r.caps.externalApprovalHook, false);
    // 记录实测能力位（失败时会打印）
    assert.equal(typeof r.caps.jsonOutput, "boolean");
    // 本机 0.150.1 实测有 --json/--output-schema/--approve-for-me/sandbox
    assert.equal(r.caps.jsonOutput, true, "本机实测 help 里有 --json");
    assert.equal(r.caps.structuredOutput, true, "本机实测 help 里有 --output-schema");
    assert.equal(r.caps.sandboxFlag, true, "本机实测 help 里有 --sandbox");
  }
);

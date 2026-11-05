/**
 * Codex 适配骨架（M2 第 4 周）—— 把 Codex CLI 的 `exec --json` 输出映射进**同一套 5 类事件**。
 *
 * ## 这文件是"第二家 harness"的样板
 *
 * 它只做两件事：
 *   ① `mapCodexObject`：Codex 的一行 JSON → 归一化事件（与 Claude 同一套词表）；
 *   ② `detectCodex`：找 CLI、问版本、探能力位（是否支持 `--json` / `--output-schema`）。
 *
 * **不改驱动、不改事件词表、不改审批桥** —— 这正是第 4 周要证明的事（见 `agent/README.md` 接入清单）。
 *
 * ## 依据来源（全部官方，2026-11 读取）
 *
 * | 依据 | 出处 |
 * |---|---|
 * | `exec --json` 顶层事件与样本 JSONL | <https://learn.chatgpt.com/docs/non-interactive-mode>（"Sample JSON stream" 一段，测试夹具逐字取自这里） |
 * | 顶层事件/字段权威定义 | `openai/codex` → `codex-rs/exec/src/exec_events.rs`（`ThreadEvent` / `ThreadItem` / 各 Item 结构体） |
 * | 同款 TS 类型（跨语言对照） | `openai/codex` → `sdk/typescript/src/events.ts`、`sdk/typescript/src/items.ts` |
 * | 本机 CLI 能力位（`--json` / `--output-schema` / `--approve-for-me` 是否存在） | 本机 `codex exec --help`（`codex-cli 0.150.1`，实测） |
 *
 * ## 实测校准（M2 第 5 周，**1 次真实调用**）
 *
 * 命令：`codex exec --json --sandbox read-only --skip-git-repo-check "Reply with exactly: OK"`（本机 0.150.1）。
 * 结果：CLI 退出码 **1**（本机 codex 配置的模型 `gpt-6.1-sol` 与当前 ChatGPT 账号不兼容 → 400 model_not_found），
 * 但 stdout **仍是合法 JSONL**，共 6 行，喂 `createCodexDriver` 后 **unknown=0**。实得顺序：
 *
 * ```
 * thread.started
 * item.completed(error)   ← 模型元数据警告
 * item.completed(error)   ← skills 上下文预算警告（可能多条，且**早于 turn.started**）
 * turn.started
 * error                   ← message 是**嵌套 JSON 字符串**（{"type":"error","status":400,…}）
 * turn.failed             ← error.message 同样是嵌套 JSON 字符串
 * ```
 *
 * 与官方文档样本的差异（已按实测修正/记录）：
 *   ① `item.completed(error)` 可以在 `turn.started` **之前**、可以**多条**（映射器不依赖顺序，天然兼容）；
 *   ② 顶层 `error` / `turn.failed` 的 message 是**JSON 编码的字符串** → 新增 `normalizeErrorMessage`
 *      解一层（否则手机上会显示 {"type":"error",…} 这种乱码）；
 *   ③ 正常路径（`agent_message` / `command_execution`）**本轮没拿到**（账号模型限制），
 *      仍以官方文档样本为准，等业主修正 codex 的 model 后再跑一次校准。
 *
 * ## 未核实项（**不要当成事实用**，下一轮必须实跑一次 `codex exec --json` 校准）
 *
 * 1. `item.started` 的 `command_execution` 是否一定带 `aggregated_output`（官方样本里**没有**这个字段）
 *    —— 本模块按"缺失=空串"处理。
 * 2. `item.updated` 的增量语义（官方只给了类型、没给样本）—— 本模块**忽略**，避免重复 tool.call。
 * 3. `command_execution.status` 是否会出现 `declined`（Rust 枚举有、TS 类型没有）—— 本模块未知值按 failed 处理。
 * 4. `web_search` / `file_change` / `todo_list` / `collab_tool_call` 的实际线上形状（TS 联合类型未含 collab）
 *    —— 字段按官方类型定义解析，缺字段一律降级、不崩。
 * 5. **审批不可回调**：本机 `codex exec --help` 只有 `--approve-for-me`（自动审查）与
 *    `--dangerously-bypass-approvals-and-sandbox`，**没有**"把审批交给外部程序"的开关。
 *    ⇒ exec 模式下我们只能做**只通知**（`mode:"notify-only"`）；要真审批得走 `codex app-server`
 *    （experimental，JSON-RPC 带 `approvalId`，见第 1 周报告 §3.2）——**本轮不接**。
 */

import fsSync from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync, execFileSync as nodeExecFileSync } from "node:child_process";

import {
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_PREVIEW_CHARS,
  EVENT_TYPES,
  byteLength,
  createJsonlDriver,
  frameLine,
  parseLineJson,
  previewOf
} from "./events.mjs";
import { NPM_ROOT_ENV, probeCandidateVersion, probeNpmRoot, splitPathList } from "./detect.mjs";
import { formatVersion, parseVersion } from "./version.mjs";

/** 显式指定 codex CLI（排障/企业定制）。 */
export const CODEX_BIN_ENV = "DSH_AGENT_CODEX_BIN";
/** 显式指定 npm 全局根；不设则回落到通用 `DSH_AGENT_NPM_ROOT` / 自动探测。 */
export const CODEX_NPM_ROOT_ENV = "DSH_AGENT_CODEX_NPM_ROOT";

/** 官方定义的顶层事件类型（`exec_events.rs` 的 `ThreadEvent`）。 */
export const CODEX_TOP_EVENTS = Object.freeze([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error"
]);

/** 官方定义的 item 类型（`ThreadItemDetails`）；`collab_tool_call` 仅 Rust 侧有【未核实】。 */
export const CODEX_ITEM_TYPES = Object.freeze([
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "todo_list",
  "error"
]);

/** Codex 的能力声明（detectCodex 会按本机 help 实测覆盖）。 */
export const CODEX_CAPABILITIES = Object.freeze({
  jsonOutput: true, // `codex exec --json`（官方文档 + 本机 help 实测）
  structuredOutput: true, // `--output-schema`
  resume: true, // 交互式有 resume；exec 侧续接方式【未核实】
  appServer: true, // experimental app-server（审批可路由，本轮不接）
  externalApprovalHook: false // exec 模式没有"审批回调外部程序"的开关（本机 help 实测）
});

const DEFAULT_CODEX_FS = {
  existsSync: (p) => fsSync.existsSync(p),
  statSync: (p) => fsSync.statSync(p),
  realpathSync: (p) => fsSync.realpathSync(p)
};

/** 工具语义归一（与 ACP 的 kind 词表一致，和 Claude 映射共用一套 UI 词汇）。 */
function codexToolMeta(type) {
  switch (type) {
    case "command_execution":
      return { name: "shell", kind: "execute" };
    case "file_change":
      return { name: "file_change", kind: "edit" };
    case "web_search":
      return { name: "web_search", kind: "fetch" };
    case "mcp_tool_call":
      return { name: "mcp", kind: "other" };
    case "collab_tool_call":
      return { name: "collab", kind: "other" };
    default:
      return { name: type, kind: "other" };
  }
}

/**
 * 实测（0.150.1）：顶层 `error` 与 `turn.failed` 的 message 是**JSON 字符串**（内层还有一层 error 对象）。
 * 直接进 UI 会变成乱码；这里解一层，优先取内层 `.error.message` / `.message`，解析失败原样返回。
 */
export function normalizeErrorMessage(raw) {
  const s = String(raw ?? "");
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object") {
      if (typeof obj?.error?.message === "string") return obj.error.message;
      if (typeof obj.message === "string") return obj.message;
    }
  } catch {
    /* 不是 JSON → 原样用 */
  }
  return s;
}

function isErrStatus(status) {
  return String(status || "") === "failed";
}

/** 从 MCP result.content 里取文本（只用于算字节数/截断预览）。 */
function mcpContentText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Codex 一行的**对象**映射（单行纯函数，不跨行记忆）。
 *
 * 注意：单行视角下，`item.completed` 的工类 item 会同时产出 `tool.call` + `tool.result`
 * （因为没有"上一行"可参照）。跑真实流时请用 `createCodexDriver`（内部带去重）。
 *
 * @param {object} obj
 * @param {{now?:()=>number, maxPreviewChars?:number}} [ctx]
 * @returns {{ok:true, events:object[]}|{ok:false, reason:string}}
 */
export function mapCodexObject(obj, {
  now = () => Date.now(),
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not-object" };
  const at = now();
  const base = (type) => ({ v: 1, type, at });

  switch (obj.type) {
    case "thread.started":
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "working",
          phase: "thread",
          threadId: String(obj.thread_id || "")
        }]
      };

    case "turn.started":
      return { ok: true, events: [{ ...base(EVENT_TYPES.STATUS), status: "working", phase: "turn" }] };

    case "turn.completed": {
      const u = obj.usage || {};
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.TURN_END),
          reason: "completed",
          isError: false,
          usage: {
            inputTokens: Number(u.input_tokens) || 0,
            cachedInputTokens: Number(u.cached_input_tokens) || 0,
            // 官方文档样本没有这个字段 → 缺失按 0（【未核实】线上是否总是给）
            cacheWriteInputTokens: Number(u.cache_write_input_tokens) || 0,
            outputTokens: Number(u.output_tokens) || 0,
            reasoningOutputTokens: Number(u.reasoning_output_tokens) || 0
          }
        }]
      };
    }

    case "turn.failed": {
      const msg = normalizeErrorMessage(obj?.error?.message);
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.TURN_END),
          reason: "error",
          isError: true,
          errorMessage: previewOf(msg, maxPreviewChars)
        }]
      };
    }

    case "error":
      // 事件流层面的不可恢复错误（可能伴随 turn.failed，也可能单独出现）
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "error",
          scope: "stream",
          message: previewOf(normalizeErrorMessage(obj.message), maxPreviewChars)
        }]
      };

    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapCodexItem(obj, { phase: obj.type, at, maxPreviewChars, seen: null });

    default:
      return { ok: false, reason: `unknown-type:${String(obj.type || "?")}` };
  }
}

/**
 * item 事件映射（内部）。
 *
 * @param {object} obj 顶层事件对象
 * @param {{phase:string, at:number, maxPreviewChars:number, seen:Set<string>|null}} opts
 *   seen 非空时做跨行去重（真实流场景）；null = 单行纯函数模式
 */
function mapCodexItem(obj, { phase, at, maxPreviewChars, seen }) {
  const item = obj.item;
  if (!item || typeof item !== "object") return { ok: false, reason: "item-without-payload" };
  const itemType = String(item.type || "");
  if (!itemType) return { ok: false, reason: "item-without-type" };

  const base = (type) => ({ v: 1, type, at });
  const completing = phase === "item.completed";
  const starting = phase === "item.started";
  const id = String(item.id || "");

  // 是否要发 tool.call：started 一定发；completed 只在"还没发过"时补发
  // （有状态=真实流：started 已发过就跳过；无状态=单行纯函数：completed 需要自带 call 才能表达）
  const maybeCall = () => {
    if (phase === "item.updated") return false;
    if (seen) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  };

  switch (itemType) {
    case "agent_message": {
      // 官方样本：item.completed 携带完整 text；started 的形态【未核实】→ 只在 completed 发
      if (!completing) return { ok: true, events: [] };
      const text = String(item.text ?? "");
      if (!text) return { ok: true, events: [] };
      return { ok: true, events: [{ ...base(EVENT_TYPES.MESSAGE_DELTA), text, final: true }] };
    }

    case "reasoning": {
      // 推理摘要**内容不落**（可能有命令/文件内容），只给出"在思考"与字节数
      if (!starting && !completing) return { ok: true, events: [] };
      if (seen) {
        const key = `reasoning:${id}`;
        if (seen.has(key)) return { ok: true, events: [] };
        seen.add(key);
      }
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "thinking",
          textBytes: byteLength(item.text ?? "")
        }]
      };
    }

    case "command_execution": {
      const status = String(item.status || "");
      if (!starting && !completing) return { ok: true, events: [] }; // item.updated：忽略（增量语义【未核实】）
      const events = [];
      if (maybeCall()) {
        events.push({
          ...base(EVENT_TYPES.TOOL_CALL),
          toolCallId: id,
          name: "shell",
          kind: "execute",
          // 只落**命令字节数**，不落命令原文
          inputBytes: byteLength(item.command ?? "")
        });
      }
      if (completing) {
        const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
        const out = String(item.aggregated_output ?? "");
        // 只有 completed/in_progress 算"非失败"；未知值（如 Rust 侧有、TS 没有的 declined）一律按失败
        const statusOk = status === "completed" || status === "in_progress";
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT),
          toolCallId: id,
          isError: !statusOk || (exitCode !== null && exitCode !== 0),
          exitCode,
          outputBytes: byteLength(out),
          outputPreview: previewOf(out, maxPreviewChars)
        });
      }
      return { ok: true, events };
    }

    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (!starting && !completing) return { ok: true, events: [] };
      const events = [];
      if (maybeCall()) {
        events.push({
          ...base(EVENT_TYPES.TOOL_CALL),
          toolCallId: id,
          name: "file_change",
          kind: "edit",
          inputBytes: 0,
          fileCount: changes.length
        });
      }
      if (completing) {
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT),
          toolCallId: id,
          isError: isErrStatus(item.status),
          fileCount: changes.length,
          outputBytes: 0,
          outputPreview: ""
        });
      }
      return { ok: true, events };
    }

    case "mcp_tool_call": {
      const meta = codexToolMeta(itemType);
      const fullName = `mcp:${String(item.server || "?")}/${String(item.tool || "?")}`;
      if (!starting && !completing) return { ok: true, events: [] };
      const events = [];
      if (maybeCall()) {
        events.push({
          ...base(EVENT_TYPES.TOOL_CALL),
          toolCallId: id,
          name: fullName,
          kind: meta.kind,
          inputBytes: byteLength(JSON.stringify(item.arguments ?? null))
        });
      }
      if (completing) {
        const text = mcpContentText(item.result);
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT),
          toolCallId: id,
          isError: isErrStatus(item.status) || Boolean(item.error),
          outputBytes: byteLength(text),
          outputPreview: previewOf(String(item?.error?.message || text), maxPreviewChars)
        });
      }
      return { ok: true, events };
    }

    case "web_search": {
      if (!starting && !completing) return { ok: true, events: [] };
      const events = [];
      if (maybeCall()) {
        events.push({
          ...base(EVENT_TYPES.TOOL_CALL),
          toolCallId: id,
          name: "web_search",
          kind: "fetch",
          inputBytes: byteLength(item.query ?? "")
        });
      }
      if (completing) {
        const results = Array.isArray(item.results) ? item.results : [];
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT),
          toolCallId: id,
          isError: false,
          resultCount: results.length,
          outputBytes: 0,
          outputPreview: ""
        });
      }
      return { ok: true, events };
    }

    case "collab_tool_call": {
      // 仅 Rust `ThreadItemDetails` 有；TS 联合类型未含 → 【未核实】
      const meta = codexToolMeta(itemType);
      if (!starting && !completing) return { ok: true, events: [] };
      const events = [];
      if (maybeCall()) {
        events.push({
          ...base(EVENT_TYPES.TOOL_CALL),
          toolCallId: id,
          name: `collab:${String(item.tool || "?")}`,
          kind: meta.kind,
          inputBytes: byteLength(item.prompt ?? "")
        });
      }
      if (completing) {
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT),
          toolCallId: id,
          isError: isErrStatus(item.status),
          outputBytes: 0,
          outputPreview: ""
        });
      }
      return { ok: true, events };
    }

    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items : [];
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "plan",
          planItems: items.length,
          planDone: items.filter((x) => x && x.completed === true).length
        }]
      };
    }

    case "error":
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "error",
          scope: "item",
          message: previewOf(normalizeErrorMessage(item.message), maxPreviewChars)
        }]
      };

    default:
      return { ok: false, reason: `unknown-item-type:${itemType}` };
  }
}

/**
 * Codex 一行（字符串）的映射（单行纯函数）。
 * @param {string} line
 * @param {{now?:()=>number, maxLineBytes?:number, maxPreviewChars?:number}} [opts]
 */
export function mapCodexLine(line, {
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  const framed = frameLine(line, { maxLineBytes });
  if (!framed.ok) return framed;
  const parsed = parseLineJson(framed.raw);
  if (!parsed.ok) return parsed;
  return mapCodexObject(parsed.obj, { now, maxPreviewChars });
}

/**
 * 有状态映射器（给真实流用）：跨行记住已发过 tool.call 的 item id，避免 started/completed 重复。
 * @param {{now?:()=>number, maxPreviewChars?:number}} [opts]
 */
export function createCodexMapper({ now = () => Date.now(), maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS } = {}) {
  const seen = new Set();
  return function mapCodexObjectStateful(obj, ctx = {}) {
    const useNow = typeof ctx.now === "function" ? ctx.now : now;
    const usePreview = Number.isFinite(ctx.maxPreviewChars) ? ctx.maxPreviewChars : maxPreviewChars;
    if (!obj || typeof obj !== "object") return { ok: false, reason: "not-object" };
    const at = useNow();
    if (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") {
      return mapCodexItem(obj, { phase: obj.type, at, maxPreviewChars: usePreview, seen });
    }
    return mapCodexObject(obj, { now: useNow, maxPreviewChars: usePreview });
  };
}

/**
 * 现成的 Codex 事件驱动（与 `createEventMapper` 同构，只是换了 mapLine）。
 * @param {{sink?:object, onEvent?:Function, onUnknown?:Function, now?:()=>number,
 *          maxLineBytes?:number, maxPreviewChars?:number}} [opts]
 */
export function createCodexDriver({
  sink = null,
  onEvent,
  onUnknown,
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  return createJsonlDriver({
    mapLine: createCodexMapper({ now, maxPreviewChars }),
    sink,
    onEvent,
    onUnknown,
    now,
    maxLineBytes,
    maxPreviewChars,
    driverName: "codex"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI 探测（找 codex / 问版本 / 探能力位）—— 复刻 Claude 那套"永远不抛错"的风格
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造候选（按优先级）。codex 的 npm 包 bin 是 **Node 脚本** `bin/codex.js`
 * （本机实测：`/opt/homebrew/bin/codex` → `@openai/codex/bin/codex.js`），
 * 它在内部自己 `spawn` 平台原生二进制；所以"用 node 跑 codex.js"是跨平台最稳的一条。
 *
 * @returns {Array<{kind:string, command:string, argsPrefix:string[], pathHint?:string}>}
 */
export function buildCodexCandidates({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_CODEX_FS,
  npmRoot = "",
  isExecutable,
  realpath
} = {}) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const key = `${c.command}:${(c.argsPrefix || []).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const isExec =
    typeof isExecutable === "function"
      ? isExecutable
      : (p) => {
          try {
            const st = fs.statSync(p);
            if (!st.isFile()) return false;
            if (platform === "win32") return /\.exe$/i.test(p);
            return (Number(st.mode) & 0o111) !== 0;
          } catch {
            return false;
          }
        };
  const real = typeof realpath === "function" ? realpath : (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };

  // 1) 显式覆盖：.js/.cjs/.mjs 用 node 跑，其余当可执行直接跑
  const explicit = String(env?.[CODEX_BIN_ENV] ?? "").trim();
  if (explicit) {
    if (/\.(c|m)?js$/i.test(explicit)) {
      push({ kind: "explicit-node", command: execPath, argsPrefix: [explicit], pathHint: explicit });
    } else {
      push({ kind: "explicit", command: explicit, argsPrefix: [], pathHint: explicit });
    }
  }

  // 2) PATH。posix 解软链；Windows 只认 codex.exe（.cmd 无 shell 跑不了，同 Claude 的理由）
  for (const dir of splitPathList(env?.PATH, platform)) {
    const names = platform === "win32" ? ["codex.exe"] : ["codex"];
    for (const name of names) {
      const p = path.join(dir, name);
      if (!isExec(p)) continue;
      push({ kind: "path", command: platform === "win32" ? p : real(p), argsPrefix: [], pathHint: p });
      break;
    }
  }

  // 3) npm 全局包里的 Node 启动器（跨平台最稳；它会自己找平台原生二进制）
  if (npmRoot) {
    const js = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
    try {
      if (fs.statSync(js).isFile()) {
        push({ kind: "npm-node", command: execPath, argsPrefix: [js], pathHint: js });
      }
    } catch {
      /* 不存在就跳过 */
    }
  }
  return out;
}

/**
 * 探能力位：跑一次 `exec --help` 看有哪些开关（**不调用模型**）。
 * @returns {{ok:boolean, caps:object, evidence:object, reason?:string}}
 */
export function probeCodexCaps(candidate, { spawnSync = nodeSpawnSync, timeoutMs = 10_000 } = {}) {
  const caps = { ...CODEX_CAPABILITIES, jsonOutput: false, structuredOutput: false, externalApprovalHook: false };
  try {
    const r = spawnSync(candidate.command, [...(candidate.argsPrefix || []), "exec", "--help"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const text = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
    if (r?.error || (typeof r?.status === "number" && r.status !== 0) || !text.trim()) {
      return { ok: false, caps, evidence: { helpTextLength: text.length }, reason: `exec --help 失败（${r?.error?.code || r?.status || "空输出"}）` };
    }
    caps.jsonOutput = /--json\b/.test(text);
    caps.structuredOutput = /--output-schema\b/.test(text);
    caps.approvalsAutoReview = /--approve-for-me\b/.test(text);
    caps.sandboxFlag = /--sandbox\b/.test(text);
    caps.externalApprovalHook = false; // 仅当出现"把审批交给外部程序"的开关才置 true（当前官方没有）
    return {
      ok: true,
      caps,
      evidence: {
        helpTextLength: text.length,
        matched: {
          json: caps.jsonOutput,
          outputSchema: caps.structuredOutput,
          approveForMe: Boolean(caps.approvalsAutoReview),
          sandbox: Boolean(caps.sandboxFlag)
        }
      }
    };
  } catch (err) {
    return { ok: false, caps, evidence: {}, reason: `能力探测异常: ${err?.code || err?.message || err}` };
  }
}

/**
 * 一站式探测：找 CLI → 问版本 → 探 `exec --help` 能力位。**永远不抛错**。
 *
 * 状态：`ok` | `cli-missing` | `version-unknown` | `error`
 * 注意：即使 `ok:true`，`mode` 也是 **`notify-only`** —— exec 模式没有审批回调开关（见文件头 5）。
 */
export function detectCodex({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_CODEX_FS,
  spawnSync = nodeSpawnSync,
  execFileSync = nodeExecFileSync,
  npmRoot,
  probeTimeoutMs = 10_000,
  probeCaps = true,
  isExecutable,
  realpath
} = {}) {
  const warnings = [];
  let root = npmRoot;
  if (root === undefined) {
    // 显式 env > 通用 env > 复用 Claude 那套 npm root 探测（同一份路径启发式）
    root =
      String(env?.[CODEX_NPM_ROOT_ENV] ?? "").trim() ||
      String(env?.[NPM_ROOT_ENV] ?? "").trim() ||
      probeNpmRoot({ execFileSync, platform, env, fs, execPath });
  }

  let candidates;
  try {
    candidates = buildCodexCandidates({ env, platform, execPath, fs, npmRoot: root, isExecutable, realpath });
  } catch (err) {
    return { ok: false, status: "error", mode: "notify-only", reason: `构建候选异常: ${err?.message || err}`, caps: { ...CODEX_CAPABILITIES } };
  }

  const attempts = [];
  for (const c of candidates) {
    const r = probeCandidateVersion(c, { spawnSync, timeoutMs: probeTimeoutMs });
    attempts.push({ kind: c.kind, path: c.pathHint || c.command, ok: r.ok, reason: r.ok ? "" : r.reason });
    if (!r.ok) continue;

    const capsResult = probeCaps
      ? probeCodexCaps(c, { spawnSync, timeoutMs: probeTimeoutMs })
      : { ok: true, caps: { ...CODEX_CAPABILITIES }, evidence: {} };
    if (!capsResult.ok) warnings.push({ code: "caps-probe-failed", message: capsResult.reason });

    return {
      ok: true,
      status: "ok",
      // exec 模式只能只通知（审批需 app-server，本轮不接）
      mode: "notify-only",
      cli: { kind: c.kind, path: c.pathHint || c.command, command: c.command, argsPrefix: c.argsPrefix || [] },
      version: { ...r.version, text: formatVersion(r.version) },
      caps: capsResult.caps,
      capsEvidence: capsResult.evidence,
      attempts,
      warnings
    };
  }

  return {
    ok: false,
    status: candidates.length ? "version-unknown" : "cli-missing",
    mode: "notify-only",
    reason: candidates.length
      ? "找到了 codex 候选但都拿不到版本（安装损坏？或 --version 输出形态变了）"
      : "没有找到 Codex CLI（未安装，或不在 PATH / npm 全局目录里）",
    caps: { ...CODEX_CAPABILITIES },
    attempts,
    warnings
  };
}

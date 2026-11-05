/**
 * 事件映射（M2 第 3 周 · 最小集）—— 把 `claude --output-format stream-json` 的每一行
 * 映射成设计稿 7 事件里的 **5 种**，并可选落 jsonl。
 *
 * ## 为什么只要 5 种（而不是 7 种）
 *
 * 设计稿 §2.4 的 7 种里，`assistant.final` 与 `permission.request` 在本层**不需要单独成事件**：
 *   · 完整助手消息 = `message.delta{final:true}`（本轮已实测：`assistant` 行就是完整消息）；
 *   · 审批请求走的是**钩子**（PermissionBridge），不是 stdout —— 两条通道各管一段，互不混淆。
 * 少两种事件 = 少两份 UI 状态机，符合"能落地的最小抽象"。
 *
 * | 归一化事件 | 来源（实测字段） |
 * |---|---|
 * | `status` | `system/init`、`system/hook_started|hook_response`、`system/api_retry` |
 * | `message.delta` | `assistant.message.content[].text`（final=true）、`stream_event` 的 `text_delta`（final=false） |
 * | `tool.call` | `assistant.message.content[].tool_use`（只留 id/name/kind/输入字节数） |
 * | `tool.result` | `user.message.content[].tool_result`（只留 isError/输出字节数/截断预览） |
 * | `turn.end` | `result` 行（success / error / max_turns / interrupted） |
 *
 * ## 三条硬规矩
 *
 * ① **未知形状不许崩**：未知 `type`/`subtype`、坏 JSON、超长行 → 计数后丢弃（`stats`），
 *    绝不让一行意外输出把整条会话的采集带死。
 * ② **不记录命令原文**：`tool.call` 只带 `inputBytes`（输入 JSON 的字节数），**不带 input 内容**。
 *    `tool.result` 只带**截断预览**（默认 120 字符，可调到 0 关闭）。
 * ③ **默认不启用**：没有 `filePath` 的 sink 什么都不写；落盘失败**静默**（计数 + 只告警一次），
 *    磁盘满/不可写绝不能影响正在跑的会话。
 */

import fsSync from "node:fs";

import { toolKindOf } from "./permission-bridge.mjs";

/** 归一化事件类型（封版；加第 6 种属于破坏性变更）。 */
export const EVENT_TYPES = Object.freeze({
  STATUS: "status",
  MESSAGE_DELTA: "message.delta",
  TOOL_CALL: "tool.call",
  TOOL_RESULT: "tool.result",
  TURN_END: "turn.end"
});

/** 单行上限：stream-json 单行通常 < 64KB；超过这个数多半不是我们认识的输出。 */
export const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
/** tool_result 预览上限（字符）。设 0 = 完全不带输出内容。 */
export const DEFAULT_MAX_PREVIEW_CHARS = 120;

/** `result.subtype` → 归一化 turn.end reason。 */
export function turnReasonOf(result) {
  const subtype = String(result?.subtype || "");
  if (result?.is_error) return "error";
  if (subtype === "success") {
    const terminal = String(result?.terminal_reason || "");
    if (terminal === "aborted") return "aborted";
    if (terminal === "interrupted") return "interrupted";
    return "completed";
  }
  if (subtype.includes("max_turns")) return "max-turns";
  if (subtype.includes("interrupt")) return "interrupted";
  if (subtype.includes("abort")) return "aborted";
  if (subtype.startsWith("error")) return "error";
  return subtype || "completed";
}

/** 从 tool_result 的 content（string / 数组 / 对象）里取文本。 */
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          if (typeof c.text === "string") return c.text;
          if (typeof c.content === "string") return c.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function byteLength(s) {
  return Buffer.byteLength(String(s ?? ""), "utf8");
}

/**
 * 把一行 stream-json 映射成 0..n 个归一化事件。
 *
 * 返回 `{ok, events}` 或 `{ok:false, reason}`；**永远不抛错**。
 *
 * @param {string} line
 * @param {{now?:()=>number, maxLineBytes?:number, maxPreviewChars?:number}} [opts]
 */
export function mapStreamJsonLine(line, {
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  const raw = String(line ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (byteLength(raw) > maxLineBytes) return { ok: false, reason: "too-long" };

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not-object" };

  const at = now();
  const events = [];
  const base = (type) => ({ v: 1, type, at });

  switch (obj.type) {
    case "system": {
      const subtype = String(obj.subtype || "");
      if (subtype === "init") {
        events.push({
          ...base(EVENT_TYPES.STATUS),
          status: "working",
          sessionId: typeof obj.session_id === "string" ? obj.session_id : "",
          permissionMode: typeof obj.permissionMode === "string" ? obj.permissionMode : "",
          toolCount: Array.isArray(obj.tools) ? obj.tools.length : 0
        });
      } else if (subtype === "hook_started" || subtype === "hook_response") {
        // 审批钩子的生命周期（E2E/排障用；不含任何命令内容）
        events.push({
          ...base(EVENT_TYPES.STATUS),
          status: "hook",
          hookPhase: subtype === "hook_started" ? "started" : "finished",
          hookEvent: String(obj.hook_event || "")
        });
      } else if (subtype === "api_retry") {
        events.push({
          ...base(EVENT_TYPES.STATUS),
          status: "retrying",
          attempt: Number(obj.attempt) || 0,
          retryDelayMs: Number(obj.retry_delay_ms) || 0
        });
      } else if (subtype === "permission_denied") {
        /*
         * 实测形状（2.1.318，deny 之后由 CLI 自己发出）：
         *   {type:"system",subtype:"permission_denied",tool_name,tool_use_id,
         *    decision_reason_type:"hook"|…, decision_reason:"<我们的 deny message>", message}
         * 这是"审批被拒"的权威回执，手机上/审计里都该能看到；reason 是**判定理由**（不是命令原文）。
         */
        events.push({
          ...base(EVENT_TYPES.STATUS),
          status: "denied",
          toolName: String(obj.tool_name || ""),
          toolCallId: String(obj.tool_use_id || ""),
          reasonType: String(obj.decision_reason_type || ""),
          reason: String(obj.decision_reason || obj.message || "").slice(0, 120)
        });
      } else if (subtype === "thinking_tokens") {
        // 一次会话里能有几十条；落盘没有价值，直接忽略（也不算 unknown）
        return { ok: true, events: [] };
      } else {
        return { ok: false, reason: `unknown-system-subtype:${subtype || "?"}` };
      }
      break;
    }

    case "stream_event": {
      const ev = obj.event || {};
      const delta = ev.delta || {};
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        events.push({ ...base(EVENT_TYPES.MESSAGE_DELTA), text: delta.text, final: false });
      } else {
        return { ok: false, reason: "unknown-stream-event" };
      }
      break;
    }

    case "assistant": {
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return { ok: false, reason: "assistant-without-content" };
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          if (!block.text) continue;
          events.push({ ...base(EVENT_TYPES.MESSAGE_DELTA), text: block.text, final: true });
        } else if (block.type === "tool_use") {
          const input = block.input;
          events.push({
            ...base(EVENT_TYPES.TOOL_CALL),
            toolCallId: String(block.id || ""),
            name: String(block.name || ""),
            kind: toolKindOf(block.name),
            // 只留大小，**不留内容**（命令原文不进日志）
            inputBytes: input === undefined ? 0 : byteLength(JSON.stringify(input))
          });
        }
      }
      break;
    }

    case "user": {
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return { ok: false, reason: "user-without-content" };
      for (const block of content) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        const text = textOfContent(block.content);
        const preview = maxPreviewChars > 0 ? text.slice(0, maxPreviewChars) : "";
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT),
          toolCallId: String(block.tool_use_id || ""),
          isError: block.is_error === true,
          outputBytes: byteLength(text),
          outputPreview: preview
        });
      }
      break;
    }

    case "result": {
      events.push({
        ...base(EVENT_TYPES.TURN_END),
        reason: turnReasonOf(obj),
        isError: obj.is_error === true,
        durationMs: Number(obj.duration_ms) || 0,
        numTurns: Number(obj.num_turns) || 0,
        sessionId: typeof obj.session_id === "string" ? obj.session_id : ""
      });
      break;
    }

    default:
      return { ok: false, reason: `unknown-type:${String(obj.type || "?")}` };
  }

  return { ok: true, events };
}

const DEFAULT_SINK_FS = {
  appendFileSync: (p, data, opts) => fsSync.appendFileSync(p, data, opts)
};

/**
 * append-only jsonl 落盘（**默认不启用**：不给 filePath 就什么都不写）。
 *
 * 落盘失败**静默**：只计数 + 告警一次，绝不抛回调用方（磁盘满不能影响正在跑的会话）。
 *
 * @param {{filePath?:string, fs?:object, log?:(e:object)=>void, now?:()=>number}} opts
 */
export function createJsonlSink({ filePath, fs = DEFAULT_SINK_FS, log, now = () => Date.now() } = {}) {
  const enabled = Boolean(filePath);
  const logger = typeof log === "function" ? log : () => {};
  const stats = { enabled, events: 0, bytes: 0, writeErrors: 0, firstErrorAt: 0, lastError: "" };
  let warned = false;

  return {
    enabled,
    filePath: enabled ? filePath : "",
    write(event) {
      if (!enabled) return false;
      let line;
      try {
        line = JSON.stringify(event) + "\n";
      } catch {
        stats.writeErrors += 1;
        return false;
      }
      try {
        fs.appendFileSync(filePath, line, { encoding: "utf8" });
        stats.events += 1;
        stats.bytes += byteLength(line);
        return true;
      } catch (err) {
        stats.writeErrors += 1;
        if (!stats.firstErrorAt) stats.firstErrorAt = now();
        stats.lastError = String(err?.code || err?.message || err).slice(0, 120);
        if (!warned) {
          warned = true;
          try {
            logger({ level: "warn", event: "events.sink-error", error: stats.lastError });
          } catch {
            /* 日志失败也不影响 */
          }
        }
        return false;
      }
    },
    stats() {
      return { ...stats };
    }
  };
}

/**
 * 有状态映射器：逐行喂入，自动编号 `seq`、可选的 `onEvent` 回调与 sink 落盘。
 *
 * @param {{sink?:object, onEvent?:(e:object)=>void, now?:()=>number,
 *          maxLineBytes?:number, maxPreviewChars?:number, sessionId?:string}} [opts]
 */
export function createEventMapper({
  sink = null,
  onEvent,
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  let seq = 0;
  const stats = {
    lines: 0,
    events: 0,
    badJson: 0,
    tooLong: 0,
    empty: 0,
    unknown: 0,
    byType: Object.create(null),
    byReason: Object.create(null),
    // 未识别原因（排障用：到底是哪种新事件让我们丢了一行）
    unknownReasons: Object.create(null)
  };
  const notify = typeof onEvent === "function" ? onEvent : null;

  return {
    /** 喂一行；返回本行产出的事件数组（可能为空）。永不抛错。 */
    writeLine(line) {
      stats.lines += 1;
      const r = mapStreamJsonLine(line, { now, maxLineBytes, maxPreviewChars });
      if (!r.ok) {
        if (r.reason === "bad-json") stats.badJson += 1;
        else if (r.reason === "too-long") stats.tooLong += 1;
        else if (r.reason === "empty") stats.empty += 1;
        else {
          stats.unknown += 1;
          const key = String(r.reason || "unknown").slice(0, 80);
          stats.unknownReasons[key] = (stats.unknownReasons[key] || 0) + 1;
        }
        return [];
      }
      const out = [];
      for (const ev of r.events) {
        seq += 1;
        const full = { ...ev, seq };
        stats.events += 1;
        stats.byType[full.type] = (stats.byType[full.type] || 0) + 1;
        if (full.type === EVENT_TYPES.TURN_END) {
          stats.byReason[full.reason] = (stats.byReason[full.reason] || 0) + 1;
        }
        if (sink) sink.write(full);
        if (notify) {
          try {
            notify(full);
          } catch {
            /* 回调抛错不能影响采集 */
          }
        }
        out.push(full);
      }
      return out;
    },
    stats() {
      return {
        ...stats,
        byType: { ...stats.byType },
        byReason: { ...stats.byReason },
        unknownReasons: { ...stats.unknownReasons }
      };
    }
  };
}

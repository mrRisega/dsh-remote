/**
 * 事件映射（M2 第 4 周：**驱动通用化**）—— 一份「jsonl 驱动」+ 一份「Claude 映射」。
 *
 * ## 分层（接第二家只需要换 mapLine）
 *
 * ```
 * 子进程 stdout（逐行 JSON）
 *      │
 *      ▼
 * createJsonlDriver({ mapLine, sink, onUnknown })   ← 通用：分帧/解析/统计/落盘/seq/未知兜底
 *      │                                              （不认识任何一家 CLI）
 *      ▼
 * mapLine(obj, { now, maxPreviewChars })             ← 一家一份：Claude=mapClaudeObject、Codex=mapCodexObject
 *      │
 *      ▼
 * 5 类归一化事件：status / message.delta / tool.call / tool.result / turn.end
 * ```
 *
 * 换句话说：**驱动不懂 Claude，也不懂 Codex**；换 harness 只换 `mapLine`（见 `agent/README.md` 接入清单）。
 * 这是设计稿"2 个驱动（jsonl + acp）+ 1 套事件模型"里 jsonl 那半个驱动的落地。
 *
 * ## 三条硬规矩（沿用第 3 周，不变）
 *
 * ① **未知形状不许崩**：未知 type/字段、坏 JSON、超长行、甚至 `mapLine` 自己抛错 → 计数后丢弃，
 *    绝不让一行意外输出把整条会话的采集带死。
 * ② **不记录命令原文**：`tool.call` 只带输入**字节数**；`tool.result` 只带截断预览（默认 120 字符）。
 * ③ **默认不启用**：没有 `filePath` 的 sink 什么都不写；落盘失败**静默**（计数 + 只告警一次）。
 *
 * ## 对外行为承诺
 *
 * `mapStreamJsonLine` / `createEventMapper` / `createJsonlSink` / `EVENT_TYPES` / `turnReasonOf`
 * 都是第 3 周就有的公开 API，**行为保持不变**（第 3 周的 18 条用例继续守它们）；
 * 本轮新增的是 `createJsonlDriver`、`mapClaudeLine`、`mapClaudeObject`。
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

/** 单行上限：正常 stream-json 单行 < 64KB；超过这个数多半不是我们认识的输出。 */
export const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
/** tool_result 预览上限（字符）。设 0 = 完全不带输出内容。 */
export const DEFAULT_MAX_PREVIEW_CHARS = 120;

/** `result.subtype` → 归一化 turn.end reason（Claude 专用，保留导出供测试/复用）。 */
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

/** UTF-8 字节数（隐私策略用"字节数"而不是内容）。 */
export function byteLength(s) {
  return Buffer.byteLength(String(s ?? ""), "utf8");
}

/** 截断预览（0 表示不带内容）。 */
export function previewOf(text, maxPreviewChars) {
  if (!(maxPreviewChars > 0)) return "";
  return String(text ?? "").slice(0, maxPreviewChars);
}

/** 归一化事件的基础字段。`at` 由各 mapper 打（便于单测固定时钟），`v/seq` 由驱动补。 */
function base(type, at) {
  return { v: 1, type, at };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code（stream-json）映射
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claude Code 一行的**对象**映射（驱动解析完 JSON 后调用）。
 *
 * 返回 `{ok:true, events}` 或 `{ok:false, reason}`；**永远不抛错**。
 *
 * @param {object} obj 已解析的 stream-json 对象
 * @param {{now?:()=>number, maxPreviewChars?:number}} [ctx]
 */
export function mapClaudeObject(obj, {
  now = () => Date.now(),
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not-object" };

  const at = now();
  const events = [];

  switch (obj.type) {
    case "system": {
      const subtype = String(obj.subtype || "");
      if (subtype === "init") {
        events.push({
          ...base(EVENT_TYPES.STATUS, at),
          status: "working",
          sessionId: typeof obj.session_id === "string" ? obj.session_id : "",
          permissionMode: typeof obj.permissionMode === "string" ? obj.permissionMode : "",
          toolCount: Array.isArray(obj.tools) ? obj.tools.length : 0
        });
      } else if (subtype === "hook_started" || subtype === "hook_response") {
        // 审批钩子的生命周期（E2E/排障用；不含任何命令内容）
        events.push({
          ...base(EVENT_TYPES.STATUS, at),
          status: "hook",
          hookPhase: subtype === "hook_started" ? "started" : "finished",
          hookEvent: String(obj.hook_event || "")
        });
      } else if (subtype === "api_retry") {
        events.push({
          ...base(EVENT_TYPES.STATUS, at),
          status: "retrying",
          attempt: Number(obj.attempt) || 0,
          retryDelayMs: Number(obj.retry_delay_ms) || 0
        });
      } else if (subtype === "permission_denied") {
        /*
         * 实测形状（2.1.318，deny 之后由 CLI 自己发出）：
         *   {type:"system",subtype:"permission_denied",tool_name,tool_use_id,
         *    decision_reason_type:"hook"|…, decision_reason:"<我们的 deny message>", message}
         * 这是"审批被拒"的权威回执；reason 是**判定理由**（不是命令原文）。
         */
        events.push({
          ...base(EVENT_TYPES.STATUS, at),
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
        events.push({ ...base(EVENT_TYPES.MESSAGE_DELTA, at), text: delta.text, final: false });
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
          events.push({ ...base(EVENT_TYPES.MESSAGE_DELTA, at), text: block.text, final: true });
        } else if (block.type === "tool_use") {
          const input = block.input;
          events.push({
            ...base(EVENT_TYPES.TOOL_CALL, at),
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
        events.push({
          ...base(EVENT_TYPES.TOOL_RESULT, at),
          toolCallId: String(block.tool_use_id || ""),
          isError: block.is_error === true,
          outputBytes: byteLength(text),
          outputPreview: previewOf(text, maxPreviewChars)
        });
      }
      break;
    }

    case "result": {
      events.push({
        ...base(EVENT_TYPES.TURN_END, at),
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

/**
 * Claude Code 一行（字符串）的映射 —— 保留第 3 周的公开入口。
 *
 * @param {string} line
 * @param {{now?:()=>number, maxLineBytes?:number, maxPreviewChars?:number}} [opts]
 */
export function mapClaudeLine(line, {
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  const framed = frameLine(line, { maxLineBytes });
  if (!framed.ok) return framed;
  const parsed = parseLineJson(framed.raw);
  if (!parsed.ok) return parsed;
  return mapClaudeObject(parsed.obj, { now, maxPreviewChars });
}

/**
 * 第 3 周的旧名字 —— **行为完全一致**，保留给既有调用方/用例。
 * @deprecated 用 `mapClaudeLine`（明确"这是 Claude 的映射"）。
 */
export const mapStreamJsonLine = mapClaudeLine;

// ─────────────────────────────────────────────────────────────────────────────
// 通用 jsonl 驱动
// ─────────────────────────────────────────────────────────────────────────────

/** 分帧：去空白 → 空行 / 超长行判定（两家 CLI 同样的规矩）。 */
export function frameLine(line, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  const raw = String(line ?? "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (byteLength(raw) > maxLineBytes) return { ok: false, reason: "too-long" };
  return { ok: true, raw };
}

/** 解析 JSON：坏 JSON 只返回 reason，不抛。 */
export function parseLineJson(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { ok: false, reason: "not-object" };
    return { ok: true, obj };
  } catch {
    return { ok: false, reason: "bad-json" };
  }
}

/**
 * **通用 jsonl 驱动**：分帧 → 解析 JSON → `mapLine(obj, ctx)` → 归一化信封（v/seq）→ sink/回调。
 *
 * 驱动不认识任何一家 CLI；`mapLine` 返回 `{ok:true, events:[{type,...}]}` 或 `{ok:false, reason}`。
 * `mapLine` 自己抛错也会被兜住（记 `mapperErrors`，走 `onUnknown`），**不向上抛**。
 *
 * @param {object} opts
 * @param {(obj:object, ctx:{now:()=>number, maxPreviewChars:number}) => {ok:boolean, events?:object[], reason?:string}} opts.mapLine
 * @param {{write:(e:object)=>boolean}} [opts.sink] 落盘（见 createJsonlSink）
 * @param {(e:object)=>void} [opts.onEvent]          每条归一化事件回调
 * @param {(reason:string, raw:string)=>void} [opts.onUnknown] 未识别行回调
 * @param {()=>number} [opts.now]
 * @param {number} [opts.maxLineBytes]
 * @param {number} [opts.maxPreviewChars]
 * @param {string} [opts.driverName] 统计用（claude / codex / …）
 */
export function createJsonlDriver({
  mapLine,
  sink = null,
  onEvent,
  onUnknown,
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS,
  driverName = "jsonl"
} = {}) {
  if (typeof mapLine !== "function") throw new Error("createJsonlDriver: 缺少 mapLine");
  let seq = 0;
  const stats = {
    driverName,
    lines: 0,
    events: 0,
    badJson: 0,
    tooLong: 0,
    empty: 0,
    unknown: 0,
    mapperErrors: 0,
    byType: Object.create(null),
    byReason: Object.create(null),
    // 未识别原因（排障用：到底是哪种新事件让我们丢了一行）
    unknownReasons: Object.create(null)
  };
  const notifyEvent = typeof onEvent === "function" ? onEvent : null;
  const notifyUnknown = typeof onUnknown === "function" ? onUnknown : null;

  function countUnknown(reason) {
    stats.unknown += 1;
    const key = String(reason || "unknown").slice(0, 80);
    stats.unknownReasons[key] = (stats.unknownReasons[key] || 0) + 1;
  }

  return {
    /** 喂一行；返回本行产出的事件数组（可能为空）。永不抛错。 */
    writeLine(line) {
      stats.lines += 1;
      const framed = frameLine(line, { maxLineBytes });
      if (!framed.ok) {
        if (framed.reason === "too-long") stats.tooLong += 1;
        else stats.empty += 1;
        return [];
      }
      const parsed = parseLineJson(framed.raw);
      if (!parsed.ok) {
        if (parsed.reason === "bad-json") stats.badJson += 1;
        else countUnknown(parsed.reason);
        return [];
      }

      let result;
      try {
        result = mapLine(parsed.obj, { now, maxPreviewChars });
      } catch (err) {
        stats.mapperErrors += 1;
        countUnknown(`mapper-error:${String(err?.message || err).slice(0, 60)}`);
        if (notifyUnknown) {
          try {
            notifyUnknown("mapper-error", framed.raw);
          } catch {
            /* 回调抛错不影响采集 */
          }
        }
        return [];
      }

      if (!result || result.ok !== true || !Array.isArray(result.events)) {
        const reason = String(result?.reason || "unknown");
        countUnknown(reason);
        if (notifyUnknown) {
          try {
            notifyUnknown(reason, framed.raw);
          } catch {
            /* 同上 */
          }
        }
        return [];
      }

      const out = [];
      for (const ev of result.events) {
        if (!ev || typeof ev !== "object" || typeof ev.type !== "string") {
          countUnknown("bad-event");
          continue;
        }
        seq += 1;
        const full = { v: 1, ...ev, seq };
        stats.events += 1;
        stats.byType[full.type] = (stats.byType[full.type] || 0) + 1;
        if (full.type === EVENT_TYPES.TURN_END) {
          stats.byReason[full.reason] = (stats.byReason[full.reason] || 0) + 1;
        }
        if (sink) sink.write(full);
        if (notifyEvent) {
          try {
            notifyEvent(full);
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

// ─────────────────────────────────────────────────────────────────────────────
// jsonl 落盘
// ─────────────────────────────────────────────────────────────────────────────

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
 * Claude Code 的现成映射器（第 3 周 API，行为保持不变）。
 *
 * @param {{sink?:object, onEvent?:(e:object)=>void, onUnknown?:Function, now?:()=>number,
 *          maxLineBytes?:number, maxPreviewChars?:number}} [opts]
 */
export function createEventMapper({
  sink = null,
  onEvent,
  onUnknown,
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  return createJsonlDriver({
    mapLine: mapClaudeObject,
    sink,
    onEvent,
    onUnknown,
    now,
    maxLineBytes,
    maxPreviewChars,
    driverName: "claude"
  });
}

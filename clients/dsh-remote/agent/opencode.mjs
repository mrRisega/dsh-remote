/**
 * OpenCode 适配骨架（**HTTP server + SSE 事件流**，M2 第 5 周）。
 *
 * ## 和 jsonl 两家最大的不同：事件是 **SSE**，不是 stdout 行
 *
 * `opencode serve` 把它的事件挂在 `GET /event`（Server-Sent Events）上；回合结束、工具状态、
 * 审批请求都从这条流里来。**不能直接喂 `createJsonlDriver`** —— SSE 有自己的分帧（`data: {...}\n\n`、
 * 注释行心跳、多行 data）。所以本模块提供三层：
 *
 * ```
 * HTTP 响应流(SSE)  ──createSseParser──▶  {event, data}  ──mapOpenCodeObject──▶ 5 类事件
 *                         ↑ SSE 分帧/心跳/坏 JSON 兜底                ↑ 一家一份
 *                attachOpenCodeSse({stream, driver})  ← 把手接起来的薄胶水
 * ```
 *
 * **为什么要桥接而不是直接改驱动**：通用驱动（`events.mjs`）吃的是"一行一个 JSON"，
 * 它的假设（行=对象、坏 JSON 计数）正好等于 SSE 的 *data 载荷*。因此桥接层只负责"SSE → 一行 JSON"，
 * 之后仍然复用同一个驱动（seq/统计/sink/未知兜底全部不改）——这正是"2 个驱动 4 家"的中间形态。
 *
 * ## 依据来源（官方，2026-11 读取）
 *
 * | 依据 | 出处 |
 * |---|---|
 * | Server API（`GET /event` SSE、`POST /session/:id/permissions/:permissionID`、`prompt_async`、`session.idle` 语义） | <https://opencode.ai/docs/server/> |
 * | 事件与 Part 的**权威字段定义**（`Event` 联合、`message.part.updated`、`permission.updated`、`ToolState`…） | npm 包 `@opencode-ai/sdk@1.19.5` 的 `dist/gen/types.gen.d.ts`（官方发布产物，逐字对照） |
 * | 官方文档里该类型的链接 | 同 docs/server 指向 `packages/sdk/js/src/gen/types.gen.ts`（v2 仓库重构后该路径已变，故改用 npm 产物） |
 *
 * ## 未核实项（**不要当事实**）
 *
 * 1. 本机**未安装** OpenCode（探测会 SKIP）；以下都是"按官方类型定义映射"，**没有真实事件流校准**。
 * 2. SSE 分帧里 OpenCode 是否带 `event:` 行（本模块两种都吃：有 event 名则忽略，只认 data）。
 * 3. `message.part.updated` 是否既发"全量 text"又发 `delta` —— 本模块优先用 `delta`（增量），
 *    否则把 `text` 当完整段落（final=true），下游需要按 `part.id` 去重（下一步做）。
 * 4. `session.idle` 是否等价于"回合结束"（文档语义是，但未实测多 agent/子会话场景）。
 * 5. `permission.updated` 的 `pattern` 可能含命令片段 → **不落**；`title` 是 agent 文案 → 也**不落**。
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
  previewOf
} from "./events.mjs";
import { NPM_ROOT_ENV, probeCandidateVersion, probeNpmRoot, splitPathList } from "./detect.mjs";
import { formatVersion } from "./version.mjs";

/** 显式指定 opencode CLI。 */
export const OPENCODE_BIN_ENV = "DSH_AGENT_OPENCODE_BIN";
/** 显式指定 npm 全局根。 */
export const OPENCODE_NPM_ROOT_ENV = "DSH_AGENT_OPENCODE_NPM_ROOT";

/** 我们认识的顶层事件（其余按"忽略"处理，未知形状才计 unknown）。 */
export const OPENCODE_EVENTS = Object.freeze([
  "server.connected",
  "session.status",
  "session.idle",
  "session.error",
  "message.part.updated",
  "permission.updated",
  "permission.replied"
]);

/** 明确"认识但与本层无关"的事件（忽略而不是报 unknown，避免日志噪声）。 */
export const OPENCODE_IGNORED_EVENTS = Object.freeze([
  "server.instance.disposed",
  "installation.updated",
  "installation.update.available",
  "lsp.client.diagnostics",
  "lsp.updated",
  "message.updated",
  "message.removed",
  "message.part.removed",
  "session.compacted",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.diff",
  "file.edited",
  "file.watcher.updated",
  "todo.updated",
  "command.executed",
  "vcs.branch.updated",
  "tui.prompt.append",
  "tui.command.execute",
  "tui.toast.show",
  "pty.created",
  "pty.updated",
  "pty.exited",
  "pty.deleted"
]);

/** OpenCode 工具名 → 归一化 kind（工具名是小写 snake）。 */
const TOOL_KIND = Object.freeze({
  bash: "execute",
  shell: "execute",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  patch: "edit",
  apply_patch: "edit",
  read: "read",
  grep: "search",
  glob: "search",
  list: "search",
  webfetch: "fetch",
  websearch: "fetch",
  task: "other",
  todowrite: "other",
  todoread: "other"
});

function kindOfTool(tool) {
  return TOOL_KIND[String(tool || "").toLowerCase()] || "other";
}

/** 取出事件体：`/global/event` 是 `{directory, payload}`，`/event` 是事件本体。 */
export function unwrapOpenCodeEvent(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.payload && typeof obj.payload === "object" && typeof obj.payload.type === "string") return obj.payload;
  if (typeof obj.type === "string") return obj;
  return null;
}

/**
 * 一个 OpenCode 事件对象 → 归一化事件。
 *
 * @param {object} obj `/event` 的事件本体，或 `/global/event` 的 `{directory,payload}`
 * @param {{now?:()=>number, maxPreviewChars?:number}} [ctx]
 */
export function mapOpenCodeObject(obj, {
  now = () => Date.now(),
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  const ev = unwrapOpenCodeEvent(obj);
  if (!ev) return { ok: false, reason: "not-event" };
  const at = now();
  const base = (type) => ({ v: 1, type, at });
  const props = ev.properties && typeof ev.properties === "object" ? ev.properties : {};

  switch (ev.type) {
    case "server.connected":
      return { ok: true, events: [{ ...base(EVENT_TYPES.STATUS), status: "connected" }] };

    case "session.status": {
      const st = props.status || {};
      const state = String(st.type || "");
      if (state === "idle") return { ok: true, events: [{ ...base(EVENT_TYPES.STATUS), status: "idle" }] };
      if (state === "busy") return { ok: true, events: [{ ...base(EVENT_TYPES.STATUS), status: "working" }] };
      if (state === "retry") {
        return {
          ok: true,
          events: [{
            ...base(EVENT_TYPES.STATUS),
            status: "retrying",
            attempt: Number(st.attempt) || 0,
            retryDelayMs: Number(st.next) || 0
          }]
        };
      }
      return { ok: true, events: [] };
    }

    case "session.idle":
      // 文档语义：会话空闲 = 回合结束
      return { ok: true, events: [{ ...base(EVENT_TYPES.TURN_END), reason: "completed", isError: false }] };

    case "session.error": {
      const err = props.error || {};
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.TURN_END),
          reason: "error",
          isError: true,
          // error 是 ProviderAuthError / UnknownError / ApiError 等联合；只取 name + message 预览
          errorName: String(err.name || ""),
          errorMessage: previewOf(String(err?.data?.message || err?.message || ""), maxPreviewChars)
        }]
      };
    }

    case "message.part.updated": {
      const part = props.part || {};
      const type = String(part.type || "");
      if (type === "text") {
        const delta = typeof props.delta === "string" ? props.delta : "";
        if (delta) return { ok: true, events: [{ ...base(EVENT_TYPES.MESSAGE_DELTA), text: delta, final: false }] };
        const text = String(part.text || "");
        if (!text) return { ok: true, events: [] };
        // 没给 delta 时把 text 当完整段落；同一个 part 会多次到达，下游需按 part.id 去重【未核实】
        return { ok: true, events: [{ ...base(EVENT_TYPES.MESSAGE_DELTA), text, final: true }] };
      }
      if (type === "reasoning") {
        return {
          ok: true,
          events: [{ ...base(EVENT_TYPES.STATUS), status: "thinking", textBytes: byteLength(part.text ?? "") }]
        };
      }
      if (type === "tool") {
        const state = part.state || {};
        const status = String(state.status || "");
        const toolCallId = String(part.callID || part.id || "");
        if (status === "pending" || status === "running" || !status) {
          return {
            ok: true,
            events: [{
              ...base(EVENT_TYPES.TOOL_CALL),
              toolCallId,
              name: String(part.tool || ""),
              kind: kindOfTool(part.tool),
              status: status || "pending",
              // input 只算字节数，不落内容（命令原文不进日志）
              inputBytes: state.input === undefined ? 0 : byteLength(JSON.stringify(state.input))
            }]
          };
        }
        if (status === "completed" || status === "error") {
          const output = status === "completed" ? String(state.output ?? "") : String(state.error ?? "");
          return {
            ok: true,
            events: [{
              ...base(EVENT_TYPES.TOOL_RESULT),
              toolCallId,
              isError: status === "error",
              outputBytes: byteLength(output),
              outputPreview: previewOf(output, maxPreviewChars)
            }]
          };
        }
        return { ok: true, events: [] };
      }
      // step-start / step-finish / snapshot / patch / file / agent / subtask / retry / compaction
      return { ok: true, events: [] };
    }

    case "permission.updated": {
      // 审批请求：pattern/title 可能含命令片段 → 不落；只给 id/类型/工具关联
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "waiting_approval",
          requestId: String(props.id || ""),
          permType: String(props.type || ""),
          toolCallId: String(props.callID || "")
          // 注意：真正的审批详情/回执走 PermissionBridge + HTTP（POST /session/:id/permissions/:id），
          // 不走事件流；事件流这里只负责"有一条待审批"的提示。
        }]
      };
    }

    case "permission.replied":
      return {
        ok: true,
        events: [{
          ...base(EVENT_TYPES.STATUS),
          status: "approval_replied",
          requestId: String(props.permissionID || ""),
          response: String(props.response || "")
        }]
      };

    default:
      if (OPENCODE_IGNORED_EVENTS.includes(ev.type)) return { ok: true, events: [] };
      return { ok: false, reason: `unknown-type:${String(ev.type || "?")}` };
  }
}

/** 一行 JSON（SSE data 或测试夹具）映射。 */
export function mapOpenCodeLine(line, {
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
  return mapOpenCodeObject(obj, { now, maxPreviewChars });
}

/** 现成的 OpenCode 事件驱动（喂 SSE 的 data 载荷行）。 */
export function createOpenCodeDriver({
  sink = null,
  onEvent,
  onUnknown,
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  return createJsonlDriver({
    mapLine: mapOpenCodeObject,
    sink,
    onEvent,
    onUnknown,
    now,
    maxLineBytes,
    maxPreviewChars,
    driverName: "opencode-sse"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE → 事件（真正的"桥接"就在这里）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析一个 SSE block（`event:` / `data:` / 注释心跳）。坏 JSON 返回 `{data:null,raw}`，不抛。
 * @param {string} raw
 */
export function parseSseBlock(raw) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const dataLines = [];
  let eventName = "";
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // 注释/心跳（OpenCode 会发 `: connected` 之类）
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
  }
  if (!dataLines.length) return null;
  const dataText = dataLines.join("\n");
  try {
    return { event: eventName, data: JSON.parse(dataText) };
  } catch {
    return { event: eventName, data: null, raw: dataText };
  }
}

/**
 * 增量 SSE 解析器：`push(chunk)` 返回本次凑齐的消息；跨 chunk 的半截数据留在缓冲区。
 * @param {{onMessage?:(m:{event:string,data:any,raw?:string})=>void}} [opts]
 */
export function createSseParser({ onMessage } = {}) {
  let buffer = "";
  const emit = (msg) => {
    if (!msg) return null;
    if (typeof onMessage === "function") {
      try {
        onMessage(msg);
      } catch {
        /* 回调抛错不影响解析 */
      }
    }
    return msg;
  };
  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      const out = [];
      let idx;
      // SSE 事件以空行分隔；兼容 \r\n
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, idx);
        const match = /\r?\n\r?\n/.exec(buffer.slice(idx));
        buffer = buffer.slice(idx + (match ? match[0].length : 2));
        const msg = emit(parseSseBlock(raw));
        if (msg) out.push(msg);
      }
      return out;
    },
    /** 流结束：把缓冲区里最后一个没有空行结尾的 block 也解析掉。 */
    flush() {
      const msg = buffer.trim() ? emit(parseSseBlock(buffer)) : null;
      buffer = "";
      return msg ? [msg] : [];
    },
    buffered() {
      return buffer;
    }
  };
}

/**
 * 把 `GET /event` 的响应流接到驱动上 —— **SSE 桥接的具体做法**（3 行核心逻辑）：
 *   ① `stream.on("data")` → `parser.push(chunk)`（分帧）；
 *   ② 每条消息的 `data` 对象 → `driver.writeLine(JSON.stringify(data))`（复用通用驱动）；
 *   ③ 坏 JSON/未知对象 → 驱动自己的 `unknown` 计数（不吞、不崩）。
 *
 * 用法（未来接到 index/bridge）：
 * ```js
 * const driver = createOpenCodeDriver({ sink: createJsonlSink({ filePath }), onEvent });
 * const sse = attachOpenCodeSse({ stream: res, driver, log });
 * // 结束时：sse.detach(); sse.parser.flush();
 * ```
 *
 * @param {{stream:NodeJS.ReadableStream, driver:object, log?:(e:object)=>void}} opts
 * @returns {{detach:()=>void, parser:object, stats:()=>({chunks:number, badBlocks:number})}}
 */
export function attachOpenCodeSse({ stream, driver, log } = {}) {
  if (!stream || typeof stream.on !== "function") throw new Error("attachOpenCodeSse: 缺少可读流");
  if (!driver || typeof driver.writeLine !== "function") throw new Error("attachOpenCodeSse: 缺少 driver");
  const logger = typeof log === "function" ? log : () => {};
  const counts = { chunks: 0, badBlocks: 0 };
  const parser = createSseParser({
    onMessage(msg) {
      if (!msg) return;
      if (msg.data == null) {
        counts.badBlocks += 1;
        try {
          logger({ level: "warn", event: "sse.bad-json", rawBytes: byteLength(msg.raw || "") });
        } catch {
          /* ignore */
        }
        return;
      }
      driver.writeLine(JSON.stringify(msg.data));
    }
  });
  const onData = (chunk) => {
    counts.chunks += 1;
    parser.push(chunk);
  };
  stream.on("data", onData);
  const onEnd = () => parser.flush();
  if (typeof stream.once === "function") stream.once("end", onEnd);
  return {
    parser,
    detach() {
      if (typeof stream.off === "function") stream.off("data", onData);
      else if (typeof stream.removeListener === "function") stream.removeListener("data", onData);
    },
    stats: () => ({ ...counts })
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI 探测
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_OPENCODE_FS = {
  existsSync: (p) => fsSync.existsSync(p),
  statSync: (p) => fsSync.statSync(p),
  realpathSync: (p) => fsSync.realpathSync(p),
  readdirSync: (p) => fsSync.readdirSync(p)
};

/** 能力声明（server API 来自官方文档；serve 开关实测 help）。 */
export const OPENCODE_CAPABILITIES = Object.freeze({
  serverApi: false, // `opencode serve`（实测 help）
  sse: true, // `GET /event`（官方 server 文档）
  permissionReply: true, // `POST /session/:id/permissions/:permissionID`（官方 server 文档）
  externalApprovalHook: false, // 审批走 HTTP 端点（我们直接答），不需要外部钩子
  approvalChannel: "http" // 审批通道形态
});

/**
 * 候选：显式 env → PATH → npm 全局包 `opencode-ai`（目录里找 `opencode*` 可执行/JS 入口）。
 * ⚠️ npm 包里二进制命名跨平台不一致（`bin/opencode.exe` 等）——这里按目录扫描，找不到就跳过，
 *    并在 README 里标注"npm 布局未核实"。原生安装器装到 PATH 的那条永远优先。
 */
export function buildOpenCodeCandidates({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_OPENCODE_FS,
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

  const explicit = String(env?.[OPENCODE_BIN_ENV] ?? "").trim();
  if (explicit) {
    if (/\.(c|m)?js$/i.test(explicit)) push({ kind: "explicit-node", command: execPath, argsPrefix: [explicit], pathHint: explicit });
    else push({ kind: "explicit", command: explicit, argsPrefix: [], pathHint: explicit });
  }

  for (const dir of splitPathList(env?.PATH, platform)) {
    const names = platform === "win32" ? ["opencode.exe"] : ["opencode"];
    for (const name of names) {
      const p = path.join(dir, name);
      if (!isExec(p)) continue;
      push({ kind: "path", command: platform === "win32" ? p : real(p), argsPrefix: [], pathHint: p });
      break;
    }
  }

  if (npmRoot) {
    const binDir = path.join(npmRoot, "opencode-ai", "bin");
    try {
      for (const name of fs.readdirSync(binDir)) {
        if (!/^opencode/i.test(name)) continue;
        const p = path.join(binDir, name);
        if (/\.(c|m)?js$/i.test(name)) push({ kind: "npm-node", command: execPath, argsPrefix: [p], pathHint: p });
        else if (isExec(p)) push({ kind: "npm-native", command: p, argsPrefix: [], pathHint: p });
      }
    } catch {
      /* 没装 npm 包就跳过 */
    }
  }
  return out;
}

/** 探 serve 能力位：`opencode serve --help`（不启动服务、不调模型）。 */
export function probeOpenCodeCaps(candidate, { spawnSync = nodeSpawnSync, timeoutMs = 10_000 } = {}) {
  const caps = { ...OPENCODE_CAPABILITIES, serverApi: false };
  try {
    const r = spawnSync(candidate.command, [...(candidate.argsPrefix || []), "serve", "--help"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const text = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
    if (r?.error || (typeof r?.status === "number" && r.status !== 0) || !text.trim()) {
      return { ok: false, caps, evidence: {}, reason: `serve --help 失败（${r?.error?.code || r?.status || "空输出"}）` };
    }
    caps.serverApi = /--port\b/.test(text) || /--hostname\b/.test(text);
    return {
      ok: true,
      caps,
      evidence: {
        helpTextLength: text.length,
        matched: { port: /--port\b/.test(text), hostname: /--hostname\b/.test(text), cors: /--cors\b/.test(text) }
      }
    };
  } catch (err) {
    return { ok: false, caps, evidence: {}, reason: `能力探测异常: ${err?.code || err?.message || err}` };
  }
}

/**
 * 一站式探测。**永不抛错**。mode：有 server API → `"approval"`（HTTP 审批端点）；否则 `"notify-only"`。
 */
export function detectOpenCode({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_OPENCODE_FS,
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
    root =
      String(env?.[OPENCODE_NPM_ROOT_ENV] ?? "").trim() ||
      String(env?.[NPM_ROOT_ENV] ?? "").trim() ||
      probeNpmRoot({ execFileSync, platform, env, fs, execPath });
  }

  let candidates;
  try {
    candidates = buildOpenCodeCandidates({ env, platform, execPath, fs, npmRoot: root, isExecutable, realpath });
  } catch (err) {
    return { ok: false, status: "error", mode: "notify-only", reason: `构建候选异常: ${err?.message || err}`, caps: { ...OPENCODE_CAPABILITIES } };
  }

  const attempts = [];
  for (const c of candidates) {
    const r = probeCandidateVersion(c, { spawnSync, timeoutMs: probeTimeoutMs });
    attempts.push({ kind: c.kind, path: c.pathHint || c.command, ok: r.ok, reason: r.ok ? "" : r.reason });
    if (!r.ok) continue;
    const capsResult = probeCaps ? probeOpenCodeCaps(c, { spawnSync, timeoutMs: probeTimeoutMs }) : { ok: true, caps: { ...OPENCODE_CAPABILITIES, serverApi: true }, evidence: {} };
    if (!capsResult.ok) warnings.push({ code: "caps-probe-failed", message: capsResult.reason });
    return {
      ok: true,
      status: "ok",
      mode: capsResult.caps?.serverApi ? "approval" : "notify-only",
      approvalChannel: capsResult.caps?.serverApi ? "http" : "",
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
    reason: candidates.length ? "找到了 opencode 候选但都拿不到版本" : "没有找到 OpenCode CLI（未安装，或不在 PATH / npm 全局目录里）",
    caps: { ...OPENCODE_CAPABILITIES },
    attempts,
    warnings
  };
}

/**
 * Gemini CLI 适配骨架（**ACP / JSON-RPC over stdio**，M2 第 5 周）。
 *
 * ## 为什么 ACP 这家最省事
 *
 * ACP 的 stdio 传输规定：**一条消息一行 JSON-RPC、行内不许有换行**（官方 transports 规范原文：
 * "Messages are delimited by newlines (`\n`), and MUST NOT contain embedded newlines"）。
 * ⇒ 它和 Claude/Codex 的 jsonl 输出**同构**，可以**直接复用 `createJsonlDriver`**，只需要换一个 `mapLine`。
 * 这是"2 个驱动覆盖 4 家"里 ACP 那半个驱动的最小落地。
 *
 * ## 依据来源（全部官方，2026-11 读取）
 *
 * | 依据 | 出处 |
 * |---|---|
 * | stdio 传输："一行一条 JSON-RPC" | <https://agentclientprotocol.com/protocol/v1/transports> |
 * | `session/update` 的全部 `sessionUpdate` 变体 | <https://agentclientprotocol.com/protocol/v1/prompt-turn> |
 * | `agent_message_chunk` / `plan` / `notice` 的 JSON 样本 | 同上（测试夹具逐字摘录） |
 * | `tool_call` / `tool_call_update` / `session/request_permission` 的 JSON 样本与字段 | <https://agentclientprotocol.com/protocol/v1/tool-calls> |
 * | stopReason 闭集（end_turn / max_tokens / max_turn_requests / refusal / cancelled） | <https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons> |
 * | 本机 `gemini --help` 实测 | `gemini 0.31.0`（Homebrew 安装）：ACP 开关当前叫 **`--experimental-acp`**（不是文档里的 `--acp`） |
 *
 * ## 未核实项（**不要当事实**）
 *
 * 1. 本机 `gemini 0.31.0` 的 ACP 实现代际（文档同时有 ACP v1/v2）—— 本模块只按 **v1** 语义映射；
 *    真机握手时以 `initialize` 的协议版本为准。
 * 2. `usage_update` / `notice` / `session_info_update` 等较新变体的实际字段 —— 本模块对不认识的变体
 *    **忽略而不是报错**（`ok:true, events:[]`），避免被判成"未知行"。
 * 3. `session/prompt` 的**失败**是"JSON-RPC error 响应"还是"stopReason"—— 本模块把 JSON-RPC error
 *    映射成 `status(error)`；要精确成 `turn.end` 需要维护"哪个 id 是 prompt"的状态机（下一步做）。
 * 4. 审批：ACP 的 `session/request_permission` 是**协议内的双向请求**（我们作为 client 必须回）。
 *    本模块只把它映射成 `status(waiting_approval)`；真正的"回执写回"要接到 PermissionBridge/协调器（下一步）。
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
import { formatVersion } from "./version.mjs";

/** 显式指定 gemini CLI。 */
export const GEMINI_BIN_ENV = "DSH_AGENT_GEMINI_BIN";
/** 显式指定 npm 全局根（不设则回落到通用 `DSH_AGENT_NPM_ROOT` / 自动探测）。 */
export const GEMINI_NPM_ROOT_ENV = "DSH_AGENT_GEMINI_NPM_ROOT";

/** ACP 的 `sessionUpdate` 变体（v1 文档全集；本模块只映射前 6 个，其余忽略）。 */
export const ACP_SESSION_UPDATE_VARIANTS = Object.freeze([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "notice",
  "compaction_update",
  "compaction_summary_chunk"
]);

/** ACP 工具分类词表（设计稿 §2.3 已直接沿用这套）。 */
export const ACP_TOOL_KINDS = Object.freeze([
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"
]);

/** ACP stopReason → 归一化 turn.end reason。 */
export function stopReasonOf(stopReason) {
  switch (String(stopReason || "")) {
    case "end_turn":
      return "completed";
    case "max_tokens":
      return "max-tokens";
    case "max_turn_requests":
      return "max-turns";
    case "refusal":
      return "refused";
    case "cancelled":
      return "aborted";
    default:
      return "completed";
  }
}

function mapToolKind(kind) {
  const k = String(kind || "");
  return ACP_TOOL_KINDS.includes(k) ? k : "other";
}

/**
 * ACP content（单块或数组）→ 文本。
 *
 * 注意两种官方形状都要吃：
 *   · 消息块直接是 `{type:"text", text}`；
 *   · `tool_call_update.content` 是 `[{type:"content", content:{type:"text",text}}]`（嵌套一层）。
 */
function contentText(content) {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  return blocks
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      if (typeof c.text === "string") return c.text;
      if (c.content && typeof c.content === "object" && typeof c.content.text === "string") return c.content.text;
      if (typeof c.content === "string") return c.content;
      return "";
    })
    .filter(Boolean)
    .join("");
}

/**
 * 一条 ACP 消息（已解析的 JSON-RPC 对象）→ 归一化事件。
 *
 * 返回 `{ok:true, events}` 或 `{ok:false, reason}`；永不抛错。
 *
 * @param {object} obj
 * @param {{now?:()=>number, maxPreviewChars?:number}} [ctx]
 */
export function mapGeminiObject(obj, {
  now = () => Date.now(),
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not-object" };
  const at = now();
  const base = (type) => ({ v: 1, type, at });

  // ACP 的传输是 JSON-RPC 2.0；不是这个形状就不是 ACP（防止把 stderr 混进 stdout）
  if (obj.jsonrpc !== "2.0") return { ok: false, reason: "not-jsonrpc" };

  // ① Agent → Client 通知：session/update
  if (obj.method === "session/update") {
    const params = obj.params || {};
    const update = params.update;
    if (!update || typeof update !== "object") return { ok: false, reason: "update-without-payload" };
    const variant = String(update.sessionUpdate || "");
    switch (variant) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (!text) return { ok: true, events: [] };
        // ACP 的 chunk 是**流式增量**；完整消息由客户端按 messageId 拼
        return { ok: true, events: [{ ...base(EVENT_TYPES.MESSAGE_DELTA), text, final: false }] };
      }
      case "agent_thought_chunk":
        return {
          ok: true,
          events: [{
            ...base(EVENT_TYPES.STATUS),
            status: "thinking",
            // 推理内容不落（同 Codex 的策略），只给字节数
            textBytes: byteLength(contentText(update.content))
          }]
        };
      case "user_message_chunk":
        return { ok: true, events: [] };
      case "tool_call": {
        const raw = update.rawInput;
        return {
          ok: true,
          events: [{
            ...base(EVENT_TYPES.TOOL_CALL),
            toolCallId: String(update.toolCallId || ""),
            name: String(update.name || ""),
            kind: mapToolKind(update.kind),
            status: String(update.status || "pending"),
            // title 是 Agent 自己写的文案，可能夹带命令 → 不落；只落输入字节数
            inputBytes: raw === undefined ? 0 : byteLength(JSON.stringify(raw))
          }]
        };
      }
      case "tool_call_update": {
        const status = String(update.status || "");
        // 只有终态才产出 tool.result；in_progress/pending 的增量不产生事件（避免重复）
        if (status !== "completed" && status !== "failed") return { ok: true, events: [] };
        const text = contentText(update.content);
        return {
          ok: true,
          events: [{
            ...base(EVENT_TYPES.TOOL_RESULT),
            toolCallId: String(update.toolCallId || ""),
            isError: status === "failed",
            outputBytes: byteLength(text),
            outputPreview: previewOf(text, maxPreviewChars)
          }]
        };
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        return {
          ok: true,
          events: [{
            ...base(EVENT_TYPES.STATUS),
            status: "plan",
            planItems: entries.length,
            planDone: entries.filter((e) => e && String(e.status || "") === "completed").length
          }]
        };
      }
      case "notice":
        return {
          ok: true,
          events: [{
            ...base(EVENT_TYPES.STATUS),
            status: "notice",
            text: previewOf(String(update.message ?? update.text ?? ""), maxPreviewChars)
          }]
        };
      case "usage_update":
        // 字段形状未核实（v1 文档只列了变体名）→ 只报"有更新"，不猜字段
        return { ok: true, events: [{ ...base(EVENT_TYPES.STATUS), status: "usage" }] };
      default:
        // available_commands_update / current_mode_update / config_option_update /
        // session_info_update / compaction_* —— 与 UI 的 5 类事件无关，忽略而非报错
        return { ok: true, events: [] };
    }
  }

  // ② Agent → Client 双向请求：session/request_permission（审批）
  if (obj.method === "session/request_permission") {
    const params = obj.params || {};
    const toolCall = params.toolCall || {};
    const options = Array.isArray(params.options) ? params.options : [];
    return {
      ok: true,
      events: [{
        ...base(EVENT_TYPES.STATUS),
        status: "waiting_approval",
        // JSON-RPC 的 id 就是这条审批的回执 id（client 必须用它回 outcome）
        requestId: String(obj.id ?? ""),
        toolCallId: String(toolCall.toolCallId || ""),
        toolKind: mapToolKind(toolCall.kind),
        // 选项只暴露 kind（协议枚举），不暴露 agent 写的 name 文案
        optionKinds: options.map((o) => String(o?.kind || "")).filter(Boolean)
      }]
    };
  }

  // ③ 响应：session/prompt 的结果（stopReason）
  if (obj.result && typeof obj.result === "object" && "stopReason" in obj.result) {
    const raw = String(obj.result.stopReason || "");
    return {
      ok: true,
      events: [{
        ...base(EVENT_TYPES.TURN_END),
        reason: stopReasonOf(raw),
        isError: false,
        rawStopReason: raw
      }]
    };
  }

  // ④ JSON-RPC 错误响应（可能是 prompt 失败，也可能是某次请求失败；精确归属需要状态机，下一步）
  if (obj.error) {
    return {
      ok: true,
      events: [{
        ...base(EVENT_TYPES.STATUS),
        status: "error",
        scope: "jsonrpc",
        message: previewOf(String(obj.error?.message || JSON.stringify(obj.error)), maxPreviewChars)
      }]
    };
  }

  if (obj.method) return { ok: false, reason: `unknown-method:${String(obj.method)}` };
  return { ok: false, reason: "unknown-shape" };
}

/** 一行（字符串）映射。 */
export function mapGeminiLine(line, {
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  const framed = frameLine(line, { maxLineBytes });
  if (!framed.ok) return framed;
  const parsed = parseLineJson(framed.raw);
  if (!parsed.ok) return parsed;
  return mapGeminiObject(parsed.obj, { now, maxPreviewChars });
}

/** 现成的 Gemini 事件驱动（ACP stdio 的一行一条 JSON-RPC 直接喂进来）。 */
export function createGeminiDriver({
  sink = null,
  onEvent,
  onUnknown,
  now = () => Date.now(),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS
} = {}) {
  return createJsonlDriver({
    mapLine: mapGeminiObject,
    sink,
    onEvent,
    onUnknown,
    now,
    maxLineBytes,
    maxPreviewChars,
    driverName: "gemini-acp"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI 探测
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_GEMINI_FS = {
  existsSync: (p) => fsSync.existsSync(p),
  statSync: (p) => fsSync.statSync(p),
  realpathSync: (p) => fsSync.realpathSync(p)
};

/** ACP 能力声明（detectGemini 会按本机 help 实测覆盖）。 */
export const GEMINI_CAPABILITIES = Object.freeze({
  acp: false, // 是否支持 ACP 模式（实测 help）
  acpFlag: "", // 实际开关名（`--acp` 或 `--experimental-acp`）
  jsonOutput: false, // `-p --output-format json` 一类的非交互输出【未核实】
  externalApprovalHook: false, // ACP 不需要外部钩子：审批在协议内（session/request_permission）
  acpApproval: false // 协议层支持审批（acp=true 时为 true；接线未做）
});

/**
 * 候选：显式 env → PATH → npm 全局包（`@google/gemini-cli/bundle/gemini.js`）。
 * 注意：Homebrew 装的 gemini 是 `Cellar/.../dist/index.js`（可执行 shebang），
 * PATH 那一步 realpath 后就是它，能直接 spawn。
 */
export function buildGeminiCandidates({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_GEMINI_FS,
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

  const explicit = String(env?.[GEMINI_BIN_ENV] ?? "").trim();
  if (explicit) {
    if (/\.(c|m)?js$/i.test(explicit)) push({ kind: "explicit-node", command: execPath, argsPrefix: [explicit], pathHint: explicit });
    else push({ kind: "explicit", command: explicit, argsPrefix: [], pathHint: explicit });
  }

  for (const dir of splitPathList(env?.PATH, platform)) {
    const names = platform === "win32" ? ["gemini.exe"] : ["gemini"];
    for (const name of names) {
      const p = path.join(dir, name);
      if (!isExec(p)) continue;
      push({ kind: "path", command: platform === "win32" ? p : real(p), argsPrefix: [], pathHint: p });
      break;
    }
  }

  if (npmRoot) {
    const js = path.join(npmRoot, "@google", "gemini-cli", "bundle", "gemini.js");
    try {
      if (fs.statSync(js).isFile()) push({ kind: "npm-node", command: execPath, argsPrefix: [js], pathHint: js });
    } catch {
      /* 不存在就跳过 */
    }
  }
  return out;
}

/** 探 ACP 能力位：跑一次 `--help`（**不启动模型**）。 */
export function probeGeminiCaps(candidate, { spawnSync = nodeSpawnSync, timeoutMs = 10_000 } = {}) {
  const caps = { ...GEMINI_CAPABILITIES };
  try {
    const r = spawnSync(candidate.command, [...(candidate.argsPrefix || []), "--help"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const text = `${r?.stdout ?? ""}${r?.stderr ?? ""}`;
    if (r?.error || (typeof r?.status === "number" && r.status !== 0) || !text.trim()) {
      return { ok: false, caps, evidence: { helpTextLength: text.length }, reason: `--help 失败（${r?.error?.code || r?.status || "空输出"}）` };
    }
    const hasAcp = /--acp\b/.test(text);
    const hasExperimental = /--experimental-acp\b/.test(text);
    caps.acp = hasAcp || hasExperimental;
    caps.acpFlag = hasAcp ? "--acp" : hasExperimental ? "--experimental-acp" : "";
    caps.acpApproval = caps.acp;
    caps.jsonOutput = /--output-format\b/.test(text);
    return {
      ok: true,
      caps,
      evidence: { helpTextLength: text.length, matched: { acp: hasAcp, experimentalAcp: hasExperimental, outputFormat: caps.jsonOutput } }
    };
  } catch (err) {
    return { ok: false, caps, evidence: {}, reason: `能力探测异常: ${err?.code || err?.message || err}` };
  }
}

/**
 * 一站式探测：找 CLI → 版本 → ACP 能力位。**永不抛错**。
 *
 * mode：有 ACP → `"approval"`（协议内审批，接线待做）；没有 → `"notify-only"`。
 */
export function detectGemini({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_GEMINI_FS,
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
      String(env?.[GEMINI_NPM_ROOT_ENV] ?? "").trim() ||
      String(env?.[NPM_ROOT_ENV] ?? "").trim() ||
      probeNpmRoot({ execFileSync, platform, env, fs, execPath });
  }

  let candidates;
  try {
    candidates = buildGeminiCandidates({ env, platform, execPath, fs, npmRoot: root, isExecutable, realpath });
  } catch (err) {
    return { ok: false, status: "error", mode: "notify-only", reason: `构建候选异常: ${err?.message || err}`, caps: { ...GEMINI_CAPABILITIES } };
  }

  const attempts = [];
  for (const c of candidates) {
    const r = probeCandidateVersion(c, { spawnSync, timeoutMs: probeTimeoutMs });
    attempts.push({ kind: c.kind, path: c.pathHint || c.command, ok: r.ok, reason: r.ok ? "" : r.reason });
    if (!r.ok) continue;
    const capsResult = probeCaps ? probeGeminiCaps(c, { spawnSync, timeoutMs: probeTimeoutMs }) : { ok: true, caps: { ...GEMINI_CAPABILITIES }, evidence: {} };
    if (!capsResult.ok) warnings.push({ code: "caps-probe-failed", message: capsResult.reason });
    if (capsResult.caps?.acpFlag === "--experimental-acp") {
      warnings.push({ code: "acp-experimental", message: "本机 ACP 开关是 --experimental-acp（实验性），协议代际需实测握手确认" });
    }
    return {
      ok: true,
      status: "ok",
      mode: capsResult.caps?.acp ? "approval" : "notify-only",
      approvalChannel: capsResult.caps?.acp ? "acp-jsonrpc" : "",
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
      ? "找到了 gemini 候选但都拿不到版本"
      : "没有找到 Gemini CLI（未安装，或不在 PATH / npm 全局目录里）",
    caps: { ...GEMINI_CAPABILITIES },
    attempts,
    warnings
  };
}

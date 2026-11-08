/**
 * im-commands — 三家 IM 机器人（企微 / 钉钉 / 飞书）共用的**命令层**（2026-11-08）。
 *
 * 业主实测：在钉钉里发 `/ls` 期望列会话，但当时没有命令层 → `/ls` 被当成 prompt 转给了模型。
 * 命令层把这类「控制类消息」在**进模型之前**拦下、自己执行并回复；解析器/文案/能力门禁三家共用，
 * 各通道只负责把回复发出去（企微被动回复 / 钉钉 sessionWebhook / 飞书 im/v1/messages）。
 *
 * 命令表（能力门禁复用 `WECHAT_CAPABILITY_TABLE`，与会员升级文案同口径）：
 *   | 命令        | 能力              | 免费 | 说明                                   |
 *   | /help       | 无                | ✅   | 列出全部命令（含会员命令标注）         |
 *   | /status     | 无                | ✅   | 连接状态 + 当前会话 + 本月剩余指令     |
 *   | /stop       | 无                | ✅   | 急停当前任务（安全阀必须免费、立即生效）|
 *   | /ls         | sessions          | ❌   | 最近 ≤10 个会话（标题/索引/当前标记）  |
 *   | /use <N>    | sessions          | ❌   | 切换当前绑定会话（写配置 sessionId）   |
 *   | /unbind     | 无                | ✅   | 解绑/退订本会话推送（合规：随时可退订）|
 *
 * 未命中的 `/xxx`：回帮助提示（含"未知命令"），**绝不转给模型**。
 * 回复一律用纯文本列表（不用 Markdown 表格；各通道发送前还会走 im-format 兜底）。
 */

import path from "node:path";

import { WECHAT_CAPABILITY_TABLE, grantsCap } from "./wechat-runtime.mjs";
import { IM_BOTS_FILE, atomicWriteJson, readJsonFile } from "./wecom-bot.mjs";

/** 命令表（顺序即 /help 展示顺序）。`free` 只是文档标记；真正门禁看 caps。 */
export const IM_COMMANDS = Object.freeze([
  Object.freeze({ name: "/help", caps: Object.freeze([]), free: true, usage: "/help", summary: "查看命令" }),
  Object.freeze({ name: "/status", caps: Object.freeze([]), free: true, usage: "/status", summary: "连接状态 / 当前会话 / 本月额度" }),
  Object.freeze({ name: "/stop", caps: Object.freeze([]), free: true, usage: "/stop", summary: "急停当前任务" }),
  Object.freeze({ name: "/ls", caps: Object.freeze(["sessions"]), free: false, usage: "/ls", summary: "列出最近会话（会员）" }),
  Object.freeze({ name: "/use", caps: Object.freeze(["sessions"]), free: false, usage: "/use <序号>", summary: "切换当前会话（会员）" }),
  Object.freeze({ name: "/unbind", caps: Object.freeze([]), free: true, usage: "/unbind", summary: "解绑本会话推送（随时可退订）" })
]);

/** 会话标题截断（按码点，避免切坏 emoji/中文）。 */
export function truncateTitle(title, max = 24) {
  const s = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtTime(at) {
  const n = Number(at) || 0;
  if (!n) return "";
  try {
    const d = new Date(n);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch { return ""; }
}

/**
 * 解析一条消息是否为命令。
 * @returns {{name:string, arg:string, unknown?:boolean, raw:string}|null} null = 普通文本（照旧转给模型）
 */
export function parseImCommand(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw.startsWith("/")) return null;
  const m = /^\/([a-zA-Z]*)(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/.exec(raw);
  if (!m) return { name: "/", arg: "", unknown: true, raw };
  const word = String(m[1] || "").toLowerCase();
  return { name: word ? `/${word}` : "/", arg: String(m[2] || "").toLowerCase(), rest: m[3] || "", unknown: !word, raw };
}

/** 当前 caps 是否具备该命令要求（点号前缀规则，与会员表同源）。 */
export function commandAllowed(command, caps) {
  const list = Array.isArray(caps) ? caps : [];
  return (command.caps || []).every((c) => grantsCap(list, c));
}

function appPromo(ctx) {
  const base = String((ctx && ctx.appUrl) || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/promo`;
}

/** /help：列出全部命令（免费/会员标注；免费档会提示哪些需要会员）。 */
export function helpText(ctx = {}) {
  const caps = Array.isArray(ctx.caps) ? ctx.caps : [];
  const lines = ["📋 可用命令（命令不会发给模型，直接执行）", ""];
  for (const cmd of IM_COMMANDS) {
    const allowed = commandAllowed(cmd, caps);
    const mark = cmd.free ? "" : allowed ? "（会员）" : "（会员·当前档不可用）";
    lines.push(`${cmd.usage} — ${cmd.summary}${mark}`);
  }
  lines.push("", "免费档可用的命令：/help /status /stop /unbind（急停与退订永远免费）。");
  if (caps.includes("sessions")) lines.push("你的档位已包含会话管理（/ls、/use）。");
  return lines.join("\n");
}

/** 未知 /xxx：不转给模型，回"未知命令 + 帮助提示"。 */
export function unknownCommandText(cmd, ctx = {}) {
  const name = cmd && cmd.name && cmd.name !== "/" ? cmd.name : cmd && cmd.raw ? String(cmd.raw).split(/\s+/)[0] : "/?";
  return `未知命令：${name}\n\n${helpText(ctx)}`;
}

/** 会员功能被拦：与现有升级文案同口径（能做什么/去哪升级），只是更简短。 */
export function upgradeText(commandName, ctx = {}) {
  const promo = appPromo(ctx);
  const lines = [
    `🔒 ${commandName} 是会员功能（列出/切换会话）`,
    "",
    "免费可用：/help /status /stop /unbind（急停、退订永远免费）",
    "升级 Pro：指令不限量、可开新任务、可切换/多会话"
  ];
  if (promo) lines.push(`👉 ${promo}`);
  return lines.join("\n");
}

/** /status：与状态文件同源的连接/会话/额度摘要。 */
export async function statusText(ctx = {}) {
  const snap = typeof ctx.statusSnapshot === "function" ? await ctx.statusSnapshot() : (ctx.status || {});
  const s = snap && typeof snap === "object" ? snap : {};
  const channel = String(s.channelLabel || ctx.channelLabel || "IM");
  const connected = s.connected === true;
  const authed = s.authenticated === true;
  const state = String(s.state || (connected ? "connected" : "idle"));
  const stateLine = connected
    ? (authed ? "✅ 已连接（认证通过）" : "✅ 已连接（等待认证）")
    : `⚠️ 未连接（${state}${s.lastError ? `：${truncateTitle(s.lastError, 40)}` : ""}）`;
  const conv = truncateTitle(s.currentSessionTitle || s.boundSessionTitle || "", 24) || "未选择";
  const convId = String(s.currentSessionId || s.boundSessionId || "");
  const shortId = convId ? convId.replace(/^session-/, "").slice(0, 8) : "";
  const limit = Number(s.messagesPerMonth) || 0;
  const used = Number(s.usage && s.usage.messages) || 0;
  const quotaLine = limit > 0
    ? `本月指令：已用 ${used}/${limit}${s.tier ? `（${s.tier}）` : ""}`
    : `本月指令：不限${s.tier ? `（${s.tier}）` : ""}`;
  const lines = [
    "📊 连接状态",
    `· 通道：${channel}`,
    `· 状态：${stateLine}`,
    `· 当前会话：${conv}${shortId ? `（#${shortId}）` : ""}`,
    `· ${quotaLine}`
  ];
  if (s.remainingMessages !== null && s.remainingMessages !== undefined && limit > 0) {
    lines.push(`· 剩余：${Number(s.remainingMessages) || 0} 条`);
  }
  return lines.join("\n");
}

/** ctx 的 currentSessionId/currentSessionTitle 允许函数或字符串（各通道实现风格不一）。 */
function resolveMaybeFn(value) {
  try { return typeof value === "function" ? String(value() || "") : String(value || ""); } catch { return ""; }
}

/** 统一取最近会话列表（ctx.sessions 返回 [{sessionId,title,updatedAt,running}]）。 */
export async function listSessions(ctx = {}) {
  if (typeof ctx.sessions !== "function") return [];
  const rows = await ctx.sessions();
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.sessionId === "string" && r.sessionId)
    .slice(0, 10)
    .map((r) => ({
      sessionId: r.sessionId,
      title: String(r.title || r.sessionTitle || "").trim() || r.sessionId,
      updatedAt: Number(r.updatedAt) || 0,
      running: r.running === true
    }));
}

/** /ls：≤10 个会话，标题截断 24 + 索引 + 当前标记 + 更新时间。 */
export async function lsText(ctx = {}) {
  const rows = await listSessions(ctx);
  const current = resolveMaybeFn(ctx.currentSessionId) || String(ctx.activeSessionId || "");
  if (!rows.length) {
    return "📂 最近没有可列出的会话。\n\n先在电脑的 DeepSeek Harness 里打开/运行一个会话，再发 /ls。";
  }
  const lines = ["📂 最近会话（最多 10 个）", ""];
  rows.forEach((r, i) => {
    const isCurrent = r.sessionId === current;
    const time = fmtTime(r.updatedAt);
    const marks = [isCurrent ? "（当前）" : "", r.running ? "· 运行中" : "", time ? `· ${time}` : ""].filter(Boolean).join(" ");
    lines.push(`${i + 1}. ${truncateTitle(r.title, 24)}${marks ? ` ${marks}` : ""}`);
  });
  lines.push("", "回复 /use <序号> 切换会话（例如 /use 1）。");
  return { text: lines.join("\n"), rows };
}

/** /use <N>：切换当前绑定会话（写配置 sessionId/sessionTitle）。 */
export async function useText(ctx = {}, arg = "") {
  const rows = await listSessions(ctx);
  if (!rows.length) return "现在没有可切换的会话。先在电脑上打开一个会话，再发 /ls 看看。";
  const raw = String(arg || "").trim();
  if (!raw) return "用法：/use <序号>（先发 /ls 查看会话列表，例如 /use 1）";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > rows.length) {
    return `序号超出范围：当前列表是 1-${rows.length}。先发 /ls 查看列表，再用 /use <序号> 切换。`;
  }
  const pick = rows[n - 1];
  if (typeof ctx.switchSession !== "function") return "当前通道还不支持切换会话（订阅器未就绪），请在电脑上切换。";
  const r = await ctx.switchSession({ sessionId: pick.sessionId, title: pick.title });
  if (!r || r.ok !== true) {
    return `切换失败：${truncateTitle((r && (r.message || r.reason)) || "未知错误", 60)}。可以到电脑上切换，或稍后再试。`;
  }
  return `✅ 已切换到 #${n} ${truncateTitle(pick.title, 24) || pick.sessionId}`;
}

/** /stop：急停当前任务（免费、立即生效；回执明确）。 */
export async function stopText(ctx = {}) {
  const current = resolveMaybeFn(ctx.currentSessionId) || String(ctx.activeSessionId || "");
  if (!current) return "当前没有正在运行的会话，无需急停。";
  if (typeof ctx.cancelSession !== "function") return "急停失败：后台还没连上事件通道（订阅器未就绪）。请在电脑上停止任务。";
  const title = truncateTitle(resolveMaybeFn(ctx.currentSessionTitle) || ctx.activeSessionTitle || current, 24);
  let r;
  try { r = await ctx.cancelSession({ sessionId: current }); } catch (e) {
    r = { ok: false, message: e && e.message ? e.message : String(e) };
  }
  if (r && r.ok === true) return `⏹ 已急停：${title}（已发送中止，正在停止当前任务）`;
  return `⏹ 急停请求已发出，但没收到确认：${truncateTitle((r && (r.message || r.reason)) || "未知错误", 60)}。请到电脑上确认任务是否已停。`;
}

/** /unbind：解绑本会话推送（免费；合规要求任何人可退订）。 */
export async function unbindText(ctx = {}) {
  if (typeof ctx.unbind !== "function") return "解绑失败：当前通道暂不支持解绑，请在电脑的「远程访问」里关闭该通道。";
  let r;
  try { r = await ctx.unbind(); } catch (e) { r = { ok: false, message: e && e.message ? e.message : String(e) }; }
  if (r && r.ok === true) return "✅ 已解绑：这台电脑不再向本会话推送通知。想重新接收，发任意消息即可重新绑定。";
  return `解绑失败：${truncateTitle((r && (r.message || r.reason)) || "未知错误", 60)}`;
}

/**
 * 执行一条命令（**命中即返回 handled:true，调用方直接回复 text 并 return，绝不进模型**）。
 *
 * @param {{text:string, ctx:object}} args
 *   ctx 契约（各通道按自己能力提供，缺的降级）：
 *   · caps[]、tier、appUrl、channelLabel
 *   · sessions(): Promise<[{sessionId,title,updatedAt,running}]>
 *   · currentSessionId(): string、currentSessionTitle?: string、activeSessionId?
 *   · cancelSession({sessionId})、switchSession({sessionId,title})、unbind()
 *   · statusSnapshot(): Promise<{connected,authenticated,state,lastError,tier,usage,messagesPerMonth,remainingMessages,currentSessionTitle,currentSessionId}>
 * @returns {Promise<{handled:boolean, ok?:boolean, gated?:boolean, command?:string, text?:string, rows?:Array}>}
 */
export async function executeImCommand({ text, ctx = {} } = {}) {
  const cmd = parseImCommand(text);
  if (!cmd) return { handled: false };
  const caps = Array.isArray(ctx.caps) ? ctx.caps : [];
  const known = IM_COMMANDS.find((c) => c.name === cmd.name);
  if (!known) return { handled: true, ok: false, command: cmd.name, text: unknownCommandText(cmd, ctx) };
  if (!commandAllowed(known, caps)) {
    return { handled: true, ok: false, gated: true, command: known.name, text: upgradeText(known.name, ctx) };
  }
  try {
    switch (known.name) {
      case "/help":
        return { handled: true, ok: true, command: known.name, text: helpText(ctx) };
      case "/status":
        return { handled: true, ok: true, command: known.name, text: await statusText(ctx) };
      case "/stop":
        return { handled: true, ok: true, command: known.name, text: await stopText(ctx) };
      case "/unbind":
        return { handled: true, ok: true, command: known.name, text: await unbindText(ctx) };
      case "/ls": {
        const r = await lsText(ctx);
        return { handled: true, ok: true, command: known.name, text: typeof r === "string" ? r : r.text, rows: typeof r === "string" ? [] : r.rows };
      }
      case "/use":
        return { handled: true, ok: true, command: known.name, text: await useText(ctx, cmd.arg) };
      default:
        return { handled: true, ok: false, command: known.name, text: unknownCommandText(cmd, ctx) };
    }
  } catch (e) {
    return {
      handled: true,
      ok: false,
      command: known.name,
      text: `命令执行失败：${truncateTitle(e && e.message ? e.message : e, 60)}。可以到电脑上看一眼，或稍后再试。`
    };
  }
}

/** 能力表（导出方便各通道显示"会员功能"标记；单一真相源）。 */
export const IM_COMMAND_CAPABILITY_TABLE = WECHAT_CAPABILITY_TABLE;

/**
 * 切换会话时写 `im-bots.json` 对应通道的 `sessionId/sessionTitle`（0600 原子写，保留其它段）。
 * 各通道 controller 会热更新并在下一次入站用新会话。
 */
export function writeImBotsSession(relayDir, channel, { sessionId, sessionTitle } = {}) {
  const dir = String(relayDir || "");
  const ch = String(channel || "");
  if (!dir || !ch) return { ok: false, reason: "no_target" };
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, reason: "no_session_id" };
  try {
    const file = path.join(dir, IM_BOTS_FILE);
    const prev = readJsonFile(file);
    const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
    const cur = base[ch] && typeof base[ch] === "object" ? base[ch] : {};
    atomicWriteJson(file, {
      ...base,
      version: 1,
      [ch]: { ...cur, sessionId: sid, sessionTitle: truncateTitle(sessionTitle || "", 60) }
    }, { onWarn: () => { /* 静默 */ } });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

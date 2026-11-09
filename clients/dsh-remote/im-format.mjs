/**
 * im-format — **通道感知的消息格式化**（2026-11-08 业主反馈「企微/飞书推回来的表格都是乱的」）。
 *
 * 背景
 * -----------------------------------------------------------------
 * agent 的最终回答常带 Markdown 表格（`| a | b |`）、标题、引用、任务列表…… 而企业微信 / 钉钉的
 * markdown **不支持表格**：原样发出去就是一堆竖线，用户看到的就是「乱」。不同 IM 通道的能力也不同
 * （企微/钉钉支持 markdown 子集；飞书 markdown 能力弱、卡片强；个人微信机器人有自己的一套特殊格式），
 * 所以"发之前按通道能力适配一次"应该是一个**独立的、可单测的纯函数模块**，而不是散在 wecom-bot 里。
 *
 * 用法
 * -----------------------------------------------------------------
 * ```js
 * import { formatForChannel, CHANNEL_CAPS } from "./im-format.mjs";
 * const text = formatForChannel("wecom", { title: "", text: agentAnswer });
 * ```
 * 规则（确定性、可测，见 formatForChannel 注释）：
 *   · 表格 → 「• 列1：值1 · 列2：值2」多行（列多/超宽时按「• 记录 N」+ 每列一行拆开）
 *   · `#` 标题 → 加粗（markdown 通道）/ 纯文本
 *   · `---` 分隔线 → 空行；`>` 引用 → `› `；`- [ ]` / `- [x]` → `☐` / `☑`；嵌套列表压平一层
 *   · 代码块**原样保留**；inline code / bold / 链接不动（企微 markdown 支持）
 *   · wecom 默认按 **4096 字节（UTF-8）** 截断，优先在段落/行边界，附「…(已截断，完整内容看电脑)」
 *   · `wechat` 走现有特殊格式（本模块只做 **plain 兜底**，不重复实现微信那套富文本）
 *   · 未知通道 → `plain`（fail-safe：宁可少用格式，也不发坏的 markdown）
 */

/** 各通道能力（钉钉/飞书实现时直接复用；wechat = 现有特殊格式，不经本模块排版）。 */
export const CHANNEL_CAPS = Object.freeze({
  wecom: Object.freeze({ markdown: true, tables: false, card: true }),
  dingtalk: Object.freeze({ markdown: true, tables: false, card: true }),
  feishu: Object.freeze({ markdown: false, tables: false, card: true }),
  wechat: Object.freeze({ markdown: false, special: true }),
  plain: Object.freeze({ markdown: false })
});

/** 截断提示（与 wecom-bot 的 ANSWER_TRUNCATED_NOTE 同文，便于去重）。 */
export const TRUNCATED_NOTE = "…(已截断，完整内容看电脑)";
/** 完成/出错通知里「总结正文」的长度上限（2026-11-10 业主：只有标题没有总结）。 */
export const SUMMARY_MAX_CHARS = 1500;

/** 各通道默认字节上限（wecom 官方 4096；其它先给宽松值，留 maxBytes 覆盖）。 */
const DEFAULT_MAX_BYTES = Object.freeze({
  wecom: 4096,
  dingtalk: 4096,
  feishu: 8192,
  wechat: Infinity,
  plain: Infinity
});

/** UTF-8 字节数（中文 3 字节；emoji 4 字节）。 */
export function utf8Bytes(value) {
  try {
    return Buffer.byteLength(String(value == null ? "" : value), "utf8");
  } catch {
    return String(value == null ? "" : value).length * 3;
  }
}

/** 终端/聊天窗口的显示宽度（CJK 与 emoji 记 2 列；只用于"这行会不会太宽"的确定性判断）。 */
export function displayWidth(value) {
  let width = 0;
  for (const ch of String(value == null ? "" : value)) {
    const cp = ch.codePointAt(0) || 0;
    const wide = cp === 0x2329 || cp === 0x232a
      || (cp >= 0x1100 && cp <= 0x115f)
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe4f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1f64f)
      || (cp >= 0x1f900 && cp <= 0x1f9ff)
      || (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 通道名规范化：未知/空 → `plain`（fail-safe）。 */
export function normalizeChannelName(channel) {
  const name = String(channel || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CHANNEL_CAPS, name)) return name;
  // 常见别名（调用方拼错/叫法不同时不至于掉进 markdown 分支）
  if (name === "weixin" || name === "wx" || name === "wechat-bot" || name === "personal") return "wechat";
  if (name === "workbench" || name === "wxwork" || name === "qywx" || name === "wecom-bot") return "wecom";
  if (name === "ding" || name === "dingding") return "dingtalk";
  if (name === "lark") return "feishu";
  return "plain";
}

// ---------- Markdown 表格解析（确定性：只按未转义的 `|` 切） ----------

/** 是否是表格行（以 `|` 开头且至少 2 个竖线）。 */
function isTableLine(line) {
  const t = String(line || "").trim();
  if (!t.startsWith("|")) return false;
  const count = (t.match(/\|/g) || []).length;
  return count >= 2;
}

/** 把一行表格拆成单元格（支持 `\|` 转义；不会把转义竖线当分隔符）。 */
export function splitTableRow(line) {
  let s = String(line || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  // 结尾的竖线是边框（`\|` 结尾不算）
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i += 1; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 分隔行（`|---|---|` / `|:--|--:|`）。 */
function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(String(c || "").trim()));
}

/**
 * 表格 → 可读文本。
 *
 * 规则（写死，便于单测）：
 *   · 每条数据行 = 「• 列1：值1 · 列2：值2 …」；
 *   · 列数 ≤3 且整行显示宽度 ≤60 → 单行；否则拆成「• 记录 N」+ 每列一行（避免超宽/被客户端折行成乱码）；
 *   · 表头作为**列名**逐行带上（不是另起一行表格头——用户要的是"看得懂哪列是什么"）。
 * @param {string[]} lines 连续的表格行
 * @returns {string[]} 转换后的行（不含 `|---`）
 */
export function convertMarkdownTable(lines) {
  const rows = (Array.isArray(lines) ? lines : []).map(splitTableRow);
  if (!rows.length) return [];
  let header = null;
  let dataRows = rows;
  if (rows.length >= 2 && isSeparatorRow(rows[1])) { header = rows[0]; dataRows = rows.slice(2); }
  else if (rows.length >= 1 && isSeparatorRow(rows[0])) { dataRows = rows.slice(1); }
  else { header = rows[0]; dataRows = rows.slice(1); }
  const colCount = Math.max(
    header ? header.length : 0,
    ...dataRows.map((r) => r.length),
    0
  );
  const out = [];
  let index = 0;
  for (const row of dataRows) {
    if (!row || isSeparatorRow(row)) continue;
    index += 1;
    const cells = [];
    for (let c = 0; c < colCount; c += 1) {
      const rawName = header && header[c] ? String(header[c]).trim() : "";
      const name = rawName || `列${c + 1}`;
      const val = row[c] == null ? "" : String(row[c]).trim();
      if (!val) continue;
      cells.push({ name, val });
    }
    if (!cells.length) continue;
    const oneLine = cells.map((c) => `${c.name}：${c.val}`).join(" · ");
    if (cells.length <= 3 && displayWidth(oneLine) <= 60) {
      out.push(`• ${oneLine}`);
      continue;
    }
    out.push(`• 记录 ${index}`);
    for (const c of cells) out.push(`  ${c.name}：${c.val}`);
  }
  return out;
}

// ---------- 行级转换 ----------

const RE_FENCE = /^\s{0,3}(```|~~~)/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TASK = /^(\s*)([-*+]|\d+\.)\s+\[( |x|X)\]\s+(.*)$/;
const RE_NESTED_LIST = /^(\s{2,})([-*+]|\d+\.)\s+(.*)$/;
const RE_BULLET = /^(\s*)([-*+])\s+(.*)$/;

/** 把一段"非代码块"文本按行转换（markdown 通道保留 inline 语法；非 markdown 通道降级）。 */
function convertLines(lines, markdown) {
  const out = [];
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    const converted = convertMarkdownTable(table);
    if (converted.length) {
      out.push("", ...converted, "");
    }
    table = [];
  };
  for (const rawLine of lines) {
    const line = String(rawLine == null ? "" : rawLine);
    if (isTableLine(line)) { table.push(line); continue; }
    flushTable();
    // 标题
    const heading = RE_HEADING.exec(line);
    if (heading) {
      const text = heading[2].trim();
      out.push(markdown ? `**${text}**` : text);
      continue;
    }
    // 分隔线 → 空行
    if (RE_HR.test(line)) { out.push(""); continue; }
    // 引用
    const quote = RE_QUOTE.exec(line);
    if (quote) { out.push(`› ${quote[1].trim()}`); continue; }
    // 任务列表（☐/☑，不再保留 `- [ ]`）
    const task = RE_TASK.exec(line);
    if (task) {
      const done = String(task[3]).toLowerCase() === "x";
      const box = done ? "☑" : "☐";
      out.push(markdown ? `- ${box} ${task[4].trim()}` : `${box} ${task[4].trim()}`);
      continue;
    }
    // 嵌套列表：压平一层（更深缩进统一成 2 空格 + `·`，不再出现多层缩进）
    const nested = RE_NESTED_LIST.exec(line);
    if (nested) { out.push(`  · ${nested[3].trim()}`); continue; }
    // 普通列表：非 markdown 通道把 `-` 换成 `•`（markdown 通道保持）
    const bullet = RE_BULLET.exec(line);
    if (bullet && !markdown) { out.push(`${bullet[1]}• ${bullet[3].trim()}`); continue; }
    out.push(markdown ? line : line.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"));
  }
  flushTable();
  return out;
}

/** 整段 Markdown → 目标通道文本（代码块原样保留）。 */
function convertMarkdownLike(input, markdown) {
  const text = String(input == null ? "" : input);
  if (!text.trim()) return "";
  const lines = text.split("\n");
  const out = [];
  let code = [];
  let inCode = false;
  const flushCode = () => {
    if (!code.length) return;
    if (markdown) out.push(...code);
    else {
      // 非 markdown 通道：去掉围栏，内容缩进两格（保持"是代码"的观感，不出现 ```）
      for (const line of code) {
        if (RE_FENCE.test(line)) continue;
        out.push(line ? `  ${line}` : "");
      }
    }
    code = [];
  };
  let plainBuffer = [];
  const flushPlain = () => {
    if (!plainBuffer.length) return;
    out.push(...convertLines(plainBuffer, markdown));
    plainBuffer = [];
  };
  for (const line of lines) {
    if (RE_FENCE.test(line)) {
      if (!inCode) { flushPlain(); inCode = true; code = [line]; continue; }
      code.push(line); flushCode(); inCode = false; continue;
    }
    if (inCode) { code.push(line); continue; }
    plainBuffer.push(line);
  }
  if (inCode) flushCode(); // 未闭合的代码块也原样保留（不吞内容）
  flushPlain();
  // 收尾清理：行尾空格 / 连续空行压成一个 / 首尾空行去掉
  const cleaned = [];
  for (const line of out) {
    const trimmedRight = String(line).replace(/[ \t]+$/, "");
    if (trimmedRight === "" && (cleaned.length === 0 || cleaned[cleaned.length - 1] === "")) continue;
    cleaned.push(trimmedRight);
  }
  while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();
  return cleaned.join("\n");
}

// ---------- 截断（按 UTF-8 字节 / 字符，优先段落边界） ----------

function fitsBoth(value, maxBytes, maxChars) {
  if (utf8Bytes(value) > maxBytes) return false;
  if (maxChars !== Infinity && [...String(value)].length > maxChars) return false;
  return true;
}

/**
 * 安全截断：优先整段 → 整行 → 逐码点；绝不切在 UTF-8 中间（用 `for...of` 按码点累加）。
 * 结果末尾附 `suffix`（调用方保证 suffix 也计入上限）。
 * @returns {string}
 */
export function truncateUtf8Safe(text, { maxBytes = Infinity, maxChars = Infinity, suffix = TRUNCATED_NOTE } = {}) {
  const body = String(text == null ? "" : text);
  if (fitsBoth(body, maxBytes, maxChars)) return body;
  const tail = `\n${suffix}`;
  const budgetBytes = maxBytes - utf8Bytes(tail);
  const budgetChars = maxChars === Infinity ? Infinity : maxChars - [...tail].length;
  if (budgetBytes <= 0 || (budgetChars !== Infinity && budgetChars <= 0)) return suffix;
  // ① 段落
  let out = "";
  for (const para of body.split(/\n{2,}/)) {
    const cand = out ? `${out}\n\n${para}` : para;
    if (!fitsBoth(cand, budgetBytes, budgetChars)) break;
    out = cand;
  }
  // ② 行
  if (!out) {
    for (const line of body.split("\n")) {
      const cand = out ? `${out}\n${line}` : line;
      if (!fitsBoth(cand, budgetBytes, budgetChars)) break;
      out = cand;
    }
  }
  // ③ 逐码点（不会切坏代理对/中文）
  if (!out) {
    for (const ch of body) {
      const cand = out + ch;
      if (!fitsBoth(cand, budgetBytes, budgetChars)) break;
      out = cand;
    }
  }
  return `${out.replace(/[ \t]+$/, "")}${tail}`;
}

// ---------- 对外主函数 ----------

/**
 * 按通道能力格式化消息。
 *
 * 支持的选项：
 *   · `text`      正文（Markdown 源码）
 *   · `title`     可选标题（会作为加粗/纯文本首行；正文里的 `#` 标题也会各自转换）
 *   · `kind`      预留：目前不影响输出（钉钉/飞书将来可按 kind 分样式）
 *   · `maxChars`  字符上限（可选）
 *   · `maxBytes`  字节上限（默认按通道：wecom/dingtalk 4096；feishu 8192；plain/wechat 不限）
 *
 * @param {"wecom"|"dingtalk"|"feishu"|"wechat"|"plain"|string} channel
 * @param {{title?:string, text?:string, kind?:string, maxChars?:number, maxBytes?:number}} [options]
 * @returns {string}
 */
export function formatForChannel(channel, options = {}) {
  const name = normalizeChannelName(channel);
  const caps = CHANNEL_CAPS[name] || CHANNEL_CAPS.plain;
  const markdown = caps.markdown === true;
  const rawText = String(options.text == null ? "" : options.text);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes) : DEFAULT_MAX_BYTES[name];
  const maxChars = Number.isFinite(Number(options.maxChars)) && Number(options.maxChars) > 0
    ? Number(options.maxChars) : Infinity;

  // 调用方可能已经自己截断过并附了 suffix（wecom-bot 的回答回传会先按字符截 1500）：
  // 先摘掉，统一由本模块决定是否需要再按字节截，避免出现两个「已截断」。
  let preTruncated = false;
  let bodyText = rawText;
  if (bodyText.endsWith(TRUNCATED_NOTE)) {
    preTruncated = true;
    bodyText = bodyText.slice(0, -TRUNCATED_NOTE.length);
  }

  let body = convertMarkdownLike(bodyText, markdown);
  const title = String(options.title == null ? "" : options.title).trim();
  if (title) {
    const titleLine = markdown ? `**${title}**` : title;
    body = body ? `${titleLine}\n\n${body}` : titleLine;
  }
  // 微信通道有其自己的特殊格式（wechat-runtime 负责）：这里只做 plain 兜底，且不截断（由微信侧管）。
  if (name === "wechat") return body;

  const fitted = truncateUtf8Safe(body, { maxBytes, maxChars, suffix: TRUNCATED_NOTE });
  if (fitted === body) {
    // 原本就在上限内：如果调用方已标过截断，保留它的提示（不要悄悄丢掉；保持原样拼接）
    return preTruncated ? `${body}${TRUNCATED_NOTE}` : body;
  }
  return fitted;
}


// ===========================================================================
// 任务总结（turn_done / turn_error / turn_blocked 通知带正文）
// ===========================================================================

function charsOf(text) { return Array.from(String(text == null ? "" : text)); }

function truncateChars(text, maxChars) {
  const chars = charsOf(text);
  if (!Number.isFinite(maxChars) || maxChars <= 0 || chars.length <= maxChars) return String(text == null ? "" : text);
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

/** 截断到 maxChars（含「已截断」提示；与 formatForChannel 的提示同文，避免重复）。 */
function truncateCharsWithNote(text, maxChars) {
  let body = String(text == null ? "" : text);
  const hadNote = body.endsWith(TRUNCATED_NOTE);
  if (hadNote) body = body.slice(0, -TRUNCATED_NOTE.length).replace(/\s+$/, "");
  const chars = charsOf(body);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return hadNote ? `${body}${TRUNCATED_NOTE}` : body;
  const noteChars = charsOf(TRUNCATED_NOTE).length + 1; // 换行 + 提示一起算进上限
  if (chars.length + noteChars <= maxChars) return hadNote ? `${body}${TRUNCATED_NOTE}` : body;
  const budget = Math.max(1, maxChars - noteChars);
  return `${chars.slice(0, budget).join("").replace(/\s+$/, "")}\n${TRUNCATED_NOTE}`;
}

/** 事件里能当"摘要"的字段（订阅器取不到正文时的降级来源）。 */
export function extractSummaryFromNode(node) {
  if (!node || typeof node !== "object") return "";
  for (const key of ["summary", "message", "detail", "text"]) {
    const v = node[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * 提取一次 turn 的**总结正文**（优先级：订阅器 lastAssistantText → 事件字段 → 空）。
 *
 * · `subscriber.lastAssistantText({sessionId})` 是最准的（agent 最终回答原文）；
 * · turn/end 瞬间正文可能还没落库 → 支持 `retryDelays`（如 [0,400]）短重试；
 * · 都取不到 → 返回空 text（调用方降级"仅标题"，不报错）；
 * · 返回值只含正文；**日志由调用方只打长度**（正文可能有代码/密钥/隐私）。
 *
 * @returns {Promise<{text:string, source:"assistant"|"node"|"none"}>}
 */
export async function extractTurnSummary({ node, subscriber, sessionId, maxChars = SUMMARY_MAX_CHARS, retryDelays = null } = {}) {
  const sid = String(sessionId || (node && node.sessionId) || "");
  const delays = Array.isArray(retryDelays) && retryDelays.length ? retryDelays : [0];
  let lastEmpty = "";
  if (subscriber && typeof subscriber.lastAssistantText === "function" && sid) {
    for (const delay of delays) {
      if (Number(delay) > 0) {
        try { await new Promise((r) => setTimeout(r, Math.min(Number(delay) || 0, 5000))); } catch { /* 忽略 */ }
      }
      try {
        const r = await subscriber.lastAssistantText({ sessionId: sid });
        if (r && r.ok === true && typeof r.text === "string" && r.text.trim()) {
          return { text: truncateCharsWithNote(r.text.trim(), maxChars), source: "assistant" };
        }
        lastEmpty = String((r && (r.code || r.message)) || "empty");
      } catch { /* 下一次重试 */ }
    }
  }
  const fallback = extractSummaryFromNode(node);
  if (fallback) return { text: truncateCharsWithNote(fallback, maxChars), source: "node" };
  return { text: "", source: "none", reason: lastEmpty };
}

/** 各 reason 的通知首行（与既有通知文案保持一致）。 */
export function turnHeadline(node) {
  if (!node || typeof node !== "object") return "";
  const kind = String(node.kind || "");
  if (kind === "session-error") return "❌ 出错了";
  if (kind !== "turn-end") return "";
  const reason = String(node.reason || "unknown");
  if (reason === "completed") return "✅ 任务完成";
  if (reason === "error" || reason === "max-tokens") return "❌ 出错了";
  if (reason === "blocked") return "⛔ 被拦下了";
  if (reason === "aborted" || reason === "interrupted") return "⏹ 已停止";
  return "ℹ️ 任务结束";
}

/**
 * 组装「任务完成/出错」通知：`✅ 任务完成｜<标题>\n\n<总结正文>`。
 *
 * · 正文为空 → 只返回标题行（降级，不报错）；
 * · 正文按通道渲染（表格转可读列表、按通道字节上限截断），并限制 **1500 字**；
 * · 非 turn/session-error 事件返回 null（审批类仍走卡片，不混入总结）。
 *
 * @returns {string|null}
 */
export function buildTurnNotification({ node, channel = "wecom", summary = "", sessionTitle = "", maxChars = SUMMARY_MAX_CHARS } = {}) {
  const head = turnHeadline(node);
  if (!head) return null;
  const title = truncateChars(String(sessionTitle || "").replace(/\s+/g, " ").trim(), 40);
  const line = title ? `${head}｜${title}` : head;
  const raw = String(summary == null ? "" : summary).trim();
  if (!raw) return line; // 取不到正文 → 保持"仅标题"
  const formatted = formatForChannel(channel, { text: raw, maxChars });
  return formatted ? `${line}\n\n${formatted}` : line;
}

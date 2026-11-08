/**
 * wecom-bot — 企业微信「智能机器人」WebSocket 长连接通道（bridge 侧，2026-11-07 / task-21）。
 *
 * 为什么是长连接而不是 webhook 群机器人（业主 2026-11-07 纠正方向）
 * -----------------------------------------------------------------
 * 群机器人 webhook 只能「发」不能「收」，而且收消息要公网回调地址；企业微信「智能机器人」
 * 支持 Bot ID + Secret 直连官方 WebSocket，电脑在线就能双向联动（收消息 / 被动回复 / 主动推送）。
 *
 * 协议事实（Lead 已用真实凭据实测通过，此处照抄，勿凭记忆改）
 * -----------------------------------------------------------------
 *   端点      wss://openws.work.weixin.qq.com（私有部署企业不同 → `url` 可配置）
 *   认证      → {cmd:"aibot_subscribe", headers:{req_id}, body:{secret, bot_id}}
 *             ← {headers:{req_id}, errcode:0, errmsg:"ok"}      errcode≠0 = 凭据错（不可重试）
 *   心跳      → {cmd:"ping", headers:{req_id}}，间隔 30s；连续 2 次无 ack 判死重连
 *   入站消息  ← {cmd:"aibot_msg_callback", headers:{req_id}, body:{msgid, msgtype, text:{content}, …}}
 *   入站事件  ← {cmd:"aibot_event_callback", …}（enter_chat / template_card_event / feedback_event …）
 *   被动回复  → {cmd:"aibot_respond_msg", headers:{req_id: 入站帧的 req_id},
 *                body:{msgtype:"stream", stream:{id, finish, content}}}
 *   主动推送  → {cmd:"aibot_send_msg", headers:{req_id}, body:{chatid, msgtype:"markdown", markdown:{content}}}
 *             · 单聊 chatid = 对方 userid；群聊 chatid = 群 chatid
 *
 * ⚠️ 必须 `import WebSocket from "ws"`，**不要用 Node 全局 WebSocket**（本机实测 1006 失败）。
 * `ws` 已是本项目运行时依赖（`clients/dsh-remote/package.json` + 插件自带 runtime 都带）。
 *
 * 设计边界（每一条都重要）
 * -----------------------------------------------------------------
 * 1. **默认关闭**：没有 `im-bots.json` / 未启用 / 缺 botId+secret → 什么都不起（零副作用）。
 * 2. **凭据错 ≠ 网络断**：errcode≠0 → 立即停止并记明确错误，**绝不无限重连**（否则会被官方限流/封禁）；
 *    网络断/心跳超时 → 指数退避 1s→2s→…→30s 重连。
 * 3. **secret 绝不进日志**：本模块只打印 cmd/errcode/chatid 哈希；日志器再做一层字面量脱敏兜底。
 * 4. **不阻塞主链路**：所有失败都吞掉只记日志；通知发送 fire-and-forget，绝不影响隧道。
 * 5. **文件按契约**：`im-bots.json`（插件写，桥只读）/ `im-bot-status.json`（桥写，原子替换 + 0600）。
 *
 * 对外 API（task-21 规格）
 * -----------------------------------------------------------------
 *   createWecomBot({botId, secret, url?, logger?, clock?, wsFactory?, ...})
 *     → {start, stop, sendMarkdown(chatid, text), replyStream(frame, id, content, finish), status(), on(evt)}
 *   createWecomBotController({relayDir, ...})
 *     → {start, stop, status()}   // 读配置 + fs.watchFile(2s) 热更新；bridge 只需要它
 * 纯函数（便于单测，不依赖网络）：normalizeImBotsConfig / readImBotsConfig /
 *   normalizeAllowList / extractInboundText / pickInboundIdentity / toMarkdownNotification /
 *   atomicWriteJson / hardenFile / maskSecrets
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { createEventSubscriber, NODE_KINDS } from "./dsh-events.mjs";
// 通道感知格式化（2026-11-08：企微/钉钉 markdown 不支持表格，发前统一适配；飞书/微信各有分支）
import { formatForChannel } from "./im-format.mjs";
// 命令层（2026-11-08）：/help /status /stop /ls /use /unbind 在**进模型前**拦下执行；
// 解析/文案/能力门禁三家共用（与会员升级文案同口径）。
import { executeImCommand, writeImBotsSession } from "./im-commands.mjs";
// 会员能力表 = **单一真相源**：直接复用微信通道那套（WECHAT_CAPABILITY_TABLE / limitsFor / grantsCap），
// 不另造一套。企微/飞书/钉钉将来都套同一套判定（见 research/.../im-channel-membership-design.md）。
import {
  WECHAT_CAPABILITY_TABLE,
  WECHAT_TIER_LIMITS,
  capabilitiesFor,
  grantsCap,
  limitsFor
} from "./wechat-runtime.mjs";

// ===========================================================================
// 1. 常量 / 契约文件名
// ===========================================================================

/** 官方智能机器人长连接地址（企业私有部署可能不同 → 配置里可覆盖）。 */
export const DEFAULT_WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
/** 配置文件（**插件写、桥只读**；内含明文 secret，必须 0600）。 */
export const IM_BOTS_FILE = "im-bots.json";
/** 状态文件（**桥写、插件读**；原子替换 + 0600，绝不含 secret）。 */
export const IM_BOT_STATUS_FILE = "im-bot-status.json";

/** 心跳间隔 / 连续未 ack 判死次数（协议事实：30s，连续 2 次）。 */
export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT_MAX_MISS = 2;
/** 认证应答超时：超时按「网络问题」重连（不按凭据错）。 */
export const AUTH_TIMEOUT_MS = 10_000;
/** 重连退避：1s 起、翻倍、30s 封顶。 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** 配置热更新轮询（fs.watchFile interval）。 */
export const CONFIG_POLL_MS = 2_000;
/** 主动推送等 ack 的超时（只用于记账/日志，不阻塞）。 */
export const SEND_ACK_TIMEOUT_MS = 15_000;
/** 通知正文上限（企业微信 markdown 单条有长度限制，这里先截）。 */
export const NOTIFY_MAX_CHARS = 600;
/** 「回答回传」：入站后多久内到达的 turn/end 才回传正文（超时视为另一次对话 → 回到标题通知）。 */
export const ANSWER_RELAY_TTL_MS = 10 * 60 * 1000;
/** 「回答回传」正文上限；超出截断并注明。 */
export const ANSWER_MAX_CHARS = 1500;
/** 截断提示（用户能看懂、也知道去哪看全文）。 */
export const ANSWER_TRUNCATED_NOTE = "…(已截断，完整内容看电脑)";
/**
 * 取「最终回答」的重试间隔（ms）。
 * 为什么要有：turn/end 与"最终消息已落进会话历史"之间可能有极短竞态 —— 第一次 pageSession
 * 拿到的是空/上一条。只在「ok 但没有正文」时补一次（400ms），拿到就发；这是唯一会多等的场景。
 */
export const ANSWER_FETCH_RETRY_DELAYS_MS = Object.freeze([0, 400]);

/* ── 审批卡片（task-24）────────────────────────────────────────────────────────
 * 协议来自官方 @wecom/aibot-node-sdk 类型定义（Lead 已核实）：
 *   发卡：{cmd:"aibot_send_msg", headers:{req_id}, body:{chatid, msgtype:"template_card", template_card:{...}}}
 *   点按钮 → 入站 {cmd:"aibot_event_callback", body:{event:{eventtype:"template_card_event", event_key, task_id}}}
 *   更新：{cmd:"aibot_respond_update_msg", headers:{req_id:事件帧的req_id},
 *          body:{response_type:"update_template_card", template_card:{...改后的卡...}}}
 */
/** 审批卡 TTL（与系统一致 90s）：过期后再点按「拒绝」处理（fail-closed）。 */
export const APPROVAL_CARD_TTL_MS = 90_000;
/** 卡片摘要上限（官方 sub_title_text 限 112 字）。 */
export const APPROVAL_CARD_SUMMARY_MAX = 112;
/** task_id 上限（官方：字母数字-_@，≤128）。 */
export const APPROVAL_CARD_TASK_ID_MAX = 128;
/** 审批卡在内存里最多保留多少张（超出丢最旧；只影响「点旧卡」时的幂等/过期判定）。 */
export const APPROVAL_CARD_MAX = 50;
/** 状态文件 `sessions[]` 上限（task-24：≤10，只含 id/title/updatedAt）。 */
export const SESSION_LIST_MAX = 10;
/** 预览卡片（自检/演示）：内存里最多记住几张（独立于真实审批，绝不进幂等表）。 */
export const PREVIEW_CARD_MAX = 10;
/** 会话列表（含标题/updatedAt）的刷新节流；会话事件很密，避免每来一条就查一次 DSH。 */
export const SESSION_LIST_REFRESH_MS = 30_000;
/** 入站 msgid 去重表上限 / TTL（重连后官方可能补发同一条）。 */
export const SEEN_MSG_MAX = 200;
export const SEEN_MSG_TTL_MS = 10 * 60 * 1000;
/** 日志行上限（内存里留最近 N 行，供测试断言「secret 从未出现」）。 */
export const LOG_MAX_LINES = 200;

const WS_OPEN = 1;

// ===========================================================================
// 2. 小工具：脱敏 / 日志 / 文件
// ===========================================================================

/** 类似命令行的敏感字段（`secret=xxx` / `"secret":"xxx"` / `bot_id=xxx`）一律抹掉。 */
const SECRET_FIELD_RE = /("?(?:secret|bot_id|botid|app_secret|appsecret|token|password)"?\s*[:=]\s*)("?)([^",\s}]+)\2/gi;

/**
 * 把已知密钥字面量与「像密钥的字段」都抹成 ***（日志的最后一道防线）。
 * @param {string} text
 * @param {string[]} [knownSecrets]
 * @returns {string}
 */
export function maskSecrets(text, knownSecrets = []) {
  let out = String(text == null ? "" : text);
  for (const s of knownSecrets) {
    const v = String(s || "");
    if (v.length < 4) continue;
    out = out.split(v).join("***");
  }
  return out.replace(SECRET_FIELD_RE, (_m, head) => `${head}"***"`).replace(/(secret|bot_id|botid)=\S+/gi, (_m, k) => `${k}=***`);
}

/**
 * chatid 的短哈希：日志里只打这个（chatid 是 userid/群 id，属于可识别信息）。
 * @param {string} chatid
 * @returns {string} 空串或 8 位十六进制
 */
export function chatIdHash(chatid) {
  const v = String(chatid || "").trim();
  if (!v) return "";
  try {
    return crypto.createHash("sha1").update(v).digest("hex").slice(0, 8);
  } catch {
    return "????????";
  }
}

/** 截断（单行化），用于错误/标题。 */
export function truncateText(value, max = 120) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * 极简作用域日志器（与 wechat-channel 的 createLogger 同思路：内存留痕 + 全量脱敏）。
 *
 * 绝不打印完整帧：本模块自己只传 cmd/errcode/chatid 哈希/短原因；日志器再兜一层字面量脱敏，
 * 所以即使调用方手滑把 secret 拼进消息，也不会落盘（`logger.lines` 供测试钉死这一点）。
 *
 * @param {{sink?: Function|object, secrets?: string[], prefix?: string, maxLines?: number}} opts
 * @returns {{info:Function,warn:Function,error:Function,debug:Function,lines:string[]}}
 */
export function createScopedLogger(opts = {}) {
  const prefix = String(opts.prefix || "[wecom]");
  const maxLines = Number.isFinite(opts.maxLines) ? Math.max(1, opts.maxLines) : LOG_MAX_LINES;
  const known = Array.isArray(opts.secrets) ? opts.secrets.filter((s) => typeof s === "string" && s.length >= 4) : [];
  const sink = opts.sink;
  const lines = [];
  const push = (level, message) => {
    let line;
    try {
      line = `${prefix} ${level} ${maskSecrets(message, known)}`;
    } catch {
      line = `${prefix} ${level} <log-failed>`;
    }
    lines.push(line);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    try {
      if (typeof sink === "function") sink(level, line);
      else if (sink && typeof sink[level] === "function") sink[level](line);
    } catch {
      /* 日志失败绝不影响业务 */
    }
  };
  return {
    info: (m) => push("info", m),
    warn: (m) => push("warn", m),
    error: (m) => push("warn", m), // bridge 日志里 error 也落 warn（保持与其它模块一致）
    debug: (m) => push("debug", m),
    lines
  };
}

/**
 * 把文件权限收紧到「只有本人可读写」。
 *
 * ⚠️ Windows 上 `{mode:0o600}` 是空操作（Windows 用 ACL）：实测默认拿到的是用户目录继承 ACL，
 * 备份/同步盘/支持包都会连 secret 一起带走。这里显式断继承、只授当前用户；失败只告警一次。
 * （与 wechat-channel/dsh-bridge 里的同名实现等价 —— 本模块必须零内部依赖、可独立单测。）
 *
 * @param {string} file
 * @param {(msg:string)=>void} [onWarn]
 */
let hardenWarned = false;
export function hardenFile(file, onWarn) {
  try { fs.chmodSync(file, 0o600); } catch { /* POSIX 上失败不致命 */ }
  if (process.platform !== "win32") return;
  const who = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");
  if (!who) {
    if (!hardenWarned) {
      hardenWarned = true;
      const msg = `无法收紧文件权限（USERDOMAIN/USERNAME 均未设置）：${file}`;
      if (typeof onWarn === "function") onWarn(msg); else console.warn(`⚠️ ${msg}`);
    }
    return;
  }
  let r;
  try {
    r = spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`],
      { windowsHide: true, encoding: "utf8", timeout: 8000 });
  } catch (e) { r = { status: -1, stderr: e.message }; }
  if (r.status !== 0 && !hardenWarned) {
    hardenWarned = true;
    const msg = `收紧文件权限失败(${who})：${String(r.stderr || "").trim() || `icacls 退出码 ${r.status}`}`;
    if (typeof onWarn === "function") onWarn(msg); else console.warn(`⚠️ ${msg}`);
  }
}

/**
 * 原子写 JSON：同目录临时文件 → rename（同文件系统 rename 是原子的）。
 *
 * 为什么必须原子：插件每 2s 左右读一次状态文件渲染 UI；直接 writeFileSync 有「读到写了一半的
 * 半个 JSON」的窗口，而那份文件是面板判断「机器人是否在线」的唯一依据。
 * 失败时清理临时文件，**绝不留下半成品**。
 *
 * @param {string} file
 * @param {unknown} data
 * @param {{onWarn?:(m:string)=>void}} [opts]
 */
export function atomicWriteJson(file, data, opts = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    hardenFile(tmp, opts.onWarn);
    fs.renameSync(tmp, file); // 原子替换
    hardenFile(file, opts.onWarn);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    throw e;
  }
}

/** 读 JSON 文件（不存在/坏 JSON → null，绝不抛）。 */
export function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** 读文件的 POSIX 权限位（Windows 上不可信，测试里按平台跳过断言）。 */
export function fileMode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return null; }
}

// ===========================================================================
// 3. 配置契约：im-bots.json（插件写 / 桥读）
// ===========================================================================

/**
 * `im-bots.json` 的规范形状（缺字段一律补默认；非法值当未配置，**绝不抛**）：
 *
 * ```json
 * {
 *   "version": 1,
 *   "wecom": {
 *     "enabled": true,
 *     "botId": "",
 *     "secret": "",
 *     "url": "",                // 可选：私有部署企业填自己的长连接地址
 *     "targetChatId": "",       // 可选：主动推送的兜底接收方（userid 或群 chatid）
 *     "allowFrom": [],          // 可选：入站白名单（userid / chatid），空 = 首次发送者自动绑定
 *     "sessionId": "",          // 可选：**固定转发目标会话**（空 = 跟随当前活跃会话）
 *     "sessionTitle": "",       // 可选：上面那个会话的显示名（只用于状态文件/面板展示）
 *     "previewCardAt": 0        // 可选：**发送预览卡片**的触发时间戳（ms；插件写、桥读）
 *   },
 *   "feishu": { "enabled": false, "appId": "", "appSecret": "" }
 * }
 * ```
 *
 * @param {any} raw
 * @returns {{version:number, wecom:{enabled:boolean,botId:string,secret:string,url:string,targetChatId:string,allowFrom:string[],sessionId:string,sessionTitle:string,previewCardAt:number}, feishu:{enabled:boolean,appId:string,appSecret:string}}}
 */
export function normalizeImBotsConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const w = src.wecom && typeof src.wecom === "object" && !Array.isArray(src.wecom) ? src.wecom : {};
  const f = src.feishu && typeof src.feishu === "object" && !Array.isArray(src.feishu) ? src.feishu : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    version: Number.isFinite(Number(src.version)) ? Number(src.version) : 1,
    wecom: {
      enabled: w.enabled === true,
      botId: str(w.botId),
      secret: typeof w.secret === "string" ? w.secret : "",
      url: str(w.url),
      targetChatId: str(w.targetChatId),
      allowFrom: normalizeAllowList(w.allowFrom),
      // 会话可选绑定（task-24）：空 = 跟随「最近活跃会话」
      sessionId: str(w.sessionId),
      sessionTitle: str(w.sessionTitle),
      // 预览卡片触发时间戳（ms）：插件每点一次「发送预览」就写一个新值
      previewCardAt: Number.isFinite(Number(w.previewCardAt)) && Number(w.previewCardAt) > 0 ? Number(w.previewCardAt) : 0
    },
    feishu: {
      enabled: f.enabled === true,
      appId: str(f.appId),
      appSecret: typeof f.appSecret === "string" ? f.appSecret : ""
    }
  };
}

/**
 * 入站白名单规范化：只接受字符串数组，去空去重、最多 50 个（防止配置写坏成对象/巨数组）。
 * @param {any} raw
 * @returns {string[]}
 */
export function normalizeAllowList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * 从 `relayDir/im-bots.json` 读配置。
 * @param {string} relayDir
 * @returns {ReturnType<typeof normalizeImBotsConfig>|null} 文件不存在 → null；解析失败 → null
 */
export function readImBotsConfig(relayDir) {
  if (!relayDir) return null;
  const raw = readJsonFile(path.join(String(relayDir), IM_BOTS_FILE));
  if (raw === null) return null;
  return normalizeImBotsConfig(raw);
}

// ===========================================================================
// 4. 入站解析（纯函数，便于钉住字段形状）
// ===========================================================================

/**
 * 从入站 body 里抽文本（尽力而为，不认识就返回空串）。
 *
 * 已知形状：`{msgtype:"text", text:{content:"…"}}`；`mixed` 可能是
 * `{mixed:{msg_item:[{type:"text", text:{content}}]}}` 或 `{mixed:[…]}`；
 * `voice` 可能带 `voice.content`（语音转写文本，若有）。**绝不猜图片/文件内容**。
 *
 * @param {any} body
 * @returns {string}
 */
export function extractInboundText(body) {
  if (!body || typeof body !== "object") return "";
  const direct = body.text && typeof body.text === "object" ? body.text.content : undefined;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof body.content === "string" && body.content.trim()) return body.content.trim();
  const mixed = body.mixed;
  const items = mixed && typeof mixed === "object"
    ? (Array.isArray(mixed.msg_item) ? mixed.msg_item : Array.isArray(mixed.items) ? mixed.items : Array.isArray(mixed) ? mixed : [])
    : [];
  const parts = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const type = String(it.type || it.msgtype || "");
    if (type && type !== "text") continue;
    const c = it.text && typeof it.text === "object" ? it.text.content : undefined;
    if (typeof c === "string" && c.trim()) parts.push(c.trim());
  }
  if (parts.length) return parts.join("\n");
  const voice = body.voice && typeof body.voice === "object" ? body.voice : null;
  if (voice && typeof voice.content === "string" && voice.content.trim()) return voice.content.trim();
  if (typeof body.msgtype === "string" && body.msgtype !== "text" && body.msgtype !== "mixed") {
    // 图片/文件/语音无转写：只回一句提示由上层决定，不当作文本转发
    return "";
  }
  return "";
}

/**
 * 从入站 body 里抽「谁发的 / 哪个会话」。
 *
 * 单聊 chatid = 对方 userid；群聊 = 群 chatid（优先用 body.chatid，取不到再退回 userid）。
 * 各字段名在不同回调形状里略有差异，这里按**可信度**依次取，取不到给空串。
 *
 * @param {any} body
 * @returns {{fromUser:string, chatid:string, isGroup:boolean}} 
 */
export function pickInboundIdentity(body) {
  const b = body && typeof body === "object" ? body : {};
  const from = b.from && typeof b.from === "object" ? b.from : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const fromUser = str(from.userid) || str(from.user_id) || str(from.userId)
    || str(b.fromuserid) || str(b.from_userid) || str(b.userid) || str(b.user_id);
  const explicitChat = str(b.chatid) || str(b.chat_id) || str(from.chatid) || str(from.chat_id);
  const chattype = str(b.chattype) || str(b.chat_type) || str(b.type) || "";
  const isGroup = /group|chatroom|群/i.test(chattype);
  return { fromUser, chatid: explicitChat || (isGroup ? "" : fromUser), isGroup };
}

/**
 * 出站通知文案（Markdown；企业微信 markdown 支持粗体、emoji、换行）。
 *
 * 只映射「用户需要知道的三类」：任务完成 / 出错 / 需要拍板（含 agent 提问与计划审批）。
 * 其余节点（gap/fault/日报/额度…）**不在这里发** —— 微信通道与 push-reporter 已各自负责，
 * 重复推送是骚扰。
 *
 * @param {object} node dsh-events 的分类节点
 * @param {{sessionTitle?:(sessionId:string)=>string, maxChars?:number}} [opts]
 * @returns {string|null} 不需要推送 → null
 */
export function toMarkdownNotification(node, opts = {}) {
  if (!node || typeof node !== "object") return null;
  const sessionId = typeof node.sessionId === "string" ? node.sessionId : "";
  let title = "";
  try {
    if (typeof opts.sessionTitle === "function") title = String(opts.sessionTitle(sessionId) || "");
  } catch { title = ""; }
  title = truncateText(title || shortSession(sessionId), 40);
  const suffix = title ? `｜${title}` : "";
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(20, opts.maxChars) : NOTIFY_MAX_CHARS;

  let text = null;
  switch (node.kind) {
    case NODE_KINDS.TURN_END: {
      const reason = String(node.reason || "unknown");
      if (reason === "error" || reason === "max-tokens") {
        text = `❌ 出错了${suffix}`
          + (reason === "max-tokens" ? "\n输出被截断，可能需要你再给一句「继续」。" : "\n到电脑上看一眼错误详情。");
      } else if (reason === "blocked") {
        text = `⛔ 被拦下了${suffix}`;
      } else if (reason === "aborted" || reason === "interrupted") {
        text = `⏹ 已停止${suffix}`;
      } else if (reason === "completed") {
        text = `✅ 任务完成${suffix}`;
      } else {
        text = `ℹ️ 任务结束${suffix}（${truncateText(reason, 30)}）`;
      }
      break;
    }
    case NODE_KINDS.SESSION_ERROR:
      text = `❌ 出错了${suffix}${node.message ? "\n" + truncateText(node.message, 160) : ""}`;
      break;
    case NODE_KINDS.APPROVAL_REQUEST:
      text = `🛂 需要你在电脑上拍板｜${truncateText(node.toolName || node.reason || "一步操作", 60)}`
        + "\n（远程通道只读通知；请在电脑上确认）";
      break;
    case NODE_KINDS.USER_QUESTION:
      text = `🛂 需要你回答${suffix}\n（agent 在等你选一个选项，请到电脑上回答）`;
      break;
    case NODE_KINDS.PLAN_REVIEW:
      text = `🛂 等你批准计划${suffix}\n（请到电脑上确认计划）`;
      break;
    default:
      return null;
  }
  return truncateText(text, maxChars);
}

/** 会话 id 的短形式（日志/标题用；不泄露完整 id）。 */
function shortSession(sessionId) {
  const s = String(sessionId || "").replace(/^session-/, "");
  if (!s) return "";
  return s.length <= 12 ? s : s.slice(0, 8) + "…";
}

// ===========================================================================
// 4b. 审批卡片（纯函数，便于单测钉住报文形状）
// ===========================================================================

/** 安全哈希（字母数字）：task_id 只允许 [A-Za-z0-9-_@]，且 ≤128。 */
export function approvalTaskId(requestId) {
  const raw = String(requestId || "");
  let hash = "";
  try {
    hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 32);
  } catch {
    hash = "x" + raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 31);
  }
  const id = `apr_${hash}`;
  return id.length > APPROVAL_CARD_TASK_ID_MAX ? id.slice(0, APPROVAL_CARD_TASK_ID_MAX) : id;
}

/**
 * 解析按钮回调的 `event_key`（`allow:<requestId>` / `deny:<requestId>`）。
 * requestId 本身可能含 `:`（DSH eventId 形态不定），所以**只按第一个冒号切**。
 * @param {string} eventKey
 * @returns {{decision:"allow"|"deny", requestId:string}|null}
 */
export function parseApprovalEventKey(eventKey) {
  const raw = String(eventKey || "").trim();
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const kind = raw.slice(0, idx).trim().toLowerCase();
  const requestId = raw.slice(idx + 1).trim();
  if (!requestId) return null;
  if (kind === "allow" || kind === "allowed" || kind === "approve") return { decision: "allow", requestId };
  if (kind === "deny" || kind === "denied" || kind === "reject") return { decision: "deny", requestId };
  return null;
}

/**
 * 审批卡（button_interaction）报文。
 * @param {{requestId:string, title?:string, summary?:string, toolName?:string}} info
 */
export function buildApprovalCard(info = {}) {
  const requestId = String(info.requestId || "");
  const toolName = truncateText(info.toolName || "", 40);
  const title = truncateText(info.title || "需要你在电脑上拍板", 30);
  const summary = truncateText(info.summary || "", APPROVAL_CARD_SUMMARY_MAX);
  return {
    card_type: "button_interaction",
    task_id: approvalTaskId(requestId),
    main_title: {
      title,
      desc: toolName ? `工具：${toolName}` : "DeepSeek Harness 在等你允许一步操作"
    },
    // 官方限制 112 字；摘要只放"在等什么"，不放完整命令（隐私边界与 push-reporter 一致）
    sub_title_text: summary,
    button_list: [
      { text: "允许一次", key: `allow:${requestId}`, style: 1 },
      { text: "拒绝", key: `deny:${requestId}`, style: 2 }
    ]
  };
}

/** 卡片更新后的文案（决定/过期/失败）—— 用 text_notice（按钮消失，结果一目了然）。 */
export function buildDecidedCard(info = {}) {
  const state = String(info.state || "handled");
  const requestId = String(info.requestId || "");
  const who = truncateText(info.who || "", 40);
  const whenText = typeof info.at === "number" && info.at > 0 ? fmtClockFromMs(info.at) : "";
  const map = {
    allowed: { title: "✅ 已允许一次", desc: who ? `操作人：${who}` : "已允许一次" },
    denied: { title: "❌ 已拒绝", desc: who ? `操作人：${who}` : "已拒绝" },
    expired: { title: "⌛ 已过期（按拒绝处理）", desc: "超过 90 秒未处理，已 fail-closed 按拒绝执行" },
    failed: { title: "⚠️ 没能送达电脑端", desc: truncateText(info.reason || "请到电脑上确认", 60) },
    handled: { title: "ℹ️ 这条审批已经处理过了", desc: who ? `操作人：${who}` : "" },
  };
  const hit = map[state] || map.handled;
  return {
    card_type: "text_notice",
    task_id: approvalTaskId(requestId),
    main_title: { title: hit.title, desc: hit.desc },
    sub_title_text: whenText ? `处理时间：${whenText}` : ""
  };
}

/**
 * 预览审批卡（button_interaction）：让业主不用等真实审批就能看到卡片长什么样、按钮能不能点。
 * task_id / 按钮 key 都带 `preview` 且以时间戳结尾 —— 点击时能一眼识别，**绝不会走进真实审批**。
 * @param {number} ts 触发时间戳（ms；来自 im-bots.json 的 previewCardAt）
 */
export function buildPreviewCard(ts) {
  const stamp = String(Number(ts) || 0).slice(-10);
  return {
    card_type: "button_interaction",
    task_id: `apr_preview_${stamp}`,
    main_title: {
      title: "预览：需要你在电脑上拍板",
      desc: "这是一张预览卡片，不会真的执行操作"
    },
    sub_title_text: "点一下下面的按钮试试：只会更新这张卡片，不会执行任何操作",
    button_list: [
      { text: "允许一次", key: `allow:preview:${stamp}`, style: 1 },
      { text: "拒绝", key: `deny:preview:${stamp}`, style: 2 }
    ]
  };
}

/** 预览卡点击后的结果卡（text_notice；按钮消失、说明这是演示）。 */
export function buildPreviewDecidedCard(info = {}) {
  const decision = info.decision === "allow" ? "允许" : "拒绝";
  const who = truncateText(info.who || "", 40);
  const whenText = typeof info.at === "number" && info.at > 0 ? fmtClockFromMs(info.at) : "";
  const parts = [];
  if (who) parts.push(`操作人：${who}`);
  if (whenText) parts.push(`时间：${whenText}`);
  return {
    card_type: "text_notice",
    task_id: typeof info.taskId === "string" && info.taskId ? info.taskId : `apr_preview_${String(Number(info.ts) || 0).slice(-10)}`,
    main_title: {
      title: `预览卡片 · 已收到你的选择（${decision}）`,
      desc: "这是预览卡片，没有对应的真实操作"
    },
    sub_title_text: parts.join(" ｜ ")
  };
}

/** 是否是预览卡的按钮（`allow:preview:<ts>` / `deny:preview:<ts>` 或 task_id 前缀）。 */
export function isPreviewCardEvent(requestId, taskId) {
  if (/^preview:/.test(String(requestId || ""))) return true;
  if (/^apr_preview_/.test(String(taskId || ""))) return true;
  return false;
}

/** 毫秒时间戳 → HH:MM:SS（本地时区；只用于卡片确认文案）。 */
function fmtClockFromMs(ms) {
  try {
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return ""; }
}

/**
 * 状态文件里的 `sessions[]`（≤10，只含 id/title/updatedAt；**绝不含消息正文**）。
 * @param {Array<{id:string,title?:string,updatedAt?:number}>} list
 */
export function normalizeSessionStatusList(list) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(list) ? list : [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const id = typeof it.id === "string" ? it.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: truncateText(it.title || "", 60),
      updatedAt: Number.isFinite(Number(it.updatedAt)) ? Number(it.updatedAt) : 0
    });
    if (out.length >= SESSION_LIST_MAX) break;
  }
  return out;
}

// ===========================================================================
// 5. WebSocket 长连接客户端
// ===========================================================================

/**
 * 创建企业微信智能机器人长连接客户端。
 *
 * @param {{
 *   botId: string, secret: string, url?: string,
 *   relayDir?: string,                        // 有值时写 im-bot-status.json（桥的场景）
 *   targetChatId?: string, allowFrom?: string[],
 *   notify?: boolean,                         // 出站通知总开关（默认 true，还要过 env）
 *   logger?: Function|{info?:Function,warn?:Function,error?:Function,debug?:Function},
 *   clock?: () => number,
 *   wsFactory?: (url:string)=>any,            // 仅测试：注入假 WS；默认 new WebSocket(url)
 *   subscriber?: any,                         // 注入既有订阅器（bridge 可选复用）
 *   createSubscriber?: () => any,             // 注入工厂
 *   upstream?: string|(()=>string),           // 默认订阅器的上游（让端口漂移能跟上）
 *   cookie?: string|(()=>string),
 *   sessionTitle?: (sessionId:string)=>string,
 *   sessionIdProvider?: () => string,         // 入站转发目标会话（bridge 可注入）
 *   heartbeatMs?: number, heartbeatMaxMiss?: number, authTimeoutMs?: number,
 *   reconnectBaseMs?: number, reconnectMaxMs?: number, sendAckTimeoutMs?: number,
 *   maxNotifyPerMinute?: number               // 通知限速（默认 10，防事件风暴刷屏）
 * }} options
 */
export function createWecomBot(options = {}) {
  const botId = String(options.botId || "").trim();
  const secret = typeof options.secret === "string" ? options.secret : "";
  const url = String(options.url || "").trim() || DEFAULT_WECOM_WS_URL;
  const relayDir = options.relayDir ? String(options.relayDir) : "";
  const targetChatId = String(options.targetChatId || "").trim();
  const allowFrom = normalizeAllowList(options.allowFrom);
  const now = typeof options.clock === "function" ? options.clock : () => Date.now();
  const heartbeatMs = positiveNumber(options.heartbeatMs, HEARTBEAT_MS);
  const heartbeatMaxMiss = Math.max(1, Math.floor(positiveNumber(options.heartbeatMaxMiss, HEARTBEAT_MAX_MISS)));
  const authTimeoutMs = positiveNumber(options.authTimeoutMs, AUTH_TIMEOUT_MS);
  const reconnectBaseMs = positiveNumber(options.reconnectBaseMs, RECONNECT_BASE_MS);
  const reconnectMaxMs = Math.max(reconnectBaseMs, positiveNumber(options.reconnectMaxMs, RECONNECT_MAX_MS));
  const sendAckTimeoutMs = positiveNumber(options.sendAckTimeoutMs, SEND_ACK_TIMEOUT_MS);
  const notifyAllowed = options.notify !== false;
  const maxNotifyPerMinute = Math.max(1, Math.floor(positiveNumber(options.maxNotifyPerMinute, 10)));
  // 「回答回传」（入站 → agent 回答 → 原路发回）：默认开；TTL/上限可注入（测试用）
  const answerRelayEnabled = options.answerRelay !== false;
  const answerRelayTtlMs = positiveNumber(options.answerRelayTtlMs, ANSWER_RELAY_TTL_MS);
  const answerMaxChars = Math.max(20, Math.floor(positiveNumber(options.answerMaxChars, ANSWER_MAX_CHARS)));
  // 审批卡片（task-24）：默认开；TTL 可注入（测试用）；决策回调由 bridge 注入
  const approvalCardsEnabled = options.approvalCards !== false;
  const approvalCardTtlMs = positiveNumber(options.approvalCardTtlMs, APPROVAL_CARD_TTL_MS);
  const onApprovalDecision = typeof options.onApprovalDecision === "function" ? options.onApprovalDecision : null;
  // 会话可选绑定（task-24）：配置固定的会话（空 = 跟随活跃会话）
  let configuredSessionId = String(options.configuredSessionId || "").trim();
  let configuredSessionTitle = truncateText(options.configuredSessionTitle || "", 60);
  // ── 会员判定（2026-11-07 业主拍板：通知免费、审批免费、互动半阉割）──
  // capsProvider 由 bridge 注入（复用微信通道的 resolveWechatTier：字符串档位或 {plan,caps,limits,rev}）；
  // 拿不到 / 未注入 → **按 free fail-closed**。
  const capsProvider = typeof options.capsProvider === "function" ? options.capsProvider : null;
  const tierOverride = typeof options.tier === "string" && options.tier.trim() ? options.tier.trim() : ""; // 仅测试
  const capabilityTable = options.capabilityTable && typeof options.capabilityTable === "object" ? options.capabilityTable : WECHAT_CAPABILITY_TABLE;
  const limitTable = options.limitTable && typeof options.limitTable === "object" ? options.limitTable : WECHAT_TIER_LIMITS;
  const appUrl = String(options.appUrl || "").trim();
  // 通道格式适配（wecom 当前唯一实现；钉钉/飞书接入时传对应 channel 即可）
  const formatChannel = String(options.formatChannel || "wecom").trim() || "wecom";
  const upgradeUrl = String(options.upgradeUrl || "").trim()
    || (appUrl ? `${appUrl.replace(/\/+$/, "")}/promo` : "");
  const tierRefreshMs = positiveNumber(options.tierRefreshMs, 10 * 60 * 1000);
  const tierDenyThrottleMs = Number.isFinite(Number(options.tierDenyThrottleMs))
    ? Math.max(0, Number(options.tierDenyThrottleMs)) : 5000;
  const log = createScopedLogger({ sink: options.logger, secrets: [secret], prefix: "[wecom]" });

  const statusFile = relayDir ? path.join(relayDir, IM_BOT_STATUS_FILE) : "";
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);

  /** 状态机（`status()` 的底层；不含任何密钥）。 */
  const state = {
    running: false,
    connected: false,
    authenticated: false,
    authFailed: false,
    lastError: "",
    lastConnectedAt: 0,
    lastMessageAt: 0,
    boundChatId: "",
    targetChatId,
    reconnectAttempts: 0,
    nextRetryInMs: 0,
    lastPingAt: 0,
    lastPongAt: 0,
    inbound: 0,
    rejected: 0,
    notified: 0,
    sent: 0,
    sendFailed: 0,
    answers: 0,
    cards: 0,
    approvalDecisions: 0,
    previews: 0,
    previewClicks: 0
  };

  /** 会员状态：档位 + 服务端权益包 + 本月用量（跨重启从状态文件恢复）。 */
  const membership = {
    tier: "",               // 最近一次成功取到的档位（空 = 还没取到 → 对外按 free）
    entitlements: null,     // {rev, plan, caps[], limits{}}（服务端权威）
    checkedAt: 0,
    usage: { month: "", count: 0 }
  };

  let ws = null;
  let stopped = true;
  let reqSeq = 0;
  /** 连接代次：每新建一次连接 +1。旧连接遗留的定时器（认证/发送 ack）据此自我作废 ——
   *  否则一次「认证超时」的定时器会在重连成功 15s 后把**新连接**误杀（真机上会表现为周期性掉线）。 */
  let epoch = 0;
  let authTimer = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let tierTimer = null;
  let pingOutstanding = 0;
  let subscriber = null;
  let ownsSubscriber = false;
  let wired = false;
  let lastNoTargetLogAt = 0;
  /**
   * 最近一次**入站转发成功**的会话：{ sessionId, at }。
   * 用途：收到这个会话的 turn/end 时，把 agent 的最终回答正文回传给同一个企微会话
   * （否则业主只能看到「已转给桌面端会话 ✓」，看不到回答）。消费一次即清空。
   */
  let lastInbound = { sessionId: "", at: 0 };
  /**
   * 会话可选绑定（task-24）：
   *   · sessionList — 状态文件里的 `sessions[]`（≤10，只含 id/title/updatedAt）
   *   · activeSession — 最近活跃会话（来自 session-state running / control-activity / 事件）
   *   · boundSessionId — 当前**实际**转发目标（config.sessionId → active → sessions[0]）
   */
  let sessionList = [];
  let activeSession = { id: "", title: "" };
  let boundSessionId = "";
  const sessionRegistry = new Map(); // id -> {id,title,updatedAt}
  const sessionCache = { at: 0, items: [], inFlight: false };
  let sessionRefreshTimer = null;
  /** 审批卡片：内存登记（task_id → 记录 / requestId → 记录），用于幂等与 TTL 判定。 */
  const cardsByTask = new Map();
  const cardsByRequest = new Map();
  /**
   * 预览卡**独立集合**：只用于识别点击来源与重放结果卡。
   * ⚠️ 绝不进 cardsByTask/cardsByRequest —— 避免污染真实审批的幂等表与 90s TTL 语义。
   */
  const previewCards = new Map(); // taskId -> {ts, chatid, sentAt}
  const pending = new Map();   // reqId -> {kind, timer, onAck}
  const seenMsgs = new Map();  // msgid -> at
  const notifiedKeys = new Map(); // dedupe key -> at
  const notifyTimes = [];      // 限速窗口

  // 重启后沿用上次绑定的会话 + 本月用量/档位快照（都不含密钥/正文）
  if (relayDir) {
    try {
      const prev = readJsonFile(statusFile);
      const w = prev && prev.wecom && typeof prev.wecom === "object" ? prev.wecom : {};
      if (typeof w.boundChatId === "string" && w.boundChatId) state.boundChatId = w.boundChatId;
      // 用量必须恢复（否则重启 = 免费用户额度清零）；档位/权益包只在有 provider 时恢复，
      // 且下次刷新会用服务端权威值覆盖 —— 没有 provider 时一律按 free fail-closed。
      if (w.usage && typeof w.usage === "object" && typeof w.usage.month === "string") {
        membership.usage = { month: w.usage.month, count: Math.max(0, Number(w.usage.messages ?? w.usage.count) || 0) };
      }
      if (capsProvider && typeof w.tier === "string" && w.tier) {
        membership.tier = w.tier;
        membership.entitlements = {
          rev: typeof w.entitlementsRev === "string" ? w.entitlementsRev : "",
          plan: w.tier,
          caps: Array.isArray(w.caps) ? w.caps.slice() : null,
          limits: w.limits && typeof w.limits === "object" ? w.limits : null
        };
      }
    } catch { /* 忽略 */ }
  }

  // ---------- 会员判定（通知免费 / 审批免费 / 互动半阉割） ----------

  /** 月份键（用量按月归零；与微信通道同口径）。 */
  function monthKey(at = now()) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  /** 当前档位（测试可注入 tier 覆盖；从没取到过 → free）。 */
  function tierNow() {
    if (tierOverride) return tierOverride;
    return membership.tier || "free";
  }
  /**
   * 当前生效能力：服务端权益包 caps 优先（**是数组就算数，空数组=什么都不给**），
   * 否则按档位查内置表。判据是"是不是数组"而不是"非空"——空数组是服务端权威的"清空"，
   * 当成"没给"会 fail-open（与微信通道 2026-09-23 的修法一致）。
   */
  function capsNow() {
    const server = membership.entitlements && Array.isArray(membership.entitlements.caps)
      ? membership.entitlements.caps : null;
    if (server) return server;
    return capabilitiesFor(tierNow(), capabilityTable) || [];
  }
  /** 当前生效限制（messages_per_month：0/缺省=不限）。 */
  function limitsNow() {
    const server = membership.entitlements && membership.entitlements.limits;
    if (server && typeof server === "object") return server;
    return limitsFor(tierNow(), limitTable) || {};
  }
  function canCap(cap) { return grantsCap(capsNow(), cap); }
  /** 本月已用指令数（跨月自动归零）。 */
  function usageThisMonth() {
    const m = monthKey();
    return membership.usage.month === m ? Number(membership.usage.count || 0) : 0;
  }
  /** 每月指令上限（0 = 不限）。 */
  function messageLimitNow() {
    const n = Number((limitsNow() || {}).messages_per_month || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  /** 配置里的固定会话是否因免费档被忽略（`sessions` 是会员能力）。 */
  function bindingGatedNow() {
    return Boolean(configuredSessionId) && !canCap("sessions");
  }

  /**
   * 刷新档位（带节流）。拿不到时**沿用上次已知档位**（首启即 free，fail-closed）。
   * 契约与微信通道一致：字符串档位（旧）或 {plan,caps,limits,rev}（权益包）。
   */
  async function refreshTier({ force = false, minIntervalMs = 30_000 } = {}) {
    if (!capsProvider) return tierNow();
    const at = now();
    if (!force && at - membership.checkedAt < minIntervalMs) return tierNow();
    membership.checkedAt = at;
    let got = null;
    try {
      got = await capsProvider();
    } catch (e) {
      log.warn(`读取账号档位失败（沿用上次）：${truncateText(e && e.message ? e.message : e, 100)}`);
      return tierNow();
    }
    const isObj = Boolean(got) && typeof got === "object";
    const plan = String((isObj ? got.plan : got) || "").trim();
    if (!plan) return tierNow(); // 空 = 这次没取到 → 沿用（绝不因为网络抖动把付费用户降级）
    const caps = isObj && Array.isArray(got.caps) ? got.caps : null;
    const limits = isObj && got.limits && typeof got.limits === "object" ? got.limits : null;
    const rev = isObj ? String(got.rev || "") : "";
    const changed = plan !== membership.tier;
    membership.tier = plan;
    if (caps || limits) {
      membership.entitlements = {
        rev,
        plan,
        caps: caps || (membership.entitlements && membership.entitlements.caps) || null,
        limits: limits || (membership.entitlements && membership.entitlements.limits) || null
      };
    }
    if (changed) log.info(`账号档位：${plan}${caps ? "（含权益包）" : ""}`);
    writeStatus();
    return tierNow();
  }
  /** 判能力前先确保档位新鲜（被拒时用更短节流；买完马上重试能进）。 */
  async function canCapNow(cap) {
    if (canCap(cap)) return true;
    await refreshTier({ minIntervalMs: tierDenyThrottleMs });
    return canCap(cap);
  }
  /** 记一条指令用量（**只在真的派出去之后**调用；失败不扣额度）。 */
  function bumpUsage() {
    const m = monthKey();
    const used = membership.usage.month === m ? Number(membership.usage.count || 0) : 0;
    membership.usage = { month: m, count: used + 1 };
    writeStatus();
  }

  /** 升级文案（**一次说完**：能做什么 / 还剩几条 / 去哪升级）。 */
  function upgradeText(reason) {
    const freeLimit = Number((limitsFor("free", limitTable) || {}).messages_per_month || 20);
    const used = usageThisMonth();
    const rows = [
      reason === "quota"
        ? `📵 本月免费指令已用完（${used}/${freeLimit}，下月 1 号自动恢复）。`
        : "🔒 继续在企微里派活/追问是会员功能。",
      "",
      "免费可以用：接收任务通知、点审批卡（**不占额度**）"
        + (reason === "quota" ? "" : `；每月 ${freeLimit} 条指令（本月已用 ${used}/${freeLimit}）`),
      "升级 Pro：指令不限量、可开新任务、可切换会话"
    ];
    if (upgradeUrl) rows.push(`👉 ${upgradeUrl}`);
    return rows.join("\n");
  }

  /** 入站会员闸：返回 null = 放行；返回对象 = 已被拦下（已回复用户）。 */
  async function membershipGate(frame, info) {
    // ① 能力闸：没有 assign.continue → 不能派活（先尝试刷新档位：可能刚升级）
    if (!canCap("assign.continue")) {
      if (await canCapNow("assign.continue")) return null;
      replyText(frame, upgradeText("capability"));
      emitter.emit("inbound-gated", { ...info, reason: "capability", tier: tierNow() });
      log.info(`入站被会员闸拦下（无 assign.continue，tier=${tierNow()}）`);
      return { reason: "capability" };
    }
    // ② 额度闸：免费档每月 N 条（0 = 不限）。超额前先刷新档位（可能刚买）
    const limit = messageLimitNow();
    if (limit > 0 && usageThisMonth() >= limit) {
      await refreshTier({ minIntervalMs: tierDenyThrottleMs });
      const limit2 = messageLimitNow();
      if (!(limit2 > 0 && usageThisMonth() >= limit2)) return null;
      replyText(frame, upgradeText("quota"));
      emitter.emit("inbound-gated", { ...info, reason: "quota", tier: tierNow(), limit: limit2 });
      log.info(`入站被额度闸拦下（${usageThisMonth()}/${limit2}，tier=${tierNow()}）`);
      return { reason: "quota" };
    }
    return null;
  }

  // ---------- 状态文件（契约） ----------

  /** 契约里的 wecom 段（**字段名冻结**，插件按它渲染；不含 secret）。 */
  function statusWecom() {
    return {
      // enabled = **配置意图**（有凭据就算启用），不因桥退出/断线翻成 false ——
      // 否则 bridge 优雅退出时写下的最后一版状态会让面板显示「已被禁用」，
      // 与用户实际配置相反。运行时状态由 connected/authenticated 表达。
      enabled: Boolean(botId && secret),
      connected: state.connected === true,
      authenticated: state.authenticated === true,
      lastError: truncateText(maskSecrets(state.lastError, [secret]), 160),
      lastConnectedAt: Number(state.lastConnectedAt) || 0,
      lastMessageAt: Number(state.lastMessageAt) || 0,
      boundChatId: state.boundChatId || "",
      targetChatId: targetChatId || "",
      // 会话可选绑定（task-24）：只读元数据（id/标题/更新时间），绝不含消息正文
      sessions: normalizeSessionStatusList(sessionList),
      activeSessionId: activeSession.id || "",
      activeSessionTitle: activeSession.title || "",
      boundSessionId: boundSessionId || "",
      // ── 会员判定（2026-11-07）：档位 / 能力 / 本月用量 / 绑定是否被门槛忽略 ──
      // caps 只放**能力名**（非敏感）；插件面板可只用 capsCount/remainingMessages。
      tier: tierNow(),
      caps: capsNow().slice(),
      capsCount: capsNow().length,
      bindingGated: bindingGatedNow(),
      messagesPerMonth: messageLimitNow(),
      remainingMessages: messageLimitNow() ? Math.max(0, messageLimitNow() - usageThisMonth()) : null,
      usage: { month: membership.usage.month || monthKey(), messages: usageThisMonth() }
    };
  }

  /** 写状态文件：合并既有其它段（feishu 等由别的模块写，绝不整份覆盖）。 */
  function writeStatus() {
    if (!statusFile) return;
    try {
      const prev = readJsonFile(statusFile);
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      const next = {
        ...base,
        version: 1,
        updatedAt: Number(now()) || Date.now(),
        wecom: { ...(base.wecom && typeof base.wecom === "object" ? base.wecom : {}), ...statusWecom() }
      };
      atomicWriteJson(statusFile, next, { onWarn: (m) => log.warn(m) });
    } catch (e) {
      log.warn(`状态文件写入失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  // ---------- 帧收发 ----------

  function nextReqId(kind) {
    reqSeq += 1;
    // 官方只要求 req_id 可回带；用「类型-序号-时间」便于日志定位，且不含任何机密
    return `dsh-${kind}-${reqSeq}-${Number(now()) || Date.now()}`;
  }

  function rawSend(obj) {
    const sock = ws;
    if (!sock || sock.readyState !== WS_OPEN) return false;
    try {
      sock.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      log.warn(`发送失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
      return false;
    }
  }

  /** 发一帧并登记 ack 期望（超时只记账，不阻塞）。 */
  function sendWithAck(kind, cmd, body, onAck) {
    const reqId = nextReqId(kind);
    const myEpoch = epoch;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      if (myEpoch !== epoch) return; // 旧连接的遗留定时器：不得影响新连接
      if (kind === "ping") return; // 心跳由 pingOutstanding 计数判死，这里不重复处理
      try { if (onAck) onAck({ ok: false, timeout: true, errcode: null }); } catch { /* 忽略 */ }
    }, sendAckTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    pending.set(reqId, { kind, timer, onAck });
    const frame = { cmd, headers: { req_id: reqId } };
    if (body !== undefined) frame.body = body;
    if (!rawSend(frame)) {
      clearTimeout(timer);
      pending.delete(reqId);
      return { ok: false, reqId, reason: "socket_closed" };
    }
    return { ok: true, reqId };
  }

  /** 处理服务端 ack（按 req_id 匹配）。 */
  function handleAck(reqId, frame) {
    const entry = pending.get(reqId);
    if (!entry) return false;
    pending.delete(reqId);
    try { if (entry.timer) clearTimeout(entry.timer); } catch { /* 忽略 */ }
    const errcode = frame.errcode !== undefined ? Number(frame.errcode) : 0;
    const errmsg = typeof frame.errmsg === "string" ? frame.errmsg : "";
    try {
      if (entry.onAck) entry.onAck({ ok: errcode === 0, errcode, errmsg });
    } catch { /* 忽略 */ }
    return true;
  }

  // ---------- 连接 / 认证 / 心跳 / 重连 ----------

  function clearAuthTimer() {
    if (authTimer) { try { clearTimeout(authTimer); } catch { /* 忽略 */ } authTimer = null; }
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { try { clearInterval(heartbeatTimer); } catch { /* 忽略 */ } heartbeatTimer = null; }
    pingOutstanding = 0;
  }
  function dropSocket() {
    const sock = ws;
    ws = null;
    if (!sock) return;
    try {
      sock.removeAllListeners();
      sock.on("error", () => { /* 关闭途中的错误不该冒泡 */ });
      if (typeof sock.terminate === "function" && sock.readyState === WS_OPEN) sock.terminate();
      else if (typeof sock.close === "function") sock.close();
    } catch { /* 忽略 */ }
  }

  function connect() {
    if (stopped || state.authFailed) return;
    let sock;
    try {
      sock = typeof options.wsFactory === "function" ? options.wsFactory(url) : new WebSocket(url);
    } catch (e) {
      scheduleReconnect(`ws_init:${truncateText(e && e.message ? e.message : e, 80)}`);
      return;
    }
    ws = sock;
    epoch += 1;
    try {
      sock.on("open", () => onOpen());
      sock.on("message", (raw) => onRawMessage(raw));
      sock.on("error", (e) => {
        // 只记短原因（不断言"凭据错"：错误事件 ≠ 认证结果）
        log.warn(`WebSocket 异常：${truncateText(e && e.message ? e.message : e, 120)}`);
      });
      sock.on("close", (code, reason) => onClose(code, reason));
    } catch (e) {
      log.warn(`挂监听失败：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  function onOpen() {
    if (stopped) return;
    state.connected = true;
    state.authenticated = false;
    state.lastConnectedAt = now();
    state.nextRetryInMs = 0;
    log.info("已连上企业微信长连接，正在认证…");
    writeStatus();
    emitStatus();
    // 认证帧（协议事实见文件头）
    sendWithAck("auth", "aibot_subscribe", { secret, bot_id: botId }, (ack) => {
      clearAuthTimer();
      if (ack && ack.ok) {
        state.authenticated = true;
        state.authFailed = false;
        state.reconnectAttempts = 0;
        state.lastError = "";
        log.info("认证成功（aibot_subscribe ok）");
        writeStatus();
        emitStatus();
        startHeartbeat();
        emitter.emit("authenticated", { at: now() });
        return;
      }
      if (ack && ack.timeout) {
        // 认证没应答：按网络问题重连（不判凭据错）
        log.warn("认证应答超时，按网络问题重连");
        closeAndReconnect("auth_timeout");
        return;
      }
      failAuth(ack && ack.errcode, ack && ack.errmsg);
    });
    // 兜底：连 auth ack 都没等到
    clearAuthTimer();
    authTimer = setTimeout(() => {
      authTimer = null;
      if (stopped || state.authenticated || state.authFailed) return;
      log.warn("等待认证应答超时，按网络问题重连");
      closeAndReconnect("auth_timeout");
    }, authTimeoutMs);
    if (typeof authTimer.unref === "function") authTimer.unref();
  }

  /**
   * 认证失败 = **凭据/权限问题**，立即停止，不重连（否则会被官方限流甚至封禁）。
   * @param {any} errcode
   * @param {any} errmsg
   */
  function failAuth(errcode, errmsg) {
    state.authFailed = true;
    state.authenticated = false;
    state.running = false;
    const code = Number.isFinite(Number(errcode)) ? Number(errcode) : null;
    // 服务端 errmsg 原样回显 secret 是最坏情况（实测不会，但状态/日志绝不能因此泄露）
    const msg = truncateText(maskSecrets(errmsg || "认证被拒绝", [secret]), 120);
    state.lastError = code === null ? `认证被拒绝：${msg}` : `认证被拒绝（errcode=${code}）：${msg}`;
    log.warn(`${state.lastError}；凭据问题不重连，请检查 Bot ID / Secret`);
    stopHeartbeat();
    clearAuthTimer();
    try { for (const [, p] of pending) { try { clearTimeout(p.timer); } catch { /* 忽略 */ } } } catch { /* 忽略 */ }
    pending.clear();
    dropSocket();
    state.connected = false;
    state.nextRetryInMs = 0;
    writeStatus();
    emitStatus();
    emitter.emit("auth-failed", { errcode: code, message: msg, at: now() });
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (stopped || !state.authenticated) return;
      if (pingOutstanding >= heartbeatMaxMiss) {
        log.warn(`心跳连续 ${pingOutstanding} 次未应答，判定连接已死，准备重连`);
        closeAndReconnect("heartbeat_timeout");
        return;
      }
      pingOutstanding += 1;
      state.lastPingAt = now();
      sendWithAck("ping", "ping", undefined, (ack) => {
        if (ack && ack.ok) {
          pingOutstanding = 0;
          state.lastPongAt = now();
        } else if (!ack || !ack.timeout) {
          log.warn(`心跳应答异常（errcode=${ack && ack.errcode}）`);
        }
      });
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  function closeAndReconnect(reason) {
    if (stopped || state.authFailed) return;
    dropSocket();
    state.connected = false;
    state.authenticated = false;
    stopHeartbeat();
    clearAuthTimer();
    scheduleReconnect(reason);
  }

  function scheduleReconnect(reason) {
    if (stopped || state.authFailed) return;
    if (reconnectTimer) return; // 单飞：一次只排一个重连
    const attempt = state.reconnectAttempts;
    const delay = Math.min(reconnectMaxMs, Math.round(reconnectBaseMs * Math.pow(2, attempt)));
    state.reconnectAttempts = attempt + 1;
    state.nextRetryInMs = delay;
    state.lastError = state.lastError || `连接断开：${truncateText(reason, 80)}`;
    log.warn(`连接断开（${reason}），${delay}ms 后重连（第 ${state.reconnectAttempts} 次）`);
    writeStatus();
    emitStatus();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      state.nextRetryInMs = 0;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  function onClose(code, reason) {
    if (stopped) return;
    const why = `close ${code === undefined ? "?" : code}${reason ? ` ${truncateText(String(reason), 60)}` : ""}`;
    state.connected = false;
    state.authenticated = false;
    stopHeartbeat();
    clearAuthTimer();
    if (state.authFailed) return;
    scheduleReconnect(why);
  }

  // ---------- 帧分发 ----------

  function onRawMessage(raw) {
    let frame = null;
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      frame = JSON.parse(text);
    } catch {
      log.warn("收到无法解析的帧（已忽略）");
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const headers = frame.headers && typeof frame.headers === "object" ? frame.headers : {};
    const reqId = typeof headers.req_id === "string" ? headers.req_id : typeof headers.reqId === "string" ? headers.reqId : "";
    // ① ack（按 req_id 匹配）—— 只打 cmd/errcode，绝不整帧落日志
    if (reqId && handleAck(reqId, frame)) return;
    // ② 无 req_id 的错误帧：未认证时的非 0 errcode 被视为认证失败（保守：凭据问题不能重连风暴）
    if (frame.errcode !== undefined && Number(frame.errcode) !== 0 && !state.authenticated) {
      failAuth(frame.errcode, frame.errmsg);
      return;
    }
    const cmd = typeof frame.cmd === "string" ? frame.cmd : "";
    if (cmd === "aibot_msg_callback") {
      void handleInboundMessage(frame);
      return;
    }
    if (cmd === "aibot_event_callback") {
      void handleInboundEvent(frame);
      return;
    }
    if (cmd === "ping") {
      // 少数服务端实现会主动 ping：回一个同形状的 pong（不影响官方 ack 流程）
      rawSend({ cmd: "pong", headers: reqId ? { req_id: reqId } : {} });
      return;
    }
    log.debug(`未处理的帧 cmd=${cmd || "(ack)"}${frame.errcode !== undefined ? ` errcode=${frame.errcode}` : ""}`);
  }

  async function handleInboundMessage(frame) {
    const body = frame.body && typeof frame.body === "object" ? frame.body : {};
    const msgid = String(body.msgid || body.msg_id || "").trim();
    const text = extractInboundText(body);
    const { fromUser, chatid, isGroup } = pickInboundIdentity(body);

    // 去重（官方重连后可能补发；同一 msgid 只处理一次）
    if (msgid) {
      pruneSeen();
      if (seenMsgs.has(msgid)) {
        log.debug(`重复消息已忽略（msgid 命中）`);
        return;
      }
      seenMsgs.set(msgid, now());
    }
    state.inbound += 1;
    state.lastMessageAt = now();

    const info = { msgid, text, chatid, fromUser, isGroup, frame, at: now() };

    // 安全：allowFrom 白名单（可选）。非空时只接受白名单内的 userid/chatid；空 = 首次发送者自动绑定。
    if (allowFrom.length && !allowFrom.includes(fromUser) && !allowFrom.includes(chatid)) {
      state.rejected += 1;
      log.warn(`拒绝非白名单发送者（from=${chatIdHash(fromUser) || "?"} chat=${chatIdHash(chatid) || "?"}）`);
      writeStatus();
      replyText(frame, "你暂时没有这台电脑的远程通道权限。请让电脑那边把你的企业微信 userid 加进白名单。");
      emitter.emit("inbound-rejected", info);
      return;
    }
    if (!text) {
      log.info(`收到非文本消息（msgtype=${truncateText(body.msgtype || "?", 20)}），未转发`);
      writeStatus();
      replyText(frame, "目前只支持文本消息（图片/文件/语音暂不转发）。");
      emitter.emit("inbound-ignored", info);
      return;
    }
    // 绑定：最近一次跟机器人说话的会话就是主动推送的接收方
    if (chatid && chatid !== state.boundChatId) {
      state.boundChatId = chatid;
      log.info(`已绑定推送会话 chat=${chatIdHash(chatid)}${isGroup ? "（群）" : ""}`);
    }
    writeStatus();
    emitStatus();
    emitter.emit("message", info);
    // 便捷回调（规格里写的 onMessage 形态）：与事件并行，异常绝不影响转发
    try { if (typeof options.onMessage === "function") options.onMessage(info); } catch { /* 忽略 */ }
    await dispatchInbound(frame, info);
  }

  async function handleInboundEvent(frame) {
    const body = frame.body && typeof frame.body === "object" ? frame.body : {};
    const ev = body.event && typeof body.event === "object" ? body.event : {};
    // 卡片事件的事件类型在 `body.event.eventtype` 里（body.event 是对象，不能直接 String()）
    const eventType = String(ev.eventtype || ev.event_type || body.event_type || body.eventType || "").trim();
    const { fromUser, chatid, isGroup } = pickInboundIdentity(body);
    log.info(`收到机器人事件 event=${truncateText(eventType || "?", 40)}${fromUser ? ` from=${chatIdHash(fromUser)}` : ""}`);
    state.lastMessageAt = now();
    writeStatus();
    emitter.emit("bot-event", { eventType, fromUser, chatid, isGroup, frame, at: now() });
    // 审批卡片按钮点击 → 走真实审批回执（task-24）
    if (eventType === "template_card_event" || (ev.event_key && ev.task_id)) {
      await handleApprovalCardEvent(frame);
    }
  }

  /** 把入站文本转给 DSH 会话（尽力，失败给用户一句人话）。 */
  /**
   * 命令层（三家共用 `im-commands.mjs`）：命中返回 true（已回复，调用方直接 return）。
   * 回复走被动回复/主动推送（replyText），不经过模型、不计额度。
   */
  async function handleCommand(frame, info) {
    const text = String((info && info.text) || "");
    if (!/^\s*\//.test(text)) return false; // 快路径：非命令不构造 ctx
    const cmd = await executeImCommand({
      text,
      ctx: {
        caps: capsNow(),
        tier: tierNow(),
        appUrl,
        channelLabel: "企业微信",
        sessions: async () => {
          try { await refreshSessions({ force: true }); } catch { /* 忽略 */ }
          return sessionList.map((x) => ({ sessionId: x.id, title: x.title, updatedAt: x.updatedAt, running: false }));
        },
        currentSessionId: () => {
          const known = boundSessionId || activeSession.id || "";
          if (known) return known;
          if (configuredSessionId && canCap("sessions")) return configuredSessionId;
          if (sessionList.length) return sessionList[0].id;
          const sub = subscriber;
          try {
            if (sub && typeof sub.sessions === "function") {
              const ids = sub.sessions();
              if (Array.isArray(ids) && ids.length) return String(ids[0]);
            }
          } catch { /* 忽略 */ }
          return "";
        },
        currentSessionTitle: () => titleOfSession(boundSessionId || activeSession.id, activeSession.title || ""),
        cancelSession: async ({ sessionId }) => {
          const sub = subscriber;
          if (!sub || typeof sub.cancelSession !== "function") return { ok: false, message: "订阅器未就绪" };
          try {
            const r = await sub.cancelSession({ sessionId });
            return r && typeof r === "object" ? r : { ok: Boolean(r) };
          } catch (e) { return { ok: false, message: e && e.message ? e.message : String(e) }; }
        },
        switchSession: async ({ sessionId, title }) => {
          const r = writeImBotsSession(relayDir, "wecom", { sessionId, sessionTitle: title });
          if (r.ok) {
            configuredSessionId = sessionId;
            configuredSessionTitle = truncateText(title || "", 60);
            writeStatus();
          }
          return r;
        },
        unbind: async () => {
          state.boundChatId = "";
          writeStatus();
          return { ok: true };
        },
        statusSnapshot: async () => ({
          connected: state.connected === true,
          authenticated: state.authenticated === true,
          state: state.connected ? "connected" : "idle",
          lastError: state.lastError || "",
          tier: tierNow(),
          usage: { month: monthKey(), messages: usageThisMonth() },
          messagesPerMonth: messageLimitNow(),
          remainingMessages: messageLimitNow() ? Math.max(0, messageLimitNow() - usageThisMonth()) : null,
          currentSessionId: boundSessionId || activeSession.id || "",
          currentSessionTitle: titleOfSession(boundSessionId || activeSession.id, activeSession.title || "")
        })
      }
    });
    if (!cmd || !cmd.handled) return false;
    replyText(frame, cmd.text);
    emitter.emit("command", { ...info, command: cmd.command, ok: cmd.ok === true, gated: cmd.gated === true });
    log.info(`命令 ${cmd.command}${cmd.gated ? "（会员闸拦截）" : ""} 已回复（不转模型）`);
    return true;
  }

  async function dispatchInbound(frame, info) {
    const sub = subscriber;
    // ⓪ 命令层：命中即执行并回复，**绝不进模型**，也不计入额度（/stop、/unbind 永远免费）
    const cmd = await handleCommand(frame, info);
    if (cmd) return;
    // ① 会员闸（通知/审批免费；派活受能力与月度额度约束，fail-closed）
    const gated = await membershipGate(frame, info);
    if (gated) return;
    const sessionId = await resolveSessionId(sub);
    if (!sub || typeof sub.promptSession !== "function") {
      log.warn("入站消息无法转发：事件订阅器未就绪（详见启动日志）");
      replyText(frame, "已收到你的消息，但后台还没连上 DeepSeek Harness 的事件通道，暂时转不过去。请确认电脑端 dsh web 正在运行。");
      emitter.emit("inbound-failed", { ...info, reason: "no_subscriber" });
      return;
    }
    if (!sessionId) {
      log.warn("入站消息无法转发：还没有可接管的会话");
      replyText(frame, "已收到，但还没在桌面端选择要接管的会话。请先在电脑的 DeepSeek Harness 里打开一个会话，再发一次。");
      emitter.emit("inbound-failed", { ...info, reason: "no_session" });
      return;
    }
    let result;
    try {
      result = await sub.promptSession({ sessionId, text: info.text });
    } catch (e) {
      result = { ok: false, message: e && e.message ? e.message : String(e) };
    }
    if (result && result.ok) {
      // 记下"这次入站交给了哪个会话"：该会话下一次 turn/end 要把回答正文回传给企微
      lastInbound = { sessionId, at: now() };
      // 额度只统计**真的派出去的**指令（审批回执/预览按钮不经过这里，也就不计数）
      bumpUsage();
      // 状态文件对外表达"当前实际转发目标"（面板据此显示绑定关系）
      if (boundSessionId !== sessionId) { boundSessionId = sessionId; writeStatus(); }
      log.info(`入站文本已转给会话 session=${shortSession(sessionId)}`);
      replyText(frame, `已转给桌面端会话 ✓（${shortSession(sessionId)}）`);
      emitter.emit("inbound-routed", { ...info, sessionId });
      return;
    }
    const why = truncateText((result && (result.code || result.message)) || "未知错误", 80);
    log.warn(`入站文本转发失败：${why}`);
    replyText(frame, `转发失败：${why}。请到电脑上确认会话还在运行。`);
    emitter.emit("inbound-failed", { ...info, sessionId, reason: why });
  }

  // ---------- 会话可选绑定（task-24） ----------

  /** subscriber 当前 follow 着的会话 id 列表（只读；拿不到算空）。 */
  function followedSessionIds() {
    const sub = subscriber;
    if (!sub || typeof sub.sessions !== "function") return [];
    try {
      const ids = sub.sessions();
      return Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x).slice(0, 100) : [];
    } catch { return []; }
  }

  /** 会话标题：注入的 sessionTitle() > DSH 列表里的标题 > 配置里给固定会话起的名字。 */
  function titleOfSession(id, fallback) {
    if (typeof options.sessionTitle === "function") {
      try {
        const t = String(options.sessionTitle(id) || "").trim();
        if (t) return truncateText(t, 60);
      } catch { /* 忽略 */ }
    }
    if (fallback) return truncateText(fallback, 60);
    if (id === configuredSessionId && configuredSessionTitle) return configuredSessionTitle;
    const cached = sessionRegistry.get(id);
    return cached && cached.title ? cached.title : "";
  }

  /**
   * 转发目标优先级（task-24）：配置固定 → 最近活跃 → 会话列表第一个。
   * ⚠️ 配置固定会话是**会员能力**（sessions）：免费档忽略（见 bindingGatedNow）。
   */
  function computeBoundSessionId() {
    if (configuredSessionId && canCap("sessions")) return configuredSessionId;
    if (activeSession.id) return activeSession.id;
    return sessionList.length ? sessionList[0].id : "";
  }

  /** 同步 active/bound 派生状态 + 把「配置固定的会话」补进列表首位（用户明确选过）。 */
  function syncSessionState() {
    if (activeSession.id) activeSession.title = titleOfSession(activeSession.id, activeSession.title);
    boundSessionId = computeBoundSessionId();
    // 免费档不把"配置固定会话"补进列表（否则它会变成 sessions[0] 被拿去转发）
    if (configuredSessionId && canCap("sessions") && !sessionList.some((s) => s.id === configuredSessionId)) {
      sessionList = normalizeSessionStatusList([
        { id: configuredSessionId, title: configuredSessionTitle, updatedAt: 0 },
        ...sessionList
      ]);
    }
  }

  /**
   * 刷新「会话列表 + 标题 + updatedAt」并写状态文件。
   *
   * 来源（task-24）：`subscriber.sessions()`（= 当前 follow 中的会话 id）∩ `listSessions()` 的元数据。
   * 只写元数据（id/title/updatedAt），**绝不含消息正文**；`listSessions` 有 30s 缓存，
   * 会话事件再密也不会把 DSH 打成筛子。
   */
  async function refreshSessions(opts = {}) {
    const sub = subscriber;
    if (!sub) return;
    const at = now();
    const ids = followedSessionIds();
    const needDetail = opts.force === true || at - sessionCache.at > SESSION_LIST_REFRESH_MS;
    let detail = sessionCache.items;
    if (needDetail && !sessionCache.inFlight && typeof sub.listSessions === "function") {
      sessionCache.inFlight = true;
      try {
        const r = await sub.listSessions();
        if (r && r.ok && Array.isArray(r.sessions)) {
          detail = r.sessions;
          sessionCache.at = now();
          sessionCache.items = detail;
        }
      } catch { /* 忽略：拿不到标题不影响转发 */ } finally {
        sessionCache.inFlight = false;
      }
    }
    const byId = new Map();
    for (const it of Array.isArray(detail) ? detail : []) {
      if (it && typeof it.sessionId === "string" && it.sessionId) byId.set(it.sessionId, it);
    }
    const rows = [];
    for (const id of ids) {
      const d = byId.get(id) || {};
      const title = titleOfSession(id, d.title);
      const updatedAt = Number(d.updatedAt) || (sessionRegistry.get(id) && sessionRegistry.get(id).updatedAt) || at;
      sessionRegistry.set(id, { id, title, updatedAt });
      rows.push({ id, title, updatedAt });
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    sessionList = normalizeSessionStatusList(rows);
    syncSessionState();
    writeStatus();
  }

  /** 会话事件的刷新合并（80ms）；`force` 时立刻拉一次详情（如 ready / 配置变更后）。 */
  function scheduleSessionRefresh(force = false) {
    if (stopped) return;
    if (sessionRefreshTimer) return;
    sessionRefreshTimer = setTimeout(() => {
      sessionRefreshTimer = null;
      void refreshSessions({ force }).catch(() => {});
    }, force ? 0 : 80);
    if (typeof sessionRefreshTimer.unref === "function") sessionRefreshTimer.unref();
  }

  /**
   * 入站转发目标会话（task-24 优先级）：
   *   ① `im-bots.json` 的 `wecom.sessionId`（配置固定；用户明确选的）
   *   ② `activeSessionId`（最近活跃/最近事件）
   *   ③ `sessions[0]`（follow 中按 updatedAt 最新）
   *   ④ 兜底维持旧行为：`listSessions()` 里 running / 第一个
   */
  async function resolveSessionId(sub) {
    // ⓪ bridge 注入的显式取值器（历史钩子，最高优先；bridge 当前未使用）
    try {
      if (typeof options.sessionIdProvider === "function") {
        const got = String(options.sessionIdProvider() || "");
        if (got) return got;
      }
    } catch { /* 忽略 */ }
    // 配置固定的会话是**会员能力**（sessions）：免费档忽略它，回退"跟随活跃会话"，
    // 状态文件里 bindingGated=true（面板据此把会话下拉置灰 + 标会员徽章）。
    if (configuredSessionId && canCap("sessions")) return configuredSessionId;
    if (activeSession.id) return activeSession.id;
    if (sessionList.length === 0) {
      try { await refreshSessions({ force: true }); } catch { /* 忽略 */ }
    }
    if (sessionList.length) return sessionList[0].id;
    if (!sub || typeof sub.listSessions !== "function") return "";
    try {
      const r = await sub.listSessions();
      const list = r && r.ok && Array.isArray(r.sessions) ? r.sessions : [];
      const pick = list.find((s) => s && s.running) || list[0];
      return pick && typeof pick.sessionId === "string" ? pick.sessionId : "";
    } catch {
      return "";
    }
  }

  // ---------- 被动回复 / 主动推送 ----------

  /** 被动回复（同一条入站消息的 req_id 上回一个 stream 帧）。 */
  function replyStream(frame, id, content, finish = true) {
    const headers = frame && frame.headers && typeof frame.headers === "object" ? frame.headers : {};
    const inboundReqId = typeof headers.req_id === "string" ? headers.req_id : typeof headers.reqId === "string" ? headers.reqId : "";
    if (!inboundReqId) return { ok: false, reason: "no_req_id" };
    const ok = rawSend({
      cmd: "aibot_respond_msg",
      headers: { req_id: inboundReqId },
      body: { msgtype: "stream", stream: { id: String(id || `reply-${nextReqId("reply")}`), finish: finish === true, content: String(content == null ? "" : content) } }
    });
    return ok ? { ok: true } : { ok: false, reason: "socket_closed" };
  }

  /** 回复一句人话：优先被动回复（不需要绑定），拿不到入站 req_id 时退回主动推送。 */
  function replyText(frame, text) {
    // 被动回复同样按通道格式化（确认文案里可能有列表/表格；也防止超长撑爆客户端）
    const content = formatForChannel(formatChannel, { text: text == null ? "" : String(text), maxChars: 500 });
    const r = replyStream(frame, "", content, true);
    if (r.ok) return r;
    const target = state.boundChatId || targetChatId;
    if (target) return sendMarkdown(target, content);
    return { ok: false, reason: r.reason || "no_target" };
  }

  /**
   * 主动推送 Markdown。
   * @param {string} chatid 单聊 = userid；群聊 = 群 chatid
   * @param {string} text
   * @returns {{ok:boolean, reqId?:string, reason?:string}}
   */
  function sendMarkdown(chatid, text, opts = {}) {
    const to = String(chatid || "").trim();
    // 2026-11-08：所有主动 markdown（通知/回答回传/确认文案）统一按通道能力格式化：
    // 表格→可读列表、标题→加粗、分隔线→空行、wecom 4096 字节截断（优先段落边界）。
    const content = formatForChannel(formatChannel, {
      text: text == null ? "" : String(text),
      maxBytes: opts.maxBytes,
      maxChars: opts.maxChars
    });
    if (!to) return { ok: false, reason: "no_chatid" };
    if (!content) return { ok: false, reason: "empty_text" };
    if (!state.authenticated) return { ok: false, reason: "not_authenticated" };
    const r = sendWithAck("send", "aibot_send_msg", {
      chatid: to,
      msgtype: "markdown",
      markdown: { content }
    }, (ack) => {
      // 官方契约只保证认证/心跳有 ack；推送帧**以发出为准**（没有 ack 不视为失败，不刷告警）。
      // 但若服务端明确回了非 0 errcode，必须记账 + 告警（例如机器人被禁用/被移出群）。
      if (ack && ack.ok !== true && ack.timeout !== true) {
        state.sendFailed += 1;
        log.warn(`主动推送被拒绝（errcode=${ack.errcode}）`);
      }
    });
    if (r.ok) {
      state.sent += 1;
      log.debug(`主动推送已发出 chat=${chatIdHash(to)} len=${content.length}`);
    }
    return r;
  }

  // ---------- 审批卡片（task-24） ----------

  /** 卡片记录表清理（只影响「点旧卡」时的幂等/TTL 判定；上限 50 张）。 */
  function pruneApprovalCards() {
    const at = now();
    const cutoff = at - 10 * 60 * 1000;
    for (const [taskId, rec] of cardsByTask) {
      if (rec.sentAt < cutoff || rec.decidedAt && rec.decidedAt < cutoff) cardsByTask.delete(taskId);
    }
    for (const [rid, rec] of cardsByRequest) {
      if (!cardsByTask.has(rec.taskId)) cardsByRequest.delete(rid);
    }
    while (cardsByTask.size > APPROVAL_CARD_MAX) {
      const first = cardsByTask.keys().next();
      if (first.done) break;
      const rec = cardsByTask.get(first.value);
      cardsByTask.delete(first.value);
      if (rec) cardsByRequest.delete(rec.requestId);
    }
  }

  /**
   * 主动发一张**审批卡片**（button_interaction：允许一次 / 拒绝）。
   *
   * 与 markdown 通知的区别：卡片点按钮会回一个 `template_card_event`，据此走真实审批回执；
   * markdown 只能"通知你去电脑上点"。所以审批类事件优先发卡片（发不出去再退回 markdown）。
   *
   * @param {string} chatid 单聊 = userid；群聊 = 群 chatid
   * @param {{requestId:string, title?:string, summary?:string, toolName?:string}} info
   * @returns {{ok:boolean, taskId?:string, reqId?:string, reason?:string}}
   */
  function sendApprovalCard(chatid, info = {}) {
    const to = String(chatid || "").trim();
    const requestId = String(info.requestId || "").trim();
    if (!to) return { ok: false, reason: "no_chatid" };
    if (!requestId) return { ok: false, reason: "no_request_id" };
    if (!state.authenticated) return { ok: false, reason: "not_authenticated" };
    pruneApprovalCards();
    const card = buildApprovalCard({ requestId, title: info.title, summary: info.summary, toolName: info.toolName });
    const record = {
      taskId: card.task_id,
      requestId,
      chatid: to,
      sentAt: now(),
      decided: false,
      decidedAt: 0,
      decidedBy: "",
      decidedState: "pending",
      title: card.main_title && card.main_title.title,
      summary: card.sub_title_text,
    };
    cardsByTask.set(record.taskId, record);
    cardsByRequest.set(requestId, record);
    const r = sendWithAck("send", "aibot_send_msg", {
      chatid: to,
      msgtype: "template_card",
      template_card: card
    }, (ack) => {
      if (ack && ack.ok !== true && ack.timeout !== true) {
        state.sendFailed += 1;
        log.warn(`审批卡片被拒绝（errcode=${ack.errcode}）`);
      }
    });
    if (!r.ok) {
      cardsByTask.delete(record.taskId);
      cardsByRequest.delete(requestId);
      return r;
    }
    state.sent += 1;
    state.cards += 1;
    // 只打长度/短 task_id：请求 id 与工具名都不进日志
    log.info(`审批卡片已发出 chat=${chatIdHash(to)} task=${record.taskId} 摘要长度=${(record.summary || "").length}`);
    return { ok: true, taskId: record.taskId, reqId: r.reqId };
  }

  /**
   * 发一张**预览审批卡**（自检/演示）：业主不用等真实审批就能看到卡片样式、验证按钮能不能点。
   *
   * 与 sendApprovalCard 的区别：按钮 key 带 `preview:`，点击时只更新卡片、**不调 onApprovalDecision**，
   * 也不进真实审批的幂等表/TTL 集合（独立 previewCards）。
   *
   * @param {string} chatid
   * @param {number} ts 触发时间戳（来自 im-bots.json 的 previewCardAt）
   */
  function sendPreviewCard(chatid, ts) {
    const to = String(chatid || "").trim();
    const stamp = Number(ts) || 0;
    if (!to) return { ok: false, reason: "no_chatid" };
    if (!stamp) return { ok: false, reason: "no_ts" };
    if (!state.authenticated) return { ok: false, reason: "not_authenticated" };
    const card = buildPreviewCard(stamp);
    const r = sendWithAck("send", "aibot_send_msg", {
      chatid: to,
      msgtype: "template_card",
      template_card: card
    }, (ack) => {
      if (ack && ack.ok !== true && ack.timeout !== true) {
        state.sendFailed += 1;
        log.warn(`预览卡片被拒绝（errcode=${ack.errcode}）`);
      }
    });
    if (!r.ok) return r;
    state.sent += 1;
    state.previews += 1;
    previewCards.set(card.task_id, { ts: stamp, chatid: to, sentAt: now() });
    while (previewCards.size > PREVIEW_CARD_MAX) {
      const first = previewCards.keys().next();
      if (first.done) break;
      previewCards.delete(first.value);
    }
    log.info(`预览卡片已发出 chat=${chatIdHash(to)} ts=${String(stamp).slice(-10)}`);
    return { ok: true, taskId: card.task_id, reqId: r.reqId };
  }

  /** 预览卡点击：只更新这张卡 + 回一句说明；**绝不调 onApprovalDecision**（没有真实操作）。 */
  function handlePreviewCardClick(frame, parsed, info = {}) {
    const who = info.fromUser || info.chatid || "企微用户";
    const taskId = String(info.taskId || "");
    const ts = Number((parsed.requestId.match(/^preview:(\d+)$/) || [])[1]) || 0;
    const card = buildPreviewDecidedCard({ decision: parsed.decision, who, at: now(), taskId, ts });
    const headers = frame && frame.headers && typeof frame.headers === "object" ? frame.headers : {};
    const reqId = typeof headers.req_id === "string" ? headers.req_id : typeof headers.reqId === "string" ? headers.reqId : "";
    if (reqId) {
      rawSend({
        cmd: "aibot_respond_update_msg",
        headers: { req_id: reqId },
        body: { response_type: "update_template_card", template_card: card }
      });
    }
    const replyChat = info.chatid || state.boundChatId || targetChatId;
    if (replyChat) sendMarkdown(replyChat, "这是预览卡片，没有对应的真实操作。");
    state.previewClicks += 1;
    log.info(`预览卡片点击 decision=${parsed.decision} from=${chatIdHash(who) || "?"}`);
    emitter.emit("preview-clicked", { decision: parsed.decision, taskId, fromUser: info.fromUser || "", at: now() });
    return { ok: true };
  }

  /** 用事件帧的 req_id 更新卡片（按钮消失 → text_notice 结果卡）。 */
  function updateApprovalCard(frame, record, stateOverride) {
    const headers = frame && frame.headers && typeof frame.headers === "object" ? frame.headers : {};
    const reqId = typeof headers.req_id === "string" ? headers.req_id : typeof headers.reqId === "string" ? headers.reqId : "";
    if (!reqId) return { ok: false, reason: "no_req_id" };
    const card = buildDecidedCard({
      requestId: record.requestId,
      state: stateOverride || record.decidedState,
      who: record.decidedBy,
      at: record.decidedAt,
      reason: record.failReason
    });
    const ok = rawSend({
      cmd: "aibot_respond_update_msg",
      headers: { req_id: reqId },
      body: { response_type: "update_template_card", template_card: card }
    });
    return ok ? { ok: true } : { ok: false, reason: "socket_closed" };
  }

  /**
   * 处理「用户点了审批卡片按钮」（template_card_event）。
   *
   * 幂等：同一张卡只消费一次——重复点击不再调回调，只把结果卡重放一遍 + 回一句"已处理"。
   * TTL：90s（与系统一致）之后点 = 过期 → **按拒绝处理**（fail-closed）并回调 deny。
   * 安全：`allowFrom` 白名单同样约束按钮点击（陌生人不能替业主拍板）。
   */
  async function handleApprovalCardEvent(frame) {
    const body = frame && frame.body && typeof frame.body === "object" ? frame.body : {};
    const ev = body.event && typeof body.event === "object" ? body.event : (body.event_type || body.eventtype ? body : {});
    const eventType = String(ev.eventtype || ev.event_type || body.eventtype || body.event_type || "");
    if (eventType && eventType !== "template_card_event") {
      log.debug(`未处理的卡片事件类型 event=${truncateText(eventType, 30)}`);
      return;
    }
    const eventKey = String(ev.event_key || ev.eventKey || "");
    const taskId = String(ev.task_id || ev.taskId || "");
    const parsed = parseApprovalEventKey(eventKey);
    const { fromUser, chatid, isGroup } = pickInboundIdentity(body);
    const senderId = fromUser || chatid;
    const replyChat = chatid || state.boundChatId || targetChatId;

    state.lastMessageAt = now();
    writeStatus();
    // 只打 hash：企业微信 userid 是可识别信息
    log.info(`审批卡片点击 task=${taskId || "?"} decision=${parsed ? parsed.decision : "?"} from=${chatIdHash(senderId) || "?"}`);

    if (allowFrom.length && !allowFrom.includes(fromUser) && !allowFrom.includes(chatid)) {
      state.rejected += 1;
      log.warn(`拒绝非白名单的审批点击 from=${chatIdHash(senderId) || "?"}`);
      if (replyChat) sendMarkdown(replyChat, "你没有这台电脑的审批权限。");
      emitter.emit("approval-rejected", { taskId, eventKey, fromUser, chatid, at: now() });
      return;
    }
    if (!parsed) {
      log.warn("审批卡片按钮无法识别（event_key 不合法或卡片已失效）");
      if (replyChat) sendMarkdown(replyChat, "⚠️ 这个按钮已经失效了（审批请求可能已结束）。请到电脑上确认。");
      return;
    }
    const requestId = parsed.requestId;
    // 预览卡：独立分支（不回调、不进幂等表、不受 90s TTL 约束；可反复点着看）
    if (isPreviewCardEvent(requestId, taskId) || previewCards.has(taskId)) {
      handlePreviewCardClick(frame, parsed, { taskId, fromUser, chatid, isGroup });
      return;
    }
    const record = (taskId && cardsByTask.get(taskId)) || cardsByRequest.get(requestId) || null;
    const who = fromUser || chatid || "企微用户";

    // ① 幂等：同一张卡只处理一次
    if (record && record.decided) {
      updateApprovalCard(frame, record);
      const label = record.decidedState === "allowed" ? "已允许" : record.decidedState === "denied" ? "已拒绝" : record.decidedState === "expired" ? "已过期" : "已处理";
      if (replyChat) sendMarkdown(replyChat, `ℹ️ 这条审批已经处理过了（${label}），重复点击不会再执行一次。`);
      emitter.emit("approval-duplicate", { requestId, taskId: record.taskId, fromUser, chatid, at: now() });
      return;
    }

    // ② TTL：过期（或记录已丢失 = 无法证明未过期）→ 按拒绝处理（fail-closed）
    const expired = !record || (now() - record.sentAt > approvalCardTtlMs);
    const target = record || {
      taskId: taskId || approvalTaskId(requestId),
      requestId,
      chatid: replyChat || "",
      sentAt: 0,
      decided: false,
      decidedAt: 0,
      decidedBy: "",
      decidedState: "pending",
      title: "",
      summary: ""
    };
    const decision = expired ? "deny" : parsed.decision;
    target.decided = true;
    target.decidedAt = now();
    target.decidedBy = who;
    target.decidedState = expired ? "expired" : decision === "allow" ? "allowed" : "denied";
    cardsByTask.set(target.taskId, target);
    cardsByRequest.set(requestId, target);

    // ③ 调注入的决策回调（bridge 内部路由到 approvalCoordinator / pushReporter，与手机拍板同一条路）
    let result = { ok: false, reason: "审批通道未就绪" };
    if (onApprovalDecision) {
      try {
        const r = await Promise.resolve(onApprovalDecision(requestId, decision, {
          source: "wecom-card",
          taskId: target.taskId,
          chatid: target.chatid,
          fromUser,
          isGroup,
          expired,
          at: now()
        }));
        result = r && typeof r === "object" ? r : { ok: r !== false };
      } catch (e) {
        result = { ok: false, reason: truncateText(e && e.message ? e.message : e, 80) };
      }
    }

    if (expired) {
      // 过期也要求"回调 deny"（幂等：DSH 侧若已按未批准处理，回执会失败，但卡片必须显示真相）
      updateApprovalCard(frame, target);
      if (replyChat) sendMarkdown(replyChat, `⌛ 这条审批已过期（超过 ${Math.round(approvalCardTtlMs / 1000)} 秒），已按「拒绝」处理。请到电脑上重新发起。`);
      emitter.emit("approval-expired", { requestId, taskId: target.taskId, fromUser, chatid, decision: "deny", result, at: now() });
      return;
    }

    if (result && result.ok) {
      state.approvalDecisions += 1;
      updateApprovalCard(frame, target);
      const timeText = fmtClockFromMs(target.decidedAt);
      if (replyChat) {
        sendMarkdown(replyChat, decision === "allow"
          ? `✅ 已允许一次（${who} · ${timeText}）`
          : `❌ 已拒绝（${who} · ${timeText}）`);
      }
      log.info(`审批卡片处理完成 decision=${decision} task=${target.taskId}`);
      emitter.emit("approval-decided", { requestId, taskId: target.taskId, decision, fromUser, chatid, via: result.via, at: now() });
      return;
    }

    // ④ 没送达电脑端（例如手机上已经拍过板 / DSH 侧已过期）：如实说，卡片显示失败
    target.decidedState = "failed";
    target.failReason = truncateText((result && result.reason) || "没有可用的审批通道", 60);
    updateApprovalCard(frame, target);
    if (replyChat) sendMarkdown(replyChat, `⚠️ 没能送达电脑端：${target.failReason}。请到电脑上确认。`);
    log.warn(`审批卡片未能送达电脑端：${target.failReason}`);
    emitter.emit("approval-failed", { requestId, taskId: target.taskId, decision, fromUser, chatid, reason: target.failReason, at: now() });
  }

  // ---------- DSH 事件订阅（出站通知 + 入站转发共用） ----------

  function ensureSubscriber() {
    if (subscriber) { wireSubscriber(); return; }
    if (options.subscriber) {
      subscriber = options.subscriber;
      ownsSubscriber = false;
    } else if (typeof options.createSubscriber === "function") {
      subscriber = options.createSubscriber();
      ownsSubscriber = true;
    } else if (options.upstream !== undefined) {
      try {
        subscriber = createEventSubscriber({
          upstream: typeof options.upstream === "function" ? options.upstream : String(options.upstream || ""),
          cookie: typeof options.cookie === "function" ? options.cookie : (options.cookie || ""),
          follow: true,
          log: (level, message) => {
            const line = `[events] ${message}`;
            if (level === "warn" || level === "error") log.warn(line); else log.debug(line);
          }
        });
        ownsSubscriber = true;
      } catch (e) {
        log.warn(`事件订阅器创建失败（出站通知/入站转发不可用）：${truncateText(e && e.message ? e.message : e, 120)}`);
        subscriber = null;
      }
    }
    wireSubscriber();
    if (subscriber && typeof subscriber.start === "function") {
      try { subscriber.start(); } catch (e) {
        log.warn(`事件订阅器启动失败：${truncateText(e && e.message ? e.message : e, 120)}`);
      }
    }
  }

  function wireSubscriber() {
    const sub = subscriber;
    if (!sub || wired) return;
    wired = true;
    try {
      sub.on("event", (node) => onEventNode(node));
      // 会话可选绑定（task-24）：活跃会话 + 会话列表元数据随事件刷新（合并后写状态文件）
      sub.on("session-state", (info) => {
        if (!info || typeof info.sessionId !== "string" || !info.sessionId) return;
        if (info.state === "running") activeSession.id = info.sessionId;
        else if (info.state === "removed" && activeSession.id === info.sessionId) activeSession.id = "";
        scheduleSessionRefresh();
      });
      sub.on("control-activity", (info) => {
        if (info && typeof info.sessionId === "string" && info.sessionId) activeSession.id = info.sessionId;
        scheduleSessionRefresh();
      });
      sub.on("control-sessions", () => scheduleSessionRefresh());
      sub.on("sessions-discovered", () => scheduleSessionRefresh());
      sub.on("ready", () => scheduleSessionRefresh(true));
      sub.on("gap", (info) => {
        const from = info && info.from ? new Date(info.from).toISOString() : "?";
        const to = info && info.to ? new Date(info.to).toISOString() : "?";
        log.warn(`事件订阅断线窗口 ${from} → ${to}，期间通知不可补发`);
      });
      sub.on("auth-error", (info) => {
        log.warn(`事件订阅鉴权失败（${(info && info.surface) || "?"}）：需要刷新 dsh web 会话 cookie`);
      });
      sub.on("fault", (info) => {
        const expected = info && info.expected === true;
        const msg = `事件订阅异常 code=${(info && info.code) || "?"}${info && info.sessionId ? ` session=${shortSession(info.sessionId)}` : ""}`;
        if (expected) log.debug(msg); else log.warn(`${msg}：${truncateText(info && info.message, 80)}`);
      });
    } catch (e) {
      log.warn(`挂事件处理器失败：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  /**
   * 这个 turn/end 是不是「我们刚转发进去的那次对话」的收尾？
   *
   * 判据（宁可不回传，也不要瞎回传）：
   *   · 必须**实时** turn/end（`fromSnapshot` = 重连时补报的旧 turn，绝不能拿旧回答当新回答）；
   *   · 会话必须是最近一次入站转发成功的那个；
   *   · 距那次入站 < TTL（默认 10 分钟）—— 超时就当另一次对话，走原来的标题通知；
   *   · 事件时间不能早于入站时间（给 5s 时钟/批处理余量）。
   */
  function shouldRelayAnswer(node) {
    if (!answerRelayEnabled) return false;
    if (node.kind !== NODE_KINDS.TURN_END) return false;
    if (node.fromSnapshot === true) return false;
    if (!lastInbound.sessionId || node.sessionId !== lastInbound.sessionId) return false;
    const at = now();
    if (at - lastInbound.at >= answerRelayTtlMs) return false;
    if (Number.isFinite(node.at) && node.at > 0 && node.at < lastInbound.at - 5000) return false;
    return true;
  }

  /**
   * 回答回传：把 agent 的最终回答正文发回企微（不再发「✅ 任务完成｜标题」那条）。
   *
   * 取正文用事件订阅器的 `lastAssistantText({sessionId})`（dsh-events 已有，永不抛）；
   * 取不到 → **降级退回原来的标题通知**（不丢消息，也不假装有正文）；
   * 日志只打长度/会话短 id，**绝不打印正文**（回答里可能有代码/密钥/隐私）。
   */
  async function relayAnswer(node, sessionId) {
    const target = state.boundChatId || targetChatId;
    if (!target) {
      const at = now();
      if (at - lastNoTargetLogAt > 10 * 60 * 1000) {
        lastNoTargetLogAt = at;
        log.info("有回答要回传，但还没绑定接收方：请先在企业微信里给机器人发一句话（或在配置里填 targetChatId）");
      }
      return;
    }
    let text = "";
    let why = "";
    const sub = subscriber;
    if (!sub || typeof sub.lastAssistantText !== "function") {
      why = "no_subscriber";
    } else {
      for (const delay of ANSWER_FETCH_RETRY_DELAYS_MS) {
        if (delay > 0) {
          await sleepTimer(delay);
          if (stopped) return; // 等待期间桥已退出：不再发
        }
        try {
          const r = await sub.lastAssistantText({ sessionId });
          if (r && r.ok && typeof r.text === "string" && r.text.trim()) {
            text = r.text.trim();
            break;
          }
          why = String((r && (r.code || r.message)) || "empty");
          // 硬失败（page-failed / session-not-found）重试也没意义；只有「ok 但正文还没落库」才补一次
          if (!(r && r.ok)) break;
        } catch (e) {
          why = truncateText(e && e.message ? e.message : e, 60);
          break;
        }
      }
    }

    // 降级：拿不到正文 → 退回标题通知（与改动前的行为一致）
    if (!text) {
      const fallback = toMarkdownNotification(node, { sessionTitle: options.sessionTitle });
      if (!fallback) return;
      if (!notifyRateOk()) {
        log.warn("通知超过每分钟上限，已丢弃（防止事件风暴刷屏）");
        return;
      }
      state.notified += 1;
      sendMarkdown(target, fallback);
      log.info(`取不到回答正文（${truncateText(why || "empty", 60)}），已降级为标题通知`);
      return;
    }

    const truncated = text.length > answerMaxChars;
    let body = truncated ? `${text.slice(0, answerMaxChars)}${ANSWER_TRUNCATED_NOTE}` : text;
    // 非正常结束（出错/被拦/中止）时保留一句状态行，避免"看到回答却不知道它不完整"
    const reasonKind = String(node.reason || "");
    if (reasonKind && reasonKind !== "completed") {
      const status = toMarkdownNotification(node, { sessionTitle: options.sessionTitle });
      if (status) body = `${status}\n\n${body}`;
    }
    if (!notifyRateOk()) {
      log.warn("通知超过每分钟上限，已丢弃（防止事件风暴刷屏）");
      return;
    }
    state.notified += 1;
    state.answers += 1;
    const sent = sendMarkdown(target, body);
    // 只打长度与截断标记：正文绝不能进日志
    log.info(`回答回传 chat=${chatIdHash(target)} len=${body.length}${truncated ? "（已截断）" : ""}${sent && sent.ok ? "" : ` 发送失败=${(sent && sent.reason) || "?"}`}`);
  }

  function onEventNode(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.sessionId === "string" && node.sessionId) {
      activeSession.id = node.sessionId;
      scheduleSessionRefresh();
    }
    if (stopped || !notifyAllowed || !state.authenticated) return;
    // ── 回答回传：入站后的同一会话 turn/end → 发回答正文（消费一次）──
    if (shouldRelayAnswer(node)) {
      const key = notifyKey(node);
      if (key && !rememberNotifyKey(key)) return;
      const sid = node.sessionId;
      lastInbound = { sessionId: "", at: 0 }; // 同一次入站只回传一次
      void relayAnswer(node, sid);
      return;
    }
    // ── 审批类事件：优先发**可点按钮的卡片**（允许一次/拒绝），发不出去再退回 markdown ──
    if (node.kind === NODE_KINDS.APPROVAL_REQUEST) {
      const markdown = toMarkdownNotification(node, { sessionTitle: options.sessionTitle });
      const key = notifyKey(node);
      if (key && !rememberNotifyKey(key)) return;
      const requestId = String(node.eventId || "");
      const target = state.boundChatId || targetChatId;
      if (!target) {
        const at = now();
        if (at - lastNoTargetLogAt > 10 * 60 * 1000) {
          lastNoTargetLogAt = at;
          log.info("有审批要推，但还没绑定接收方：请先在企业微信里给机器人发一句话（或在配置里填 targetChatId）");
        }
        return;
      }
      if (!notifyRateOk()) {
        log.warn("通知超过每分钟上限，已丢弃（防止事件风暴刷屏）");
        return;
      }
      state.notified += 1;
      if (approvalCardsEnabled && requestId) {
        const r = sendApprovalCard(target, {
          requestId,
          title: "需要你在电脑上拍板",
          summary: node.reason || node.toolName || "",
          toolName: node.toolName || ""
        });
        if (r.ok) return;
        log.warn(`审批卡片发送失败（${r.reason}），退回文本通知`);
      }
      if (markdown) sendMarkdown(target, markdown);
      return;
    }
    const markdown = toMarkdownNotification(node, { sessionTitle: options.sessionTitle });
    if (!markdown) return;
    const key = notifyKey(node);
    if (key && !rememberNotifyKey(key)) return;
    const target = state.boundChatId || targetChatId;
    if (!target) {
      // 首次使用：用户还没给机器人发过话，也没有配 targetChatId → 无处可推（如实记日志，不刷屏）
      const at = now();
      if (at - lastNoTargetLogAt > 10 * 60 * 1000) {
        lastNoTargetLogAt = at;
        log.info("有通知要发，但还没绑定接收方：请先在企业微信里给机器人发一句话（或在配置里填 targetChatId）");
      }
      return;
    }
    if (!notifyRateOk()) {
      log.warn("通知超过每分钟上限，已丢弃（防止事件风暴刷屏）");
      return;
    }
    state.notified += 1;
    sendMarkdown(target, markdown);
  }

  function notifyKey(node) {
    const sid = String(node.sessionId || "");
    if (node.kind === NODE_KINDS.TURN_END) return `turn:${sid}:${node.turn ?? "?"}:${node.seq ?? "?"}:${node.reason || "?"}`;
    if (node.kind === NODE_KINDS.APPROVAL_REQUEST || node.kind === NODE_KINDS.USER_QUESTION || node.kind === NODE_KINDS.PLAN_REVIEW) {
      return `approval:${node.eventId || ""}:${sid}`;
    }
    if (node.kind === NODE_KINDS.SESSION_ERROR) return `error:${sid}:${node.code || node.message || ""}:${node.at || ""}`;
    return "";
  }

  function rememberNotifyKey(key) {
    const at = now();
    // 有界 + TTL：Map 保插入序，超上限丢最旧
    for (const [k, t] of notifiedKeys) {
      if (at - t > 10 * 60 * 1000) notifiedKeys.delete(k);
      else break;
    }
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.set(key, at);
    if (notifiedKeys.size > 200) {
      const first = notifiedKeys.keys().next();
      if (!first.done) notifiedKeys.delete(first.value);
    }
    return true;
  }

  function notifyRateOk() {
    const at = now();
    while (notifyTimes.length && at - notifyTimes[0] > 60_000) notifyTimes.shift();
    if (notifyTimes.length >= maxNotifyPerMinute) return false;
    notifyTimes.push(at);
    return true;
  }

  function pruneSeen() {
    const at = now();
    for (const [k, t] of seenMsgs) {
      if (at - t > SEEN_MSG_TTL_MS) seenMsgs.delete(k);
      else break;
    }
    if (seenMsgs.size <= SEEN_MSG_MAX) return;
    const over = seenMsgs.size - SEEN_MSG_MAX;
    let i = 0;
    for (const k of seenMsgs.keys()) {
      if (i >= over) break;
      seenMsgs.delete(k);
      i += 1;
    }
  }

  // ---------- 对外 API ----------

  function emitStatus() {
    try { emitter.emit("status", status()); } catch { /* 忽略 */ }
  }

  /** 只读状态快照（**不含 secret/完整帧**；面板/诊断/测试都读它）。 */
  function status() {
    return {
      enabled: Boolean(botId && secret) && !stopped,
      running: state.running === true,
      connected: state.connected === true,
      authenticated: state.authenticated === true,
      authFailed: state.authFailed === true,
      lastError: truncateText(maskSecrets(state.lastError, [secret]), 160),
      lastConnectedAt: Number(state.lastConnectedAt) || 0,
      lastMessageAt: Number(state.lastMessageAt) || 0,
      boundChatId: state.boundChatId || "",
      targetChatId: targetChatId || "",
      reconnectAttempts: state.reconnectAttempts,
      nextRetryInMs: state.nextRetryInMs,
      lastPingAt: state.lastPingAt,
      lastPongAt: state.lastPongAt,
      inbound: state.inbound,
      rejected: state.rejected,
      notified: state.notified,
      answers: state.answers,
      sent: state.sent,
      sendFailed: state.sendFailed,
      subscriber: subscriber && typeof subscriber.state === "string" ? subscriber.state : "none",
      // 会话可选绑定（task-24）：只读元数据，不含消息正文
      sessions: normalizeSessionStatusList(sessionList),
      activeSessionId: activeSession.id || "",
      activeSessionTitle: titleOfSession(activeSession.id, activeSession.title),
      boundSessionId: boundSessionId || "",
      previews: state.previews,
      cards: state.cards,
      approvalDecisions: state.approvalDecisions,
      previews: state.previews,
      previewClicks: state.previewClicks,
      // 会员判定（2026-11-07）：档位/能力/本月用量/绑定是否被门槛忽略
      tier: tierNow(),
      caps: capsNow().slice(),
      bindingGated: bindingGatedNow(),
      messagesPerMonth: messageLimitNow(),
      usage: { month: membership.usage.month || monthKey(), messages: usageThisMonth() }
    };
  }

  return {
    /** 启动：连上 → 认证 → 心跳 → 挂事件订阅（同步返回；连接异步推进）。 */
    start() {
      if (!stopped) return status();
      if (!botId || !secret) {
        log.warn("未配置 Bot ID / Secret，不启动长连接");
        state.lastError = "未配置 Bot ID / Secret";
        writeStatus();
        return status();
      }
      stopped = false;
      state.running = true;
      state.authFailed = false;
      emitStatus();
      writeStatus();
      ensureSubscriber();
      connect();
      // 会员档位：启动时刷一次（不 await，不阻塞连接），之后每 10 分钟校准一次
      void refreshTier({ force: true }).catch(() => {});
      if (!tierTimer && capsProvider) {
        tierTimer = setInterval(() => { void refreshTier().catch(() => {}); }, tierRefreshMs);
        if (typeof tierTimer.unref === "function") tierTimer.unref();
      }
      return status();
    },

    /** 停止：清定时器、关订阅（只关自己创建的）、关连接、写最后一次状态。 */
    async stop() {
      if (stopped) return status();
      stopped = true;
      state.running = false;
      state.connected = false;
      state.authenticated = false;
      state.nextRetryInMs = 0;
      try { if (reconnectTimer) clearTimeout(reconnectTimer); } catch { /* 忽略 */ }
      reconnectTimer = null;
      try { if (tierTimer) clearInterval(tierTimer); } catch { /* 忽略 */ }
      tierTimer = null;
      stopHeartbeat();
      clearAuthTimer();
      for (const [, p] of pending) { try { clearTimeout(p.timer); } catch { /* 忽略 */ } }
      pending.clear();
      if (ownsSubscriber && subscriber && typeof subscriber.close === "function") {
        try { subscriber.close(); } catch { /* 忽略 */ }
      }
      subscriber = null;
      wired = false;
      dropSocket();
      writeStatus();
      emitStatus();
      log.info("长连接已停止");
      return status();
    },

    sendMarkdown,
    sendApprovalCard,
    sendPreviewCard,
    replyStream,
    status,
    /** 事件：message / bot-event / authenticated / auth-failed / status / inbound-*（EventEmitter 语义）。 */
    on(event, listener) { emitter.on(event, listener); return () => emitter.off(event, listener); },
    once(event, listener) { emitter.once(event, listener); return () => emitter.off(event, listener); },
    off(event, listener) { emitter.off(event, listener); },
    /** 仅测试/诊断：内部日志器（lines 里可断言 secret 从未出现）。 */
    _logger: log
  };
}

/** 可等待的短延迟（unref：不阻止进程退出）。 */
function sleepTimer(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    if (t && typeof t.unref === "function") t.unref();
  });
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ===========================================================================
// 6. 控制器：配置读取 + 热更新（bridge 只需要这一个入口）
// ===========================================================================

/**
 * 创建企业微信长连接控制器（bridge 侧入口）。
 *
 * 职责（与 task-21 §3 对应）：
 *   · 默认**关闭**：没有 `im-bots.json` / `wecom.enabled !== true` / 缺 botId+secret → 不起连接；
 *   · 启动时读配置；`fs.watchFile(2s)` 监听变化 → 配置变了才重建连接（禁用/改凭据/改 targetChatId 都生效）；
 *   · 退出时 stop（等长连接真正关掉，最多等 close 事件兜底）。
 *
 * 环境开关（都可选，默认不拦）：
 *   · `DSH_IM_BOTS=0`        —— 整个 IM 机器人功能强制关闭（连配置都不看）
 *   · `DSH_IM_BOT_NOTIFY=0`  —— 只关出站通知（入站转发照常）
 *   · `DSH_PUSH_REPORT=0`    —— 既有推送总闸，同样关掉本通知（保持一致）
 *
 * @param {{
 *   relayDir: string,
 *   log?: Function|object,
 *   env?: Record<string,string|undefined>,
 *   clock?: () => number,
 *   configPollMs?: number,
 *   notify?: boolean,
 *   createBot?: (opts:object)=>any,           // 仅测试：替换 bot 工厂
 *   botOptions?: object,                      // 透传给 createWecomBot（upstream/cookie/sessionTitle…）
 *   onApprovalDecision?: (requestId, decision, meta) => Promise<{ok, reason?, via?}|boolean>,
 *                                             // 审批卡片点击回调（bridge 注入；与手机拍板同一条路）
 * }} options
 */
export function createWecomBotController(options = {}) {
  const relayDir = String(options.relayDir || "");
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const now = typeof options.clock === "function" ? options.clock : () => Date.now();
  const pollMs = positiveNumber(options.configPollMs, CONFIG_POLL_MS);
  const log = createScopedLogger({ sink: options.log, prefix: "[wecom]" });
  const configFile = path.join(relayDir, IM_BOTS_FILE);
  const statusFile = path.join(relayDir, IM_BOT_STATUS_FILE);
  const botFactory = typeof options.createBot === "function" ? options.createBot : createWecomBot;

  const state = {
    started: false,
    enabled: false,
    configFound: false,
    reason: "not_started",
    configUpdatedAt: 0,
    lastError: ""
  };

  let bot = null;
  let currentDigest = "";
  let listener = null;
  let reloading = false;
  /**
   * 「预览卡片」已处理到的 previewCardAt（跨重启从状态文件 `wecom.lastPreviewCardAt` 恢复，
   * 保证**相同值不重复发**；插件每点一次「发送预览」写一个新时间戳）。
   */
  let lastPreviewAt = 0;
  if (relayDir) {
    try {
      const st = readJsonFile(statusFile);
      lastPreviewAt = Number(st && st.wecom && st.wecom.lastPreviewCardAt) || 0;
    } catch { /* 忽略 */ }
  }

  function notifyAllowed() {
    if (String(env.DSH_IM_BOT_NOTIFY || "") === "0") return false;
    if (String(env.DSH_PUSH_REPORT || "") === "0") return false;
    return options.notify !== false;
  }

  function hardDisabled() {
    return String(env.DSH_IM_BOTS || "") === "0";
  }

  /** 配置摘要（**含 secret 的 sha1**，只在内存里比较；绝不落文件/日志）。 */
  function digestOf(cfg) {
    if (!cfg) return "missing";
    const w = cfg.wecom || {};
    let secretHash = "";
    try { secretHash = w.secret ? crypto.createHash("sha1").update(String(w.secret)).digest("hex") : ""; } catch { secretHash = "?"; }
    return JSON.stringify([
      w.enabled === true, w.botId || "", secretHash, w.url || "",
      w.targetChatId || "", w.allowFrom || [], notifyAllowed(),
      // 会话可选绑定（task-24）：改了固定会话就要重建 bot（转发目标立即生效，无需重启 bridge）
      w.sessionId || "", w.sessionTitle || ""
    ]);
  }

  /** 写「未启用」状态（配置存在但关着/不全时也要让插件看到原因）。 */
  function writeDisabledStatus(reason) {
    if (!relayDir) return;
    try {
      const prev = readJsonFile(statusFile);
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      atomicWriteJson(statusFile, {
        ...base,
        version: 1,
        updatedAt: Number(now()) || Date.now(),
        wecom: {
          ...(base.wecom && typeof base.wecom === "object" ? base.wecom : {}),
          enabled: false,
          connected: false,
          authenticated: false,
          lastError: truncateText(reason, 160),
          boundChatId: "",
          targetChatId: "",
          sessions: [],
          activeSessionId: "",
          activeSessionTitle: "",
          boundSessionId: ""
        }
      }, { onWarn: (m) => log.warn(m) });
    } catch (e) {
      log.warn(`状态文件写入失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  async function stopBot() {
    const b = bot;
    bot = null;
    if (!b) return;
    try { await b.stop(); } catch (e) {
      log.warn(`停止长连接失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  /** 把「已处理的 previewCardAt」写进状态文件（跨重启防重复；面板只读，不依赖它）。 */
  function writePreviewMarker(at) {
    if (!relayDir) return;
    try {
      const prev = readJsonFile(statusFile);
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      atomicWriteJson(statusFile, {
        ...base,
        version: 1,
        updatedAt: Number(now()) || Date.now(),
        wecom: { ...(base.wecom && typeof base.wecom === "object" ? base.wecom : {}), lastPreviewCardAt: Number(at) || 0 }
      }, { onWarn: (m) => log.warn(m) });
    } catch (e) {
      log.warn(`预览标记写入失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  /** 认证后按当前绑定关系发预览卡（无接收方 → 只记日志，不报错）。 */
  function sendPreviewNow(targetBot, at) {
    if (targetBot !== bot) return; // 等待期间连接被重建/停用 → 不再发
    const st = typeof targetBot.status === "function" ? targetBot.status() : {};
    const to = String(st.boundChatId || st.targetChatId || "");
    if (!to) {
      log.info("预览卡片跳过：还没有绑定接收方（先在企业微信里给机器人发一句话，再点一次「发送预览」）");
      return;
    }
    const r = targetBot.sendPreviewCard(to, at);
    if (r && r.ok) log.info(`预览卡片已按配置发送 chat=${chatIdHash(to)}`);
    else log.warn(`预览卡片发送失败（${(r && r.reason) || "?"}）`);
  }

  /**
   * 处理「发送预览卡片」信号（im-bots.json 的 wecom.previewCardAt）。
   *
   * 规则：previewCardAt > 上次已处理值（且 >0）→ 向 boundChatId || targetChatId 发一张预览卡；
   * 相同值绝不重复发（先记再发，watchFile 抖动也只会处理一次）。连接配置没变时**不重建连接**。
   * bot 还没认证时最多等 20s（认证事件驱动），超时放弃（下次插件再点一次即可）。
   */
  async function handlePreview(cfg) {
    try {
      const w = cfg && cfg.wecom && typeof cfg.wecom === "object" ? cfg.wecom : null;
      if (!w || w.enabled !== true || !w.botId || !w.secret) return;
      const at = Number(w.previewCardAt) || 0;
      if (!(at > lastPreviewAt)) return;
      lastPreviewAt = at; // 先记账：同一值不重复发
      writePreviewMarker(at);
      const b = bot;
      if (!b || typeof b.sendPreviewCard !== "function") return;
      const st = typeof b.status === "function" ? b.status() : {};
      if (st.authenticated === true) { sendPreviewNow(b, at); return; }
      await new Promise((resolve) => {
        let done = false;
        let off = null;
        const timer = setTimeout(finish, 20_000);
        if (timer && typeof timer.unref === "function") timer.unref();
        function finish() {
          if (done) return;
          done = true;
          try { clearTimeout(timer); } catch { /* 忽略 */ }
          try { if (typeof off === "function") off(); } catch { /* 忽略 */ }
          sendPreviewNow(b, at);
          resolve();
        }
        try { off = typeof b.on === "function" ? b.on("authenticated", finish) : null; } catch { off = null; }
      });
    } catch (e) {
      log.warn(`预览卡片处理失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  /** 按当前配置应用（幂等：连接配置没变就只处理预览等"不重建连接"的信号）。 */
  async function applyConfig() {
    if (reloading) return; // 单飞：watch 回调可能连着触两次
    reloading = true;
    try {
      if (hardDisabled()) {
        state.enabled = false;
        state.reason = "disabled_by_env";
        await stopBot();
        return;
      }
      const cfg = readImBotsConfig(relayDir);
      state.configFound = cfg !== null;
      const digest = digestOf(cfg); // 只含"连接配置"（不含 previewCardAt：预览不需要重建连接）
      if (digest === currentDigest) {
        // 连接配置没变（watchFile 会因 mtime 反复触发）→ 仍要处理「发送预览」信号
        await handlePreview(cfg);
        return;
      }
      currentDigest = digest;
      await stopBot();
      if (!cfg) {
        state.enabled = false;
        state.reason = "no_config";
        log.info("未找到 im-bots.json，IM 机器人通道不启动");
        return;
      }
      state.configUpdatedAt = Number(now()) || Date.now();
      const w = cfg.wecom;
      if (!w.enabled) {
        state.enabled = false;
        state.reason = "disabled";
        log.info("im-bots.json 里 wecom.enabled=false，IM 机器人通道不启动");
        writeDisabledStatus("未启用（配置里 wecom.enabled=false）");
        return;
      }
      if (!w.botId || !w.secret) {
        state.enabled = false;
        state.reason = "missing_credentials";
        log.warn("im-bots.json 里缺少 botId/secret，IM 机器人通道不启动");
        writeDisabledStatus("缺少 Bot ID / Secret（请在插件「企业微信机器人」里填写）");
        return;
      }
      const botOptions = {
        botId: w.botId,
        secret: w.secret,
        url: w.url || undefined,
        relayDir,
        targetChatId: w.targetChatId,
        allowFrom: w.allowFrom,
        // 会话可选绑定（task-24）：配置固定的会话（空 = 跟随活跃会话；状态文件里写 boundSessionId）
        configuredSessionId: w.sessionId,
        configuredSessionTitle: w.sessionTitle,
        // 审批卡片点击 → 决策回调（bridge 注入：approvalCoordinator.resolve → pushReporter.answerApproval）
        onApprovalDecision: typeof options.onApprovalDecision === "function" ? options.onApprovalDecision : undefined,
        notify: notifyAllowed(),
        logger: options.log,
        clock: options.clock,
        ...(options.botOptions && typeof options.botOptions === "object" ? options.botOptions : {})
      };
      bot = botFactory(botOptions);
      if (!bot || typeof bot.start !== "function") {
        state.enabled = false;
        state.reason = "bot_factory_invalid";
        state.lastError = "bot 工厂返回了无效对象";
        log.warn(state.lastError);
        return;
      }
      state.enabled = true;
      state.reason = "started";
      state.lastError = "";
      bot.start();
      log.info(`IM 机器人通道已启动（chat 兜底=${w.targetChatId ? chatIdHash(w.targetChatId) : "未配置"}，通知=${notifyAllowed() ? "开" : "关"}）`);
      await handlePreview(cfg);
    } catch (e) {
      state.enabled = false;
      state.reason = "apply_failed";
      state.lastError = truncateText(e && e.message ? e.message : e, 160);
      log.warn(`应用 IM 机器人配置失败（忽略）：${state.lastError}`);
    } finally {
      reloading = false;
    }
  }

  function watchConfig() {
    if (listener) return;
    listener = () => { void applyConfig(); };
    try {
      fs.watchFile(configFile, { interval: pollMs }, listener);
    } catch (e) {
      log.warn(`监听 im-bots.json 失败（改配置后需重启 bridge）：${truncateText(e && e.message ? e.message : e, 120)}`);
      listener = null;
    }
  }

  function unwatchConfig() {
    if (!listener) return;
    try { fs.unwatchFile(configFile, listener); } catch { /* 忽略 */ }
    listener = null;
  }

  /** 控制器只读快照（start/stop 内部与外部都读它）。 */
  function statusSnapshot() {
    const bs = bot && typeof bot.status === "function" ? bot.status() : null;
    return {
      started: state.started,
      enabled: state.enabled,
      configFound: state.configFound,
      reason: state.reason,
      configPath: configFile,
      statusPath: statusFile,
      configUpdatedAt: state.configUpdatedAt,
      lastError: state.lastError || (bs && bs.lastError) || "",
      bot: bs
    };
  }

  return {
    /** 启动：读配置（可能不起连接）+ 开始监听配置变化。 */
    async start() {
      if (state.started) return statusSnapshot();
      state.started = true;
      if (hardDisabled()) {
        state.reason = "disabled_by_env";
        log.info("IM 机器人通道已被 DSH_IM_BOTS=0 关闭");
        return statusSnapshot();
      }
      if (!relayDir) {
        state.reason = "no_relay_dir";
        log.warn("缺少 relayDir，IM 机器人通道不启动");
        return statusSnapshot();
      }
      await applyConfig();
      watchConfig();
      return statusSnapshot();
    },

    /** 停止：先停 watch，再停连接（顺序重要：避免停的过程中又起一个）。 */
    async stop() {
      unwatchConfig();
      state.started = false;
      state.enabled = false;
      state.reason = "stopped";
      await stopBot();
      return statusSnapshot();
    },

    status: statusSnapshot,

    /** 仅测试：当前 bot 实例（不参与生产逻辑）。 */
    _bot() { return bot; }
  };
}

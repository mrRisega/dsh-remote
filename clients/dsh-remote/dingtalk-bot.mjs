/**
 * dingtalk-bot — 钉钉「Stream 模式」长连接通道（2026-11-08，与 wecom-bot 同构，**零新增依赖**）。
 *
 * 为什么要自写（官方明确鼓励）：
 *   钉钉把 Stream 协议公开成文档，并写明「平台也向开发者开放了 Stream 模式的接入协议，
 *   鼓励各语言开发者根据此协议完成 Stream 客户端开发」。核心 = HTTP 换 ticket + WebSocket 收帧 + ACK，
 *   链路 ~150 行，不需要 SDK。/tmp/dt-probe 实测官方 SDK 仅 68KB 包（4.3MB 依赖树），
 *   自写主要是为了与企微通道同构、零新增依赖。
 *
 * 协议（来源：research/2026-11-strategy/06-multiagent/dingtalk-stream.md，均来自官方文档/官方 SDK 源码）
 * -----------------------------------------------------------------
 *   1) 建连前换 ticket：POST {gatewayUrl}（默认 https://api.dingtalk.com/v1.0/gateway/connections/open）
 *      body {clientId, clientSecret, subscriptions:[{type:"CALLBACK",topic:"/v1.0/im/bot/messages/get"}], ua}
 *      → {endpoint, ticket}；**ticket 一次性 + 90s 有效**（每次重连都必须重新 open，绝不复用）。
 *   2) wss://{endpoint路径}?ticket=… → 帧是纯 JSON：{type:"SYSTEM"|"EVENT"|"CALLBACK", headers:{messageId,topic,contentType,time}, data}
 *      ⚠️ `data` 是 **JSON 字符串**（要二次 parse；本模块容错 object/string 两种）。
 *   3) **每帧必须 ACK**（CALLBACK 不自动 ACK）：
 *        {code:200, headers:{messageId, contentType:"application/json"}, message:"OK", data: "<JSON 字符串>"}
 *      · SYSTEM ping → data `{"opaque":<原样回传>}`（messageId 必须一致）
 *      · EVENT      → data `{"status":"SUCCESS"}`
 *      · 机器人消息 → data `{"response":null}`（钉钉不读，只认 code=200）
 *      · SYSTEM disconnect → **不 ACK**，主动重连（官方给 10s 宽限；我们直接换新连接）
 *      · CONNECTED/REGISTERED/KEEPALIVE/未知 SYSTEM → 只记 debug，**忽略不崩**（官方协议文档没写这几个 topic）
 *      ⚠️ ACK 的 `data` 是 JSON 字符串（与官方 SDK 一致）；task 文档里提过的 base64 变体标 UNVERIFIED，
 *         真机若要求 base64 只需改 `buildAck` 一处（有单测夹具钉住当前形状）。
 *   4) 入站机器人消息（topic /v1.0/im/bot/messages/get）data：conversationId / conversationType(1=单聊 2=群) /
 *      senderStaffId / msgtype / text.content / sessionWebhook / robotCode / msgId …
 *   5) **Stream 里不能内联回复**：回复走 HTTP —— 默认 `POST {sessionWebhook}` body
 *      `{msgtype:"markdown", markdown:{title, text}}`（markdown 支持、表格不支持 → 统一走 `im-format.mjs`
 *      的 `formatForChannel("dingtalk", …)`）；可选 `replyMode:"openapi"` 走 accessToken + OpenAPI（标 UNVERIFIED）。
 *   6) 重连：每次先重新 open 拿新 ticket；退避 min(1000×2^n + 抖动, 60000)。**open 返回 4xx = 凭据错 → 不重连**，
 *      状态置 failed 并给明确错误。
 *   7) accessToken（仅 openapi 模式）：POST https://api.dingtalk.com/v1.0/oauth2/accessToken
 *      {appKey: clientId, appSecret: clientSecret} → {accessToken, expireIn}；内存缓存（提前 5 分钟过期）。
 *
 * 安全/契约
 * -----------------------------------------------------------------
 *   · clientSecret / ticket / accessToken **绝不进日志与状态文件**（状态只留 ticketExpiresAt 时间戳）：
 *     `maskSecrets` + 只打 cmd/topic/chatid 哈希。
 *   · 配置：`im-bots.json` 的 `dingtalk` 段（与插件线约定，见 normalizeDingtalkConfig）；
 *     状态：`im-bot-status.json` 的 `dingtalk` 段（字段与企微对齐 + subscriptions/ticketExpiresAt）。
 *   · 会员判定、会话绑定、通知/回答回传、格式化、状态原子写 **全部复用** 企微那套（同一套能力表/口径）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { createEventSubscriber, NODE_KINDS } from "./dsh-events.mjs";
import { formatForChannel } from "./im-format.mjs";
// 命令层（2026-11-08）：/help /status /stop /ls /use /unbind 在进模型前拦下执行（三家共用）
import { executeImCommand, writeImBotsSession } from "./im-commands.mjs";
import {
  WECHAT_CAPABILITY_TABLE,
  WECHAT_TIER_LIMITS,
  capabilitiesFor,
  grantsCap,
  limitsFor
} from "./wechat-runtime.mjs";
import {
  CONFIG_POLL_MS,
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE,
  atomicWriteJson,
  chatIdHash,
  createScopedLogger,
  maskSecrets,
  normalizeAllowList,
  readJsonFile,
  toMarkdownNotification,
  truncateText
} from "./wecom-bot.mjs";

// ===========================================================================
// 1. 常量 / 协议纯函数（可直接单测，不建连、不打网络）
// ===========================================================================

/** Stream 建连网关（私有化/测试可覆盖）。 */
export const DINGTALK_OPEN_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/** accessToken 端点（仅 openapi 回复模式）。 */
export const DINGTALK_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
/** 单聊/群聊主动发消息 OpenAPI（仅 openapi 回复模式；标 UNVERIFIED，真机需一次核验）。 */
export const DINGTALK_O2O_SEND_URL = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
export const DINGTALK_GROUP_SEND_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
/** 机器人消息订阅 topic。 */
export const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
/** 卡片按钮回调 topic（卡片拍板本轮**后置**；收到也只 ACK + 记日志，不崩）。 */
export const TOPIC_CARD_CALLBACK = "/v1.0/card/instances/callback";
/** 默认订阅（与调研一致：只订机器人消息；卡片后置再加）。 */
export const DEFAULT_SUBSCRIPTIONS = Object.freeze([{ type: "CALLBACK", topic: TOPIC_ROBOT }]);
/** ticket 有效期（官方：90s / 一次性）。状态文件只记过期时间，不存 ticket。 */
export const TICKET_TTL_MS = 90_000;
/**
 * 回复通道持久化文件（相对 relayDir；0600）：缓存最近一次入站带来的
 * `{sessionWebhook, sessionWebhookExpiredTime, senderStaffId, conversationId, conversationType, boundChatId, at}`。
 * 为什么不写状态文件：sessionWebhook 里带会话令牌，状态文件是给面板/浏览器看的（只放元数据）。
 * 为什么要落盘：进程重启后「回答回传」仍要能发出去（Lead 实测 bug：只存内存会丢，回传直接发不出）。
 */
export const REPLY_FILE = "im-dingtalk-reply.json";
/** webhook 过期后降级 openapi 时给用户/日志的明确原因（面板据此提示"再发一条消息激活"）。 */
const NO_REPLY_CHANNEL_HINT = "回复通道不可用：请在钉钉里再发一条消息激活（或配置 robotCode 走 OpenAPI）";
/** 重连退避：1s 起、翻倍、60s 封顶（+0~1s 抖动，照官方 SDK 行为）。 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** open 请求超时。 */
const OPEN_TIMEOUT_MS = 10_000;
/** 机器人消息 ACK（官方：`{"response":null}`；钉钉不读该字段，只认 code=200）。 */
export const BOT_CALLBACK_ACK = Object.freeze({ response: null });
/** 事件订阅 ACK。 */
export const EVENT_ACK = Object.freeze({ status: "SUCCESS" });
/** 单条消息去重上限。 */
const SEEN_MSG_MAX = 200;

/** 构造 open 请求体（**只含契约字段**；用户可注入订阅列表，默认只订机器人消息）。 */
export function buildOpenBody({ clientId, clientSecret, subscriptions, ua, localIp } = {}) {
  const subs = Array.isArray(subscriptions) && subscriptions.length
    ? subscriptions
      .filter((s) => s && typeof s === "object" && typeof s.topic === "string" && s.topic)
      .map((s) => ({ type: String(s.type || "CALLBACK"), topic: String(s.topic) }))
    : DEFAULT_SUBSCRIPTIONS.map((s) => ({ ...s }));
  const body = {
    clientId: String(clientId || ""),
    clientSecret: String(clientSecret || ""),
    subscriptions: subs
  };
  if (ua) body.ua = String(ua);
  if (localIp) body.localIp = String(localIp);
  return body;
}

/**
 * 构造 ACK 帧。`data` 是 **JSON 字符串**（官方 SDK 行为；task 里提过的 base64 变体标 UNVERIFIED）。
 * @param {string} messageId 原样带回
 * @param {object} payload   ACK data 的对象
 */
export function buildAck(messageId, payload) {
  return {
    code: 200,
    headers: { messageId: String(messageId || ""), contentType: "application/json" },
    message: "OK",
    data: JSON.stringify(payload === undefined ? {} : payload)
  };
}

/** SYSTEM ping 的 ACK（把 data.opaque 原样回传；messageId 必须一致）。 */
export function buildPingAck(messageId, opaque) {
  return buildAck(messageId, { opaque: opaque === undefined ? "" : opaque });
}

/**
 * 解析下行帧。
 * @returns {{type:string, headers:object, data:any, raw:object}|null}
 */
export function parseFrame(raw) {
  let frame = null;
  try {
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const headers = frame.headers && typeof frame.headers === "object" ? frame.headers : {};
  let data = frame.data;
  // ⚠️ 官方：data 是 JSON 字符串（要二次 parse）。这里同时容错 object/空值。
  if (typeof data === "string") {
    const s = data.trim();
    if (!s) data = null;
    else {
      try { data = JSON.parse(s); } catch { data = null; }
    }
  }
  return { type: String(frame.type || "").toUpperCase(), headers, data, raw: frame };
}

/** 把机器人消息 data 归一成内部结构（字段名以官方「机器人接收消息」为准）。 */
export function normalizeBotMessage(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const textObj = d.text && typeof d.text === "object" ? d.text : null;
  const text = textObj && typeof textObj.content === "string"
    ? textObj.content
    : (typeof d.content === "string" ? d.content : "");
  const conversationType = String(d.conversationType || "");
  const conversationId = String(d.conversationId || "");
  const senderStaffId = String(d.senderStaffId || "");
  return {
    text: String(text || "").trim(),
    msgId: String(d.msgId || ""),
    msgtype: String(d.msgtype || ""),
    conversationId,
    conversationType,
    isGroup: conversationType === "2",
    senderStaffId,
    senderNick: String(d.senderNick || ""),
    senderId: String(d.senderId || ""),
    sessionWebhook: String(d.sessionWebhook || ""),
    sessionWebhookExpiredTime: Number(d.sessionWebhookExpiredTime) || 0,
    robotCode: String(d.robotCode || ""),
    createAt: Number(d.createAt) || 0,
    /** 主动发消息/去重用的目标：群=conversationId，单聊=senderStaffId（单聊 conversationId 不能当 chatId，否则会被误判成群聊）。 */
    chatId: (conversationType === "2" ? conversationId : senderStaffId) || conversationId || senderStaffId,
    raw: d
  };
}

/** sessionWebhook 回复体（与自定义机器人一致；markdown 支持表格? → 不支持，文本已由 im-format 适配）。 */
export function buildSessionWebhookBody({ title, text } = {}) {
  const t = String(title || "").trim() || "DeepSeek Harness";
  return { msgtype: "markdown", markdown: { title: truncateText(t, 64), text: String(text == null ? "" : text) } };
}

/** 配置规范化：`im-bots.json` 的 `dingtalk` 段（缺字段补默认，非法值当未配置，绝不抛）。 */
export function normalizeDingtalkConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const replyMode = str(src.replyMode).toLowerCase() === "openapi" ? "openapi" : "sessionWebhook";
  return {
    enabled: src.enabled === true,
    clientId: str(src.clientId),
    clientSecret: typeof src.clientSecret === "string" ? src.clientSecret : "",
    // robotCode **可选**（扫码一键创建机器人可能不返回 robot_code）：只影响 openapi 主动发送/卡片；
    // 接收消息 + sessionWebhook 回复完全不需要它（capabilities 里会如实降级）。
    robotCode: str(src.robotCode),
    // 凭据来源（插件扫码授权流程写入 "scan"，手工填默认 "manual"）——仅用于状态排障/面板展示
    credentialSource: str(src.credentialSource).toLowerCase() === "scan" ? "scan" : "manual",
    replyMode,
    sessionWebhook: str(src.sessionWebhook),
    boundChatId: str(src.boundChatId),
    allowFrom: normalizeAllowList(src.allowFrom),
    cardTemplateId: str(src.cardTemplateId),
    streamUrl: str(src.streamUrl),
    // 会话可选绑定（与企微同口径）
    sessionId: str(src.sessionId),
    sessionTitle: str(src.sessionTitle)
  };
}

/** 读取 `im-bots.json` 的 dingtalk 段（文件不存在 → null）。 */
export function readDingtalkConfig(relayDir) {
  if (!relayDir) return null;
  const raw = readJsonFile(path.join(String(relayDir), IM_BOTS_FILE));
  if (raw === null) return null;
  const section = raw && typeof raw === "object" && raw.dingtalk && typeof raw.dingtalk === "object"
    ? raw.dingtalk : {};
  return normalizeDingtalkConfig(section);
}

// ===========================================================================
// 2. 长连接 bot（与 createWecomBot 同形）
// ===========================================================================

/**
 * @param {{
 *   clientId: string, clientSecret: string,
 *   robotCode?: string,                 // 可选：只影响 openapi 主动发送/卡片；缺省时降级（接收+sessionWebhook 回复仍可用）
 *   cardTemplateId?: string,            // 可选：卡片拍板模板（缺省 card 能力降级）
 *   credentialSource?: "scan"|"manual", // 凭据来源（状态透出；扫码授权写入 scan）
 *   replyMode?: "sessionWebhook"|"openapi",
 *   gatewayUrl?: string,                 // 覆盖 open 端点（私有化/测试）
 *   tokenUrl?: string, o2oSendUrl?: string, groupSendUrl?: string,
 *   subscriptions?: Array<{type:string, topic:string}>,
 *   relayDir?: string,                   // 有值 → 写 im-bot-status.json 的 dingtalk 段
 *   allowFrom?: string[], targetChatId?: string,
 *   configuredSessionId?: string, configuredSessionTitle?: string,
 *   capsProvider?: () => Promise<string|object>, tier?: string, appUrl?: string,
 *   notify?: boolean, formatChannel?: string,
 *   logger?: Function|object, clock?: () => number,
 *   wsFactory?: (url:string)=>any, fetchImpl?: typeof fetch,
 *   upstream?: string|(()=>string), cookie?: string|(()=>string), subscriber?: any,
 *   reconnectBaseMs?: number, reconnectMaxMs?: number, openTimeoutMs?: number,
 *   tierDenyThrottleMs?: number, sessionIdProvider?: () => string
 * }} options
 */
export function createDingtalkBot(options = {}) {
  const clientId = String(options.clientId || "").trim();
  const clientSecret = typeof options.clientSecret === "string" ? options.clientSecret : "";
  const robotCode = String(options.robotCode || "").trim();
  const cardTemplateId = String(options.cardTemplateId || "").trim();
  const credentialSource = String(options.credentialSource || "").toLowerCase() === "scan" ? "scan" : "manual";
  const replyMode = String(options.replyMode || "sessionWebhook").toLowerCase() === "openapi" ? "openapi" : "sessionWebhook";
  const gatewayUrl = String(options.gatewayUrl || "").trim() || DINGTALK_OPEN_URL;
  const tokenUrl = String(options.tokenUrl || "").trim() || DINGTALK_TOKEN_URL;
  const o2oSendUrl = String(options.o2oSendUrl || "").trim() || DINGTALK_O2O_SEND_URL;
  const groupSendUrl = String(options.groupSendUrl || "").trim() || DINGTALK_GROUP_SEND_URL;
  const relayDir = options.relayDir ? String(options.relayDir) : "";
  const allowFrom = normalizeAllowList(options.allowFrom);
  const targetChatId = String(options.targetChatId || "").trim();
  let configuredSessionId = String(options.configuredSessionId || "").trim();
  let configuredSessionTitle = truncateText(options.configuredSessionTitle || "", 60);
  const now = typeof options.clock === "function" ? options.clock : () => Date.now();
  const doFetch = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const wsFactory = typeof options.wsFactory === "function" ? options.wsFactory : (url) => new WebSocket(url);
  const reconnectBaseMs = positiveNumber(options.reconnectBaseMs, RECONNECT_BASE_MS);
  const reconnectMaxMs = Math.max(reconnectBaseMs, positiveNumber(options.reconnectMaxMs, RECONNECT_MAX_MS));
  const openTimeoutMs = positiveNumber(options.openTimeoutMs, OPEN_TIMEOUT_MS);
  const notifyAllowed = options.notify !== false;
  const formatChannel = String(options.formatChannel || "dingtalk").trim() || "dingtalk";
  const ua = String(options.ua || "dsh-remote-bridge/dingtalk-bot");
  const subscriptions = Array.isArray(options.subscriptions) && options.subscriptions.length
    ? options.subscriptions : DEFAULT_SUBSCRIPTIONS;
  const log = createScopedLogger({ sink: options.logger, secrets: [clientSecret], prefix: "[dingtalk]" });

  // 会员判定（与企微同口径：通知/拍板免费、互动免费 20 条/月）
  const capsProvider = typeof options.capsProvider === "function" ? options.capsProvider : null;
  const tierOverride = typeof options.tier === "string" && options.tier.trim() ? options.tier.trim() : "";
  const capabilityTable = options.capabilityTable && typeof options.capabilityTable === "object" ? options.capabilityTable : WECHAT_CAPABILITY_TABLE;
  const limitTable = options.limitTable && typeof options.limitTable === "object" ? options.limitTable : WECHAT_TIER_LIMITS;
  const tierDenyThrottleMs = Number.isFinite(Number(options.tierDenyThrottleMs)) ? Math.max(0, Number(options.tierDenyThrottleMs)) : 5000;

  const statusFile = relayDir ? path.join(relayDir, IM_BOT_STATUS_FILE) : "";
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);

  /** 连接状态机：idle | connecting | connected | reconnecting | failed（与企微/飞书统一）。 */
  const state = {
    running: false,
    phase: "idle",
    connected: false,
    authenticated: false,
    lastError: "",
    lastConnectedAt: 0,
    lastMessageAt: 0,
    openCount: 0,
    ticketExpiresAt: 0,
    reconnectAttempts: 0,
    nextRetryInMs: 0,
    boundChatId: "",
    boundConversationId: "",
    boundUserId: "",
    boundSessionWebhook: "",
    boundSessionWebhookExpiredAt: 0,
    messages: 0,
    gated: 0,
    /** 最近一次回复失败原因（人话；写状态 replyChannel.lastError，不覆盖连接错误）。 */
    replyChannelError: ""
  };
  const membership = { tier: "", entitlements: null, checkedAt: 0, usage: { month: "", count: 0 } };

  /**
   * 能力降级表（写进状态，插件面板据此禁用按钮 + 提示去补配置）：
   *   · openapi：主动发送需要 robotCode（扫码授权不一定返回 robot_code）→ 缺省 = false
   *   · card：卡片拍板需要 robotCode + 卡片平台模板 ID → 缺一即 false
   * ⚠️ 接收消息 / sessionWebhook 回复**不依赖**这两项，所以机器人仍可正常用（产品主链路不受影响）。
   */
  function capabilitiesNow() {
    const openapi = Boolean(robotCode);
    return { openapi, card: Boolean(openapi && cardTemplateId) };
  }

  let ws = null;
  let stopped = true;
  let reconnectTimer = null;
  let tierTimer = null;
  let connecting = false;
  let subscriber = null;
  let ownsSubscriber = false;
  let wired = false;
  let lastSeenSessionId = "";
  let lastInbound = { sessionId: "", at: 0 };
  let lastNoTargetLogAt = 0;
  let boundSessionId = "";
  const seenMsgs = new Map();
  const pendingToken = { value: "", expiresAt: 0 };

  // 配置里持久化的 sessionWebhook（插件/上次运行留下的）：首次入站前也能主动发；
  // ⚠️ webhook 里带会话令牌，**绝不写状态文件**，只在内存里用。
  if (options.sessionWebhook) state.boundSessionWebhook = String(options.sessionWebhook || "");
  // 上次入站缓存的回复通道（跨重启可用）：im-dingtalk-reply.json（0600）
  if (relayDir) {
    try {
      const saved = readJsonFile(path.join(relayDir, REPLY_FILE));
      if (saved && typeof saved === "object") {
        if (typeof saved.sessionWebhook === "string" && saved.sessionWebhook) state.boundSessionWebhook = saved.sessionWebhook;
        if (Number.isFinite(Number(saved.sessionWebhookExpiredTime))) state.boundSessionWebhookExpiredAt = Number(saved.sessionWebhookExpiredTime);
        if (typeof saved.senderStaffId === "string" && saved.senderStaffId) state.boundUserId = saved.senderStaffId;
        if (typeof saved.conversationId === "string" && saved.conversationId) state.boundConversationId = saved.conversationId;
        if (typeof saved.boundChatId === "string" && saved.boundChatId) state.boundChatId = saved.boundChatId;
      }
    } catch { /* 忽略坏文件 */ }
  }
  if (targetChatId && !state.boundChatId) state.boundChatId = targetChatId;

  // 重启恢复：用量 / 绑定目标 / 档位快照（均不含凭据）
  if (relayDir) {
    try {
      const prev = readJsonFile(statusFile);
      const d = prev && prev.dingtalk && typeof prev.dingtalk === "object" ? prev.dingtalk : {};
      if (typeof d.boundChatId === "string" && d.boundChatId) state.boundChatId = d.boundChatId;
      if (typeof d.boundConversationId === "string") state.boundConversationId = d.boundConversationId;
      if (typeof d.boundUserId === "string") state.boundUserId = d.boundUserId;
      if (typeof d.boundSessionWebhook === "string") state.boundSessionWebhook = d.boundSessionWebhook;
      if (Number.isFinite(Number(d.boundSessionWebhookExpiredAt))) state.boundSessionWebhookExpiredAt = Number(d.boundSessionWebhookExpiredAt);
      if (typeof d.boundSessionId === "string") boundSessionId = d.boundSessionId;
      if (d.usage && typeof d.usage === "object" && typeof d.usage.month === "string") {
        membership.usage = { month: d.usage.month, count: Math.max(0, Number(d.usage.messages ?? d.usage.count) || 0) };
      }
      if (capsProvider && typeof d.tier === "string" && d.tier) {
        membership.tier = d.tier;
        membership.entitlements = {
          rev: typeof d.entitlementsRev === "string" ? d.entitlementsRev : "",
          plan: d.tier,
          caps: Array.isArray(d.caps) ? d.caps.slice() : null,
          limits: d.limits && typeof d.limits === "object" ? d.limits : null
        };
      }
    } catch { /* 忽略 */ }
  }

  // ---------- 会员（与 wecom 同口径） ----------

  function monthKey(at = now()) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  function tierNow() { return tierOverride || membership.tier || "free"; }
  function capsNow() {
    const server = membership.entitlements && Array.isArray(membership.entitlements.caps) ? membership.entitlements.caps : null;
    if (server) return server;
    return capabilitiesFor(tierNow(), capabilityTable) || [];
  }
  function limitsNow() {
    const server = membership.entitlements && membership.entitlements.limits;
    if (server && typeof server === "object") return server;
    return limitsFor(tierNow(), limitTable) || {};
  }
  function canCap(cap) { return grantsCap(capsNow(), cap); }
  function usageThisMonth() { return membership.usage.month === monthKey() ? Number(membership.usage.count || 0) : 0; }
  function messageLimitNow() {
    const n = Number((limitsNow() || {}).messages_per_month || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function bindingGatedNow() { return Boolean(configuredSessionId) && !canCap("sessions"); }
  async function refreshTier({ force = false, minIntervalMs = 30_000 } = {}) {
    if (!capsProvider) return tierNow();
    const at = now();
    if (!force && at - membership.checkedAt < minIntervalMs) return tierNow();
    membership.checkedAt = at;
    let got = null;
    try { got = await capsProvider(); } catch (e) {
      log.warn(`读取账号档位失败（沿用上次）：${truncateText(e && e.message ? e.message : e, 100)}`);
      return tierNow();
    }
    const isObj = Boolean(got) && typeof got === "object";
    const plan = String((isObj ? got.plan : got) || "").trim();
    if (!plan) return tierNow();
    const caps = isObj && Array.isArray(got.caps) ? got.caps : null;
    const limits = isObj && got.limits && typeof got.limits === "object" ? got.limits : null;
    membership.tier = plan;
    if (caps || limits) {
      membership.entitlements = {
        rev: isObj ? String(got.rev || "") : "",
        plan,
        caps: caps || (membership.entitlements && membership.entitlements.caps) || null,
        limits: limits || (membership.entitlements && membership.entitlements.limits) || null
      };
    }
    writeStatus();
    return tierNow();
  }
  async function canCapNow(cap) {
    if (canCap(cap)) return true;
    await refreshTier({ minIntervalMs: tierDenyThrottleMs });
    return canCap(cap);
  }
  function bumpUsage() {
    const m = monthKey();
    const used = membership.usage.month === m ? Number(membership.usage.count || 0) : 0;
    membership.usage = { month: m, count: used + 1 };
    writeStatus();
  }
  function upgradeText(reason) {
    const freeLimit = Number((limitsFor("free", limitTable) || {}).messages_per_month || 20);
    const used = usageThisMonth();
    const rows = [
      reason === "quota" ? `📵 本月免费指令已用完（${used}/${freeLimit}，下月 1 号自动恢复）。` : "🔒 继续在钉钉里派活/追问是会员功能。",
      "",
      "免费可以用：接收任务通知" + (reason === "quota" ? "" : `；每月 ${freeLimit} 条指令（本月已用 ${used}/${freeLimit}）`),
      "升级 Pro：指令不限量、可开新任务、可切换会话"
    ];
    const appUrl = String(options.appUrl || "").trim();
    if (appUrl) rows.push(`👉 ${appUrl.replace(/\/+$/, "")}/promo`);
    return rows.join("\n");
  }
  async function membershipGate(info) {
    if (!canCap("assign.continue")) {
      if (await canCapNow("assign.continue")) return null;
      reply(info, upgradeText("capability"));
      state.gated += 1;
      emitter.emit("inbound-gated", { ...info, reason: "capability", tier: tierNow() });
      return { reason: "capability" };
    }
    const limit = messageLimitNow();
    if (limit > 0 && usageThisMonth() >= limit) {
      await refreshTier({ minIntervalMs: tierDenyThrottleMs });
      const limit2 = messageLimitNow();
      if (!(limit2 > 0 && usageThisMonth() >= limit2)) return null;
      reply(info, upgradeText("quota"));
      state.gated += 1;
      emitter.emit("inbound-gated", { ...info, reason: "quota", tier: tierNow(), limit: limit2 });
      return { reason: "quota" };
    }
    return null;
  }
  function bindingGatedNowSafe() { try { return bindingGatedNow(); } catch { return false; } }

  // ---------- 状态文件（契约） ----------

  function statusSection() {
    return {
      enabled: Boolean(clientId && clientSecret),
      state: state.phase,
      connected: state.connected === true,
      authenticated: state.authenticated === true,
      lastError: truncateText(maskSecrets(state.lastError, [clientSecret]), 160),
      lastConnectedAt: Number(state.lastConnectedAt) || 0,
      lastMessageAt: Number(state.lastMessageAt) || 0,
      boundChatId: state.boundChatId || "",
      // 钉钉独有（排障用；**绝不含 ticket/token**，只留过期时间戳）
      subscriptions: subscriptions.map((s) => String(s.topic || "")).filter(Boolean),
      ticketExpiresAt: Number(state.ticketExpiresAt) || 0,
      connectedAt: Number(state.lastConnectedAt) || 0,
      openCount: Number(state.openCount) || 0,
      reconnectAttempts: Number(state.reconnectAttempts) || 0,
      // 凭据来源 + 能力降级（robotCode 可选：缺省时只降级 openapi/卡片）
      credentialSource,
      robotCodeConfigured: Boolean(robotCode),
      capabilities: capabilitiesNow(),
      // 回复通道三层降级（面板显示「可用/需重新发一条消息激活」；不含 webhook 原值）
      replyChannel: replyChannelStatus(),
      // 会员 + 用量（与企微对齐）
      tier: tierNow(),
      caps: capsNow().slice(),
      capsCount: capsNow().length,
      bindingGated: bindingGatedNowSafe(),
      messagesPerMonth: messageLimitNow(),
      remainingMessages: messageLimitNow() ? Math.max(0, messageLimitNow() - usageThisMonth()) : null,
      usage: { month: membership.usage.month || monthKey(), messages: usageThisMonth() },
      // 会话绑定（与企微对齐；本轮不提供 sessions[] 列表）
      boundSessionId: boundSessionId || "",
      activeSessionId: lastSeenSessionId || ""
    };
  }
  function writeStatus() {
    if (!statusFile) return;
    try {
      const prev = readJsonFile(statusFile);
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      atomicWriteJson(statusFile, {
        ...base,
        version: 1,
        updatedAt: Number(now()) || Date.now(),
        dingtalk: { ...(base.dingtalk && typeof base.dingtalk === "object" ? base.dingtalk : {}), ...statusSection() }
      }, { onWarn: (m) => log.warn(m) });
    } catch (e) {
      log.warn(`状态文件写入失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  // ---------- 连接 / 重连 ----------

  function setPhase(phase, error) {
    state.phase = phase;
    if (error !== undefined) state.lastError = String(error || "");
    writeStatus();
  }
  function clearReconnect() {
    if (reconnectTimer) { try { clearTimeout(reconnectTimer); } catch { /* 忽略 */ } }
    reconnectTimer = null;
    state.nextRetryInMs = 0;
  }
  function dropSocket() {
    const sock = ws;
    ws = null;
    if (!sock) return;
    try {
      sock.removeAllListeners();
      sock.on("error", () => { /* 关闭途中的错误不冒泡 */ });
      if (typeof sock.terminate === "function" && sock.readyState === 1) sock.terminate();
      else if (typeof sock.close === "function") sock.close();
    } catch { /* 忽略 */ }
  }
  function scheduleReconnect(reason) {
    if (stopped) return;
    if (reconnectTimer) return;
    const attempt = state.reconnectAttempts;
    const base = Math.min(reconnectMaxMs, Math.round(reconnectBaseMs * Math.pow(2, attempt)));
    const jitter = Math.floor(Math.random() * Math.min(1000, base));
    const delay = Math.min(reconnectMaxMs, base + jitter);
    state.reconnectAttempts = attempt + 1;
    state.nextRetryInMs = delay;
    setPhase("reconnecting", state.lastError || `连接断开：${truncateText(reason, 80)}`);
    log.warn(`连接断开（${reason}），${delay}ms 后重新换 ticket 重连（第 ${state.reconnectAttempts} 次）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      state.nextRetryInMs = 0;
      void connect().catch(() => {});
    }, delay);
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  /** ① 换 ticket（每次重连都必须重新 open；ticket 一次性 + 90s）。 */
  async function openConnection() {
    state.openCount += 1;
    const body = buildOpenBody({ clientId, clientSecret, subscriptions, ua, localIp: options.localIp });
    let res = null;
    try {
      if (typeof doFetch !== "function") throw new Error("no fetch");
      res = await doFetch(gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(openTimeoutMs) : undefined
      });
    } catch (e) {
      return { ok: false, network: true, error: `连接网关不可达：${truncateText(e && e.message ? e.message : e, 100)}` };
    }
    const httpStatus = Number(res && res.status) || 0;
    let json = null;
    try { json = res && typeof res.json === "function" ? await res.json() : null; } catch { json = null; }
    if (res && res.ok === false) {
      const credErr = httpStatus >= 400 && httpStatus < 500;
      const msg = (json && (json.message || json.errmsg)) || "";
      return {
        ok: false,
        httpStatus,
        credential: credErr,
        error: `建连网关拒绝（HTTP ${httpStatus}）${msg ? `：${truncateText(msg, 80)}` : ""}`
      };
    }
    const endpoint = String((json && json.endpoint) || "").trim();
    const ticket = String((json && json.ticket) || "").trim();
    if (!endpoint || !ticket) {
      return { ok: false, protocol: true, error: "建连网关响应缺少 endpoint/ticket" };
    }
    state.ticketExpiresAt = now() + TICKET_TTL_MS;
    return { ok: true, endpoint, ticket };
  }

  /** ② 用 ticket 建 WebSocket（ticket 校验即鉴权；WS 上不再有应用层认证帧）。 */
  async function connect() {
    if (stopped || connecting) return;
    connecting = true;
    clearReconnect();
    try {
      setPhase(state.lastConnectedAt ? "reconnecting" : "connecting");
      const opened = await openConnection();
      if (stopped) return;
      if (!opened.ok) {
        if (opened.credential) {
          // 凭据错（4xx）→ **不重连**，状态给人话（用户需要去改 clientId/clientSecret）
          state.connected = false;
          state.authenticated = false;
          setPhase("failed", `${opened.error}；请检查 Client ID / Client Secret（或应用是否已开通 Stream 模式）`);
          log.warn(state.lastError);
          emitter.emit("auth-failed", { httpStatus: opened.httpStatus || 0, message: opened.error, at: now() });
          return;
        }
        scheduleReconnect(opened.error || "open 失败");
        return;
      }
      const sep = opened.endpoint.includes("?") ? "&" : "?";
      const url = `${opened.endpoint}${sep}ticket=${encodeURIComponent(opened.ticket)}`;
      let sock;
      try {
        sock = wsFactory(url);
      } catch (e) {
        scheduleReconnect(`ws 建立失败：${truncateText(e && e.message ? e.message : e, 80)}`);
        return;
      }
      ws = sock;
      try {
        sock.on("open", () => onSocketOpen());
        sock.on("message", (raw) => onSocketMessage(raw));
        sock.on("error", (e) => log.warn(`WebSocket 异常：${truncateText(e && e.message ? e.message : e, 120)}`));
        sock.on("close", (code, reason) => onSocketClose(code, reason));
      } catch (e) {
        log.warn(`挂监听失败：${truncateText(e && e.message ? e.message : e, 120)}`);
      }
    } finally {
      connecting = false;
    }
  }

  function onSocketOpen() {
    if (stopped) return;
    state.connected = true;
    state.authenticated = true; // ticket 校验即鉴权（WS 上无认证帧）
    state.lastConnectedAt = now();
    state.reconnectAttempts = 0;
    setPhase("connected", "");
    log.info("已连上钉钉 Stream 网关（ticket 鉴权完成）");
    emitter.emit("connected", { at: now() });
    // 会员档位：连上后刷一次（不阻塞收帧）
    void refreshTier({ force: true }).catch(() => {});
    if (!tierTimer && capsProvider) {
      tierTimer = setInterval(() => { void refreshTier().catch(() => {}); }, 10 * 60 * 1000);
      if (typeof tierTimer.unref === "function") tierTimer.unref();
    }
  }

  function onSocketClose(code, reason) {
    if (stopped) return;
    const why = `close ${code === undefined ? "?" : code}${reason ? ` ${truncateText(String(reason), 60)}` : ""}`;
    state.connected = false;
    state.authenticated = false;
    scheduleReconnect(why);
  }

  // ---------- 帧处理（每帧都要 ACK，除 disconnect） ----------

  function rawSend(obj) {
    const sock = ws;
    if (!sock || sock.readyState !== 1) return false;
    try { sock.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function onSocketMessage(raw) {
    const frame = parseFrame(raw);
    if (!frame) { log.warn("收到无法解析的帧（已忽略）"); return; }
    const messageId = String((frame.headers && frame.headers.messageId) || "");
    const topic = String((frame.headers && frame.headers.topic) || "");
    if (frame.type === "SYSTEM") return onSystemFrame({ messageId, topic, data: frame.data });
    if (frame.type === "EVENT") {
      rawSend(buildAck(messageId, EVENT_ACK));
      emitter.emit("event", { topic, data: frame.data, at: now() });
      log.debug(`EVENT topic=${truncateText(topic || "?", 40)}`);
      return;
    }
    if (frame.type === "CALLBACK") return onCallbackFrame({ messageId, topic, data: frame.data });
    log.debug(`未处理的帧 type=${truncateText(frame.type || "?", 20)}`);
  }

  function onSystemFrame({ messageId, topic, data }) {
    const t = String(topic || "").toLowerCase();
    if (t === "ping") {
      // ⚠️ 官方：data.opaque 原样回传，messageId 必须一致
      const opaque = data && typeof data === "object" ? data.opaque : data;
      rawSend(buildPingAck(messageId, opaque));
      return;
    }
    if (t === "disconnect") {
      // 官方给 10s 宽限；我们主动换新连接（旧 socket 走 close → 由 scheduleReconnect 兜住）。
      log.warn("收到 SYSTEM disconnect，主动换新 ticket 重连");
      dropSocket();
      state.connected = false;
      state.authenticated = false;
      scheduleReconnect("system disconnect");
      return;
    }
    // CONNECTED/REGISTERED/KEEPALIVE/未知：官方协议文档没写，只记 debug、不崩、不重连
    log.debug(`忽略 SYSTEM topic=${truncateText(topic || "?", 40)}`);
  }

  function onCallbackFrame({ messageId, topic, data }) {
    if (topic === TOPIC_ROBOT) {
      // 机器人消息：先 ACK（fire-and-forget；钉钉不重推），再异步处理
      rawSend(buildAck(messageId, BOT_CALLBACK_ACK));
      void handleBotMessage(data).catch((e) => log.warn(`处理机器人消息失败（已忽略）：${truncateText(e && e.message ? e.message : e, 120)}`));
      return;
    }
    if (topic === TOPIC_CARD_CALLBACK) {
      // 卡片按钮：本轮卡片拍板后置；仍要 ACK（2s 时限），ACK data 先给空响应（UNVERIFIED，真机核验后替换为卡片更新数据）
      rawSend(buildAck(messageId, BOT_CALLBACK_ACK));
      log.info("收到卡片按钮回调（卡片拍板本轮后置，已 ACK）");
      emitter.emit("card-action", { data, at: now() });
      return;
    }
    // 未知 CALLBACK topic：也要 ACK（否则可能被重推），内容给空响应
    rawSend(buildAck(messageId, BOT_CALLBACK_ACK));
    log.debug(`未处理的 CALLBACK topic=${truncateText(topic || "?", 40)}`);
  }

  // ---------- 入站机器人消息 ----------

  function pruneSeen() {
    const at = now();
    for (const [k, t] of seenMsgs) {
      if (at - t > 10 * 60 * 1000) seenMsgs.delete(k);
      else break;
    }
    while (seenMsgs.size > SEEN_MSG_MAX) {
      const first = seenMsgs.keys().next();
      if (first.done) break;
      seenMsgs.delete(first.value);
    }
  }

  /** 写回复通道缓存到磁盘（0600；含会话令牌，绝不进状态/日志）。 */
  function persistReplyChannel() {
    if (!relayDir) return;
    try {
      atomicWriteJson(path.join(relayDir, REPLY_FILE), {
        version: 1,
        sessionWebhook: state.boundSessionWebhook || "",
        sessionWebhookExpiredTime: Number(state.boundSessionWebhookExpiredAt) || 0,
        senderStaffId: state.boundUserId || "",
        conversationId: state.boundConversationId || "",
        boundChatId: state.boundChatId || "",
        at: now()
      }, { onWarn: (m) => log.warn(m) });
    } catch (e) {
      log.warn(`回复通道缓存写入失败（忽略）：${truncateText(e && e.message ? e.message : e, 100)}`);
    }
  }

  /** 日志/状态里只用 webhook 的 host（整条 URL 含会话令牌，绝不外泄）。 */
  function webhookHost(url) {
    try { return new URL(String(url)).host; } catch { return chatIdHash(String(url)) || "?"; }
  }

  /** 更新「回复目标」：缓存 sessionWebhook（被动回复）+ senderStaffId/conversationId（openapi 降级用）。 */
  function bindTarget(info) {
    if (info.conversationId) state.boundConversationId = info.conversationId;
    if (info.senderStaffId) state.boundUserId = info.senderStaffId;
    if (info.chatId && info.chatId !== state.boundChatId) {
      state.boundChatId = info.chatId;
      log.info(`已绑定推送会话 chat=${chatIdHash(info.chatId)}${info.isGroup ? "（群）" : "（单聊）"}`);
    }
    if (info.sessionWebhook) {
      const changed = info.sessionWebhook !== state.boundSessionWebhook;
      state.boundSessionWebhook = info.sessionWebhook;
      state.boundSessionWebhookExpiredAt = info.sessionWebhookExpiredTime || 0;
      state.replyChannelError = "";
      if (changed) log.info(`已缓存回复通道 sessionWebhook（host=${webhookHost(info.sessionWebhook)}，过期=${state.boundSessionWebhookExpiredAt ? new Date(state.boundSessionWebhookExpiredAt).toISOString() : "未知"}）`);
    }
    persistReplyChannel();
    writeStatus();
  }

  async function handleBotMessage(data) {
    const info = normalizeBotMessage(data);
    state.lastMessageAt = now();
    if (info.msgId) {
      pruneSeen();
      if (seenMsgs.has(info.msgId)) { log.debug("重复消息已忽略（msgId 命中）"); return; }
      seenMsgs.set(info.msgId, now());
    }
    state.messages += 1;
    // 安全：allowFrom 白名单（senderStaffId / conversationId；空 = 首次发送者自动绑定）
    if (allowFrom.length && !allowFrom.includes(info.senderStaffId) && !allowFrom.includes(info.conversationId)) {
      log.warn(`拒绝非白名单发送者（from=${chatIdHash(info.senderStaffId) || "?"} chat=${chatIdHash(info.conversationId) || "?"})`);
      reply(info, "你暂时没有这台电脑的远程通道权限。请让电脑那边把你的钉钉 userId 加进白名单。");
      emitter.emit("inbound-rejected", info);
      return;
    }
    bindTarget(info);
    writeStatus();
    if (!info.text) {
      log.info(`收到非文本消息（msgtype=${truncateText(info.msgtype || "?", 20)}），未转发`);
      reply(info, "目前只支持文本消息（图片/文件/语音暂不转发）。");
      emitter.emit("inbound-ignored", info);
      return;
    }
    emitter.emit("message", info);
    void dispatchInbound(info).catch((e) => log.warn(`入站转发失败（已忽略）：${truncateText(e && e.message ? e.message : e, 120)}`));
  }

  /** 命令层：命中已回复返回 true（不转模型、不计额度；回复走三层回复通道）。 */
  async function handleCommand(info) {
    const text = String((info && info.text) || "");
    if (!/^\s*\//.test(text)) return false;
    const cmd = await executeImCommand({
      text,
      ctx: {
        caps: capsNow(),
        tier: tierNow(),
        appUrl: String(options.appUrl || ""),
        channelLabel: "钉钉",
        sessions: async () => {
          const sub = subscriber;
          if (!sub) return [];
          let rows = [];
          try {
            if (typeof sub.listSessions === "function") {
              const r = await sub.listSessions();
              rows = Array.isArray(r) ? r : (r && r.ok && Array.isArray(r.sessions) ? r.sessions : []);
            }
          } catch { rows = []; }
          if ((!Array.isArray(rows) || rows.length === 0) && typeof sub.sessions === "function") {
            try { rows = (sub.sessions() || []).map((id) => ({ sessionId: String(id) })); } catch { rows = []; }
          }
          return (Array.isArray(rows) ? rows : []).map((x) => ({
            sessionId: String(x.sessionId || x.id || ""),
            title: String(x.title || ""),
            updatedAt: Number(x.updatedAt) || 0,
            running: x.running === true
          })).filter((x) => x.sessionId);
        },
        currentSessionId: () => {
          const known = boundSessionId || lastSeenSessionId || "";
          if (known) return known;
          if (configuredSessionId && canCap("sessions")) return configuredSessionId;
          const sub = subscriber;
          try {
            if (sub && typeof sub.sessions === "function") {
              const ids = sub.sessions();
              if (Array.isArray(ids) && ids.length) return String(ids[0]);
            }
          } catch { /* 忽略 */ }
          return "";
        },
        currentSessionTitle: () => "",
        cancelSession: async ({ sessionId }) => {
          const sub = subscriber;
          if (!sub || typeof sub.cancelSession !== "function") return { ok: false, message: "订阅器未就绪" };
          try {
            const r = await sub.cancelSession({ sessionId });
            return r && typeof r === "object" ? r : { ok: Boolean(r) };
          } catch (e) { return { ok: false, message: e && e.message ? e.message : String(e) }; }
        },
        switchSession: async ({ sessionId, title }) => {
          const r = writeImBotsSession(relayDir, "dingtalk", { sessionId, sessionTitle: title });
          if (r.ok) {
            configuredSessionId = sessionId;
            configuredSessionTitle = truncateText(title || "", 60);
            boundSessionId = sessionId;
            writeStatus();
          }
          return r;
        },
        unbind: async () => { clearReplyChannel(); return { ok: true }; },
        statusSnapshot: async () => ({
          connected: state.connected === true,
          authenticated: state.authenticated === true,
          state: state.phase,
          lastError: state.lastError || "",
          tier: tierNow(),
          usage: { month: monthKey(), messages: usageThisMonth() },
          messagesPerMonth: messageLimitNow(),
          remainingMessages: messageLimitNow() ? Math.max(0, messageLimitNow() - usageThisMonth()) : null,
          currentSessionId: boundSessionId || lastSeenSessionId || "",
          currentSessionTitle: ""
        })
      }
    });
    if (!cmd || !cmd.handled) return false;
    reply(info, cmd.text);
    emitter.emit("command", { ...info, command: cmd.command, ok: cmd.ok === true, gated: cmd.gated === true });
    log.info(`命令 ${cmd.command}${cmd.gated ? "（会员闸拦截）" : ""} 已回复（不转模型）`);
    return true;
  }

  /** 入站 → 命令层 → 会员闸 → 转发到 DSH 会话（尽力、可降级）。 */
  async function dispatchInbound(info) {
    const sub = subscriber;
    if (await handleCommand(info)) return;
    const gated = await membershipGate(info);
    if (gated) return;
    const sessionId = await resolveSessionId(sub);
    if (!sub || typeof sub.promptSession !== "function") {
      log.warn("入站消息无法转发：事件订阅器未就绪");
      reply(info, "已收到你的消息，但后台还没连上 DeepSeek Harness 的事件通道，暂时转不过去。请确认电脑端 dsh web 正在运行。");
      emitter.emit("inbound-failed", { ...info, reason: "no_subscriber" });
      return;
    }
    if (!sessionId) {
      log.warn("入站消息无法转发：还没有可接管的会话");
      reply(info, "已收到，但还没在桌面端选择要接管的会话。请先在电脑的 DeepSeek Harness 里打开一个会话，再发一次。");
      emitter.emit("inbound-failed", { ...info, reason: "no_session" });
      return;
    }
    let result;
    try { result = await sub.promptSession({ sessionId, text: info.text }); } catch (e) {
      result = { ok: false, message: e && e.message ? e.message : String(e) };
    }
    if (result && result.ok) {
      lastInbound = { sessionId, at: now() };
      bumpUsage();
      if (boundSessionId !== sessionId) { boundSessionId = sessionId; writeStatus(); }
      log.info(`入站文本已转给会话 session=${shortSession(sessionId)}`);
      reply(info, `已转给桌面端会话 ✓（${shortSession(sessionId)}）`);
      emitter.emit("inbound-routed", { ...info, sessionId });
      return;
    }
    const why = truncateText((result && (result.code || result.message)) || "未知错误", 80);
    log.warn(`入站文本转发失败：${why}`);
    reply(info, `转发失败：${why}。请到电脑上确认会话还在运行。`);
    emitter.emit("inbound-failed", { ...info, sessionId, reason: why });
  }

  async function resolveSessionId(sub) {
    try {
      if (typeof options.sessionIdProvider === "function") {
        const got = String(options.sessionIdProvider() || "");
        if (got) return got;
      }
    } catch { /* 忽略 */ }
    // 配置固定会话是会员能力（sessions）；免费档忽略并回退「跟随活跃会话」
    if (configuredSessionId && canCap("sessions")) return configuredSessionId;
    if (lastSeenSessionId) return lastSeenSessionId;
    if (!sub || typeof sub.listSessions !== "function") return "";
    try {
      const r = await sub.listSessions();
      const list = r && r.ok && Array.isArray(r.sessions) ? r.sessions : [];
      const pick = list.find((s) => s && s.running) || list[0];
      return pick && typeof pick.sessionId === "string" ? pick.sessionId : "";
    } catch { return ""; }
  }

  // ---------- 回复（Stream 内不能回；默认 sessionWebhook，可选 openapi） ----------

  /** 即时回复当前会话（sessionWebhook；不需要 token/权限）。 */
  async function replySessionWebhook(webhookUrl, { title, text } = {}) {
    const url = String(webhookUrl || "").trim();
    if (!url) return { ok: false, reason: "no_webhook" };
    if (typeof doFetch !== "function") return { ok: false, reason: "no_fetch" };
    const formatted = formatForChannel(formatChannel, { title, text: text == null ? "" : String(text) });
    const body = buildSessionWebhookBody({ title: title || "DeepSeek Harness", text: formatted });
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const status = Number(res && res.status) || 0;
      let json = null; try { json = res && typeof res.json === "function" ? await res.json() : null; } catch { json = null; }
      if (!res || res.ok === false) {
        return { ok: false, status, reason: `sessionWebhook HTTP ${status}`, errcode: (json && json.errcode) || 0 };
      }
      return { ok: true, status };
    } catch (e) {
      return { ok: false, reason: truncateText(e && e.message ? e.message : e, 100) };
    }
  }

  /** accessToken（仅 openapi 模式；内存缓存，提前 5 分钟过期）。 */
  async function getAccessToken() {
    const at = now();
    if (pendingToken.value && at < pendingToken.expiresAt) return pendingToken.value;
    if (typeof doFetch !== "function") return "";
    try {
      const res = await doFetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: clientId, appSecret: clientSecret })
      });
      const json = res && typeof res.json === "function" ? await res.json() : null;
      const token = String((json && (json.accessToken || json.access_token)) || "");
      const expireIn = Number((json && (json.expireIn || json.expires_in)) || 7200);
      if (!res || res.ok === false || !token) return "";
      pendingToken.value = token;
      pendingToken.expiresAt = at + Math.max(60, expireIn - 300) * 1000;
      return token;
    } catch { return ""; }
  }

  /** 主动发消息（openapi 模式；标 UNVERIFIED：msgKey/msgParam 形状来自官方文档，未经真机核验）。 */
  async function sendOpenapi(text, { title } = {}) {
    // ★ robotCode 可选：缺省时明确拒绝（不崩、不白打 token 请求），并说清"哪些能力不可用/怎么恢复"
    if (!robotCode) {
      return {
        ok: false,
        reason: "no_robot_code",
        detail: "未配置 robotCode：openapi 主动发送与卡片拍板不可用（接收消息、sessionWebhook 回复不受影响）。"
          + "请在插件「钉钉机器人」里补 robotCode，或改用 sessionWebhook 接收回复。",
        capabilities: capabilitiesNow()
      };
    }
    if (!state.authenticated) return { ok: false, reason: "not_connected", capabilities: capabilitiesNow() };
    const token = await getAccessToken();
    if (!token) return { ok: false, reason: "no_access_token", capabilities: capabilitiesNow() };
    const formatted = formatForChannel(formatChannel, { title, text: text == null ? "" : String(text) });
    const msgParam = JSON.stringify({ title: truncateText(title || "DeepSeek Harness", 64), text: formatted });
    const isGroup = state.boundConversationId && state.boundChatId === state.boundConversationId;
    const useRobot = robotCode;
    const url = isGroup ? groupSendUrl : o2oSendUrl;
    const body = isGroup
      ? { robotCode: useRobot, openConversationId: state.boundConversationId, msgKey: "sampleMarkdown", msgParam }
      : { robotCode: useRobot, userIds: [state.boundUserId].filter(Boolean), msgKey: "sampleMarkdown", msgParam };
    if (!isGroup && !body.userIds.length) return { ok: false, reason: "no_target_user" };
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
        body: JSON.stringify(body)
      });
      if (!res || res.ok === false) {
        let json = null; try { json = res && typeof res.json === "function" ? await res.json() : null; } catch { json = null; }
        return { ok: false, status: Number(res && res.status) || 0, reason: truncateText((json && (json.message || json.code)) || "openapi 发送失败", 80) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: truncateText(e && e.message ? e.message : e, 100) };
    }
  }

  /**
   * 当前可用的回复通道（**三层降级**）：
   *   ① 缓存 sessionWebhook（未过期；被动回复，最快、不需要 token）
   *   ② openapi（robotCode + senderStaffId/conversationId 都有）
   *   ③ none（明确原因，面板提示"再发一条消息激活"）
   */
  function replyChannelNow() {
    const expiresAt = Number(state.boundSessionWebhookExpiredAt) || 0;
    const webhookUsable = Boolean(state.boundSessionWebhook) && (!expiresAt || now() < expiresAt);
    if (webhookUsable) return { kind: "sessionWebhook", webhook: state.boundSessionWebhook, expiresAt, reason: "" };
    if (robotCode && (state.boundUserId || state.boundConversationId)) {
      return {
        kind: "openapi",
        webhook: "",
        expiresAt: 0,
        reason: state.boundSessionWebhook ? "sessionWebhook_expired" : "no_webhook"
      };
    }
    return {
      kind: "none",
      webhook: "",
      expiresAt,
      reason: state.boundSessionWebhook ? "sessionWebhook_expired" : (robotCode ? "no_target_user" : "no_robot_code"),
      lastError: NO_REPLY_CHANNEL_HINT
    };
  }

  /** 状态文件里的 replyChannel 元数据（**绝不含 webhook 原值**）。 */
  function replyChannelStatus() {
    const ch = replyChannelNow();
    return {
      kind: ch.kind,
      expiresAt: Number(ch.expiresAt) || 0,
      lastError: truncateText(maskSecrets(state.replyChannelError || "", [clientSecret]), 160),
      hasWebhook: Boolean(state.boundSessionWebhook)
    };
  }

  function markReplyChannelError(detail) {
    state.replyChannelError = truncateText(String(detail || ""), 160);
    writeStatus();
  }

  /**
   * 统一回复入口（回答回传/通知/命令回复都走这里）。
   * ① 缓存 sessionWebhook → ② 失败/过期降级 openapi → ③ 都不可用：**明确日志 + 状态人话，绝不静默**。
   */
  async function sendViaReplyChannel(text, opts = {}) {
    const title = opts.title || "";
    const preferredWebhook = String(opts.webhook || "").trim();
    const channel = replyChannelNow();
    const webhook = preferredWebhook || (channel.kind === "sessionWebhook" ? channel.webhook : "");
    if (webhook) {
      const r = await replySessionWebhook(webhook, { title, text });
      if (r.ok) {
        if (state.replyChannelError) { state.replyChannelError = ""; writeStatus(); }
        return { ...r, kind: "sessionWebhook" };
      }
      // JSDoc: 只记 host + 错误原因（整条 URL 带会话令牌，绝不外泄）
      log.warn(`sessionWebhook 回复失败（host=${webhookHost(webhook)}，${truncateText(r.reason, 60)}）→ 尝试 OpenAPI 兜底`);
      markReplyChannelError(`sessionWebhook 回复失败：${truncateText(r.reason, 80)}；${NO_REPLY_CHANNEL_HINT}`);
    }
    if (robotCode && (state.boundUserId || state.boundConversationId)) {
      const fb = await sendOpenapi(text, { title });
      if (fb.ok) return { ...fb, kind: "openapi" };
      log.warn(`OpenAPI 兜底也失败：${truncateText(fb.reason, 80)}`);
      markReplyChannelError(`OpenAPI 回复失败：${truncateText(fb.reason, 80)}；${NO_REPLY_CHANNEL_HINT}`);
      return { ok: false, kind: "none", reason: "no_reply_channel", detail: fb.reason || "" };
    }
    // 缺 robotCode：给更具体的可操作错误（与能力降级口径一致，不是笼统的"没通道"）
    if (!robotCode) {
      const detail = "未配置 robotCode：openapi 主动发送不可用（接收消息与 sessionWebhook 回复不受影响）。"
        + "请在插件「钉钉机器人」里补 robotCode。";
      log.warn(`no_robot_code：${detail}`);
      markReplyChannelError(`no_robot_code：${detail}`);
      return { ok: false, kind: "none", reason: "no_robot_code", detail, capabilities: capabilitiesNow() };
    }
    const at = now();
    if (at - lastNoTargetLogAt > 60_000) {
      lastNoTargetLogAt = at;
      log.warn(`no_reply_channel：${NO_REPLY_CHANNEL_HINT}（detail=${truncateText(channel.reason, 40)}，webhook=${state.boundSessionWebhook ? "expired" : "none"}，robotCode=${robotCode ? "有" : "无"}，userId=${state.boundUserId ? "有" : "无"}）`);
    }
    markReplyChannelError(`no_reply_channel：${NO_REPLY_CHANNEL_HINT}`);
    return { ok: false, kind: "none", reason: "no_reply_channel", detail: NO_REPLY_CHANNEL_HINT };
  }

  /** 兼容旧入口：通知/回答回传/命令回复统一走三层回复通道。 */
  async function sendMarkdown(text, opts = {}) {
    return sendViaReplyChannel(text, opts);
  }

  /** 回复一句人话：优先本次入站的 webhook，再走三层降级；失败不抛。 */
  function reply(info, text) {
    const webhook = info && info.sessionWebhook ? info.sessionWebhook : "";
    void sendViaReplyChannel(text, { webhook }).catch(() => {});
  }

  /** 解绑推送（/unbind 命令用）：清内存 + 删持久化回复通道 + 清状态绑定字段。 */
  function clearReplyChannel() {
    state.boundSessionWebhook = "";
    state.boundSessionWebhookExpiredAt = 0;
    state.boundUserId = "";
    state.boundConversationId = "";
    state.boundChatId = "";
    state.replyChannelError = "";
    if (relayDir) {
      try { fs.rmSync(path.join(relayDir, REPLY_FILE), { force: true }); } catch { /* 忽略 */ }
    }
    writeStatus();
  }

  // ---------- DSH 事件订阅（通知 + 回答回传 + 活跃会话） ----------

  function ensureSubscriber() {
    if (subscriber) { wireSubscriber(); return; }
    if (options.subscriber) { subscriber = options.subscriber; ownsSubscriber = false; }
    else if (typeof options.createSubscriber === "function") { subscriber = options.createSubscriber(); ownsSubscriber = true; }
    else if (options.upstream !== undefined) {
      try {
        subscriber = createEventSubscriber({
          upstream: typeof options.upstream === "function" ? options.upstream : String(options.upstream || ""),
          cookie: typeof options.cookie === "function" ? options.cookie : (options.cookie || ""),
          follow: true,
          log: (level, message) => { if (level === "warn" || level === "error") log.warn(`[events] ${message}`); else log.debug(`[events] ${message}`); }
        });
        ownsSubscriber = true;
      } catch (e) {
        log.warn(`事件订阅器创建失败：${truncateText(e && e.message ? e.message : e, 120)}`);
        subscriber = null;
      }
    }
    wireSubscriber();
    if (subscriber && typeof subscriber.start === "function") {
      try { subscriber.start(); } catch (e) { log.warn(`事件订阅器启动失败：${truncateText(e && e.message ? e.message : e, 120)}`); }
    }
  }
  function wireSubscriber() {
    const sub = subscriber;
    if (!sub || wired) return;
    wired = true;
    try {
      sub.on("event", (node) => onEventNode(node));
      sub.on("session-state", (info) => {
        if (info && typeof info.sessionId === "string" && info.state === "running") lastSeenSessionId = info.sessionId;
      });
      sub.on("control-activity", (info) => {
        if (info && typeof info.sessionId === "string" && info.sessionId) lastSeenSessionId = info.sessionId;
      });
      sub.on("gap", (info) => log.warn(`事件订阅断线窗口（通知不可补发）：${new Date((info && info.from) || Date.now()).toISOString()}`));
      sub.on("auth-error", (info) => log.warn(`事件订阅鉴权失败（${(info && info.surface) || "?"}）`));
      sub.on("fault", (info) => {
        const expected = info && info.expected === true;
        const msg = `事件订阅异常 code=${(info && info.code) || "?"}`;
        if (expected) log.debug(msg); else log.warn(`${msg}：${truncateText(info && info.message, 80)}`);
      });
    } catch (e) {
      log.warn(`挂事件处理器失败：${truncateText(e && e.message ? e.message : e, 120)}`);
    }
  }

  function onEventNode(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.sessionId === "string" && node.sessionId) lastSeenSessionId = node.sessionId;
    if (stopped || !notifyAllowed || !state.authenticated) return;
    // 回答回传：入站后的同一会话 turn/end → 把 agent 最终回答发回钉钉（与企微同语义）
    if (shouldRelayAnswer(node)) {
      const key = notifyKey(node);
      if (key && !rememberNotifyKey(key)) return;
      const sid = node.sessionId;
      lastInbound = { sessionId: "", at: 0 };
      void relayAnswer(node, sid);
      return;
    }
    const markdown = toMarkdownNotification(node, { sessionTitle: options.sessionTitle });
    if (!markdown) return;
    const key = notifyKey(node);
    if (key && !rememberNotifyKey(key)) return;
    if (!notifyRateOk()) { log.warn("通知超过每分钟上限，已丢弃（防止事件风暴刷屏）"); return; }
    void sendMarkdown(markdown).catch(() => {});
  }

  const notifiedKeys = new Map();
  const notifyTimes = [];
  function notifyKey(node) {
    const sid = String(node.sessionId || "");
    if (node.kind === NODE_KINDS.TURN_END) return `turn:${sid}:${node.turn ?? "?"}:${node.seq ?? "?"}:${node.reason || "?"}`;
    if (node.kind === NODE_KINDS.APPROVAL_REQUEST || node.kind === NODE_KINDS.USER_QUESTION || node.kind === NODE_KINDS.PLAN_REVIEW) return `approval:${node.eventId || ""}:${sid}`;
    if (node.kind === NODE_KINDS.SESSION_ERROR) return `error:${sid}:${node.code || node.message || ""}:${node.at || ""}`;
    return "";
  }
  function rememberNotifyKey(key) {
    const at = now();
    for (const [k, t] of notifiedKeys) { if (at - t > 10 * 60 * 1000) notifiedKeys.delete(k); else break; }
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.set(key, at);
    if (notifiedKeys.size > 200) { const first = notifiedKeys.keys().next(); if (!first.done) notifiedKeys.delete(first.value); }
    return true;
  }
  function notifyRateOk() {
    const at = now();
    while (notifyTimes.length && at - notifyTimes[0] > 60_000) notifyTimes.shift();
    if (notifyTimes.length >= 10) return false;
    notifyTimes.push(at);
    return true;
  }
  function shouldRelayAnswer(node) {
    if (node.kind !== NODE_KINDS.TURN_END) return false;
    if (node.fromSnapshot === true) return false;
    if (!lastInbound.sessionId || node.sessionId !== lastInbound.sessionId) return false;
    if (now() - lastInbound.at >= 10 * 60 * 1000) return false;
    if (Number.isFinite(node.at) && node.at > 0 && node.at < lastInbound.at - 5000) return false;
    return true;
  }
  async function relayAnswer(node, sessionId) {
    let text = "";
    const sub = subscriber;
    if (sub && typeof sub.lastAssistantText === "function") {
      try {
        const r = await sub.lastAssistantText({ sessionId });
        if (r && r.ok && typeof r.text === "string") text = r.text.trim();
      } catch { /* 忽略 */ }
    }
    const markdown = text || toMarkdownNotification(node, { sessionTitle: options.sessionTitle }) || "";
    if (!markdown) return;
    if (!notifyRateOk()) { log.warn("通知超过每分钟上限，已丢弃（防止事件风暴刷屏）"); return; }
    const r = await sendMarkdown(markdown);
    log.info(`回答回传 chat=${chatIdHash(state.boundChatId) || "?"} len=${markdown.length}${r && r.ok ? "" : ` 发送失败=${(r && r.reason) || "?"}`}`);
  }

  // ---------- 对外 API ----------

  function shortSession(sessionId) {
    const s = String(sessionId || "").replace(/^session-/, "");
    if (!s) return "";
    return s.length <= 12 ? s : s.slice(0, 8) + "…";
  }
  function status() {
    return {
      enabled: Boolean(clientId && clientSecret),
      running: state.running === true,
      state: state.phase,
      connected: state.connected === true,
      authenticated: state.authenticated === true,
      lastError: truncateText(maskSecrets(state.lastError, [clientSecret]), 160),
      lastConnectedAt: Number(state.lastConnectedAt) || 0,
      lastMessageAt: Number(state.lastMessageAt) || 0,
      boundChatId: state.boundChatId || "",
      boundConversationId: state.boundConversationId || "",
      boundUserId: state.boundUserId || "",
      ticketExpiresAt: Number(state.ticketExpiresAt) || 0,
      openCount: Number(state.openCount) || 0,
      reconnectAttempts: Number(state.reconnectAttempts) || 0,
      nextRetryInMs: state.nextRetryInMs,
      // 凭据来源 + 能力降级（robotCode 可选：缺省时只降级 openapi/卡片）
      credentialSource,
      robotCodeConfigured: Boolean(robotCode),
      capabilities: capabilitiesNow(),
      // 回复通道三层降级（面板显示「可用/需重新发一条消息激活」；不含 webhook 原值）
      replyChannel: replyChannelStatus(),
      subscriptions: subscriptions.map((s) => String(s.topic || "")).filter(Boolean),
      messages: state.messages,
      gated: state.gated,
      tier: tierNow(),
      caps: capsNow().slice(),
      bindingGated: bindingGatedNowSafe(),
      messagesPerMonth: messageLimitNow(),
      usage: { month: membership.usage.month || monthKey(), messages: usageThisMonth() },
      sessions: [],
      activeSessionId: lastSeenSessionId || "",
      boundSessionId: boundSessionId || "",
      subscriber: subscriber && typeof subscriber.state === "string" ? subscriber.state : "none"
    };
  }

  return {
    start() {
      if (!stopped) return status();
      if (!clientId || !clientSecret) {
        state.lastError = "未配置 Client ID / Client Secret";
        state.phase = "failed";
        writeStatus();
        return status();
      }
      stopped = false;
      state.running = true;
      state.phase = "connecting";
      if (!robotCode) {
        log.info("未配置 robotCode：机器人仍可正常接收消息并用 sessionWebhook 回复；"
          + "openapi 主动发送/卡片拍板降级为不可用（状态 capabilities 会如实标记）");
      }
      writeStatus();
      ensureSubscriber();
      void connect().catch((e) => {
        log.warn(`连接失败：${truncateText(e && e.message ? e.message : e, 120)}`);
        scheduleReconnect("connect 异常");
      });
      return status();
    },
    async stop() {
      if (stopped) return status();
      stopped = true;
      state.running = false;
      state.connected = false;
      state.authenticated = false;
      state.phase = "idle";
      clearReconnect();
      if (tierTimer) { try { clearInterval(tierTimer); } catch { /* 忽略 */ } tierTimer = null; }
      if (ownsSubscriber && subscriber && typeof subscriber.close === "function") {
        try { subscriber.close(); } catch { /* 忽略 */ }
      }
      subscriber = null;
      wired = false;
      dropSocket();
      writeStatus();
      log.info("钉钉 Stream 长连接已停止");
      return status();
    },
    status,
    replySessionWebhook,
    sendMarkdown,
    sendViaReplyChannel,
    clearReplyChannel,
    getAccessToken,
    on(event, listener) { emitter.on(event, listener); return () => emitter.off(event, listener); },
    once(event, listener) { emitter.once(event, listener); return () => emitter.off(event, listener); },
    off(event, listener) { emitter.off(event, listener); },
    _logger: log
  };
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ===========================================================================
// 3. 控制器：配置读取 + 热更新（bridge 入口，与 wecom 同构）
// ===========================================================================

/**
 * 创建钉钉 Stream 通道控制器（bridge 侧入口）。
 *
 * 默认关闭：`im-bots.json` 的 `dingtalk.enabled !== true` 或缺 clientId/clientSecret → 不建连。
 * `fs.watchFile(2s)` 监听配置变化 → 变了才重建（与 wecom 同一个文件，两段互不影响）。
 * 环境开关：`DSH_IM_BOTS=0` 全关；`DSH_IM_BOT_NOTIFY=0` / `DSH_PUSH_REPORT=0` 只关出站通知。
 */
export function createDingtalkBotController(options = {}) {
  const relayDir = String(options.relayDir || "");
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const now = typeof options.clock === "function" ? options.clock : () => Date.now();
  const pollMs = positiveNumber(options.configPollMs, CONFIG_POLL_MS);
  const log = createScopedLogger({ sink: options.log, prefix: "[dingtalk]" });
  const configFile = path.join(relayDir, IM_BOTS_FILE);
  const statusFile = path.join(relayDir, IM_BOT_STATUS_FILE);
  const botFactory = typeof options.createBot === "function" ? options.createBot : createDingtalkBot;
  const state = { started: false, enabled: false, configFound: false, reason: "not_started", lastError: "" };
  let bot = null;
  let currentDigest = "";
  let listener = null;
  let reloading = false;

  function notifyAllowed() {
    if (String(env.DSH_IM_BOT_NOTIFY || "") === "0") return false;
    if (String(env.DSH_PUSH_REPORT || "") === "0") return false;
    return options.notify !== false;
  }
  function hardDisabled() { return String(env.DSH_IM_BOTS || "") === "0"; }
  function digestOf(cfg) {
    if (!cfg) return "missing";
    const secretHash = cfg.clientSecret ? crypto.createHash("sha1").update(String(cfg.clientSecret)).digest("hex") : "";
    return JSON.stringify([cfg.enabled, cfg.clientId || "", secretHash, cfg.robotCode || "", cfg.cardTemplateId || "", cfg.credentialSource || "", cfg.replyMode || "", cfg.sessionId || "", cfg.sessionTitle || "", cfg.allowFrom || [], notifyAllowed()]);
  }
  function writeDisabledStatus(reason) {
    if (!relayDir) return;
    try {
      const prev = readJsonFile(statusFile);
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      atomicWriteJson(statusFile, {
        ...base,
        version: 1,
        updatedAt: Number(now()) || Date.now(),
        dingtalk: {
          ...(base.dingtalk && typeof base.dingtalk === "object" ? base.dingtalk : {}),
          enabled: false, state: "idle", connected: false, authenticated: false,
          lastError: truncateText(reason, 160)
        }
      }, { onWarn: (m) => log.warn(m) });
    } catch (e) { log.warn(`状态文件写入失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`); }
  }
  async function stopBot() {
    const b = bot;
    bot = null;
    if (!b) return;
    try { await b.stop(); } catch (e) { log.warn(`停止钉钉连接失败（忽略）：${truncateText(e && e.message ? e.message : e, 120)}`); }
  }
  async function applyConfig() {
    if (reloading) return;
    reloading = true;
    try {
      if (hardDisabled()) { state.enabled = false; state.reason = "disabled_by_env"; await stopBot(); return; }
      const cfg = readDingtalkConfig(relayDir);
      state.configFound = cfg !== null;
      const digest = digestOf(cfg);
      if (digest === currentDigest) return;
      currentDigest = digest;
      await stopBot();
      if (!cfg) { state.enabled = false; state.reason = "no_config"; log.info("未找到 im-bots.json，钉钉通道不启动"); return; }
      if (!cfg.enabled) { state.enabled = false; state.reason = "disabled"; log.info("im-bots.json 里 dingtalk.enabled=false"); writeDisabledStatus("未启用（配置里 dingtalk.enabled=false）"); return; }
      if (!cfg.clientId || !cfg.clientSecret) {
        state.enabled = false; state.reason = "missing_credentials";
        log.warn("im-bots.json 里缺少 clientId/clientSecret，钉钉通道不启动");
        writeDisabledStatus("缺少 Client ID / Client Secret（请在插件「钉钉机器人」里填写）");
        return;
      }
      const botOptions = {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        robotCode: cfg.robotCode,
        cardTemplateId: cfg.cardTemplateId,
        credentialSource: cfg.credentialSource,
        replyMode: cfg.replyMode,
        gatewayUrl: cfg.streamUrl || undefined,
        relayDir,
        allowFrom: cfg.allowFrom,
        configuredSessionId: cfg.sessionId,
        configuredSessionTitle: cfg.sessionTitle,
        capsProvider: typeof options.capsProvider === "function" ? options.capsProvider : undefined,
        appUrl: options.appUrl,
        tier: options.tier,
        notify: notifyAllowed(),
        logger: options.log,
        clock: options.clock,
        ...(options.botOptions && typeof options.botOptions === "object" ? options.botOptions : {})
      };
      if (cfg.sessionWebhook) botOptions.sessionWebhook = cfg.sessionWebhook;
      bot = botFactory(botOptions);
      if (!bot || typeof bot.start !== "function") {
        state.enabled = false; state.reason = "bot_factory_invalid"; state.lastError = "bot 工厂返回无效对象"; return;
      }
      state.enabled = true;
      state.reason = "started";
      state.lastError = "";
      bot.start();
      log.info(`钉钉 Stream 通道已启动（replyMode=${cfg.replyMode}，通知=${notifyAllowed() ? "开" : "关"}）`);
    } catch (e) {
      state.enabled = false; state.reason = "apply_failed";
      state.lastError = truncateText(e && e.message ? e.message : e, 160);
      log.warn(`应用钉钉配置失败（忽略）：${state.lastError}`);
    } finally { reloading = false; }
  }
  function watchConfig() {
    if (listener) return;
    listener = () => { void applyConfig(); };
    try { fs.watchFile(configFile, { interval: pollMs }, listener); }
    catch (e) { log.warn(`监听 im-bots.json 失败：${truncateText(e && e.message ? e.message : e, 120)}`); listener = null; }
  }
  function unwatchConfig() {
    if (!listener) return;
    try { fs.unwatchFile(configFile, listener); } catch { /* 忽略 */ }
    listener = null;
  }
  function statusSnapshot() {
    const bs = bot && typeof bot.status === "function" ? bot.status() : null;
    return {
      started: state.started, enabled: state.enabled, configFound: state.configFound,
      reason: state.reason, configPath: configFile, statusPath: statusFile,
      lastError: state.lastError || (bs && bs.lastError) || "", bot: bs
    };
  }
  return {
    async start() {
      if (state.started) return statusSnapshot();
      state.started = true;
      if (hardDisabled()) { state.reason = "disabled_by_env"; log.info("钉钉通道已被 DSH_IM_BOTS=0 关闭"); return statusSnapshot(); }
      if (!relayDir) { state.reason = "no_relay_dir"; log.warn("缺少 relayDir，钉钉通道不启动"); return statusSnapshot(); }
      await applyConfig();
      watchConfig();
      return statusSnapshot();
    },
    async stop() {
      unwatchConfig();
      state.started = false; state.enabled = false; state.reason = "stopped";
      await stopBot();
      return statusSnapshot();
    },
    status: statusSnapshot,
    _bot() { return bot; }
  };
}

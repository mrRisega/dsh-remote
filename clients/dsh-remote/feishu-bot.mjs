/**
 * feishu-bot — 飞书「企业自建应用」长连接机器人通道（bridge 侧，2026-11-08 / task-27）。
 *
 * ## 为什么走长连接 + 为什么必须懒加载官方 SDK
 *
 * 飞书长连接是 **protobuf 帧（pbbp2.Frame）+ SDK 内部 HTTP bootstrap 握手**，官方只开放 SDK、
 * 没有公开原始协议（调研 `research/2026-11-strategy/06-multiagent/feishu-long-connection.md` §2.2/§2.10）。
 * 自写 = 逆向非公开协议 = 重演 ilink 老坑，所以**只用官方 SDK**。
 *
 * 但官方 `@larksuiteoapi/node-sdk` 体积大（1.6MB tgz / 41MB 解压 / 7 个传递依赖），业主明确要求
 * **不随包分发、配置前才按需下载**。于是本模块：
 *   · `package.json` **不声明**这个依赖；
 *   · 运行时从 `<relayDir>/im-deps/node_modules/@larksuiteoapi/node-sdk` **动态 import**（懒加载 + 缓存）；
 *   · 目录不存在 → 状态 `sdk_missing`，**不崩、不阻塞企微/微信/隧道**；面板据此显示「下载依赖」入口。
 *
 * ## 与企微契约对齐（复用优先）
 *
 * | 复用 | 来源 |
 * |---|---|
 * | `maskSecrets` / `chatIdHash` / `truncateText` / `createScopedLogger` / `hardenFile` / `atomicWriteJson` / `readJsonFile` / `normalizeAllowList` / `toMarkdownNotification` | `wecom-bot.mjs`（同一套脱敏、原子写、通知文案） |
 * | 通道格式化 | `im-format.mjs` 的 `formatForChannel("feishu", …)`（飞书无 markdown 文本 → 纯文本/卡片字段） |
 * | 会员判定 | `wechat-runtime.mjs` 的 `WECHAT_CAPABILITY_TABLE` / `limitsFor` / `capabilitiesFor` / `grantsCap`（**单一真相源**：免费 20 条/月、通知+拍板免费、派活受闸） |
 * | 事件源 | `dsh-events.mjs` 的 `createEventSubscriber`（与企微同一路：`turn/end`、`approval/request`…） |
 * | 审批决策 | bridge 注入的 `onApprovalDecision(requestId, decision)`（**与企微卡片同一路**） |
 *
 * ## 设计边界（每一条都重要）
 *
 * 1. **默认关闭**：`im-bots.json` 没有 `feishu.enabled && appId && appSecret` → 零连接、零文件、零日志噪音。
 * 2. **懒加载 & 可注入**：`sdkFactory` / `loadSdk` / `fetchImpl` / `timers` / `clock` 都可注入 → 单测不装真包、不联网。
 * 3. **3 秒 ACK 铁律**：卡片按钮回调**先返回 toast/更新卡片，再异步交决策**；绝不在 handler 里 await 网络/写库
 *    （超时会重推 → 重复回执）。幂等键 = `requestId + action`。
 * 4. **凭据错 ≠ 网络断**：appId/secret 错、应用未发版、权限不足 → 明确人话错误并**停止重连**；
 *    网络类错误 → 交给 SDK 的 autoReconnect（我们只如实报状态）。
 * 5. **secret 绝不进日志**：模块只打 appId 掩码/chat 哈希；logger 再兜一层字面量脱敏。
 * 6. **文件按契约**：`im-bots.json`（插件写、桥只读）/ `im-bot-status.json`（桥写、原子替换 + 0600）。
 *    status 的 `feishu` 段与企微字段一一对应，另加 `state` 与 `deps.feishu`。
 *
 * ## 对外 API
 *
 * ```js
 * // 依赖探测（面板「下载依赖」前后都能调，不发网络）
 * feishuSdkStatus({ relayDir, env })   // {installed, version, path, depsDir, lastError}
 * await loadFeishuSdk({ relayDir })    // {ok, sdk?, status, error?}（懒加载 + 缓存）
 *
 * // 纯函数（单测友好）
 * validateAppId / normalizeFeishuConfig / readFeishuConfig
 * buildApprovalCard / buildDecidedCard / parseCardAction / formatFeishuText / feishuErrorHint
 *
 * // 传输层
 * createFeishuSender({ appId, appSecret, domain, fetchImpl, clock })  // token + 发消息
 * createFeishuBot({ appId, appSecret, …, sdkFactory, onApprovalDecision }) // WSClient + 事件
 *
 * // bridge 只需要这个（与 createWecomBotController 同形）
 * createFeishuBotController({ relayDir, onApprovalDecision, capsProvider, log, … })
 *   → {start, stop, status}
 * ```
 *
 * ## 配置页 8 步向导（契约常量，供插件半直接渲染；不在此模块画 UI）
 *
 * `FEISHU_SETUP_GUIDE` 里有官方文档链接、注册地址与 8 步文案（含「保存事件配置时长连接必须已在线」的顺序坑）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import {
  maskSecrets,
  chatIdHash,
  truncateText,
  createScopedLogger,
  hardenFile,
  atomicWriteJson,
  readJsonFile,
  normalizeAllowList,
  toMarkdownNotification,
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE,
  APPROVAL_CARD_TTL_MS
} from "./wecom-bot.mjs";
import {
  SUMMARY_MAX_CHARS,
  buildTurnNotification,
  extractTurnSummary,
  formatForChannel
} from "./im-format.mjs";
// 命令层（2026-11-08）：/help /status /stop /ls /use /unbind 在进模型前拦下执行（三家共用）
import { executeImCommand, writeImBotsSession } from "./im-commands.mjs";
import {
  WECHAT_CAPABILITY_TABLE,
  WECHAT_TIER_LIMITS,
  capabilitiesFor,
  grantsCap,
  limitsFor
} from "./wechat-runtime.mjs";
import { createEventSubscriber, NODE_KINDS } from "./dsh-events.mjs";

// ===========================================================================
// 1. 常量 / 契约
// ===========================================================================

/** 官方 Node SDK 包名（**不写进 package.json**，运行时懒加载）。 */
export const FEISHU_SDK_PACKAGE = "@larksuiteoapi/node-sdk";
/** 按需依赖目录名（在 relayDir 下）。 */
export const IM_DEPS_DIR_NAME = "im-deps";
/** 官方开放平台域名（国际版 Lark 用 larksuite）。 */
export const FEISHU_DOMAINS = Object.freeze({
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com"
});
/** SDK 内部对 appId 的**严格**正则（源码里的校验；不匹配时 start() 只打日志不抛错 → "保存成功但连不上"）。 */
export const APP_ID_STRICT_RE = /^cli_[0-9a-fA-F]{16}$/;
/** 我们前置校验的**宽松**正则：只拦明显错的（新格式 ID 可能含非 hex 字符，见调研 R3）。 */
export const APP_ID_LOOSE_RE = /^cli_[A-Za-z0-9]{8,40}$/;
/** tenant_access_token 获取 / 消息发送路径。 */
export const FEISHU_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
export const FEISHU_SEND_PATH = "/open-apis/im/v1/messages";
/** 默认接收方类型（open_id；群/会话场景配置里改 chat_id）。 */
export const DEFAULT_RECEIVE_ID_TYPE = "open_id";
/** 卡片按钮回调 ACK 的硬期限（飞书要求 3 秒内响应，否则重推）。 */
export const ACK_DEADLINE_MS = 3000;
/** 已处理回执的幂等 TTL / 上限。 */
export const SEEN_CARD_TTL_MS = 10 * 60 * 1000;
export const SEEN_CARD_MAX = 200;
/** 通知去重 TTL / 上限（对齐企微）。 */
export const NOTIFY_KEY_TTL_MS = 10 * 60 * 1000;
export const NOTIFY_KEY_MAX = 200;
/** 通知限速：每分钟最多 20 条（对齐官方单应用/单群频控，也防事件风暴刷屏）。 */
export const NOTIFY_PER_MINUTE_MAX = 20;
/** 连接状态轮询间隔。 */
export const CONNECTION_POLL_MS = 2000;
/** 配置热更新轮询间隔（与企微一致）。 */
export const CONFIG_POLL_MS = 2000;
/** SDK 缺失时给人话（面板据此提示「下载依赖（约 41MB）」）。 */
export const SDK_MISSING_HINT =
  "飞书官方 SDK 未下载（约 41MB，按需安装、不进安装包）。请在插件「通知与消息通道 → 飞书」点「下载依赖」后重试。";
/** 长连接不支持代理（官方文档）→ 连接失败时给这条。 */
export const PROXY_HINT = "飞书长连接不支持代理：如果公司网络必须走代理，这条通道在当前网络下连不上（可改用手机远程）。";

/**
 * 飞书官方文档 / 注册入口 + 配置向导（配置页直接渲染；本模块不画 UI）。
 *
 * 业主 2026-11-08 明确的产品口径：**接收人（open_id/chat_id）不让用户填** —— 用户本来也
 * 不知道去哪拿，默认就是他/她本人。所以主路径只有两步（填 App ID/Secret + 发一句话自动绑定），
 * 后台的 7 项配置折叠成「需要更细的步骤」。
 */
export const FEISHU_SETUP_GUIDE = Object.freeze({
  docs: Object.freeze({
    createApp: "https://open.feishu.cn/app?lang=zh-CN",
    cardInteractiveBot: "https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/develop-a-card-interactive-bot",
    longConnectionEvent: "https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case",
    longConnectionCallback: "https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/callback-subscription/configure-callback-request-address",
    sendMessage: "https://open.feishu.cn/document/server-docs/im-v1/message/create",
    receiveMessage: "https://open.feishu.cn/document/server-docs/im-v1/message/events/receive",
    registerApp: "https://open.feishu.cn/app"
  }),
  /** 主路径（展示在第一层，只要两件事）。 */
  quickPath: Object.freeze([
    "在飞书开放平台创建一个企业自建应用，复制 **App ID / App Secret**（只填这两样，接收人不用填）",
    "填进本面板 → 下载依赖 → 在飞书里给机器人**发一句话**：接收人自动绑定，之后通知/拍板都发给你"
  ]),
  quickPathHint: "应用能力/权限/事件与回调/发版这些后台设置仍需做一次（点开「需要更细的步骤」照着做）。",
  detailsLabel: "需要更细的步骤",
  /** 接收人自动绑定的口径（面板可展示成一句说明）。 */
  bindingHint: "接收人不需要填：机器人收到你的第一条消息后自动记住这个会话；在群里 @ 它则记住那个群。",
  steps: Object.freeze([
    "打开飞书开放平台（open.feishu.cn/app）→ 创建**企业自建应用**（商店应用不支持长连接）",
    "「凭证与基础信息」→ 复制 **App ID / App Secret**（App ID 形如 cli_ 开头的一串字符）",
    "「添加应用能力」→ 开启**机器人**",
    "「权限管理」→ 申请收消息（im:message.p2p_msg:readonly、im:message.group_at_msg:readonly）与发消息（im:message:send_as_bot）",
    "「事件与回调 → 事件配置」→ 订阅方式选**使用长连接接收事件** → 添加「接收消息 v2.0」",
    "「事件与回调 → 回调配置」→ 订阅方式选**使用长连接接收回调** → 添加 card.action.trigger（拍板卡片用）",
    "「版本管理与发布」→ 创建版本并**发布**（不发布不生效）；「可用范围」包含你自己/目标成员",
    "回到本面板：填 App ID / Secret → 「下载依赖」→「测试连接」→ 在飞书里给机器人**发一句话**（接收人自动绑定，无需填写）"
  ]),
  // 最容易被忽略的顺序坑：保存事件配置时，必须已经有一个长连接在线。
  orderWarning: "顺序很重要：先在本机填好凭据让长连接在线，再去开发者后台保存「事件/回调」配置（否则保存会提示「应用未建立长连接」）。",
  oneAppOnePc: "同一个飞书应用只挂一台电脑：多台设备会互抢事件（官方集群随机分发，上限 50 连接）。"
});

/** 飞书常见错误码 → 人话（面板展示；不含任何凭据）。 */
export const FEISHU_ERROR_HINTS = Object.freeze({
  99991663: "应用凭证失效：App ID / App Secret 不对，或应用已被停用",
  99991661: "应用缺少机器人能力，或修改后没有发布版本",
  99991668: "应用未开通所需权限（收消息 / 发消息）",
  230002: "机器人不在这个会话里：去飞书群里把机器人添加进来，或先私聊它一句",
  230006: "发送太频繁，稍后再试",
  230013: "你不在应用可用范围内：开发者后台把可用范围改成包含你，然后发版",
  1000040350: "同一应用的连接数超限（上限 50）：检查是否有别的电脑挂着同一个应用"
});

/** 把飞书错误码/消息翻成人话（未知码原样带出，便于搜官方文档）。 */
export function feishuErrorHint(code, message = "") {
  const n = Number(code);
  const hint = FEISHU_ERROR_HINTS[n];
  const detail = truncateText(String(message || ""), 160);
  if (hint) return detail ? `${hint}（${detail}）` : hint;
  if (!Number.isFinite(n) && !detail) return "未知错误";
  return detail ? `飞书返回错误 ${Number.isFinite(n) ? n : ""}：${detail}`.trim() : `飞书返回错误 ${n}`;
}

// ===========================================================================
// 2. 纯函数：App ID 校验 / 配置 / 卡片 / 入站解析
// ===========================================================================

/**
 * appId 前置校验。**宽松**只拦明显错的；同时告诉调用方 SDK 的严格正则是否通过 ——
 * SDK 不匹配严格正则时只打一行 error 就 return（见调研 R3），所以必须提前暴露这个信号。
 * @param {string} appId
 * @returns {{ok:boolean, strict:boolean, warning?:string, reason?:string}}
 */
export function validateAppId(appId) {
  const v = String(appId || "").trim();
  if (!v) return { ok: false, strict: false, reason: "App ID 为空" };
  if (!APP_ID_LOOSE_RE.test(v)) {
    return {
      ok: false,
      strict: false,
      reason: "App ID 形如 cli_ 开头 + 一串字符，在开发者后台「凭证与基础信息」里复制"
    };
  }
  const strict = APP_ID_STRICT_RE.test(v);
  return {
    ok: true,
    strict,
    ...(strict ? {} : {
      warning: "这个 App ID 没有通过官方 SDK 的严格校验（cli_ + 16 位十六进制）：旧版 SDK 可能「保存成功但一直连不上」，请务必用「测试连接」确认，或升级 SDK 版本"
    })
  };
}

/** 域名归一：feishu（默认）/ lark。 */
export function normalizeDomain(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return v === "lark" || v === "larksuite" ? "lark" : "feishu";
}

/** 接收方类型归一：open_id / chat_id（空 = 默认 open_id）。 */
export function normalizeReceiveIdType(raw, fallback = DEFAULT_RECEIVE_ID_TYPE) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "open_id" || v === "chat_id") return v;
  return fallback;
}

/**
 * `im-bots.json` 里 `feishu` 段的规范形状（缺字段补默认；非法值当未配置，**绝不抛**）。
 *
 * 注意：**不加** `verifyToken` / `encryptKey` —— 长连接模式下事件/回调由 SDK 内部解密分发，
 * 这两个字段只属于「事件发送至开发者服务器」的 HTTP 模式（调研 §4.1）。
 *
 * @param {any} raw 完整 im-bots 对象或直接是 feishu 段
 * @returns {{enabled:boolean,appId:string,appSecret:string,domain:"feishu"|"lark",receiveId:string,receiveIdType:"open_id"|"chat_id",boundChatId:string,allowFrom:string[],cardApproval:boolean,sdkVersion:string,sessionId:string,sessionTitle:string}}
 */
export function normalizeFeishuConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const f = src.feishu && typeof src.feishu === "object" && !Array.isArray(src.feishu) ? src.feishu : src;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  return {
    enabled: f.enabled === true,
    appId: str(f.appId),
    appSecret: typeof f.appSecret === "string" ? f.appSecret : "",
    domain: normalizeDomain(f.domain),
    receiveId: str(f.receiveId),
    receiveIdType: normalizeReceiveIdType(f.receiveIdType, ""),
    boundChatId: str(f.boundChatId),
    allowFrom: normalizeAllowList(f.allowFrom),
    cardApproval: f.cardApproval !== false, // 默认开
    sdkVersion: str(f.sdkVersion),
    // 复用企微的「固定转发目标会话」（空 = 跟随当前活跃会话）
    sessionId: str(f.sessionId),
    sessionTitle: str(f.sessionTitle)
  };
}

/**
 * 从 `relayDir/im-bots.json` 读飞书配置（**桥只读**；插件写）。
 * 注意：不走 `wecom-bot.readImBotsConfig`，因为它的 normalize 只保留 feishu 的 3 个字段。
 * @returns {{config:ReturnType<typeof normalizeFeishuConfig>, raw:any}|null}
 */
export function readFeishuConfig(relayDir) {
  if (!relayDir) return null;
  const raw = readJsonFile(path.join(String(relayDir), IM_BOTS_FILE));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { config: normalizeFeishuConfig(raw), raw };
}

/** 飞书文本格式化：无 markdown → 纯文本（表格/加粗降级由 im-format 统一处理）。 */
export function formatFeishuText(text, opts = {}) {
  return formatForChannel("feishu", { ...opts, text });
}

/** appId 掩码（日志/状态里只给前后各 4 位）。 */
export function maskAppId(appId) {
  const v = String(appId || "");
  if (v.length <= 10) return v ? "cli_***" : "";
  return `${v.slice(0, 8)}***${v.slice(-2)}`;
}

function oneLine(value, max = 200) {
  return truncateText(String(value == null ? "" : value).replace(/\s+/g, " ").trim(), max);
}

/**
 * 审批卡片（卡片 JSON **2.0**；调研 R11：1.0 与 2.0 不兼容，统一 2.0）。
 * 按钮用 `behaviors:[{type:"callback", value:{action, requestId, nonce, expiresAt}}]`。
 *
 * @param {{requestId:string, toolName?:string, summary?:string, sessionTitle?:string, expiresAt?:number, nonce?:string}} info
 */
export function buildApprovalCard(info = {}) {
  const requestId = String(info.requestId || "");
  const toolName = oneLine(info.toolName || "一步操作", 60);
  const summary = oneLine(info.summary || "", 200);
  const expiresAt = Number(info.expiresAt) || 0;
  const nonce = String(info.nonce || "");
  const value = (action) => ({ action, requestId, nonce, expiresAt });
  const bodyLines = [`工具：${toolName}`];
  if (summary) bodyLines.push(`内容：${summary}`);
  bodyLines.push(`有效期 ${Math.max(1, Math.round(APPROVAL_CARD_TTL_MS / 1000))} 秒；到期未回执按「拒绝」处理（不会默认放行）。`);
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: "🛂 需要你拍板" },
      template: "orange"
    },
    body: {
      elements: [
        { tag: "div", text: { tag: "plain_text", content: bodyLines.join("\n") } },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "允许一次" },
              type: "primary",
              behaviors: [{ type: "callback", value: value("allow") }]
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "拒绝" },
              type: "danger",
              behaviors: [{ type: "callback", value: value("deny") }]
            }
          ]
        }
      ]
    }
  };
}

/** 回执后的卡片（原地更新，把按钮换成状态；3 秒 ACK 时直接返回它）。 */
export function buildDecidedCard(info = {}) {
  const requestId = String(info.requestId || "");
  const decision = info.decision === "allow" ? "allow" : "deny";
  const operator = oneLine(info.operator || "", 40);
  const allowed = decision === "allow";
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: allowed ? "✅ 已允许（一次）" : "🛑 已拒绝" },
      template: allowed ? "green" : "red"
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: [
              `请求：${oneLine(requestId, 64)}`,
              operator ? `操作人：${operator}` : "",
              allowed ? "本次只放行这一次，不会变成永久允许。" : "这一步不会执行（拒绝）。"
            ].filter(Boolean).join("\n")
          }
        }
      ]
    }
  };
}

/**
 * 解析卡片按钮回调（`card.action.trigger`）。
 *
 * 官方事件形状（长连接回调）：
 * ```json
 * { "event_id":"…", "event": { "operator":{"operator_id":{"open_id":"ou_…"}},
 *   "action":{"value":{"action":"allow","requestId":"…"}},
 *   "context":{"open_chat_id":"oc_…","open_message_id":"om_…"} } }
 * ```
 * 兼容 `data.event` / `data` 两种外层；**不认的形状返回 ok:false**（上层回 toast 错误，绝不乱放行）。
 *
 * @param {any} payload
 * @returns {{ok:boolean, requestId?:string, decision?:"allow"|"deny", action?:string, operatorOpenId?:string, chatId?:string, messageId?:string, eventKey?:string, expiresAt?:number, nonce?:string, reason?:string}}
 */
export function parseCardAction(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "回调为空" };
  const event = payload.event && typeof payload.event === "object" ? payload.event : payload;
  const action = event.action && typeof event.action === "object" ? event.action : {};
  const value = action.value && typeof action.value === "object" ? action.value : {};
  const requestId = String(value.requestId || value.request_id || "").trim();
  const rawAction = String(value.action || "").toLowerCase();
  const decision = rawAction === "allow" || rawAction === "approve" || rawAction === "allowed"
    ? "allow"
    : rawAction === "deny" || rawAction === "reject" || rawAction === "denied"
      ? "deny"
      : "";
  if (!requestId) return { ok: false, reason: "回调里没有 requestId（卡片 version 可能不是本模块发的）" };
  if (!decision) return { ok: false, reason: `不认识的按钮动作：${truncateText(rawAction || "空", 20)}` };
  const operator = event.operator && typeof event.operator === "object" ? event.operator : {};
  const operatorOpenId = String(
    (operator.operator_id && operator.operator_id.open_id) || operator.open_id || ""
  );
  const context = event.context && typeof event.context === "object" ? event.context : {};
  const eventId = String(payload.event_id || payload.event?.event_id || "");
  return {
    ok: true,
    requestId,
    decision,
    action: rawAction,
    operatorOpenId,
    chatId: String(context.open_chat_id || ""),
    messageId: String(context.open_message_id || ""),
    eventKey: eventId || `${requestId}:${decision}`,
    expiresAt: Number(value.expiresAt) || 0,
    nonce: String(value.nonce || "")
  };
}

/** 从飞书消息 content（JSON 字符串）里抽文本；不认识的类型返回 ""（**绝不猜**）。 */
export function extractFeishuMessageText(msgType, contentRaw) {
  const type = String(msgType || "");
  let parsed = contentRaw;
  if (typeof contentRaw === "string") {
    try { parsed = JSON.parse(contentRaw); } catch { return ""; }
  }
  if (!parsed || typeof parsed !== "object") return "";
  if (type === "text") {
    const t = parsed.text;
    return typeof t === "string" ? t.trim() : "";
  }
  // 富文本 post：{title, content:[[{tag:"text",text}]]}（结构有多个历史版本，尽力而为）
  if (type === "post") {
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (typeof node === "string") { parts.push(node); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === "object") {
        if (typeof node.text === "string") parts.push(node.text);
        if (Array.isArray(node.content)) node.content.forEach(walk);
      }
    };
    walk(parsed.title || "");
    walk(parsed.content || []);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/**
 * 把 `im.v1.message.receive_v1` 的 data 归一化。
 * @param {any} data SDK 回调入参（`{event:{message,sender,...}}` 或直接 event）
 * @returns {{ok:boolean, chatId?:string, chatType?:string, openId?:string, senderType?:string, messageId?:string, msgType?:string, text?:string, reason?:string}}
 */
export function normalizeInboundEvent(data) {
  const event = data && typeof data === "object" && data.event && typeof data.event === "object" ? data.event : data;
  if (!event || typeof event !== "object") return { ok: false, reason: "入站事件为空" };
  const message = event.message && typeof event.message === "object" ? event.message : null;
  const sender = event.sender && typeof event.sender === "object" ? event.sender : {};
  if (!message) return { ok: false, reason: "入站事件没有 message" };
  const msgType = String(message.message_type || message.msg_type || "");
  const text = extractFeishuMessageText(msgType, message.content);
  return {
    ok: true,
    chatId: String(message.chat_id || ""),
    chatType: String(message.chat_type || ""),
    openId: String((sender.sender_id && sender.sender_id.open_id) || sender.open_id || ""),
    senderType: String(sender.sender_type || ""),
    messageId: String(message.message_id || ""),
    msgType,
    text
  };
}

// ===========================================================================
// 3. 懒加载 SDK（按需下载、不随包分发）
// ===========================================================================

/** 模块级缓存：`dir -> {sdk, status}`；注入工厂用 WeakMap 按函数身份缓存（不同工厂不能互相污染）。 */
const sdkCache = new Map();
let factoryCache = new WeakMap();
let lastSdkError = "";

/** SDK 目录：`<relayDir>/im-deps/node_modules/@larksuiteoapi/node-sdk`。 */
export function resolveFeishuSdkDir({ relayDir = "", env = process.env } = {}) {
  const root = String(env?.DSH_IM_DEPS_DIR || "").trim() || (relayDir ? path.join(String(relayDir), IM_DEPS_DIR_NAME) : "");
  if (!root) return "";
  return path.join(root, "node_modules", "@larksuiteoapi", "node-sdk");
}

/**
 * 依赖状态（**只读文件，不发网络**）：面板据此显示「未下载 / 已安装 vX」。
 * @returns {{installed:boolean, version:string, path:string, depsDir:string, lastError:string, injected?:boolean}}
 */
export function feishuSdkStatus({ relayDir = "", env = process.env, fsImpl = fs, sdkFactory = null } = {}) {
  const depsRoot = String(env?.DSH_IM_DEPS_DIR || "").trim() || (relayDir ? path.join(String(relayDir), IM_DEPS_DIR_NAME) : "");
  if (typeof sdkFactory === "function") {
    return { installed: true, injected: true, version: "injected", path: "injected", depsDir: depsRoot, lastError: "" };
  }
  const dir = resolveFeishuSdkDir({ relayDir, env });
  if (!dir) return { installed: false, version: "", path: "", depsDir: "", lastError: lastSdkError };
  let version = "";
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(dir, "package.json"), "utf8"));
    version = String(pkg?.version || "");
  } catch (e) {
    return { installed: false, version: "", path: dir, depsDir: depsRoot, lastError: lastSdkError || truncateText(e?.message || e, 120) };
  }
  const entry = resolveSdkEntry(dir, { fsImpl });
  return { installed: Boolean(entry), version, path: entry || dir, depsDir: depsRoot, lastError: lastSdkError };
}

/** 从 package.json 解析入口（main/exports 都可能用；找不到回退 index.js）。 */
function resolveSdkEntry(dir, { fsImpl = fs } = {}) {
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(dir, "package.json"), "utf8"));
    const main = typeof pkg.main === "string" && pkg.main.trim() ? pkg.main.trim() : "index.js";
    const candidates = [main, "index.js", "lib/index.js"];
    for (const rel of candidates) {
      const p = path.join(dir, rel);
      try { if (fsImpl.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
    }
  } catch { /* 交给回退 */ }
  return "";
}

/**
 * 懒加载官方 SDK（**只有飞书启用且真正要建连时才调**；成功后模块级缓存）。
 *
 * @param {{relayDir?:string, env?:object, sdkFactory?:Function, importImpl?:Function, fsImpl?:object}} opts
 * @returns {Promise<{ok:boolean, sdk?:any, status:object, error?:string}>}
 */
export async function loadFeishuSdk({
  relayDir = "",
  env = process.env,
  sdkFactory = null,
  importImpl = null,
  fsImpl = fs
} = {}) {
  if (typeof sdkFactory === "function") {
    if (factoryCache.has(sdkFactory)) return factoryCache.get(sdkFactory);
    try {
      const sdk = sdkFactory();
      const value = { ok: true, sdk, status: feishuSdkStatus({ relayDir, env, sdkFactory }) };
      factoryCache.set(sdkFactory, value);
      return value;
    } catch (e) {
      lastSdkError = truncateText(e?.message || e, 160);
      return { ok: false, status: feishuSdkStatus({ relayDir, env, sdkFactory }), error: lastSdkError };
    }
  }

  const status = feishuSdkStatus({ relayDir, env, fsImpl });
  if (!status.installed) {
    lastSdkError = status.lastError || "";
    return { ok: false, status, error: SDK_MISSING_HINT };
  }
  const key = status.path;
  if (sdkCache.has(key)) return sdkCache.get(key);
  try {
    const importer = typeof importImpl === "function" ? importImpl : (u) => import(u);
    const mod = await importer(pathToFileURL(status.path).href);
    const sdk = mod && (mod.default || mod);
    const value = { ok: true, sdk, status };
    sdkCache.set(key, value);
    lastSdkError = "";
    return value;
  } catch (e) {
    lastSdkError = truncateText(e?.message || e, 160);
    return { ok: false, status: { ...status, lastError: lastSdkError }, error: `飞书 SDK 加载失败：${lastSdkError}` };
  }
}

/** 仅测试：清空 SDK 缓存（生产不需要）。 */
export function _resetFeishuSdkCache() {
  sdkCache.clear();
  factoryCache = new WeakMap();
  lastSdkError = "";
}

// ===========================================================================
// 4. 发送器（tenant_access_token + im/v1/messages）
// ===========================================================================

/**
 * 创建发送器：拿 tenant_access_token（缓存）+ 发消息 + 可选更新卡片。
 *
 * 为什么自写 HTTP 而不是用 SDK 的 Client：发送是**简单 REST**，自写可注入 fetch、可单测、
 * 也能在 SDK 版本升级时少受一层影响；长连接那部分才必须用 SDK。
 *
 * @param {{appId:string, appSecret:string, domain?:"feishu"|"lark", fetchImpl?:Function, clock?:Function, logger?:object, tokenSkewMs?:number}} opts
 */
export function createFeishuSender({
  appId,
  appSecret,
  domain = "feishu",
  fetchImpl = (...args) => globalThis.fetch(...args),
  clock = () => Date.now(),
  logger,
  tokenSkewMs = 60_000
} = {}) {
  const base = FEISHU_DOMAINS[normalizeDomain(domain)] || FEISHU_DOMAINS.feishu;
  const log = logger || createScopedLogger({ prefix: "[feishu]", secrets: [String(appSecret || "")] });
  const state = { token: "", expiresAt: 0, lastError: "", sends: 0, tokenFetches: 0 };

  async function readJson(res) {
    if (!res || typeof res.json !== "function") return {};
    try { return await res.json(); } catch { return {}; }
  }

  async function ensureToken({ force = false } = {}) {
    const at = Number(clock()) || Date.now();
    if (!force && state.token && at < state.expiresAt) return state.token;
    state.tokenFetches += 1;
    const res = await fetchImpl(`${base}${FEISHU_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const json = await readJson(res);
    const code = Number(json.code);
    if (!json || code !== 0 || !json.tenant_access_token) {
      const hint = feishuErrorHint(code || res?.status, json?.msg || json?.message || "");
      state.lastError = hint;
      log.warn(`获取 token 失败：${hint}`);
      throw Object.assign(new Error(hint), { code: code || -1 });
    }
    state.token = String(json.tenant_access_token);
    const expireSec = Number(json.expire) || 7200;
    state.expiresAt = at + Math.max(60, expireSec) * 1000 - Math.max(0, tokenSkewMs);
    state.lastError = "";
    return state.token;
  }

  async function sendMessage({ receiveId, receiveIdType = DEFAULT_RECEIVE_ID_TYPE, msgType = "text", content } = {}) {
    const rid = String(receiveId || "");
    if (!rid) return { ok: false, reason: "缺少接收方（先让用户在飞书里给机器人发一句话以完成绑定）" };
    const body = {
      receive_id: rid,
      msg_type: String(msgType || "text"),
      content: typeof content === "string" ? content : JSON.stringify(content ?? {})
    };
    const doSend = async () => {
      const token = await ensureToken();
      const url = `${base}${FEISHU_SEND_PATH}?receive_id_type=${encodeURIComponent(normalizeReceiveIdType(receiveIdType))}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const json = await readJson(res);
      return { status: res?.status, json, code: Number(json?.code) };
    };
    try {
      let r = await doSend();
      // token 失效：刷新一次再重试（只重试一次，绝不无限打）
      if (r.code === 99991663) {
        state.token = "";
        r = await doSend();
      }
      state.sends += 1;
      if (r.code === 0) {
        return { ok: true, code: 0, messageId: String(r.json?.data?.message_id || ""), data: r.json?.data };
      }
      const hint = feishuErrorHint(r.code || r.status, r.json?.msg || r.json?.message || "");
      state.lastError = hint;
      log.warn(`发送失败 chat=${chatIdHash(rid)} msg_type=${body.msg_type}：${hint}`);
      return { ok: false, code: r.code, reason: hint };
    } catch (e) {
      const hint = feishuErrorHint(-1, e?.message || e);
      state.lastError = hint;
      log.warn(`发送异常 chat=${chatIdHash(rid)}：${hint}`);
      return { ok: false, reason: hint };
    }
  }

  return {
    /** 发纯文本（内容已按飞书无 markdown 的规则格式化由调用方决定）。 */
    async sendText(receiveId, text, { receiveIdType = DEFAULT_RECEIVE_ID_TYPE } = {}) {
      return sendMessage({
        receiveId,
        receiveIdType,
        msgType: "text",
        content: { text: formatFeishuText(text) }
      });
    },
    /** 发卡片（审批拍板用）。 */
    async sendCard(receiveId, card, { receiveIdType = DEFAULT_RECEIVE_ID_TYPE } = {}) {
      return sendMessage({ receiveId, receiveIdType, msgType: "interactive", content: card });
    },
    /** 原地更新卡片（best-effort；失败不算致命，调用方只记日志）。 */
    async patchCard(messageId, card) {
      const mid = String(messageId || "");
      if (!mid) return { ok: false, reason: "缺少 message_id" };
      try {
        const token = await ensureToken();
        const res = await fetchImpl(`${base}${FEISHU_SEND_PATH}/${encodeURIComponent(mid)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
          body: JSON.stringify({ content: JSON.stringify(card) })
        });
        const json = await readJson(res);
        const code = Number(json?.code);
        if (code === 0) return { ok: true };
        return { ok: false, code, reason: feishuErrorHint(code || res?.status, json?.msg || "") };
      } catch (e) {
        return { ok: false, reason: truncateText(e?.message || e, 120) };
      }
    },
    /** 发送器只读状态（token 不回显）。 */
    state() {
      return {
        tokenReady: Boolean(state.token),
        expiresAt: state.expiresAt,
        sends: state.sends,
        tokenFetches: state.tokenFetches,
        lastError: state.lastError
      };
    }
  };
}

// ===========================================================================
// 5. 长连接 bot（WSClient + 事件/回调分发）
// ===========================================================================

/**
 * 创建飞书长连接 bot（**未 start 前不加载 SDK、不建连**）。
 *
 * 事件：
 *   · `'message'`：归一化入站消息（已过滤 bot 自己、已过 allowFrom）
 *   · `'cardAction'`：卡片按钮（已 ACK，决策已异步交给 onApprovalDecision）
 *   · `'ready' | 'error' | 'status'`：状态变化
 *
 * @param {object} options
 */
export function createFeishuBot({
  appId,
  appSecret,
  domain = "feishu",
  receiveId = "",
  receiveIdType = "",
  allowFrom = [],
  cardApproval = true,
  /** 配置里预填的绑定点（可选；兼容旧配置/手工排障）。正常流程由 chat.list 或首条消息自动绑定。 */
  boundChatId = "",
  /** 连接成功后用 chat.list 自动选群：每页条数。 */
  chatListPageSize = 20,
  relayDir = "",
  env = process.env,
  logger,
  clock = () => Date.now(),
  sdkFactory = null,
  loadSdk = loadFeishuSdk,
  importImpl = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  onApprovalDecision,
  ackDeadlineMs = ACK_DEADLINE_MS,
  connectionPollMs = CONNECTION_POLL_MS,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval }
} = {}) {
  const emitter = new EventEmitter();
  const log = logger && typeof logger.info === "function" && typeof logger.warn === "function"
    ? logger
    : createScopedLogger({
        prefix: "[feishu]",
        secrets: [String(appSecret || "")],
        ...(typeof logger === "function" ? { sink: logger } : {})
      });
  const seenCards = new Map();
  let sender = null;
  let wsClient = null;
  let sdkRef = null; // 懒加载后的 SDK（chat.list 自动选群用）
  let dispatcherHandlers = null;
  let pollTimer = null;
  let stopped = false;
  let started = false;

  const state = {
    connected: false,
    authenticated: false,
    state: "idle",
    lastError: "",
    lastConnectedAt: 0,
    lastMessageAt: 0,
    boundChatId: "",
    boundChatType: "", // "chat_id"（群，来自 chat.list/群消息）| "open_id"（单聊，来自消息）
    boundChatName: "", // 群名（面板展示"已自动绑定：<群名或私聊>"）
    boundSource: "",   // "auto_group"（chat.list 自动选群）| "auto"（首条消息/预填）
    chatCount: null,   // 机器人所在群数（chat.list 结果；null=没查到/没权限）
    sdkVersion: "",
    ackCount: 0,
    decisionCount: 0
  };

  function emitStatus() {
    try { emitter.emit("status", status()); } catch { /* 忽略 */ }
  }

  function readConnectionState() {
    try {
      if (wsClient && typeof wsClient.getConnectionStatus === "function") {
        const st = wsClient.getConnectionStatus();
        const s = String(st?.state || st?.status || "");
        if (s) return s;
      }
    } catch { /* 忽略 */ }
    return "";
  }

  function refreshConnection() {
    if (stopped) return;
    const s = readConnectionState();
    if (!s) return;
    const connected = s === "connected";
    if (connected && !state.connected) {
      state.connected = true;
      state.authenticated = true; // 飞书语义：bootstrap 成功即已鉴权
      state.state = "connected";
      state.lastConnectedAt = Number(clock()) || Date.now();
      log.info("长连接已就绪");
      try { emitter.emit("ready", status()); } catch { /* 忽略 */ }
      void autoBindFromChatList();
    } else if (!connected) {
      state.connected = false;
      state.authenticated = false;
      state.state = /reconnect/i.test(s) ? "reconnecting" : s;
    }
    emitStatus();
  }

  function stopPolling() {
    if (!pollTimer) return;
    try { timers.clearInterval(pollTimer); } catch { /* 忽略 */ }
    pollTimer = null;
  }

  function startPolling() {
    stopPolling();
    // 有 getConnectionStatus 才轮询；否则视为"start 成功即已连上"（乐观，失败会走 'error'）
    if (wsClient && typeof wsClient.getConnectionStatus === "function") {
      pollTimer = timers.setInterval(refreshConnection, connectionPollMs);
      if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
      refreshConnection();
      // 首拍可能仍是 connecting：给一拍宽限
      timers.setTimeout(refreshConnection, 200);
    } else {
      state.connected = true;
      state.authenticated = true;
      state.state = "connected";
      state.lastConnectedAt = Number(clock()) || Date.now();
      try { emitter.emit("ready", status()); } catch { /* 忽略 */ }
      emitStatus();
      void autoBindFromChatList();
    }
  }

  function rememberCardKey(key) {
    const at = Number(clock()) || Date.now();
    for (const [k, t] of seenCards) {
      if (at - t > SEEN_CARD_TTL_MS) seenCards.delete(k);
      else break;
    }
    if (seenCards.has(key)) return false;
    seenCards.set(key, at);
    if (seenCards.size > SEEN_CARD_MAX) {
      const oldest = seenCards.keys().next().value;
      if (oldest !== undefined) seenCards.delete(oldest);
    }
    return true;
  }

  /**
   * 卡片按钮回调 —— **同步返回 ACK**，决策异步执行（3 秒铁律）。
   * 返回的 `{toast, card:{type:"raw",data}}` 就是飞书要求的回调响应。
   */
  function handleCardAction(payload) {
    const parsed = parseCardAction(payload);
    if (!parsed.ok) {
      log.warn(`卡片回执无法解析：${truncateText(parsed.reason, 80)}`);
      return { toast: { type: "warning", content: `回执无效：${truncateText(parsed.reason, 40)}` } };
    }
    const at = Number(clock()) || Date.now();
    if (parsed.expiresAt && at > parsed.expiresAt) {
      log.warn(`卡片回执已过期 requestId=${truncateText(parsed.requestId, 24)}`);
      return { toast: { type: "info", content: "这条审批已过期（未回复按拒绝处理）" } };
    }
    if (!rememberCardKey(parsed.eventKey)) {
      return { toast: { type: "info", content: "这条回执已处理过了" } };
    }
    const operator = parsed.operatorOpenId ? maskOperator(parsed.operatorOpenId) : "";
    const decidedCard = buildDecidedCard({ requestId: parsed.requestId, decision: parsed.decision, operator });
    state.ackCount += 1;
    // 先 ACK（同步返回），再异步交决策 —— 绝不能 await 网络/写库
    if (typeof onApprovalDecision === "function") {
      Promise.resolve()
        .then(() => onApprovalDecision(parsed.requestId, parsed.decision))
        .then((r) => {
          state.decisionCount += 1;
          if (r && r.ok === false) {
            log.warn(`审批回执提交失败 requestId=${truncateText(parsed.requestId, 24)}：${truncateText(r.reason || r.error || "?", 80)}`);
          }
        })
        .catch((e) => log.warn(`审批回执异常：${truncateText(e?.message || e, 100)}`));
    } else {
      log.warn("没有注入 onApprovalDecision：卡片回执只 ACK、不生效（编辑/接线问题）");
    }
    try { emitter.emit("cardAction", { ...parsed, ackAt: at }); } catch { /* 忽略 */ }
    return {
      toast: { type: "success", content: parsed.decision === "allow" ? "已回传：允许一次" : "已回传：拒绝" },
      card: { type: "raw", data: decidedCard }
    };
  }

  function handleMessageEvent(payload) {
    const inbound = normalizeInboundEvent(payload);
    if (!inbound.ok) {
      log.warn(`入站消息无法解析：${truncateText(inbound.reason, 80)}`);
      return;
    }
    // 过滤机器人自己（飞书会推 sender_type==='bot'），避免自回环
    if (inbound.senderType === "bot") return;
    if (!inbound.chatId) return;
    if (!inbound.text) {
      // 非文本：不猜内容，回一句可预期的话（不消耗额度、不算派活）
      log.info(`收到暂不支持的消息类型 type=${truncateText(inbound.msgType, 20)}`);
      void sender?.sendText?.(inbound.chatId, "暂不支持该消息类型，请发文字（或在电脑上选择会话）。", { receiveIdType: "chat_id" });
      return;
    }
    if (Array.isArray(allowFrom) && allowFrom.length > 0 && inbound.openId && !allowFrom.includes(inbound.openId)) {
      log.warn(`入站被白名单拦下 open_id=${maskOperator(inbound.openId)}`);
      void sender?.sendText?.(inbound.chatId, "你不在这个通道的白名单里，无法指挥这台电脑。", { receiveIdType: "chat_id" });
      return;
    }
    /*
     * 首次说话即绑定（与企微/钉钉一致）：接收人不让用户填。
     *   · 群聊 → 记 chat_id（后续按 chat_id 推）
     *   · 单聊 → 记 sender.open_id（后续按 open_id 推，用户换群也不会发错地方）
     * 绑定信息只放内存 + 状态文件（桥写），配置里不需要 receiveId。
     */
    const isGroup = inbound.chatType === "group";
    state.boundChatId = isGroup ? inbound.chatId : (inbound.openId || inbound.chatId);
    state.boundChatType = isGroup ? "chat_id" : "open_id"; // 直接就是后续发送用的 receive_id_type
    state.boundChatName = ""; // 消息里没有群名；面板显示「私聊/群」即可
    state.boundSource = "auto"; // 用户发消息即改绑（覆盖 chat.list 的 auto_group）
    state.lastMessageAt = Number(clock()) || Date.now();
    emitStatus();
    try { emitter.emit("message", inbound); } catch (e) { log.warn(`message 处理异常：${truncateText(e?.message || e, 100)}`); }
  }

  function buildDispatcher(sdk) {
    const dispatcher = new sdk.EventDispatcher({});
    const handlers = {
      "im.message.receive_v1": (data) => {
        try { handleMessageEvent(data); } catch (e) { log.warn(`im.message 处理异常：${truncateText(e?.message || e, 100)}`); }
        // 事件回调要求 3 秒内返回：业务已经 fire-and-forget，这里立刻返回
        return { ok: true };
      },
      "card.action.trigger": (data) => handleCardAction(data)
    };
    dispatcherHandlers = handlers;
    if (typeof dispatcher.register === "function") dispatcher.register(handlers);
    else if (typeof dispatcher.on === "function") {
      for (const [k, fn] of Object.entries(handlers)) dispatcher.on(k, fn);
    }
    return { dispatcher, handlers };
  }

  /**
   * 接收人来源：
   *   · config      —— 用户在高级场景里手工填了 receiveId（优先）
   *   · auto_group  —— 连接成功后 chat.list 自动选中了机器人所在的群
   *   · auto        —— 首条消息自动绑定（私聊 open_id / 群 chat_id），或配置预填
   *   · none        —— 还没绑定（通知会跳过并记日志，不报错）
   */
  function receiveIdSource() {
    if (String(receiveId || "").trim()) return "config";
    if (!state.boundChatId) return "none";
    return state.boundSource === "auto_group" ? "auto_group" : "auto";
  }

  /** 自动绑定后的推送类型（直接就是 receive_id_type）。 */
  function boundTargetType() {
    if (state.boundChatType === "chat_id") return "chat_id";
    if (state.boundChatType === "open_id") return "open_id";
    return "";
  }

  /**
   * **连接成功后自动选群**（业主/Lead 实测：`client.im.v1.chat.list()` 能列出机器人所在群）：
   *   · 有群 → 记为接收人（多个群取第一个，用户发消息会改绑）→ receiveIdSource=auto_group
   *   · 空   → 不绑定，等首条消息
   *   · 无权限/失败 → 只记日志，**不影响连接与"发消息绑定"**
   * 配置里填了 receiveId 时只记录群数，不覆盖（配置优先）。
   */
  async function autoBindFromChatList() {
    if (autoBindTried) return;
    autoBindTried = true;
    const cfgTo = String(receiveId || "").trim();
    let client = null;
    try {
      if (!sdkRef || typeof sdkRef.Client !== "function") {
        log.info("SDK 未提供 Client（跳过自动选群，等首条消息绑定）");
        return;
      }
      const opts = { appId, appSecret };
      if (normalizeDomain(domain) === "lark" && sdkRef?.Domain?.Lark) opts.domain = sdkRef.Domain.Lark;
      client = new sdkRef.Client(opts);
    } catch (e) {
      log.warn(`创建 Client 失败（跳过自动选群，不影响消息绑定）：${truncateText(e?.message || e, 120)}`);
      return;
    }
    const listFn = client?.im?.v1?.chat?.list;
    if (typeof listFn !== "function") {
      log.info("SDK 没有 chat.list（跳过自动选群，等首条消息绑定）");
      return;
    }
    let resp = null;
    try {
      // 官方 1.76 的调用形态是 { params: {…} }；兼容直接传参数 / 无参（Lead 实测无参也能列出群）
      try {
        resp = await listFn.call(client.im.v1.chat, { params: { page_size: chatListPageSize } });
      } catch (e1) {
        try {
          resp = await listFn.call(client.im.v1.chat, { page_size: chatListPageSize });
        } catch (e2) {
          resp = await listFn.call(client.im.v1.chat);
        }
      }
    } catch (e) {
      // 常见：应用没申请 im:chat:readonly → 只记日志（不影响连接/发消息/消息绑定）
      log.warn(`chat.list 失败（忽略，不影响消息绑定；如需自动选群请加 im:chat:readonly）：${truncateText(e?.message || e, 120)}`);
      return;
    }
    const code = Number(resp?.code ?? resp?.data?.code);
    if (Number.isFinite(code) && code !== 0) {
      log.warn(`chat.list 返回错误码 ${code}（忽略；如需自动选群请加 im:chat:readonly）；${feishuErrorHint(code, resp?.msg || "")}`);
      return;
    }
    const items = Array.isArray(resp?.data?.items) ? resp.data.items : (Array.isArray(resp?.items) ? resp.items : []);
    state.chatCount = items.length;
    // 显式指定（receiveId）或配置预填 boundChatId 都算"用户已经定了目标"→ 只记录群数，不覆盖
    const prefilled = String(boundChatId || "").trim();
    if (cfgTo || prefilled) {
      // 不覆盖用户指定的目标，但尽量补上群名（面板显示「已自动绑定：<群名>」）
      const wanted = cfgTo || prefilled;
      const hit = items.find((it) => String(it?.chat_id || it?.chatId || "") === wanted);
      if (hit && !state.boundChatName) state.boundChatName = String(hit.name || "");
      log.info(`接收人已指定（${cfgTo ? "receiveId" : "配置预填 boundChatId"}，优先），chat.list 仅记录机器人所在群数=${items.length}`);
      emitStatus();
      return;
    }
    if (!items.length) {
      log.info("机器人还没进任何群：等用户私聊或拉群后自动绑定");
      emitStatus();
      return;
    }
    const first = items[0] || {};
    const chatId = String(first.chat_id || first.chatId || "");
    if (!chatId) {
      emitStatus();
      return;
    }
    state.boundChatId = chatId;
    state.boundChatType = "chat_id";
    state.boundChatName = String(first.name || "");
    state.boundSource = "auto_group";
    log.info(`已自动绑定到群 chat=${chatIdHash(chatId)} 群数=${items.length}${items.length > 1 ? "（多个群取第一个；用户发消息会改绑）" : ""}`);
    emitStatus();
  }
  let autoBindTried = false;

  /**
   * 解析一次发送的 target 与 receive_id_type（产品口径：接收人默认自动绑定）。
   *
   * 优先级（任务书第 3 条）：
   *   ① 调用方显式传的 receiveIdType（内部回复用，最明确）
   *   ② 配置里手工填的 receiveIdType（高级场景）
   *   ③ 按 boundChatType 自动判断（群→chat_id / 单聊→open_id）
   *   ④ 兜底 open_id（老行为）
   * target 优先级：显式 to > 配置 receiveId > 自动绑定的 boundChatId
   */
  function resolveSendTarget(explicitTo, explicitType) {
    const cfgTo = String(receiveId || "").trim();
    const to = String(explicitTo || "").trim() || cfgTo || state.boundChatId || "";
    let type = normalizeReceiveIdType(explicitType || "", "");
    if (!type && cfgTo) {
      // 只有"用户显式填了 receiveId"时，receiveIdType 才有意义（插件的默认 open_id 不能套到群上）
      type = normalizeReceiveIdType(receiveIdType, "") || DEFAULT_RECEIVE_ID_TYPE;
    }
    // 显式 to（内部回复，未传 type）沿用老行为 open_id；自动绑定则按 boundChatType 判断
    if (!type) type = explicitTo ? DEFAULT_RECEIVE_ID_TYPE : (boundTargetType() || DEFAULT_RECEIVE_ID_TYPE);
    return { to, type };
  }

  function status() {
    return {
      enabled: started && !stopped,
      connected: state.connected,
      authenticated: state.authenticated,
      state: state.state,
      lastError: state.lastError,
      lastConnectedAt: state.lastConnectedAt,
      lastMessageAt: state.lastMessageAt,
      boundChatId: state.boundChatId,
      boundChatType: state.boundChatType,
      boundChatName: state.boundChatName,
      chatCount: state.chatCount,
      // 接收人来源：config / auto_group（chat.list 自动选群）/ auto（首条消息）/ none
      receiveIdSource: receiveIdSource(),
      receiveIdConfigured: Boolean(String(receiveId || "").trim()),
      appId: maskAppId(appId),
      domain: normalizeDomain(domain),
      receiveIdType: normalizeReceiveIdType(receiveIdType, ""),
      cardApproval: cardApproval !== false,
      sdkVersion: state.sdkVersion,
      ackCount: state.ackCount,
      decisionCount: state.decisionCount
    };
  }

  return {
    /** 建连（懒加载 SDK）。**永不抛错**：失败以 `{ok:false, reason}` + 状态返回。 */
    async start() {
      if (started && !stopped) return { ok: state.connected, status: status() };
      started = true;
      stopped = false;
      state.state = "connecting";
      emitStatus();

      // ① appId 前置校验（SDK 静默拒绝的坑：见调研 R3）
      const check = validateAppId(appId);
      if (!check.ok) {
        state.state = "failed";
        state.lastError = check.reason || "App ID 不合法";
        log.warn(`拒绝连接：${state.lastError}`);
        emitStatus();
        return { ok: false, reason: "invalid_app_id", status: status() };
      }
      if (check.warning) log.warn(check.warning);

      // ② 懒加载 SDK
      const loaded = await loadSdk({ relayDir, env, sdkFactory, importImpl });
      if (!loaded.ok) {
        state.state = "sdk_missing";
        state.lastError = loaded.error || SDK_MISSING_HINT;
        log.warn(`飞书 SDK 不可用：${state.lastError}`);
        emitStatus();
        return { ok: false, reason: "sdk_missing", status: status() };
      }
      const sdk = loaded.sdk || {};
      sdkRef = sdk;
      state.sdkVersion = String(loaded.status?.version || "");
      // 配置里预填的绑定点（可选）：oc_ 开头视为群 chat_id，其余视为 open_id
      const seeded = String(boundChatId || "").trim();
      if (seeded && !state.boundChatId) {
        state.boundChatId = seeded;
        state.boundChatType = /^oc_/i.test(seeded) ? "chat_id" : "open_id";
        state.boundSource = "auto";
      }

      // ③ 发送器（REST）
      sender = createFeishuSender({
        appId,
        appSecret,
        domain,
        fetchImpl,
        clock,
        logger: log
      });

      // ④ WSClient（长连接）。domain 仅国际版需要显式传（SDK 用 Domain.Lark 枚举）
      try {
        const wsOpts = { appId, appSecret };
        if (normalizeDomain(domain) === "lark") {
          const larkDomain = sdk?.Domain?.Lark;
          if (larkDomain) wsOpts.domain = larkDomain;
        }
        const { dispatcher } = buildDispatcher(sdk);
        wsClient = new sdk.WSClient(wsOpts);
        if (!wsClient || typeof wsClient.start !== "function") throw new Error("SDK 的 WSClient 形状不认识");
        await Promise.resolve(wsClient.start({ eventDispatcher: dispatcher }));
        state.state = "connecting";
        startPolling();
        log.info(`长连接已发起 appId=${maskAppId(appId)} domain=${normalizeDomain(domain)} cardApproval=${cardApproval !== false}`);
        emitStatus();
        return { ok: true, status: status() };
      } catch (e) {
        state.state = "failed";
        state.lastError = mapConnectError(e);
        log.warn(`建连失败：${state.lastError}`);
        emitStatus();
        // 建连失败不抛：上面已给明确状态；调用方（controller）只写状态
        return { ok: false, reason: "connect_failed", error: state.lastError, status: status() };
      }
    },

    /** 关闭连接（幂等）。 */
    async stop() {
      stopped = true;
      started = false;
      stopPolling();
      const c = wsClient;
      wsClient = null;
      if (c) {
        try { if (typeof c.close === "function") await c.close(); else if (typeof c.stop === "function") await c.stop(); } catch (e) {
          log.warn(`关闭长连接失败（忽略）：${truncateText(e?.message || e, 100)}`);
        }
      }
      state.connected = false;
      state.authenticated = false;
      state.state = "idle";
      emitStatus();
      return { ok: true };
    },

    /** 发文本（自动按飞书通道格式化；接收人默认自动绑定）。 */
    async sendText(to, text, opts = {}) {
      if (!sender) return { ok: false, reason: "发送器未初始化（连接尚未建立）" };
      const { to: target, type } = resolveSendTarget(to, opts.receiveIdType);
      if (!target) return { ok: false, reason: "还没绑定接收人：先在飞书里给机器人发一句话" };
      const r = await sender.sendText(target, text, { receiveIdType: type });
      if (r.ok) {
        state.lastMessageAt = Number(clock()) || Date.now();
        emitStatus();
      }
      return r;
    },

    /** 解绑接收人（/unbind 命令用）：清内存绑定 + 触发状态刷新；之后收到消息会自动重新绑定。 */
    clearBinding() {
      state.boundChatId = "";
      state.boundChatType = "";
      state.boundChatName = "";
      state.boundSource = "";
      emitStatus();
      return { ok: true };
    },

    /** 发审批卡片（返回值带 messageId，供回执后原地更新）。 */
    async sendCard(to, card, opts = {}) {
      if (!sender) return { ok: false, reason: "发送器未初始化（连接尚未建立）" };
      const { to: target, type } = resolveSendTarget(to, opts.receiveIdType);
      if (!target) return { ok: false, reason: "还没绑定接收人：先在飞书里给机器人发一句话" };
      return sender.sendCard(target, card, { receiveIdType: type });
    },

    /** 更新卡片（best-effort）。 */
    async patchCard(messageId, card) {
      if (!sender) return { ok: false, reason: "发送器未初始化" };
      return sender.patchCard(messageId, card);
    },

    /** 事件订阅：'message' | 'cardAction' | 'ready' | 'error' | 'status'。 */
    on(evt, cb) {
      emitter.on(evt, cb);
      return () => emitter.off(evt, cb);
    },

    status,
    senderState: () => (sender ? sender.state() : null),
    /** 仅测试：等价 SDK 分发一次事件/回调（不经过网络）。 */
    _dispatch(kind, payload) {
      const fn = dispatcherHandlers && dispatcherHandlers[kind];
      if (!fn) return { ok: false, reason: `no-handler:${kind}` };
      return fn(payload);
    }
  };
}

function maskOperator(openId) {
  const v = String(openId || "");
  if (!v) return "";
  return `${v.slice(0, 4)}***${v.slice(-2)}`;
}

/** 建连错误 → 人话（凭据/权限/网络分档；网络类给代理提示）。 */
export function mapConnectError(error) {
  const raw = String(error?.message || error || "");
  const code = error?.code || error?.response?.code || "";
  const joined = `${code} ${raw}`;
  if (/auth_failed|invalid app|app_id|app_secret|401|514/i.test(joined)) {
    return `应用凭据校验失败：检查 App ID / App Secret（${truncateText(raw, 120)}）`;
  }
  if (/forbidden|403|scope|permission/i.test(joined)) {
    return `应用没有权限或类型不对（长连接仅支持企业自建应用；${truncateText(raw, 120)}）`;
  }
  if (/exceed_conn_limit|1000040350/i.test(joined)) {
    return feishuErrorHint(1000040350, raw);
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|proxy/i.test(joined)) {
    return `连不上飞书长连接：检查企业网络/代理。${PROXY_HINT}（${truncateText(raw, 100)}）`;
  }
  return `建连失败：${truncateText(raw || "未知错误", 160)}`;
}

// ===========================================================================
// 6. 控制器（读配置 / 热更新 / 状态文件 / 会员闸 / 事件通知）
// ===========================================================================

function monthKey(at) {
  try { return new Date(Number(at) || Date.now()).toISOString().slice(0, 7); } catch { return ""; }
}

/**
 * bridge 只需要这个（与 `createWecomBotController` 同形）。
 *
 * @param {object} options
 * @param {string} options.relayDir
 * @param {(requestId:string, decision:"allow"|"deny")=>Promise<{ok?:boolean}>} [options.onApprovalDecision]
 * @param {()=>Promise<string|{plan?:string}>} [options.capsProvider] 会员档位（复用 resolveWechatTier）
 * @param {Function} [options.createBot] 测试注入
 * @param {Function} [options.sdkFactory] 测试注入（返回假 SDK）
 * @param {Function} [options.subscriberFactory] 测试注入（返回假事件订阅器）
 * @param {object} [options.botOptions] 传给 bot 的额外参数（upstream/cookie 等给订阅器用）
 */
export function createFeishuBotController(options = {}) {
  const relayDir = String(options.relayDir || "");
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const pollMs = Number.isFinite(Number(options.configPollMs)) && Number(options.configPollMs) > 0
    ? Number(options.configPollMs) : CONFIG_POLL_MS;
  const log = createScopedLogger({ sink: options.log, prefix: "[feishu]" });
  const configFile = relayDir ? path.join(relayDir, IM_BOTS_FILE) : "";
  const statusFile = relayDir ? path.join(relayDir, IM_BOT_STATUS_FILE) : "";
  const createBot = typeof options.createBot === "function" ? options.createBot : createFeishuBot;
  const sdkFactory = typeof options.sdkFactory === "function" ? options.sdkFactory : null;
  const loadSdk = typeof options.loadSdk === "function" ? options.loadSdk : loadFeishuSdk;
  const onApprovalDecision = typeof options.onApprovalDecision === "function" ? options.onApprovalDecision : null;
  const capsProvider = typeof options.capsProvider === "function" ? options.capsProvider : null;
  const notifyEnabled = options.notify !== false && String(env.DSH_IM_BOT_NOTIFY || "") !== "0" && String(env.DSH_PUSH_REPORT || "") !== "0";
  const cardApprovalAllowed = options.cardApproval !== false && String(env.DSH_FEISHU_CARD_APPROVAL || "") !== "0";
  const timers = options.timers && typeof options.timers === "object" ? options.timers : { setTimeout, clearTimeout, setInterval, clearInterval };
  const botOptions = options.botOptions && typeof options.botOptions === "object" ? options.botOptions : {};
  const appUrl = String(options.appUrl || "");
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : undefined;

  const state = {
    started: false,
    enabled: false,
    configFound: false,
    reason: "not_started",
    configUpdatedAt: 0,
    lastError: ""
  };
  /** 会员快照（与企微同一套表；拿不到 → free fail-closed）。 */
  const membership = { tier: "", caps: [], limits: {}, usage: { month: "", count: 0 }, checkedAt: 0 };

  let bot = null;
  let currentDigest = "";
  let listener = null;
  let reloading = false;
  let subscriber = null;
  let notifyMinute = { at: 0, count: 0 };
  const notifiedKeys = new Map();

  // ── 会员 ────────────────────────────────────────────────────────────────
  function tierNow() {
    return membership.tier || "free";
  }
  function capsNow() {
    return Array.isArray(membership.caps) && membership.caps.length
      ? membership.caps
      : capabilitiesFor(tierNow(), WECHAT_CAPABILITY_TABLE);
  }
  function canCap(need) {
    return grantsCap(capsNow(), need);
  }
  function limitsNow() {
    return limitsFor(tierNow(), WECHAT_TIER_LIMITS);
  }
  function usageThisMonth() {
    const m = monthKey(clock());
    return membership.usage.month === m ? Number(membership.usage.count || 0) : 0;
  }
  async function refreshTier({ force = false, minIntervalMs = 30_000 } = {}) {
    if (!capsProvider) return tierNow();
    const at = Number(clock()) || Date.now();
    if (!force && at - membership.checkedAt < minIntervalMs) return tierNow();
    let got = null;
    try { got = await capsProvider(); } catch { got = null; }
    membership.checkedAt = at;
    if (!got) return tierNow();
    const plan = typeof got === "string" ? got : String(got.plan || "");
    if (!plan) return tierNow();
    membership.tier = plan;
    const caps = typeof got === "object" && Array.isArray(got.caps) ? got.caps : capabilitiesFor(plan, WECHAT_CAPABILITY_TABLE);
    membership.caps = caps;
    membership.limits = typeof got === "object" && got.limits && typeof got.limits === "object" ? got.limits : limitsFor(plan, WECHAT_TIER_LIMITS);
    writeStatus();
    return tierNow();
  }
  function bumpUsage() {
    const m = monthKey(clock());
    const used = membership.usage.month === m ? Number(membership.usage.count || 0) : 0;
    membership.usage = { month: m, count: used + 1 };
    writeStatus();
  }

  /** 重启恢复：usage/tier 从状态文件回读（免费额度不能因重启清零）。 */
  function hydrateFromStatus() {
    if (!statusFile) return;
    try {
      const prev = readJsonFile(statusFile);
      const f = prev && prev.feishu && typeof prev.feishu === "object" ? prev.feishu : null;
      if (!f) return;
      if (f.usage && typeof f.usage === "object" && typeof f.usage.month === "string") {
        membership.usage = { month: f.usage.month, count: Math.max(0, Number(f.usage.messages ?? f.usage.count) || 0) };
      }
      if (capsProvider && typeof f.tier === "string" && f.tier) {
        membership.tier = f.tier;
        membership.caps = Array.isArray(f.caps) ? f.caps : capabilitiesFor(f.tier, WECHAT_CAPABILITY_TABLE);
        membership.limits = f.limits && typeof f.limits === "object" ? f.limits : limitsFor(f.tier, WECHAT_TIER_LIMITS);
      }
    } catch { /* 忽略 */ }
  }

  // ── 状态文件 ────────────────────────────────────────────────────────────
  function sdkStatusNow() {
    try {
      return feishuSdkStatus({ relayDir, env, sdkFactory });
    } catch (e) {
      return { installed: false, version: "", path: "", depsDir: "", lastError: truncateText(e?.message || e, 120) };
    }
  }
  function feishuSection() {
    const bs = bot && typeof bot.status === "function" ? bot.status() : null;
    const dep = sdkStatusNow();
    return {
      enabled: state.enabled === true,
      state: (bs && bs.state) || state.reason || "idle",
      connected: bs ? bs.connected === true : false,
      authenticated: bs ? bs.authenticated === true : false,
      lastError: truncateText(state.lastError || (bs && bs.lastError) || "", 160),
      lastConnectedAt: bs?.lastConnectedAt || 0,
      lastMessageAt: bs?.lastMessageAt || 0,
      boundChatId: (bs && bs.boundChatId) || "",
      boundChatType: (bs && bs.boundChatType) || "",
      boundChatName: (bs && bs.boundChatName) || "",
      chatCount: Number.isInteger(bs?.chatCount) ? bs.chatCount : null,
      // 面板据此显示「接收人：自动绑定（已/未）/ 手动配置」；receiveId 用户不用填
      receiveIdSource: (bs && bs.receiveIdSource) || (configNow?.receiveId ? "config" : "none"),
      receiveIdConfigured: Boolean(configNow?.receiveId),
      appId: bs?.appId || maskAppId(""),
      domain: bs?.domain || "feishu",
      receiveIdType: bs?.receiveIdType || "",
      cardApproval: bs ? bs.cardApproval === true : cardApprovalAllowed,
      sdkVersion: bs?.sdkVersion || dep.version || "",
      tier: tierNow(),
      caps: capsNow(),
      limits: limitsNow(),
      usage: { month: membership.usage.month || monthKey(clock()), messages: usageThisMonth() },
      ackCount: bs?.ackCount || 0,
      decisionCount: bs?.decisionCount || 0
    };
  }
  function writeStatus() {
    if (!statusFile) return;
    // 没有配置、也没有历史状态时不制造空文件：bridge 在仓库目录被调试启动（relayDir=repo）时
    // 不该凭空往工作区写 im-bot-status.json；真实用户有配置时才会写。
    try {
      if (!fs.existsSync(configFile) && !fs.existsSync(statusFile)) return;
    } catch { /* 检查失败就照常写 */ }
    try {
      const prev = readJsonFile(statusFile);
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      const dep = sdkStatusNow();
      atomicWriteJson(statusFile, {
        ...base,
        version: 1,
        updatedAt: Number(clock()) || Date.now(),
        feishu: feishuSection(),
        deps: {
          ...(base.deps && typeof base.deps === "object" ? base.deps : {}),
          feishu: {
            installed: dep.installed === true,
            version: dep.version || "",
            path: dep.path || "",
            lastError: dep.lastError || ""
          }
        }
      }, { onWarn: (m) => log.warn(m) });
    } catch (e) {
      log.warn(`状态文件写入失败（忽略）：${truncateText(e?.message || e, 120)}`);
    }
  }

  // ── 通知 ────────────────────────────────────────────────────────────────
  function notifyRateOk() {
    const at = Number(clock()) || Date.now();
    if (at - notifyMinute.at > 60_000) notifyMinute = { at, count: 0 };
    if (notifyMinute.count >= NOTIFY_PER_MINUTE_MAX) return false;
    notifyMinute.count += 1;
    return true;
  }
  function rememberNotifyKey(key) {
    const at = Number(clock()) || Date.now();
    for (const [k, t] of notifiedKeys) {
      if (at - t > NOTIFY_KEY_TTL_MS) notifiedKeys.delete(k);
      else break;
    }
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.set(key, at);
    if (notifiedKeys.size > NOTIFY_KEY_MAX) {
      const oldest = notifiedKeys.keys().next().value;
      if (oldest !== undefined) notifiedKeys.delete(oldest);
    }
    return true;
  }
  function notifyKey(node) {
    const sid = String(node?.sessionId || "");
    if (!node) return "";
    if (node.kind === NODE_KINDS.TURN_END) return `turn:${sid}:${node.turn ?? "?"}:${node.seq ?? "?"}:${node.reason || "?"}`;
    if (node.kind === NODE_KINDS.APPROVAL_REQUEST || node.kind === NODE_KINDS.USER_QUESTION || node.kind === NODE_KINDS.PLAN_REVIEW) {
      return `approval:${node.eventId || ""}:${sid}`;
    }
    if (node.kind === NODE_KINDS.SESSION_ERROR) return `error:${sid}:${node.code || node.message || ""}:${node.at || ""}`;
    return "";
  }
  function targetOf() {
    if (!bot) return "";
    const bs = bot.status();
    return configNow?.receiveId || bs.boundChatId || "";
  }
  let configNow = null;

  async function onEventNode(node) {
    if (!node || typeof node !== "object") return;
    if (!notifyEnabled || !bot) return;
    const target = targetOf();
    if (!target) {
      log.info("有事件要推，但还没绑定接收方：不用填接收人 —— 在飞书里给机器人发一句话，就会自动绑定到你这个会话");
      return;
    }
    if (!notifyRateOk()) {
      log.warn("通知超过每分钟上限，已丢弃（防事件风暴）");
      return;
    }
    // 任务完成/出错：**一条**消息 = 标题行 + 总结正文（同 turn 已去重；审批类不混入总结）
    if (node.kind === NODE_KINDS.TURN_END || node.kind === NODE_KINDS.SESSION_ERROR) {
      const key = notifyKey(node);
      if (key && !rememberNotifyKey(key)) return;
      let summary = { text: "", source: "none" };
      try {
        summary = await extractTurnSummary({ node, subscriber, sessionId: node.sessionId, maxChars: SUMMARY_MAX_CHARS });
      } catch { summary = { text: "", source: "none" }; }
      const text = buildTurnNotification({
        node,
        channel: "feishu",
        summary: summary.text,
        sessionTitle: String((configNow && configNow.sessionTitle) || ""),
        maxChars: SUMMARY_MAX_CHARS
      });
      if (!text) return;
      log.info(`任务通知 kind=${node.kind} reason=${node.reason || "?"} summary=${summary.source} len=${Array.from(summary.text).length}`);
      await bot.sendText(target, text);
      return;
    }
    // 审批：优先卡片（可点按钮）
    if (node.kind === NODE_KINDS.APPROVAL_REQUEST) {
      const key = notifyKey(node);
      if (key && !rememberNotifyKey(key)) return;
      const requestId = String(node.eventId || "");
      if (cardApprovalAllowed && requestId) {
        const card = buildApprovalCard({
          requestId,
          toolName: node.toolName || node.reason || "",
          summary: node.detail || node.summary || "",
          sessionTitle: node.sessionTitle || "",
          expiresAt: (Number(clock()) || Date.now()) + APPROVAL_CARD_TTL_MS,
          nonce: crypto.randomBytes(6).toString("hex")
        });
        const r = await bot.sendCard(target, card);
        if (r.ok) {
          log.info(`审批卡片已发送 requestId=${truncateText(requestId, 24)} chat=${chatIdHash(target)}`);
          return;
        }
        log.warn(`审批卡片发送失败（${r.reason || "?"}），退回文本通知`);
      }
      const text = toMarkdownNotification(node, {});
      if (text) await bot.sendText(target, text);
      return;
    }
    const text = toMarkdownNotification(node, {});
    if (!text) return;
    const key = notifyKey(node);
    if (key && !rememberNotifyKey(key)) return;
    await bot.sendText(target, text);
  }

  // ── 入站 ────────────────────────────────────────────────────────────────
  /** 入站命令层：命中返回 true（已回复，调用方直接 return）。 */
  async function handleInboundCommand(msg) {
    const text = String((msg && msg.text) || "");
    if (!/^\s*\//.test(text)) return false;
    const cmd = await executeImCommand({
      text,
      ctx: {
        caps: capsNow(),
        tier: tierNow(),
        appUrl,
        channelLabel: "飞书",
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
          const cfgId = String((configNow && configNow.sessionId) || "");
          if (cfgId) return cfgId;
          const sub = subscriber;
          try {
            if (sub && typeof sub.sessions === "function") {
              const ids = sub.sessions();
              if (Array.isArray(ids) && ids.length) return String(ids[0]);
            }
          } catch { /* 忽略 */ }
          return "";
        },
        currentSessionTitle: () => String((configNow && configNow.sessionTitle) || ""),
        cancelSession: async ({ sessionId }) => {
          const sub = subscriber;
          if (!sub || typeof sub.cancelSession !== "function") return { ok: false, message: "订阅器未就绪" };
          try {
            const r = await sub.cancelSession({ sessionId });
            return r && typeof r === "object" ? r : { ok: Boolean(r) };
          } catch (e) { return { ok: false, message: e && e.message ? e.message : String(e) }; }
        },
        switchSession: async ({ sessionId, title }) => {
          const r = writeImBotsSession(relayDir, "feishu", { sessionId, sessionTitle: title });
          if (r.ok && configNow) configNow = { ...configNow, sessionId, sessionTitle: title || "" };
          return r;
        },
        unbind: async () => {
          try { if (bot && typeof bot.clearBinding === "function") bot.clearBinding(); } catch { /* 忽略 */ }
          return { ok: true };
        },
        statusSnapshot: async () => {
          const bs = bot && typeof bot.status === "function" ? bot.status() : null;
          return {
            connected: state.connected === true,
            authenticated: state.authenticated === true,
            state: state.state,
            lastError: state.lastError || "",
            tier: tierNow(),
            usage: { month: monthKey(clock()), messages: usageThisMonth() },
            messagesPerMonth: Number(limitsNow().messages_per_month || 0),
            remainingMessages: Number(limitsNow().messages_per_month || 0) > 0
              ? Math.max(0, Number(limitsNow().messages_per_month || 0) - usageThisMonth()) : null,
            currentSessionId: String((configNow && configNow.sessionId) || (bs && bs.boundChatId) || ""),
            currentSessionTitle: String((configNow && configNow.sessionTitle) || (bs && bs.boundChatName) || "")
          };
        }
      }
    });
    if (!cmd || !cmd.handled) return false;
    try {
      await bot.sendText(msg.chatId, cmd.text, { receiveIdType: "chat_id" });
    } catch { /* 回复失败不阻塞 */ }
    log.info(`命令 ${cmd.command}${cmd.gated ? "（会员闸拦截）" : ""} 已回复（不转模型）`);
    return true;
  }

  async function onInboundMessage(msg) {
    if (!msg || !msg.text) return;
    const at = Number(clock()) || Date.now();
    // ⓪ 命令层：命中即执行并回复，**绝不进模型**，也不计入额度（/stop、/unbind 永远免费）
    if (await handleInboundCommand(msg)) return;
    // 白名单在 bot 层已过滤；这里做会员闸：派活要 assign.continue + 月度额度
    await refreshTier({ minIntervalMs: 30_000 });
    if (!canCap("assign.continue")) {
      await refreshTier({ force: true }); // 可能是刚升级：再确认一次
      if (!canCap("assign.continue")) {
        const promo = appUrl ? `${appUrl.replace(/\/+$/, "")}/app/promo` : "";
        await bot.sendText(msg.chatId, `当前档位不支持从飞书派活${promo ? `（升级：${promo}）` : ""}。审批与通知不受影响。`, { receiveIdType: "chat_id" });
        log.info(`入站被会员闸拦下（无 assign.continue，tier=${tierNow()}）`);
        return;
      }
    }
    const limit = Number(limitsNow().messages_per_month || 0);
    if (limit > 0 && usageThisMonth() >= limit) {
      await refreshTier({ force: true }); // 可能是刚升级：再确认一次
      const limit2 = Number(limitsNow().messages_per_month || 0);
      if (limit2 > 0 && usageThisMonth() >= limit2) {
        const promo = appUrl ? `${appUrl.replace(/\/+$/, "")}/app/promo` : "";
        await bot.sendText(msg.chatId, `免费额度已用完（每月 ${limit2} 条）${promo ? `，升级后不限：${promo}` : ""}。审批与通知仍免费。`, { receiveIdType: "chat_id" });
        log.info(`入站被额度闸拦下（${usageThisMonth()}/${limit2}，tier=${tierNow()}）`);
        return;
      }
    }
    // 选会话：配置固定 → 订阅器已 follow 的第一个 → listSessions 第一个
    const sub = subscriber;
    let sessionId = configNow?.sessionId || "";
    if (!sessionId && sub && typeof sub.sessions === "function") {
      const list = sub.sessions();
      sessionId = Array.isArray(list) && list.length ? String(list[0]) : "";
    }
    if (!sessionId && sub && typeof sub.listSessions === "function") {
      try {
        const r = await sub.listSessions();
        const rows = Array.isArray(r) ? r : Array.isArray(r?.sessions) ? r.sessions : [];
        sessionId = rows.length ? String(rows[0].sessionId || rows[0].id || "") : "";
      } catch { /* 忽略 */ }
    }
    if (!sessionId || !sub || typeof sub.promptSession !== "function") {
      await bot.sendText(msg.chatId, "还没在电脑端选择要接管的会话：先在电脑上打开一个会话，再从这里发消息。", { receiveIdType: "chat_id" });
      return;
    }
    bumpUsage();
    try {
      await sub.promptSession({ sessionId, text: msg.text });
      await bot.sendText(msg.chatId, "已收到，转给电脑上的会话了。", { receiveIdType: "chat_id" });
    } catch (e) {
      log.warn(`转发入站消息失败：${truncateText(e?.message || e, 120)}`);
      await bot.sendText(msg.chatId, "没转出去：电脑端可能忙或会话已结束，到电脑上看一眼。", { receiveIdType: "chat_id" });
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  function digestOf(cfg) {
    if (!cfg) return "missing";
    const f = cfg;
    let secretHash = "";
    try { secretHash = f.appSecret ? crypto.createHash("sha1").update(String(f.appSecret)).digest("hex") : ""; } catch { secretHash = "?"; }
    return JSON.stringify([
      f.enabled === true, f.appId || "", secretHash, f.domain,
      f.receiveId || "", f.receiveIdType || "", Array.isArray(f.allowFrom) ? f.allowFrom : [],
      f.cardApproval !== false, notifyEnabled, cardApprovalAllowed, f.sessionId || ""
    ]);
  }
  async function stopBot() {
    const b = bot;
    bot = null;
    if (!b) return;
    try { await b.stop(); } catch (e) { log.warn(`停止飞书长连接失败（忽略）：${truncateText(e?.message || e, 100)}`); }
  }
  function unwatchConfig() {
    if (!listener) return;
    try { fs.unwatchFile(configFile, listener); } catch { /* 忽略 */ }
    listener = null;
  }
  function watchConfig() {
    if (listener || !configFile) return;
    listener = () => { void applyConfig(); };
    // persistent:false —— watcher 本身不持有事件循环（bridge 有隧道保活；测试/停止后不会挂住进程）
    try { fs.watchFile(configFile, { interval: pollMs, persistent: false }, listener); } catch (e) {
      log.warn(`监听 im-bots.json 失败（改配置后需重启 bridge）：${truncateText(e?.message || e, 120)}`);
      listener = null;
    }
  }
  async function stopSubscriber() {
    const s = subscriber;
    subscriber = null;
    if (!s) return;
    try { if (typeof s.stop === "function") await s.stop(); } catch { /* 忽略 */ }
  }
  function ensureSubscriber() {
    if (subscriber || !notifyEnabled) return subscriber;
    try {
      if (typeof options.subscriberFactory === "function") subscriber = options.subscriberFactory();
      else {
        const upstream = typeof botOptions.upstream === "function" ? botOptions.upstream : botOptions.upstream;
        if (!upstream) return null;
        subscriber = createEventSubscriber({
          upstream,
          cookie: botOptions.cookie || "",
          log: (levelOrLine, maybeLine) => {
            const line = typeof maybeLine === "string" ? maybeLine : String(levelOrLine || "");
            log.info(line);
          }
        });
      }
      if (subscriber && typeof subscriber.on === "function") {
        subscriber.on("event", (node) => { void onEventNode(node).catch(() => {}); });
        subscriber.on("ready", () => log.info("事件订阅器已就绪（通知可用）"));
        subscriber.on("auth-error", (info) => log.warn(`事件订阅鉴权失败：${truncateText(info?.message || "", 100)}`));
      }
      if (subscriber && typeof subscriber.start === "function") subscriber.start();
      return subscriber;
    } catch (e) {
      log.warn(`事件订阅器启动失败（不影响长连接）：${truncateText(e?.message || e, 120)}`);
      subscriber = null;
      return null;
    }
  }

  async function applyConfig() {
    if (reloading) return;
    reloading = true;
    try {
      if (String(env.DSH_IM_BOTS || "") === "0") {
        state.enabled = false;
        state.reason = "disabled_by_env";
        await stopBot();
        await stopSubscriber();
        writeStatus();
        return;
      }
      const read = relayDir ? readFeishuConfig(relayDir) : null;
      state.configFound = Boolean(read);
      const cfg = read ? read.config : normalizeFeishuConfig({});
      configNow = cfg;
      const digest = digestOf(cfg);
      if (digest === currentDigest) { writeStatus(); return; }
      currentDigest = digest;
      await stopBot();
      await stopSubscriber();
      state.configUpdatedAt = Number(clock()) || Date.now();
      state.lastError = "";

      if (!cfg.enabled) {
        state.enabled = false;
        state.reason = "disabled";
        log.info("im-bots.json 里 feishu.enabled=false，飞书通道不启动");
        writeStatus();
        return;
      }
      if (!cfg.appId || !cfg.appSecret) {
        state.enabled = false;
        state.reason = "missing_credentials";
        state.lastError = "缺少 App ID / App Secret（开发者后台「凭证与基础信息」里复制）";
        log.warn(state.lastError);
        writeStatus();
        return;
      }
      const appCheck = validateAppId(cfg.appId);
      if (!appCheck.ok) {
        state.enabled = false;
        state.reason = "invalid_app_id";
        state.lastError = appCheck.reason || "App ID 不合法";
        log.warn(`飞书 App ID 校验失败：${state.lastError}`);
        writeStatus();
        return;
      }
      const dep = sdkStatusNow();
      if (!dep.installed) {
        state.enabled = false;
        state.reason = "sdk_missing";
        state.lastError = SDK_MISSING_HINT;
        log.info("飞书 SDK 未下载（按需依赖）：面板点「下载依赖」后会自动重试");
        writeStatus();
        return;
      }
      await refreshTier({ force: true });

      try {
        bot = createBot({
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          domain: cfg.domain,
          receiveId: cfg.receiveId,
          receiveIdType: cfg.receiveIdType,
          allowFrom: cfg.allowFrom,
          boundChatId: cfg.boundChatId,
          cardApproval: cardApprovalAllowed && cfg.cardApproval,
          relayDir,
          env,
          clock,
          timers,
          sdkFactory,
          loadSdk,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(botOptions || {}),
          onApprovalDecision,
          logger: options.log
        });
      } catch (e) {
        bot = null;
        state.enabled = false;
        state.reason = "bot_factory_invalid";
        state.lastError = truncateText(e?.message || e, 160);
        log.warn(`创建飞书 bot 失败：${state.lastError}`);
        writeStatus();
        return;
      }
      state.enabled = true;
      state.reason = "starting";
      if (bot && typeof bot.on === "function") {
        bot.on("ready", () => { state.reason = "connected"; writeStatus(); ensureSubscriber(); });
        bot.on("status", () => { writeStatus(); });
        bot.on("message", (msg) => { void onInboundMessage(msg).catch(() => {}); });
      }
      const r = bot && typeof bot.start === "function" ? await bot.start() : { ok: false, reason: "bot_without_start" };
      if (r && r.ok) {
        state.reason = "connected";
        ensureSubscriber();
      } else {
        const bs = bot && typeof bot.status === "function" ? bot.status() : {};
        state.reason = bs.state || r?.reason || "failed";
        state.lastError = (r && (r.error || r.reason)) || bs.lastError || "";
        if (state.reason === "sdk_missing") state.enabled = false;
        log.warn(`飞书通道未就绪（${state.reason}）：${state.lastError}`);
      }
      writeStatus();
    } catch (e) {
      state.enabled = false;
      state.reason = "apply_failed";
      state.lastError = truncateText(e?.message || e, 160);
      log.warn(`应用飞书配置失败（忽略）：${state.lastError}`);
      writeStatus();
    } finally {
      reloading = false;
    }
  }

  function statusSnapshot() {
    return {
      started: state.started,
      enabled: state.enabled,
      configFound: state.configFound,
      reason: state.reason,
      configPath: configFile,
      statusPath: statusFile,
      configUpdatedAt: state.configUpdatedAt,
      lastError: state.lastError,
      deps: sdkStatusNow(),
      bot: bot && typeof bot.status === "function" ? bot.status() : null
    };
  }

  return {
    async start() {
      if (state.started) return statusSnapshot();
      state.started = true;
      hydrateFromStatus();
      if (!relayDir) {
        state.reason = "no_relay_dir";
        log.warn("缺少 relayDir，飞书通道不启动");
        return statusSnapshot();
      }
      await applyConfig();
      watchConfig();
      return statusSnapshot();
    },
    async stop() {
      unwatchConfig();
      state.started = false;
      state.enabled = false;
      state.reason = "stopped";
      await stopBot();
      await stopSubscriber();
      writeStatus();
      return statusSnapshot();
    },
    status: statusSnapshot,
    /** 仅测试。 */
    _bot: () => bot,
    _membership: () => ({ ...membership, usage: { ...membership.usage } })
  };
}

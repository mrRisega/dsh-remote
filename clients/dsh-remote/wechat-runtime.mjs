/**
 * 微信机器人通道 —— **运行时编排层**(bridge 侧)。
 *
 * 分工(见 docs/wechat-bot-channel.md):
 *   · `wechat-channel.mjs`  协议原语:ilink 客户端 / 扫码状态机 / 凭据 / 消息格式化 / 入站解析
 *   · `dsh-events.mjs`      DSH 事件订阅:/api/remote.mux 的 $events 与 session/follow
 *   · **本文件**            把两者拼成一条能跑的生命周期:绑定控制面 + 出站通知路由 + 入站长轮询
 *   · `dsh-bridge.mjs`      只负责 import 本模块、start/stop(见其 runTunnel)
 *
 * 为什么要单独一层:上游两个模块刻意**不做循环**(wechat-channel.mjs 的 unbind 注释写着
 * 「停止长轮询是调用方的事(它持有循环)」),而"谁持有循环、收到事件发给谁、用户回数字对应哪条
 * 通知"是本产品的编排决策,不属于协议层。放在这里也让 bridge 主文件保持精简。
 *
 * 对外两个入口:
 *   · `createWeChatRuntime({...})` → 运行时对象(供 bridge 与测试使用)
 *   · 控制面 HTTP(仅回环 + bridge_secret):供插件宿主半边代理面板请求
 *
 * ⚠️ 安全边界
 *   · 控制面只 bind 127.0.0.1,**绝不** 0.0.0.0
 *   · 端口用 0(临时端口),写进 `.wechat-control.json` 供宿主半边发现
 *   · 每个请求校验 `x-dsh-bridge-secret`(来自 .dsh-config.json,与 bridge 既有密钥同源)
 *   · 面板侧响应一律走 sanitizeAccount() —— **永不回显 bot_token**
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import {
  WeChatChannel,
  startBind,
  createLogger,
  redact,
  saveState,
  loadState,
  sanitizeAccount,
  buildOutboundNotification,
  normalizeInput,
  extractDigits,
  extractInboundText,
  extractFromUserId,
  handleCommand,
  classifyInbound,
  formatCompletion,
  isDestructiveTool,
  renderStatusText,
  stopReasonText,
  isSessionExpired,
  writePrivateJson,
  SessionCooldown,
  SESSION_SUMMARY_MAX,
  DEFAULT_UPDATES_TIMEOUT_MS
} from "./wechat-channel.mjs";
import { createEventSubscriber, NODE_KINDS } from "./dsh-events.mjs";

/**
 * v2:微信不再只是"通知器",而是**能创建会话、下发任务、追问续接**的遥控器。
 *
 * ⚠️ 这改变了安全面:一旦能 `session/prompt`,机器人就能在你电脑上驱动 agent 改文件、跑命令。
 * 所以本文件有两条硬约束(别在重构时弄丢):
 *   ① 通道只在**已绑定**时启动(绑定又要求 bridge 有账号 → 等价于"必须注册登录");
 *   ② **破坏性操作不给一步回执** —— 见 `#notify` 里的 `isDestructiveTool` 分支。
 */

/**
 * v2 能力表(运营钩子) —— 业主 2026-09-22 确认的分层:
 *
 *   · **免费档 = 只读 + 审批**:收得到任务通知(含完成小结、报错、额度、会员到期),
 *     点得了审批回执(选择下一步执行)。但**遥控不了**。
 *   · **付费档 = 免费档 + 遥控**:在微信里直接交代任务、切换会话(以及预留的中途纠偏/附件/多会话)。
 *
 * 免费用户尝试付费能力时,回复里带上 App 链接 —— 这既是解释,也是转化入口
 * (见 `#upsellText()`:业主口径是"如果免费用户要去做其他的东西,就在消息后面跟一个访问 App 的链接")。
 *
 * ⚠️ `pro_max` **必须存在**:服务端的生效套餐取值就是 free / pro / pro_max(见企业端 auth.js 的
 *    PLAN_PRIORITY),而 `capabilitiesFor` 对**未知档位回退 free** —— 漏了 pro_max 就会把
 *    最高的付费档用户当成免费用户挡在门外。
 * ⚠️ 改这张表 = 改产品权限,别顺手加能力;`free` 那行是"用户没付钱时他能做什么"的唯一定义。
 */
const FREE_CAPABILITIES = Object.freeze([
  "notify", "approve", "status", "stop",
  // ★ 业主 2026-09-22 拍板:「免费只能继续已有会话(回复即续接),不能开新会话、不能选用别的会话」。
  //   所以 assign 被**拆成两半**:continue 免费、new 付费 —— 既让免费用户"能接着聊",
  //   又保住"开新任务 / 管会话"是会员能力(否则付费理由就没了)。
  "assign.continue"
]);
const PAID_CAPABILITIES = Object.freeze([
  "notify", "approve", "status", "stop",
  "assign", // 粗粒度授权:按前缀规则天然覆盖 assign.new 与 assign.continue
  "sessions", "summary",
  "steer", "attach", "multi" // 预留:中途纠偏 / 附件 / 多会话并行
]);
export const WECHAT_CAPABILITY_TABLE = Object.freeze({
  free: FREE_CAPABILITIES,
  pro: PAID_CAPABILITIES,
  pro_max: PAID_CAPABILITIES
});

/**
 * 能力授权(点号**前缀规则**)。
 *
 * 配置里写粗粒度 `"assign"` 即授权 `assign` 与 `assign.*`;写细粒度 `"assign.continue"` 只授权它自己。
 * 这样运营既能一键给整块能力,也能只给其中一半。
 * ⚠️ **未知 need 一律不授权**(fail-closed):代码新加了个能力而配置没跟上时,宁可不给。
 */
export function grantsCap(caps, need) {
  if (!Array.isArray(caps) || !need) return false;
  return caps.some((c) => {
    const s = String(c || "");
    return s === need || need.startsWith(`${s}.`);
  });
}

/**
 * 各档位的**额外限制**(与能力表并列,同属"权益包")。
 *
 * `messages_per_month`:该档用户每月最多能给 agent 发多少条消息;**0 或缺省 = 不限**。
 * 业主 2026-09-22:「免费给每月 N 条消息额度,超出再引导升级(可配置,挂在权益包里)」。
 * ⚠️ 只有**派活**(发消息/开任务)计数;审批回执与指令**不计数** ——
 *    否则免费用户会为了省额度而不敢拍板,那等于把安全阀关掉。
 */
export const WECHAT_TIER_LIMITS = Object.freeze({
  free: Object.freeze({ messages_per_month: 20 }),
  pro: Object.freeze({ messages_per_month: 0 }),
  pro_max: Object.freeze({ messages_per_month: 0 })
});

/** 某档位的限制。未知档位按最低档(free)处理 —— 与能力表同一口径。 */
export function limitsFor(tier, table = WECHAT_TIER_LIMITS) {
  const key = Object.prototype.hasOwnProperty.call(table, String(tier || "")) ? String(tier) : "free";
  return table[key] || {};
}

/** 某档位具备哪些能力。未知档位按最低档(free)处理 —— 宁可少给,不可误放。 */
export function capabilitiesFor(tier, table = WECHAT_CAPABILITY_TABLE) {
  const key = Object.prototype.hasOwnProperty.call(table, String(tier || "")) ? String(tier) : "free";
  return table[key];
}

/**
 * 指令 → 所需能力。**没列出的指令不设门槛**（`/help`、`/status`、`/unbind`、`/quiet` 人人可用）。
 *
 * 为什么 `/unbind` 绝不设门槛:免费用户也必须能解绑 —— 否则他被绑上了却退不掉,
 * 这既是骚扰也是合规问题。
 * 为什么 `/stop` 放进免费档:免费用户已经能通过审批「选择下一步执行」,再给一个急停阀是同一件事;
 * 一个只会发通知、却连"停下"都做不到的通道,用户会觉得被挟持。
 */
const COMMAND_CAPABILITY = Object.freeze({
  "/new": "assign.new", // 开新会话 = 付费(「继续已有会话」走 assign.continue,见纯文本分支)
  "/ls": "sessions",
  "/use": "sessions",
  "/summary": "summary",
  "/stop": "stop"
});

/**
 * ★ 两个上游模块的**节点词表不一致**,这里是唯一的翻译点。
 *
 * 背景:`dsh-events.mjs` 与 `wechat-channel.mjs` 是并行开发的两个模块,各自按规格 §5 定了
 * 自己的 kind 名 —— 事件侧用「事件语义」(`approval-request`),文案侧用「展示语义」(`approval`)。
 * 两边单测各自全绿,拼在一起却不认识彼此。翻译放在编排层(本文件)而不是改动任一上游:
 * 上游各自的名字都对,耦合点只有一处,放在这里能被一条测试完整覆盖。
 *
 * ⚠️ 新增节点时必须同时改这里,否则用户收到的是「未知节点」——`assertKindCoverage()` 会先报错。
 */
const EVENT_KIND_TO_FORMATTER_KIND = Object.freeze({
  [NODE_KINDS.APPROVAL_REQUEST]: "approval",
  [NODE_KINDS.USER_QUESTION]: "question",
  [NODE_KINDS.PLAN_REVIEW]: "plan",
  [NODE_KINDS.SESSION_ERROR]: "error",
  [NODE_KINDS.TURN_END]: "stopped",
  [NODE_KINDS.DIGEST_DUE]: "daily",
  [NODE_KINDS.QUOTA_LOW]: "quota",
  [NODE_KINDS.MEMBERSHIP_EXPIRING]: "membership"
});

/** 没有文案模板的节点:不是"漏了",而是按设计另行处理(见 #notify)。 */
const SPECIAL_EVENT_KINDS = Object.freeze([
  NODE_KINDS.EVENT_EXPIRED,
  NODE_KINDS.GAP,
  NODE_KINDS.FAULT
]);

/**
 * **提醒类**节点:它不是"等用户拍板",只是"告诉他一件事 + 顺带给个入口"。
 *
 * 为什么必须单独分一类(2026-09-23 定位到真机问题):
 *   额度提醒与会员到期提醒在文案层是**可回执**的(带「邀请好友 / 知道了」选项,
 *   见 wechat-channel.mjs 的 `optionsFor`),于是它们会被塞进审批队列 `pendingReplies`。
 *   而数字回执按 **FIFO** 认领(微信里消息位置固定,用户从上往下读)——
 *   真机后果:用户看到的是底部**最新那条审批**,回「1」,
 *   回执却落到了**更早的那条额度提醒**上 → 审批没人答,得再回一次才轮到。
 *
 * 所以队列分两类:
 *   · **决策**(审批 / 提问 / 计划)= 需要用户拍板,数字回执优先给它们;
 *   · **提醒**(额度 / 会员到期)= 不占决策位;只有一条决策都没有时,数字才给它们。
 */
const NOTICE_FORMATTER_KINDS = Object.freeze(["quota", "membership"]);

/**
 * 把事件节点翻译成文案节点。
 * @returns {{node: object|null, formatterKind: string}}
 */
export function toFormatterNode(eventNode = {}) {
  const formatterKind = EVENT_KIND_TO_FORMATTER_KIND[eventNode.kind] || "";
  if (!formatterKind) return { node: null, formatterKind: "" };
  const node = { ...eventNode, kind: formatterKind };

  // 字段名对齐:事件侧叫 toolName,文案侧读 tool
  if (node.tool == null && node.toolName != null) node.tool = node.toolName;

  // 提问:事件侧是 questions[{id,question,options[]}],文案侧读 prompt + options[]
  if (formatterKind === "question" || formatterKind === "plan") {
    const q = Array.isArray(node.questions) ? node.questions[0] : null;
    if (q) {
      if (!node.prompt) node.prompt = q.question || q.detail || "";
      if (!Array.isArray(node.options) || !node.options.length) {
        node.options = Array.isArray(q.options) ? q.options : [];
      }
    }
  }

  // 简报:文案侧读 lines[]
  if (formatterKind === "daily" && !Array.isArray(node.lines)) {
    const parts = [];
    if (node.notified != null) parts.push(`今天为你推送了 ${node.notified} 条提醒`);
    if (node.answered != null) parts.push(`你回执了 ${node.answered} 条`);
    if (!parts.length) parts.push("今天暂时没有要你处理的事。");
    node.lines = parts;
  }

  // 停止:事件侧的 reason 是机器值(completed/aborted/…),文案侧自己会翻译,
  // 但 detail 留一份人类可读的,便于排查
  if (formatterKind === "stopped" && node.reason) {
    node.detail = stopReasonText(node.reason);
  }

  return { node, formatterKind };
}

/**
 * 自检:事件侧声明的每个 kind 都必须有归宿(翻译表 或 特殊列表)。
 * 这样"上游新增了节点、编排层忘了接"会**当场**暴露,而不是等用户收到「未知节点」。
 */
export function assertKindCoverage() {
  const missing = Object.values(NODE_KINDS).filter(
    (k) => !EVENT_KIND_TO_FORMATTER_KIND[k] && !SPECIAL_EVENT_KINDS.includes(k)
  );
  if (missing.length) {
    throw new Error(`wechat-runtime: 事件侧新增了未接线的节点 kind: ${missing.join(", ")}(请补 EVENT_KIND_TO_FORMATTER_KIND)`);
  }
  return true;
}

/** 控制面发现文件(宿主半边读它拿端口)。不含密钥 —— 密钥在 .dsh-config.json。 */
export const CONTROL_FILE = ".wechat-control.json";
/** 控制面鉴权头。 */
export const CONTROL_HEADER = "x-dsh-bridge-secret";
/** 绑定会话的默认存活时长(面板上二维码可被扫的时间)。 */
export const DEFAULT_BIND_TTL_MS = 5 * 60_000;
/** 默认每日简报时刻(本地时区小时,0-23)。 */
/**
 * 每日简报时刻(本地小时)。
 *
 * ⚠️ 必须是**晚上**而不是早上:简报的内容是"**今天**干了啥"(已完成/出错/你拍板了几次),
 *    早上 9 点发的时候今天才刚开始,整篇都是空的 —— 业主原话「每天早上发『今日干了啥事儿』,
 *    这肯定不太对劲。应该是晚上发,比如晚上 6 点,发『今天干了啥』」。
 *    它同时兼作微信 24h 推送窗口的心跳,所以一天**只发一次**、不要早晚各一次。
 */
export const DEFAULT_DIGEST_HOUR = 18;
/**
 * 档位校准间隔。10 分钟足够跟上升级/到期(派发被拒时还会立刻再确认一次),
 * 又不至于把账号 API 当心跳打。
 */
export const WECHAT_TIER_REFRESH_MS = 10 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读一个 JSON **文件**(控制面发现文件等)。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 解析请求体里的 JSON **文本**。
 *
 * ⚠️ 必须与 readJson 分开:早先控制面把请求体交给了 readJson,而它是**读文件**的
 * (`fs.readFileSync(<一段 JSON 文本>)` 必然抛错 → 返回 null),于是**所有 POST 体都是 null** ——
 * 表现是「提交配对码」永远回「请输入手机微信上显示的数字」,而且没有任何报错线索。
 * 端到端绑定流程测试抓到了它(wechat-e2e.test.mjs)。
 */
function parseBodyText(text) {
  try {
    const v = JSON.parse(String(text || ""));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** 极简请求体读取(限制体积,防止回环上的畸形请求把内存吃满)。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve("");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

export class WeChatRuntime {
  /**
   * @param {{
   *   relayDir: string,
   *   upstream?: string,              // dsh web 地址,默认 http://127.0.0.1:3080
   *   cookieOf?: () => string,        // 读 .harness-cookie.json 的回调(bridge 已有该逻辑)
   *   secret?: string,                // 控制面密钥(bridge_secret);空则控制面拒绝所有请求
   *   logger?: any,
   *   clock?: () => number,
   *   fetch?: typeof fetch,
   *   port?: number,                  // 控制面端口,0=临时端口(默认)
   *   bindTtlMs?: number,
   *   digestHour?: number,
   *   disabled?: boolean,             // 总开关
   * }} opts
   */
  constructor(opts = {}) {
    if (!opts.relayDir) throw new Error("WeChatRuntime: 缺少 relayDir");
    this.relayDir = opts.relayDir;
    this.upstream = String(opts.upstream || "http://127.0.0.1:3080").replace(/\/+$/, "");
    this.cookieOf = typeof opts.cookieOf === "function" ? opts.cookieOf : () => "";
    this.secret = String(opts.secret || "");
    this.clock = opts.clock || Date.now;
    this.fetchImpl = opts.fetch;
    this.logger = opts.logger || createLogger();
    this.bindTtlMs = opts.bindTtlMs || DEFAULT_BIND_TTL_MS;
    this.digestHour = Number.isInteger(opts.digestHour) ? opts.digestHour : DEFAULT_DIGEST_HOUR;
    this.controlPort = Number.isInteger(opts.port) ? opts.port : 0;
    this.disabled = !!opts.disabled;
    // 冷却时长可注入:生产用 1 小时(与腾讯官方插件一致),测试用短值以便验证"不猛打接口"。
    this.cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs > 0 ? opts.cooldownMs : undefined;

    this.channel = new WeChatChannel({
      relayDir: this.relayDir,
      logger: this.logger,
      clock: this.clock,
      fetch: this.fetchImpl,
      cooldownMs: this.cooldownMs,
      // 未绑定时客户端用这个 baseUrl(生产恒为腾讯 ilink 默认值)。
      // 可注入是为了让「绑定流程」能在本地假上游上被测 —— 否则绑定路径只能靠真机扫码验证。
      baseUrl: opts.baseUrl
    });
    this.subscriber = null;
    this.controlServer = null;
    this.boundPort = 0;

    this.stopping = false;
    this.channelTask = null;
    this.digestTask = null;

    /** 绑定会话(同一时刻至多一个)。 */
    this.bind = null;
    /**
     * 可回执通知的**待答队列**(最近的在末尾)。
     * 微信里用户只回一个数字,消息里不带 eventId(见 buildOutboundNotification 注释),
     * 所以数字必须映射到"最近一条待答通知" —— 这就是那张表存在的理由。
     */
    this.pendingReplies = [];
    /** 当日简报计数(本地,不落盘)。 */
    this.todayStats = { day: "", notified: 0, answered: 0 };

    /**
     * v2「当前会话」指针。**必须从状态文件恢复** —— 否则 bridge 一重启,
     * 用户之前选好的任务就丢了,他再发一句话会静默开成一个**新任务**,
     * 而不是继续原来那个(用户完全无从察觉)。
     */
    const persisted = loadState(this.relayDir);
    this.currentSessionId = persisted.current_session_id || "";
    this.currentSessionTitle = persisted.current_session_title || "";
    /** `/ls` 的结果缓存(1-based 序号供 /use 使用)。 */
    this.sessionIndex = [];
    /**
     * 运营钩子的可注入点(生产由 bridge 注入真实档位;测试可覆盖)。
     * `tierOverride` 空 = 用缓存/默认;`capabilityTable` 空 = 用内置表。
     */
    this.tierOverride = typeof opts.tier === "string" ? opts.tier : "";
    this.capabilityTable = opts.capabilityTable || WECHAT_CAPABILITY_TABLE;
    this.limitTable = opts.limitTable || WECHAT_TIER_LIMITS;
    /**
     * **服务端下发的权益包**(可空):`{rev, plan, caps[], limits{}}`。
     * 空 = 冷启动/还没取到 → 用内置表按档位解析(与今天行为完全一致)。
     * ⚠️ 取自磁盘缓存:进程重启后不会因为一次网络失败就把付费用户降级。
     */
    this.entitlements = (opts.entitlements && typeof opts.entitlements === "object")
      ? opts.entitlements
      : (persisted.entitlements && typeof persisted.entitlements === "object" ? persisted.entitlements : null);
    this.entitlementsRev = String((this.entitlements && this.entitlements.rev) || "");
    /** 免费档的每月消息用量(跨月自动归零)。 */
    this.msgUsage = (persisted.msg_usage && typeof persisted.msg_usage === "object") ? persisted.msg_usage : null;
    /**
     * 真实档位来源(async→ "free"|"pro"|"pro_max";空串 = 这次没取到)。
     * bridge 用账号 API 的生效套餐实现它;不注入时档位恒为缓存/默认(测试与自建)。
     */
    this.tierProvider = typeof opts.tierProvider === "function" ? opts.tierProvider : null;
    /**
     * 账号快照来源(async→ `{plan, plan_ends_at, trial_expires_at}`)。
     * 目前只服务于"会员临近到期提醒" —— bridge 注入时**复用它查档位那次 `/api/me`**,
     * 不额外增加网络请求。不注入 = 不发这类提醒(宁可不发,也不拿猜的到期日骚扰用户)。
     */
    this.accountInfo = typeof opts.accountInfo === "function" ? opts.accountInfo : null;
    /** App 入口(免费用户越界时给的转化链接)。空则不附链接,不编一个假地址。 */
    this.appUrl = String(opts.appUrl || "").trim();
    /**
     * ★ 档位**持久化缓存**:进程重启后不会因为一次网络失败就把付费用户降级成免费。
     * 首次运行且从未取到过 = 空 → 按 free(宁可少给,不可误放)。
     */
    this.cachedTier = String(persisted.tier || "").trim();
    this.tierCheckedAt = 0;
    this.tierTimer = null;
    /**
     * 被拒时重查档位的节流窗口。用户刚升级完重试要能进,但免费用户反复发消息
     * 也不能变成"每条消息打一次账号 API",所以取 5 秒(最坏情况等 5 秒就能进)。
     * 可注入,便于测试把这条路径跑成确定性的。
     */
    this.tierDenyThrottleMs = Number.isFinite(opts.tierDenyThrottleMs) ? opts.tierDenyThrottleMs : 5_000;
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  /** 面板可见状态。**只返回脱敏字段**。 */
  status() {
    const state = loadState(this.relayDir);
    const acct = sanitizeAccount(this.channel.account);
    const cooldownMs = this.channel.cooldown.remainingMs ? this.channel.cooldown.remainingMs() : 0;
    return {
      ok: true,
      disabled: this.disabled,
      bound: !!acct.bound,
      bot_id: acct.botId || "",
      bound_at: acct.boundAt || 0,
      connected_at: state.connected_at || 0,
      last_push_ok_at: state.last_push_ok_at || 0,
      last_error: state.last_error || "",
      cooldown_ms: cooldownMs,
      // 只数**待拍板**的(不含额度/会员到期这类提醒):面板上的数字要与用户真实要做的决定一致
      pending_replies: this.#decisionCount(),
      // ★ 面板要把「你现在能用什么」如实展示出来(业主:话术与权限必须一致,不多承诺)。
      //   这里下发的是**通道实际在用**的那一份(服务端权益包优先,否则内置表按档位),
      //   所以面板不需要自己猜档位 → 展示与判定不可能不一致。
      plan: this.#tier(),
      caps: this.#caps(),
      limits: this.#limits(),
      entitlements_source: this.entitlements && this.entitlements.caps ? "server" : "builtin",
      messages_used_this_month: (this.msgUsage && this.msgUsage.month === this.#monthKey())
        ? Number(this.msgUsage.count || 0)
        : 0,
      // ⚠️ 失败/成功后 bind.done=true 但仍留着对象 —— 必须一起判,否则面板在绑定失败后
      // 会一直显示"正在绑定"(真机实测撞到:超时后 binding.active 还是 true)。
      binding: this.bind && !this.bind.done
        ? { active: true, need_verify_code: !!this.bind.needVerifyCode }
        : { active: false, failed: !!(this.bind && this.bind.done && !this.bind.result) },
      channel_running: !!this.channelTask,
      events_running: !!this.subscriber
    };
  }

  /** 通知文案里用的机器人自称与奖励口径(与产品口径同源)。 */
  #notifyOpts() {
    return { botName: "ClawBot" };
  }

  // ── 控制面 HTTP ─────────────────────────────────────────────────────────

  /** 启动控制面(仅回环)。端口写进发现文件。 */
  async startControl() {
    if (this.controlServer) return this.boundPort;
    this.controlServer = http.createServer((req, res) => {
      this.#handleControl(req, res).catch((e) => {
        try { sendJson(res, 500, { ok: false, error: redact(String(e && e.message ? e.message : e)) }); } catch { /* 已断开 */ }
      });
    });
    // ★ 只 bind 回环 —— 控制面能改机器人绑定,绝不能暴露到局域网/公网。
    await new Promise((resolve, reject) => {
      this.controlServer.once("error", reject);
      this.controlServer.listen(this.controlPort, "127.0.0.1", () => {
        this.controlServer.removeListener("error", reject);
        resolve();
      });
    });
    this.boundPort = this.controlServer.address().port;
    this.#publishControlFile();
    this.logger.info(`[wechat] 控制面已就绪 127.0.0.1:${this.boundPort}(仅回环 + 密钥)`);
    return this.boundPort;
  }

  #publishControlFile() {
    try {
      writePrivateJson(
        path.join(this.relayDir, CONTROL_FILE),
        { port: this.boundPort, pid: process.pid, started_at: this.clock(), header: CONTROL_HEADER },
        (m) => this.logger.warn(m)
      );
    } catch (e) {
      this.logger.warn(`[wechat] 写控制面发现文件失败:${redact(String(e.message || e))}`);
    }
  }

  async #handleControl(req, res) {
    if (!this.secret) {
      // 没有密钥 = 拒绝一切(而不是放行)—— 避免配置缺失时控制面变成开放后门。
      return sendJson(res, 403, { ok: false, error: "bridge_secret 未配置,控制面已禁用" });
    }
    const got = String(req.headers[CONTROL_HEADER] || "");
    if (got !== this.secret) return sendJson(res, 401, { ok: false, error: "unauthorized" });

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;
    const body = req.method === "POST" ? parseBodyText(await readBody(req)) : null;

    switch (route) {
      case "GET /wechat/status":
        return sendJson(res, 200, this.status());

      case "POST /wechat/bind/start": {
        const r = await this.beginBind();
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      case "GET /wechat/bind/poll": {
        const r = await this.pollBind();
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      case "POST /wechat/bind/verify": {
        const r = this.submitVerifyCode(body && body.code);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      case "POST /wechat/bind/cancel":
        return sendJson(res, 200, this.cancelBind());

      case "POST /wechat/unbind":
        return sendJson(res, 200, await this.unbind());

      default:
        return sendJson(res, 404, { ok: false, error: `no such route: ${route}` });
    }
  }

  async stopControl() {
    const srv = this.controlServer;
    this.controlServer = null;
    if (!srv) return;
    await new Promise((resolve) => srv.close(() => resolve()));
    try { fs.rmSync(path.join(this.relayDir, CONTROL_FILE), { force: true }); } catch { /* 忽略 */ }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  async start() {
    if (this.disabled) {
      this.logger.info("[wechat] 已按配置禁用(DSH_WECHAT=0)");
      return { ok: true, disabled: true };
    }
    await this.startControl();
    if (this.channel.account) {
      await this.startChannel();
    } else {
      this.logger.info("[wechat] 未绑定微信,等待面板发起绑定");
    }
    this.#startDigestTimer();
    return { ok: true, port: this.boundPort, bound: !!this.channel.account };
  }

  async stop() {
    this.stopping = true;
    this.cancelBind();
    if (this.digestTask) { clearInterval(this.digestTask); this.digestTask = null; }
    await this.stopChannel();
    await this.stopControl();
  }

  // ── 出站通道(绑定后才起) ──────────────────────────────────────────────

  async startChannel() {
    if (this.channelTask || !this.channel.account) return false;
    this.stopping = false;
    this.channel.writeState({ connected_at: this.clock(), last_error: "" });
    // 档位:启动时取一次(不等它,别拖慢上线),之后每 10 分钟校准一次。
    // 用户升级后不必重启 bridge —— 下一次派发时的 #canNow 还会立刻再确认一遍。
    void this.#refreshTier(0);
    if (!this.tierTimer) {
      this.tierTimer = setInterval(() => { void this.#refreshTier(0); }, WECHAT_TIER_REFRESH_MS);
      if (typeof this.tierTimer.unref === "function") this.tierTimer.unref();
    }
    this.#startSubscriber();
    this.channelTask = this.#channelLoop().catch((e) => {
      this.logger.warn(`[wechat] 长轮询退出:${redact(String(e && e.message ? e.message : e))}`);
      this.channelTask = null;
    });
    return true;
  }

  async stopChannel() {
    this.stopping = true;
    if (this.tierTimer) {
      clearInterval(this.tierTimer);
      this.tierTimer = null;
    }
    if (this.subscriber) {
      try { this.subscriber.close(); } catch { /* 忽略 */ }
      this.subscriber = null;
    }
    const task = this.channelTask;
    this.channelTask = null;
    if (task) { try { await Promise.race([task, sleep(1500)]); } catch { /* 忽略 */ } }
    // 通知腾讯侧"通道客户端下线"
    try {
      if (this.channel.account) {
        this.channel.client.setToken(this.channel.account.token);
        await this.channel.client.notifyStop({});
      }
    } catch (e) {
      this.logger.warn(`[wechat] notifystop 失败(忽略):${redact(String(e && e.message ? e.message : e))}`);
    }
  }

  /**
   * 入站长轮询。user 的回复经此进来。
   *
   * 退避策略:命中 errcode -14(session timeout)时**不重试**,按腾讯官方插件的做法
   * 冷却 1 小时(§3)——否则会把接口打爆,而且掩盖真正的失效原因。
   */
  async #channelLoop() {
    // 上线信号:告诉腾讯侧"通道客户端起来了"(§3 notifystart)
    try {
      await this.channel.client.notifyStart({});
    } catch (e) {
      this.logger.warn(`[wechat] notifystart 失败(继续):${redact(String(e && e.message ? e.message : e))}`);
    }
    this.channel.writeState({ connected_at: this.clock(), last_error: "" });

    while (!this.stopping) {
      // ⚠️ SessionCooldown **没有** isActive() —— 它只有 remainingMs()/remainingMinutes()/arm()。
      // 早先这里写成 `cooldown.isActive && cooldown.isActive()` 会静默短路成 false,
      // 后果是 -14 冷却**完全不生效**、命中 session timeout 后仍继续猛打接口。
      // 这正是本模块要防的事,所以只用 remainingMs() 判,并由测试锁死。
      const cooldownMs = this.channel.cooldown.remainingMs();
      if (cooldownMs > 0) {
        await sleep(Math.min(60_000, Math.max(1000, cooldownMs)));
        continue;
      }
      let resp;
      try {
        resp = await this.channel.client.getUpdates({
          buf: this.channel.updatesBuf,
          timeoutMs: DEFAULT_UPDATES_TIMEOUT_MS
        });
      } catch (e) {
        this.#noteFailure(`getupdates 失败:${redact(String(e && e.message ? e.message : e))}`);
        await sleep(3000);
        continue;
      }
      if (isSessionExpired(resp)) {
        this.channel.noteSessionExpired("getupdates");
        continue;
      }
      if (typeof resp.get_updates_buf === "string") this.channel.updatesBuf = resp.get_updates_buf;
      for (const msg of Array.isArray(resp.msgs) ? resp.msgs : []) {
        try { await this.handleInbound(msg); } catch (e) {
          this.logger.warn(`[wechat] 处理入站消息失败:${redact(String(e && e.message ? e.message : e))}`);
        }
      }
    }
  }

  // ── 入站:回执与指令 ────────────────────────────────────────────────────

  /** 取"最近一条待答通知"(用户回数字时映射到它)。 */
  /**
   * 取"**最早**一条待答通知"。
   *
   * ⚠️ 必须是**先进先出**,不能取最近一条。真机 bug(业主报的):
   *    「如果需要用户回应多条消息,而用户一开始只看到第一条审批消息,回应一个数字之后,
   *      流程就结束了,后面的几条消息没有让用户继续回应,直接提示为『未回应』」
   *    成因:旧实现按栈顶(最新那条)匹配数字,而**微信是从上往下读的**、消息一发出去位置就固定 ——
   *    用户看着第 1 条回「1」,系统却答了最后一条,第 1 条于是永远没人回应。
   */
  #oldestPending() {
    // 先清掉已被消费/过期的,再看队列
    this.pendingReplies = this.pendingReplies.filter((p) => this.channel.registry.get(p.eventId));
    // ★ **决策优先**:数字回执是给"要用户拍板的事"用的。
    //   提醒类(额度/会员到期)只是告知 + 顺带入个口,不能抢走审批的回执位 ——
    //   否则用户看着底部那条审批回「1」,回执却落到更早的提醒上(真机复现过)。
    const decisions = this.pendingReplies.filter((p) => !p.notice);
    if (decisions.length) return decisions[0];
    // 一条决策都没有 → 才轮到提醒(它的「邀请好友 / 知道了」这时才有意义)
    return this.pendingReplies[0] || null;
  }

  /** 待**拍板**的条数(不含提醒类)。 */
  #decisionCount() {
    return this.pendingReplies.filter((p) => !p.notice).length;
  }

  /**
   * 答完一条后,把**下一条**待拍板的重新发到底部。
   *
   * 这是"多条审批"体验的关键一步:微信消息位置固定,用户永远在**底部的那条**上回数字。
   * 把下一条重发到底部 ⇒ "用户正在看的那条"就恒等于"系统会作答的那条"(FIFO),两种直觉对齐。
   * 不重发的话,用户得往上翻去找哪条还没答 —— 翻错就又是"答错对象"。
   *
   * 只发**紧凑提醒**(完整内容在聊天记录里已有),不复用完整模板:避免重复长文、也避免再占一个回执编号。
   */
  async #resurfaceNext(from) {
    const pending = this.#oldestPending();
    if (!pending) return;
    const entry = this.channel.registry.get(pending.eventId);
    const opts = Array.isArray(entry && entry.options) ? entry.options : [];
    if (!opts.length) return; // 不可回执的(如破坏性审批)不再提示
    const task = String((pending.node && (pending.node.toolName || pending.node.title)) || "").trim();
    const lines = [`还有 ${this.#decisionCount()} 条待你拍板：`];
    if (task) lines.push(`· ${task}`);
    lines.push("");
    opts.forEach((o, i) => lines.push(`回复 ${i + 1} = ${o.label}`));
    await this.reply(from, lines.join("\n"));
  }

  /** 处理一条入站消息(回执 / 指令 / 交代任务)。公开以便 bridge 与测试直接驱动。 */
  async handleInbound(msg) {
    const from = extractFromUserId(msg);
    const text = normalizeInput(extractInboundText(msg));
    if (!text) return;

    // 内部统计:任何入站互动都算一次"窗口续期"事件
    this.#bumpToday();

    // ── v2 分派:命令 → 数字 → 普通消息 ────────────────────────────────────
    // ⚠️ 顺序不能换:
    //   · 命令必须最先 —— 否则「/new 修个 bug」会被当成一条发给会话的普通消息;
    //   · 数字必须优先于普通消息 —— 否则用户回复「1」做审批时,会被当成给会话的文本发进去。
    const cls = classifyInbound(text);

    if (cls.kind === "command") {
      await this.#runCommand(from, cls);
      return;
    }
    if (cls.kind === "choice") {
      await this.#answerChoice(from, cls.choice);
      return;
    }
    if (cls.kind === "message") {
      // 纯文本 = 派活。★ 分两种(业主 2026-09-22 拍板):
      //   · **有当前会话** → 「继续已有会话」= assign.continue —— **免费也有**(让免费用户能接着聊)
      //   · **没有当前会话** → 等同开新任务 = assign.new —— 付费才有
      //   这样既满足"能继续聊",又保住"开新任务/管会话"是会员能力。
      const need = this.currentSessionId ? "assign.continue" : "assign.new";
      if (!(await this.#canNow(need))) {
        // ⚠️ 陷阱:回执只认**纯数字**(见 classifyInbound)。免费档的核心价值恰恰是审批,
        //    用户很可能打字「允许」而不是回「1」—— 若只回一句付费提示,他会以为免费版什么都干不了。
        //    所以手上有待回执的消息时,先把"回数字就能拍板"说在前面。
        const waiting = this.#decisionCount();
        const head = waiting > 0
          ? `你还有 ${waiting} 条待你拍板的消息 —— 直接回一个数字(如 1)就能完成决定,不用打字。\n\n`
          : "";
        await this.reply(from, head + this.#upsellText());
        return;
      }
      await this.#sendToSession(from, cls.text);
      return;
    }
  }

  /**
   * 当前账号档位。可用 `opts.tier` 覆盖(测试注入);否则用**上次成功取到的档位**。
   * 从没取到过 = 空 → 按 free(宁可少给,不可误放)。
   */
  #tier() {
    if (this.tierOverride) return this.tierOverride;
    return this.cachedTier || "free";
  }

  /**
   * 当前生效的**能力集合**。
   * 优先用服务端权益包下发的 caps;没有才按档位查内置表(冷启动兜底)。
   * 这样"后台改权限无需发版"就成立了 —— 而内置表保证即使服务端没给也不会瞎放权。
   */
  #caps() {
    const server = this.entitlements && Array.isArray(this.entitlements.caps) ? this.entitlements.caps : null;
    // ⚠️ 判据是「**是不是数组**」,不是「数组非空」(2026-09-23 修):
    //   服务端下发 `caps: []` 是**权威的"这一档什么都不能做"**(后台明确清空,契约 §4.1)。
    //   写成 `server.length` 会把空数组当成"没给",于是回退**内置表** ——
    //   本该"什么都不能做"的档位拿回内置的一整套能力(付费档尤其严重),方向正好是 fail-open。
    if (server) return server;
    return capabilitiesFor(this.#tier(), this.capabilityTable);
  }

  /** 当前生效的限制(服务端权益包优先,否则内置表按档位)。 */
  #limits() {
    const server = this.entitlements && this.entitlements.limits;
    if (server && typeof server === "object") return server;
    return limitsFor(this.#tier(), this.limitTable);
  }

  /** 当前档位是否具备某能力(运营钩子的唯一判断入口)。 */
  #can(cap) {
    return grantsCap(this.#caps(), cap);
  }

  /** 月份键(用量按月归零)。 */
  #monthKey(now = this.clock()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  /**
   * **每月消息额度闸**(业主 2026-09-22:免费给每月 N 条,超出引导升级)。
   * `messages_per_month` 为 0/缺省 = 不限(付费档走这条)。
   * ⚠️ 只在**派活**前拦;审批回执与指令不计数、也不拦 ——
   *    否则免费用户会为了省额度不敢拍板,那等于把安全阀关掉。
   */
  #msgQuotaGate() {
    const limit = Number((this.#limits() || {}).messages_per_month || 0);
    if (!Number.isFinite(limit) || limit <= 0) return { ok: true };
    const month = this.#monthKey();
    const used = this.msgUsage && this.msgUsage.month === month ? Number(this.msgUsage.count || 0) : 0;
    if (used < limit) return { ok: true };
    return {
      ok: false,
      text: `本月的 ${limit} 条消息额度已经用完了(下个月 1 号自动恢复)。\n\n${this.#upsellText()}`
    };
  }

  /** 记一条消息用量。**只在真的派出去之后调用**(发失败不该扣额度)。 */
  #msgQuotaBump() {
    const month = this.#monthKey();
    const used = this.msgUsage && this.msgUsage.month === month ? Number(this.msgUsage.count || 0) : 0;
    this.msgUsage = { month, count: used + 1 };
    this.channel.writeState({ msg_usage: this.msgUsage });
  }

  /**
   * 刷新档位(带节流)。**取不到时保留上次已知档位** —— 网络抖一下就把付费用户降级成免费,
   * 他会看到"升级后即可使用"而自己明明付过钱,这比多给几分钟权限糟糕得多。
   * @returns {Promise<string>} 刷新后的档位
   */
  async #refreshTier(minIntervalMs = 30_000) {
    if (!this.tierProvider) return this.#tier();
    const now = Date.now();
    if (now - this.tierCheckedAt < minIntervalMs) return this.#tier();
    this.tierCheckedAt = now;
    let got = null;
    try {
      got = await this.tierProvider();
    } catch (e) {
      this.logger.warn(`[wechat] 读取账号档位失败(沿用上次):${redact(String(e && e.message ? e.message : e))}`);
      return this.#tier();
    }
    // 兼容两种契约:字符串(旧:只给档位)与对象(权益包:档位 + 能力 + 限制 + 版本号)
    const isObj = Boolean(got) && typeof got === "object";
    const plan = String((isObj ? got.plan : got) || "").trim();
    if (!plan) return this.#tier(); // 空 = 这次没取到 → 沿用缓存(绝不降级)
    // ★ 判据是「caps 是**数组**」,**空数组也算权威**(2026-09-23 修):
    //   空数组 = 服务端明确表达"这一档什么都不能做"(后台"清空",契约 §4.1)。
    //   若把空数组当成"没给",会沿用上次那份包(或回退内置表)——
    //   于是"清空 pro"变成"pro 拿回内置的一整付费套能力",比意图**更多**权限(fail-open)。
    const caps = isObj && Array.isArray(got.caps) ? got.caps : null;
    const limits = isObj && got.limits && typeof got.limits === "object" ? got.limits : null;
    const rev = isObj ? String(got.rev || "") : "";
    const planChanged = plan !== this.cachedTier;
    const bundleIncoming = Boolean(caps || limits);
    this.cachedTier = plan;
    if (bundleIncoming) {
      // 服务端给了权益包 → 以它为准;没给的字段保留上次(不因为缺字段就把能力清空)
      this.entitlements = {
        rev,
        plan,
        caps: caps || (this.entitlements && this.entitlements.caps) || null,
        limits: limits || (this.entitlements && this.entitlements.limits) || null
      };
      this.entitlementsRev = rev;
    }
    if (planChanged || bundleIncoming) {
      this.channel.writeState(bundleIncoming ? { tier: plan, entitlements: this.entitlements } : { tier: plan });
      if (planChanged) this.logger.info(`[wechat] 账号档位:${plan}${bundleIncoming ? "(含权益包)" : ""}`);
    }
    return this.#tier();
  }

  /**
   * 判能力时先**确保档位是新鲜的**:用户刚买完重试必须能进(最坏等 `tierDenyThrottleMs`,
   * 默认 5 秒),而不是等到下次重启 bridge 才发现"我付了钱还是不能用"。
   */
  async #canNow(cap) {
    if (this.#can(cap)) return true;
    await this.#refreshTier(this.tierDenyThrottleMs);
    return this.#can(cap);
  }

  /**
   * 立刻校准一次档位(不走节流)。
   *
   * 存在的理由:这是唯一能**主动**触发校准的入口 —— 其余触发点都被"当前档位够用就不查"
   * 拦在前面(`#canNow` 只在被拒时才查),于是一条关键不变量没法被测到:
   * 「provider 返回空串时必须沿用上次档位,而不是降级」。付费用户的钱包就挂在这条上。
   * 将来面板做"我刚买完,立刻校准"也走这里。
   */
  async refreshTierNow() {
    return this.#refreshTier(0);
  }

  /**
   * 帮助文案。**必须按档位如实分层**。
   *
   * 为什么不能直接用上游那个静态 HELP_TEXT:它把 `/new`、`/ls`、`/use` 与"直接发一句话"
   * 都列成"你能用的",而 `#upsellText()` 正是让免费用户"回复 /help 看现在能做什么" ——
   * 那等于把人骗到一个他做不到的清单上,然后每次尝试都吃一次拒绝。
   */
  #helpText() {
    // ★ 逐条**按实际能力**生成,不再用"档位名"或"有没有粗粒度 assign"来猜。
    //
    // 为什么必须改(2026-09-23,后台可配权限之后才暴露):管理员可以把 caps 配得很细 ——
    // 只勾细粒度 `assign.new` 而不勾粗粒度根 `assign` 时,旧的 `#can("assign")` 返回**假**,
    // 于是**付费用户**拿到一份写着"你没有这些功能"的免费档帮助;
    // 反过来(勾了粗根又关掉某个子能力)则会把做不到的指令列成"你能用的"。
    // 两个方向都违反业主红线「话术与权限必须一致、不多承诺」。
    // 现在每一行都挂一个判据,能不能用由 `#can(...)` **逐条**决定。
    const canNew = this.#can("assign.new");
    const canContinue = this.#can("assign.continue");
    const rows = [
      { ok: this.#can("approve"), text: "· 回数字(如 1)回执最近一条需要你拍板的消息" },
      { ok: this.#can("stop"), text: "· /stop 中断当前会话正在跑的回合" },
      { ok: this.#can("status"), text: "· /status 查看绑定与推送状态" },
      { ok: true, text: "· /quiet 暂停推送(回复任意消息恢复)" }, // 本地开关,不需要任何能力
      { ok: true, text: "· /unbind 解除微信绑定" },
      // 「接着当前任务聊」与「开新任务」是**两个独立能力**(业主 2026-09-22 拍板把 assign 拆成两半),
      // 所以这里也拆成两行、各自判各自的:免费用户会看到第一行可用、第二行落在会员区。
      // ⚠️ 行内**不要**再写"会员功能"三个字 —— 那是下面分区标题的专属词,
      //    混进可用段会让"会员区之前不得出现 /new"这类结构断言失准(读起来也乱)。
      { ok: canContinue, text: "· 直接发一句话 = 接着当前任务聊" },
      { ok: canNew, text: "· /new <任务> 开新任务(直接发一句话也行)" },
      { ok: this.#can("sessions"), text: "· /ls 列出会话、/use <编号> 切换会话" },
      { ok: this.#can("summary"), text: "· /summary 重发最近结论" }
    ];
    const usable = rows.filter((r) => r.ok);
    const locked = rows.filter((r) => !r.ok);
    // 「通知版」这个标签说的是**档位画像**,不是"有缺项" —— 判据必须是
    // "他有没有能在微信里**干活**的能力"(开新任务 / 管会话 / 要小结)。
    // ⚠️ 曾经写成 `locked.length ? 通知版 : ...`:后台把 caps 配细之后,
    //    一个能开新任务的付费用户只要缺了 summary 就会被标成"通知版" —— 那是错的画像。
    const workCaps = ["assign.new", "sessions", "summary"];
    const isNoticeOnly = !workCaps.some((c) => this.#can(c));
    const lines = [
      `【DSH 微信通道${isNoticeOnly ? " · 通知版" : ""}】`,
      "现在能用的:",
      ...usable.map((r) => r.text)
    ];
    if (locked.length) {
      lines.push("", "会员功能(开通后可用):", ...locked.map((r) => r.text));
      if (this.appUrl) lines.push("", `👉 开通并查看设备列表:${this.appUrl}`);
    }
    return lines.join("\n");
  }

  /**
   * 免费用户越界时的回复:说清「通知版能做什么」+ 给出可点击的 App 链接。
   *
   * 业主口径:免费用户要去做别的事情时,就在消息后面跟一个访问 App 的链接,
   * 点一下就能到我们的 App 界面 —— 这既是解释,也是把用户引回远程控制主功能的入口。
   * ⚠️ 微信不渲染 Markdown,所以这里用「」和纯文本,不要写 `**`。
   */
  #upsellText() {
    const lines = [
      "微信机器人当前是「通知版」:",
      "· 能收到任务通知、完成小结,以及需要你审批的请求",
      "· 在微信里直接交代任务、切换会话属于会员功能"
    ];
    if (this.appUrl) {
      lines.push("", `👉 打开 App 查看设备列表、远程控制你的电脑:${this.appUrl}`);
    }
    lines.push("", "回复 /help 可以看到现在能做什么。");
    return lines.join("\n");
  }

  /**
   * 免费档的任务收尾话术。
   * 默认那句「回复就能接着做」对免费用户是**空头承诺**(他回复只会拿到付费引导),
   * 所以换成"会员可用 + App 链接",把用户引到主功能上去。
   */
  #continuationHint() {
    const tail = this.appUrl ? `打开 App 继续:${this.appUrl}` : "打开 App 即可继续。";
    return `在微信里接着交代下一步属于会员功能。${tail}`;
  }

  /** 指令分派。 */
  async #runCommand(from, cls) {
    const cmd = cls.command;
    const args = cls.args || "";

    // ★ 运营钩子:能力表在**每次派发**时真的被查 —— 它是活代码,不是文档。
    //   先 `#canNow` 刷新档位再判:用户刚升级完立刻重试必须能进。
    const need = COMMAND_CAPABILITY[cmd];
    if (need && !(await this.#canNow(need))) {
      await this.reply(from, this.#upsellText());
      return;
    }

    if (cmd === "/unbind") {
      await this.reply(from, "正在为你解绑微信机器人…");
      await this.unbind();
      return;
    }
    if (cmd === "/quiet") {
      this.channel.writeState({ quiet: true });
      await this.reply(from, "已开启免打扰:之后只推需要你决定的与报错,不再推日常状态。回复 /status 查看,回复任意消息可恢复。");
      return;
    }
    if (cmd === "/new") {
      await this.#cmdNew(from, args);
      return;
    }
    if (cmd === "/ls") {
      await this.#cmdList(from);
      return;
    }
    if (cmd === "/use") {
      await this.#cmdUse(from, args);
      return;
    }
    if (cmd === "/stop") {
      await this.#cmdStop(from);
      return;
    }
    if (cmd === "/summary") {
      await this.#cmdSummary(from);
      return;
    }
    if (cmd === "/status") {
      await this.#cmdStatus(from);
      return;
    }
    if (cmd === "/help") {
      await this.reply(from, this.#helpText());
      return;
    }
    // 未知指令:**绝不静默**,而且必须用**按档位分层**的帮助。
    //
    // ⚠️ 这里以前直接透传上游 `handleCommand()` 的 replyText,而它拼的是**静态** HELP_TEXT ——
    //    那份清单把 `/new`、`/ls`、`/use`、`/summary` 与"直接发一句话"一并列成"你能用的"。
    //    免费用户敲错一个字,拿到的就是这张会员清单:照着做 → 再吃一次拒绝,
    //    于是"打错命令"被理解成"这功能坏了"。业主红线是「话术与权限必须一致、不多承诺」,
    //    而 `#helpText()` 存在的唯一理由就是按档位如实分层(见它的注释)。
    //    另外把用户敲的那条**原样回显** —— 他才知道是哪个字打错了。
    if (cmd) {
      await this.reply(from, `不认识这条指令:${cmd}\n\n${this.#helpText()}`);
      return;
    }
    // 兜底:理论上到不了(入站非空文本必带 command),但绝不静默吞掉
    const r = handleCommand(cmd, args);
    await this.reply(from, (r && r.replyText) || "可用指令:/help");
  }

  // ── v2:会话遥控 ────────────────────────────────────────────────────────

  /** 当前会话指针落盘(重启后仍记得你在跟哪个任务)。 */
  #rememberSession(sessionId, title) {
    this.currentSessionId = sessionId || "";
    this.currentSessionTitle = title || "";
    this.channel.writeState({ current_session_id: this.currentSessionId, current_session_title: this.currentSessionTitle });
  }

  /** 拉一次会话列表(带标题),并记住 1-based 序号供 /use 使用。 */
  async #sessions() {
    if (!this.subscriber || typeof this.subscriber.listSessions !== "function") return null;
    const r = await this.subscriber.listSessions();
    if (!r || !r.ok) return null;
    this.sessionIndex = r.sessions || [];
    return this.sessionIndex;
  }

  /**
   * `/new [任务]` —— 建一个 DSH 会话,可选地立刻把任务下发进去。
   * 默认**沿用最近项目**(cwd 取最近一个会话的 cwd);要换项目就显式给路径,
   * 避免把简单事做复杂(业主拍板)。
   */
  async #cmdNew(from, task) {
    if (!this.subscriber || typeof this.subscriber.createSession !== "function") {
      await this.reply(from, "暂不可用:DSH 会话服务未就绪。");
      return;
    }
    // ⚠️ 额度闸必须在**建会话之前** —— 否则超额时会在 DSH 里留下一个空会话(白占一个任务的坑)
    const gate = this.#msgQuotaGate();
    if (!gate.ok) {
      await this.reply(from, gate.text);
      return;
    }
    const list = await this.#sessions();
    let cwd = "";
    if (list && list.length) {
      // 优先沿用**当前会话**的项目,没有则用最近用过的那个
      const cur = list.find((s) => s.sessionId === this.currentSessionId);
      cwd = (cur && cur.cwd) || (list[0] && list[0].cwd) || "";
    }

    const created = await this.subscriber.createSession(cwd ? { cwd } : {});
    if (!created || !created.ok) {
      await this.reply(from, `开新任务失败:${(created && created.message) || "未知错误"}`);
      return;
    }
    this.#rememberSession(created.sessionId, "");
    const short = String(created.sessionId).replace(/^session-/, "").slice(0, 8);

    const text = String(task || "").trim();
    if (!text) {
      await this.reply(from, `已开新任务 ${short}。把要做的直接发给我就行(回复任意内容即下发)。`);
      return;
    }
    const sent = await this.subscriber.promptSession({ sessionId: created.sessionId, text });
    if (!sent || !sent.ok) {
      await this.reply(from, `新任务 ${short} 已建立,但下发失败:${(sent && sent.message) || "未知错误"}`);
      return; // 没派出去 → 不扣额度
    }
    this.#msgQuotaBump();
    await this.reply(from, `已开新任务 ${short} 并下发。跑完我会推结论给你;中途想补充直接回话即可。`);
    // ★ 额度消耗**之后**才可能提醒(必须排在 bump 之后:提醒要看到刚扣掉的这一条)。
    //   放在回执之后:提醒落在"已下发"下面,读起来是补充说明而不是打断。
    //   fire-and-forget:提醒是锦上添花,绝不能因为它失败/变慢而影响派活这条主流程。
    this.#maybeRemindQuota().catch(() => {});
  }

  /** `/ls` —— 列出最近会话(带名称),供 /use 选择。 */
  async #cmdList(from) {
    const list = await this.#sessions();
    if (!list) {
      await this.reply(from, "暂时拿不到会话列表(DSH 会话服务未就绪)。");
      return;
    }
    if (!list.length) {
      await this.reply(from, "还没有任何会话。发一句话给我就能开一个新任务。");
      return;
    }
    const top = list.slice(0, 9);
    const lines = ["最近的会话(回 /use <编号> 切换):"];
    top.forEach((s, i) => {
      const name = s.title || "(未命名)";
      const mark = s.sessionId === this.currentSessionId ? " ←当前" : "";
      const run = s.running ? " ▶运行中" : "";
      lines.push(`${i + 1}. ${name}${run}${mark}`);
    });
    lines.push("纯文本默认发给「当前」会话;想开新的用 /new。");
    await this.reply(from, lines.join("\n"));
  }

  /** `/use <n>` —— 切换当前会话。 */
  async #cmdUse(from, args) {
    const list = (this.sessionIndex && this.sessionIndex.length) ? this.sessionIndex : await this.#sessions();
    if (!list || !list.length) {
      await this.reply(from, "还没有会话可选。先用 /ls 看看,或 /new 开一个。");
      return;
    }
    const n = Number(String(args || "").trim());
    if (!Number.isInteger(n) || n < 1 || n > list.length) {
      await this.reply(from, `编号不对。请回 /use 1 到 /use ${list.length} 之间的数字(先 /ls 看列表)。`);
      return;
    }
    const s = list[n - 1];
    this.#rememberSession(s.sessionId, s.title || "");
    await this.reply(from, `已切到:${s.title || "(未命名)"}${s.running ? "(运行中)" : ""}。之后你发的话都进这个任务。`);
  }

  /** `/stop` —— 中断当前会话正在跑的回合。 */
  async #cmdStop(from) {
    if (!this.currentSessionId) {
      await this.reply(from, "现在没有选中的会话。/ls 看看要停哪个,或 /use <编号> 选中它。");
      return;
    }
    if (!this.subscriber || typeof this.subscriber.cancelSession !== "function") {
      await this.reply(from, "暂不可用:DSH 会话服务未就绪。");
      return;
    }
    const r = await this.subscriber.cancelSession({ sessionId: this.currentSessionId });
    await this.reply(from, r && r.ok ? "已发出中断。任务停下后我会把状态推给你。" : `中断失败:${(r && r.message) || "未知错误"}`);
  }

  /** `/status` —— 绑定状态 + 当前会话。 */
  async #cmdStatus(from) {
    const base = renderStatusText(this.channel.account, loadState(this.relayDir), { pending: this.#decisionCount() });
    const name = this.currentSessionTitle || "";
    const short = this.currentSessionId ? String(this.currentSessionId).replace(/^session-/, "").slice(0, 8) : "";
    const line = this.currentSessionId
      ? `当前任务:${name || "(未命名)"} ${short}`
      : "当前任务:未选中(发一句话即开新任务,/ls 可切换)";
    await this.reply(from, `${base}\n${line}`);
  }

  /** `/summary` —— 重发当前会话的最近结论。 */
  async #cmdSummary(from) {
    if (!this.currentSessionId) {
      await this.reply(from, "现在没有选中的会话。先 /ls + /use <编号> 选一个。");
      return;
    }
    const r = await this.#sessionSummary(this.currentSessionId);
    if (!r) {
      await this.reply(from, "暂时取不到结论(会话历史读不到或还没有内容)。");
      return;
    }
    await this.reply(from, r);
  }

  /** 取某个会话的"结论"= 最后一条助手消息(截到微信可读长度上限)。 */
  async #sessionSummary(sessionId) {
    if (!this.subscriber || typeof this.subscriber.lastAssistantText !== "function") return "";
    try {
      const r = await this.subscriber.lastAssistantText({ sessionId });
      if (!r || !r.ok || !r.text) return "";
      // ⚠️ 这里与展示侧的 COMPLETION_SUMMARY_MAX 是**两道闸**:取值侧若更小,
      //    结论会在拼接之前就被砍掉,排查时只盯 formatter 找不到真正截断点(历史踩过)。
      return String(r.text).trim().slice(0, SESSION_SUMMARY_MAX);
    } catch {
      return "";
    }
  }

  /** 普通文本 → 发给当前会话;没有当前会话就等同 /new。 */
  async #sendToSession(from, text) {
    const body = String(text || "").trim();
    if (!body) return;
    if (!this.currentSessionId) {
      await this.#cmdNew(from, body);
      return;
    }
    if (!this.subscriber || typeof this.subscriber.promptSession !== "function") {
      await this.reply(from, "暂不可用:DSH 会话服务未就绪。");
      return;
    }
    // 每月消息额度闸(放在真正派活之前;审批/指令不计数也不拦)
    const gate = this.#msgQuotaGate();
    if (!gate.ok) {
      await this.reply(from, gate.text);
      return;
    }
    const r = await this.subscriber.promptSession({ sessionId: this.currentSessionId, text: body });
    if (r && r.ok) {
      this.#msgQuotaBump(); // 只在真的派出去之后扣额度(发失败不该扣)
      await this.reply(from, `已补充给「${this.currentSessionTitle || "当前任务"}」,跑完推结论给你。`);
      // ★ 额度消耗**之后**才可能提醒(顺序不能反:提醒要看的是扣完之后还剩几条);
      //   fire-and-forget,提醒失败不影响"已下发"这条主流程的结果。
      this.#maybeRemindQuota().catch(() => {});
      return;
    }
    await this.reply(from, `发送失败:${(r && r.message) || "未知错误"}。回 /ls 确认当前任务还在不在。`);
  }

  /** 数字回执(审批 / 提问)。 */
  async #answerChoice(from, digits) {
    if (digits === null || digits === undefined) return;

    const pending = this.#oldestPending();
    if (!pending) {
      // §6 ①:过期**绝不**当成同意,如实告诉用户。
      await this.reply(from, "这条对应的待办已经过期或已被处理过了,没有代你做出任何选择。");
      return;
    }
    const entry = this.channel.registry.get(pending.eventId);
    if (!entry) {
      this.pendingReplies = this.pendingReplies.filter((p) => p.eventId !== pending.eventId);
      await this.reply(from, "这条对应的待办已经过期或已被处理过了,没有代你做出任何选择。");
      return;
    }
    const option = entry.options[digits - 1];
    if (!option) {
      await this.reply(from, `编号 ${digits} 不在选项里。请回复 1-${entry.options.length} 之间的数字。`);
      return;
    }

    // ── 提醒类(额度 / 会员到期):它**没有**对应的 DSH 提问或审批,回执必须就地消化 ──
    //    ⚠️ 这里顺手修掉一个「从来没生效过」的入口:此前提醒的「邀请好友 / 知道了」
    //       被当成提问派给 `subscriber.answerQuestion`,拿一个**不存在的 question id** 去答,
    //       必然失败 → 用户看到的是「没能替你完成这个选择」。选项文案承诺了、行为却做不到,
    //       正是业主红线里"话术与权限不一致"的那一类。
    if (pending.notice) {
      this.channel.registry.consume(pending.eventId);
      this.pendingReplies = this.pendingReplies.filter((p) => p.eventId !== pending.eventId);
      if (String(option.value) === "invite") {
        const lines = ["邀请好友:在 App 里的「邀请」入口取你的专属链接,发给他即可。"];
        if (this.appUrl) lines.push(this.appUrl);
        // 只说事实,不报具体奖励数字(那是 App/后台的口径,这里报错了就成了假承诺)
        lines.push("（只有邀请人得奖励,被邀请方没有奖励;奖励档位以 App 内展示为准。）");
        await this.reply(from, lines.join("\n"));
      } else {
        await this.reply(from, "好的。");
      }
      return;
    }

    // 用掉,避免同一条被回复两次
    this.channel.registry.consume(pending.eventId);
    this.pendingReplies = this.pendingReplies.filter((p) => p.eventId !== pending.eventId);

    // ⚠️ 选项字段是 `value`(不是 outcome);且审批与提问的**回执编码不同**,
    // 必须按事件节点自己的 answerShape 分派 —— 用错会把审批值塞进提问信封。
    let ans;
    try {
      if (pending.answerShape === "approval") {
        ans = await this.subscriber.answerApproval(pending.eventId, option.value);
      } else {
        const q = Array.isArray(pending.node && pending.node.questions) ? pending.node.questions[0] : null;
        const answers = q
          ? [{ id: q.id, selected: [String(option.label)] }]
          : [{ id: "answer", selected: [String(option.label)] }];
        ans = await this.subscriber.answerQuestion(pending.eventId, answers);
      }
    } catch (e) {
      ans = { ok: false, error: redact(String(e && e.message ? e.message : e)) };
    }
    this.#bumpToday("answered");
    if (ans && ans.ok === false) {
      // 回晚了 / 已被别处处理 —— 如实告知,不假装成功(§6 ①)
      await this.reply(from, `没能替你完成这个选择(${ans.error || "可能已经过期或被处理"}）。任务那边已按"未批准"继续处理了,请到电脑上确认。`);
      await this.#resurfaceNext(from); // 这条废了也要把下一条顶到底部,别让用户往上翻
      return;
    }
    await this.reply(from, `已按你的选择处理:${option.label || digits}。`);
    // ★ 还有待拍板的 → 把下一条重发到底部,用户直接在最新那条上回数字即可。
    //   (不重发的话用户得往上翻找哪条没答 —— 翻错就是"答错对象",正是业主报的那个 bug 的成因。)
    await this.#resurfaceNext(from);
  }

  async reply(to, text) {
    if (!this.channel.account || !to) return false;
    // ★ 文本**必须是字符串**。历史上 `#helpText()` 对付费档直接 `return HELP_TEXT` ——
    //   那是个**数组**,而 `String(数组)` 会按逗号拼接、**一个换行都没有**:
    //   用户实测到的正是「/help 回一坨,没有换行也没有编号」。数组一律按行拼接,
    //   让"想给多行却给了数组"退化成**正确**的多行文本,而不是一坨。
    const body = Array.isArray(text) ? text.join("\n") : String(text == null ? "" : text);
    if (!body) return false;
    try {
      await this.channel.client.sendMessage({ to, text: body });
      this.channel.markPush(true);
      return true;
    } catch (e) {
      this.#noteFailure(`sendmessage 失败:${redact(String(e && e.message ? e.message : e))}`);
      return false;
    }
  }

  #noteFailure(text) {
    this.channel.writeState({ last_error: String(text).slice(0, 200) });
    this.logger.warn(`[wechat] ${text}`);
  }

  // ── 出站:DSH 事件 → 微信通知 ───────────────────────────────────────────

  #startSubscriber() {
    // ⚠️ 建订阅器与挂事件处理器必须**分开**:早先把 on(...) 全写在 `if (subscriber) return;`
    // 之后,于是任何**预先注入**的订阅器都拿不到任何 handler —— 表现为"事件来了却什么都不发生",
    // 而且完全静默。现在无论订阅器是新建还是注入,都保证挂上处理器(WeakSet 去重,可重复调用)。
    if (!this.subscriber) {
      this.subscriber = createEventSubscriber({
        upstream: this.upstream,
        cookie: () => this.cookieOf(),
        follow: true,
        log: (level, message, meta) => {
          try { this.logger[level === "warn" ? "warn" : level === "error" ? "warn" : "info"](`[wechat/events] ${message}`, meta); } catch { /* 忽略 */ }
        }
      });
    }
    this.#wireSubscriber(this.subscriber);
    if (typeof this.subscriber.start === "function") this.subscriber.start();
  }

  #wireSubscriber(sub) {
    this.wired = this.wired || new WeakSet();
    if (!sub || this.wired.has(sub)) return;
    this.wired.add(sub);

    sub.on("event", (node) => {
      this.notify(node).catch((e) => this.logger.warn(`[wechat] 通知发送失败:${redact(String(e && e.message ? e.message : e))}`));
    });
    sub.on("gap", (info) => {
      // §6 ②:事件不重放 —— 断线窗口内的通知**漏了就是漏了**,必须如实说,不能装作没事。
      this.logger.warn(`[wechat/events] 订阅断线窗口 ${info && info.from ? new Date(info.from).toISOString() : "?"} → ${info && info.to ? new Date(info.to).toISOString() : "?"},该窗口内的通知不可补发`);
      this.#tellGap().catch(() => {});
    });
    sub.on("auth-error", (info) => {
      this.logger.warn(`[wechat/events] 鉴权失败(${info && info.surface}):需要刷新 harness cookie`);
    });
  }

  async #tellGap() {
    if (!this.channel.account) return;
    const to = this.channel.account.userId;
    if (!to) return;
    await this.reply(to, "⚠️ 通知通道刚才断过线。这段时间里的提醒可能没有发给你(微信侧不会补发),如果有正在跑的任务,建议到电脑上看一眼。");
  }

  /**
   * 把一条**事件**节点发到微信。可回执的登记进待答队列。
   * 公开方法:bridge 与测试都直接调用它(不叫 #notify 是因为它是本模块的主要出口之一)。
   */
  async notify(eventNode) {
    if (!eventNode || !this.channel.account) return { ok: false, reason: "not_bound" };
    const acct = this.channel.account;

    // 免打扰:只放行"需要你决定"的与"报错"。用**事件侧**的 kind 判,不是文案侧的。
    const state = loadState(this.relayDir);
    if (state.quiet) {
      const important = [
        NODE_KINDS.APPROVAL_REQUEST,
        NODE_KINDS.USER_QUESTION,
        NODE_KINDS.PLAN_REVIEW,
        NODE_KINDS.SESSION_ERROR
      ].includes(eventNode.kind);
      if (!important) return { ok: false, reason: "quiet" };
    }

    // 没有文案模板的节点:按设计另行处理,不是漏接线
    if (SPECIAL_EVENT_KINDS.includes(eventNode.kind)) {
      if (eventNode.kind === NODE_KINDS.EVENT_EXPIRED) {
        // §6 ①:过期要**明确告诉用户**,不能沉默 —— 用户以为还没过期最危险。
        await this.reply(acct.userId, "⌛ 刚才那条需要你决定的事已经过期了,DSH 已按「未批准」继续处理。如果还要做,请到电脑上重新发起。");
      }
      // gap 由 subscriber 的 'gap' 事件单独处理;fault 只记日志,不打扰用户。
      return { ok: false, reason: `special:${eventNode.kind}` };
    }

    const { node: formatted, formatterKind } = toFormatterNode(eventNode);
    if (!formatted) {
      this.logger.warn(`[wechat] 未接线的节点 kind=${eventNode.kind}(消息未发出)`);
      return { ok: false, reason: `unmapped:${eventNode.kind}` };
    }

    // 日报要能回答"今天干了啥" → 在既有的 notified/answered 之外,再记完成与失败。
    // (owner 口径:日报不该是"今天要做啥"的清单,而是"今天做了什么"的回顾)
    if (formatterKind === "stopped") {
      this.#bumpToday(String(eventNode.reason || "") === "completed" ? "completed" : "failed");
    }

    // ── v2 富化 ────────────────────────────────────────────────────────────
    // 两条 v2 规则在这里落地,顺序有讲究:先判"完成推送要富化",再判"审批要不要降级为
    // 只能回电脑确认"。两者都**不走**通用模板,所以放在 buildOutboundNotification 之前。
    let built;

    if (formatterKind === "stopped") {
      // 完成任务不能只推「任务已停止」—— 要带**会话名称 + 结论**,让用户不用打开电脑就知道结果。
      const sid = eventNode.sessionId || this.currentSessionId || "";
      let title = this.currentSessionTitle || "";
      if (sid) {
        const list = await this.#sessions();
        const hit = list ? list.find((s) => s.sessionId === sid) : null;
        if (hit && hit.title) title = hit.title;
        // 学到标题就记住,后面 /status 与 /ls 都能直接用
        if (hit && sid === this.currentSessionId && title !== this.currentSessionTitle) {
          this.#rememberSession(sid, title);
        }
      }
      const summary = sid ? await this.#sessionSummary(sid) : "";
      const c = formatCompletion({
        title,
        reason: eventNode.reason,
        summary,
        sessionId: sid,
        hanging: !summary
      // 判据是 **assign.new**(能不能开新任务),不是粗粒度 assign:
      // 后台只勾细粒度 assign.new 时,粗根判假 → 会给一个**能派活**的用户塞"接着交代属于会员功能"
      }, this.#can("assign.new") ? {} : { continuationHint: this.#continuationHint() });
      built = { text: c.text, replyable: false, eventId: "" };
    } else if (
      formatterKind === "approval" &&
      // ★ 安全边界:破坏性操作**不给一步回执**。加了 session/prompt 之后,这条通道能驱动
      //   agent 改文件/跑命令,手机上点一下太便宜;必须回电脑上确认。
      isDestructiveTool(eventNode.toolName || formatted.tool, eventNode.reason || formatted.detail)
    ) {
      const tool = eventNode.toolName || formatted.tool || "(未提供)";
      const detail = String(eventNode.reason || formatted.detail || "").trim();
      // 现在被降级只有两种原因,文案要分别说清是**哪一种**(否则用户不知道该防什么):
      //   · 有内容且命中破坏性模式 → 是这一步的**内容**危险;
      //   · 内容为空但降级了 → 是**这个工具本身**属于删除/覆盖类(按工具名判的)。
      // ⚠️ 「看不到内容」不再降级(业主拍板:DSH 自身有权限控制,不要过严),所以这里
      //    不会出现"因为看不见所以不给点"的说法 —— 那样说会与实现不一致。
      built = {
        text: [
          "【需要你到电脑上确认】",
          `工具: ${tool}`,
          detail ? `原因: ${detail}` : "",
          "",
          detail
            ? "这一步的内容被判定为破坏性操作(删除 / 强推 / 覆盖等),不能从微信里一键放行。"
            : "这个工具本身属于删除 / 覆盖类,不能从微信里一键放行。",
          "请到电脑上确认;不处理的话 DSH 会按「未批准」继续。"
        ].filter(Boolean).join("\n"),
        replyable: false,
        eventId: ""
      };
    } else {
      built = buildOutboundNotification(formatted, this.channel.registry, this.#notifyOpts());
    }

    if (!built || !built.text) return { ok: false, reason: "no_text" };

    // 已经还有别的待拍板 → 明确说"不止这一条"。不说的话用户会以为答完就结束了,
    // 后面几条就变成"没人回应"(业主报的那个 bug 的后半段现象)。
    // ⚠️ 数字必须取**发送前**的快照:push 之后它会包含这一条自己。
    // ⚠️ 只数**决策**:提醒类(额度/会员到期)不占拍板位,更不该在提醒里说"你还有 N 条待拍板"。
    const isNotice = NOTICE_FORMATTER_KINDS.includes(formatterKind);
    const othersWaiting = built.replyable && built.eventId && !isNotice ? this.#decisionCount() : 0;
    const outgoing = othersWaiting > 0
      ? `${built.text}\n\n（你还有 ${othersWaiting + 1} 条待拍板，回完这条我会把下一条发到下面）`
      : built.text;

    const sent = await this.reply(acct.userId, outgoing);
    if (sent && built.replyable && built.eventId) {
      this.pendingReplies.push({
        eventId: built.eventId,
        kind: formatterKind,
        answerShape: eventNode.answerShape || (formatterKind === "approval" ? "approval" : "question"),
        node: eventNode,
        // ★ 提醒类不参与 FIFO 认领(只有一条决策都没有时才会接数字),见 NOTICE_FORMATTER_KINDS
        notice: isNotice,
        at: this.clock()
      });
      // 队列上限:只保留最近若干条待答,避免无限增长
      while (this.pendingReplies.length > 20) this.pendingReplies.shift();
      this.#bumpToday("notified");
    }
    return { ok: sent, eventId: built.eventId || "" };
  }

  /** 供 bridge / 账户轮询调用:P1 的额度提醒(挂双路钩子)。 */
  async notifyQuotaLow(detail = {}) {
    if (!this.subscriber) return { ok: false, reason: "not_running" };
    return this.notify(this.subscriber.quotaLow(detail));
  }

  /** 供 bridge / 账户轮询调用:P1 的会员过期提醒(挂续费/带新用户双路钩子)。 */
  async notifyMembershipExpiring(detail = {}) {
    if (!this.subscriber) return { ok: false, reason: "not_running" };
    return this.notify(this.subscriber.membershipExpiring(detail));
  }

  // ── 每日简报(兼作 24h 推送窗口心跳,§7) ────────────────────────────────

  #startDigestTimer() {
    if (this.digestTask) return;
    // 每分钟检查一次:① 是否到了今天的简报时刻且今天还没发过 ② 会员是否临近到期
    this.digestTask = setInterval(() => {
      this.#maybeDigest().catch(() => {});
      this.#maybeRemindExpiry().catch(() => {});
    }, 60_000);
    if (this.digestTask.unref) this.digestTask.unref();
  }

  /**
   * 会员/试用临近到期的提醒(提前 2 天、提前 1 天、到期当天)。
   *
   * ⚠️ 这条**以前根本不存在**:`notifyMembershipExpiring()` 只有定义、全仓零调用方 ——
   *    业主以为"提前两天发、提前一天也发",实际一次都没发过。这里补上唯一的触发点。
   *
   * 数据来源:`opts.accountInfo`(由 bridge 注入,复用它查档位时那次 `/api/me`,不额外打网络)。
   * 拿不到就**什么都不发** —— 宁可漏发一次,也不要拿"猜的到期日"去骚扰用户。
   * 每个阈值**一天只发一次**(落盘去重),避免一天里反复提醒。
   */
  async #maybeRemindExpiry() {
    if (this.stopping || !this.channel.account || !this.subscriber) return;
    if (typeof this.accountInfo !== "function") return;
    const now = this.clock();
    let info = null;
    try { info = await this.accountInfo(); } catch { info = null; }
    if (!info || typeof info !== "object") return;
    const endsAt = Number(info.plan_ends_at || info.trial_expires_at || 0);
    if (!Number.isFinite(endsAt) || endsAt <= 0) return;
    const days = Math.ceil((endsAt - now) / 86_400_000);
    // 只在这三个节点提醒:2 天 / 1 天 / 已到期(<=0)。其余日子保持安静。
    const slot = days <= 0 ? "expired" : days === 1 ? "1" : days === 2 ? "2" : "";
    if (!slot) return;
    const key = `${this.#today(now)}:${slot}`;
    const state = loadState(this.relayDir);
    if (state.last_membership_notice === key) return; // 这个阈值今天已提醒过
    const r = await this.notifyMembershipExpiring({
      state: slot === "expired" ? "expired" : "expiring",
      days: Math.max(0, days),
      plan: String(info.plan || "")
    });
    // 只有真发出去了才记账(与简报同一个道理:不能把没发出去的当已发)
    if (r && r.ok) this.channel.writeState({ last_membership_notice: key });
  }

  #today(now = this.clock()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /**
   * 每月消息额度「快用完了」的提醒(这是**唯一的**触发点)。
   *
   * ⚠️ 这条**以前根本不存在**:`notifyQuotaLow()` 只有定义、全仓零调用方 ——
   *    于是用户永远是在额度**归零那一刻**才撞上冷冰冰的拒绝,事先毫无预告。
   *    与 `#maybeRemindExpiry()` 同一套模式(落盘去重 + 只有真发出去了才记账),
   *    调用点也照它那样 fire-and-forget(见 `#cmdNew` / `#sendToSession`)。
   *
   * 触发口径(两个条件取**较宽松**的那个,谁先到用谁 —— 别让用户到 0 才收到):
   *   · 已用 ≥ 80% ;或 · 剩余 ≤ 2 条
   * 频控:**每个自然月最多一次**(`#monthKey()` 落盘去重)。每发一条就念一遍额度是骚扰,
   *     而且微信里挡住消息的正是额度本身 —— 提醒的价值在"提前预告",不是"复读"。
   *
   * ⚠️ `messages_per_month` 为 0/缺省 = **不限**(付费档就是 0):必须**直接返回**,
   *    否则付费用户会被按月念叨"你额度快用完了"(他没有额度这回事)。
   * ⚠️ 提醒本身**不消耗**消息额度:它不走 `#msgQuotaBump()`,也不经 `handleInbound`
   *    (那是"派活"的入口)—— 发提醒绝不能让用户的余额更少。
   */
  async #maybeRemindQuota() {
    if (this.stopping || !this.channel.account || !this.subscriber) return;
    const limit = Number((this.#limits() || {}).messages_per_month || 0);
    // 0 / 缺省 / 非法 = 不限 → 永不提醒(付费用户不该被念额度)
    if (!Number.isFinite(limit) || limit <= 0) return;
    const month = this.#monthKey();
    const used = this.msgUsage && this.msgUsage.month === month ? Number(this.msgUsage.count || 0) : 0;
    if (used <= 0) return; // 一条都还没发过:没有"快用完"这回事
    const remain = Math.max(0, limit - used);
    // 阈值 = min(80% 处, 剩余 2 条处)。`Math.max(1, …)` 保证不会在第 0 条就触发。
    const threshold = Math.min(Math.ceil(limit * 0.8), Math.max(1, limit - 2));
    if (used < threshold) return;
    const state = loadState(this.relayDir);
    if (state.last_quota_notice === month) return; // 这个自然月已经提醒过
    const r = await this.notifyQuotaLow({ state: "low", message: this.#quotaLowText(limit, used, remain) });
    // 只有真发出去了才记账(与简报/到期提醒同一个道理:没发出去的不能算已发)
    if (r && r.ok) this.channel.writeState({ last_quota_notice: month });
  }

  /**
   * 额度提醒正文。**只讲事实 + 与该用户实际能力一致的引导**(契约 §8 红线 1:不多承诺)。
   *
   * ⚠️ 升级引导必须**看 caps**,不能背一句固定的"开通会员即可用全部功能":
   *    能力是后台按档位配的(契约 §2),写死的话术会承诺 `caps` 里根本没有的能力。
   *    这里的做法是:只有在用户**确实还不具备**开新任务能力(`assign`)时才提示"这是会员能力",
   *    其余情况只给 App 入口、不描述任何能力 —— 陈述少一句,总比多承诺一句强。
   */
  #quotaLowText(limit, used, remain) {
    const lines = [
      `本月 ${limit} 条消息额度已用 ${used} 条，还剩 ${remain} 条。`,
      `额度按自然月计算，下个月 1 号自动归零（重新给满 ${limit} 条）。`
    ];
    if (!this.#can("assign.new")) {
      // 按**实际缺的那一项**说,不笼统说"派活是会员能力":
      // 还能接着当前会话聊的人被这么说,会以为自己在微信里什么都做不了 ——
      // 少承诺同样是一种"话术与权限不一致"。
      lines.push("", this.#can("assign.continue")
        ? "在微信里开新任务属于会员能力；接着当前任务回复仍然可用（你能用的能力以 App 内展示为准）。"
        : "在微信里直接派活属于会员能力；开通后可继续使用（你能用的能力以 App 内展示为准）。");
    }
    if (this.appUrl) lines.push("", `👉 打开 App：${this.appUrl}`);
    return lines.join("\n");
  }

  #bumpToday(field = "notified") {
    const day = this.#today();
    if (this.todayStats.day !== day) {
      this.todayStats = { day, notified: 0, answered: 0, completed: 0, failed: 0 };
    }
    this.todayStats[field] = (this.todayStats[field] || 0) + 1;
  }

  /**
   * 每日简报(兼作 24h 推送窗口的心跳)。
   *
   * ⚠️ 旧实现有两个问题,一起修了:
   *   ① 只把 `{notified, answered}` 交给下游,**没有 lines** → 用户每天收到的是兜底句
   *      「今天暂时没有要做的事。」—— 那不是"今天干了啥",等于白发(业主:"日报发的内容有点问题")。
   *   ② 先把 `last_digest_day` 落盘**再**发送 → 一旦这次没发出去(网络抖动/节点被权限关掉),
   *      当天的简报就被**烧掉**、当天再也不会补发。
   */
  async #maybeDigest() {
    if (this.stopping || !this.channel.account || !this.subscriber) return;
    const now = this.clock();
    const hour = new Date(now).getHours();
    if (hour !== this.digestHour) return;
    const state = loadState(this.relayDir);
    if (state.last_digest_day === this.#today(now)) return; // 今天已发
    const s = this.todayStats;
    const lines = this.#digestLines();
    const node = this.subscriber.digestDue({ lines, notified: s.notified, answered: s.answered });
    const r = await this.notify(node);
    // ★ 只有**真的发出去了**才记"今天已发"(见上面 ②)
    if (r && r.ok) this.channel.writeState({ last_digest_day: this.#today(now) });
  }

  /** 简报正文:回答"**今天**干了啥"(业主口径:日报是回顾,不是待办清单)。 */
  #digestLines() {
    const s = this.todayStats;
    const lines = [];
    if (s.completed) lines.push(`· 完成任务 ${s.completed} 个`);
    if (s.failed) lines.push(`· 出错或中断 ${s.failed} 个`);
    if (s.notified) lines.push(`· 推送通知 ${s.notified} 条`);
    if (s.answered) lines.push(`· 你在微信里拍板 ${s.answered} 次`);
    if (!lines.length) lines.push("· 今天这台电脑上没有跑任务。");
    return lines;
  }

  /**
   * 供测试驱动**真实**的简报路径(含"今天是否已发"与"只有发送成功才记账"两条判断)。
   * 与 `runDigestNow` 的区别:后者是运维手动补发、故意绕过这两条判断;这里用于验证它们。
   */
  async runMaybeDigestNow() {
    return this.#maybeDigest();
  }

  /** 供测试/运维手动触发一次"到期提醒"检查(绕过定时器)。与 runDigestNow 同一目的。 */
  async runExpiryRemindNow() {
    return this.#maybeRemindExpiry();
  }

  /**
   * 供测试/运维手动触发一次"额度将尽"检查。生产路径是**派活成功之后**自动调用
   * (见 `#cmdNew` / `#sendToSession`);单测要确定性地验它,所以单独开一个口子 ——
   * 与 `runExpiryRemindNow` / `runDigestNow` 同一目的。
   */
  async runQuotaRemindNow() {
    return this.#maybeRemindQuota();
  }

  /**
   * 供测试/运维手动触发一次简报(绕过时刻判断)。
   * 生产路径走 #maybeDigest 的定时器;单测不能等一天,所以单独开一个口子。
   */
  async runDigestNow(extra = {}) {
    if (!this.subscriber) return { ok: false, reason: "not_running" };
    const node = this.subscriber.digestDue({
      lines: this.#digestLines(),
      notified: this.todayStats.notified,
      answered: this.todayStats.answered,
      ...extra
    });
    return this.notify(node);
  }

  // ── 绑定控制面 ──────────────────────────────────────────────────────────

  /** 开始绑定:取二维码 → 返回面板可直接 <img src> 的 data URL。 */
  /**
   * 本机是否已登录账号。
   * 判据:`.dsh-config.json` 里有 `phone` —— 该字段由面板登录成功后写入(安装器的 setup
   * 也会写)。读不到/损坏一律当**未登录**,宁可多要一次登录,也不能在未登录时放开遥控能力。
   */
  #hasAccount() {
    try {
      const cfg = readJson(path.join(this.relayDir, ".dsh-config.json"));
      return !!(cfg && typeof cfg.phone === "string" && cfg.phone.trim());
    } catch {
      return false;
    }
  }

  async beginBind() {
    if (this.disabled) return { ok: false, error: "微信通道已禁用" };
    if (this.channel.account) return { ok: false, error: "已经绑定过了;如需更换请先解绑" };
    // ★ 权限门槛(业主拍板:必须注册登录后才能用微信机器人)。
    //   判据是**本机配置里有账号**(登录后才会写入)。放在最前面:没登录就连二维码都不给,
    //   而不是"给二维码但绑上用不了"——后者会让用户白扫一次,体验更差。
    //   bridge 侧这道闸与面板侧"未登录不显示 tab"是双保险(bridge 可能被别的客户端调)。
    if (!this.#hasAccount()) {
      return { ok: false, error: "请先在「远程访问」面板登录账号,再连接微信机器人。", code: "login_required" };
    }
    this.cancelBind();
    try {
      const started = await startBind({
        client: this.channel.client,
        logger: this.logger,
        timeoutMs: this.bindTtlMs
      });
      this.bind = {
        started,
        createdAt: this.clock(),
        needVerifyCode: false,
        done: false,
        result: null,
        error: ""
      };
      // 进入 need_verifycode 时置位,让面板弹输入框(§3 状态机)
      started.session.onNeedVerifyCode = () => { if (this.bind) this.bind.needVerifyCode = true; };
      return {
        ok: true,
        qrcode_svg: started.qrcodeSvg || "",
        qrcode_url: started.qrcodeUrl || "",
        message: started.message
      };
    } catch (e) {
      const error = redact(String(e && e.message ? e.message : e));
      this.logger.warn(`[wechat] 取二维码失败:${error}`);
      return { ok: false, error };
    }
  }

  /**
   * 推进绑定状态机一步。面板轮询调用。
   *
   * ⚠️ 必须严格按 `BindSession.next()` 的**真实返回契约**判分支 —— 这里踩过一次大坑:
   * 早先我按 `{state:"confirmed", account:{…}}` 读,而实际上 `next()` 的返回是
   *   · 成功  `{ok:true, alreadyBound:false, token, accountId, baseUrl, userId, message}`(**没有 state/account**)
   *   · 待续  `{ok:false, pending:true, status:"wait"|"scaned"|"unknown"}`
   *   · 要码  `{ok:false, verifyNeeded:true, status:"need_verifycode", attempt}`
   *   · 失败  `{ok:false, code, message}`(来自 fail())
   * 于是 `state` 恒为 "wait"、成功分支永不命中 —— **用户永远绑不上**,而且没有任何报错线索。
   * 是端到端绑定流程测试抓到的(wechat-e2e.test.mjs)。
   */
  async pollBind() {
    if (!this.bind) return { ok: true, state: "idle", bound: !!this.channel.account };
    if (this.bind.done) {
      return { ok: true, state: this.bind.result ? "confirmed" : "failed", bound: !!this.channel.account, error: this.bind.error };
    }
    let step;
    try {
      step = await this.bind.started.next();
    } catch (e) {
      this.bind.error = redact(String(e && e.message ? e.message : e));
      this.bind.done = true;
      return { ok: false, state: "failed", error: this.bind.error };
    }
    if (!step || typeof step !== "object") {
      return { ok: true, state: "wait", need_verify_code: !!this.bind.needVerifyCode, bound: false };
    }

    // 1) 成功:token 是最硬的判据(没有 token 什么都做不了)
    if (step.ok === true && typeof step.token === "string" && step.token) {
      this.channel.adoptConfirmed({
        token: step.token,
        accountId: step.accountId,
        baseUrl: step.baseUrl,
        userId: step.userId
      });
      this.bind.done = true;
      this.bind.result = true;
      await this.startChannel(); // 绑定成功即上线,面板随后就能看到"已绑定"
      return { ok: true, state: "confirmed", bound: true };
    }
    // 2) 该 bot 之前已绑过 → 服务端不再下发凭据,但语义上是成功
    if (step.ok === true && step.alreadyBound === true) {
      this.bind.done = true;
      this.bind.result = true;
      return { ok: true, state: "already_bound", bound: !!this.channel.account };
    }
    // 3) 要配对码(必须每次表面化,否则用户第二次不会再看到输入框)
    if (step.verifyNeeded === true) {
      this.bind.needVerifyCode = true;
      return { ok: true, state: "need_verifycode", need_verify_code: true, bound: false };
    }
    // 4) 终态失败:带 code 且不再 pending
    if (step.ok === false && step.pending !== true && typeof step.code === "string" && step.code) {
      this.bind.done = true;
      this.bind.error = step.message || step.code;
      return { ok: false, state: "failed", code: step.code, error: this.bind.error };
    }
    // 5) 仍在推进(wait / scaned / unknown)
    this.bind.needVerifyCode = false;
    return {
      ok: true,
      state: typeof step.status === "string" ? step.status : "wait",
      need_verify_code: false,
      bound: false
    };
  }

  /** 提交手机微信上显示的数字配对码。 */
  submitVerifyCode(code) {
    const c = String(code == null ? "" : code).trim();
    if (!/^[0-9]{1,8}$/.test(c)) return { ok: false, error: "请输入手机微信上显示的数字" };
    if (!this.bind) return { ok: false, error: "当前没有进行中的绑定" };
    const ok = this.bind.started.submitVerifyCode(c);
    if (ok) this.bind.needVerifyCode = false;
    return ok ? { ok: true } : { ok: false, error: "配对码未被接受,请重试" };
  }

  cancelBind() {
    if (!this.bind) return { ok: true, cancelled: false };
    try { if (this.bind.started.session && this.bind.started.session.cancel) this.bind.started.session.cancel(); } catch { /* 忽略 */ }
    this.bind = null;
    return { ok: true, cancelled: true };
  }

  /** 解绑:停轮询 → notifystop → 删凭据 → 状态置未绑定。 */
  async unbind() {
    await this.stopChannel();
    const r = await this.channel.unbind();
    this.pendingReplies = [];
    this.subscriber = null;
    // 允许重新绑定
    this.stopping = false;
    return { ok: true, notify_error: r.notifyError || "" };
  }
}

export function createWeChatRuntime(opts) {
  return new WeChatRuntime(opts);
}

/** 读控制面发现文件(插件宿主半边用)。 */
export function readControlFile(relayDir) {
  return readJson(path.join(relayDir, CONTROL_FILE));
}

export { saveState, loadState, SessionCooldown };

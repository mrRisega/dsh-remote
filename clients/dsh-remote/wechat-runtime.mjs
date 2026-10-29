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
  extractContextToken,
  inboundMessageId,
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
 * v2 能力表(运营钩子) —— 用户 2026-09-22 确认的分层:
 *
 *   · **免费档 = 只读 + 审批**:收得到任务通知(含完成小结、报错、额度、会员到期),
 *     点得了审批回执(选择下一步执行)。但**遥控不了**。
 *   · **付费档 = 免费档 + 遥控**:在微信里直接交代任务、切换会话(以及预留的中途纠偏/附件/多会话)。
 *
 * 免费用户尝试付费能力时,回复里带上 App 链接 —— 这既是解释,也是转化入口
 * (见 `#upsellText()`:用户约定是"如果免费用户要去做其他的东西,就在消息后面跟一个访问 App 的链接")。
 *
 * ⚠️ `pro_max` **必须存在**:服务端的生效套餐取值就是 free / pro / pro_max(见企业端 auth.js 的
 *    PLAN_PRIORITY),而 `capabilitiesFor` 对**未知档位回退 free** —— 漏了 pro_max 就会把
 *    最高的付费档用户当成免费用户挡在门外。
 * ⚠️ 改这张表 = 改产品权限,别顺手加能力;`free` 那行是"用户没付钱时他能做什么"的唯一定义。
 */
const FREE_CAPABILITIES = Object.freeze([
  "notify", "approve", "status", "stop",
  // ★ 用户 2026-09-22 拍板:「免费只能继续已有会话(回复即续接),不能开新会话、不能选用别的会话」。
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
 * 用户 2026-09-22:「免费给每月 N 条消息额度,超出再引导升级(可配置,挂在权益包里)」。
 * ⚠️ 只有**派活**(发消息/开任务)计数;审批回执与指令**不计数** ——
 *    否则免费用户会为了省额度而不敢拍板,那等于把安全阀关掉。
 */
export const WECHAT_TIER_LIMITS = Object.freeze({
  free: Object.freeze({ messages_per_month: 20 }),
  pro: Object.freeze({ messages_per_month: 0 }),
  pro_max: Object.freeze({ messages_per_month: 0 })
});

/** 某档位的限制。未知档位按最低档(free)处理 —— 与能力表同一约定。 */
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
 * 主动推送失败后的**待补发队列**上限（见 `#pushProactive`）：只留**最近几条**。
 *
 * 2026-10-09 用户约定：「积压超过一定时限后就丢弃掉最早的数据，只保留最近几条」。
 * 从 20 收到 5 的理由：一轮里真正还值得看的就最近那么两三条；攒到 20 条的结果是
 * 平台一恢复就**一次连打十几条** —— 实测正是这种突发批量触发 `ret=-2 prepare failed`
 * 被限流，于是补发又失败、队列再涨，越积越多永远还不上（现场观察到的就是这个循环）。
 */
const MAX_OUTBOX = 5;
/**
 * 待补发条目的**保质期**：超过这个时长还没送达就丢弃（先丢最旧的）。
 *
 * 为什么必须有（同一条用户约定）：一条"任务跑完了"的通知迟到几小时就**毫无价值** ——
 * 补发出去只会让用户以为刚刚才发生；而队列的价值在于"网络抖动期间的短暂失败"，
 * 那是分钟级的。2 小时足够覆盖抖动与短时离线，又不会把半天前的旧事翻出来刷屏。
 */
const OUTBOX_TTL_MS = 2 * 60 * 60 * 1000;
/** 补发时的正文前缀（迟到必须如实说，不能让用户以为刚刚才发生）。 */
const OUTBOX_MARK = "（补发）";

/**
 * 单次补发**最多逐条重发几条**（2026-10-29 ClawBot 修复，CONTRACT §3.5）。
 *
 * 为什么在 TTL/上限之外还要再收一层：平台在"一次连打多条"时最容易触发
 * `ret=-2 prepare failed`（真机现场就是这个循环：补发 → 失败 → 队列涨 → 再补发）。
 * TTL 只把**老的**丢掉，挡不住"一分钟内攒了 5 条"；单次最多 2 条 + 一条汇总，
 * 既让用户知道"还漏了东西"，又不至于把平台重新打到限流。剩下的汇总成一句，绝不静默丢。
 */
const MAX_OUTBOX_FLUSH = 2;
/** 补发时"较早的通知已省略"的汇总文案（N = 被省略的条数）。 */
const OUTBOX_OVERFLOW_TEXT = (n) => `${OUTBOX_MARK}另有 ${n} 条较早的通知未送达，已省略`;
/**
 * 通道静默期间"又有一条推送被跳过/入队"的日志节流窗口。
 *
 * 静默时每收到一条通知都记一行，就是我们自己刷屏（真机一次积压几十条）——
 * 10 分钟一条足够看清趋势，又不会把真正该看的日志淹掉。
 */
const PUSH_PAUSED_LOG_INTERVAL_MS = 10 * 60_000;
/**
 * 日报失败/静默后的**重试退避**（15 分钟）。
 *
 * 旧实现每个 60 秒 tick 都重试一次，18 点那一小时真机日志里刷了 111/240/175 条
 * `ret=-2 prepare failed`（CONTRACT §0）。退避不是"放弃"：真正的补发机会在用户下次
 * 说话时（入站 = 令牌刚刷新，见 #flushPendingDigest）。
 */
const DIGEST_RETRY_BACKOFF_MS = 15 * 60_000;
/**
 * `/status` 在推送静默时追加的提示（文案与面板/CONTRACT §3.7 同源）。
 * 用户最怕的是"机器人坏了"这种误解 —— 必须说清是平台的窗口限制、以及怎么恢复。
 */
const PUSH_PAUSED_HINT = "推送已静默：微信通道只在你最近发过消息后的一小段时间内允许机器人主动发消息。回任意一条消息即可恢复，未送达的通知会补发。";
/**
 * 入站前**刚刚**静默过时，`/status` 追加的提示。
 *
 * 为什么需要单独一句：用户最可能的诊断动作就是发 `/status` 问"怎么不推送了"，
 * 而入站消息本身会清掉 `push_paused` —— 等 #cmdStatus 判断时已经"不静默"了。
 * 若不快照"这条消息到达之前的状态"，这个提示在真实入站路径下永远不会出现，
 * 用户就得不到解释（Lead 2026-10-29 复审指出）。
 */
const PUSH_RECOVERED_HINT = "（刚才推送静默过：你这条消息已恢复推送；此前未送达的通知会补发）";
/** `lastSilence` 的有效期：10 分钟内发 `/status` 才认为"刚才静默过"（再久就不算刚发生了）。 */
const SILENCE_RECENT_MS = 10 * 60_000;

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
 *    早上 9 点发的时候今天才刚开始,整篇都是空的 —— 用户原话「每天早上发『今日干了啥事儿』,
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
   * 「预期内的订阅拒绝」已报过的 (code|sessionId) 集合 —— 见 fault 处理器。
   * 只是防刷屏：每生成一个**子代理**会话都会被订阅层拒一次，不记集合就是每个子代理刷一行 warn。
   */
  #expectedFaultSeen = new Set();

  /**
   * 已 warn 过的**非绑定用户** from 集合 —— 见 handleInbound 的身份过滤。
   * 陌生消息可能成片来（群/服务号回推），每个都 warn 就是把日志刷满；同一 from 说一次足够。
   */
  #foreignSenderWarned = new Set();

  /**
   * 本次"推送静默"期间是否已经 warn 过一次。
   *
   * 令牌过期不是网络抖动：同一段时间里每条发不出去的消息都会走到同一个 catch，
   * 不节流就是几十条 warn。入站（令牌刷新）或发送成功后重置，下一次过期重新报一次。
   */
  #pauseWarned = false;

  /**
   * @param {{
   *   relayDir: string,
   *   upstream?: string|(() => string), // dsh web 地址,默认 http://127.0.0.1:3080;函数=每次重连重新求值
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
    /**
     * 上游地址的**取值器**：恰好是字符串时是常量函数。
     *
     * 为什么不让它是个固化字符串：宿主端口会变（`dsh web --port 0`、DSH Desktop 每次启动随机端口），
     * 而事件订阅器是**长连接** —— 固化字符串的后果是端口一变就永久重连到旧端口。
     * 【2026-10-09 真机实证】bridge 启动时宿主还是 3080，随后换成 19387；隧道转发侧
     * （每次都读最新 UPSTREAM）一切正常，唯独微信事件通道死循环刷
     * `connect ECONNREFUSED 127.0.0.1:3080` —— 手机能开页面，但**任务完成没有任何推送**。
     */
    this.upstreamOf = typeof opts.upstream === "function" ? opts.upstream : () => this.upstream;
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

    /**
     * 待补发队列的**单飞锁**（CONTRACT §3.5）。
     * 入站的 fire-and-forget 补发与主动推送路径都会调 #flushOutbox —— 不加锁时
     * 两条调用会同时读到同一份队列、把同一批通知各发一遍（用户看到"重复推送"）。
     */
    this.outboxFlushing = false;
    /**
     * 日报的下一次重试时间（clock 毫秒）。未到点直接 return —— 修掉"每小时 60 次猛打"。
     * 0 = 没有退避在生效。
     */
    this.digestNextTryAt = 0;
    /**
     * 日报发送的**单飞锁**：#maybeDigest（定时器）与 #flushPendingDigest（入站补发）
     * 是两个入口，并发进来会各发一条 —— 真机上就是"简报发两遍"。
     * 磁盘原子占位（#claimDigest）挡的是跨进程，这里挡的是同进程内的并发入口。
     */
    this.digestFlushing = false;
    /** "推送静默，本条已跳过/入队"日志的节流时间戳（见 #logPushPaused）。 */
    this.pausedPushLogAt = 0;
    /**
     * 最近一次"入站前处于静默"的快照 `{ at, reason }`（见 handleInbound 第 ③ 步）。
     * 只服务于 `/status`：入站会把 push_paused 清掉，不快照的话用户问"怎么不推送了"
     * 永远得不到"刚才静默过、你这条消息已恢复"的答复。
     */
    this.lastSilence = null;

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
    // 待补发条数只报**有效**条数（按保质期过滤后）：见下方 pending_outbox 的历史注释
    const pendingOutboxCount = this.#pruneOutbox(state.pending_outbox).kept.length;
    // 推送静默标记由 channel 落在 state（invalidateContextToken 写、发送成功/入站清）——
    // 这里直接读 state，保证面板看到的与"发不发得出去"是**同一份事实**。
    const pushPaused = state.push_paused && typeof state.push_paused === "object" ? state.push_paused : null;
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
      // ★ 面板要把「你现在能用什么」如实展示出来(用户:话术与权限必须一致,不多承诺)。
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
      events_running: !!this.subscriber,
      // ── 2026-10-29 ClawBot 修复:推送静默 / 令牌 / 待补发(面板要能解释"为什么没消息")──
      // 静默不是故障而是平台的窗口限制(CONTRACT §0 真机实测:令牌分钟级过期、没有续期接口),
      // 所以必须让面板/状态如实说明,而不是让用户以为机器人坏了。
      push_paused: !!pushPaused,
      push_paused_at: Number((pushPaused && pushPaused.at) || 0),
      push_paused_reason: String((pushPaused && pushPaused.reason) || ""),
      context_token_at: Number(state.context_token_at || 0),
      pending_outbox_count: pendingOutboxCount,
      digest_pending_day: String(state.pending_digest_day || ""),
      // ── 诊断字段（2026-09-25 故障加的）────────────────────────────────────
      // 那次「任务跑完一条微信都没收到，日志里也没有任何报错」暴露了三件必须能看见的事：
      //   ① 事件订阅到底 ready 了没、**正在 follow 哪些会话**（follow 集为空 = turn/end 收不到）；
      //   ② 有没有排进待补发队列的通知（推送失败不再等于消失）；
      //   ③ 最近一次订阅异常是什么（以前 fault 只 emit、没人接，全静默）。
      events_state: this.subscriber && typeof this.subscriber.state === "string" ? this.subscriber.state : "",
      followed_sessions: this.subscriber && typeof this.subscriber.sessions === "function"
        ? this.subscriber.sessions()
        : [],
      // 报**有效**条数（按保质期过滤后）：否则进程重启后，面板会一直显示那几条早已过期、
      // 永远不会被补发的条目，看起来像"队列卡住了"。真正的清理由 #trimOutbox 落盘。
      pending_outbox: pendingOutboxCount,
      last_fault: state.last_fault || null,
      last_completed_session_id: state.last_completed_session_id || "",
      last_completed_at: Number(state.last_completed_at || 0),
      inbound_shape_null_token: state.inbound_shape || ""
    };
  }

  /** 通知文案里用的机器人自称与奖励约定(与产品约定同源)。 */
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

    // ★ 恢复长轮询游标（2026-10-29 ClawBot bug 1，CONTRACT §3.1）。
    //   旧实现只把 `get_updates_buf` 放在内存里 —— bridge 重启/重连后游标归零，
    //   服务端会重投"未确认"的消息 → 同一条消息被派活两次（用户报的「会话发两遍」）。
    //   官方实现按 bot 账号落盘；读写都在 channel 层，这里只负责启动时取一次。
    //   `||` 保留内存里已有的值：channel 若自己恢复过，就不必再读盘。
    try {
      this.channel.updatesBuf = this.channel.updatesBuf || this.channel.loadUpdatesBuf();
    } catch (e) {
      this.logger.warn(`[wechat] 恢复长轮询游标失败(从空游标开始):${redact(String(e && e.message ? e.message : e))}`);
    }

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
      // ★ 游标**在本批消息处理完之后**才落盘（Lead 2026-10-29 决策，取代 CONTRACT §3.1 的"先存"）。
      //
      // 取舍（为什么"先处理后存"而不是"先存后处理"）：
      //   · 先存（at-most-once）：getUpdates 成功后立刻推进游标，若进程在这批消息的处理中途崩溃，
      //     游标已经前进 → **这批剩余的消息永久丢失**，而且没有任何补偿机会。
      //   · 后存（at-least-once）：崩溃后重启会从旧游标重投**这一批**，同一条消息可能被再派一次 ——
      //     但重复由 channel 的持久化去重表吸收（`isDuplicateMessage` 在派发**之前**就标记，
      //     属于 before-dispatch 语义），所以重放是安全的。
      //   结论：宁可极小概率下重放一批（被去重表吸收），也不要静默丢一批用户消息。
      //   用 try/finally 保证"即使某条 handleInbound 抛错也照样保存"—— 否则一条坏消息会让游标
      //   永久卡住，变成无限重投。循环内仍是 catch+log 继续，不中断整批。
      try {
        for (const msg of Array.isArray(resp.msgs) ? resp.msgs : []) {
          // 每条入站一行 info，**不含正文**：正文里有用户的任务/隐私，日志只留可定位的元信息
          // （id / 来源 / 类型 / 文本长度）—— 出问题时要能对上是哪条，又不能让日志成为泄密面。
          this.logger.info(
            `[wechat] 入站 id=${inboundMessageId(msg) || "?"} from=${extractFromUserId(msg) || "?"}`
            + ` type=${msg && msg.message_type != null ? msg.message_type : "?"}`
            + ` len=${String(extractInboundText(msg) || "").length}`
          );
          try { await this.handleInbound(msg); } catch (e) {
            this.logger.warn(`[wechat] 处理入站消息失败:${redact(String(e && e.message ? e.message : e))}`);
          }
        }
      } finally {
        // 整批处理完（或中途抛错）才推进并落盘游标；内存值一起更新，否则下一轮会拿旧游标重投本批
        if (typeof resp.get_updates_buf === "string") {
          this.channel.updatesBuf = resp.get_updates_buf;
          try {
            this.channel.saveUpdatesBuf(resp.get_updates_buf);
          } catch (e) {
            // 游标落盘失败绝不能打断长轮询（否则通道直接停了）—— 最多退化成"重启后重投一批"
            this.logger.warn(`[wechat] 保存长轮询游标失败(继续轮询):${redact(String(e && e.message ? e.message : e))}`);
          }
        }
      }
    }
  }

  // ── 入站:回执与指令 ────────────────────────────────────────────────────

  /** 取"最近一条待答通知"(用户回数字时映射到它)。 */
  /**
   * 取"**最早**一条待答通知"。
   *
   * ⚠️ 必须是**先进先出**,不能取最近一条。真机 bug(用户报的):
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
    const account = this.channel.account;
    const from = extractFromUserId(msg);

    // ── ① 身份 / 类型过滤（严格排在去重之前，CONTRACT §3.2 第 1 步）────────────
    // 为什么必须先过滤：这条通道能驱动用户电脑上的 agent（session/prompt），
    // 不过滤就等于把"谁都能派活"写进协议层。以前完全没有这道闸。
    // ①a 机器人自己的消息（平台会把 bot 发出去的消息回灌进 getupdates）
    if (Number(msg && msg.message_type) === 2 || /@im\.bot$/i.test(from)) {
      if (typeof this.logger.debug === "function") {
        this.logger.debug(`[wechat] 跳过机器人消息 from=${from || "?"} type=${msg && msg.message_type != null ? msg.message_type : "?"}`);
      }
      return;
    }
    // ①b 不是绑定用户 → 跳过 + warn（同一 from 只 warn 一次：陌生来源可能成片来，
    //    每条都 warn 就是把真正的告警淹掉）。
    if (account && account.userId && from && from !== account.userId) {
      if (!this.#foreignSenderWarned.has(from)) {
        this.#foreignSenderWarned.add(from);
        this.logger.warn(`[wechat] 忽略非绑定用户的消息 from=${from}（当前绑定的是 ${account.userId}）`);
      }
      return;
    }

    // ── ② 入站去重（channel 层按 bot 账号落盘，CONTRACT §3.2 第 2 步）──────────
    // 游标丢失/服务端重投时同一条消息会再来一次；没有去重就会把同一条派活两次。
    // fail-open 由 channel 保证：id 为空或去重表读/写失败 → 当"不重复"（宁可重复一次，
    // 也绝不因为去重把消息吃掉）。
    const id = inboundMessageId(msg);
    if (this.channel.isDuplicateMessage(id)) {
      this.logger.info(`[wechat] 跳过重复入站 id=${id}`);
      return;
    }

    const text = normalizeInput(extractInboundText(msg));
    // ── ③ 记令牌（入站消息带来 `context_token`，出站必须回带它才发得出去）──────
    //    放在 `if (!text) return` **之前**：图片/语音这类没有文本的消息同样携带新令牌，
    //    同样是"用户刚说过话、推送窗口已打开"的信号 —— 绝不能因为 text 为空就被早退跳过。
    //    channel 侧在写盘记住令牌的同时会**清掉 push_paused**（入站 = 令牌已刷新 = 通道恢复）。
    //    记不住不影响主流程（最坏就是这一条发不出去，与以前一样）。
    //    ⚠️ 反过来，**没带令牌**的入站不会解除静默：没有 context_token 发出去必然还是
    //    `prepare failed`（CONTRACT §0），提前解除只会让补发多失败一次、把日志再刷一遍。
    //    等带令牌的消息（真实入站都带）到了再恢复，才是"能发出去就恢复"的如实语义。
    // ★ 先快照"这条消息到达之前是否处于静默"，再让 rememberContextToken 去清它。
    //   用户的心理路径是「咦不推送了」→ 发 /status 问；而入站会当场解除静默，所以
    //   #cmdStatus 必须靠这份快照才能说出「刚才静默过、你这条消息已恢复」。
    const silenceBefore = this.#pushPaused();
    if (silenceBefore.paused) {
      this.lastSilence = { at: this.clock(), reason: silenceBefore.reason };
    }
    try { this.channel.rememberContextToken(extractContextToken(msg), from); } catch { /* 忽略 */ }
    // 令牌已刷新 → 下一次过期属于"新的一次静默"，warn 要重新允许
    this.#pauseWarned = false;
    // ★ 0.6.15：`context_token` 的形状一直没被验证过（§11）。真机日志里
    //   `ret=-2 prepare failed` 出现过 48 次，而状态文件里**从来没有** context_token ——
    //   也就是说入站消息里没带它（或字段名和我们猜的不一样）。这里把**字段名**记一次
    //   （只有名字，没有值），下次再出这个问题就能一眼看出该取哪个键，不用再猜。
    this.#noteInboundShapeIfNoToken(msg);

    // ── ④ 补发（入站 = 平台推送窗口刚打开，是唯一能补送积压的时刻）──────────────
    // 按契约顺序**日报优先**触发，再补待补发队列。两条都 fire-and-forget：
    // 补发失败绝不能影响用户这条消息的处理；#flushOutbox 内部单飞，与推送路径不会并发重发。
    // ⚠️ 实现细节（别被顺序误导）：#flushPendingDigest 走 notify → #pushProactive，而后者
    //    **先补待补发队列再发这一条**（既有行为）。所以网络上的实际顺序可能是"积压 → 日报"。
    //    这不影响任何承诺（每条都发、各一次、有界），只是别在别处假设严格先后。
    void this.#flushPendingDigest(from).catch(() => false);
    void this.#flushOutbox(from).catch(() => 0);

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
      // 纯文本 = 派活。★ 分两种(用户 2026-09-22 拍板):
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
   * **每月消息额度闸**(用户 2026-09-22:免费给每月 N 条,超出引导升级)。
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
    // 两个方向都违反用户红线「话术与权限必须一致、不多承诺」。
    // 现在每一行都挂一个判据,能不能用由 `#can(...)` **逐条**决定。
    const canNew = this.#can("assign.new");
    const canContinue = this.#can("assign.continue");
    const rows = [
      { ok: this.#can("approve"), text: "· 回数字(如 1)回执最近一条需要你拍板的消息" },
      { ok: this.#can("stop"), text: "· /stop 中断当前会话正在跑的回合" },
      { ok: this.#can("status"), text: "· /status 查看绑定与推送状态" },
      { ok: true, text: "· /quiet 暂停推送(回复任意消息恢复)" }, // 本地开关,不需要任何能力
      { ok: true, text: "· /unbind 解除微信绑定" },
      // 「接着当前任务聊」与「开新任务」是**两个独立能力**(用户 2026-09-22 拍板把 assign 拆成两半),
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
   * 用户约定:免费用户要去做别的事情时,就在消息后面跟一个访问 App 的链接,
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
    //    于是"打错命令"被理解成"这功能坏了"。用户红线是「话术与权限必须一致、不多承诺」,
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
    this.channel.writeState({
      current_session_id: this.currentSessionId,
      current_session_title: this.currentSessionTitle,
      // 「回复目标是什么时候定下来的」——回话前对表要用（见 #retargetToLatestCompletion）。
      current_session_set_at: this.clock(),
    });
  }

  /**
   * 记下"最近完成的任务"（**无论那条完成推送有没有发出去**）。
   *
   * 为什么必须有它：`#rememberSession` 只在推送真的发出去了才会被调用 —— 一旦推送失败
   * （微信侧 ret=-2）或者订阅漏了 turn/end，当前会话指针就**停在旧会话上**，用户回话会发进
   * 那个旧会话（用户 2026-09-25 实测：「刚才我回了个话，而且回到了另外一个对话里面去了」）。
   * 有了这个记录，回话前就能对一次表（见 `#retargetToLatestCompletion`）。
   */
  #rememberCompletion(sessionId, title) {
    if (!sessionId) return;
    this.channel.writeState({
      last_completed_session_id: String(sessionId),
      last_completed_session_title: String(title || ""),
      last_completed_at: this.clock(),
    });
  }

  /**
   * 回话前的"对表"：当前会话指针是不是**落后于**最近一次完成？
   *
   * 判据严格且保守：只有「完成时间**晚于**我们最后一次把回复目标定下来的时间」才切换。
   * 绝不因为"还有个更活跃的会话"就改主意 —— 那会把用户正在聊的会话顶掉。
   * @returns {boolean} 是否切换了
   */
  async #retargetToLatestCompletion() {
    try {
      const st = loadState(this.relayDir);
      const sid = String(st.last_completed_session_id || "");
      if (!sid || sid === this.currentSessionId) return false;
      const doneAt = Number(st.last_completed_at || 0);
      const setAt = Number(st.current_session_set_at || 0);
      if (!doneAt || doneAt <= setAt) return false;
      let title = String(st.last_completed_session_title || "");
      if (!title) {
        // 静音路径只记了 id（没解析标题）→ 这里补一次，让确认文案里能出现人话的会话名
        try {
          const list = await this.#sessions();
          const hit = list ? list.find((s) => s.sessionId === sid) : null;
          if (hit && hit.title) title = hit.title;
        } catch { /* 取不到就用空标题 */ }
      }
      this.#rememberSession(sid, title);
      this.logger.info(`[wechat] 回话前对表：当前会话落后于最近完成的任务 ${sid}，已自动切过去`);
      return true;
    } catch { return false; }
  }

  /**
   * 可切换会话列表（`/ls` 与 `/use` **共用同一份**）—— 过滤必须收口在这里。
   *
   * 为什么（用户反馈「/ls 列出一堆(未命名)会话」）：`listSessions` 返回的会话里有大量**空白会话**
   * （新建后一句话没说的坑），官方已经在数据里标了 `blank`（`dsh-events.mjs:1654` 解析出来却
   * 一直没人用）。规则：只留 **有名字 / 正在跑 / 当前选中** 的会话；`blank === true` 一律剔除。
   *
   * ⚠️ 过滤**只能**放在这里（或同步过滤 sessionIndex）：`/ls` 渲染 1..N 编号、`/use <n>` 按下标取
   *    会话、而 `sessionIndex`（/use 的列表来源）就是本函数的返回值 —— 任何一处单独过滤都会让
   *    两边编号分叉（用户 `/ls` 看到第 2 条是 A，`/use 2` 却切到 B）。
   * ⚠️ 老版本 DSH 不带 `blank` 字段：`undefined === true` 为假 → 自动退化成"有名字/在跑/当前"，
   *    不会因为升级或降级把整张列表清空。
   */
  #usableSessions(list) {
    return (Array.isArray(list) ? list : []).filter((s) => {
      if (!s || typeof s !== "object") return false;
      if (s.blank === true) return false;                       // 官方明确标记的空白会话
      if (s.sessionId === this.currentSessionId) return true;    // 当前选中：永远留在列表里
      if (s.running === true) return true;                       // 正在跑
      return Boolean(String(s.title || "").trim());              // 有名字
    });
  }

  /** 拉一次会话列表(带标题),并记住 1-based 序号供 /use 使用(列表已按 #usableSessions 过滤)。 */
  async #sessions() {
    if (!this.subscriber || typeof this.subscriber.listSessions !== "function") return null;
    const r = await this.subscriber.listSessions();
    if (!r || !r.ok) return null;
    this.sessionIndex = this.#usableSessions(r.sessions || []);
    return this.sessionIndex;
  }

  /**
   * `/new [任务]` —— 建一个 DSH 会话,可选地立刻把任务下发进去。
   * 默认**沿用最近项目**(cwd 取最近一个会话的 cwd);要换项目就显式给路径,
   * 避免把简单事做复杂(用户拍板)。
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
    const lines = [base, line];
    // ★ 推送静默时**必须如实追加一句**：否则用户看到"机器人不说话了"只会以为它坏了，
    //   而真实原因是平台的窗口限制（令牌过期、没有续期接口，见 CONTRACT §0）。
    //   这句同时告诉他怎么办（回任意一条消息即可恢复），比任何技术细节都有用。
    //   分两种说法：现在还静默（发不出去）／刚才静默过但这条入站已经恢复（见 lastSilence）。
    const pausedNow = this.#pushPaused();
    if (pausedNow.paused) {
      lines.push("", PUSH_PAUSED_HINT);
    } else if (this.lastSilence && this.clock() - Number(this.lastSilence.at || 0) < SILENCE_RECENT_MS) {
      lines.push("", PUSH_RECOVERED_HINT);
    }
    await this.reply(from, lines.join("\n"));
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
    // ★ 0.6.15：回话前先对一次表 —— 完成推送**没发出去**时（平台 ret=-2 / 订阅漏了 turn/end），
    //   当前会话指针会停在旧会话上，这一句"再改一下"就会发给那个旧会话。
    const switched = await this.#retargetToLatestCompletion();
    // 每月消息额度闸(放在真正派活之前;审批/指令不计数也不拦)
    const gate = this.#msgQuotaGate();
    if (!gate.ok) {
      await this.reply(from, gate.text);
      return;
    }
    const r = await this.subscriber.promptSession({ sessionId: this.currentSessionId, text: body });
    if (r && r.ok) {
      this.#msgQuotaBump(); // 只在真的派出去之后扣额度(发失败不该扣)
      // 「最后一次把回复目标定下来」的时间：下一次对表要看它，避免把用户正在聊的会话顶掉。
      this.channel.writeState({ current_session_set_at: this.clock() });
      const note = switched ? "（刚跑完的那个任务已自动切为回复对象）" : "";
      await this.reply(from, `已补充给「${this.currentSessionTitle || "当前任务"}」,跑完推结论给你。${note}`);
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
    //       正是用户红线里"话术与权限不一致"的那一类。
    if (pending.notice) {
      this.channel.registry.consume(pending.eventId);
      this.pendingReplies = this.pendingReplies.filter((p) => p.eventId !== pending.eventId);
      if (String(option.value) === "invite") {
        const lines = ["邀请好友:在 App 里的「邀请」入口取你的专属链接,发给他即可。"];
        if (this.appUrl) lines.push(this.appUrl);
        // 只说事实,不报具体奖励数字(那是 App/后台的约定,这里报错了就成了假承诺)
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
    //   (不重发的话用户得往上翻找哪条没答 —— 翻错就是"答错对象",正是用户报的那个 bug 的成因。)
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
    // 发送前先看一眼静默标记：这条如果能发出去，说明令牌是好的 → 下面要把它清掉
    const pausedBefore = !!this.#pushPaused().paused;
    try {
      await this.channel.client.sendMessage({ to, text: body });
      this.channel.markPush(true);
      // ★ 发送成功 = 令牌有效 = 通道恢复：把通道层的静默标记清掉，
      //   让面板/状态如实变回"正常"，而不是一直挂着一条已经过期的警告。
      if (pausedBefore) {
        try { this.channel.clearPushPaused(); } catch { /* 清标记失败不影响这条已发出的消息 */ }
        this.#pauseWarned = false;
        this.logger.info("[wechat] 主动推送已恢复（令牌有效），静默标记已清除");
      }
      return true;
    } catch (e) {
      // 🔴 令牌过期（ret=-2 prepare failed）**不是网络抖动**：平台没有续期接口，
      //   同一条重发必然再失败（CONTRACT §0 真机实测：有效期约 10 分钟）。
      //   所以这里既不重试也不重写 last_error —— 立刻静默主动推送并如实记账，
      //   否则就是我们刷满日志、还让用户以为"只是慢"。
      if (e && e.code === "context_token_expired") {
        const reason = String(e && e.message ? e.message : e || "context_token 已过期");
        try { this.channel.invalidateContextToken(reason); } catch { /* 记账失败也必须保持静默 */ }
        if (!this.#pauseWarned) {
          this.#pauseWarned = true;
          this.logger.warn(`[wechat] 主动推送已暂停（上下文令牌过期）：${redact(reason)}（等用户下次发消息刷新令牌后自动恢复）`);
        }
        return false;
      }
      this.#noteFailure(`sendmessage 失败:${redact(String(e && e.message ? e.message : e))}`);
      return false;
    }
  }

  // ── 推送静默（2026-10-29 ClawBot 修复） ─────────────────────────────────

  /**
   * 读通道层的"主动推送是否已静默"。
   *
   * 静默 = 最近一次 sendMessage 撞上 `ret=-2 prepare failed`（context_token 过期，
   * channel 层落盘 `push_paused`）。它不是网络故障，平台也没有续期接口 —— 令牌只在
   * "最近有入站消息"的很短窗口内有效（CONTRACT §0 真机实测）。
   * 所以静默期间**不发请求、只入队**，等用户下次说话（令牌刷新）再补。
   */
  #pushPaused() {
    const r = this.channel.pushPaused();
    return r && typeof r === "object" ? r : { paused: false, at: 0, reason: "" };
  }

  /** 静默期间"这条推送被跳过/入队"的日志：≥10 分钟一条，避免我们自己把日志刷满。 */
  #logPushPaused(text) {
    const now = this.clock();
    if (now - this.pausedPushLogAt < PUSH_PAUSED_LOG_INTERVAL_MS) return;
    this.pausedPushLogAt = now;
    this.logger.info(`[wechat] ${text}`);
  }

  /**
   * 入站消息里到底有没有 `context_token`？没有的话，把**字段名**记一次（值一律不记）。
   *
   * 为什么需要：出站要回带 `context_token`，而没人验证过它的真实形状（§11）。
   * 真机证据（2026-09-25）：bridge 日志里 `ret=-2 errmsg=prepare failed` 出现 48 次，
   * 而状态文件里**从来没有** context_token —— 说明入站消息里没带它，或者它在别的键上。
   * 猜字段名没有意义，让真机告诉我们：只记名字（不含任何内容/凭据），一次就够。
   */
  #noteInboundShapeIfNoToken(msg) {
    try {
      if (extractContextToken(msg)) return; // 有令牌就没什么可记的
      const shape = [];
      const walk = (obj, prefix, depth) => {
        if (!obj || typeof obj !== "object" || depth > 2 || shape.length >= 40) return;
        for (const k of Object.keys(obj)) {
          if (shape.length >= 40) return;
          const path = prefix ? `${prefix}.${k}` : k;
          shape.push(path);
          const v = obj[k];
          if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path, depth + 1);
        }
      };
      walk(msg, "", 0);
      const joined = shape.join(",");
      const st = loadState(this.relayDir);
      if (String(st.inbound_shape || "") === joined) return; // 同形状只记一次
      this.channel.writeState({ inbound_shape: joined });
      this.logger.info(`[wechat] 入站消息里没有 context_token；字段名（不含值）：${joined}`);
    } catch { /* 诊断失败不影响主流程 */ }
  }

  #noteFailure(text) {
    this.channel.writeState({ last_error: String(text).slice(0, 200) });
    this.logger.warn(`[wechat] ${text}`);
  }

  // ── 待补发队列（主动推送失败不再静默丢失） ──────────────────────────────
  //
  // 【2026-09-25 故障】用户的任务跑完后**一条微信都没收到**，而日志里躺着 48 条
  // `sendmessage 失败:sendMessage: ret=-2 errmsg=prepare failed` —— 平台侧发送失败是
  // **间歇性**的（实测同一台机器上有的消息发得出去、有的发不出去），而旧实现失败即丢弃：
  // 用户永远不知道那条"任务跑完了"存在过。
  //
  // 做法：主动推送（通知类）失败就**入队**，在下一次成功发送/成功入站时按 FIFO 补发。
  // 补发时正文前加「（补发）」——迟到就要如实说，不能让用户以为刚刚才发生。
  // ⚠️ 队列落盘且**只存正文**（不含 token/eventId）：状态文件是面板可读的，
  //    凭据一律不进（§8）。
  #outbox() {
    try {
      const st = loadState(this.relayDir);
      return Array.isArray(st.pending_outbox) ? st.pending_outbox : [];
    } catch { return []; }
  }

  #writeOutbox(items) {
    const list = Array.isArray(items) ? items : [];
    this.channel.writeState({ pending_outbox: list, pending_outbox_count: list.length });
    return list;
  }

  /**
   * 丢掉**过期**条目（返回保留的与丢掉的数量）。
   * `at` 缺失/非法 = 更早的落盘格式（那时还没有 at 字段）→ 一律视为过期：
   * 留着只会把"最近几条"挤掉，而它们必然比 TTL 更老。
   */
  #pruneOutbox(list) {
    const now = this.clock();
    const kept = [];
    let dropped = 0;
    for (const item of Array.isArray(list) ? list : []) {
      const at = Number(item && item.at);
      if (!Number.isFinite(at) || at <= 0 || now - at > OUTBOX_TTL_MS) { dropped += 1; continue; }
      kept.push(item);
    }
    return { kept, dropped };
  }

  /** 丢弃过期的、并按上限只留最近几条；丢了就**如实记一行日志**（绝不静默丢）。 */
  #trimOutbox(list) {
    const { kept, dropped } = this.#pruneOutbox(list);
    let overflow = 0;
    while (kept.length > MAX_OUTBOX) { kept.shift(); overflow += 1; }
    const lost = dropped + overflow;
    if (lost > 0) {
      const mins = Math.round(OUTBOX_TTL_MS / 60000);
      const why = [dropped ? `${dropped} 条超 ${mins} 分钟未送达` : "", overflow ? `${overflow} 条超出最近 ${MAX_OUTBOX} 条上限` : ""]
        .filter(Boolean).join("、");
      this.logger.warn(`[wechat] 待补发队列丢弃 ${lost} 条（${why}），保留最近 ${kept.length} 条`);
    }
    return kept;
  }

  #enqueueOutbox(text, kind = "") {
    const body = String(text || "");
    if (!body) return 0;
    const list = this.#outbox();
    list.push({ text: body, kind: String(kind || ""), at: this.clock() });
    return this.#writeOutbox(this.#trimOutbox(list)).length;
  }

  /**
   * 把待补发队列发出去（2026-10-29 收敛，CONTRACT §3.5）。
   *
   * 三条硬约束：
   *  ① **单飞**：入站的 fire-and-forget 与主动推送路径会并发调用 —— 不加锁时两边会
   *     读到同一份队列、把同一批通知各发一遍（用户看到"重复推送"）；并发调用直接返回 0。
   *  ② **单次最多逐条重发 MAX_OUTBOX_FLUSH 条**，取**最近**的几条（越早越没价值，
   *     而且一次连打正是平台限流的触发条件，见常量注释）。
   *  ③ 还有更早的 → 再发**一条汇总**「另有 N 条较早的通知未送达，已省略」后清空队列：
   *     既不让用户以为"什么都没漏"，也不逐条刷屏；被省略的条数**如实记日志**。
   * 补发路径**不看 push_paused** —— 它是被入站触发的，此刻令牌刚刚刷新（CONTRACT §3.4）。
   * @returns {Promise<number>} 这次补发成功的条数（含汇总那一条）
   */
  async #flushOutbox(to) {
    // 单飞：并发调用直接返回 0（另一条调用会把队列处理掉）
    if (this.outboxFlushing) return 0;
    if (!to) return 0;
    this.outboxFlushing = true;
    try {
      // 补发前先按保质期清一遍：**过期的不发**（迟到几小时的"任务跑完了"只会误导用户），
      // 也避免一次性连打十几条把平台打限流（那正是队列越积越多的成因）。
      const raw = this.#outbox();
      const list = this.#trimOutbox(raw);              // 只在真丢了东西时才落盘（避免每轮都写状态文件）
      if (list.length !== raw.length) this.#writeOutbox(list);
      if (!list.length) return 0;
      const target = list.slice(-MAX_OUTBOX_FLUSH);    // 只逐条重发最近的几条
      const older = list.slice(0, Math.max(0, list.length - target.length));
      let sent = 0;
      for (const item of target) {
        const ok = await this.reply(to, `${OUTBOX_MARK}${String(item && item.text ? item.text : "")}`);
        if (!ok) {
          // 还是发不出去（例如令牌又过期了）：**保留全部 older + 尚未送出的 target**，下次再试。
          // ⚠️ 别写成 `list.slice(sent)`：`sent` 只在 target 内计数，而 list 是 [older..., target...]，
          //    那个写法会同时犯两个错 —— 最早的 older 被静默丢掉、已经发出去的 target 又被放回队列
          //    再发一遍（用户收到重复）。必须按两段拼回去。
          const rest = [...older, ...target.slice(sent)];
          this.#writeOutbox(rest);
          this.logger.warn(`[wechat] 补发中断：已送出 ${sent} 条，剩 ${rest.length} 条留到下次（不丢，含较早的 ${older.length} 条）`);
          return sent;
        }
        sent += 1;
      }
      if (older.length) {
        // 更早的通知不再逐条重发，但**必须让用户知道有东西被省略了**（绝不静默丢）。
        const ok = await this.reply(to, OUTBOX_OVERFLOW_TEXT(older.length));
        if (!ok) {
          // 汇总都没发出去 → 这些条目留着下次再试（不能因为已经"打算省略"就真丢了）
          this.#writeOutbox(older);
          this.logger.warn(`[wechat] 补发省略汇总没发出去，${older.length} 条较早的通知留到下次`);
          return sent;
        }
        sent += 1;
        this.logger.warn(`[wechat] 补发时省略了 ${older.length} 条较早的通知（单次最多逐条重发 ${MAX_OUTBOX_FLUSH} 条，避免一次连打触发平台限流）`);
      }
      this.#writeOutbox([]);
      this.logger.info(`[wechat] 待补发队列已送出 ${sent} 条并清空`);
      return sent;
    } finally {
      this.outboxFlushing = false;
    }
  }

  /**
   * 主动推送（通知类）：先补发积压，再发这一条；发不出去就入队，绝不丢。
   *
   * 2026-10-29 新增：通道**静默**期间（令牌过期）**不发请求** —— 发了必然 prepare failed，
   * 只会刷日志并把平台打成限流（真机现场正是这个循环）。此时只入队，等入站补发。
   * @returns {Promise<{sent:boolean, queued:boolean}>} queued=true 表示"已排进待补发"，
   *   调用方据此仍可登记待拍板项（用户稍后看到时还能回执）。
   */
  async #pushProactive(to, text, kind = "", { queue = true } = {}) {
    const body = String(text || "");
    if (!body) return { sent: false, queued: false };
    const paused = this.#pushPaused();
    if (paused.paused) {
      // 静默中：请求一个都不发（这是 CONTRACT §3.4 的核心）。
      if (!queue) return { sent: false, queued: false };
      const depth = this.#enqueueOutbox(body, kind);
      this.#logPushPaused(`主动推送已静默(${kind || "?"})：本条已入队（${depth} 条待补发，等入站补发）`);
      return { sent: false, queued: true };
    }
    await this.#flushOutbox(to).catch(() => 0);
    const ok = await this.reply(to, body);
    if (ok) return { sent: true, queued: false };
    // queue=false：**自己有重试/占位语义**的通知（日报）绝不能排队 ——
    // 排队 + 它自己的下一次 tick 补发 = 用户收到两条，而且"当天已发"的占位账也会算错。
    if (!queue) return { sent: false, queued: false };
    const depth = this.#enqueueOutbox(body, kind);
    this.logger.warn(`[wechat] 主动推送失败(${kind || "?"})：已排进待补发队列（${depth} 条），下一条能发出去时会补上`);
    return { sent: false, queued: true };
  }

  // ── 出站:DSH 事件 → 微信通知 ───────────────────────────────────────────

  #startSubscriber() {
    // ⚠️ 建订阅器与挂事件处理器必须**分开**:早先把 on(...) 全写在 `if (subscriber) return;`
    // 之后,于是任何**预先注入**的订阅器都拿不到任何 handler —— 表现为"事件来了却什么都不发生",
    // 而且完全静默。现在无论订阅器是新建还是注入,都保证挂上处理器(WeakSet 去重,可重复调用)。
    if (!this.subscriber) {
      this.subscriber = createEventSubscriber({
        // 传**取值器**而不是当次的值：见构造函数里 upstreamOf 的说明（端口变了要能跟上）。
        upstream: () => this.upstreamOf(),
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
    sub.on("fault", (info) => {
      // ★ 2026-09-25：订阅层的 fault **以前完全没人接**（`#emitFault` 只 emit、不 log），
      //   于是「follow 失败 / 发现失败 / 流上限」全都**静默消失** —— 用户看到的是
      //   「任务跑完没有任何推送，日志里也没有任何报错」，事后只能靠数日志行数考古。
      //   现在：一条 warn 落进 bridge 日志（带时间戳），并把**非预期**的那条记进状态文件供面板显示。
      //   `expected: true`（子代理会话必然被拒 / 会话刚被删）只记日志，不当故障刷状态。
      const code = String((info && info.code) || "unknown");
      const message = String((info && info.message) || "").slice(0, 160);
      const sessionId = String((info && info.sessionId) || "");
      // 预期内的拒绝（子代理会话必然被拒 `session/agent-busy` / 会话刚被删 `session/not-found`）
      // **不是故障**：每生成一个子代理就会来一条，写成 warn 会把真正的故障淹掉
      // （2026-10-09 现场：日志里成片 `订阅异常 session/agent-busy … require their durable parent address`）。
      // 但也不能完全静默（2026-09-25 的教训：fault 以前没人接，全丢）→ 降为 info，且同一对只报一次。
      if (info && info.expected === true) {
        const key = `${code}|${sessionId}`;
        if (this.#expectedFaultSeen.size < 200 && !this.#expectedFaultSeen.has(key)) {
          this.#expectedFaultSeen.add(key);
          this.logger.info(`[wechat/events] 订阅跳过(预期，不重试) ${code}${sessionId ? ` session=${sessionId}` : ""}: ${message}`);
        }
        return;
      }
      this.logger.warn(`[wechat/events] 订阅异常 ${code}${sessionId ? ` session=${sessionId}` : ""}: ${message}`);
      this.channel.writeState({ last_fault: { code, message, session_id: sessionId, at: this.clock() } });
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
  async notify(eventNode, opts = {}) {
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
      if (!important) {
        // ★ 0.6.15：静音也要**记账**。完成推送被静音时，这条"最近完成的任务"仍然必须被记下来 ——
        //   否则用户下一秒回话就会发进上一次的会话（用户实测的那个"回到另一个对话"）。
        //   静音只表示"不打扰"，不表示"当它没发生过"。
        if (eventNode.kind === NODE_KINDS.TURN_END && eventNode.sessionId) {
          this.#rememberCompletion(eventNode.sessionId, "");
        }
        return { ok: false, reason: "quiet" };
      }
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
    // (owner 约定:日报不该是"今天要做啥"的清单,而是"今天做了什么"的回顾)
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
      }
      // ★ 0.6.15 修（用户实测）：**完成推送要把"当前会话"切到刚跑完的那个**。
      //   旧行为只在 sid 已经是当前会话时才更新标题，于是：B 会话跑完推了结论，用户直接在微信里
      //   回一句"再改一下"，那条消息却被 `#sendToSession` 发给了**上一次的当前会话 A** ——
      //   A 莫名其妙多了一条指令，B 永远收不到。用户看到的正是"推送过来了，我准备回话，
      //   它还停留在我之前的会话里"。
      //   语义：**最近完成的任务 = 最近一次推送的对象 = 你现在回话的对象**。这是唯一不会让人踩空的解释。
      //
      // ★ 0.6.15 补：**先无条件记下"最近完成的任务"**（与推送成败无关）。
      //   推送失败（微信 ret=-2）或订阅漏了 turn/end 时，这一步是回话前对表的唯一依据，
      //   否则当前会话指针会停在旧会话上，用户回话直接发进旧会话（用户实测的第二个症状）。
      this.#rememberCompletion(sid, title);
      if (sid && sid !== this.currentSessionId) {
        this.#rememberSession(sid, title);
      } else if (sid && title && title !== this.currentSessionTitle) {
        this.#rememberSession(sid, title); // 学到标题就记住,后面 /status 与 /ls 都能直接用
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
      // ⚠️ 「看不到内容」不再降级(用户拍板:DSH 自身有权限控制,不要过严),所以这里
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
    // 后面几条就变成"没人回应"(用户报的那个 bug 的后半段现象)。
    // ⚠️ 数字必须取**发送前**的快照:push 之后它会包含这一条自己。
    // ⚠️ 只数**决策**:提醒类(额度/会员到期)不占拍板位,更不该在提醒里说"你还有 N 条待拍板"。
    const isNotice = NOTICE_FORMATTER_KINDS.includes(formatterKind);
    const othersWaiting = built.replyable && built.eventId && !isNotice ? this.#decisionCount() : 0;
    const outgoing = othersWaiting > 0
      ? `${built.text}\n\n（你还有 ${othersWaiting + 1} 条待拍板，回完这条我会把下一条发到下面）`
      : built.text;

    // ★ 0.6.15：走 `#pushProactive`（先补发积压 → 再发这条 → 发不出去就入队），
    //   不再直接 `reply()`。旧实现失败即丢弃 —— 平台的发送失败是间歇性的，用户于是
    //   "任务跑完了却一条都没收到"，而且谁也不知道那条通知存在过。
    // 日报（`daily`）自带重试与"当天已发"占位：它一旦进了补发队列就会与下一次 tick 撞成两条，
    // 也会把占位账算错 —— 这类通知**明确不排队**（其余通知都排队，失败不再等于消失）。
    const queueFailedPush = opts.queueFailedPush !== false && formatterKind !== "daily";
    const pushed = await this.#pushProactive(acct.userId, outgoing, formatterKind, { queue: queueFailedPush });
    // 入队也算"已经安排了送达"：用户稍后看到补发时，回执必须仍然认得出这条待办。
    const sent = pushed.sent || pushed.queued;
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
   *    用户以为"提前两天发、提前一天也发",实际一次都没发过。这里补上唯一的触发点。
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
   * 触发约定(两个条件取**较宽松**的那个,谁先到用谁 —— 别让用户到 0 才收到):
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
   * ⚠️ 旧实现有三个问题,一起修了:
   *   ① 只把 `{notified, answered}` 交给下游,**没有 lines** → 用户每天收到的是兜底句
   *      「今天暂时没有要做的事。」—— 那不是"今天干了啥",等于白发(用户:"日报发的内容有点问题")。
   *   ② 先把 `last_digest_day` 落盘**再**发送 → 一旦这次没发出去(网络抖动/节点被权限关掉),
   *      当天的简报就被**烧掉**、当天再也不会补发。
   *   ③ 「读 state → 发送 → 写 state」是一段**跨 await 的读-改-写**:发送要等网络,
   *      这段窗口里第二个执行者会读到"今天还没发"→ **两条都发出去**
   *      (2026-09-23 真机:用户收到两条简报)。现在用**原子占位**把"今天这条归我发"锁死。
   */
  async #maybeDigest() {
    if (this.stopping || !this.channel.account || !this.subscriber) return;
    const now = this.clock();
    const hour = new Date(now).getHours();
    if (hour !== this.digestHour) return;
    // ★ 退避（2026-10-29 修复，CONTRACT §3.6）：上一次没成功（令牌过期/静默/网络失败）→
    //   15 分钟内不再试。旧实现每个 60 秒 tick 都猛打一次，真机 18 点那一小时刷了
    //   111/240/175 条 `ret=-2 prepare failed`。退避不是放弃 —— 补发改由入站触发
    //   （见 #flushPendingDigest：用户一说话令牌就刷新，那才是能把简报送出去的时刻）。
    if (this.digestNextTryAt && now < this.digestNextTryAt) return;
    const day = this.#today(now);
    const state = loadState(this.relayDir);
    if (state.last_digest_day === day) return; // 今天已发
    // ★ 先原子占位再发送:两个实例/两次 tick 并存时,只有一个能拿到(见 #claimDigest)
    const claim = this.#claimDigest(day);
    if (!claim.ok) return;
    // 占位拿到就先把"今天还没送达"落盘：进程若在发送途中被杀（占位会被当作陈旧接管，
    // 但 pending 标记能让下一次**入站**立刻补上，不必再等一天）。
    this.channel.writeState({ pending_digest_day: day });
    const paused = this.#pushPaused();
    let r;
    if (paused.paused) {
      // 静默期间发也必然失败（prepare failed）→ 干脆一个请求都不发，等入站补发。
      this.#logPushPaused(`日报已静默（${paused.reason || "context_token 过期"}），等下次入站补发`);
      r = { ok: false, reason: "push_paused" };
    } else {
      r = await this.#sendDigestNow();
    }
    // ★ 只有**真的发出去了**才记"今天已发"(见上面 ②)
    if (r && r.ok) {
      this.channel.writeState({ last_digest_day: day, pending_digest_day: "" });
      this.digestNextTryAt = 0;
      return;
    }
    // 没真发出去 → 释放占位（不能把当天烧掉）+ 退避 15 分钟（修掉"每小时 60 次猛打"）
    this.#releaseDigest(claim);
    this.digestNextTryAt = this.clock() + DIGEST_RETRY_BACKOFF_MS;
    this.logger.warn(`[wechat] 日报未送达（${(r && r.reason) || "unknown"}）：已记为待补发，${Math.round(DIGEST_RETRY_BACKOFF_MS / 60_000)} 分钟后或下次入站再试`);
  }

  /**
   * 真正发一次当日简报（`#maybeDigest` 与 `#flushPendingDigest` **共用**）。
   *
   * 单飞：两个入口都是异步发送，并发进来会各发一条（真机上就表现为"简报发两遍"）。
   * 磁盘原子占位（`#claimDigest`）挡的是跨进程/跨实例，这里挡的是同进程内的并发入口。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async #sendDigestNow() {
    if (this.digestFlushing) return { ok: false, reason: "inflight" };
    this.digestFlushing = true;
    try {
      const s = this.todayStats;
      // ⚠️ 必须把 lines 一起传：只给 notified/answered 会让用户每天收到兜底句
      //    「今天暂时没有要做的事。」—— 那不是"今天干了啥"（见 #maybeDigest 的历史注释）。
      const node = this.subscriber.digestDue({ lines: this.#digestLines(), notified: s.notified, answered: s.answered });
      // queueFailedPush:false —— 日报自带 pending/退避语义，绝不能进待补发队列（否则双份）
      return await this.notify(node, { queueFailedPush: false });
    } catch (e) {
      return { ok: false, reason: redact(String(e && e.message ? e.message : e)) };
    } finally {
      this.digestFlushing = false;
    }
  }

  /**
   * 入站后补发"今天没能送达的日报"（CONTRACT §3.6）。
   *
   * 为什么必须由**入站**触发：平台只允许"最近有入站消息"的窗口内主动推送，
   * 日报失败/静默后靠定时器重试只会一直 prepare failed。用户一说话令牌刚刷新，
   * 这是唯一能把简报送出去的时刻 —— 所以它排在待补发队列**之前**（日报过期就没意义了）。
   * 这里**不看 push_paused**：入站意味着令牌已刷新（CONTRACT §3.4）。
   * @returns {Promise<boolean>} 是否补发成功
   */
  async #flushPendingDigest(to) {
    if (!to || !this.subscriber || !this.channel.account) return false;
    const day = this.#today();
    const state = loadState(this.relayDir);
    if (state.last_digest_day === day) {
      // 今天已送达：顺手清掉可能残留的待补标记（异常退出/旧版本留下的，别让状态永远挂着）
      if (state.pending_digest_day) this.channel.writeState({ pending_digest_day: "" });
      return false;
    }
    if (String(state.pending_digest_day || "") !== day) return false;
    const r = await this.#sendDigestNow();
    if (!(r && r.ok)) return false;
    // ★ 只有真发出去才写 last_digest_day，并清掉待补标记（"发过才算数"）
    this.channel.writeState({ last_digest_day: day, pending_digest_day: "" });
    this.digestNextTryAt = 0;
    this.logger.info("[wechat] 未送达的日报已在入站后补发成功");
    return true;
  }

  /**
   * 原子占位「今天这条简报由我来发」。
   *
   * 🔴 为什么光看 state 里的 `last_digest_day` 不够:那是**读-改-写**,中间隔着一次网络发送。
   *    典型撞车场景有两个,都真实发生过:
   *      · 更新期间新旧 bridge **短暂共存**(旧的还没退、新的已起);
   *      · 一次发送耗时超过 60s,下一次定时器 tick **叠**上来。
   *    两者都会让第二个执行者在写盘之前读到"今天还没发" → 用户收到两条。
   *    `openSync(..., "wx")`(不存在才创建)由内核保证原子,只有一个执行者能拿到 ✅
   *
   * 生命期:发成功 → 占位**留着**(它比 state 更强,重启/换实例也不会丢);
   *        发失败 → 立刻由 `#releaseDigest` 释放,让下一 tick 补发;
   *        占位超过 10 分钟 = **陈旧**(进程在发送途中被杀)→ 接管它。
   *        宁可极小概率重发一次,也不要出现"那天彻底不发了"。
   */
  #claimDigest(day) {
    const file = path.join(this.relayDir, `.digest-${day}.sent`);
    const STALE_MS = 10 * 60_000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.closeSync(fs.openSync(file, "wx"));
        this.#pruneDigestClaims(day);
        return { ok: true, file };
      } catch (e) {
        if (!e || e.code !== "EEXIST") {
          // 目录不可写等:退回"这次不发",绝不因此把 bridge 打挂(简报是锦上添花)
          return { ok: false, file };
        }
        let age = 0;
        try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { age = 0; }
        if (age < STALE_MS) return { ok: false, file }; // 别人正在发 / 今天已经发过
        try { fs.rmSync(file, { force: true }); } catch { return { ok: false, file }; }
        // 删掉陈旧占位后重抢一次
      }
    }
    return { ok: false, file };
  }

  /** 发送失败时释放占位(交给下一 tick 补发)。 */
  #releaseDigest(claim) {
    if (!claim || !claim.file) return;
    try { fs.rmSync(claim.file, { force: true }); } catch { /* ignore */ }
  }

  /** 清掉别的日期留下的占位文件(一天一个,不清理会一年攒 365 个)。 */
  #pruneDigestClaims(today) {
    try {
      for (const name of fs.readdirSync(this.relayDir)) {
        if (!name.startsWith(".digest-") || !name.endsWith(".sent")) continue;
        if (name === `.digest-${today}.sent`) continue;
        try { fs.rmSync(path.join(this.relayDir, name), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 目录读不了就算了:占位本身仍生效 */ }
  }

  /** 简报正文:回答"**今天**干了啥"(用户约定:日报是回顾,不是待办清单)。 */
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
    // ★ 权限门槛(用户拍板:必须注册登录后才能用微信机器人)。
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

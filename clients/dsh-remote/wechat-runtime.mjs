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
  HELP_TEXT,
  classifyInbound,
  formatCompletion,
  isDestructiveTool,
  renderStatusText,
  stopReasonText,
  isSessionExpired,
  writePrivateJson,
  SessionCooldown,
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
const PAID_CAPABILITIES = Object.freeze([
  "notify", "approve", "status", "stop",
  "assign", "sessions", "summary",
  "steer", "attach", "multi" // 预留:中途纠偏 / 附件 / 多会话并行
]);
export const WECHAT_CAPABILITY_TABLE = Object.freeze({
  free: Object.freeze(["notify", "approve", "status", "stop"]),
  pro: PAID_CAPABILITIES,
  pro_max: PAID_CAPABILITIES
});

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
  "/new": "assign",
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
export const DEFAULT_DIGEST_HOUR = 9;
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
    /**
     * 真实档位来源(async→ "free"|"pro"|"pro_max";空串 = 这次没取到)。
     * bridge 用账号 API 的生效套餐实现它;不注入时档位恒为缓存/默认(测试与自建)。
     */
    this.tierProvider = typeof opts.tierProvider === "function" ? opts.tierProvider : null;
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
      pending_replies: this.pendingReplies.length,
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
  #latestPending() {
    const now = this.clock();
    while (this.pendingReplies.length) {
      const head = this.pendingReplies[this.pendingReplies.length - 1];
      const entry = this.channel.registry.get(head.eventId);
      if (entry) return head;
      this.pendingReplies.pop();
      void now;
    }
    return null;
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
      // 纯文本 = 「在微信里交代任务」→ 付费能力。免费用户拿到解释 + App 链接(转化入口)。
      if (!(await this.#canNow("assign"))) {
        // ⚠️ 陷阱:回执只认**纯数字**(见 classifyInbound)。免费档的核心价值恰恰是审批,
        //    用户很可能打字「允许」而不是回「1」—— 若只回一句付费提示,他会以为免费版什么都干不了。
        //    所以手上有待回执的消息时,先把"回数字就能拍板"说在前面。
        const head = this.pendingReplies.length > 0
          ? `你还有 ${this.pendingReplies.length} 条待你拍板的消息 —— 直接回一个数字(如 1)就能完成决定,不用打字。\n\n`
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

  /** 当前档位是否具备某能力(运营钩子的唯一判断入口)。 */
  #can(cap) {
    return capabilitiesFor(this.#tier(), this.capabilityTable).includes(cap);
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
    let next = "";
    try {
      next = String((await this.tierProvider()) || "").trim();
    } catch (e) {
      this.logger.warn(`[wechat] 读取账号档位失败(沿用上次):${redact(String(e && e.message ? e.message : e))}`);
      return this.#tier();
    }
    if (!next) return this.#tier(); // 空串 = 这次没取到 → 沿用缓存
    if (next !== this.cachedTier) {
      this.cachedTier = next;
      this.channel.writeState({ tier: next });
      this.logger.info(`[wechat] 账号档位:${next}`);
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
    if (this.#can("assign")) return HELP_TEXT; // 付费档:完整清单
    const lines = [
      "【DSH 微信通道 · 通知版】",
      "现在能用的:",
      "· 回数字(如 1)回执最近一条需要你拍板的消息",
      "· /stop 中断当前会话正在跑的回合",
      "· /status 查看绑定与推送状态",
      "· /quiet 暂停推送(回复任意消息恢复)",
      "· /unbind 解除微信绑定",
      "",
      "会员功能(开通后可用):",
      "· 直接发一句话 = 给当前任务派活",
      "· /new 开新任务、/ls 列出会话、/use <编号> 切换会话、/summary 重发最近结论"
    ];
    if (this.appUrl) lines.push("", `👉 开通并查看设备列表:${this.appUrl}`);
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
    // 其余交给上游的通用处理 —— ⚠️ 字段是 `replyText`,不是 text。
    const r = handleCommand(cmd, args);
    await this.reply(from, (r && r.replyText) || "可用指令:/new /ls /use /stop /status /summary /help /quiet /unbind");
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
      return;
    }
    await this.reply(from, `已开新任务 ${short} 并下发。跑完我会推结论给你;中途想补充直接回话即可。`);
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
    const base = renderStatusText(this.channel.account, loadState(this.relayDir), { pending: this.pendingReplies.length });
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

  /** 取某个会话的"结论"= 最后一条助手消息(已截断到微信可读长度)。 */
  async #sessionSummary(sessionId) {
    if (!this.subscriber || typeof this.subscriber.lastAssistantText !== "function") return "";
    try {
      const r = await this.subscriber.lastAssistantText({ sessionId });
      if (!r || !r.ok || !r.text) return "";
      return String(r.text).trim().slice(0, 700);
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
    const r = await this.subscriber.promptSession({ sessionId: this.currentSessionId, text: body });
    if (r && r.ok) {
      await this.reply(from, `已补充给「${this.currentSessionTitle || "当前任务"}」,跑完推结论给你。`);
      return;
    }
    await this.reply(from, `发送失败:${(r && r.message) || "未知错误"}。回 /ls 确认当前任务还在不在。`);
  }

  /** 数字回执(审批 / 提问)。 */
  async #answerChoice(from, digits) {
    if (digits === null || digits === undefined) return;

    const pending = this.#latestPending();
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
      return;
    }
    await this.reply(from, `已按你的选择处理:${option.label || digits}。`);
  }

  async reply(to, text) {
    if (!this.channel.account || !to) return false;
    try {
      await this.channel.client.sendMessage({ to, text });
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
      }, this.#can("assign") ? {} : { continuationHint: this.#continuationHint() });
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
            ? "这一步的**内容**被判定为破坏性操作(删除 / 强推 / 覆盖等),不能从微信里一键放行。"
            : "这个**工具本身**属于删除 / 覆盖类,不能从微信里一键放行。",
          "请到电脑上确认;不处理的话 DSH 会按「未批准」继续。"
        ].filter(Boolean).join("\n"),
        replyable: false,
        eventId: ""
      };
    } else {
      built = buildOutboundNotification(formatted, this.channel.registry, this.#notifyOpts());
    }

    if (!built || !built.text) return { ok: false, reason: "no_text" };

    const sent = await this.reply(acct.userId, built.text);
    if (sent && built.replyable && built.eventId) {
      this.pendingReplies.push({
        eventId: built.eventId,
        kind: formatterKind,
        answerShape: eventNode.answerShape || (formatterKind === "approval" ? "approval" : "question"),
        node: eventNode,
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
    // 每分钟检查一次"是否到了今天的简报时刻且今天还没发过"
    this.digestTask = setInterval(() => {
      this.#maybeDigest().catch(() => {});
    }, 60_000);
    if (this.digestTask.unref) this.digestTask.unref();
  }

  #today(now = this.clock()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  #bumpToday(field = "notified") {
    const day = this.#today();
    if (this.todayStats.day !== day) this.todayStats = { day, notified: 0, answered: 0 };
    this.todayStats[field] = (this.todayStats[field] || 0) + 1;
  }

  async #maybeDigest() {
    if (this.stopping || !this.channel.account || !this.subscriber) return;
    const now = this.clock();
    const hour = new Date(now).getHours();
    if (hour !== this.digestHour) return;
    const state = loadState(this.relayDir);
    if (state.last_digest_day === this.#today(now)) return; // 今天已发
    this.channel.writeState({ last_digest_day: this.#today(now) });
    const node = this.subscriber.digestDue({
      notified: this.todayStats.notified,
      answered: this.todayStats.answered
    });
    await this.notify(node);
  }

  /**
   * 供测试/运维手动触发一次简报(绕过时刻判断)。
   * 生产路径走 #maybeDigest 的定时器;单测不能等一天,所以单独开一个口子。
   */
  async runDigestNow(extra = {}) {
    if (!this.subscriber) return { ok: false, reason: "not_running" };
    const node = this.subscriber.digestDue({ notified: this.todayStats.notified, answered: this.todayStats.answered, ...extra });
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

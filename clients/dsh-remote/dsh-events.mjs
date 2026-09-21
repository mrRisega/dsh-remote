/**
 * dsh-events — DSH 事件订阅器（微信机器人通道的事件源，见 docs/wechat-bot-channel.md §4/§5/§6）。
 *
 * 为什么需要一条**独立连接**
 *   dsh-bridge.mjs 对 DSH 的 WebSocket 帧是逐字节透传、**从不解析**的（它不认识「会话」），
 *   而插件宿主半边（packages/dsh-remote-web/lib/index.js）**没有任何审批挂钩**。
 *   所以要观察事件，必须有一个本地进程自己开一条到 DSH 的连接。
 *
 * 依赖
 *   零新增依赖：只用仓库已 vendor 的 `ws`（`dsh-bridge.mjs` 同样是 `import WebSocket from "ws"`）
 *   与 node 内建模块。
 *
 * 线上形状（逐条抄自 DSH shipped source，勿凭记忆改）
 *   - mux 路由 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`
 *     @deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js:3
 *     （⚠️ dsh-bridge.mjs:26 的注释写的 `/api/events.mux` 是**过期注释**，全 DSH 零命中）
 *   - 客户端→服务端 `{type:'open',streamId,endpoint,payload}` / `{type:'cancel',streamId}`
 *     stream-protocol.js `parseRemoteStreamClientMessage()`:155（键集精确匹配）
 *   - 服务端→客户端 `{type:'item',streamId,value}` / `{type:'end',streamId}` /
 *     `{type:'error',streamId,error:{code,message,details}}`，同文件 `parseRemoteStreamServerMessage()`:175
 *   - `$events`：endpoint `'$events'`，payload `{args:{}}`，**首帧** value 为
 *     `{type:'ready',clientId,host:{home}}`；clientId 是回答任何事件的必需品
 *     dsh-api-gateway/lib/index.js `openRemoteEvents()`:585
 *   - `emit` 帧 `{type:'emit',event,args}`，args 即 Cordis 监听参数
 *     dsh-api-remotes/lib/index.js `broadcastRemoteEvent()`:621
 *   - `waterfall` 帧 `{type:'waterfall',event,eventId,agentId,request}`，
 *     `request` 已被服务端剥掉 `agent`/`signal`（可达字段：审批 toolName/callId/reason；
 *     提问 questions） dsh-api-gateway/lib/index.js `startRemoteEvent()`:630
 *   - 🔴 第三种帧：waterfall 事件被结算/取消时服务端补发 `{type:'cancel',eventId}`
 *     （同文件 `finishRemoteEvent()`:712）。规格 §4 的帧清单里没有它，但它是
 *     「这条审批已作废」的**唯一**信号 —— §6① 要求消息上能显示「这条已过期」。
 *   - 回执走 HTTP（不是 socket）：`POST {upstream}/api/$events/result`
 *     body `{type:'client-request',rpcId,method:'$events/result',payload:{args:{clientId,eventId,outcome}}}`
 *     响应 `{type:'server-response',rpcId,result:{ok:true,value}|{ok:false,error:{code,message,details}}}`
 *     @deepseek-ai/dsh-client-connection/lib/index.js `rpcFetchHandler()`:635 / `fullResponse()`:685
 *     ⚠️ 规格 §4 说「`{ok:false,error}` 体」——实际嵌在 `result` 里。
 *   - `session/follow`：payload **必须是 `{args:{request:{address:{kind:'session',sessionId:'<id>'}}}}`**
 *     （外层 `args` 是 gateway 的硬校验，见 dsh-api-gateway/lib/index.js `remoteRequest():929`；
 *     规格 §4 只给了 args 内层对象，照抄会被服务端拒掉 —— 真机实测踩过）
 *     首帧 `{type:'snapshot',header,cursor,records,hasMore,projections}`（真机实测键集一致，
 *     `header.id` 是完整会话 id），其后 `{type:'event',event:{type,seq,time,data:{turn,reason:{kind}}}}`
 *     @deepseek-ai/dsh-api-session-controller/lib/index.js `follow()`:1400
 *   - 🔴 **follow 的 sessionId 用「事件里报什么就发什么」**，不要一律加 `session-` 前缀：
 *     真机实测（2026-09-21）本机根会话的日志 id 是 `session-<uuid>`，而**子代理会话的真实 id 是裸 uuid**
 *     （裸 id → `session/agent-busy`，说明找到了；`session-<uuid>` → `session/not-found`，说明不存在）。
 *     规格 §4 那句「必须用持久 session-<uuid>，裸 uuid 会 not-found」只在根会话上成立。
 *     本模块主形式原样发送，另一种形式只在 `session/not-found` 时兜底各试一次（见 `sessionIdCandidates`）。
 *   - `api-session/*` 的口径（真机逐帧核对）：`status` = `[sessionId, running]`（**边沿**事件）、
 *     `error` = `[id, message]`、`activity` = `[sessionId, epochMs]`、`removed` = `[sessionId]`、
 *     `added` = `[summary]`，summary 字段 `sessionId/updatedAt/running/blank/parentSessionId/origin/cwd/projections`。
 *   - `turn/end.reason.kind` 闭集：completed|aborted|blocked|error|max-tokens|interrupted
 *     （同包 typert.host.js 的 `TurnEndReasonMap`）
 *
 * 会话发现（为什么还需要 $events 之外的东西）
 *   `$events` 的 `api-session/status` 是**边沿**事件：它只是「状态变了」，**不补发**。
 *   于是 bridge 重启/断线重连时，若某任务正在跑，我们永远收不到它的 `status:true`，
 *   也就永远不 follow，最终拿不到它的 `turn/end` —— P0 节点 4 会**静默丢失**。
 *   两条补洞来源（都只读，默认开）：
 *     ① `session/list`（**一元 HTTP**，不是流）：每项带真实 `running` → 连接时/周期对账时
 *        直接发现「正在跑」的会话并 follow；也可据此关掉已停的 follow（防泄漏）。
 *     ② `session/control`（流）：baseline 的 `queues/jobs/projections` **键**即实时会话集合
 *        （**没有** running 字段），其后的 queue/jobs/projection 帧是该会话「活着」的电平信号。
 *
 * 会话控制（一元 RPC 层）
 *   除回执外，本模块还给上层提供一组**会话控制**方法（`listSessions` / `createSession` /
 *   `promptSession` / `pageSession` / `lastAssistantText` / `cancelSession` / `renameSession`）。
 *   它们和回执走同一条 HTTP 通道（`POST {upstream}/api/<method>`，信封见上），
 *   **一律返回类型化结果、绝不抛异常**（失败形状 `{ok:false, code, message, details?}`）。
 *   线参名逐个抄自 DSH 自己的 zod 描述符
 *   （@deepseek-ai/dsh-api-session-controller/lib/typert.host.js `TYPERT.invocations`）：
 *     session/list   → `{_request:{}}`  ← **唯一**用 `_request` 的（送 `request` 被拒：missing "_request"）
 *     session/create → `{request:{workspaceId?,cwd?,sessionId?,agentPreset?}}`
 *     session/prompt → `{request:{requestId,sessionId,mode,content,clientTimeZone?}}`（前四个**全必填**）
 *     session/page   → `{request:{address:{kind:'session',sessionId},throughSeq,beforeSeq?,maxMessages?}}`
 *     session/cancel → `{request:{sessionId}}`  → `{accepted:true}`
 *     session/rename → `{request:{sessionId,title}}` → `{title,seq}`
 *   ⚠️ **没有 delete/dispose**：描述符里 `session/*` 只有上面这些（外加 search/fork/attachment/
 *      modelCatalog/selectModel/updateQueue/control/follow），不要发明一个删除方法。
 *
 *   `throughSeq` 从哪来（`session/page` 的必填项）
 *     ① `session/list` 每项的 `projections.asOfSeq` —— 投影快照的 as-of 序号，本身就是会话日志里的
 *        一个 seq（history.js `projectionBlock()` 直接搬 `snapshot.asOfSeq`；`follow()` 里没开投影时
 *        更是直接写 `{asOfSeq: cursor}`，证明它和会话 cursor 同尺度）。
 *     ② `session/follow` 首帧的 `cursor`（= 该会话当时**最后一条已提交事件**的 seq），
 *        以及其后每条 `event.seq`；本模块顺手记进 `#cursors`。
 *     两者都 ≤ 会话当前 cursor，所以取**较大者**只会让这一页更完整、不会越过 cursor。
 *     `pageSession` **每次都重新拉一次 `session/list`**（投影缓存可能落后于实时流，
 *     缓存只用于「list 失败」时兜底）；两处都拿不到就**显式失败** `through-seq-unavailable`，
 *     绝不猜一个魔法数字。
 *     ⚠️ 不用描述符允许的 `throughSeq: -1`：history.js `paginate()` 会把它算成
 *        `end = min(-1+1, …) = 0` → 返回**空页**（不是「最新一页」）。口径为负，故不采用。
 *
 *   助手结论文本的真实形状（`session/page` → `value.records[]`）
 *     `record = {type:'event', event:{type,seq,time,data}}`；助手消息是 `event.type === 'assistant/message'`，
 *     `event.data = {turn,step,message:{id,role:'assistant',source:{kind:'model',…},content:[…]},stream,usage?}`，
 *     可见文本块是 `{type:'text',text}`（`reasoning`/`tool-call`/`tool-result` 都**不是**结论）。
 *     证据：dsh-session/lib/types/types.d.ts:309（`SessionEventMap['assistant/message']`）
 *     + dsh-llm/lib/types/types.d.ts:39（`TextBlock`）。只挂 usage 的空 `content` 消息会被跳过，
 *     取**最后一条非空**文本；形状不认识就返回 `""`（永不抛出）。
 *
 * 硬性质（每一个都有测试兜着）
 *   ① 审批**有寿命**：只在 turn 开着时有效，绑在请求的 AbortSignal 上。
 *      `cancel` 帧一到就标记 expired，**再回执一律拒绝**；「没回复」绝不等于同意（fail-closed）。
 *   ② `$events` 的 emit **不重放**：重连后不假装连续，发 `{kind:'gap',from,to}` 让上层
 *      如实告诉用户「通知可能漏了」。
 *   ③ 401 自愈只存在于 HTTP 路径（bridge 的 WS 路径没有）：mux 握手被 401/403 拒绝时
 *      **停止重连**并 emit `auth-error`，由上层换 Cookie 后调 `retry()`。
 *
 * @module dsh-events
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

// ============================================================
// 常量（与 DSH 源码一一对应）
// ============================================================

/** mux WebSocket 路由（REMOTE_STREAM_MUX_PATH，已含 `/api`）。 */
export const MUX_PATH = "/api/remote.mux";
/** RPC 通道前缀（dsh-client-connection 的 `API_PATH`）。 */
export const API_CHANNEL = "/api";
/** 全局转发事件流**逻辑端点名**（REMOTE_EVENT_STREAM_ENDPOINT），不是 URL。 */
export const EVENTS_ENDPOINT = "$events";
/** 回执的**逻辑端点名**（REMOTE_EVENT_RESULT_ENDPOINT），用作 envelope 的 `method`。 */
export const RESULT_ENDPOINT = "$events/result";
/**
 * 回执的 HTTP 路由 = 通道 + 端点：`POST {upstream}/api/$events/result`。
 * ⚠️ 逻辑端点名不带前导 `/`，直接拼在 upstream 后面会得到 `http://host$events/result`（实测会
 * `Failed to parse URL`）—— 这是本模块踩过的坑，规格 §4 只写了逻辑名。
 */
export const RESULT_PATH = `${API_CHANNEL}/${RESULT_ENDPOINT}`;
/** 打开 $events 的空 payload（REMOTE_EVENT_STREAM_PAYLOAD）。 */
export const EVENTS_PAYLOAD = Object.freeze({ args: {} });
/**
 * 会话发现源 ①：`session/list`（**一元**远端方法，走 HTTP，不能开流）。
 * 返回 `{items: SessionSummary[]}`，每项带真实 `running: boolean` —— 这是「接进来时已经在跑的会话」
 * 唯一**确定性**的发现方式（`$events` 的 `api-session/status` 是边沿事件，接进来之前的那次永远不会补发）。
 * ⚠️ 线参名是 `_request`（不是 `request`）：实测送 `request` 会得到
 *    `gateway/arguments-invalid: missing "_request"; unexpected "request"`。
 */
export const SESSION_LIST_ENDPOINT = "session/list";
/** 会话发现源 ②：`session/control`（流）：baseline 给出实时会话集合，其后按会话推 queue/jobs/projection。 */
export const SESSION_CONTROL_ENDPOINT = "session/control";
/** `session/list` 的线参名（见上）。 */
export const SESSION_LIST_WIRE_ARG = "_request";
/**
 * 除 `session/list` 外**所有** `session/*` 一元方法的线参名都是 `request`
 * （typert.host.js 的 TYPERT.invocations 里每个都是 `{name:'request', wire:'request'}`）。
 */
export const SESSION_JSON_ARG = "request";
/** 新建会话（`{request:{workspaceId?,cwd?,sessionId?,agentPreset?}}` → `{sessionId,agentPreset?}`）。 */
export const SESSION_CREATE_ENDPOINT = "session/create";
/** 发一条消息（`{request:{requestId,sessionId,mode,content,clientTimeZone?}}` → `{accepted:true}`）。 */
export const SESSION_PROMPT_ENDPOINT = "session/prompt";
/** 读会话历史（`{request:{address,throughSeq,beforeSeq?,maxMessages?}}` → `{records,hasMore}`）。 */
export const SESSION_PAGE_ENDPOINT = "session/page";
/** 取消当前 turn（`{request:{sessionId}}` → `{accepted:true}`）。⚠️ 全 DSH 没有 delete/dispose 方法。 */
export const SESSION_CANCEL_ENDPOINT = "session/cancel";
/** 改会话标题（`{request:{sessionId,title}}` → `{title,seq}`）。 */
export const SESSION_RENAME_ENDPOINT = "session/rename";
/** 一元 RPC 的默认超时（ms）：网关卡住也不能把通知循环拖死。 */
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;
/** `#cursors`（throughSeq 兜底缓存）的条数上限。 */
const CURSOR_LIMIT = 512;

/** 分类后的节点 kind。前 4 个是规格 §5 的 P0，后 3 个是 P1 的本地钩子。 */
export const NODE_KINDS = Object.freeze({
  /** 1 要你拍板（工具放行）—— 可回执 */
  APPROVAL_REQUEST: "approval-request",
  /** 2 在等你回答（agent 提问）—— 可回执 */
  USER_QUESTION: "user-question",
  /** 2 计划模式待批（`intent.kind === 'plan-review'`）—— 可回执，文案与普通提问区分 */
  PLAN_REVIEW: "plan-review",
  /** 3 任务报错 */
  SESSION_ERROR: "session-error",
  /** 4 任务停止（来自 session/follow 的 turn/end，带精确 reason） */
  TURN_END: "turn-end",
  /** 附加：审批/提问已作废（规格 §6① 要求可显示「已过期」） */
  EVENT_EXPIRED: "event-expired",
  /** 附加：重连窗口，期间的通知可能已经漏了（规格 §6②） */
  GAP: "gap",
  /** 5 每日简报（本地定时触发） */
  DIGEST_DUE: "digest-due",
  /** 6 额度将尽 / 被限流 */
  QUOTA_LOW: "quota-low",
  /** 7 会员即将过期 / 已过期 */
  MEMBERSHIP_EXPIRING: "membership-expiring",
  /** 非致命故障（会话不存在 / 子代理被拒 / 流结束等） */
  FAULT: "fault",
});

/** `approval/request` 的合法回执值（DSH OUTCOMES 里属于「人做的决定」的两项）。 */
export const APPROVAL_OUTCOMES = Object.freeze(["allowed-once", "rejected"]);

/** 节点 1 的选项文案（编号选项由微信侧渲染）。 */
export const APPROVAL_CHOICES = Object.freeze([
  Object.freeze({ value: "allowed-once", label: "允许一次" }),
  Object.freeze({ value: "rejected", label: "拒绝" }),
]);

/** `turn/end.reason.kind` 闭集。 */
export const TURN_END_REASONS = Object.freeze([
  "completed",
  "aborted",
  "blocked",
  "error",
  "max-tokens",
  "interrupted",
]);

/** 会话 id 的持久前缀。 */
const SESSION_PREFIX = "session-";

// ============================================================
// 小工具
// ============================================================

/**
 * 补上 `session-` 前缀的「规范持久形式」。
 * @param {unknown} id - 会话 id。
 * @returns {string} 带前缀形式；非字符串/空返回空串。
 */
export function toDurableSessionId(id) {
  if (typeof id !== "string") return "";
  const trimmed = id.trim();
  if (trimmed === "") return "";
  return trimmed.startsWith(SESSION_PREFIX) ? trimmed : `${SESSION_PREFIX}${trimmed}`;
}

/**
 * 一条会话 id 的**候选线上形式**，按可信度排序：**第一个永远是原样**。
 *
 * 🔴 真机实测（2026-09-21，本机 dsh web）推翻了规格 §4 的说法：
 *   · 本会话（dsh web 建的根会话）的日志 id **是** `session-<uuid>`；
 *   · 但子代理会话的**真实日志 id 是裸 uuid**（`b7632f14-…`）：
 *     用裸 id 开 follow → `session/agent-busy`（说明**会话找到了**，只是子代理要按父地址取）；
 *     用 `session-<uuid>` 开 → `session/not-found`（这个 id 根本不存在）。
 *   所以「一律加前缀」是错的（会让非前缀 id 的会话永远 follow 不上），
 *   「一律原样」则对 `session-<uuid>` 的写法毫无容错。
 *   → 主形式用**事件里报什么就发什么**，另一种形式只在 `session/not-found` 时兜底试一次。
 *
 * @param {unknown} id - 事件里报的会话 id。
 * @returns {string[]} `[原样, 另一种形式]`；空 id 返回 `[]`。
 */
export function sessionIdCandidates(id) {
  if (typeof id !== "string") return [];
  const trimmed = id.trim();
  if (trimmed === "") return [];
  const alternate = trimmed.startsWith(SESSION_PREFIX)
    ? trimmed.slice(SESSION_PREFIX.length)
    : `${SESSION_PREFIX}${trimmed}`;
  return alternate === "" || alternate === trimmed ? [trimmed] : [trimmed, alternate];
}

/** 回执失败的类型化错误：服务端 `{ok:false,error}`、HTTP 状态、或本地 dedupe 拒绝。 */
export class EventAnswerError extends Error {
  /**
   * @param {string} code - 服务端 error.code，或本地码：`already-answered` | `event-expired`
   *   | `not-connected` | `bad-response` | `rpc-mismatch` | `http-<status>` | `network`。
   * @param {string} message - 面向人的说明（可直接转发给用户）。
   * @param {object} [extra] - `{details?, status?, rpcId?, eventId?}`。
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "EventAnswerError";
    this.code = code;
    this.details = extra.details;
    this.status = extra.status;
    this.rpcId = extra.rpcId;
    this.eventId = extra.eventId;
  }

  /** 是否「服务端明确告诉我们这事已经了结」——上层可以静默吞掉。 */
  get settled() {
    return this.code === "already-answered" || this.code === "event-expired";
  }
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** 「已了结」集合的上限：daemon 长跑时不能无限涨（Map 插入序 = 由旧到新淘汰）。 */
const SETTLED_LIMIT = 4096;

/**
 * 记下一个已了结的 eventId。
 * @param {Map<string, true>} settled - 目标集合。
 * @param {string} eventId - 事件 id。
 */
function markSettled(settled, eventId) {
  settled.set(eventId, true);
  while (settled.size > SETTLED_LIMIT) settled.delete(settled.keys().next().value);
}

/** 从 Cordis emit 的 args 里取一个可展示的字符串。 */
function messageOf(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ============================================================
// 一元 RPC 的小工具（纯函数，方便单测）
// ============================================================

/**
 * 类型化失败对象：**所有**一元方法失败时都返回这个形状（绝不抛异常）。
 * @param {string} code - 服务端 error.code 或本地码（`invalid-arguments` / `bad-response` /
 *   `timeout` / `network` / `through-seq-unavailable` / `http-<status>` / `rpc-mismatch` …）。
 * @param {string} message - 面向人的说明（可直接转发给用户）。
 * @param {unknown} [details] - 服务端给的细节（原样带出）。
 * @returns {{ok:false, code:string, message:string, details?:unknown}}
 */
function typedFailure(code, message, details) {
  return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };
}

/** 本地参数校验失败（不会发出任何请求）。 */
function invalidArguments(message) {
  return typedFailure("invalid-arguments", message);
}

/** 把抛出的东西（EventAnswerError / TypeError / 任意值）折成类型化失败。 */
function failureOf(error) {
  if (error instanceof EventAnswerError) {
    return typedFailure(error.code, error.message, error.details);
  }
  return typedFailure("internal", `未预期的错误：${messageOf(error) || String(error)}`);
}

/** 非空字符串？ */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** `session/list` 一项里的 `projections.asOfSeq`（拿不到返回 undefined）。 */
function asOfSeqOf(value, sessionId) {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  for (const item of items) {
    if (!isRecord(item) || item.sessionId !== sessionId) continue;
    const seq = isRecord(item.projections) ? item.projections.asOfSeq : undefined;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) return seq;
    return undefined;
  }
  return undefined;
}

/**
 * 从 `session/page` 的 `records` 里取**最后一条非空助手文本**。
 *
 * 真实形状（见模块头）：`record = {type:'event', event:{type:'assistant/message',
 * data:{turn,step,message:{id,role:'assistant',content:[{type:'text',text},…]}}}}`。
 * 只认 `{type:'text'}` 块：`reasoning` / `tool-call` / `tool-result` 都不是给用户看的结论。
 * 空 `content` 的 assistant/message（只挂 usage 的结算事件）会被跳过，因此结果是「最后一条**有字**的」。
 * 形状不认识 / 不是数组 / 什么都没有 → `""`（**永不抛出**，这是给通知循环用的）。
 *
 * @param {unknown} records - `pageSession().records`。
 * @returns {string} 结论文本；没有就空串。
 */
export function extractLastAssistantText(records) {
  if (!Array.isArray(records)) return "";
  let text = "";
  for (const record of records) {
    const event = isRecord(record) ? record.event : null;
    if (!isRecord(event) || event.type !== "assistant/message") continue;
    const data = isRecord(event.data) ? event.data : null;
    if (data === null) continue;
    // 主形状：data.message.content[]；兜底：data.content[]（防御式，字段名不假设唯一）。
    const message = isRecord(data.message) ? data.message : null;
    if (message !== null && message.role !== undefined && message.role !== "assistant") continue;
    const content = Array.isArray(message?.content) ? message.content : Array.isArray(data.content) ? data.content : null;
    if (content === null) continue;
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    const joined = parts.join("\n");
    if (joined.trim() !== "") text = joined; // 空文本不覆盖上一条（跳过只挂 usage 的结算消息）
  }
  return text;
}

// ============================================================
// 订阅器
// ============================================================

const DEFAULT_RECONNECT = Object.freeze({ minMs: 500, maxMs: 15_000, factor: 2, jitter: 0.2 });

/**
 * 一个 DSH 事件订阅器 = 一条 mux socket（$events 全局流）+ N 条 session/follow 流。
 *
 * 事件（EventEmitter；**不发 `'error'`**，避免无监听者时抛出）：
 *   - `'ready'`            `{clientId, host, at, generation}`：$events 就绪，clientId 已拿到
 *   - `'event'`            分类后的节点（见 classify*），微信侧唯一入口
 *   - `'gap'`              `{kind:'gap', from, to, reason, at}`：断线窗口，通知可能漏了
 *   - `'fault'`            `{kind:'fault', code, message, expected, sessionId?, at}`：非致命故障
 *   - `'auth-error'`       `{status, message, surface:'ws'|'http', at}`：需要换 Cookie
 *   - `'follow-opened'`    `{sessionId, streamId, at}`
 *   - `'follow-closed'`    `{sessionId, streamId, reason, at}`
 *   - `'follow-snapshot'`  `{sessionId, header, cursor, recordCount, at}`
 *   - `'session-state'`    `{sessionId, state:'running'|'idle'|'removed', at}`
 *   - `'sessions-discovered'` `{running: string[], total, at}`：`session/list` 发现结果
 *   - `'control-sessions'` `{sessions: string[], at}`：`session/control` baseline 的实时会话集合
 *   - `'control-activity'` `{sessionId, type, key?, at}`：某会话有 queue/jobs/projection 更新（= 活着）
 *   - `'closed'`           `{}`：主动 close() 完成
 */
class EventSubscriber extends EventEmitter {
  #opts;
  #WebSocketImpl;
  #fetchImpl;

  #state = "idle";
  #closed = false;
  #ws = null;
  #attempt = 0;
  #reconnectTimer = null;

  #clientId = null;
  #ready = null;
  #readyWaiters = [];

  /** streamId -> { endpoint, kind:'events'|'follow', sessionId? } */
  #streams = new Map();
  /** sessionId -> { streamId, openedAt, sawTurnEnd, settleTimer } */
  #follows = new Map();
  /** 当前认为「正在跑」的会话（api-session/status、api-session/added 的 running、session/list 的 running）。 */
  #running = new Set();
  /** sessionId -> 最近一次「实时 running 凭据」的时间（用于对账时不与刚来的边沿事件打架）。 */
  #runningLiveAt = new Map();
  /** `session/control` 观察到的实时会话集合（含未在跑的）。 */
  #controlSessions = new Set();
  #controlStreamId = null;
  #discoverTimer = null;
  /** 已就 `(sessionId, seq)` 报过的 turn/end，避免 snapshot 补报与实时帧重复。 */
  #reportedTurnEnds = new Map();
  /** 本代内开流失败过的会话：不再重试，避免 session/not-found 打转。重连后清空。 */
  #followBlocked = new Set();

  /** 已回执过的 eventId（一次有效，绝不重发）；用 Map 保持插入序以便有界淘汰。 */
  #answered = new Map();
  /** 已作废的 eventId（收到 cancel 帧）；再回执一律拒绝。 */
  #expired = new Map();
  /** eventId -> 分类节点（供上层按 eventId 查文案）。 */
  #pending = new Map();
  /**
   * sessionId -> 已知的最大会话 seq（`session/follow` 的 snapshot.cursor 与每条 event.seq，
   * 以及 `session/list` 的 projections.asOfSeq）。`session/page` 的 `throughSeq` 用它兜底。
   */
  #cursors = new Map();

  #seq = 0;
  #lastFrameAt = 0;
  #authStatus = null;
  #lastSocketError = null;
  #now;

  constructor(options = {}) {
    super();
    if (typeof options.upstream !== "string" || options.upstream.trim() === "") {
      throw new TypeError("dsh-events: options.upstream is required (e.g. http://127.0.0.1:3080)");
    }
    this.#opts = {
      upstream: options.upstream.replace(/\/+$/, ""),
      cookie: options.cookie ?? "",
      muxPath: options.muxPath ?? MUX_PATH,
      /** HTTP 路由（默认 `/api/$events/result`）。 */
      resultPath: options.resultPath ?? RESULT_PATH,
      /** envelope 里的逻辑方法名（默认 `$events/result`）。 */
      resultEndpoint: options.resultEndpoint ?? RESULT_ENDPOINT,
      reconnect: { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) },
      /** 会话停止运行后，再等这么久收尾 turn/end 帧，然后关流（防止 socket 泄漏）。 */
      followSettleMs: options.followSettleMs ?? 1_500,
      /** 同时打开的 follow 流上限（子代理会话会被拒，上限也保护 DSH）。 */
      maxFollowStreams: options.maxFollowStreams ?? 8,
      /** 是否管理 follow 订阅集（false = 只订阅 $events）。 */
      follow: options.follow !== false,
      /** 用 `session/list` 发现「接进来时已经在跑」的会话（默认开）。 */
      discover: options.discover !== false,
      /**
       * 对账间隔（ms）：周期性核对已 follow 的会话是否还在跑，不在跑就关流（防泄漏）。
       * 0 = 关闭周期对账（仍会在每次连接时发现一次）。
       * 只在**手上有 follow 流**时才真的发这一次请求（没有流就没有可对账的东西）。
       */
      discoverIntervalMs: options.discoverIntervalMs ?? 120_000,
      /** 是否订阅 `session/control`（实时会话集合 + 活跃度；默认开）。 */
      control: options.control !== false,
      /**
       * 一元 RPC 的超时（ms）。0/负数/非有限值 = 不设超时（不建议）。
       * 超时既 abort 掉这次 fetch，也让 promise 立刻以 `code:'timeout'` 结算，
       * 所以即使注入的 fetchImpl 不认 signal，也**不会**把调用方挂住。
       */
      rpcTimeoutMs: options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      log: typeof options.log === "function" ? options.log : null,
    };
    this.#WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.#fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#now = typeof options.now === "function" ? options.now : () => Date.now();
  }

  // ---------- 只读状态 ----------

  get state() {
    return this.#state;
  }

  /** 当前 $events 世代的 clientId（回执必需），未就绪时为 null。 */
  get clientId() {
    return this.#clientId;
  }

  /** 当前已打开的 follow 会话 id 列表（测试「无 socket 泄漏」用）。 */
  sessions() {
    return [...this.#follows.keys()];
  }

  /** 当前持有的事件 id 列表（未结算的 waterfall 事件）。 */
  pendingEvents() {
    return [...this.#pending.keys()];
  }

  // ---------- 生命周期 ----------

  /** 开始连接（幂等）。就绪请 await `whenReady()` 或监听 `'ready'`。 */
  start() {
    if (this.#closed) throw new Error("dsh-events: subscriber is closed");
    if (this.#state !== "idle") return this;
    this.#connect();
    return this;
  }

  /** 等下一个（或当前这一代的）ready。 */
  whenReady() {
    if (this.#ready !== null) return Promise.resolve(this.#ready);
    return new Promise((resolve) => {
      this.#readyWaiters.push(resolve);
    });
  }

  /** 401/403 之后：Cookie 已换新，手动重试（会重新读 cookie，可以是函数）。 */
  retry() {
    if (this.#closed) return this;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#state === "auth-failed" || this.#state === "idle") {
      this.#authStatus = null;
      this.#attempt = 0;
      if (this.#ws !== null && this.#ws.readyState === this.#WebSocketImpl.OPEN) return this;
      this.#connect();
    }
    return this;
  }

  /** 关闭：取消所有流、断开 socket、清定时器。之后不可再 start()。 */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = "closed";
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#discoverTimer !== null) {
      clearTimeout(this.#discoverTimer);
      this.#discoverTimer = null;
    }
    for (const [sessionId, entry] of this.#follows) {
      if (entry.settleTimer !== null) clearTimeout(entry.settleTimer);
      this.emit("follow-closed", {
        sessionId,
        streamId: entry.streamId,
        reason: "closed",
        at: this.#now(),
      });
    }
    this.#follows.clear();
    this.#streams.clear();
    this.#controlStreamId = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws !== null) {
      try {
        ws.removeAllListeners();
        ws.close(1000, "subscriber closed");
      } catch {
        /* 关不掉就等 GC */
      }
    }
    this.emit("closed", {});
  }

  // ---------- 连接 ----------

  #log(level, message, meta) {
    if (this.#opts.log === null) return;
    try {
      this.#opts.log(level, message, meta);
    } catch {
      /* 日志失败不得影响业务 */
    }
  }

  #cookieValue() {
    const raw = this.#opts.cookie;
    try {
      const value = typeof raw === "function" ? raw() : raw;
      return typeof value === "string" ? value.trim() : "";
    } catch (error) {
      this.#log("warn", "cookie getter threw", { error: String(error) });
      return "";
    }
  }

  #muxUrl() {
    const url = new URL(this.#opts.upstream);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = this.#opts.muxPath;
    url.search = "";
    url.hash = "";
    return url.href;
  }

  #connect() {
    if (this.#closed) return;
    this.#state = "connecting";
    let url;
    try {
      url = this.#muxUrl();
    } catch (error) {
      this.#state = "auth-failed";
      this.#emitAuthError(0, `upstream 不是合法 URL: ${String(error)}`, "ws");
      return;
    }
    // Host 显式写成上游 authority（loopback 围栏），Cookie 复用 bridge 已持有的浏览器会话。
    const headers = { Host: new URL(this.#opts.upstream).host };
    const cookie = this.#cookieValue();
    if (cookie !== "") headers.Cookie = cookie;

    let ws;
    try {
      ws = new this.#WebSocketImpl(url, { headers, perMessageDeflate: false });
    } catch (error) {
      this.#lastSocketError = String(error);
      this.#scheduleReconnect("socket-construct-failed");
      return;
    }
    this.#ws = ws;
    this.#authStatus = null;

    ws.on("open", () => {
      if (this.#ws !== ws || this.#closed) return;
      this.#state = "ready-pending";
      this.#lastFrameAt = this.#now();
      this.#openStream(EVENTS_ENDPOINT, EVENTS_PAYLOAD, { kind: "events" });
    });

    ws.on("message", (data, isBinary) => {
      if (this.#ws !== ws) return;
      if (isBinary) return; // mux 只发文本；二进制帧忽略
      this.#onTextFrame(data);
    });

    ws.on("unexpected-response", (req, res) => {
      this.#authStatus = res.statusCode;
      this.#lastSocketError = `HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim();
      try {
        res.resume();
      } catch {
        /* 已消费 */
      }
      try {
        ws.terminate();
      } catch {
        /* 已断 */
      }
    });

    ws.on("error", (error) => {
      this.#lastSocketError = error?.message ?? String(error);
    });

    ws.on("close", (code, reason) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#onSocketClosed(code, reason);
    });
  }

  #emitFault(code, message, extra = {}) {
    this.emit("fault", {
      kind: NODE_KINDS.FAULT,
      code,
      message,
      expected: extra.expected === true,
      sessionId: extra.sessionId,
      ...(extra.details === undefined ? {} : { details: extra.details }),
      at: this.#now(),
    });
  }

  #emitAuthError(status, message, surface) {
    this.emit("auth-error", { status, message, surface, at: this.#now() });
  }

  #onSocketClosed(code, reasonText) {
    const wasReady = this.#ready !== null;
    const from = this.#lastFrameAt !== 0 ? this.#lastFrameAt : this.#now();

    // 这一代的所有流都随 socket 消失：静默清空（gap 标记负责「漏了什么」的诚实）。
    for (const [sessionId, entry] of this.#follows) {
      if (entry.settleTimer !== null) clearTimeout(entry.settleTimer);
      this.emit("follow-closed", {
        sessionId,
        streamId: entry.streamId,
        reason: "socket-closed",
        at: this.#now(),
      });
    }
    this.#follows.clear();
    this.#streams.clear();
    this.#controlStreamId = null;
    this.#clientId = null;
    this.#ready = null;
    this.#pending.clear();
    this.#followBlocked.clear();

    if (this.#closed) return;

    const authStatus = this.#authStatus;
    if (authStatus === 401 || authStatus === 403) {
      this.#state = "auth-failed";
      this.#emitAuthError(
        authStatus,
        `mux 握手被拒（HTTP ${authStatus}）：$events 的 WS 路径没有 401 自愈，请换个 Cookie 后调 retry()`,
        "ws",
      );
      return;
    }

    if (wasReady) {
      this.emit("gap", {
        kind: NODE_KINDS.GAP,
        from,
        to: this.#now(),
        reason: `socket-closed(${code}${reasonText && reasonText.length ? ":" + reasonText.toString() : ""})`,
        at: this.#now(),
      });
    } else {
      this.#emitFault("connect-failed", `mux 连接未能就绪：${this.#lastSocketError ?? `close ${code}`}`);
    }
    this.#scheduleReconnect("socket-closed");
  }

  #scheduleReconnect(reason) {
    if (this.#closed || this.#reconnectTimer !== null) return;
    const { minMs, maxMs, factor, jitter } = this.#opts.reconnect;
    const base = Math.min(maxMs, minMs * factor ** this.#attempt);
    const delay = Math.max(0, Math.round(base * (1 - jitter + Math.random() * jitter * 2)));
    this.#attempt += 1;
    this.#state = "reconnecting";
    this.#log("info", "mux 重连中", { reason, delay, attempt: this.#attempt });
    const timer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    timer.unref?.();
    this.#reconnectTimer = timer;
  }

  #send(frame) {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== this.#WebSocketImpl.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.#log("warn", "mux 发送失败", { error: String(error) });
      return false;
    }
  }

  // ---------- mux 流 ----------

  #openStream(endpoint, payload, meta) {
    const streamId = `s${++this.#seq}`;
    // 自带的 streamId 让「这一帧属于哪条流」在回调里可判（迟到帧比对用）。
    this.#streams.set(streamId, { streamId, endpoint, ...meta });
    this.#send({ type: "open", streamId, endpoint, payload });
    return streamId;
  }

  #cancelStream(streamId) {
    if (!this.#streams.has(streamId)) return;
    this.#streams.delete(streamId);
    this.#send({ type: "cancel", streamId });
  }

  #onTextFrame(data) {
    let frame;
    try {
      frame = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      this.#log("warn", "mux 帧不是 JSON，已忽略");
      return;
    }
    if (!isRecord(frame) || typeof frame.type !== "string") return;
    this.#lastFrameAt = this.#now();

    const streamId = typeof frame.streamId === "string" ? frame.streamId : "";
    const stream = this.#streams.get(streamId);

    if (frame.type === "item") {
      if (stream === undefined) return; // 已取消流的迟到帧
      if (stream.kind === "events") this.#onEventsValue(frame.value);
      else if (stream.kind === "control") this.#onControlValue(frame.value);
      else this.#onFollowValue(stream, frame.value);
      return;
    }
    /**
     * 防御分支:**顶层 waterfall 帧**。
     *
     * 🔴 更正(2026-09-20):这里原先的注释写着「对真实 DSH 实测到的形状」—— **那是错的**,
     * 我当时是被自己写错的假上游误导(假 mux 既发顶层帧、又用了不存在的 streamId),
     * 于是把"我的假上游不对"误判成了"协议是顶层形态"。
     *
     * **真实形状是包在 `item` 里的**(证据,均查过源码):
     *   · `dsh-api-gateway/lib/index.js` 的 `pump()`:
     *       `for await (const value of source) await this.send({type:"item",streamId,value})`
     *     —— **每个**生成器产出都被这层包住。
     *   · 生产者在同文件把 `{type:"waterfall",…}` 推进 per-client queue,queue 产出即该 `value`。
     *   · DSH **自己的浏览器客户端** `dsh-api-gateway/lib/client.js:729` 也在
     *     `value.type === "waterfall"` 上解析 —— 若真机发顶层帧,DSH 自己的 UI 会把每次审批
     *     都丢掉,而审批正是那个 UI 在答的。这是最硬的反证。
     *   · `dsh-client-connection/lib/client.js:5599` 的顶层字面量是**测试 fixture**
     *     (`approvalInvocation`,reason「fixture 常驻审批」),不是协议。
     *
     * 所以**主路径是 `#onEventsValue` 里的内嵌形态**(见 `value.type === "waterfall"`),
     * 端到端测试 test/wechat-e2e.test.mjs 用的就是真实形状。本分支仅作**未观测形态的兜底**,
     * 万一服务端将来改包裹方式不至于静默丢审批;它由同文件的一条用例覆盖,不是死代码。
     */
    if (frame.type === "waterfall") {
      const node = classifyWaterfall(frame, this.#now());
      if (node === null) return;
      this.#pending.set(node.eventId, node);
      this.emit("event", node);
      return;
    }
    if (frame.type === "error") {
      this.#onStreamError(streamId, stream, frame.error);
      return;
    }
    if (frame.type === "end") {
      this.#onStreamEnd(streamId, stream);
    }
  }

  // ---------- $events ----------

  #onEventsValue(value) {
    if (!isRecord(value) || typeof value.type !== "string") return;

    if (value.type === "ready") {
      if (typeof value.clientId !== "string" || value.clientId === "") {
        // 没有 clientId 就永远回不了执；如实报故障，不假装就绪。
        this.#emitFault("ready-without-client-id", "$events 的 ready 帧没有 clientId，无法回执任何事件");
        return;
      }
      this.#clientId = value.clientId;
      const ready = {
        clientId: value.clientId,
        host: isRecord(value.host) ? value.host : undefined,
        at: this.#now(),
        generation: this.#attempt + 1,
      };
      this.#ready = ready;
      this.#state = "ready";
      this.#attempt = 0;
      for (const resolve of this.#readyWaiters.splice(0)) resolve(ready);
      this.emit("ready", ready);
      this.#openControlStream();
      this.#reconcileFollows();
      // 「接进来时已经在跑」的会话只能靠 session/list 发现（status 是边沿事件，不会补发）。
      void this.discoverRunningSessions().catch(() => {});
      this.#scheduleDiscovery();
      return;
    }

    if (value.type === "cancel") {
      const eventId = typeof value.eventId === "string" ? value.eventId : "";
      if (eventId === "") return;
      this.#settleEvent(eventId, "cancelled-by-host");
      return;
    }

    if (value.type === "emit") {
      this.#onEmitFrame(value);
      return;
    }

    if (value.type === "waterfall") {
      const node = classifyWaterfall(value, this.#now());
      if (node === null) return;
      this.#pending.set(node.eventId, node);
      this.emit("event", node);
    }
  }

  #onEmitFrame(value) {
    const event = typeof value.event === "string" ? value.event : "";
    const args = Array.isArray(value.args) ? value.args : [];
    this.#onSessionStateEvent(event, args);
    const node = classifyEmit(event, args, this.#now());
    if (node !== null) this.emit("event", node);
  }

  /**
   * 用 added / removed / status 对账 follow 订阅集（规格 §3「管理订阅集」）。
   * status 是边沿事件，所以 added（带 running）也要参与对账。
   */
  #onSessionStateEvent(event, args) {
    if (event === "api-session/status") {
      const sessionId = args[0];
      if (typeof sessionId !== "string" || sessionId === "") return;
      const running = args[1] === true;
      const entry = this.#follows.get(sessionId);
      if (running) {
        this.#running.add(sessionId);
        this.#runningLiveAt.set(sessionId, this.#now());
        if (entry !== undefined) entry.liveAt = this.#now();
        if (entry !== undefined && entry.settleTimer !== null) {
          clearTimeout(entry.settleTimer);
          entry.settleTimer = null;
        }
        this.#ensureFollow(sessionId);
      } else {
        this.#running.delete(sessionId);
        this.#scheduleFollowClose(sessionId, "idle");
      }
      this.emit("session-state", { sessionId, state: running ? "running" : "idle", at: this.#now() });
      return;
    }
    if (event === "api-session/removed") {
      const sessionId = args[0];
      if (typeof sessionId !== "string" || sessionId === "") return;
      this.#running.delete(sessionId);
      this.#runningLiveAt.delete(sessionId);
      this.#followBlocked.delete(sessionId);
      this.#closeFollow(sessionId, "removed");
      this.emit("session-state", { sessionId, state: "removed", at: this.#now() });
      return;
    }
    // api-session/added：summary 自带 `running`（真机字段：sessionId/updatedAt/running/blank/…）。
    // `api-session/status` 是**边沿**事件 —— 我们接进来之前就已经在跑的会话不会再发 status:true，
    // 所以这里用 added 的 running 兜住「在我们眼皮底下新建且立即开跑」的会话。
    if (event === "api-session/added") {
      const summary = isRecord(args[0]) ? args[0] : null;
      const sessionId = typeof summary?.sessionId === "string" ? summary.sessionId : "";
      if (sessionId === "" || summary?.running !== true) return;
      this.#running.add(sessionId);
      this.#runningLiveAt.set(sessionId, this.#now());
      this.#ensureFollow(sessionId);
    }
  }

  /**
   * 会话停下后关流。
   * 已经收到过这条会话的 turn/end → 立即关（后面不会再有本轮的帧）；
   * 否则等 `followSettleMs` 收尾那条可能还在路上的 turn/end，避免漏报停止原因。
   */
  #scheduleFollowClose(sessionId, reason) {
    const entry = this.#follows.get(sessionId);
    if (entry === undefined) return;
    const settleMs = Math.max(0, this.#opts.followSettleMs);
    if (entry.settleTimer !== null) clearTimeout(entry.settleTimer);
    if (entry.sawTurnEnd) {
      this.#closeFollow(sessionId, "turn-end");
      return;
    }
    if (settleMs === 0) {
      this.#closeFollow(sessionId, reason);
      return;
    }
    const timer = setTimeout(() => {
      const current = this.#follows.get(sessionId);
      if (current !== entry) return;
      entry.settleTimer = null;
      this.#closeFollow(sessionId, reason);
    }, settleMs);
    timer.unref?.();
    entry.settleTimer = timer;
  }

  #reconcileFollows() {
    if (!this.#opts.follow) return;
    for (const sessionId of this.#running) this.#ensureFollow(sessionId);
  }

  // ---------- 会话发现（$events 的补洞） ----------

  /**
   * 开 `session/control`：baseline 给出实时会话集合，其后按会话推 queue/jobs/projection。
   * 它**没有 running 字段**（baseline 只有 queues/jobs/projections 三个键），所以它负责
   * 「谁存在 + 谁在活跃」，而「谁在跑」由 `session/list` 的 running 决定。
   */
  #openControlStream() {
    if (!this.#opts.control || this.#controlStreamId !== null) return;
    this.#controlStreamId = this.#openStream(SESSION_CONTROL_ENDPOINT, EVENTS_PAYLOAD, { kind: "control" });
  }

  /**
   * 用一元 `session/list` 发现正在跑的会话，并做一次对账。
   * 每次连接后调用一次；`discoverIntervalMs > 0` 时还会周期性调用（只在我们手上确实有 follow 流时）。
   * @returns {Promise<string[]>} 本次发现的 running 会话 id（按服务端顺序）。
   */
  async discoverRunningSessions() {
    if (!this.#opts.discover || this.#closed || this.#state !== "ready") return [];
    const startedAt = this.#now();
    let value;
    try {
      ({ value } = await this.#rpc(SESSION_LIST_ENDPOINT, { [SESSION_LIST_WIRE_ARG]: {} }));
    } catch (error) {
      this.#emitFault("discovery-failed", `session/list 失败，无法发现已在跑的会话：${error?.message ?? error}`, {
        details: error?.details,
      });
      return [];
    }
    if (this.#closed) return [];
    const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
    const running = [];
    const runningIds = new Set();
    for (const item of items) {
      if (!isRecord(item) || typeof item.sessionId !== "string" || item.sessionId === "") continue;
      if (item.running !== true) continue;
      running.push(item.sessionId);
      runningIds.add(item.sessionId);
    }

    // 对账：列表说不在跑、且**没有**比本次列表「不更晚」的实时 running 凭据 → 关流（防泄漏）。
    // `liveAt` 只在 status:true / added(running) 时更新，避免和「刚开跑」的边沿事件打架。
    //
    // 🔴 这里是 `>=` 而不是 `>`：两个时间戳都是 **ms 精度** 的 `Date.now()`。连接时
    //    `#onEventsValue` 在一个同步块里依次做「resolve whenReady」、「开 control」、
    //    「`discoverRunningSessions()`（= 此刻记 startedAt，随后才发 HTTP）」，
    //    而上层拿到 ready 后立刻推来的 `status:true` 极可能**落在同一毫秒** —— 于是
    //    `entry.liveAt === startedAt`，写成 `>` 就会把「刚刚才报在跑」的会话当成过期列表的
    //    牺牲品关掉（真机后果：那一轮的 turn/end 静默丢失，正是本模块最怕的 P0 丢通知）。
    //    取 `>=` = 「凭据不早于我开始列表」就信凭据；真已停跑的会话会在**下一轮**对账
    //    （startedAt 严格更大）里被关掉，所以不会泄漏 follow 流。
    for (const sessionId of [...this.#follows.keys()]) {
      if (runningIds.has(sessionId)) continue;
      const entry = this.#follows.get(sessionId);
      if (entry === undefined || entry.liveAt >= startedAt) continue;
      this.#closeFollow(sessionId, "not-running");
    }

    for (const sessionId of running) {
      this.#running.add(sessionId);
      this.#ensureFollow(sessionId, undefined, { reconcile: true });
    }
    this.emit("sessions-discovered", {
      running,
      total: items.length,
      at: this.#now(),
    });
    return running;
  }

  #scheduleDiscovery() {
    if (this.#discoverTimer !== null) clearTimeout(this.#discoverTimer);
    const interval = Number(this.#opts.discoverIntervalMs);
    if (!this.#opts.discover || !Number.isFinite(interval) || interval <= 0) return;
    const timer = setTimeout(() => {
      this.#discoverTimer = null;
      if (this.#closed || this.#state !== "ready") return;
      // 没有 follow 流就没有可对账的东西；但**每代**至少发现过一次（连接时就做过了）。
      if (this.#follows.size > 0) void this.discoverRunningSessions().catch(() => {});
      this.#scheduleDiscovery();
    }, interval);
    timer.unref?.();
    this.#discoverTimer = timer;
  }

  /**
   * 显式 follow 一条会话（bridge 想在发现机制之外自己指定时用）。
   * @param {string} sessionId - 事件/面板给的会话 id（原样发送为主形式）。
   * @returns {string|null} streamId；未就绪/被跳过时为 null。
   */
  followSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    this.#running.add(sessionId);
    this.#ensureFollow(sessionId);
    const entry = this.#follows.get(sessionId);
    return entry === undefined ? null : entry.streamId;
  }

  /** `session/control` 观察到的实时会话集合（含未在跑的）。 */
  controlSessions() {
    return [...this.#controlSessions];
  }

  /**
   * 为一条会话开 follow 流。
   * @param {string} sessionId - 事件里报的会话 id（作为 map key）。
   * @param {string[]} [candidates] - 线上候选 id，默认 `sessionIdCandidates(sessionId)`。
   *   `candidates[0]` 是主形式（原样），其余只在 `session/not-found` 时兜底各试一次。
   */
  #ensureFollow(sessionId, candidates = sessionIdCandidates(sessionId), options = {}) {
    if (!this.#opts.follow || this.#closed || this.#state !== "ready") return;
    if (candidates.length === 0) return;
    if (this.#follows.has(sessionId)) return;
    if (this.#followBlocked.has(sessionId)) return; // 本代已失败过，不重试打转
    if (this.#follows.size >= this.#opts.maxFollowStreams) {
      this.#emitFault("follow-limit", `follow 流已达上限 ${this.#opts.maxFollowStreams}，跳过 ${sessionId}`, {
        sessionId,
      });
      return;
    }
    const [wireId, ...alternates] = candidates;
    // ⚠️ 线上 payload 必须是**恰好一个** `args` 字段（gateway remoteRequest 校验，见
    // dsh-api-gateway/lib/index.js:929），`request` 是 args 里的具名线参 ——
    // 规格 §4 给的是 args 内层对象，直接当 payload 发会被服务端
    // `gateway/internal: Remote payload must contain exactly one plain-object args field` 拒掉（实测）。
    const streamId = this.#openStream(
      "session/follow",
      { args: { request: { address: { kind: "session", sessionId: wireId } } } },
      { kind: "follow", sessionId },
    );
    const entry = {
      streamId,
      wireId,
      alternates,
      openedAt: this.#now(),
      sawTurnEnd: false,
      settleTimer: null,
      /** 最近一次「实时 running 凭据」的时间（status:true / added(running)）；0 = 没有。 */
      liveAt: this.#runningLiveAt.get(sessionId) ?? 0,
      /** 由 session/list 发现而开的流：其 snapshot 里的尾部 turn/end 可以补报（见 #onFollowValue）。 */
      reconcile: options.reconcile === true,
    };
    this.#follows.set(sessionId, entry);
    this.emit("follow-opened", { sessionId, streamId, wireId, at: this.#now() });
  }

  #closeFollow(sessionId, reason) {
    const entry = this.#follows.get(sessionId);
    if (entry === undefined) return;
    if (entry.settleTimer !== null) clearTimeout(entry.settleTimer);
    this.#follows.delete(sessionId);
    this.#cancelStream(entry.streamId);
    this.emit("follow-closed", { sessionId, streamId: entry.streamId, reason, at: this.#now() });
  }

  // ---------- session/control（实时会话集合 + 活跃度） ----------

  /**
   * 处理一条 `SessionControlFrame`（键集与实现见 dsh-api-session-controller
   * `lib/types/types.d.ts:523` + `lib/index.js control():1042`）：
   *   - `{type:'baseline', value:{queues,jobs,projections}}`：**没有 sessions 键**，
   *     会话 id 就是这三个 map 的键（实测三者的键集完全一致）。
   *   - `{type:'queue'|'jobs', sessionId, …}` / `{type:'projection', sessionId, key, value, seq}`：
   *     按会话推的增量帧 —— 一条会话在写 projection 就说明它活着（在跑），可作为 follow 的触发。
   */
  #onControlValue(value) {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "baseline") {
      const block = isRecord(value.value) ? value.value : {};
      const ids = new Set();
      for (const key of ["queues", "jobs", "projections"]) {
        const map = block[key];
        if (!isRecord(map)) continue;
        for (const sessionId of Object.keys(map)) if (sessionId !== "") ids.add(sessionId);
      }
      this.#controlSessions = ids;
      this.emit("control-sessions", { sessions: [...ids], at: this.#now() });
      return;
    }
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
    if (sessionId === "") return;
    this.#controlSessions.add(sessionId);
    this.emit("control-activity", {
      sessionId,
      type: value.type,
      key: typeof value.key === "string" ? value.key : undefined,
      at: this.#now(),
    });
    // 活跃 = 在跑；$events 的 status 是边沿事件，这条是电平补充（幂等，已 follow 就直接返回）。
    this.#ensureFollow(sessionId);
  }

  // ---------- session/follow ----------

  #onFollowValue(stream, value) {
    if (!isRecord(value) || typeof value.type !== "string") return;
    const sessionId = stream.sessionId;

    if (value.type === "snapshot") {
      const header = isRecord(value.header) ? value.header : {};
      const records = Array.isArray(value.records) ? value.records : [];
      // snapshot.cursor = 该会话**最后一条已提交事件**的 seq → `session/page` 的 throughSeq 可用它。
      this.#rememberCursor(sessionId, value.cursor);
      this.emit("follow-snapshot", {
        sessionId,
        header,
        cursor: value.cursor,
        recordCount: records.length,
        at: this.#now(),
      });
      // 一般**不**把 snapshot.records 当通知会被历史重播；唯一例外是「补报」流：
      //   reconcile 流是为「接进来时已经在跑的会话」开的，若它的最后一条记录就是 turn/end，
      //   说明这一轮在我们挂上之前刚好结束 —— 那正是 §6② 里「会静默丢失」的那条停止通知。
      //   只在**最后一条**是 turn/end 时才补（会话若还在第二轮里跑，最后一条就不会是 turn/end）。
      const entry = this.#follows.get(sessionId);
      const last = records.at(-1);
      const lastEvent = isRecord(last) && isRecord(last.event) ? last.event : null;
      if (entry?.reconcile === true && (entry.reconcileUsed ?? false) === false && lastEvent?.type === "turn/end") {
        entry.reconcileUsed = true;
        const node = classifyTurnEnd(sessionId, lastEvent, this.#now());
        if (this.#markTurnEnd(node)) this.emit("event", { ...node, fromSnapshot: true });
      }
      return;
    }

    if (value.type !== "event") return; // assistant-stream 等忽略
    const event = isRecord(value.event) ? value.event : null;
    this.#rememberCursor(sessionId, event?.seq); // 每条事件都把 throughSeq 的水位往前推
    if (event === null || event.type !== "turn/end") return;

    const entry = this.#follows.get(sessionId);
    if (entry !== undefined && entry.streamId === stream.streamId) entry.sawTurnEnd = true;

    const node = classifyTurnEnd(sessionId, event, this.#now());
    if (this.#markTurnEnd(node)) this.emit("event", node);
    if (!this.#running.has(sessionId)) this.#closeFollow(sessionId, "turn-end");
  }

  /**
   * 记下一条 turn/end，重复的（同一 sessionId + seq）不重复上报。
   * snapshot 补报与实时帧可能指向同一条。
   * @param {object} node - `classifyTurnEnd` 的结果。
   * @returns {boolean} 是否值得上报。
   */
  #markTurnEnd(node) {
    const key = `${node.sessionId}#${String(node.seq ?? "?")}#${String(node.turn ?? "?")}`;
    if (this.#reportedTurnEnds.has(key)) return false;
    this.#reportedTurnEnds.set(key, true);
    while (this.#reportedTurnEnds.size > SETTLED_LIMIT) {
      this.#reportedTurnEnds.delete(this.#reportedTurnEnds.keys().next().value);
    }
    return true;
  }

  // ---------- 流级错误/结束 ----------

  #onStreamError(streamId, stream, error) {
    this.#streams.delete(streamId);
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "gateway/internal";
    const message = isRecord(error) && typeof error.message === "string" ? error.message : "unknown stream error";
    const details = isRecord(error) ? error.details : undefined;

    if (stream === undefined) {
      this.#emitFault(code, message);
      return;
    }
    if (stream.kind === "follow") {
      const sessionId = stream.sessionId;
      const entry = this.#follows.get(sessionId);
      if (entry !== undefined && entry.settleTimer !== null) clearTimeout(entry.settleTimer);
      this.#follows.delete(sessionId);
      // `session/not-found` 且还有候选 id 形式 → 换个形式再试一次（各形式最多一次，不会打转）。
      // 真机实测：子代理会话的真实 id 是裸 uuid，`session-<uuid>` 会 not-found —— 反过来也可能。
      if (code === "session/not-found" && entry !== undefined && entry.alternates.length > 0) {
        this.#emitFault(code, message, { expected: true, sessionId, details });
        this.emit("follow-closed", { sessionId, streamId, reason: `error:${code}`, at: this.#now() });
        this.#ensureFollow(sessionId, entry.alternates);
        return;
      }
      // 子代理会话必然被拒（session/agent-busy），这是**预期**的非致命条件；
      // 会话刚被删的 session/not-found 同理。都只标记本代不再重试，绝不重试打转。
      const expected = code === "session/agent-busy" || code === "session/not-found";
      this.#followBlocked.add(sessionId);
      this.#emitFault(code, message, { expected, sessionId, details });
      this.emit("follow-closed", { sessionId, streamId, reason: `error:${code}`, at: this.#now() });
      return;
    }
    if (stream.kind === "control") {
      // control 只是「发现/活跃度」的冗余来源，掉了不致命（$events 仍在）。下次重连会重开。
      this.#controlStreamId = null;
      this.#emitFault(code, message, { details });
      return;
    }
    // $events 流本身报错 = 观察能力没了：记故障并断开重连（不假装连续）。
    this.#emitFault(code, message, { details });
    try {
      this.#ws?.terminate();
    } catch {
      /* 已断 */
    }
  }

  #onStreamEnd(streamId, stream) {
    this.#streams.delete(streamId);
    if (stream === undefined) return;
    if (stream.kind === "follow") {
      const sessionId = stream.sessionId;
      const entry = this.#follows.get(sessionId);
      if (entry !== undefined && entry.settleTimer !== null) clearTimeout(entry.settleTimer);
      this.#follows.delete(sessionId);
      this.emit("follow-closed", { sessionId, streamId, reason: "end", at: this.#now() });
      return;
    }
    if (stream.kind === "control") {
      this.#controlStreamId = null;
      this.#emitFault("control-stream-ended", "session/control 被服务端结束（发现/活跃度冗余失效，$events 仍在）");
      return;
    }
    // $events 正常结束是不正常的：服务端 registerRemoteEvents 消失才会这样。
    this.#emitFault("events-stream-ended", "$events 流被服务端结束，将重连（其间事件可能已漏）");
    try {
      this.#ws?.terminate();
    } catch {
      /* 已断 */
    }
  }

  // ---------- 回执（HTTP，不是 socket） ----------

  /**
   * 回执一个事件。**每个 eventId 只发一次**：第二次直接抛 `already-answered`，
   * 已作废（收到 cancel 帧）的事件抛 `event-expired`。
   * @param {string} eventId - waterfall 帧上的 eventId。
   * @param {object} outcome - 线上 outcome：`{kind:'result', value:…}`。
   * @returns {Promise<{ok:true, eventId:string, rpcId:string, status:number}>}
   * @throws {EventAnswerError} 服务端拒绝 / 未连接 / 重复回执。
   */
  async answer(eventId, outcome) {
    if (typeof eventId !== "string" || eventId === "") {
      throw new TypeError("dsh-events: answer(eventId, outcome) requires a non-empty eventId");
    }
    if (!isRecord(outcome) || typeof outcome.kind !== "string") {
      throw new TypeError("dsh-events: outcome must be an object with a kind");
    }
    if (this.#expired.has(eventId)) {
      throw new EventAnswerError("event-expired", "这条请求已经作废（过期或已被取消），不能回执", { eventId });
    }
    if (this.#answered.has(eventId)) {
      throw new EventAnswerError("already-answered", "这条请求已经回执过，不会重复发送", { eventId });
    }
    const clientId = this.#clientId;
    if (typeof clientId !== "string" || clientId === "" || this.#state !== "ready") {
      throw new EventAnswerError("not-connected", "$events 未就绪（没有 clientId），无法回执", { eventId });
    }

    // 先记账再发：并发两次回执也只会有一次真正发出。
    markSettled(this.#answered, eventId);
    this.#pending.delete(eventId);

    const { rpcId, status } = await this.#rpc(this.#opts.resultEndpoint, { clientId, eventId, outcome }, eventId);
    return { ok: true, eventId, rpcId, status };
  }

  /**
   * 一次一元远端 RPC（HTTP，不是 socket）：`POST {upstream}/api/<method>`。
   * **每次调用都带超时**（`rpcTimeoutMs`）：网关卡住时先 abort 掉请求，
   * 并让这个 promise 以 `code:'timeout'` 结算 —— 通知循环永远不会被一次 HTTP 拖死。
   * @param {string} method - 逻辑端点名（如 `$events/result` / `session/list`）。
   * @param {object} args - 线参对象（放进 envelope 的 `payload.args`）。
   * @param {string} [eventId] - 仅用于错误归属。
   * @returns {Promise<{value:unknown, rpcId:string, status:number}>} 成功时返回 `result.value`。
   * @throws {EventAnswerError} 超时 / 网络 / HTTP / `{ok:false,error}` 全部变成类型化失败。
   */
  async #rpc(method, args, eventId) {
    const rpcId = randomUUID();
    const envelope = { type: "client-request", rpcId, method, payload: { args } };
    const url = `${this.#opts.upstream}${API_CHANNEL}/${method}`;

    const timeoutMs = Number(this.#opts.rpcTimeoutMs);
    const budgeted = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const controller = budgeted ? new AbortController() : null;
    let timedOut = false;
    let timer = null;
    /** 超时哨兵：即使 fetchImpl 不认 signal，也能让下面这个 race 立刻结算。 */
    const budget = budgeted
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              controller.abort();
            } catch {
              /* abort 失败无所谓，下面的 reject 才是保证 */
            }
            reject(
              new EventAnswerError("timeout", `${method} 超过 ${timeoutMs}ms 没有返回，已放弃这一次一元调用`, {
                eventId,
                rpcId,
              }),
            );
          }, timeoutMs);
          timer.unref?.();
        })
      : null;
    budget?.catch(() => {}); // 先挂一个处理器：race 提前结算时不留未处理拒绝

    let response;
    try {
      const request = this.#fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#cookieHeader() },
        body: JSON.stringify(envelope),
        ...(controller === null ? {} : { signal: controller.signal }),
      });
      response = budget === null ? await request : await Promise.race([request, budget]);
    } catch (error) {
      if (timedOut || error instanceof EventAnswerError) {
        throw error instanceof EventAnswerError
          ? error
          : new EventAnswerError("timeout", `${method} 超时（${timeoutMs}ms）`, { eventId, rpcId });
      }
      throw new EventAnswerError("network", `${method} 请求失败：${String(error?.message ?? error)}`, {
        eventId,
        rpcId,
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const status = Number(response?.status ?? 0);
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let body = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }

    if (status === 401 || status === 403) {
      this.#emitAuthError(status, `${method} 返回 HTTP ${status}，需要换 Cookie`, "http");
    }
    if (body === null || !isRecord(body)) {
      throw new EventAnswerError(`http-${status}`, `${method} 响应不可解析（HTTP ${status}）：${text.slice(0, 200)}`, {
        eventId,
        rpcId,
        status,
      });
    }
    if (body.rpcId !== rpcId) {
      throw new EventAnswerError("rpc-mismatch", `${method} 响应 rpcId 不匹配（HTTP ${status}）`, {
        eventId,
        rpcId,
        status,
      });
    }
    const result = isRecord(body.result) ? body.result : null;
    if (result === null) {
      throw new EventAnswerError("bad-response", `${method} 响应缺少 result（HTTP ${status}）`, {
        eventId,
        rpcId,
        status,
      });
    }
    if (result.ok !== true) {
      const error = isRecord(result.error) ? result.error : {};
      throw new EventAnswerError(
        typeof error.code === "string" ? error.code : "gateway/internal",
        typeof error.message === "string" ? error.message : `${method} 被服务端拒绝`,
        { eventId, rpcId, status, details: error.details },
      );
    }
    return { value: result.value, rpcId, status };
  }

  /**
   * 一元方法的统一出口：成功 → `project(value)` 的字段；失败 → 类型化失败（**永不抛出**）。
   * @param {string} method - 逻辑端点名。
   * @param {object} args - `payload.args`。
   * @param {(value:unknown)=>(object|null|undefined)} project - 成功投影；返回 null/undefined
   *   = 响应形状不是预期的（→ `bad-response`）。
   * @returns {Promise<{ok:true, [k:string]:unknown}|{ok:false, code:string, message:string, details?:unknown}>}
   */
  async #unary(method, args, project) {
    let value;
    try {
      ({ value } = await this.#rpc(method, args));
    } catch (error) {
      return failureOf(error);
    }
    let projected;
    try {
      projected = project(value);
    } catch (error) {
      return typedFailure("bad-response", `${method} 响应无法解析：${messageOf(error)}`);
    }
    if (projected === null || projected === undefined || typeof projected !== "object") {
      return typedFailure("bad-response", `${method} 响应形状不是预期的（缺必需字段）`);
    }
    return { ok: true, ...projected };
  }

  /**
   * 记下某会话「已知的最大 seq」（只增不减；有界，防长跑内存涨）。
   * @param {unknown} sessionId
   * @param {unknown} seq
   */
  #rememberCursor(sessionId, seq) {
    if (!isNonEmptyString(sessionId)) return;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return;
    const known = this.#cursors.get(sessionId);
    if (known !== undefined && known >= seq) return;
    this.#cursors.set(sessionId, seq);
    while (this.#cursors.size > CURSOR_LIMIT) this.#cursors.delete(this.#cursors.keys().next().value);
  }

  /**
   * `session/page` 必填的 `throughSeq`：取「`session/list` 的 `projections.asOfSeq`」与
   * 「follow 流见过的最新 seq」中的**较大者**（两者都 ≤ 会话当前 cursor，见模块头）。
   * 每次都重新拉一次 `session/list`（投影缓存可能落后）；它失败时才用缓存兜底。
   * @param {string} sessionId
   * @returns {Promise<{ok:true, throughSeq:number}|{ok:false, code:string, message:string, details?:unknown}>}
   */
  async #throughSeqFor(sessionId) {
    const cached = this.#cursors.get(sessionId);
    let listed;
    let listFailure = null;
    try {
      const { value } = await this.#rpc(SESSION_LIST_ENDPOINT, { [SESSION_LIST_WIRE_ARG]: {} });
      listed = asOfSeqOf(value, sessionId);
      if (listed !== undefined) this.#rememberCursor(sessionId, listed);
    } catch (error) {
      listFailure = failureOf(error);
    }
    const candidates = [cached, listed].filter(
      (seq) => typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0,
    );
    if (candidates.length > 0) return { ok: true, throughSeq: Math.max(...candidates) };
    // 缓存也没有：把 list 的真实原因（401 / timeout / 会话不存在…）如实带出去，而不是编一个数字。
    if (listFailure !== null) return listFailure;
    return typedFailure(
      "through-seq-unavailable",
      `会话 ${sessionId} 的 throughSeq 无法确定：session/list 里没有它的 projections.asOfSeq，` +
        `本地也没有它的 follow cursor。先 listSessions() 或等它出现在 follow 快照里再翻页。`,
    );
  }

  /**
   * 审批回执：`value` ∈ `allowed-once | rejected`。
   * async：参数校验失败也会变成 rejection（调用方统一 `try { await … } catch`）。
   */
  async answerApproval(eventId, value) {
    if (!APPROVAL_OUTCOMES.includes(value)) {
      throw new TypeError(
        `dsh-events: approval outcome must be one of ${APPROVAL_OUTCOMES.join(" | ")}，收到 ${JSON.stringify(value)}`,
      );
    }
    return this.answer(eventId, { kind: "result", value });
  }

  /**
   * 提问回执。
   * @param {string} eventId
   * @param {Array<{id:string, selected:string[], custom?:string}>} answers
   */
  async answerQuestion(eventId, answers) {
    if (!Array.isArray(answers)) throw new TypeError("dsh-events: answers must be an array");
    const normalized = answers.map((answer) => {
      if (!isRecord(answer) || typeof answer.id !== "string" || answer.id === "") {
        throw new TypeError("dsh-events: each answer needs a non-empty id");
      }
      if (!Array.isArray(answer.selected)) {
        throw new TypeError(`dsh-events: answer ${answer.id} needs a selected array`);
      }
      const selected = answer.selected.map((label) => {
        if (typeof label !== "string") throw new TypeError(`dsh-events: answer ${answer.id} labels must be strings`);
        return label;
      });
      return answer.custom === undefined
        ? { id: answer.id, selected }
        : { id: answer.id, selected, custom: String(answer.custom) };
    });
    return this.answer(eventId, { kind: "result", value: { answers: normalized } });
  }

  // ---------- 会话控制（一元 RPC；全部返回类型化结果，永不抛出） ----------

  /**
   * 列出会话（`session/list`，线参名是 **`_request`**）。
   * @returns {Promise<{ok:true, sessions:Array<{sessionId:string,title:string,running:boolean,
   *   blank:boolean, cwd?:string, updatedAt:number}>}
   *   |{ok:false, code:string, message:string, details?:unknown}>}
   *   `title` 取 `projections.values.title`（可空 → `""`）；`cwd` 线上可能缺席。
   */
  async listSessions() {
    const result = await this.#unary(SESSION_LIST_ENDPOINT, { [SESSION_LIST_WIRE_ARG]: {} }, (value) => {
      const items = isRecord(value) && Array.isArray(value.items) ? value.items : null;
      if (items === null) return null;
      const sessions = [];
      const cursors = [];
      for (const item of items) {
        if (!isRecord(item) || !isNonEmptyString(item.sessionId)) continue;
        const values = isRecord(item.projections) && isRecord(item.projections.values) ? item.projections.values : {};
        sessions.push({
          sessionId: item.sessionId,
          title: typeof values.title === "string" ? values.title : "",
          running: item.running === true,
          blank: item.blank === true,
          ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
          updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        });
        const seq = isRecord(item.projections) ? item.projections.asOfSeq : undefined;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) cursors.push([item.sessionId, seq]);
      }
      return { sessions, cursors };
    });
    if (!result.ok) return result;
    for (const [sessionId, seq] of result.cursors) this.#rememberCursor(sessionId, seq);
    return { ok: true, sessions: result.sessions };
  }

  /**
   * 新建会话（`session/create`）。只转发 `cwd` / `agentPreset`（其余字段由 DSH 默认）。
   * @param {{cwd?:string, agentPreset?:string}} [options]
   * @returns {Promise<{ok:true, sessionId:string, agentPreset?:string}|{ok:false, code:string, message:string, details?:unknown}>}
   */
  async createSession({ cwd, agentPreset } = {}) {
    const request = {};
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd === "") return invalidArguments("cwd 必须是非空字符串（或省略）");
      request.cwd = cwd;
    }
    if (agentPreset !== undefined) {
      if (typeof agentPreset !== "string" || agentPreset === "") {
        return invalidArguments("agentPreset 必须是非空字符串（或省略）");
      }
      request.agentPreset = agentPreset;
    }
    return this.#unary(SESSION_CREATE_ENDPOINT, { [SESSION_JSON_ARG]: request }, (value) => {
      if (!isRecord(value) || !isNonEmptyString(value.sessionId)) return null;
      return {
        sessionId: value.sessionId,
        ...(typeof value.agentPreset === "string" ? { agentPreset: value.agentPreset } : {}),
      };
    });
  }

  /**
   * 给会话发一条文本消息（`session/prompt`）。
   *
   * ⚠️ 线上 `request` 的每个字段都是**必填**（`{request:{}}` 会被边界校验拒掉）：
   * `requestId` / `sessionId` / `mode` / `content` 一个都不能少。`requestId` 不给就本地
   * 用 `randomUUID()` 生成（DSH 自己的客户端也是这么做的），并在结果里回给调用方。
   *
   * @param {{sessionId:string, text:string, mode?:"queue"|"steer", requestId?:string,
   *   clientTimeZone?:string}} options
   * @returns {Promise<{ok:true, accepted:true, requestId:string}|{ok:false, code:string, message:string, details?:unknown}>}
   *   本地参数不合法 → `{ok:false, code:'invalid-arguments'}`，**不发请求**。
   */
  async promptSession({ sessionId, text, mode = "queue", requestId, clientTimeZone } = {}) {
    if (!isNonEmptyString(sessionId)) return invalidArguments("sessionId 必须是非空字符串");
    if (typeof text !== "string" || text.trim() === "") return invalidArguments("text 必须是非空字符串");
    if (mode !== "queue" && mode !== "steer") {
      return invalidArguments(`mode 只能是 "queue" 或 "steer"（收到 ${JSON.stringify(mode)}）`);
    }
    if (requestId !== undefined && !isNonEmptyString(requestId)) {
      return invalidArguments("requestId 给了就必须是非空字符串");
    }
    if (clientTimeZone !== undefined && !isNonEmptyString(clientTimeZone)) {
      return invalidArguments("clientTimeZone 给了就必须是非空字符串（IANA 名或 UTC）");
    }
    const request = {
      // DSH 自己的客户端也用 randomUUID()（dsh-api-session-controller/lib/client.js:1660）。
      requestId: requestId ?? randomUUID(),
      sessionId,
      mode,
      content: [{ type: "text", text }],
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    };
    const result = await this.#unary(SESSION_PROMPT_ENDPOINT, { [SESSION_JSON_ARG]: request }, (value) => {
      if (!isRecord(value) || value.accepted !== true) return null;
      return { accepted: true };
    });
    return result.ok ? { ok: true, accepted: true, requestId: request.requestId } : result;
  }

  /**
   * 读会话历史的一页（`session/page`）。
   *
   * `throughSeq` 由 `#throughSeqFor()` 解析（`session/list` 的 `projections.asOfSeq`
   * 与本地 follow cursor 取大者）；解析不出来就显式失败 `through-seq-unavailable`。
   *
   * @param {{sessionId:string, maxMessages?:number}} options
   * @returns {Promise<{ok:true, records:Array<object>, hasMore:boolean}|{ok:false, code:string, message:string, details?:unknown}>}
   */
  async pageSession({ sessionId, maxMessages = 40 } = {}) {
    if (!isNonEmptyString(sessionId)) return invalidArguments("sessionId 必须是非空字符串");
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
      return invalidArguments("maxMessages 必须是正整数");
    }
    const seq = await this.#throughSeqFor(sessionId);
    if (!seq.ok) return seq;
    return this.#unary(
      SESSION_PAGE_ENDPOINT,
      {
        [SESSION_JSON_ARG]: {
          address: { kind: "session", sessionId },
          throughSeq: seq.throughSeq,
          maxMessages,
        },
      },
      (value) => {
        if (!isRecord(value) || !Array.isArray(value.records)) return null;
        return { records: value.records, hasMore: value.hasMore === true };
      },
    );
  }

  /**
   * 会话的**最后一条助手文本**（= 「结论」）。内部就是 `pageSession()` + 文本抽取，
   * 任何失败都折成 `{ok:false, …}`，**永不抛出**。
   * @param {{sessionId:string, maxMessages?:number}} options
   * @returns {Promise<{ok:true, text:string}|{ok:false, code:string, message:string, details?:unknown, text:string}>}
   */
  async lastAssistantText({ sessionId, maxMessages = 40 } = {}) {
    const page = await this.pageSession({ sessionId, maxMessages });
    if (!page.ok) return { ...page, text: "" };
    return { ok: true, text: extractLastAssistantText(page.records) };
  }

  /**
   * 取消会话当前的 turn（`session/cancel`，`{request:{sessionId}}` → `{accepted:true}`）。
   * ⚠️ 这是**请求**不是命令：本地状态不在这里改，仍由 `$events` 的 `status` 与 follow 的
   * `turn/end` 说了算。全 DSH **没有** delete/dispose 方法。
   * @param {{sessionId:string}} options
   * @returns {Promise<{ok:true}|{ok:false, code:string, message:string, details?:unknown}>}
   */
  async cancelSession({ sessionId } = {}) {
    if (!isNonEmptyString(sessionId)) return invalidArguments("sessionId 必须是非空字符串");
    return this.#unary(SESSION_CANCEL_ENDPOINT, { [SESSION_JSON_ARG]: { sessionId } }, (value) => {
      if (!isRecord(value) || value.accepted !== true) return null;
      return {};
    });
  }

  /**
   * 改会话标题（`session/rename`，`{request:{sessionId,title}}` → `{title,seq}`）。
   * `seq` 也顺带更新本地 throughSeq 缓存。
   * @param {{sessionId:string, title:string}} options
   * @returns {Promise<{ok:true, title:string, seq?:number}|{ok:false, code:string, message:string, details?:unknown}>}
   */
  async renameSession({ sessionId, title } = {}) {
    if (!isNonEmptyString(sessionId)) return invalidArguments("sessionId 必须是非空字符串");
    if (typeof title !== "string" || title.trim() === "") return invalidArguments("title 必须是非空字符串");
    const result = await this.#unary(
      SESSION_RENAME_ENDPOINT,
      { [SESSION_JSON_ARG]: { sessionId, title } },
      (value) => {
        if (!isRecord(value) || typeof value.title !== "string") return null;
        return {
          title: value.title,
          ...(typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 0
            ? { seq: value.seq }
            : {}),
        };
      },
    );
    if (result.ok && typeof result.seq === "number") this.#rememberCursor(sessionId, result.seq);
    return result;
  }

  #cookieHeader() {
    const cookie = this.#cookieValue();
    return cookie === "" ? {} : { cookie };
  }

  /** 事件已了结：从待答集合移除并标记作废（迟到回执会被拒）。 */
  #settleEvent(eventId, reason) {
    const node = this.#pending.get(eventId);
    this.#pending.delete(eventId);
    markSettled(this.#expired, eventId);
    this.emit("event", {
      kind: NODE_KINDS.EVENT_EXPIRED,
      eventId,
      node: node?.kind,
      reason,
      at: this.#now(),
    });
  }

  // ---------- P1 本地钩子（规格 §5 节点 5/6/7：只暴露触发点，不实现调度策略） ----------

  /** 节点 5 每日简报：上层自定时机调用（兼作 24h 推送窗口的心跳）。 */
  digestDue(detail = {}) {
    return this.#emitLocal({ kind: NODE_KINDS.DIGEST_DUE, specNode: 5, ...detail });
  }

  /** 节点 6 额度将尽 / 被限流。 */
  quotaLow(detail = {}) {
    const state = detail.state === "throttled" ? "throttled" : "low";
    return this.#emitLocal({ kind: NODE_KINDS.QUOTA_LOW, specNode: 6, state, ...detail });
  }

  /** 节点 7 会员即将过期 / 已过期。 */
  membershipExpiring(detail = {}) {
    const state = detail.state === "expired" ? "expired" : "expiring";
    return this.#emitLocal({ kind: NODE_KINDS.MEMBERSHIP_EXPIRING, specNode: 7, state, ...detail });
  }

  #emitLocal(node) {
    const withTime = { at: this.#now(), ...node };
    this.emit("event", withTime);
    return withTime;
  }
}

// ============================================================
// 分类（纯函数，独立导出便于单测与复用）
// ============================================================

/**
 * 把一条 `emit` 帧分类成产品节点（不是产品节点的返回 null）。
 * @param {string} event - 事件名。
 * @param {unknown[]} args - Cordis 监听参数。
 * @param {number} at - 本地时间戳（epoch ms）。
 * @returns {object|null}
 */
export function classifyEmit(event, args, at) {
  if (event === "api-session/error") {
    // dsh-api-session-controller/lib/index.js:2759 emit(agent.id, errorChain(error))
    //                                            :2781 emit(sessionId, result.error.message)
    const id = typeof args[0] === "string" ? args[0] : "";
    return {
      kind: NODE_KINDS.SESSION_ERROR,
      specNode: 3,
      sessionId: id,
      agentId: id,
      message: messageOf(args[1]),
      at,
    };
  }
  return null;
}

/**
 * 把一条 `waterfall` 帧分类成产品节点。
 * @param {object} frame - `{type:'waterfall',event,eventId,agentId,request}`。
 * @param {number} at - 本地时间戳（epoch ms）。
 * @returns {object|null}
 */
export function classifyWaterfall(frame, at) {
  const event = typeof frame.event === "string" ? frame.event : "";
  const eventId = typeof frame.eventId === "string" ? frame.eventId : "";
  const agentId = typeof frame.agentId === "string" ? frame.agentId : "";
  if (eventId === "") return null;
  const request = isRecord(frame.request) ? frame.request : {};
  // DSH 里 agent 身份即会话身份（`ctx.emit("api-session/status", agent.id, …)`），
  // waterfall 帧只给 agentId，故 sessionId 由它派生。
  const sessionId = agentId;

  if (event === "approval/request") {
    // 线上 request = ApprovalRequest 去掉 agent/signal：{toolName, callId?, reason?}
    return {
      kind: NODE_KINDS.APPROVAL_REQUEST,
      specNode: 1,
      answerShape: "approval",
      answerable: true,
      sessionId,
      agentId,
      eventId,
      toolName: typeof request.toolName === "string" ? request.toolName : "",
      callId: typeof request.callId === "string" ? request.callId : undefined,
      reason: typeof request.reason === "string" ? request.reason : undefined,
      options: APPROVAL_CHOICES.map((choice) => ({ ...choice })),
      at,
    };
  }

  if (event === "user-questions/request") {
    // 线上 request = AskUserQuestionRequestEvent 去掉 agent/signal：{questions:[…]}
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const first = questions[0];
    const intent = isRecord(first) && isRecord(first.intent) ? first.intent : undefined;
    const isPlanReview = intent?.kind === "plan-review";
    const options = [];
    for (const question of questions) {
      if (!isRecord(question)) continue;
      const questionId = typeof question.id === "string" ? question.id : "";
      const labels = Array.isArray(question.options) ? question.options : [];
      for (const option of labels) {
        if (!isRecord(option) || typeof option.label !== "string") continue;
        options.push({
          questionId,
          id: questionId,
          label: option.label,
          description: typeof option.description === "string" ? option.description : undefined,
        });
      }
    }
    return {
      kind: isPlanReview ? NODE_KINDS.PLAN_REVIEW : NODE_KINDS.USER_QUESTION,
      specNode: 2,
      answerShape: "question",
      answerable: true,
      planReview: isPlanReview,
      sessionId,
      agentId,
      eventId,
      questions,
      options,
      intent: isPlanReview ? { kind: "plan-review", approve: String(intent.approve ?? "") } : undefined,
      detail: isRecord(first) && typeof first.detail === "string" ? first.detail : undefined,
      at,
    };
  }

  return null;
}

/**
 * 把一条 follow 流上的 `turn/end` 会话事件分类成产品节点（精确停止原因）。
 * @param {string} sessionId - 会话 id。
 * @param {object} event - `{type:'turn/end',seq,time,data:{turn,reason}}`。
 * @param {number} at - 本地时间戳（epoch ms）。
 * @returns {object}
 */
export function classifyTurnEnd(sessionId, event, at) {
  const data = isRecord(event.data) ? event.data : {};
  const reason = isRecord(data.reason) ? data.reason : {};
  const kind = typeof reason.kind === "string" ? reason.kind : "unknown";
  return {
    kind: NODE_KINDS.TURN_END,
    specNode: 4,
    sessionId,
    turn: typeof data.turn === "number" ? data.turn : undefined,
    reason: kind,
    known: TURN_END_REASONS.includes(kind),
    detail: reason,
    seq: typeof event.seq === "number" ? event.seq : undefined,
    at: typeof event.time === "number" && Number.isFinite(event.time) ? event.time : at,
  };
}

/**
 * 创建一个订阅器。
 * @param {{
 *   upstream: string,
 *   cookie?: string|(() => string),
 *   muxPath?: string,
 *   resultPath?: string,
 *   resultEndpoint?: string,
 *   reconnect?: {minMs?:number,maxMs?:number,factor?:number,jitter?:number},
 *   followSettleMs?: number,
 *   maxFollowStreams?: number,
 *   follow?: boolean,
 *   discover?: boolean,
 *   discoverIntervalMs?: number,
 *   control?: boolean,
 *   rpcTimeoutMs?: number,
 *   log?: (level:string, message:string, meta?:object) => void,
 *   now?: () => number,
 *   WebSocketImpl?: any,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {EventSubscriber}
 */
export function createEventSubscriber(options) {
  return new EventSubscriber(options);
}

export { EventSubscriber };

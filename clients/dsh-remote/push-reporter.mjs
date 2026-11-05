/**
 * push-reporter — 把电脑端的事件（任务完成 / 需要拍板 / 出错）上报到 SaaS，由服务端决定
 * 是否推送（规则化审批在服务端做、审计在服务端落），本模块只负责**可靠、克制地把事件送到**。
 *
 * 设计边界（每一条都重要）
 * ---------------------------------------------------------------
 * 1. **默认关闭**：只有服务端明确"推送已开启且本账号有订阅"时才启动；任何一步失败都静默降级。
 * 2. **绝不阻塞主链路**：不 await 在 bridge 的事件循环里，所有网络动作都在自己的队列里串行做；
 *    异常一律 catch，绝不冒泡到隧道帧循环（隧道挂 = 全用户断连）。
 * 3. **隐私最小化**：默认只上报"标题 + 一句结果摘要"，**不上报完整命令/代码**；
 *    只有 `DSH_PUSH_DETAIL=1` 时才带 `approval.summary`（由服务端规则引擎判断风险）。
 * 4. **幂等**：同一事件（同一 event_id）重试不会让服务端推两次（服务端也有幂等，这里是第一道）。
 * 5. **有界**：队列最多 50 条，满了丢最旧并计数；网络失败指数退避，最多 3 次。
 *
 * 跨仓库契约（企业端 `/api/notify/event`，字段不可改）
 * ---------------------------------------------------------------
 * POST {apiBase}/api/notify/event   Authorization: Bearer <device JWT>
 * {
 *   event_id, device_id, kind, at,
 *   session: { id, title? },
 *   title, body,
 *   approval?: { request_id, summary?, options: [{value,label}] }
 * }
 * 响应 200 { ok, notified, suppressed, reason? }
 */

import { createEventSubscriber, NODE_KINDS, TURN_END_REASONS } from "./dsh-events.mjs";

/** 上报体里 kind 的闭集（与服务端契约一致）。 */
export const NOTIFY_KINDS = Object.freeze({
  TURN_DONE: "turn_done",
  TURN_ERROR: "turn_error",
  TURN_BLOCKED: "turn_blocked",
  APPROVAL_REQUEST: "approval_request",
});

/** 队列上限 / 重试退避 / 单次请求超时。 */
export const MAX_QUEUE = 50;
export const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000]);
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_EVENT_ID_LEN = 128;
/** 上报正文硬上限（服务端也会截，这里先截，省流量）。 */
export const MAX_BODY_LEN = 200;

/** 结果摘要里不该出现的、像"命令"的东西（默认模式下再兜一层）。 */
const COMMAND_HINT = /(^|\s)(rm|sudo|npm|pnpm|yarn|git|docker|kubectl|curl|wget|ssh|scp|chmod|chown|systemctl|psql|mysql)\s/i;

/**
 * 事件节点 → 上报体。返回 `null` 表示"这类节点不上报"（例如 gap/fault/简报）。
 *
 * 导出是为了单测能直接钉住映射（不依赖真实订阅器）。
 *
 * @param {object} node dsh-events 的分类节点
 * @param {{deviceId:string, detail?:boolean, sessionTitle?:(sessionId:string)=>string, now?:()=>number}} opts
 * @returns {object|null}
 */
export function toNotifyPayload(node, opts = {}) {
  if (!node || typeof node !== "object") return null;
  const deviceId = String(opts.deviceId || "");
  if (!deviceId) return null;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const at = Number.isFinite(node.at) ? node.at : now();
  const sessionId = typeof node.sessionId === "string" ? node.sessionId : "";
  const sessionTitleRaw = typeof opts.sessionTitle === "function" ? opts.sessionTitle(sessionId) : "";
  const sessionTitle = truncate(String(sessionTitleRaw || ""), 60);
  const session = { id: sessionId };
  if (sessionTitle) session.title = sessionTitle;

  if (node.kind === NODE_KINDS.APPROVAL_REQUEST || node.kind === NODE_KINDS.PLAN_REVIEW
      || node.kind === NODE_KINDS.USER_QUESTION) {
    const requestId = String(node.eventId || "");
    if (!requestId) return null;
    const isPlan = node.kind === NODE_KINDS.PLAN_REVIEW;
    const isQuestion = node.kind === NODE_KINDS.USER_QUESTION;
    const tool = String(node.toolName || "").trim();
    // 摘要只给"能看懂在等什么"的最小信息；完整命令默认不外发（隐私）。
    const rawSummary = String(node.reason || tool || "").trim();
    // ★ 默认模式一律只给"动作名"，完整命令只有 detail 模式才外发（隐私边界）。
    const action = opts.detail ? truncate(rawSummary, MAX_BODY_LEN) : safeSummary(tool, rawSummary);
    const title = isQuestion ? "等你回答" : isPlan ? "等你批准计划" : "需要你拍板";
    const body = isQuestion
      ? "agent 提问：需要你选一个选项才能继续"
      : isPlan
        ? "agent 在等你批准计划"
        : (action ? `需要你拍板：${action}` : "需要你拍板");
    return {
      event_id: makeEventId(deviceId, "approval", requestId),
      device_id: deviceId,
      kind: NOTIFY_KINDS.APPROVAL_REQUEST,
      at,
      session,
      title,
      body,
      approval: {
        request_id: requestId,
        // 默认模式下 summary 只保留"动作名"，不带完整命令（detail 模式才带原文）
        summary: action,
        options: normalizeOptions(node.options)
      }
    };
  }

  if (node.kind === NODE_KINDS.TURN_END) {
    const reason = String(node.reason || "unknown");
    const known = TURN_END_REASONS.includes(reason);
    let kind = NOTIFY_KINDS.TURN_DONE;
    let title = "任务完成";
    let body = sessionTitle ? `${sessionTitle} 跑完了` : "任务跑完了";
    if (reason === "error" || reason === "max-tokens") {
      kind = NOTIFY_KINDS.TURN_ERROR;
      title = reason === "max-tokens" ? "任务被截断" : "任务出错";
      body = sessionTitle ? `${sessionTitle} ${title}` : title;
    } else if (reason === "blocked") {
      kind = NOTIFY_KINDS.TURN_BLOCKED;
      title = "任务被拦下";
      body = sessionTitle ? `${sessionTitle} 被拦下了` : "任务被拦下了，需要你看一下";
    } else if (!known) {
      /* 未知 reason：当成完成上报，但不假装"成功"——正文如实写原因 */
      body = `${sessionTitle || "任务"} 结束了（${reason}）`;
    }
    const key = `turn:${sessionId}:${node.turn ?? "?"}:${node.seq ?? "?"}:${reason}`;
    return {
      event_id: makeEventId(deviceId, "turn", key),
      device_id: deviceId,
      kind,
      at,
      session,
      title,
      body: truncate(body, MAX_BODY_LEN)
    };
  }

  if (node.kind === NODE_KINDS.SESSION_ERROR) {
    const message = truncate(String(node.message || "任务出错"), MAX_BODY_LEN);
    return {
      event_id: makeEventId(deviceId, "error", `${sessionId}:${node.code || message}:${at}`),
      device_id: deviceId,
      kind: NOTIFY_KINDS.TURN_ERROR,
      at,
      session,
      title: "任务出错",
      body: message
    };
  }

  // gap / fault / digest / quota / membership / expired：本模块不负责（微信通道/其他模块在做）
  return null;
}

function normalizeOptions(raw) {
  const out = [];
  if (Array.isArray(raw)) {
    for (const o of raw) {
      if (!o || typeof o !== "object") continue;
      const value = typeof o.value === "string" ? o.value : "";
      const label = typeof o.label === "string" ? o.label : "";
      if (!value || !label) continue;
      out.push({ value, label: truncate(label, 20) });
      if (out.length >= 4) break;
    }
  }
  return out.length ? out : [
    { value: "allowed-once", label: "允许一次" },
    { value: "rejected", label: "拒绝" }
  ];
}

/** 默认模式下的安全摘要：只留动作名，绝不把完整命令行外发。 */
function safeSummary(tool, fallback) {
  const t = String(tool || "").trim();
  if (t) return truncate(t, 40);
  const s = String(fallback || "").trim();
  if (!s) return "需要你拍板";
  if (COMMAND_HINT.test(s)) {
    const m = s.split(/\s+/)[0];
    return truncate(m, 40);
  }
  return truncate(s, 40);
}

/** 服务端契约：event_id 只允许 [A-Za-z0-9._:-]（其它字符 400）。 */
const EVENT_ID_SAFE = /[^A-Za-z0-9._:-]/g;

function makeEventId(deviceId, scope, key) {
  const raw = `${deviceId}:${scope}:${String(key || "").slice(0, 80)}`;
  // 同 key 同一毫秒重复 = 同一事件；加上 at 会被去重逻辑判成不同事件，故不加
  const id = raw.replace(EVENT_ID_SAFE, "_"); // 空格/问号/斜杠等一律换成下划线
  return id.length > MAX_EVENT_ID_LEN ? id.slice(0, MAX_EVENT_ID_LEN) : id;
}

function truncate(s, n) {
  const str = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * 创建上报器。不自动启动（见 `start()`）。
 *
 * @param {{
 *   apiBase: string,
 *   tokenProvider: () => (string|Promise<string>),
 *   deviceId: string,
 *   upstream: () => string,
 *   cookie?: () => string,
 *   detail?: boolean,
 *   sessionTitle?: (sessionId:string)=>string,
 *   log?: (level:string, message:string, meta?:object)=>void,
 *   fetchImpl?: typeof fetch,
 *   WebSocketImpl?: any,
 *   now?: () => number,
 *   maxQueue?: number,
 *   retryDelaysMs?: number[],
 *   startOnInit?: boolean,
 * }} options
 */
export function createPushReporter(options = {}) {
  const apiBase = String(options.apiBase || "").replace(/\/+$/, "");
  const deviceId = String(options.deviceId || "");
  const tokenProvider = typeof options.tokenProvider === "function" ? options.tokenProvider : () => "";
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => {};
  const detail = options.detail === true;
  const maxQueue = Number.isFinite(options.maxQueue) ? options.maxQueue : MAX_QUEUE;
  const retryDelaysMs = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : RETRY_DELAYS_MS;

  /** @type {{payload:object, tries:number}[]} */
  const queue = [];
  const seen = new Map(); // event_id -> at（有界）
  const stats = { started: false, reason: "", enqueued: 0, sent: 0, dropped: 0, duplicates: 0, failed: 0, lastError: "" };

  let subscriber = null;
  let flushing = false;
  let stopped = false;
  let flushTimer = null;

  function remember(id) {
    if (seen.has(id)) return false;
    seen.set(id, now());
    // 有界：超过 500 条淘汰最旧（Map 保插入序）
    if (seen.size > 500) {
      const first = seen.keys().next();
      if (!first.done) seen.delete(first.value);
    }
    return true;
  }

  function enqueue(payload) {
    if (!payload) return false;
    if (!remember(payload.event_id)) {
      stats.duplicates += 1;
      return false;
    }
    if (queue.length >= maxQueue) {
      queue.shift();
      stats.dropped += 1;
      log("warn", "[push] 上报队列已满，丢弃最旧一条");
    }
    queue.push({ payload, tries: 0 });
    stats.enqueued += 1;
    scheduleFlush(0);
    return true;
  }

  function scheduleFlush(delayMs) {
    if (stopped) return;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, Math.max(0, delayMs));
    // 不阻止进程退出（bridge 退出时最多等 1s，见 stop()）
    if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
  }

  async function flush() {
    if (stopped && queue.length === 0) return;
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const item = queue[0];
        const token = await Promise.resolve(tokenProvider()).catch(() => "");
        if (!token) {
          stats.lastError = "no_token";
          log("warn", "[push] 没有可用 token，稍后再上报");
          scheduleFlush(retryDelaysMs[0] || 5_000);
          return;
        }
        const result = await postOnce(token, item.payload, apiBase, fetchImpl);
        if (result.ok) {
          queue.shift();
          stats.sent += 1;
          continue;
        }
        if (result.authFailed) {
          // token 失效：丢这批并等下一次 device-login 刷新（不无限重试）
          queue.shift();
          stats.failed += 1;
          stats.lastError = "auth_failed";
          log("warn", "[push] device token 失效，丢弃本批上报（等下次登录刷新）");
          continue;
        }
        if (result.clientError) {
          // 契约错误（400/404/422）：重试没意义
          queue.shift();
          stats.failed += 1;
          stats.lastError = `http_${result.status}`;
          log("warn", `[push] 服务端拒绝上报（HTTP ${result.status}），丢弃该条`);
          continue;
        }
        item.tries += 1;
        stats.failed += 1;
        stats.lastError = result.error || `http_${result.status}`;
        if (item.tries > retryDelaysMs.length) {
          queue.shift();
          log("warn", `[push] 上报重试 ${item.tries - 1} 次仍失败，丢弃该条`);
          continue;
        }
        const delay = retryDelaysMs[item.tries - 1] || 5_000;
        scheduleFlush(delay);
        return;
      }
    } catch (e) {
      stats.lastError = String(e && e.message ? e.message : e);
      log("warn", `[push] 上报循环异常（已忽略）：${stats.lastError}`);
    } finally {
      flushing = false;
    }
  }

  /**
   * 启动门禁（两层，都是服务端说了算 —— 客户端开关只是省流量，不是安全边界）：
   *   ① `GET /api/me` → `notify.enabled`：服务端总开关（push_enabled）。老服务端没有该字段 = 关闭。
   *   ② `GET /api/push/public-key` → `subscribed`：本账号有没有订阅；没有就不必起事件订阅器。
   */
  async function probeEnabled(token) {
    try {
      const me = await fetchWithTimeout(`${apiBase}/api/me`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
      }, fetchImpl, REQUEST_TIMEOUT_MS);
      if (!me) return { ok: false, reason: "no_response" };
      if (me.status === 401 || me.status === 403) return { ok: false, reason: "auth_failed" };
      if (me.status !== 200) return { ok: false, reason: `http_${me.status}` };
      const meBody = await safeJson(me);
      const enabled = !!(meBody && meBody.notify && meBody.notify.enabled === true);
      if (!enabled) return { ok: false, reason: "disabled" };

      const sub = await fetchWithTimeout(`${apiBase}/api/push/public-key`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
      }, fetchImpl, REQUEST_TIMEOUT_MS);
      if (!sub) return { ok: false, reason: "no_response" };
      if (sub.status === 200) {
        const subBody = await safeJson(sub);
        if (subBody && subBody.subscribed === true) return { ok: true };
        return { ok: false, reason: "no_subscription" };
      }
      // 老服务端没有推送端点：当作没有订阅（不启动）
      return { ok: false, reason: `http_${sub.status}` };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  return {
    /** 启动：先问服务端"推送开了吗、本账号订阅了吗"，再开始订阅事件。 */
    async start() {
      if (stats.started || stopped) return stats;
      if (!apiBase) { stats.reason = "no_api_base"; return stats; }
      if (!deviceId) { stats.reason = "no_device"; return stats; }
      const token = await Promise.resolve(tokenProvider()).catch(() => "");
      if (!token) { stats.reason = "no_token"; return stats; }
      const gate = await probeEnabled(token);
      if (!gate.ok) { stats.reason = gate.reason || "disabled"; log("info", `[push] 未启动上报：${stats.reason}`); return stats; }
      try {
        subscriber = createEventSubscriber({
          upstream: typeof options.upstream === "function" ? options.upstream : String(options.upstream || ""),
          cookie: typeof options.cookie === "function" ? options.cookie : (options.cookie || ""),
          follow: true,
          log: (level, message) => log(level === "error" ? "warn" : level, `[push/events] ${message}`),
          now,
          WebSocketImpl: options.WebSocketImpl,
          fetchImpl
        });
        subscriber.on("event", (node) => {
          try {
            const payload = toNotifyPayload(node, {
              deviceId,
              detail,
              sessionTitle: options.sessionTitle,
              now
            });
            if (payload) enqueue(payload);
          } catch (e) {
            log("warn", `[push] 事件归一化失败（已忽略）：${e && e.message ? e.message : e}`);
          }
        });
        subscriber.on("auth-error", () => log("warn", "[push] 事件订阅鉴权失败，等 harness cookie 自愈"));
        subscriber.on("gap", () => log("warn", "[push] 事件订阅断线窗口，期间通知可能漏发"));
        subscriber.start();
        stats.started = true;
        stats.reason = "started";
      } catch (e) {
        stats.reason = `subscribe_failed:${e && e.message ? e.message : e}`;
        log("warn", `[push] 订阅器启动失败（已忽略）：${stats.reason}`);
      }
      return stats;
    },

    /** 停止：最多 1s 尽力 flush，然后释放订阅器。 */
    async stop() {
      stopped = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const deadline = now() + 1_000;
      while (queue.length > 0 && now() < deadline) {
        await flush();
        if (queue.length > 0) await new Promise((r) => setTimeout(r, 50));
      }
      try { if (subscriber && typeof subscriber.close === "function") subscriber.close(); } catch { /* 忽略 */ }
      subscriber = null;
      stats.started = false;
    },

    /**
     * 把一条审批回执写回 DSH（供决策轮询器调用）。
     *
     * 为什么放在这里：DSH 的审批回执要用订阅器里的 `clientId`(+ 上游地址/cookie)，
     * 而订阅器归本模块所有；另起一个订阅器既浪费一条 WS，也会让"谁有资格回执"变得模糊。
     *
     * @param {string} eventId DSH 的审批事件 id（= 上报体里的 approval.request_id）
     * @param {"allowed-once"|"rejected"} outcome
     * @returns {Promise<any>} 原样返回订阅器结果；没有订阅器时抛错（由调用方兜底）
     */
    async answerApproval(eventId, outcome) {
      const sub = subscriber;
      if (!sub || typeof sub.answerApproval !== "function") {
        throw new Error("push-reporter: 事件订阅器未就绪，暂时无法回执审批");
      }
      return sub.answerApproval(eventId, outcome);
    },

    /** 只读状态（面板/诊断用；不包含任何事件内容）。 */
    status() {
      return { ...stats, queued: queue.length };
    },

    /** 仅供单测：直接塞一条（绕过订阅器）。 */
    _enqueue(payload) { return enqueue(payload); },
    /** 仅供单测：立即跑一次发送循环。 */
    _flush: flush,
    /** 仅供单测：把映射函数暴露出去，避免测试重复实现。 */
    _toNotifyPayload: toNotifyPayload
  };
}

async function postOnce(token, payload, apiBase, fetchImpl) {
  try {
    const r = await fetchWithTimeout(`${apiBase}/api/notify/event`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }, fetchImpl, REQUEST_TIMEOUT_MS);
    if (!r) return { ok: false, error: "no_response" };
    if (r.status === 200) {
      const body = await safeJson(r);
      if (body && body.ok === true) return { ok: true };
      return { ok: false, clientError: true, status: r.status };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, authFailed: true, status: r.status };
    if (r.status >= 400 && r.status < 500) return { ok: false, clientError: true, status: r.status };
    return { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function fetchWithTimeout(url, init, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== "function") return null;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch { /* 忽略 */ } }, timeoutMs) : null;
  if (timer && typeof timer.unref === "function") timer.unref();
  try {
    return await fetchImpl(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeJson(r) {
  try { return await r.json(); } catch { return null; }
}

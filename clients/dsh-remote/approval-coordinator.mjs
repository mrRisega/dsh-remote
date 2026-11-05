/**
 * approval-coordinator — 把「Claude Code 的审批请求」接到「手机端回执」上。
 *
 * 链路：
 *   Claude Code 要升权 → 我们的钩子收到请求（requestId）
 *     → 本模块登记一个待决 Promise，并让 bridge 上报一条 approval 事件（手机收到推送）
 *     → 用户在手机上点「允许一次 / 拒绝」
 *     → decision-poller 拉到回执 → 调本模块 `resolve(requestId, decision)` → Promise 落地
 *     → 钩子回写 allow/deny，Claude Code 继续或放弃
 *
 * 设计边界（每一条都重要）
 * ---------------------------------------------------------------
 * 1. **fail-closed**：TTL 到点（默认 90s，与钩子一致）、stop()、上报失败 → 一律 `deny`。
 *    「没人拍板」绝不能被当成「同意」。
 * 2. **只有一次**：同一条请求只 settle 一次；重复 resolve 返回 false（幂等，不报错）。
 * 3. **不泄漏原文**：上报体里的 `summary` 用于服务端风险分级（必须给），但**日志里永远只有
 *    toolName/requestId**，不记录命令全文。
 * 4. **不阻塞**：上报是 fire-and-forget；上报抛错也只在超时后 deny（不会让钩子挂死）。
 * 5. **有界**：同时在等的请求上限（默认 8，与钩子并发闸一致），超限直接 deny 并告警。
 */

export const DEFAULT_APPROVAL_TTL_MS = 90_000;
export const MAX_PENDING_APPROVALS = 8;

/** 拒绝时回给模型/用户的中文说明（会原样进 Claude 上下文）。 */
export const DENY_MESSAGES = Object.freeze({
  timeout: "等待手机审批超时，已按拒绝处理",
  stopped: "bridge 关闭，未决审批一律拒绝",
  overflow: "同时在等的审批过多，已拒绝（请稍后重试）",
  cancelled: "审批已取消"
});

/**
 * @param {{
 *   report?: (payload: {requestId:string, toolName:string, kind:string, summary:string}) => any,
 *   ttlMs?: number,
 *   maxPending?: number,
 *   now?: () => number,
 *   log?: (level:string, message:string, meta?:object) => void,
 *   setTimeoutImpl?: (fn:Function, ms:number)=>any,
 *   clearTimeoutImpl?: (t:any)=>void,
 * }} options
 */
export function createApprovalCoordinator(options = {}) {
  const report = typeof options.report === "function" ? options.report : null;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_APPROVAL_TTL_MS;
  const maxPending = Number.isFinite(options.maxPending) ? options.maxPending : MAX_PENDING_APPROVALS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => {};
  const setT = typeof options.setTimeoutImpl === "function" ? options.setTimeoutImpl : setTimeout;
  const clearT = typeof options.clearTimeoutImpl === "function" ? options.clearTimeoutImpl : clearTimeout;

  /** requestId -> {resolve, timer, at, toolName} */
  const pending = new Map();
  const stats = { asked: 0, allowed: 0, denied: 0, expired: 0, overflow: 0, stopped: false };

  function settle(requestId, decision, message, reason) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    try { clearT(entry.timer); } catch { /* 忽略 */ }
    const d = decision === "allow" ? "allow" : "deny";
    if (d === "allow") stats.allowed += 1;
    else stats.denied += 1;
    if (reason === "timeout") stats.expired += 1;
    log("info", `[approval] ${requestId} → ${d}${reason ? `（${reason}）` : ""}`);
    try { entry.resolve({ decision: d, message }); } catch { /* 调用方自己兜 */ }
    return true;
  }

  return {
    /**
     * 钩子调用：等手机拍板。返回 `{decision:"allow"|"deny", message?}`。
     * @param {{requestId:string, toolName?:string, kind?:string, detail?:string, detailTruncated?:boolean, expiresAt?:number}} req
     */
    ask(req) {
      if (stats.stopped) {
        return Promise.resolve({ decision: "deny", message: DENY_MESSAGES.stopped });
      }
      const requestId = String(req && req.requestId ? req.requestId : "");
      if (!requestId) {
        return Promise.resolve({ decision: "deny", message: "审批请求缺少 id" });
      }
      if (pending.size >= maxPending) {
        stats.overflow += 1;
        log("warn", `[approval] 待决审批已达上限 ${maxPending}，直接拒绝 ${requestId}`);
        return Promise.resolve({ decision: "deny", message: DENY_MESSAGES.overflow });
      }
      if (pending.has(requestId)) {
        // 同一请求重复进来（钩子重试）：沿用第一次的 Promise，不重复上报
        return pending.get(requestId).promise;
      }
      let resolveFn;
      const promise = new Promise((resolve) => { resolveFn = resolve; });
      const timer = setT(() => {
        settle(requestId, "deny", DENY_MESSAGES.timeout, "timeout");
      }, ttlMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      pending.set(requestId, { resolve: resolveFn, timer, at: now(), toolName: String((req && req.toolName) || ""), promise });
      stats.asked += 1;

      // 上报：让手机收到推送。失败不影响超时兜底（到点仍然 deny）。
      if (report) {
        try {
          void Promise.resolve(report({
            requestId,
            toolName: String((req && req.toolName) || ""),
            kind: String((req && req.kind) || ""),
            // summary 只用于服务端风险分级；默认不会进推送正文（服务端 notify_include_detail=0）
            summary: String((req && req.detail) || (req && req.toolName) || "").slice(0, 200)
          })).catch((e) => {
            log("warn", `[approval] 上报失败（等超时拒绝）：${e && e.message ? e.message : e}`);
          });
        } catch (e) {
          log("warn", `[approval] 上报异常（等超时拒绝）：${e && e.message ? e.message : e}`);
        }
      } else {
        log("warn", "[approval] 没有上报通道，本次审批只能等超时拒绝");
      }
      return promise;
    },

    /**
     * 回执到达时调用。返回 true = 这条回执属于审批请求（已消费）；false = 不归我管（交给 DSH 那条路）。
     * @param {string} requestId
     * @param {"allow"|"deny"} decision
     */
    resolve(requestId, decision) {
      const id = String(requestId || "");
      if (!pending.has(id)) return false;
      settle(id, decision, undefined, decision === "allow" ? undefined : "denied-by-user");
      return true;
    },

    /** 关闭：所有未决一律拒绝（绝不留悬挂的 Promise）。 */
    stop() {
      stats.stopped = true;
      const ids = [...pending.keys()];
      for (const id of ids) settle(id, "deny", DENY_MESSAGES.stopped, "stopped");
      return ids.length;
    },

    status() {
      return { ...stats, pending: pending.size, ttlMs, maxPending };
    },

    /** 仅供单测：当前待决 id 列表。 */
    _pendingIds() { return [...pending.keys()]; }
  };
}

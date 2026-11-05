/**
 * decision-poller — 把"用户在手机上点的允许/拒绝"从 SaaS 拉回来，落到电脑端。
 *
 * 链路（配合服务端 `/api/notify/pending`）：
 *   手机点按钮 → POST /api/notify/decision（服务端存）
 *     → 本模块每 3s GET /api/notify/pending?device_id=…
 *     → 对每条决策调用注入的 `apply(item)`（bridge 里 = dsh-events 的 answerApproval）
 *     → POST /api/notify/ack 确认，服务端不再返回
 *
 * 设计边界（每一条都重要）
 * ---------------------------------------------------------------
 * 1. **默认不启动**：只有「事件上报已在跑」时才起（没有上报就没有通知，也就不可能有回执）。
 * 2. **绝不阻塞主链路**：所有异常吞掉只记日志；一个 tick 失败不影响下一个 tick。
 * 3. **幂等**：apply 成功才 ack；apply 失败（例如会话已结束）也 ack —— 否则会每 3s 重放同一条
 *    并把用户"一直点不掉"的旧决策反复怼给 DSH。失败会记 warn，不影响其它决策。
 * 4. **有界**：单次最多处理 20 条（服务端也限 20），串行 apply，避免并发打爆 dsh。
 * 5. **过期不应用**：服务端已过滤；这里再按 expires_at 兜一次（时钟漂移时宁可丢也不误放行）。
 *
 * 安全语义：`allow` 只能映射成 **allowed-once**（"允许一次"），绝不映射成"永久放行"；
 * `deny` 映射成 `rejected`。任何未知值 → 当 deny 处理（fail-closed）。
 */

export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const MAX_ITEMS_PER_TICK = 20;
export const REQUEST_TIMEOUT_MS = 8_000;

/** 手机端的 decision → dsh-events 的 outcome（未知一律 deny，fail-closed）。 */
export function toDshOutcome(decision) {
  return String(decision) === "allow" ? "allowed-once" : "rejected";
}

/**
 * @param {{
 *   apiBase: string,
 *   deviceId: string,
 *   tokenProvider: () => (string|Promise<string>),
 *   apply: (item: {event_id:string, request_id:string, decision:"allow"|"deny", id:string}) => Promise<any>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   intervalMs?: number,
 *   log?: (level:string, message:string, meta?:object) => void,
 * }} options
 */
export function createDecisionPoller(options = {}) {
  const apiBase = String(options.apiBase || "").replace(/\/+$/, "");
  const deviceId = String(options.deviceId || "");
  const tokenProvider = typeof options.tokenProvider === "function" ? options.tokenProvider : () => "";
  const apply = typeof options.apply === "function" ? options.apply : null;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_POLL_INTERVAL_MS;
  const log = typeof options.log === "function" ? options.log : () => {};

  const stats = { started: false, polls: 0, applied: 0, skipped: 0, failed: 0, acked: 0, lastError: "" };
  /**
   * 已应用过的决策 id（有界 LRU）。
   *
   * 为什么需要：服务端是"至少一次"语义 —— 我们 ack 丢了或超时未 ack，同一条回执会被重投。
   * 若每次都重新 `apply()`，会把同一条审批反复回执给 DSH（服务端虽是幂等的 already_decided，
   * 但会刷日志、也会让"允许一次"看起来像被允许多次）。所以按 id 去重：见过的只 ack 不再应用。
   */
  const appliedIds = new Map();
  let timer = null;
  let stopped = false;
  let ticking = false;

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, Math.max(0, delayMs));
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      stats.polls += 1;
      const token = await Promise.resolve(tokenProvider()).catch(() => "");
      if (!token) {
        stats.lastError = "no_token";
        return;
      }
      const url = `${apiBase}/api/notify/pending?device_id=${encodeURIComponent(deviceId)}`;
      const res = await fetchWithTimeout(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` }
      }, fetchImpl, REQUEST_TIMEOUT_MS);
      if (!res) { stats.lastError = "no_response"; return; }
      if (res.status === 401) {
        // token 过期：等下一次 device-login 刷新，继续轮询没有意义但也不该停（刷新后要能恢复）
        stats.lastError = "auth_failed";
        log("warn", "[decision] 设备 token 失效，跳过本轮（等下次登录刷新）");
        return;
      }
      if (res.status === 403) {
        // device_mismatch：这台机器的 device_id 已登记在别的账号下 —— 重试永远不会成功，停下。
        stats.lastError = "device_mismatch";
        log("warn", "[decision] 本机设备不属于当前账号（device_mismatch），已停止决策轮询");
        stopped = true;
        return;
      }
      if (res.status === 400) {
        // invalid_device_id（缺/超长）：配置问题，重试无意义
        stats.lastError = "invalid_device_id";
        log("warn", "[decision] device_id 非法，已停止决策轮询");
        stopped = true;
        return;
      }
      if (res.status !== 200) { stats.lastError = `http_${res.status}`; return; }
      const body = await safeJson(res);
      const items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS_PER_TICK) : [];
      if (items.length === 0) { stats.lastError = ""; return; }

      const ackIds = [];
      for (const item of items) {
        const id = String(item && item.id ? item.id : "");
        const eventId = String(item && item.event_id ? item.event_id : "");
        const requestId = String(item && item.request_id ? item.request_id : "");
        const decision = String(item && item.decision ? item.decision : "");
        const expiresAt = Number(item && item.expires_at ? item.expires_at : 0);
        // 服务端"至少一次"语义：redeliver_count>0 表示这条之前可能已经投递过（我们回过 ack 但响应丢了）。
        // 不改行为（仍照常应用并 ack），只在日志留痕，便于排查"为什么同一条审批被应用两次"。
        const redeliverCount = Number(item && item.redeliver_count ? item.redeliver_count : 0);
        if (redeliverCount > 0) {
          log("warn", `[decision] 收到重投回执（第 ${redeliverCount} 次） request_id=${requestId || "-"}`);
        }
        if (expiresAt > 0 && expiresAt < now()) {
          // 服务端已过期却仍返回（时钟漂移）：不应用，但 ack 掉避免反复拉
          stats.failed += 1;
          if (id) ackIds.push(id);
          continue;
        }
        if (id && appliedIds.has(id)) {
          // 重投的同一条：之前已应用过 → 只 ack，不再 apply（幂等）
          stats.skipped += 1;
          ackIds.push(id);
          continue;
        }
        if (!apply || !requestId) {
          stats.failed += 1;
          if (id) ackIds.push(id);
          continue;
        }
        try {
          await apply({
            id,
            event_id: eventId,
            request_id: requestId,
            decision: decision === "allow" ? "allow" : "deny",
            outcome: toDshOutcome(decision)
          });
          stats.applied += 1;
          if (id) {
            appliedIds.set(id, now());
            if (appliedIds.size > 500) {
              const first = appliedIds.keys().next();
              if (!first.done) appliedIds.delete(first.value);
            }
          }
        } catch (e) {
          // 应用失败（会话已结束/事件已作废）也必须 ack，否则每 3s 重放同一条
          stats.failed += 1;
          stats.lastError = String(e && e.message ? e.message : e);
          log("warn", `[decision] 应用失败（已跳过并确认）: ${stats.lastError}`);
        }
        if (id) ackIds.push(id);
      }
      if (ackIds.length > 0) await ack(token, ackIds, apiBase, fetchImpl, stats, log);
    } catch (e) {
      stats.lastError = String(e && e.message ? e.message : e);
      log("warn", `[decision] 轮询异常（已忽略）：${stats.lastError}`);
    } finally {
      ticking = false;
      if (!stopped) schedule(intervalMs);
    }
  }

  return {
    start() {
      if (stats.started || stopped) return stats;
      if (!apiBase || !deviceId || !apply) {
        stats.lastError = !apiBase ? "no_api_base" : !deviceId ? "no_device" : "no_apply";
        return stats;
      }
      stats.started = true;
      schedule(intervalMs);
      return stats;
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      stats.started = false;
    },
    status() { return { ...stats }; },
    /** 仅供单测：跑一次 tick（不排下一轮）。 */
    _tick: tick
  };
}

async function ack(token, ids, apiBase, fetchImpl, stats, log) {
  try {
    const res = await fetchWithTimeout(`${apiBase}/api/notify/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(0, 50) })
    }, fetchImpl, REQUEST_TIMEOUT_MS);
    if (res && res.status === 200) {
      stats.acked += ids.length;
      return;
    }
    log("warn", `[decision] ack 失败（HTTP ${res ? res.status : "无响应"}），下轮会重复拉取（幂等，无副作用）`);
  } catch (e) {
    log("warn", `[decision] ack 异常（已忽略）：${e && e.message ? e.message : e}`);
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

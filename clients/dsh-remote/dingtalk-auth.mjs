/**
 * dingtalk-auth — 钉钉「扫码一键创建机器人」授权会话的**持久化 + 断点续轮询**（2026-11-08）。
 *
 * 要解决的根因
 * -----------------------------------------------------------------
 * 官方 connector 的授权是标准 device-flow：
 *   POST /app/registration/init  {source:"DING_DWS_CLAW"} → {nonce}
 *   POST /app/registration/begin {nonce}                 → {device_code, verification_uri_complete, interval, expires_in}
 *   POST /app/registration/poll  {device_code}           → {status:"WAITING"|"SUCCESS", client_id, client_secret}
 *
 * 凭据**只在 poll 返回 SUCCESS 的那一次**给出。如果 device_code 只存在进程内存里（插件进程/面板关掉/宿主重启），
 * 授权会话就丢了 —— 钉钉侧显示「连接成功」、机器人也建好了，但我们永远接不住凭据，用户只能去控制台重新复制。
 *
 * 本模块因此把授权会话**原子落盘**到 `<relayDir>/im-dingtalk-auth.json`（0600），
 * bridge 启动时 `resumeDingtalkAuth()` 继续按 interval 轮询；拿到凭据后写 `im-bots.json` 的 dingtalk 段、
 * 删除 auth 文件、写状态 `dingtalk.state="connected"`，随后现有 controller 的热更新会真正把机器人连上。
 *
 * 安全
 * -----------------------------------------------------------------
 *   · auth 文件含 device_code（等价于"授权票据"）→ 0600，且**不写状态文件**、不进日志。
 *   · 拿到的 clientSecret 只写 im-bots.json（0600 原子写），日志只打 clientId 尾号。
 *
 * 对插件暴露的接口（插件侧改为委托调用，2026-11-08 Lead 确认）：
 *   beginDingtalkAuth({relayDir, fetchImpl})   → {ok, url, expiresIn, interval, expiresAt}
 *   authStatus({relayDir})                     → {ok, status:"idle|waiting|success|failed|expired", remainingSeconds, url?, message?, clientIdTail?}
 *   cancelDingtalkAuth({relayDir})             → {ok:true}（停轮询 + 删 auth 文件）
 *   resumeDingtalkAuth({relayDir, fetchImpl, onSuccess}) → bridge 启动时调用（fire-and-forget 也安全）
 *   stopDingtalkAuthPolling()                  → 只停定时器（**保留** auth 文件，供下次启动续轮询）
 */

import fs from "node:fs";
import path from "node:path";

import {
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE,
  atomicWriteJson,
  createScopedLogger,
  readJsonFile,
  truncateText
} from "./wecom-bot.mjs";

/** 授权会话文件（相对 relayDir；0600；含 device_code，绝不进状态/日志）。 */
export const DINGTALK_AUTH_FILE = "im-dingtalk-auth.json";
/**
 * 控制命令文件（插件写、桥读，0600）：`{"action":"begin"|"cancel","at":<ts>}`。
 * 桥用 `fs.watchFile` 盯它（1s），处理完删除文件；同一 `at` 不重复处理。
 * 这样插件不需要点对点 HTTP 端点，也不需要持有 device_code —— 只发"开始/取消"意图。
 */
export const DINGTALK_AUTH_CMD_FILE = "im-dingtalk-auth-cmd.json";
/** 官方 connector 用的注册端点（与插件侧 lib/index.js 的 DINGTALK_REG_BASE 保持一致）。 */
export const DINGTALK_REG_BASE = "https://oapi.dingtalk.com/app/registration";
/** 兜底 TTL 上限：钉钉 device-flow 的 expires_in 是 7200s（2 小时）。 */
export const DINGTALK_AUTH_TTL_MS = 7200 * 1000;
/** 默认轮询间隔（秒）；钉钉 begin 会返回 interval（实测 3s 左右）。 */
const DEFAULT_POLL_SECONDS = 3;
/** 单次 HTTP 超时。 */
const REQUEST_TIMEOUT_MS = 8_000;
/** auth 成功后 lastResult 保留多久（供插件轮询读结果）。 */
const LAST_RESULT_TTL_MS = 10 * 60 * 1000;

/** 面向用户的中文错误（绝不把裸 code / 钉钉 errmsg 直接渲染给用户）。 */
const HUMAN = Object.freeze({
  network_error: "连不上钉钉接口，请检查网络后重试",
  rejected: "钉钉拒绝了这次授权请求，请重新扫码",
  expired: "授权已过期，请重新扫码生成新的链接",
  cancelled: "这次授权已被取消",
  write_failed: "拿到的凭据保存失败（磁盘/权限问题），请检查后重试",
  bad_credentials: "钉钉返回的凭据不完整，请重新扫码",
  no_relay_dir: "缺少 relay 目录，无法保存授权会话",
  no_session: "没有进行中的扫码授权",
  success: "授权成功，机器人凭据已保存（正在自动连接）"
});

/** relayDir → 后台轮询会话（只存内存；device_code 同时持久化在 auth 文件里）。 */
const sessions = new Map();
/** relayDir → 最近一次结论（success/failed/expired/cancelled；供 authStatus 在文件删除后仍能读到）。 */
const lastResults = new Map();
let generationSeq = 0;

function human(code, fallback) {
  const text = String(fallback || "").trim();
  if (/[\u4e00-\u9fa5]/.test(text) && !/^\s*[{[]/.test(text)) return truncateText(text, 120);
  return HUMAN[code] || "操作失败，请稍后重试";
}

function nowOf(options) {
  return typeof options.clock === "function" ? Number(options.clock()) || Date.now() : Date.now();
}

function authFileOf(relayDir) {
  return path.join(String(relayDir || ""), DINGTALK_AUTH_FILE);
}

/** 读取授权会话文件（不存在/坏 JSON → null，绝不抛）。 */
export function readDingtalkAuthSession(relayDir) {
  if (!relayDir) return null;
  const raw = readJsonFile(authFileOf(relayDir));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const deviceCode = typeof raw.deviceCode === "string" ? raw.deviceCode : "";
  if (!deviceCode) return null;
  return {
    deviceCode,
    interval: Math.max(1, Math.min(10, Number(raw.interval) || DEFAULT_POLL_SECONDS)),
    expiresAt: Number(raw.expiresAt) || 0,
    url: typeof raw.url === "string" ? raw.url : "",
    createdAt: Number(raw.createdAt) || 0,
    credentialSource: "scan"
  };
}

function removeAuthFile(relayDir) {
  try { fs.rmSync(authFileOf(relayDir), { force: true }); } catch { /* 忽略 */ }
}

/** 合并写状态文件的 dingtalk 段（保留其它段/字段；绝不含 secret）。 */
function patchDingtalkStatus(relayDir, patch, onWarn) {
  if (!relayDir) return;
  try {
    const file = path.join(String(relayDir), IM_BOT_STATUS_FILE);
    const prev = readJsonFile(file);
    const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
    const cur = base.dingtalk && typeof base.dingtalk === "object" ? base.dingtalk : {};
    atomicWriteJson(file, {
      ...base,
      version: 1,
      updatedAt: Date.now(),
      dingtalk: { ...cur, ...patch }
    }, { onWarn });
  } catch { /* 状态写失败不影响授权本身 */ }
}

/** relayDir → 上次写入的 dingtalk.auth 快照（JSON；内容没变就不重复写文件）。 */
const lastAuthSync = new Map();

/** 把 authStatus() 的结果同步进状态文件 `dingtalk.auth`（**绝不含 deviceCode/secret**）。 */
function syncAuthStatus(relayDir, onWarn) {
  if (!relayDir) return null;
  const st = authStatus({ relayDir });
  const snapshot = {
    state: String(st.status || "idle"),
    url: st.status === "waiting" && st.url ? String(st.url) : "",
    expiresAt: Number(st.expiresAt) || 0,
    remainingSec: Math.max(0, Number(st.remainingSeconds) || 0),
    clientIdTail: String(st.clientIdTail || ""),
    message: String(st.message || "")
  };
  const sig = JSON.stringify(snapshot);
  if (lastAuthSync.get(relayDir) === sig) return snapshot;
  lastAuthSync.set(relayDir, sig);
  patchDingtalkStatus(relayDir, { auth: snapshot }, onWarn);
  return snapshot;
}

// ---------- 控制命令文件（插件 → 桥） ----------

/** relayDir → { watcher 状态/去重信息 }（只存内存；命令文件处理完即删）。 */
const cmdWatchers = new Map();

function readCommandFile(relayDir) {
  const file = path.join(String(relayDir || ""), DINGTALK_AUTH_CMD_FILE);
  const raw = readJsonFile(file);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = String(raw.action || "").toLowerCase();
  if (action !== "begin" && action !== "cancel") return null;
  return { action, at: Number(raw.at) || 0 };
}

function removeCommandFile(relayDir) {
  try { fs.rmSync(path.join(String(relayDir || ""), DINGTALK_AUTH_CMD_FILE), { force: true }); } catch { /* 忽略 */ }
}

/**
 * 处理命令文件（幂等）：读 → 去重(at) → 执行 → 删除文件 → 同步状态。
 * 返回处理结果（测试/排障用）：`{ok, action?, skipped?}`。
 */
export async function handleDingtalkAuthCommand(options = {}) {
  const relayDir = String(options.relayDir || "");
  if (!relayDir) return { ok: false, code: "no_relay_dir" };
  const state = cmdWatchers.get(relayDir) || { lastHandledAt: 0, handling: false };
  if (state.handling) return { ok: false, code: "busy" };
  const cmd = readCommandFile(relayDir);
  if (!cmd) {
    // 坏文件/未知 action：删掉，避免每 1s 刷日志（只记一次 debug）
    if (fs.existsSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE))) {
      removeCommandFile(relayDir);
      if (options.logger) options.logger("debug", "[dingtalk-auth] 忽略无法识别的授权命令文件（已删除）");
    }
    return { ok: false, code: "no_command" };
  }
  const log = createScopedLogger({ sink: options.logger, prefix: "[dingtalk-auth]" });
  if (cmd.at && cmd.at <= state.lastHandledAt) {
    removeCommandFile(relayDir);
    log.debug(`忽略重复的授权命令（at=${cmd.at} ≤ lastHandledAt=${state.lastHandledAt}）`);
    return { ok: true, action: cmd.action, skipped: true, at: cmd.at };
  }
  state.handling = true;
  cmdWatchers.set(relayDir, state);
  try {
    if (cmd.action === "begin") {
      log.info("收到面板「开始扫码授权」命令 → 生成授权链接并持久化会话");
      const r = await beginDingtalkAuth({
        relayDir,
        fetchImpl: options.fetchImpl,
        logger: options.logger,
        pollMs: options.pollMs,
        onSuccess: options.onSuccess,
        onWarn: options.onWarn
      });
      state.lastHandledAt = cmd.at || Date.now();
      log.info(r.ok ? "已生成扫码授权链接（等待用户手机确认）" : `扫码授权发起失败：${r.message || r.code || "?"}`);
      return { ok: r.ok, action: "begin", at: cmd.at, result: r };
    }
    log.info("收到面板「取消扫码授权」命令");
    cancelDingtalkAuth({ relayDir, onWarn: options.onWarn });
    state.lastHandledAt = cmd.at || Date.now();
    return { ok: true, action: "cancel", at: cmd.at };
  } finally {
    removeCommandFile(relayDir);
    state.handling = false;
    cmdWatchers.set(relayDir, state);
    syncAuthStatus(relayDir, options.onWarn);
  }
}

/**
 * 启动命令文件监听（bridge 启动时调用；幂等）。
 * 同时每秒刷新一次 `dingtalk.auth`（remainingSec 会随时间减少），桥退出时 stop 掉。
 * @param {{relayDir:string, fetchImpl?:Function, logger?:Function, onSuccess?:Function, onWarn?:Function,
 *          intervalMs?:number, pollMs?:number}} options
 */
export function startDingtalkAuthCommandWatcher(options = {}) {
  const relayDir = String(options.relayDir || "");
  if (!relayDir) return { ok: false, code: "no_relay_dir" };
  const existing = cmdWatchers.get(relayDir);
  if (existing && existing.timer) return { ok: true, started: false };
  const file = path.join(relayDir, DINGTALK_AUTH_CMD_FILE);
  const intervalMs = Math.max(20, Number(options.intervalMs) || 1000);
  const state = { lastHandledAt: 0, handling: false, timer: null, listener: null };
  // ⚠️ 必须**先把 state 放进 map 再触发首次 handle**：否则启动时恰有命令文件的情况下，
  //    handleDingtalkAuthCommand 会用自己的临时 state 覆盖 map，导致 stop 时拿不到 listener
  //    → fs.watchFile 解不掉（测试进程/桥退出时泄漏）。
  cmdWatchers.set(relayDir, state);
  const tick = () => {
    // 先处理命令（有就执行），再刷新状态（remainingSec 随时间变化）
    void handleDingtalkAuthCommand(options)
      .catch(() => { /* 内部已兜住 */ })
      .finally(() => { syncAuthStatus(relayDir, options.onWarn); });
  };
  state.listener = () => { void handleDingtalkAuthCommand(options).catch(() => {}); };
  try {
    fs.watchFile(file, { interval: intervalMs }, state.listener);
  } catch (e) {
    if (options.logger) options.logger("warn", `[dingtalk-auth] 监听授权命令文件失败：${e && e.message ? e.message : e}`);
  }
  state.timer = setInterval(tick, intervalMs);
  if (typeof state.timer.unref === "function") state.timer.unref();
  // 启动时先检查一次（上次退出可能留下未处理命令），之后 interval 心跳兜底
  void handleDingtalkAuthCommand(options).catch(() => {});
  syncAuthStatus(relayDir, options.onWarn);
  return { ok: true, started: true, intervalMs };
}

/** 停止命令文件监听（bridge 退出时调用；**保留** auth 文件，下次启动续轮询）。 */
export function stopDingtalkAuthCommandWatcher(relayDir) {
  const dirs = relayDir ? [String(relayDir)] : [...cmdWatchers.keys()];
  for (const dir of dirs) {
    const state = cmdWatchers.get(dir);
    if (!state) continue;
    try { if (state.timer) clearInterval(state.timer); } catch { /* 忽略 */ }
    state.timer = null;
    try {
      if (state.listener) fs.unwatchFile(path.join(dir, DINGTALK_AUTH_CMD_FILE), state.listener);
    } catch { /* 忽略 */ }
    state.listener = null;
    cmdWatchers.delete(dir);
  }
}

/** 测试用：清空命令监听内存态（不动文件）。 */
export function __resetDingtalkAuthCmdForTest() {
  stopDingtalkAuthCommandWatcher();
}

function stopSession(relayDir) {
  const sess = sessions.get(relayDir);
  if (sess) {
    try { if (sess.timer) clearInterval(sess.timer); } catch { /* 忽略 */ }
    sess.timer = null;
    sessions.delete(relayDir);
  }
}

function setLastResult(relayDir, result) {
  lastResults.set(relayDir, { ...result, at: Date.now() });
  while (lastResults.size > 50) {
    const first = lastResults.keys().next();
    if (first.done) break;
    lastResults.delete(first.value);
  }
}

async function jsonPost(fetchImpl, url, payload) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload || {}),
    signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
  });
  let body = null;
  try { body = res && typeof res.json === "function" ? await res.json() : null; } catch { body = null; }
  return { ok: Boolean(res && res.ok), status: Number(res && res.status) || 0, body: body && typeof body === "object" ? body : {} };
}

/** 把扫码拿到的凭据写进 im-bots.json 的 dingtalk 段（0600 原子写；保留其它段/字段，自动 enabled）。 */
function saveScannedCredentials(relayDir, clientId, clientSecret, onWarn) {
  const cid = String(clientId || "").trim();
  const csec = String(clientSecret || "").trim();
  if (!cid || !csec) return { ok: false, code: "bad_credentials", message: human("bad_credentials") };
  try {
    const file = path.join(String(relayDir), IM_BOTS_FILE);
    const prev = readJsonFile(file);
    const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
    const cur = base.dingtalk && typeof base.dingtalk === "object" ? base.dingtalk : {};
    const dingtalk = {
      ...cur,
      enabled: true,
      clientId: cid,
      clientSecret: csec,
      credentialSource: "scan"
    };
    // 扫码流程只给 client_id/client_secret：robotCode 缺省用 clientId（Lead 2026-11-08 约定；
    // 用户后续可在面板里改成正真的机器人编码 —— openapi/卡片能力由 dingtalk-bot 的 capabilities 表达）。
    if (!String(dingtalk.robotCode || "").trim()) dingtalk.robotCode = cid;
    atomicWriteJson(file, { ...base, version: 1, dingtalk }, { onWarn });
    return { ok: true, clientIdTail: cid.length > 4 ? cid.slice(-4) : cid };
  } catch (e) {
    return { ok: false, code: "write_failed", message: human("write_failed", e && e.message) };
  }
}

function expireAuth(relayDir, sess) {
  stopSession(relayDir);
  removeAuthFile(relayDir);
  const message = human("expired");
  patchDingtalkStatus(relayDir, { state: "failed", lastError: message, credentialSource: "scan" }, sess && sess.onWarn);
  setLastResult(relayDir, { status: "expired", message, code: "expired" });
  syncAuthStatus(relayDir, sess && sess.onWarn);
  if (sess) sess.log.info(`扫码授权会话已过期（device_code 清理，可在面板重新发起）`);
}

function finishFailure(relayDir, sess, { code, message }) {
  stopSession(relayDir);
  removeAuthFile(relayDir);
  patchDingtalkStatus(relayDir, { state: "failed", lastError: message, credentialSource: "scan" }, sess && sess.onWarn);
  setLastResult(relayDir, { status: "failed", code, message });
  syncAuthStatus(relayDir, sess && sess.onWarn);
  sess.log.warn(`扫码授权失败：${code || "?"} — ${message}`);
}

function finishSuccess(relayDir, sess, { clientId, clientSecret }) {
  const saved = saveScannedCredentials(relayDir, clientId, clientSecret, sess && sess.onWarn);
  stopSession(relayDir);
  if (!saved.ok) {
    removeAuthFile(relayDir);
    const message = saved.message || human("write_failed");
    patchDingtalkStatus(relayDir, { state: "failed", lastError: message, credentialSource: "scan" }, sess && sess.onWarn);
    setLastResult(relayDir, { status: "failed", code: saved.code || "write_failed", message });
    syncAuthStatus(relayDir, sess && sess.onWarn);
    sess.log.warn(`扫码凭据保存失败：${message}`);
    return;
  }
  // 先删 auth 文件（凭据已落盘；device_code 不再需要）再写状态
  removeAuthFile(relayDir);
  patchDingtalkStatus(relayDir, { state: "connected", lastError: "", credentialSource: "scan" }, sess && sess.onWarn);
  setLastResult(relayDir, { status: "success", credentialSource: "scan", clientIdTail: saved.clientIdTail, message: human("success") });
  syncAuthStatus(relayDir, sess && sess.onWarn);
  sess.log.info(`扫码授权成功：机器人凭据已写入 im-bots.json（clientId 尾号 ${saved.clientIdTail}，credentialSource=scan）`);
  if (typeof sess.onSuccess === "function") {
    try { sess.onSuccess({ clientIdTail: saved.clientIdTail, credentialSource: "scan" }); } catch { /* 忽略 */ }
  }
}

async function pollOnce(relayDir, sess) {
  if (sessions.get(relayDir) !== sess) return; // 已被新会话取代
  if (sess.inFlight) return;
  const at = sess.clock();
  if (at >= sess.expiresAt) { expireAuth(relayDir, sess); return; }
  sess.inFlight = true;
  let r;
  try {
    r = await jsonPost(sess.fetchImpl, `${DINGTALK_REG_BASE}/poll`, { device_code: sess.deviceCode });
  } catch {
    sess.networkErrors += 1;
    if (sess.networkErrors === 1) sess.log.warn("轮询钉钉接口网络异常：继续重试直到授权过期（不会丢会话）");
    return;
  } finally {
    sess.inFlight = false;
  }
  if (sessions.get(relayDir) !== sess) return; // 期间被 begin 覆盖
  const body = r.body || {};
  const status = String(body.status || "").toUpperCase();
  const clientId = body.client_id || body.clientId || "";
  const clientSecret = body.client_secret || body.clientSecret || "";
  if (status === "SUCCESS" || (clientId && clientSecret)) {
    finishSuccess(relayDir, sess, { clientId, clientSecret });
    return;
  }
  if (status === "FAIL" || status === "EXPIRED" || status === "REJECTED") {
    finishFailure(relayDir, sess, {
      code: status === "EXPIRED" ? "expired" : "rejected",
      message: human(status === "EXPIRED" ? "expired" : "rejected", body.message || body.errmsg)
    });
    return;
  }
  if (status === "WAITING" || status === "PENDING" || status === "") {
    sess.waits += 1;
    syncAuthStatus(relayDir, sess.onWarn); // 顺带刷新 dingtalk.auth（remainingSec 随时间减少）
    return; // 用户还没在手机钉钉里点「一键创建」
  }
  // 未知/异常响应：宽容地继续等（直到过期），避免一次怪响应把会话作废
  sess.waits += 1;
}

function startPolling(relayDir, sess) {
  stopSession(relayDir);
  sessions.set(relayDir, sess);
  const tick = () => { void pollOnce(relayDir, sess).catch(() => { /* 轮询内部已兜住 */ }); };
  sess.timer = setInterval(tick, sess.pollMs);
  if (typeof sess.timer.unref === "function") sess.timer.unref();
  // 立刻先轮一次：用户在 begin 之前就点完确认也不耽误
  void pollOnce(relayDir, sess).catch(() => { /* 忽略 */ });
}

function makeSession({ relayDir, session, fetchImpl, logger, onSuccess, clock, pollMs, onWarn }) {
  const log = createScopedLogger({ sink: logger, prefix: "[dingtalk-auth]" });
  const now = clock();
  const gen = ++generationSeq;
  return {
    gen,
    relayDir,
    deviceCode: session.deviceCode,
    expiresAt: session.expiresAt,
    url: session.url,
    fetchImpl,
    logger,
    onSuccess,
    onWarn,
    clock,
    log,
    pollMs: Math.max(10, Number(pollMs) || Math.max(1000, Number(session.interval || DEFAULT_POLL_SECONDS) * 1000)),
    inFlight: false,
    waits: 0,
    networkErrors: 0
  };
}

/**
 * 开始一次扫码授权：init → begin → **把会话原子落盘** → 后台按 interval 轮询。
 *
 * 同一 relayDir 同时只保留一个会话：新的 begin 会作废旧会话（旧 auth 文件被覆盖/删除）。
 * @returns {Promise<{ok:boolean, url?:string, expiresIn?:number, interval?:number, expiresAt?:number, code?:string, message?:string}>}
 */
export async function beginDingtalkAuth(options = {}) {
  const relayDir = String(options.relayDir || "");
  if (!relayDir) return { ok: false, code: "no_relay_dir", message: human("no_relay_dir") };
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const log = createScopedLogger({ sink: options.logger, prefix: "[dingtalk-auth]" });
  if (typeof fetchImpl !== "function") return { ok: false, code: "network_error", message: human("network_error") };
  // 覆盖旧会话（并发 begin）：先停表、清旧文件，再发新请求 —— 旧链接从此失效
  stopSession(relayDir);
  removeAuthFile(relayDir);

  let init;
  try { init = await jsonPost(fetchImpl, `${DINGTALK_REG_BASE}/init`, { source: "DING_DWS_CLAW" }); }
  catch { return { ok: false, code: "network_error", message: human("network_error") }; }
  const nonce = init.ok && init.body && typeof init.body.nonce === "string" ? init.body.nonce : "";
  if (!nonce) {
    const message = human("rejected", init.body && (init.body.message || init.body.errmsg));
    setLastResult(relayDir, { status: "failed", code: "rejected", message });
    return { ok: false, code: "rejected", message };
  }
  let begin;
  try { begin = await jsonPost(fetchImpl, `${DINGTALK_REG_BASE}/begin`, { nonce }); }
  catch { return { ok: false, code: "network_error", message: human("network_error") }; }
  const body = begin.body || {};
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const url = typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : "";
  if (!begin.ok || !deviceCode || !url) {
    const message = human("rejected", body.message || body.errmsg);
    setLastResult(relayDir, { status: "failed", code: "rejected", message });
    return { ok: false, code: "rejected", message };
  }
  const interval = Math.max(1, Math.min(10, Number(body.interval) || DEFAULT_POLL_SECONDS));
  const expiresIn = Math.max(60, Math.min(7200, Number(body.expires_in) || DINGTALK_AUTH_TTL_MS / 1000));
  const at = nowOf(options);
  const expiresAt = at + Math.min(expiresIn * 1000, DINGTALK_AUTH_TTL_MS);
  const persisted = { deviceCode, interval, expiresAt, url, createdAt: at, credentialSource: "scan" };
  try {
    atomicWriteJson(authFileOf(relayDir), { version: 1, ...persisted }, { onWarn: options.onWarn });
  } catch (e) {
    return { ok: false, code: "write_failed", message: human("write_failed", e && e.message) };
  }
  const sess = makeSession({
    relayDir,
    session: persisted,
    fetchImpl,
    logger: options.logger,
    onSuccess: options.onSuccess,
    clock: () => nowOf(options),
    pollMs: options.pollMs,
    onWarn: options.onWarn
  });
  startPolling(relayDir, sess);
  setLastResult(relayDir, { status: "waiting", url, expiresAt });
  syncAuthStatus(relayDir, options.onWarn);
  log.info(`已生成扫码授权链接（device_code 已持久化，会话有效期 ${Math.round((expiresAt - at) / 1000)}s；关面板/重启桥都不丢）`);
  return { ok: true, url, expiresIn: Math.round((expiresAt - at) / 1000), interval, expiresAt };
}

/**
 * 断点续轮询：bridge 启动时调用。存在未过期会话 → 继续按 interval poll；
 * 成功后写 `im-bots.json`（credentialSource:"scan"）、删 auth 文件、写状态 `state="connected"`。
 * 不存在/已过期 → 返回 `{ok:false, code:"no_session"|"expired"}`（过期会顺手清理文件与状态）。
 */
export async function resumeDingtalkAuth(options = {}) {
  const relayDir = String(options.relayDir || "");
  if (!relayDir) return { ok: false, code: "no_relay_dir", message: human("no_relay_dir") };
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const log = createScopedLogger({ sink: options.logger, prefix: "[dingtalk-auth]" });
  const at = nowOf(options);
  const session = readDingtalkAuthSession(relayDir);
  if (!session) return { ok: false, code: "no_session", message: human("no_session") };
  if (!session.expiresAt || at >= session.expiresAt) {
    removeAuthFile(relayDir);
    const message = human("expired");
    patchDingtalkStatus(relayDir, { state: "failed", lastError: message, credentialSource: "scan" }, options.onWarn);
    setLastResult(relayDir, { status: "expired", code: "expired", message });
    log.info("发现已过期的扫码授权会话，已清理（可在面板重新发起）");
    return { ok: false, code: "expired", message };
  }
  if (sessions.has(relayDir)) {
    const cur = sessions.get(relayDir);
    return {
      ok: true,
      status: "waiting",
      url: session.url,
      remainingSeconds: Math.max(0, Math.ceil((session.expiresAt - at) / 1000)),
      pollMs: cur.pollMs
    };
  }
  const sess = makeSession({
    relayDir,
    session,
    fetchImpl,
    logger: options.logger,
    onSuccess: options.onSuccess,
    clock: () => nowOf(options),
    pollMs: options.pollMs,
    onWarn: options.onWarn
  });
  startPolling(relayDir, sess);
  setLastResult(relayDir, { status: "waiting", url: session.url, expiresAt: session.expiresAt });
  syncAuthStatus(relayDir, options.onWarn);
  log.info(`续接上次未完成的扫码授权（剩余 ${Math.round((session.expiresAt - at) / 1000)}s，device_code 来自磁盘）`);
  return { ok: true, status: "waiting", url: session.url, remainingSeconds: Math.ceil((session.expiresAt - at) / 1000), interval: session.interval, pollMs: sess.pollMs };
}

/**
 * 查询授权状态（给插件读）：waiting/success/failed/expired/idle + 剩余秒数。
 * 只读，不会重启已停止的轮询（bridge 重启后由 resumeDingtalkAuth 负责续上）。
 */
export function authStatus(options = {}) {
  const relayDir = String(options.relayDir || "");
  const at = nowOf(options);
  if (!relayDir) return { ok: false, status: "idle", remainingSeconds: 0, message: human("no_relay_dir") };
  const session = readDingtalkAuthSession(relayDir);
  if (session) {
    if (at < session.expiresAt) {
      return {
        ok: true,
        status: "waiting",
        remainingSeconds: Math.max(0, Math.ceil((session.expiresAt - at) / 1000)),
        url: session.url,
        interval: session.interval,
        expiresAt: session.expiresAt,
        hasSecret: false
      };
    }
    // 过期：顺手清理（读接口也允许做这种幂等清理；结果仍如实返回）
    stopSession(relayDir);
    removeAuthFile(relayDir);
    const message = human("expired");
    setLastResult(relayDir, { status: "expired", code: "expired", message });
    patchDingtalkStatus(relayDir, { state: "failed", lastError: message, credentialSource: "scan" }, options.onWarn);
    return { ok: false, status: "expired", remainingSeconds: 0, message };
  }
  const last = lastResults.get(relayDir);
  if (last && at - last.at < LAST_RESULT_TTL_MS) {
    return { ...last, ok: last.status === "success", status: last.status, remainingSeconds: 0 };
  }
  return { ok: false, status: "idle", remainingSeconds: 0 };
}

/** 用户显式取消：停轮询 + 删 auth 文件 + 状态标记取消。 */
export function cancelDingtalkAuth(options = {}) {
  const relayDir = String(options.relayDir || "");
  if (!relayDir) return { ok: false, code: "no_relay_dir", message: human("no_relay_dir") };
  stopSession(relayDir);
  removeAuthFile(relayDir);
  const message = human("cancelled");
  setLastResult(relayDir, { status: "failed", code: "cancelled", message });
  patchDingtalkStatus(relayDir, { state: "failed", lastError: message, credentialSource: "scan" }, options.onWarn);
  syncAuthStatus(relayDir, options.onWarn);
  return { ok: true };
}

/** 只停定时器（**保留** auth 文件）：bridge 正常退出/配置变化时调用，下次启动可续轮询。 */
export function stopDingtalkAuthPolling() {
  for (const relayDir of [...sessions.keys()]) stopSession(relayDir);
}

/** 测试用：清空内存态（定时器 + 最近结论），不动文件。 */
export function __resetDingtalkAuthForTest() {
  stopDingtalkAuthPolling();
  stopDingtalkAuthCommandWatcher();
  lastResults.clear();
  lastAuthSync.clear();
  generationSeq = 0;
}

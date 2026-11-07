#!/usr/bin/env node
/**
 * feishu-bot 契约测试（M2 第 6 周 / task-27）。
 *
 * 全部用**注入的假 SDK / 假 fetch / 假事件订阅器**：不安装 41MB 官方 SDK、不联网、不建连。
 *
 * 覆盖（对应任务书七条）：
 *   ① SDK 缺失 → sdk_missing 且不崩；懒加载成功 → 缓存；sdkFactory 注入
 *   ② 建连参数（appId/appSecret/事件与回调注册）
 *   ③ 收消息解析 + 回复报文；过滤 bot 自己 / 白名单
 *   ④ 卡片回调 → 3 秒内 ACK、幂等、过期、再异步决策（与企微同一路）
 *   ⑤ 免费档第 21 条拦截（入站派活计数；通知/拍板不计数）
 *   ⑥ secret 不进日志
 *   ⑦ 状态字段（feishu 段 + deps.feishu；保留 wecom 段）
 *
 * 用法: node --test clients/dsh-remote/test/feishu-bot.test.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_ID_STRICT_RE,
  FEISHU_SDK_PACKAGE,
  FEISHU_SETUP_GUIDE,
  SDK_MISSING_HINT,
  _resetFeishuSdkCache,
  buildApprovalCard,
  buildDecidedCard,
  createFeishuBot,
  createFeishuBotController,
  createFeishuSender,
  extractFeishuMessageText,
  feishuErrorHint,
  feishuSdkStatus,
  formatFeishuText,
  loadFeishuSdk,
  mapConnectError,
  normalizeFeishuConfig,
  normalizeInboundEvent,
  parseCardAction,
  readFeishuConfig,
  resolveFeishuSdkDir,
  validateAppId
} from "../feishu-bot.mjs";

const APP_ID = "cli_9f427eec54ae901b"; // 16 hex：既能过我们的宽松校验，也能过 SDK 严格正则
const APP_SECRET = "super-secret-value-do-not-log";
const NOW = 1_700_000_000_000;
const at = () => NOW;

// ── 临时目录 ──────────────────────────────────────────────────────────────
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-feishu-"));
process.on("exit", () => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkRelayDir(name) {
  const d = path.join(DIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
}
function writeConfig(relayDir, feishu, extra = {}) {
  writeJson(path.join(relayDir, "im-bots.json"), {
    version: 1,
    wecom: { enabled: true, botId: "bot-x", secret: "wecom-secret" },
    feishu,
    ...extra
  });
}
/** 造一个「已下载 SDK」的目录（package.json + index.js 占位）。 */
function fakeSdkDir(relayDir, version = "1.76.0") {
  const sdkDir = resolveFeishuSdkDir({ relayDir });
  writeJson(path.join(sdkDir, "package.json"), { name: FEISHU_SDK_PACKAGE, version, main: "index.js" });
  fs.writeFileSync(path.join(sdkDir, "index.js"), "module.exports = {};\n");
  return sdkDir;
}

// ── 假 SDK ────────────────────────────────────────────────────────────────
function makeFakeSdk({ connectError = null, connectionState = "connected" } = {}) {
  const calls = { ws: [], dispatchers: [], starts: [], closes: 0, ctors: 0 };
  class EventDispatcher {
    constructor(opts) { this.opts = opts; this.handlers = {}; calls.dispatchers.push(this); }
    register(handlers) { this.handlers = handlers; return this; }
  }
  class WSClient {
    constructor(opts) { calls.ctors += 1; this.opts = opts; calls.ws.push(opts); }
    start({ eventDispatcher }) {
      calls.starts.push({ eventDispatcher });
      if (connectError) throw connectError;
      return Promise.resolve();
    }
    getConnectionStatus() { return { state: connectionState }; }
    close() { calls.closes += 1; return Promise.resolve(); }
  }
  class Client { constructor(opts) { this.opts = opts; } }
  return { sdk: { WSClient, EventDispatcher, Client }, calls };
}

// ── 假 fetch ──────────────────────────────────────────────────────────────
function makeFetch({ tokenCode = 0, sendCode = 0, sendMsg = "", patchCode = 0 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const isToken = url.includes("/auth/v3/tenant_access_token/internal");
    const isPatch = (init.method || "GET") === "PATCH";
    if (isToken) {
      return {
        ok: true,
        status: 200,
        json: async () => (tokenCode === 0
          ? { code: 0, tenant_access_token: "t-token", expire: 7200 }
          : { code: tokenCode, msg: "token failed" })
      };
    }
    if (isPatch) return { ok: true, status: 200, json: async () => ({ code: patchCode, msg: "" }) };
    return {
      ok: true,
      status: 200,
      json: async () => (sendCode === 0
        ? { code: 0, data: { message_id: "om_msg_1" } }
        : { code: sendCode, msg: sendMsg || "send failed" })
    };
  };
  return { fn, calls };
}

// ── 假事件订阅器 ──────────────────────────────────────────────────────────
function makeSubscriber() {
  const emitter = new EventEmitter();
  const calls = { sessions: [], prompts: [], started: 0, stopped: 0, listenSessions: 0 };
  return {
    calls,
    on: (evt, cb) => emitter.on(evt, cb),
    emit: (evt, arg) => emitter.emit(evt, arg),
    start() { calls.started += 1; return this; },
    stop() { calls.stopped += 1; },
    sessions() { return ["session-abc"]; },
    async listSessions() { calls.listenSessions += 1; return [{ sessionId: "session-abc", title: "t" }]; },
    async promptSession(req) { calls.prompts.push(req); return { ok: true }; }
  };
}

// ── 假消息/回调夹具（形状对齐官方事件） ──────────────────────────────────
const inboundText = (text = "你好", { senderType = "user", openId = "ou_user_1" } = {}) => ({
  event: {
    sender: { sender_id: { open_id: openId }, sender_type: senderType },
    message: {
      message_id: "om_in_1",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text })
    }
  }
});
const cardAction = ({ decision = "allow", requestId = "apr_1", nonce = "n1", expiresAt = NOW + 60_000, openId = "ou_user_1" } = {}) => ({
  event_id: `ev_${requestId}_${decision}`,
  event: {
    operator: { operator_id: { open_id: openId } },
    action: { value: { action: decision, requestId, nonce, expiresAt } },
    context: { open_chat_id: "oc_chat_1", open_message_id: "om_card_1" }
  }
});

// ===========================================================================
// A. SDK 状态 / 懒加载
// ===========================================================================

test("SDK 状态：未下载 → installed:false（面板据此显示「下载依赖」）", () => {
  const relayDir = mkRelayDir("sdk-missing");
  const st = feishuSdkStatus({ relayDir, env: {} });
  assert.equal(st.installed, false);
  assert.match(st.depsDir, /im-deps$/);
});

test("SDK 懒加载：目录不存在 → ok:false + sdk_missing 人话（不抛）", async () => {
  _resetFeishuSdkCache();
  const relayDir = mkRelayDir("sdk-missing2");
  const r = await loadFeishuSdk({ relayDir, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, SDK_MISSING_HINT);
  assert.equal(r.status.installed, false);
});

test("SDK 状态：已下载 → installed/version/path 正确（入口从 package.json main 解析）", () => {
  const relayDir = mkRelayDir("sdk-ok");
  const sdkDir = fakeSdkDir(relayDir, "1.76.0");
  const st = feishuSdkStatus({ relayDir, env: {} });
  assert.equal(st.installed, true);
  assert.equal(st.version, "1.76.0");
  assert.equal(st.path, path.join(sdkDir, "index.js"));
});

test("SDK 懒加载：import 成功并缓存（第二次不再 import）", async () => {
  _resetFeishuSdkCache();
  const relayDir = mkRelayDir("sdk-load");
  fakeSdkDir(relayDir);
  let imports = 0;
  const importImpl = async () => {
    imports += 1;
    return { default: { WSClient: class {}, EventDispatcher: class {} } };
  };
  const a = await loadFeishuSdk({ relayDir, env: {}, importImpl });
  assert.equal(a.ok, true);
  assert.equal(imports, 1);
  const b = await loadFeishuSdk({ relayDir, env: {}, importImpl });
  assert.equal(b.ok, true);
  assert.equal(imports, 1, "命中缓存");
});

test("SDK 懒加载：sdkFactory 注入（测试用桩）→ installed:injected", async () => {
  _resetFeishuSdkCache();
  const fake = makeFakeSdk();
  const st = feishuSdkStatus({ relayDir: "", env: {}, sdkFactory: () => fake.sdk });
  assert.equal(st.installed, true);
  assert.equal(st.injected, true);
  const r = await loadFeishuSdk({ relayDir: "", env: {}, sdkFactory: () => fake.sdk });
  assert.equal(r.ok, true);
  assert.equal(r.sdk, fake.sdk);
});

test("SDK 懒加载：import 抛错 → ok:false，lastError 进状态（不抛）", async () => {
  _resetFeishuSdkCache();
  const relayDir = mkRelayDir("sdk-broken");
  fakeSdkDir(relayDir);
  const r = await loadFeishuSdk({
    relayDir,
    env: {},
    importImpl: async () => {
      throw new Error("cannot find module proto");
    }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /加载失败/);
  const st = feishuSdkStatus({ relayDir, env: {} });
  assert.match(st.lastError, /cannot find module/);
});

// ===========================================================================
// B. 纯函数
// ===========================================================================

test("App ID 校验：严格/宽松/非法三档（SDK 静默拒绝的坑要提前暴露）", () => {
  assert.equal(validateAppId("").ok, false);
  assert.equal(validateAppId("https://open.feishu.cn").ok, false);
  const strict = validateAppId(APP_ID);
  assert.equal(strict.ok, true);
  assert.equal(strict.strict, true);
  assert.ok(APP_ID_STRICT_RE.test(APP_ID));
  // 官方文档示例里出现过含 x 的 ID（过不了 SDK 严格正则）→ 我们放行但要 warning
  const loose = validateAppId("cli_a5ca35a685b0x26e");
  assert.equal(loose.ok, true);
  assert.equal(loose.strict, false);
  assert.match(loose.warning, /严格校验/);
});

test("配置归一：默认值 / domain 归一 / allowFrom 去重 / cardApproval 默认开", () => {
  const cfg = normalizeFeishuConfig({
    feishu: {
      enabled: true, appId: " cli_x1 ", appSecret: " s ", domain: "Lark",
      receiveId: " oc_1 ", receiveIdType: "CHAT_ID",
      allowFrom: ["ou_a", "ou_a", ""], cardApproval: false
    }
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.appId, "cli_x1");
  assert.equal(cfg.appSecret, " s ");
  assert.equal(cfg.domain, "lark");
  assert.equal(cfg.receiveId, "oc_1");
  assert.equal(cfg.receiveIdType, "chat_id");
  assert.deepEqual(cfg.allowFrom, ["ou_a"]);
  assert.equal(cfg.cardApproval, false);
  // 缺省
  const def = normalizeFeishuConfig({});
  assert.equal(def.domain, "feishu");
  assert.equal(def.receiveIdType, "");
  assert.equal(def.cardApproval, true);
  assert.equal(def.sdkVersion, "");
  assert.equal(def.verifyToken, undefined, "长连接模式不需要 verifyToken");
});

test("读配置：文件不存在 → null；存在 → {config, raw}", () => {
  const relayDir = mkRelayDir("cfg-read");
  assert.equal(readFeishuConfig(relayDir), null);
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: "s" });
  const r = readFeishuConfig(relayDir);
  assert.equal(r.config.enabled, true);
  assert.equal(r.config.appId, APP_ID);
  assert.ok(r.raw.wecom, "原始对象保留（便于调试）");
});

test("审批卡片：卡片 2.0 + 两个按钮 + behaviors callback 带 requestId/action/nonce/expiresAt", () => {
  const card = buildApprovalCard({
    requestId: "apr_1", toolName: "Bash", summary: "npm test",
    expiresAt: NOW + 90_000, nonce: "n1"
  });
  assert.equal(card.schema, "2.0");
  const actions = card.body.elements.find((e) => e.tag === "action");
  assert.equal(actions.actions.length, 2);
  const values = actions.actions.map((b) => b.behaviors[0].value);
  assert.deepEqual(values.map((v) => v.action), ["allow", "deny"]);
  assert.equal(values[0].requestId, "apr_1");
  assert.equal(values[0].nonce, "n1");
  assert.equal(values[0].expiresAt, NOW + 90_000);
  assert.equal(JSON.stringify(card).includes("**"), false, "飞书文本无 markdown");
});

test("决定后的卡片：标题/颜色随决策变", () => {
  const ok = buildDecidedCard({ requestId: "apr_1", decision: "allow", operator: "ou_us***_1" });
  assert.equal(ok.header.template, "green");
  assert.match(ok.header.title.content, /已允许/);
  const no = buildDecidedCard({ requestId: "apr_1", decision: "deny" });
  assert.equal(no.header.template, "red");
  assert.match(no.header.title.content, /已拒绝/);
});

test("解析卡片回调：合法 allow/deny；缺 requestId / 未知动作 → ok:false", () => {
  const allow = parseCardAction(cardAction({ decision: "allow", requestId: "apr_9" }));
  assert.equal(allow.ok, true);
  assert.equal(allow.requestId, "apr_9");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.operatorOpenId, "ou_user_1");
  assert.equal(allow.chatId, "oc_chat_1");
  assert.equal(allow.messageId, "om_card_1");

  const deny = parseCardAction(cardAction({ decision: "deny" }));
  assert.equal(deny.decision, "deny");

  assert.equal(parseCardAction(null).ok, false);
  assert.equal(parseCardAction({ event: { action: { value: { action: "allow" } } } }).ok, false);
  assert.equal(parseCardAction({ event: { action: { value: { action: "launch", requestId: "x" } } } }).ok, false);
});

test("入站消息归一：text / post / 未知类型；bot 自己可识别", () => {
  assert.equal(extractFeishuMessageText("text", JSON.stringify({ text: " hi " })), "hi");
  assert.equal(
    extractFeishuMessageText("post", JSON.stringify({ title: "T", content: [[{ tag: "text", text: "正文" }]] })),
    "T 正文"
  );
  assert.equal(extractFeishuMessageText("image", JSON.stringify({ image_key: "k" })), "");
  assert.equal(extractFeishuMessageText("text", "{bad json"), "");

  const ev = normalizeInboundEvent(inboundText("hi"));
  assert.equal(ev.ok, true);
  assert.equal(ev.chatId, "oc_chat_1");
  assert.equal(ev.openId, "ou_user_1");
  assert.equal(ev.senderType, "user");
  assert.equal(ev.text, "hi");

  const botEv = normalizeInboundEvent(inboundText("hi", { senderType: "bot" }));
  assert.equal(botEv.senderType, "bot");
});

test("格式化：飞书无 markdown 文本 → 纯文本；超长按字节截断", () => {
  const plain = formatFeishuText("**加粗** 内容", { maxBytes: 1000 });
  assert.equal(plain.includes("**"), false);
  const long = formatFeishuText("中文".repeat(5000), { maxBytes: 300 });
  assert.ok(Buffer.byteLength(long, "utf8") <= 300 + 32, "截断后应在上限附近（含截断提示）");
});

test("错误码 → 人话（凭据/权限/机器人不在群/超频/可用范围/连接超限）", () => {
  assert.match(feishuErrorHint(99991663), /凭证失效/);
  assert.match(feishuErrorHint(230002), /机器人不在/);
  assert.match(feishuErrorHint(230013), /可用范围/);
  assert.match(feishuErrorHint(1000040350), /连接数超限/);
  assert.match(feishuErrorHint(999999, "boom"), /999999/);
});

test("建连错误映射：凭据/权限/网络（代理提示）/ 未知", () => {
  assert.match(mapConnectError(new Error("auth_failed: 514")), /凭据/);
  assert.match(mapConnectError(new Error("forbidden 403")), /权限|企业自建/);
  assert.match(mapConnectError(new Error("ETIMEDOUT")), /代理/);
  assert.match(mapConnectError(new Error("exceed_conn_limit")), /连接数超限/);
  assert.match(mapConnectError(new Error("weird")), /建连失败/);
});

// ===========================================================================
// C. 发送器
// ===========================================================================

test("发送文本：先拿 token 再 POST /im/v1/messages?receive_id_type=…，body 正确", async () => {
  const f = makeFetch();
  const sender = createFeishuSender({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: f.fn, clock: at });
  const r = await sender.sendText("ou_u1", "**hi**");
  assert.equal(r.ok, true);
  assert.equal(r.messageId, "om_msg_1");
  const tokenCall = f.calls.find((c) => c.url.includes("/auth/v3/tenant_access_token/internal"));
  assert.ok(tokenCall);
  assert.deepEqual(JSON.parse(tokenCall.body), { app_id: APP_ID, app_secret: APP_SECRET });
  const sendCall = f.calls.find((c) => c.url.includes("/open-apis/im/v1/messages"));
  assert.match(sendCall.url, /receive_id_type=open_id/);
  assert.equal(sendCall.headers.authorization, "Bearer t-token");
  const body = JSON.parse(sendCall.body);
  assert.equal(body.receive_id, "ou_u1");
  assert.equal(body.msg_type, "text");
  assert.equal(JSON.parse(body.content).text.includes("**"), false, "发送前按飞书通道格式化");
});

test("token 缓存：两次发送只取一次 token", async () => {
  const f = makeFetch();
  const sender = createFeishuSender({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: f.fn, clock: at });
  await sender.sendText("ou_u1", "a");
  await sender.sendText("ou_u1", "b");
  assert.equal(f.calls.filter((c) => c.url.includes("tenant_access_token")).length, 1);
});

test("发送卡片：msg_type=interactive，content 是卡片 JSON 字符串", async () => {
  const f = makeFetch();
  const sender = createFeishuSender({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: f.fn, clock: at });
  const card = buildApprovalCard({ requestId: "apr_1", toolName: "Bash" });
  const r = await sender.sendCard("oc_c1", card, { receiveIdType: "chat_id" });
  assert.equal(r.ok, true);
  const call = f.calls.find((c) => c.url.includes("/open-apis/im/v1/messages"));
  assert.match(call.url, /receive_id_type=chat_id/);
  const body = JSON.parse(call.body);
  assert.equal(body.msg_type, "interactive");
  assert.equal(JSON.parse(body.content).schema, "2.0");
});

test("发送失败：230002 → ok:false + 人话（机器人不在群）", async () => {
  const f = makeFetch({ sendCode: 230002, sendMsg: "bot is not in chat" });
  const sender = createFeishuSender({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: f.fn, clock: at });
  const r = await sender.sendText("oc_c1", "hi");
  assert.equal(r.ok, false);
  assert.match(r.reason, /机器人不在/);
});

test("token 失效（99991663）：清缓存重取一次再重试发送", async () => {
  let tokenCalls = 0;
  let sendCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("tenant_access_token")) {
      tokenCalls += 1;
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: `t-${tokenCalls}`, expire: 7200 }) };
    }
    sendCalls += 1;
    if (sendCalls === 1) return { ok: true, status: 200, json: async () => ({ code: 99991663, msg: "token invalid" }) };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: "om_2" } }) };
  };
  const sender = createFeishuSender({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl, clock: at });
  const r = await sender.sendText("ou_u1", "hi");
  assert.equal(r.ok, true);
  assert.equal(tokenCalls, 2);
  assert.equal(sendCalls, 2);
});

test("更新卡片：PATCH /im/v1/messages/:message_id", async () => {
  const f = makeFetch();
  const sender = createFeishuSender({ appId: APP_ID, appSecret: APP_SECRET, fetchImpl: f.fn, clock: at });
  const r = await sender.patchCard("om_1", buildDecidedCard({ requestId: "x", decision: "allow" }));
  assert.equal(r.ok, true);
  const call = f.calls.find((c) => c.method === "PATCH");
  assert.match(call.url, /\/im\/v1\/messages\/om_1$/);
  assert.equal(JSON.parse(call.body).content.includes("\"2.0\""), true);
});

// ===========================================================================
// D. Bot：建连 / 入站 / 卡片回调
// ===========================================================================

async function startBot({ sdkOpts, fetchOpts, botOpts = {} } = {}) {
  const fake = makeFakeSdk(sdkOpts);
  const f = makeFetch(fetchOpts);
  const logs = [];
  const bot = createFeishuBot({
    appId: APP_ID,
    appSecret: APP_SECRET,
    relayDir: mkRelayDir(`bot-${Math.random().toString(36).slice(2, 8)}`),
    sdkFactory: () => fake.sdk,
    fetchImpl: f.fn,
    clock: at,
    receiveIdType: "open_id",
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    ...botOpts
  });
  const r = await bot.start();
  return { bot, fake, fetchCalls: f.calls, logs, r };
}

test("bot 建连：WSClient 参数是 appId/appSecret；注册事件+卡片两个 handler；状态 connected", async () => {
  const { bot, fake, r, logs } = await startBot();
  assert.equal(r.ok, true);
  assert.equal(fake.calls.ctors, 1);
  assert.deepEqual(fake.calls.ws[0], { appId: APP_ID, appSecret: APP_SECRET });
  const handlers = fake.calls.dispatchers[0].handlers;
  assert.ok(typeof handlers["im.message.receive_v1"] === "function");
  assert.ok(typeof handlers["card.action.trigger"] === "function");
  const st = bot.status();
  assert.equal(st.state, "connected");
  assert.equal(st.connected, true);
  assert.equal(st.authenticated, true);
  assert.equal(st.appId.startsWith("cli_"), true);
  assert.equal(st.appId.includes(APP_ID), false, "状态里 appId 必须掩码");
  assert.equal(JSON.stringify(logs).includes(APP_SECRET), false, "secret 不进日志");
  await bot.stop();
});

test("bot 建连：appId 非法 → invalid_app_id，不创建 WSClient（SDK 会静默拒绝的坑提前拦）", async () => {
  const fake = makeFakeSdk();
  const bot = createFeishuBot({ appId: "not-a-cli-id", appSecret: "s", sdkFactory: () => fake.sdk, clock: at, relayDir: mkRelayDir("bot-bad-id") });
  const r = await bot.start();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid_app_id");
  assert.equal(fake.calls.ctors, 0);
  assert.equal(bot.status().state, "failed");
});

test("bot 建连：SDK 缺失 → sdk_missing（不抛、状态可读）", async () => {
  const relayDir = mkRelayDir("bot-no-sdk");
  const bot = createFeishuBot({
    appId: APP_ID, appSecret: "s", relayDir, clock: at,
    loadSdk: async () => ({ ok: false, error: SDK_MISSING_HINT, status: { installed: false } })
  });
  const r = await bot.start();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "sdk_missing");
  assert.equal(bot.status().state, "sdk_missing");
  assert.match(bot.status().lastError, /未下载/);
});

test("bot 建连：SDK start 抛凭据错 → 人话（凭据校验失败），状态 failed 不崩", async () => {
  const fake = makeFakeSdk({ connectError: Object.assign(new Error("auth_failed: 514"), { code: "auth_failed" }) });
  const bot = createFeishuBot({
    appId: APP_ID, appSecret: "s", sdkFactory: () => fake.sdk, clock: at, relayDir: mkRelayDir("bot-auth-fail")
  });
  const r = await bot.start();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "connect_failed");
  assert.match(bot.status().lastError, /凭据/);
  assert.equal(bot.status().state, "failed");
});

test("bot 入站：文本消息 → 'message' 事件（归一化）+ 绑定 chatId；bot 自己消息被过滤", async () => {
  const { bot } = await startBot();
  const got = [];
  bot.on("message", (m) => got.push(m));
  bot._dispatch("im.message.receive_v1", inboundText("你好"));
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "你好");
  assert.equal(got[0].chatId, "oc_chat_1");
  assert.equal(bot.status().boundChatId, "oc_chat_1");
  bot._dispatch("im.message.receive_v1", inboundText("自己", { senderType: "bot" }));
  assert.equal(got.length, 1, "bot 自己的消息不能触发");
  await bot.stop();
});

test("bot 入站：白名单外的人被拒（回一句提示，不触发 message）", async () => {
  const { bot, fetchCalls } = await startBot({ botOpts: { allowFrom: ["ou_allowed"] } });
  const got = [];
  bot.on("message", (m) => got.push(m));
  bot._dispatch("im.message.receive_v1", inboundText("hi", { openId: "ou_stranger" }));
  assert.equal(got.length, 0);
  await new Promise((r) => setTimeout(r, 20)); // 拒绝提示是 fire-and-forget，等一拍再断言
  const sent = fetchCalls.find((c) => c.url.includes("/im/v1/messages"));
  assert.ok(sent, "应回复提示");
  assert.match(JSON.parse(sent.body).content, /白名单/);
  bot._dispatch("im.message.receive_v1", inboundText("hi", { openId: "ou_allowed" }));
  assert.equal(got.length, 1);
  await bot.stop();
});

test("卡片回执：同步 ACK（toast+卡片）→ 决策异步；重复点击幂等；过期不回执", async () => {
  let decisions = [];
  const { bot } = await startBot({
    botOpts: {
      onApprovalDecision: (rid, decision) => {
        decisions.push({ rid, decision });
        return new Promise(() => {}); // 永不 resolve：证明 ACK 不被它阻塞
      }
    }
  });
  const t0 = Date.now();
  const ack = bot._dispatch("card.action.trigger", cardAction({ decision: "allow", requestId: "apr_1" }));
  const ackMs = Date.now() - t0;
  assert.ok(ack.toast && ack.toast.type === "success");
  assert.equal(ack.card.type, "raw");
  assert.match(ack.card.data.header.title.content, /已允许/);
  assert.ok(ackMs < 200, `ACK 必须同步/极快（实际 ${ackMs}ms，官方要求 3s 内）`);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(decisions, [{ rid: "apr_1", decision: "allow" }], "决策应由异步链路收到一次");

  // 同一条回执重复点：只回 toast，不再交决策
  const again = bot._dispatch("card.action.trigger", cardAction({ decision: "allow", requestId: "apr_1" }));
  assert.equal(again.toast.type, "info");
  await Promise.resolve();
  assert.equal(decisions.length, 1);

  // 已过期：不回执
  const expired = bot._dispatch("card.action.trigger", cardAction({ decision: "deny", requestId: "apr_2", expiresAt: NOW - 1 }));
  assert.equal(expired.toast.type, "info");
  assert.match(expired.toast.content, /过期/);
  await Promise.resolve();
  assert.equal(decisions.length, 1);

  // 无法解析：toast 警告，绝不乱放行
  const bad = bot._dispatch("card.action.trigger", { event: { action: { value: {} } } });
  assert.equal(bad.toast.type, "warning");
  await bot.stop();
});

test("卡片回执：拒绝也走同一条决策链路", async () => {
  const decisions = [];
  const { bot } = await startBot({
    botOpts: { onApprovalDecision: async (rid, decision) => { decisions.push({ rid, decision }); return { ok: true }; } }
  });
  const ack = bot._dispatch("card.action.trigger", cardAction({ decision: "deny", requestId: "apr_x" }));
  assert.equal(ack.toast.content.includes("拒绝"), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(decisions, [{ rid: "apr_x", decision: "deny" }]);
  await bot.stop();
});

test("bot.stop：关闭 WSClient 且幂等；状态回到 idle", async () => {
  const { bot, fake } = await startBot();
  await bot.stop();
  assert.equal(fake.calls.closes, 1);
  assert.equal(bot.status().state, "idle");
  assert.equal(bot.status().enabled, false);
  await bot.stop();
  assert.equal(fake.calls.closes, 1, "幂等");
});

// ===========================================================================
// E. Controller：配置 / 状态文件 / 会员闸 / 通知
// ===========================================================================

function startController(relayDir, opts = {}) {
  const fake = makeFakeSdk();
  const f = makeFetch();
  const logs = [];
  const sub = opts.subscriber || makeSubscriber();
  const controller = createFeishuBotController({
    relayDir,
    env: {},
    clock: at,
    sdkFactory: () => fake.sdk,
    fetchImpl: f.fn,
    subscriberFactory: () => sub,
    log: (line) => logs.push(String(line)),
    configPollMs: 10,
    ...opts,
    // 允许覆盖
    ...(opts.subscriber ? { subscriberFactory: () => opts.subscriber } : {})
  });
  return { controller, fake, fetchCalls: f.calls, logs, sub };
}

test("controller：无配置 → 不启动（零连接）；状态写 enabled:false", async () => {
  const relayDir = mkRelayDir("ctl-none");
  const { controller, fake } = startController(relayDir, { subscriber: makeSubscriber() });
  await controller.start();
  assert.equal(fake.calls.ctors, 0);
  const st = controller.status();
  assert.equal(st.enabled, false);
  assert.equal(st.configFound, false);
  await controller.stop();
});

test("controller：enabled 但 SDK 未下载 → sdk_missing + deps.feishu.installed=false，不崩", async () => {
  const relayDir = mkRelayDir("ctl-nosdk");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET });
  const controller = createFeishuBotController({ relayDir, env: {}, clock: at, configPollMs: 10, log: () => {} });
  await controller.start();
  assert.equal(controller.status().reason, "sdk_missing");
  const statusFile = path.join(relayDir, "im-bot-status.json");
  const st = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(st.feishu.state, "sdk_missing");
  assert.equal(st.deps.feishu.installed, false);
  assert.match(st.feishu.lastError, /未下载/);
  await controller.stop();
});

test("controller：appId 非法 → invalid_app_id + 人话，不建连", async () => {
  const relayDir = mkRelayDir("ctl-badid");
  writeConfig(relayDir, { enabled: true, appId: "not-cli", appSecret: APP_SECRET });
  const { controller, fake } = startController(relayDir, { subscriber: makeSubscriber() });
  await controller.start();
  assert.equal(controller.status().reason, "invalid_app_id");
  assert.equal(fake.calls.ctors, 0);
  await controller.stop();
});

test("controller：正常启用 → 建连 + 状态文件 feishu 段完整且保留 wecom 段", async () => {
  const relayDir = mkRelayDir("ctl-ok");
  writeConfig(relayDir, {
    enabled: true, appId: APP_ID, appSecret: APP_SECRET,
    receiveId: "ou_owner", receiveIdType: "open_id", cardApproval: true
  });
  // 预置一份 wecom 状态：验证合并写不覆盖别的通道
  writeJson(path.join(relayDir, "im-bot-status.json"), {
    version: 1, updatedAt: 1, wecom: { enabled: true, connected: true, authenticated: true }
  });
  const { controller, fake } = startController(relayDir, { subscriber: makeSubscriber(), capsProvider: async () => "pro" });
  await controller.start();
  assert.equal(fake.calls.ctors, 1);
  const st = JSON.parse(fs.readFileSync(path.join(relayDir, "im-bot-status.json"), "utf8"));
  assert.equal(st.wecom.connected, true, "wecom 段必须保留");
  assert.equal(st.feishu.enabled, true);
  assert.equal(st.feishu.state, "connected");
  assert.equal(st.feishu.connected, true);
  assert.equal(st.feishu.authenticated, true);
  assert.equal(st.feishu.tier, "pro");
  assert.ok(Array.isArray(st.feishu.caps) && st.feishu.caps.length > 0);
  assert.ok(st.feishu.usage && typeof st.feishu.usage.messages === "number");
  assert.equal(st.deps.feishu.installed, true);
  assert.equal(st.deps.feishu.version, "injected");
  await controller.stop();
});

test("controller：入站派活 — 免费档第 21 条被拦（配额从状态文件恢复），不转发会话", async () => {
  const relayDir = mkRelayDir("ctl-quota");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET, receiveId: "oc_chat_1", receiveIdType: "chat_id" });
  const month = new Date(NOW).toISOString().slice(0, 7);
  // 预置：本月已用 20 条
  writeJson(path.join(relayDir, "im-bot-status.json"), {
    version: 1, feishu: { usage: { month, messages: 20 }, tier: "free" }
  });
  const sub = makeSubscriber();
  const { controller, botFetch } = (() => {
    const r = startController(relayDir, { subscriber: sub, capsProvider: async () => "free" });
    return { controller: r.controller, botFetch: r.fetchCalls };
  })();
  await controller.start();
  // 模拟飞书推来一条消息（走真实 bot 的入站 handler）
  controller._bot()._dispatch("im.message.receive_v1", inboundText("帮我跑个任务"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sub.calls.prompts.length, 0, "第 21 条不能转发给 agent");
  const reply = botFetch.find((c) => c.url.includes("/im/v1/messages"));
  assert.ok(reply, "应回一条额度提示");
  assert.match(JSON.parse(reply.body).content, /免费额度已用完/);
  await controller.stop();
});

test("controller：入站派活 — 付费档可转发，usage 计数 +1 并落状态", async () => {
  const relayDir = mkRelayDir("ctl-pass");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET, receiveId: "oc_chat_1", receiveIdType: "chat_id" });
  const sub = makeSubscriber();
  const { controller, fake, fetchCalls } = startController(relayDir, { subscriber: sub, capsProvider: async () => "pro" });
  await controller.start();
  controller._bot()._dispatch("im.message.receive_v1", inboundText("继续做"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sub.calls.prompts.length, 1);
  assert.deepEqual(sub.calls.prompts[0], { sessionId: "session-abc", text: "继续做" });
  const ack = fetchCalls.find((c) => c.url.includes("/im/v1/messages"));
  assert.match(JSON.parse(ack.body).content, /已收到/);
  const st = JSON.parse(fs.readFileSync(path.join(relayDir, "im-bot-status.json"), "utf8"));
  assert.equal(st.feishu.usage.messages, 1);
  await controller.stop();
});

test("controller：审批事件 → 发可点卡片（interactive）；turn_end → 发文本通知", async () => {
  const relayDir = mkRelayDir("ctl-notify");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET, receiveId: "ou_owner", receiveIdType: "open_id" });
  const sub = makeSubscriber();
  const { controller, fetchCalls } = startController(relayDir, { subscriber: sub });
  await controller.start();
  sub.emit("event", { kind: "approval-request", eventId: "apr_notify_1", toolName: "Bash", sessionId: "s1" });
  await new Promise((r) => setTimeout(r, 20));
  const card = fetchCalls.find((c) => c.url.includes("/im/v1/messages") && JSON.parse(c.body).msg_type === "interactive");
  assert.ok(card, "审批事件应发 interactive 卡片");
  const content = JSON.parse(JSON.parse(card.body).content);
  const action = content.body.elements.find((e) => e.tag === "action");
  assert.equal(action.actions[0].behaviors[0].value.requestId, "apr_notify_1");

  sub.emit("event", { kind: "turn-end", sessionId: "s1", turn: 1, seq: 2, reason: "completed" });
  await new Promise((r) => setTimeout(r, 20));
  const texts = fetchCalls.filter((c) => c.url.includes("/im/v1/messages") && JSON.parse(c.body).msg_type === "text");
  assert.ok(texts.length >= 1, "turn_end 应发文本通知");
  assert.match(JSON.parse(texts[texts.length - 1].body).content, /完成/);
  await controller.stop();
});

test("controller：热更新（改 appId）→ 重建长连接", async () => {
  const relayDir = mkRelayDir("ctl-reload");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET, receiveId: "ou_owner" });
  const fake = makeFakeSdk();
  const controller = createFeishuBotController({
    relayDir,
    env: {},
    clock: at,
    sdkFactory: () => fake.sdk,
    fetchImpl: makeFetch().fn,
    configPollMs: 10,
    log: () => {}
  });
  await controller.start();
  assert.equal(fake.calls.ctors, 1);
  writeConfig(relayDir, { enabled: true, appId: "cli_aaaaaaaaaaaaaaaa", appSecret: APP_SECRET, receiveId: "ou_owner" });
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && fake.calls.ctors < 2) await new Promise((r) => setTimeout(r, 25));
  assert.equal(fake.calls.ctors, 2, "改凭据应重建连接");
  await controller.stop();
});

test("controller：stop 幂等，状态写 stopped", async () => {
  const relayDir = mkRelayDir("ctl-stop");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET });
  const { controller, fake, sub } = startController(relayDir, { subscriber: makeSubscriber() });
  await controller.start();
  await controller.stop();
  await controller.stop();
  assert.equal(fake.calls.closes, 1);
  assert.equal(sub.calls.stopped, 1);
  const st = JSON.parse(fs.readFileSync(path.join(relayDir, "im-bot-status.json"), "utf8"));
  assert.equal(st.feishu.enabled, false);
});

test("controller：日志里绝不出现 appSecret", async () => {
  const relayDir = mkRelayDir("ctl-secret");
  writeConfig(relayDir, { enabled: true, appId: APP_ID, appSecret: APP_SECRET, receiveId: "ou_owner" });
  const { controller, logs } = startController(relayDir, { subscriber: makeSubscriber() });
  await controller.start();
  await controller.stop();
  assert.equal(logs.some((l) => l.includes(APP_SECRET)), false, "secret 绝不能进日志");
});

// ===========================================================================
// F. 配置页向导契约（供插件半渲染；不画 UI）
// ===========================================================================

test("8 步向导：官方链接齐全、步骤 8 条、含顺序坑与「一个应用一台电脑」", () => {
  assert.match(FEISHU_SETUP_GUIDE.docs.registerApp, /open\.feishu\.cn\/app/);
  assert.match(FEISHU_SETUP_GUIDE.docs.longConnectionEvent, /long-connection|event-subscription/);
  assert.equal(FEISHU_SETUP_GUIDE.steps.length, 8);
  assert.match(FEISHU_SETUP_GUIDE.steps[4], /长连接接收事件/);
  assert.match(FEISHU_SETUP_GUIDE.steps[5], /card\.action\.trigger/);
  assert.match(FEISHU_SETUP_GUIDE.orderWarning, /长连接在线/);
  assert.match(FEISHU_SETUP_GUIDE.oneAppOnePc, /一台电脑/);
});

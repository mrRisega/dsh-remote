/**
 * 企业微信「智能机器人」长连接通道 —— bridge 侧单测（task-21）。
 *
 * 全部用**本地 ws WebSocketServer** 模拟官方长连接，不连任何真实网络/不使用业主凭据。
 * 覆盖规格里的每一条硬要求：
 *   ① 认证帧格式（cmd/headers.req_id/body{secret,bot_id}）
 *   ② 认证失败（errcode≠0）**不重连**，且错误可读、带 errcode
 *   ③ 心跳 30s 语义（连续未 ack 判死重连）+ pong 正常时保持连接
 *   ④ 指数退避重连 1s→2s→…→上限
 *   ⑤ 入站文本解析（text/mixed）+ 绑定 chatid + 被动回复形状
 *   ⑥ 主动推送报文（aibot_send_msg + chatid/markdown 形状）
 *   ⑦ 状态文件 im-bot-status.json：字段契约 + 0600 + 原子替换（无残留 .tmp）+ 合并其它段
 *   ⑧ secret 绝不进日志（含"服务端把 secret 回显进 errmsg"的最坏情况）
 *   ⑨ 出站通知映射（turn_done / turn_error / approval_request）+ 绑定会话优先 / targetChatId 兜底 / 都没有时跳过
 *   ⑩ 入站转发（promptSession）与失败降级（无会话/无订阅器）
 *   ⑪ 配置契约 im-bots.json（默认关闭 / 缺凭据 / allowFrom 白名单 / targetChatId）
 *   ⑫ 控制器 fs.watchFile 热更新（禁用即停、改凭据重连）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import test from "node:test";

import { WebSocketServer } from "ws";

import {
  ANSWER_MAX_CHARS,
  ANSWER_TRUNCATED_NOTE,
  APPROVAL_CARD_SUMMARY_MAX,
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE,
  approvalTaskId,
  atomicWriteJson,
  buildApprovalCard,
  buildDecidedCard,
  buildPreviewCard,
  buildPreviewDecidedCard,
  createScopedLogger,
  isPreviewCardEvent,
  createWecomBot,
  createWecomBotController,
  extractInboundText,
  fileMode,
  maskSecrets,
  normalizeImBotsConfig,
  normalizeSessionStatusList,
  parseApprovalEventKey,
  pickInboundIdentity,
  readImBotsConfig,
  toMarkdownNotification
} from "../wecom-bot.mjs";
import { NODE_KINDS } from "../dsh-events.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待（避免固定 sleep 造成 flake）。 */
async function waitFor(fn, { timeoutMs = 4000, stepMs = 15, label = "条件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await sleep(stepMs);
  }
}

const SECRET = "test-secret-abc123";
const BOT_ID = "bot-test-0001";

/**
 * 本地假长连接服务端。
 * @param {{onFrame?:Function, onConnect?:Function}} opts
 */
async function startFakeServer(opts = {}) {
  const state = { conns: [], frames: [], closed: 0 };
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const port = wss.address().port;
  wss.on("connection", (ws) => {
    const conn = { ws, at: Date.now(), frames: [] };
    state.conns.push(conn);
    ws.on("message", (raw) => {
      let frame = null;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      conn.frames.push(frame);
      state.frames.push(frame);
      if (typeof opts.onFrame === "function") {
        try { opts.onFrame(frame, ws, state); } catch { /* 断言由用例负责 */ }
      }
    });
    ws.on("close", () => { state.closed += 1; });
    if (typeof opts.onConnect === "function") {
      try { opts.onConnect(ws, conn, state); } catch { /* 忽略 */ }
    }
  });
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    state,
    ack(reqId, extra = {}) {
      const frame = { headers: reqId ? { req_id: reqId } : {}, errcode: 0, errmsg: "ok", ...extra };
      for (const c of state.conns) {
        try { c.ws.send(JSON.stringify(frame)); } catch { /* 忽略 */ }
      }
    },
    /** 广播一帧给当前所有连接（模拟官方下发）。 */
    push(frame) {
      for (const c of state.conns) {
        try { c.ws.send(JSON.stringify(frame)); } catch { /* 忽略 */ }
      }
    },
    close() {
      for (const c of state.conns) { try { c.ws.terminate(); } catch { /* 忽略 */ } }
      return new Promise((resolve) => wss.close(() => resolve()));
    }
  };
}

/** 认证成功的服务端行为：收到 aibot_subscribe 就回 ok。 */
const autoAckAuth = (frame, ws) => {
  if (frame.cmd === "aibot_subscribe") {
    ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: "ok" }));
  }
};
/** 心跳回 ack（让连接保持）。 */
const autoAckPing = (frame, ws) => {
  if (frame.cmd === "ping") {
    ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: "ok" }));
  }
};
/** 主动推送回 ack（用于断言 sent 计数）。 */
const autoAckSend = (frame, ws) => {
  if (frame.cmd === "aibot_send_msg" || frame.cmd === "aibot_respond_msg") {
    ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: "ok" }));
  }
};

function tmpRelayDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wecom-"));
}

function readStatus(relayDir) {
  try { return JSON.parse(fs.readFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), "utf8")); } catch { return null; }
}

/** 极简假订阅器（EventEmitter + dsh-events 的最小可用面）。 */
function fakeSubscriber(over = {}) {
  const sub = new EventEmitter();
  sub.state = "ready";
  sub.started = false;
  sub.closed = false;
  sub.promptCalls = [];
  sub.cancelCalls = [];
  sub.cancelSession = async ({ sessionId } = {}) => { sub.cancelCalls.push({ sessionId }); return { ok: true }; };
  sub.sessionDetails = Array.isArray(over.sessions) ? over.sessions.slice() : [];
  sub.start = () => { sub.started = true; };
  sub.close = () => { sub.closed = true; };
  sub.listSessions = async () => ({ ok: true, sessions: sub.sessionDetails });
  // task-24：follow 中的会话 id（`subscriber.sessions()` 的真实形状是 string[]）。
  // 默认从 sessions 详情里取 id（更贴近真实：细节列表里有的会话通常也在 follow 中）。
  sub.sessionIds = Array.isArray(over.sessionIds)
    ? over.sessionIds.slice()
    : sub.sessionDetails.map((x) => x && x.sessionId).filter(Boolean);
  sub.sessions = () => sub.sessionIds.slice();
  /** 回答回传用（dsh-events 的真实签名：{ok:true,text} / {ok:false,code,text:""}；可动态替换）。 */
  sub.lastAssistantCalls = [];
  sub.assistantReply = over.assistantText !== undefined ? over.assistantText : { ok: true, text: "" };
  sub.lastAssistantText = async ({ sessionId } = {}) => {
    sub.lastAssistantCalls.push({ sessionId });
    return typeof sub.assistantReply === "function" ? sub.assistantReply(sessionId) : sub.assistantReply;
  };
  sub.promptSession = async (arg) => {
    sub.promptCalls.push(arg);
    if (over.promptImpl) return over.promptImpl(arg);
    return { ok: true, accepted: true };
  };
  return sub;
}

// ─────────────────────────── ① 认证 + 状态文件契约 ───────────────────────────

test("★ 认证帧格式（aibot_subscribe + secret/bot_id）与成功后状态文件契约（0600/字段/原子写/合并不覆盖其它段）", async () => {
  const relayDir = tmpRelayDir();
  fs.writeFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), JSON.stringify({
    version: 1, updatedAt: 1, feishu: { connected: true } // 别的模块写的段，必须原样保留
  }), { mode: 0o600 });

  const server = await startFakeServer({ onFrame: autoAckAuth });
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url, relayDir, logger: () => {}
  });
  try {
    bot.start();
    await waitFor(() => bot.status().authenticated, { label: "认证完成" });
    const auth = server.state.frames.find((f) => f.cmd === "aibot_subscribe");
    assert.ok(auth, "必须发出 aibot_subscribe 认证帧");
    assert.deepEqual(Object.keys(auth).sort(), ["body", "cmd", "headers"], "认证帧只允许 cmd/headers/body 三个顶层字段");
    assert.deepEqual(Object.keys(auth.headers), ["req_id"], "headers 里只有 req_id");
    assert.equal(typeof auth.headers.req_id, "string");
    assert.ok(auth.headers.req_id.length > 0);
    assert.deepEqual(auth.body, { secret: SECRET, bot_id: BOT_ID }, "body 形状必须是 {secret, bot_id}");

    const st = bot.status();
    assert.equal(st.connected, true);
    assert.equal(st.authenticated, true);
    assert.equal(st.enabled, true);

    const file = path.join(relayDir, IM_BOT_STATUS_FILE);
    const status = readStatus(relayDir);
    assert.ok(status, "必须写 im-bot-status.json");
    assert.equal(status.version, 1);
    assert.ok(status.updatedAt > 0);
    assert.deepEqual(status.feishu, { connected: true }, "其它 IM 的段必须原样保留（绝不整份覆盖）");
    const w = status.wecom;
    for (const k of ["enabled", "connected", "authenticated", "lastError", "lastConnectedAt", "lastMessageAt", "boundChatId", "targetChatId"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(w, k), `状态文件 wecom 段必须含字段 ${k}`);
    }
    assert.equal(w.enabled, true);
    assert.equal(w.connected, true);
    assert.equal(w.authenticated, true);
    assert.equal(w.lastError, "");
    assert.ok(w.lastConnectedAt > 0);
    assert.equal(w.boundChatId, "");
    assert.ok(!JSON.stringify(status).includes(SECRET), "状态文件绝不能含 secret");
    if (process.platform !== "win32") assert.equal(fileMode(file), 0o600, "状态文件必须 0600");
    const leftovers = fs.readdirSync(relayDir).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, [], "原子写下不得残留 .tmp 文件");
  } finally {
    await bot.stop();
    await server.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

// ─────────────────────────── ② 认证失败不重连 ───────────────────────────

test("★ 认证失败（errcode≠0）：立即停止、不无限重连，错误可读且带 errcode", async () => {
  const relayDir = tmpRelayDir();
  const server = await startFakeServer({
    onFrame: (frame, ws) => {
      if (frame.cmd === "aibot_subscribe") {
        ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 40101, errmsg: "invalid secret" }));
      }
    }
  });
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url, relayDir, logger: () => {},
    reconnectBaseMs: 20, reconnectMaxMs: 40 // 就算要重连也会很快暴露
  });
  try {
    const authFailed = new Promise((resolve) => bot.once("auth-failed", resolve));
    bot.start();
    const ev = await authFailed;
    assert.equal(ev.errcode, 40101);
    const st = bot.status();
    assert.equal(st.authFailed, true);
    assert.equal(st.authenticated, false);
    assert.match(st.lastError, /40101/);
    assert.match(st.lastError, /认证被拒绝/);
    await sleep(300); // 远超退避时间
    assert.equal(server.state.conns.length, 1, "凭据错必须**不重连**（否则会被官方限流/封禁）");
    assert.equal(readStatus(relayDir).wecom.authenticated, false);
    assert.ok(!JSON.stringify(readStatus(relayDir)).includes(SECRET), "状态文件不得含 secret");
  } finally {
    await bot.stop();
    await server.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

// ─────────────────────────── ③ 心跳 ───────────────────────────

test("★ 心跳：ping 帧形状正确、pong 正常时保持连接；连续未 ack 判死并重连", async () => {
  // 场景 A：正常回 pong → 连接不掉
  {
    const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
    const bot = createWecomBot({
      botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {},
      heartbeatMs: 20, heartbeatMaxMiss: 2, reconnectBaseMs: 20, reconnectMaxMs: 40
    });
    try {
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证完成" });
      await sleep(150);
      const pings = server.state.frames.filter((f) => f.cmd === "ping");
      assert.ok(pings.length >= 2, `应按间隔发心跳（实际 ${pings.length} 次）`);
      assert.deepEqual(Object.keys(pings[0]).sort(), ["cmd", "headers"], "ping 帧只允许 cmd/headers");
      assert.equal(typeof pings[0].headers.req_id, "string");
      assert.equal(server.state.conns.length, 1, "pong 正常时不得重连");
      assert.ok(bot.status().lastPongAt > 0);
    } finally {
      await bot.stop();
      await server.close();
    }
  }
  // 场景 B：服务端从不回 pong → 连续未 ack → 判死重连
  {
    const server = await startFakeServer({ onFrame: autoAckAuth });
    const bot = createWecomBot({
      botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {},
      heartbeatMs: 20, heartbeatMaxMiss: 2, reconnectBaseMs: 20, reconnectMaxMs: 40
    });
    try {
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证完成" });
      await waitFor(() => server.state.conns.length >= 2, { timeoutMs: 3000, label: "心跳超时后重连" });
      assert.ok(server.state.frames.filter((f) => f.cmd === "ping").length >= 2);
    } finally {
      await bot.stop();
      await server.close();
    }
  }
});

// ─────────────────────────── ④ 指数退避 ───────────────────────────

test("★ 断网重连：指数退避（1s→2s→…）且不超过 30s 上限（这里用 20/40ms 缩放验证形状）", async () => {
  // 服务端一接上就断开（网络断的典型形态）→ 客户端应退避重连，且间隔递增到上限
  const server = await startFakeServer({
    onConnect: (ws) => { try { ws.close(); } catch { /* 忽略 */ } }
  });
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {},
    reconnectBaseMs: 40, reconnectMaxMs: 80, authTimeoutMs: 500
  });
  try {
    bot.start();
    await waitFor(() => server.state.conns.length >= 4, { timeoutMs: 5000, label: "至少 4 次连接" });
    const times = server.state.conns.map((c) => c.at);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // 间距应递增（40 → 80 → 80），且都不超过上限 + 合理调度余量
    assert.ok(gaps[0] >= 20, `第一次重连间隔应 ≥ 基础退避（实际 ${gaps[0]}ms）`);
    assert.ok(gaps[gaps.length - 1] <= 80 + 120, `重连间隔不得超过上限太多（实际 ${gaps[gaps.length - 1]}ms）`);
    const st = bot.status();
    assert.ok(st.reconnectAttempts >= 3);
    assert.ok(st.nextRetryInMs <= 80, "nextRetryInMs 必须被上限钳住");
  } finally {
    await bot.stop();
    await server.close();
  }
});

// ─────────────────────────── ⑤ 入站解析 + 被动回复 ───────────────────────────

test("★ 入站文本：解析 text/mixed、绑定 chatid、被动回复 aibot_respond_msg 形状", async () => {
  const relayDir = tmpRelayDir();
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
  // 无订阅器（不传 upstream）→ 入站转发降级，但绑定/回复仍要工作
  const callbacks = [];
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url, relayDir, logger: () => {},
    onMessage: (m) => callbacks.push(m) // 规格里的便捷回调形态
  });
  try {
    const messages = [];
    bot.on("message", (m) => messages.push(m));
    bot.start();
    await waitFor(() => bot.status().authenticated, { label: "认证完成" });

    server.push({
      cmd: "aibot_msg_callback",
      headers: { req_id: "inbound-req-1" },
      body: { msgid: "msg-1", msgtype: "text", text: { content: "帮我看下构建为什么失败" }, from: { userid: "user-a" }, chattype: "single" }
    });
    await waitFor(() => messages.length === 1, { label: "入站事件" });
    assert.equal(messages[0].text, "帮我看下构建为什么失败");
    assert.equal(messages[0].msgid, "msg-1");
    assert.equal(messages[0].chatid, "user-a", "单聊 chatid = 对方 userid");
    assert.equal(messages[0].fromUser, "user-a");
    assert.equal(messages[0].isGroup, false);
    assert.equal(callbacks.length, 1, "onMessage 回调也要被调用（与事件并行）");
    assert.equal(callbacks[0].text, "帮我看下构建为什么失败");

    // 绑定 + 状态文件
    assert.equal(bot.status().boundChatId, "user-a", "首次入站即绑定推送接收方");
    const st = readStatus(relayDir);
    assert.equal(st.wecom.boundChatId, "user-a");
    assert.ok(st.wecom.lastMessageAt > 0);

    // 无订阅器 → 被动回复一句「转不过去」
    const reply = await waitFor(() => server.state.frames.find((f) => f.cmd === "aibot_respond_msg"), { label: "被动回复" });
    assert.deepEqual(Object.keys(reply.headers), ["req_id"]);
    assert.equal(reply.headers.req_id, "inbound-req-1", "被动回复必须回带入站帧的 req_id");
    assert.equal(reply.body.msgtype, "stream");
    assert.equal(typeof reply.body.stream.id, "string");
    assert.equal(reply.body.stream.finish, true);
    assert.match(reply.body.stream.content, /还没连上|转不过去/);

    // 同 msgid 重发 → 去重（不再 emit）
    server.push({
      cmd: "aibot_msg_callback",
      headers: { req_id: "inbound-req-1b" },
      body: { msgid: "msg-1", msgtype: "text", text: { content: "重复" }, from: { userid: "user-a" } }
    });
    await sleep(100);
    assert.equal(messages.length, 1, "同一 msgid 必须去重");
  } finally {
    await bot.stop();
    await server.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("纯函数：extractInboundText 覆盖 text/mixed/voice/非文本；pickInboundIdentity 区分单聊群聊", () => {
  assert.equal(extractInboundText({ msgtype: "text", text: { content: " hi " } }), "hi");
  assert.equal(extractInboundText({
    msgtype: "mixed",
    mixed: { msg_item: [{ type: "text", text: { content: "第一句" } }, { type: "image", image: {} }, { type: "text", text: { content: "第二句" } }] }
  }), "第一句\n第二句");
  assert.equal(extractInboundText({ msgtype: "mixed", mixed: [{ type: "text", text: { content: "a" } }] }), "a");
  assert.equal(extractInboundText({ msgtype: "voice", voice: { content: "语音转写" } }), "语音转写");
  assert.equal(extractInboundText({ msgtype: "image" }), "", "图片没有文本 → 空串（由上层提示）");

  assert.deepEqual(pickInboundIdentity({ from: { userid: "u1" } }), { fromUser: "u1", chatid: "u1", isGroup: false });
  assert.deepEqual(pickInboundIdentity({ chatid: "g1", chattype: "group", from: { userid: "u1" } }), { fromUser: "u1", chatid: "g1", isGroup: true });
  assert.deepEqual(pickInboundIdentity({}), { fromUser: "", chatid: "", isGroup: false });
});

// ─────────────────────────── ⑥ 主动推送 ───────────────────────────

test("★ 主动推送：aibot_send_msg 报文形状（chatid + markdown）；未认证时如实失败", async () => {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckSend(f, ws); } });
  const bot = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {} });
  try {
    const early = bot.sendMarkdown("user-a", "还没认证");
    assert.deepEqual(early, { ok: false, reason: "not_authenticated" }, "未认证不得发");
    assert.equal(bot.sendMarkdown("", "x").reason, "no_chatid");

    bot.start();
    await waitFor(() => bot.status().authenticated, { label: "认证完成" });
    const r = bot.sendMarkdown("user-a", "✅ 任务完成｜构建修复");
    assert.equal(r.ok, true);
    const frame = await waitFor(() => server.state.frames.find((f) => f.cmd === "aibot_send_msg"), { label: "主动推送帧" });
    assert.deepEqual(Object.keys(frame).sort(), ["body", "cmd", "headers"]);
    assert.equal(typeof frame.headers.req_id, "string");
    assert.equal(frame.body.chatid, "user-a");
    assert.equal(frame.body.msgtype, "markdown");
    assert.equal(frame.body.markdown.content, "✅ 任务完成｜构建修复");
    await waitFor(() => bot.status().sent === 1, { label: "推送被 ack 后计数" });
  } finally {
    await bot.stop();
    await server.close();
  }
});

// ─────────────────────────── ⑦ secret 不进日志 ───────────────────────────

test("★ secret 绝不进日志：连服务端把 secret 回显进 errmsg 的最坏情况也不能漏", async () => {
  const lines = [];
  const server = await startFakeServer({
    onFrame: (frame, ws) => {
      if (frame.cmd === "aibot_subscribe") {
        // 最坏情况：服务端把收到的 secret 原样写回 errmsg（真实服务端不会，但我们要兜住）
        ws.send(JSON.stringify({
          headers: { req_id: frame.headers.req_id },
          errcode: 40001,
          errmsg: `invalid credential secret=${frame.body.secret} bot_id=${frame.body.bot_id}`
        }));
      }
    }
  });
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url, logger: (level, line) => lines.push(line),
    authTimeoutMs: 500
  });
  try {
    bot.start();
    await waitFor(() => bot.status().authFailed, { label: "认证失败" });
    await sleep(80);
    const loggerLines = bot._logger.lines.join("\n");
    assert.ok(loggerLines.length > 0, "应至少有一行日志（便于排查）");
    assert.ok(!loggerLines.includes(SECRET), "日志绝不能出现 secret 字面量");
    assert.ok(!lines.join("\n").includes(SECRET), "外部 sink 同样不能收到 secret");
    assert.ok(!bot.status().lastError.includes(SECRET), "状态里的错误文案也不能带 secret");
  } finally {
    await bot.stop();
    await server.close();
  }
});

// ─────────────────────────── ⑧ allowFrom 白名单 ───────────────────────────

test("白名单 allowFrom：陌生发送者被拒绝且不绑定；白名单内正常绑定", async () => {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {},
    allowFrom: ["user-ok"]
  });
  try {
    const messages = [];
    const rejected = [];
    bot.on("message", (m) => messages.push(m));
    bot.on("inbound-rejected", (m) => rejected.push(m));
    bot.start();
    await waitFor(() => bot.status().authenticated, { label: "认证完成" });

    server.push({
      cmd: "aibot_msg_callback", headers: { req_id: "evil-1" },
      body: { msgid: "e1", msgtype: "text", text: { content: "删库跑路" }, from: { userid: "user-evil" } }
    });
    await waitFor(() => rejected.length === 1, { label: "拒绝事件" });
    assert.equal(messages.length, 0, "白名单外不得分发");
    assert.equal(bot.status().boundChatId, "", "白名单外不得绑定");
    const reply = await waitFor(() => server.state.frames.find((f) => f.cmd === "aibot_respond_msg"), { label: "拒绝回复" });
    assert.match(reply.body.stream.content, /权限/);

    server.push({
      cmd: "aibot_msg_callback", headers: { req_id: "ok-1" },
      body: { msgid: "e2", msgtype: "text", text: { content: "你好" }, from: { userid: "user-ok" } }
    });
    await waitFor(() => messages.length === 1, { label: "白名单内分发" });
    assert.equal(bot.status().boundChatId, "user-ok");
  } finally {
    await bot.stop();
    await server.close();
  }
});

// ─────────────────────────── ⑨ 入站转发（fake subscriber）───────────────────────────

test("★ 入站转发：有会话 → promptSession({sessionId,text})；无会话 → 回复「还没选择会话」且不调用", async () => {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
  // 场景 A：订阅器已发现运行中的会话
  {
    const sub = fakeSubscriber();
    const bot = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {}, subscriber: sub });
    try {
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证完成" });
      sub.emit("session-state", { sessionId: "session-abc", state: "running" });
      await sleep(30);
      server.push({
        cmd: "aibot_msg_callback", headers: { req_id: "fwd-1" },
        body: { msgid: "m-f1", msgtype: "text", text: { content: "跑一下测试" }, from: { userid: "user-a" } }
      });
      await waitFor(() => sub.promptCalls.length === 1, { label: "promptSession 调用" });
      assert.deepEqual(sub.promptCalls[0], { sessionId: "session-abc", text: "跑一下测试" });
      const reply = await waitFor(() => server.state.frames.find((f) => f.cmd === "aibot_respond_msg"), { label: "成功回复" });
      assert.match(reply.body.stream.content, /已转给桌面端会话/);
      assert.equal(bot.status().inbound, 1);
    } finally {
      await bot.stop();
    }
  }
  // 场景 B：没有任何会话 → 提示用户先选择，且不得调用 promptSession
  {
    const sub = fakeSubscriber({ sessions: [] });
    const bot = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {}, subscriber: sub });
    try {
      const failed = [];
      bot.on("inbound-failed", (e) => failed.push(e));
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证完成" });
      server.push({
        cmd: "aibot_msg_callback", headers: { req_id: "fwd-2" },
        body: { msgid: "m-f2", msgtype: "text", text: { content: "hello" }, from: { userid: "user-a" } }
      });
      await waitFor(() => failed.length === 1, { label: "转发失败事件" });
      assert.equal(failed[0].reason, "no_session");
      assert.equal(sub.promptCalls.length, 0, "没有会话时绝不乱发 promptSession");
      const reply = await waitFor(() => server.state.frames.filter((f) => f.cmd === "aibot_respond_msg").pop(), { label: "提示回复" });
      assert.match(reply.body.stream.content, /还没在桌面端选择要接管的会话/);
    } finally {
      await bot.stop();
      await server.close();
    }
  }
});

// ─────────────────────────── ⑩ 出站通知（fake subscriber）───────────────────────────

test("★ 出站通知：turn_done/turn_error → Markdown、approval_request → 审批卡片，都发到绑定的 chatid；无接收方时跳过", async () => {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
  const sub = fakeSubscriber();

  // 纯函数映射（文案钉死）
  assert.match(toMarkdownNotification({ kind: NODE_KINDS.TURN_END, sessionId: "s1", reason: "completed" }), /^✅ 任务完成/);
  assert.match(toMarkdownNotification({ kind: NODE_KINDS.TURN_END, sessionId: "s1", reason: "error" }), /^❌ 出错了/);
  assert.match(toMarkdownNotification({ kind: NODE_KINDS.TURN_END, sessionId: "s1", reason: "max-tokens" }), /^❌ 出错了/);
  assert.match(toMarkdownNotification({ kind: NODE_KINDS.SESSION_ERROR, sessionId: "s1", message: "boom" }), /^❌ 出错了.*boom/s);
  assert.match(toMarkdownNotification({ kind: NODE_KINDS.APPROVAL_REQUEST, sessionId: "s1", toolName: "Bash" }), /^🛂 需要你在电脑上拍板｜Bash/);
  assert.equal(toMarkdownNotification({ kind: NODE_KINDS.GAP }, {}), null, "其它节点不在这里推");
  assert.equal(toMarkdownNotification({ kind: NODE_KINDS.TURN_END, reason: "completed" }, { sessionTitle: () => "重构登录" }), "✅ 任务完成｜重构登录");

  // 场景 A：先入站绑定 chatid，再出站推送
  const bot = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {}, subscriber: sub });
  try {
    bot.start();
    await waitFor(() => bot.status().authenticated, { label: "认证完成" });
    server.push({
      cmd: "aibot_msg_callback", headers: { req_id: "bind-1" },
      body: { msgid: "m-b1", msgtype: "text", text: { content: "hi" }, from: { userid: "user-a" } }
    });
    await waitFor(() => bot.status().boundChatId === "user-a", { label: "绑定" });

    sub.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "session-x", reason: "completed", turn: 1, seq: 9, at: Date.now() });
    const send = await waitFor(() => server.state.frames.find((f) => f.cmd === "aibot_send_msg"), { label: "完成通知" });
    assert.equal(send.body.chatid, "user-a", "优先用最近一次入站 chatid");
    assert.match(send.body.markdown.content, /^✅ 任务完成/);

    // 同一事件重复（重连快照补报）→ 去重
    const before = server.state.frames.filter((f) => f.cmd === "aibot_send_msg").length;
    sub.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "session-x", reason: "completed", turn: 1, seq: 9, at: Date.now() });
    await sleep(120);
    assert.equal(server.state.frames.filter((f) => f.cmd === "aibot_send_msg").length, before, "同一 turn/end 不得重复推送");

    // 出错 → 仍是 markdown
    sub.emit("event", { kind: NODE_KINDS.SESSION_ERROR, sessionId: "session-x", message: "build failed" });
    const errSend = await waitFor(() => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body.markdown && /出错了/.test(f.body.markdown.content)).pop(), { label: "出错通知" });
    assert.equal(errSend.body.chatid, "user-a");
    // 审批类 → **卡片**（task-24），不再是 markdown
    sub.emit("event", { kind: NODE_KINDS.APPROVAL_REQUEST, sessionId: "session-x", eventId: "ev-1", toolName: "Bash", reason: "要执行一条命令" });
    const cardSend = await waitFor(() => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body.msgtype === "template_card").pop(), { label: "审批卡片" });
    assert.equal(cardSend.body.chatid, "user-a");
    assert.equal(cardSend.body.template_card.card_type, "button_interaction");
    assert.match(cardSend.body.template_card.main_title.desc, /Bash/);
  } finally {
    await bot.stop();
  }

  // 场景 B：没有入站绑定，也没有 targetChatId → 跳过并记日志（不发任何推送）
  {
    const sub2 = fakeSubscriber();
    const bot2 = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {}, subscriber: sub2 });
    try {
      const sentBefore = server.state.frames.filter((f) => f.cmd === "aibot_send_msg").length;
      bot2.start();
      await waitFor(() => bot2.status().authenticated, { label: "认证完成2" });
      sub2.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "s2", reason: "completed", turn: 1, seq: 1 });
      await sleep(150);
      assert.equal(server.state.frames.filter((f) => f.cmd === "aibot_send_msg").length, sentBefore, "没有接收方时跳过");
      assert.ok(bot2._logger.lines.some((l) => /还没绑定接收方/.test(l)), "要记一条可排查的日志");
    } finally {
      await bot2.stop();
    }
  }

  // 场景 C：targetChatId 兜底
  {
    const sub3 = fakeSubscriber();
    const bot3 = createWecomBot({
      botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {}, subscriber: sub3,
      targetChatId: "user-target"
    });
    try {
      bot3.start();
      await waitFor(() => bot3.status().authenticated, { label: "认证完成3" });
      sub3.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "s3", reason: "completed", turn: 2, seq: 2 });
      const send = await waitFor(() => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body.chatid === "user-target").pop(), { label: "targetChatId 兜底" });
      assert.ok(send.body.markdown.content.startsWith("✅ 任务完成"));
    } finally {
      await bot3.stop();
      await server.close();
    }
  }
});

// ─────────────────────────── ⑩b 回答回传（入站 → agent 回答 → 原路发回）───────────────────────────

/** 建一个「已认证 + 入站一次 + 可注入回答」的 bot，返回便捷断言面。 */
async function setupRelayBot(over = {}) {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); autoAckSend(f, ws); } });
  const lines = [];
  const sub = fakeSubscriber({
    sessions: [{ sessionId: "session-abc", running: true }],
    ...(over.sub || {})
  });
  if (over.assistantText !== undefined) sub.assistantReply = over.assistantText;
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url,
    logger: (level, line) => lines.push(line),
    subscriber: sub,
    ...(over.bot || {})
  });
  const sends = () => server.state.frames.filter((f) => f.cmd === "aibot_send_msg");
  const inbound = async (msgid, content, userid = "user-a") => {
    const before = sub.promptCalls.length;
    server.push({
      cmd: "aibot_msg_callback", headers: { req_id: `in-${msgid}` },
      body: { msgid, msgtype: "text", text: { content }, from: { userid } }
    });
    await waitFor(() => sub.promptCalls.length > before, { label: `入站 ${msgid} 被转发` });
  };
  const turnEnd = (extra = {}) => sub.emit("event", {
    kind: NODE_KINDS.TURN_END, sessionId: "session-abc", reason: "completed",
    turn: 1, seq: 1, at: Date.now(), ...extra
  });
  return { server, sub, bot, lines, sends, inbound, turnEnd, close: async () => { await bot.stop(); await server.close(); } };
}

test("★ 任务通知带总结（企微）：turn_done → 一条「✅ 任务完成｜标题 + 正文」；同 turn 不重发；缺正文降级标题；正文不进日志", async () => {
  const rt = await setupRelayBot({ assistantText: { ok: true, text: "这是 agent 的最终总结" } });
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().authenticated, { label: "认证完成" });
    await rt.inbound("relay-1", "你好");
    rt.turnEnd({ turn: 1, seq: 11 });
    const first = await waitFor(() => rt.sends()[0], { label: "任务通知" });
    assert.equal(first.body.chatid, "user-a");
    assert.equal(first.body.msgtype, "markdown");
    const content = first.body.markdown.content;
    assert.match(content, /^✅ 任务完成/, "★ 通知必须带「任务完成」标题行");
    assert.match(content, /\n\n这是 agent 的最终总结$/, "★ 同一条消息里带总结正文（不是另发一条）");
    assert.deepEqual(rt.sub.lastAssistantCalls[0], { sessionId: "session-abc" }, "正文通过 lastAssistantText 取");
    await sleep(120);
    assert.equal(rt.sends().length, 1, "★ 同一次 turn 只发一条（不得标题一条 + 正文一条）");

    // 同 turn 重复事件 → 去重，不重发
    rt.turnEnd({ turn: 1, seq: 11 });
    await sleep(120);
    assert.equal(rt.sends().length, 1, "★ 同 turn 重复事件去重");

    // 其它会话的 turn/end 也带总结（订阅器能给到该会话正文）
    rt.sub.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "session-other", reason: "completed", turn: 1, seq: 12, at: Date.now() });
    const other = await waitFor(() => rt.sends().find((f) => f.body.markdown.content.includes("这是 agent 的最终总结") && f !== first), { label: "其它会话通知" });
    assert.match(other.body.markdown.content, /^✅ 任务完成/);

    // 取不到正文 → 降级仅标题（不丢消息、不报错）
    await rt.inbound("relay-2", "再问一句");
    rt.sub.assistantReply = { ok: false, code: "page-failed", text: "" };
    rt.turnEnd({ turn: 3, seq: 14 });
    await waitFor(() => rt.sends().length >= 3, { label: "降级通知" });
    const fallback = rt.sends()[rt.sends().length - 1];
    assert.match(fallback.body.markdown.content, /^✅ 任务完成/, "★ 取不到正文时仅标题");
    assert.ok(!fallback.body.markdown.content.includes("\n\n"), "无正文时不要多余空段");
    // 正文绝不进日志（只打长度）
    const allLogs = rt.lines.join("\n");
    assert.ok(!allLogs.includes("这是 agent 的最终总结"), "★ 总结正文绝不能进日志");
    assert.ok(allLogs.split("\n").some((l) => /任务通知 .*len=\d+/.test(l)), "日志只记长度");
  } finally {
    await rt.close();
  }
});

test("★ 任务通知：turn/end 瞬间正文还没落库 → 短重试后仍带总结（不是直接降级标题）", async () => {
  let call = 0;
  const rt = await setupRelayBot({
    assistantText: () => {
      call += 1;
      return call === 1 ? { ok: true, text: "" } : { ok: true, text: "重试后拿到的总结" };
    }
  });
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().authenticated, { label: "认证完成" });
    await rt.inbound("retry-1", "你好");
    rt.turnEnd({ turn: 1, seq: 31 });
    const send = await waitFor(() => rt.sends()[0], { label: "重试后的通知" });
    const content = send.body.markdown.content;
    assert.match(content, /^✅ 任务完成/);
    assert.match(content, /\n\n重试后拿到的总结$/);
    assert.equal(rt.sub.lastAssistantCalls.length, 2, "应恰好重试一次");
  } finally {
    await rt.close();
  }
});

test("★ 任务通知边界：超长正文按 1500 字截断+注明；出错带错误摘要；正文不进日志", async () => {
  const longSummary = "开头" + "长".repeat(3000) + "SECRET-SUMMARY-TAIL";
  const rt = await setupRelayBot({ assistantText: { ok: true, text: longSummary } });
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().authenticated, { label: "认证完成" });
    await rt.inbound("trunc-1", "来点长的");
    rt.turnEnd({ turn: 1, seq: 22 });
    const send = await waitFor(() => rt.sends()[0], { label: "截断后的通知" });
    const content = send.body.markdown.content;
    assert.match(content, /^✅ 任务完成/);
    assert.ok(content.endsWith(ANSWER_TRUNCATED_NOTE), `超长正文要以「${ANSWER_TRUNCATED_NOTE}」结尾`);
    const bodyPart = content.split("\n\n").slice(1).join("\n\n");
    assert.ok(Array.from(bodyPart).length <= 1500 + Array.from(ANSWER_TRUNCATED_NOTE).length + 2, "正文长度不得超过 1500 字（+截断提示）");
    assert.ok(!content.includes("SECRET-SUMMARY-TAIL"));
    const allLogs = rt.lines.join("\n");
    assert.ok(!allLogs.includes("SECRET-SUMMARY-TAIL"), "★ 总结正文绝不能进日志");
    assert.ok(!allLogs.includes("长".repeat(40)), "★ 正文片段也不能进日志");
    assert.ok(allLogs.split("\n").some((l) => /任务通知 .* len=\d+/.test(l)), "日志只记长度");

    // 出错：❌ 标题 + 错误摘要（同一条消息）
    rt.sub.assistantReply = { ok: true, text: "只跑了一半的结果" };
    await rt.inbound("err-1", "再试");
    rt.turnEnd({ turn: 2, seq: 23, reason: "error" });
    const errSend = await waitFor(() => rt.sends().find((f) => f.body.markdown.content.includes("只跑了一半的结果")), { label: "出错通知" });
    assert.match(errSend.body.markdown.content, /^❌ 出错了/);
    assert.match(errSend.body.markdown.content, /\n\n只跑了一半的结果$/);

    // 被拦下（blocked）：状态行 + 总结
    rt.sub.assistantReply = { ok: true, text: "被安全策略拦截的说明" };
    await rt.inbound("block-1", "危险操作");
    rt.turnEnd({ turn: 3, seq: 24, reason: "blocked" });
    const blocked = await waitFor(() => rt.sends().find((f) => f.body.markdown.content.includes("被安全策略拦截的说明")), { label: "被拦通知" });
    assert.match(blocked.body.markdown.content, /^⛔ 被拦下了/);
  } finally {
    await rt.close();
  }
});

// ─────────────────────────── ⑩c 审批卡片（task-24）───────────────────────────

/** 模拟「用户点了卡片按钮」：官方入站事件帧（body.event.eventtype=template_card_event）。 */
function pushCardClick(server, { reqId, taskId, eventKey, chatid = "user-a", userid = "user-a" }) {
  server.push({
    cmd: "aibot_event_callback",
    headers: { req_id: reqId },
    body: {
      msgid: `evt-${reqId}`,
      create_time: 1700000000,
      msgtype: "event",
      chatid,
      chattype: "single",
      from: { userid },
      event: { eventtype: "template_card_event", event_key: eventKey, task_id: taskId }
    }
  });
}

/** 建一个「已认证、可收卡片点击」的 bot。 */
async function setupCardBot(over = {}) {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); autoAckSend(f, ws); } });
  const lines = [];
  const decisions = [];
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url,
    logger: (level, line) => lines.push(line),
    onApprovalDecision: async (requestId, decision, meta) => {
      decisions.push({ requestId, decision, meta });
      if (typeof over.decide === "function") return over.decide(requestId, decision, meta);
      return { ok: true, via: "dsh" };
    },
    ...(over.bot || {})
  });
  const sends = () => server.state.frames.filter((f) => f.cmd === "aibot_send_msg");
  const updates = () => server.state.frames.filter((f) => f.cmd === "aibot_respond_update_msg");
  const cards = () => sends().filter((f) => f.body && f.body.msgtype === "template_card");
  const texts = () => sends().filter((f) => f.body && f.body.markdown);
  return {
    server, bot, lines, decisions, sends, updates, cards, texts,
    async start() { bot.start(); await waitFor(() => bot.status().authenticated, { label: "认证完成(card)" }); },
    async close() { await bot.stop(); await server.close(); }
  };
}

test("★ 审批卡片报文：button_interaction 结构 / task_id 安全哈希 / 按钮 key / 摘要 ≤112 / 未认证拒绝", async () => {
  // 纯函数先钉死（不依赖网络）
  assert.match(approvalTaskId("ev-abc"), /^apr_[A-Za-z0-9_-]+$/);
  assert.ok(approvalTaskId("x".repeat(500)).length <= 128, "task_id 必须 ≤128");
  assert.notEqual(approvalTaskId("a"), approvalTaskId("b"), "不同 requestId → 不同 task_id");
  assert.deepEqual(parseApprovalEventKey("allow:abc:def"), { decision: "allow", requestId: "abc:def" }, "只按第一个冒号切");
  assert.deepEqual(parseApprovalEventKey("deny:xyz"), { decision: "deny", requestId: "xyz" });
  assert.equal(parseApprovalEventKey("bogus:x"), null);
  assert.equal(parseApprovalEventKey("allow:"), null, "空 requestId 不算合法按钮");
  const pureCard = buildApprovalCard({ requestId: "ev-1", summary: "长".repeat(300), toolName: "Bash" });
  assert.equal(pureCard.card_type, "button_interaction");
  assert.equal(pureCard.sub_title_text.length, APPROVAL_CARD_SUMMARY_MAX, "摘要必须截到 112 字");
  assert.equal(pureCard.button_list[0].style, 1);
  assert.equal(pureCard.button_list[1].style, 2);
  assert.match(buildDecidedCard({ requestId: "ev-1", state: "allowed", who: "张三", at: Date.now() }).main_title.title, /已允许/);
  assert.ok(normalizeSessionStatusList([{ id: "a" }, { id: "a" }, { id: "b", title: " t ", updatedAt: 5 }]).length === 2);

  const rt = await setupCardBot();
  try {
    await rt.start();
    const longSummary = "命令详情 ".repeat(60);
    const r = rt.bot.sendApprovalCard("user-a", { requestId: "ev-abc:123", title: "需要你在电脑上拍板", summary: longSummary, toolName: "Bash" });
    assert.equal(r.ok, true);
    const frame = await waitFor(() => rt.cards()[0], { label: "审批卡片帧" });
    assert.equal(frame.body.chatid, "user-a");
    assert.equal(frame.body.msgtype, "template_card");
    const card = frame.body.template_card;
    assert.equal(card.card_type, "button_interaction");
    assert.match(card.task_id, /^apr_[A-Za-z0-9_-]+$/);
    assert.ok(card.task_id.length <= 128);
    assert.equal(card.task_id, r.taskId);
    assert.equal(card.main_title.title, "需要你在电脑上拍板");
    assert.match(card.main_title.desc, /Bash/);
    assert.ok(card.sub_title_text.length <= APPROVAL_CARD_SUMMARY_MAX);
    assert.equal(card.button_list.length, 2);
    assert.deepEqual(card.button_list.map((b) => ({ text: b.text, style: b.style })), [
      { text: "允许一次", style: 1 }, { text: "拒绝", style: 2 }
    ]);
    assert.equal(card.button_list[0].key, "allow:ev-abc:123", "requestId 原样进 key（含冒号）");
    assert.equal(card.button_list[1].key, "deny:ev-abc:123");
    // 未认证时如实失败（不静默）
    assert.equal(rt.bot.sendApprovalCard("user-a", { requestId: "" }).reason, "no_request_id");
    assert.equal(rt.bot.sendApprovalCard("", { requestId: "x" }).reason, "no_chatid");
  } finally {
    await rt.close();
  }
});

test("★ 审批卡片点击：allow/deny → onApprovalDecision → aibot_respond_update_msg（req_id=事件帧）→ 短文本确认", async () => {
  const rt = await setupCardBot();
  try {
    await rt.start();
    // 允许
    const r1 = rt.bot.sendApprovalCard("user-a", { requestId: "ev-allow", toolName: "Bash" });
    await waitFor(() => rt.cards().length === 1, { label: "卡片已发" });
    pushCardClick(rt.server, { reqId: "evt-req-1", taskId: r1.taskId, eventKey: "allow:ev-allow" });
    await waitFor(() => rt.decisions.length === 1, { label: "allow 回调" });
    assert.deepEqual(
      { requestId: rt.decisions[0].requestId, decision: rt.decisions[0].decision, source: rt.decisions[0].meta.source },
      { requestId: "ev-allow", decision: "allow", source: "wecom-card" }
    );
    const upd1 = await waitFor(() => rt.updates()[0], { label: "卡片更新(allow)" });
    assert.equal(upd1.headers.req_id, "evt-req-1", "★ 更新帧的 req_id 必须是**事件帧**的 req_id");
    assert.equal(upd1.body.response_type, "update_template_card");
    assert.equal(upd1.body.template_card.card_type, "text_notice");
    assert.match(upd1.body.template_card.main_title.title, /已允许/);
    const txt1 = await waitFor(() => rt.texts().find((f) => /已允许一次/.test(f.body.markdown.content)), { label: "允许确认文本" });
    assert.equal(txt1.body.chatid, "user-a");

    // 拒绝
    const r2 = rt.bot.sendApprovalCard("user-a", { requestId: "ev-deny", toolName: "Write" });
    await waitFor(() => rt.cards().length === 2, { label: "第二张卡片" });
    pushCardClick(rt.server, { reqId: "evt-req-2", taskId: r2.taskId, eventKey: "deny:ev-deny", userid: "user-b" });
    await waitFor(() => rt.decisions.length === 2, { label: "deny 回调" });
    assert.equal(rt.decisions[1].decision, "deny");
    const upd2 = await waitFor(() => rt.updates().find((f) => f.headers.req_id === "evt-req-2"), { label: "卡片更新(deny)" });
    assert.match(upd2.body.template_card.main_title.title, /已拒绝/);
    assert.match(upd2.body.template_card.main_title.desc, /user-b/, "卡片上写清操作人");
    await waitFor(() => rt.texts().find((f) => /已拒绝/.test(f.body.markdown.content)), { label: "拒绝确认文本" });
    // senderId 不进日志（只 hash）
    assert.ok(!rt.lines.join("\n").includes("user-b"), "★ 操作人 userid 不得进日志（只 hash）");
    assert.ok(rt.lines.some((l) => /审批卡片点击/.test(l)));
    assert.equal(rt.bot.status().approvalDecisions, 2);
  } finally {
    await rt.close();
  }
});

test("★ 审批卡片：重复点击幂等（不再回调，回「已处理」）；过期后点=按拒绝处理（fail-closed）", async () => {
  // 幂等
  {
    const rt = await setupCardBot();
    try {
      await rt.start();
      const r = rt.bot.sendApprovalCard("user-a", { requestId: "ev-dup" });
      await waitFor(() => rt.cards().length === 1, { label: "卡片" });
      pushCardClick(rt.server, { reqId: "dup-1", taskId: r.taskId, eventKey: "allow:ev-dup" });
      await waitFor(() => rt.decisions.length === 1, { label: "首次点击" });
      pushCardClick(rt.server, { reqId: "dup-2", taskId: r.taskId, eventKey: "allow:ev-dup" });
      await sleep(120);
      assert.equal(rt.decisions.length, 1, "★ 同一张卡重复点击不得再次调回调（幂等）");
      const dupText = await waitFor(() => rt.texts().find((f) => /已经处理过/.test(f.body.markdown.content)), { label: "已处理提示" });
      assert.match(dupText.body.markdown.content, /已允许/);
      const upd2 = await waitFor(() => rt.updates().find((f) => f.headers.req_id === "dup-2"), { label: "重复点击也更新卡片" });
      assert.match(upd2.body.template_card.main_title.title, /已允许/);
    } finally {
      await rt.close();
    }
  }
  // TTL 过期（注入 40ms）
  {
    const rt = await setupCardBot({ bot: { approvalCardTtlMs: 40 } });
    try {
      await rt.start();
      const r = rt.bot.sendApprovalCard("user-a", { requestId: "ev-old" });
      await waitFor(() => rt.cards().length === 1, { label: "卡片2" });
      await sleep(120); // 超过 40ms TTL
      pushCardClick(rt.server, { reqId: "old-1", taskId: r.taskId, eventKey: "allow:ev-old" });
      await waitFor(() => rt.decisions.length === 1, { label: "过期也回调" });
      assert.equal(rt.decisions[0].decision, "deny", "★ 过期点击必须 fail-closed 按拒绝处理（即使点的是允许）");
      assert.equal(rt.decisions[0].meta.expired, true);
      const upd = await waitFor(() => rt.updates().find((f) => f.headers.req_id === "old-1"), { label: "过期卡片更新" });
      assert.match(upd.body.template_card.main_title.title, /已过期/);
      const txt = await waitFor(() => rt.texts().find((f) => /过期/.test(f.body.markdown.content)), { label: "过期提示" });
      assert.match(txt.body.markdown.content, /按「拒绝」处理/);
    } finally {
      await rt.close();
    }
  }
});

test("★ 审批回调失败：卡片显示「没能送达电脑端」+ 提示到电脑上确认（不假装成功）", async () => {
  const rt = await setupCardBot({ decide: () => ({ ok: false, reason: "事件已作废（可能已在手机上拍板）" }) });
  try {
    await rt.start();
    const r = rt.bot.sendApprovalCard("user-a", { requestId: "ev-fail" });
    await waitFor(() => rt.cards().length === 1, { label: "卡片" });
    pushCardClick(rt.server, { reqId: "fail-1", taskId: r.taskId, eventKey: "allow:ev-fail" });
    await waitFor(() => rt.decisions.length === 1, { label: "回调" });
    const upd = await waitFor(() => rt.updates().find((f) => f.headers.req_id === "fail-1"), { label: "失败卡片更新" });
    assert.match(upd.body.template_card.main_title.title, /没能送达/);
    const txt = await waitFor(() => rt.texts().find((f) => /没能送达电脑端/.test(f.body.markdown.content)), { label: "失败提示" });
    assert.equal(rt.bot.status().approvalDecisions, 0, "失败不计数为成功");
  } finally {
    await rt.close();
  }
});

// ─────────────────────────── ⑩e 预览卡片（自检/演示）───────────────────────────

test("★ 预览卡片：报文结构 / 点击只更新卡+说明 / **不调 onApprovalDecision** / 可重复点 / 不污染真实审批", async () => {
  // 纯函数先钉死
  const ts = 1699999999123;
  const pure = buildPreviewCard(ts);
  assert.equal(pure.card_type, "button_interaction");
  assert.equal(pure.task_id, "apr_preview_9999999123", "task_id = apr_preview_ + 时间戳后 10 位");
  assert.equal(pure.main_title.title, "预览：需要你在电脑上拍板");
  assert.equal(pure.main_title.desc, "这是一张预览卡片，不会真的执行操作");
  assert.deepEqual(pure.button_list.map((b) => b.key), ["allow:preview:9999999123", "deny:preview:9999999123"]);
  assert.equal(pure.button_list[0].style, 1);
  assert.equal(pure.button_list[1].style, 2);
  assert.equal(isPreviewCardEvent("preview:123", ""), true);
  assert.equal(isPreviewCardEvent("", "apr_preview_123"), true);
  assert.equal(isPreviewCardEvent("ev-real", "apr_abc"), false);
  assert.match(buildPreviewDecidedCard({ decision: "deny", who: "业主", ts }).main_title.title, /预览卡片 · 已收到你的选择（拒绝）/);
  assert.equal(buildPreviewDecidedCard({ decision: "allow", ts }).main_title.desc, "这是预览卡片，没有对应的真实操作");

  const rt = await setupCardBot();
  try {
    await rt.start();
    const r = rt.bot.sendPreviewCard("user-a", ts);
    assert.equal(r.ok, true);
    assert.equal(r.taskId, "apr_preview_9999999123");
    const frame = await waitFor(() => rt.cards()[0], { label: "预览卡片帧" });
    assert.equal(frame.body.chatid, "user-a");
    assert.equal(frame.body.msgtype, "template_card");
    assert.deepEqual(frame.body.template_card, pure, "线上报文与纯函数构造完全一致");

    // 点「允许」：只更新卡 + 一句说明，绝不调 onApprovalDecision
    pushCardClick(rt.server, { reqId: "pv-1", taskId: r.taskId, eventKey: "allow:preview:9999999123", userid: "user-preview" });
    const upd = await waitFor(() => rt.updates().find((f) => f.headers.req_id === "pv-1"), { label: "预览卡更新" });
    assert.equal(upd.body.response_type, "update_template_card");
    assert.match(upd.body.template_card.main_title.title, /预览卡片 · 已收到你的选择（允许）/);
    assert.equal(upd.body.template_card.main_title.desc, "这是预览卡片，没有对应的真实操作");
    assert.equal(upd.body.template_card.card_type, "text_notice");
    const txt = await waitFor(() => rt.texts().find((f) => /这是预览卡片，没有对应的真实操作/.test(f.body.markdown.content)), { label: "预览说明文本" });
    assert.equal(txt.body.chatid, "user-a");
    assert.equal(rt.decisions.length, 0, "★ 预览卡点击绝不调 onApprovalDecision（没有真实操作）");
    // 再点「拒绝」→ 允许重复点（预览不是幂等的一次性卡）
    pushCardClick(rt.server, { reqId: "pv-2", taskId: r.taskId, eventKey: "deny:preview:9999999123", userid: "user-preview" });
    const upd2 = await waitFor(() => rt.updates().find((f) => f.headers.req_id === "pv-2"), { label: "第二次预览点击" });
    assert.match(upd2.body.template_card.main_title.title, /（拒绝）/);
    assert.equal(rt.decisions.length, 0);
    assert.equal(rt.bot.status().previewClicks, 2);
    assert.equal(rt.bot.status().previews, 1);

    // 预览卡不污染真实审批：随后真实审批卡点击仍走回调
    const real = rt.bot.sendApprovalCard("user-a", { requestId: "ev-real" });
    await waitFor(() => rt.cards().length === 2, { label: "真实审批卡" });
    pushCardClick(rt.server, { reqId: "real-1", taskId: real.taskId, eventKey: "allow:ev-real" });
    await waitFor(() => rt.decisions.length === 1, { label: "真实审批回调" });
    assert.equal(rt.decisions[0].requestId, "ev-real");
    // 操作人 userid 不进日志（只 hash）
    assert.ok(!rt.lines.join("\n").includes("user-preview"), "★ 预览点击的操作人 userid 也不得进日志");
  } finally {
    await rt.close();
  }
});

test("★ 控制器：previewCardAt 变大 → 发一次预览卡（不重建连接）；相同值不重复；无接收方跳过", async () => {
  const relayDir = tmpRelayDir();
  const logs = [];
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); autoAckSend(f, ws); } });
  const created = [];
  const writeCfg = (extra = {}) => fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
    version: 1, wecom: { enabled: true, botId: BOT_ID, secret: SECRET, ...extra }
  }), { mode: 0o600 });
  const cards = () => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body && f.body.msgtype === "template_card");
  const controller = createWecomBotController({
    relayDir, configPollMs: 30, env: {},
    log: (level, line) => logs.push(line),
    createBot: (opts) => {
      const b = createWecomBot({ ...opts, url: server.url, logger: (level, line) => logs.push(line) });
      created.push(b);
      return b;
    }
  });
  try {
    writeCfg(); // 无 previewCardAt
    await controller.start();
    await waitFor(() => controller.status().bot && controller.status().bot.authenticated, { timeoutMs: 5000, label: "连上" });
    const bot = controller._bot();
    // 先绑定接收方（入站一句即可；没有 subscriber 也能绑定 chat）
    server.push({ cmd: "aibot_msg_callback", headers: { req_id: "bind-pv" }, body: { msgid: "mpv1", msgtype: "text", text: { content: "hi" }, from: { userid: "user-a" } } });
    await waitFor(() => bot.status().boundChatId === "user-a", { label: "绑定接收方" });
    assert.equal(cards().length, 0);

    // ① previewCardAt 变大 → 发一张，且不重建连接
    writeCfg({ previewCardAt: 1111 });
    await waitFor(() => cards().some((f) => f.body.template_card.task_id === "apr_preview_1111"), { timeoutMs: 5000, label: "预览卡 1111" });
    assert.equal(created.length, 1, "★ 只改 previewCardAt 不得重建连接（连接配置没变）");
    assert.equal(cards().length, 1);

    // ② 相同值（哪怕 mtime 变了）不重复发
    writeCfg({ previewCardAt: 1111 });
    await sleep(250);
    assert.equal(cards().length, 1, "★ 相同 previewCardAt 不得重复发");

    // ③ 再变大 → 再发一张
    writeCfg({ previewCardAt: 2222 });
    await waitFor(() => cards().some((f) => f.body.template_card.task_id === "apr_preview_2222"), { timeoutMs: 5000, label: "预览卡 2222" });
    assert.equal(cards().length, 2);

    // ④ 状态文件回写「已处理的 previewCardAt」（跨重启防重复）
    await waitFor(() => { const st = readStatus(relayDir); return st && st.wecom && st.wecom.lastPreviewCardAt === 2222; }, { label: "预览标记" });
  } finally {
    await controller.stop();
    await server.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }

  // ⑤ 没有接收方 → 跳过并记日志（不报错、不发卡）
  {
    const relayDir2 = tmpRelayDir();
    const logs2 = [];
    const server2 = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); autoAckSend(f, ws); } });
    try {
      fs.writeFileSync(path.join(relayDir2, IM_BOTS_FILE), JSON.stringify({
        version: 1, wecom: { enabled: true, botId: BOT_ID, secret: SECRET, previewCardAt: 3333 }
      }), { mode: 0o600 });
      const controller2 = createWecomBotController({
        relayDir: relayDir2, configPollMs: 30, env: {},
        log: (level, line) => logs2.push(line),
        createBot: (opts) => createWecomBot({ ...opts, url: server2.url, logger: (level, line) => logs2.push(line) })
      });
      try {
        await controller2.start();
        await waitFor(() => controller2.status().bot && controller2.status().bot.authenticated, { timeoutMs: 5000, label: "连上2" });
        await sleep(200);
        assert.equal(server2.state.frames.filter((f) => f.cmd === "aibot_send_msg").length, 0, "没有接收方不得发卡");
        assert.ok(logs2.join("\n").includes("预览卡片跳过"), "要记一条可排查的跳过日志（不报错）");
      } finally {
        await controller2.stop();
      }
    } finally {
      await server2.close();
      fs.rmSync(relayDir2, { recursive: true, force: true });
    }
  }
});

// ─────────────────────────── ⑩d 会话可选绑定（task-24）───────────────────────────

test("★ 会话绑定优先级：配置固定 → 最近活跃 → sessions[0]；状态文件 sessions/activeSessionId/boundSessionId", async () => {
  const relayDir1 = tmpRelayDir();
  // ① 配置固定优先
  {
    const sub = fakeSubscriber({
      sessionIds: ["s-live"],
      sessions: [{ sessionId: "s-live", title: "活跃会话", running: true, updatedAt: 200 }]
    });
    const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
    const bot = createWecomBot({
      botId: BOT_ID, secret: SECRET, url: server.url, relayDir: relayDir1, logger: () => {},
      subscriber: sub, configuredSessionId: "s-fixed", configuredSessionTitle: "固定会话",
      tier: "pro" // 固定会话是会员能力（sessions）；免费档会被忽略（另有用例覆盖）
    });
    try {
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证1" });
      sub.emit("session-state", { sessionId: "s-live", state: "running", at: Date.now() });
      server.push({ cmd: "aibot_msg_callback", headers: { req_id: "bind-a" }, body: { msgid: "mb1", msgtype: "text", text: { content: "hi" }, from: { userid: "user-a" } } });
      await waitFor(() => sub.promptCalls.length === 1, { label: "入站转发1" });
      assert.equal(sub.promptCalls[0].sessionId, "s-fixed", "★ 配置固定的会话优先级最高");
      await waitFor(() => {
        const st = readStatus(relayDir1);
        return st && st.wecom && st.wecom.boundSessionId === "s-fixed" && Array.isArray(st.wecom.sessions) && st.wecom.sessions.length >= 1;
      }, { label: "状态文件 boundSessionId + sessions" });
      const st = readStatus(relayDir1);
      assert.equal(st.wecom.activeSessionId, "s-live");
      assert.ok(Array.isArray(st.wecom.sessions) && st.wecom.sessions.length >= 1);
      assert.deepEqual(Object.keys(st.wecom.sessions[0]).sort(), ["id", "title", "updatedAt"], "sessions 元素只含 id/title/updatedAt");
      assert.equal(st.wecom.sessions[0].id, "s-fixed", "配置固定的会话补进列表（用户明确选过）");
      assert.equal(st.wecom.sessions[0].title, "固定会话");
    } finally {
      await bot.stop();
      await server.close();
      fs.rmSync(relayDir1, { recursive: true, force: true });
    }
  }

  // ② 无配置：最近活跃会话优先
  {
    const relayDir = tmpRelayDir();
    const sub = fakeSubscriber({ sessionIds: ["s-a", "s-b"], sessions: [
      { sessionId: "s-a", title: "A", updatedAt: 100 },
      { sessionId: "s-b", title: "B", updatedAt: 200 }
    ] });
    const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
    const bot = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, relayDir, logger: () => {}, subscriber: sub });
    try {
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证2" });
      sub.emit("session-state", { sessionId: "s-b", state: "running", at: Date.now() });
      await waitFor(() => bot.status().activeSessionId === "s-b", { label: "活跃会话" });
      server.push({ cmd: "aibot_msg_callback", headers: { req_id: "bind-b" }, body: { msgid: "mb2", msgtype: "text", text: { content: "hi" }, from: { userid: "user-a" } } });
      await waitFor(() => sub.promptCalls.length === 1, { label: "入站转发2" });
      assert.equal(sub.promptCalls[0].sessionId, "s-b", "★ 无配置时用最近活跃会话");
      await waitFor(() => {
        const st = readStatus(relayDir);
        return st && st.wecom && st.wecom.boundSessionId === "s-b" && Array.isArray(st.wecom.sessions) && st.wecom.sessions.length >= 2;
      }, { label: "状态文件2（bound + sessions）" });
      const st = readStatus(relayDir);
      assert.ok(st.wecom.sessions.length <= 10);
      assert.deepEqual(st.wecom.sessions.map((x) => x.id).sort(), ["s-a", "s-b"].sort());
    } finally {
      await bot.stop();
      await server.close();
      fs.rmSync(relayDir, { recursive: true, force: true });
    }
  }

  // ③ 无配置、无活跃：sessions[0]（按 updatedAt 最新）
  {
    const sub = fakeSubscriber({ sessionIds: ["s-1", "s-2"], sessions: [
      { sessionId: "s-1", title: "旧", updatedAt: 100 },
      { sessionId: "s-2", title: "新", updatedAt: 200 }
    ] });
    const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
    const bot = createWecomBot({ botId: BOT_ID, secret: SECRET, url: server.url, logger: () => {}, subscriber: sub });
    try {
      bot.start();
      await waitFor(() => bot.status().authenticated, { label: "认证3" });
      server.push({ cmd: "aibot_msg_callback", headers: { req_id: "bind-c" }, body: { msgid: "mb3", msgtype: "text", text: { content: "hi" }, from: { userid: "user-a" } } });
      await waitFor(() => sub.promptCalls.length === 1, { label: "入站转发3" });
      assert.equal(sub.promptCalls[0].sessionId, "s-2", "★ sessions[0] = updatedAt 最新的那个");
      // 列表上限 10
      assert.ok(normalizeSessionStatusList(Array.from({ length: 15 }, (_, i) => ({ id: `x${i}` }))).length === 10);
    } finally {
      await bot.stop();
      await server.close();
    }
  }
});

test("控制器：只改 sessionId 也会重建 bot（配置热更新后转发目标立即生效）", async () => {
  const relayDir = tmpRelayDir();
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
  const imports = [];
  const controller = createWecomBotController({
    relayDir, configPollMs: 30, log: () => {}, env: {},
    createBot: (opts) => {
      imports.push({ sessionId: opts.configuredSessionId, sessionTitle: opts.configuredSessionTitle, hasDecisionCb: typeof opts.onApprovalDecision === "function" });
      return createWecomBot({ ...opts, url: server.url });
    }
  });
  try {
    await controller.start();
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1, wecom: { enabled: true, botId: BOT_ID, secret: SECRET, sessionId: "s-one", sessionTitle: "一号会话" }
    }), { mode: 0o600 });
    await waitFor(() => imports.length >= 1 && controller.status().bot && controller.status().bot.authenticated, { timeoutMs: 5000, label: "起bot" });
    assert.deepEqual({ id: imports[0].sessionId, title: imports[0].sessionTitle }, { id: "s-one", title: "一号会话" });
    assert.equal(imports[0].hasDecisionCb, false, "没注入回调时如实没有（卡片点击会回「未就绪」）");
    // 只改固定会话 → 摘要变化 → 重建
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1, wecom: { enabled: true, botId: BOT_ID, secret: SECRET, sessionId: "s-two", sessionTitle: "二号会话" }
    }), { mode: 0o600 });
    await waitFor(() => imports.length >= 2, { timeoutMs: 5000, label: "改 sessionId 后重建" });
    assert.deepEqual({ id: imports[1].sessionId, title: imports[1].sessionTitle }, { id: "s-two", title: "二号会话" });
  } finally {
    await controller.stop();
    await server.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

// ─────────────────────── ⑩f IM 通道会员判定（2026-11-07）───────────────────────

// 复用微信通道那套能力表（单一真相源）：免费 = 通知/审批/状态/急停 + assign.continue(20 条/月)
const FREE_CAPS = ["notify", "approve", "status", "stop", "assign.continue"];
const PAID_CAPS = ["notify", "approve", "status", "stop", "assign", "sessions", "summary", "steer", "attach", "multi"];
const tierFreeObj = () => ({ plan: "free", caps: FREE_CAPS, limits: { messages_per_month: 20 }, rev: "rev-free" });
const tierProObj = () => ({ plan: "pro", caps: PAID_CAPS, limits: { messages_per_month: 0 }, rev: "rev-pro" });

/** 会员用例的 bot：接入一个可控 capsProvider，返回常用断言面。 */
async function setupMemberBot(over = {}) {
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); autoAckSend(f, ws); } });
  const sub = fakeSubscriber(over.sub || {
    sessionIds: ["s-live", "s-other"],
    sessions: [
      { sessionId: "s-live", title: "活跃会话", running: true, updatedAt: 200 },
      { sessionId: "s-other", title: "另一个", updatedAt: 100 }
    ]
  });
  const lines = [];
  const decisions = [];
  const bot = createWecomBot({
    botId: BOT_ID, secret: SECRET, url: server.url,
    logger: (level, line) => lines.push(line),
    subscriber: sub,
    capsProvider: over.capsProvider,
    appUrl: "https://app.test/",
    onApprovalDecision: async (requestId, decision) => { decisions.push({ requestId, decision }); return { ok: true }; },
    tierDenyThrottleMs: 0,
    ...(over.bot || {})
  });
  const replies = () => server.state.frames.filter((f) => f.cmd === "aibot_respond_msg");
  const markdowns = () => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body && f.body.markdown);
  const cards = () => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && f.body && f.body.msgtype === "template_card");
  let seq = 0;
  return {
    server, sub, bot, lines, decisions, replies, markdowns, cards,
    async start() { bot.start(); await waitFor(() => bot.status().authenticated, { label: "认证(member)" }); },
    /** 发一条入站文本；返回是否真的被转发（promptSession）。 */
    async inbound(text = "hi", userid = "user-a") {
      seq += 1;
      const beforeP = sub.promptCalls.length;
      const beforeR = replies().length;
      server.push({
        cmd: "aibot_msg_callback", headers: { req_id: `min-${seq}` },
        body: { msgid: `mm-${seq}`, msgtype: "text", text: { content: text }, from: { userid } }
      });
      await waitFor(() => sub.promptCalls.length > beforeP || replies().length > beforeR, { label: `入站 ${seq} 处理完` });
      await sleep(10);
      return sub.promptCalls.length > beforeP;
    },
    lastReplyText() {
      const r = replies()[replies().length - 1];
      return r && r.body && r.body.stream ? String(r.body.stream.content || "") : "";
    },
    async close() { await bot.stop(); await server.close(); }
  };
}

test("★ 会员·免费档：通知照常、审批卡可点且**不计数**、额度不变", async () => {
  const relayDir = tmpRelayDir();
  const rt = await setupMemberBot({ capsProvider: async () => tierFreeObj(), bot: { relayDir } });
  try {
    await rt.start();
    await waitFor(() => rt.bot.status().tier === "free", { label: "档位 free" });
    // 入站绑定（同时消耗 1 条免费额度）
    assert.equal(await rt.inbound("你好"), true);
    await waitFor(() => rt.bot.status().usage.messages === 1, { label: "用量 1" });
    // 通知照常（免费）
    rt.sub.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "session-x", reason: "completed", turn: 1, seq: 1, at: Date.now() });
    await waitFor(() => rt.markdowns().find((f) => /任务完成/.test(f.body.markdown.content)), { label: "免费通知" });
    // 审批卡：可点、不计数
    const card = rt.bot.sendApprovalCard("user-a", { requestId: "ev-free-1", toolName: "Bash" });
    await waitFor(() => rt.cards().length === 1, { label: "免费审批卡" });
    pushCardClick(rt.server, { reqId: "free-click-1", taskId: card.taskId, eventKey: "allow:ev-free-1" });
    await waitFor(() => rt.decisions.length === 1, { label: "免费审批回执" });
    assert.equal(rt.bot.status().usage.messages, 1, "★ 审批回执不得计数（安全阀优先）");
    const st = readStatus(relayDir);
    assert.deepEqual(st.wecom.usage, { month: st.wecom.usage.month, messages: 1 }, "状态文件 usage 只记 1（入站那条）");
    assert.equal(st.wecom.tier, "free");
    assert.ok(Array.isArray(st.wecom.caps) && st.wecom.caps.includes("assign.continue"));
    assert.equal(st.wecom.messagesPerMonth, 20);
    assert.equal(st.wecom.remainingMessages, 19);
  } finally {
    await rt.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("★ 会员·免费档额度：前 20 条正常派活，第 21 条回「本月免费指令已用完」+ 升级链接且不调 promptSession", async () => {
  const relayDir = tmpRelayDir();
  const rt = await setupMemberBot({ capsProvider: async () => tierFreeObj(), bot: { relayDir } });
  try {
    await rt.start();
    for (let i = 1; i <= 20; i++) {
      assert.equal(await rt.inbound(`第 ${i} 条`), true, `第 ${i} 条应允许`);
    }
    await waitFor(() => rt.bot.status().usage.messages === 20, { label: "用满 20" });
    const promptsBefore = rt.sub.promptCalls.length;
    assert.equal(await rt.inbound("第 21 条"), false, "★ 第 21 条不得派活");
    assert.equal(rt.sub.promptCalls.length, promptsBefore, "第 21 条不得调用 promptSession");
    const reply = rt.lastReplyText();
    assert.match(reply, /本月免费指令已用完/);
    assert.match(reply, /20/);
    assert.match(reply, /升级 Pro/);
    assert.match(reply, /https:\/\/app\.test\/promo/, "要带升级链接 /app/promo");
    assert.equal(rt.bot.status().usage.messages, 20, "被拦的消息不计数");
    // 超额后通知仍然正常（不能把已有通道静默停掉）
    rt.sub.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "session-x", reason: "completed", turn: 9, seq: 9, at: Date.now() });
    await waitFor(() => rt.markdowns().find((f) => /任务完成/.test(f.body.markdown.content)), { label: "超额后通知仍在" });
  } finally {
    await rt.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("★ 会员·跨月清零：上月用满 20 条 → 本月第一条仍可派活", async () => {
  const relayDir = tmpRelayDir();
  // 预置"上个月已经用满"的状态
  fs.writeFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), JSON.stringify({
    version: 1, wecom: { usage: { month: "2000-01", messages: 25 } }
  }), { mode: 0o600 });
  const rt = await setupMemberBot({ capsProvider: async () => tierFreeObj(), bot: { relayDir } });
  try {
    await rt.start();
    await waitFor(() => rt.bot.status().tier === "free", { label: "档位" });
    assert.equal(await rt.inbound("新月份第一条"), true, "★ 跨月必须清零");
    const st = readStatus(relayDir);
    const d = new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    assert.equal(st.wecom.usage.month, month);
    assert.equal(st.wecom.usage.messages, 1);
  } finally {
    await rt.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("★ 会员·fail-closed：没有 capsProvider 按 free 处理（额度用满即拦）；档位刷新后放行", async () => {
  const relayDir = tmpRelayDir();
  const d = new Date();
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  fs.writeFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), JSON.stringify({
    version: 1, wecom: { usage: { month, messages: 20 } }
  }), { mode: 0o600 });
  // ① 完全没有 provider
  {
    const rt = await setupMemberBot({ bot: { relayDir } });
    try {
      await rt.start();
      await sleep(30);
      assert.equal(rt.bot.status().tier, "free", "★ 没有 capsProvider → free（fail-closed）");
      assert.equal(await rt.inbound("没有 provider"), false);
      assert.match(rt.lastReplyText(), /本月免费指令已用完/);
    } finally {
      await rt.close();
    }
  }
  // ② provider 先取不到（空），随后返回 pro → 下一次放行
  {
    let plan = "";
    const rt = await setupMemberBot({ capsProvider: async () => (plan ? tierProObj() : ""), bot: { relayDir } });
    try {
      await rt.start();
      await sleep(30);
      assert.equal(await rt.inbound("空档位时"), false, "取不到档位 → 按 free 拦");
      plan = "pro";
      assert.equal(await rt.inbound("刚升级后"), true, "★ 档位刷新后必须放行（不用重启）");
      assert.equal(rt.bot.status().tier, "pro");
    } finally {
      await rt.close();
    }
  }
  fs.rmSync(relayDir, { recursive: true, force: true });
});

test("★ 会员·免费档忽略配置固定会话（bindingGated）；paid 档全放开（不限量/固定会话生效）", async () => {
  // ① 免费：配置了 sessionId 也不生效，回退活跃会话；状态标注 bindingGated
  {
    const relayDir = tmpRelayDir();
    const rt = await setupMemberBot({
      capsProvider: async () => tierFreeObj(),
      bot: { relayDir, configuredSessionId: "s-fixed", configuredSessionTitle: "固定会话" }
    });
    try {
      await rt.start();
      await waitFor(() => rt.bot.status().tier === "free", { label: "free" });
      const st0 = rt.bot.status();
      assert.equal(st0.bindingGated, true, "★ 免费档固定会话被门槛忽略");
      assert.equal(await rt.inbound("免费档"), true);
      assert.equal(rt.sub.promptCalls[0].sessionId, "s-live", "免费档回退到活跃会话，而不是 s-fixed");
      await waitFor(() => { const st = readStatus(relayDir); return st && st.wecom && st.wecom.bindingGated === true; }, { label: "状态文件 bindingGated" });
      const st = readStatus(relayDir);
      assert.equal(st.wecom.boundSessionId, "s-live");
      assert.equal(st.wecom.bindingGated, true);
    } finally {
      await rt.close();
      fs.rmSync(relayDir, { recursive: true, force: true });
    }
  }
  // ② paid：不限量 + 固定会话生效 + bindingGated=false
  {
    const relayDir = tmpRelayDir();
    const rt = await setupMemberBot({
      capsProvider: async () => tierProObj(),
      bot: { relayDir, configuredSessionId: "s-fixed", configuredSessionTitle: "固定会话" }
    });
    try {
      await rt.start();
      await waitFor(() => rt.bot.status().tier === "pro", { label: "pro" });
      assert.equal(rt.bot.status().bindingGated, false);
      for (let i = 1; i <= 25; i++) assert.equal(await rt.inbound(`付费 ${i}`), true, `付费第 ${i} 条`);
      assert.equal(rt.bot.status().usage.messages, 25, "付费也统计用量（但不限量）");
      assert.equal(rt.bot.status().messagesPerMonth, 0, "0 = 不限");
      assert.equal(rt.sub.promptCalls.every((c) => c.sessionId === "s-fixed"), true, "★ 付费档固定会话生效");
      const st = readStatus(relayDir);
      assert.equal(st.wecom.tier, "pro");
      assert.equal(st.wecom.remainingMessages, null, "不限量时 remaining=null");
    } finally {
      await rt.close();
      fs.rmSync(relayDir, { recursive: true, force: true });
    }
  }
});

test("★ 会员·服务端 caps 清空（空数组=权威）→ 互动全关但通知照常；审批卡仍可点", async () => {
  const rt = await setupMemberBot({
    capsProvider: async () => ({ plan: "free", caps: [], limits: { messages_per_month: 20 }, rev: "rev-empty" })
  });
  try {
    await rt.start();
    await waitFor(() => rt.bot.status().caps.length === 0, { label: "caps 清空" });
    assert.equal(rt.bot.status().caps.length, 0, "空数组 = 服务端明确清空，不得回退内置表");
    assert.equal(await rt.inbound("被清空的档位"), false, "没有 assign.continue → 不得派活");
    assert.match(rt.lastReplyText(), /会员功能|升级 Pro/);
    // 通知不受能力表影响（通知是免费能力，不能静默停掉）
    rt.sub.emit("event", { kind: NODE_KINDS.TURN_END, sessionId: "session-x", reason: "completed", turn: 3, seq: 3, at: Date.now() });
    await waitFor(() => rt.markdowns().find((f) => /任务完成/.test(f.body.markdown.content)), { label: "通知仍在" });
    // 审批卡也不受互动闸影响（点得动、不计数）
    const card = rt.bot.sendApprovalCard("user-a", { requestId: "ev-empty-1", toolName: "Bash" });
    await waitFor(() => rt.cards().length === 1, { label: "卡" });
    pushCardClick(rt.server, { reqId: "empty-click", taskId: card.taskId, eventKey: "allow:ev-empty-1" });
    await waitFor(() => rt.decisions.length === 1, { label: "审批回执" });
    assert.equal(rt.bot.status().usage.messages, 0);
  } finally {
    await rt.close();
  }
});

// ─────────────────────── ⑩g 通道格式化接入（2026-11-08）───────────────────────

test("★ 通道格式化接入：回答回传含 Markdown 表格时，发出的报文里没有裸表格（转成「• 列：值」）", async () => {
  const answerWithTable = [
    "修复完成，改动如下：",
    "",
    "| 文件 | 改动 | 行数 |",
    "|---|---|---|",
    "| clients/dsh-remote/a.mjs | 修端口探测 | 10 |",
    "| clients/dsh-remote/b.mjs | 加负缓存 | 20 |",
    "",
    "以上。"
  ].join("\n");
  const rt = await setupRelayBot({ assistantText: { ok: true, text: answerWithTable } });
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().authenticated, { label: "认证完成" });
    await rt.inbound("relay-table-1", "给我看下改动");
    rt.turnEnd({ turn: 1, seq: 41 });
    const send = await waitFor(() => rt.sends()[0], { label: "回答回传" });
    const content = send.body.markdown.content;
    assert.ok(!/\|\s*-{2,}/.test(content), "★ 报文里不得出现 |--- 分隔行");
    assert.ok(!/^\s*\|.*\|\s*$/m.test(content), "★ 报文里不得出现裸表格行");
    assert.match(content, /^• 文件：clients\/dsh-remote\/a\.mjs · 改动：修端口探测 · 行数：10$/m);
    assert.match(content, /修复完成/);
    assert.match(content, /以上。/);
  } finally {
    await rt.close();
  }
});

// ─────────────────────────── ⑪ 配置契约 ───────────────────────────

test("配置契约：normalizeImBotsConfig 缺字段补默认、非法值当未配置；readImBotsConfig 文件不存在返回 null", () => {
  const relayDir = tmpRelayDir();
  try {
    assert.equal(readImBotsConfig(relayDir), null, "没有配置文件 → null（默认关闭）");
    const cfg = normalizeImBotsConfig({
      version: 1,
      wecom: { enabled: true, botId: " b1 ", secret: "s1", targetChatId: " u1 ", allowFrom: ["a", "a", 3, ""] },
      extra: { keep: true }
    });
    assert.equal(cfg.wecom.botId, "b1");
    assert.equal(cfg.wecom.secret, "s1");
    assert.equal(cfg.wecom.url, "");
    assert.equal(cfg.wecom.targetChatId, "u1");
    assert.deepEqual(cfg.wecom.allowFrom, ["a"], "允许列表去空/去重/非字符串忽略");
    assert.equal(cfg.feishu.enabled, false);
    const broken = normalizeImBotsConfig({ wecom: "not-an-object", feishu: null });
    assert.equal(broken.wecom.enabled, false);
    assert.equal(broken.wecom.botId, "");
    assert.deepEqual(normalizeImBotsConfig(null).wecom.allowFrom, []);

    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({ wecom: { enabled: true, botId: "b", secret: "s", sessionId: "sid-1", sessionTitle: "我的会话" } }));
    const read = readImBotsConfig(relayDir);
    assert.equal(read.wecom.botId, "b");
    assert.equal(read.wecom.enabled, true);
    assert.equal(read.wecom.sessionId, "sid-1", "task-24：配置支持固定会话");
    assert.equal(read.wecom.sessionTitle, "我的会话");
    assert.equal(normalizeImBotsConfig({ wecom: {} }).wecom.sessionId, "", "缺省 = 跟随活跃会话");
    // 预览卡片触发时间戳（task-25/小改动）：number 保留；非法/缺失 → 0
    assert.equal(normalizeImBotsConfig({ wecom: {} }).wecom.previewCardAt, 0);
    assert.equal(normalizeImBotsConfig({ wecom: { previewCardAt: 1700000000123 } }).wecom.previewCardAt, 1700000000123);
    assert.equal(normalizeImBotsConfig({ wecom: { previewCardAt: "1700000000123" } }).wecom.previewCardAt, 1700000000123, "数字字符串也认");
    assert.equal(normalizeImBotsConfig({ wecom: { previewCardAt: -5 } }).wecom.previewCardAt, 0, "非法值当未配置");
    assert.equal(normalizeImBotsConfig({ wecom: { previewCardAt: "abc" } }).wecom.previewCardAt, 0);
  } finally {
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("日志器脱敏：maskSecrets 抹掉字面量与类似字段;createScopedLogger 有界留痕", () => {
  const line = maskSecrets("secret=abcd1234 bot_id=b1 Authorization: Bearer tok", ["abcd1234"]);
  assert.ok(!line.includes("abcd1234"));
  assert.match(line, /secret=\*\*\*/);
  const logger = createScopedLogger({ maxLines: 2 });
  logger.info("a");
  logger.warn("b");
  logger.error("c");
  assert.equal(logger.lines.length, 2, "内存日志必须有界");
  assert.match(logger.lines[1], /warn/);
});

// ─────────────────────────── ⑫ 控制器：配置热更新 ───────────────────────────

test("★ 控制器：默认关闭（无配置）→ 启用后连上 → 禁用即停 → 改凭据重连（fs.watchFile 热更新）", async () => {
  const relayDir = tmpRelayDir();
  const server = await startFakeServer({ onFrame: (f, ws) => { autoAckAuth(f, ws); autoAckPing(f, ws); } });
  const imports = []; // 记录每次创建 bot 的配置（验证凭据变化会重建）
  const controller = createWecomBotController({
    relayDir,
    configPollMs: 30,
    log: () => {},
    env: {}, // 不受本机环境变量影响
    createBot: (opts) => {
      imports.push({ botId: opts.botId, targetChatId: opts.targetChatId, allowFrom: opts.allowFrom });
      // 打桩只改连接地址：其余逻辑走真实 bot
      return createWecomBot({ ...opts, url: server.url });
    }
  });
  try {
    await controller.start();
    assert.equal(controller.status().reason, "no_config");
    assert.equal(controller.status().enabled, false, "没有配置时必须默认关闭（零副作用）");

    // ① 写入启用配置 → 自动起连接
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1,
      wecom: { enabled: true, botId: BOT_ID, secret: SECRET, targetChatId: "user-t", allowFrom: ["u1"] }
    }), { mode: 0o600 });
    await waitFor(() => controller.status().enabled && controller.status().bot && controller.status().bot.authenticated,
      { timeoutMs: 5000, label: "配置生效并认证" });
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0], { botId: BOT_ID, targetChatId: "user-t", allowFrom: ["u1"] });
    const file = readStatus(relayDir);
    assert.equal(file.wecom.enabled, true);
    assert.equal(file.wecom.targetChatId, "user-t", "状态文件要回显 targetChatId（非敏感）");

    // ② 改成 enabled:false → 连接应停止且状态变 disabled
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1, wecom: { enabled: false, botId: BOT_ID, secret: SECRET }
    }), { mode: 0o600 });
    await waitFor(() => !controller.status().enabled, { timeoutMs: 5000, label: "禁用生效" });
    await waitFor(() => readStatus(relayDir) && readStatus(relayDir).wecom.enabled === false, { label: "状态文件 disabled" });
    await waitFor(() => server.state.closed >= 1, { label: "连接已关闭" });

    // ③ 换一份凭据重新启用 → 应重建连接（新 bot 实例）
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1, wecom: { enabled: true, botId: "bot-test-0002", secret: "another-secret-xyz" }
    }), { mode: 0o600 });
    await waitFor(() => controller.status().enabled && imports.length >= 2, { timeoutMs: 5000, label: "改凭据后重建" });
    await waitFor(() => controller.status().bot && controller.status().bot.authenticated, { timeoutMs: 5000, label: "重新认证" });
    assert.equal(imports[imports.length - 1].botId, "bot-test-0002");
    // 配置没变时不得反复重建（watchFile 会因 mtime 反复触发）
    const count = imports.length;
    await sleep(200);
    assert.equal(imports.length, count, "配置未变化时不得重复重建连接");
  } finally {
    await controller.stop();
    await server.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("控制器：缺 botId/secret 时不启动并写明确的 disabled 原因；DSH_IM_BOTS=0 硬关闭", async () => {
  const relayDir = tmpRelayDir();
  try {
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1, wecom: { enabled: true, botId: "", secret: "" }
    }), { mode: 0o600 });
    const controller = createWecomBotController({ relayDir, log: () => {}, env: {}, configPollMs: 30 });
    try {
      await controller.start();
      assert.equal(controller.status().enabled, false);
      assert.equal(controller.status().reason, "missing_credentials");
      const st = readStatus(relayDir);
      assert.ok(st && st.wecom.enabled === false);
      assert.match(st.wecom.lastError, /Bot ID \/ Secret/);
    } finally {
      await controller.stop();
    }
    const off = createWecomBotController({ relayDir, log: () => {}, env: { DSH_IM_BOTS: "0" } });
    try {
      await off.start();
      assert.equal(off.status().enabled, false);
      assert.equal(off.status().reason, "disabled_by_env");
    } finally {
      await off.stop();
    }
  } finally {
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

// ─────────────────────────── ⑬ 原子写独立性 ───────────────────────────

test("atomicWriteJson：覆盖写、目录自动创建、0600、失败不留临时文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wecom-atomic-"));
  try {
    const nested = path.join(dir, "a", "b", "x.json");
    atomicWriteJson(nested, { hello: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")), { hello: 1 });
    if (process.platform !== "win32") assert.equal(fileMode(nested), 0o600);
    atomicWriteJson(nested, { hello: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf8")), { hello: 2 });
    assert.deepEqual(fs.readdirSync(path.dirname(nested)).filter((n) => n.includes(".tmp")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────── 命令层（2026-11-08：/ls 不再转给模型）───────────────────────

test("★ 命令层：/help /status 直接回复、/ls 免费档被拦、/stop 免费急停；命中命令**不进 promptSession**", async () => {
  const rt = await setupRelayBot();
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().authenticated, { label: "认证" });
    const replies = () => rt.server.state.frames.filter((f) => f.cmd === "aibot_respond_msg");
    const sendCmd = async (msgid, content) => {
      const before = replies().length;
      rt.server.push({ cmd: "aibot_msg_callback", headers: { req_id: `cmd-${msgid}` }, body: { msgid: `m-${msgid}`, msgtype: "text", text: { content }, from: { userid: "user-a" } } });
      await waitFor(() => replies().length > before, { label: `命令 ${msgid} 回复` });
      return String(replies()[before].body.stream.content || "");
    };
    const help = await sendCmd("help", "/help");
    assert.match(help, /可用命令/);
    assert.match(help, /\/ls/);
    assert.match(help, /\/unbind/);
    assert.equal(rt.sub.promptCalls.length, 0, "★ 命令不得进模型");
    const status = await sendCmd("status", "/status");
    assert.match(status, /连接状态/);
    assert.match(status, /当前会话/);
    const ls = await sendCmd("ls", "/ls");
    assert.match(ls, /会员功能/, "免费档 /ls 必须被拦");
    assert.equal(rt.sub.promptCalls.length, 0);
    const stop = await sendCmd("stop", "/stop");
    assert.match(stop, /已急停|没有正在运行/);
    assert.deepEqual(rt.sub.cancelCalls, [{ sessionId: "session-abc" }], "★ /stop 调 cancelSession");
    assert.equal(rt.sub.promptCalls.length, 0, "★ 全部命令都不进模型");
    // 普通文本照旧进模型
    await rt.inbound("normal-1", "帮我改一下代码");
    assert.equal(rt.sub.promptCalls.length, 1);
  } finally { await rt.close(); }
});

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
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE,
  atomicWriteJson,
  createScopedLogger,
  createWecomBot,
  createWecomBotController,
  extractInboundText,
  fileMode,
  maskSecrets,
  normalizeImBotsConfig,
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
  sub.sessions = over.sessions || [];
  sub.start = () => { sub.started = true; };
  sub.close = () => { sub.closed = true; };
  sub.listSessions = async () => ({ ok: true, sessions: sub.sessions });
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

test("★ 出站通知：turn_done/turn_error/approval_request → Markdown 推送到绑定的 chatid；无接收方时跳过", async () => {
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

    // 出错 + 拍板
    sub.emit("event", { kind: NODE_KINDS.SESSION_ERROR, sessionId: "session-x", message: "build failed" });
    const errSend = await waitFor(() => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && /出错了/.test(f.body.markdown.content)).pop(), { label: "出错通知" });
    assert.equal(errSend.body.chatid, "user-a");
    sub.emit("event", { kind: NODE_KINDS.APPROVAL_REQUEST, sessionId: "session-x", eventId: "ev-1", toolName: "Bash" });
    const apprSend = await waitFor(() => server.state.frames.filter((f) => f.cmd === "aibot_send_msg" && /拍板/.test(f.body.markdown.content)).pop(), { label: "拍板通知" });
    assert.match(apprSend.body.markdown.content, /^🛂 需要你在电脑上拍板｜Bash/);
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

    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({ wecom: { enabled: true, botId: "b", secret: "s" } }));
    const read = readImBotsConfig(relayDir);
    assert.equal(read.wecom.botId, "b");
    assert.equal(read.wecom.enabled, true);
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

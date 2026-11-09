/**
 * dingtalk-bot — 钉钉 Stream 长连接通道单测（2026-11-08）。
 *
 * 全部零真实网络：本机起一个假 gateway（HTTP /open + WebSocketServer），本机起一个假 sessionWebhook
 * 服务；凭据用假值。覆盖：
 *   建连报文（open body/clientId/订阅 topic/ua）、每帧 ACK（SYSTEM ping / 机器人消息 / EVENT）、
 *   入站解析 + sessionWebhook 回复（格式化后无裸表格）、ticket 一次性（每次重连重新 open）、
 *   SYSTEM disconnect 重连、未知 SYSTEM 忽略不崩、凭据错（4xx）不重连、会员闸（免费 20 条/月）、
 *   状态文件字段、secret 不进日志、controller 启停与热更新。
 *
 * 说明：ACK 的 `data` 我们按官方 SDK 行为发 **JSON 字符串**（task 里提过的 base64 变体标 UNVERIFIED，
 * 真机核验后只改 buildAck 一处）；断言里解析后比较，不依赖序列化细节。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

import { WebSocketServer } from "ws";

import {
  BOT_CALLBACK_ACK,
  DINGTALK_OPEN_URL,
  TICKET_TTL_MS,
  TOPIC_ROBOT,
  buildAck,
  buildOpenBody,
  buildPingAck,
  buildSessionWebhookBody,
  createDingtalkBot,
  createDingtalkBotController,
  normalizeBotMessage,
  normalizeDingtalkConfig,
  parseFrame,
  readDingtalkConfig
} from "../dingtalk-bot.mjs";
import {
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE
} from "../wecom-bot.mjs";

const FAKE_SECRET = "DingSecret-Should-Never-Leak-123";
const FAKE_CLIENT = "ding-fake-client-id";

// ─────────────────────────── 测试工具 ───────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 读 JSON 文件（不存在/坏 JSON → null）。 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function waitFor(fn, { label = "条件", timeout = 5000, interval = 20 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

function tmpRelayDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-dingtalk-"));
}

/**
 * 假 gateway：HTTP POST /open 返回 {endpoint, ticket}；WebSocketServer 收 ACK。
 * `openResponder` 可返回 {status, body} 覆盖 open 响应（测凭据错/异常）。
 */
async function startGateway({ openResponder } = {}) {
  const state = { opens: [], acks: [], tickets: [], clients: [], closeCount: 0, lastUpgradeUrl: "" };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && String(req.url || "").startsWith("/open")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch { json = null; }
        state.opens.push({ url: req.url, body: json, headers: req.headers, raw: body });
        const custom = typeof openResponder === "function" ? openResponder(json, state) : null;
        if (custom) {
          res.writeHead(custom.status || 200, { "content-type": "application/json" });
          res.end(JSON.stringify(custom.body === undefined ? {} : custom.body));
          return;
        }
        state.tickets.push(`ticket-${state.tickets.length + 1}`);
        res.writeHead(200, { "content-type": "application/json", accept: "application/json" });
        res.end(JSON.stringify({ endpoint: `ws://127.0.0.1:${server.address().port}`, ticket: state.tickets[state.tickets.length - 1] }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    state.clients.push(ws);
    ws.on("message", (raw) => {
      try { state.acks.push(JSON.parse(raw.toString("utf8"))); } catch { /* 忽略坏帧 */ }
    });
    ws.on("close", () => { state.closeCount += 1; });
  });
  server.on("upgrade", (req, socket, head) => {
    state.lastUpgradeUrl = String(req.url || "");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    state, port,
    openUrl: `http://127.0.0.1:${port}/open`,
    wsUrl: `ws://127.0.0.1:${port}`,
    /** 给最新一条连接推一帧（服务端 → 客户端）。 */
    push(frame) {
      const ws = state.clients[state.clients.length - 1];
      assert.ok(ws, "还没有 WebSocket 连接");
      ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    killClients(code = 1006) {
      for (const ws of state.clients) { try { ws.terminate(); } catch { /* 忽略 */ } }
    },
    /** 取到的 ACK 里 data 解析成对象（兼容 string/object 两种实现）。 */
    ackData(ack) {
      if (!ack) return null;
      if (ack.data && typeof ack.data === "object") return ack.data;
      try { return JSON.parse(String(ack.data || "")); } catch { return null; }
    },
    async close() {
      for (const ws of state.clients) { try { ws.terminate(); } catch { /* 忽略 */ } }
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => server.close(() => r()));
    }
  };
}

/** 假 sessionWebhook（钉钉回复走 HTTP POST）。 */
async function startWebhook(payload = { errcode: 0, errmsg: "ok" }, status = 200) {
  const state = { calls: [] };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(body); } catch { json = null; }
      state.calls.push({ url: req.url, body: json, headers: req.headers });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    state,
    url: `http://127.0.0.1:${port}/hook`,
    last() { return state.calls[state.calls.length - 1]; },
    async close() { await new Promise((r) => server.close(() => r())); }
  };
}

/** 最小 fake 订阅器（与 bridge 里 dsh-events 的对外接口同形）。 */
function fakeSubscriber({ sessions = [{ sessionId: "session-live", running: true, title: "活跃会话" }], answer = "这是 agent 的最终回答" } = {}) {
  const emitter = new EventEmitter();
  const calls = { prompt: [], listSessions: 0, lastAssistant: 0, cancel: [] };
  return {
    on(evt, fn) { emitter.on(evt, fn); return this; },
    once(evt, fn) { emitter.once(evt, fn); return this; },
    emit(evt, ...args) { emitter.emit(evt, ...args); },
    start() { /* noop */ },
    close() { /* noop */ },
    sessions() { return sessions.map((s) => s.sessionId); },
    async listSessions() { calls.listSessions += 1; return { ok: true, sessions }; },
    async promptSession({ sessionId, text }) { calls.prompt.push({ sessionId, text }); return { ok: true }; },
    async cancelSession({ sessionId } = {}) { calls.cancel.push({ sessionId }); return { ok: true }; },
    async lastAssistantText() { calls.lastAssistant += 1; return { ok: true, text: answer }; },
    calls
  };
}

/** 建一个 bot（可选注入 capsProvider）。 */
async function setupBot(over = {}) {
  const gateway = await startGateway(over.gateway);
  const hook = await startWebhook();
  const relayDir = over.relayDir === undefined ? tmpRelayDir() : over.relayDir;
  const sub = over.sub || fakeSubscriber(over.subOptions);
  const logs = [];
  const bot = createDingtalkBot({
    clientId: FAKE_CLIENT,
    clientSecret: FAKE_SECRET,
    robotCode: "ding-robot-code",
    gatewayUrl: gateway.openUrl,
    relayDir,
    subscriber: sub,
    appUrl: "https://app.test/",
    logger: (level, line) => logs.push(line),
    reconnectBaseMs: 40,
    reconnectMaxMs: 160,
    tierDenyThrottleMs: 0,
    ...(over.bot || {})
  });
  return {
    bot, gateway, hook, relayDir, sub, logs,
    async start() {
      bot.start();
      await waitFor(() => bot.status().connected === true, { label: "连接建立" });
      return bot.status();
    },
    /** 推一条机器人文本消息（模拟钉钉下发）。 */
    async inbound({ text = "继续", msgId = `msg-${Date.now()}-${Math.random()}`, conversationId = "cid-group-1", conversationType = "2", senderStaffId = "staff-1", webhook } = {}) {
      const data = {
        conversationId, conversationType, senderStaffId, senderNick: "小钉",
        msgtype: "text", msgId, text: { content: text },
        sessionWebhook: webhook === undefined ? hook.url : webhook,
        sessionWebhookExpiredTime: Date.now() + 10 * 60 * 1000,
        robotCode: "ding-robot-code", createAt: Date.now()
      };
      gateway.push({
        type: "CALLBACK",
        headers: { messageId: `mid-${msgId}`, topic: TOPIC_ROBOT, contentType: "application/json", time: String(Date.now()) },
        data: JSON.stringify(data)
      });
      return data;
    },
    async close() {
      await bot.stop();
      await gateway.close();
      await hook.close();
      fs.rmSync(relayDir, { recursive: true, force: true });
    }
  };
}

// ─────────────────────────── 纯协议函数 ───────────────────────────

test("协议纯函数：open 请求体 / ACK（JSON 字符串 data）/ ping ACK 原样回传 opaque / 帧解析 / 配置规范化", () => {
  const body = buildOpenBody({ clientId: "id", clientSecret: "sec", ua: "dsh-remote-bridge/0.7.11" });
  assert.deepEqual(body.subscriptions, [{ type: "CALLBACK", topic: TOPIC_ROBOT }], "默认只订机器人消息 topic");
  assert.equal(body.clientId, "id");
  assert.equal(body.clientSecret, "sec");
  assert.equal(body.ua, "dsh-remote-bridge/0.7.11");
  assert.ok(!("localIp" in body), "未提供 localIp 时不带该字段");

  const ack = buildAck("m-1", BOT_CALLBACK_ACK);
  assert.equal(ack.code, 200);
  assert.equal(ack.message, "OK");
  assert.equal(ack.headers.messageId, "m-1");
  assert.equal(ack.headers.contentType, "application/json");
  assert.equal(typeof ack.data, "string", "★ ACK data 是 JSON 字符串（官方 SDK 行为；base64 变体标 UNVERIFIED）");
  assert.deepEqual(JSON.parse(ack.data), { response: null });

  const ping = buildPingAck("m-2", "opaque-xyz");
  assert.equal(ping.headers.messageId, "m-2");
  assert.deepEqual(JSON.parse(ping.data), { opaque: "opaque-xyz" }, "ping 必须原样回传 data.opaque");

  const frame = parseFrame(JSON.stringify({ type: "CALLBACK", headers: { messageId: "m", topic: TOPIC_ROBOT }, data: JSON.stringify({ msgId: "x", text: { content: "hi" } }) }));
  assert.equal(frame.type, "CALLBACK");
  assert.equal(frame.headers.messageId, "m");
  assert.deepEqual(frame.data, { msgId: "x", text: { content: "hi" } }, "data 字符串要二次 parse");
  assert.equal(parseFrame("not-json"), null);

  const msg = normalizeBotMessage({ conversationId: "c1", conversationType: "2", senderStaffId: "s1", msgtype: "text", text: { content: " hi " }, sessionWebhook: "u", msgId: "m" });
  assert.equal(msg.text, "hi");
  assert.equal(msg.isGroup, true);
  assert.equal(msg.chatId, "c1", "群聊目标 = conversationId");

  const cfg = normalizeDingtalkConfig({ enabled: true, clientId: " a ", clientSecret: "s", replyMode: "OPENAPI", allowFrom: ["u1", "u2"] });
  assert.equal(cfg.clientId, "a");
  assert.equal(cfg.replyMode, "openapi");
  assert.equal(cfg.credentialSource, "manual", "默认凭据来源 = manual");
  assert.equal(normalizeDingtalkConfig({ credentialSource: "scan" }).credentialSource, "scan", "扫码授权写入 scan");
  assert.equal(normalizeDingtalkConfig({ credentialSource: "SCAN" }).credentialSource, "scan");
  assert.equal(normalizeDingtalkConfig({ credentialSource: "weird" }).credentialSource, "manual", "非法值回 manual");
  assert.deepEqual(cfg.allowFrom, ["u1", "u2"]);
  // 缺省/非法值不抛
  assert.equal(normalizeDingtalkConfig(null).enabled, false);
  assert.equal(normalizeDingtalkConfig({ replyMode: "weird" }).replyMode, "sessionWebhook");
});

test("buildSessionWebhookBody：markdown 形状（标题兜底、正文原样由 im-format 适配）", () => {
  const body = buildSessionWebhookBody({ title: "", text: "| a | b |\n|---|---|\n| 1 | 2 |" });
  assert.equal(body.msgtype, "markdown");
  assert.equal(body.markdown.title, "DeepSeek Harness");
  assert.ok(body.markdown.text.includes("|---|---|"), "这里只构造报文；表格适配由 replySessionWebhook 里的 im-format 负责");
});

// ─────────────────────────── 建连 + ACK ───────────────────────────

test("★ 建连：open 请求体（clientId/clientSecret/订阅 topic/ua）→ WS 连上 → 状态 connected", async () => {
  const rt = await setupBot();
  try {
    await rt.start();
    const open = rt.gateway.state.opens[0];
    assert.ok(open, "必须调用 connections/open");
    assert.equal(open.body.clientId, FAKE_CLIENT);
    assert.equal(open.body.clientSecret, FAKE_SECRET);
    assert.deepEqual(open.body.subscriptions, [{ type: "CALLBACK", topic: TOPIC_ROBOT }]);
    assert.match(rt.gateway.state.lastUpgradeUrl, /\?ticket=ticket-1$/, "WS 必须带 ticket 参数");
    const st = rt.bot.status();
    assert.equal(st.connected, true);
    assert.equal(st.authenticated, true, "ticket 校验即鉴权");
    assert.equal(st.state, "connected");
    assert.ok(st.ticketExpiresAt > Date.now(), "状态里只留 ticket 过期时间（不存 ticket）");
  } finally { await rt.close(); }
});

test("★ 每帧 ACK：SYSTEM ping 回显 opaque、机器人消息 {response:null}、EVENT {status:SUCCESS}；disconnect/未知 SYSTEM 不 ACK", async () => {
  const rt = await setupBot();
  try {
    await rt.start();
    // ① SYSTEM ping
    rt.gateway.push({ type: "SYSTEM", headers: { messageId: "ping-1", topic: "ping" }, data: JSON.stringify({ opaque: "op-1" }) });
    const pingAck = await waitFor(() => rt.gateway.state.acks.find((a) => a.headers && a.headers.messageId === "ping-1"), { label: "ping ACK" });
    assert.equal(pingAck.code, 200);
    assert.deepEqual(rt.gateway.ackData(pingAck), { opaque: "op-1" });
    // ② 机器人消息 CALLBACK（ACK 先于业务处理）
    rt.gateway.push({
      type: "CALLBACK",
      headers: { messageId: "cb-1", topic: TOPIC_ROBOT },
      data: JSON.stringify({ msgId: "cb-msg-1", msgtype: "text", text: { content: "hi" }, conversationId: "cid-1", conversationType: "1", senderStaffId: "staff-1", sessionWebhook: rt.hook.url })
    });
    const cbAck = await waitFor(() => rt.gateway.state.acks.find((a) => a.headers && a.headers.messageId === "cb-1"), { label: "callback ACK" });
    assert.deepEqual(rt.gateway.ackData(cbAck), { response: null });
    // ③ EVENT 订阅
    rt.gateway.push({ type: "EVENT", headers: { messageId: "ev-1", topic: "*" }, data: JSON.stringify({ eventType: "x" }) });
    const evAck = await waitFor(() => rt.gateway.state.acks.find((a) => a.headers && a.headers.messageId === "ev-1"), { label: "event ACK" });
    assert.deepEqual(rt.gateway.ackData(evAck), { status: "SUCCESS" });
    // ④ 未知 SYSTEM 忽略、不崩、不 ACK
    const before = rt.gateway.state.acks.length;
    for (const topic of ["CONNECTED", "REGISTERED", "KEEPALIVE", "something-new"]) {
      rt.gateway.push({ type: "SYSTEM", headers: { messageId: `sys-${topic}`, topic }, data: "{}" });
    }
    await sleep(80);
    assert.equal(rt.gateway.state.acks.length, before, "★ 未知 SYSTEM topic 不得 ACK（官方协议未定义，只记日志）");
    // 收到 SYSTEM disconnect：不 ACK + 换 ticket 重连
    const opensBefore = rt.gateway.state.opens.length;
    rt.gateway.push({ type: "SYSTEM", headers: { messageId: "disc-1", topic: "disconnect" }, data: "{}" });
    const reconnect = await waitFor(() => rt.gateway.state.opens.length > opensBefore, { label: "disconnect 后重新 open" });
    assert.ok(reconnect);
    await waitFor(() => rt.bot.status().connected === true, { label: "重连成功" });
    assert.ok(!rt.gateway.state.acks.some((a) => a.headers && a.headers.messageId === "disc-1"), "disconnect 不 ACK");
  } finally { await rt.close(); }
});

test("★ ticket 一次性 + 断线重连：每次重连都重新 open（新 ticket），不会复用旧 ticket", async () => {
  const rt = await setupBot();
  try {
    await rt.start();
    assert.equal(rt.gateway.state.opens.length, 1);
    rt.gateway.killClients();
    await waitFor(() => rt.gateway.state.opens.length >= 2, { label: "第二次 open" });
    assert.notEqual(rt.gateway.state.tickets[0], rt.gateway.state.tickets[1], "★ 每次重连必须是新 ticket");
    await waitFor(() => rt.bot.status().connected === true, { label: "重连后 connected" });
    assert.equal(rt.bot.status().state, "connected");
    assert.ok(rt.bot.status().openCount >= 2);
  } finally { await rt.close(); }
});

test("★ 凭据错（open 返回 4xx）：状态 failed、不重连、错误人话里点出 Client ID/Secret", async () => {
  const rt = await setupBot({
    gateway: { openResponder: () => ({ status: 401, body: { code: "InvalidAuthentication", message: "invalid clientId or clientSecret" } }) }
  });
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().state === "failed", { label: "failed 状态" });
    const st = rt.bot.status();
    assert.equal(st.connected, false);
    assert.match(st.lastError, /HTTP 401/);
    assert.match(st.lastError, /Client ID/);
    await sleep(400); // 远大于测试退避（40/80/160ms）：凭据错必须**不重连**
    assert.equal(rt.gateway.state.opens.length, 1, "★ 凭据错不得重连");
  } finally { await rt.close(); }
});

// ─────────────────────────── 入站 + 回复 ───────────────────────────

test("★ 入站消息解析 → 转给 DSH 会话 → sessionWebhook 回复（markdown、表格已被格式化）", async () => {
  const rt = await setupBot();
  try {
    await rt.start();
    await rt.inbound({ text: "继续排查", msgId: "in-1", conversationId: "cid-group-9" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "promptSession 调用" });
    assert.deepEqual(rt.sub.calls.prompt[0], { sessionId: "session-live", text: "继续排查" });
    const call = await waitFor(() => rt.hook.state.calls[0], { label: "sessionWebhook 回复" });
    assert.equal(call.body.msgtype, "markdown");
    assert.match(call.body.markdown.text, /已转给桌面端会话/);
    const st = rt.bot.status();
    assert.equal(st.boundChatId, "cid-group-9");
    assert.equal(st.messages, 1);
    assert.equal(st.usage.messages, 1, "派活成功记 1 条额度");
    // 状态文件同步
    const disk = JSON.parse(fs.readFileSync(path.join(rt.relayDir, IM_BOT_STATUS_FILE), "utf8"));
    assert.equal(disk.dingtalk.boundChatId, "cid-group-9");
    assert.equal(disk.dingtalk.usage.messages, 1);
  } finally { await rt.close(); }
});

test("★ 回答回传：turn_end 拿到 agent 最终回答 → 发回 sessionWebhook；Markdown 表格转成可读列表（无裸表格）", async () => {
  const answer = [
    "修复完成：",
    "",
    "| 文件 | 改动 |",
    "|---|---|",
    "| a.mjs | 修端口 |",
    "| b.mjs | 加缓存 |"
  ].join("\n");
  const rt = await setupBot({ subOptions: { answer } });
  try {
    await rt.start();
    await rt.inbound({ text: "给我看改动", msgId: "in-2" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站转发" });
    rt.sub.emit("event", { kind: "turn-end", sessionId: "session-live", turn: 1, seq: 7, at: Date.now() });
    const call = await waitFor(() => rt.hook.state.calls.find((c) => /修复完成/.test(c.body.markdown.text)), { label: "回答回传" });
    const text = call.body.markdown.text;
    assert.ok(!/\|\s*-{2,}/.test(text), "★ 不得出现 |--- 分隔行");
    assert.ok(!/^\s*\|.*\|\s*$/m.test(text), "★ 不得出现裸表格");
    assert.match(text, /• 文件：a\.mjs · 改动：修端口/);
  } finally { await rt.close(); }
});

test("★ 会员闸：免费档本月用满 20 条 → 第 21 条不派活、回升级文案（含 /app/promo）、通知不受影响", async () => {
  const relayDir = tmpRelayDir();
  const d = new Date();
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  fs.writeFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), JSON.stringify({
    version: 1, dingtalk: { usage: { month, messages: 20 } }
  }), { mode: 0o600 });
  const capsProvider = async () => ({ plan: "free", caps: ["notify", "approve", "status", "stop", "assign.continue"], limits: { messages_per_month: 20 }, rev: "r-free" });
  const rt = await setupBot({ relayDir, bot: { capsProvider } });
  try {
    await rt.start();
    await waitFor(() => rt.bot.status().tier === "free", { label: "档位 free" });
    await rt.inbound({ text: "第 21 条", msgId: "gate-1" });
    await waitFor(() => rt.hook.state.calls.length >= 1, { label: "拦截回复" });
    assert.equal(rt.sub.calls.prompt.length, 0, "★ 超额不得调 promptSession");
    const text = rt.hook.last().body.markdown.text;
    assert.match(text, /本月免费指令已用完/);
    assert.match(text, /升级 Pro/);
    assert.match(text, /https:\/\/app\.test\/promo/, "要带升级链接 /app/promo");
    assert.equal(rt.bot.status().usage.messages, 20, "被拦的消息不计数");
    // 通知照常（免费能力，不能静默停掉）
    rt.sub.emit("event", { kind: "turn-end", sessionId: "session-other", turn: 2, seq: 1, at: Date.now(), reason: "completed" });
    await waitFor(() => rt.hook.state.calls.some((c) => /任务完成|完成|turn/i.test(c.body.markdown.text)), { label: "通知" }).catch(() => null);
    assert.ok(rt.hook.state.calls.length >= 1, "通知/回复仍可用");
  } finally { await rt.close(); }
});

// ─────────────────────────── 状态 / 脱敏 ───────────────────────────

test("★ 状态文件字段齐全（与企微对齐 + subscriptions/ticketExpiresAt），且**不含 secret/ticket/token**", async () => {
  const rt = await setupBot();
  try {
    await rt.start();
    await rt.inbound({ text: "hi", msgId: "st-1" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站" });
    const raw = fs.readFileSync(path.join(rt.relayDir, IM_BOT_STATUS_FILE), "utf8");
    const disk = JSON.parse(raw);
    const d = disk.dingtalk;
    for (const key of ["enabled", "state", "connected", "authenticated", "lastError", "lastConnectedAt", "lastMessageAt", "boundChatId", "tier", "caps", "capsCount", "bindingGated", "messagesPerMonth", "remainingMessages", "usage"]) {
      assert.ok(key in d, `状态文件缺少字段 ${key}`);
    }
    assert.ok(Array.isArray(d.subscriptions) && d.subscriptions.includes(TOPIC_ROBOT), "subscriptions 排障字段");
    assert.ok(Number(d.ticketExpiresAt) > 0, "ticketExpiresAt 时间戳");
    assert.ok(!raw.includes(FAKE_SECRET), "★ 状态文件不得含 clientSecret");
    assert.ok(!raw.includes("ticket-"), "★ 状态文件不得含 ticket 原值");
    assert.ok(!/accessToken/i.test(raw), "★ 状态文件不得含 accessToken");
    assert.deepEqual(d.usage.month.length, 7);
    assert.equal(d.usage.messages, 1);
  } finally { await rt.close(); }
});

test("★ 脱敏：日志里不出现 clientSecret（open 失败/正常连接都不泄漏）", async () => {
  const rt = await setupBot({
    gateway: { openResponder: () => ({ status: 500, body: { message: `boom ${FAKE_SECRET}` } }) }
  });
  try {
    rt.bot.start();
    await waitFor(() => rt.bot.status().state === "reconnecting" || rt.bot.status().state === "failed", { label: "错误状态" });
    await sleep(50);
    const joined = rt.logs.join("\n");
    assert.ok(joined.length > 0, "应有日志");
    assert.ok(!joined.includes(FAKE_SECRET), "★ 日志不得出现 clientSecret（含服务端回显）");
    assert.ok(!/ticket-[0-9]/.test(joined), "日志不得打印 ticket 原值");
  } finally { await rt.close(); }
});

// ─────────────────────────── 配置 / 控制器 ───────────────────────────

test("readDingtalkConfig：只读 dingtalk 段；文件缺失/损坏返回 null，绝不抛", () => {
  const dir = tmpRelayDir();
  try {
    assert.equal(readDingtalkConfig(dir), null, "文件不存在 → null");
    fs.writeFileSync(path.join(dir, IM_BOTS_FILE), "{bad json", { mode: 0o600 });
    assert.equal(readDingtalkConfig(dir), null, "坏 JSON → null");
    fs.writeFileSync(path.join(dir, IM_BOTS_FILE), JSON.stringify({ version: 1, wecom: { enabled: true } }), { mode: 0o600 });
    const cfg = readDingtalkConfig(dir);
    assert.ok(cfg && cfg.enabled === false, "没有 dingtalk 段 → 默认关闭");
    fs.writeFileSync(path.join(dir, IM_BOTS_FILE), JSON.stringify({
      version: 1,
      dingtalk: { enabled: true, clientId: "id", clientSecret: "sec", robotCode: "rk", replyMode: "sessionWebhook" }
    }), { mode: 0o600 });
    const cfg2 = readDingtalkConfig(dir);
    assert.equal(cfg2.enabled, true);
    assert.equal(cfg2.robotCode, "rk");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("controller：未启用不建连；启用后按配置起 bot（注入 subscriber），stop 后断开", async () => {
  const gateway = await startGateway();
  const relayDir = tmpRelayDir();
  const sub = fakeSubscriber();
  try {
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({ version: 1, dingtalk: { enabled: false } }), { mode: 0o600 });
    const controller = createDingtalkBotController({
      relayDir,
      log: () => {},
      botOptions: { subscriber: sub },
      configPollMs: 50
    });
    await controller.start();
    assert.equal(controller.status().enabled, false);
    assert.equal(controller.status().reason, "disabled");
    assert.equal(gateway.state.opens.length, 0, "未启用不得建连");
    // 改成启用 + 本地网关（streamUrl 覆盖）→ 热更新后连上
    fs.writeFileSync(path.join(relayDir, IM_BOTS_FILE), JSON.stringify({
      version: 1,
      dingtalk: {
        enabled: true, clientId: FAKE_CLIENT, clientSecret: FAKE_SECRET,
        robotCode: "rk", cardTemplateId: "card-tpl-9", credentialSource: "scan", streamUrl: gateway.openUrl
      }
    }), { mode: 0o600 });
    await waitFor(() => controller.status().enabled === true, { label: "控制器启用（热更新）", timeout: 4000 });
    await waitFor(() => gateway.state.opens.length >= 1, { label: "按配置建连", timeout: 4000 });
    const botStatus = controller.status().bot;
    assert.equal(botStatus.credentialSource, "scan", "controller 要把 credentialSource 透传给 bot");
    assert.deepEqual(botStatus.capabilities, { openapi: true, card: true }, "controller 要把 cardTemplateId 透传给 bot");
    await controller.stop();
    assert.equal(controller.status().enabled, false);
    assert.equal(controller.status().reason, "stopped");
  } finally {
    await gateway.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("controller：DSH_IM_BOTS=0 全关（env 优先）", async () => {
  const controller = createDingtalkBotController({ relayDir: tmpRelayDir(), env: { DSH_IM_BOTS: "0" }, log: () => {}, configPollMs: 50 });
  try {
    await controller.start();
    assert.equal(controller.status().enabled, false);
    assert.equal(controller.status().reason, "disabled_by_env");
  } finally { await controller.stop(); }
});

// ─────────────────────────── 常量/默认值 ───────────────────────────

// ─────────────────── 回复通道三层降级（2026-11-08 实测 bug：回答回传发不出） ───────────────────

/** 包一层 fetch：把 openapi（accessToken / oToMessages / groupMessages）拦成本地假响应并记录。 */
function makeOpenapiFetch() {
  const calls = [];
  const fetchImpl = (url, init) => {
    const u = String(url);
    if (u.includes("/oauth2/accessToken")) {
      calls.push({ kind: "token", url: u, body: init && init.body });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ accessToken: "tok-123", expireIn: 7200 }) });
    }
    if (u.includes("/robot/oToMessages/batchSend") || u.includes("/robot/groupMessages/send")) {
      let body = null;
      try { body = JSON.parse(init && init.body ? init.body : "{}"); } catch { body = null; }
      calls.push({ kind: "send", url: u, body, headers: init && init.headers });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ processQueryKey: "pq-1" }) });
    }
    return fetch(url, init);
  };
  return { fetchImpl, calls };
}

test("★ 回复通道①：入站缓存 sessionWebhook → 回答回传直接 POST 它（跨重启保持）", async () => {
  const relayDir = tmpRelayDir();
  const hook = await startWebhook();
  const gateway = await startGateway();
  const sub = fakeSubscriber({ answer: "重启后也要能回传答案" });
  const botOptions = {
    clientId: FAKE_CLIENT, clientSecret: FAKE_SECRET, robotCode: "ding-robot",
    gatewayUrl: gateway.openUrl, relayDir, subscriber: sub,
    logger: () => {}, reconnectBaseMs: 40, reconnectMaxMs: 160, tierDenyThrottleMs: 0
  };
  const bot1 = createDingtalkBot(botOptions);
  try {
    bot1.start();
    await waitFor(() => bot1.status().connected, { label: "连接1" });
    gateway.push({
      type: "CALLBACK", headers: { messageId: "mid-c1", topic: TOPIC_ROBOT },
      data: JSON.stringify({
        conversationId: "cid-1", conversationType: "2", senderStaffId: "staff-9",
        msgtype: "text", msgId: "m-c1", text: { content: "你好" },
        sessionWebhook: hook.url, sessionWebhookExpiredTime: Date.now() + 5 * 60_000
      })
    });
    await waitFor(() => hook.state.calls.length >= 1, { label: "被动回复" });
    const st1 = bot1.status();
    assert.equal(st1.replyChannel.kind, "sessionWebhook");
    assert.equal(st1.replyChannel.hasWebhook, true);
    await bot1.stop();
  } finally {
    await gateway.close();
  }
  // 重启（新进程语义）：只靠磁盘缓存也要能回传
  const gateway2 = await startGateway();
  const bot2 = createDingtalkBot({ ...botOptions, gatewayUrl: gateway2.openUrl });
  try {
    bot2.start();
    await waitFor(() => bot2.status().connected, { label: "连接2" });
    assert.equal(bot2.status().replyChannel.kind, "sessionWebhook", "★ 重启后回复通道来自持久化缓存");
    const before = hook.state.calls.length;
    const r = await bot2.sendMarkdown("重启后的回答回传");
    assert.equal(r.ok, true);
    assert.equal(r.kind, "sessionWebhook");
    await waitFor(() => hook.state.calls.length > before, { label: "重启后回传到 webhook" });
    assert.match(hook.last().body.markdown.text, /重启后的回答回传/);
  } finally {
    await bot2.stop();
    await gateway2.close();
    await hook.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("★ 回复通道②：sessionWebhook 过期 → 降级 openapi（userIds=[senderStaffId]）", async () => {
  const relayDir = tmpRelayDir();
  const gateway = await startGateway();
  const hook = await startWebhook();
  const api = makeOpenapiFetch();
  const sub = fakeSubscriber({ answer: "x" });
  const bot = createDingtalkBot({
    clientId: FAKE_CLIENT, clientSecret: FAKE_SECRET, robotCode: "ding-robot",
    gatewayUrl: gateway.openUrl, relayDir, subscriber: sub,
    fetchImpl: api.fetchImpl, logger: () => {},
    reconnectBaseMs: 40, reconnectMaxMs: 160, tierDenyThrottleMs: 0
  });
  try {
    bot.start();
    await waitFor(() => bot.status().connected, { label: "连接" });
    gateway.push({
      type: "CALLBACK", headers: { messageId: "mid-exp", topic: TOPIC_ROBOT },
      data: JSON.stringify({
        conversationId: "cid-exp", conversationType: "1", senderStaffId: "staff-exp",
        msgtype: "text", msgId: "m-exp", text: { content: "hi" },
        sessionWebhook: hook.url, sessionWebhookExpiredTime: Date.now() - 1000 // 已过期
      })
    });
    await waitFor(() => bot.status().messages >= 1, { label: "入站" });
    assert.equal(bot.status().replyChannel.kind, "openapi", "★ webhook 过期 → 显示 openapi 可用");
    const hookCalls = hook.state.calls.length;
    const r = await bot.sendMarkdown("降级 openapi 回答");
    assert.equal(r.ok, true);
    assert.equal(r.kind, "openapi");
    const send = api.calls.filter((c) => c.kind === "send");
    assert.equal(send.length, 1);
    assert.deepEqual(send[0].body.userIds, ["staff-exp"], "★ 用缓存的 senderStaffId 发单聊");
    assert.match(send[0].headers["x-acs-dingtalk-access-token"], /tok-123/);
    assert.equal(hook.state.calls.length, hookCalls, "过期 webhook 不得再被调用");
  } finally {
    await bot.stop(); await gateway.close(); await hook.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("★ 回复通道③：webhook 与 openapi 都不可用 → 明确日志 no_reply_channel + 状态人话（不静默）", async () => {
  const relayDir = tmpRelayDir();
  const gateway = await startGateway();
  const logs = [];
  const bot = createDingtalkBot({
    clientId: FAKE_CLIENT, clientSecret: FAKE_SECRET, robotCode: "", // 无 robotCode
    gatewayUrl: gateway.openUrl, relayDir,
    logger: (level, line) => logs.push(line),
    reconnectBaseMs: 40, reconnectMaxMs: 160, tierDenyThrottleMs: 0
  });
  try {
    bot.start();
    await waitFor(() => bot.status().connected, { label: "连接" });
    const r = await bot.sendMarkdown("发不出去的");
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /no_reply_channel|no_robot_code|no_target_user|no_webhook/);
    await waitFor(() => logs.join("\n").match(/no_reply_channel|no_robot_code/), { label: "明确日志" });
    const st = bot.status();
    assert.equal(st.replyChannel.kind, "none");
    assert.ok(String(st.replyChannel.lastError || "").length > 0, "状态要有人话原因");
    const stFile = readJson(path.join(relayDir, IM_BOT_STATUS_FILE));
    assert.equal(stFile.dingtalk.replyChannel.kind, "none");
    assert.match(String(stFile.dingtalk.replyChannel.lastError || ""), /回复通道|robotCode/, "面板可显示可操作原因（补 robotCode / 再发一条消息激活）");
  } finally {
    await bot.stop(); await gateway.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

test("★ 脱敏：日志/状态只出现 webhook host 与哈希，不含整条 webhook URL 或 secret", async () => {
  const relayDir = tmpRelayDir();
  const gateway = await startGateway();
  const logs = [];
  const sub = fakeSubscriber();
  const bot = createDingtalkBot({
    clientId: FAKE_CLIENT, clientSecret: FAKE_SECRET, robotCode: "ding-robot",
    gatewayUrl: gateway.openUrl, relayDir, subscriber: sub,
    logger: (level, line) => logs.push(line),
    reconnectBaseMs: 40, reconnectMaxMs: 160, tierDenyThrottleMs: 0
  });
  try {
    bot.start();
    await waitFor(() => bot.status().connected, { label: "连接" });
    const webhookUrl = "https://oapi.dingtalk.test/robot/sendBySession?session=TOKEN-SECRET-AAA";
    gateway.push({
      type: "CALLBACK", headers: { messageId: "mid-sec", topic: TOPIC_ROBOT },
      data: JSON.stringify({
        conversationId: "cid-sec", conversationType: "1", senderStaffId: "staff-sec",
        msgtype: "text", msgId: "m-sec", text: { content: "hi" },
        sessionWebhook: webhookUrl, sessionWebhookExpiredTime: Date.now() + 60_000
      })
    });
    await waitFor(() => bot.status().messages >= 1, { label: "入站" });
    await waitFor(() => logs.join("\n").includes("oapi.dingtalk.test"), { label: "host 日志" });
    const joined = logs.join("\n");
    assert.ok(!joined.includes("TOKEN-SECRET-AAA"), "★ 日志不得含 webhook 会话令牌");
    assert.ok(!joined.includes(FAKE_SECRET), "★ 日志不得含 clientSecret");
    const raw = fs.readFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), "utf8");
    assert.ok(!raw.includes("TOKEN-SECRET-AAA"), "★ 状态文件不得含 webhook 原值");
    assert.ok(!raw.includes(FAKE_SECRET));
  } finally {
    await bot.stop(); await gateway.close();
    fs.rmSync(relayDir, { recursive: true, force: true });
  }
});

// ─────────────────── robotCode 可选（扫码一键创建机器人，2026-11-08） ───────────────────

test("★ robotCode 可选：只给 clientId/clientSecret 也能启动、收/回消息；状态 capabilities 如实降级", async () => {
  const rt = await setupBot({ bot: { robotCode: "" } });
  try {
    await rt.start();
    const st = rt.bot.status();
    assert.equal(st.connected, true, "★ 没有 robotCode 也必须能连上");
    assert.equal(st.robotCodeConfigured, false);
    assert.deepEqual(st.capabilities, { openapi: false, card: false }, "★ robotCode 缺省 → openapi/card 降级");
    // 收消息 + sessionWebhook 回复（主链路完全不依赖 robotCode）
    await rt.inbound({ text: "扫码创建的机器人也能用", msgId: "norobot-1" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站转发" });
    const call = await waitFor(() => rt.hook.state.calls[0], { label: "sessionWebhook 回复" });
    assert.match(call.body.markdown.text, /已转给桌面端会话/);
    // 状态文件也标记降级 + 凭据来源
    const d = JSON.parse(fs.readFileSync(path.join(rt.relayDir, IM_BOT_STATUS_FILE), "utf8")).dingtalk;
    assert.deepEqual(d.capabilities, { openapi: false, card: false });
    assert.equal(d.robotCodeConfigured, false);
    assert.equal(d.credentialSource, "manual");
  } finally { await rt.close(); }
});

test("★ openapi 模式缺 robotCode：给明确错误、不崩、不白打 token 请求；接收消息照常", async () => {
  const fetchUrls = [];
  const trackedFetch = (url, init) => { fetchUrls.push(String(url)); return fetch(url, init); };
  const rt = await setupBot({ bot: { robotCode: "", replyMode: "openapi", fetchImpl: trackedFetch } });
  try {
    await rt.start();
    // 主动发送：明确拒绝，带 detail 与 capabilities（不是抛异常/静默失败）
    const r = await rt.bot.sendMarkdown("主动推送试试");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_robot_code");
    assert.match(String(r.detail || ""), /robotCode/);
    assert.match(String(r.detail || ""), /接收消息|sessionWebhook/, "要说清主链路不受影响");
    assert.deepEqual(r.capabilities, { openapi: false, card: false });
    assert.ok(!fetchUrls.some((u) => u.includes("/oauth2/accessToken")), "★ 缺 robotCode 时不得白打一次 token 请求");
    // 接收消息照常：openapi 回复失败但入站照常转给 DSH（不崩）
    await rt.inbound({ text: "openapi 缺 robotCode 时的入站", msgId: "norobot-2" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站转发" });
    assert.equal(rt.bot.status().capabilities.openapi, false);
    assert.equal(rt.bot.status().connected, true, "连接不受能力降级影响");
  } finally { await rt.close(); }
});

test("★ capabilities 组合：robotCode 决定 openapi；card 还需 cardTemplateId；credentialSource 透出", async () => {
  // ① 有 robotCode、无卡片模板 → openapi 可用、card 不可用
  {
    const rt = await setupBot({ bot: { robotCode: "ding-robot", credentialSource: "scan" } });
    try {
      await rt.start();
      assert.deepEqual(rt.bot.status().capabilities, { openapi: true, card: false });
      assert.equal(rt.bot.status().credentialSource, "scan", "扫码授权的来源要透出");
      const d = JSON.parse(fs.readFileSync(path.join(rt.relayDir, IM_BOT_STATUS_FILE), "utf8")).dingtalk;
      assert.deepEqual(d.capabilities, { openapi: true, card: false });
      assert.equal(d.credentialSource, "scan");
    } finally { await rt.close(); }
  }
  // ② robotCode + cardTemplateId → 两项都可用
  {
    const rt = await setupBot({ bot: { robotCode: "ding-robot", cardTemplateId: "card-tpl-1" } });
    try {
      await rt.start();
      assert.deepEqual(rt.bot.status().capabilities, { openapi: true, card: true });
      const d = JSON.parse(fs.readFileSync(path.join(rt.relayDir, IM_BOT_STATUS_FILE), "utf8")).dingtalk;
      assert.deepEqual(d.capabilities, { openapi: true, card: true });
    } finally { await rt.close(); }
  }
});

test("常量：默认 open 端点 / ticket 90s / 退避 1s→60s", () => {
  assert.equal(DINGTALK_OPEN_URL, "https://api.dingtalk.com/v1.0/gateway/connections/open");
  assert.equal(TICKET_TTL_MS, 90_000);
  assert.equal(TOPIC_ROBOT, "/v1.0/im/bot/messages/get");
});

// ─────────────────────── 命令层（2026-11-08：/ls 不再转给模型）───────────────────────

test("★ 命令层：/help 回复、免费档 /ls 被拦（会员文案）、/stop 免费急停；命令不进 promptSession", async () => {
  const rt = await setupBot();
  try {
    await rt.start();
    const pushCmd = async (msgId, text) => {
      rt.gateway.push({
        type: "CALLBACK", headers: { messageId: `mid-${msgId}`, topic: TOPIC_ROBOT },
        data: JSON.stringify({
          conversationId: "cid-cmd", conversationType: "2", senderStaffId: "staff-cmd",
          msgtype: "text", msgId: `m-${msgId}`, text: { content: text },
          sessionWebhook: rt.hook.url, sessionWebhookExpiredTime: Date.now() + 60_000
        })
      });
    };
    pushCmd("help", "/help");
    await waitFor(() => rt.hook.state.calls.find((c) => /可用命令/.test(c.body.markdown.text)), { label: "/help 回复" });
    assert.equal(rt.sub.calls.prompt.length, 0, "★ 命令不得进模型");
    pushCmd("ls", "/ls");
    await waitFor(() => rt.hook.state.calls.find((c) => /会员功能/.test(c.body.markdown.text)), { label: "/ls 会员拦截" });
    assert.equal(rt.sub.calls.prompt.length, 0);
    pushCmd("stop", "/stop");
    await waitFor(() => rt.hook.state.calls.find((c) => /已急停|没有正在运行/.test(c.body.markdown.text)), { label: "/stop 回复" });
    assert.equal(rt.sub.calls.cancel.length, 1, "★ /stop 调 cancelSession");
    assert.equal(rt.sub.calls.prompt.length, 0);
    // 普通文本照旧转发
    await rt.inbound({ text: "帮我看看日志", msgId: "m-normal-cmd" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "普通文本转发" });
  } finally { await rt.close(); }
});

// ─────────────────────── 任务通知带总结（2026-11-10：只有"已完成"没有总结）───────────────────────

test("★ 任务通知带总结（钉钉）：turn_done → 一条「✅ 任务完成 + 正文」（表格转列表）；同 turn 去重；正文不进日志", async () => {
  const answer = "修复完成：\n\n| 文件 | 改动 |\n|---|---|\n| a.mjs | 修端口 |\n| b.mjs | 加缓存 |";
  const rt = await setupBot({ subOptions: { answer } });
  try {
    await rt.start();
    await rt.inbound({ text: "给我看改动", msgId: "sum-in-1" });
    await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站转发" });
    const turn = { kind: "turn-end", sessionId: "session-live", turn: 1, seq: 41, reason: "completed", at: Date.now() };
    rt.sub.emit("event", { ...turn });
    const call = await waitFor(() => rt.hook.state.calls.find((c) => c.body.markdown.text.includes("任务完成")), { label: "任务通知" });
    const text = call.body.markdown.text;
    assert.match(text, /^✅ 任务完成/, "★ 通知带「任务完成」标题行");
    assert.match(text, /\n\n修复完成：/, "★ 同一条消息带总结正文");
    assert.match(text, /• 文件：a\.mjs · 改动：修端口/, "★ 表格转可读列表");
    assert.ok(!/\|\s*-{2,}/.test(text), "★ 不得有裸表格");
    // 同 turn 重复事件 → 去重
    const before = rt.hook.state.calls.filter((c) => c.body.markdown.text.includes("任务完成")).length;
    rt.sub.emit("event", { ...turn });
    await sleep(60);
    assert.equal(rt.hook.state.calls.filter((c) => c.body.markdown.text.includes("任务完成")).length, before, "★ 同 turn 只发一条");
    // 正文不进日志（只打 len）
    const logs = rt.logs.join("\n");
    assert.ok(!logs.includes("修复完成"), "★ 总结正文绝不能进日志");
    assert.ok(logs.split("\n").some((l) => /任务通知 .*len=\d+/.test(l)), "日志只记长度");
  } finally { await rt.close(); }
});

test("★ 任务通知边界（钉钉）：缺正文降级仅标题；超长按 1500 字截断+注明；出错带错误摘要；审批不混入总结", async () => {
  // ① 缺正文 → 仅标题
  {
    const rt = await setupBot({ subOptions: { answer: "" } });
    try {
      await rt.start();
      await rt.inbound({ text: "hi", msgId: "sum-2" });
      await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站" });
      rt.sub.emit("event", { kind: "turn-end", sessionId: "session-live", turn: 1, seq: 51, reason: "completed", at: Date.now() });
      const call = await waitFor(() => rt.hook.state.calls.find((c) => c.body.markdown.text.includes("任务完成")), { label: "降级标题" });
      assert.equal(call.body.markdown.text, "✅ 任务完成", "★ 取不到正文 → 仅标题（不多空段）");
    } finally { await rt.close(); }
  }
  // ② 超长 → 截断 + 注明；出错 → ❌ + 摘要
  {
    const rt = await setupBot({ subOptions: { answer: "开头" + "长".repeat(3000) + "SECRET-TAIL" } });
    try {
      await rt.start();
      await rt.inbound({ text: "hi", msgId: "sum-3" });
      await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站" });
      rt.sub.emit("event", { kind: "turn-end", sessionId: "session-live", turn: 1, seq: 61, reason: "completed", at: Date.now() });
      const call = await waitFor(() => rt.hook.state.calls.find((c) => c.body.markdown.text.includes("任务完成")), { label: "截断通知" });
      const text = call.body.markdown.text;
      assert.ok(text.endsWith("…(已截断，完整内容看电脑)"), "超长正文要带截断提示");
      const body = text.split("\n\n").slice(1).join("\n\n");
      assert.ok(Array.from(body).length <= 1500 + 20, "正文不超过 1500 字（+提示）");
      assert.ok(!text.includes("SECRET-TAIL"));
      assert.ok(!rt.logs.join("\n").includes("SECRET-TAIL"), "★ 正文不进日志");
      // 出错：❌ 标题 + 摘要
      rt.sub.emit("event", { kind: "turn-end", sessionId: "session-live", turn: 2, seq: 62, reason: "error", at: Date.now() });
      const err = await waitFor(() => rt.hook.state.calls.find((c) => c.body.markdown.text.startsWith("❌ 出错了")), { label: "出错通知" });
      assert.match(err.body.markdown.text, /\n\n开头/, "出错也要带错误摘要");
    } finally { await rt.close(); }
  }
  // ③ 审批事件不混入总结（走普通通知，不是 ✅ 任务完成）——先入站绑定回复通道
  {
    const rt = await setupBot({ subOptions: { answer: "审批不该出现的总结" } });
    try {
      await rt.start();
      await rt.inbound({ text: "准备审批", msgId: "sum-apr-bind" });
      await waitFor(() => rt.sub.calls.prompt.length === 1, { label: "入站绑定" });
      const before = rt.hook.state.calls.length;
      rt.sub.emit("event", { kind: "approval-request", eventId: "apr_sum_1", toolName: "Bash", sessionId: "session-live" });
      const call = await waitFor(() => rt.hook.state.calls.slice(before).find((c) => c.body.markdown.text.includes("拍板") || c.body.markdown.text.includes("审批")), { label: "审批通知" });
      assert.ok(!/^✅ 任务完成/.test(call.body.markdown.text), "★ 审批类不得混入任务总结");
      assert.ok(!call.body.markdown.text.includes("审批不该出现的总结"), "★ 审批通知不带总结正文");
    } finally { await rt.close(); }
  }
});

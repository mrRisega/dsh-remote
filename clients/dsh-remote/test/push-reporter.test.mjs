import test from "node:test";
import assert from "node:assert/strict";

import {
  createPushReporter,
  toNotifyPayload,
  NOTIFY_KINDS,
  MAX_QUEUE,
  MAX_BODY_LEN
} from "../push-reporter.mjs";
import { NODE_KINDS } from "../dsh-events.mjs";

/** 构造一个审批节点（与 dsh-events classifyWaterfall 的形状一致）。 */
function approvalNode(over = {}) {
  return {
    kind: NODE_KINDS.APPROVAL_REQUEST,
    specNode: 1,
    answerable: true,
    sessionId: "s_1",
    agentId: "a_1",
    eventId: "evt_approval_1",
    toolName: "Bash",
    reason: "npm run deploy",
    options: [
      { value: "allowed-once", label: "允许一次" },
      { value: "rejected", label: "拒绝" }
    ],
    at: 1_700_000_000_000,
    ...over
  };
}

function turnEndNode(over = {}) {
  return {
    kind: NODE_KINDS.TURN_END,
    specNode: 4,
    sessionId: "s_1",
    turn: 3,
    reason: "completed",
    known: true,
    seq: 42,
    at: 1_700_000_000_000,
    ...over
  };
}

/** 极简 fetch 假实现：按脚本返回，记录每次调用。 */
function makeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift();
    if (!step) throw new Error("fetch script exhausted");
    if (step instanceof Error) throw step;
    const status = step.status ?? 200;
    const body = step.body ?? { ok: true };
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return body; }
    };
  };
  fn.calls = calls;
  return fn;
}

// ───────────────────────── 映射（事件 → 上报体） ─────────────────────────

test("① 审批节点 → approval_request，event_id 稳定、带选项、正文不含完整命令（默认隐私模式）", () => {
  const p = toNotifyPayload(approvalNode(), { deviceId: "dev-x", detail: false });
  assert.equal(p.kind, NOTIFY_KINDS.APPROVAL_REQUEST);
  assert.match(p.event_id, /^dev-x:approval:/);
  assert.equal(p.approval.request_id, "evt_approval_1");
  assert.equal(p.approval.options.length, 2);
  assert.equal(p.session.id, "s_1");
  // 默认模式：summary 只留动作名（工具名），绝不外发 "npm run deploy" 这种完整命令
  assert.equal(p.approval.summary, "Bash");
  assert.ok(!JSON.stringify(p).includes("npm run deploy"), "默认模式不得把完整命令外发");
  assert.ok(p.body.length <= MAX_BODY_LEN);
});

test("② detail 模式才带上完整命令摘要（服务端规则引擎据此判风险）", () => {
  const p = toNotifyPayload(approvalNode(), { deviceId: "dev-x", detail: true });
  assert.equal(p.approval.summary, "npm run deploy");
});

test("③ 会话标题进 session.title（超长截断），正文只写一句人话", () => {
  const p = toNotifyPayload(approvalNode(), {
    deviceId: "dev-x",
    sessionTitle: () => "重构登录模块".repeat(20)
  });
  assert.ok(p.session.title.length <= 60);
});

test("④ turn/end 各 reason 映射：completed→turn_done、error→turn_error、blocked→turn_blocked、未知原因如实写", () => {
  const done = toNotifyPayload(turnEndNode(), { deviceId: "dev-x", sessionTitle: () => "重构登录模块" });
  assert.equal(done.kind, NOTIFY_KINDS.TURN_DONE);
  assert.match(done.body, /重构登录模块/);

  const err = toNotifyPayload(turnEndNode({ reason: "error", known: true }), { deviceId: "dev-x" });
  assert.equal(err.kind, NOTIFY_KINDS.TURN_ERROR);

  const blocked = toNotifyPayload(turnEndNode({ reason: "blocked", known: true }), { deviceId: "dev-x" });
  assert.equal(blocked.kind, NOTIFY_KINDS.TURN_BLOCKED);

  const weird = toNotifyPayload(turnEndNode({ reason: "some-new-reason", known: false }), { deviceId: "dev-x" });
  assert.equal(weird.kind, NOTIFY_KINDS.TURN_DONE);
  assert.match(weird.body, /some-new-reason/);
});

test("⑤ gap/fault/简报等节点不上报（返回 null），缺 deviceId 也不上报", () => {
  assert.equal(toNotifyPayload({ kind: NODE_KINDS.GAP, at: 1 }, { deviceId: "dev-x" }), null);
  assert.equal(toNotifyPayload({ kind: NODE_KINDS.FAULT, at: 1 }, { deviceId: "dev-x" }), null);
  assert.equal(toNotifyPayload({ kind: NODE_KINDS.DIGEST_DUE, at: 1 }, { deviceId: "dev-x" }), null);
  assert.equal(toNotifyPayload(approvalNode(), { deviceId: "" }), null);
  assert.equal(toNotifyPayload(null, { deviceId: "dev-x" }), null);
});

test("⑥ 审批节点没有 eventId（无法回执）时不上报", () => {
  assert.equal(toNotifyPayload(approvalNode({ eventId: "" }), { deviceId: "dev-x" }), null);
});

// ───────────────────────── 队列与投递 ─────────────────────────

test("⑦ 同一 event_id 重复入队只算一条（幂等第一道）", async () => {
  const fetchImpl = makeFetch([{ status: 200 }]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  const p = toNotifyPayload(turnEndNode(), { deviceId: "dev-x" });
  assert.equal(r._enqueue(p), true);
  assert.equal(r._enqueue({ ...p }), false);
  assert.equal(r.status().duplicates, 1);
  await r._flush();
  assert.equal(r.status().sent, 1);
  await r.stop();
});

test("⑧ 队列有界：超过上限丢最旧并计数（不让内存无界增长）", async () => {
  const fetchImpl = makeFetch([]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl,
    maxQueue: 3
  });
  for (let i = 0; i < 5; i++) {
    r._enqueue({
      event_id: `dev-x:turn:${i}`,
      device_id: "dev-x",
      kind: NOTIFY_KINDS.TURN_DONE,
      at: 1,
      session: { id: "s" },
      title: "任务完成",
      body: "x"
    });
  }
  assert.equal(r.status().queued, 3);
  assert.equal(r.status().dropped, 2);
  await r.stop();
});

test("⑨ 投递成功：带 Bearer、POST 到 /api/notify/event、JSON body", async () => {
  const fetchImpl = makeFetch([{ status: 200, body: { ok: true, notified: 1 } }]);
  const r = createPushReporter({
    apiBase: "https://api.example.com/",
    deviceId: "dev-x",
    tokenProvider: () => "tok-1",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  r._enqueue(toNotifyPayload(turnEndNode(), { deviceId: "dev-x" }));
  await r._flush();
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://api.example.com/api/notify/event");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer tok-1");
  assert.equal(JSON.parse(call.init.body).device_id, "dev-x");
  assert.equal(r.status().sent, 1);
  await r.stop();
});

test("⑩ 401：丢弃本批（等下次登录刷新），不无限重试", async () => {
  const fetchImpl = makeFetch([{ status: 401 }]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "expired",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  r._enqueue(toNotifyPayload(turnEndNode(), { deviceId: "dev-x" }));
  await r._flush();
  assert.equal(r.status().queued, 0, "401 后不应把条目留在队列里反复打");
  assert.equal(r.status().lastError, "auth_failed");
  await r.stop();
});

test("⑪ 400 契约错误：丢弃该条（重试没意义）", async () => {
  const fetchImpl = makeFetch([{ status: 400 }]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  r._enqueue(toNotifyPayload(turnEndNode(), { deviceId: "dev-x" }));
  await r._flush();
  assert.equal(r.status().queued, 0);
  assert.match(r.status().lastError, /http_400/);
  await r.stop();
});

test("⑫ 5xx：保留条目等待退避重试（不丢事件）", async () => {
  const fetchImpl = makeFetch([{ status: 503 }]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl,
    retryDelaysMs: [1, 1, 1]
  });
  r._enqueue(toNotifyPayload(turnEndNode(), { deviceId: "dev-x" }));
  await r._flush();
  assert.equal(r.status().queued, 1, "5xx 应保留重试");
  await r.stop();
});

test("⑬ 没有 token：不发请求、条目留在队列", async () => {
  const fetchImpl = makeFetch([]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  r._enqueue(toNotifyPayload(turnEndNode(), { deviceId: "dev-x" }));
  await r._flush();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(r.status().queued, 1);
  assert.equal(r.status().lastError, "no_token");
  await r.stop();
});

// ───────────────────────── 启动门禁 ─────────────────────────

test("⑭ start()：服务端明确关闭推送时**不启动**（默认关）", async () => {
  const fetchImpl = makeFetch([{ status: 200, body: { ok: true, notify: { enabled: false } } }]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  const st = await r.start();
  assert.equal(st.started, false);
  assert.equal(st.reason, "disabled");
  await r.stop();
});

test("⑮ start()：账号没有推送订阅时不启动（没订阅推了也没人收）", async () => {
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, notify: { enabled: true } } },
    { status: 200, body: { ok: true, enabled: true, subscribed: false } }
  ]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  const st = await r.start();
  assert.equal(st.started, false);
  assert.equal(st.reason, "no_subscription");
  await r.stop();
});

test("⑯ start()：没有 token 时不启动、不抛异常", async () => {
  const fetchImpl = makeFetch([]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  const st = await r.start();
  assert.equal(st.started, false);
  assert.equal(st.reason, "no_token");
  assert.equal(fetchImpl.calls.length, 0);
  await r.stop();
});

test("⑰ 探测失败（网络异常）不抛、不启动（可选增强绝不能拖垮主链路）", async () => {
  const fetchImpl = makeFetch([new Error("ECONNREFUSED")]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  const st = await r.start();
  assert.equal(st.started, false);
  assert.equal(st.reason, "ECONNREFUSED");
  await r.stop();
});

test("⑱ 事件归一化抛错也不影响（畸形节点被忽略，不冒泡）", async () => {
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl: makeFetch([])
  });
  // 直接喂畸形对象给映射函数：必须返回 null 而不是抛
  assert.equal(toNotifyPayload({ kind: NODE_KINDS.APPROVAL_REQUEST, eventId: null, at: "x" }, { deviceId: "dev-x" }), null);
  await r.stop();
});

test("⑲ 正文长度硬上限：超长标题/正文被截断", () => {
  const p = toNotifyPayload(turnEndNode(), {
    deviceId: "dev-x",
    sessionTitle: () => "很长的标题".repeat(100)
  });
  assert.ok(p.body.length <= MAX_BODY_LEN);
  assert.ok(p.session.title.length <= 60);
});

test("⑳ MAX_QUEUE 常量与文档一致（50）", () => {
  assert.equal(MAX_QUEUE, 50);
});

test("㉑ event_id 必须只含 [A-Za-z0-9._:-]（服务端契约，问号/空格会被 400）", () => {
  const p = toNotifyPayload(
    { kind: NODE_KINDS.TURN_END, sessionId: "s/1", turn: undefined, seq: undefined, reason: "completed", at: 1 },
    { deviceId: "dev-x" }
  );
  assert.ok(p, "应生成上报体");
  assert.match(p.event_id, /^[A-Za-z0-9._:-]+$/, `event_id 含非法字符：${p.event_id}`);
  // 会话 id 里有斜杠、turn/seq 缺失产生问号 —— 都必须被归一化成安全字符
  const p2 = toNotifyPayload(
    { kind: NODE_KINDS.APPROVAL_REQUEST, sessionId: "s/1", eventId: "evt 1?x", at: 1, toolName: "Bash" },
    { deviceId: "dev-x" }
  );
  assert.match(p2.event_id, /^[A-Za-z0-9._:-]+$/, `event_id 含非法字符：${p2.event_id}`);
  assert.ok(p2.event_id.length <= 128);
});

test("㉒ start()：服务端开启且已订阅时才会继续（门禁用 /api/me.notify.enabled）", async () => {
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, notify: { enabled: true } } },
    { status: 200, body: { ok: true, enabled: true, subscribed: true } }
  ]);
  const r = createPushReporter({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    upstream: "http://127.0.0.1:3080",
    fetchImpl
  });
  const st = await r.start();
  // 订阅器在测试环境没有真实 WS，启动可能失败；关键断言是"门禁通过了"（reason 不再是 disabled/no_subscription）
  assert.notEqual(st.reason, "disabled");
  assert.notEqual(st.reason, "no_subscription");
  assert.equal(fetchImpl.calls[0].url, "https://api.example.com/api/me");
  await r.stop();
});

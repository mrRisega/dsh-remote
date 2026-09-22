/**
 * 微信通道**编排层**测试(wechat-runtime.mjs)。
 *
 * 这一层的存在理由就是"把两个并行开发的模块拼起来",所以测试的重点也在这里:
 *
 *   ① **词表翻译**:事件侧(`dsh-events.mjs`)与文案侧(`wechat-channel.mjs`)的 kind 名不同
 *      (`approval-request` vs `approval`),两边各自单测全绿、拼起来却互不认识。
 *      这里锁死每一个 kind 都有归宿,并且上游**新增** kind 时会当场失败。
 *   ② **-14 冷却真的生效**:腾讯侧 token 失效时若不退避会猛打接口。
 *      ⚠️ 这里守的是一个**真实踩过的坑**:SessionCooldown 没有 isActive(),
 *      写成 `cooldown.isActive && cooldown.isActive()` 会静默短路成 false,冷却形同虚设。
 *   ③ **回执编码分派**:审批用 answerApproval(值),提问用 answerQuestion(答案数组),
 *      用错会把审批值塞进提问信封。且选项字段是 `value` 不是 outcome。
 *   ④ **控制面安全**:仅回环 + 必须带密钥;**永不回显 bot_token**。
 *   ⑤ §6 的两条产品硬约束:过期**绝不**当同意;断线窗口要如实告知。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import * as rtmod from "../wechat-runtime.mjs";
import {
  createWeChatRuntime,
  readControlFile,
  assertKindCoverage,
  toFormatterNode,
  CONTROL_HEADER
} from "../wechat-runtime.mjs";
import { saveAccount, loadState, formatNotification, SessionCooldown } from "../wechat-channel.mjs";
import { NODE_KINDS } from "../dsh-events.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wc-rt-"));
const SECRET = "s3cret-bridge";

/** 静默 logger。⚠️ 必须带 addSecret():WeChatChannel 构造时会调用它给 token 脱敏。 */
const quietLogger = () => ({ info() {}, warn() {}, error() {}, debug() {}, addSecret() {} });


/** 本地假 ilink 服务 —— 测试期网络护栏只允许回环,所以必须自带假上游。 */
function fakeIlink(handler) {
  const state = { sends: [], notifyStart: 0, notifyStop: 0, getUpdates: 0, queue: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (obj) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname.endsWith("/getupdates")) {
        state.getUpdates += 1;
        if (handler && handler.onGetUpdates) return handler.onGetUpdates(state, reply);
        const msgs = state.queue.splice(0);
        return reply({ ret: 0, msgs, get_updates_buf: "buf-" + state.getUpdates, longpolling_timeout_ms: 1 });
      }
      if (url.pathname.endsWith("/sendmessage")) {
        try { state.sends.push(JSON.parse(body)); } catch { state.sends.push({ raw: body }); }
        return reply({ ret: 0, message_id: "m" + state.sends.length });
      }
      if (url.pathname.endsWith("/notifystart")) { state.notifyStart += 1; return reply({ ret: 0 }); }
      if (url.pathname.endsWith("/notifystop")) { state.notifyStop += 1; return reply({ ret: 0 }); }
      if (url.pathname.endsWith("/get_bot_qrcode")) return reply({ ret: 0, qrcode: "Q1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc?qrcode=Q1&bot_type=3" });
      if (url.pathname.endsWith("/get_qrcode_status")) return reply({ status: "wait" });
      return reply({ ret: 0 });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        state,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        // ⚠️ 只 close() 不够:Node 的 fetch(undici)默认 keep-alive,连接不释放会让
        // server.close() 一直等下去 → 整个测试挂死(本文件真的踩过一次,排查成本很高)。
        close: () =>
          new Promise((r) => {
            try { server.closeAllConnections?.(); } catch { /* 老版本无此 API */ }
            server.close(() => r());
          })
      })
    );
  });
}

/** 直接构造一个"已绑定"的运行时(绕过扫码),便于测通道与回执。 */
async function boundRuntime(ilink, opts = {}) {
  const relayDir = tmp();
  saveAccount(relayDir, { token: "tok-abc", accountId: "bot-1", baseUrl: ilink.baseUrl, userId: "user-1", boundAt: 1 });
  const rt = createWeChatRuntime({
    relayDir,
    upstream: "http://127.0.0.1:1",
    secret: SECRET,
    cooldownMs: opts.cooldownMs,
    // 默认按**付费档**跑:本文件绝大多数用例测的是遥控能力(交代任务/选会话)。
    // 免费档的门槛由「分层」那组用例专门守 —— 它们显式传 tier:"free"。
    tier: opts.tier === undefined ? "pro" : opts.tier,
    tierProvider: opts.tierProvider,
    tierDenyThrottleMs: opts.tierDenyThrottleMs,
    limitTable: opts.limitTable,
    entitlements: opts.entitlements,
    appUrl: opts.appUrl,
    logger: quietLogger()
  });
  // 替换订阅器:本文件测编排,不测 DSH 协议(那是 dsh-events.test.mjs 的职责)
  rt.subscriber = opts.subscriber || makeFakeSubscriber();
  return { rt, relayDir };
}

/** 假的 DSH 订阅器:记录回执调用,便于断言分派正确。 */
function makeFakeSubscriber() {
  const s = new EventEmitter();
  s.calls = [];
  s.answer = async (id, outcome) => { s.calls.push({ m: "answer", id, outcome }); return { ok: true }; };
  s.answerApproval = async (id, value) => { s.calls.push({ m: "answerApproval", id, value }); return { ok: true }; };
  s.answerQuestion = async (id, answers) => { s.calls.push({ m: "answerQuestion", id, answers }); return { ok: true }; };
  // ⚠️ 必须 `...d` 展开透传:真实实现是 `this.#emitLocal({ kind, specNode: 5, ...detail })`。
  //    只挑 notified/answered 会把 `lines` 丢掉 → 日报退化成兜底文案,而测试还"通过"(假的失真)。
  s.digestDue = (d = {}) => ({ kind: NODE_KINDS.DIGEST_DUE, ...d, at: 1 });
  s.quotaLow = (d = {}) => ({ kind: NODE_KINDS.QUOTA_LOW, message: d.message, at: 1 });
  s.membershipExpiring = (d = {}) => ({ kind: NODE_KINDS.MEMBERSHIP_EXPIRING, message: d.message, at: 1 });
  s.start = () => {};
  s.close = () => {};
  // ── v2:会话遥控。记录调用,让编排层的分派可被断言 ──
  s.sessionsFixture = [];
  s.summaryFixture = "";
  s.listSessions = async () => { s.calls.push({ m: "listSessions" }); return { ok: true, sessions: s.sessionsFixture }; };
  s.createSession = async (o = {}) => { s.calls.push({ m: "createSession", opts: o }); return { ok: true, sessionId: "session-new-1" }; };
  s.promptSession = async (o = {}) => { s.calls.push({ m: "promptSession", sessionId: o.sessionId, text: o.text }); return { ok: true, accepted: true }; };
  s.cancelSession = async (o = {}) => { s.calls.push({ m: "cancelSession", sessionId: o.sessionId }); return { ok: true }; };
  s.lastAssistantText = async () => ({ ok: true, text: s.summaryFixture });
  return s;
}

const lastText = (state) => {
  const last = state.sends[state.sends.length - 1];
  return last && last.msg && last.msg.item_list && last.msg.item_list[0] && last.msg.item_list[0].text_item
    ? last.msg.item_list[0].text_item.text
    : "";
};

// ── ① 词表翻译 ────────────────────────────────────────────────────────────

test("★ 词表覆盖:事件侧每个 kind 都必须有归宿(上游新增节点会当场暴露)", () => {
  assert.equal(assertKindCoverage(), true);
});

test("★ 翻译:事件 kind → 文案 kind 全部命中,不再渲染出「未知节点」", async () => {
  const expect = {
    [NODE_KINDS.APPROVAL_REQUEST]: "approval",
    [NODE_KINDS.USER_QUESTION]: "question",
    [NODE_KINDS.PLAN_REVIEW]: "plan",
    [NODE_KINDS.SESSION_ERROR]: "error",
    [NODE_KINDS.TURN_END]: "stopped",
    [NODE_KINDS.DIGEST_DUE]: "daily",
    [NODE_KINDS.QUOTA_LOW]: "quota",
    [NODE_KINDS.MEMBERSHIP_EXPIRING]: "membership"
  };
  for (const [eventKind, formatterKind] of Object.entries(expect)) {
    const { node } = toFormatterNode({ kind: eventKind });
    assert.ok(node, `${eventKind} 没有翻译出文案节点`);
    assert.equal(node.kind, formatterKind);
    const text = formatNotification(node, {}).text;
    assert.ok(!text.includes("未知节点"), `${eventKind} 渲染成了「未知节点」:${text}`);
  }
});

test("★ 翻译:字段名对齐(toolName→tool / questions→prompt+options / 简报 lines / 停止原因)", () => {
  const a = toFormatterNode({ kind: NODE_KINDS.APPROVAL_REQUEST, toolName: "Bash", reason: "rm -rf" }).node;
  assert.equal(a.tool, "Bash", "toolName 必须映射到 tool,否则文案显示「(未提供)」");
  assert.match(formatNotification(a, {}).text, /工具: Bash/);

  const q = toFormatterNode({
    kind: NODE_KINDS.USER_QUESTION,
    questions: [{ id: "q1", question: "选哪个?", options: ["A", "B"] }]
  }).node;
  assert.equal(q.prompt, "选哪个?");
  assert.deepEqual(q.options, ["A", "B"], "提问的选项必须被抬到 options,否则用户看不到可回什么");
  const qt = formatNotification(q, {});
  assert.equal(qt.replyable, true);
  assert.equal(qt.options.length, 2);

  const d = toFormatterNode({ kind: NODE_KINDS.DIGEST_DUE, notified: 3, answered: 1 }).node;
  assert.ok(Array.isArray(d.lines) && d.lines.length, "简报必须有 lines,否则文案是空的");

  const t = toFormatterNode({ kind: NODE_KINDS.TURN_END, reason: "aborted" }).node;
  assert.match(formatNotification(t, {}).text, /被中断|中止|停止原因/, "停止原因要翻译给用户看");
});

test("特殊节点不该被当成「未接线」:event-expired / gap / fault 走各自的路径", () => {
  for (const k of [NODE_KINDS.EVENT_EXPIRED, NODE_KINDS.GAP, NODE_KINDS.FAULT]) {
    assert.equal(toFormatterNode({ kind: k }).node, null, `${k} 不应有文案模板`);
    assert.equal(assertKindCoverage(), true, `${k} 必须被 SPECIAL 列表认领,否则覆盖自检会误报`);
  }
});

// ── ② -14 冷却 ────────────────────────────────────────────────────────────

test("★ -14 冷却真的生效:命中 session timeout 后不得猛打接口", async () => {
  const ilink = await fakeIlink({ onGetUpdates: (_s, reply) => reply({ ret: 0, errcode: -14, errmsg: "session timeout" }) });
  try {
    const { rt } = await boundRuntime(ilink, { cooldownMs: 300 });
    await rt.startChannel();
    await new Promise((r) => setTimeout(r, 1400));
    // 冷却 300ms + 循环下限 1s → 1.4s 内应该只打了极少数几次;
    // 若 isActive 短路 bug 回归,这里会变成几十次。
    assert.ok(ilink.state.getUpdates <= 3, `冷却未生效:1.4s 内打了 ${ilink.state.getUpdates} 次 getupdates`);
    // 断言「冷却被触发并记了账」而不是「此刻冷却未结束」——用 300ms 短冷却时,
    // 1.4s 后冷却本来就该结束了;原先断言 remainingMs>0 是测试自己写错了。
    assert.match(
      rt.status().last_error,
      /冷却|token 失效|会话过期/,
      `-14 应被登记为冷却状态,实际:${JSON.stringify(rt.status().last_error)}`
    );
    await rt.stop();
  } finally {
    await ilink.close();
  }
});

test("SessionCooldown 没有 isActive():编排层不得依赖它(防静默短路回归)", () => {
  const sc = new SessionCooldown({ cooldownMs: 1000 });
  assert.equal(typeof sc.isActive, "undefined", "上游确实没有 isActive —— 若将来加了,请同步改运行时并用本测试提醒");
  assert.equal(sc.remainingMs(), 0, "未 arm 时 remainingMs 必须是 0(不能是 undefined,否则比较会出错)");
  sc.arm("test");
  assert.ok(sc.remainingMs() > 0);
});

// ── ③ 回执分派 ────────────────────────────────────────────────────────────

test("★ 审批回执走 answerApproval,提问回执走 answerQuestion(不能混)", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    rt.channel.account = { token: "t", accountId: "b", baseUrl: ilink.baseUrl, userId: "user-1" };

    // 1) 推一条审批
    const sent = await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "ev-1", toolName: "Bash", reason: "rm", answerShape: "approval", at: 1
    });
    assert.equal(sent.ok, true);
    assert.match(lastText(ilink.state), /需要你拍板/);

    // 用户回 1 → 应走 answerApproval 且值为 allowed-once
    ilink.state.queue.push({ from_user_id: "user-1", item_list: [{ type: 1, text_item: { text: "1" } }] });
    await rt.handleInbound({ from_user_id: "user-1", item_list: [{ type: 1, text_item: { text: "1" } }] });
    const call = sub.calls[sub.calls.length - 1];
    assert.equal(call.m, "answerApproval", "审批必须走 answerApproval,否则编码不对");
    assert.equal(call.value, "allowed-once", "选项字段是 value,不是 outcome");

    // 2) 推一条提问
    await rt.notify({
      kind: NODE_KINDS.USER_QUESTION, eventId: "ev-2", answerShape: "question", at: 1,
      questions: [{ id: "q1", question: "选哪个?", options: ["甲", "乙"] }]
    });
    await rt.handleInbound({ from_user_id: "user-1", item_list: [{ type: 1, text_item: { text: "2" } }] });
    const call2 = sub.calls[sub.calls.length - 1];
    assert.equal(call2.m, "answerQuestion", "提问必须走 answerQuestion");
    assert.deepEqual(call2.answers, [{ id: "q1", selected: ["乙"] }]);
  } finally {
    await ilink.close();
  }
});

test("★ 过期绝不等于同意:没有待答通知时回数字,必须明说「没有代你做决定」", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    await rt.handleInbound({ from_user_id: "user-1", item_list: [{ type: 1, text_item: { text: "1" } }] });
    assert.equal(sub.calls.length, 0, "不得在没有待答通知时发出任何回执");
    assert.match(lastText(ilink.state), /没有代你做出任何选择/);
  } finally {
    await ilink.close();
  }
});

test("同一条通知不得被回复两次(consume 后再次回复应被拒)", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    await rt.notify({ kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "ev-x", toolName: "B", answerShape: "approval", at: 1 });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    const before = sub.calls.length;
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    assert.equal(sub.calls.length, before, "第二次回复不得再产生一次回执");
  } finally {
    await ilink.close();
  }
});

// ── ④ 指令 / 帮助文案 ─────────────────────────────────────────────────────

test("★ handleCommand 的字段是 replyText:回 /help 必须真的发出帮助(防静默发空)", async () => {
  const ilink = await fakeIlink();
  try {
    const { rt } = await boundRuntime(ilink);
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/help" } }] });
    const text = lastText(ilink.state);
    assert.ok(text.includes("/status") && text.includes("/unbind"), `帮助文案没发出来,实际:${JSON.stringify(text)}`);
  } finally {
    await ilink.close();
  }
});

test("★ 分层:免费档 = 通知+审批,付费档才给遥控;未知档位按最低档", () => {
  const { capabilitiesFor, WECHAT_CAPABILITY_TABLE, grantsCap, limitsFor } = rtmod;
  const free = capabilitiesFor("free");
  // 免费档(业主口径):收得到通知、点得了审批、看得到状态、停得下任务 —— 但**遥控不了**。
  for (const cap of ["notify", "approve", "status", "stop"]) {
    assert.ok(free.includes(cap), `免费档必须有 ${cap}`);
  }
  for (const cap of ["assign", "sessions", "summary"]) {
    assert.ok(!free.includes(cap), `免费档**不得**有 ${cap}(业主:那是付费能力)`);
  }
  // 付费档 = 免费档超集 + 遥控
  const pro = capabilitiesFor("pro");
  // ⚠️ 必须用 grantsCap(前缀规则)判超集:付费档写的是粗粒度 "assign",
  //    它按前缀**覆盖** assign.continue —— 用裸 includes 会误判成"缺能力"。
  for (const cap of free) assert.ok(grantsCap(pro, cap), `付费档必须授权免费档的每一项,缺 ${cap}`);
  for (const cap of ["assign.new", "assign.continue", "sessions", "summary"]) {
    assert.ok(grantsCap(pro, cap), `付费档必须有 ${cap}`);
  }

  // ★★ 业主 2026-09-22 拍板的核心不变量:免费**能续接已有会话、不能开新会话**
  assert.ok(grantsCap(free, "assign.continue"), "免费档必须能「继续已有会话」(回复即续接)");
  assert.ok(!grantsCap(free, "assign.new"), "★免费档**不得**能开新会话(那是会员能力的差异点)");
  assert.ok(!grantsCap(free, "sessions"), "免费档不得能切换会话");

  // 前缀规则本身:粗粒度授权覆盖细粒度,细粒度不越权,未知能力一律不授权(fail-closed)
  assert.ok(grantsCap(["assign"], "assign.new") && grantsCap(["assign"], "assign.continue"),
    "写 assign 应同时覆盖 new 与 continue");
  assert.ok(!grantsCap(["assign.continue"], "assign.new"), "写 assign.continue 不得越权到 assign.new");
  assert.ok(!grantsCap(["assign.continue"], "assign"), "细粒度不得反向覆盖粗粒度");
  assert.ok(!grantsCap(["assign"], "constructor"), "前缀规则不能被开头相同的无关词命中");
  assert.ok(!grantsCap(free, "steer") && !grantsCap(["whatever"], "assign.new"), "未知能力不授权");

  // 额度(业主:「免费给每月 N 条消息额度,超出再引导升级」;付费档不限)
  assert.ok(Number(limitsFor("free").messages_per_month) > 0, "免费档必须有每月消息额度");
  assert.equal(Number(limitsFor("pro").messages_per_month || 0), 0, "付费档不应限量(0 = 不限)");
  assert.equal(Number(limitsFor("pro_max").messages_per_month || 0), 0, "最高档同样不限量");
  assert.ok(pro.length > free.length, "付费档应比免费档多能力(否则钩子没意义)");
  // ⚠️ 服务端的最高档取值是 **pro_max** —— 漏了它 capabilitiesFor 会回退 free,
  //    把花了最多钱的用户当成免费用户挡在门外。
  assert.deepEqual(capabilitiesFor("pro_max"), pro, "pro_max 必须与 pro 同权(服务端 plan 取值就是 pro_max)");
  // 未知/空档位按最低档处理 —— 宁可少给,不可误放
  assert.deepEqual(capabilitiesFor("nonexistent"), free);
  assert.deepEqual(capabilitiesFor(""), free);
  assert.deepEqual(capabilitiesFor(undefined), free);
  // 表是冻结的(防止运行期被改)
  assert.ok(Object.isFrozen(WECHAT_CAPABILITY_TABLE));
});

test("★ 分层:免费档被挡且回复里带 App 链接;付费档放行;未知档位按免费", async () => {
  // 这条守的是两件事:(1) 门槛是**活代码**,不是文档;(2) 免费用户越界时拿到的是
  // 「解释 + 可点击的 App 链接」,而不是一句干巴巴的拒绝 —— 那是把用户引回主功能的入口。
  const APP_URL = "https://app.example/x/";
  const ilink = await fakeIlink();
  try {
    const send = (rt) => rt.handleInbound({
      from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 做点事" } }]
    });

    // ① 免费档:必须拒绝,且回复里要有 App 链接
    const free = await boundRuntime(ilink, { subscriber: makeFakeSubscriber(), tier: "free", appUrl: APP_URL });
    await send(free.rt);
    assert.equal(free.rt.subscriber.calls.filter((c) => c.m === "createSession").length, 0,
      "免费档不得真的建会话");
    const freeText = lastText(ilink.state);
    assert.match(freeText, /会员功能/, `要说清为什么被拒,实际:${freeText}`);
    assert.ok(freeText.includes(APP_URL),
      `★回复必须带上可点击的 App 链接(业主:免费用户要去做别的,就给他访问 App 的链接),实际:${freeText}`);
    assert.match(freeText, /\/help/, "还要告诉他现在能做什么,而不是死路一条");

    // ② 付费档:同一句话必须放行
    const pro = await boundRuntime(ilink, { subscriber: makeFakeSubscriber(), tier: "pro", appUrl: APP_URL });
    await send(pro.rt);
    assert.equal(pro.rt.subscriber.calls.filter((c) => c.m === "createSession").length, 1,
      "付费档必须能交代任务");

    // ③ 未知档位按最低档 —— 宁可少给,不可误放
    const weird = await boundRuntime(ilink, { subscriber: makeFakeSubscriber(), tier: "谁", appUrl: APP_URL });
    await send(weird.rt);
    assert.equal(weird.rt.subscriber.calls.filter((c) => c.m === "createSession").length, 0,
      "未知档位必须按免费档处理");
  } finally {
    await ilink.close();
  }
});

test("★ 分层:免费档仍能收通知、点审批、看状态、急停(不能把免费版做成废的)", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub, tier: "free" });

    // ① 通知 + 审批一步回执 —— 免费档的核心价值,绝不能因为分层被误伤
    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "evt-free", toolName: "Read",
      reason: "读取文件", answerShape: "approval", at: 1
    });
    assert.ok(rt.pendingReplies.length > 0, "免费档必须收到可回执的审批通知");
    assert.match(lastText(ilink.state), /回复 1/, "非破坏性审批必须给编号选项");
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    assert.equal(sub.calls.filter((c) => String(c.m).startsWith("answer")).length, 1,
      "免费档必须能一步回执审批");

    // ② /status 是信息类:人人可用(也是免费用户的转化入口)
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/status" } }] });
    assert.ok(lastText(ilink.state).length > 0, "/status 必须对免费档可用");

    // ③ /stop 是急停阀:免费档也必须能停。
    //    免费用户不能主动 /use 切会话,但指针会在他收到事件时自动落上(见 #rememberSession),
    //    这里直接把它置上,模拟"本来就在跑某个任务"。
    rt.currentSessionId = "session-running";
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/stop" } }] });
    assert.equal(sub.calls.filter((c) => c.m === "cancelSession").length, 1,
      "免费档必须能急停(一个只会通知、连停都停不了的通道会让人觉得被挟持)");
  } finally {
    await ilink.close();
  }
});

test("★ 分层:档位取不到时沿用上次已知档位(绝不因一次网络抖动把付费用户降级)", async () => {
  const ilink = await fakeIlink();
  try {
    let answer = "pro";
    const sub1 = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, {
      subscriber: sub1, tier: "", tierProvider: async () => answer, tierDenyThrottleMs: 0
    });

    // 首次判档位时缓存为空(按免费)→ 被拒路径触发刷新 → 取到 pro → **同一条指令立即放行**
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/ls" } }] });
    assert.equal(sub1.calls.filter((c) => c.m === "listSessions").length, 1,
      "首次取到 pro 后就该放行(不能因为'一开始不知道'就把付费用户挡掉)");

    // 此后账号 API 一直取不到(返回空串)→ 必须**沿用 pro**。
    // ⚠️ 必须**主动**触发一次校准:光靠派发测不到 —— 缓存已是 pro 时 `#can` 直接放行,
    //    根本不会再走刷新那条路径(变异测试实测:不加这一步,"取不到就降级"的变异抓不到)。
    answer = "";
    assert.equal(await rt.refreshTierNow(), "pro",
      "★取不到档位时必须沿用上次的 pro —— 付过钱的用户不该因一次网络失败被判成免费");

    // 而且能力也真的还在(不只是内部字段好看)
    const sub2 = makeFakeSubscriber();
    rt.subscriber = sub2;
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/ls" } }] });
    assert.equal(sub2.calls.filter((c) => c.m === "listSessions").length, 1,
      "沿用 pro 期间,遥控能力必须仍然可用");
  } finally {
    await ilink.close();
  }
});

test("★ 分层:刚升级完立刻重试必须能进(不必重启 bridge)", async () => {
  const ilink = await fakeIlink();
  try {
    // 一开始服务端说 free → 交代任务被拒;用户买完后服务端改口 pro → 同一条指令必须能进。
    // tierDenyThrottleMs:0 把节流关掉,让这条路径确定性地可测(生产默认 5 秒,注释已写明)。
    let plan = "free";
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, {
      subscriber: sub, tier: "", tierProvider: async () => plan, tierDenyThrottleMs: 0
    });

    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 做点事" } }] });
    assert.equal(sub.calls.filter((c) => c.m === "createSession").length, 0, "免费时先拒");

    plan = "pro"; // 用户升级
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 做点事" } }] });
    assert.equal(sub.calls.filter((c) => c.m === "createSession").length, 1,
      "★升级后必须能进:否则用户付了钱还要重启 bridge 才能用");
  } finally {
    await ilink.close();
  }
});

test("★ v2:纯文本 = 交代任务 —— 没有当前会话时自动开新会话并下发", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "帮我修个 bug" } }] });
    const created = sub.calls.find((c) => c.m === "createSession");
    const prompted = sub.calls.find((c) => c.m === "promptSession");
    assert.ok(created, "没有当前会话时,第一条普通消息应开新会话");
    assert.equal(prompted && prompted.text, "帮我修个 bug", "任务文本必须原样下发");
    assert.match(lastText(ilink.state), /已开新任务/);
  } finally {
    await ilink.close();
  }
});

test("★ v2:有当前会话时纯文本进当前会话(不是每次开新的)", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 第一件事" } }] });
    sub.calls.length = 0;
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "再补充一句" } }] });
    const created = sub.calls.find((c) => c.m === "createSession");
    const prompted = sub.calls.find((c) => c.m === "promptSession");
    assert.ok(!created, "已有当前会话时**不得**再开新会话");
    assert.equal(prompted && prompted.sessionId, "session-new-1");
    assert.equal(prompted && prompted.text, "再补充一句");
  } finally {
    await ilink.close();
  }
});

test("★ v2 安全边界(业主拍板放宽):看不到内容照给一键回执,只看得出破坏性才降级", async () => {
  // 背景:DSH 的审批节点常常只下发 toolName、没有命令原文。原先「看不到内容也算破坏性」
  // 会把绝大多数正常 Bash 审批都降级成"只能回电脑确认" —— 过严。业主明确:DSH 自身有
  // 权限控制,安全边界可以松一点。所以现在**只看内容**。
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });

    // (a) 没有内容 → 按普通审批,保留一步回执
    await rt.notify({ kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "d2", toolName: "Bash", answerShape: "approval", at: 1 });
    const a = lastText(ilink.state);
    assert.match(a, /需要你拍板/, `看不到内容应是普通审批,实际:${a}`);
    assert.match(a, /回复 1/, "看不到内容必须仍给编号选项(放宽后的行为)");
    assert.equal(rt.pendingReplies.length, 1, "应登记为待答,用户能一键处理");

    // 回 1 必须真的能放行 —— 这是放宽后要保证的核心路径
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    const answered = sub.calls.filter((c) => c.m === "answerApproval");
    assert.equal(answered.length, 1, "普通审批必须能被微信一键放行");
    assert.equal(answered[0].value, "allowed-once");

    // (b) 内容里看得出破坏性 → 仍然降级,不给一键回执
    sub.calls.length = 0;
    await rt.notify({ kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "d1", toolName: "Bash", reason: "rm -rf /x", answerShape: "approval", at: 1 });
    const b = lastText(ilink.state);
    assert.match(b, /到电脑上确认/, `破坏性内容必须要求回电脑,实际:${b}`);
    assert.match(b, /内容.*破坏性/, "有内容时应说是**内容**被判定破坏性");
    assert.ok(!/回复 1/.test(b), "破坏性操作不得给编号选项");
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    assert.equal(sub.calls.filter((c) => c.m === "answerApproval").length, 0, "破坏性操作绝不能被一键放行");
  } finally {
    await ilink.close();
  }
});

test("★ v2:/ls 列出会话(带名称),/use N 切换并落盘", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    sub.sessionsFixture = [
      { sessionId: "session-aaa", title: "修复 Windows 兼容性", running: true, cwd: "/p" },
      { sessionId: "session-bbb", title: "写周报", running: false, cwd: "/p" }
    ];
    const { rt, relayDir } = await boundRuntime(ilink, { subscriber: sub });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/ls" } }] });
    const listed = lastText(ilink.state);
    assert.match(listed, /修复 Windows 兼容性/, `列表必须带会话名称,实际:${listed}`);
    assert.match(listed, /写周报/);

    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/use 2" } }] });
    assert.equal(rt.currentSessionId, "session-bbb");
    // 必须落盘 —— 否则 bridge 一重启,用户选好的任务就丢了,下一条消息会静默开成新任务
    assert.equal(loadState(relayDir).current_session_id, "session-bbb", "当前会话指针必须落盘");
  } finally {
    await ilink.close();
  }
});

test("★ v2:当前会话指针在重启后恢复(否则用户下一条消息会静默开成新任务)", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    sub.sessionsFixture = [{ sessionId: "session-zzz", title: "长任务", running: false, cwd: "/p" }];
    const { rt, relayDir } = await boundRuntime(ilink, { subscriber: sub });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/ls" } }] });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/use 1" } }] });

    // 模拟 bridge 重启:用同一个 relayDir 新建一个运行时
    const sub2 = makeFakeSubscriber();
    const rt2 = createWeChatRuntime({
      relayDir, upstream: "http://127.0.0.1:1", secret: SECRET,
      tier: "pro", // 本用例测的是"指针持久化",不是分层;按付费档跑才有"发消息"这条能力
      logger: quietLogger()
    });
    rt2.subscriber = sub2;
    assert.equal(rt2.currentSessionId, "session-zzz", "重启后必须还记得当前会话");
    await rt2.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "继续" } }] });
    const prompted = sub2.calls.find((c) => c.m === "promptSession");
    assert.equal(prompted && prompted.sessionId, "session-zzz", "重启后必须接着原会话,不能开新的");
  } finally {
    await ilink.close();
  }
});

test("★ v2:完成推送带会话名称 + 结论,而不只是「任务已停止」", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    sub.sessionsFixture = [{ sessionId: "session-s1", title: "修复 Windows 兼容性", running: false, cwd: "/p" }];
    sub.summaryFixture = "定位到 PATH 分隔符问题,已修复并验证。";
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/use 1" } }] });
    await rt.notify({ kind: NODE_KINDS.TURN_END, sessionId: "session-s1", reason: "completed", at: 1 });
    const text = lastText(ilink.state);
    assert.match(text, /修复 Windows 兼容性/, `必须带会话名称,实际:${text}`);
    assert.match(text, /PATH 分隔符/, `必须带结论,实际:${text}`);
    assert.match(text, /完成/, "正常完成不能读起来像失败");
  } finally {
    await ilink.close();
  }
});

test("★ 分层:免费档的完成推送不能承诺「回复就能接着做」,要改成会员说明 + App 链接", async () => {
  // 默认那句「回复这条消息就能接着这个会话往下做」对免费用户是**空头承诺**:
  // 他回复纯文本只会拿到付费引导。文案必须跟着档位走,否则用户会以为产品坏了。
  const APP_URL = "https://app.example/x/";
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    sub.sessionsFixture = [{ sessionId: "session-s1", title: "跑个长任务", running: false, cwd: "/p" }];
    sub.summaryFixture = "已完成。";
    const { rt } = await boundRuntime(ilink, { subscriber: sub, tier: "free", appUrl: APP_URL });
    rt.currentSessionId = "session-s1";
    await rt.notify({ kind: NODE_KINDS.TURN_END, sessionId: "session-s1", reason: "completed", at: 1 });
    const text = lastText(ilink.state);

    // 免费档照样要看得到"完成了 + 结论"(这是他的核心价值)
    assert.match(text, /完成/, "免费档必须照样收到完成通知");
    assert.match(text, /已完成/, "结论也要给");
    assert.ok(!/就能接着这个会话/.test(text),
      `★不得对免费用户承诺"回复就能接着做"(他做不到),实际:${text}`);
    assert.ok(text.includes(APP_URL), `★收尾要给出 App 链接,实际:${text}`);

    // 付费档:保留原话术(产品核心,别被这条改动误伤)
    const ilink2 = await fakeIlink();
    try {
      const sub2 = makeFakeSubscriber();
      sub2.sessionsFixture = [{ sessionId: "session-s1", title: "跑个长任务", running: false, cwd: "/p" }];
      sub2.summaryFixture = "已完成。";
      const { rt: rt2 } = await boundRuntime(ilink2, { subscriber: sub2, tier: "pro", appUrl: APP_URL });
      rt2.currentSessionId = "session-s1";
      await rt2.notify({ kind: NODE_KINDS.TURN_END, sessionId: "session-s1", reason: "completed", at: 1 });
      assert.match(lastText(ilink2.state), /就能接着这个会话/, "付费档必须保留「回复即续接」这句");
    } finally {
      await ilink2.close();
    }
  } finally {
    await ilink.close();
  }
});

test("★ 分层:/help 必须按档位如实分层(免费用户看到的清单里不能有他做不到的指令)", async () => {
  const APP_URL = "https://app.example/x/";
  const ilink = await fakeIlink();
  try {
    const free = await boundRuntime(ilink, { subscriber: makeFakeSubscriber(), tier: "free", appUrl: APP_URL });
    await free.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/help" } }] });
    const t = lastText(ilink.state);
    assert.match(t, /通知版/, "免费档的帮助要说明自己是通知版");
    assert.ok(t.includes(APP_URL), "免费档的帮助里必须带开通入口(App 链接)");
    assert.match(t, /会员功能/, "会员能力必须单独分组，不能混进「现在能用的」");
    // /new 只能出现在「会员功能」那一段之后 —— 混在前面就是骗人
    const memberAt = t.indexOf("会员功能");
    assert.ok(memberAt > -1 && t.indexOf("/new") > memberAt, "/new 不得出现在免费能力段里");

    const pro = await boundRuntime(ilink, { subscriber: makeFakeSubscriber(), tier: "pro", appUrl: APP_URL });
    await pro.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/help" } }] });
    const pt = lastText(ilink.state);
    assert.match(pt, /DSH 微信通道/, "付费档仍用完整帮助");
    assert.ok(!/通知版/.test(pt), "付费档不该被标成通知版");
  } finally {
    await ilink.close();
  }
});

test("★ 分层:免费用户打字「允许」(而不是回数字)时,要先把「回数字就能拍板」说在前面", async () => {
  // 回执只认纯数字(classifyInbound),而免费档的核心价值就是审批 ——
  // 用户很可能打字「允许」。这时只回一句付费提示,他会以为免费版什么都干不了。
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub, tier: "free", appUrl: "https://app.example/x/" });
    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "evt-1", toolName: "Read",
      reason: "读取文件", answerShape: "approval", at: 1
    });
    assert.ok(rt.pendingReplies.length > 0, "先得有一条待回执的消息");

    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "允许" } }] });
    const text = lastText(ilink.state);
    assert.match(text, /回一个数字/, `必须先告诉他怎么拍板,实际:${text}`);
    assert.match(text, /待你拍板/, "要说明确实有东西在等他决定");
    assert.ok(text.includes("https://app.example/x/"), "仍然要带上 App 链接");

    // 而回数字本身必须真的能拍板(免费档的核心价值不能被这条改动带坏)
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    assert.equal(sub.calls.filter((c) => String(c.m).startsWith("answer")).length, 1,
      "回数字必须照常完成审批");
  } finally {
    await ilink.close();
  }
});

test("★★ 日报发送失败时**不能**把当天标记为已发(否则当天再也不会补发)", async () => {
  // 旧实现先写 last_digest_day **再**发送 → 一旦这次没发出去(网络抖动),当天的简报就被烧掉。
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt, relayDir } = await boundRuntime(ilink, { subscriber: sub, tier: "pro" });
    // 让"现在"正好等于简报时刻,真实路径才会通过时刻闸门
    rt.digestHour = new Date().getHours();
    const stateOf = () => JSON.parse(fs.readFileSync(path.join(relayDir, ".wechat-state.json"), "utf8"));

    const origSend = rt.channel.client.sendMessage.bind(rt.channel.client);
    const sends = () => ilink.state.sends.length;

    // ① 发送失败 → 不得记账
    rt.channel.client.sendMessage = async () => { throw new Error("boom"); };
    await rt.runMaybeDigestNow();
    assert.ok(!stateOf().last_digest_day,
      "★发送失败时绝不能标记今天已发 —— 否则当天再也不会补发(旧实现的坑)");

    // ② 恢复发送 → 必须能补发成功并记账
    rt.channel.client.sendMessage = origSend;
    const n = sends();
    await rt.runMaybeDigestNow();
    assert.equal(sends(), n + 1, "恢复后应当补发一条");
    assert.ok(stateOf().last_digest_day, "补发成功后要记账");

    // ③ 已经发过 → 同一天不再重复
    await rt.runMaybeDigestNow();
    assert.equal(sends(), n + 1, "同一天只发一次(它兼作 24h 窗口心跳,不能刷屏)");
  } finally {
    await ilink.close();
  }
});

test("★ 日报:晚上发(不是早上)、内容是「今天干了啥」、带品牌露出", async () => {
  // 业主:「每天早上发『今日干了啥事儿』,这肯定不太对劲。应该是晚上发,比如晚上 6 点,发『今天干了啥』」
  // 且一天只发一次(它兼作 24h 推送窗口的心跳,早晚各一次就太频繁了)。
  assert.equal(rtmod.DEFAULT_DIGEST_HOUR, 18, "日报时刻必须是晚上 18 点,不能是早上 9 点");
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub, tier: "pro" });
    // 造出今天的数据:一个正常完成的任务 + 一次真的拍板
    await rt.notify({ kind: NODE_KINDS.TURN_END, sessionId: "s1", reason: "completed", at: 1 });
    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "a1", toolName: "Read",
      reason: "读配置", answerShape: "approval", at: 1
    });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    await rt.runDigestNow();
    const text = lastText(ilink.state);
    assert.match(text, /完成任务 1 个/, `日报要回顾**今天做了什么**,实际:${text}`);
    assert.match(text, /你在微信里拍板 1 次/, "拍板次数也要回顾(频道价值可见)");
    assert.match(text, /DSH 远程控制/, "要有品牌轻露出");
    assert.match(text, /回复/, "必须保留 24h 窗口心跳那句(靠用户回消息续期)");
    assert.doesNotMatch(text, /没有要做的事/, "不许再用「待办清单」的措辞");
  } finally {
    await ilink.close();
  }
});

test("★★ 会员到期提醒:提前 2 天 / 1 天 / 到期当天各提醒一次,同一天不重复", async () => {
  // 这条**以前根本不存在**:notifyMembershipExpiring() 只有定义、全仓零调用方 ——
  // 业主以为"提前两天发、提前一天也发",实际一次都没发过。这里锁住补上的触发点。
  const ilink = await fakeIlink();
  try {
    const DAY = 86_400_000;
    let info = { plan: "pro", plan_ends_at: Date.now() + 2 * DAY, trial_expires_at: null };
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub, tier: "pro" });
    rt.accountInfo = async () => info;

    const before = ilink.state.sends.length;
    await rt.runExpiryRemindNow();
    assert.equal(ilink.state.sends.length, before + 1, "提前 2 天必须发一条提醒");

    // 同一天、同一阈值:**不重复**
    await rt.runExpiryRemindNow();
    assert.equal(ilink.state.sends.length, before + 1, "同一个阈值一天只能提醒一次");

    // 提前 5 天:保持安静(只在 2/1/到期当天三个节点说话)
    info = { plan: "pro", plan_ends_at: Date.now() + 5 * DAY, trial_expires_at: null };
    await rt.runExpiryRemindNow();
    assert.equal(ilink.state.sends.length, before + 1, "提前 5 天不该打扰用户");

    // 提前 1 天:是新阈值 → 再发一次
    info = { plan: "pro", plan_ends_at: Date.now() + 1 * DAY, trial_expires_at: null };
    await rt.runExpiryRemindNow();
    assert.equal(ilink.state.sends.length, before + 2, "提前 1 天要再提醒一次");

    // 没有到期信息 / 取不到账号 → 什么都不发(宁可不发,也不拿猜的到期日骚扰)
    info = { plan: "pro", plan_ends_at: null, trial_expires_at: null };
    const n = ilink.state.sends.length;
    await rt.runExpiryRemindNow();
    assert.equal(ilink.state.sends.length, n, "没有到期日就不该发");

    rt.accountInfo = null;
    await rt.runExpiryRemindNow();
    assert.equal(ilink.state.sends.length, n, "没有 accountInfo 数据源就什么都不发");
  } finally {
    await ilink.close();
  }
});

test("★★ A:免费档「能续接已有会话、不能开新会话」(业主拍板的分级)", async () => {
  const ilink = await fakeIlink();
  try {
    // ① 免费 + **没有**当前会话 → 纯文本等于开新任务 → 必须被拒
    const subA = makeFakeSubscriber();
    const a = await boundRuntime(ilink, { subscriber: subA, tier: "free", appUrl: "https://app.example/x/" });
    await a.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "帮我修个 bug" } }] });
    assert.equal(subA.calls.filter((c) => c.m === "createSession").length, 0,
      "免费 + 无当前会话:不得开新任务");
    assert.match(lastText(ilink.state), /会员功能/, "要说明这是会员能力");

    // ② 免费 + **有**当前会话 → 纯文本必须放行(这就是"能接着聊")
    const subB = makeFakeSubscriber();
    const b = await boundRuntime(ilink, { subscriber: subB, tier: "free" });
    b.rt.currentSessionId = "session-x";
    b.rt.currentSessionTitle = "已有任务";
    await b.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "继续修" } }] });
    const prompted = subB.calls.filter((c) => c.m === "promptSession");
    assert.equal(prompted.length, 1, "★免费 + 有当前会话:必须能继续聊(业主要的就是这个)");
    assert.equal(prompted[0].text, "继续修", "内容要原样下发");

    // ③ 免费仍不能开新会话、不能切换会话
    const subC = makeFakeSubscriber();
    const c = await boundRuntime(ilink, { subscriber: subC, tier: "free" });
    c.rt.currentSessionId = "session-x";
    await c.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 新任务" } }] });
    assert.equal(subC.calls.filter((m) => m.m === "createSession").length, 0, "免费不得开新会话");
    await c.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/ls" } }] });
    assert.equal(subC.calls.filter((m) => m.m === "listSessions").length, 0, "免费不得列/切会话");
  } finally {
    await ilink.close();
  }
});

test("★★ B:免费档每月额度用完后引导升级;审批与指令不计数;付费档不限", async () => {
  const LIMITS = { free: { messages_per_month: 2 }, pro: { messages_per_month: 0 }, pro_max: { messages_per_month: 0 } };
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, {
      subscriber: sub, tier: "free", appUrl: "https://app.example/x/", limitTable: LIMITS
    });
    rt.currentSessionId = "s";
    rt.currentSessionTitle = "t";
    const send = () => rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "派活" } }] });

    // 审批与指令**不**吃额度:先做一次审批,额度不受影响
    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "q1", toolName: "Read",
      reason: "读配置", answerShape: "approval", at: 1
    });
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    assert.equal(sub.calls.filter((c) => c.m === "answerApproval").length, 1, "审批必须照常可用(安全阀不能吃额度)");

    await send(); await send();
    assert.equal(sub.calls.filter((c) => c.m === "promptSession").length, 2, "额度内 2 条应放行");

    await send();
    assert.equal(sub.calls.filter((c) => c.m === "promptSession").length, 2, "★超出额度后不得再派活");
    const text = lastText(ilink.state);
    assert.match(text, /额度已经用完/, `要说清是用完额度而不是报错,实际:${text}`);
    assert.ok(text.includes("https://app.example/x/"), "仍要给升级入口(App 链接)");

    // 付费档:同样连发 5 条都不受限
    const paid = makeFakeSubscriber();
    const p = await boundRuntime(ilink, { subscriber: paid, tier: "pro" });
    p.rt.currentSessionId = "s";
    for (let i = 0; i < 5; i += 1) {
      await p.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "派活" + i } }] });
    }
    assert.equal(paid.calls.filter((c) => c.m === "promptSession").length, 5, "付费档不限量");
  } finally {
    await ilink.close();
  }
});

test("★★ 权益包:服务端下发的 caps/limits 覆盖内置表(后台改权限无需发版)", async () => {
  const ilink = await fakeIlink();
  try {
    // ① 服务端给免费档额外开了 assign.new → 免费用户当场就能开新会话
    const subA = makeFakeSubscriber();
    const a = await boundRuntime(ilink, {
      subscriber: subA, tier: "free",
      entitlements: { rev: "r1", plan: "free", caps: ["notify", "approve", "assign.new", "assign.continue"], limits: { messages_per_month: 0 } }
    });
    await a.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 做点事" } }] });
    assert.equal(subA.calls.filter((c) => c.m === "createSession").length, 1,
      "服务端放开后,免费档也能开新会话(证明权限真的由配置决定)");

    // ② 反向:服务端把付费档的 assign 收掉 → 同一个付费用户立刻不能派活
    const subB = makeFakeSubscriber();
    const b = await boundRuntime(ilink, {
      subscriber: subB, tier: "pro",
      entitlements: { rev: "r2", plan: "pro", caps: ["notify", "approve", "status", "stop"], limits: {} }
    });
    b.rt.currentSessionId = "s";
    await b.rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "派活" } }] });
    assert.equal(subB.calls.filter((c) => c.m === "promptSession").length, 0,
      "服务端收权后付费档也不该能派活(收权必须真的生效)");
  } finally {
    await ilink.close();
  }
});

test("★★ 多条待审批:回数字必须答**最早那条**(先进先出),答完把下一条顶到底部", async () => {
  // 业主报的真 bug:「如果需要用户回应多条消息,而用户一开始只看到第一条审批消息,
  //   回应一个数字之后,流程就结束了。后面的几条消息没有让用户继续回应,直接提示为『未回应』」
  // 成因:旧实现按**栈顶(最新)**匹配数字,而微信是**从上往下读**的、消息位置一发出去就固定
  //   → 用户看着第 1 条回「1」,系统答了最后一条,第 1 条永远没人回应,DSH 最终标它「未回应」。
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub, tier: "pro" });

    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "e1", toolName: "Read",
      reason: "读配置", answerShape: "approval", at: 1
    });
    // 第二条到达时第一条还没被答 → 文案必须说明"不止这一条"
    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "e2", toolName: "Write",
      reason: "写文件", answerShape: "approval", at: 2
    });
    assert.equal(rt.pendingReplies.length, 2, "两条都该登记为待答");
    assert.match(lastText(ilink.state), /还有 2 条待拍板/,
      `★必须告诉用户"不止这一条",否则他以为答完就结束了,实际:${lastText(ilink.state)}`);

    // 回「1」→ 必须答**最早**的 e1
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    const answered = sub.calls.filter((c) => c.m === "answerApproval");
    assert.equal(answered.length, 1, "必须真的回执一条");
    assert.equal(answered[0].id, "e1", "★必须答**最早那条**(e1),而不是最新那条(e2)");

    // 答完还剩 1 条 → 必须把**下一条重发到底部**,用户直接在最新消息上回数字
    const after = lastText(ilink.state);
    assert.match(after, /还有 1 条待你拍板/, `★答完要把下一条顶到底部,实际:${after}`);
    assert.match(after, /回复 1/, "重发的提醒要带可回数字的选项");
    assert.match(after, /Write/, "要指明下一条是什么(工具名),用户才知道在批什么");

    // 再回一次 → 答掉 e2;队列空了就不该再发多余提醒
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    const all = sub.calls.filter((c) => c.m === "answerApproval");
    assert.equal(all.length, 2);
    assert.equal(all[1].id, "e2", "第二条应是 e2");
    assert.doesNotMatch(lastText(ilink.state), /待你拍板/, "队列空了就不该再发提醒");
  } finally {
    await ilink.close();
  }
});

test("★ v2 安全:破坏性审批不给回执选项,回数字也不产生任何回执", async () => {
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const { rt } = await boundRuntime(ilink, { subscriber: sub });
    await rt.notify({
      kind: NODE_KINDS.APPROVAL_REQUEST, eventId: "evt-d", toolName: "Bash",
      reason: "rm -rf /important", answerShape: "approval", at: 1
    });
    const text = lastText(ilink.state);
    assert.match(text, /到电脑上确认/);
    assert.ok(!/回复 1/.test(text), "破坏性操作不得给编号选项");
    assert.equal(rt.pendingReplies.length, 0, "不得登记为待答");

    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "1" } }] });
    const answers = sub.calls.filter((c) => String(c.m).startsWith("answer"));
    assert.equal(answers.length, 0, "破坏性操作绝不能被微信一键放行");
  } finally {
    await ilink.close();
  }
});

test("/quiet 后只推「要你决定」与报错,日常节点被静音", async () => {
  const ilink = await fakeIlink();
  try {
    const { rt, relayDir } = await boundRuntime(ilink);
    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/quiet" } }] });
    assert.equal(loadState(relayDir).quiet, true);

    const before = ilink.state.sends.length;
    const quieted = await rt.notify({ kind: NODE_KINDS.DIGEST_DUE, notified: 1, answered: 0, at: 1 });
    assert.equal(quieted.ok, false);
    assert.equal(quieted.reason, "quiet");
    assert.equal(ilink.state.sends.length, before, "免打扰期间日常节点不得发出");

    const urgent = await rt.notify({ kind: NODE_KINDS.SESSION_ERROR, detail: "boom", at: 1 });
    assert.equal(urgent.ok, true, "报错属于「必须放行」");
  } finally {
    await ilink.close();
  }
});

// ── ⑤ 控制面安全 ──────────────────────────────────────────────────────────

test("★ 控制面:无密钥一律 401,且只 bind 回环", async () => {
  const ilink = await fakeIlink();
  try {
    const { rt, relayDir } = await boundRuntime(ilink);
    const port = await rt.startControl();
    const base = `http://127.0.0.1:${port}`;

    const noAuth = await fetch(`${base}/wechat/status`);
    assert.equal(noAuth.status, 401, "无密钥必须 401");
    const badAuth = await fetch(`${base}/wechat/status`, { headers: { [CONTROL_HEADER]: "wrong" } });
    assert.equal(badAuth.status, 401);

    const ok = await fetch(`${base}/wechat/status`, { headers: { [CONTROL_HEADER]: SECRET } });
    assert.equal(ok.status, 200);

    // 发现文件里只有端口,没有密钥
    const disc = readControlFile(relayDir);
    assert.equal(disc.port, port);
    assert.equal(disc.header, CONTROL_HEADER);
    assert.ok(!JSON.stringify(disc).includes(SECRET), "发现文件绝不能包含密钥");

    // 服务确实只监听回环
    const addr = rt.controlServer.address();
    assert.equal(addr.address, "127.0.0.1", "控制面必须只 bind 127.0.0.1");
    await rt.stopControl();
  } finally {
    await ilink.close();
  }
});

test("★ 面板状态永不回显 bot_token", async () => {
  const ilink = await fakeIlink();
  try {
    const { rt } = await boundRuntime(ilink);
    const s = rt.status();
    const json = JSON.stringify(s);
    assert.ok(!json.includes("tok-abc"), `状态里泄漏了 token:${json}`);
    assert.ok(!("token" in s), "状态里不得出现 token 字段");
    assert.equal(s.bound, true, "绑定状态要如实反映");
  } finally {
    await ilink.close();
  }
});

test("没有 bridge_secret 时控制面拒绝一切(不能变成开放后门)", async () => {
  const ilink = await fakeIlink();
  try {
    const relayDir = tmp();
    saveAccount(relayDir, { token: "t", accountId: "b", baseUrl: ilink.baseUrl, userId: "u", boundAt: 1 });
    const rt = createWeChatRuntime({ relayDir, secret: "", logger: quietLogger() });
    const port = await rt.startControl();
    const r = await fetch(`http://127.0.0.1:${port}/wechat/status`, { headers: { [CONTROL_HEADER]: "" } });
    assert.equal(r.status, 403);
    await rt.stopControl();
  } finally {
    await ilink.close();
  }
});

// ── ⑥ 断线窗口要如实告知(§6 ②) ───────────────────────────────────────────

test("★ 断线窗口:订阅报 gap 时必须主动告知「可能漏了」,不能装作没事", async () => {
  const ilink = await fakeIlink();
  try {
    const { rt } = await boundRuntime(ilink);
    await rt.startChannel();
    await new Promise((r) => setTimeout(r, 120));
    const before = ilink.state.sends.length;
    rt.subscriber.emit("gap", { from: 1, to: 2 });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(ilink.state.sends.length > before, "gap 之后必须发出一条告知");
    assert.match(lastText(ilink.state), /补发|漏/);
    await rt.stop();
  } finally {
    await ilink.close();
  }
});

test("绑定态只有 bound/unbound 两态:未绑定时通道不启动、绑定后启动", async () => {
  const ilink = await fakeIlink();
  try {
    const relayDir = tmp();
    const rt = createWeChatRuntime({ relayDir, secret: SECRET, logger: quietLogger() });
    assert.equal(rt.status().bound, false);
    assert.equal(rt.status().channel_running, false);
    assert.equal(await rt.startChannel(), false, "未绑定不得启动长轮询");

    saveAccount(relayDir, { token: "t", accountId: "b", baseUrl: ilink.baseUrl, userId: "u", boundAt: 1 });
    const rt2 = createWeChatRuntime({ relayDir, secret: SECRET, logger: quietLogger() });
    rt2.subscriber = makeFakeSubscriber();
    assert.equal(await rt2.startChannel(), true);
    await rt2.stop();
  } finally {
    await ilink.close();
  }
});

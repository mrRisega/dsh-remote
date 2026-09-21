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
  s.digestDue = (d = {}) => ({ kind: NODE_KINDS.DIGEST_DUE, notified: d.notified, answered: d.answered, at: 1 });
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

test("★ 运营钩子:能力表是活代码 —— 每档能力可查,未知档位按最低档", () => {
  const { capabilitiesFor, WECHAT_CAPABILITY_TABLE } = rtmod;
  // 免费档今天必须**包含全部**能力(业主:当前免费开放给所有人)
  const free = capabilitiesFor("free");
  for (const cap of ["notify", "approve", "assign", "sessions", "summary"]) {
    assert.ok(free.includes(cap), `免费档今天必须有 ${cap}(当前全免费)`);
  }
  // 付费档是预留的:必须存在且是免费档的超集(加付费档 = 只改表,不动业务逻辑)
  const pro = capabilitiesFor("pro");
  for (const cap of free) assert.ok(pro.includes(cap), `付费档必须是免费档超集,缺 ${cap}`);
  assert.ok(pro.length > free.length, "付费档应比免费档多能力(否则钩子没意义)");
  // 未知/空档位按最低档处理 —— 宁可少给,不可误放
  assert.deepEqual(capabilitiesFor("nonexistent"), free);
  assert.deepEqual(capabilitiesFor(""), free);
  assert.deepEqual(capabilitiesFor(undefined), free);
  // 表是冻结的(防止运行期被改)
  assert.ok(Object.isFrozen(WECHAT_CAPABILITY_TABLE));
});

test("★ 运营钩子:能力表在派发路径上真的生效 —— 拿掉 assign 后交代任务被拒", async () => {
  // 这条守的是"钩子是活代码,不是文档":今天免费档含 assign 所以行为不变,
  // 但把 assign 从表里拿掉后,**派发必须真的拒绝**。
  const ilink = await fakeIlink();
  try {
    const sub = makeFakeSubscriber();
    const relayDir = tmp();
    saveAccount(relayDir, { token: "tok", accountId: "b", baseUrl: ilink.baseUrl, userId: "u", boundAt: 1 });
    const rt = createWeChatRuntime({
      relayDir, upstream: "http://127.0.0.1:1", secret: SECRET, logger: quietLogger(),
      // 注入一张"免费档不含 assign"的表,模拟将来把该能力收进付费档
      capabilityTable: { free: ["notify"], pro: ["notify", "approve", "assign", "sessions", "summary"] }
    });
    rt.subscriber = sub;

    await rt.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 做点事" } }] });
    assert.equal(sub.calls.filter((c) => c.m === "createSession").length, 0, "不含 assign 时不得真的建会话");
    assert.match(lastText(ilink.state), /当前档位/, `必须给出可照做的拒绝理由,实际:${lastText(ilink.state)}`);

    // 默认档位(不注入)必须仍然可用 —— 业主:当前免费开放给所有人
    const rt2 = createWeChatRuntime({ relayDir, upstream: "http://127.0.0.1:1", secret: SECRET, logger: quietLogger() });
    rt2.subscriber = makeFakeSubscriber();
    await rt2.handleInbound({ from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/new 做点事" } }] });
    assert.equal(rt2.subscriber.calls.filter((c) => c.m === "createSession").length, 1, "默认(免费档)今天必须能交代任务");
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

/**
 * im-commands — 三家 IM 机器人共用命令层单测（2026-11-08）。
 *
 * 纯函数 + 注入式执行器，覆盖：解析（大小写/参数/未知）、/help 全命令、未知命令不转发、
 * 免费档 /ls /use 被拦 + 升级文案、/stop 免费立即生效、/use 越界/缺参、/status 与快照同源、
 * /unbind 免费、命令回复不含裸表格、写配置 sessionId（保留其它段）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  IM_COMMANDS,
  commandAllowed,
  executeImCommand,
  helpText,
  lsText,
  parseImCommand,
  writeImBotsSession
} from "../im-commands.mjs";
import { freeCaps, paidCaps } from "./im-caps-fixture.mjs";
import { fileMode } from "../wecom-bot.mjs";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-imcmd-")); }

function sessionsFixture() {
  const rows = [
    { sessionId: "session-alpha", title: "重构支付回调链路（很长的标题会被截断到二十四字以内）", updatedAt: Date.UTC(2026, 10, 8, 1, 30), running: true },
    { sessionId: "session-beta", title: "修端口探测", updatedAt: Date.UTC(2026, 10, 7, 22, 0) },
    { sessionId: "session-gamma", title: "写测试", updatedAt: 0 }
  ];
  return async () => rows;
}

/** 一个记录调用的 ctx（各用例按需覆盖）。 */
function makeCtx(over = {}) {
  const calls = { switch: [], cancel: [], unbind: 0 };
  const ctx = {
    caps: freeCaps(),
    tier: "free",
    appUrl: "https://app.test/",
    channelLabel: "钉钉",
    sessions: sessionsFixture(),
    currentSessionId: () => "session-alpha",
    currentSessionTitle: "重构支付回调链路",
    switchSession: async (arg) => { calls.switch.push(arg); return { ok: true }; },
    cancelSession: async (arg) => { calls.cancel.push(arg); return { ok: true }; },
    unbind: async () => { calls.unbind += 1; return { ok: true }; },
    statusSnapshot: async () => ({
      connected: true, authenticated: true, state: "connected", lastError: "",
      tier: "free", usage: { month: "2026-11", messages: 3 }, messagesPerMonth: 20, remainingMessages: 17,
      currentSessionId: "session-alpha", currentSessionTitle: "重构支付回调链路"
    }),
    ...over
  };
  return { ctx, calls };
}

const run = (text, ctx) => executeImCommand({ text, ctx });
const assertNoRawTable = (text) => {
  assert.ok(!/\|\s*-{2,}/.test(text), `不得含表格分隔行：${text}`);
  assert.ok(!/^\s*\|.*\|\s*$/m.test(text), `不得含裸表格行：${text}`);
};

// ─────────────────────────── 解析 ───────────────────────────

test("parseImCommand：命令/大小写/参数/未知；普通文本返回 null", () => {
  assert.deepEqual(parseImCommand("/help"), { name: "/help", arg: "", rest: "", unknown: false, raw: "/help" });
  assert.equal(parseImCommand("/HELP").name, "/help", "大小写不敏感");
  assert.equal(parseImCommand("  /Status  ").name, "/status");
  assert.equal(parseImCommand("/use 3").arg, "3");
  assert.equal(parseImCommand("/use").arg, "");
  assert.equal(parseImCommand("/use   abc").arg, "abc");
  assert.equal(parseImCommand("/ls 额外 参数").arg, "额外");
  assert.equal(parseImCommand("/").unknown, true, "光一个 / 算未知命令");
  assert.equal(parseImCommand("/wat").unknown, false);
  assert.equal(parseImCommand("hello"), null, "普通文本不是命令");
  assert.equal(parseImCommand("ls"), null);
  assert.equal(parseImCommand("  /help 看下  ").arg, "看下");
});

// ─────────────────────────── /help / 未知 ───────────────────────────

test("★ /help：列出全部命令（免费/会员标注），免费档看到会员命令标注", async () => {
  const { ctx } = makeCtx();
  const r = await run("/help", ctx);
  assert.equal(r.handled, true);
  assert.equal(r.ok, true);
  for (const c of IM_COMMANDS) assert.ok(r.text.includes(c.usage), `/help 必须包含 ${c.usage}`);
  assert.match(r.text, /命令不会发给模型/);
  assert.match(r.text, /\/stop/);
  assert.match(r.text, /\/unbind/);
  assert.match(r.text, /会员/, "免费档要标注会员命令");
  assertNoRawTable(r.text);
});

test("★ 未知命令：不转发给模型（handled=true），回「未知命令 + 帮助」", async () => {
  let promptCalls = 0;
  const { ctx } = makeCtx();
  const r = await run("/deploy now", ctx);
  assert.equal(r.handled, true, "★ 未知 /xxx 必须被命令层拦下");
  assert.ok(promptCalls === 0);
  assert.match(r.text, /未知命令：\/deploy/);
  assert.match(r.text, /\/help/);
  assertNoRawTable(r.text);
  // 非命令文本仍返回 handled:false（照旧进模型）
  const normal = await run("帮我改一下代码", ctx);
  assert.deepEqual(normal, { handled: false });
});

// ─────────────────────────── 能力门禁 ───────────────────────────

test("★ 免费档 /ls、/use 被拦：回会员文案 + /app/promo；命令不进模型", async () => {
  const { ctx } = makeCtx();
  const ls = await run("/ls", ctx);
  assert.equal(ls.handled, true);
  assert.equal(ls.gated, true);
  assert.match(ls.text, /会员功能/);
  assert.match(ls.text, /https:\/\/app\.test\/promo/);
  assert.match(ls.text, /免费可用/);
  assertNoRawTable(ls.text);
  const use = await run("/use 1", ctx);
  assert.equal(use.gated, true);
  assert.match(use.text, /\/use 是会员功能/);
  // 免费命令不受影响
  for (const cmd of ["/help", "/status", "/stop", "/unbind"]) {
    const r = await run(cmd, ctx);
    assert.equal(r.gated, undefined, `${cmd} 必须免费可用`);
    assert.equal(r.handled, true);
  }
});

// ─────────────────────────── /ls ───────────────────────────

test("★ /ls（会员）：≤10 条、标题截断 24、索引 + 当前标记 + 更新时间；不含裸表格", async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ sessionId: `session-${i}`, title: `会话 ${i} 号很长的标题需要被截断处理一下`, updatedAt: Date.UTC(2026, 10, 8, 10, i % 60) }));
  const { ctx } = makeCtx({ caps: paidCaps(), sessions: async () => many, currentSessionId: () => "session-3" });
  const r = await run("/ls", ctx);
  assert.equal(r.ok, true);
  const lines = r.text.split("\n").filter((l) => /^\d+\. /.test(l));
  assert.equal(lines.length, 10, "最多 10 条");
  assert.match(r.text, /1\. 会话 0 号/);
  assert.match(r.text, /4\. 会话 3 号[^\n]*（当前）/, "当前会话要有标记");
  assert.match(r.text, /· \d{2}-\d{2} \d{2}:\d{2}/, "带更新时间");
  for (const line of lines) {
    const titlePart = line.replace(/^\d+\. /, "").split(" ")[0];
    assert.ok(Array.from(titlePart.replace(/…$/, "")).length <= 24, `标题超过 24 字：${line}`);
  }
  assert.match(r.text, /\/use <序号>/);
  assertNoRawTable(r.text);
});

test("/ls：没有会话时给可操作提示", async () => {
  const { ctx } = makeCtx({ caps: paidCaps(), sessions: async () => [] });
  const r = await run("/ls", ctx);
  assert.equal(r.ok, true);
  assert.match(r.text, /最近没有可列出的会话/);
  assert.match(r.text, /打开\/运行一个会话/);
});

// ─────────────────────────── /use ───────────────────────────

test("★ /use <N>：合法序号切换（写配置由 ctx.switchSession 完成）+ 回执", async () => {
  const { ctx, calls } = makeCtx({ caps: paidCaps() });
  const r = await run("/use 2", ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.switch, [{ sessionId: "session-beta", title: "修端口探测" }]);
  assert.match(r.text, /已切换到 #2 修端口探测/);
});

test("★ /use 越界 / 缺参 / 无会话：给可操作提示，不崩", async () => {
  const { ctx, calls } = makeCtx({ caps: paidCaps() });
  const out = await run("/use 99", ctx);
  assert.equal(out.ok, true, "越界是提示不是崩溃");
  assert.match(out.text, /序号超出范围：当前列表是 1-3/);
  assert.match(out.text, /\/ls/);
  assert.equal(calls.switch.length, 0);
  const missing = await run("/use", ctx);
  assert.match(missing.text, /用法：\/use <序号>/);
  const none = await run("/use 1", makeCtx({ caps: paidCaps(), sessions: async () => [] }).ctx);
  assert.match(none.text, /没有可切换的会话/);
  const failing = await run("/use 1", makeCtx({ caps: paidCaps(), switchSession: async () => ({ ok: false, reason: "写配置失败" }) }).ctx);
  assert.match(failing.text, /切换失败：写配置失败/);
});

// ─────────────────────────── /stop / /status / /unbind ───────────────────────────

test("★ /stop：免费可用、立即调 cancelSession、回执明确（没会话给说明）", async () => {
  const { ctx, calls } = makeCtx();
  const r = await run("/stop", ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.cancel, [{ sessionId: "session-alpha" }]);
  assert.match(r.text, /已急停：重构支付回调链路/);
  // 无会话
  const none = await run("/stop", makeCtx({ currentSessionId: () => "" }).ctx);
  assert.match(none.text, /没有正在运行的会话/);
  // 取消失败要给"没收到确认"
  const fail = await run("/stop", makeCtx({ cancelSession: async () => ({ ok: false, message: "通道断开" }) }).ctx);
  assert.match(fail.text, /没收到确认：通道断开/);
});

test("★ /status：连接状态 + 当前会话 + 本月剩余（与状态快照同源；不限量显示不限）", async () => {
  const { ctx } = makeCtx();
  const r = await run("/status", ctx);
  assert.equal(r.ok, true);
  assert.match(r.text, /连接状态/);
  assert.match(r.text, /✅ 已连接/);
  assert.match(r.text, /当前会话：重构支付回调链路/);
  assert.match(r.text, /本月指令：已用 3\/20/);
  assert.match(r.text, /剩余：17 条/);
  assertNoRawTable(r.text);
  // 付费不限量
  const pro = await run("/status", makeCtx({
    caps: paidCaps(), tier: "pro",
    statusSnapshot: async () => ({ connected: false, state: "reconnecting", tier: "pro", usage: { messages: 0 }, messagesPerMonth: 0, currentSessionId: "" })
  }).ctx);
  assert.match(pro.text, /未连接（reconnecting/);
  assert.match(pro.text, /本月指令：不限（pro）/);
  assert.match(pro.text, /当前会话：未选择/);
});

test("★ /unbind：免费可用、任何人可退订（调 unbind + 明确回执）", async () => {
  const { ctx, calls } = makeCtx();
  const r = await run("/unbind", ctx);
  assert.equal(r.ok, true);
  assert.equal(calls.unbind, 1);
  assert.match(r.text, /已解绑/);
  assert.match(r.text, /重新绑定/);
});

// ─────────────────────────── 执行器健壮性 / 配置写入 ───────────────────────────

test("执行器：ctx 抛错也返回 handled:true（命令层绝不把异常漏给模型）", async () => {
  const r = await run("/ls", makeCtx({ caps: paidCaps(), sessions: async () => { throw new Error("订阅器挂了"); } }).ctx);
  assert.equal(r.handled, true);
  assert.match(r.text, /命令执行失败：订阅器挂了/);
});

test("★ writeImBotsSession：写对应通道的 sessionId/sessionTitle（保留其它段，0600）", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "im-bots.json"), JSON.stringify({
      version: 1,
      wecom: { enabled: true, botId: "b" },
      dingtalk: { enabled: true, clientId: "c" },
      feishu: { enabled: false }
    }), { mode: 0o600 });
    const r = writeImBotsSession(dir, "dingtalk", { sessionId: "session-beta", sessionTitle: "修端口探测" });
    assert.equal(r.ok, true);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, "im-bots.json"), "utf8"));
    assert.equal(disk.dingtalk.sessionId, "session-beta");
    assert.equal(disk.dingtalk.sessionTitle, "修端口探测");
    assert.equal(disk.dingtalk.clientId, "c", "其它字段保留");
    assert.equal(disk.wecom.botId, "b", "其它通道段保留");
    if (process.platform !== "win32") assert.equal(fileMode(path.join(dir, "im-bots.json")) & 0o777, 0o600);
    // 非法参数
    assert.equal(writeImBotsSession(dir, "", {}).ok, false);
    assert.equal(writeImBotsSession(dir, "dingtalk", { sessionId: "" }).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("helpText/commandAllowed：能力表判断与 /help 文案一致（单一真相源）", () => {
  assert.equal(commandAllowed(IM_COMMANDS.find((c) => c.name === "/stop"), []), true, "急停不需要能力");
  assert.equal(commandAllowed(IM_COMMANDS.find((c) => c.name === "/ls"), freeCaps()), false);
  assert.equal(commandAllowed(IM_COMMANDS.find((c) => c.name === "/ls"), paidCaps()), true);
  const paidHelp = helpText({ caps: paidCaps(), appUrl: "https://a/" });
  assert.match(paidHelp, /你的档位已包含会话管理/);
  const freeHelp = helpText({ caps: freeCaps() });
  assert.ok(!/已包含会话管理/.test(freeHelp));
});

test("三家接线（源级契约）：wecom/dingtalk/feishu 都在进模型前调用命令层", () => {
  for (const file of ["wecom-bot.mjs", "dingtalk-bot.mjs", "feishu-bot.mjs"]) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(/from "\.\/im-commands\.mjs"/.test(src), `${file} 必须 import im-commands.mjs`);
    assert.ok(/executeImCommand\(/.test(src), `${file} 必须调用 executeImCommand`);
    const cmdAt = src.indexOf("executeImCommand(");
    const promptAt = src.indexOf("promptSession(");
    assert.ok(cmdAt > -1 && (promptAt === -1 || cmdAt < promptAt), `${file} 命令层必须出现在 promptSession 之前（cmdAt=${cmdAt}, promptAt=${promptAt}）`);
  }
});

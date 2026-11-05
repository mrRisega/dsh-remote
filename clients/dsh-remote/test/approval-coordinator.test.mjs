import test from "node:test";
import assert from "node:assert/strict";

import { createApprovalCoordinator, DENY_MESSAGES, MAX_PENDING_APPROVALS } from "../approval-coordinator.mjs";

/** 可控假时钟：手动 flush 到点的定时器。 */
function makeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeoutImpl(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms, at: ms });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    /** 触发所有到点的定时器（简单起见：全部触发）。 */
    fireAll() {
      const list = [...timers.entries()].slice();
      for (const [id, t] of list) { timers.delete(id); t.fn(); }
      return list.length;
    },
    count() { return timers.size; }
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test("① 手机点允许 → ask() 返回 allow（只允许一次，由调用方映射）", async () => {
  const clock = makeClock();
  const reports = [];
  const c = createApprovalCoordinator({
    report: (p) => { reports.push(p); },
    ...clock
  });
  const p = c.ask({ requestId: "r1", toolName: "Bash", detail: "npm run deploy" });
  assert.deepEqual(c._pendingIds(), ["r1"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].requestId, "r1");
  assert.equal(reports[0].summary, "npm run deploy");
  assert.equal(c.resolve("r1", "allow"), true);
  assert.deepEqual(await p, { decision: "allow", message: undefined });
  assert.equal(c.status().allowed, 1);
  assert.equal(clock.count(), 0, "settle 后必须清掉定时器");
});

test("② 手机点拒绝 → deny，且带拒绝说明", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const p = c.ask({ requestId: "r2", toolName: "Write" });
  assert.equal(c.resolve("r2", "deny"), true);
  const r = await p;
  assert.equal(r.decision, "deny");
  assert.equal(c.status().denied, 1);
});

test("③ TTL 到点 → 必须 deny（fail-closed：没人拍板 ≠ 同意）", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ttlMs: 90_000, ...clock });
  const p = c.ask({ requestId: "r3", toolName: "Bash", detail: "rm -rf build" });
  assert.equal(clock.fireAll(), 1);
  const r = await p;
  assert.equal(r.decision, "deny");
  assert.equal(r.message, DENY_MESSAGES.timeout);
  assert.equal(c.status().expired, 1);
});

test("④ 重复 resolve 幂等返回 false（不覆盖第一次决定）", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const p = c.ask({ requestId: "r4" });
  assert.equal(c.resolve("r4", "allow"), true);
  assert.equal(c.resolve("r4", "deny"), false);
  assert.equal((await p).decision, "allow");
});

test("⑤ 不认识的 requestId → resolve 返回 false（交给 DSH 那条路处理）", () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  assert.equal(c.resolve("not-mine", "allow"), false);
});

test("⑥ 并发上限：超过上限直接拒绝，不让第 9 条挂着", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const ps = [];
  for (let i = 0; i < MAX_PENDING_APPROVALS; i++) ps.push(c.ask({ requestId: "ok-" + i }));
  const over = await c.ask({ requestId: "over-1" });
  assert.equal(over.decision, "deny");
  assert.equal(over.message, DENY_MESSAGES.overflow);
  assert.equal(c.status().overflow, 1);
  // 清理：全部决议掉，避免悬挂
  for (let i = 0; i < MAX_PENDING_APPROVALS; i++) c.resolve("ok-" + i, "deny");
  await Promise.all(ps);
});

test("⑦ 同一请求重复 ask（钩子重试）复用同一个 Promise，且只上报一次", async () => {
  const clock = makeClock();
  let reports = 0;
  const c = createApprovalCoordinator({ report: () => { reports += 1; }, ...clock });
  const p1 = c.ask({ requestId: "dup" });
  const p2 = c.ask({ requestId: "dup" });
  assert.equal(p1, p2);
  assert.equal(reports, 1);
  c.resolve("dup", "allow");
  assert.deepEqual(await p1, { decision: "allow", message: undefined });
});

test("⑧ stop() 把全部未决审批结算为拒绝（绝不留悬挂 Promise）", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const p1 = c.ask({ requestId: "s1" });
  const p2 = c.ask({ requestId: "s2" });
  const n = c.stop();
  assert.equal(n, 2);
  assert.equal((await p1).decision, "deny");
  assert.equal((await p2).decision, "deny");
  assert.equal(c._pendingIds().length, 0);
  // stop 之后新请求立即拒绝，不再挂着
  const r = await c.ask({ requestId: "s3" });
  assert.equal(r.decision, "deny");
  assert.equal(r.message, DENY_MESSAGES.stopped);
});

test("⑨ 上报抛错不影响超时兜底（不会挂死钩子）", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({
    report: () => { throw new Error("network down"); },
    ...clock
  });
  const p = c.ask({ requestId: "r9" });
  assert.equal(clock.fireAll(), 1);
  const r = await p;
  assert.equal(r.decision, "deny");
});

test("⑩ 没有上报通道时也能工作（到点拒绝），并告警一次", async () => {
  const clock = makeClock();
  const warnings = [];
  const c = createApprovalCoordinator({
    log: (lvl, msg) => { if (lvl === "warn") warnings.push(msg); },
    ...clock
  });
  const p = c.ask({ requestId: "r10" });
  clock.fireAll();
  assert.equal((await p).decision, "deny");
  assert.ok(warnings.some((w) => /没有上报通道/.test(w)));
});

test("⑪ 日志不含命令原文（隐私）；只含 requestId/toolName/结论", async () => {
  const clock = makeClock();
  const logs = [];
  const c = createApprovalCoordinator({
    report: () => true,
    log: (lvl, msg) => logs.push(msg),
    ...clock
  });
  const p = c.ask({ requestId: "r11", toolName: "Bash", detail: "rm -rf /important" });
  c.resolve("r11", "allow");
  await p;
  const all = logs.join("\n");
  assert.ok(!all.includes("rm -rf /important"), "日志绝不能出现命令原文");
  assert.match(all, /r11/);
});

test("⑫ 缺 requestId 的请求直接拒绝（不挂起）", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const r = await c.ask({ toolName: "Bash" });
  assert.equal(r.decision, "deny");
  assert.equal(c._pendingIds().length, 0);
});

test("⑬ status() 字段齐全（面板/诊断用）", () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const st = c.status();
  for (const k of ["asked", "allowed", "denied", "expired", "overflow", "pending", "ttlMs", "maxPending"]) {
    assert.ok(k in st, "status 缺字段 " + k);
  }
  assert.equal(st.ttlMs, 90_000);
});

test("⑭ resolve 后立刻 await 能拿到结果（微任务级，不需要额外 tick）", async () => {
  const clock = makeClock();
  const c = createApprovalCoordinator({ report: () => true, ...clock });
  const p = c.ask({ requestId: "fast" });
  c.resolve("fast", "allow");
  const r = await p;
  assert.equal(r.decision, "allow");
  await flush();
});

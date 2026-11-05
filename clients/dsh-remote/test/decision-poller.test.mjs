import test from "node:test";
import assert from "node:assert/strict";

import { createDecisionPoller, toDshOutcome, MAX_ITEMS_PER_TICK } from "../decision-poller.mjs";

/** 按脚本返回的假 fetch；记录每次调用。 */
function makeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift();
    if (!step) throw new Error("fetch script exhausted: " + url);
    if (step instanceof Error) throw step;
    return {
      status: step.status ?? 200,
      async json() { return step.body ?? { ok: true }; }
    };
  };
  fn.calls = calls;
  return fn;
}

function mk(opts) {
  return createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async () => ({ ok: true }),
    fetchImpl: makeFetch([]),
    ...opts
  });
}

test("① 手机 decision → DSH outcome：allow 只能是 allowed-once，未知一律拒绝", () => {
  assert.equal(toDshOutcome("allow"), "allowed-once");
  assert.equal(toDshOutcome("deny"), "rejected");
  assert.equal(toDshOutcome("weird"), "rejected");
  assert.equal(toDshOutcome(""), "rejected");
  assert.equal(toDshOutcome(undefined), "rejected");
  // 绝不把 allow 映射成永久放行
  assert.notEqual(toDshOutcome("allow"), "allowed-always");
});

test("② start 门禁：缺 apiBase / deviceId / apply 都不启动", () => {
  assert.equal(mk({ apiBase: "" }).start().lastError, "no_api_base");
  assert.equal(mk({ deviceId: "" }).start().lastError, "no_device");
  assert.equal(mk({ apply: null }).start().lastError, "no_apply");
  assert.equal(mk().start().started, true);
  mk().stop();
});

test("③ happy path：拉取 → 应用 → ack，参数正确", async () => {
  const applied = [];
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, items: [
      { id: "d1", event_id: "dev-x:approval:evt_1", request_id: "evt_1", decision: "allow", decided_at: 1, expires_at: Date.now() + 60000 }
    ] } },
    { status: 200, body: { ok: true, acked: 1 } }
  ]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async (item) => { applied.push(item); },
    fetchImpl,
    intervalMs: 60_000
  });
  await p._tick();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].request_id, "evt_1");
  assert.equal(applied[0].decision, "allow");
  assert.equal(applied[0].outcome, "allowed-once");
  // 第一个请求是 pending（带 device_id），第二个是 ack
  assert.match(fetchImpl.calls[0].url, /\/api\/notify\/pending\?device_id=dev-x/);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, "Bearer tok");
  assert.match(fetchImpl.calls[1].url, /\/api\/notify\/ack$/);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body).ids, ["d1"]);
  assert.equal(p.status().applied, 1);
  assert.equal(p.status().acked, 1);
  p.stop();
});

test("④ apply 抛错也必须 ack（否则每 3s 重放同一条）", async () => {
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, items: [
      { id: "d1", event_id: "e1", request_id: "evt_1", decision: "deny", expires_at: Date.now() + 60000 }
    ] } },
    { status: 200, body: { ok: true } }
  ]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async () => { throw new Error("session gone"); },
    fetchImpl
  });
  await p._tick();
  assert.equal(p.status().applied, 0);
  assert.equal(p.status().failed, 1);
  assert.match(fetchImpl.calls[1].url, /\/api\/notify\/ack$/);
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body).ids, ["d1"]);
  p.stop();
});

test("⑤ 已过期条目：不应用，但要 ack 掉避免反复拉", async () => {
  const applied = [];
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, items: [
      { id: "old", event_id: "e", request_id: "evt_old", decision: "allow", expires_at: Date.now() - 1000 }
    ] } },
    { status: 200, body: { ok: true } }
  ]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async (i) => { applied.push(i); },
    fetchImpl
  });
  await p._tick();
  assert.equal(applied.length, 0, "过期决策绝不能应用");
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body).ids, ["old"]);
  p.stop();
});

test("⑥ 401：不应用、不 ack、不抛", async () => {
  const applied = [];
  const fetchImpl = makeFetch([{ status: 401 }]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "expired",
    apply: async (i) => { applied.push(i); },
    fetchImpl
  });
  await p._tick();
  assert.equal(applied.length, 0);
  assert.equal(p.status().lastError, "auth_failed");
  assert.equal(fetchImpl.calls.length, 1, "401 后不应再发 ack");
  p.stop();
});

test("⑦ 没有 token：一个请求都不发", async () => {
  const fetchImpl = makeFetch([]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "",
    apply: async () => {},
    fetchImpl
  });
  await p._tick();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(p.status().lastError, "no_token");
  p.stop();
});

test("⑧ ack 失败不影响主流程（幂等，下轮重复拉也没副作用）", async () => {
  const applied = [];
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, items: [
      { id: "d1", event_id: "e", request_id: "evt_1", decision: "allow", expires_at: Date.now() + 60000 }
    ] } },
    { status: 500, body: { ok: false } }
  ]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async (i) => { applied.push(i); },
    fetchImpl
  });
  await p._tick();
  assert.equal(applied.length, 1);
  assert.equal(p.status().acked, 0);
  p.stop();
});

test("⑨ 单次最多处理 20 条（有界，避免并发打爆 dsh）", async () => {
  const items = Array.from({ length: 35 }, (_, i) => ({
    id: "d" + i, event_id: "e" + i, request_id: "evt_" + i, decision: "deny", expires_at: Date.now() + 60000
  }));
  const applied = [];
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, items } },
    { status: 200, body: { ok: true } }
  ]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async (i) => { applied.push(i); },
    fetchImpl
  });
  await p._tick();
  assert.equal(applied.length, MAX_ITEMS_PER_TICK);
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).ids.length, MAX_ITEMS_PER_TICK);
  p.stop();
});

test("⑩ 未知 decision 值按 deny 处理（fail-closed）", async () => {
  const applied = [];
  const fetchImpl = makeFetch([
    { status: 200, body: { ok: true, items: [
      { id: "d1", event_id: "e", request_id: "evt_1", decision: "maybe", expires_at: Date.now() + 60000 }
    ] } },
    { status: 200, body: { ok: true } }
  ]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async (i) => { applied.push(i); },
    fetchImpl
  });
  await p._tick();
  assert.equal(applied[0].decision, "deny");
  assert.equal(applied[0].outcome, "rejected");
  p.stop();
});

test("⑪ 网络异常吞掉，不抛、不崩", async () => {
  const fetchImpl = makeFetch([new Error("ECONNRESET")]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async () => {},
    fetchImpl
  });
  await p._tick();
  assert.match(p.status().lastError, /ECONNRESET/);
  p.stop();
});

test("⑫ stop() 后不再轮询", async () => {
  const fetchImpl = makeFetch([]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com",
    deviceId: "dev-x",
    tokenProvider: () => "tok",
    apply: async () => {},
    fetchImpl,
    intervalMs: 10
  });
  p.start();
  p.stop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fetchImpl.calls.length, 0, "stop 后不应再发任何请求");
});

test("⑬ 403 device_mismatch / 400 invalid_device_id：停止轮询（重试永远不会成功）", async () => {
  const f1 = makeFetch([{ status: 403 }]);
  const p1 = createDecisionPoller({
    apiBase: "https://api.example.com", deviceId: "dev-x", tokenProvider: () => "tok",
    apply: async () => {}, fetchImpl: f1, intervalMs: 10
  });
  p1.start();
  await p1._tick();
  assert.equal(p1.status().lastError, "device_mismatch");
  const before = f1.calls.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f1.calls.length, before, "403 之后不应再轮询");
  p1.stop();

  const f2 = makeFetch([{ status: 400 }]);
  const p2 = createDecisionPoller({
    apiBase: "https://api.example.com", deviceId: "dev-x", tokenProvider: () => "tok",
    apply: async () => {}, fetchImpl: f2, intervalMs: 10
  });
  await p2._tick();
  assert.equal(p2.status().lastError, "invalid_device_id");
  p2.stop();
});

test("⑭ 401 之后仍会继续轮询（token 刷新后要能恢复）", async () => {
  const f = makeFetch([{ status: 401 }]);
  const p = createDecisionPoller({
    apiBase: "https://api.example.com", deviceId: "dev-x", tokenProvider: () => "expired",
    apply: async () => {}, fetchImpl: f, intervalMs: 10
  });
  p.start();
  await p._tick();
  assert.equal(p.status().lastError, "auth_failed");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(f.calls.length >= 2, "401 不应停止轮询（等 token 刷新）");
  p.stop();
});

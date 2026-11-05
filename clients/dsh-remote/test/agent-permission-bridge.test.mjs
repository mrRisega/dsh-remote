#!/usr/bin/env node
/**
 * PermissionBridge 契约测试 —— 本轮最核心的模块。
 *
 * 每条用例都对着第 1 周**实测**结论写（报告 §2/§3）：
 *   ① 响应体形状：只有 `hookSpecificOutput.hookEventName + decision.behavior` 生效，
 *      其他形状一律等于"无决策 = 拒绝"（所以异常输入我们**不返回 allow**）；
 *   ② 超时 = 拒绝：TTL 到期必须 deny，绝不"没回复就放行"；
 *   ③ token / 事件名 / 体积 / 并发 四道闸，任何一道不过都不放行；
 *   ④ 临时 settings 只写权限钩子、0600、`stop()` 必删；
 *   ⑤ **日志不含命令原文**（隐私要求）。
 *
 * 用真实 loopback HTTP（127.0.0.1:0 随机端口），不 mock fetch；外部依赖（时钟/计时器/fs）
 * 可注入的才注入。测试期由 scripts/test-net-guard.cjs 保证只能打本地。
 *
 * 用法: node --test clients/dsh-remote/test/agent-permission-bridge.test.mjs
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_DENY_MESSAGE,
  buildDecisionResponse,
  buildPermissionSettings,
  createPermissionBridge,
  normalizePermissionRequest,
  permissionOptions,
  tokenMatches,
  toolKindOf
} from "../agent/permission-bridge.mjs";

const TOKEN = "test-token-123";

/** 起一个桥，跑完必停。 */
async function withBridge(opts, fn) {
  const logs = [];
  const bridge = createPermissionBridge({
    token: TOKEN,
    ttlMs: 2000,
    decide: async () => ({ decision: "allow" }),
    log: (e) => logs.push(e),
    ...opts
  });
  const started = await bridge.start();
  try {
    return await fn({ bridge, started, logs });
  } finally {
    await bridge.stop();
  }
}

const post = (started, body, { token = TOKEN, pathname = "/permission" } = {}) =>
  fetch(`${started.url}${pathname}?t=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

const permBody = (toolName = "Bash", input = { command: "echo hi" }) => ({
  session_id: "s1",
  cwd: "/tmp/proj",
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
  tool_name: toolName,
  tool_input: input
});

test("工具类别映射：未知工具落 other，不猜", () => {
  assert.equal(toolKindOf("Bash"), "execute");
  assert.equal(toolKindOf("Write"), "edit");
  assert.equal(toolKindOf("Read"), "read");
  assert.equal(toolKindOf("WebFetch"), "fetch");
  assert.equal(toolKindOf("SomethingNew"), "other");
  assert.equal(toolKindOf(undefined), "other");
});

test("审批选项：固定两项（实测没有 permission_suggestions，不能依赖上游）", () => {
  const opts = permissionOptions();
  assert.deepEqual(opts.map((o) => o.kind), ["allow_once", "reject_once"]);
  assert.deepEqual(opts.map((o) => o.optionId), ["allow-once", "reject-once"]);
});

test("响应体：只产出实测确认过的两种形状", () => {
  assert.deepEqual(buildDecisionResponse("allow"), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } }
  });
  const deny = buildDecisionResponse("deny", "不许");
  assert.deepEqual(deny, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "不许" } }
  });
  // 未知 decision 一律按拒绝（fail-closed）
  assert.equal(buildDecisionResponse("maybe").hookSpecificOutput.decision.behavior, "deny");
  // message 有上限，避免超长进模型上下文
  assert.equal(buildDecisionResponse("deny", "x".repeat(5000)).hookSpecificOutput.decision.message.length, 1024);
});

test("临时 settings：只声明 PermissionRequest http 钩子，URL 带端口与 token", () => {
  const s = buildPermissionSettings({ port: 4321, token: TOKEN, hookTimeoutSec: 120 });
  assert.deepEqual(Object.keys(s.hooks), ["PermissionRequest"], "不得注入其它事件（SessionStart 实测不支持 http）");
  const hook = s.hooks.PermissionRequest[0].hooks[0];
  assert.equal(hook.type, "http");
  assert.equal(hook.timeout, 120, "timeout 单位是秒（实测）");
  assert.equal(hook.url, `http://127.0.0.1:4321/permission?t=${TOKEN}`);
  assert.equal(s.hooks.PermissionRequest[0].matcher, "*");
});

test("归一化：Bash → execute + 命令原文进 detail；Write → edit + 路径", () => {
  const now = 1_700_000_000_000;
  const bash = normalizePermissionRequest({
    body: permBody("Bash", { command: "rm -rf build" }),
    requestId: "r1",
    now,
    ttlMs: 90_000
  });
  assert.equal(bash.ok, true);
  assert.equal(bash.request.kind, "execute");
  assert.equal(bash.request.detail, "rm -rf build");
  assert.equal(bash.request.expiresAt, now + 90_000);
  assert.equal(bash.request.options.length, 2);

  const write = normalizePermissionRequest({
    body: permBody("Write", { file_path: "/tmp/a.txt", content: "hi" }),
    requestId: "r2",
    now,
    ttlMs: 1000
  });
  assert.equal(write.request.kind, "edit");
  assert.equal(write.request.detail, "/tmp/a.txt");
  assert.equal(write.request.title, "Write: 写入文件");
});

test("归一化：detail 超长截断并标记（不把整文件塞进内存）", () => {
  const r = normalizePermissionRequest({
    body: permBody("Bash", { command: "x".repeat(5000) }),
    requestId: "r",
    now: 0,
    ttlMs: 1000,
    maxDetailChars: 100
  });
  assert.equal(r.request.detail.length, 100);
  assert.equal(r.request.detailTruncated, true);
});

test("归一化：未知事件 / 缺 tool_name / 非对象 → ok:false（上层按拒绝）", () => {
  assert.equal(normalizePermissionRequest({ body: { hook_event_name: "PreToolUse", tool_name: "Bash" }, requestId: "r", now: 0, ttlMs: 1 }).ok, false);
  assert.equal(normalizePermissionRequest({ body: { hook_event_name: "PermissionRequest" }, requestId: "r", now: 0, ttlMs: 1 }).ok, false);
  assert.equal(normalizePermissionRequest({ body: null, requestId: "r", now: 0, ttlMs: 1 }).ok, false);
});

test("token 比较：等长且相同才通过；空/不等长一律 false", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("abc", "abcd"), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
});

test("只允许绑回环：广域 bind 直接抛错（不能把审批端点开给局域网）", () => {
  assert.throws(() => createPermissionBridge({ host: "0.0.0.0" }), /只允许绑回环/);
});

test("端到端：允许 → 200 + 实测形状；临时 settings 存在且 0600；stop 后目录被删", async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-test-"));
  let settingsPath = "";
  try {
    await withBridge({ settingsDir: dir, decide: async () => ({ decision: "allow" }) }, async ({ started }) => {
      settingsPath = started.settingsPath;
      assert.ok(fsSync.existsSync(settingsPath), "临时 settings 必须落盘");
      const mode = fsSync.statSync(settingsPath).mode & 0o777;
      assert.equal(mode, 0o600, "settings 含 token，必须 0600");

      const saved = JSON.parse(fsSync.readFileSync(settingsPath, "utf8"));
      const url = saved.hooks.PermissionRequest[0].hooks[0].url;
      assert.match(url, new RegExp(`:${started.port}/permission\\?t=${TOKEN}$`));

      const res = await post(started, permBody());
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), buildDecisionResponse("allow"));
    });
    assert.equal(fsSync.existsSync(settingsPath), false, "stop() 必须删掉临时 settings");
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("端到端：拒绝 → 200 + deny 形状（message 原样回传给模型）", async () => {
  await withBridge({ decide: async () => ({ decision: "deny", message: "用户拒绝" }) }, async ({ started }) => {
    const res = await post(started, permBody());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
    assert.equal(body.hookSpecificOutput.decision.message, "用户拒绝");
  });
});

test("端到端：错误 token → 403（且不返回任何决策体）", async () => {
  await withBridge({ decide: async () => ({ decision: "allow" }) }, async ({ started }) => {
    const res = await post(started, permBody(), { token: "wrong" });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "forbidden");
    assert.equal(body.hookSpecificOutput, undefined, "绝不能给出 allow 形状");
  });
});

test("端到端：未知事件名 → 400（无决策 → 上游 fail-closed）", async () => {
  await withBridge({}, async ({ started }) => {
    const res = await post(started, { ...permBody(), hook_event_name: "SessionStart" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unknown-shape");
  });
});

test("端到端：坏 JSON → 400；超体积 → 413；错误路径 → 404；GET /health → 200", async () => {
  await withBridge({ maxBodyBytes: 200 }, async ({ started }) => {
    assert.equal((await post(started, "{oops")).status, 400);

    const big = await post(started, permBody("Bash", { command: "x".repeat(1000) }));
    assert.equal(big.status, 413);

    const nf = await fetch(`${started.url}/nope?t=${TOKEN}`, { method: "POST", body: "{}" });
    assert.equal(nf.status, 404);

    const health = await fetch(`${started.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  });
});

test("端到端：决策处理器抛错 → 拒绝（不是 500，也不是放行）", async () => {
  await withBridge(
    {
      decide: () => {
        throw new Error("手机通道断了");
      }
    },
    async ({ started }) => {
      const res = await post(started, permBody());
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
      assert.match(body.hookSpecificOutput.decision.message, /手机通道断了/);
    }
  );
});

test("端到端：决策返回 cancelled → 拒绝", async () => {
  await withBridge({ decide: async () => ({ cancelled: true }) }, async ({ started }) => {
    const body = await (await post(started, permBody())).json();
    assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
  });
});

test("端到端：TTL 到期无决策 → **拒绝**（fail-closed，默认文案，不含命令原文）", async () => {
  // 用假计时器精确触发"超时"，不真等 90 秒
  const queue = [];
  const timers = {
    setTimeout: (fn) => {
      queue.push(fn);
      return queue.length;
    },
    clearTimeout: () => {}
  };
  let resolveHang;
  const hang = new Promise((r) => {
    resolveHang = r;
  });
  await withBridge(
    {
      timers,
      ttlMs: 90_000,
      decide: () => hang // 永远不返回，模拟"手机没人应答"
    },
    async ({ started }) => {
      const pending = post(started, permBody("Bash", { command: "rm -rf /important" }));
      // 等桥接把请求登记进 pending，再手动触发 TTL
      for (let i = 0; i < 50 && started.pendingCount() === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
      assert.equal(started.pendingCount(), 1);
      assert.equal(queue.length, 1, "TTL 计时器应已挂上");
      queue[0](); // 到期
      const res = await pending;
      const body = await res.json();
      assert.equal(body.hookSpecificOutput.decision.behavior, "deny");
      assert.equal(body.hookSpecificOutput.decision.message, DEFAULT_DENY_MESSAGE);
      assert.doesNotMatch(body.hookSpecificOutput.decision.message, /rm -rf/, "拒绝文案不得回显命令");
      resolveHang({ decision: "allow" }); // 释放挂起的 promise，避免测试退出时悬挂
    }
  );
});

test("端到端：并发上限 → 429（不排队，避免内存/时延被拖长）", async () => {
  let release;
  const hang = new Promise((r) => {
    release = r;
  });
  await withBridge({ maxPending: 1, decide: () => hang }, async ({ started }) => {
    const first = post(started, permBody());
    for (let i = 0; i < 50 && started.pendingCount() === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(started.pendingCount(), 1);

    const second = await post(started, permBody());
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error, "too-many-pending");

    release({ decision: "deny", message: "放行第一笔后收工" });
    assert.equal((await first).status, 200);
  });
});

test("隐私：日志只记元数据，**不含命令原文/路径**", async () => {
  await withBridge({ decide: async () => ({ decision: "deny", message: "no" }) }, async ({ started, logs }) => {
    const secretCommand = "curl -H 'Authorization: Bearer sk-super-secret' http://example.com";
    const res = await post(started, permBody("Bash", { command: secretCommand }));
    assert.equal(res.status, 200);

    const dump = JSON.stringify(logs);
    assert.ok(logs.some((e) => e.event === "permission.request"), "应记录请求事件");
    assert.ok(logs.some((e) => e.event === "permission.decision"), "应记录决策事件");
    assert.doesNotMatch(dump, /sk-super-secret/, "日志绝不能带命令原文");
    assert.doesNotMatch(dump, /Authorization/, "日志绝不能带命令原文");
    // 元数据字段要在
    const req = logs.find((e) => e.event === "permission.request");
    assert.equal(req.toolName, "Bash");
    assert.equal(req.kind, "execute");
    assert.equal(typeof req.detailTruncated, "boolean");
  });
});

test("生命周期：重复 start 抛错；stop 幂等；stop 后端口不再服务", async () => {
  const bridge = createPermissionBridge({ token: TOKEN, decide: async () => ({ decision: "allow" }) });
  const started = await bridge.start();
  await assert.rejects(() => bridge.start(), /已经启动/);
  const url = started.url;
  await bridge.stop();
  await bridge.stop(); // 幂等
  await assert.rejects(() => fetch(`${url}/health`), /fetch failed|ECONNREFUSED/);
});

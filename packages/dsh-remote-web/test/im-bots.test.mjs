// 🤖 IM 机器人通道（企业微信智能机器人）—— 节点半（lib/index.js）三条本地 API 的契约回归。
//
// 契约（与桥半约定，字段名不要改）：
//   <relayDir>/im-bots.json       插件写、桥读  {version:1, wecom:{enabled,botId,secret,url,targetChatId}}
//   <relayDir>/im-bot-status.json 桥写、插件只读 {updatedAt, wecom:{...}}
//   GET  /dsh-remote/im-bots              → {ok, wecom:{enabled,botId,hasSecret,url,targetChatId}, status}
//   PUT  /dsh-remote/im-bots  {wecom:{...}} → 保存（空 secret = 不修改；空 targetChatId = 不设置）
//   POST /dsh-remote/im-bots/test         → 保存（可选）后轮询状态 ≤10s
//   ⚠️ **secret 永不返回浏览器**（GET/PUT/test 三个响应里都只有 hasSecret）。
//
// 为什么这些用例必须存在：面板只回显 hasSecret，secret 一旦被误下发，等于把机器人凭据
// 暴露给任何能打开本机 dsh web 页面的人（哪怕它只是一台共享电脑）。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

/** 装插件 → 起一个只做本地路由分发的 host（与 announcements-proxy.test.mjs 同一形态）。 */
function boot(relayDir, config = {}) {
  const routes = [];
  apply({
    webServer: { register(rt) { routes.push(rt); return () => {}; } },
    effect(reg) { return reg(); },
    logger: { info() {}, warn() {} },
  }, { relayDir, ...config });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const rt = routes.find((r) => (r.kind === "prefix"
      ? url.pathname === r.path || url.pathname.startsWith(r.path + "/")
      : url.pathname === r.path));
    (rt ? rt.handler : ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  return host;
}

const tmpRelay = () => mkdtemp(path.join(os.tmpdir(), "dsh-imbot-"));

async function withHost(relayDir, config, fn) {
  const host = boot(relayDir, config);
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${host.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => host.close(r)); }
}

const json = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
};
const put = (base, wecom) => json(`${base}/dsh-remote/im-bots`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ wecom }),
});
const postTest = (base, wecom) => json(`${base}/dsh-remote/im-bots/test`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(wecom === undefined ? {} : { wecom }),
});
const readCfg = async (relayDir) => JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8"));
const writeStatus = (relayDir, wecom, extra = {}) =>
  writeFile(path.join(relayDir, "im-bot-status.json"), JSON.stringify({ updatedAt: Date.now(), wecom, ...extra }));

// ───────────────────────────── GET ─────────────────────────────

test("GET /dsh-remote/im-bots：未配置时给完整空形态（面板据此显示「未配置」，不是报错）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    const r = await json(`${base}/dsh-remote/im-bots`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.wecom, { enabled: false, botId: "", hasSecret: false, url: "", targetChatId: "", sessionId: "", sessionTitle: "" },
      "未配置 = 全空 + hasSecret:false（绝不出现 secret 字段；会话绑定也默认空 = 跟随活跃）");
    assert.equal(r.body.status.connected, false);
    assert.equal(r.body.status.lastError, "");
  });
});

test("GET：**绝不返回 secret**（连字段名都不出现），只给 hasSecret", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "SECRET-PLAINTEXT-123", targetChatId: "chat-9" });
    const r = await json(`${base}/dsh-remote/im-bots`);
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("SECRET-PLAINTEXT-123"), "★ 响应体里绝不能出现 secret 明文");
    assert.ok(!raw.includes("secret"), "★ 连 secret 字段名都不下发（只给 hasSecret 布尔）");
    assert.equal(r.body.wecom.hasSecret, true);
    assert.equal(r.body.wecom.botId, "aibdemo1234");
    assert.equal(r.body.wecom.targetChatId, "chat-9", "GET 回显 targetChatId（lead 补充契约）");
  });
});

test("GET：状态文件是桥写的 → 只转发白名单字段（桥塞敏感字段也带不出去）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await writeStatus(relayDir, {
      enabled: true, connected: true, authenticated: true, lastError: "", lastConnectedAt: 111,
      lastMessageAt: 222, boundChatId: "chat-1", secret: "LEAKED-FROM-STATUS",
    }, { updatedAt: 333, token: "LEAKED-TOKEN" });
    const r = await json(`${base}/dsh-remote/im-bots`);
    const raw = JSON.stringify(r.body);
    assert.equal(r.body.status.connected, true);
    assert.equal(r.body.status.boundChatId, "chat-1");
    assert.ok(!raw.includes("LEAKED"), "★ 状态文件只按白名单挑字段，未知/敏感字段一律不外传");
    assert.equal(r.body.updatedAt, 333);
  });
});

// ───────────────────────────── PUT ─────────────────────────────

test("PUT：保存 Bot ID + Secret + targetChatId；文件 0600（仅本机可读），JSON 形状符合契约", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    const r = await put(base, { botId: "aibdemo1234", secret: "s3cret", targetChatId: "chat-9" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.wecom.hasSecret, true);
    const file = path.join(relayDir, "im-bots.json");
    const cfg = JSON.parse(await readFile(file, "utf8"));
    assert.equal(cfg.version, 1);
    assert.deepEqual(cfg.wecom, { enabled: true, botId: "aibdemo1234", secret: "s3cret", url: "", targetChatId: "chat-9", sessionId: "", sessionTitle: "", previewCardAt: 0 });
    if (process.platform !== "win32") {
      const st = await stat(file);
      assert.equal(st.mode & 0o777, 0o600, "★ 配置文件必须 0600（含明文 secret）");
    }
  });
});

test("PUT：空 secret = **不修改**（用户只改 Bot ID 时不必重填），且 targetChatId 可单独清空", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "keep-me", targetChatId: "chat-9" });
    const r = await put(base, { botId: "aibdemo5678", secret: "", targetChatId: "" });
    assert.equal(r.status, 200);
    const cfg = await readCfg(relayDir);
    assert.equal(cfg.wecom.botId, "aibdemo5678", "Bot ID 已更新");
    assert.equal(cfg.wecom.secret, "keep-me", "★ 空 secret 必须保留原值（面板不回显 secret，用户没法重填）");
    assert.equal(cfg.wecom.targetChatId, "", "targetChatId 传空串 = 清空（留空 = 不设置）");
  });
});

test("PUT：校验失败一律人话 + 稳定错误码（invalid_bot_id / missing_secret），且**不落盘半成品**", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    const bad = await put(base, { botId: "not-a-bot", secret: "x" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_bot_id", "Bot ID 形如 aib... —— 抄错要当场拒绝");
    assert.ok(String(bad.body.message).includes("aib"), "错误文案要告诉用户正确形状");

    const noSecret = await put(base, { botId: "aibdemo1234" });
    assert.equal(noSecret.status, 400);
    assert.equal(noSecret.body.error, "missing_secret");

    await assert.rejects(readFile(path.join(relayDir, "im-bots.json"), "utf8"),
      "校验失败时绝不能写出半成品配置文件");
  });
});

test("PUT：保留其它平台与未知字段（插件不认识 feishu，但没有权利删掉它）", async () => {
  const relayDir = await tmpRelay();
  await writeFile(path.join(relayDir, "im-bots.json"), JSON.stringify({
    version: 1, feishu: { enabled: true, appId: "cli_x" }, wecom: { enabled: false, botId: "", secret: "", url: "", targetChatId: "" }, keep: 1,
  }));
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x" });
    const cfg = await readCfg(relayDir);
    assert.deepEqual(cfg.feishu, { enabled: true, appId: "cli_x" }, "其它平台的配置必须原样保留");
    assert.equal(cfg.keep, 1, "未知顶层字段也保留（前向兼容）");
    assert.equal(cfg.wecom.enabled, true);
  });
});

test("PUT：url 与 targetChatId 的边界（非法 url 拒绝；超长会话 ID 拒绝）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    const badUrl = await put(base, { botId: "aibdemo1234", secret: "x", url: "ftp://x" });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.body.error, "invalid_url");
    const badChat = await put(base, { botId: "aibdemo1234", secret: "x", targetChatId: "c".repeat(201) });
    assert.equal(badChat.status, 400);
    assert.equal(badChat.body.error, "invalid_target_chat_id");
  });
});

// ───────────────────────────── POST /test ─────────────────────────────

test("POST /test：没有 secret → 400 missing_secret（不带凭据不可能是桥的问题）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    const r = await postTest(base, { botId: "aibdemo1234" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "missing_secret");
  });
});

test("POST /test：桥写的状态显示已连接 → {ok:true, connected:true, authenticated}（≤10s 内回）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x", targetChatId: "" });
    await writeStatus(relayDir, { enabled: true, connected: true, authenticated: true, lastError: "" });
    const r = await postTest(base);   // 不传 body = 测已保存的配置
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, connected: true, authenticated: true, lastError: "" });
  });
});

test("POST /test：桥明确报错 → 502 connect_failed，并把桥的 lastError 原文带给用户", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x" });
    await writeStatus(relayDir, { enabled: true, connected: false, authenticated: false, lastError: "invalid credential (errcode 40001)" });
    const r = await postTest(base);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "connect_failed");
    assert.ok(String(r.body.lastError).includes("40001"), "桥给的原因必须原样透出（用户才能拿去搜/找客服）");
    assert.ok(String(r.body.message).includes("40001"), "人话文案里也要带上原因");
  });
});

test("POST /test：状态一直不动 → 504 timeout（等待上限可配，测试用 300ms，不空等 10s）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, { imBotsWaitMs: 300 }, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x" });
    const t0 = Date.now();
    const r = await postTest(base);
    assert.equal(r.status, 504);
    assert.equal(r.body.error, "timeout");
    assert.ok(Date.now() - t0 < 5000, "必须尊重配置的等待上限（否则用例会真等 10s）");
    assert.ok(String(r.body.message).includes("Bridge"), "超时要告诉用户去检查电脑端后台服务，而不是只给错误码");
  });
});

test("POST /test：带凭据 body = 先保存再测（面板「保存并连接」一次点完）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    // 桥在这期间连上（模拟：请求发出后桥写状态）
    const timer = setTimeout(() => {
      writeStatus(relayDir, { enabled: true, connected: true, authenticated: false, lastError: "" }).catch(() => {});
    }, 50);
    const r = await postTest(base, { botId: "aibdemo9999", secret: "new-secret", targetChatId: "chat-7" });
    clearTimeout(timer);
    assert.equal(r.status, 200);
    const cfg = await readCfg(relayDir);
    assert.equal(cfg.wecom.botId, "aibdemo9999", "POST body 里的凭据必须先落盘（桥只读文件）");
    assert.equal(cfg.wecom.secret, "new-secret");
    assert.equal(cfg.wecom.targetChatId, "chat-7");
  });
});

// ─────────────────── 会话可选绑定（2026-11-07，task-25） ───────────────────
//
// 契约（与桥约定死，字段名不要改）：
//   状态文件 wecom.sessions[{id,title,updatedAt}] / activeSessionId / boundSessionId
//   配置     wecom.sessionId + wecom.sessionTitle（空 sessionId = 跟随当前活跃会话）
// 面板只读状态文件里的会话列表，不自己拉会话；GET 必须按**白名单**挑字段。

test("GET：透出会话白名单字段（sessions/activeSessionId/boundSessionId），且只挑 id/title/updatedAt", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await writeStatus(relayDir, {
      enabled: true, connected: true, authenticated: true, lastError: "",
      sessions: [
        { id: "sess-1-abcdef123456", title: "修复登录问题", updatedAt: 111, internalToken: "LEAK-1" },
        { id: "sess-2-xyz", title: "部署到 NAS", updatedAt: 222 },
        { id: "", title: "坏数据", updatedAt: 333 },
      ],
      activeSessionId: "sess-2-xyz",
      activeSessionTitle: "部署到 NAS",
      boundSessionId: "sess-1-abcdef123456",
      secret: "LEAK-SECRET",
    });
    const r = await json(`${base}/dsh-remote/im-bots`);
    const st = r.body.status;
    assert.equal(st.activeSessionId, "sess-2-xyz");
    assert.equal(st.boundSessionId, "sess-1-abcdef123456");
    assert.equal(st.sessions.length, 2, "没有 id 的坏数据要过滤掉");
    assert.deepEqual(st.sessions[0], { id: "sess-1-abcdef123456", title: "修复登录问题", updatedAt: 111 },
      "★ 会话只挑白名单字段（internalToken 不得外泄）");
    assert.ok(!JSON.stringify(r.body).includes("LEAK"), "★ 状态文件里的敏感字段绝不能被透出");
  });
});

test("PUT：保存会话绑定写 sessionId + sessionTitle；传空 sessionId = 跟随活跃（同时清掉标题）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x" });
    const r1 = await put(base, { sessionId: "sess-1-abcdef123456", sessionTitle: "修复登录问题" });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.wecom.sessionId, "sess-1-abcdef123456", "GET/PUT 回显已绑定会话");
    assert.equal(r1.body.wecom.sessionTitle, "修复登录问题");
    const cfg1 = await readCfg(relayDir);
    assert.equal(cfg1.wecom.sessionId, "sess-1-abcdef123456");
    assert.equal(cfg1.wecom.sessionTitle, "修复登录问题");

    // 选「跟随当前活跃会话」→ 空 sessionId + 空 title
    const r2 = await put(base, { sessionId: "", sessionTitle: "残留标题" });
    assert.equal(r2.status, 200);
    const cfg2 = await readCfg(relayDir);
    assert.equal(cfg2.wecom.sessionId, "", "空 sessionId = 跟随当前活跃会话");
    assert.equal(cfg2.wecom.sessionTitle, "", "★ 清空绑定时必须同时清掉标题（否则 UI 会显示错的目标）");
    assert.equal(cfg2.wecom.botId, "aibdemo1234", "其它凭据不受影响");
  });
});

test("PUT：会话 ID 过长 → 400 invalid_session_id（不写半成品）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x" });
    const r = await put(base, { sessionId: "s".repeat(201) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_session_id");
    const cfg = await readCfg(relayDir);
    assert.equal(cfg.wecom.sessionId, "", "校验失败不得落盘");
  });
});

// ─────────────────── 发送预览卡片（2026-11-07，task-25 尾） ───────────────────
//
// 契约：桥监听 im-bots.json 的 wecom.previewCardAt（ms；值变大桥就发一张预览审批卡），
// 处理完把 wecom.lastPreviewCardAt 写回状态文件。插件只负责"把时间戳写大"。

test("GET：白名单透出 status.wecom.lastPreviewCardAt（桥写的已处理时间戳）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await writeStatus(relayDir, { enabled: true, connected: true, authenticated: true, lastError: "", lastPreviewCardAt: 1_700_000_123_456 });
    const r = await json(`${base}/dsh-remote/im-bots`);
    assert.equal(r.body.status.lastPreviewCardAt, 1_700_000_123_456, "lastPreviewCardAt 必须在白名单里");
  });
});

test("PUT previewCardAt：写数字时间戳，且**不丢** botId/secret/会话绑定/接收会话（覆盖写不许冲掉其它字段）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "keep-me", targetChatId: "chat-9", sessionId: "sess-1", sessionTitle: "修复登录" });
    const before = await readCfg(relayDir);
    const r = await put(base, { previewCardAt: 1_700_000_999_000 });
    assert.equal(r.status, 200);
    const cfg = await readCfg(relayDir);
    assert.equal(cfg.wecom.previewCardAt, 1_700_000_999_000, "★ previewCardAt 必须落盘（桥只认这个数变大）");
    assert.equal(cfg.wecom.botId, before.wecom.botId, "Bot ID 不能被冲掉");
    assert.equal(cfg.wecom.secret, "keep-me", "★ Secret 不能被冲掉（面板不回显，丢了用户都不知道）");
    assert.equal(cfg.wecom.targetChatId, "chat-9", "接收会话 ID 不能被冲掉");
    assert.equal(cfg.wecom.sessionId, "sess-1", "会话绑定不能被冲掉");
    assert.equal(cfg.wecom.sessionTitle, "修复登录", "会话标题不能被冲掉");
  });
});

test("PUT previewCardAt：非法值（非数字 / 0 / 负数）→ 400 invalid_preview_card_at，且不写半成品", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await put(base, { botId: "aibdemo1234", secret: "x" });
    for (const bad of ["not-a-number", 0, -5]) {
      const r = await put(base, { previewCardAt: bad });
      assert.equal(r.status, 400, "非法值必须 400：" + String(bad));
      assert.equal(r.body.error, "invalid_preview_card_at");
    }
    const cfg = await readCfg(relayDir);
    assert.equal(cfg.wecom.previewCardAt, 0, "非法触发值绝不能写进文件（桥会永久失效且难排查）");
  });
});

// ─────────────────── 会员档位 / 额度（2026-11-07 桥侧判定） ───────────────────

test("GET：白名单透出 tier/caps/capsCount/bindingGated/messagesPerMonth/remainingMessages/usage", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await writeStatus(relayDir, {
      enabled: true, connected: true, tier: "free",
      caps: ["wecom", "session_binding"], capsCount: 2, bindingGated: true,
      messagesPerMonth: 20, remainingMessages: 7,
      usage: { month: "2026-11", messages: 13 },
      // 攻击面：状态文件里的内部字段/额外字段绝不能被整包吐出去
      secret: "LEAK", capsRaw: { internal: "LEAK2" }, extra: "LEAK3",
    });
    const r = await json(`${base}/dsh-remote/im-bots`);
    const st = r.body.status;
    assert.equal(st.tier, "free");
    assert.deepEqual(st.caps, ["wecom", "session_binding"], "caps 只取字符串数组（截断/过滤），不得透出对象");
    assert.equal(st.capsCount, 2);
    assert.equal(st.bindingGated, true);
    assert.equal(st.messagesPerMonth, 20);
    assert.equal(st.remainingMessages, 7);
    assert.deepEqual(st.usage, { month: "2026-11", messages: 13 });
    assert.ok(!JSON.stringify(r.body).includes("LEAK"), "★ 白名单之外的状态字段绝不能被透出");
  });
});

test("GET：tier 只认三个枚举值；remainingMessages=null 表示不限/未知（不能被当成 0）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await writeStatus(relayDir, { tier: "gold", remainingMessages: null, messagesPerMonth: 0 });
    let st = (await json(`${base}/dsh-remote/im-bots`)).body.status;
    assert.equal(st.tier, "", "未知档位必须归一成空串（面板据此不渲染，绝不猜）");
    assert.equal(st.remainingMessages, null, "null 必须保持 null（0 条剩余 ≠ 不限量）");
    assert.equal(st.messagesPerMonth, 0);

    await writeStatus(relayDir, { tier: "pro_max", remainingMessages: null });
    st = (await json(`${base}/dsh-remote/im-bots`)).body.status;
    assert.equal(st.tier, "pro_max");
  });
});

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
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
    assert.deepEqual(r.body, { ok: true, platform: "wecom", connected: true, authenticated: true, lastError: "" });
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

// ─────────────────── 钉钉 / 飞书通道（2026-11-08） ───────────────────

const putPlatform = (base, platform, config) => json(`${base}/dsh-remote/im-bots`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform, config }),
});
const postPlatformTest = (base, platform, config) => json(`${base}/dsh-remote/im-bots/test`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config ? { platform, config } : { platform }),
});
const getDeps = async (base) => (await json(`${base}/dsh-remote/im-deps`)).body;
const post = (base, url) => json(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

test("GET：dingtalk / feishu 两段都只回脱敏视图（有 hasSecret，绝无 clientSecret/appSecret 值）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await putPlatform(base, "dingtalk", { clientId: "ding-id", clientSecret: "DING-SECRET", robotCode: "ding-robot" });
    await putPlatform(base, "feishu", { appId: "cli_1", appSecret: "FS-SECRET", receiveId: "ou_1", receiveIdType: "open_id" });
    const r = await json(`${base}/dsh-remote/im-bots`);
    assert.equal(r.body.dingtalk.clientId, "ding-id");
    assert.equal(r.body.dingtalk.robotCode, "ding-robot");
    assert.equal(r.body.dingtalk.hasSecret, true);
    assert.equal(r.body.feishu.appId, "cli_1");
    assert.equal(r.body.feishu.receiveIdType, "open_id");
    assert.equal(r.body.feishu.hasSecret, true);
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("DING-SECRET"), "★ 钉钉 secret 绝不能出现");
    assert.ok(!raw.includes("FS-SECRET"), "★ 飞书 secret 绝不能出现");
    assert.ok(!raw.includes("clientSecret") && !raw.includes("appSecret"), "连字段名都不出现");
  });
});

test("PUT：保存钉钉配置（0600 原子写 + 保留未知字段 + 空 secret 不覆盖）；缺字段给人话错误", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    // 先写一份带未知字段的旧文件：插件不认识，但不能删掉
    await writeFile(path.join(relayDir, "im-bots.json"), JSON.stringify({ version: 1, future: { keep: 1 } }));
    let r = await putPlatform(base, "dingtalk", { clientId: "id1", clientSecret: "sec1", robotCode: "rc1" });
    assert.equal(r.status, 200);
    let cfg = JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8"));
    assert.equal(cfg.dingtalk.clientId, "id1");
    assert.equal(cfg.dingtalk.clientSecret, "sec1");
    assert.equal(cfg.dingtalk.robotCode, "rc1");
    assert.equal(cfg.dingtalk.enabled, true, "首次保存凭据 = 想让它生效");
    assert.deepEqual(cfg.future, { keep: 1 }, "未知字段必须保留");
    const mode = (await stat(path.join(relayDir, "im-bots.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "配置文件必须 0600");

    // 空 secret = 不修改
    r = await putPlatform(base, "dingtalk", { clientId: "id2", clientSecret: "", robotCode: "rc2" });
    assert.equal(r.status, 200);
    cfg = JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8"));
    assert.equal(cfg.dingtalk.clientId, "id2");
    assert.equal(cfg.dingtalk.clientSecret, "sec1", "空 secret 表示不修改");
    assert.equal(cfg.dingtalk.robotCode, "rc2");

    // 缺字段
    r = await putPlatform(base, "dingtalk", { clientId: "id3", clientSecret: "sec3", robotCode: "" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "missing_robot_code", "三个字段都要：缺 Robot Code 要报出来");
  });
});

test("PUT：保存飞书配置（字段锁死 + receiveIdType 校验 + 空 secret 不覆盖）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    // ★ 2026-11-08 业主：接收人不需要用户填（桥侧自动发现）→ 不传 receiveId 也必须能保存
    let r = await putPlatform(base, "feishu", { appId: "cli_a", appSecret: "fs_a" });
    assert.equal(r.status, 200, "只有 App ID + Secret 就必须能保存");
    let cfg = JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8"));
    assert.equal(cfg.feishu.appId, "cli_a");
    assert.equal(cfg.feishu.receiveId, "", "接收人留空 = 交给桥自动发现");
    assert.equal(cfg.feishu.receiveIdType, "open_id", "默认 open_id（桥可能在自动发现后回写）");
    r = await putPlatform(base, "feishu", { receiveIdType: "chat_id" });
    assert.equal(r.status, 200);
    assert.equal(cfg.feishu.domain, "https://open.feishu.cn", "domain 默认官方");
    r = await putPlatform(base, "feishu", { appId: "cli_b", appSecret: "", receiveId: "ou_b" });
    cfg = JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8"));
    assert.equal(cfg.feishu.appSecret, "fs_a", "空 secret 不覆盖");
    assert.equal(cfg.feishu.receiveIdType, "chat_id", "显式传 receiveIdType 时可改（高级/兼容用）");
    // 非法 receiveIdType
    r = await putPlatform(base, "feishu", { appId: "x", appSecret: "y", receiveId: "z", receiveIdType: "userid" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_receive_id_type");
  });
});

test("POST /test：platform=dingtalk / feishu 各自轮询对应状态（不再混用 wecom 状态）", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await putPlatform(base, "dingtalk", { clientId: "i", clientSecret: "s", robotCode: "r" });
    await putPlatform(base, "feishu", { appId: "cli_i", appSecret: "fs_s", receiveId: "ou_i" });
    await writeStatus(relayDir, { connected: false, authenticated: false, lastError: "" }, {
      dingtalk: { enabled: true, connected: true, authenticated: true, lastError: "" },
      feishu: { enabled: true, connected: true, authenticated: true, lastError: "" },
    });
    let r = await postPlatformTest(base, "dingtalk");
    assert.equal(r.status, 200);
    assert.equal(r.body.platform, "dingtalk");
    assert.equal(r.body.connected, true);
    r = await postPlatformTest(base, "feishu");
    assert.equal(r.body.platform, "feishu");
    assert.equal(r.body.connected, true);
    // 未保存 secret 的平台：给明确错误，而不是"连不上"
    await withHost(await tmpRelay(), {}, async (base2) => {
      const rr = await postPlatformTest(base2, "dingtalk");
      assert.equal(rr.status, 400);
      assert.equal(rr.body.error, "missing_secret");
    });
  });
});

test("GET 状态白名单：status.dingtalk / status.feishu 按契约透出（含 tier/caps/usage/state），状态文件敏感字段不外泄", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, {}, async (base) => {
    await writeStatus(relayDir, { connected: false }, {
      dingtalk: {
        enabled: true, state: "connected", connected: true, authenticated: true, lastError: "", boundChatId: "chat-9",
        tier: "pro", caps: ["dingtalk"], capsCount: 1, bindingGated: false, messagesPerMonth: 0, remainingMessages: null,
        usage: { month: "2026-11", messages: 5 }, clientSecret: "LEAK-D", token: "LEAK-T",
        credentialSource: "scan", robotCodeConfigured: true, capabilities: { openapi: true, card: false }, internal: "LEAK-C",
      },
      feishu: {
        enabled: true, state: "failed", connected: false, authenticated: false, lastError: "鉴权失败", boundChatId: "",
        tier: "free", caps: [], capsCount: 0, bindingGated: true, messagesPerMonth: 20, remainingMessages: 19,
        usage: { month: "2026-11", messages: 1 }, boundChatType: "p2p", receiveIdSource: "auto", appSecret: "LEAK-F",
      },
    });
    const r = await json(`${base}/dsh-remote/im-bots`);
    const d = r.body.status.dingtalk;
    assert.equal(d.state, "connected");
    assert.equal(d.tier, "pro");
    assert.deepEqual(d.caps, ["dingtalk"]);
    assert.equal(d.remainingMessages, null, "null 必须保持 null（≠0）");
    assert.deepEqual(d.usage, { month: "2026-11", messages: 5 });
    assert.equal(d.credentialSource, "scan", "凭据来源要透出（扫码/手动）");
    assert.equal(d.robotCodeConfigured, true, "Robot Code 是否配置要透出（面板据此置灰能力）");
    assert.deepEqual(d.capabilities, { openapi: true, card: false }, "能力开关只透出 openapi/card 两个布尔");
    const f = r.body.status.feishu;
    assert.equal(f.state, "failed");
    assert.equal(f.tier, "free");
    assert.equal(f.bindingGated, true);
    assert.equal(f.remainingMessages, 19);
    assert.equal(f.boundChatType, "p2p", "飞书自动绑定类型要透出（面板显示「已自动绑定：私聊」）");
    assert.equal(f.receiveIdSource, "auto", "自动发现来源要透出");
    assert.ok(!JSON.stringify(r.body).includes("LEAK"), "★ 桥写状态里的敏感字段必须被白名单挡掉");
    // wecom 老字段仍在（向后兼容）
    assert.equal(typeof r.body.status.connected, "boolean");
  });
});

// 假子进程：测试注入 opts.imDepsSpawn，绝不真的联网 npm install
function fakeSpawnChild(installed, stderrText) {
  const handlers = {};
  return {
    stdout: { on() {} },
    stderr: { on(_e, cb) { handlers.data = cb; } },
    on(ev, cb) { handlers[ev] = cb; },
    _finish() {
      if (installed) handlers.installed = true;
      setTimeout(() => {
        if (stderrText && handlers.data) handlers.data(Buffer.from(stderrText));
        if (handlers.exit) handlers.exit(installed ? 0 : 1);
      }, 20);
    }
  };
}

test("GET /im-deps + POST /im-deps/feishu：后台安装（注入假 spawn，不联网），phase 从 downloading→done", async () => {
  const relayDir = await tmpRelay();
  const pkgDir = path.join(relayDir, "im-deps", "node_modules", "@larksuiteoapi", "node-sdk");
  const spawnCalls = [];
  const imDepsSpawn = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    const child = fakeSpawnChild(true, "");
    // 模拟 npm 装完后落盘（测试里直接写好 package.json）
    setTimeout(async () => {
      await mkdir(pkgDir, { recursive: true });
      await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@larksuiteoapi/node-sdk", version: "1.40.0" }));
      child._finish();
    }, 10);
    return child;
  };
  await withHost(relayDir, { imDepsSpawn }, async (base) => {
    let deps = await getDeps(base);
    assert.equal(deps.feishu.installed, false);
    assert.equal(deps.feishu.phase, "idle");

    const r = await post(base, `${base}/dsh-remote/im-deps/feishu`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.started, true);
    assert.ok(spawnCalls.length === 1, "应触发一次 npm install");
    assert.ok(spawnCalls[0].args.join(" ").includes("@larksuiteoapi/node-sdk@1.40.0"), "安装命令必须钉死 SDK 版本");

    // 轮询 phase 直到 done
    let phase = "";
    for (let i = 0; i < 50; i++) {
      deps = await getDeps(base);
      phase = deps.feishu.phase;
      if (phase === "done" || phase === "failed") break;
      await new Promise((r2) => setTimeout(r2, 30));
    }
    deps = await getDeps(base);
    assert.equal(deps.feishu.phase, "done", "安装完成后 phase=done，实际 " + deps.feishu.phase);
    assert.equal(deps.feishu.installed, true);
    assert.equal(deps.feishu.version, "1.40.0");
    assert.ok(deps.feishu.path.includes("node-sdk"));
  });
});

test("POST /im-deps/feishu：安装失败 → phase=failed + 人话原因（network/disk/permission/sdk_install_failed）", async () => {
  const relayDir = await tmpRelay();
  const imDepsSpawn = () => {
    const child = fakeSpawnChild(false, "npm ERR! code ETIMEDOUT network registry.npmjs.org");
    setTimeout(() => child._finish(), 10);
    return child;
  };
  await withHost(relayDir, { imDepsSpawn }, async (base) => {
    const r = await post(base, `${base}/dsh-remote/im-deps/feishu`);
    assert.equal(r.status, 200);
    let deps = null;
    for (let i = 0; i < 60; i++) {
      deps = await getDeps(base);
      if (deps.feishu.phase === "failed") break;
      await new Promise((r2) => setTimeout(r2, 30));
    }
    assert.equal(deps.feishu.phase, "failed", "失败必须落到 failed 而不是永远 downloading");
    assert.match(deps.feishu.lastError, /网络不通/, "网络类错误要翻成人话");
    // 已失败后重试：再次触发安装
    const r2 = await post(base, `${base}/dsh-remote/im-deps/feishu`);
    assert.equal(r2.body.started, true, "失败后允许重试");
  });
});

// ─────────────────── 钉钉「扫码一键创建机器人」device-flow（2026-11-08） ───────────────────

/** 假钉钉接口（注入 imAuthFetch；测试绝不真的打 oapi.dingtalk.com）。 */
function makeAuthFetch(plan = {}) {
  const calls = [];
  const resp = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fn = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), body });
    const u = String(url);
    if (u.endsWith("/init")) {
      if (plan.initThrows) throw new Error("ECONNRESET");
      return resp(plan.init || { nonce: "nonce-1" });
    }
    if (u.endsWith("/begin")) {
      if (plan.beginRejected) return resp({ errmsg: "rejected" }, false, 400);
      return resp(plan.begin || { device_code: "dc-secret", verification_uri_complete: "https://oapi.dingtalk.com/auth?x=1", interval: 2, expires_in: 7200 });
    }
    if (u.endsWith("/poll")) {
      if (plan.pollThrows) throw new Error("ETIMEDOUT");
      return resp(plan.polls && plan.polls.length ? plan.polls.shift() : { status: "WAITING" });
    }
    throw new Error("unexpected url " + u);
  };
  fn.calls = calls;
  return fn;
}

test("POST /im-dingtalk-auth/begin：返回 authId/url/interval/expiresIn；device_code 绝不落浏览器", async () => {
  const relayDir = await tmpRelay();
  const imAuthFetch = makeAuthFetch();
  await withHost(relayDir, { imAuthFetch }, async (base) => {
    const r = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.authId, "必须给浏览器一个 authId 句柄");
    assert.equal(r.body.url, "https://oapi.dingtalk.com/auth?x=1");
    assert.equal(r.body.interval, 2);
    assert.equal(r.body.expiresIn, 7200, "★ TTL 必须按钉钉 expires_in（7200s），不能再是写死的 2 分钟");
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("dc-secret"), "★ device_code 不能下发给浏览器");
  });
});

test("POST begin 限流：同一时间只允许一个授权，旧 authId 查询回 cancelled", async () => {
  const relayDir = await tmpRelay();
  const imAuthFetch = makeAuthFetch();
  await withHost(relayDir, { imAuthFetch, imAuthPollMs: 60000 }, async (base) => {
    const a = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    const b = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.ok(a.body.authId && b.body.authId && a.body.authId !== b.body.authId);
    const old = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=${encodeURIComponent(a.body.authId)}`);
    assert.equal(old.body.status, "failed");
    assert.equal(old.body.code, "cancelled", "旧授权必须被作废（而不是继续有效）");
    const cur = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=${encodeURIComponent(b.body.authId)}`);
    assert.equal(cur.body.status, "waiting");
  });
});

test("GET status：waiting → success 时把凭据写入 im-bots.json（0600、credentialSource=scan），响应不回 secret", async () => {
  const relayDir = await tmpRelay();
  const imAuthFetch = makeAuthFetch({
    polls: [
      { status: "WAITING" },
      { status: "SUCCESS", client_id: "ding-client-8899", client_secret: "DING-SCAN-SECRET" },
    ],
  });
  await withHost(relayDir, { imAuthFetch, imAuthPollMs: 60000 }, async (base) => {
    const begin = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    const id = encodeURIComponent(begin.body.authId);
    let st = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=${id}&check=1`);
    assert.equal(st.body.status, "waiting", "用户还没确认 → waiting");
    st = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=${id}&check=1`);
    assert.equal(st.body.status, "success");
    assert.equal(st.body.credentialSource, "scan");
    assert.equal(st.body.hasSecret, true);
    assert.equal(st.body.clientIdTail, "8899");
    assert.ok(!JSON.stringify(st.body).includes("DING-SCAN-SECRET"), "★ 扫码拿到的 secret 绝不能回给浏览器");

    const cfg = JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8"));
    assert.equal(cfg.dingtalk.clientId, "ding-client-8899");
    assert.equal(cfg.dingtalk.clientSecret, "DING-SCAN-SECRET", "凭据要写入配置文件（桥读）");
    assert.equal(cfg.dingtalk.credentialSource, "scan");
    assert.equal(cfg.dingtalk.enabled, true, "扫码成功即可用");
    const mode = (await stat(path.join(relayDir, "im-bots.json"))).mode & 0o777;
    assert.equal(mode, 0o600, "配置文件必须 0600");

    // 面板 GET 里也只见 hasSecret，不见 secret
    const view = await json(`${base}/dsh-remote/im-bots`);
    assert.equal(view.body.dingtalk.hasSecret, true);
    assert.equal(view.body.dingtalk.credentialSource, "scan");
    assert.ok(!JSON.stringify(view.body).includes("DING-SCAN-SECRET"));
  });
});

test("GET status：未知/过期 authId → expired；钉钉拒绝 → failed(dingtalk_api_rejected)；网络不通 → failed(network_error)", async () => {
  const relayDir = await tmpRelay();
  await withHost(relayDir, { imAuthFetch: makeAuthFetch() }, async (base) => {
    const none = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=nope`);
    assert.equal(none.body.status, "expired");
    assert.equal(none.body.code, "expired");

    // 钉钉拒绝 poll
    const rejDir = await tmpRelay();
    const rejFetch = makeAuthFetch({ polls: [{ status: "DENIED", message: "用户取消了创建" }] });
    await withHost(rejDir, { imAuthFetch: rejFetch, imAuthPollMs: 60000 }, async (base2) => {
      const b = await post(base2, `${base2}/dsh-remote/im-dingtalk-auth/begin`);
      const st = await json(`${base2}/dsh-remote/im-dingtalk-auth/status?id=${encodeURIComponent(b.body.authId)}&check=1`);
      assert.equal(st.body.status, "failed");
      assert.equal(st.body.code, "dingtalk_api_rejected");
      assert.ok(st.body.message.includes("用户取消"), "钉钉原文原因要带给用户");
    });

    // 网络抖动的 poll：**不放失败**（后台继续重试直到 expires_in），状态仍 waiting
    const netDir = await tmpRelay();
    const netFetch = makeAuthFetch({ pollThrows: true });
    await withHost(netDir, { imAuthFetch: netFetch, imAuthPollMs: 60000 }, async (base3) => {
      const b = await post(base3, `${base3}/dsh-remote/im-dingtalk-auth/begin`);
      const st = await json(`${base3}/dsh-remote/im-dingtalk-auth/status?id=${encodeURIComponent(b.body.authId)}&check=1`);
      assert.equal(st.body.status, "waiting", "网络抖动不该判死授权（用户还在扫码）");
    });
  });
});

test("POST begin：钉钉接口不可用 → network_error / dingtalk_api_rejected（人话）", async () => {
  const dir1 = await tmpRelay();
  await withHost(dir1, { imAuthFetch: makeAuthFetch({ initThrows: true }) }, async (base) => {
    const r = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.equal(r.status, 502);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, "network_error");
    assert.match(r.body.message, /连不上钉钉接口/, "错误 message 必须是中文人话");
  });
  const dir2 = await tmpRelay();
  await withHost(dir2, { imAuthFetch: makeAuthFetch({ beginRejected: true }) }, async (base) => {
    const r = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.equal(r.body.code, "dingtalk_api_rejected");
  });
});

test("钉钉授权：后台轮询在**无人查询**时也继续前进（关面板/刷新不影响），TTL 按 expires_in=7200s", async () => {
  const relayDir = await tmpRelay();
  const imAuthFetch = makeAuthFetch({
    polls: [{ status: "WAITING" }, { status: "SUCCESS", client_id: "ding-bg-1", client_secret: "BG-SECRET" }],
  });
  // 后台轮询间隔压到 20ms（生产 3s），验证"不靠面板/HTTP 查询也会成功"
  await withHost(relayDir, { imAuthFetch, imAuthPollMs: 20 }, async (base) => {
    const begin = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.equal(begin.body.expiresIn, 7200, "★ TTL 必须是钉钉的 expires_in（7200s），不是 2 分钟");
    // 不调用任何 status 接口，等后台轮询把 SUCCESS 落盘
    let cfg = null;
    for (let i = 0; i < 100; i++) {
      try { cfg = JSON.parse(await readFile(path.join(relayDir, "im-bots.json"), "utf8")); } catch { cfg = null; }
      if (cfg && cfg.dingtalk && cfg.dingtalk.clientId === "ding-bg-1") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(cfg && cfg.dingtalk.clientId === "ding-bg-1", "★ 后台轮询必须在没有面板查询时也把凭据写盘");
    assert.equal(cfg.dingtalk.credentialSource, "scan");
    assert.equal(cfg.dingtalk.enabled, true, "扫码成功自动 enabled");
    // 之后查询直接拿到 success（脱敏）
    const st = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=${encodeURIComponent(begin.body.authId)}`);
    assert.equal(st.body.status, "success");
    assert.ok(!JSON.stringify(st.body).includes("BG-SECRET"));
  });
});

test("钉钉授权错误：message 永远是中文人话（绝不裸 code / ok）", async () => {
  const dir1 = await tmpRelay();
  await withHost(dir1, { imAuthFetch: makeAuthFetch({ initThrows: true }) }, async (base) => {
    const r = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.equal(r.body.code, "network_error");
    assert.notEqual(r.body.message, r.body.code, "message 不能等于裸 code");
    assert.match(r.body.message, /[\u4e00-\u9fa5]/, "message 必须含中文");
  });
  const dir2 = await tmpRelay();
  await withHost(dir2, { imAuthFetch: makeAuthFetch({ beginRejected: true }) }, async (base) => {
    const r = await post(base, `${base}/dsh-remote/im-dingtalk-auth/begin`);
    assert.match(r.body.message, /[\u4e00-\u9fa5]/);
    assert.ok(!/^\s*(ok|error|https?:)/i.test(r.body.message), "不得裸渲染 ok/errcode/URL");
  });
  const dir3 = await tmpRelay();
  await withHost(dir3, { imAuthFetch: makeAuthFetch() }, async (base) => {
    const st = await json(`${base}/dsh-remote/im-dingtalk-auth/status?id=nope`);
    assert.equal(st.body.code, "expired");
    assert.match(st.body.message, /授权已过期/, "过期也要中文人话");
  });
});

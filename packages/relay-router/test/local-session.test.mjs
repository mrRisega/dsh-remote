#!/usr/bin/env node
/**
 * 本地(自部署)会话时长 + 滑动续签 —— 端到端测试。
 *
 * 用户反馈(原文)：「手机端 Web 页面使用账号密码登录时，经常需要重新登录，一天要登录好多次。
 * 你诊断一下这块的会话保存过期时间是不是太短了？是不是没有续签会话？咱们至少保留 7 天以上。」
 *
 * 自建部署模式(用户用访问密钥登录手机端 /app/)的症状同源:本地 JWT 曾写死 2 小时
 * (`exp: now + 7200`)且**完全没有续签** → 每 2 小时掉一次登录。本文件把修法钉成可执行契约:
 *   ① `DSH_LOCAL_SESSION_TTL_MS` 可配:默认 30 天(与 SaaS 侧 auth_session_ttl_ms 对齐),
 *      硬夹 [7 天, 1 年],非法值( NaN / ≤0 )回落默认;
 *   ② 剩余不足半个 TTL 的本地 token → `Set-Cookie` 把 exp 推满(滑动续签);剩余充足 → 不写 cookie;
 *   ③ sat(首次登录锚,**毫秒**)在续签时继承;老 token(无 sat)也能续,并以"首次遇到"为新锚;
 *   ④ `now - sat` 超过 `DSH_LOCAL_SESSION_ABS_MAX_MS`(默认 1 年,下限 7 天)→ 不再续签,
 *      旧 token 仍按自身 exp 正常工作(**不 500**);
 *   ⑤ enterprise 密钥签发的令牌**不会**被 router 续签(吊销/绝对上限语义归 enterprise 自己)。
 *
 * 用法: node --test test/local-session.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const ROUTER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");
const SOURCE = readFileSync(ROUTER_SRC, "utf8");

const ENTERPRISE_SECRET = "enterprise-secret-0123456789abcdef0123456789";
const LOCAL_SECRET = "local-secret-0123456789abcdef0123456789abcd";
const ACCESS_KEY = "test-access-key-please-rotate";

const DAY_S = 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_30D_S = 30 * DAY_S;
const TTL_7D_S = 7 * DAY_S;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- JWT 小工具(与 router 的 HS256 同构;测试自己签,便于构造各种 sat/exp) ----------

function signJwt(claims, secret) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(claims);
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function claimsOf(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

/**
 * 造一个本地密钥签发的 token。
 * `sat: null` = 模拟"本改动之前签发的老 token"(claims 里没有 sat)。
 */
function localToken({ remainingSec = 3600, sat = Date.now(), sub = "local", plan = "pro_max" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub, plan, iat: now - 60, exp: now + remainingSec, ...(sat === null ? {} : { sat }) }, LOCAL_SECRET);
}

const cookieOf = (token) => `dsh_token=${encodeURIComponent(token)}`;
const renewedTokenOf = (cookie) => decodeURIComponent(cookie.slice("dsh_token=".length, cookie.indexOf(";")));

/** 带 cookie 请求 /_devices(需鉴权的同源只读端点),返回状态与响应里的 Set-Cookie。 */
async function getDevices(base, token) {
  const res = await fetch(`${base}/_devices`, { headers: { cookie: cookieOf(token) }, redirect: "manual" });
  const cookies = res.headers.getSetCookie();
  await res.json().catch(() => null);
  return { status: res.status, cookies, renewed: cookies.find((c) => c.startsWith("dsh_token=")) };
}

async function login(base, key = ACCESS_KEY) {
  const res = await fetch(`${base}/_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, token: body?.token || "" };
}

/** 取一个空闲端口(先绑 0 再释放;本地测试的短暂竞态可以接受)。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 起一个 router 子进程并等它开始监听。 */
async function startRouter(extraEnv = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [ROUTER_SRC], {
    env: {
      ...process.env,
      DSH_ROUTER_HOST: "127.0.0.1",
      DSH_ROUTER_PORT: String(port),
      DSH_ENTERPRISE_JWT_SECRET: ENTERPRISE_SECRET,
      DSH_LOCAL_JWT_SECRET: LOCAL_SECRET,
      DSH_LOCAL_ACCESS_KEYS: ACCESS_KEY,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const chunks = [];
  proc.stdout.on("data", (d) => chunks.push(String(d)));
  proc.stderr.on("data", (d) => chunks.push(String(d)));
  const log = () => chunks.join("");
  const t0 = Date.now();
  while (!log().includes("[router] 监听")) {
    if (proc.exitCode !== null) throw new Error(`router 提前退出(exit=${proc.exitCode}):\n${log()}`);
    if (Date.now() - t0 > 10_000) {
      proc.kill("SIGKILL");
      throw new Error(`router 未在 10s 内监听:\n${log()}`);
    }
    await sleep(50);
  }
  return {
    base: `http://127.0.0.1:${port}`,
    log,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 3000).unref();
      })
  };
}

/** 从源码里按大括号配平抽出函数体(同 native-app-entry.test.mjs 的手法)。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `源码里找不到 ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 大括号不配平`);
}

// ================================================================

/** 默认配置的 router:①③④⑤ 都跑在它上面(少起进程、用例更快)。 */
let router;
before(async () => { router = await startRouter(); });
after(async () => { await router?.stop(); });

test("① 会话时长可配:默认 30 天(≥7 天),配成 1 小时仍被夹到 ≥7 天,非法值回落默认", async (t) => {
  await t.test("未配置 DSH_LOCAL_SESSION_TTL_MS → 30 天,并带上毫秒级 sat 锚", async () => {
    const { status, body, token } = await login(router.base);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.mode, "local");
    const c = claimsOf(token);
    const ttl = c.exp - c.iat;
    assert.ok(ttl >= TTL_7D_S, `TTL 至少 7 天,实际 ${ttl}s`);
    assert.ok(Math.abs(ttl - TTL_30D_S) <= 5, `未配置时应为默认 30 天,实际 ${ttl}s`);
    assert.ok(Number.isFinite(c.sat) && Math.abs(c.sat - Date.now()) < 60_000,
      `sat 必须是毫秒时间戳(≈现在),实际 ${c.sat}`);
  });

  await t.test("DSH_LOCAL_SESSION_TTL_MS=3600000(1 小时)→ 被夹到 7 天", async () => {
    const r = await startRouter({ DSH_LOCAL_SESSION_TTL_MS: "3600000" });
    try {
      const { token } = await login(r.base);
      const ttl = claimsOf(token).exp - claimsOf(token).iat;
      assert.ok(ttl >= TTL_7D_S, `配置漂移也不许低于 7 天,实际 ${ttl}s`);
      assert.ok(Math.abs(ttl - TTL_7D_S) <= 5, `1 小时应被夹到 7 天下限,实际 ${ttl}s`);
    } finally {
      await r.stop();
    }
  });

  await t.test("非法值(NaN)→ 回落默认 30 天(不是夹到下限)", async () => {
    const r = await startRouter({ DSH_LOCAL_SESSION_TTL_MS: "abc" });
    try {
      const { token } = await login(r.base);
      const ttl = claimsOf(token).exp - claimsOf(token).iat;
      assert.ok(Math.abs(ttl - TTL_30D_S) <= 5, `非法值应回落默认 30 天,实际 ${ttl}s`);
    } finally {
      await r.stop();
    }
  });

  await t.test("非法值(≤0)→ 回落默认 30 天", async () => {
    const r = await startRouter({ DSH_LOCAL_SESSION_TTL_MS: "-1" });
    try {
      const { token } = await login(r.base);
      const ttl = claimsOf(token).exp - claimsOf(token).iat;
      assert.ok(Math.abs(ttl - TTL_30D_S) <= 5, `非法值应回落默认 30 天,实际 ${ttl}s`);
    } finally {
      await r.stop();
    }
  });
});

test("② 滑动续签:剩余不足半个 TTL → 推满;剩余充足 → 不写 cookie", async (t) => {
  await t.test("剩余 1 小时(≪15 天)→ 回写满 TTL 的本地 token", async () => {
    const { status, renewed } = await getDevices(router.base, localToken({ remainingSec: 3600 }));
    assert.equal(status, 200, "续签不能影响正常鉴权结果");
    assert.ok(renewed, "剩余不足半个 TTL 时必须回写 Set-Cookie");
    const remain = claimsOf(renewedTokenOf(renewed)).exp - Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(remain - TTL_30D_S) <= 5, `新 token 必须被推满(≈30 天),实际 ${remain}s`);
    assert.match(renewed, /Path=\//, "Set-Cookie 必须带 Path=/");
    assert.match(renewed, /SameSite=Lax/);
    assert.match(renewed, /Secure/);
    assert.doesNotMatch(renewed, /HttpOnly/i, "手机端 JS 要读这个 cookie,不能加 HttpOnly");
    assert.match(renewed, new RegExp(`Max-Age=${TTL_30D_S}`), "Max-Age 应与新 token 的 exp 一致");
  });

  await t.test("剩余 14 天(略少于半个 TTL)→ 续签", async () => {
    const { renewed } = await getDevices(router.base, localToken({ remainingSec: 14 * DAY_S }));
    assert.ok(renewed, "剩余 14 天 < 15 天,应该续签");
  });

  await t.test("剩余 29 天(> 半个 TTL)→ 不写任何 Set-Cookie", async () => {
    const { status, cookies } = await getDevices(router.base, localToken({ remainingSec: 29 * DAY_S }));
    assert.equal(status, 200);
    assert.deepEqual(cookies, [], "剩余充足时必须节流:不产生多余 Set-Cookie");
  });

  await t.test("已过期的本地 token → 不续签(该重新输访问密钥)", async () => {
    const expired = signJwt(
      { sub: "local", plan: "pro_max", iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 60 },
      LOCAL_SECRET
    );
    const { status, cookies } = await getDevices(router.base, expired);
    assert.equal(status, 401, "过期令牌仍应 401(不能靠续签把过期令牌救活)");
    assert.deepEqual(cookies, []);
  });

  await t.test("幂等:一个请求只回一条 dsh_token Set-Cookie", async () => {
    const { cookies } = await getDevices(router.base, localToken({ remainingSec: 600 }));
    assert.equal(cookies.filter((c) => c.startsWith("dsh_token=")).length, 1,
      "同一请求里不得对多个下游重复续签/回写多条 cookie");
  });
});

test("③ sat(首次登录锚)在续签时继承;老 token(无 sat)也能续", async (t) => {
  await t.test("连续两次续签,sat 不变", async () => {
    const anchor = Date.now() - 3 * DAY_MS; // 3 天前"首次登录"
    const first = await getDevices(router.base, localToken({ remainingSec: 600, sat: anchor }));
    assert.ok(first.renewed);
    const c1 = claimsOf(renewedTokenOf(first.renewed));
    assert.equal(c1.sat, anchor, "续签必须继承旧 sat —— 重置它会让绝对上限形同虚设");

    // 第二次:现实里发生在 15 天后;这里直接构造"同锚 + 剩余不足"的 token 等价模拟。
    const second = await getDevices(router.base, localToken({ remainingSec: 600, sat: anchor }));
    const c2 = claimsOf(renewedTokenOf(second.renewed));
    assert.equal(c2.sat, anchor, "第二次续签 sat 仍未变");
    assert.equal(c2.sat, c1.sat);
    assert.ok(c2.exp - c2.iat >= TTL_7D_S, "每次续签都应推满一个完整 TTL");
  });

  await t.test("老 token(claims 无 sat)→ 仍可续签,并以首次遇到为新锚(不追溯吊销)", async () => {
    const t0 = Date.now();
    const { status, renewed } = await getDevices(router.base, localToken({ remainingSec: 600, sat: null }));
    assert.equal(status, 200);
    assert.ok(renewed, "本改动之前签发的 token 不该被追溯吊销");
    const c = claimsOf(renewedTokenOf(renewed));
    assert.ok(Math.abs(c.sat - t0) < 60_000,
      `无 sat 的老 token 应以"首次遇到的那一刻"为锚(毫秒),实际 sat=${c.sat} 参考=${t0}`);
  });
});

test("④ 绝对上限:sat 超过 DSH_LOCAL_SESSION_ABS_MAX_MS(默认 1 年)→ 不再续签,且不 500", async () => {
  const old = localToken({ remainingSec: 3600, sat: Date.now() - 400 * DAY_MS });
  const out = await getDevices(router.base, old);
  assert.equal(out.status, 200, "绝对上限到点只是不续签,本次请求必须照常 200(绝不能 500)");
  assert.deepEqual(out.cookies, [], "超过绝对上限后不得再续签(cookie 自然过期,用户重新输密钥)");

  const within = await getDevices(router.base, localToken({ remainingSec: 3600, sat: Date.now() - 364 * DAY_MS }));
  assert.ok(within.renewed, "还没到绝对上限时应继续续签");
});

test("⑤ enterprise token 不被 router 续签(吊销/绝对上限语义归 enterprise 自己)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const ent = signJwt({ sub: "42", plan: "pro", iat: now - 60, exp: now + 600 }, ENTERPRISE_SECRET);
  const out = await getDevices(router.base, ent);
  assert.equal(out.status, 200, "enterprise token 照常鉴权");
  assert.deepEqual(out.cookies, [], "router 不得给 enterprise 令牌回写任何新 cookie");

  // 更强的一条:即使这个 enterprise 令牌"看起来也该续"(剩余很少、还带 sat),也不许重签
  const ent2 = signJwt(
    { sub: "42", plan: "pro", iat: now - 600, exp: now + 60, sat: Date.now() - DAY_MS },
    ENTERPRISE_SECRET
  );
  const out2 = await getDevices(router.base, ent2);
  assert.equal(out2.status, 200);
  assert.deepEqual(out2.cookies, [], "enterprise 令牌必须由 enterprise 自己续签,router 不得插手");
});

test("⑥ 绝对上限配置漂移:配成 60000(1 分钟)→ 夹到 7 天下限", async () => {
  const r = await startRouter({ DSH_LOCAL_SESSION_TTL_MS: "3600000", DSH_LOCAL_SESSION_ABS_MAX_MS: "60000" });
  try {
    const { token } = await login(r.base);
    const ttl = claimsOf(token).exp - claimsOf(token).iat;
    assert.ok(ttl >= TTL_7D_S, `TTL 下限 7 天,实际 ${ttl}s`);

    const beyond = await getDevices(r.base, localToken({ remainingSec: 600, sat: Date.now() - 8 * DAY_MS }));
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.cookies, [], "sat 8 天前 > 被夹后的 7 天上限 → 不续签");

    const inside = await getDevices(r.base, localToken({ remainingSec: 600, sat: Date.now() - 6 * DAY_MS }));
    assert.ok(inside.renewed, "sat 6 天前应仍在(被夹到 7 天的)上限内 → 必须续签(证明没被夹成 1 分钟)");
  } finally {
    await r.stop();
  }
});

test("⑦ 回包合并:上游带 Set-Cookie 时续签 cookie 要追加,不能被 writeHead 覆盖", async (t) => {
  // 代理回包走 res.writeHead(status, 上游头);Node 里 writeHead 的同名头会整体覆盖 setHeader,
  // 所以续签必须自己合并进 writeHead 的头里 —— 这条用例直接钉住那段合并逻辑。
  const impl = extractFunction(SOURCE, "appendResponseCookie");
  // eslint-disable-next-line no-new-func
  const build = new Function(`${impl}; return appendResponseCookie;`)();
  const captured = [];
  const fakeRes = { writeHead: (...args) => { captured.push(args); return fakeRes; } };
  build(fakeRes, "dsh_token=NEW; Path=/");

  fakeRes.writeHead(200, { "content-type": "text/plain", "set-cookie": ["up=1; Path=/"] });
  assert.deepEqual(captured[0][1]["Set-Cookie"], ["up=1; Path=/", "dsh_token=NEW; Path=/"]);
  assert.equal(captured[0][1]["content-type"], "text/plain", "原有头必须原样保留");

  fakeRes.writeHead(204, { "set-cookie": "up=2" });
  assert.deepEqual(captured[1][1]["Set-Cookie"], ["up=2", "dsh_token=NEW; Path=/"]);
  assert.equal(captured[1][1]["set-cookie"], undefined, "小写形式也要归一,避免两条同名头互踩");

  fakeRes.writeHead(200, { "content-type": "application/json" });
  assert.deepEqual(captured[2][1], { "content-type": "application/json", "Set-Cookie": ["dsh_token=NEW; Path=/"] });

  fakeRes.writeHead(200);
  assert.deepEqual(captured[3][1], { "Set-Cookie": "dsh_token=NEW; Path=/" });

  fakeRes.writeHead(200, ["content-type", "text/plain"]);
  assert.deepEqual(captured[4][1], ["content-type", "text/plain", "Set-Cookie", "dsh_token=NEW; Path=/"]);

  await t.test("隐式 writeHead(直接 res.end())也必须带上续签 cookie", async () => {
    // router 里确有"只 writeHead 前就 end"的极简回包形态;Node 的隐式头走 this.writeHead,
    // 这条用真实 ServerResponse 把"包一层 writeHead 就够"验证掉(而不是靠推测)。
    const srv = http.createServer((req, res) => {
      build(res, "dsh_token=NEW; Path=/");
      res.end("ok");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/`);
      await res.text();
      assert.deepEqual(res.headers.getSetCookie(), ["dsh_token=NEW; Path=/"]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

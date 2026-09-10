// 首次安装后「立即登录」二维码/设备列表报红字 的回归（node 半）。
//
// 现场：全新安装只装插件（dsh plugin add / 插件市场）时，.dsh-config.json 里没有 bridge_secret
// （该字段原本只有一键安装器 dsh-setup.mjs 会写）。而企业端 POST /api/device-login 强制校验
// x-dsh-bridge-secret → 面板请求 /dsh-remote/access-key & /dsh-remote/mobile-sessions 时拿不到 token，
// 旧版一律回 401「尚未登录：请先在「账号」卡片登录手机号账号」——用户明明刚登录成功（误导性红字），
// 只能等后台自愈装完运行环境写回密钥、或手动刷新页面才恢复。
//
// 本用例锁死四点：
//   1. 缺 bridge_secret → 插件向 /api/public-config 自愈取一次并落盘，请求一次即成功（无需刷新）；
//   2. 带了密钥仍失败（网络/5xx）→ 服务端退避重试一次；
//   3. 服务端轮换密钥 → 强制重取新密钥再试；
//   4. 凭证齐全却拿不到 token → 503 + retryable（绝不再谎报“尚未登录”）；密码失效 → 401 relogin_required。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const SECRET = "secret-aaa-111";
const NEW_SECRET = "secret-bbb-222";
const EXPIRES = 1893456000000;

/**
 * 假企业端（复刻生产行为）：
 *  - GET /api/public-config：下发 bridge_secret（可关闭/可轮换）
 *  - POST /api/device-login：**强制**校验 x-dsh-bridge-secret，缺失/不符 → 401 需要有效设备密钥
 *  - POST /api/auth-key：需 Bearer → 返回一次性访问地址与二维码
 */
function startFakeRelay(opts = {}) {
  const seen = [];
  let secret = opts.secret === undefined ? SECRET : opts.secret;
  let deviceLoginCalls = 0;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    seen.push({
      method: req.method,
      path: url.pathname,
      authorization: req.headers.authorization || "",
      secret: req.headers["x-dsh-bridge-secret"] || "",
    });
    if (req.method === "GET" && url.pathname === "/api/public-config") {
      if (opts.noPublicConfig) return send(503, { error: { message: "public-config down" } });
      return send(200, { service: "dsh-remote", app_url: "https://app.test/", api_url: `http://127.0.0.1:${srv.address().port}`, bridge_secret: secret });
    }
    if (req.method === "POST" && url.pathname === "/api/device-login") {
      deviceLoginCalls += 1;
      // 前 N 次网络/5xx 类失败（模拟中继刚重启）
      if (opts.deviceLoginFailTimes && deviceLoginCalls <= opts.deviceLoginFailTimes) {
        if (opts.deviceLoginFailMode === "throw") { req.socket.destroy(); return; }
        return send(503, { error: { code: "unavailable", message: "中继重启中" } });
      }
      if (opts.badCredentials) return send(401, { error: { code: "bad_credentials", message: "手机号或密码错误" } });
      const got = req.headers["x-dsh-bridge-secret"] || "";
      if (!secret || got !== secret) return send(401, { error: { code: "unauthorized", message: "device-login 需要有效设备密钥" } });
      return send(200, { token: "jwt-abc" });
    }
    if (req.method === "POST" && url.pathname === "/api/auth-key") {
      if (!(req.headers.authorization || "").startsWith("Bearer ")) return send(401, { error: { code: "invalid_token", message: "无效或过期的 token" } });
      return send(200, { ok: true, key: "K1", url: "https://app.test/a/K1", expires_at: EXPIRES, ttl_ms: 1800000, qr_data_url: "data:image/png;base64,AAAA" });
    }
    if (req.method === "GET" && url.pathname === "/api/mobile-sessions") {
      if (!(req.headers.authorization || "").startsWith("Bearer ")) return send(401, { error: { code: "invalid_token", message: "无效或过期的 token" } });
      return send(200, { ok: true, sessions: [{ id: "ms_1", label: "iPhone 15", created_at: 1700000000000, revoked_at: null }] });
    }
    send(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    srv, seen, port: srv.address().port,
    rotateSecret(next) { secret = next === undefined ? NEW_SECRET : next; },
    getSecret() { return secret; },
  })));
}

/** 装载插件路由（boot），cfgExtra 覆盖默认配置。 */
async function bootRelay(relayPort, cfgExtra = {}, relayDirOverride) {
  const tempDir = relayDirOverride || (await mkdtemp(path.join(os.tmpdir(), "dsh-first-login-")));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000",
    password: "pw",
    device_id: "dev-first-login",
    api_url: `http://127.0.0.1:${relayPort}`,
    ...cfgExtra,
  }));
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir: tempDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}`, tempDir };
}

async function readCfg(dir) {
  return JSON.parse(await readFile(path.join(dir, ".dsh-config.json"), "utf8"));
}

test("首次安装（配置缺 bridge_secret）→ 自愈取密钥并落盘：二维码一次就拿到，不再需要刷新页面", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port); // 无 bridge_secret：模拟只装插件的全新安装
  try {
    const res = await fetch(`${base}/dsh-remote/access-key`);
    assert.equal(res.status, 200, "首次登录后应立即拿到一次性访问地址（旧版这里 401「尚未登录」）");
    const r = await res.json();
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://app.test/a/K1");
    assert.equal(r.qr_data_url, "data:image/png;base64,AAAA", "二维码应随首次请求一起返回");

    const dl = relay.seen.filter((s) => s.path === "/api/device-login");
    assert.equal(dl.length, 1, "device-login 只应调用一次（自愈取到密钥后再发请求）");
    assert.equal(dl[0].secret, SECRET, "device-login 必须带上自愈得到的共享密钥");
    assert.equal((await readCfg(tempDir)).bridge_secret, SECRET, "密钥应落盘，供 bridge 与后续重启复用");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("设备列表同样自愈：缺 bridge_secret 时 mobile-sessions 一次成功", async () => {
  const relay = await startFakeRelay();
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const res = await fetch(`${base}/dsh-remote/mobile-sessions`);
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.ok, true);
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].label, "iPhone 15");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("有密钥但中继 5xx（刚重启）→ 服务端退避重试一次即成功", async () => {
  const relay = await startFakeRelay({ deviceLoginFailTimes: 1 });
  const { host, base, tempDir } = await bootRelay(relay.port, { bridge_secret: SECRET });
  try {
    const res = await fetch(`${base}/dsh-remote/access-key`);
    assert.equal(res.status, 200, "中继抖动一次应被服务端重试吸收");
    assert.equal(relay.seen.filter((s) => s.path === "/api/device-login").length, 2, "应重试一次");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("网络层失败（连接被断开）→ 服务端重试一次", async () => {
  const relay = await startFakeRelay({ deviceLoginFailTimes: 1, deviceLoginFailMode: "throw" });
  const { host, base, tempDir } = await bootRelay(relay.port, { bridge_secret: SECRET });
  try {
    const res = await fetch(`${base}/dsh-remote/mobile-sessions`);
    assert.equal(res.status, 200, "连接抖动（fetch 抛错）也应重试后成功");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("服务端轮换 shared secret → 强制重取新密钥再试，且写回配置", async () => {
  const relay = await startFakeRelay({ secret: SECRET });
  const { host, base, tempDir } = await bootRelay(relay.port, { bridge_secret: "secret-stale-999" });
  try {
    relay.rotateSecret(NEW_SECRET); // 企业端换了密钥，本机还存着旧的
    const res = await fetch(`${base}/dsh-remote/access-key`);
    assert.equal(res.status, 200, "旧密钥被拒后应自动取新密钥重试");
    assert.equal((await readCfg(tempDir)).bridge_secret, NEW_SECRET, "新密钥应覆盖写回配置");
    const secrets = relay.seen.filter((s) => s.path === "/api/device-login").map((s) => s.secret);
    assert.deepEqual(secrets, ["secret-stale-999", NEW_SECRET], "先旧后新：第二次必须用轮换后的密钥");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("凭证齐全但中继未就绪（重试后仍失败）→ 503 + retryable，绝不谎报「尚未登录」", async () => {
  const relay = await startFakeRelay({ noPublicConfig: true }); // 取不到密钥 → device-login 401 需要设备密钥
  const { host, base, tempDir } = await bootRelay(relay.port);
  try {
    const res = await fetch(`${base}/dsh-remote/access-key`);
    assert.equal(res.status, 503, "应回可重试状态码，而不是 401");
    const r = await res.json();
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true, "必须标记 retryable，浏览器半据此自动重试");
    assert.equal(r.hint, "relay_not_ready");
    assert.ok(!/尚未登录/.test(String(r.error)), "账号已登录，文案不得再引导用户去登录");
    assert.match(String(r.error), /尚未就绪|稍后重试/);
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("密码被企业端拒绝 → 401 relogin_required（不可重试，提示重新登录）", async () => {
  const relay = await startFakeRelay({ badCredentials: true });
  const { host, base, tempDir } = await bootRelay(relay.port, { bridge_secret: SECRET });
  try {
    const res = await fetch(`${base}/dsh-remote/mobile-sessions`);
    assert.equal(res.status, 401);
    const r = await res.json();
    assert.equal(r.hint, "relogin_required");
    assert.equal(r.retryable, false, "密码失效重试无意义");
    assert.match(String(r.error), /重新登录/);
    assert.ok(!/尚未登录/.test(String(r.error)), "与「未登录」分开，文案要能指导下一步");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("自建模式不取设备密钥（走 /_login，不经 public-config）", async () => {
  const relay = await startFakeRelay();
  // 自建：local_key 优先于账号（假企业端未实现 /_login → 降级失败，但绝不能去 device-login/public-config）
  const { host, base, tempDir } = await bootRelay(relay.port, {
    local_key: "lk-1",
    tunnel_url: `ws://127.0.0.1:${relay.port}`,
  });
  try {
    const res = await fetch(`${base}/dsh-remote/access-key`);
    assert.equal(res.status, 503, "自建且上游未实现 /_login → 可重试降级");
    assert.ok(!relay.seen.some((s) => s.path === "/api/device-login" || s.path === "/api/public-config"),
      "自建模式不得请求 device-login / public-config");
  } finally {
    host.close();
    relay.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

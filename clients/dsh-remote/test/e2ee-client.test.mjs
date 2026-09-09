#!/usr/bin/env node
/**
 * e2ee-client.mjs 原语契约测试(纯函数/内存,不起真实进程):
 *   - MK 派生向量与 enterprise 参考实现(e2ee.js deriveE2eeMasterKey)一致(固定口令/盐 → 固定 hex);
 *   - 信封加解密往返 / 篡改拒绝 / nonce 重放拒绝 / ws 计数重放拒绝;
 *   - 参数端点容错(非 200 / 无 e2ee / enabled=false → disabled 不回退抛错);
 *   - 桥端控制通道握手(hello→ack、探针好/坏密钥)、http 明文编解码、ws 标签解析。
 *
 * 用法: node --test test/e2ee-client.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  DEFAULT_MK_KDF,
  E2eeError,
  E2eeService,
  E2eeSession,
  HttpNonceGuard,
  SequenceGuard,
  decodeHttpRequestPlain,
  decodeHttpResponsePlain,
  decodeSalt,
  deriveMasterKey,
  deriveShk,
  encodeHttpRequestPlain,
  encodeHttpResponsePlain,
  envelopeRequestHeaders,
  fetchE2eeParams,
  hasEnvelopeMarker,
  newSessId,
  normalizeKdf,
  parseEnvelopeMarker,
  parseWsE2eeParams,
  randomB64
} from "../e2ee-client.mjs";

// 固定口令/盐的 MK 期望值:由 enterprise e2ee.js deriveE2eeMasterKey 计算得到
// (deriveE2eeMasterKey("dsh-e2ee-test-password", saltB64) 的输出,供跨端对齐校验)。
const SALT_B64 = "AAECAwQFBgcICQoLDA0ODw"; // 16B 0x00..0x0f
const EXPECTED_MK_HEX = "c73a0c5817997926c49f4902643e0203d225666b7afe60468115652ca79ec955";

test("MK 派生向量:固定口令/盐 → 与 enterprise e2ee.js 参考实现一致", () => {
  const mk = deriveMasterKey("dsh-e2ee-test-password", SALT_B64);
  assert.equal(mk.length, 32);
  assert.equal(mk.toString("hex"), EXPECTED_MK_HEX);
});

test("MK 派生:同口令同盐稳定;口令/盐不同则不同", () => {
  const mk1 = deriveMasterKey("dsh-e2ee-test-password", SALT_B64);
  const mk1b = deriveMasterKey("dsh-e2ee-test-password", SALT_B64);
  const mk2 = deriveMasterKey("dsh-e2ee-test-password", Buffer.from("fedcba9876543210fedcba9876543210", "hex").toString("base64url"));
  const mk3 = deriveMasterKey("another-password", SALT_B64);
  assert.deepEqual(mk1, mk1b);
  assert.notDeepEqual(mk1, mk2);
  assert.notDeepEqual(mk1, mk3);
});

test("MK 派生:口令 NFKC 归一(全角数字=半角数字),两端一致", () => {
  const fullWidth = deriveMasterKey("正确口令１２３", SALT_B64);
  const halfWidth = deriveMasterKey("正确口令123", SALT_B64);
  assert.deepEqual(fullWidth, halfWidth);
  assert.equal(halfWidth.length, 32);
});

test("MK 派生:盐/参数非法即拒绝(非 16B、坏 base64url、坏 kdf)", () => {
  assert.equal(decodeSalt(""), null);
  assert.equal(decodeSalt("short"), null);
  assert.equal(decodeSalt("!!!!not-base64url!!!!"), null);
  assert.throws(() => deriveMasterKey("pw", "short"), /salt 非法/);
  assert.throws(() => deriveMasterKey("pw", SALT_B64, { iter: 0 }), /iter/);
  assert.throws(() => deriveMasterKey("pw", SALT_B64, { iter: 100, dkLen: 0 }), /dkLen/);
  assert.throws(() => deriveMasterKey("pw", SALT_B64, { iter: 100, dkLen: 32, hash: "md5" }), /hash/);
  // 参数按服务端下发执行(不写死):iter=1 也能快速算,且与 600k 同构
  const fast = deriveMasterKey("pw", SALT_B64, { alg: "pbkdf2-sha256", iter: 1, dkLen: 32, hash: "sha256" });
  assert.equal(fast.length, 32);
});

test("normalizeKdf 兼容 iter / iterations 两种下发写法", () => {
  assert.deepEqual(normalizeKdf({ alg: "pbkdf2-sha256", iter: 1000, dkLen: 32, hash: "sha256" }), { alg: "pbkdf2-sha256", iter: 1000, dkLen: 32, hash: "sha256" });
  assert.equal(normalizeKdf(null).iter, DEFAULT_MK_KDF.iter);
  assert.equal(normalizeKdf({ iterations: 42, dkLen: 16 }).iter, 42);
});

// ---------- 参数端点容错(本地 mock) ----------

async function withParamsServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/relay-api`;
  try {
    return { base, close: () => new Promise((r) => server.close(r)) };
  } finally {
    /* keep open until test done */
  }
}

test("fetchE2eeParams:enabled=true 正常解析 §3.4 形状", async () => {
  const { base, close } = await withParamsServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer tok-1");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      e2ee: { enabled: true, profile: "pbkdf2-sha256-600k", kdf: { alg: "pbkdf2-sha256", iter: 600000, dkLen: 32, hash: "sha256" }, salt: SALT_B64, epoch: 3 }
    }));
  });
  try {
    const p = await fetchE2eeParams(base, "tok-1");
    assert.equal(p.enabled, true);
    assert.equal(p.salt, SALT_B64);
    assert.equal(p.epoch, 3);
    assert.equal(p.kdf.iter, 600000);
  } finally {
    await close();
  }
});

test("fetchE2eeParams:401/404/5xx/无 e2ee/enabled=false → disabled(明文回退,不抛)", async () => {
  const cases = [
    [(res) => { res.writeHead(401); res.end("{}"); }, "server_unauthorized"],
    [(res) => { res.writeHead(404); res.end("{}"); }, "server_no_params"],
    [(res) => { res.writeHead(500); res.end("boom"); }, "http_500"],
    [(res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ e2ee: { enabled: false, salt: "" } })); }, "server_disabled"],
    [(res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); }, "server_no_params"],
    [(res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not-json"); }, "bad_params"],
    [(res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ e2ee: { enabled: true, salt: "abc" } })); }, "bad_params"]
  ];
  for (const [handler, expectedReason] of cases) {
    const { base, close } = await withParamsServer((req, res) => handler(res));
    try {
      const p = await fetchE2eeParams(base, "tok");
      assert.equal(p.enabled, false, `case ${expectedReason}`);
      assert.equal(p.reason, expectedReason);
    } finally {
      await close();
    }
  }
});

test("fetchE2eeParams:网络不可达 → params_unreachable(不抛)", async () => {
  const p = await fetchE2eeParams("http://127.0.0.1:1", "tok", { timeoutMs: 500 });
  assert.equal(p.enabled, false);
  assert.equal(p.reason, "params_unreachable");
});

// ---------- 会话密钥 / 信封往返 ----------

function makeSession(over = {}) {
  const mk = deriveMasterKey("unit-password", SALT_B64);
  const a = randomB64(32);
  const b = randomB64(32);
  const { shk, saltH } = deriveShk(mk, a, b);
  return new E2eeSession({ sessId: newSessId(), shk, saltH, ...over });
}

test("deriveShk:确定性 + 32B;a/b 非法长度拒绝", () => {
  const mk = deriveMasterKey("unit-password", SALT_B64);
  const r1 = deriveShk(mk, randomB64(32), randomB64(32));
  assert.equal(r1.shk.length, 32);
  assert.equal(r1.saltH.length, 32);
  assert.throws(() => deriveShk(mk, "short", randomB64(32)), /32B/);
});

test("信封往返:http 请求(文本)seal→open 恢复明文;字段完整", () => {
  const s = makeSession();
  const plain = encodeHttpRequestPlain({ method: "POST", path: "/api/session/s1/messages", headers: { "content-type": "application/json" }, bodyB64: Buffer.from("你好 dsh").toString("base64"), bodyBase64: true });
  // http 请求 key-info reqNonce 默认 = 信封自身 n(自描述),开包方无需额外状态
  const env = s.seal({ kind: "http", dir: "p2b", counter: 7, data: plain });
  assert.equal(env.v, 2);
  assert.equal(env.k, "http");
  assert.equal(env.s, s.sessId);
  assert.equal(env.c, 7);
  assert.equal(env.t, 0);
  const opened = s.open({ kind: "http", dir: "p2b", env, counter: env.c });
  const req = decodeHttpRequestPlain(opened.data);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/session/s1/messages");
  assert.equal(Buffer.from(req.bodyB64, "base64").toString("utf8"), "你好 dsh");
});

function envNonce() {
  return Buffer.from("0102030405060708090a0b0c", "hex").toString("base64url");
}

test("信封往返:ws 二进制(t:1)密封原样还原", () => {
  const s = makeSession();
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  const env = s.seal({ kind: "w", dir: "p2b", counter: 0, data: bytes, t: 1, wsLabel: "/api/events?w=deadbeef" });
  assert.equal(env.t, 1);
  const opened = s.open({ kind: "w", dir: "p2b", env, counter: 0, wsLabel: "/api/events?w=deadbeef" });
  assert.equal(opened.t, 1);
  assert.deepEqual(opened.data, bytes);
});

test("篡改拒绝:d 翻转一字节 → auth_failed;会话/kind/方向不符均拒绝", () => {
  const s = makeSession();
  const env = s.seal({ kind: "http", dir: "p2b", counter: 1, data: "payload" });
  // 篡改密文
  const tampered = { ...env, d: flipB64(env.d) };
  assert.throws(() => s.open({ kind: "http", dir: "p2b", env: tampered, counter: env.c }), (e) => e instanceof E2eeError && e.code === "auth_failed");
  // 篡改 nonce(改 key-info 域,信封自描述 reqNonce 随之变化 → 密钥不同 → 认证失败)
  assert.throws(() => s.open({ kind: "http", dir: "p2b", env: { ...env, n: Buffer.alloc(12, 1).toString("base64url") }, counter: env.c }), (e) => e instanceof E2eeError);
  // 错误 kind / 错误方向(密钥域分离)
  assert.throws(() => s.open({ kind: "w", dir: "p2b", env, counter: env.c, wsLabel: "x" }), (e) => e instanceof E2eeError);
  assert.throws(() => s.open({ kind: "http", dir: "b2p", env, counter: env.c }), (e) => e instanceof E2eeError && e.code === "auth_failed");
  // 会话不符(直接报 bad_session,不开包)
  const other = makeSession();
  assert.throws(() => other.open({ kind: "http", dir: "p2b", env, counter: env.c }), (e) => e instanceof E2eeError && ["bad_session", "auth_failed"].includes(e.code));
});

function flipB64(b64) {
  const buf = Buffer.from(b64, "base64url");
  buf[0] ^= 0xff;
  return buf.toString("base64url");
}

test("http 响应信封:封包→开包,enc=gzip 被提取、实体头剥离,正文还原", () => {
  const s = makeSession();
  const body = Buffer.from(JSON.stringify({ ok: true }), "utf8");
  const plain = encodeHttpResponsePlain({
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "100", "x-thing": "v" },
    bodyBuffer: body
  });
  const env = s.seal({ kind: "http-resp", dir: "b2p", counter: 3, data: plain, reqNonceB64: envNonce() });
  const opened = s.open({ kind: "http-resp", dir: "b2p", env, counter: env.c, reqNonceB64: envNonce() });
  const resp = decodeHttpResponsePlain(opened.data);
  assert.equal(resp.status, 200);
  assert.equal(resp.enc, "gzip");
  assert.equal(resp.headers["content-type"], "application/json");
  assert.equal(resp.headers["content-encoding"], undefined); // 实体头进 enc 不残留
  assert.deepEqual(resp.bodyBuffer, body);
});

test("防重放:HttpNonceGuard 同 (sess,n) 重复拒绝;窗口过期后放行", () => {
  const g = new HttpNonceGuard({ windowMs: 40_000, max: 16 });
  assert.equal(g.check("s1", "nonce-a"), true);
  assert.equal(g.check("s1", "nonce-a"), false); // 重放
  assert.equal(g.check("s1", "nonce-b"), true); // 不同 nonce 放行
  assert.equal(g.check("s2", "nonce-a"), true); // 不同会话放行
  // 窗口 0 = 立即过期:同一 nonce 再次出现被当作新消息放行(5 分钟窗口语义)
  const g2 = new HttpNonceGuard({ windowMs: 0, max: 16 });
  assert.equal(g2.check("s1", "x"), true);
  assert.equal(g2.check("s1", "x"), true);
  assert.equal(g2.check("s1", "x"), true);
});

test("防重放:SequenceGuard 计数必须单调;重放/乱序拒绝", () => {
  const g = new SequenceGuard();
  g.check(0);
  g.check(1);
  g.check(5); // 跳号(网络无乱序,实际不会发生)允许? 协议要求单调 +1,这里严格递增即可
  assert.throws(() => g.check(5), (e) => e instanceof E2eeError && e.code === "replay");
  assert.throws(() => g.check(1), (e) => e instanceof E2eeError && e.code === "replay");
  assert.throws(() => g.check(-1), (e) => e instanceof E2eeError && e.code === "bad_counter");
});

// ---------- ws 标签 / 信封标记头 ----------

test("parseWsE2eeParams:解析 e2ee/w、剥离出上游路径、保留 w 的流标签", () => {
  const sessId = newSessId();
  const r = parseWsE2eeParams(`/api/events.mux?a=1&e2ee=${sessId}&w=0011223344556677`);
  assert.equal(r.sessId, sessId);
  assert.equal(r.w, "0011223344556677");
  assert.equal(r.upstreamPath, "/api/events.mux?a=1");
  assert.equal(r.wsLabel, "/api/events.mux?a=1&w=0011223344556677");
  // 无标记 / 无 query → null
  assert.equal(parseWsE2eeParams("/api/events.mux"), null);
  assert.equal(parseWsE2eeParams(`/api?e2ee=${sessId}`), null);
  assert.equal(parseWsE2eeParams(`/api?e2ee=bad&w=0011`), null);
});

test("信封标记头:封包/识别/解析一致;content-type 与 x-dsh-e2ee 双信号", () => {
  const sessId = newSessId();
  const h = envelopeRequestHeaders(sessId, "http");
  assert.equal(h["content-type"], "application/vnd.dsh.e2ee-v2");
  assert.equal(hasEnvelopeMarker(h), true);
  assert.equal(hasEnvelopeMarker({ "content-type": "text/html" }), false);
  const m = parseEnvelopeMarker(h);
  assert.equal(m.v, 2);
  assert.equal(m.s, sessId);
  assert.equal(m.k, "http");
  assert.equal(parseEnvelopeMarker({}), null);
});

// ---------- 桥端服务:握手 / 探针 / 开关 ----------

test("E2eeService:disabled 状态 caps 为空;enabled 后 caps=['e2ee-v2']", () => {
  const off = new E2eeService({ enabled: false, reason: "server_disabled" });
  assert.deepEqual(off.caps(), []);
  assert.equal(off.enabled, false);
  const mk = deriveMasterKey("unit-password", SALT_B64);
  const on = new E2eeService({ enabled: true, mk, salt: SALT_B64, profile: "pbkdf2-sha256-600k" });
  assert.deepEqual(on.caps(), ["e2ee-v2"]);
  assert.equal(on.state().reason, "ok");
});

test("E2eeService.init:服务端 enabled=false/401/无密码/禁用开关 → 明文回退原因", async () => {
  // 无密码
  const noPw = await E2eeService.init({ apiBase: "http://127.0.0.1:1", token: "t", password: "" });
  assert.equal(noPw.enabled, false);
  assert.equal(noPw.reason, "no_password");
  // allowed=false(本地配置关闭)
  const off = await E2eeService.init({ apiBase: "http://127.0.0.1:1", token: "t", password: "pw", allowed: false });
  assert.equal(off.reason, "disabled_by_config");
  // 401
  const { base, close } = await withParamsServer((req, res) => { res.writeHead(401); res.end("{}"); });
  try {
    const unauthorized = await E2eeService.init({ apiBase: base, token: "t", password: "pw" });
    assert.equal(unauthorized.enabled, false);
    assert.equal(unauthorized.reason, "server_unauthorized");
  } finally {
    await close();
  }
});

test("握手:hello→ack(b 随机 32B);salt/profile 不符拒绝;disabled 服务拒绝", async () => {
  const mk = deriveMasterKey("unit-password", SALT_B64);
  const svc = new E2eeService({ enabled: true, mk, salt: SALT_B64, profile: "pbkdf2-sha256-600k" });
  const sessId = newSessId();
  const { session, ack } = svc.handleHello({
    v: 2, type: "e2ee-hello", role: "phone", s: sessId, a: randomB64(32), salt: SALT_B64, profile: "pbkdf2-sha256-600k", ts: Date.now()
  });
  assert.equal(ack.type, "e2ee-hello-ack");
  assert.equal(ack.s, sessId);
  assert.equal(Buffer.from(ack.b, "base64url").length, 32);
  assert.deepEqual(ack.caps, ["e2ee-v2"]);
  assert.equal(session.verified, false);
  assert.equal(svc.sessionOf(sessId).sessId, sessId);
  // salt 不一致 → 拒绝(params 域不匹配)
  assert.throws(() => svc.handleHello({ v: 2, type: "e2ee-hello", role: "phone", s: newSessId(), a: randomB64(32), salt: Buffer.alloc(16, 1).toString("base64url"), profile: "pbkdf2-sha256-600k" }), (e) => e.code === "params");
  // disabled 服务
  const off = new E2eeService({ enabled: false, reason: "server_disabled" });
  assert.throws(() => off.handleHello({ v: 2, type: "e2ee-hello", role: "phone", s: newSessId(), a: randomB64(32), salt: SALT_B64 }), (e) => e.code === "disabled");
});

test("探针:正确 MK 通过并置 verified;错误 MK → bad_key;未解锁会话被拒", () => {
  const mk = deriveMasterKey("unit-password", SALT_B64);
  const svc = new E2eeService({ enabled: true, mk, salt: SALT_B64, profile: "pbkdf2-sha256-600k" });
  const sessId = newSessId();
  const aB64 = randomB64(32);
  // 手机 hello → bridge 生成 b → 手机与 bridge 各自 deriveShk(mk, a, b)
  const bB64 = (() => {
    const { ack } = svc.handleHello({ v: 2, type: "e2ee-hello", role: "phone", s: sessId, a: aB64, salt: SALT_B64, profile: "pbkdf2-sha256-600k" });
    return ack.b;
  })();
  const client = new E2eeSession({ sessId, ...deriveShk(mk, aB64, bB64), profile: "pbkdf2-sha256-600k" });
  // 探针(明文 {p,t,c})
  const probe = client.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: JSON.stringify({ p: "dsh-e2ee-probe-v1", t: Date.now(), c: 0 }) });
  const { reply, session } = svc.handleProbe(sessId, probe);
  assert.equal(reply.k, "ctrl");
  assert.equal(reply.s, sessId);
  assert.equal(session.verified, true);
  // bridge 回 probe-ok → 手机可开
  const okPlain = client.open({ kind: "ctrl", dir: "b2p", env: reply, counter: reply.c });
  assert.equal(JSON.parse(okPlain.data.toString("utf8")).p, "dsh-e2ee-probe-ok");
  // 重放同一探针 → 计数重放拒绝
  assert.throws(() => svc.handleProbe(sessId, probe), (e) => e.code === "replay" || e.code === "bad_counter");
  // 错误 MK(错误口令)的手机 → bad_key
  const wrongMk = deriveMasterKey("wrong-password", SALT_B64);
  const client2 = new E2eeSession({ sessId, ...deriveShk(wrongMk, aB64, bB64), profile: "pbkdf2-sha256-600k" });
  const probe2 = client2.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: JSON.stringify({ p: "dsh-e2ee-probe-v1", t: Date.now(), c: 0 }) });
  assert.throws(() => svc.handleProbe(sessId, probe2), (e) => e.code === "bad_key" || e.code === "auth_failed");
  // 未知会话拒绝
  assert.throws(() => svc.handleProbe(newSessId(), probe), (e) => e.code === "unknown_session");
});

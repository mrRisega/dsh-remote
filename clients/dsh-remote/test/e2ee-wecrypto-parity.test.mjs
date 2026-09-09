#!/usr/bin/env node
/**
 * e2ee-wecrypto-parity.test.mjs — 手机端(浏览器 WebCrypto,native.html 抽取)与
 * 桥端(node:crypto e2ee-client.mjs)的**字节级一致性**对拍(纯函数/内存,不起进程):
 *   - MK KAT:同一固定口令/盐 → 同一 32B hex(node 与 enterprise e2ee.js 三方一致);
 *   - SHK/子密钥:同一 MK+a/b → 同一 hex;
 *   - 信封(seal/open):显式 nonce/计数/方向/kind 完全一致 → node 与 wc 产出逐字段相同
 *     (http / http-resp / w 文本+二进制 / ctrl);交叉 open 成功、篡改拒绝;
 *   - http/ws 明文编解码与信封标记头、ws 标签解析一致。
 *
 * 用法: node --test test/e2ee-wecrypto-parity.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  E2eeSession,
  decodeHttpRequestPlain as nodeDecodeReq,
  decodeHttpResponsePlain as nodeDecodeResp,
  deriveMasterKey,
  deriveShk,
  encodeHttpRequestPlain as nodeEncodeReq,
  encodeHttpResponsePlain as nodeEncodeResp,
  envelopeRequestHeaders,
  newSessId,
  parseEnvelopeMarker,
  parseWsE2eeParams,
  randomB64
} from "../e2ee-client.mjs";
import { loadNativeWcCore } from "./lib-native-e2ee.mjs";

// 与 e2ee-client.test.mjs 相同的 KAT 常量(enterprise deriveE2eeMasterKey 三方一致)
const SALT_B64 = "AAECAwQFBgcICQoLDA0ODw"; // 16B 0x00..0x0f
const EXPECTED_MK_HEX = "c73a0c5817997926c49f4902643e0203d225666b7afe60468115652ca79ec955";

const wc = await loadNativeWcCore();
const hex = (u8) => Buffer.from(u8).toString("hex");

function nodeSession(over = {}) {
  const mk = deriveMasterKey("parity-password", SALT_B64);
  const { shk, saltH } = deriveShk(mk, randomB64(32), randomB64(32));
  return new E2eeSession({ sessId: newSessId(), shk, saltH, ...over });
}

test("MK 派生:WebCrypto 与 node 同口令同盐逐字节一致(含 KAT)", async () => {
  const mkWc = await wc.wcDeriveMasterKey("dsh-e2ee-test-password", SALT_B64);
  assert.equal(mkWc.length, 32);
  assert.equal(hex(mkWc), EXPECTED_MK_HEX); // KAT(enterprise e2ee.js 参考实现)
  const mkNode = deriveMasterKey("dsh-e2ee-test-password", SALT_B64);
  assert.equal(hex(mkWc), mkNode.toString("hex"));
  // NFKC 归一(全角数字=半角)两端一致
  const fullWc = await wc.wcDeriveMasterKey("正确口令１２３", SALT_B64);
  const halfWc = await wc.wcDeriveMasterKey("正确口令123", SALT_B64);
  assert.equal(hex(fullWc), hex(halfWc));
  const fullNode = deriveMasterKey("正确口令１２３", SALT_B64);
  assert.equal(hex(fullWc), fullNode.toString("hex"));
  // 盐非法:wc 与 node 同样拒绝
  await assert.rejects(() => wc.wcDeriveMasterKey("pw", "short"), /salt 非法/);
  // 参数按服务端下发执行(iter=1 同构可算)
  const fast = await wc.wcDeriveMasterKey("pw", SALT_B64, { alg: "pbkdf2-sha256", iter: 1, dkLen: 32, hash: "sha256" });
  assert.equal(fast.length, 32);
});

test("SHK/子密钥:WebCrypto 与 node 在相同 a/b/MK 下逐字节一致", async () => {
  const mkNode = deriveMasterKey("parity-password", SALT_B64);
  const aB64 = randomB64(32);
  const bB64 = randomB64(32);
  const nodeShk = deriveShk(mkNode, aB64, bB64);
  const wcMk = await wc.wcDeriveMasterKey("parity-password", SALT_B64);
  const wcShk = await wc.wcDeriveShk(wcMk, aB64, bB64);
  assert.equal(hex(wcShk.saltH), nodeShk.saltH.toString("hex"));
  assert.equal(hex(wcShk.shk), nodeShk.shk.toString("hex"));
});

/** 同参数在 node 与 wc 各建一个会话(显式 a/b → SHK 一致)。 */
async function twinSessions() {
  const mkNode = deriveMasterKey("parity-password", SALT_B64);
  const aB64 = randomB64(32);
  const bB64 = randomB64(32);
  const sessId = newSessId();
  const wcMk = await wc.wcDeriveMasterKey("parity-password", SALT_B64);
  const { shk: wcShk, saltH: wcSaltH } = await wc.wcDeriveShk(wcMk, aB64, bB64);
  const nodeS = new E2eeSession({ sessId, ...deriveShk(mkNode, aB64, bB64) });
  const wcS = new wc.WcE2eeSession({ sessId, shk: wcShk, saltH: wcSaltH });
  return { nodeS, wcS, sessId };
}

const NONCE_12 = () => Buffer.from("00112233445566778899aabb", "hex");
const NONCE_12_B64 = "ABEiM0RVZneImaq7";

test("信封逐字段一致:http 请求 / http 响应 / w(文本·二进制)/ ctrl", async () => {
  const { nodeS, wcS } = await twinSessions();

  // http 请求(node key-info reqNonce 默认 = 信封 n)
  const reqPlain = nodeEncodeReq({ method: "POST", path: "/api/session/s1/messages?b=2", headers: { "content-type": "application/json", "x-test": "v" }, bodyB64: Buffer.from("你好 世界").toString("base64") });
  const envNode = nodeS.seal({ kind: "http", dir: "p2b", counter: 7, data: reqPlain, nonce: NONCE_12() });
  const envWc = await wcS.seal({ kind: "http", dir: "p2b", counter: 7, data: reqPlain, nonceBytes: NONCE_12() });
  assert.deepEqual(envWc, envNode, "http p2b 信封应与 node 完全一致");
  // 交叉 open 成功
  const openedByWc = await wcS.open({ kind: "http", dir: "p2b", env: envNode, counter: envNode.c });
  assert.equal(Buffer.from(openedByWc.data).toString(), Buffer.from(reqPlain).toString());

  // http 响应(http-resp key-info reqNonce = 请求 n;n 为响应 nonce)
  const respPlain = nodeEncodeResp({ status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": "10", "x-a": "1" }, bodyBuffer: Buffer.from("hello-gzip-body") });
  const envRespN = nodeS.seal({ kind: "http-resp", dir: "b2p", counter: 3, data: respPlain, reqNonceB64: NONCE_12_B64, nonce: NONCE_12() });
  const envRespW = await wcS.seal({ kind: "http-resp", dir: "b2p", counter: 3, data: respPlain, reqNonceB64: NONCE_12_B64, nonceBytes: NONCE_12() });
  assert.deepEqual(envRespW, envRespN, "http-resp b2p 信封应与 node 完全一致");
  const openedResp = await wcS.open({ kind: "http-resp", dir: "b2p", env: envRespN, counter: envRespN.c, reqNonceB64: NONCE_12_B64 });
  const rp = nodeDecodeResp(Buffer.from(openedResp.data));
  assert.equal(rp.status, 200);
  assert.equal(rp.enc, "gzip");
  assert.equal(rp.headers["content-type"], "application/json");
  assert.equal(rp.headers["content-encoding"], undefined);

  // w 文本 + 二进制
  const wsLabel = "/api/events.mux?w=0011223344556677";
  for (const [data, t] of [["ping-你好", undefined], [Buffer.from([0, 1, 2, 253, 254, 255]), 1]]) {
    const envWN = nodeS.seal({ kind: "w", dir: "p2b", counter: 0, data, t, wsLabel, nonce: NONCE_12() });
    const envWW = await wcS.seal({ kind: "w", dir: "p2b", counter: 0, data: Buffer.isBuffer(data) ? new Uint8Array(data) : data, t, wsLabel, nonceBytes: NONCE_12() });
    assert.deepEqual(envWW, envWN, "w 信封应与 node 完全一致");
    const back = await wcS.open({ kind: "w", dir: "p2b", env: envWN, counter: envWN.c, wsLabel });
    assert.equal(back.t, t === 1 ? 1 : 0);
    if (t === 1) assert.deepEqual(Buffer.from(back.data), data);
    else assert.equal(Buffer.from(back.data).toString("utf8"), data);
  }

  // ctrl 探针
  const probePlain = JSON.stringify({ p: "dsh-e2ee-probe-v1", t: 1700000000000, c: 0 });
  const envCN = nodeS.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: probePlain, nonce: NONCE_12() });
  const envCW = await wcS.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: probePlain, nonceBytes: NONCE_12() });
  assert.deepEqual(envCW, envCN, "ctrl 信封应与 node 完全一致");
});

test("交叉开包 + 篡改拒绝(方向/kind/密文被改 → wc 与 node 同判)", async () => {
  const { nodeS, wcS } = await twinSessions();
  const plain = nodeEncodeReq({ method: "GET", path: "/api/x", headers: {}, bodyB64: "" });
  const envN = nodeS.seal({ kind: "http", dir: "p2b", counter: 1, data: plain, nonce: NONCE_12() });
  const envW = await wcS.seal({ kind: "http", dir: "p2b", counter: 1, data: plain, nonceBytes: NONCE_12() });

  // 双向交叉开包(不同实现、同一会话材料)
  const n2w = await wcS.open({ kind: "http", dir: "p2b", env: envN, counter: envN.c });
  const w2n = nodeS.open({ kind: "http", dir: "p2b", env: envW, counter: envW.c });
  assert.equal(Buffer.from(n2w.data).toString("utf8"), Buffer.from(plain).toString("utf8"));
  assert.equal(Buffer.from(w2n.data).toString("utf8"), Buffer.from(plain).toString("utf8"));

  // 篡改密文:node 拒 + wc 拒(auth_failed)
  const tampered = { ...envW, d: (() => { const b = Buffer.from(envW.d, "base64url"); b[3] ^= 0xff; return b.toString("base64url"); })() };
  assert.throws(() => nodeS.open({ kind: "http", dir: "p2b", env: tampered, counter: tampered.c }), (e) => e.code === "auth_failed");
  await assert.rejects(() => wcS.open({ kind: "http", dir: "p2b", env: tampered, counter: tampered.c }), (e) => e && e.code === "auth_failed");
  // 错误方向(wc 侧密钥域分离 → auth 失败)
  await assert.rejects(() => wcS.open({ kind: "http", dir: "b2p", env: envW, counter: envW.c }), (e) => e && e.code === "auth_failed");
  // 会话不符 → bad_session
  const other = new E2eeSession({ sessId: newSessId(), shk: Buffer.alloc(32, 9), saltH: Buffer.alloc(32, 9) });
  await assert.rejects(() => wcS.open({ kind: "http", dir: "p2b", env: { ...envW, s: other.sessId }, counter: envW.c }), (e) => e && e.code === "bad_session");
});

test("信封标记头 / 明文编解码 / ws 标签:浏览器与 node 同构", async () => {
  const sessId = newSessId();
  const hNode = envelopeRequestHeaders(sessId, "http");
  const hWc = wc.wcEnvelopeHeaders(sessId, "http");
  assert.deepEqual(hWc, hNode);
  assert.deepEqual(wc.wcParseEnvelopeMarker(hWc), parseEnvelopeMarker(hNode));
  assert.equal(wc.wcHasEnvelopeMarker(hWc), true);
  assert.equal(wc.wcHasEnvelopeMarker({ "content-type": "text/html" }), false);

  const req = { method: "POST", path: "/api/echo?b=2", headers: { "content-type": "application/json", "x-test": "abc" }, bodyB64: Buffer.from("payload").toString("base64") };
  const bNode = Buffer.from(nodeEncodeReq(req));
  const bWc = wc.wcEncodeHttpRequestPlain(req);
  assert.deepEqual(Buffer.from(bWc), bNode, "请求明文 JSON 应逐字节一致");
  const decWc = wc.wcDecodeHttpRequestPlain(bWc);
  const decNode = nodeDecodeReq(bNode);
  assert.equal(decWc.method, decNode.method);
  assert.equal(decWc.path, decNode.path);
  assert.deepEqual(decWc.headers, decNode.headers);
  assert.equal(decWc.bodyB64, decNode.bodyB64);

  const respNode = nodeEncodeResp({ status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" }, bodyBuffer: Buffer.from("aGk=", "base64") });
  const respWc = wc.wcEncodeHttpResponsePlain({ status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" }, bodyB64: "aGk=" });
  assert.deepEqual(Buffer.from(respWc), Buffer.from(respNode));
  const dResp = wc.wcDecodeHttpResponsePlain(respWc);
  assert.equal(dResp.enc, "gzip");
  assert.equal(dResp.bodyB64, "aGk=");

  const path = `/api/events.mux?a=1&e2ee=${sessId}&w=0011223344556677`;
  assert.deepEqual(wc.wcParseWsE2eeParams(path), parseWsE2eeParams(path));
  assert.equal(wc.wcParseWsE2eeParams("/api/events.mux"), null);
});

test("随机化往返:wc 自洽(seal→open)与 node 交叉 20 轮", async () => {
  for (let i = 0; i < 20; i++) {
    const { nodeS, wcS } = await twinSessions();
    const wsLabel = `/stream?w=${wc.wcRandomHex(8)}`;
    const msg = "round-" + i + "-你好-" + wc.wcRandomHex(6);
    const envW = await wcS.seal({ kind: "w", dir: "p2b", counter: i, data: msg, wsLabel });
    const opened = nodeS.open({ kind: "w", dir: "p2b", env: envW, counter: i, wsLabel });
    assert.equal(Buffer.from(opened.data).toString("utf8"), msg);
    const envN = nodeS.seal({ kind: "w", dir: "b2p", counter: i, data: Buffer.from([i, i + 1, i + 2]), t: 1, wsLabel });
    const back = await wcS.open({ kind: "w", dir: "b2p", env: envN, counter: i, wsLabel });
    assert.deepEqual(Buffer.from(back.data), Buffer.from([i, i + 1, i + 2]));
  }
});

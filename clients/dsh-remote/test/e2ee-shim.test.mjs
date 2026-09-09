#!/usr/bin/env node
/**
 * e2ee-shim.test.mjs — 镜像页 E2EE shim(Phase-4)契约测试(纯函数/内存,mock 传输):
 *   A. 注入契约:injectE2eeShim / shouldInjectE2eeShim / maybeInjectE2eeShim(env 开关/
 *      非 html/防重复/非 UTF-8)与脚本内容含交接键与徽标 id;
 *   B. 上游路径归一与 §4.5 策略表(/api 排除 SSE、/sidebar、/git、/pet;channel/device
 *      形态;/plugins|/assets|/manifest|/_e2ee|跨源明文);
 *   C. 信封字节一致性:镜像 shim(浏览器 WebCrypto 抽取)↔ 桥端 node e2ee-client(同一
 *      会话材料 → 信封逐字段一致、交叉开包、篡改拒绝);
 *   D. 一次性交接单:native.html 写入函数(抽取)→ 镜像 shim 读取函数(抽取)跨文件
 *      往返一致;非法输入双端拒绝;write/clear 语义;
 *   E. fetch 包装(mock 传输):命中 → 外层信封 POST + 响应信封解密重建;gzip 响应;
 *      篡改 → 显式 502 + x-dsh-e2ee-error;未命中/无会话/跨源/SSE → 原样透传;
 *   F. WS 包装(mock native socket):URL 追加 &e2ee=&w=、逐消息封/解、方向计数、
 *      binaryType=arraybuffer、重放 → 1008 关闭、非策略路径 → 原样放行。
 *
 * 真实本地 router+bridge 互通(注入 / HTTP 信封 / WS 数据流)见 e2ee-bridge.test.mjs。
 * 用法: node --test test/e2ee-shim.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  E2eeSession,
  decodeHttpRequestPlain,
  decodeHttpResponsePlain,
  deriveMasterKey,
  deriveShk,
  encodeHttpRequestPlain,
  encodeHttpResponsePlain,
  envelopeRequestHeaders,
  newSessId,
  parseWsE2eeParams,
  randomB64
} from "../e2ee-client.mjs";
import {
  injectE2eeShim,
  shouldInjectE2eeShim,
  maybeInjectE2eeShim,
  e2eeShimEnabled
} from "../e2ee-shim.mjs";
import { loadShimCore, extractShimCore } from "./lib-e2ee-shim.mjs";
import { loadNativeHandoverCore, extractNativeHandoverCore, loadNativeWcCore } from "./lib-native-e2ee.mjs";

const OFFICIAL_HTML = `<!doctype html>
<html lang="en">
<head><base href="/"><script>window.__ModuleLoader__ = { mode: "queue" }</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title></head>
<body><div id="root"></div></body></html>`;

const shim = await loadShimCore();
const nativeHo = await loadNativeHandoverCore();
const wc = await loadNativeWcCore();

/** 用同一会话材料建 node 对端(桥端视角)。 */
function peerNodeSession(seSess) {
  return new E2eeSession({
    sessId: seSess.sessId,
    shk: Buffer.from(seSess.shk),
    saltH: Buffer.from(seSess.saltH),
    profile: seSess.profile,
    epoch: seSess.epoch
  });
}
function makeSeSession(over = {}) {
  const mk = deriveMasterKey("shim-parity-password", "AAECAwQFBgcICQoLDA0ODw");
  const { shk, saltH } = deriveShk(mk, randomB64(32), randomB64(32));
  return new shim.SeSession({ sessId: newSessId(), shk: new Uint8Array(shk), saltH: new Uint8Array(saltH), ...over });
}
const NONCE_12 = () => new Uint8Array(Buffer.from("00112233445566778899aabb", "hex"));

// ============ A. 注入契约 ============

test("injectE2eeShim:官方 html 注入 style/script 于 </head> 前,且为纯 splice", () => {
  const r = injectE2eeShim(OFFICIAL_HTML);
  assert.equal(r.injected, true);
  const outHeadIdx = r.html.toLowerCase().lastIndexOf("</head>");
  const cssAt = r.html.indexOf("dsh-e2ee-shim-css");
  const jsAt = r.html.indexOf("dsh-e2ee-shim-js");
  assert.ok(cssAt > 0 && cssAt < outHeadIdx && jsAt > 0 && jsAt < outHeadIdx, "style/script 应在 </head> 之前");
  const headIdx = OFFICIAL_HTML.toLowerCase().lastIndexOf("</head>");
  assert.ok(r.html.startsWith(OFFICIAL_HTML.slice(0, headIdx)), "head 前缀原样(纯 splice)");
  assert.ok(r.html.endsWith(OFFICIAL_HTML.slice(headIdx)), "head 之后原样(纯 splice)");
  // 内容:交接键 + 徽标 + 核心区间;脚本正文不得含未转义 </script>(HTML 解析歧义)
  assert.match(r.html, /dsh-e2ee-handover/);
  assert.match(r.html, /dsh-e2ee-badge/);
  assert.match(r.html, /DSH-E2EE-SHIM-CORE-START/);
  const body = r.html.slice(jsAt).split("</script>")[0];
  assert.ok(!/<\/script/i.test(body), "shim 脚本正文不应含未转义 </script");
  assert.ok(!body.includes("<script"), "shim 脚本正文不应含嵌套 <script");
});

test("injectE2eeShim:无 </head> / 已有标记 → 原样(防重复)", () => {
  assert.equal(injectE2eeShim("<div>partial</div>").injected, false);
  const once = injectE2eeShim(OFFICIAL_HTML).html;
  const again = injectE2eeShim(once);
  assert.equal(again.injected, false);
  assert.equal(again.html, once);
});

test("shouldInjectE2eeShim:仅官方 text/html 含 </head> 非替换字符", () => {
  assert.equal(shouldInjectE2eeShim({ contentType: "text/html; charset=utf-8", html: OFFICIAL_HTML }), true);
  assert.equal(shouldInjectE2eeShim({ contentType: "text/html", html: "<html><head><title>x</title></head></html>" }), false);
  assert.equal(shouldInjectE2eeShim({ contentType: "application/json", html: OFFICIAL_HTML }), false);
  assert.equal(shouldInjectE2eeShim({ contentType: "text/html", html: "<html><title>x</title>" }), false);
  const latin1 = "\uFFFD" + "<html><head></head></html>" + OFFICIAL_HTML; // 含替换字符 → 不冒险改写
  assert.equal(shouldInjectE2eeShim({ contentType: "text/html", html: latin1 }), false);
});

test("maybeInjectE2eeShim:Buffer 级入口默认注入;DSH_E2EE_SHIM=0 关闭", () => {
  const { buf, injected } = maybeInjectE2eeShim({ buf: Buffer.from(OFFICIAL_HTML, "utf8"), contentType: "text/html" });
  assert.equal(injected, true);
  assert.ok(buf.toString("utf8").includes("data-dsh-e2ee-shim"));
  process.env.DSH_E2EE_SHIM = "0";
  try {
    assert.equal(e2eeShimEnabled(), false);
    assert.equal(maybeInjectE2eeShim({ buf: Buffer.from(OFFICIAL_HTML, "utf8"), contentType: "text/html" }).injected, false);
  } finally {
    delete process.env.DSH_E2EE_SHIM;
  }
  assert.equal(e2eeShimEnabled(), true);
  assert.equal(maybeInjectE2eeShim({ buf: Buffer.alloc(0), contentType: "text/html" }).injected, false);
});

test("e2ee-shim-script.js 核心区间存在且可抽取(>0 行)", () => {
  const core = extractShimCore();
  assert.ok(core.split("\n").length > 200);
});

// ============ B. 归一与策略表 ============

test("seUpstreamPathOf:channel/device 形态归一(与 router/native 同构)", () => {
  assert.equal(shim.seUpstreamPathOf("/remote/dev-abc123/api/session/search?b=2"), "/api/session/search?b=2");
  assert.equal(shim.seUpstreamPathOf("/remote/dev-abc123/api/session/search"), "/api/session/search");
  assert.equal(shim.seUpstreamPathOf("/remote/api/session/search?device=d1&b=2"), "/api/session/search?b=2");
  assert.equal(shim.seUpstreamPathOf("/api/session/search?b=2"), "/api/session/search?b=2");
  assert.equal(shim.seUpstreamPathOf("/remote/dev-abc123/sidebar"), "/sidebar");
  assert.equal(shim.seUpstreamPathOf("/remote/dev-abc123/"), "/");
  assert.equal(shim.seUpstreamPathOf("/"), "/");
});

test("HTTP 策略表:命中 /api|/sidebar|/git|/pet;SSE/静态/ctrl/跨源类排除", () => {
  const h = { accept: "application/json" };
  assert.equal(shim.seShouldEncryptHttp("/api/session/search", h), true);
  assert.equal(shim.seShouldEncryptHttp("/api/session/search?a=1", h), true);
  assert.equal(shim.seShouldEncryptHttp("/remote/dev-x/api/echo", h), true);
  assert.equal(shim.seShouldEncryptHttp("/remote/api/echo?device=d", h), true);
  assert.equal(shim.seShouldEncryptHttp("/sidebar/tree", h), true);
  assert.equal(shim.seShouldEncryptHttp("/git/x", h), true);
  assert.equal(shim.seShouldEncryptHttp("/pet/x", h), true);
  // SSE/静态/manifest/ctrl/非前缀 → 明文
  assert.equal(shim.seShouldEncryptHttp("/api/session/s1/events", h), false);
  assert.equal(shim.seShouldEncryptHttp("/api/session/s1/events/stream", h), false);
  assert.equal(shim.seShouldEncryptHttp("/api/events", h), false);
  assert.equal(shim.seShouldEncryptHttp("/api/events.mux", h), false); // fetch 视作 SSE 形态
  assert.equal(shim.seShouldEncryptHttp("/api/x", { accept: "text/event-stream" }), false);
  assert.equal(shim.seShouldEncryptHttp("/plugins/??@deepseek-ai/x.js", h), false);
  assert.equal(shim.seShouldEncryptHttp("/assets/app.js", h), false);
  assert.equal(shim.seShouldEncryptHttp("/manifest.json", h), false);
  assert.equal(shim.seShouldEncryptHttp("/favicon.ico", h), false);
  assert.equal(shim.seShouldEncryptHttp("/_e2ee/ctrl", h), false);
  assert.equal(shim.seShouldEncryptHttp("/dsh-remote/status", h), false);
  assert.equal(shim.seShouldEncryptHttp("/api2", h), false);
});

test("WS 策略:/api 数据流(含 events.mux)加密;静态/ctrl 放行", () => {
  assert.equal(shim.seShouldEncryptWs("/api/events.mux?x=1"), true);
  assert.equal(shim.seShouldEncryptWs("/api/session/s1/events"), true);
  assert.equal(shim.seShouldEncryptWs("/remote/dev-x/api/events.mux"), true);
  assert.equal(shim.seShouldEncryptWs("/_e2ee/ctrl"), false);
  assert.equal(shim.seShouldEncryptWs("/plugins/x"), false);
});

test("wsLabel 解析与桥端 parseWsE2eeParams 逐字段一致(字节同构)", () => {
  const sessId = newSessId();
  const w = "0011223344556677";
  const path = `/api/events.mux?a=1&e2ee=${sessId}&w=${w}`;
  const se = shim.seWsLabelParts(path);
  const node = parseWsE2eeParams(path);
  assert.equal(se.sessId, node.sessId);
  assert.equal(se.w, node.w);
  assert.equal(se.wsLabel, node.wsLabel);
  assert.equal(se.upstreamPath, node.upstreamPath);
  // 通道/设备形态:先归一(剥 /remote)再解析 —— 与 bridge 收到的帧 path 一致
  const path2 = `/remote/dev-x${path}`;
  const se2 = shim.seWsLabelParts(path2);
  assert.equal(se2.wsLabel, node.wsLabel);
  assert.equal(se2.upstreamPath, node.upstreamPath);
  assert.equal(shim.seWsLabelParts("/api/events.mux"), null);
});

// ============ C. 信封字节一致 ============

test("信封逐字段一致:http/http-resp/w(文本·二进制)/ctrl(shim ↔ node)", async () => {
  const seS = makeSeSession();
  const nodeS = peerNodeSession(seS);
  const plain = Buffer.from('{"hello":"世界"}');
  const envSE = await seS.seal({ kind: "http", dir: "p2b", counter: 7, data: plain, nonceBytes: NONCE_12() });
  const envNode = nodeS.seal({ kind: "http", dir: "p2b", counter: 7, data: plain, nonce: Buffer.from(NONCE_12()) });
  assert.deepEqual(envSE, envNode);
  // 交叉开包
  const backNode = nodeS.open({ kind: "http", dir: "p2b", env: envSE, counter: envSE.c });
  assert.equal(Buffer.from(backNode.data).toString("utf8"), '{"hello":"世界"}');

  const respPlain = encodeHttpResponsePlain({ status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" }, bodyBuffer: Buffer.from("aGk=", "base64") });
  const envRespN = nodeS.seal({ kind: "http-resp", dir: "b2p", counter: 3, data: respPlain, reqNonceB64: envSE.n, nonce: Buffer.from(NONCE_12()) });
  const envRespS = await seS.seal({ kind: "http-resp", dir: "b2p", counter: 3, data: respPlain, reqNonceB64: envSE.n, nonceBytes: NONCE_12() });
  assert.deepEqual(envRespS, envRespN);
  const openedS = await seS.open({ kind: "http-resp", dir: "b2p", env: envRespN, counter: envRespN.c, reqNonceB64: envSE.n });
  const rp = shim.seDecodeHttpRespPlain(openedS.data);
  assert.equal(rp.status, 200);
  assert.equal(rp.enc, "gzip");

  const wsLabel = "/api/events.mux?w=0011223344556677";
  const wsText = "ping-shim-你好";
  const envWN = nodeS.seal({ kind: "w", dir: "p2b", counter: 0, data: wsText, wsLabel, nonce: Buffer.from(NONCE_12()) });
  const envWS = await seS.seal({ kind: "w", dir: "p2b", counter: 0, data: wsText, wsLabel, nonceBytes: NONCE_12() });
  assert.deepEqual(envWS, envWN);
  const wBin = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const envBinS = await seS.seal({ kind: "w", dir: "p2b", counter: 1, data: wBin, t: 1, wsLabel });
  const backBin = nodeS.open({ kind: "w", dir: "p2b", env: envBinS, counter: 1, wsLabel });
  assert.deepEqual(Buffer.from(backBin.data), Buffer.from(wBin));
  // 篡改拒绝
  const tampered = { ...envWN, d: (() => { const b = Buffer.from(envWN.d, "base64url"); b[3] ^= 0xff; return b.toString("base64url"); })() };
  assert.throws(() => nodeS.open({ kind: "w", dir: "p2b", env: tampered, counter: tampered.c, wsLabel }), (e) => e.code === "auth_failed");
  await assert.rejects(() => seS.open({ kind: "w", dir: "p2b", env: tampered, counter: tampered.c, wsLabel }), (e) => e && e.code === "auth_failed");
});

test("请求信封明文编解码与信封标记头同构(node 交叉)", () => {
  const plainShim = shim.seEncodeHttpReqPlain({ method: "POST", path: "/api/echo?b=2", headers: { "content-type": "application/json", "x-t": "v" }, bodyBytes: new Uint8Array(Buffer.from("载荷", "utf8")) });
  const plainNode = encodeHttpRequestPlain({ method: "POST", path: "/api/echo?b=2", headers: { "content-type": "application/json", "x-t": "v" }, bodyB64: Buffer.from("载荷", "utf8").toString("base64") });
  assert.deepEqual(Buffer.from(plainShim), Buffer.from(plainNode));
  const sessId = newSessId();
  assert.deepEqual(shim.seEnvelopeHeaders(sessId), envelopeRequestHeaders(sessId, "http"));
});

// ============ D. 一次性交接单(native → 镜像) ============

test("交接单:native 写入(抽取真实代码)→ shim 读取(抽取真实代码)跨文件往返一致", async () => {
  const mk = await wc.wcDeriveMasterKey("handover-pw", "AAECAwQFBgcICQoLDA0ODw");
  const aB64 = wc.wcRandomB64(32);
  const bB64 = wc.wcRandomB64(32);
  const { shk, saltH } = await wc.wcDeriveShk(mk, aB64, bB64);
  const sessLike = { sessId: wc.wcNewSessId(), shk, saltH, profile: "pbkdf2-sha256-600k", epoch: 3 };

  const raw = nativeHo.dshE2eeHandoverEncode(sessLike);
  assert.ok(raw);
  const obj = JSON.parse(raw);
  assert.equal(obj.v, 2);
  assert.equal(obj.s, sessLike.sessId);
  assert.equal(obj.profile, "pbkdf2-sha256-600k");
  assert.equal(obj.epoch, 3);
  // shim 侧解码 → 会话重建(字节一致)
  const parsed = shim.seHandoverDecode(raw);
  assert.ok(parsed);
  assert.equal(parsed.s, sessLike.sessId);
  assert.deepEqual(Buffer.from(parsed.shk), Buffer.from(shk));
  assert.deepEqual(Buffer.from(parsed.saltH), Buffer.from(saltH));
  const sess = shim.seSessionOfHandover(raw);
  assert.ok(sess && sess.sessId === sessLike.sessId);
});

test("交接单:非法输入 native/shim 双端拒绝;write/clear 语义(mock storage)", () => {
  assert.equal(nativeHo.dshE2eeHandoverEncode(null), null);
  assert.equal(nativeHo.dshE2eeHandoverEncode({ sessId: "zz", shk: new Uint8Array(32), saltH: new Uint8Array(32) }), null);
  assert.equal(nativeHo.dshE2eeHandoverEncode({ sessId: "a".repeat(32), shk: new Uint8Array(8), saltH: new Uint8Array(32) }), null);
  assert.equal(shim.seHandoverDecode("not json"), null);
  assert.equal(shim.seHandoverDecode(JSON.stringify({ v: 1, s: "a".repeat(32) })), null);
  assert.equal(shim.seHandoverDecode(JSON.stringify({ v: 2, s: "a".repeat(32), shk: "!!", salt: "!!" })), null);

  const storage = new Map();
  const mock = { getItem: (k) => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  nativeHo.dshE2eeHandoverWrite({ sessId: "a".repeat(32), shk: new Uint8Array(32).fill(1), saltH: new Uint8Array(32).fill(2) }, mock);
  assert.equal(storage.has(nativeHo.DSH_E2EE_HANDOVER_KEY), true);
  nativeHo.dshE2eeHandoverClear(mock);
  assert.equal(storage.has(nativeHo.DSH_E2EE_HANDOVER_KEY), false);
  // write 对非法会话不落键;storage 异常不抛
  nativeHo.dshE2eeHandoverWrite({ sessId: "bad" }, mock);
  assert.equal(storage.has(nativeHo.DSH_E2EE_HANDOVER_KEY), false);
  nativeHo.dshE2eeHandoverClear({ removeItem() { throw new Error("x"); } });
});

// ============ E. fetch 包装(mock 传输) ============

/** 建一个「桥端」node 会话作为 mock 传输对端。 */
function bridgePeer(sessId, shkBytes, saltHBytes) {
  return new E2eeSession({ sessId, shk: Buffer.from(shkBytes), saltH: Buffer.from(saltHBytes) });
}

test("fetch 包装:命中策略 → 外层信封 POST + 响应信封解密重建(含 gzip)", async () => {
  const seS = makeSeSession();
  const peer = bridgePeer(seS.sessId, seS.shk, seS.saltH);
  const ORIGIN = "http://relay.local";
  const sent = [];
  const mockTransport = async (input, init) => {
    sent.push({ input: String(input), init });
    const envReq = JSON.parse(init.body);
    assert.equal(init.method, "POST");
    assert.ok(init.headers["content-type"].startsWith("application/vnd.dsh.e2ee-v2"));
    // 桥端打开请求信封 → 校验内容
    const opened = peer.open({ kind: "http", dir: "p2b", env: envReq, counter: envReq.c ?? 0 });
    const req = decodeHttpRequestPlain(opened.data);
    assert.equal(req.method, "PUT");
    assert.equal(req.path, "/api/session/s1/messages?x=1");
    assert.equal(Buffer.from(req.bodyB64, "base64").toString("utf8"), "你好 body");
    // 响应(压缩先于加密)→ 封回
    const gz = gzipSync("mirror html 内容-".repeat(20));
    const plain = encodeHttpResponsePlain({ status: 201, headers: { "content-type": "application/json", "content-encoding": "gzip", "x-up": "yes" }, bodyBuffer: gz });
    const envResp = peer.seal({ kind: "http-resp", dir: "b2p", counter: envReq.c ?? 0, data: plain, reqNonceB64: envReq.n });
    return new Response(JSON.stringify(envResp), { status: 200, headers: { "content-type": "application/vnd.dsh.e2ee-v2", "x-dsh-e2ee": "v=2;s=" + seS.sessId + ";k=http-resp" } });
  };
  const res = await shim.seFetchWrapper(mockTransport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/session/s1/messages?x=1", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-custom": "abc" },
    body: "你好 body"
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("x-up"), "yes");
  assert.equal(await res.text(), "mirror html 内容-".repeat(20));
  assert.equal(sent.length, 1);
  assert.ok(String(sent[0].input).endsWith("/api/session/s1/messages?x=1"), "外层 URL 保持不变");
});

test("fetch 包装:明文响应(无信封标记)→ 原样透传;篡改响应 → 显式 502 ⚠", async () => {
  const seS = makeSeSession();
  const peer = bridgePeer(seS.sessId, seS.shk, seS.saltH);
  const ORIGIN = "http://relay.local";

  // 1) 明文响应(如 router 402/502 错误页)
  const plainTransport = async () => new Response('{"error":"quota"}', { status: 402, headers: { "content-type": "application/json" } });
  const r1 = await shim.seFetchWrapper(plainTransport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/x", { method: "GET" });
  assert.equal(r1.status, 402);
  assert.equal(await r1.text(), '{"error":"quota"}');

  // 2) 篡改密文 → 502 + x-dsh-e2ee-error + ⚠(绝不静默/绝不误转发)
  const tamperTransport = async (_input, init) => {
    const envReq = JSON.parse(init.body);
    const gz = gzipSync("secret");
    const plain = encodeHttpResponsePlain({ status: 200, headers: { "content-type": "text/plain" }, bodyBuffer: gz });
    const envResp = peer.seal({ kind: "http-resp", dir: "b2p", counter: envReq.c ?? 0, data: plain, reqNonceB64: envReq.n });
    const buf = Buffer.from(envResp.d, "base64url");
    buf[7] ^= 0xaa; // 篡改密文
    envResp.d = buf.toString("base64url");
    return new Response(JSON.stringify(envResp), { status: 200, headers: { "content-type": "application/vnd.dsh.e2ee-v2", "x-dsh-e2ee": "v=2;s=" + seS.sessId + ";k=http-resp" } });
  };
  const r2 = await shim.seFetchWrapper(tamperTransport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/x", { method: "GET" });
  assert.equal(r2.status, 502);
  assert.equal(r2.headers.get("x-dsh-e2ee-error"), "auth_failed");
  assert.match(await r2.text(), /⚠/);
});

test("fetch 包装:未命中策略/无会话/跨源/SSE/无法读取 body → 原样透传(零行为)", async () => {
  const seS = makeSeSession();
  const ORIGIN = "http://relay.local";
  let calls = 0;
  const passthrough = async (input, init) => { calls++; return new Response("plain", { status: 200 }); };
  // 无会话
  assert.equal(await (await shim.seFetchWrapper(passthrough, { sess: null, origin: ORIGIN }, ORIGIN + "/api/x", {})).text(), "plain");
  // 未命中策略(静态)
  await shim.seFetchWrapper(passthrough, { sess: seS, origin: ORIGIN }, ORIGIN + "/plugins/app.js", {});
  // 跨源
  await shim.seFetchWrapper(passthrough, { sess: seS, origin: ORIGIN }, "https://other.example/api/x", {});
  // SSE(accept)
  await shim.seFetchWrapper(passthrough, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/events", { headers: { accept: "text/event-stream" } });
  assert.equal(calls, 4);
});

// ============ F. WS 包装(mock native socket) ============

class FakeNative {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this.binaryType = "blob"; this.protocol = ""; this.extensions = ""; this.bufferedAmount = 0;
  }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ type: "close", code: code, reason: reason, target: this });
  }
  addEventListener() {}
  removeEventListener() {}
  fireOpen() { this.readyState = 1; if (this.onopen) this.onopen({ type: "open", target: this }); }
  fireMessage(data) { if (this.onmessage) this.onmessage({ type: "message", data: data, target: this }); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond, ms = 1500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 3));
  }
  throw new Error("条件未满足(超时 " + ms + "ms)");
};

test("WS 包装:URL 追加 &e2ee=&w=,逐消息封包(计数递增)且桥端可解", async () => {
  const seS = makeSeSession();
  const peer = bridgePeer(seS.sessId, seS.shk, seS.saltH);
  const ORIGIN = "http://relay.local";
  const patched = shim.seMakeWsCtor(FakeNative, { sess: seS, origin: ORIGIN });
  const ws = patched(ORIGIN + "/api/events.mux?x=1");
  assert.ok(ws instanceof shim.SeE2eeWs, "命中策略 → 套代理");
  const inner = ws._inner;
  assert.ok(inner.url.includes("e2ee=" + seS.sessId), "URL 带 e2ee");
  assert.match(inner.url, /[?&]w=[0-9a-f]{16}/, "URL 带 8B hex w");
  // 发送文本 → 外层是 w 信封,桥端逐包解开
  ws.send("ping-你好");
  ws.send("second");
  await until(() => inner.sent.length === 2);
  assert.equal(inner.sent.length, 2);
  const full = inner.url.slice(inner.url.indexOf("/api"));
  const parts = shim.seWsLabelParts(full);
  for (let i = 0; i < 2; i++) {
    const env = JSON.parse(inner.sent[i]);
    assert.equal(env.k, "w");
    assert.equal(env.c, i);
    const opened = peer.open({ kind: "w", dir: "p2b", env, counter: env.c, wsLabel: parts.wsLabel });
    const text = Buffer.from(opened.data).toString("utf8");
    assert.equal(text, i === 0 ? "ping-你好" : "second");
  }
  ws.close(1000);
});

test("WS 包装:下行信封解密→原文事件;binaryType=arraybuffer;重放 → 1008 关闭", async () => {
  const seS = makeSeSession();
  const peer = bridgePeer(seS.sessId, seS.shk, seS.saltH);
  const ORIGIN = "http://relay.local";
  const patched = shim.seMakeWsCtor(FakeNative, { sess: seS, origin: ORIGIN });
  const ws = patched(ORIGIN + "/api/events.mux");
  const inner = ws._inner;
  inner.fireOpen();
  const full = inner.url.slice(inner.url.indexOf("/api"));
  const parts = shim.seWsLabelParts(full);

  // 下行文本信封 → onmessage 收到原文
  let msgEvt = null;
  ws.onmessage = (ev) => { msgEvt = ev; };
  const env0 = peer.seal({ kind: "w", dir: "b2p", counter: 0, data: "下行你好", wsLabel: parts.wsLabel });
  inner.fireMessage(JSON.stringify(env0));
  await until(() => msgEvt && msgEvt.data === "下行你好");
  assert.equal(msgEvt.data, "下行你好");

  // 明文帧(非信封)→ 原样透传
  ws.onmessage = (ev) => { msgEvt = ev; };
  inner.fireMessage("raw-plain");
  await until(() => msgEvt && msgEvt.data === "raw-plain");
  assert.equal(msgEvt.data, "raw-plain");

  // 下行二进制(arraybuffer)
  let binEvt = null;
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => { binEvt = ev; };
  const env1 = peer.seal({ kind: "w", dir: "b2p", counter: 1, data: Buffer.from([9, 8, 7]), t: 1, wsLabel: parts.wsLabel });
  inner.fireMessage(JSON.stringify(env1));
  await until(() => binEvt && binEvt.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(binEvt.data)], [9, 8, 7]);

  // 重放(计数回退)→ 1008 关闭,显式失败
  let closed = null;
  ws.onclose = (ev) => { closed = ev; };
  inner.fireMessage(JSON.stringify(env0)); // c=0 ≤ last=1 → replay
  await until(() => closed, 800);
  assert.ok(closed, "重放应触发 close");
  assert.equal(closed.code, 1008);
});

test("WS 包装:非策略路径原样放行;同会话已标记 URL 幂等接管;异会话标记放行", () => {
  const seS = makeSeSession();
  const patched = shim.seMakeWsCtor(FakeNative, { sess: seS, origin: "http://relay.local" });
  const plain = patched("http://relay.local/dsh-remote/ws");
  assert.ok(plain instanceof FakeNative, "非数据 WS → 原生");
  assert.ok(!(plain instanceof shim.SeE2eeWs));
  // 同会话 e2ee 已标记(重开场景)→ 幂等接管,不二次加参
  const w = "0011223344556677";
  const again = patched(`http://relay.local/api/events.mux?e2ee=${seS.sessId}&w=${w}`);
  assert.ok(again instanceof shim.SeE2eeWs, "同会话已标记 URL 应幂等接管(避免原文走加密流)");
  assert.equal(again._inner.url, `ws://relay.local/api/events.mux?e2ee=${seS.sessId}&w=${w}`);
  // 异会话标记 → 原样放行(不误接管别家会话流)
  const other = patched(`http://relay.local/api/events.mux?e2ee=${"f".repeat(32)}&w=${w}`);
  assert.ok(other instanceof FakeNative);
});

test("fetch 包装:真实字节往返(shim 密封 → 桥端打开 → 封回 → shim 打开)自洽 5 轮", async () => {
  for (let i = 0; i < 5; i++) {
    const seS = makeSeSession();
    const peer = bridgePeer(seS.sessId, seS.shk, seS.saltH);
    const ORIGIN = "http://relay.local";
    const body = "round-" + i + "-中文";
    const mock = async (_input, init) => {
      const envReq = JSON.parse(init.body);
      const opened = peer.open({ kind: "http", dir: "p2b", env: envReq, counter: envReq.c ?? 0 });
      const req = decodeHttpRequestPlain(opened.data);
      const plain = encodeHttpResponsePlain({ status: 200, headers: { "content-type": "text/plain", "x-round": String(i) }, bodyBuffer: Buffer.from("echo:" + Buffer.from(req.bodyB64, "base64").toString("utf8")) });
      const envResp = peer.seal({ kind: "http-resp", dir: "b2p", counter: envReq.c ?? 0, data: plain, reqNonceB64: envReq.n });
      return new Response(JSON.stringify(envResp), { status: 200, headers: { "content-type": "application/vnd.dsh.e2ee-v2", "x-dsh-e2ee": "v=2;s=" + seS.sessId + ";k=http-resp" } });
    };
    const res = await shim.seFetchWrapper(mock, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/echo", { method: "POST", body });
    assert.equal(await res.text(), "echo:" + body);
    assert.equal(res.headers.get("x-round"), String(i));
  }
});

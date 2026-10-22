#!/usr/bin/env node
/**
 * e2ee-shim-retry.test.mjs — 镜像页 shim 的「网络层失败一次极短重试」(D,2026-10-23):
 *
 * 背景:文档预览/会话历史的数据面(`/api/workspaceFiles/*`、`/api/session/page`、
 * `/api/officeToPdf/*`)在弱网或中继限速下经常"读到一半断"——浏览器只看到一次
 * fetch reject 或空响应,上层直接落到"读取失败"(用户得手点「重新读取文件」)。
 *
 * 契约(全部用抽取出来的真实 CORE 代码 + mock 传输,不开真浏览器):
 *   A. 白名单:只认幂等读路径(目录式前缀对齐 /api/session/page 不误伤 /api/session/pages);
 *   B. fetch reject → 白名单读路径重试 1 次(共 2 次请求),第二次成功则用户无感;
 *   C. 重试必须换**新 nonce 的信封**(桥端 http nonce 防重放窗口 5 分钟,复用会被判 replay);
 *   D. 非白名单路径(fetch reject)→ 不重试,原异常原样抛出(零行为变化);
 *   E. 已有响应体的明文 4xx/5xx → 不重试;
 *   F. 信封响应体为空/非法(截断)→ 白名单读路径重试;
 *   G. 调用方已 abort → 不再重试,抛 AbortError;
 *   H. 白名单路径首次成功 → 只发 1 次(不能无脑双发)。
 *
 * 用法: node --test test/e2ee-shim-retry.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  E2eeSession,
  decodeHttpRequestPlain,
  deriveMasterKey,
  deriveShk,
  encodeHttpResponsePlain,
  newSessId,
  randomB64
} from "../e2ee-client.mjs";
import { loadShimCore } from "./lib-e2ee-shim.mjs";

const shim = await loadShimCore();
const ORIGIN = "http://relay.local";

function makeSeSession(over = {}) {
  const mk = deriveMasterKey("shim-retry-password", "AAECAwQFBgcICQoLDA0ODw");
  const { shk, saltH } = deriveShk(mk, randomB64(32), randomB64(32));
  return new shim.SeSession({ sessId: newSessId(), shk: new Uint8Array(shk), saltH: new Uint8Array(saltH), ...over });
}
/** 桥端视角的 node 对端(同一会话材料)。 */
function peerOf(seSess) {
  return new E2eeSession({ sessId: seSess.sessId, shk: Buffer.from(seSess.shk), saltH: Buffer.from(seSess.saltH) });
}
/** 把响应明文封成信封响应(桥端在回包时做的事)。 */
function envelopeResponse(peer, envReq, { status = 200, headers = {}, body = Buffer.from("ok") } = {}) {
  const plain = encodeHttpResponsePlain({ status, headers, bodyBuffer: body });
  const envResp = peer.seal({ kind: "http-resp", dir: "b2p", counter: envReq.c ?? 0, data: plain, reqNonceB64: envReq.n });
  return new Response(JSON.stringify(envResp), {
    status: 200,
    headers: { "content-type": "application/vnd.dsh.e2ee-v2", "x-dsh-e2ee": `v=2;s=${peer.sessId};k=http-resp` }
  });
}

// ============ A. 白名单 ============

test("A. 白名单:幂等读路径命中;写/上传/其它路径不命中", () => {
  const yes = [
    "/api/workspaceFiles/readBytes",
    "/api/workspaceFiles/stat",
    "/api/workspaceFiles/readBytes?x=1",
    "/api/session/page",
    "/api/session/page?sessionId=s1&offset=0",
    "/api/officeToPdf/render",
    "/api/officeToPdf/whatever"
  ];
  for (const p of yes) assert.equal(shim.seRetryableReadPath(p), true, `应命中: ${p}`);
  const no = [
    "/api/session/pages",           // 不能吃掉同名兄弟路径(精确匹配)
    "/api/session/page/extra",      // 子路径也不算(精确匹配)
    "/api/session/pageX",
    "/api/session/uploadFileBinary",
    "/api/file",
    "/api/session/list",
    "/api/workspace",
    "/plugins/app.js",
    ""
  ];
  for (const p of no) assert.equal(shim.seRetryableReadPath(p), false, `不应命中: ${p}`);
  assert.equal(shim.SE_RETRY_DELAY_MS, 300);
  assert.ok(Array.isArray(shim.SE_RETRY_PATH_PREFIXES) && shim.SE_RETRY_PATH_PREFIXES.length >= 3);
});

test("A2. 白名单口径与加密策略一致:device 形态 /remote/<dev>/api/... 也要命中", () => {
  // 客户端在 device 形态下会把路径改写成 /remote/<deviceId>/api/...
  // (见 seUpstreamPathOf 的注释):重试白名单必须先用同一函数归一,否则这类请求漏重试。
  const yes = [
    "/remote/dev-x/api/workspaceFiles/readBytes",
    "/remote/dev-x/api/workspaceFiles/stat?x=1",
    "/remote/dev-x/api/session/page",
    "/remote/dev-x/api/session/page?sessionId=s1",
    "/remote/dev-x/api/officeToPdf/render"
  ];
  for (const p of yes) assert.equal(shim.seRetryableReadPath(p), true, `device 形态应命中: ${p}`);
  const no = [
    "/remote/dev-x/api/session/pages",
    "/remote/dev-x/api/session/page/extra",
    "/remote/dev-x/api/session/uploadFileBinary",
    "/remote/dev-x/api/session/list"
  ];
  for (const p of no) assert.equal(shim.seRetryableReadPath(p), false, `device 形态不应命中: ${p}`);
  // 与 seUpstreamPathOf 口径一致:归一后应当就是白名单里的上游路径
  assert.equal(shim.seUpstreamPathOf("/remote/dev-x/api/workspaceFiles/readBytes"), "/api/workspaceFiles/readBytes");
  assert.equal(shim.seUpstreamPathOf("/remote/dev-x/api/session/page?sessionId=s1&device=dev-x"), "/api/session/page?sessionId=s1");
});

// ============ B/C. fetch reject → 重试一次 + 新 nonce ============

test("B/C. fetch reject(白名单读路径)→ 重试 1 次即成功;两次请求 nonce 不同(防 replay)", async () => {
  const seS = makeSeSession();
  const peer = peerOf(seS);
  const nonces = [];
  let calls = 0;
  const transport = async (_input, init) => {
    calls += 1;
    const envReq = JSON.parse(init.body);
    nonces.push(envReq.n);
    const opened = peer.open({ kind: "http", dir: "p2b", env: envReq, counter: envReq.c ?? 0 });
    const req = decodeHttpRequestPlain(opened.data);
    assert.equal(req.path, "/api/workspaceFiles/readBytes");
    if (calls === 1) throw new TypeError("Load failed"); // 第一次:网络层失败
    return envelopeResponse(peer, envReq, { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true,"value":"重试成功"}') });
  };
  const res = await shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/workspaceFiles/readBytes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(calls, 2, "白名单读路径的网络层失败必须重试一次(共 2 次)");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true,"value":"重试成功"}');
  assert.notEqual(nonces[0], nonces[1], "重试必须重新封新 nonce 的信封,复用会被桥端判 replay");
});

test("B/C. 请求体同样重发(重试的是同一个幂等读请求)", async () => {
  const seS = makeSeSession();
  const peer = peerOf(seS);
  const bodies = [];
  let calls = 0;
  const transport = async (_input, init) => {
    calls += 1;
    const envReq = JSON.parse(init.body);
    const opened = peer.open({ kind: "http", dir: "p2b", env: envReq, counter: envReq.c ?? 0 });
    const req = decodeHttpRequestPlain(opened.data);
    bodies.push(Buffer.from(req.bodyB64, "base64").toString("utf8"));
    if (calls === 1) throw new TypeError("Load failed");
    return envelopeResponse(peer, envReq, { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("done") });
  };
  await shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/session/page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"sessionId":"s1","offset":40}'
  });
  assert.deepEqual(bodies, ['{"sessionId":"s1","offset":40}', '{"sessionId":"s1","offset":40}']);
});

// ============ D. 非白名单:不重试 ============

test("D. 非白名单路径 fetch reject → 不重试,原异常抛出(零行为变化)", async () => {
  const seS = makeSeSession();
  let calls = 0;
  const boom = new TypeError("Load failed");
  const transport = async () => { calls += 1; throw boom; };
  await assert.rejects(
    () => shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/session/uploadFileBinary?sessionId=s", { method: "POST", body: "x" }),
    (e) => e === boom,
    "非白名单必须原样抛原异常(不能换成别的错误)"
  );
  assert.equal(calls, 1);
});

// ============ E. 已有响应体的明文错误页:不重试 ============

test("E. 明文 4xx/5xx(有响应体)→ 不重试,原样透传", async () => {
  const seS = makeSeSession();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return new Response('{"error":{"code":"upstream","message":"boom"}}', { status: 502, headers: { "content-type": "application/json" } });
  };
  const res = await shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/workspaceFiles/readBytes", { method: "POST", body: "{}" });
  assert.equal(calls, 1, "已经有响应体(哪怕是 5xx)不重试");
  assert.equal(res.status, 502);
  assert.match(await res.text(), /boom/);
});

// ============ F. 信封响应为空/截断 → 重试 ============

test("F. 信封响应体为空(截断)→ 白名单读路径重试;第二次正常则成功", async () => {
  const seS = makeSeSession();
  const peer = peerOf(seS);
  let calls = 0;
  const transport = async (_input, init) => {
    calls += 1;
    const envReq = JSON.parse(init.body);
    if (calls === 1) return new Response("", { status: 200, headers: { "content-type": "application/vnd.dsh.e2ee-v2", "x-dsh-e2ee": `v=2;s=${seS.sessId};k=http-resp` } });
    return envelopeResponse(peer, envReq, { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("第二次好了") });
  };
  const res = await shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/officeToPdf/render", { method: "POST", body: "{}" });
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "第二次好了");
});

test("F2. 非白名单的空信封响应 → 不重试,仍回显式 502 bad_envelope(原行为)", async () => {
  const seS = makeSeSession();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return new Response("", { status: 200, headers: { "content-type": "application/vnd.dsh.e2ee-v2", "x-dsh-e2ee": `v=2;s=${seS.sessId};k=http-resp` } });
  };
  const res = await shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/session/list", { method: "POST", body: "{}" });
  assert.equal(calls, 1);
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("x-dsh-e2ee-error"), "bad_envelope");
});

// ============ G. 调用方 abort:不重试 ============

test("G. 调用方已 abort → 不重试,抛 AbortError", async () => {
  const seS = makeSeSession();
  let calls = 0;
  const transport = async () => { calls += 1; throw new TypeError("Load failed"); };
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/workspaceFiles/readBytes", { method: "POST", body: "{}", signal: ac.signal }),
    (e) => e && e.name === "AbortError"
  );
  assert.equal(calls, 1, "已 abort 的请求不应再发第二次");
});

// ============ H. 首次成功:不双发 ============

test("H. 白名单路径首次成功 → 只发 1 次(不做无脑双发)", async () => {
  const seS = makeSeSession();
  const peer = peerOf(seS);
  let calls = 0;
  const transport = async (_input, init) => {
    calls += 1;
    const envReq = JSON.parse(init.body);
    return envelopeResponse(peer, envReq, { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("[]") });
  };
  const res = await shim.seFetchWrapper(transport, { sess: seS, origin: ORIGIN }, ORIGIN + "/api/workspaceFiles/stat", { method: "POST", body: "{}" });
  assert.equal(calls, 1);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "[]");
});

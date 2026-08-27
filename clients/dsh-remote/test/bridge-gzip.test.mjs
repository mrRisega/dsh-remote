#!/usr/bin/env node
/**
 * bridge 响应 gzip 压缩契约测试(防回归):
 *   maybeCompressResponse 各分支单测 + 经 handleHttpFrame/doHttp 的本地上游全链路集成。
 *
 * 注意:dsh-bridge.mjs 顶层会读 DSH_BRIDGE_* 环境变量并写 .dsh-config.json,
 * 因此必须先设好 env(设备 id + 临时配置 + 本地上游地址)再动态 import。
 *
 * 用法: node --test test/bridge-gzip.test.mjs
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { gunzipSync } from "node:zlib";

// ---------- 本地假上游(doHttp 全链路用;端口先占再 import,UPSTREAM 在模块加载时固定) ----------

const BIG_JSON = JSON.stringify({
  ok: true,
  items: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `item-${i}`, desc: "x".repeat(20) }))
});
const TINY_TEXT = "tiny";

const upstream = http.createServer((req, res) => {
  if (req.url === "/big-json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(BIG_JSON);
    return;
  }
  if (req.url === "/tiny") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(TINY_TEXT);
    return;
  }
  if (req.url === "/no-content") {
    res.writeHead(204, { "content-type": "text/plain" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello-upstream");
});

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-gzip-"));
process.env.DSH_BRIDGE_DEVICE_ID = "dev-gziptest0001";
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, "config.json");

const { maybeCompressResponse, handleHttpFrame } = await new Promise((resolve, reject) => {
  upstream.listen(0, "127.0.0.1", () => {
    process.env.DSH_BRIDGE_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    import("../dsh-bridge.mjs").then(resolve, reject);
  });
});

after(() => {
  try { upstream.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---------- maybeCompressResponse 单测 ----------

const BIG = Buffer.from(BIG_JSON, "utf8"); // ≈250KB,可压缩
const GZIP_ACCEPT = "gzip, deflate, br, zstd";

test("压缩 js/json/css/svg/xml/text:返回 gzip buf + content-encoding 头,解压后与原内容一致", async () => {
  for (const contentType of [
    "application/javascript",
    "application/json; charset=utf-8",
    "text/css",
    "image/svg+xml",
    "application/xml",
    "text/html; charset=utf-8"
  ]) {
    const r = await maybeCompressResponse({
      buf: BIG, contentType, contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
    });
    assert.ok(r, `应压缩 ${contentType}`);
    assert.deepEqual(r.headers, { "content-encoding": "gzip" });
    assert.ok(r.buf.length < BIG.length, `${contentType}: gzip 后应更小 (${r.buf.length} < ${BIG.length})`);
    assert.deepEqual(gunzipSync(r.buf), BIG, `${contentType}: 解压后应与原文一致`);
  }
});

test("<1KB 不压缩", async () => {
  const small = Buffer.from("a".repeat(512));
  const r = await maybeCompressResponse({
    buf: small, contentType: "text/plain", contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
  });
  assert.equal(r, null);
});

test("上游已编码(content-encoding 非空)不叠压缩", async () => {
  const r = await maybeCompressResponse({
    buf: BIG, contentType: "application/json", contentEncoding: "gzip", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
  });
  assert.equal(r, null);
});

test("text/event-stream 不压缩(SSE 需流式逐条推)", async () => {
  const r = await maybeCompressResponse({
    buf: BIG, contentType: "text/event-stream", contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
  });
  assert.equal(r, null);
});

test("请求未带 gzip Accept-Encoding 不压缩(保守:手机可能不会解压)", async () => {
  for (const acceptEncoding of ["", "br", "deflate, br", "identity"]) {
    const r = await maybeCompressResponse({
      buf: BIG, contentType: "application/json", contentEncoding: "", acceptEncoding, status: 200, method: "GET"
    });
    assert.equal(r, null, `accept-encoding=${JSON.stringify(acceptEncoding)}`);
  }
});

test("gzip 后不比原 buf 小就不采用(不可压数据)", async () => {
  const incompressible = randomBytes(4096); // 随机字节 gzip 只会更大
  const r = await maybeCompressResponse({
    buf: incompressible, contentType: "application/json", contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
  });
  assert.equal(r, null);
});

test("HEAD / 204 / 304 不压缩(无响应体语义)", async () => {
  const cases = [
    { method: "HEAD", status: 200 },
    { method: "GET", status: 204 },
    { method: "GET", status: 304 }
  ];
  for (const c of cases) {
    const r = await maybeCompressResponse({
      buf: BIG, contentType: "application/json", contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: c.status, method: c.method
    });
    assert.equal(r, null, JSON.stringify(c));
  }
});

test("content-type 缺失/不可压缩类型不压缩", async () => {
  for (const contentType of ["", "application/octet-stream", "image/png"]) {
    const r = await maybeCompressResponse({
      buf: BIG, contentType, contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
    });
    assert.equal(r, null, `content-type=${JSON.stringify(contentType)}`);
  }
});

test("非 Buffer 输入不压缩", async () => {
  const r = await maybeCompressResponse({
    buf: "not-a-buffer-".repeat(200), contentType: "text/plain", contentEncoding: "", acceptEncoding: GZIP_ACCEPT, status: 200, method: "GET"
  });
  assert.equal(r, null);
});

// ---------- doHttp 全链路集成(handleHttpFrame → 本地上游) ----------

/** 发一帧并取回 reply。 */
async function request(frame) {
  let reply;
  const sender = (obj) => { reply = obj; return true; };
  await handleHttpFrame(sender, { type: "http", ...frame });
  return reply;
}

test("集成:大 JSON 响应带 gzip 压缩回传(content-encoding: gzip + 可解压)", async () => {
  const reply = await request({
    id: "g1",
    method: "GET",
    path: "/big-json",
    headers: { "accept-encoding": GZIP_ACCEPT, "user-agent": "phone-browser" }
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-encoding"], "gzip", "回包 headers 必须带 content-encoding: gzip(否则手机浏览器不解压 → 乱码)");
  assert.equal(reply.bodyBase64, true);
  const raw = Buffer.from(reply.body, "base64");
  assert.ok(raw.length < Buffer.byteLength(BIG_JSON), `压缩后应更小 (${raw.length} < ${Buffer.byteLength(BIG_JSON)})`);
  assert.equal(gunzipSync(raw).toString("utf8"), BIG_JSON, "gzip body 解压后应与上游原文一致");
});

test("集成:未带 gzip Accept-Encoding 时不压缩,body 为原文", async () => {
  const reply = await request({
    id: "g2",
    method: "GET",
    path: "/big-json",
    headers: { "user-agent": "phone-browser" }
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-encoding"], undefined);
  assert.equal(Buffer.from(reply.body, "base64").toString("utf8"), BIG_JSON);
});

test("集成:小响应(<1KB)不压缩", async () => {
  const reply = await request({
    id: "g3",
    method: "GET",
    path: "/tiny",
    headers: { "accept-encoding": GZIP_ACCEPT }
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-encoding"], undefined);
  assert.equal(Buffer.from(reply.body, "base64").toString("utf8"), TINY_TEXT);
});

test("集成:204 响应不压缩", async () => {
  const reply = await request({
    id: "g4",
    method: "GET",
    path: "/no-content",
    headers: { "accept-encoding": GZIP_ACCEPT }
  });
  assert.equal(reply.status, 204);
  assert.equal(reply.headers["content-encoding"], undefined);
});

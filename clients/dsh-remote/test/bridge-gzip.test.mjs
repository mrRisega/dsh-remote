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
import { gunzipSync, gzipSync } from "node:zlib";

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
  /* 模拟**真实 dsh web**:上游自己就把响应 gzip 掉并回 content-encoding: gzip
     (线上 `/plugins/??` 那个 13.4MB 的聚合包正是这样发的)。
     这条路由是 bridge「丢弃上游压缩」那个 bug 的回归哨兵 —— 见文件末尾的集成用例。 */
  if (req.url === "/upstream-gzip") {
    const body = Buffer.from(BIG_JSON, "utf8");
    if (String(req.headers["accept-encoding"] || "").includes("gzip")) {
      const z = gzipSync(body);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(z.length)
      });
      res.end(z);
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
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

test("★ 回归:上游自己 gzip 过(content-encoding: gzip),bridge 仍必须重压回传", async () => {
  /* 事故原貌(2026-09-23):
   *   undici 的 fetch 会**自动解压** body,但**保留** `content-encoding: gzip` 响应头。
   *   旧代码把该头当作"buf 已编码"传给 maybeCompressResponse → 函数保守 return null →
   *   **永不重压**。于是线上 dsh web 的 /plugins/?? 聚合包(上游 gzip 后 5.12MB)
   *   被按 13.39MB 原样塞进隧道(实测 3 次,每次 bridge 日志都是 13707KB)。
   *   免费档 1Mbps 下这一条就把首屏从 ~40 秒拖到 100+ 秒。
   *
   * 这条用例守的是:**上游压过 ≠ 我们手上是压缩数据**。bridge 手上永远是 undici 解压后的明文,
   * 所以必须照常走压缩分支 —— 一旦有人把这个头又接回去,这里立刻红。
   */
  const reply = await request({
    id: "g5",
    method: "GET",
    path: "/upstream-gzip",
    headers: { "accept-encoding": GZIP_ACCEPT, "user-agent": "phone-browser" }
  });
  assert.equal(reply.status, 200);
  assert.equal(
    reply.headers["content-encoding"],
    "gzip",
    "上游压过也照样要重压 —— 少了这个头,隧道里就是 2.6 倍的白流量"
  );
  const raw = Buffer.from(reply.body, "base64");
  const plainLen = Buffer.byteLength(BIG_JSON);
  assert.ok(raw.length < plainLen, `重压后必须小于明文 (${raw.length} < ${plainLen})`);
  assert.ok(
    raw.length < plainLen * 0.6,
    `应当真正压下去(实测明文 ${plainLen} → ${raw.length});若接近明文说明压缩没生效`
  );
  // 只解压一次就应得到原文 —— 这一条同时排除"双重 gzip"这种更坏的结果
  assert.equal(gunzipSync(raw).toString("utf8"), BIG_JSON, "只能有一层 gzip;解压一次必须就是原文");
});

test("★ 回归:上游 gzip + 客户端没带 Accept-Encoding → 不压缩,但内容仍是明文原文", async () => {
  // 上游按 accept-encoding 决定压不压;bridge 解压后原样回传(不带 content-encoding),
  // 手机端按 identity 处理 → 内容正确,只是没省流量。绝不能出现"标了 gzip 其实是明文"。
  const reply = await request({
    id: "g6",
    method: "GET",
    path: "/upstream-gzip",
    headers: { "user-agent": "phone-browser" }
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-encoding"], undefined);
  assert.equal(Buffer.from(reply.body, "base64").toString("utf8"), BIG_JSON);
});

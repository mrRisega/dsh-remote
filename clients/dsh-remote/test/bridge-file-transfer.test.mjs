#!/usr/bin/env node
/**
 * bridge-file-transfer.test.mjs — 文件上传/下载/预览这条线的 bridge 侧契约(2026-10-23):
 *
 *   A. 上传健壮性(B):
 *      - `requestBodyBytes`:http 帧 base64 / 旧协议文本的字节数(日志与 502 回包用);
 *      - `classifyUpstreamError`:超时 / 连不上 / 其它三类 code(生产 502 里 24 字节的
 *        `{"error":"fetch failed"}` 退化成用户看不懂的"上传失败"的根因之一);
 *      - 502 回包改成可读 `{error:{code,message,...}}`(保留 error 键与顶层 code/message);
 *      - 上传成功日志必须含**上行字节 + 耗时**(客服排查"上传失败"的三要素之一);
 *      - 隧道 `maxPayload` 与 relay-router 的 WS_MAX_PAYLOAD(256MB) 对齐,且真的传给
 *        `new WebSocket`(否则 100MiB 默认值会被大上传帧 1009 打断 → 连续 502 device_offline)。
 *
 *   B. 下载(C):
 *      - `/api/file` 的**导航**响应补 `Content-Disposition: attachment; filename*=UTF-8''…`;
 *      - 图片/子资源(sec-fetch-dest=image)、非导航、上游已有该头、非 /api/file 一律不动;
 *      - 走真实 handleHttpFrame → doHttp → 本地上游全链路,body 不被改动。
 *
 * 用法: node --test test/bridge-file-transfer.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const BRIDGE_SRC = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dsh-bridge.mjs");

/** 假上游:dsh web 的最小替身。 */
const PDF_BYTES = Buffer.from("%PDF-1.4\n% test pdf body " + "x".repeat(2048) + "\n%%EOF\n", "utf8");
const upstream = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/api/file") {
    if (u.searchParams.get("miss") === "1") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    if (u.searchParams.get("withcd") === "1") {
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'inline; filename="upstream.pdf"' });
      res.end(PDF_BYTES);
      return;
    }
    res.writeHead(200, { "content-type": "application/pdf", "cache-control": "private, no-store" });
    res.end(PDF_BYTES);
    return;
  }
  if (u.pathname === "/api/session/uploadFileBinary") {
    let n = 0;
    req.on("data", (c) => { n += c.length; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, value: { receiptId: "r1", file: { attachmentId: "sha256:x", name: u.searchParams.get("name") || "", bytes: n } } }));
    });
    return;
  }
  if (u.pathname === "/api/boom") {
    // 模拟上游连接被重置(用户关掉 dsh web / Electron 退出)
    try { req.socket.destroy(); } catch { /* ignore */ }
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("ok");
});

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-filetransfer-"));
process.env.DSH_BRIDGE_DEVICE_ID = "dev-filetrf00001";
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, "config.json");

const bridge = await new Promise((resolve, reject) => {
  upstream.listen(0, "127.0.0.1", () => {
    process.env.DSH_BRIDGE_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    import("../dsh-bridge.mjs").then(resolve, reject);
  });
});
const { handleHttpFrame, requestBodyBytes, classifyUpstreamError, downloadDispositionOf, downloadFilenameOf, TUNNEL_WS_OPTIONS, TUNNEL_WS_MAX_PAYLOAD } = bridge;

after(() => {
  try { upstream.close(); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 发一帧并取回 reply(与 bridge-gzip 用例同构)。 */
async function request(frame) {
  let reply;
  const sender = (obj) => { reply = obj; return true; };
  await handleHttpFrame(sender, { type: "http", ...frame });
  return reply;
}

// ============================================================
// A. 上传健壮性(B)
// ============================================================

test("requestBodyBytes:base64 / 文本 / 空体", () => {
  assert.equal(requestBodyBytes(undefined, true), 0);
  assert.equal(requestBodyBytes("", true), 0);
  // 1MB 字节 → base64 后按 3/4 反推回 1MB
  const oneMb = Buffer.alloc(1024 * 1024, 7);
  assert.equal(requestBodyBytes(oneMb.toString("base64"), true), oneMb.length);
  // 带 padding 的短样本
  assert.equal(requestBodyBytes(Buffer.from("abc").toString("base64"), true), 3);   // YWJj
  assert.equal(requestBodyBytes(Buffer.from("ab").toString("base64"), true), 2);    // YWI=
  assert.equal(requestBodyBytes(Buffer.from("a").toString("base64"), true), 1);     // YQ==
  // 旧协议:原始文本按 UTF-8
  assert.equal(requestBodyBytes("你好", false), 6);
});

test("classifyUpstreamError:超时 / 连不上 / 其它 → 稳定 code + 可读 message", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const t = classifyUpstreamError(timeout);
  assert.equal(t.code, "upstream_timeout");
  assert.match(t.message, /没有响应|稍后重试/);

  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const r = classifyUpstreamError(refused);
  assert.equal(r.code, "upstream_unreachable");
  assert.match(r.message, /连不上电脑端|重新发现/);
  assert.equal(r.detail, "ECONNREFUSED");

  const socketErr = Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
  assert.equal(classifyUpstreamError(socketErr).code, "upstream_unreachable");

  const other = new Error("boom");
  const o = classifyUpstreamError(other);
  assert.equal(o.code, "upstream_error");
  assert.match(o.message, /boom/);
});

test("★ 上游 502 回包:可读 {error:{code,message}},不再是 {\"error\":\"fetch failed\"}", async () => {
  const reply = await request({ id: "boom1", method: "GET", path: "/api/boom", headers: {} });
  assert.equal(reply.status, 502);
  assert.match(String(reply.headers["content-type"]), /application\/json/);
  const body = JSON.parse(Buffer.from(reply.body, "base64").toString("utf8"));
  assert.equal(typeof body.error, "object", "error 必须是对象(可读 code/message),不能是裸字符串");
  assert.equal(typeof body.error.code, "string");
  assert.ok(body.error.code.length > 0);
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 8, "message 必须是一句人话,不是 'fetch failed'");
  // 兼容字段:顶层 code/message 与 error.code/message 一致
  assert.equal(body.code, body.error.code);
  assert.equal(body.message, body.error.message);
  // 诊断字段:method/path/bytes/durationMs(客服据此定位是哪次上传、传了多大)
  assert.equal(body.error.method, "GET");
  assert.equal(body.error.path, "/api/boom");
  assert.equal(typeof body.error.bytes, "number");
  assert.equal(typeof body.error.durationMs, "number");
});

test("★ 上传成功日志含上行字节与耗时(长请求可观测性)", async () => {
  const bytes = Buffer.alloc(1024 * 1024, 3); // 1MB
  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  let reply;
  try {
    reply = await request({
      id: "up1",
      method: "POST",
      path: "/api/session/uploadFileBinary?sessionId=session-test&name=big.bin",
      headers: { "content-type": "application/octet-stream" },
      body: bytes.toString("base64"),
      bodyBase64: true
    });
  } finally {
    console.log = orig;
  }
  assert.equal(reply.status, 200);
  const line = logs.find((l) => l.includes("/api/session/uploadFileBinary"));
  assert.ok(line, "上传必须留下一条日志:" + JSON.stringify(logs));
  assert.match(line, /→ 200/);
  assert.match(line, /上行 1\.00MB/, "日志必须含上行字节(排查 413/超时/断流都靠它):" + line);
  assert.match(line, /\(\d+ms/, "日志必须含耗时:" + line);
});

test("★ 隧道 ws maxPayload 与 router 对齐(256MB),且真的传给 new WebSocket", () => {
  assert.equal(TUNNEL_WS_MAX_PAYLOAD, 256 * 1024 * 1024);
  assert.equal(TUNNEL_WS_OPTIONS.maxPayload, 256 * 1024 * 1024);
  assert.equal(TUNNEL_WS_OPTIONS.followRedirects, false);
  // ws 默认 100MiB 挡不住 64MiB 请求体的 base64 帧(≈89.5MB),余量仅 ~15%;
  // 代码级断言防止以后"顺手删掉"这个选项。
  const src = readFileSync(BRIDGE_SRC, "utf8");
  assert.match(src, /new WebSocket\(endpoint, TUNNEL_WS_OPTIONS\)/, "隧道连接必须显式传 TUNNEL_WS_OPTIONS");
});

// ============================================================
// B. 下载(C)
// ============================================================

test("downloadFilenameOf:取最后一段;非法/空回落 download", () => {
  assert.equal(downloadFilenameOf("/Users/mac/TalkWithMe/incidence_test.pdf"), "incidence_test.pdf");
  assert.equal(downloadFilenameOf("/Users/mac/TalkWithMe/预览_技术SQL表_上.png"), "预览_技术SQL表_上.png");
  assert.equal(downloadFilenameOf("C:\\Users\\a\\b.zip"), "b.zip");
  assert.equal(downloadFilenameOf("/a/b/"), "b");
  assert.equal(downloadFilenameOf(""), "download");
  assert.equal(downloadFilenameOf("/"), "download");
});

test("downloadDispositionOf:导航 → attachment(RFC 5987);图片/子资源/非导航/上游已有 → 不动", () => {
  const nav = { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml" };
  const cd = downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2F%E6%8A%A5%E5%91%8A.pdf", reqHeaders: nav, resHeaders: {} });
  assert.ok(cd && cd.startsWith("attachment;"), "导航必须给 attachment:" + cd);
  assert.match(cd, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.pdf/, "中文名必须 percent-encode 进 filename*:" + cd);
  assert.match(cd, /filename="download\.pdf"/, "非 ASCII 名的 ASCII 回退用 download.<ext>(别丢扩展名):" + cd);

  // 子资源:pic 的 <img src> 加载,不能变成下载
  for (const dest of ["image", "empty", "iframe", "audio", "video"]) {
    assert.equal(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.png", reqHeaders: { "sec-fetch-dest": dest }, resHeaders: {} }), null, dest);
  }
  // 老浏览器(无 sec-fetch-dest):靠 Accept 判导航
  assert.ok(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf", reqHeaders: { accept: "text/html,application/xhtml+xml,*/*" }, resHeaders: {} }));
  assert.equal(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.png", reqHeaders: { accept: "image/avif,image/webp,*/*" }, resHeaders: {} }), null);
  // 上游已经给了(attachment 或 inline)→ 一律不覆盖
  assert.equal(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf", reqHeaders: nav, resHeaders: { "content-disposition": 'inline; filename="x.pdf"' } }), null);
  assert.equal(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf", reqHeaders: nav, resHeaders: { "Content-Disposition": 'attachment; filename="x.pdf"' } }), null);
  // 非 /api/file、非 GET → 不动
  assert.equal(downloadDispositionOf({ method: "GET", path: "/api/workspaceFiles/readBytes", reqHeaders: nav, resHeaders: {} }), null);
  assert.equal(downloadDispositionOf({ method: "POST", path: "/api/file?path=%2Ftmp%2Fa.pdf", reqHeaders: nav, resHeaders: {} }), null);
  // 显式 ?download=1 强制(即使 Accept 是图片),?download=0 强制不加
  assert.ok(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.png&download=1", reqHeaders: { "sec-fetch-dest": "image" }, resHeaders: {} }));
  assert.equal(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf&download=0", reqHeaders: nav, resHeaders: {} }), null);
});

test("集成:/api/file 导航请求 → 补 Content-Disposition,body 与上游逐字节一致", async () => {
  const reply = await request({
    id: "dl1",
    method: "GET",
    path: "/api/file?path=%2FUsers%2Fmac%2FTalkWithMe%2Fincidence_test.pdf",
    headers: { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml", "user-agent": "iPhone" }
  });
  assert.equal(reply.status, 200);
  const cd = reply.headers["content-disposition"];
  assert.ok(cd, "导航下载必须带 content-disposition:" + JSON.stringify(reply.headers));
  assert.match(cd, /^attachment;/);
  assert.match(cd, /filename\*=UTF-8''incidence_test\.pdf/);
  assert.deepEqual(Buffer.from(reply.body, "base64"), PDF_BYTES, "attachment 不能改动响应体");
});

test("集成:图片子资源请求 → 不加 Content-Disposition(聊天里 <img src=/api/file> 不受影响)", async () => {
  const reply = await request({
    id: "dl2",
    method: "GET",
    path: "/api/file?path=%2FUsers%2Fmac%2FTalkWithMe%2Fa.png",
    headers: { "sec-fetch-dest": "image", accept: "image/avif,image/webp,image/png" }
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-disposition"], undefined);
});

test("集成:上游已给 Content-Disposition → 保留上游值(不覆盖)", async () => {
  const reply = await request({
    id: "dl3",
    method: "GET",
    path: "/api/file?path=%2Ftmp%2Fa.pdf&withcd=1",
    headers: { "sec-fetch-dest": "document", accept: "text/html" }
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-disposition"], 'inline; filename="upstream.pdf"');
});

test("集成:上游 4xx/5xx 不补 attachment(否则浏览器把报错正文下载成文件)", async () => {
  const reply = await request({
    id: "dl4",
    method: "GET",
    path: "/api/file?path=%2Ftmp%2Fa.pdf&miss=1",
    headers: { "sec-fetch-dest": "document", accept: "text/html" }
  });
  assert.equal(reply.status, 404);
  assert.equal(reply.headers["content-disposition"], undefined);
  assert.equal(Buffer.from(reply.body, "base64").toString("utf8"), "not found");
});

test("downloadDispositionOf:非 2xx 一律不附加", () => {
  const nav = { "sec-fetch-dest": "document", accept: "text/html" };
  for (const status of [204, 301, 401, 404, 413, 500, 502]) {
    assert.equal(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf", status, reqHeaders: nav, resHeaders: {} }), null, String(status));
  }
  assert.ok(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf", status: 200, reqHeaders: nav, resHeaders: {} }));
  assert.ok(downloadDispositionOf({ method: "GET", path: "/api/file?path=%2Ftmp%2Fa.pdf", status: 206, reqHeaders: nav, resHeaders: {} }));
});

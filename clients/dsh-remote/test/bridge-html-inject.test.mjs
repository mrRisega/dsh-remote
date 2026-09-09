#!/usr/bin/env node
/**
 * bridge HTML 注入集成测试(经 doHttp/handleHttpFrame 全链路):
 *   - 官方特征 html 响应 → reply body 含注入的 <style data-dsh-mobile-adapter>;
 *   - 同时请求带 gzip Accept-Encoding → 仍是 gzip 且解压后含注入块(注入发生在 gzip 前);
 *   - DSH_MOBILE_ADAPTER=0 → 原样回传;
 *   - 非 html(SSE/json/二进制)不动。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { gunzipSync } from "node:zlib";

const OFFICIAL_HTML = `<!doctype html><html><head>
<script>window.__ModuleLoader__ = { mode: "queue" }</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title>
</head><body><div id="root"></div></body></html>`;

const upstream = http.createServer((req, res) => {
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(OFFICIAL_HTML);
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: hi\n\n"); // 结束的 SSE 帧(便于缓冲测试)
    return;
  }
  if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("console.log(1)");
    return;
  }
  res.writeHead(404);
  res.end("nope");
});

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-html-inject-"));
process.env.DSH_BRIDGE_DEVICE_ID = "dev-htmltest0001";
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, "config.json");
delete process.env.DSH_MOBILE_ADAPTER; // 默认开启

const { handleHttpFrame } = await new Promise((resolve, reject) => {
  upstream.listen(0, "127.0.0.1", () => {
    process.env.DSH_BRIDGE_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
    import("../dsh-bridge.mjs").then(resolve, reject);
  });
});

after(() => {
  try { upstream.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function request(frame) {
  let reply;
  const sender = (obj) => { reply = obj; return true; };
  await handleHttpFrame(sender, { type: "http", ...frame });
  return reply;
}
const decode = (reply) => {
  const buf = Buffer.from(reply.body, "base64");
  if (reply.headers["content-encoding"] === "gzip") return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
};

test("集成:官方特征 html 经 doHttp 回传时注入适配层", async () => {
  const reply = await request({ id: "h1", method: "GET", path: "/page", headers: { "accept-encoding": "gzip", "user-agent": "phone" } });
  assert.equal(reply.status, 200);
  const text = decode(reply);
  assert.ok(text.includes('data-dsh-mobile-adapter'), "应注入 style/script");
  const headIdx = text.toLowerCase().lastIndexOf("</head>");
  assert.ok(text.indexOf("dsh-mobile-adapter-css") < headIdx, "注入块应位于 </head> 前");
  // 原文其余部分保持(仅 splice)
  const oi = OFFICIAL_HTML.toLowerCase().lastIndexOf("</head>");
  assert.ok(text.startsWith(OFFICIAL_HTML.slice(0, oi)));
  assert.ok(text.endsWith(OFFICIAL_HTML.slice(oi)));
});

test("集成:注入在 gzip 前发生,回包仍可 gzip 解压且含注入块", async () => {
  const reply = await request({ id: "h2", method: "GET", path: "/page", headers: { "accept-encoding": "gzip, deflate", "user-agent": "phone" } });
  assert.equal(reply.headers["content-encoding"], "gzip", "压缩后应带 content-encoding");
  const text = decode(reply);
  assert.ok(text.includes("dsh-mobile-adapter-js"));
});

test("集成:DSH_MOBILE_ADAPTER=0 关闭注入,原样回传", async () => {
  process.env.DSH_MOBILE_ADAPTER = "0";
  try {
    const reply = await request({ id: "h3", method: "GET", path: "/page", headers: { "user-agent": "phone" } });
    const text = decode(reply);
    assert.ok(!text.includes("data-dsh-mobile-adapter"), "关闭时应原样");
    assert.equal(text, OFFICIAL_HTML);
  } finally {
    delete process.env.DSH_MOBILE_ADAPTER;
  }
});

test("集成:非 html(SSE / js / json)不动", async () => {
  const ev = await request({ id: "h4", method: "GET", path: "/events", headers: { "accept-encoding": "gzip", "user-agent": "phone" } });
  assert.equal(decode(ev), "data: hi\n\n");
  const js = await request({ id: "h5", method: "GET", path: "/app.js", headers: { "accept-encoding": "gzip", "user-agent": "phone" } });
  assert.equal(decode(js), "console.log(1)");
  assert.ok(!decode(js).includes("dsh-mobile-adapter"));
});

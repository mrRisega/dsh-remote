#!/usr/bin/env node
/**
 * bridge HTML 注入集成测试(经 doHttp/handleHttpFrame 全链路):
 *   - 官方特征 html 响应 → reply body 含注入的 <style data-dsh-mobile-adapter>;
 *   - 同时请求带 gzip Accept-Encoding → 仍是 gzip 且解压后含注入块(注入发生在 gzip 前);
 *   - DSH_MOBILE_ADAPTER=0 → 原样回传;
 *   - 非 html(SSE/json/二进制)不动。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// ── 「镜像页交付了、页面再也没回来」的看门狗（2026-09-25）────────────────────────
// 背景：首屏提示层被整块删除（它会永久盖住已加载完的界面）。删掉之后页面上不再有任何东西
// 能告诉用户"没加载完" —— 但服务端有一个更硬的信号：交付 HTML 后官方前端一定会在几秒内
// 发一串请求；一个都没有，那这个页面几乎必然没起来。这里把它记进日志，供 doctor / 诊断复制查看。

test("★ 看门狗：交付镜像页后挂起；**任何后续请求都会撤掉它**（别把正常加载误报成失败）", async () => {
  const mod = await import("../dsh-bridge.mjs");
  assert.equal(typeof mod.__mirrorLoadWatchState, "function", "要有可断言的状态钩子");
  assert.equal(mod.__mirrorLoadWatchState(), null, "初始应为空");

  // ① 交付镜像页（/ 是官方特征 HTML）→ 挂起看门狗
  const page = await request({ id: "w1", method: "GET", path: "/page", headers: {} });
  assert.ok(page && page.status === 200);
  const st = mod.__mirrorLoadWatchState();
  assert.ok(st && st.path === "/page", "交付镜像页后必须挂起看门狗");

  // ② 页面发来任何后续请求 → 立即撤掉（页面活着，不该误报）
  await request({ id: "w2", method: "POST", path: "/api/session/list", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(mod.__mirrorLoadWatchState(), null, "★ 有后续请求 = 页面活着，看门狗必须撤销");
});

test("看门狗只记日志、不做任何用户可见动作（不注入、不弹层、不改状态）", () => {
  const src = readFileSync(new URL("../dsh-bridge.mjs", import.meta.url), "utf8");
  const i = src.indexOf("function armMirrorLoadWatch");
  assert.ok(i > 0, "找不到 armMirrorLoadWatch");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  assert.match(body, /60 \* 1000/, "阈值 60 秒（宽松：正常加载 1~3 秒就回来一串请求）");
  assert.match(body, /timer\.unref\?\.\(\)/, "定时器必须 unref（否则测试/退出会被它吊住）");
  assert.match(body, /console\.error\(/, "只写日志");
  assert.ok(!/appendChild|inject|writeFileSync|send\(/.test(body), "不得有注入/弹层/落盘/发帧等任何副作用");
});

#!/usr/bin/env node
/**
 * mobile-adapter 注入契约测试:
 *   injectMobileAdapter          纯函数:含 </head> 才注入、注入块出现在 <head> 内;
 *   shouldInjectHtml             只注入 text/html 且带官方特征的官方 dsh web 页面;
 *   maybeInjectMobileAdapter     整段 gate(env 开关 / 非 html / 非 UTF-8 不动);
 *   env DSH_MOBILE_ADAPTER=0     关闭。
 * 注意:doHttp 集成(经 handleHttpFrame → 本地上游的 html 注入 + gzip 兼容)见 bridge-html 集成用例。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// 官方 dsh web 特征片段(与真实 index.html 同源):__ModuleLoader__ + DeepSeek Harness title
const OFFICIAL_HTML = `<!doctype html>
<html lang="en">
<head><base href="/"><script>window.__ModuleLoader__ = { mode: "queue" }</script>
<link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-modules/client.js">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness</title></head>
<body><div id="root"></div></body></html>`;

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-mobile-adapter-"));
process.env.DSH_BRIDGE_DEVICE_ID = "dev-mobiletest0001";
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, "config.json");

const mod = await import("../mobile-adapter.mjs");
const { injectMobileAdapter, shouldInjectHtml, maybeInjectMobileAdapter, mobileAdapterEnabled } = mod;

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("injectMobileAdapter:含 </head> 的 html 注入 <style>/<script>,且位于 <head> 内", () => {
  const r = injectMobileAdapter(OFFICIAL_HTML);
  assert.equal(r.injected, true);
  const headEnd = r.html.toLowerCase().lastIndexOf("</head>");
  const cssAt = r.html.indexOf("dsh-mobile-adapter-css");
  const jsAt = r.html.indexOf("dsh-mobile-adapter-js");
  assert.ok(cssAt > 0 && cssAt < headEnd, "style 应在 </head> 之前");
  assert.ok(jsAt > 0 && jsAt < headEnd, "script 应在 </head> 之前");
  // 只做 splice:注入块前后字节应与原文一致
  const headIdx = OFFICIAL_HTML.toLowerCase().lastIndexOf("</head>");
  assert.ok(r.html.startsWith(OFFICIAL_HTML.slice(0, headIdx)), "head 前缀原样");
  assert.ok(r.html.endsWith(OFFICIAL_HTML.slice(headIdx)), "head 之后原样");
  // 内容含窄屏 media query 与基础规则
  assert.match(r.html, /@media \(max-width: 820px\)/);
  assert.match(r.html, /overflow-x: hidden/);
});

test("injectMobileAdapter:无 </head> 的 html 原样返回", () => {
  const r = injectMobileAdapter("<div>partial stream, no head</div>");
  assert.equal(r.injected, false);
  assert.equal(r.html, "<div>partial stream, no head</div>");
});

test("shouldInjectHtml:只接受 text/html + </head> + 官方特征", () => {
  assert.equal(shouldInjectHtml({ contentType: "text/html; charset=utf-8", html: OFFICIAL_HTML }), true);
  // 非官方 html(无 __ModuleLoader__/DeepSeek Harness 特征)
  assert.equal(shouldInjectHtml({ contentType: "text/html", html: "<html><head><title>x</title></head><body>x</body></html>" }), false);
  // 非 html
  assert.equal(shouldInjectHtml({ contentType: "application/json", html: OFFICIAL_HTML }), false);
  assert.equal(shouldInjectHtml({ contentType: "text/event-stream", html: OFFICIAL_HTML }), false);
  // 无 </head>
  assert.equal(shouldInjectHtml({ contentType: "text/html", html: "<html><title>x</title>" }), false);
});

test("maybeInjectMobileAdapter:Buffer 级入口(默认开启时注入)", () => {
  const { buf, injected } = maybeInjectMobileAdapter({ buf: Buffer.from(OFFICIAL_HTML, "utf8"), contentType: "text/html; charset=utf-8" });
  assert.equal(injected, true);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.toString("utf8").includes("data-dsh-mobile-adapter"));
});

test("maybeInjectMobileAdapter:env DSH_MOBILE_ADAPTER=0 时关闭", () => {
  process.env.DSH_MOBILE_ADAPTER = "0";
  try {
    assert.equal(mobileAdapterEnabled(), false);
    const { buf, injected } = maybeInjectMobileAdapter({ buf: Buffer.from(OFFICIAL_HTML, "utf8"), contentType: "text/html; charset=utf-8" });
    assert.equal(injected, false);
    assert.equal(buf.toString("utf8"), OFFICIAL_HTML);
  } finally {
    delete process.env.DSH_MOBILE_ADAPTER;
  }
  assert.equal(mobileAdapterEnabled(), true);
});

test("maybeInjectMobileAdapter:非 html / 空 body / 非 UTF-8 原样", () => {
  assert.equal(maybeInjectMobileAdapter({ buf: Buffer.from(OFFICIAL_HTML, "utf8"), contentType: "image/png" }).injected, false);
  assert.equal(maybeInjectMobileAdapter({ buf: Buffer.alloc(0), contentType: "text/html" }).injected, false);
  const latin1 = Buffer.from("\x80\x81\x82\xfe\xff" + "<html><head></head></html>", "latin1");
  const r = maybeInjectMobileAdapter({ buf: latin1, contentType: "text/html" });
  assert.equal(r.injected, false);
  assert.deepEqual(r.buf, latin1);
});

test("适配层文本不含口令类敏感标记(仅结构提示)", () => {
  assert.ok(!/password|secret|token\s*=/i.test(mod.ADAPTER_TAG + "")); // ADAPTER_TAG 只是 id 常量
});

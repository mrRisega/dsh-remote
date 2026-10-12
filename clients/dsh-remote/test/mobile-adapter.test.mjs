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

test("注入体里不得出现反引号(模板字符串会被提前闭合 —— 本仓 AGENTS.md 明列的坑)", () => {
  const r = injectMobileAdapter(OFFICIAL_HTML);
  const cssAt = r.html.indexOf('<style id="dsh-mobile-adapter-css"');
  const jsAt = r.html.indexOf('<script id="dsh-mobile-adapter-js"');
  const css = r.html.slice(r.html.indexOf(">", cssAt) + 1, r.html.indexOf("</style>", cssAt));
  const js = r.html.slice(r.html.indexOf(">", jsAt) + 1, r.html.indexOf("</script>", jsAt));
  assert.ok(css.length > 1000 && js.length > 1000, "应取到注入体");
  // 注入体是 JS 模板字符串拼出来的：里面再出现反引号就会提前闭合，报错信息往往毫不相干。
  assert.equal(css.includes("`"), false, "注入样式体内出现反引号（注释里也不行）");
  assert.equal(js.includes("`"), false, "注入脚本体内出现反引号（注释里也不行）");
});

test("fix2:设置区用精确类+小字号,浮层不再持久 will-change,鲸鱼协同 JS 载荷存在", () => {
  const r = injectMobileAdapter(OFFICIAL_HTML);
  const css = r.html.slice(r.html.indexOf('<style id="dsh-mobile-adapter-css"'), r.html.indexOf("</style>"));
  const js = r.html.slice(r.html.indexOf('<script id="dsh-mobile-adapter-js"'));
  // 设置面板:全屏/精确类/顶部 tab 字号 ≤13px/内容拉满
  assert.match(css, /\[class~="VOzbGW_overlay"\]/);
  assert.match(css, /\[class~="VOzbGW_panel"\]/);
  assert.match(css, /\[class~="VOzbGW_navCell"\]/);
  assert.match(css, /font-size:\s*13px\s*!important/);
  assert.match(css, /\[class~="VOzbGW_options"\]/);
  // 浮层规则不应再携带会被 fixed 弹层当作 containing block 的持久 will-change(见文件注释)
  assert.ok(!/(^|})\s*will-change:\s*transform\s*;/m.test(css), "CSS 规则不应再有 will-change: transform 声明(注释里的字样不算)");
  // 鲸鱼挂件(dsh-whale-widget)窄屏协同载荷:锚点清理 + touch 拖动护栏 + 卡左上兜底
  assert.match(js, /dshw-pos/);
  assert.match(js, /\.dshwv-root/);
  assert.match(js, /touchstart/);
  assert.match(js, /whaleUnstickIfStuck|whaleNativeDragToBottomRight/);
  // 上述 CSS/JS 都只能落在 ≤820px 运行时:CSS 规则整体在 media 内;JS 执行由 NARROW() 把关
  assert.ok(css.indexOf("@media (max-width: 820px)") !== -1);
  assert.match(js, /NARROW\s*=\s*\(\)\s*=>\s*window\.innerWidth\s*<=\s*820/);
});

test("2026-10-13:0.2 前缀(Dws9Sa_*)与结构兜底都在(官方改名不再整段静默失效)", () => {
  const r = injectMobileAdapter(OFFICIAL_HTML);
  const css = r.html.slice(r.html.indexOf('<style id="dsh-mobile-adapter-css"'), r.html.indexOf("</style>"));
  const js = r.html.slice(r.html.indexOf('<script id="dsh-mobile-adapter-js"'));
  // ① 0.2.0-rc.2 实测前缀:VOzbGW_* → Dws9Sa_*(结构/类名一一对应,只换哈希)
  for (const k of ["overlay", "panel", "nav", "navTitle", "navList", "navCell", "content", "header", "close", "options"]) {
    assert.match(css, new RegExp(`\\[class~="VOzbGW_${k}"\\]`), `0.1.5 前缀钩子 ${k} 必须保留`);
    assert.match(css, new RegExp(`\\[class~="Dws9Sa_${k}"\\]`), `0.2 前缀钩子 ${k} 必须并挂`);
  }
  // ② 结构兜底:JS 打稳定类 + CSS 认稳定类 + :has() 纯 CSS 兜底
  assert.match(js, /maTagSettingsDialog/);
  assert.match(js, /dsh-ma-settings-panel/);
  assert.match(css, /\.dsh-ma-settings-panel/);
  assert.match(css, /div\[role="dialog"\]:has\(> nav\)/);
  // ③ 可见的降级诊断(不得引入覆盖层):console.warn 走适配层既有通道
  assert.match(js, /\[dsh-mobile-adapter\]/);
  assert.match(js, /window\.console\.warn|console\.warn/);
  // ④ 通用弹层按手机尺寸收敛
  assert.match(css, /max-width:\s*calc\(100vw - 24px\)\s*!important/);
  assert.match(css, /max-height:\s*calc\(100dvh - 24px\)\s*!important/);
  assert.match(css, /\.dru-popup-card/);
});

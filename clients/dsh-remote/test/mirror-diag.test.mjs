#!/usr/bin/env node
/**
 * mirror-diag.mjs —— 镜像页故障采集器的注入契约（防回归）。
 *
 * 这个文件守的是"下次故障能不能带证据回来"，本身不修任何功能，所以更不能坏：
 *   ① 注入位置必须在 </head> 前（否则文档已开始执行，抓不到启动错误）；
 *   ② 幂等：重复注入会把同一份脚本塞两遍（每次请求/每次重试都塞）；
 *   ③ 门要准：只注入官方 dsh web 文档（text/html + 宿主特征），不能污染其它响应；
 *   ④ 开关必须真的关：DSH_MIRROR_DIAG=0 → 一个字节都不注入；
 *   ⑤ 注入体不得含 </script>（会把整页截断）。
 *
 * 用法：node --test test/mirror-diag.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  injectMirrorDiag, maybeInjectMirrorDiag, shouldInjectMirrorDiag,
  mirrorDiagEnabled, DIAG_ID, DIAG_SCRIPT_PATH
} from "../mirror-diag.mjs";
import fs from "node:fs";

const HTML = `<!doctype html><html><head><title>DeepSeek Harness</title>
<script type="module" src="./assets/index.js"></script></head><body><div id="root"></div></body></html>`;

test("★ 注入到 </head> 之前，且带唯一标记（幂等可识别）", () => {
  const out = injectMirrorDiag(HTML);
  assert.equal(out.injected, true);
  const i = out.html.indexOf(`data-${DIAG_ID}`);
  assert.ok(i > 0, "必须带 data- 标记");
  assert.ok(i < out.html.indexOf("</head>"), "必须在 </head> 之前");
  assert.ok(i < out.html.indexOf("./assets/index.js"), "必须早于页面自身脚本（才能抓到启动期错误）");
  assert.ok(i < out.html.indexOf("<title>"), "必须紧跟 <head> 开头（越早越能抓到错误）");
  // 原始内容一个不丢
  assert.ok(out.html.includes('<div id="root"></div>'));
});

test("★ 幂等：已注入过就不再注入（防止重复执行/重复上报）", () => {
  const once = injectMirrorDiag(HTML);
  const twice = injectMirrorDiag(once.html);
  assert.equal(twice.injected, false);
  assert.equal(twice.html, once.html);
});

test("★ 门要准：非 HTML / 非官方文档 / 已注入 → 一律不注入", () => {
  assert.equal(shouldInjectMirrorDiag({ contentType: "application/javascript", html: HTML }), false, "JS 不注入");
  assert.equal(shouldInjectMirrorDiag({ contentType: "text/html", html: "<html><head></head><body>hi</body></html>" }), false, "非官方文档不注入");
  assert.equal(shouldInjectMirrorDiag({ contentType: "text/html", html: "<html><body>无 head</body></html>" }), false, "无 </head> 不注入");
  const injected = injectMirrorDiag(HTML).html;
  assert.equal(shouldInjectMirrorDiag({ contentType: "text/html", html: injected }), false, "已注入要跳过");
});

test("★ 开关真能关：DSH_MIRROR_DIAG=0 → 不注入（逃生口）", () => {
  const old = process.env.DSH_MIRROR_DIAG;
  try {
    process.env.DSH_MIRROR_DIAG = "0";
    assert.equal(mirrorDiagEnabled(), false);
    const r = maybeInjectMirrorDiag({ buf: Buffer.from(HTML), contentType: "text/html" });
    assert.equal(r.injected, false);
  } finally {
    if (old === undefined) delete process.env.DSH_MIRROR_DIAG; else process.env.DSH_MIRROR_DIAG = old;
  }
});

test("★ Buffer 入口：注入后仍是合法 UTF-8，且字节数增加", () => {
  const buf = Buffer.from(HTML);
  const r = maybeInjectMirrorDiag({ buf, contentType: "text/html; charset=utf-8" });
  assert.equal(r.injected, true);
  assert.ok(r.buf.length > buf.length, "注入后应变大");
  const text = r.buf.toString("utf8");
  assert.ok(text.includes("</head>") && text.includes("dsh-mirror-diag"));
  assert.ok(!text.includes("\ufffd"), "不得出现替换字符（编码破坏）");
});

test("★ 采集器源码自身：不含 </script>、不写 DOM、只在失败时上报", () => {
  const src = fs.readFileSync(DIAG_SCRIPT_PATH, "utf8");
  assert.ok(src.length > 500, "采集器不能是空壳");
  assert.ok(!/<\/script/i.test(src), "含 </script> 会把宿主文档截断");
  assert.ok(!/document\.body\.appendChild|innerHTML\s*=/.test(src), "采集器不得改动页面 DOM");
  assert.match(src, /mirror-diag/, "上报地址要对");
  assert.match(src, /Failed to load plugins/, "必须识别首页启动失败文案");
  assert.match(src, /mirror_diag|DSH_MIRROR_DIAG|pagehide/, "必须有无痕静默路径");
});

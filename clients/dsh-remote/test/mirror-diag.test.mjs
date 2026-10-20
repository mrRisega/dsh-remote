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

// ══════════════════════════════════════════════════════════════════════════════
// C4/C6（2026-10-20 诊断）：把适配层的「自动重试 / compat-official / scrim」计数带进上报
//
// 理由：服务端只有 nginx + mirror_diag 两层时，分不清"失败后是自愈了还是永久坏了"。
// 适配层把这几个计数挂在 window.__dshMaRetryStats / __dshMaDiag 上（只读），
// 采集器在**有**这些全局时把它们作为可选字段 ui 带回去；没有时整体缺省（不改变既有 payload 形状）。
// ══════════════════════════════════════════════════════════════════════════════

import vm from "node:vm";

/** 在 vm 里跑真实采集器脚本，返回 { payloads, fire, runTimers }。 */
function runDiagScript(winExtra = {}) {
  const SRC = fs.readFileSync(DIAG_SCRIPT_PATH, "utf8");
  const listeners = new Map();
  const fetches = [];
  const timers = [];
  const win = {
    location: { href: "https://n.risegao.cn:13443/remote/dev-x/", origin: "https://n.risegao.cn:13443", pathname: "/remote/dev-x/" },
    navigator: { userAgent: "iPhone Safari (mirror-diag test)" },
    localStorage: { getItem: (k) => (k === "dsh_token" ? "tk-test" : null) },
    addEventListener: (type, fn) => { const arr = listeners.get(type) || []; arr.push(fn); listeners.set(type, arr); },
    MutationObserver: undefined,
    PerformanceObserver: undefined,
    ...winExtra,
  };
  const doc = { cookie: "", body: { innerText: "" }, documentElement: {} };
  const ctx = vm.createContext({
    window: win, document: doc, W: win, D: doc,
    navigator: win.navigator, localStorage: win.localStorage,
    fetch: (url, init) => { fetches.push({ url: String(url), init }); return Promise.resolve(); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    URL, Date, Math, JSON, Object, Array, String, Number, RegExp, Boolean, Promise, Error,
  });
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx, { timeout: 5000 });
  return {
    win,
    payloads: () => fetches.map((f) => { try { return JSON.parse(f.init.body); } catch { return null; } }).filter(Boolean),
    /** 触发采集器登记的 window 事件（资源 error 在捕获阶段被接住）。 */
    fire(type, ev) { for (const fn of listeners.get(type) || []) fn(ev); },
    /** 走完所有已登记的 setTimeout（flush 延迟 2500ms）。 */
    runTimers() { const q = timers.splice(0); for (const fn of q) fn(); },
  };
}

test("★ C4/C6：适配层在场时，上报里带可选字段 ui（retry / compat / scrim）", () => {
  const env = runDiagScript({
    __dshMaRetryStats: { page: 2, res: 1, lastKind: "page:boot_failed", at: 1 },
    __dshMaDiag: { compatOfficial: { on: true }, scrim: { activations: 3, invariantHits: 1 } },
  });
  // 一条真实会触发上报的失败：/plugins/ 聚合包加载失败
  env.fire("error", { target: { src: "https://n.risegao.cn:13443/plugins/??@deepseek-ai/x.js", tagName: "SCRIPT" } });
  env.runTimers();
  const [payload] = env.payloads();
  assert.ok(payload, "有失败资源时必须上报");
  assert.equal(payload.items.length, 1, "既有 items 契约不变");
  assert.equal(payload.items[0].t, "res");
  assert.deepEqual(payload.ui.retry, { page: 2, res: 1, kind: "page:boot_failed" },
    "★ 自动重试次数必须带回去 —— 否则服务端分不清「自愈了」和「永久坏了」");
  assert.equal(payload.ui.compat, 1, "compat-official 降级也要能被服务端看见（UI 插件兼容问题的规模）");
  assert.deepEqual(payload.ui.scrim, { on: 3, fix: 1 }, "scrim 下闸/不变量摘除计数（「又点不动了」的现场证据）");
});

test("适配层不在场（旧版本/宽屏/未注入）时：payload 形状不变、不出现 ui 字段", () => {
  const env = runDiagScript();
  env.fire("error", { target: { src: "https://n.risegao.cn:13443/assets/index.js", tagName: "SCRIPT" } });
  env.runTimers();
  const [payload] = env.payloads();
  assert.ok(payload, "有失败资源时必须上报");
  assert.equal("ui" in payload, false, "没有适配层诊断时不得新增字段（老服务端/老页面兼容）");
  assert.deepEqual(Object.keys(payload).sort(), ["at", "boot_failed", "items", "kind", "page", "ua", "v"],
    "既有 payload 字段一个不多一个不少");
});

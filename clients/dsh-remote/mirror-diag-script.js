/**
 * dsh-mirror-diag — 镜像页「加载故障」采集器（由 bridge 注入到 text/html 的 </head> 前）。
 *
 * 由来（2026-10-17）：用户反馈「装了 UI 插件后打不开界面 / Failed to load plugins」，
 * 但本地与账号环境都复现不出来。生产日志里只看到 `/plugins/??…` 的 499 中断，
 * 拿不到浏览器侧的真实失败项（哪个 URL、多少毫秒、什么错误）。这个采集器就是
 * **让下一次故障自己带证据回来**。
 *
 * 设计约束（都是硬要求）：
 *   1. **绝不打扰用户**：不改 DOM、不加 UI、不阻塞渲染；任何异常都在内部吞掉。
 *   2. **只在出错时上报**：没有失败资源/脚本错误 → 一个字节都不发（零流量）。
 *   3. **不泄密**：只上报**路径**（剥掉 query/hash）、状态码、耗时、字节数、错误消息前 500 字；
 *      不上报页面内容、请求体、cookie、token、用户信息。
 *   4. **可关**：`?mirror_diag=0` 或 bridge 环境变量 `DSH_MIRROR_DIAG=0` → 完全不注入。
 *   5. **慢请求也记**：`/plugins/`、`/assets/` 加载超过 8s 记一条（这正是"插件聚合包被
 *      限速拖死 → 浏览器 499"的现场）。
 *
 * 上报地址：`/relay-api/api/mirror-diag`（企业端，需登录态；token 从 localStorage.dsh_token 取）。
 */
(function () {
  "use strict";
  var W = window, D = document;
  var VERSION = 1;
  var SLOW_MS = 8000;
  var MAX_ITEMS = 20;
  var FLUSH_DELAY = 2500;
  var ENDPOINT = "/relay-api/api/mirror-diag";
  var items = [];
  var bootFailed = [];
  var sent = false;
  var timer = null;

  function now() { return Date.now(); }
  function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
  /** 只保留同源路径（剥 query/hash），跨源整条丢弃 —— 避免把第三方 URL 带出去。 */
  function pathOf(u) {
    try {
      var x = new URL(String(u || ""), W.location.href);
      if (x.origin !== W.location.origin) return null;
      return clip(x.pathname, 300);
    } catch (e) { return null; }
  }
  function add(item) {
    if (!item || items.length >= MAX_ITEMS || sent) return;
    items.push(item);
    if (timer === null) timer = setTimeout(flush, FLUSH_DELAY);
  }
  function interesting(p) {
    return !!p && (p.indexOf("/plugins/") === 0 || p.indexOf("/assets/") === 0
      || p.indexOf("/remote/") === 0 || p.indexOf("/api/") === 0);
  }

  // ① 资源加载失败（script/link/img/fetch 的 error 事件在捕获阶段拿到 target）
  W.addEventListener("error", function (e) {
    try {
      var t = e && e.target;
      if (t && t !== W && (t.src || t.href)) {
        var p = pathOf(t.src || t.href);
        if (interesting(p)) add({ t: "res", url: p, tag: String(t.tagName || "").toLowerCase() });
        return;
      }
      if (e && e.message) add({ t: "err", msg: clip(e.message, 500), src: pathOf(e.filename) });
    } catch (x) { /* 采集器自身绝不抛 */ }
  }, true);

  // ② 未处理异常 / Promise 拒绝
  W.addEventListener("unhandledrejection", function (e) {
    try {
      var r = e && e.reason;
      var msg = r && (r.message || r.stack) ? (r.message || "") + " " + (r.stack || "") : String(r);
      add({ t: "rej", msg: clip(msg, 500) });
    } catch (x) {}
  });

  // ③ 慢资源（插件聚合包/前端主干）—— 用 Resource Timing，不额外发请求
  try {
    if (W.PerformanceObserver) {
      var po = new W.PerformanceObserver(function (list) {
        try {
          list.getEntries().forEach(function (en) {
            var p = pathOf(en.name);
            if (!interesting(p)) return;
            if (en.duration >= SLOW_MS) {
              add({ t: "slow", url: p, ms: Math.round(en.duration), bytes: en.transferSize || 0 });
            } else if (en.transferSize === 0 && en.duration > 0 && en.responseEnd > 0) {
              // transferSize 为 0 且非缓存命中 → 常见于"请求被中断/取消"
              add({ t: "zero", url: p, ms: Math.round(en.duration) });
            }
          });
        } catch (x) {}
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch (x) {}

  // ④ 首页启动失败文案（`Failed to load plugins` / `did not activate`）—— 抓具体插件名
  function scanBootFailure() {
    try {
      var txt = (D.body && D.body.innerText) || "";
      if (txt.indexOf("Failed to load plugins") < 0 && txt.indexOf("did not activate") < 0) return;
      var lines = txt.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      for (var i = 0; i < lines.length; i++) {
        if (/import failed|did not activate|pending \(waiting|: [a-z]+ failed/i.test(lines[i])) {
          if (bootFailed.length < 10) bootFailed.push(clip(lines[i], 200));
        }
      }
      if (bootFailed.length === 0) bootFailed.push("Failed to load plugins（无明细文本）");
      if (timer === null) timer = setTimeout(flush, 300);
    } catch (x) {}
  }
  try {
    var mo = new W.MutationObserver(scanBootFailure);
    if (D.documentElement) mo.observe(D.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(scanBootFailure, 6000);
    setTimeout(scanBootFailure, 15000);
  } catch (x) {}

  function token() {
    try {
      var t = W.localStorage && W.localStorage.getItem("dsh_token");
      if (t) return t;
      var m = D.cookie.match(/(?:^|;\s*)dsh_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : "";
    } catch (e) { return ""; }
  }

  /** 适配层（mobile-adapter）暴露的只读诊断：首屏自动重试次数 / compat-official 降级 / scrim 计数。
   *  为什么从这里带出去（2026-10-20 C4/C6）：服务端只有 nginx/mirror_diag 两层时，
   *  分不清"失败后是自愈了还是永久坏了" —— 这三个计数就是"自愈有没有发生"的第一手证据。
   *  没有适配层（宽屏/未注入/旧版本）时返回 undefined：字段整体缺省，不改变既有 payload 形状。 */
  function uiDiag() {
    try {
      var r = W.__dshMaRetryStats;
      var d = W.__dshMaDiag;
      if (!r && !d) return undefined;
      var out = {};
      if (r) out.retry = { page: Number(r.page) || 0, res: Number(r.res) || 0, kind: clip(r.kind || r.lastKind || "", 40) };
      if (d && d.compatOfficial) out.compat = d.compatOfficial.on ? 1 : 0;
      if (d && d.scrim) out.scrim = { on: Number(d.scrim.activations) || 0, fix: Number(d.scrim.invariantHits) || 0 };
      return out;
    } catch (e) { return undefined; }
  }

  function flush() {
    timer = null;
    if (sent || (items.length === 0 && bootFailed.length === 0)) return;
    sent = true;
    var tk = token();
    var payload = {
      v: VERSION,
      kind: bootFailed.length ? "boot" : "runtime",
      page: clip(W.location.pathname, 200),
      ua: clip(W.navigator && W.navigator.userAgent, 300),
      items: items.slice(0, MAX_ITEMS),
      boot_failed: bootFailed.slice(0, 10),
      at: now()
    };
    var ui = uiDiag();
    if (ui) payload.ui = ui;   // 可选字段：老服务端无视即可
    try {
      fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () { /* 上报失败静默：绝不影响页面 */ });
    } catch (e) { /* ignore */ }
  }

  // 页面卸载前兜底发一次（keepalive 允许在卸载后继续）
  W.addEventListener("pagehide", function () { try { if (!sent) flush(); } catch (x) {} });
})();

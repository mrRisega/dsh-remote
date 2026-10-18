#!/usr/bin/env node
/**
 * 镜像页「旧浏览器兼容层」（2026-10-18 真机事故）。
 *
 * 事故：用户在 iPhone（iOS 16.1 / 17.3）打开镜像页永远卡住、出不来对话界面。
 * mirror_diag 上报抓到真实错误：
 *   · TypeError: Promise.withResolvers is not a function   （Safari 17.4+ 才有）
 *   · AbortSignal.any is not a function                    （Safari 17.4+ 才有）
 *   · SyntaxError: Unexpected token '{'（iOS 16.1 连新语法都不支持 → 只能提示升级）
 *
 * 本文件锁三件事：
 *   ① 注入体最前面**真的补齐**了这两个运行时 API（vm 里删掉原生实现后跑，断言可用）；
 *   ② 语法级不支持 / 典型兼容报错时，会显示**顶部轻量提示条**（可关闭、非全屏、z-index 低于 FAB）；
 *   ③ 提示条只在"界面没就绪"时出现，绝不打扰正常页面。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 取注入脚本原文。 */
function adapterScript() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能从注入结果里取出脚本");
  return m[1];
}
function adapterCss() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<style id="[^"]*-css"[^>]*>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(m, "应能从注入结果里取出样式");
  return m[1];
}
/** 只取兼容层代码段（有 marker，便于独立执行）。 */
function compatBlock() {
  const src = adapterScript();
  const i = src.indexOf("===DSH-MA-COMPAT-START===");
  const j = src.indexOf("===DSH-MA-COMPAT-END===");
  assert.ok(i > 0 && j > i, "兼容层应有 START/END 标记");
  const bodyStart = src.indexOf("*/", i) + 2;           // START 注释结束
  const bodyEnd = src.lastIndexOf("/*", j);              // END 注释开始（不要把它带进来）
  return src.slice(bodyStart, bodyEnd);
}

test("★ 补齐 Promise.withResolvers 与 AbortSignal.any（老 Safari 缺这两项 → 页面永远起不来）", async () => {
  // 造一个"老 Safari"环境：独立 fake realm —— 不污染宿主全局（Promise 无 withResolvers、
  // AbortSignal 无 any；AbortController/Signal 行为与浏览器一致：abort 会派发 abort 事件）。
  const listeners = new WeakMap();
  class FakeAbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; }
    addEventListener(type, fn) {
      if (type !== "abort") return;
      const arr = listeners.get(this) || [];
      arr.push(fn);
      listeners.set(this, arr);
    }
    removeEventListener() {}
  }
  class FakeAbortController {
    constructor() { this.signal = new FakeAbortSignal(); }
    abort(reason) {
      const sig = this.signal;
      if (sig.aborted) return;
      sig.aborted = true;
      sig.reason = reason;
      for (const fn of listeners.get(sig) || []) {
        try { fn({ target: sig }); } catch (e) { /* 忽略 */ }
      }
    }
  }
  const sandbox = { console, setTimeout, clearTimeout, AbortSignal: FakeAbortSignal, AbortController: FakeAbortController, Array, Object };
  sandbox.globalThis = sandbox;
  // 老 Safari：没有 withResolvers。用包装函数暴露 Promise 构造器（不带静态 withResolvers）
  sandbox.Promise = function PromiseCompat(executor) { return new Promise(executor); };

  vm.runInNewContext(compatBlock(), sandbox, { timeout: 5000 });

  // ① withResolvers：结构正确、能 resolve
  assert.equal(typeof sandbox.Promise.withResolvers, "function", "必须补出 Promise.withResolvers");
  const wr = sandbox.Promise.withResolvers();
  assert.equal(typeof wr.resolve, "function");
  assert.equal(typeof wr.reject, "function");
  assert.ok(wr.promise instanceof Promise);
  let got = null;
  wr.promise.then((v) => { got = v; });
  wr.resolve(42);
  await new Promise((r) => setImmediate(r));
  assert.equal(got, 42, "补齐后的 promise 必须真的能用");

  // ② AbortSignal.any：任一 signal 中断 → 合并 signal 跟着中断
  assert.equal(typeof sandbox.AbortSignal.any, "function", "必须补出 AbortSignal.any");
  const c1 = new sandbox.AbortController();
  const c2 = new sandbox.AbortController();
  const combined = sandbox.AbortSignal.any([c1.signal, c2.signal]);
  assert.equal(combined.aborted, false);
  c2.abort();
  assert.equal(combined.aborted, true, "其中一个 abort → 合并 signal 必须 aborted");

  // ③ 已经 aborted 的输入 → 立即返回 aborted 的 signal
  const c3 = new sandbox.AbortController();
  c3.abort();
  assert.equal(sandbox.AbortSignal.any([c3.signal]).aborted, true);

  // ④ 常用 ES2023 方法兜底（这些也在老 Safari 上缺失）
  assert.equal(typeof sandbox.Array.prototype.findLast, "function");
  assert.equal(typeof sandbox.Array.prototype.toSorted, "function");
  assert.equal(typeof sandbox.Object.hasOwn, "function");
  assert.equal(vm.runInNewContext("[1,2,3].findLast(function(n){return n<3})", sandbox), 2);
});

test("★ 语法级不支持（老 Safari 解析不了新语法）→ 探测为不兼容并给出原因", () => {
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  sandbox.Promise = Promise;
  sandbox.AbortSignal = AbortSignal;
  // 模拟"新语法解析失败"：Function 构造器抛 SyntaxError（CSP 场景抛 EvalError 不应误判 —— 见下一条）
  sandbox.Function = function () { const e = new SyntaxError("Unexpected token '{'"); throw e; };
  vm.runInNewContext(compatBlock(), sandbox, { timeout: 5000 });
  const compat = vm.runInNewContext("maCompat", sandbox);
  assert.equal(compat.ok, false, "语法不支持必须判为不兼容");
  assert.match(compat.why, /系统版本过旧/, "要给出人能看懂的原因（系统版本过旧）");
});

test("★ CSP 禁止 eval 抛 EvalError 时**不得**误判为老浏览器（否则正常用户会被吓到）", () => {
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  sandbox.Promise = Promise;
  sandbox.AbortSignal = AbortSignal;
  // 补上 polyfill，确保唯一失败点是 EvalError
  sandbox.Function = function () { const e = new Error("Blocked by CSP"); e.name = "EvalError"; throw e; };
  // 让 withResolvers 存在，避免被当成缺失
  sandbox.Promise = Object.assign(Promise, { withResolvers: Promise.withResolvers || function () { let a, b; const p = new Promise((r, j) => { a = r; b = j; }); return { promise: p, resolve: a, reject: b }; } });
  vm.runInNewContext(compatBlock(), sandbox, { timeout: 5000 });
  const compat = vm.runInNewContext("maCompat", sandbox);
  assert.equal(typeof compat, "object");
  // EvalError 不应产生"系统版本过旧"
  assert.ok(!/系统版本过旧/.test(compat.why || ""), `CSP 的 EvalError 不得被判成语法不支持，实际 why=${compat.why}`);
});

test("★ 兼容提示条：顶部轻量条（非全屏、可关闭、z-index 低于 FAB），两个出口按钮齐全", () => {
  const src = adapterScript();
  const css = adapterCss();
  assert.match(src, /dsh-ma-compatbar/, "注入体必须有兼容提示条");
  assert.match(css, /div\.dsh-ma-compatbar\s*\{/, "必须有对应样式");
  // 顶部轻量条：fixed top，限高；不得全屏
  const barCss = css.slice(css.indexOf("div.dsh-ma-compatbar {"), css.indexOf("div.dsh-ma-compatbar[hidden]"));
  assert.match(barCss, /position:\s*fixed/, "提示条应为浮层");
  assert.match(barCss, /top:\s*0/, "应贴顶部（不挡对话区操作）");
  assert.match(barCss, /max-height:/, "必须限高，不能占满屏");
  assert.doesNotMatch(barCss, /(height|inset):\s*(100vh|0;)/, "不得写成全屏覆盖层（历史事故：全屏层曾永久盖住界面）");
  // z-index 低于 FAB（400），保证悬浮菜单永远可点
  const z = /z-index:\s*(\d+)/.exec(barCss);
  assert.ok(z && Number(z[1]) < 400, `z-index 必须低于 FAB 400，实际 ${z && z[1]}`);
  // 关闭按钮 + 两个出口
  assert.match(src, /dsh-ma-compatbar-x/, "必须有 ✕ 关闭");
  assert.match(src, /返回设备列表/, "必须有「返回设备列表」出口");
  assert.match(src, /复制诊断信息/, "必须有「复制诊断信息」出口");
});

test("★ 提示只在界面没就绪时出现（正常页面绝不被这条打扰）", () => {
  const src = adapterScript();
  const fn = src.slice(src.indexOf("function maShowCompatBar("), src.indexOf("/** 页面脚本报出"));
  assert.match(fn, /maLoadReadyNow\(\)/, "必须先判断页面已就绪，就绪则不提示");
  assert.match(fn, /maLoadReadyNow\(\)\) return/, "就绪时直接 return");
});

test("★ 注入体完整性：无 </script>、可编译（老浏览器兜底代码不能自己把文档截断）", () => {
  const src = adapterScript();
  assert.ok(!/<\/script/i.test(src), "注入体不得含 </script>");
  assert.doesNotThrow(() => new vm.Script(src), "注入体必须能被解析（否则页面直接白屏）");
  // 兼容层必须出现在脚本最前面（要在应用模块执行前补齐 API）
  const compatIdx = src.indexOf("===DSH-MA-COMPAT-START===");
  const firstAppRef = src.indexOf("__DSH_TRANSPORT__");
  assert.ok(compatIdx > 0 && compatIdx < firstAppRef, "兼容层必须排在宿主相关逻辑之前（模块执行前）");
});

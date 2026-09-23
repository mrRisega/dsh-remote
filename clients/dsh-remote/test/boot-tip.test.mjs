#!/usr/bin/env node
/**
 * 镜像页首屏加载提示的契约与行为测试（0.6.14）。
 *
 * 用户反馈：「普通用户加载进入镜像页面时等待时间较长，目前等待过程中一直在转圈。
 *          建议给普通用户增加一个友好的提示（例如提示"正在排队中"）。」
 *
 * 首屏为什么慢：镜像页要拉 dsh web 的全部客户端插件（实测 ~14 MB 的一个**不可拆分**聚合请求），
 * 免费档限速下几十秒起步。官方那个转圈不告诉用户任何事，用户只能反复刷新 —— 反而更慢。
 *
 * 这里守四件事：
 *   ① 提示必须在**页面解析的第一时间**出现（早于所有主机判定 —— 首屏慢的正是判定等不到的时候）；
 *   ② 分阶段补充说明（8s / 30s）与秒表，让"到底等了多久"可见；
 *   ③ 官方 UI 就绪后自动撤下；且有 4 分钟兜底 + pagehide/unload 清理，绝不留悬挂定时器；
 *   ④ 只做提示、不做拦截（pointer-events:none），提示失效也绝不挡住用户操作。
 *
 * 用法: node --test test/boot-tip.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "mobile-adapter.mjs"), "utf8");
const STYLE = SRC.slice(SRC.indexOf("const STYLE = `") + "const STYLE = `".length, SRC.indexOf("`;\n\n/**", SRC.indexOf("const STYLE = `")));
const SCRIPT_START = SRC.indexOf("const SCRIPT = `(() => {") + "const SCRIPT = `".length;
const SCRIPT = SRC.slice(SCRIPT_START, SRC.indexOf("`;\n\n/**", SCRIPT_START));
/**
 * 只取「首屏提示」这一段来跑行为。
 * 为什么不像别的用例那样跑整个适配层：整段要一整套 DOM 桩（抽屉/遮罩/设置面板…），
 * 而这里要验的是**提示的生命周期**，隔离出来既稳又准（改动范围也正好是这一段）。
 */
const BOOT = SCRIPT.slice(SCRIPT.indexOf("var maBootTip"), SCRIPT.indexOf("/* —— 主机门解除"));

/** 极简 DOM 桩：只支撑"提示出现/撤下"这条路径。 */
function makeDom({ body = true, ready = false, frame = false } = {}) {
  const nodes = [];
  const el = (tag) => {
    const n = {
      tagName: String(tag).toUpperCase(), className: "", _text: "", children: [], attrs: {}, parentNode: null,
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ""; },
      set textContent(v) { this._text = String(v); }, get textContent() { return this._text; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      querySelector(sel) {
        const cls = String(sel).replace(/^\./, "");
        const hit = (x) => (x.className || "").split(/\s+/).includes(cls);
        const walk = (x) => { for (const c of x.children) { if (hit(c)) return c; const d = walk(c); if (d) return d; } return null; };
        return walk(this);
      }
    };
    return n;
  };
  const doc = {
    readyState: ready ? "complete" : "loading",
    listeners: {},
    createElement: el,
    querySelector(sel) {
      if (sel === ".dsh-ma-boot") return nodes.find((n) => (n.className || "").includes("dsh-ma-boot")) || null;
      if (frame && /frame|textarea|contenteditable|textbox|sidebar-collapsed/.test(sel)) return el("div");
      return null;
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({})); }
  };
  if (body) { doc.body = el("body"); doc.body.className = ""; }
  else { doc.body = null; doc.bodyHolder = el("body"); }
  return { doc, nodes, el, attachBody() { doc.body = doc.bodyHolder; } };
}

function run(env) {
  const timers = [];
  const intervals = [];
  const win = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({})); },
    innerWidth: 390, innerHeight: 844,
    location: { href: "https://example.test/remote/dev-x/", origin: "https://example.test" },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { timers.push({ fn, ms: 0 }); return timers.length; },
    cancelAnimationFrame() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  };
  const ctx = {
    window: win,
    document: env.doc,
    location: win.location,
    navigator: { userAgent: "node-test", language: "zh-CN" },
    console: { warn() {}, log() {}, error() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Promise, Map, Set
  };
  vm.createContext(ctx);
  vm.runInContext(BOOT, ctx, { timeout: 5000 });
  return { win, timers, intervals };
}

test("样式：提示层不挡点击（pointer-events:none）、覆盖所有宽度、有转圈与秒表样式", () => {
  assert.match(STYLE, /\.dsh-ma-boot\s*\{[\s\S]*?pointer-events:\s*none/, "提示层绝不能拦截点击");
  assert.ok(!/@media \(max-width: 820px\) \{\s*\.dsh-ma-boot/.test(STYLE), "提示不受窄屏限定（Windows/桌面浏览器同样要等）");
  assert.match(STYLE, /\.dsh-ma-boot-spin/, "要有加载动画");
  assert.match(STYLE, /\.dsh-ma-boot-elapsed/, "要有秒表");
});

test("★ 行为：页面还在解析（readyState=loading）也要立刻挂出提示", () => {
  const env = makeDom({ ready: false, frame: false });
  const { win, timers } = run(env);
  // 提示挂载挂在 DOMContentLoaded 上（此时 body 可能还没出来）
  assert.ok((env.doc.listeners.DOMContentLoaded || []).length > 0, "必须监听 DOMContentLoaded 再挂提示");
  env.doc.dispatch("DOMContentLoaded");
  const tip = env.doc.body.children.find((c) => (c.className || "").includes("dsh-ma-boot"));
  assert.ok(tip, "解析阶段就要出现提示（这正是首屏最慢的时候）");
  assert.match(tip.innerHTML, /正在加载远程桌面/);
  assert.match(tip.innerHTML, /首次打开需要下载/, "要说明为什么慢");
  assert.ok(timers.some((t) => t.ms === 8000) && timers.some((t) => t.ms === 30000), "要有 8s/30s 两段补充说明");
  assert.ok(timers.some((t) => t.ms === 240000), "要有 4 分钟兜底撤下");
  assert.ok((win.listeners.pagehide || []).length > 0, "pagehide 要清理（不留悬挂定时器）");
});

test("★ 行为：官方 UI 就绪后自动撤下提示", () => {
  const env = makeDom({ ready: true, frame: true }); // ready=complete → 立即挂；frame=true → 已就绪
  const { intervals } = run(env);
  const tip = env.doc.body.children.find((c) => (c.className || "").includes("dsh-ma-boot"));
  assert.ok(tip, "先挂上");
  assert.ok(intervals.length >= 2, "要有秒表 + 就绪轮询两个定时器");
  // 两个 interval 都是 1000ms（秒表 / 就绪轮询），顺序不保证 —— 全部推一次，模拟"1 秒过去"
  intervals.forEach((t) => t.fn());
  assert.equal(tip.attrs["data-fading"], "1", "官方 UI 就绪后应进入淡出");
});

test("行为：脚本在 <head> 里先跑（readyState=loading，body 还没出来）也绝不能抛，body 就位后补挂", () => {
  // 真实时序就是这条：适配层被内联在 <head>，执行时 body 可能还不存在
  const env = makeDom({ body: false, ready: false });
  assert.doesNotThrow(() => run(env), "body 缺失时绝不能抛（适配层其他逻辑还要跑）");
  env.attachBody();
  env.doc.dispatch("DOMContentLoaded");
  const tip = env.doc.body.children.find((c) => (c.className || "").includes("dsh-ma-boot"));
  assert.ok(tip, "body 就位后补挂提示");
  assert.match(tip.innerHTML, /正在加载远程桌面/);
});

test("源码契约：提示必须早于主机判定（HOSTISH/NARROW），否则首屏最慢那段没有提示", () => {
  // ⚠️ 基准要用 **HOSTISH 的定义**（const HOSTISH =），不能用 indexOf("HOSTISH")：
  //    提示那段自己的注释里就提到了 HOSTISH，拿注释当基准会把顺序判反（第一版就这么红的）。
  const iTip = SCRIPT.indexOf("var maBootTip");
  const iHost = SCRIPT.indexOf("const HOSTISH");
  assert.ok(iTip > 0 && iHost > 0, "找不到提示段或主机判定");
  assert.ok(iTip < iHost, "提示段必须在主机判定之前");
  assert.ok(BOOT.includes("pointer-events: none") || STYLE.includes("pointer-events: none"), "必须写明不拦截点击");
  assert.ok(!/dsh-ma-boot[\s\S]{0,400}?pointer-events:\s*auto/.test(STYLE), "提示层不得改成可点击拦截");
});

#!/usr/bin/env node
/**
 * mobile-adapter 回归测试：**网络再慢，左侧抽屉按钮（汉堡）也必须最终出现**。
 *
 * 用户原话（2026-09-2x 手机实测）：
 *   「在网络比较慢的情况下，左边的抽屉按钮有时候出不来。你要考虑修复这个问题，
 *     甭管网络有多慢，都要让那个抽屉能加载出来。」
 *
 * 根因（本文件针对的 bug）：
 *   注入脚本 boot() 的**执行时机**是写死的一组固定重试
 *   （DOMContentLoaded + 700 / 1600 / 3200 / 7000 / 12000 ms），
 *   而汉堡按钮的创建排在 `if (!frame) return;` **之后**：
 *     · 官方 SPA bundle 有 13.4MB（实测未压缩），免费档被中继限速到 128KB/s 时冷启动要 1-2 分钟；
 *     · 官方 frame 在 12 秒内根本没出现 → 5 次重试全部在那一行 return
 *       → `done` 永远为 false → 汉堡按钮永远不创建 → 用户看到"左边抽屉按钮出不来"。
 *
 * 修法（本文件断言的契约）：
 *   ① 不再依赖任何固定重试窗口 —— 改成「事件驱动（MutationObserver 观察 document/subtree）
 *      + 低频兜底（setInterval 1000ms）」的**无限期**等待：只要 done 还是 false 就继续 boot()；
 *   ② done=true 之后仍有「存在性看门狗」：官方重渲染把 dsh-ma-hamburger / dsh-ma-scrim
 *      从 DOM 里冲掉时，按引用补回（节点不变 = 事件处理与类名都还在）；
 *   ③ 两条路都必须幂等、有节流（观察者回调走 rAF 合并，兜底表 1s 一跳），
 *      且页面卸载（pagehide/unload）时断开观察者与表。
 *
 * 本文件用假 DOM + vm 跑**真实注入脚本**，并把时间轴完全握在手里（不依赖真实计时器）：
 *   · flushTimeouts()  —— 把旧的固定重试窗口一次性走完（正是"窗口耗尽"的现场）；
 *   · tickIntervals()  —— 模拟兜底 setInterval 每秒一跳，可以一直跳到第 15 秒、第 60 秒；
 *   · mountFrame()     —— 模拟官方 DOM 迟到挂载，并按真实 MutationObserver 语义通知观察者。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 取注入结果里的真实 <script> 内容（不加壳，原样执行）。 */
function adapterScript() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能取出注入脚本");
  return m[1];
}

// ── 极简假 DOM（与 mobile-adapter-runtime.test.mjs 同风格，另加父子链/isConnected） ──────

class El {
  constructor(tag = "div", attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this._cls = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    this._l = new Map();
    this.style = {
      setProperty: (k, v) => { this._cssVars[k] = v; },
      removeProperty: (k) => { delete this._cssVars[k]; },
      display: "",
    };
    this._cssVars = {};
    this._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    this.hidden = false;
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !this._cls.has(c) : !!on;
        if (want) this._cls.add(c); else this._cls.delete(c);
        return want;
      },
    };
  }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    for (const m of String(html).matchAll(/<(\w+)([^>]*)>/g)) {
      const el = new El(m[1]);
      const cls = /class="([^"]*)"/.exec(m[2] || "");
      if (cls) el.className = cls[1];
      const type = /type="([^"]*)"/.exec(m[2] || "");
      if (type) el.attrs.type = type[1];
      this.appendChild(el);
    }
  }
  get innerHTML() { return this._html || ""; }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text || ""; }
  set textContent(v) { this._text = String(v); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); if (c.parent === this) c.parent = null; return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parent; } return false; }
  /* 真实 DOM 语义：节点是否还挂在文档里。本假 DOM 以"能沿 parent 链走到 doc"为准。 */
  get isConnected() { let n = this; while (n) { if (n._inDoc) return true; n = n.parent; } return false; }
  prepend() {} focus() {} blur() {} scrollIntoView() {} setPointerCapture() {}
  matches() { return false; }
  addEventListener(t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  dispatch(t, ev = {}) { for (const fn of this._l.get(t) || []) fn({ stopPropagation() {}, preventDefault() {}, ...ev }); }
  getBoundingClientRect() { return this._rect; }
  querySelector(sel) {
    const s = String(sel);
    const hit = (el) => {
      if (s.includes('input[type="range"]')) return el.tagName === "INPUT" && el.attrs.type === "range";
      if (s.startsWith(".")) return el._cls.has(s.slice(1));
      if (s.startsWith("input")) return el.tagName === "INPUT";
      return false;
    };
    return this.children.find(hit) || null;
  }
  querySelectorAll(sel) { const one = this.querySelector(sel); return one ? [one] : []; }
}

/** 记录型 MutationObserver：可被手工触发，也可被 mountFrame 按真实语义叫醒。 */
class MutationObserverStub {
  constructor(cb) { this.cb = cb; this.targets = []; this.disconnected = false; MutationObserverStub.instances.push(this); }
  observe(t, opts) { this.targets.push({ t, opts }); }
  disconnect() { this.disconnected = true; }
  fire(records) { if (!this.disconnected) this.cb(records, this); }
  static reset() { MutationObserverStub.instances = []; }
}
MutationObserverStub.instances = [];

/**
 * 搭一个"官方 index.html 已经回来、但 13.4MB 的 SPA bundle 还没渲染出 frame"的现场：
 *   · html.outerHTML 只有官方外壳特征（__ModuleLoader__ / DeepSeek Harness）——
 *     与真实 index.html 一致，**不含** frame 的任何 data-* 标记；
 *   · document.querySelector(官方 frame 选择器) 在 mountFrame() 之前一律返回 null
 *     （= 官方 UI 还没挂载，正是用户网络慢时看到的状态）。
 */
function harness({ width = 390, height = 844 } = {}) {
  MutationObserverStub.reset();
  const intervals = [];
  const timeouts = [];
  let rafs = [];
  const state = { mounted: false, pagehide: null };

  const doc = new El("#document");
  doc.tagName = "#DOCUMENT";
  doc._inDoc = true;                     // 文档根：沿 parent 链能走到它就说明"在文档里"
  const html = new El("html");
  const body = new El("body");
  doc.appendChild(html);
  html.appendChild(body);
  // 官方 index.html 外壳（真实 HTML 里就是这些字样；frame 是 bundle 跑起来之后才有的）
  // outerHTML 做成计数器：boot() 第一行的 HOSTISH() 会整段序列化它，读数就是"整页判定"的次数
  let outerHtmlReads = 0;
  Object.defineProperty(html, "outerHTML", {
    configurable: true,
    get() { outerHtmlReads += 1; return '<html><head><script>window.__ModuleLoader__ = { mode: "queue" }</script>'
      + "<title>DeepSeek Harness</title></head><body></body></html>"; },
    set() { /* 允许写入（本用例不依赖） */ },
  });

  const frame = new El("div", { class: "pI_x6G_frame" });
  frame.setAttribute("data-sidebar-collapsed", "true");
  frame.querySelector = () => null;      // 本用例不涉及第三列/overlay 识别

  doc.readyState = "complete";
  doc.documentElement = html;
  doc.body = body;
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => ({ nodeValue: t });
  doc.getElementById = () => null;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes(".pI_x6G_frame") || /\[data-(sidebar|details|rightbar)-collapsed\]/.test(s) || s.includes("[data-shell-overlay]")) {
      return state.mounted ? frame : null;   // ⬅️ 官方 UI 迟到：挂载前一律查不到
    }
    return null;
  };
  doc.querySelectorAll = () => [];

  const loc = { href: "https://n.risegao.cn:13443/remote/dev-x/", host: "n.risegao.cn", pathname: "/remote/dev-x/", origin: "https://n.risegao.cn:13443" };
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 2,
    localStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    location: loc,
    MutationObserver: MutationObserverStub,
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "", pointerEvents: "none" }),
    addEventListener(t, fn) {
      if (t === "pagehide" || t === "unload") state.pagehide = fn;
      if (t === "pageshow") state.pageshow = fn;
    },
    removeEventListener() {},
    /* 计时器全部"抓住不放"，时间轴由用例自己推 —— 不依赖真实时钟，也不会有测试结束后的悬挂回调。 */
    setTimeout: (fn) => timeouts.push(fn),
    clearTimeout: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (id) => { if (id) intervals[id - 1] = null; },
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
  };

  const ctx = vm.createContext({
    window: win, document: doc, console,
    navigator: { userAgent: "iPhone Safari", maxTouchPoints: 5, platform: "iPhone" },
    location: loc, localStorage: win.localStorage,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    setInterval: win.setInterval, clearInterval: win.clearInterval,
    MutationObserver: MutationObserverStub, ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame,
    URL, Math, JSON, Object, Array, String, Number, RegExp, Boolean, Promise, Error, isNaN, parseInt, parseFloat,
    HTMLElement: El,
  });
  ctx.globalThis = ctx;
  ctx.self = win;

  /** 官方 UI 迟到挂载：把 frame 挂进 body，并按真实 MutationObserver 语义通知观察祖先树的观察者。 */
  const mountFrame = ({ notify = true } = {}) => {
    state.mounted = true;
    body.appendChild(frame);
    if (!notify) return;
    for (const ob of MutationObserverStub.instances.slice()) {
      if (ob.disconnected) continue;
      const targets = ob.targets.map((x) => x.t);
      // 新节点加进 body → 观察 body / documentElement / document（subtree）的观察者都会收到 childList 记录
      if (targets.includes(body) || targets.includes(html) || targets.includes(doc)) {
        ob.fire([{ type: "childList", target: body, addedNodes: [frame] }]);
      }
    }
  };
  /** 把旧的"固定重试窗口"（700/1600/3200/7000/12000ms 那批 setTimeout）一次性走完。 */
  const flushTimeouts = () => { const q = timeouts.splice(0, timeouts.length); for (const fn of q) fn(); };
  /** 模拟兜底 setInterval 每秒一跳（间隔由实现决定，用例只关心"它一直在跳"）。 */
  const tickIntervals = (seconds = 1) => {
    for (let i = 0; i < seconds; i++) for (const fn of intervals.slice()) if (fn) fn();
  };
  const flushRaf = () => { const q = rafs; rafs = []; for (const fn of q) fn(); };
  /** 模拟官方 SPA 的 DOM 变更风暴（流式输出时每帧都在改 DOM），并按真实语义通知观察者。 */
  const churn = (n = 20) => {
    for (let i = 0; i < n; i++) {
      const d = new El("div");
      body.appendChild(d);
      for (const ob of MutationObserverStub.instances.slice()) {
        if (ob.disconnected) continue;
        const targets = ob.targets.map((x) => x.t);
        if (targets.includes(body) || targets.includes(html) || targets.includes(doc)) {
          ob.fire([{ type: "childList", target: body, addedNodes: [d] }]);
        }
      }
      flushRaf();
    }
  };

  return { ctx, doc, html, body, frame, win, state, mountFrame, flushTimeouts, tickIntervals, flushRaf, churn,
    intervals, outerHtmlReads: () => outerHtmlReads };
}

function run(env, js) {
  vm.runInContext(js, env.ctx, { timeout: 5000 });
  return env;
}

const findHamburger = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-hamburger"));
const findScrim = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-scrim"));

// ── 用例 ─────────────────────────────────────────────────────────────────────

test("慢网回归：官方 frame 第 15 秒才出现，汉堡按钮最终仍必须创建（旧的 12s 固定重试窗口会永久放弃）", () => {
  const env = run(harness({ width: 390 }), adapterScript());

  assert.ok(!findHamburger(env), "前提：官方 frame 还没出现时，不该凭空造出汉堡按钮");
  assert.ok(!findScrim(env), "前提：官方 frame 还没出现时，不该凭空造出遮罩");

  // ① 先把旧的固定重试窗口整批走完（700…12000ms 全部到点）—— 这正是当年"窗口耗尽"的现场
  env.flushTimeouts();
  assert.ok(!findHamburger(env), "官方 frame 未出现时仍不得创建汉堡按钮（不能提前造出无锚点的入口）");

  // ② 再把时间推过 15 秒（兜底表每秒一跳），官方 frame 依然没来
  env.tickIntervals(15);
  assert.ok(!findHamburger(env), "前提：frame 还没来");

  // ③ 第 15 秒：13.4MB 的 bundle 终于在 128KB/s 的限制下加载完，官方 frame 挂上 DOM。
  //    这里刻意不通知观察者（notify:false）—— 只留"低频兜底 setInterval"这一条路，
  //    证明它不是"靠事件侥幸"，而是真的无限期重试。
  env.mountFrame({ notify: false });
  assert.ok(!findHamburger(env), "前提：这一瞬间还没轮到兜底表跳");

  env.tickIntervals(1);
  assert.ok(findHamburger(env),
    "网络再慢，官方 frame 一出现抽屉按钮也必须最终创建出来（本次 bug 的回归点：固定重试窗口耗尽就永久放弃）");
  assert.ok(findScrim(env), "遮罩同样必须补上（它和汉堡按钮在同一段之后创建）");
});

test("慢网回归：跳到第 60 秒（远超旧窗口 5 倍）官方 frame 才出现，汉堡按钮仍必须出现", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  env.flushTimeouts();
  env.tickIntervals(60);                        // 60 秒过去，frame 还没来
  assert.ok(!findHamburger(env), "前提：frame 仍然没来");
  env.mountFrame({ notify: false });            // 第 60 秒才挂上
  env.tickIntervals(1);
  assert.ok(findHamburger(env), "「甭管网络有多慢」——60 秒后才出现官方 frame 也必须能拿到抽屉按钮");
});

test("事件驱动：官方 frame 挂载的 DOM 变更直接叫醒适配层（观察者回调经 rAF 合并，不等兜底表）", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  assert.ok(!findHamburger(env), "前提：frame 未挂载");
  env.mountFrame();                             // 通知观察者
  env.flushRaf();                               // 合并后的那一帧
  assert.ok(findHamburger(env), "官方 frame 一挂上就必须立刻跟上（事件驱动路径），不必等 1s 兜底表");
});

test("存在性看门狗：done 之后官方重渲染把汉堡/遮罩冲掉，必须按引用补回来", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  env.mountFrame({ notify: false });
  env.tickIntervals(1);
  const ham = findHamburger(env);
  const scrim = findScrim(env);
  assert.ok(ham && scrim, "前提：抽屉入口已建好");

  // 模拟官方 SPA 重渲染：整片换掉 body 子树（实测某些路由/会话切换会重建 DOM）
  env.body.removeChild(ham);
  env.body.removeChild(scrim);
  assert.ok(!findHamburger(env), "前提：官方重渲染把我们的节点冲掉了");
  assert.equal(ham.isConnected, false, "假 DOM 语义：被移除的节点应报 isConnected=false");

  env.tickIntervals(2);
  assert.equal(findHamburger(env), ham, "补回的必须是**同一个节点**（事件处理与类名原样保留），而不是重建一个");
  assert.equal(findScrim(env), scrim, "遮罩同样必须补回");
  assert.equal(ham.isConnected, true, "补回后应重新在文档里");
});

test("清理：pagehide 必须断开观察者与兜底表（避免 bfcache/长驻页面泄漏）", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  assert.equal(typeof env.state.pagehide, "function", "应注册 pagehide 清理钩子");
  const observers = MutationObserverStub.instances.slice();
  env.state.pagehide();
  assert.ok(observers.every((o) => o.disconnected), "pagehide 必须 disconnect 所有已挂观察者");
  // 断开后时间轴上再跳也不再工作（表已清）
  env.mountFrame({ notify: false });
  env.tickIntervals(2);
  assert.ok(!findHamburger(env), "卸载后不得再往页面里塞东西");
});

test("bfcache：切走再切回来（pageshow persisted）必须重新武装看门狗，否则回来后就永久失灵", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  env.mountFrame({ notify: false });
  env.tickIntervals(1);
  const ham = findHamburger(env);
  assert.ok(ham, "前提：抽屉入口已就位");

  env.state.pagehide();                          // 切走（进入 bfcache）
  env.state.pageshow({ persisted: true });       // 切回来（从 bfcache 恢复）
  env.body.removeChild(ham);                     // 官方此时重渲染冲掉我们的节点
  env.tickIntervals(1);
  assert.equal(findHamburger(env), ham, "bfcache 恢复后看门狗必须仍然有效（重新武装）");
  env.state.pageshow({ persisted: false });      // 普通 pageshow 不得重复武装出第二套计时器
  const live = env.intervals.filter(Boolean).length;
  env.state.pageshow({ persisted: true });
  assert.equal(env.intervals.filter(Boolean).length, live, "重新武装必须先清旧表（不能越切越多计时器）");
});

test("幂等：兜底表长时间空转不得重复插入节点（每类节点在 body 里最多一个）", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  env.mountFrame({ notify: false });
  env.tickIntervals(30);                        // 空转 30 秒
  const count = (cls) => env.body.children.filter((c) => c._cls.has(cls)).length;
  assert.equal(count("dsh-ma-hamburger"), 1, "汉堡按钮必须只有一个（幂等，不能每次 tick 都插一个）");
  assert.equal(count("dsh-ma-scrim"), 1, "遮罩必须只有一个");
});

test("开销：抽屉入口就位后，官方的 DOM 变更风暴不得再触发整页判定（HOSTISH 会序列化整个 outerHTML）", () => {
  const env = run(harness({ width: 390 }), adapterScript());
  env.mountFrame({ notify: false });
  env.tickIntervals(1);
  assert.ok(findHamburger(env), "前提：抽屉入口已就位");

  // 官方流式输出时每帧都在改 DOM —— 这时适配层必须已经"静默"，不能再做昂贵判定
  const before = env.outerHtmlReads();
  env.churn(30);                                 // 30 帧 DOM 变更（每帧都通知观察者）
  env.tickIntervals(3);                          // 兜底表再空转 3 秒
  assert.equal(env.outerHtmlReads(), before,
    "入口已经建好且都在文档里时，不得再为每次 DOM 变更/每秒 tick 重新序列化整页（那是每秒几十次全量 outerHTML）");
  // 但"看门狗"必须还在：真被冲掉时依然能补回来（静默 ≠ 失灵）
  env.body.removeChild(findHamburger(env));
  env.churn(1);
  assert.ok(findHamburger(env), "静默之后看门狗仍必须工作");
});

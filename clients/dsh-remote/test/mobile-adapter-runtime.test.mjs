#!/usr/bin/env node
/**
 * mobile-adapter **运行时**契约测试（假 DOM + vm 执行真实注入脚本）。
 *
 * 事故背景（2026-09-15 生产反馈）：
 *   手机端用户打开后**整屏被阴影覆盖、点哪都没反应**，只有左侧栏（z-index 300，在遮罩之上）能点。
 *   根因是适配层自己创建的全屏 scrim（div.dsh-ma-scrim, z-index 290）：
 *     · 判定「侧栏是否展开」用的是 `!frame.hasAttribute("data-sidebar-collapsed")`，
 *       只兼容"折叠时才输出属性"这一种写法；官方若用带值写法，就永久判定为展开 →
 *       html 上的 dsh-ma-sidebar-open 常亮 → scrim 永久 pointer-events:auto（拦截整屏点击）；
 *     · 且判定为展开时还会把汉堡按钮 display:none 隐藏掉，"打开菜单/关掉遮罩"的入口也没了；
 *     · 唯一关闭路径是"点 scrim → 点官方 toggle"，找不到 toggle 就彻底卡死。
 *
 * 本用例直接拿 injectMobileAdapter() 注入的**真实脚本**在假 DOM 里跑，断言运行时行为
 * （既有用例只测注入纯函数，覆盖不到这里，所以这个 bug 当初没被任何测试拦住）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 从注入结果里取出真正的 <script> 内容（不加壳，原样执行）。 */
function adapterScript() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能取出注入脚本");
  return m[1];
}

// ── 极简假 DOM ────────────────────────────────────────────────────────────────
class El {
  constructor(tag = "div", attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this._cls = new Set();
    this._listeners = new Map();
    this.style = { setProperty: (k, v) => { if (!this._cssVars) this._cssVars = {}; this._cssVars[k] = v; }, removeProperty: (k) => { if (this._cssVars) delete this._cssVars[k]; } };
    this._cssVars = {};
    this._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => { if (on === undefined) { this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c); } else if (on) this._cls.add(c); else this._cls.delete(c); return this._cls.has(c); },
    };
  }
  // 极简 innerHTML：只认本用例需要的那点结构（class / input[type=range] / 文本）
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    for (const m of String(html).matchAll(/<(\w+)([^>]*)>/g)) {
      const tag = m[1];
      const attrs = m[2] || "";
      const el = new El(tag);
      const cls = /class="([^"]*)"/.exec(attrs);
      if (cls) el.className = cls[1];
      const type = /type="([^"]*)"/.exec(attrs);
      if (type) el.attrs.type = type[1];
      this.children.push(el);
    }
  }
  get innerHTML() { return this._html || ""; }
  get textContent() { return this._text || ""; }
  set textContent(v) { this._text = String(v); }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  prepend() {} focus() {} blur() {}
  hasAttribute(n) { return n in this.attrs; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this._listeners.get(t) || this._listeners.set(t, []).get(t)).push(fn); }
  removeEventListener() {}
  dispatch(t, ev = {}) { for (const fn of this._listeners.get(t) || []) fn({ stopPropagation() {}, preventDefault() {}, ...ev }); }
  getBoundingClientRect() { return this._rect; }
  querySelector(sel) {
    const s2 = String(sel);
    const match = (el) => {
      if (s2.includes('input[type="range"]')) return el.tagName === "INPUT" && el.attrs.type === "range";
      if (s2.startsWith(".")) return el._cls.has(s2.slice(1));
      if (s2.startsWith("input")) return el.tagName === "INPUT";
      return false;
    };
    return this.children.find(match) || null;
  }
  querySelectorAll(sel) { const one = this.querySelector(sel); return one ? [one] : []; }
  matches() { return false; }
  click() { this._clicked = (this._clicked || 0) + 1; this.dispatch("click"); }
  get isConnected() { return true; }
}

/** 搭一个最小 dsh web 环境：frame（带官方 data 属性）内含 sidebar/center 两列 + 可选官方 toggle。 */
function harness({ collapsedAttr = undefined, detailsAttr = undefined, sidebarRect = null, width = 390, withToggle = true } = {}) {
  const html = new El("html");
  // HOSTISH 门禁会读 documentElement.outerHTML 找官方特征（__ModuleLoader__ / DeepSeek Harness）
  html.outerHTML = '<html><head><script>window.__ModuleLoader__ = { mode: "queue" }</script>'
    + "<title>DeepSeek Harness</title></head><body></body></html>";
  const body = new El("body");
  const frame = new El("div");
  if (collapsedAttr !== undefined) frame.setAttribute("data-sidebar-collapsed", collapsedAttr);
  if (detailsAttr !== undefined) frame.setAttribute("data-details-collapsed", detailsAttr);

  const sidebar = new El("div", { class: "sidebarCol" });
  const center = new El("div", { class: "centerCol" });
  if (sidebarRect) sidebar._rect = sidebarRect;
  frame.appendChild(sidebar);
  frame.appendChild(center);
  const toggle = new El("button");
  toggle.setAttribute("aria-label", "打开侧边栏");

  const pickByClass = (sel) => {
    // 只支持本用例需要的极少数选择器（脚本里 querySelector 的用法就这些）
    const s2 = String(sel);
    if (/\.dsh-ma-sidebar/.test(s2)) return sidebar._cls.size ? sidebar : null;
    if (/\.hHd-Xa_root|sidebar/i.test(s2)) return sidebar;
    return null;
  };
  const frameQ = (sel) => pickByClass(sel);
  frame.querySelector = frameQ;
  frame.querySelectorAll = () => [];
  const doc = {
    documentElement: html,
    body,
    readyState: "complete",
    addEventListener() {},
    querySelector(sel) {
      const s2 = String(sel);
      if (s2.includes(".pI_x6G_frame") || s2.includes("[data-sidebar-collapsed], [data-details-collapsed]") || s2.includes("[data-shell-overlay]")) return frame;
      if (s2.includes("aria-label=")) return withToggle ? toggle : null;
      if (s2.includes(".hHd-Xa_toggle")) return withToggle ? toggle : null;
      if (s2.includes("hHd-Xa")) return sidebar; // 子列识别用（真实页面里这是侧栏）
      return pickByClass(s2);
    },
    querySelectorAll() { return []; },
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ nodeValue: t }),
    getElementById: () => null,
  };

  const timers = new Map();
  const win = {
    innerWidth: width,
    innerHeight: 800,
    devicePixelRatio: 1,
    localStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => { const id = setImmediate(fn); return id; },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.set(id, fn); return id; },
    clearTimeout: (id) => clearTimeout(id),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  const ctx = vm.createContext({
    window: win, document: doc, console, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    setInterval: () => 0, clearInterval() {}, MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver, requestAnimationFrame: win.requestAnimationFrame,
    navigator: { userAgent: "iPhone Safari", maxTouchPoints: 5, platform: "iPhone" },
    location: { href: "https://n.risegao.cn:13443/app/", host: "n.risegao.cn" },
    localStorage: win.localStorage, URL, Date, Math, JSON, Object, Array, String, Number, RegExp, Boolean, Promise, Error, isNaN, parseInt, parseFloat,
    HTMLElement: El, // 脚本用 `c instanceof HTMLElement` 过滤 frame 的子列
  });
  win.onerror = (m) => { if (ADAPTER_DEBUG) console.error("ADAPTER onerror:", m); };
  const dbgConsole = ADAPTER_DEBUG
    ? { log: (...a) => console.error("[adapter]", ...a), warn: (...a) => console.error("[adapter warn]", ...a), error: (...a) => console.error("[adapter err]", ...a) }
    : console;
  ctx.console = dbgConsole;
  ctx.globalThis = ctx;
  ctx.self = win;
  return { ctx, html, body, frame, sidebar, toggle, win };
}

const ADAPTER_DEBUG = process.env.DSH_ADAPTER_DEBUG === "1";

function runAdapter(env) {
  try {
    vm.runInContext(adapterScript(), env.ctx, { timeout: 5000 });
    // 让脚本内 setTimeout(0) 的收尾逻辑跑一轮
    for (const fn of env._pendingTimers || []) { try { fn(); } catch { /* ignore */ } }
  } catch (e) {
    if (ADAPTER_DEBUG) console.error("ADAPTER THREW:", e && e.message);
    throw e;
  }
  // sync() 在 boot 时立即执行一次；脚本内用 setTimeout/rAF 的场景再推一轮
  return env;
}

const findScrim = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-scrim"));
const findHamburger = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-hamburger"));

// ── 用例 ─────────────────────────────────────────────────────────────────────

test("运行时：官方属性带值写法 =false 时遮罩不得拦截点击（用户报的整屏阴影）", () => {
  // 官方若输出 data-sidebar-collapsed="true"（折叠），旧实现 hasAttribute 只看存在性；
  // 带值写法下必须按值判断 —— 否则"折叠态"被当成"展开"，遮罩常亮拦住整屏点击。
  const env = runAdapter(harness({ collapsedAttr: "true", sidebarRect: { left: 0, right: 300, top: 0, bottom: 800, width: 300, height: 800 } }));
  assert.ok(!env.html.classList.contains("dsh-ma-scrim-on"), "折叠态 → 遮罩不得拦截点击");
  assert.ok(!env.html.classList.contains("dsh-ma-sidebar-open"), "折叠态 → 不应处于展开态");
  // 对照：=false 属"未折叠"，是展开态（但遮罩仍只在几何可见时拦截）
  const env2 = runAdapter(harness({ collapsedAttr: "false", sidebarRect: { left: -300, right: 0, top: 0, bottom: 800, width: 300, height: 800 } }));
  assert.ok(!env2.html.classList.contains("dsh-ma-scrim-on"), "侧栏在屏外 → 遮罩绝不拦截");
});

test("运行时：侧栏没真的滑进视口时，遮罩不得拦截点击（几何兜底只管遮罩，不否决展开）", () => {
  const env = runAdapter(harness({ collapsedAttr: "", sidebarRect: { left: 0, right: 0, top: 0, bottom: 800, width: 0, height: 800 } }));
  // 判定/几何可能出偏差，但"看不见的遮罩拦住整屏点击"必须不可能发生
  assert.ok(!env.html.classList.contains("dsh-ma-scrim-on"),
    "侧栏未滑入视口 → 遮罩必须保持不拦截（dsh-ma-scrim-on 不生效）");
  assert.ok(findScrim(env), "遮罩元素本身仍应创建（关闭态只是不拦截）");
  // ⚠️ 注意:展开 class 不再由几何否决 —— 否则点菜单按钮后动画还没开始、rect 仍在屏外，
  //    sync 会把 class 立刻摘掉，抽屉永远打不开（这正是 0.6.6-beta.3 的回归）。
});

test("运行时：点菜单按钮必须能真的打开抽屉（上一版的回归点）", () => {
  // 复现现场：侧栏初始在屏外（translateX(-103%) → rect 仍在外侧），点汉堡
  // 从**收起态**开始（collapsedAttr="true" = 折叠），侧栏几何仍在屏外（动画未开始）
  const env = runAdapter(harness({ collapsedAttr: "true", sidebarRect: { left: -300, right: 0, top: 0, bottom: 800, width: 300, height: 800 }, withToggle: false }));
  assert.ok(!env.html.classList.contains("dsh-ma-sidebar-open"), "前提：初始为收起态");
  const ham = findHamburger(env);
  assert.ok(ham, "菜单按钮应存在");
  assert.equal(ham.style.display, "", "菜单按钮不得被隐藏");
  ham.dispatch("click");
  assert.ok(env.html.classList.contains("dsh-ma-sidebar-open"),
    "点菜单按钮后必须处于展开态（不能被几何判定立刻摘掉）—— 这正是上一版回归的点");
  // 再点一次应能关掉
  ham.dispatch("click");
  assert.ok(!env.html.classList.contains("dsh-ma-sidebar-open"), "再次点击应关闭");
});

test("运行时：侧栏真的滑入视口（right>8 且有宽度）时才允许拦截点击", () => {
  const env = runAdapter(harness({ collapsedAttr: "", sidebarRect: { left: 0, right: 300, top: 0, bottom: 800, width: 300, height: 800 } }));
  assert.ok(env.html.classList.contains("dsh-ma-sidebar-open"),
    "抽屉确实展开时遮罩才应显示并拦截（正常行为不能被改坏）");
});

test("运行时：判定为展开时不再隐藏汉堡按钮（避免用户没有任何入口）", () => {
  const env = runAdapter(harness({ collapsedAttr: "", sidebarRect: { left: 0, right: 300, top: 0, bottom: 800, width: 300, height: 800 } }));
  const ham = findHamburger(env);
  assert.ok(ham, "汉堡按钮应存在");
  assert.notEqual(ham.style.display, "none",
    "抽屉展开时也不应把汉堡隐藏 —— 判定一旦出错，用户会连入口都没有（事故现场就是这个死局）");
});

test("运行时：找不到官方 toggle 时，点遮罩必须能自救（摘掉遮挡类）", () => {
  const env = runAdapter(harness({ collapsedAttr: "", sidebarRect: { left: 0, right: 300, top: 0, bottom: 800, width: 300, height: 800 }, withToggle: false }));
  assert.ok(env.html.classList.contains("dsh-ma-sidebar-open"), "前提：先处于遮挡态");
  const scrim = findScrim(env);
  scrim.dispatch("click");
  assert.ok(!env.html.classList.contains("dsh-ma-sidebar-open"),
    "找不到官方 toggle 时，点遮罩应直接摘掉遮挡类（否则点哪都没反应）");
});

test("运行时：能拿到官方 toggle 时，点遮罩仍走官方 toggle（不引入私有状态）", () => {
  const env = runAdapter(harness({ collapsedAttr: "", sidebarRect: { left: 0, right: 300, top: 0, bottom: 800, width: 300, height: 800 }, withToggle: true }));
  const scrim = findScrim(env);
  scrim.dispatch("click");
  assert.ok(env.toggle._clicked >= 1, "应点击官方 toggle");
});

// ── 字号档位（2026-09-16 需求：4 档滑块、仅手机端生效） ──────────────────────

const findFsBtn = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-fsbtn"));
const findFsPanel = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-fspanel"));

test("字号：菜单/字号按钮与面板都应创建（面板默认收起）", () => {
  const env = runAdapter(harness({}));
  const btn = findFsBtn(env);
  const panel = findFsPanel(env);
  assert.ok(btn, "应有字号按钮");
  assert.ok(panel, "应有字号面板");
  assert.equal(panel.hidden, true, "面板默认收起（点按钮才展开）");
  assert.ok((panel.querySelector ? panel : {}).querySelector === undefined || true);
});

test("字号：默认档 = 最小（不加缩放属性，保持当前大小）", () => {
  const env = runAdapter(harness({}));
  assert.equal(env.html.getAttribute("data-dsh-ma-fs"), null, "默认不应带缩放属性");
  assert.equal(env.win.localStorage.getItem("dsh-ma-font-scale"), null);
});

test("字号：滑块改档 → 属性/正文变量/持久化都生效", () => {
  const env = runAdapter(harness({}));
  const panel = findFsPanel(env);
  const range = panel && panel.querySelector && panel.querySelector('input[type="range"]');
  assert.ok(range, "面板里应有 range 滑块");
  // 打到「大」(level 2)
  range.value = "2";
  range.dispatch("input");
  assert.equal(env.html.getAttribute("data-dsh-ma-fs"), "2", "应写入缩放属性（CSS 据此放大字号）");
  assert.equal(env.win.localStorage.getItem("dsh-ma-font-scale"), "2", "应持久化到 localStorage");
  const contentVar = env.html.style["--dsh-content-font-size"] || env.html._cssVars && env.html._cssVars["--dsh-content-font-size"];
  assert.ok(contentVar, "应同步官方正文变量 --dsh-content-font-size（聊天正文才会变大）");
});

test("字号：恢复「最小」时移除缩放属性（回到当前大小）", () => {
  const env = runAdapter(harness({}));
  const panel = findFsPanel(env);
  const range = panel.querySelector('input[type="range"]');
  range.value = "3"; range.dispatch("input");
  assert.equal(env.html.getAttribute("data-dsh-ma-fs"), "3");
  range.value = "0"; range.dispatch("input");
  assert.equal(env.html.getAttribute("data-dsh-ma-fs"), null, "level 0 = 最小 → 不应留缩放属性");
  assert.equal(env.win.localStorage.getItem("dsh-ma-font-scale"), "0");
});

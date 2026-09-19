#!/usr/bin/env node
/**
 * mobile-adapter 手机端两个真实事故的回归测试（假 DOM + 事件传播模型 + vm 跑真实注入脚本）。
 *
 * 事故 1（2026-09-19，微信内置浏览器实测反馈）
 *   「用微信语音转文字输入时，它在自动整理文字的过程中会直接触发输入框的发送」——半截话被发出。
 *   取证：官方输入区是 Lexical contenteditable（根元素带 data-composer-input / role=textbox /
 *   aria-multiline / data-lexical-editor），官方键位图自带的 IME 守卫只看
 *   `event.isComposing || keyCode===229 || (compositionend 后 10ms 窗口)`；
 *   而微信语音转文字没有标准 compositionend 时序 —— 真机 CDP 实测：compositionend 之后
 *   43ms 到达的 Enter 已经 isComposing=false 且超出 10ms 窗口 → 官方按「用户要发送」处理，真的发出去了。
 *   修复：适配层在**捕获阶段**加输入框专用守卫 —— ① 任何宽度下识别为"输入法确认"的 Enter
 *   （isComposing / keyCode 229 / compositionend 后 60ms 内）一律 stopPropagation；
 *   ② ≤820px 时输入框里的 Enter **只换行不发送**，发送只由官方发送按钮负责。
 *
 * 事故 2（2026-09-19，Windows 电脑通道实测反馈）
 *   「展开左边抽屉，无法选择历史会话，点任何东西都没有反应；界面右边有一个白色的框占了点位置」。
 *   根因：`isDrawer()` 只查 `r.right > 8`，而**向右滑出屏外的第三列**右边坐标是很大的正数
 *   （真机实测 left=400 / right=759 / width=358）→ 完全看不见的详情列被判成"展开的详情列" →
 *   `dsh-ma-details-open` 常亮 → 那个空的 Details 面板（白框）滑进来盖住整屏；它与抽屉同为
 *   z-index:300 且 DOM 顺序在后 → 压住抽屉吃掉了抽屉里所有点击；scrim 同时也常亮拦掉剩余区域。
 *   修复：① `isDrawer()` 必须与视口真正相交（四边都查）；② 详情列不再"官方说展开就滑进来"；
 *   ③ 遮罩不变量：遮罩在拦点击而视口内没有任何可交互抽屉 → 立刻摘掉（800ms 看门狗）。
 *
 * ⚠️ 本文件里的假 DOM 除了元素树，还实现了两件事，否则这两类 bug 根本测不出来：
 *   · **事件传播模型**（window→document→…→target 的捕获/冒泡 + stopPropagation/preventDefault），
 *     IME 守卫的全部价值就是"官方监听器收不到这一下"，没有传播语义就无法断言；
 *   · **官方窄屏布局的几何模型**（抽屉/详情列的 rect 随 html 上的 dsh-ma-*-open 变化，与 STYLE
 *     里的 CSS 一致），否则"滑出屏外的第三列"这种几何误判无法复现。
 *   CSS 里真正决定"谁能接到点击"的 z-index 不在这层模拟里 —— 用例会先断言 CSS 契约
 *   （含抽屉展开时 z-index 310 > 遮罩 290 / 详情列 300），再用同一份契约做命中测试；
 *   浏览器里的真实结果另在 headless Chromium + 官方 GUI 上验证过（见报告）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 取注入结果里的真实 <script> / <style> 内容（不加壳，原样执行）。 */
function injected() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const js = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  const css = /<style id="[^"]*-css"[^>]*>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(js && css, "应能取出注入脚本与样式");
  return { js: js[1], css: css[1] };
}

// ── 极简但带事件传播的假 DOM ────────────────────────────────────────────────────

function matchesSimple(el, sel) {
  const s = String(sel).trim();
  if (!s) return false;
  const parts = s.match(/^[a-zA-Z][\w-]*|\.[^.[\s]+|\[[^\]]+\]/g);
  if (!parts) return false;
  for (const p of parts) {
    if (p[0] === ".") { if (!el._cls.has(p.slice(1))) return false; continue; }
    if (p[0] === "[") {
      const body = p.slice(1, -1);
      const m = /^([\w-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?(?:\s+i)?$/.exec(body);
      if (!m) return false;
      const name = m[1], op = m[2], val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
      const has = el.attrs[name] !== undefined;
      if (!op) { if (!has) return false; continue; }
      if (!has) return false;
      const actual = String(el.attrs[name]);
      const expect = String(val);
      if (op === "=") { if (actual.toLowerCase() !== expect.toLowerCase()) return false; }
      else if (op === "*=") { if (!actual.toLowerCase().includes(expect.toLowerCase())) return false; }
      else if (op === "^=") { if (!actual.toLowerCase().startsWith(expect.toLowerCase())) return false; }
      else if (op === "$=") { if (!actual.toLowerCase().endsWith(expect.toLowerCase())) return false; }
      continue;
    }
    if (el.tagName !== p.toUpperCase()) return false;
  }
  return true;
}
function matches(el, sel) {
  return String(sel).split(",").some((one) => matchesSimple(el, one));
}

class Ev {
  constructor(type, init = {}) {
    this.type = type;
    this.target = null;
    this.defaultPrevented = false;
    this._stopped = false;
    this._path = [];
    Object.assign(this, init);
  }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; this._immediate = true; }
  preventDefault() { this.defaultPrevented = true; }
  composedPath() { return this._path; }
}

class El {
  constructor(tag = "div", attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    // class 属性要同时落进 classList（真实 DOM 里 .foo 选择器与 className 是同一份数据）
    this._cls = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    this._l = new Map(); // type -> { capture: [], bubble: [] }
    this.style = { setProperty() {}, removeProperty() {}, display: "" };
    this._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    this._text = "";
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
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
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
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  prepend() {}
  focus() { globalThis.__focused = this; }
  blur() {}
  setPointerCapture() {}
  click() { return this.dispatchEvent(new Ev("click", {})); }
  scrollIntoView() {}
  get isConnected() { return true; }
  matches(sel) { return matches(this, sel); }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; }
  contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parent; } return false; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(sel) { return this.descendants().find((e) => matches(e, sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter((e) => matches(e, sel)); }
  addEventListener(type, fn, opts) {
    const capture = opts === true || (opts && opts.capture === true);
    const box = this._l.get(type) || { capture: [], bubble: [] };
    (capture ? box.capture : box.bubble).push(fn);
    this._l.set(type, box);
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || (opts && opts.capture === true);
    const box = this._l.get(type);
    if (!box) return;
    const arr = capture ? box.capture : box.bubble;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  /** 目标节点自身在目标阶段要跑的两组监听器（捕获组先跑）。 */
  _fire(ev, capture) {
    const box = this._l.get(ev.type);
    if (!box) return;
    for (const fn of capture ? box.capture : box.bubble) {
      fn(ev);
      if (ev._immediate) return;
    }
  }
  dispatchEvent(ev) {
    const path = [];
    let n = this;
    while (n) { path.unshift(n); n = n.parent; }        // [window, document, html, body, …target]
    ev._path = path.slice();
    ev.target = this;
    for (let i = 0; i < path.length - 1; i++) {          // 捕获阶段（自根向下）
      if (ev._stopped) return !ev.defaultPrevented;
      path[i]._fire(ev, true);
    }
    if (!ev._stopped) this._fire(ev, true);              // 目标阶段：捕获组
    if (!ev._stopped) this._fire(ev, false);             // 目标阶段：冒泡组
    for (let i = path.length - 2; i >= 0; i--) {         // 冒泡阶段
      if (ev._stopped) break;
      path[i]._fire(ev, false);
    }
    return !ev.defaultPrevented;
  }
  getBoundingClientRect() { return this._rect; }
}

// ── 官方布局几何模型（与 STYLE 里的 CSS 一致：抽屉/详情列是离屏浮层，靠 html 上的 class 滑入） ──
const OFF_LEFT = { left: -338, right: -9, top: 0, bottom: 844, width: 328, height: 844 };  // translateX(-103%)
const IN_LEFT = { left: 0, right: 328, top: 0, bottom: 844, width: 328, height: 844 };
const OFF_RIGHT = { left: 400, right: 759, top: 0, bottom: 844, width: 358, height: 844 }; // translateX(103%)
const IN_RIGHT = { left: 31, right: 390, top: 0, bottom: 844, width: 358, height: 844 };

/** 从真实 STYLE 里读出 z-index 契约（命中测试据此排序，改坏 CSS 就会失败）。 */
function zIndexes(css) {
  const num = (re) => {
    const m = re.exec(css);
    assert.ok(m, `CSS 里应能找到该层级规则: ${re}`);
    return Number(m[1]);
  };
  return {
    scrim: num(/div\.dsh-ma-scrim\s*\{[\s\S]{0,200}?z-index:\s*(\d+)/),
    // 抽屉规则都带 :not(.dsh-ma-details) 兜底（防止一列被同时标成抽屉与详情列）
    sidebar: num(/div\.pI_x6G_sidebarCol(?::not\([^)]*\))?,\s*div\.dsh-ma-sidebar(?::not\([^)]*\))?\s*\{[\s\S]{0,500}?z-index:\s*(\d+)/),
    sidebarOpen: num(/html\.dsh-ma-sidebar-open\s+div\.pI_x6G_sidebarCol(?::not\([^)]*\))?,[\s\S]{0,200}?\{\s*z-index:\s*(\d+)/),
    details: num(/div\.pI_x6G_detailsCol,[\s\S]{0,300}?z-index:\s*(\d+)/),
    hamburger: num(/button\.dsh-ma-hamburger\s*\{[\s\S]{0,700}?z-index:\s*(\d+)/),
  };
}

class MutationObserverStub {
  constructor(cb) { this.cb = cb; this.targets = []; MutationObserverStub.instances.push(this); }
  observe(t, opts) { this.targets.push({ t, opts }); }
  disconnect() {}
  /** 手工触发：模拟官方改了 frame 的某个属性（并按 opts.attributeFilter/名字规则交给回调）。 */
  fire(attributeName, targetEl) {
    const t = targetEl || (this.targets[0] && this.targets[0].t);
    this.cb([{ type: "attributes", attributeName, target: t }], this);
  }
  static reset() { MutationObserverStub.instances = []; }
}
MutationObserverStub.instances = [];

/**
 * 搭一个最小的官方 dsh web 窄屏环境：
 *   frame(grid 三列) = 侧栏 / 中央列(含输入框) / 第三列(详情 or rightbar) + overlayLayer(全屏)
 * 输入框按官方真实结构：contenteditable + data-composer-input + role=textbox + aria-multiline。
 */
function harness({
  // ⚠️ 用 null 表示"官方不写这个属性"（undefined 会命中默认值，测不出"属性缺失"的场景）
  collapsedAttr = "true", detailsAttr = "true", rightbarAttr = null, variant = "rc1",
  width = 390, height = 844, withComposer = true, withToggle = true,
} = {}) {
  MutationObserverStub.reset();
  const intervals = [];
  const html = new El("html");
  html.outerHTML = '<html><head><script>window.__ModuleLoader__ = { mode: "queue" }</script>'
    + "<title>DeepSeek Harness</title></head><body></body></html>";
  const body = new El("body");
  const frame = new El("div", { class: "pI_x6G_frame" });
  if (collapsedAttr !== null) frame.setAttribute("data-sidebar-collapsed", collapsedAttr);
  if (detailsAttr !== null) frame.setAttribute("data-details-collapsed", detailsAttr);
  if (variant === "rc2" && rightbarAttr !== null) frame.setAttribute("data-rightbar-collapsed", rightbarAttr);

  const sidebar = new El("div", { class: variant === "rc2" ? "pI_x6G_sidebarCol" : "pI_x6G_sidebarCol" });
  const center = new El("div", { class: "pI_x6G_centerCol" });
  const third = new El("div", { class: variant === "rc2" ? "pI_x6G_rightbarCol" : "pI_x6G_detailsCol" });
  const overlay = new El("div", { class: "pI_x6G_overlayLayer", "data-shell-overlay": "true" });
  const row = new El("div", { role: "treeitem", "aria-selected": "false", class: "hHd-Xa_sessionRow YDXeBa_sessionRow" });
  // 抽屉里一条历史会话行的实测位置（侧栏 0..328，避开左上角的汉堡按钮）
  row._rect = { left: 16, top: 200, right: 216, bottom: 240, width: 200, height: 40 };
  sidebar.appendChild(row);
  /* 工作区行（官方真实结构，2026-09-19 真机 outerHTML 取证）：
     <div class="YDXeBa_projectRow" role="treeitem" aria-expanded="false" draggable="true">
       <span class="YDXeBa_slot YDXeBa_folder">…<svg>
       <span class="YDXeBa_slot YDXeBa_chevron">…<svg>
       <span class="YDXeBa_projectText"><span class="YDXeBa_title">myFreeWork</span></span>
       <span class="YDXeBa_rowActions">
         <button class="YDXeBa_iconButton" aria-label="Workspace actions for myFreeWork">…</button>
         <button class="YDXeBa_iconButton" aria-label="New session in myFreeWork">…</button>
     官方源码里这一行的 onClick 是 onToggle（setGroupExpanded），点它 = 展开/折叠该工作区的会话列表。 */
  const wsRow = new El("div", { class: "YDXeBa_projectRow", role: "treeitem", "aria-expanded": "false", draggable: "true" });
  wsRow._rect = { left: 12, top: 100, right: 268, bottom: 134, width: 256, height: 34 };
  const wsTitle = new El("span", { class: "YDXeBa_title" });
  wsTitle.textContent = "myFreeWork";
  const wsActions = new El("span", { class: "YDXeBa_rowActions" });
  const wsMenuBtn = new El("button", { class: "YDXeBa_iconButton", "aria-label": "Workspace actions for myFreeWork" });
  const wsNewBtn = new El("button", { class: "YDXeBa_iconButton", "aria-label": "New session in myFreeWork" });
  wsActions.appendChild(wsMenuBtn); wsActions.appendChild(wsNewBtn);
  wsRow.appendChild(wsTitle); wsRow.appendChild(wsActions);
  sidebar.appendChild(wsRow);
  // 侧栏里的其它入口：Task Board（导航）与非交互区（纯文本/滚动槽）
  const taskBoard = new El("button", { class: "_7D6uKa_entry", "aria-label": "Task Board", "data-dsh-taskboard-entry": "" });
  const gutter = new El("div", { class: "bhn1Oq_listArea" });
  const gutterText = new El("span");
  gutter.appendChild(gutterText);
  sidebar.appendChild(taskBoard);
  sidebar.appendChild(gutter);
  // 官方输入区（Lexical）：contenteditable 富文本宿主
  const composer = new El("div", {
    contenteditable: "true", "data-composer-input": "true", role: "textbox", "aria-multiline": "true",
  });
  const composerChild = new El("span");
  composer.appendChild(composerChild);
  // 正文里的一行（工具行/消息行）：用户点它 = "我要看详情"
  const toolRow = new El("button", { class: "Sh0Q9G_toolRow" });
  toolRow._rect = { left: 12, top: 300, right: 378, bottom: 340, width: 366, height: 40 };
  center.appendChild(toolRow);
  center.appendChild(composer);
  frame.appendChild(sidebar);
  frame.appendChild(center);
  frame.appendChild(third);
  frame.appendChild(overlay);          // 官方 overlay 层恒在 frame 末尾（0.1.5 起）

  // 抽屉/详情列的几何随 html 上的 class 变化（= STYLE 里那两条 transform 规则）
  const rectFor = (el) => {
    if (el === sidebar) return html.classList.contains("dsh-ma-sidebar-open") ? IN_LEFT : OFF_LEFT;
    if (el === third) return html.classList.contains("dsh-ma-details-open") ? IN_RIGHT : OFF_RIGHT;
    if (el === overlay) return { left: 0, right: width, top: 0, bottom: height, width, height };
    if (el === frame) return { left: 0, right: width, top: 0, bottom: height, width, height };
    return el._rect;
  };
  for (const el of [sidebar, center, third, overlay, frame, row, composer, composerChild, toolRow, wsRow, wsTitle, wsNewBtn, wsMenuBtn, taskBoard, gutterText]) {
    el.getBoundingClientRect = () => rectFor(el);
  }

  const toggle = new El("button");
  toggle.setAttribute("aria-label", "打开侧边栏");
  toggle._rect = { left: 8, top: 8, right: 48, bottom: 48, width: 40, height: 40 };

  const doc = new El("#document");
  doc.tagName = "#DOCUMENT";
  doc.appendChild(html);
  html.appendChild(body);
  body.appendChild(frame);
  // document 特有能力
  doc.readyState = "complete";
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => ({ nodeValue: t });
  doc.getElementById = () => null;
  doc.documentElement = html;
  doc.body = body;
  const docQS = El.prototype.querySelector.bind(doc);
  doc.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes("aria-label=") && !s.includes("侧边栏") && !s.includes("sidebar")) return withToggle ? toggle : null;
    if (s.includes(".hHd-Xa_toggle")) return withToggle ? toggle : null;
    return docQS(s);
  };

  const loc = { href: "https://n.risegao.cn:13443/remote/dev-x/", pathname: "/remote/dev-x/", origin: "https://n.risegao.cn:13443" };
  const win = {
    innerWidth: width, innerHeight: height, devicePixelRatio: 2,
    localStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    location: loc,
    MutationObserver: MutationObserverStub,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setImmediate(fn),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (id) => { if (id) intervals[id - 1] = null; },
    getComputedStyle: (el) => ({
      // 只模拟"点不点得动"最关键的那条：遮罩只有在 dsh-ma-scrim-on 时才 pointer-events:auto
      pointerEvents: el === scrimRef.el
        ? (html.classList.contains("dsh-ma-scrim-on") ? "auto" : "none")
        : "auto",
      zIndex: "",
    }),
    addEventListener(...a) { doc.addEventListener(...a); },
    removeEventListener(...a) { doc.removeEventListener(...a); },
  };
  const scrimRef = { el: null };

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
  /** 手工 tick 一次已挂上的 setInterval（看门狗 800ms 那一支）。 */
  const tickTimers = () => { for (const fn of intervals.slice()) { if (fn) fn(); } };
  return { ctx, doc, html, body, frame, sidebar, center, third, overlay, row, toolRow, composer, composerChild, toggle,
    wsRow, wsTitle, wsNewBtn, wsMenuBtn, taskBoard, gutterText, win, scrimRef, tickTimers, intervals };
}

/** 跑注入脚本（真实 SCRIPT，一字不改）。 */
function run(env, js) {
  vm.runInContext(js, env.ctx, { timeout: 5000 });
  const scrim = env.body.children.find((c) => c._cls.has("dsh-ma-scrim"));
  if (scrim) env.scrimRef.el = scrim;
  const ham = env.body.children.find((c) => c._cls.has("dsh-ma-hamburger"));
  if (ham) ham._rect = { left: 10, top: 10, right: 52, bottom: 52, width: 42, height: 42 };
  return env;
}

const findScrim = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-scrim"));
const findHamburger = (env) => env.body.children.find((c) => c._cls.has("dsh-ma-hamburger"));

// ── 命中测试：按 CSS 契约（z-index 高者在上；同级按 DOM 顺序）判断某点会点到谁 ──────────────
function hitTest(env, z, x, y) {
  const html = env.html;
  const candidates = [];
  const push = (el, zi, order) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!(r.left <= x && x <= r.right && r.top <= y && y <= r.bottom)) return;
    candidates.push({ el, zi, order });
  };
  const scrim = findScrim(env);
  const scrimOn = html.classList.contains("dsh-ma-scrim-on");
  const sidebarOpen = html.classList.contains("dsh-ma-sidebar-open");
  const detailsOpen = html.classList.contains("dsh-ma-details-open");
  push(env.frame, 0, 0);
  push(env.center, 0, 1);
  const sidebarZ = sidebarOpen ? z.sidebarOpen : z.sidebar;
  push(env.sidebar, sidebarZ, 2);
  push(env.row, sidebarZ, 6);                        // 抽屉里的行：子元素在父的层叠上下文里、画在父之上
  push(env.third, z.details, 3);
  if (scrimOn) push(scrim, z.scrim, 4);              // 遮罩 DOM 在 frame 之后（body 里的注入元素）
  push(findHamburger(env), z.hamburger, 5);
  if (!scrimOn && scrim) { /* pointer-events:none → 不参与命中 */ }
  if (!detailsOpen && env.third) { /* 详情列在屏外，rect 不包含测试点，自然不参与 */ }
  candidates.sort((a, b) => (b.zi - a.zi) || (b.order - a.order));
  return candidates[0] ? candidates[0].el : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Bug 1：微信语音转文字期间的 Enter 不得触发发送
// ══════════════════════════════════════════════════════════════════════════════

/** 模拟官方输入区的键位图：挂在编辑器根（冒泡阶段）上，Enter ≈ 发送。 */
function installOfficialSend(env) {
  const sent = [];
  env.composer.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    if (ev.shiftKey) return;                                  // 官方：Shift+Enter 换行
    if (ev.isComposing || ev.keyCode === 229) return;          // 官方自带的 IME 守卫（真机实测会漏）
    ev.preventDefault();
    sent.push("send");
  });
  return sent;
}
const keydown = (env, init) => {
  const ev = new Ev("keydown", init);
  env.composerChild.dispatchEvent(ev);
  return ev;
};

test("IME：合成进行中（isComposing）的 Enter 不得触达官方发送逻辑", () => {
  const { js } = injected();
  const env = run(harness({ width: 390 }), js);
  const sent = installOfficialSend(env);
  keydown(env, { key: "Enter", keyCode: 13, isComposing: true });
  assert.equal(sent.length, 0, "合成中的 Enter 绝不能被当成发送");
});

test("IME：只报 keyCode 229 的安卓输入法（key 仍是 Enter）也不得发送", () => {
  const { js } = injected();
  // 宽屏也测：228/229 这类"输入法确认"在任何宽度都不该被当成发送
  const env = run(harness({ width: 1280, height: 900 }), js);
  const sent = installOfficialSend(env);
  keydown(env, { key: "Enter", keyCode: 229, isComposing: false });
  assert.equal(sent.length, 0, "keyCode 229 = 输入法确认键（官方自己也这么判），不得发送");
});

test("IME：compositionend 之后紧跟的 Enter（isComposing 已 false）不得发送 —— 微信语音转文字的时序", () => {
  const { js } = injected();
  const env = run(harness({ width: 390 }), js);
  const sent = installOfficialSend(env);
  // 模拟"自动整理文字"：合成开始 → 合成结束 → 确认键（官方 10ms 窗口挡不住的那一下）
  env.doc.dispatchEvent(new Ev("compositionstart", {}));
  env.doc.dispatchEvent(new Ev("compositionend", {}));
  keydown(env, { key: "Enter", keyCode: 13, isComposing: false });
  assert.equal(sent.length, 0, "合成刚结束的 Enter 是输入法的确认键，不得发送（官方只留了 10ms 窗口，实测 43ms 就漏）");
});

test("IME：合成结束很久之后的 Enter 不再算输入法确认（窗口只有几十毫秒）", async () => {
  const { js } = injected();
  const env = run(harness({ width: 1280, height: 900 }), js);
  const sent = installOfficialSend(env);
  env.doc.dispatchEvent(new Ev("compositionstart", {}));
  env.doc.dispatchEvent(new Ev("compositionend", {}));
  await new Promise((r) => setTimeout(r, 90));   // 超出 60ms 窗口
  keydown(env, { key: "Enter", keyCode: 13, isComposing: false });
  assert.equal(sent.length, 1, "合成结束 90ms 之后、宽屏上的 Enter 仍应是官方语义（发送）—— 窗口不能太长");
});

test("IME：手机窄屏下 Enter 只换行不发送（发送交给发送按钮），且不 preventDefault", () => {
  const { js } = injected();
  const env = run(harness({ width: 390 }), js);
  const sent = installOfficialSend(env);
  const ev = keydown(env, { key: "Enter", keyCode: 13, isComposing: false });
  assert.equal(sent.length, 0, "窄屏下 Enter 不得发送（微信/Telegram 等手机 IM 的语义）");
  assert.equal(ev.defaultPrevented, false,
    "必须只 stopPropagation、不 preventDefault —— 否则换行也插不进去，用户按 Enter 像坏了");
});

test("IME：桌面宽屏上普通 Enter 仍是发送（不破坏桌面习惯）", () => {
  const { js } = injected();
  const env = run(harness({ width: 1280, height: 900 }), js);
  const sent = installOfficialSend(env);
  keydown(env, { key: "Enter", keyCode: 13, isComposing: false });
  assert.equal(sent.length, 1, "宽屏非 IME 的 Enter 必须保持官方语义");
});

test("IME：组合键 Ctrl/Cmd+Enter（官方强制提交）不拦", () => {
  const { js } = injected();
  const env = run(harness({ width: 390 }), js);
  const sent = installOfficialSend(env);
  keydown(env, { key: "Enter", keyCode: 13, isComposing: false, ctrlKey: true });
  keydown(env, { key: "Enter", keyCode: 13, isComposing: false, metaKey: true });
  assert.equal(sent.length, 2, "Ctrl/Cmd+Enter 是官方「强制提交」语义，必须放行");
});

test("IME：守卫只作用于输入框 —— 弹窗/表单里其它地方的 Enter 照常传播", () => {
  const { js } = injected();
  const env = run(harness({ width: 390 }), js);
  const dialog = new El("div", { class: "dsh-ma-dialog" });
  const dialogBtn = new El("button", { "aria-label": "确认" });
  dialog.appendChild(dialogBtn);
  env.body.appendChild(dialog);
  let seen = 0;
  env.doc.addEventListener("keydown", () => { seen += 1; }, true);
  dialogBtn.dispatchEvent(new Ev("keydown", { key: "Enter", keyCode: 13, isComposing: false }));
  dialogBtn.dispatchEvent(new Ev("keydown", { key: "Enter", keyCode: 13, isComposing: true }));
  assert.equal(seen, 2, "非输入框的 Enter（弹窗确认/表单提交/快捷键）一律不得被吞");
});

test("IME：非 Enter 的按键在合成期也不拦（不能伤到输入法自身）", () => {
  const { js } = injected();
  const env = run(harness({ width: 390 }), js);
  const seen = [];
  env.doc.addEventListener("keydown", (ev) => { seen.push(ev.key); }, true);
  env.doc.dispatchEvent(new Ev("compositionstart", {}));
  for (const k of ["a", "Process", "ArrowDown", "Backspace"]) {
    const ev = new Ev("keydown", { key: k, keyCode: k === "Process" ? 229 : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0, isComposing: true });
    env.composerChild.dispatchEvent(ev);
  }
  env.doc.dispatchEvent(new Ev("compositionend", {}));
  assert.deepEqual(seen, ["a", "Process", "ArrowDown", "Backspace"], "合成期的其它按键必须原样放行");
});

// ══════════════════════════════════════════════════════════════════════════════
// Bug 2：抽屉点不动 + 右边白色框
// ══════════════════════════════════════════════════════════════════════════════

test("白框：滑出屏外的第三列（rect 完全在视口右侧之外）绝不能被判成「展开的详情列」", () => {
  const { js } = injected();
  // 官方属性认不到（改名/未写）→ 旧实现退回几何判定：离屏列的 right=759 > 8 且 width 358 < 0.98vw
  // → 判成展开 → 白框滑进来盖住整屏 + 遮罩常亮。这正是用户报的现场。
  const env = run(harness({ detailsAttr: null, collapsedAttr: "true" }), js);
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false,
    "离屏的第三列不得被判成展开的详情列（否则就是那个白色空框）");
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), false, "没有任何抽屉在视口里 → 遮罩不得拦点击");
});

test("白框：官方属性说「展开」但页面刚载入时不得自动滑入空的详情面板", () => {
  const { js } = injected();
  // 载入时官方就是展开的（宽屏/上次会话遗留）→ 旧实现立刻滑出白色 Details 面板盖住界面
  const env = run(harness({ detailsAttr: null, rightbarAttr: null, variant: "rc2" }), js);
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false, "载入时的遗留展开态不得自动弹白框");
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), false, "没有抽屉 → 遮罩不得拦点击");
});

test("白框：官方 收起→展开 的实际切换（用户点了工具行）仍然要能滑入详情", () => {
  const { js } = injected();
  const env = run(harness({ detailsAttr: "true" }), js);
  const obs = MutationObserverStub.instances.find((o) => o.targets.some((t) => t.t === env.frame));
  assert.ok(obs, "应挂了 frame 属性观察器");
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false, "前提：初始为收起");
  env.toolRow.dispatchEvent(new Ev("click", {}));          // 用户点正文里的工具行
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false, "官方此刻还说收起 → 不得弹面板");
  env.frame.removeAttribute("data-details-collapsed");     // 官方展开详情（属性被移除）
  obs.fire("data-details-collapsed");
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), true,
    "用户点过正文 + 官方展开详情 → 必须能滑入（不能为了防白框把功能废掉）");
  // 详情列真的滑进视口后，遮罩才允许拦住它背后 —— 正常行为不能被改坏
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), true, "详情列真的在视口里时，遮罩应正常生效");
});

test("白框：没有用户动作时官方自己翻转成展开（改名/重渲染）不得弹白框", () => {
  const { js } = injected();
  const env = run(harness({ detailsAttr: "true" }), js);
  const obs = MutationObserverStub.instances.find((o) => o.targets.some((t) => t.t === env.frame));
  // 真机验证里的现场：官方中途把属性换成另一种写法（或直接移除），而用户什么都没点
  env.frame.removeAttribute("data-details-collapsed");
  obs.fire("data-details-collapsed");
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false,
    "用户没点过正文 → 不得仅凭官方属性/时序变化就把空的详情面板推上屏（白框必须是「用户要的」才出现）");
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), false, "同理：遮罩不得跟着拦点击");
});

test("白框：详情面板显示后点空白（遮罩）能关掉，且不会自己弹回来", () => {
  const { js } = injected();
  const env = run(harness({ detailsAttr: "true" }), js);
  const obs = MutationObserverStub.instances.find((o) => o.targets.some((t) => t.t === env.frame));
  env.toolRow.dispatchEvent(new Ev("click", {}));
  env.frame.removeAttribute("data-details-collapsed");
  obs.fire("data-details-collapsed");
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), true, "前提：用户点过正文后详情已显示");
  findScrim(env).dispatchEvent(new Ev("click", {}));
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false, "点空白应关掉详情面板");
  // 后续任何一次兜底 re-sync 都不得把用户明确关掉的面板又弹回来
  env.doc.dispatchEvent(new Ev("resize", {}));
  obs.fire("data-rightbar-collapsed");
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false,
    "用户点空白关掉之后，「要看详情」的意图必须被收回，不得自己弹回");
});

test("白框：详情列在视口里时遮罩生效；官方收起来后遮罩立刻撤掉", () => {
  const { js } = injected();
  const env = run(harness({ detailsAttr: "true" }), js);
  const obs = MutationObserverStub.instances.find((o) => o.targets.some((t) => t.t === env.frame));
  env.toolRow.dispatchEvent(new Ev("click", {}));
  env.frame.removeAttribute("data-details-collapsed");
  obs.fire("data-details-collapsed");
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), true, "前提：详情列展开且遮罩生效");
  env.frame.setAttribute("data-details-collapsed", "true");
  obs.fire("data-details-collapsed");
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-details-open"), false, "官方收起 → 详情 class 撤掉");
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), false, "官方收起 → 遮罩必须一起撤掉");
});

test("遮罩不变量：遮罩在拦点击但视口内没有任何可交互抽屉 → 看门狗立刻摘掉", () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  const ham = findHamburger(env);
  ham.dispatchEvent(new Ev("click", {}));            // 先正常打开抽屉 → 遮罩下闸 + 看门狗启动
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), true, "前提：抽屉展开、遮罩在拦点击");
  // 制造"判定链已经错了"的现场：抽屉被判定成展开（class 还在），但它的几何已经滑出视口之外
  //（真实世界里对应"官方改了结构/动画没跑完/容器被隐藏"这类让判定与实际不符的情况）
  env.sidebar.getBoundingClientRect = () => OFF_LEFT;
  env.third.getBoundingClientRect = () => OFF_RIGHT;
  env.tickTimers();                                   // 看门狗 tick（800ms 那一支）
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), false,
    "没有任何抽屉在视口里却在下闸 → 看门狗必须立刻摘掉（用户不能被一张看不见的遮罩困住）");
  assert.ok(ham, "汉堡按钮必须始终存在（唯一自救出口）");
  assert.equal(ham.style.display, "", "汉堡按钮不得被隐藏");
});

test("遮罩不变量：抽屉真的展开时遮罩正常生效（不能把正常行为一起摘掉）", () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  const ham = findHamburger(env);
  ham.dispatchEvent(new Ev("click", {}));
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "点汉堡应展开抽屉");
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), true, "抽屉在视口里 → 遮罩应正常生效");
});

test("抽屉可点：抽屉展开时抽屉内点击命中抽屉自身（不被遮罩/详情列吃掉）", () => {
  const { js, css } = injected();
  const z = zIndexes(css);
  assert.ok(z.sidebarOpen > z.scrim,
    `抽屉展开时的层级(${z.sidebarOpen})必须高于遮罩(${z.scrim}) —— 否则抽屉里所有点击都被遮罩吃掉`);
  assert.ok(z.sidebarOpen > z.details,
    `抽屉展开时的层级(${z.sidebarOpen})必须高于详情列(${z.details}) —— 详情列在 frame 里排在抽屉之后，同级会压住抽屉`);
  assert.ok(z.hamburger > z.details && z.hamburger > z.sidebarOpen,
    "汉堡按钮必须始终在最上层（判定怎么错都点得到 = 唯一自救出口）");

  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  findHamburger(env).dispatchEvent(new Ev("click", {}));
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), true, "前提：抽屉展开、遮罩生效");
  // 抽屉里的历史会话行中心点 → 必须命中的是抽屉（行本身），不是遮罩
  const r = env.row.getBoundingClientRect();
  const hit = hitTest(env, z, r.left + r.width / 2, r.top + r.height / 2);
  assert.equal(hit, env.row, "抽屉展开时，抽屉内的点击必须落在抽屉内容上");
  // 最坏情况：详情列也同时被判成展开 —— 抽屉仍然必须压得住（能在抽屉里点选）
  env.html.classList.add("dsh-ma-details-open");
  const hit2 = hitTest(env, z, r.left + r.width / 2, r.top + r.height / 2);
  assert.equal(hit2, env.row, "即便详情列同时展开，抽屉内的点击也必须有效（不能把用户困住）");
});

test("列识别：官方 0.1.5 第三列里的「Collapse right sidebar」按钮不得让它被当成抽屉列", () => {
  const { js, css } = injected();
  // 0.1.5-rc.2 真机取证：rightbar 列里有 <button class="P3OORG_iconButton" aria-label="Collapse right sidebar">
  // 旧代码用 [aria-label*="sidebar" i] 宽松包含匹配 → rightbar 同时挂上 dsh-ma-sidebar + dsh-ma-details
  // → 抽屉一展开，rightbar 也被 transform:none 拉到 left:0 盖住抽屉（实测 4 次启动 3 次命中）。
  const env = harness({ collapsedAttr: "true", variant: "rc2", detailsAttr: null, rightbarAttr: "true" });
  const rb = env.third;   // harness variant rc2 → class="pI_x6G_rightbarCol"（官方 0.1.5-rc.2 的真实类名）
  const collapseBtn = new El("button", { class: "P3OORG_iconButton", "aria-label": "Collapse right sidebar" });
  rb.appendChild(collapseBtn);
  run(env, js);
  assert.equal(rb._cls.has("dsh-ma-details"), true, "第三列仍应被认成详情列");
  assert.equal(rb._cls.has("dsh-ma-sidebar"), false,
    "第三列绝不能同时被标成抽屉列（一列两个身份 → 抽屉被自己盖住，点哪都没反应）");
  assert.equal(env.sidebar._cls.has("dsh-ma-sidebar"), true, "真正的侧栏列必须仍是抽屉列");
  // CSS 兜底：抽屉的定位/层级规则都排除了"同时也是详情列"的元素
  assert.match(css, /div\.dsh-ma-sidebar:not\(\.dsh-ma-details\)/,
    "抽屉样式必须带 :not(.dsh-ma-details) 兜底（万一又标重，详情列的样式也要赢）");
  // 抽屉仍然能开，且抽屉内点击可达
  findHamburger(env).dispatchEvent(new Ev("click", {}));
  env.doc.dispatchEvent(new Ev("resize", {}));
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "抽屉应能正常展开");
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), true, "抽屉在视口里 → 遮罩正常生效");
});

test("属性观察：官方换名字表达抽屉开合时，适配层仍能收到通知并同步", () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true" }), js);
  const obs = MutationObserverStub.instances.find((o) => o.targets.some((t) => t.t === env.frame));
  assert.ok(obs, "应挂了 frame 属性观察器");
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false, "前提：初始收起");
  // 模拟官方未来改名：用 data-sidebar-open 表达"展开"，并触发一次属性变更
  env.frame.removeAttribute("data-sidebar-collapsed");
  env.frame.setAttribute("data-sidebar-open", "true");
  obs.fire("data-sidebar-open");
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true,
    "官方改名的开合属性也必须能被观察到（旧的白名单 attributeFilter 会漏掉 → 官方开了抽屉适配层不知道）");
  // 与之无关的属性变化不应触发同步
  env.frame.setAttribute("data-unrelated-thing", "1");
  env.frame.setAttribute("aria-busy", "true");
  obs.fire("data-unrelated-thing");                   // 与开合无关的属性：不得引起状态错乱
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "无关属性变化不得改变抽屉状态");
});

test("属性兜底：开合属性完全认不到时默认收起（拿不准就选不会困住用户的一边）", () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: null, detailsAttr: null }), js);
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false,
    "官方开合属性都认不到时，不得默认展开抽屉（离屏抽屉会盖住内容，而收起态至少还能用汉堡打开）");
  assert.equal(env.html.classList.contains("dsh-ma-scrim-on"), false, "认不到属性时遮罩不得拦点击");
  const ham = findHamburger(env);
  assert.ok(ham, "此时汉堡按钮必须存在");
  ham.dispatchEvent(new Ev("click", {}));
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "认不到属性也要能用汉堡按钮打开抽屉（可自救）");
});

// ══════════════════════════════════════════════════════════════════════════════
// 回归（0.6.9-beta.2 用户实测）：「选择工作区之后，左边那个抽屉它自己没有收回去」
//
// 根因：自动收抽屉的委托用**官方属性**（expanded()）当闸门，而官方表达"展开"的方式恰恰是
// **把 data-sidebar-collapsed 移除** —— 抽屉一打开，expanded() 就变成 false
// （属性名认不到时更恒为 false），委托第一行直接 return，所有自动收起全部失效。
// 真机取证（390×844，抽屉已展开）：frame 上 "(无 data-sidebar-collapsed)"。
// 修法：闸门改用适配层自己的确定状态（dsh-ma-sidebar-open || sidebarInView()）。
// ══════════════════════════════════════════════════════════════════════════════

/** 模拟"官方两个开合属性都认不到"（比 0.1.5 改名更极端；也是回归用例最关键的现场）。 */
function openDrawerWithoutAttrs(env) {
  env.frame.removeAttribute("data-sidebar-collapsed");
  env.frame.removeAttribute("data-sidebar-open");
  findHamburger(env).dispatchEvent(new Ev("click", {}));
}
const toggleClicks = (env) => { let n = 0; env.toggle.addEventListener("click", () => { n += 1; }); return () => n; };
const waitTick = () => new Promise((r) => setTimeout(r, 30));

test("自动收抽屉：官方开合属性认不到时，点会话行**仍然**收起（本次回归的主用例）", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  const clicks = toggleClicks(env);
  openDrawerWithoutAttrs(env);
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "前提：抽屉已展开");
  assert.equal(env.frame.hasAttribute("data-sidebar-collapsed"), false, "前提：官方属性认不到(真机就是「展开时移除该属性」)");
  env.row.dispatchEvent(new Ev("click", {}));
  await waitTick();
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false,
    "属性认不到也必须能自动收起（闸门要用适配层自己的状态，不能用官方属性的猜测）");
  assert.ok(clicks() >= 1, "并应点一次官方 toggle（让官方状态与视觉一致）");
});

test("自动收抽屉：点工作区行里的「New session in <工作区>」也收起（= 抽屉里的「选择工作区」入口）", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  openDrawerWithoutAttrs(env);
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "前提：抽屉已展开");
  env.wsNewBtn.dispatchEvent(new Ev("click", {}));
  await waitTick();
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false,
    "在该工作区里新建会话 = 选定了工作区并进入 → 抽屉必须收起（官方 aria-label: New session in <工作区>）");
});

test("自动收抽屉：点工作区行本身（展开/折叠 disclosure）**不**收起", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  openDrawerWithoutAttrs(env);
  env.wsTitle.dispatchEvent(new Ev("click", {}));         // 点在标题上 = 官方 onToggle(展开该工作区)
  await waitTick();
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true,
    "工作区行是 disclosure（官方源码 onClick: onToggle → setGroupExpanded；真机实测 aria-expanded false→true、会话行 6→11 条），"
    + "点它只是展开列表给用户看，收起抽屉会导致「展开完看不到」");
  env.wsMenuBtn.dispatchEvent(new Ev("click", {}));       // 行内「⋯」菜单
  await waitTick();
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true, "行内「⋯」菜单也是就地操作，不得收起抽屉");
});

test("自动收抽屉：点侧栏里的非交互区域（滚动槽/纯文本）不收起", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  openDrawerWithoutAttrs(env);
  env.gutterText.dispatchEvent(new Ev("click", {}));
  env.sidebar.dispatchEvent(new Ev("click", {}));
  await waitTick();
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), true,
    "点侧栏空白/滚动槽不得收起（不能变成「点侧栏里任何东西都收」）");
});

test("自动收抽屉：点 Task Board 入口收起（导航类）", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  openDrawerWithoutAttrs(env);
  env.taskBoard.dispatchEvent(new Ev("click", {}));
  await waitTick();
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false, "Task Board 是切换主视图的导航入口 → 应收起抽屉");
});

test("自动收抽屉：抽屉没开时点会话行不得产生任何副作用（不误点官方 toggle）", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true" }), js);
  const clicks = toggleClicks(env);
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false, "前提：抽屉是收起的");
  env.row.dispatchEvent(new Ev("click", {}));
  await waitTick();
  assert.equal(clicks(), 0, "抽屉没开就不该去点官方 toggle（那会把抽屉打开/状态搞乱）");
  assert.equal(env.html.classList.contains("dsh-ma-sidebar-open"), false, "也不得因此打开抽屉");
});

test("自动收抽屉：桌面宽屏(>820)不收起", async () => {
  const { js } = injected();
  const env = run(harness({ collapsedAttr: "true", detailsAttr: "true", width: 1280, height: 900 }), js);
  const clicks = toggleClicks(env);
  env.row.dispatchEvent(new Ev("click", {}));
  await waitTick();
  assert.equal(clicks(), 0, "宽屏没有离屏抽屉这回事 —— 窄屏门必须继续有效");
});

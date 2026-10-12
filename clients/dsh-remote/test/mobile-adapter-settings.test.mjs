#!/usr/bin/env node
/**
 * mobile-adapter 设置面板窄屏适配回归（2026-10-13 新增）。
 *
 * 背景（用户反馈 + 真机 390×844 实测）：
 *   「手机端访问设置界面布局挤到一条竖线上」——官方设置弹层是**桌面两栏**
 *   （0.2.0-rc.2 实测：panel 342×796、nav 188 宽竖排、content 只剩 154px 可视宽）。
 *   适配层此前只挂 [class~="VOzbGW_*"]（0.1.2–0.1.5 的混淆前缀），
 *   0.2.0-rc.2 重新打包后前缀变成 Dws9Sa_* → **整段 CSS 静默失效**。
 *   用户要求的目标形态：**tab 放顶部（横排）+ 下方内容区满宽 + 弹窗按手机尺寸收敛**。
 *
 * 本文件锁三件事（都是"下次不会再静默坏掉"的判据）：
 *   ① CSS 契约：三层识别（已知前缀 / 结构稳定类 / :has 兜底）、面板竖排、nav 横排置顶、
 *      content 满宽、通用弹层 100vw-24px + max-height + 内部滚动、规则顺序（通用弹层在前）；
 *   ② 结构兜底**真的能跑**：把官方类名全部换成未知前缀（模拟下次改名），在假 DOM 上仍然
 *      认出面板并打上 dsh-ma-settings-* 稳定类；
 *   ③ 不回归：宽屏（>820）零动作、只给**已有**节点打类（不新建任何覆盖层节点）、
 *      认不出结构时只留一条可见 console.warn（护栏禁止全屏覆盖层）。
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
const { js: ADAPTER_JS, css: ADAPTER_CSS } = injected();

/** 只取 ≤820px 媒体块（新规则必须全部落在里面，这才谈得上"桌面零影响"）。 */
function narrowCss() {
  const start = ADAPTER_CSS.indexOf("@media (max-width: 820px)");
  assert.ok(start >= 0, "应有窄屏媒体查询");
  let depth = 0, i = ADAPTER_CSS.indexOf("{", start);
  const from = i + 1;
  for (; i < ADAPTER_CSS.length; i++) {
    if (ADAPTER_CSS[i] === "{") depth++;
    else if (ADAPTER_CSS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return ADAPTER_CSS.slice(from, i);
}
const NARROW_CSS = narrowCss();

// ── 极简假 DOM（只实现本用例需要的那些面） ─────────────────────────────────────
/** 支持 `tag`、`.cls`、`[attr="v"]`、`[attr]` 与其逗号组合；不支持 `~=`（脚本里没用到）。 */
function matchesSel(el, sel) {
  return String(sel).split(",").some((one) => {
    const s = one.trim();
    if (!s) return false;
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(s);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!el._cls.has(c.slice(1))) return false;
    for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
      const body = a.slice(1, -1);
      const eq = /^([\w-]+)(?:="([^"]*)")?$/.exec(body);
      if (!eq) return false;
      if (!(eq[1] in el.attrs)) return false;
      if (eq[2] !== undefined && String(el.attrs[eq[1]]).toLowerCase() !== eq[2].toLowerCase()) return false;
    }
    return true;
  });
}

class El {
  constructor(tag = "div", attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this._cls = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    this._rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    this._text = "";
    this.scrolled = 0;
    this.createdBy = null;
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
    };
  }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return n in this.attrs; }
  removeAttribute(n) { delete this.attrs[n]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  getBoundingClientRect() { return this._rect; }
  get parentElement() { return this.parent || null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n._isRoot === true; }
  matches(sel) { return matchesSel(this, sel); }
  closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parent; } return null; }
  contains(n) { while (n) { if (n === this) return true; n = n.parent; } return false; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(sel) { return this.descendants().find((e) => e.matches(sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter((e) => e.matches(sel)); }
  addEventListener() {}
  removeEventListener() {}
  remove() { if (this.parent) this.parent.removeChild(this); }
  scrollIntoView() { this.scrolled++; }
  focus() {}
  click() {}
  setPointerCapture() {}
  prepend() {}
}

/** 建一个"官方设置弹层"盒子：prefix 就是官方混淆前缀（改成未知前缀 = 模拟下次改名）。 */
function settingsBox(prefix, { width = 390, height = 844, withNav = true, navTag = "nav" } = {}) {
  const rect = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h });
  const overlay = new El("div", { class: prefix + "overlay", role: "presentation" });
  overlay._rect = rect(0, 0, width, height);
  const mask = new El("div", { class: prefix + "mask" });
  const panel = new El("div", { class: prefix + "panel", role: "dialog", "aria-modal": "true" });
  // 真实 0.2 实测：390 宽下 panel 342×796（桌面两栏），nav 188 宽竖排，content 只剩 154
  panel._rect = rect(24, 24, Math.min(800, width - 48), height - 48);
  const content = new El("div", { class: prefix + "content" });
  content._rect = rect(212, 24, 154, height - 48);
  const header = new El("div", { class: prefix + "header" });
  const options = new El("div", { class: prefix + "options" });
  content.appendChild(header); content.appendChild(options);
  panel.appendChild(content);
  const nodes = [overlay, panel, content, header, options];
  if (withNav) {
    const n = new El(navTag, { class: prefix + "nav" });
    n._rect = rect(24, 24, 188, height - 48);
    const navTitle = new El("div", { class: prefix + "navTitle" });
    navTitle.textContent = "设置";
    const navList = new El("div", { class: prefix + "navList" });
    for (const [i, label] of ["通用设置", "模型", "内置插件"].entries()) {
      const cell = new El("button", { class: prefix + "navCell" + (i === 1 ? " " + prefix + "active" : "") });
      cell.textContent = label;
      if (i === 1) cell.setAttribute("aria-current", "true");
      navList.appendChild(cell);
      nodes.push(cell);
    }
    n.appendChild(navTitle); n.appendChild(navList);
    panel.children.unshift(n);
    n.parent = panel;
    nodes.push(n, navTitle, navList);
  }
  overlay.appendChild(mask); overlay.appendChild(panel);
  return { overlay, panel, content, nodes };
}

/** 搭假环境：document/window 够跑注入脚本，且能捕获 console.warn 与 pump 定时器。 */
function harness({ prefix = "Dws9Sa_", width = 390, height = 844, withNav = true, navTag = "nav", withDialog = true } = {}) {
  const html = new El("html");
  html._isRoot = true;
  // HOSTISH() 读 documentElement.outerHTML 找官方特征
  html.outerHTML = '<html><head><script>window.__ModuleLoader__ = { mode: "queue" }</script>'
    + "<title>DeepSeek Harness</title></head><body></body></html>";
  const body = new El("body");
  body.parent = html;
  const box = withDialog ? settingsBox(prefix, { width, height, withNav, navTag }) : null;
  if (box) { body.appendChild(box.overlay); }
  // 记录"脚本自己新建"的节点（用来断言我们没有凭空造覆盖层/面板）
  const created = [];

  const doc = {
    documentElement: html,
    body,
    readyState: "complete",
    title: "DeepSeek Harness",
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) { const el = new El(tag); el.createdBy = "adapter"; created.push(el); return el; },
    createTextNode: (t) => ({ nodeValue: t, createdBy: "adapter" }),
    getElementById: () => null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
  };
  const warns = [];
  const intervals = [];
  const timers = new Set();
  const win = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 1,
    localStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => { fn(); return 1; },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); try { id.unref?.(); } catch { /* 忽略 */ } timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    fetch: undefined,
  };
  const loc = { href: "https://n.risegao.cn:13443/remote/dev-x/", host: "n.risegao.cn", pathname: "/remote/dev-x/", origin: "https://n.risegao.cn:13443" };
  win.location = loc;
  const consoleMock = { ...console, warn: (...a) => { warns.push(a.map(String).join(" ")); }, log: () => {}, error: () => {} };
  win.console = consoleMock;   // 适配层的诊断走 window.console（镜像页里就是页面控制台）
  const ctx = vm.createContext({
    window: win, document: doc, console: consoleMock,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    setInterval: win.setInterval, clearInterval: win.clearInterval,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame,
    navigator: { userAgent: "iPhone Safari", maxTouchPoints: 5, platform: "iPhone" },
    location: loc, localStorage: win.localStorage,
    URL, Date, Math, JSON, Object, Array, String, Number, RegExp, Boolean, Promise, Error, isNaN, parseInt, parseFloat,
    HTMLElement: El,
  });
  ctx.globalThis = ctx;
  ctx.self = win;
  ctx.console = consoleMock;
  return { ctx, doc, body, html, box, warns, intervals, created, win };
}

/** 跑注入脚本 + 主动推一拍 pump（脚本用 setInterval(pump, 1000) 兜底驱动）。 */
function runAdapter(env) {
  vm.runInContext(ADAPTER_JS, env.ctx, { timeout: 5000 });
  for (const fn of env.intervals) { try { fn(); } catch { /* 忽略 */ } }
  return env;
}

const has = (el, cls) => el._cls.has(cls);

// ── ① CSS 契约 ───────────────────────────────────────────────────────────────
test("CSS:三层识别都在(已知前缀 0.1.5/0.2 + 结构稳定类 + :has 兜底)", () => {
  for (const s of ['[class~="VOzbGW_overlay"]', '[class~="VOzbGW_panel"]', '[class~="VOzbGW_nav"]',
    '[class~="Dws9Sa_overlay"]', '[class~="Dws9Sa_panel"]', '[class~="Dws9Sa_nav"]',
    '[class~="Dws9Sa_navList"]', '[class~="Dws9Sa_navCell"]', '[class~="Dws9Sa_content"]',
    '[class~="Dws9Sa_options"]', ".dsh-ma-settings-panel", ".dsh-ma-settings-nav",
    ".dsh-ma-settings-navlist", ".dsh-ma-settings-cell", ".dsh-ma-settings-content"]) {
    assert.ok(NARROW_CSS.includes(s), `窄屏 CSS 应包含 ${s}`);
  }
  assert.match(NARROW_CSS, /div\[role="dialog"\]:has\(> nav\)/, ":has() 兜底应存在");
  assert.match(NARROW_CSS, /div\[role="dialog"\] > nav\b/, "结构选择器(直接子 nav)应存在");
});

test("CSS:窄屏 = 顶部横向 tab 行 + 下方内容满宽(nav 与 content 上下而非左右)", () => {
  // 面板竖排
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_panel"\][^{}]*\{[^}]*flex-direction:\s*column\s*!important/,
    "面板必须竖排(nav 在上、content 在下)");
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_panel"\][^{}]*\{[^}]*width:\s*100%\s*!important/);
  // nav 横排 + 整行 + 可横滑
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_nav"\][^{}]*\{[^}]*flex-direction:\s*row\s*!important/,
    "nav 必须横排");
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_nav"\][^{}]*\{[^}]*width:\s*100%\s*!important/);
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_navList"\][^{}]*\{[^}]*overflow-x:\s*auto/,
    "tab 行要能横向滚动");
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_navCell"\][^{}]*\{[^}]*font-size:\s*13px\s*!important/,
    "tab 字号 ≤13px");
  // content 满宽 + 内部滚动
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_content"\][^{}]*\{[^}]*width:\s*100%\s*!important/);
  assert.match(NARROW_CSS, /\[class~="Dws9Sa_options"\][^{}]*\{[^}]*overflow-y:\s*auto/);
  // 安全区留白
  assert.match(NARROW_CSS, /env\(safe-area-inset-bottom\)/);
  assert.match(NARROW_CSS, /env\(safe-area-inset-top\)/);
});

test("CSS:弹层按手机尺寸收敛(100vw-24px / max-height / 内部滚动 / 圆角收敛)", () => {
  // 官方 dialog/alertdialog/modal + 本项目 .dru-popup-card
  assert.match(NARROW_CSS, /\[role="dialog"\][^{}]*\{[^}]*max-width:\s*calc\(100vw - 24px\)\s*!important/);
  assert.match(NARROW_CSS, /\[role="alertdialog"\]/);
  assert.match(NARROW_CSS, /\[aria-modal="true"\]/);
  assert.match(NARROW_CSS, /\.dru-popup-card/);
  assert.match(NARROW_CSS, /max-height:\s*calc\(100dvh - 24px\)\s*!important/);
  assert.match(NARROW_CSS, /max-height:\s*calc\(100vh - 24px\)\s*!important/, "不认 dvh 的老浏览器要有 vh 兜底");
  assert.match(NARROW_CSS, /border-radius:\s*12px\s*!important/);
  assert.match(NARROW_CSS, /\.dru-popup\s*\{[^}]*padding:\s*12px\s*!important/);
});

test("CSS:通用弹层规则必须排在设置弹层规则之前(否则设置面板被 24px 边距钉住)", () => {
  const dialogAt = NARROW_CSS.indexOf('[role="dialog"]');
  const panelAt = NARROW_CSS.indexOf('[class~="Dws9Sa_panel"]');
  assert.ok(dialogAt >= 0 && panelAt >= 0);
  assert.ok(dialogAt < panelAt, "通用弹层在前、设置面板在后(同特异性靠顺序决胜)");
});

test("CSS:新增的弹层/设置规则全部落在 ≤820px 媒体块内(宽屏零影响)", () => {
  for (const s of ['[role="dialog"]', ".dru-popup-card", '[class~="Dws9Sa_panel"]', ".dsh-ma-settings-panel"]) {
    assert.ok(NARROW_CSS.includes(s), `${s} 必须在窄屏媒体块内`);
  }
  // 媒体块之外不得出现这些选择器（整体 <style> 里只能在媒体块出现一次）
  const outside = ADAPTER_CSS.replace(NARROW_CSS, "");
  for (const s of ['[class~="Dws9Sa_panel"]', ".dsh-ma-settings-panel", ".dru-popup-card"]) {
    assert.ok(!outside.includes(s), `${s} 不得出现在窄屏媒体块之外`);
  }
});

// ── ② 结构兜底（模拟"官方再次改名"） ───────────────────────────────────────────
test("结构兜底:官方类名全部换成未知前缀,窄屏仍能认出设置面板并打稳定类", () => {
  const env = runAdapter(harness({ prefix: "Zz9Qq_" }));
  const { panel, content } = env.box;
  assert.ok(has(panel, "dsh-ma-settings-panel"), "未知前缀下也应认出面板");
  assert.ok(has(env.box.overlay, "dsh-ma-settings-overlay"), "overlay 也应打标");
  assert.ok(has(panel.children[0], "dsh-ma-settings-nav"), "nav 应打标");
  assert.ok(has(content, "dsh-ma-settings-content"), "content 应打标");
  const navList = panel.children[0].children[1];
  assert.ok(has(navList, "dsh-ma-settings-navlist"), "tab 列表应打标");
  for (const cell of navList.children) assert.ok(has(cell, "dsh-ma-settings-cell"), "每个 tab 都应打标");
  assert.ok(has(navList.children[1], "dsh-ma-settings-active"), "当前 tab(aria-current/_active)应打标");
  assert.ok(env.warns.some((w) => w.includes("结构")), "前缀改名必须留下**可见**降级诊断");
});

test("0.2 前缀(Dws9Sa_):稳定类照打,但不报「改名」告警", () => {
  const env = runAdapter(harness({ prefix: "Dws9Sa_" }));
  assert.ok(has(env.box.panel, "dsh-ma-settings-panel"));
  assert.ok(has(env.box.content, "dsh-ma-settings-content"));
  assert.equal(env.warns.filter((w) => w.includes("混淆前缀")).length, 0, "已知前缀不该报改名告警");
});

test("0.1.5 前缀(VOzbGW_)同样打标(老版本不许回归)", () => {
  const env = runAdapter(harness({ prefix: "VOzbGW_" }));
  assert.ok(has(env.box.panel, "dsh-ma-settings-panel"));
  assert.ok(has(env.box.panel.children[0], "dsh-ma-settings-nav"));
});

test("结构兜底:nav 不是 <nav> 标签(官方改了标签名)时认不出 → 只留一条可见诊断,不报错", () => {
  const env = runAdapter(harness({ prefix: "Zz9Qq_", navTag: "div" }));
  assert.ok(!has(env.box.panel, "dsh-ma-settings-panel"), "认不出就不许乱打类(宁可不做,不可做错)");
  assert.ok(env.warns.some((w) => w.includes("未能识别为设置面板")), "应给出可见的降级诊断");
});

test("假 DOM 也不会被官方改名吓住:识别是幂等的,重复 pump 不重复打标/不刷屏告警", () => {
  const env = harness({ prefix: "Zz9Qq_" });
  runAdapter(env);
  for (const fn of env.intervals) { try { fn(); } catch { /* 忽略 */ } }
  const renamed = env.warns.filter((w) => w.includes("结构"));
  assert.equal(renamed.length, 1, "同类降级诊断只报一次(不刷屏)");
});

// ── ③ 不回归 ─────────────────────────────────────────────────────────────────
test("宽屏(>820)零动作:不打稳定类、不告警", () => {
  const env = runAdapter(harness({ prefix: "Zz9Qq_", width: 1280, height: 900 }));
  assert.ok(!has(env.box.panel, "dsh-ma-settings-panel"), "宽屏不得改动设置面板");
  assert.equal(env.warns.length, 0, "宽屏不得有任何诊断输出");
});

test("只给**已有**节点打类:不新建任何设置/覆盖层节点(护栏:适配层不得引入全屏覆盖层)", () => {
  const env = runAdapter(harness({ prefix: "Zz9Qq_" }));
  const tagged = [env.box.overlay, env.box.panel, ...env.box.nodes].filter((el) =>
    [...el._cls].some((c) => c.startsWith("dsh-ma-settings")));
  assert.ok(tagged.length > 0);
  for (const el of tagged) assert.notEqual(el.createdBy, "adapter", "稳定类只能打在官方已有节点上");
  // 新建节点里不得出现任何 fixed/absolute 覆盖层（只看适配层自己造的）
  for (const el of env.created) assert.ok(!/overlay|scrim|mask/i.test(el.className), "不得新建覆盖层节点");
});

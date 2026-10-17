#!/usr/bin/env node
/**
 * 镜像页「加载看门狗」回归（2026-10-17 真实事故）。
 *
 * 事故现场：用户本机 `~/.dsh-remote`（bridge 运行时 + 账号配对信息/设备密钥）被误删 →
 * bridge 起不来、设备离线；手机端镜像页第一次加载**干等 47 秒**才报错，页面上没有任何可操作入口
 * （只有悬浮菜单里一行"已等 N 秒…复制给客服"）。同一天面板也没有"需要重新安装/登录"的明确提示。
 *
 * 本文件锁死镜像页这一半的行为（脚本用 vm 跑真实注入体，指令级断言，不是文本 grep）：
 *   ① 阈值常量 = 12 秒（原来是 25 秒 —— 用户实测 25 秒提示已经太晚）；
 *   ② 解析期绝不创建提示层；**slow 之后**才懒创建，且只创建一次（不重复插入）；
 *   ③ 三个按钮的行为：重试 = location.reload / 返回设备列表 = 导航到 /app/ /
 *      复制诊断信息 = maLoadCopyLine（含 UA 与耗时）写进剪贴板（不可用时把整句显示出来）；
 *   ④ ✕ 关闭后本页不再弹；认出官方界面后自动收起（判错也不会长期挂着）；
 *   ⑤ 注入体不含 `</script>`、语法可编译；动画只在 prefers-reduced-motion: no-preference 下挂
 *      （老浏览器没有 matchMedia 也不会有动画 —— 用纯 CSS 特性门，不依赖 JS 判断）；
 *   ⑥ mirror_load 遥测字段与"一次语义"不变（ms/outcome/at，outcome=slow）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 取出注入脚本原文（不加壳，原样执行）。 */
function adapterScript() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能从注入结果里取出脚本");
  return m[1];
}
/** 取出注入样式原文（源码契约类断言用）。 */
function adapterCss() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<style id="[^"]*-css"[^>]*>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(m, "应能从注入结果里取出样式");
  return m[1];
}

// ── 极简假 DOM（只覆盖本用例需要的那点能力：class/attr 选择器 + 事件委托冒泡） ──────────────

function matchesSel(el, sel) {
  const s = String(sel).trim();
  if (!s) return false;
  const parts = s.match(/^[a-zA-Z][\w-]*|\.[^.[\s]+|\[[^\]]+\]/g);
  if (!parts) return false;
  for (const p of parts) {
    if (p[0] === ".") { if (!el._cls.has(p.slice(1))) return false; continue; }
    if (p[0] === "[") {
      const m = /^([\w-]+)(?:="([^"]*)")?$/.exec(p.slice(1, -1));
      if (!m) return false;
      if (!(m[1] in el.attrs)) return false;
      if (m[2] !== undefined && String(el.attrs[m[1]]) !== m[2]) return false;
      continue;
    }
    if (el.tagName !== p.toUpperCase()) return false;
  }
  return true;
}
const matchesAny = (el, sel) => String(sel).split(",").some((one) => matchesSel(el, one));

class Ev {
  constructor(type) {
    this.type = type;
    this.target = null;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this._cls = new Set();
    this._listeners = new Map(); // type -> fn[]
    this.style = { setProperty() {}, removeProperty() {} };
    this._text = "";
    this.hidden = false;
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._cls.add(c)),
      remove: (...cs) => cs.forEach((c) => this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !this._cls.has(c) : !!on; if (want) this._cls.add(c); else this._cls.delete(c); return want; },
    };
  }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    for (const m of String(html).matchAll(/<(\w+)([^>]*)>/g)) {
      const el = new El(m[1]);
      for (const a of (m[2] || "").matchAll(/([\w-]+)="([^"]*)"/g)) el.attrs[a[1]] = a[2];
      if (el.attrs.class) el.className = el.attrs.class;
      this.appendChild(el);
    }
  }
  get innerHTML() { return this._html || ""; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  prepend() {}
  focus() {}
  blur() {}
  setPointerCapture() {}
  scrollIntoView() {}
  get isConnected() { return true; }
  contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parent; } return false; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelector(sel) { return this.descendants().find((e) => matchesAny(e, sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter((e) => matchesAny(e, sel)); }
  addEventListener(type, fn) { (this._listeners.get(type) || this._listeners.set(type, []).get(type)).push(fn); }
  removeEventListener() {}
  /** 事件冒泡：目标先跑，再沿 parent 链向上（提示条用的是事件委托）。 */
  dispatchEvent(ev) {
    ev.target = this;
    let n = this;
    while (n) {
      for (const fn of n._listeners.get(ev.type) || []) fn(ev);
      n = n.parent;
    }
    return !ev.defaultPrevented;
  }
  click() { return this.dispatchEvent(new Ev("click")); }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
}

/**
 * 空镜像页环境：**没有任何官方界面**（正是"bridge 挂了/页面没加载出来"的现场）。
 * 定时器全部记录不真跑：用例自己按需 fire（12 秒看门狗、1 秒秒数刷新都由用例驱动）。
 */
function harness(opts = {}) {
  const timers = new Map();      // id -> { fn, ms }
  const intervals = new Map();   // id -> fn
  const fetches = [];
  let timerSeq = 0;
  let intervalSeq = 0;
  const clicks = { reload: 0, assign: [], clipboard: [] };

  const html = new El("html");
  html.outerHTML = "<html><head></head><body></body></html>"; // 无官方特征 → HOSTISH 为 false
  const body = new El("body");

  const doc = new El("#document");
  doc.tagName = "#DOCUMENT";
  doc.documentElement = html;
  doc.body = body;
  doc.readyState = "complete";
  doc.createElement = (t) => {
    if (opts.createElementThrows && String(t) === "div") throw new Error("DOM 挂了（模拟异常）");
    return new El(t);
  };
  doc.createTextNode = (t) => ({ nodeValue: t });
  doc.getElementById = () => null;
  const docQS = El.prototype.querySelector.bind(doc);
  doc.querySelector = (sel) => (opts.officialReady ? new El("div") : docQS(sel));
  doc.querySelectorAll = () => [];
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};

  const loc = {
    href: "https://n.risegao.cn:13443/remote/dev-x/",
    pathname: "/remote/dev-x/",
    origin: "https://n.risegao.cn:13443",
    reload() { clicks.reload += 1; },
    assign(to) { clicks.assign.push(String(to)); },
  };
  const win = {
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    localStorage: { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    location: loc,
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); try { id.unref?.(); } catch { /* 忽略 */ } return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => { const id = ++intervalSeq; intervals.set(id, fn); return id; },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "", pointerEvents: "auto", zIndex: "" }),
    fetch: (input, init) => { fetches.push({ input: String(input), init }); return Promise.resolve({ ok: true, status: 200 }); },
  };
  const navigator = { userAgent: opts.userAgent || "iPhone Safari (load-watch test)", maxTouchPoints: 5, platform: "iPhone" };
  if (opts.clipboard !== false) {
    navigator.clipboard = { writeText: (text) => { clicks.clipboard.push(String(text)); return Promise.resolve(); } };
  }
  const ctx = vm.createContext({
    window: win, document: doc, console: { log() {}, warn() {}, error() {} },
    navigator, location: loc, localStorage: win.localStorage,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    setInterval: win.setInterval, clearInterval: win.clearInterval,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame,
    fetch: win.fetch, performance: { now: () => Date.now() },
    URL, Date, Math, JSON, Object, Array, String, Number, RegExp, Boolean, Promise, Error, isNaN, parseInt, parseFloat,
    HTMLElement: El,
  });
  ctx.globalThis = ctx;
  ctx.self = win;

  const findBar = () => body.children.find((c) => c._cls.has("dsh-ma-loadbar")) || null;
  const barBtn = (role) => (findBar() ? findBar().querySelector('[data-role="' + role + '"]') : null);
  const findWatchTimer = (ms) => [...timers.values()].find((t) => t.ms === ms) || null;
  return {
    ctx, win, doc, body, timers, intervals, fetches, clicks, navigator,
    findBar, barBtn, findWatchTimer,
    /** 触发某个已登记的 setTimeout 回调（用例手工推进时间轴）。 */
    fireTimer(ms) {
      const t = findWatchTimer(ms);
      assert.ok(t, `应登记了 ${ms}ms 的定时器`);
      t.fn();
    },
    /** 触发所有 setInterval（秒数刷新 / 自适应兜底）。 */
    tickIntervals() { for (const fn of [...intervals.values()]) fn(); },
  };
}

function runScript(env) {
  vm.runInContext(adapterScript(), env.ctx, { timeout: 5000 });
  return env;
}

// ══════════════════════════════════════════════════════════════════════════════
// ① 阈值与注入体硬约束
// ══════════════════════════════════════════════════════════════════════════════

test("阈值常量 = 12 秒（25 秒太晚：用户实测干等 47 秒才看到任何东西）", () => {
  const script = adapterScript();
  assert.match(script, /var MA_LOAD_WATCH_MS = 12 \* 1000;/, "看门狗阈值常量必须是 12 秒");
  assert.match(script, /\}, MA_LOAD_WATCH_MS\);/, "setTimeout 必须用该常量（不得再散落魔法数）");
  assert.ok(!/25 \* 1000/.test(script), "不得残留 25 秒阈值");
  // 语义保留：认出官方界面就不提示（宁可不提示也不要日常误报）
  assert.match(script, /if \(maLoadReadyNow\(\)\) return;/, "认出官方界面就不该提示");
});

test("注入体：不含 `</script>`、语法可编译、无 matchMedia 依赖（老浏览器/减少动效走纯 CSS 降级）", () => {
  const script = adapterScript();
  assert.equal(script.includes("</script>"), false, "注入体内出现 </script> 会提前闭合标签，页面直接坏掉");
  assert.doesNotThrow(() => new vm.Script(script), "注入体必须可编译（vm.Script 不执行，只解析）");
  assert.equal(script.includes("matchMedia"), false,
    "不做 matchMedia 判断：动画只在 CSS 的 prefers-reduced-motion: no-preference 下挂 → 老浏览器天然无动画");
  const css = adapterCss();
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/, "动效必须放在 no-preference 特性门里");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "显式要求减少动效时必须无动画");
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]{0,200}animation: none !important/, "reduce 分支要显式关掉动画");
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 解析期不碰 DOM；slow 之后才懒创建、且只创建一次
// ══════════════════════════════════════════════════════════════════════════════

test("解析期绝不创建提示层：12 秒没到之前 body 里一个 dsh-ma-loadbar 都没有", () => {
  const env = runScript(harness());
  assert.equal(env.findBar(), null, "解析期就挂提示层 = 页面还没坏就可能挡住用户（历史事故根因），绝对不许");
  assert.equal(env.body.children.length, 0, "解析期不得往 body 塞任何适配层节点");
});

test("slow 之后才出现提示层，且只创建一次（重复触发不会插第二份）", () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  const bar = env.findBar();
  assert.ok(bar, "12 秒仍认不出官方界面 → 必须出现底部可操作提示条");
  assert.equal(bar.hidden, false, "出现后应是可见状态");
  assert.match(bar.textContent || bar.querySelector('[data-role="loadbar-txt"]').textContent,
    /电脑端可能未连接 \/ 页面加载较慢/, "文案必须明确说明可能的原因");
  assert.match(bar.querySelector('[data-role="loadbar-txt"]').textContent, /已等待 \d+ 秒/, "必须带已等待秒数");
  // 再触发一次（模拟重复路径/bfcache 恢复）→ 不得插第二份
  env.fireTimer(12000);
  const bars = env.body.children.filter((c) => c._cls.has("dsh-ma-loadbar"));
  assert.equal(bars.length, 1, "提示层只能有一份（重复插入会叠字/叠按钮）");
});

test("已认出官方界面时看门狗不提示（宁可不提示，也不要在正常页面上打扰）", () => {
  const env = runScript(harness({ officialReady: true }));
  env.fireTimer(12000);
  assert.equal(env.findBar(), null, "官方界面已就绪 → 不得出现任何提示层");
});

test("提示层创建过程中抛异常也不影响页面（吞掉，绝不把页面拖挂）", () => {
  const env = runScript(harness({ createElementThrows: true }));
  assert.doesNotThrow(() => env.fireTimer(12000), "创建提示层失败必须被吞掉");
  assert.equal(env.findBar(), null, "创建失败 → 页面保持原样（没有半成品节点）");
});

// ══════════════════════════════════════════════════════════════════════════════
// ③ 三个按钮的点击行为（假 DOM + 桩）
// ══════════════════════════════════════════════════════════════════════════════

test("按钮「重试」= location.reload()", () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  env.barBtn("loadbar-retry").click();
  assert.equal(env.clicks.reload, 1, "点「重试」必须真的刷新页面");
});

test("按钮「返回设备列表」= 导航回 /app/（用户在镜像页里唯一的主动退路）", () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  env.barBtn("loadbar-back").click();
  assert.deepEqual(env.clicks.assign, ["/app/"], "「返回设备列表」必须导航到 APP 外壳根路径");
});

test("按钮「复制诊断信息」= maLoadCopyLine（含 UA 与耗时）写进剪贴板", async () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  env.barBtn("loadbar-copy").click();
  await new Promise((r) => setImmediate(r));
  assert.equal(env.clicks.clipboard.length, 1, "点一次应复制一次");
  const line = env.clicks.clipboard[0];
  assert.match(line, /dsh-remote 手机端加载疑似卡住/, "沿用既有诊断话术（可直接粘给客服）");
  assert.match(line, /等待 \d+ 秒/, "必须含耗时");
  assert.match(line, /UA=iPhone Safari/, "必须含 UA（便于定位机型/浏览器）");
  assert.match(env.findBar().querySelector('[data-role="loadbar-txt"]').textContent, /已复制诊断信息/, "复制成功要给可见反馈");
});

test("剪贴板不可用时，把整句诊断信息显示在提示条上（至少能截图）", async () => {
  const env = runScript(harness({ clipboard: false }));
  env.fireTimer(12000);
  env.barBtn("loadbar-copy").click();
  await new Promise((r) => setImmediate(r));
  assert.equal(env.clicks.clipboard.length, 0, "前提：没有剪贴板");
  assert.match(env.findBar().querySelector('[data-role="loadbar-txt"]').textContent, /dsh-remote 手机端加载疑似卡住/,
    "剪贴板不可用时必须把整句显示出来，用户才能截图");
});

// ══════════════════════════════════════════════════════════════════════════════
// ④ ✕ 关闭后本页不再弹；认出界面后自动收起
// ══════════════════════════════════════════════════════════════════════════════

test("点 ✕ 关闭后本页不再弹（不骚扰），且秒数刷新也停掉", () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  const bar = env.findBar();
  assert.equal(bar.hidden, false, "前提：提示条可见");
  env.barBtn("loadbar-close").click();
  assert.equal(bar.hidden, true, "点 ✕ 应收起");
  // 之后的重复触发（看门狗重入 / 秒数刷新）都不得再弹出来
  env.fireTimer(12000);
  env.tickIntervals();
  assert.equal(bar.hidden, true, "关闭后本页不再弹（只提示一次）");
  assert.equal(env.body.children.filter((c) => c._cls.has("dsh-ma-loadbar")).length, 1, "也不得再创建新节点");
});

test("用户一直没关、但页面后来加载出来了 → 提示条自动收起（判错也不会长期挂着）", () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  const bar = env.findBar();
  assert.equal(bar.hidden, false, "前提：提示条可见");
  // 模拟"页面其实已经好了"：让就绪判定命中官方 frame/输入框特征
  env.doc.querySelector = (sel) => (/pI_x6G_frame|ma-frame|sidebar-collapsed|details-collapsed|rightbar-collapsed|composer-input|contenteditable|role="textbox"|textarea/.test(String(sel)) ? new El("div") : null);
  env.tickIntervals(); // 1 秒秒数刷新那一拍顺便复核"是不是已经好了"
  assert.equal(bar.hidden, true, "认出官方界面后提示条必须自动收起（安全失败方向）");
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑤ 提示层本身的形态契约（不是全屏层、不遮挡、可关闭、按钮齐全）
// ══════════════════════════════════════════════════════════════════════════════

test("提示层是**底部轻量条**：不是全屏覆盖层、限高、层级低于 FAB（自救出口永远点得到）", () => {
  const css = adapterCss();
  const barRule = /div\.dsh-ma-loadbar\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(barRule, "必须有 div.dsh-ma-loadbar 的样式规则");
  const body = barRule[1];
  assert.match(body, /position:\s*fixed/, "提示条固定在视口上（滚动时不跑）");
  assert.match(body, /bottom:\s*calc\(/, "必须贴底部（不是居中/顶部遮罩）");
  assert.ok(!/inset:\s*0/.test(body), "不得是全屏层（inset:0）");
  assert.ok(!/top:\s*0(px)?;/.test(body), "不得同时钉 top:0（那就变成全屏覆盖了）");
  assert.match(body, /max-height:/, "必须限高（内容再长也不盖住主界面）");
  assert.match(body, /overflow-y:\s*auto/, "限高后内容要能滚动");
  assert.match(body, /z-index:\s*(\d+)/, "应有显式层级");
  const z = Number(/z-index:\s*(\d+)/.exec(body)[1]);
  assert.ok(z < 400, `提示条层级(${z})必须低于 FAB(400) —— 否则会压住"返回设备列表"的自救按钮`);
  assert.ok(!/z-index:\s*\d{7,}/.test(css), "不得出现百万级 z-index（压住一切 = 判断错就锁死用户）");
  assert.match(css, /div\.dsh-ma-loadbar\[hidden\]\s*\{\s*display:\s*none\s*!important/, "隐藏态必须显式 display:none（别被 display:flex 盖过）");
  // 四个可点元素齐全
  const script = adapterScript();
  for (const role of ["loadbar-retry", "loadbar-back", "loadbar-copy", "loadbar-close"]) {
    assert.match(script, new RegExp(`data-role="${role}"`), `提示条应含 ${role} 按钮`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ mirror_load 遥测：字段与"一次语义"不变
// ══════════════════════════════════════════════════════════════════════════════

test("slow 时照旧上报 mirror_load 兜底样本：字段 ms/outcome/at 不变、整页只报一次", () => {
  const env = runScript(harness());
  env.fireTimer(12000);
  const posts = env.fetches.filter((f) => String(f.input).includes("/dsh-remote/telemetry/mirror-load"));
  assert.equal(posts.length, 1, "slow 兜底样本每次页面只发一条（reported 一次语义）");
  const body = JSON.parse(posts[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["at", "ms", "outcome"], "字段必须仍是 ms/outcome/at（后台契约不动）");
  assert.equal(body.outcome, "slow", "看门狗兜底样本的 outcome 必须是 slow");
  assert.ok(Number.isFinite(body.ms) && body.ms >= 0 && body.ms <= 600000, "ms 必须被钳制在 [0,600000]");
  // 再触发一次：reported 已置位 → 不得重复上报
  env.fireTimer(12000);
  assert.equal(env.fetches.filter((f) => String(f.input).includes("mirror-load")).length, 1, "同一页只报一次");
});

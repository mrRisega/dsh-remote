#!/usr/bin/env node
/**
 * 手机端「同一 deviceId 只允许一个镜像页」回归（2026-10-23）。
 *
 * 生产现场：手机端会出现同一设备的两个镜像页并发（重复打开 / 从历史里点回来），
 *   两边互相取消资源加载 → 都一直转圈。
 *
 * 注入体里的守卫（mobile-adapter 的 DSH-MA-SINGLEPAGE 段）契约：
 *   ① 第一个页面：同步写租约（localStorage）+ BroadcastChannel claim，正常加载；
 *   ② 第二个页面：同步读到"别人的新鲜租约"→ 立刻 blocked（window.stop + 拦 fetch/XHR/WS
 *      + 全屏提示），**不写租约、不加载**；
 *   ③ 「在本窗口继续」：广播 takeover → 旧页让路并释放租约 → 本页 400ms 后重载接管；
 *   ④ 旧页关掉/失联（租约过期）→ blocked 页自动重载接管，不会永久卡在提示层；
 *   ⑤ 非镜像页（设备列表/登录页）、老浏览器（无 localStorage/BroadcastChannel）→ 零行为。
 *
 * 本文件跑的是注入脚本里**真实的那一段**（vm + 假 DOM），断言的是行为不是文本。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 注入脚本里取出单页守卫那一段（含结尾的调用）。 */
function guardSource() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能取出注入脚本");
  const js = m[1];
  const start = "/* ===DSH-MA-SINGLEPAGE-START===";
  const end = "/* ===DSH-MA-SINGLEPAGE-END=== */";
  const a = js.indexOf(start);
  const b = js.indexOf(end);
  assert.ok(a > 0 && b > a, "找不到单页守卫的段落标记（脚本结构变了，请同步更新本用例）");
  return js.slice(a, b + end.length);
}

const SRC = guardSource();

// ── 假环境（同一"浏览器"的多个页面共享 storage 与 BroadcastChannel 总线）──────────

const NOW0 = 1_700_000_000_000;

function makeGroup() {
  return {
    store: new Map(),
    channels: new Set(),
    messages: [],
    clock: { now: NOW0 }
  };
}

function makeStorage(group) {
  return {
    getItem(k) { return group.store.has(k) ? group.store.get(k) : null; },
    setItem(k, v) { group.store.set(k, String(v)); },
    removeItem(k) { group.store.delete(k); }
  };
}

class FakeBC {
  constructor(group, name) {
    this.group = group;
    this.name = name;
    this.onmessage = null;
    group.channels.add(this);
  }
  postMessage(msg) {
    this.group.messages.push(msg);
    // 浏览器里是异步投递；用例里同步投递（同源多页面），断言更直接
    for (const peer of this.group.channels) {
      if (peer === this) continue;
      if (typeof peer.onmessage === "function") peer.onmessage({ data: msg });
    }
  }
  close() { this.group.channels.delete(this); }
}

/** 极简假 DOM：只支持守卫用到的那点能力（createElement/body.appendChild/getElementById）。 */
function makeDoc() {
  const appended = [];
  const buttons = new Map();
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: "",
      attrs: {},
      style: { cssText: "" },
      innerHTML: "",
      children: [],
      _listeners: new Map(),
      setAttribute(n, v) { this.attrs[n] = String(v); },
      getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
      addEventListener(type, fn) { (this._listeners.get(type) || this._listeners.set(type, []).get(type)).push(fn); },
      appendChild(c) { this.children.push(c); return c; }
    };
    return el;
  };
  const body = makeEl("body");
  const doc = {
    body,
    _appended: appended,
    createElement: makeEl,
    addEventListener() {},
    getElementById(id) {
      const found = appended.find((el) => el.id === id || el.attrs.id === id);
      if (found) return found;
      // 提示层里的「在本窗口继续」按钮：innerHTML 里定义了 id，按需造一个可点击元素
      const overlay = appended.find((el) => el.id === "dsh-ma-singlepage");
      if (overlay && overlay.innerHTML.includes(`id="${id}"`)) {
        if (!buttons.has(id)) {
          const btn = makeEl("button");
          btn.id = id;
          buttons.set(id, btn);
        }
        return buttons.get(id);
      }
      return null;
    }
  };
  body.appendChild = (el) => { appended.push(el); return el; };
  return doc;
}

function makeEnv(group, { pathname = "/remote/dev-A/", withBC = true, withStorage = true } = {}) {
  const timers = { intervals: new Map(), timeouts: new Map(), seq: 0 };
  const doc = makeDoc();
  const storage = withStorage ? makeStorage(group) : null;
  const state = { stops: 0, reloads: 0, messages: [] };
  const loc = {
    pathname,
    href: `https://relay.example${pathname}`,
    reload() { state.reloads += 1; }
  };
  const FakeDate = class extends Date {
    static now() { return group.clock.now; }
  };
  const win = {
    localStorage: storage,
    // 真实 window.navigator 有 locks 就用（老 Safari 没有）；这里默认不给，测租约路径
    navigator: {},
    location: loc,
    addEventListener(type, fn) { state.messages.push(type); (win._ls || (win._ls = [])).push({ type, fn }); },
    _ls: [],
    stop() { state.stops += 1; },
    fetch: () => Promise.resolve({ ok: true }),
    XMLHttpRequest: class { send() {} abort() {} },
    WebSocket: class { constructor() { this.readyState = 1; } },
    console
  };
  if (withBC) win.BroadcastChannel = class extends FakeBC { constructor(name) { super(group, name); } };
  const sandbox = {
    window: win,
    document: doc,
    location: loc,
    localStorage: storage,
    console,
    Promise,
    Date: FakeDate,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    decodeURIComponent,
    isNaN,
    parseInt,
    parseFloat,
    setInterval: (fn, ms) => { const id = ++timers.seq; timers.intervals.set(id, { fn, ms, ticks: 0 }); return id; },
    clearInterval: (id) => { timers.intervals.delete(id); },
    setTimeout: (fn, ms) => { const id = ++timers.seq; timers.timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.timeouts.delete(id); }
  };
  vm.runInNewContext(SRC, sandbox, { filename: "mobile-adapter#singlepage" });
  const api = {
    win,
    doc,
    loc,
    sandbox,
    timers,
    state,
    get appState() { return win.__dshSinglePage ? win.__dshSinglePage.state : ""; },
    /** 跑一轮 2s 轮询（blocked 页的租约复查）。 */
    tickPoll() {
      for (const t of timers.intervals.values()) { if (t.ms === 2000) t.fn(); }
    },
    runTimeouts() {
      for (const [id, t] of [...timers.timeouts]) { timers.timeouts.delete(id); t.fn(); }
    },
    clickTakeover() {
      const btn = doc.getElementById("dsh-ma-singlepage-takeover");
      assert.ok(btn, "提示层里必须有「在本窗口继续」按钮");
      const fns = btn._listeners.get("click") || [];
      assert.ok(fns.length > 0, "按钮必须绑定了点击处理");
      for (const fn of fns) fn({ type: "click" });
    },
    dispatchWindow(type, extra = {}) {
      for (const l of win._ls || []) if (l.type === type) l.fn({ type, ...extra });
    },
    lease() {
      const raw = storage && storage.getItem(`dsh-remote-mirror-page:${pathname.split("/")[2]}`);
      return raw ? JSON.parse(raw) : null;
    },
    storeGet(key) { return storage ? storage.getItem(key) : null; },
    storeSet(key, val) { if (storage) storage.setItem(key, val); }
  };
  return api;
}

// ── 用例 ──────────────────────────────────────────────────────────────────────

test("① 第一个页面：同步写租约 + 广播 claim，正常加载", () => {
  const g = makeGroup();
  const a = makeEnv(g);
  assert.equal(a.appState, "active", "第一个页面必须是活跃页");
  const lease = a.lease();
  assert.ok(lease && typeof lease.id === "string", "必须写入租约");
  assert.equal(lease.at, NOW0);
  const claim = g.messages.find((m) => m.k === "claim");
  assert.ok(claim, "必须广播 claim（让后来的页面知道有人）");
  assert.equal(a.state.stops, 0, "活跃页不得停掉自己的加载");
});

test("② 第二个页面：同步识破别人的租约 → 立刻 blocked（stop + 拦网络 + 提示），且不写租约", async () => {
  const g = makeGroup();
  const first = makeEnv(g);
  const second = makeEnv(g);
  assert.equal(second.appState, "blocked", "第二页必须被按住");
  assert.equal(second.state.stops, 1, "必须 window.stop()（停止后续资源加载）");
  const overlay = second.doc.getElementById("dsh-ma-singlepage");
  assert.ok(overlay, "必须给出可见提示（不是静默卡住）");
  assert.equal(overlay.getAttribute("data-dsh-single-page"), "blocked");
  assert.match(overlay.innerHTML, /另一个窗口/, "提示文案要点明「已在另一个窗口打开」");
  assert.match(overlay.innerHTML, /在本窗口继续/, "必须给「在本窗口继续」出口");
  // 拦网络：fetch 拒绝、WebSocket 不可用
  await assert.rejects(() => second.win.fetch("/api/x"), /本页已停用/);
  assert.throws(() => new second.win.WebSocket("ws://x"), /本页已停用/);
  // 不许抢租约：租约仍属于第一页
  assert.equal(second.lease().id, first.lease().id, "第二页绝不能覆盖第一页的租约");
});

test("③ 「在本窗口继续」：广播 takeover → 旧页让路并释放租约 → 本页重载接管", () => {
  const g = makeGroup();
  const first = makeEnv(g);
  const second = makeEnv(g);
  const firstLeaseId = first.lease().id;

  second.clickTakeover();
  // 旧页收到 takeover：立刻让路（进入 blocked、释放租约）
  assert.equal(first.appState, "blocked", "旧页必须让路，不能两边都继续加载");
  assert.equal(first.lease(), null, "旧页必须释放租约");
  assert.ok(g.messages.some((m) => m.k === "takeover"), "必须广播 takeover");
  // 本页 400ms 后重载（重载后按 takeover 标记直接接管）
  assert.equal(second.state.reloads, 0, "还没到重载时间");
  second.runTimeouts();
  assert.equal(second.state.reloads, 1, "接管方必须重载一次，拿干净页面");
  // 重载后的路径：租约可能还在 + 有 takeover 标记 → 允许接管（否则自己把自己锁死）
  const reloaded = makeEnv(g);
  assert.equal(reloaded.appState, "active", "takeover 标记有效期内的重载必须能接管");
  assert.equal(reloaded.lease().id !== firstLeaseId, true, "接管后租约归属接管方");
  // 关键：takeover 标记必须"用掉即消费"，否则有效期内第三个页面也会以为自己能接管
  const third = makeEnv(g);
  assert.equal(third.appState, "blocked", "接管完成后，再开的页面仍必须被按住（不允许并发第三个）");
});

test("④ 旧页关掉/失联（租约过期）→ blocked 页自动重载接管，不会永久卡住", () => {
  const g = makeGroup();
  makeEnv(g); // 第一页写完租约后"关掉了"（不再心跳）
  const second = makeEnv(g);
  assert.equal(second.appState, "blocked");
  // 时间前进到租约过期之后
  g.clock.now = NOW0 + 7000;
  second.tickPoll();
  assert.equal(second.state.reloads, 1, "租约过期后必须自动重载接管");
  assert.ok(second.storeGet("dsh-remote-mirror-page:dev-A:takeover"), "重载前要留 takeover 标记（避免重载后又被自己挡住）");
});

test("⑤ 活跃页 pagehide 时释放租约；bfcache 回来（pageshow persisted）重新判定", () => {
  const g = makeGroup();
  const a = makeEnv(g);
  assert.ok(a.lease());
  a.dispatchWindow("pagehide");
  assert.equal(a.lease(), null, "pagehide 必须释放租约");
  assert.equal(a.appState, "inactive", "pagehide 后不再是活跃页");
  // bfcache 回来：租约已释放 → 重新判定后重新成为活跃页
  a.dispatchWindow("pageshow", { persisted: true });
  assert.equal(a.appState, "active", "bfcache 恢复后必须重新判定并接管");
  assert.ok(a.lease(), "恢复后要重新写租约");
  // 另一个页面此刻打开 → 它看到租约并被按住（不会两个页面并发加载）
  const b = makeEnv(g);
  assert.equal(b.appState, "blocked");
});

test("⑥ 非镜像页 / 老浏览器 → 零行为（绝不把唯一页面锁死）", () => {
  // /app/ 设备列表页不参与单页约束
  const g1 = makeGroup();
  const app = makeEnv(g1, { pathname: "/app/" });
  assert.equal(app.appState, "", "非镜像页不得介入");
  assert.equal(g1.store.size, 0, "非镜像页不得写任何 localStorage");
  assert.equal(app.doc._appended.length, 0, "非镜像页不得往页面塞任何节点");

  // 没有 BroadcastChannel（部分老浏览器/隐私模式）→ 不启用
  const g2 = makeGroup();
  const noBc = makeEnv(g2, { withBC: false });
  assert.equal(noBc.appState, "", "没有 BroadcastChannel 时不得启用（不锁）");
  assert.equal(g2.store.size, 0);
  assert.equal(noBc.doc._appended.length, 0);

  // 没有 localStorage → 不启用
  const g3 = makeGroup();
  const noLs = makeEnv(g3, { withStorage: false });
  assert.equal(noLs.appState, "", "没有 localStorage 时不得启用");
  assert.equal(noLs.doc._appended.length, 0);
});

test("⑦ 同一时刻两个页面都从空租约启动（并发竞态）→ 后到的看到租约后被按住", () => {
  const g = makeGroup();
  // 用同一份 group 串行模拟"几乎同时"：第一个先写入租约（JS 单线程，真实世界也是先到先得）
  const a = makeEnv(g);
  const b = makeEnv(g);
  assert.equal(a.appState, "active");
  assert.equal(b.appState, "blocked");
  // 两个页面不会互相写坏租约
  assert.equal(a.lease().id, b.lease().id, "租约归属第 1 页，第 2 页不覆盖");
});

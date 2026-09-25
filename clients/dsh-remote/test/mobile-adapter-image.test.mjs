#!/usr/bin/env node
/**
 * mobile-adapter **图片上传兼容**契约测试（假 DOM + vm 执行真实注入脚本）。
 *
 * 业主反馈（2026-09）：「手机端无法识别图片」——选了照片发出去，模型看不到图 / 被当成普通文件。
 *
 * 根因（官方 dsh web 客户端 `dsh-client-ui-conversation` 的 createDrafts）：
 *   只有 `file.type ∈ {image/png,image/jpeg,image/webp,image/gif}` 才走**图片**通道
 *   （本地编码随 prompt 发出 → 模型真能"看"）；其余一律当**普通文件**（后台上传 + 一个文件引用）。
 * 手机恰恰最容易给出非白名单类型：iPhone「高效」格式 = `image/heic`；部分 Android = 空 type。
 *
 * 本用例拿 injectMobileAdapter() 注入的**真实脚本**在假 DOM 里跑，断言运行时行为：
 *   ① HEIC → 转成 JPEG 后再交给官方（官方收到的是 image/jpeg，而不是 heic）；
 *   ② 空 type + `.png` 扩展名 → **无损**改 MIME（不重编码）；
 *   ③ 官方认得的类型 → 一根手指都不动（零行为）；
 *   ④ 任何失败（解码失败 / DataTransfer 不可用）→ **原样重新派发**，文件绝不丢。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

function adapterScript() {
  const { html } = injectMobileAdapter("<!doctype html><html><head></head><body></body></html>");
  const m = /<script id="[^"]*-js"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "应能取出注入脚本");
  return m[1];
}

// ── 极简假 DOM：只实现图片兼容这条路径真正用到的东西 ──────────────────────────
class FakeFile {
  constructor(parts, name, opts = {}) {
    this._blob = { parts: parts.map((p) => String(p)) };
    this.name = name;
    this.type = opts.type || "";
    this.size = this._blob.parts.join("").length;
    this.lastModified = opts.lastModified || 1;
  }
  slice(_a, _b, mime) {
    const f = new FakeBlob(this._blob.parts, mime || this.type);
    f.name = this.name;
    return f;
  }
}
class FakeBlob {
  constructor(parts, type) { this._parts = parts; this.type = type || ""; this.size = parts.join("").length; this.name = ""; }
  slice(_a, _b, mime) { const b = new FakeBlob(this._parts, mime || this.type); b.name = this.name; return b; }
}
class FakeInput {
  constructor() {
    this.tagName = "INPUT";
    this.type = "file";
    this.files = [];
    this._listeners = new Map();
    this._attrs = {};
  }
  getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; }
  setAttribute(n, v) { this._attrs[n] = String(v); }
  addEventListener(t, fn) { if (!this._listeners.has(t)) this._listeners.set(t, []); this._listeners.get(t).push(fn); }
  removeEventListener() {}
  // 真实 DOM 里 dispatchEvent 会再走一遍 document 捕获监听 —— 那次会被 MA_REENTRY 提前返回，
  // 所以这里只跑本元素上的监听即可（语义等价）。
  dispatchEvent(ev) {
    ev.target = this;
    for (const fn of this._listeners.get(ev.type) || []) fn(ev);
    return true;
  }
}
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this._stopped = false;
    this._prevented = false;
    this.target = null;
  }
  stopPropagation() { this._stopped = true; }
  preventDefault() { this._prevented = true; }
}

/**
 * 最小事件派发模型：document（捕获）→ target（冒泡）。
 * capture 阶段 stopPropagation 后，**target 上的监听不再收到** —— 这正是 React 根容器监听
 * （挂在 document 之下的容器上）会因此被拦住的机制，也是本方案能生效的前提。
 */
function fireChange(env, input) {
  const ev = new FakeEvent("change", { bubbles: true });
  ev.target = input;
  for (const fn of env.docListeners.capture) fn(ev);
  if (ev._stopped) return ev;
  for (const fn of input._listeners.get("change") || []) fn(ev);
  return ev;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv({ decodeHeic = true, hasDataTransfer = true, frame = null } = {}) {
  const docListeners = { capture: [], bubble: [] };
  const input = new FakeInput();
  const created = { canvases: 0, blobs: 0, objectUrls: 0, revoked: 0 };

  const doc = {
    documentElement: { outerHTML: "<html><head><title>DeepSeek Harness</title><script>window.__ModuleLoader__=1</script></head><body></body></html>" },
    body: { appendChild() {}, querySelector: () => null, classList: { add() {}, remove() {} } },
    readyState: "complete",
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "object" ? !!opts.capture : opts === true;
      (capture ? docListeners.capture : docListeners.bubble).push(fn);
    },
    removeEventListener() {},
    querySelector: () => frame,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement(tag) {
      if (String(tag).toLowerCase() !== "canvas") return { style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} } };
      created.canvases += 1;
      const cv = {
        width: 0,
        height: 0,
        style: {},
        getContext: () => ({ drawImage() {} }),
        toBlob(cb, mime) {
          created.blobs += 1;
          cb(new FakeBlob(["jpeg-bytes"], mime || "image/jpeg"));
        }
      };
      return cv;
    },
    createTextNode: (t) => ({ nodeValue: t })
  };

  class FakeImage {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; }
    set src(v) {
      this._src = v;
      // HEIC 在部分浏览器上解不了；这里用开关模拟"解码成功/失败"
      setTimeout(() => {
        if (decodeHeic) { this.naturalWidth = 4032; this.naturalHeight = 3024; this.onload && this.onload(); }
        else { this.onerror && this.onerror(); }
      }, 0);
    }
    get src() { return this._src; }
  }

  const timers = new Set();
  const win = {
    innerWidth: 390,
    innerHeight: 800,
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    // unref：适配层自带 8s/30s/4min 的兜底计时器（首屏提示、看门狗），不 unref 会把测试进程吊住。
    // 用例里的 await wait(...) 用的是宿主定时器（未 unref），足够让这些 vm 内定时器在该跑的时候跑到。
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); try { id.unref?.(); } catch (e) { /* 忽略 */ } timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    location: { href: "https://n.risegao.cn:13443/remote/dev-x/", host: "n.risegao.cn", pathname: "/remote/dev-x/", origin: "https://n.risegao.cn:13443" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    console,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame,
    navigator: { userAgent: "iPhone Safari", maxTouchPoints: 5, platform: "iPhone" },
    location: win.location,
    localStorage: win.localStorage,
    URL: {
      createObjectURL() { created.objectUrls += 1; return "blob:fake/" + created.objectUrls; },
      revokeObjectURL() { created.revoked += 1; }
    },
    Image: FakeImage,
    File: FakeFile,
    Blob: FakeBlob,
    Event: FakeEvent,
    Date, Math, JSON, Object, Array, String, Number, RegExp, Boolean, Promise, Error,
    isNaN, parseInt, parseFloat
  });
  if (hasDataTransfer) {
    ctx.DataTransfer = class {
      constructor() { this.items = { _f: [], add(f) { this._f.push(f); } }; }
      get files() { return this.items._f; }
    };
  }
  ctx.globalThis = ctx;
  return { ctx, input, docListeners, created };
}

function runAdapter(env) {
  vm.runInContext(adapterScript(), env.ctx, { filename: "mobile-adapter.js" });
}

// ─────────────────────────── 用例 ───────────────────────────

test("★ iPhone HEIC 照片 → 转成 JPEG 后再交给官方（否则会被当成普通文件，模型看不到）", async () => {
  const env = makeEnv();
  runAdapter(env);

  // 官方监听（模拟 React 根容器/输入框上的 change 处理）
  const official = [];
  env.input.addEventListener("change", (e) => { official.push(Array.prototype.slice.call(e.target.files)); });

  const heic = new FakeFile(["heic-bytes"], "IMG_0001.HEIC", { type: "image/heic" });
  env.input.files = [heic];
  fireChange(env, env.input); // 第一次：被适配层拦下（官方收不到）
  assert.equal(official.length, 0, "★ 必须先把这次事件拦下来，不能让官方按普通文件先收走");

  await wait(30); // 等 canvas 转码完成 + 重新派发

  assert.equal(official.length, 1, "转码完成后必须重新派发一次 change");
  const got = official[0];
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "image/jpeg", "★ 交给官方的必须是白名单里的 image/jpeg");
  assert.equal(got[0].name, "IMG_0001.jpg", "文件名也要跟着换成 .jpg（面板/模型看到的名字才一致）");
  assert.equal(env.created.canvases, 1, "HEIC 必须走 canvas 转码");
});

test("★ Android 空 type + .png → **无损**改 MIME（不重编码，不丢透明通道）", async () => {
  // Android 图库经文件提供器给出的 file.type 常常是空串；字节本身是标准 PNG。
  // 这种情况走 canvas 重编码纯属浪费（还会把透明通道压成黑底），只改 MIME 就够了。
  const env = makeEnv();
  runAdapter(env);
  const official = [];
  env.input.addEventListener("change", (e) => { official.push(Array.prototype.slice.call(e.target.files)); });

  const png = new FakeFile(["png-bytes"], "screenshot.png", { type: "" });
  env.input.files = [png];
  fireChange(env, env.input);
  await wait(30);

  assert.equal(official.length, 1);
  assert.equal(official[0][0].type, "image/png", "★ 空 type 的 PNG 必须被改写成 image/png");
  assert.equal(env.created.canvases, 0, "★ 不得重编码（无损路径不该碰 canvas）");
  assert.equal(env.created.blobs, 0);
});

test("★ 官方认得的类型（image/jpeg）→ 零行为：不拦、不转、不重派发", async () => {
  const env = makeEnv();
  runAdapter(env);
  const official = [];
  env.input.addEventListener("change", (e) => { official.push(Array.prototype.slice.call(e.target.files)); });

  const jpg = new FakeFile(["jpg-bytes"], "photo.jpg", { type: "image/jpeg" });
  env.input.files = [jpg];
  fireChange(env, env.input);
  await wait(20);

  assert.equal(official.length, 1, "官方应当**当场**收到事件（我们没有拦）");
  assert.equal(official[0][0], jpg, "原文件对象必须是同一个（一个字节都没动）");
  assert.equal(env.created.canvases, 0);
  assert.equal(env.created.objectUrls, 0);
});

test("★ 解码失败（浏览器读不了 HEIC）→ 原样重新派发，文件绝不丢", async () => {
  const env = makeEnv({ decodeHeic: false });
  runAdapter(env);
  const official = [];
  env.input.addEventListener("change", (e) => { official.push(Array.prototype.slice.call(e.target.files)); });

  const heic = new FakeFile(["heic-bytes"], "IMG_2.HEIC", { type: "image/heic" });
  env.input.files = [heic];
  fireChange(env, env.input);
  await wait(40);

  assert.equal(official.length, 1, "转不了也必须把这次选择交回官方（否则用户会觉得「选了没反应」）");
  assert.equal(official[0][0].name, "IMG_2.HEIC", "交回去的是**原文件**（宁可当普通文件，也不能丢）");
});

test("★ DataTransfer 不可用（老浏览器）→ 原样重新派发，不吞事件", async () => {
  const env = makeEnv({ hasDataTransfer: false });
  runAdapter(env);
  const official = [];
  env.input.addEventListener("change", (e) => { official.push(Array.prototype.slice.call(e.target.files)); });

  const heic = new FakeFile(["heic-bytes"], "IMG_3.HEIC", { type: "image/heic" });
  env.input.files = [heic];
  fireChange(env, env.input);
  await wait(40);

  assert.equal(official.length, 1, "塞不回 input.files 时必须原样重发");
  assert.equal(official[0][0].name, "IMG_3.HEIC");
});

test("★ 混合选择：只动需要动的那个，其余原样（顺序也不许乱）", async () => {
  const env = makeEnv();
  runAdapter(env);
  const official = [];
  env.input.addEventListener("change", (e) => { official.push(Array.prototype.slice.call(e.target.files)); });

  const jpg = new FakeFile(["a"], "a.jpg", { type: "image/jpeg" });
  const heic = new FakeFile(["b"], "b.heic", { type: "image/heic" });
  const pdf = new FakeFile(["c"], "c.pdf", { type: "application/pdf" });
  env.input.files = [jpg, heic, pdf];
  fireChange(env, env.input);
  await wait(40);

  assert.equal(official.length, 1);
  const got = official[0];
  assert.equal(got.length, 3, "文件数量必须保持 3");
  assert.equal(got[0], jpg, "官方认得的原样保留（同一对象）");
  assert.equal(got[1].type, "image/jpeg", "HEIC 被转成 JPEG");
  assert.equal(got[1].name, "b.jpg");
  assert.equal(got[2], pdf, "非图片原样保留");
});

test("接线守卫：图片兼容必须真的被装上，且走**捕获阶段**（否则拦不住 React 根容器）", () => {
  const src = adapterScript();
  assert.match(src, /maInstallImageCompat\(\);/, "必须在主流程里调用（定义了不调用等于没做）");
  const i = src.indexOf('document.addEventListener("change"');
  assert.ok(i > 0, "找不到 change 监听");
  const tail = src.slice(i, i + 2000);
  assert.ok(/\},\s*true\s*\)\s*;/.test(tail),
    "★ 必须注册在捕获阶段（第三个参数 true）：React 根容器的 change 监听在 document 之下，冒泡阶段拦不住它");
  assert.match(src, /MA_REENTRY/, "必须有重入标记（否则自己派发的 change 会再被自己拦一次，死循环）");
});

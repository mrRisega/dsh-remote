#!/usr/bin/env node
/**
 * 上传失败「可读提示」（2026-10-23，文件上传反馈 fb_930b950aed94）。
 *
 * 现场：手机上传失败只看到「上传失败，点击重试」。dsh 上游客户端在 status !== 200 时
 * 直接抛错并**丢弃响应体**（dsh-client-file-upload/lib/client.js），而中继/桥端本轮
 * 已能给出可读原因（>64MB 的 413 JSON、上游不可达的分类 502 JSON）—— 这些文字到不了用户。
 *
 * 本用例跑**真实注入脚本里的上传提示层**（纯函数 + 引擎在 vm 里执行，不是文本 grep）：
 *   ① 状态码 → 人话的映射（413/502/401/带 JSON body 的其它 5xx/成功不提示）；
 *   ② 只接管 name=dsh-file-upload 的 Worker，其它 Worker 原样返回；
 *   ③ 完成消息 status!==200 时弹出底部提示，status===200 时不弹；
 *   ④ dsh 原有 onmessage 仍被**原样调用**（本层只旁听，绝不改变上传语义）；
 *   ⑤ terminate() 等成员仍绑定原生对象；重复安装幂等；boot 与看门狗都接线。
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

function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a !== -1, `找不到起始锚点: ${from}`);
  assert.ok(b !== -1 && b > a, `找不到结束锚点: ${to}`);
  return src.slice(a, b);
}

const SRC = adapterScript();
const PURE_SRC = sliceBetween(SRC, "/* ===DSH-MA-UPLOAD-HINT-PURE-START=== */", "/* ===DSH-MA-UPLOAD-HINT-PURE-END=== */");
const ENGINE_SRC = sliceBetween(SRC, "/* ===DSH-MA-UPLOAD-HINT-ENGINE-START=== */", "/* ===DSH-MA-UPLOAD-HINT-ENGINE-END=== */");

/** 造一个假 DOM + 假 sessionStorage + 假 Worker，把纯函数与引擎一起跑起来。 */
function makeSandbox() {
  const toasts = [];
  const workers = [];
  class FakeWorker {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts || {};
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      workers.push(this);
    }
    terminate() { this.terminated = true; }
    postMessage() { /* noop */ }
  }
  const makeEl = () => ({
    id: "", textContent: "", style: { cssText: "", opacity: "" },
    parentNode: null,
    setAttribute(k, v) { if (k === "id") this.id = String(v); },
    appendChild(child) { toasts.push(child); child.parentNode = this; },
    removeChild(child) { child.parentNode = null; }
  });
  const bodyEl = makeEl();
  const doc = {
    body: bodyEl,
    documentElement: bodyEl,
    getElementById: (id) => toasts.find((t) => t.id === id) || null,
    createElement: () => makeEl()
  };
  const store = new Map();
  const sandbox = {
    window: { Worker: FakeWorker },
    document: doc,
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    setTimeout: () => 0, // 不让提示自动消失，便于断言
    clearTimeout: () => {},
    console,
    Date, JSON, String, Number, RegExp, Proxy, Reflect, Error, Math
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    PURE_SRC + "\n" + ENGINE_SRC
      + "\n; ({ maUploadFailureHint, maUploadToast, maTapUploadWorker, maInstallUploadTap });",
    ctx,
    { filename: "mobile-adapter#upload-hint" }
  );
  const api = vm.runInContext("({ maUploadFailureHint, maInstallUploadTap })", ctx);
  return { api, sandbox, ctx, workers, toasts, store };
}

test("状态码/响应体 → 人话（413/502/401/其它 JSON/成功）", () => {
  const { api } = makeSandbox();
  const h = api.maUploadFailureHint;
  assert.match(h(413, ""), /64MB/, "413 必须说清 64MB 上限");
  assert.match(h(413, ""), /电脑端|压缩/, "413 要给出可执行的下一步");
  assert.match(h(502, ""), /连接中断/, "502 要说明是连接中断");
  assert.match(h(504, ""), /连接中断/, "504 同样按连接中断");
  assert.match(h(401, ""), /登录状态已过期/, "401 指向重新登录");
  assert.match(h(403, ""), /登录状态已过期/, "403 同 401");
  assert.equal(h(200, ""), "", "成功不提示");
  assert.equal(h(201, ""), "", "201 也不提示");
  assert.equal(h(0, ""), "", "没有状态码不提示");
  const custom = h(500, JSON.stringify({ error: { code: "upstream_timeout", message: "本机 dsh web 在 120 秒内没有响应" } }));
  assert.match(custom, /本机 dsh web 在 120 秒内没有响应/, "其它 5xx 要透出服务端 message");
  assert.match(h(500, "not-json"), /HTTP 500/, "非 JSON body 也要给状态码");
  assert.match(h(413, "file exceeds byte limit"), /64MB/, "上游 dsh 的字节上限文案也要归类为「太大」");
});

test("只接管 name=dsh-file-upload 的 Worker；其它 Worker 原样返回", () => {
  const { api, sandbox, workers } = makeSandbox();
  assert.equal(api.maInstallUploadTap(), true, "装着成功");
  const Native = sandbox.window.Worker;
  const other = new sandbox.window.Worker("blob:x", { name: "some-other-worker" });
  const plain = new sandbox.window.Worker("blob:y");
  assert.equal(workers.length, 2, "两个 Worker 都真的构造了");
  assert.ok(other instanceof Native, "非上传 Worker 仍是原生实例");
  assert.ok(plain instanceof Native, "无名 Worker 仍是原生实例");
  const up = new sandbox.window.Worker("blob:z", { name: "dsh-file-upload" });
  assert.equal(up.url, "blob:z", "url 透传");
  assert.equal(typeof up.postMessage, "function", "postMessage 透传");
  up.terminate();
  assert.equal(workers[2].terminated, true, "terminate 绑定到原生对象后真的生效");
});

test("完成消息 status!==200 → 弹可读提示；status===200 / progress → 不弹", () => {
  const { sandbox, ctx, workers, toasts } = makeSandbox();
  vm.runInContext("maInstallUploadTap();", ctx);
  const up = new sandbox.window.Worker("blob:upload", { name: "dsh-file-upload" });
  const raw = workers[workers.length - 1];
  const seen = [];
  up.onmessage = (ev) => seen.push(ev.data);
  raw.onmessage({ data: { kind: "complete", status: 200, body: "{\"ok\":true}" } });
  assert.equal(seen.length, 1, "dsh 的 onmessage 必须照常收到消息");
  assert.equal(toasts.length, 0, "200 不弹提示");
  raw.onmessage({ data: { kind: "complete", status: 413, body: "{\"error\":{\"code\":\"payload_too_large\"}}" } });
  assert.equal(seen.length, 2, "dsh 的 onmessage 仍照常收到消息");
  assert.equal(toasts.length, 1, "413 应弹一条提示");
  assert.equal(toasts[0].id, "dsh-ma-upload-toast");
  assert.match(String(toasts[0].textContent), /64MB/, "提示文案要说清 64MB 上限");
  raw.onmessage({ data: { kind: "progress", loaded: 10 } });
  assert.equal(toasts.length, 1, "progress 不弹提示");
});

test("重复安装幂等；boot 与看门狗都接线（源码契约）", () => {
  const { api, sandbox } = makeSandbox();
  assert.equal(api.maInstallUploadTap(), true);
  const first = sandbox.window.Worker;
  assert.equal(api.maInstallUploadTap(), true, "第二次安装仍返回 true");
  assert.equal(sandbox.window.Worker, first, "不得二次包装（否则消息会被旁听两遍）");
  const calls = SRC.match(/maInstallUploadTap\(\)/g) || [];
  assert.ok(calls.length >= 2, `boot 与看门狗都要接线（实际 ${calls.length} 处）`);
  assert.match(SRC, /name !== "dsh-file-upload"/, "只认 dsh 的上传 Worker 名字");
});

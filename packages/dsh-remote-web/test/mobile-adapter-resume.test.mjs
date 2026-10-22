#!/usr/bin/env node
/**
 * 镜像页 E2EE 死会话自动恢复（插件半 / test:plugin 覆盖，2026-10-23）。
 *
 * 完整的行为级用例在 `clients/dsh-remote/test/mobile-adapter-resume.test.mjs`（test:bridge）；
 * 这里是**插件包这一侧**的等价回归：同一个注入体在 `npm run test:plugin` 里也要被跑一遍，
 * 否则"插件发版前只跑 plugin 套件"时会漏掉这条链路（AGENTS 的发版门禁就是跑这两套）。
 *
 * 覆盖：① 设备 id 解析与"是否该恢复"纯函数；② 死会话真的会跳 /app/?resume=…&from=mirror，
 * 纯明文绝不跳；③ 闸门参数与注入体纪律（无反引号、不自己加解密/重连）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { injectMobileAdapter } from "../../../clients/dsh-remote/mobile-adapter.mjs";

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
const PURE_SRC = sliceBetween(SRC, "/* ===DSH-MA-RESUME-PURE-START=== */", "/* ===DSH-MA-RESUME-PURE-END=== */");
const ENGINE_SRC = sliceBetween(SRC, "/* ===DSH-MA-RESUME-ENGINE-START=== */", "/* ===DSH-MA-RESUME-ENGINE-END=== */");

test("设备 id 解析:只认 /remote/<id>/,非法输入一律空串(不拼进跳转地址)", () => {
  const { maDeviceIdOfMirrorPath } = vm.runInNewContext(
    PURE_SRC + "\n; ({ maDeviceIdOfMirrorPath, maE2eeResumeDecision })", {}, { filename: "plugin#resume-pure" }
  );
  assert.equal(maDeviceIdOfMirrorPath("/remote/dev-1b8cc3ac183b/"), "dev-1b8cc3ac183b");
  assert.equal(maDeviceIdOfMirrorPath("/app/"), "");
  assert.equal(maDeviceIdOfMirrorPath("/remote/..%2Fadmin"), "");
  assert.equal(maDeviceIdOfMirrorPath(""), "");
});

test("是否需要恢复:死会话才恢复;明文/未解锁默认不动(用户可能选了「暂不加密」)", () => {
  const { maE2eeResumeDecision } = vm.runInNewContext(
    PURE_SRC + "\n; ({ maDeviceIdOfMirrorPath, maE2eeResumeDecision })", {}, { filename: "plugin#resume-pure" }
  );
  const now = 1_700_000_000_000;
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "加密会话已失效，需要重新解锁" }, { now }), "dead_session");
  assert.equal(maE2eeResumeDecision({ mode: "ok", text: "端到端加密已开启" }, { now }), "");
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "未加密:未解锁(明文)" }, { now }), "");
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "未加密:交接单无效" }, { now }), "");
  // 唯一例外：死会话重载 + 本机有 MK
  assert.equal(maE2eeResumeDecision(
    { mode: "warn", text: "未加密:未解锁(明文)" },
    { mk: true, deadReloadAt: now - 1_000, now }
  ), "plaintext_after_dead");
});

/** 最小假环境：只够跑恢复层（它只读 window/document/存储，写 location）。 */
function loadEngine(pathname) {
  const nav = [];
  const listeners = { document: {}, window: {} };
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const win = {
    location: { pathname, replace: (u) => nav.push(String(u)), assign: (u) => nav.push(String(u)) },
    localStorage: store(),
    sessionStorage: store(),
    addEventListener: (t, f) => { (listeners.window[t] = listeners.window[t] || []).push(f); },
    dispatchEvent: () => true,
    fetch: () => Promise.resolve({ status: 200 })
  };
  const doc = { visibilityState: "visible", addEventListener: (t, f) => { (listeners.document[t] = listeners.document[t] || []).push(f); } };
  const timers = [];
  const sandbox = {
    window: win, document: doc,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    maPublishDiag: () => {},
    maLoadWatch: { dismissed: false, slow: false, barEl: null, barTxt: null },
    maLoadMountBar: () => ({ hidden: true }),
    maLoadHideBar: () => {},
    Date: { now: () => 1_700_000_000_000 },
    Promise, JSON, Number, String, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Event: class { constructor(type) { this.type = type; } }
  };
  vm.runInContext(ENGINE_SRC + "\n;void 0", vm.createContext(sandbox), { filename: "plugin#resume-engine" });
  return {
    nav,
    win,
    fire: (type) => { for (const fn of (listeners.document[type] || []).slice()) fn({ type, persisted: true }); },
    runTimers: () => { while (timers.length) { try { timers.shift()(); } catch { /* 忽略 */ } } }
  };
}

test("死会话 → location.replace 到 /app/?resume=<id>&from=mirror;明文不跳", () => {
  const e = loadEngine("/remote/dev-1b8cc3ac183b/");
  e.win.__dshE2eeBadge = { state: () => ({ mode: "warn", text: "加密会话已失效，需要重新解锁" }) };
  e.fire("dsh-e2ee-badge");
  e.runTimers();
  assert.deepEqual(e.nav, ["/app/?resume=dev-1b8cc3ac183b&from=mirror"]);

  const e2 = loadEngine("/remote/dev-1b8cc3ac183b/");
  e2.win.__dshE2eeBadge = { state: () => ({ mode: "warn", text: "未加密:未解锁(明文)" }) };
  e2.fire("dsh-e2ee-badge");
  e2.runTimers();
  assert.deepEqual(e2.nav, [], "纯明文不得把用户弹回设备列表");
});

test("注入体纪律:恢复层无反引号、不自己加解密/重连,闸门参数与 native.html 同量级", () => {
  assert.ok(ENGINE_SRC.indexOf("`") === -1, "注入体里的反引号会提前闭合模板字符串");
  assert.ok(ENGINE_SRC.indexOf("</script") === -1);
  assert.ok(!/crypto\.subtle|deriveKey|decrypt\(/i.test(ENGINE_SRC), "恢复层不做加解密(属于 e2ee-shim)");
  assert.ok(!/new WebSocket/i.test(ENGINE_SRC), "恢复层不自己重连 WS");
  assert.ok(/MA_RESUME_MAX_IN_WINDOW = 2/.test(ENGINE_SRC), "60 秒窗口内最多 2 次");
  assert.ok(/MA_RESUME_WINDOW_MS = 60 \* 1000/.test(ENGINE_SRC));
  assert.ok(/from=mirror/.test(ENGINE_SRC), "跳转必须带 from=mirror,便于 /app/ 侧识别来源");
});

#!/usr/bin/env node
/**
 * e2ee-shim-script.js —— **死会话自愈**回归（2026-10-20 群故障诊断 C3）。
 *
 * 现场（03-加载卡住与打不开.md §2.4 D1，P0）：
 *   dev-08b73ba9de67 单设备一天 nginx **009（e2ee_session_locked 拒握手）8997 次**，
 *   同时 4064 个 HTTP 200 —— 页面能打开，实时通道永远连不上。
 *   根因是代码缺陷：桥端回 `x-dsh-e2ee-error: unknown_session` 时，shim 只清了
 *   **storage** 里的交接单，**从不把内存里的 `_ctx.sess` 置空**（全文只有 `_install()` 一处赋值）。
 *   于是这一个页面的后续每一个 HTTP/WS 继续带死 sessId，WS 被 1008 无限拒、HTTP 全 502，
 *   刷新也只是一次次把同一张死票装回来。
 *
 * 本文件锁死 C3 契约（用**真实抽取**的核心代码，不是测试里另抄一份）：
 *   ① 收到 unknown_session → 内存会话被置空（下一次 WS 不再带 &e2ee=，HTTP 回落到明文透传）；
 *   ② 连续 ≥3 次 WS 握手失败且有会话 → 清交接单 + 清内存会话（徽标文案见脚本接线断言）；
 *   ③ 连续计数在握手成功后清零（偶发单次失败不得误清会话）；
 *   ④ 「每页最多一次」受控 reload 的闸门真的只放行一次（防 reload 风暴）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractShimCore, readShimScript, SHIM_EXPORTS } from "./lib-e2ee-shim.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIM_SCRIPT = path.join(THIS_DIR, "..", "e2ee-shim-script.js");

/**
 * 抽取核心区间并额外暴露 C3 相关内部名字。
 * 为什么不改 lib-e2ee-shim.mjs 的 SHIM_EXPORTS：那是其它 6 个用例文件共用的共享辅助，
 * 本文件的导出清单只为自己服务，独立出来不会给既有用例带来任何风险。
 */
const SELFHEAL_EXPORTS = [
  ...SHIM_EXPORTS,
  "seNoteE2eeError", "seE2eeErrorOf", "seForgetHandoverStores", "seStaleSessionHook", "seLastStaleCode",
  "seNoteWsHandshakeFail", "seNoteWsOpened", "seWsFailHook", "seWsFailCount", "seWsFailStreak",
  "SE_WS_FAIL_INVALIDATE", "seReloadOnceForDeadSession", "SE_RELOAD_GUARD_KEY",
];
const coreSrc = extractShimCore() + "\nexport { " + SELFHEAL_EXPORTS.join(", ") + " };\n";
const shim = await import("data:text/javascript;base64," + Buffer.from(coreSrc, "utf8").toString("base64"));

const SESS_ID = "a".repeat(32);

// ── 测试替身：storage / location（函数体里按名字读全局，用法和浏览器一致） ────────────────
class FakeStore {
  constructor() { this.m = new Map(); this.removes = []; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.removes.push(k); this.m.delete(k); }
}
const HANDOVER_KEY = "dsh-e2ee-handover"; // DSH_E2EE_HANDOVER_KEY（shim 常量）

/** 造一张"本机记住"的交接单；在测 storage 清理时用。 */
function seedStores() {
  const ss = new FakeStore();
  const ls = new FakeStore();
  ss.setItem(HANDOVER_KEY, "{\"v\":2}");
  ls.setItem(HANDOVER_KEY, "{\"v\":2}");
  return { ss, ls };
}
/** 只活在本「用例」里的全局替身：用完即撤，绝不泄漏到其它用例。 */
function withGlobals(fn) {
  const saves = {
    ss: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
    ls: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    loc: Object.getOwnPropertyDescriptor(globalThis, "location"),
  };
  try { return fn(); } finally {
    for (const [k, d] of [["sessionStorage", saves.ss], ["localStorage", saves.ls], ["location", saves.loc]]) {
      try { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } catch { /* ignore */ }
    }
  }
}
function installStores(ss, ls) {
  Object.defineProperty(globalThis, "sessionStorage", { value: ss, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
}

/** 假原生 WebSocket：只记录 URL，暴露 onopen/onerror/onclose 供用例手工触发。 */
class FakeNativeWS {
  constructor(url, protocols) { this.url = String(url); this.protocols = protocols; this.sent = []; }
  send(d) { this.sent.push(d); }
  close() {}
}

/** 假桥端错误响应：只需要 headers.get('x-dsh-e2ee-error')。 */
function e2eeErrorResponse(code) {
  return { status: 502, headers: { get: (n) => (String(n).toLowerCase() === "x-dsh-e2ee-error" ? code : null) } };
}

/** 直接挂一个数据 WS（绕过 URL 策略），用于驱动 SeE2eeWs 的握手失败回调。 */
function openDataWs(ctx) {
  return new shim.SeE2eeWs(FakeNativeWS, "ws://relay.local/remote/dev-x/api/remote.mux", null,
    { sess: ctx.sess, wsLabel: "w=deadbeef;e2ee=" + SESS_ID, ctx });
}

// ══════════════════════════════════════════════════════════════════════════════
// ① unknown_session → 内存会话必须置空（C3 主修：这是旧实现漏掉的那一步）
// ══════════════════════════════════════════════════════════════════════════════

test("★ unknown_session：内存 ctx.sess 被置空，且 storage 里的交接单被清掉", () => {
  withGlobals(() => {
    const { ss, ls } = seedStores();
    installStores(ss, ls);
    const ctx = { sess: { sessId: SESS_ID }, origin: "http://relay.local", deviceId: "" };
    const code = shim.seNoteE2eeError(e2eeErrorResponse("unknown_session"), ctx);
    assert.equal(code, "unknown_session");
    assert.equal(ctx.sess, null,
      "🔴 只清 storage 不清内存 = 本页后续每个 HTTP/WS 继续带死 sessId（dev-08b73ba9de67 一天 8997 次 009 的来源）");
    assert.ok(ss.removes.includes(HANDOVER_KEY) && ls.removes.includes(HANDOVER_KEY),
      "sessionStorage/localStorage 两份交接单都必须清（否则刷新又把死票装回来）");
  });
});

test("★ unknown_session 之后：同一页面新建的 WS 不再带 &e2ee=（回落明文，不再无限被 1008 拒）", () => {
  const ctx = { sess: { sessId: SESS_ID }, origin: "http://relay.local", deviceId: "dev-8e5fb209cdc8" };
  const patched = shim.seMakeWsCtor(FakeNativeWS, ctx);
  const before = patched("http://relay.local/api/remote.mux");
  assert.ok(before instanceof shim.SeE2eeWs, "前提：有会话时 mux WS 必须被加密接管");
  assert.match(before._inner.url, /e2ee=/, "前提：加密接管会追加 e2ee 参数");

  // 桥端说不认识这个会话（本用例不依赖 storage：清存储是"下次进页面"，清内存是"这一页"）
  assert.equal(shim.seNoteE2eeError(e2eeErrorResponse("unknown_session"), ctx), "unknown_session");
  const after = patched("http://relay.local/api/remote.mux");
  assert.ok(after instanceof FakeNativeWS, "会话清掉后必须回落原生 WS（明文）");
  assert.equal(after.url.includes("e2ee="), false, "★ 下一次 WS 绝不能再带 dead sessId");
  assert.equal(after.url, "http://relay.local/remote/dev-8e5fb209cdc8/api/remote.mux",
    "明文回落仍要保留设备作用域改写（那是 2026-09-26 的另一条修复，不能回退）");
});

test("unknown_session 之后 HTTP 包装退化为原样透传（不再给死会话打信封）", async () => {
  const ctx = { sess: { sessId: SESS_ID }, origin: "http://relay.local", deviceId: "" };
  const seen = [];
  const origFetch = (input, init) => { seen.push({ input: String(input), init }); return Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }); };
  shim.seNoteE2eeError(e2eeErrorResponse("unknown_session"), ctx);
  const res = await shim.seFetchWrapper(origFetch, ctx, "http://relay.local/api/session/list", { method: "GET" });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, "GET", "无会话 → 原样透传（旧行为：POST 信封打给死会话）");
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 连续 3 次 WS 握手失败 → 清交接单 + 清内存会话
// ══════════════════════════════════════════════════════════════════════════════

test("★ 连续 3 次 WS 握手失败且有会话 → 清交接单 + 清内存会话（C3 第 2 条）", () => {
  shim.seNoteWsOpened(); // 模块级连续计数是"一个页面"的语义，用例之间手工复位（等价于"上一次握手成功"）
  withGlobals(() => {
    const { ss, ls } = seedStores();
    installStores(ss, ls);
    const ctx = { sess: { sessId: SESS_ID }, origin: "http://relay.local", deviceId: "" };
    assert.equal(shim.SE_WS_FAIL_INVALIDATE, 3, "阈值常量必须是 3（测试按常量断言，不散落魔法数）");

    const ws1 = openDataWs(ctx); ws1._inner.onerror({ type: "error" });
    const ws2 = openDataWs(ctx); ws2._inner.onerror({ type: "error" });
    assert.notEqual(ctx.sess, null, "失败 2 次还不能判死会话（偶发断网不该清掉加密）");
    assert.equal(ss.removes.includes(HANDOVER_KEY), false, "同理 2 次时不得清交接单");

    const ws3 = openDataWs(ctx); ws3._inner.onclose({ type: "close", code: 1008 });
    assert.equal(ctx.sess, null, "★ 连续 3 次握手失败 = 桥端不认这张交接单 → 必须清掉本页内存会话");
    assert.ok(ss.removes.includes(HANDOVER_KEY) && ls.removes.includes(HANDOVER_KEY),
      "同时清两份交接单（本次不做受控 reload，见下一个用例的说明）");
  });
});

test("连续失败计数在握手成功后清零：中途成功一次 → 再失败 2 次也不得清会话", () => {
  shim.seNoteWsOpened();
  withGlobals(() => {
    const ctx = { sess: { sessId: SESS_ID }, origin: "http://relay.local", deviceId: "" };
    const w1 = openDataWs(ctx); w1._inner.onerror({ type: "error" });
    const w2 = openDataWs(ctx); w2._inner.onerror({ type: "error" });
    // 第三次握手成功（官方自动重连连上了）→ 连续计数归零
    const w3 = openDataWs(ctx); w3._inner.onopen({ type: "open" });
    assert.equal(shim.seWsFailStreak, 0, "成功一次后连续失败计数必须清零");
    const w4 = openDataWs(ctx); w4._inner.onerror({ type: "error" });
    const w5 = openDataWs(ctx); w5._inner.onerror({ type: "error" });
    assert.notEqual(ctx.sess, null, "清零后重新计数（2 次）→ 不得误判死会话");
  });
});

test("已经清过会话之后继续失败：不再重复清、也不抛异常（幂等）", () => {
  shim.seNoteWsOpened();
  withGlobals(() => {
    const ctx = { sess: { sessId: SESS_ID }, origin: "http://relay.local", deviceId: "" };
    for (let i = 0; i < 3; i++) { const w = openDataWs(ctx); w._inner.onerror({ type: "error" }); }
    assert.equal(ctx.sess, null);
    const before = shim.seWsFailCount;
    for (let i = 0; i < 2; i++) { const w = openDataWs(ctx); w._inner.onerror({ type: "error" }); }
    assert.equal(ctx.sess, null);
    assert.equal(shim.seWsFailCount, before + 2, "累计计数仍照常累加（徽标展示用）");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ③ 受控 reload：每标签页最多一次（防 reload 风暴）
// ══════════════════════════════════════════════════════════════════════════════

test("★ 受控 reload 闸门：第一次放行，第二次必须拒绝（每标签页最多一次）", () => {
  withGlobals(() => {
    const ss = new FakeStore();
    installStores(ss, new FakeStore());
    let reloads = 0;
    Object.defineProperty(globalThis, "location", {
      value: { reload() { reloads += 1; } }, configurable: true, writable: true,
    });
    assert.equal(shim.seReloadOnceForDeadSession(), true, "第一次（死票确定 + 刚刚清掉会话）应放行");
    assert.equal(reloads, 1, "必须真的触发一次 reload");
    assert.equal(shim.seReloadOnceForDeadSession(), false, "★ 第二次必须拒绝 —— 否则就是新的 reload 风暴（=499 来源）");
    assert.equal(reloads, 1, "不得再 reload");
    assert.ok(ss.getItem(shim.SE_RELOAD_GUARD_KEY), "闸门必须落 sessionStorage（刷新后仍在，才能跨页生效）");
  });
});

test("受控 reload 在无 sessionStorage / 无 location 的环境里安全返回 false（不抛异常）", () => {
  withGlobals(() => {
    assert.equal(shim.seReloadOnceForDeadSession(), false, "node/受限环境没有 sessionStorage → 不得抛异常");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ④ 接线断言（DOM 层不在 node 可执行范围，但"回调有没有接上、文案对不对"必须锁死）
// ══════════════════════════════════════════════════════════════════════════════

test("★ 接线：HTTP 失效分支把 ctx 传给 seNoteE2eeError；WS 失败把 ctx 传进握手回调", () => {
  const src = readShimScript();
  assert.match(src, /if \(!seIsEnvelopeResponse\(res\)\) \{ seNoteE2eeError\(res, ctx\); return res; \}/,
    "fetch 包装必须把 ctx 交给 seNoteE2eeError —— 否则内存会话永远清不掉（C3 主修）");
  assert.match(src, /seNoteWsHandshakeFail\(self\._meta && self\._meta\.wsLabel, "error", self\._meta && self\._meta\.ctx\)/,
    "WS error 回调必须带上 ctx");
  assert.match(src, /seNoteWsHandshakeFail\(self\._meta && self\._meta\.wsLabel, \(ev && \(ev\.code \|\| ev\.reason\)\) \|\| "close", self\._meta && self\._meta\.ctx\)/,
    "WS close 回调必须带上 ctx");
  assert.match(src, /new SeE2eeWs\(NativeWS, target\.href, protocols, \{ sess: ctx\.sess, wsLabel: target\.wsLabel, ctx: ctx \}\)/,
    "SeE2eeWs 必须拿到本页 ctx（否则清不到 _ctx.sess）");
});

test("★ 接线：徽标文案「加密会话已失效，需要重新解锁」出现在 WS 自愈分支", () => {
  const src = readShimScript();
  const i = src.indexOf("function _reportWsFail(");
  assert.ok(i > 0, "应能找到 _reportWsFail");
  const body = src.slice(i, i + 1400);
  assert.match(body, /加密会话已失效，需要重新解锁/, "C3 验收口径的徽标文案必须原样出现");
  assert.match(body, /dropped/, "必须区分「清了本页死会话」与「只是连不上」两种情形");
  assert.match(body, /明文继续（功能可用，但不再加密）/, "降级后要如实说明“明文可用但不加密”");
});

test("★ 接线：受控 reload 只在 HTTP unknown_session(dropped) 分支发起，WS 分支不刷新", () => {
  const src = readShimScript();
  const staleAt = src.indexOf("function _reportStaleSession(");
  const wsAt = src.indexOf("function _reportWsFail(");
  assert.ok(staleAt > 0 && wsAt > staleAt);
  const staleBody = src.slice(staleAt, wsAt);
  assert.match(staleBody, /if \(dropped\) seReloadOnceForDeadSession\(\);/,
    "HTTP 桥端主动答 unknown_session（死票确定）才做一次受控刷新");
  const wsBody = src.slice(wsAt, wsAt + 1600);
  assert.equal(wsBody.includes("seReloadOnceForDeadSession()"), false,
    "WS 握手失败可能只是电脑端暂时离线 —— 那里清会话即可，绝不能自动刷新打断用户");
});

test("注入体纪律：脚本不含未转义 </script>，且 CORE 区间仍可抽取（本轮只加逻辑不动结构）", () => {
  const raw = readFileSync(SHIM_SCRIPT, "utf8");
  assert.equal(raw.includes("</script>"), false, "shim 脚本正文不得含 </script>（HTML 解析会提前闭合）");
  assert.ok(extractShimCore().length > 1000, "CORE 区间可抽取");
});

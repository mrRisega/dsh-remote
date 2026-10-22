#!/usr/bin/env node
/**
 * 镜像页 E2EE 死会话自动恢复 / 回前台重连（2026-10-23，iOS 断线重连体验）。
 *
 * 现场：iOS 用户切后台被杀 / 切走一两分钟再回来 → 镜像页重载；桥端 E2EE 会话表是**进程内存**
 * （24h TTL + CAP 32 LRU，电脑端重启即丢）→ 重载后撞上「加密会话已失效，需要重新解锁」，
 * 旧行为只能回设备列表手动重新解锁（生产实测某设备 3964 次 e2ee_session_locked）。
 *
 * 本用例跑**真实注入脚本里的恢复层**（假 window/document，指令级断言，不是文本 grep）：
 *   ① 死会话 → location.replace("/app/?resume=<deviceId>&from=mirror")，本页最多一次 + 时间窗闸门；
 *   ② 纯明文（用户主动选「暂不加密」）**绝不**跳转 —— 只有"本该加密却因死会话被降级成明文"
 *      （shim 的 dead-reload 闸门 + 本机有派生 MK）才抢修；
 *   ③ 非镜像页路径 → 不安装监听、什么都不做；
 *   ④ 回前台：后台 ≥8s 才动作、一次轻量探针；探针失败 → 唤醒官方客户端再探一次 →
 *      仍失败只给**可见**提示，绝不做静默无限重连；本页最多 3 次。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { injectMobileAdapter } from "../mobile-adapter.mjs";

/** 从注入结果里取出真正的注入脚本（原样执行）。 */
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

// ── 纯函数：设备 id 解析 + 是否需要恢复 ─────────────────────────────────────────

function loadPure() {
  return vm.runInNewContext(
    PURE_SRC + "\n; ({ maDeviceIdOfMirrorPath, maE2eeResumeDecision })",
    {},
    { filename: "mobile-adapter#resume-pure" }
  );
}

test("设备 id 只从 /remote/<id>/ 解析,且只接受 URL 安全字符", () => {
  const { maDeviceIdOfMirrorPath } = loadPure();
  assert.equal(maDeviceIdOfMirrorPath("/remote/dev-1b8cc3ac183b/"), "dev-1b8cc3ac183b");
  assert.equal(maDeviceIdOfMirrorPath("/remote/dev-abc/session/x"), "dev-abc", "带子路径也要取到设备段");
  assert.equal(maDeviceIdOfMirrorPath("/remote/dev_abc.1:2"), "dev_abc.1:2");
  assert.equal(maDeviceIdOfMirrorPath("/remote/"), "", "没有设备段 → 空串(不跳转)");
  assert.equal(maDeviceIdOfMirrorPath("/remotex/dev"), "", "前缀必须整段匹配");
  assert.equal(maDeviceIdOfMirrorPath("/app/"), "", "设备列表页不是镜像页");
  assert.equal(maDeviceIdOfMirrorPath(""), "");
  assert.equal(maDeviceIdOfMirrorPath(null), "");
  assert.equal(maDeviceIdOfMirrorPath("/remote/..%2F..%2Fadmin"), "", "非法解码结果必须拒绝");
  assert.equal(maDeviceIdOfMirrorPath("/remote/" + "a".repeat(200)), "", "超长 id 必须拒绝");
  assert.equal(maDeviceIdOfMirrorPath("/remote/-leading"), "", "不得以符号开头(避免拼出奇怪路径)");
});

test("死会话文案 → 需要恢复;明文/未解锁默认绝不打扰", () => {
  const { maE2eeResumeDecision } = loadPure();
  const now = 1_700_000_000_000;
  // ① 桥端明确答复(两种 shim 文案)
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "加密会话已失效，需要重新解锁" }, { now }), "dead_session");
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "加密会话已失效(unknown_session):本机保存的会话已不可用,需要重新解锁。" }, { now }), "dead_session");
  // ② 状态正常 / 没有状态 → 不动作
  assert.equal(maE2eeResumeDecision({ mode: "ok", text: "端到端加密已开启" }, { now }), "");
  assert.equal(maE2eeResumeDecision(null, { now }), "");
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "" }, { now }), "");
  // ③ 纯明文/未解锁/交接单无效 —— 用户可能主动选了「暂不加密」,没有别的证据时绝不跳转
  for (const text of ["未加密:未解锁(明文)", "未加密:环境不支持", "未加密:交接单无效", "本次为明文连接"]) {
    assert.equal(maE2eeResumeDecision({ mode: "warn", text }, { now }), "", `明文态不得触发: ${text}`);
  }
  // ④ 瞬时故障类(通道未建立/无法解密)不是"确认不可用" → 不跳转
  assert.equal(maE2eeResumeDecision({ mode: "warn", text: "加密数据通道未建立(第 2 次)" }, { now }), "");
  assert.equal(maE2eeResumeDecision({ mode: "err", text: "无法解密" }, { now }), "");
});

test("只有「死会话重载 + 本机有 MK」才把降级后的明文当成待抢修", () => {
  const { maE2eeResumeDecision } = loadPure();
  const now = 1_700_000_000_000;
  const st = { mode: "warn", text: "未加密:未解锁(明文)" };
  assert.equal(maE2eeResumeDecision(st, { mk: true, deadReloadAt: now - 5_000, now }), "plaintext_after_dead");
  assert.equal(maE2eeResumeDecision(st, { mk: false, deadReloadAt: now - 5_000, now }), "", "本机没有 MK → 解锁也做不了,不打扰");
  assert.equal(maE2eeResumeDecision(st, { mk: true, deadReloadAt: now - 10 * 60 * 1000, now }), "", "重载闸门太旧 → 大概率是用户自己选的明文");
  assert.equal(maE2eeResumeDecision(st, { mk: true, deadReloadAt: now + 5_000, now }), "", "时间戳在未来 → 不可信");
});

// ── 恢复层（真实引擎 + 假 DOM）─────────────────────────────────────────────────

/**
 * 加载恢复层并让它自己装好监听（ENGINE_SRC 末尾就会调用 maArmE2eeResume）。
 * 时间/定时器/网络全部可注入，断言的是"真的发了哪个导航/请求"。
 */
function loadEngine(opts) {
  const o = opts || {};
  const calls = { replace: [], assign: [], href: [], fetchUrls: [], fetchInits: [], online: 0, timers: [], timersDropped: 0 };
  const clock = { now: o.now || 1_700_000_000_000 };
  let timerSeq = 0;
  const makeStore = (seed) => {
    const m = new Map(Object.entries(seed || {}));
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
      _map: m
    };
  };
  const localStorage = makeStore(o.localStorage);
  const sessionStorage = makeStore(o.sessionStorage);
  const listeners = { window: {}, document: {} };
  const on = (bag) => (type, fn) => { (bag[type] = bag[type] || []).push(fn); };

  const location = {
    pathname: o.pathname === undefined ? "/remote/dev-abc123/" : o.pathname,
    search: o.search || "",
    hash: o.hash || "",
    replace: (u) => calls.replace.push(String(u)),
    assign: (u) => calls.assign.push(String(u))
  };
  let href = "";
  Object.defineProperty(location, "href", {
    get: () => href,
    set: (v) => { href = String(v); calls.href.push(href); }
  });

  const win = {
    location,
    localStorage,
    sessionStorage,
    innerWidth: 390,
    innerHeight: 844,
    addEventListener: on(listeners.window),
    dispatchEvent: (ev) => { if (ev && ev.type === "online") calls.online += 1; return true; },
    fetch: (url, init) => {
      calls.fetchUrls.push(String(url));
      calls.fetchInits.push(init || {});
      if (typeof o.fetch === "function") return o.fetch(String(url), init);
      return Promise.resolve({ status: 200 });
    }
  };
  const doc = {
    visibilityState: "visible",
    addEventListener: on(listeners.document)
  };

  const loadWatch = { dismissed: false, slow: false, barEl: null, barTxt: null, hiddenCalled: 0 };
  const sandbox = {
    window: win,
    document: doc,
    localStorage,
    sessionStorage,
    maPublishDiag: () => {},
    maLoadWatch: loadWatch,
    maLoadMountBar: () => {
      const bar = { hidden: true, text: "" };
      loadWatch.barEl = bar;
      loadWatch.barTxt = {
        get textContent() { return bar.text; },
        set textContent(v) { bar.text = String(v); }
      };
      return bar;
    },
    maLoadHideBar: () => { loadWatch.hiddenCalled += 1; },
    Date: { now: () => clock.now },
    Promise,
    JSON,
    Number,
    String,
    Array,
    Object,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    // 假定时器：记 due 时间并支持真正取消 —— 否则"探针超时"会在 fetch resolve 之前被
    // 测试自己跑掉，把成功场景误判成失败（第一版用例就踩了这个假红）。
    setTimeout: (fn, ms) => {
      const id = ++timerSeq;
      calls.timers.push({ id, fn, ms, due: clock.now + Number(ms || 0) });
      return id;
    },
    clearTimeout: (id) => {
      const i = calls.timers.findIndex((t) => t.id === id);
      if (i >= 0) calls.timers.splice(i, 1);
    },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    Event: class { constructor(type) { this.type = type; } }
  };
  const api = vm.runInContext(
    ENGINE_SRC + "\n; ({ maArmE2eeResume, maE2eeTryResume, maForegroundResume, maFgState, maResumeState,"
    + " MA_RESUME_DELAY_MS, MA_RESUME_WINDOW_MS, MA_RESUME_MAX_IN_WINDOW, MA_RESUME_COOLDOWN_MS,"
    + " MA_FG_MIN_BG_MS, MA_FG_COOLDOWN_MS, MA_FG_MAX_PER_PAGE, MA_PROBE_TIMEOUT_MS })",
    vm.createContext(sandbox),
    { filename: "mobile-adapter#resume-engine" }
  );
  return {
    ...api, sandbox, win, doc, calls, listeners, localStorage, sessionStorage, loadWatch,
    now: () => clock.now,
    setNow: (v) => { clock.now = v; },
    fire: (bag, type) => {
      const list = listeners[bag][type] || [];
      for (const fn of list.slice()) fn({ type, persisted: true });
    }
  };
}

/** 把恢复层排队的所有定时器/微任务跑完（异步链：探针 → 延时 → 再探针 → 提示）。
 *  规则：**先**让已 resolve 的 promise 链跑完（setImmediate），**再**把假时钟推进到最近的
 *  到期定时器并执行 —— 顺序反了会把"4 秒探针超时"跑在"已成功的 fetch"之前，制造假红。 */
async function drain(e, rounds = 60) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setImmediate(r));
    if (!e.calls.timers.length) {
      await new Promise((r) => setImmediate(r));
      if (!e.calls.timers.length) return;
      continue;
    }
    const earliest = Math.min(...e.calls.timers.map((t) => t.due));
    if (earliest > e.now()) e.setNow(earliest);
    const due = e.calls.timers.filter((t) => t.due <= e.now());
    e.calls.timers = e.calls.timers.filter((t) => t.due > e.now());
    for (const t of due) {
      try { t.fn(); } catch { /* 定时器里的异常由被测代码自己吞 */ }
    }
  }
}

const DEAD = { mode: "warn", text: "加密会话已失效，需要重新解锁" };
const PLAIN = { mode: "warn", text: "未加密:未解锁(明文)" };
const OK = { mode: "ok", text: "端到端加密已开启" };

test("死会话 → 自动回 /app/?resume=<deviceId>&from=mirror(本页只一次)", async () => {
  const e = loadEngine({ pathname: "/remote/dev-1b8cc3ac183b/" });
  assert.equal(e.maResumeState.armed, true, "镜像页必须装上恢复层");
  e.win.__dshE2eeBadge = { state: () => DEAD };
  e.fire("document", "dsh-e2ee-badge");
  assert.deepEqual(e.calls.replace, [], "必须先给 shim 收尾一点时间,不在事件回调里同步跳转");
  await drain(e);
  assert.deepEqual(e.calls.replace, ["/app/?resume=dev-1b8cc3ac183b&from=mirror"]);
  assert.equal(e.maResumeState.reason, "dead_session");
  // 本页再次发布同样状态 → 不再跳第二次
  e.fire("document", "dsh-e2ee-badge");
  await drain(e);
  assert.equal(e.calls.replace.length, 1, "每页最多一次");
  // 闸门真的落进了 sessionStorage（跨重载仍然有效）
  const hits = JSON.parse(e.sessionStorage.getItem("dsh-ma-e2ee-resume"));
  assert.equal(hits.length, 1);
});

test("纯明文(用户选过「暂不加密」)绝不跳转 —— 即使反复收到徽标事件", async () => {
  const e = loadEngine({ pathname: "/remote/dev-abc123/" });
  e.win.__dshE2eeBadge = { state: () => PLAIN };
  e.fire("document", "dsh-e2ee-badge");
  e.fire("window", "dsh-e2ee-badge");
  await drain(e);
  assert.deepEqual(e.calls.replace, [], "明文模式功能可用,不得把用户弹回设备列表");
  assert.deepEqual(e.calls.assign, []);
  assert.deepEqual(e.calls.href, []);
  assert.equal(e.sessionStorage.getItem("dsh-ma-e2ee-resume"), null, "没有恢复就不该占用闸门额度");
});

test("死会话重载后被降级成明文,且本机有 MK → 抢修一次", async () => {
  const now = 1_700_000_000_000;
  const e = loadEngine({
    pathname: "/remote/dev-abc123/",
    now,
    localStorage: { "dsh-e2ee-mk-v1": "x".repeat(44) },
    sessionStorage: { "dsh-e2ee-dead-reload": String(now - 3000) }
  });
  e.win.__dshE2eeBadge = { state: () => PLAIN };
  // 兜底检查（800ms）就会触发；这里直接手动触发一次更稳
  e.fire("document", "dsh-e2ee-badge");
  await drain(e);
  assert.deepEqual(e.calls.replace, ["/app/?resume=dev-abc123&from=mirror"]);
  assert.equal(e.maResumeState.reason, "plaintext_after_dead");
});

test("不是镜像页 → 不装监听、不跳转(设备列表/其它页面零影响)", async () => {
  const e = loadEngine({ pathname: "/app/" });
  assert.equal(e.maResumeState.armed, false);
  e.win.__dshE2eeBadge = { state: () => DEAD };
  e.fire("document", "dsh-e2ee-badge");
  e.fire("window", "dsh-e2ee-badge");
  await drain(e);
  assert.deepEqual(e.calls.replace, []);
  assert.deepEqual(e.listeners.document["dsh-e2ee-badge"] || [], [], "非镜像页不得挂监听");
});

test("闸门:60 秒窗口内最多 2 次 / 冷却期内不重复恢复", async () => {
  const now = 1_700_000_000_000;
  const e = loadEngine({
    pathname: "/remote/dev-abc123/",
    now,
    sessionStorage: { "dsh-ma-e2ee-resume": JSON.stringify([now - 1000, now - 2000]) }
  });
  e.win.__dshE2eeBadge = { state: () => DEAD };
  e.fire("document", "dsh-e2ee-badge");
  await drain(e);
  assert.deepEqual(e.calls.replace, [], "窗口内已用完 2 次额度 → 不跳(防重定向风暴)");

  const e2 = loadEngine({ pathname: "/remote/dev-abc123/", now });
  e2.maResumeState.lastAt = now - 5_000; // 冷却期内
  e2.win.__dshE2eeBadge = { state: () => DEAD };
  e2.fire("document", "dsh-e2ee-badge");
  await drain(e2);
  assert.deepEqual(e2.calls.replace, [], "冷却期内不重复跳转");
});

test("回前台:短暂切走(<8s)不动作;超过 8s 才做一次轻量探针", async () => {
  const e = loadEngine({ pathname: "/remote/dev-abc123/" });
  e.win.__dshE2eeBadge = { state: () => OK };
  e.fire("document", "visibilitychange");   // 初始可见 → gap=0,不动作
  await drain(e);
  assert.deepEqual(e.calls.fetchUrls, [], "初始可见不得探针");

  // 切后台 3 秒 → 回来:不动作
  e.doc.visibilityState = "hidden";
  e.fire("document", "visibilitychange");
  e.setNow(e.now() + 3_000);
  e.doc.visibilityState = "visible";
  e.fire("document", "visibilitychange");
  await drain(e);
  assert.deepEqual(e.calls.fetchUrls, [], "短暂切走不算断线");

  // 切后台 30 秒 → 回来:一次探针(隧道 manifest),成功则不打扰
  e.doc.visibilityState = "hidden";
  e.fire("document", "visibilitychange");
  e.setNow(e.now() + 30_000);
  e.doc.visibilityState = "visible";
  e.fire("document", "visibilitychange");
  await drain(e);
  assert.equal(e.calls.fetchUrls.length, 1, "回前台应做一次轻量探针");
  // 必须打**过桥**的路径:HEAD /remote/<dev>/（manifest 那类会被中继本地直出,证明不了隧道）
  assert.ok(e.calls.fetchUrls[0].indexOf("/remote/dev-abc123/?dshProbe=") === 0,
    "探针必须打 /remote/<dev>/ 而不是中继本地直出的静态资源");
  assert.equal(e.calls.fetchInits[0].method, "HEAD", "首探用 HEAD(无 body,成本最低)");
  assert.equal(e.calls.fetchInits[0].headers.accept, "application/json",
    "accept 不能是 html —— 否则设备离线时会被 router 判成页面导航走 302 引导页,探针看不到 502");
  assert.equal(e.loadWatch.hiddenCalled, 0, "链路正常时不得弹提示条");
});

test("回前台:探针失败 → 唤醒官方客户端再探一次;仍失败只给可见提示(不静默无限重连)", async () => {
  let allow = false;
  const e = loadEngine({
    pathname: "/remote/dev-abc123/",
    fetch: () => (allow ? Promise.resolve({ status: 200 }) : Promise.reject(new Error("offline")))
  });
  e.win.__dshE2eeBadge = { state: () => OK };
  e.doc.visibilityState = "hidden";
  e.fire("document", "visibilitychange");
  e.setNow(e.now() + 30_000);
  e.doc.visibilityState = "visible";
  e.fire("document", "visibilitychange");
  await drain(e);
  assert.equal(e.calls.online, 1, "探针失败时派发一次 online 让官方客户端自己重连");
  assert.equal(e.calls.fetchUrls.length, 2, "只再探一次,不是无限重试");
  assert.ok(e.calls.fetchUrls[0].indexOf("/remote/dev-abc123/?dshProbe=") === 0);
  assert.ok(e.calls.fetchUrls[1].indexOf("/remote/dev-abc123/favicon.ico?dshProbe=") === 0,
    "第二次退化为 GET favicon.ico(同样是过桥路径)");
  assert.equal(e.calls.fetchInits[1].method, "GET");
  assert.ok(e.loadWatch.barTxt && /连接没有恢复/.test(e.loadWatch.barTxt.textContent),
    "仍失败必须给可见提示(复用底部提示条的重试/返回出口)");
  assert.equal(e.loadWatch.barEl.hidden, false, "提示条要真的显示出来");
  // 再切一次前台:冷却期内不再动作
  e.doc.visibilityState = "hidden";
  e.fire("document", "visibilitychange");
  e.setNow(e.now() + 30_000);
  e.doc.visibilityState = "visible";
  e.fire("document", "visibilitychange");
  await drain(e);
  assert.equal(e.calls.fetchUrls.length, 2, "冷却期内不得再探(不打扰 / 不耗流量)");
});

test("回前台:页面上是死会话 → 直接走 resume(不先探针)", async () => {
  const e = loadEngine({ pathname: "/remote/dev-abc123/" });
  e.win.__dshE2eeBadge = { state: () => DEAD };
  e.doc.visibilityState = "hidden";
  e.fire("document", "visibilitychange");
  e.setNow(e.now() + 30_000);
  e.doc.visibilityState = "visible";
  e.fire("document", "visibilitychange");
  await drain(e);
  assert.deepEqual(e.calls.replace, ["/app/?resume=dev-abc123&from=mirror"]);
  assert.deepEqual(e.calls.fetchUrls, [], "确认不可用时不做多余探针");
});

test("回前台闸门:本页最多 3 次,额度用完就交还用户", async () => {
  const e = loadEngine({ pathname: "/remote/dev-abc123/" });
  e.win.__dshE2eeBadge = { state: () => OK };
  for (let i = 0; i < 5; i += 1) {
    e.doc.visibilityState = "hidden";
    e.fire("document", "visibilitychange");
    e.setNow(e.now() + 70_000);  // 跨过 60 秒冷却，确保限的是"本页次数"而不是冷却期
    e.doc.visibilityState = "visible";
    e.fire("document", "visibilitychange");
    await drain(e);
  }
  assert.equal(e.calls.fetchUrls.length, 3, "本页最多 3 次自动恢复,绝不无限重连");
});

test("探针判定口径:502/504 = 隧道不可达;200/401/403/404 都算\"有回应\"", async () => {
  const run = async (status) => {
    const e = loadEngine({ pathname: "/remote/dev-abc123/", fetch: () => Promise.resolve({ status }) });
    e.win.__dshE2eeBadge = { state: () => OK };
    e.doc.visibilityState = "hidden";
    e.fire("document", "visibilitychange");
    e.setNow(e.now() + 30_000);
    e.doc.visibilityState = "visible";
    e.fire("document", "visibilitychange");
    await drain(e);
    return e;
  };
  for (const status of [200, 204, 401, 403, 404]) {
    const e = await run(status);
    assert.equal(e.calls.fetchUrls.length, 1, `status=${status} 应视为隧道可用(不重试)`);
    assert.equal(e.calls.online, 0, `status=${status} 不该唤醒重连`);
  }
  for (const status of [502, 504]) {
    const e = await run(status);
    assert.equal(e.calls.fetchUrls.length, 2, `status=${status} 是隧道不可达 → 唤醒 + 再探一次`);
    assert.equal(e.calls.online, 1);
  }
});

test("探针 URL 的键与 native.html / e2ee-shim 的字面量逐字一致(跨仓契约)", () => {
  // 只读两个闸门的**键**;值(时间戳/MK)永远不进 URL 或日志。
  assert.ok(ENGINE_SRC.includes('"dsh-e2ee-mk-v1"'), "MA_MK_KEY 必须与 native.html 的 E2EE_MK_STORE_KEY 一致");
  assert.ok(ENGINE_SRC.includes('"dsh-e2ee-dead-reload"'), "MA_DEAD_RELOAD_KEY 必须与 e2ee-shim 的 SE_RELOAD_GUARD_KEY 一致");
  // 与同仓 shim 源码比对(跨仓那份 native.html 由 relay-mobile 的用例锁)
  const shim = readFileSync(new URL("../e2ee-shim-script.js", import.meta.url), "utf8");
  assert.ok(shim.includes('SE_RELOAD_GUARD_KEY = "dsh-e2ee-dead-reload"'),
    "shim 的重载闸门键名变了 → 本层的 dsh-e2ee-dead-reload 必须跟着改");
});

test("恢复层阈值是常量且与 native.html 侧闸门同量级", () => {
  const e = loadEngine({ pathname: "/remote/dev-abc123/" });
  assert.equal(e.MA_RESUME_DELAY_MS, 400);
  assert.equal(e.MA_RESUME_WINDOW_MS, 60 * 1000);
  assert.equal(e.MA_RESUME_MAX_IN_WINDOW, 2);
  assert.equal(e.MA_RESUME_COOLDOWN_MS, 60 * 1000);
  assert.equal(e.MA_FG_MIN_BG_MS, 8000);
  assert.equal(e.MA_FG_MAX_PER_PAGE, 3);
  assert.equal(e.MA_PROBE_TIMEOUT_MS, 4000);
});

test("注入体纪律:恢复层不含反引号 / 不出现 </script> / 只读 E2EE 状态", () => {
  assert.ok(ENGINE_SRC.indexOf("`") === -1, "注入体里的反引号会提前闭合模板字符串");
  assert.ok(ENGINE_SRC.indexOf("</script") === -1);
  assert.ok(ENGINE_SRC.indexOf("__dshE2eeBadge") > -1, "状态必须来自 e2ee-shim 的只读出口");
  assert.ok(!/crypto\.subtle|deriveKey|decrypt\(/i.test(ENGINE_SRC), "恢复层绝不做加解密(那属于 shim)");
  assert.ok(!/new WebSocket/i.test(ENGINE_SRC), "恢复层绝不自己重连 WS");
});

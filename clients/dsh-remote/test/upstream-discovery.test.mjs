#!/usr/bin/env node
/**
 * 上游（dsh web）地址发现契约测试。
 *
 * 背景（两起真实故障，见 upstream-discovery.mjs 顶部注释）：
 *   ① `dsh web --port 8090` / `--port 0`（系统分配端口）→ 写死 3080 的探测永远失败；
 *   ② **DSH Desktop**（Electron 壳 `dsh-plugin-desktop`）默认 43120、占用则 +1，插件 0.6.10
 *      实测「面板永久停在 starting、设备从未登记」——watcher 探 3080 探不到就永不派生 bridge。
 *
 * 这里守四件事：
 *   ① 提示优先级（env > 端口文件 > DSH_WEB_URL）与规范化；
 *   ② **身份校验**：候选端口可能被别的程序占用，绝不能把 bridge 接到陌生人身上；
 *   ③ 提示不可用时会去探候选（含 Desktop 端口区间），并报出**准确的来源**；
 *   ④ 什么都找不到时保持历史行为（回退 3080），不能变成"抛错/空地址"。
 *
 * 用法: node --test test/upstream-discovery.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

import {
  __resetUpstreamCachesForTest,
  candidatePlan,
  candidatePorts,
  discoverUpstreamFast,
  discoverUpstreamFull,
  isDshLikeProcessName,
  isIgnoredListenProcess,
  discoverUpstream,
  listeningPortsOfPid,
  looksLikeDshWeb,
  normalizeUpstream,
  probeDshWeb,
  resolveUpstreamHint,
  DESKTOP_DEFAULT_PORT,
  DESKTOP_PORT_SCAN,
  FALLBACK_UPSTREAM,
  MAX_PROBE_CANDIDATES,
  MAX_PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  UPSTREAM_FILE
} from "../upstream-discovery.mjs";

const DIR = mkdtempSync(path.join(os.tmpdir(), "dsh-upstream-"));
// 发现模块有进程内缓存（负缓存/已验证/监听表）：用例之间必须清零，否则会互相污染
// （真实验证：前一个用例缓存了已关闭的假 dsh 端口，后面的"回退 3080"用例读到了它）。
beforeEach(() => { __resetUpstreamCachesForTest(); });
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

/** 假的 dsh web：回一段带官方特征标记的 HTML（身份校验靠它）。 */
const DSH_HTML = "<!doctype html><html><head><title>DeepSeek Harness</title></head><body><script>__ModuleLoader__</script></body></html>";
/** 冒牌服务：端口在听，但不是 dsh web。 */
const STRANGER = "hello, I am some other local server";

async function listen(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}` };
}
const close = (x) => new Promise((r) => x.srv.close(r));

const writeHint = (url) => writeFileSync(path.join(DIR, UPSTREAM_FILE), url + "\n");
/**
 * 把**宿主真实占用的端口**整段封掉的 fetch 包装。
 *
 * 为什么需要:候选扫描会命中开发机上真实存在的宿主,而那是**宿主**不是测试夹具,
 * 断言就变成"看运气"。最初这里只封了 `3080`(Web 版 dsh web);但装了 **DeepSeek Harness
 * 桌面端**的机器上,Desktop Host 常年监听 `43120` 起的一段端口,而这段端口正是
 * `candidatePorts()` 的静态候选 —— 于是两条用例在**代码没改**的情况下变红
 * (2026-10-07 实测:桌面端在 43120 上跑着,`什么都找不到 → 回退 3080` 得到 43120)。
 * 因此这里按"生产代码认定的已知宿主端口集合"整体封掉,测试才只依赖自己起的假服务。
 */
const realFetch = globalThis.fetch;
const AMBIENT_HOST_PORTS = new Set([
  3080, // Web 版 dsh web 的历史默认端口
  ...Array.from({ length: DESKTOP_PORT_SCAN }, (_, i) => DESKTOP_DEFAULT_PORT + i), // 桌面端 Host 候选区间
]);
const blockedFetch = (input, init) => {
  const url = String(typeof input === "string" ? input : (input && input.url) || "");
  const m = /:(\d+)(?:\/|$)/.exec(url);
  if (m && AMBIENT_HOST_PORTS.has(Number(m[1]))) {
    return Promise.reject(new Error(`blocked: ambient host port ${m[1]}`));
  }
  return realFetch(input, init);
};


test("规范化:去尾斜杠;非 http(s) / 空值一律丢弃", () => {
  assert.equal(normalizeUpstream("http://127.0.0.1:43120/"), "http://127.0.0.1:43120");
  assert.equal(normalizeUpstream("  http://127.0.0.1:3080  "), "http://127.0.0.1:3080");
  assert.equal(normalizeUpstream("wss://n.risegao.cn:13443"), "");
  assert.equal(normalizeUpstream(""), "");
  assert.equal(normalizeUpstream(undefined), "");
});

test("提示优先级:env > 端口文件 > DSH_WEB_URL", () => {
  writeHint("http://127.0.0.1:43120");
  assert.deepEqual(
    resolveUpstreamHint({ relayDir: DIR, env: { DSH_BRIDGE_UPSTREAM: "http://127.0.0.1:9001" } }),
    { url: "http://127.0.0.1:9001", source: "env" }
  );
  assert.deepEqual(resolveUpstreamHint({ relayDir: DIR, env: {} }), { url: "http://127.0.0.1:43120", source: "file" });
  // 文件坏掉 → 落到 DSH_WEB_URL
  writeHint("not-a-url");
  assert.deepEqual(
    resolveUpstreamHint({ relayDir: DIR, env: { DSH_WEB_URL: "https://example.com:8090/?token=x" } }),
    { url: "http://127.0.0.1:8090", source: "dsh_web_url" }
  );
  writeHint("http://127.0.0.1:43120");
});

test("身份校验:只认 dsh web 特征,拒绝陌生服务与空响应", () => {
  assert.equal(looksLikeDshWeb(200, DSH_HTML), true);
  assert.equal(looksLikeDshWeb(401, "dsh web authentication required; reopen the URL printed by dsh web."), true);
  assert.equal(looksLikeDshWeb(200, STRANGER), false);
  assert.equal(looksLikeDshWeb(200, ""), false);
  assert.equal(looksLikeDshWeb(500, DSH_HTML), false, "5xx 不算");
});

test("行为:probeDshWeb 认得出真 dsh web,也拒绝陌生服务与死端口", async () => {
  const dsh = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(DSH_HTML); });
  const stranger = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(STRANGER); });
  try {
    assert.equal(await probeDshWeb(dsh.url), true);
    assert.equal(await probeDshWeb(stranger.url), false, "端口在听但不是 dsh web → 必须拒绝");
    assert.equal(await probeDshWeb("http://127.0.0.1:1"), false, "死端口 → false");
    assert.equal(await probeDshWeb("wss://x"), false, "非 http(s) → false");
  } finally {
    await close(dsh); await close(stranger);
  }
});

test("★ DSH Desktop 场景:端口文件过期/缺失时,靠候选探测找到 43120 上的 dsh web", async () => {
  // 模拟 Desktop：dsh web 在 43120，而端口文件写的是上一轮的旧端口（已无人监听）
  const desktop = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(DSH_HTML); });
  // 探测真的走 43120 —— 测试里换成"把 Desktop 端口作为 extraPorts 注入"，避免占用真实端口
  writeHint("http://127.0.0.1:1"); // 过期提示
  try {
    const found = await discoverUpstream({
      relayDir: DIR,
      env: {},
      extraPorts: [desktop.port],
      fetchImpl: blockedFetch,
      platform: "win32" // 隔离宿主：不走 ps/pgrep/netstat，候选只来自提示/额外端口/静态表
    });
    assert.equal(found.url, desktop.url, "必须落到候选命中的那个 dsh web");
    assert.equal(found.source, "extra");
    assert.ok(found.rejected.includes("http://127.0.0.1:1"), "过期提示应被记入 rejected");
  } finally {
    await close(desktop);
  }
});

test("★ 候选探测不做身份校验的话会接错人:陌生服务在候选端口上也必须被拒绝", async () => {
  const stranger = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(STRANGER); });
  writeHint("http://127.0.0.1:1");
  try {
    const found = await discoverUpstream({ relayDir: DIR, env: {}, extraPorts: [stranger.port], fetchImpl: blockedFetch, platform: "win32" });
    assert.notEqual(found.url, stranger.url, "陌生服务绝不能成为上游");
    assert.equal(found.url, "http://127.0.0.1:1", "找不到时回落到提示地址(让上层按'上游没起来'重试)");
  } finally {
    await close(stranger);
  }
});

test("提示可用时不做候选扫描(省掉无谓探测)", async () => {
  const dsh = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(DSH_HTML); });
  writeHint(dsh.url);
  try {
    const found = await discoverUpstream({ relayDir: DIR, env: {}, fetchImpl: blockedFetch, platform: "win32" });
    assert.equal(found.url, dsh.url);
    assert.equal(found.source, "file");
    assert.deepEqual(found.probed, [dsh.port], "只探了提示本身");
  } finally {
    await close(dsh);
  }
});

test("显式 DSH_BRIDGE_UPSTREAM 直接采信(探测都不做) —— 保持既有语义", async () => {
  const found = await discoverUpstream({
    relayDir: DIR,
    env: { DSH_BRIDGE_UPSTREAM: "http://127.0.0.1:63999" },
    platform: "win32",
    fetchImpl: () => { throw new Error("不该发请求"); }
  });
  assert.equal(found.url, "http://127.0.0.1:63999");
  assert.equal(found.source, "env");
  assert.deepEqual(found.probed, []);
});

test("什么都找不到 → 回退历史默认 3080(不抛错、不放空)", async () => {
  writeHint("not-a-url");
  const found = await discoverUpstream({ relayDir: DIR, env: {}, fetchImpl: blockedFetch, platform: "win32", timeoutMs: 120 });
  assert.equal(found.url, FALLBACK_UPSTREAM);
  assert.equal(found.source, "fallback");
});

test("候选构成:含 3080 与 DSH Desktop 默认端口区间,且去重、带来源", () => {
  writeHint("http://127.0.0.1:43120");
  const list = candidatePorts({ relayDir: DIR, env: {}, platform: "win32" });
  const ports = list.map((e) => e.port);
  assert.ok(ports.includes(3080), "必须包含历史默认端口");
  for (let i = 0; i < 12; i++) assert.ok(ports.includes(DESKTOP_DEFAULT_PORT + i), `必须覆盖 Desktop 端口区间 +${i}`);
  assert.equal(new Set(ports).size, ports.length, "不得重复");
  assert.equal(list.find((e) => e.port === 43120).source, "file", "首个候选应来自端口文件");
});

test("实测端口:能从本进程真实监听端口里读出来(macOS/Linux 用 lsof)", async (t) => {
  if (process.platform === "win32") return t.skip("Windows 走 netstat，另有实现");
  const srv = await listen((_req, res) => res.end("x"));
  try {
    const ports = listeningPortsOfPid(process.pid);
    assert.ok(ports.includes(srv.port), `应包含 ${srv.port}，实际 ${JSON.stringify(ports)}`);
  } finally {
    await close(srv);
  }
});

// ===========================================================================
// 2026-11-07：不再乱敲本机所有端口（微信 CPU 高 + 登录慢）
// ===========================================================================

test("★ 进程名过滤:只保留像 dsh 宿主的端口,IM 客户端/无关进程全部跳过并计数", () => {
  // 黑名单优先：名字里带 wechat 的即使像 node 也拒绝
  assert.equal(isIgnoredListenProcess("WeChat"), true);
  assert.equal(isIgnoredListenProcess("企业微信"), true);
  assert.equal(isIgnoredListenProcess("wecom-node"), true);
  assert.equal(isDshLikeProcessName("wechat-node"), false, "黑名单优先于白名单");
  assert.equal(isDshLikeProcessName("QQ"), false);
  assert.equal(isDshLikeProcessName("node"), true);
  assert.equal(isDshLikeProcessName("nodejs"), true);
  assert.equal(isDshLikeProcessName("dsh-web"), true);
  assert.equal(isDshLikeProcessName("deepseek-harness"), true);
  assert.equal(isDshLikeProcessName("Electron"), true);
  assert.equal(isDshLikeProcessName("python3"), false);
  assert.equal(isDshLikeProcessName(""), false);

  const plan = candidatePlan({
    relayDir: "", // 不读端口文件：本用例只关心进程名过滤
    env: {},
    platform: "win32",
    includeStatic: false,
    listeners: [
      { port: 40001, name: "WeChat", pid: 1 },
      { port: 40002, name: "企业微信", pid: 2 },
      { port: 40003, name: "node", pid: 3 },
      { port: 40004, name: "Electron", pid: 4 },
      { port: 40005, name: "deepseek-harness", pid: 5 },
      { port: 40006, name: "python3", pid: 6 },
    ],
  });
  const ports = plan.entries.map((e) => e.port).sort((a, b) => a - b);
  assert.deepEqual(ports, [40003, 40004, 40005], "★ 只保留 node/electron/deepseek 的端口；微信/企微/python 全部排除");
  assert.equal(plan.skipped, 3, "★ skipped 必须统计被跳过的非 node 进程端口（微信、企微、python）");
  assert.ok(plan.entries.every((e) => e.source === "listen"));
});

test("★ 拿不到进程名时**绝不退化成全量探测**（SKIP 整层，不瞎敲）", () => {
  // listeners:false = 模拟 lsof/ss 不可用（如 NAS/精简系统）
  const plan = candidatePlan({ relayDir: "", env: {}, platform: "win32", includeStatic: false, listeners: false });
  assert.equal(plan.entries.length, 0, "拿不到进程名 → 本层一个候选都不收");
  assert.equal(plan.skipped, 0, "这不是'跳过'，是'整层不可用'");
  // 旧实现会把所有监听端口都收进来（listenPorts 注入路径保持兼容，供测试/特殊部署显式使用）
  const injected = candidatePlan({ relayDir: "", env: {}, platform: "win32", includeStatic: false, listenPorts: [40003, 40004] });
  assert.deepEqual(injected.entries.map((e) => e.port).sort(), [40003, 40004], "显式注入路径保持既有语义");
});

test("★ 负缓存:判定'不是 dsh'的端口 10 分钟内不再探测", async () => {
  const stranger = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(STRANGER); });
  writeHint("not-a-url");
  try {
    const first = await discoverUpstreamFull({ relayDir: DIR, env: {}, extraPorts: [stranger.port], listeners: false, platform: "win32", fetchImpl: blockedFetch, timeoutMs: 300 });
    assert.ok(first.probed.includes(stranger.port), "第一次必须探测该端口");
    const second = await discoverUpstreamFull({ relayDir: DIR, env: {}, extraPorts: [stranger.port], listeners: false, platform: "win32", fetchImpl: blockedFetch, timeoutMs: 300 });
    assert.ok(!second.probed.includes(stranger.port), "★ 负缓存内不得重复探测（微信 CPU 的根因之一就是反复敲）");
  } finally {
    await close(stranger);
  }
});

test("★ fast 路径：没有 hint/缓存/进程端口时**一个请求都不发**（<50ms 语义）", async () => {
  writeHint("not-a-url");
  let calls = 0;
  const fetchImpl = () => { calls += 1; return Promise.reject(new Error("fast 不该探测")); };
  const t0 = Date.now();
  const fast = await discoverUpstreamFast({
    relayDir: DIR, env: {}, platform: "win32", listeners: false, fetchImpl
  });
  const cost = Date.now() - t0;
  assert.equal(fast.url, "", "没有可用来源时返回空（由调用方决定回退）");
  assert.equal(calls, 0, "★ fast 不得探测未知端口");
  assert.ok(cost < 50, `fast 必须很快（实际 ${cost}ms）`);
});

test("★ 探测成本：超时 300ms；150ms 才回的 dsh 仍能命中，>300ms 的不再等", async () => {
  assert.equal(PROBE_TIMEOUT_MS, 300, "默认探测超时必须是 300ms");
  let pending = [];
  const slowOk = await listen((_req, res) => {
    pending.push(setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end(DSH_HTML); }, 150));
  });
  const tooSlow = await listen((_req, res) => {
    pending.push(setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end(DSH_HTML); }, 450));
  });
  try {
    assert.equal(await probeDshWeb(slowOk.url), true, "150ms 内响应 → 必须命中（缩短超时不能把慢机器误杀）");
    assert.equal(await probeDshWeb(tooSlow.url), false, "超过 300ms 的静默端口不再等");
  } finally {
    for (const t of pending) clearTimeout(t);
    pending = [];
    await close(slowOk); await close(tooSlow);
  }
});

test("★ 并发上限：候选再多也最多 16 个并发探测", async () => {
  const servers = [];
  try {
    for (let i = 0; i < 20; i++) {
      servers.push(await listen((_req, res) => {
        setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end(STRANGER); }, 40);
      }));
    }
    const inflight = { now: 0, max: 0 };
    const countingFetch = (input, init) => {
      inflight.now += 1;
      inflight.max = Math.max(inflight.max, inflight.now);
      return Promise.resolve(blockedFetch(input, init)).finally(() => { inflight.now -= 1; });
    };
    writeHint("not-a-url");
    await discoverUpstreamFull({
      relayDir: DIR, env: {}, platform: "win32", listeners: false,
      extraPorts: servers.map((s) => s.port), fetchImpl: countingFetch, timeoutMs: 300
    });
    assert.ok(inflight.max <= MAX_PROBE_CONCURRENCY, `★ 并发不得超过 ${MAX_PROBE_CONCURRENCY}（实际 ${inflight.max}）`);
    assert.ok(inflight.max >= 2, "应当确实并行（否则发现会串行变慢）");
  } finally {
    for (const s of servers) await close(s);
  }
});

test("★ 行为不回归：过滤后仍能发现非默认端口上的 dsh web（能力保留）", async () => {
  const dsh = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(DSH_HTML); });
  writeHint("not-a-url");
  try {
    const found = await discoverUpstreamFull({
      relayDir: DIR, env: {}, platform: "win32", listeners: false, fetchImpl: blockedFetch,
      extraPorts: [dsh.port], timeoutMs: 300
    });
    assert.equal(found.url, dsh.url, "非默认端口仍必须能发现（过滤只排除非 dsh 进程，不排除位置）");
    assert.equal(found.source, "extra");
  } finally {
    await close(dsh);
  }
});

test("★ 每个候选最多 1 次请求：连 HTTP 都不通的端口不再打第二条探测", async () => {
  // ① 死端口：旧实现 / + /dsh-remote/self = 2 个请求；现在 1 个
  let calls = 0;
  const deadFetch = () => { calls += 1; return Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })); };
  assert.equal(await probeDshWeb("http://127.0.0.1:1", { fetchImpl: deadFetch }), false);
  assert.equal(calls, 1, "★ 首探连 HTTP 响应都没拿到 → 不再打 /dsh-remote/self（省一半连接）");

  // ② 正常 HTTP 的陌生服务：首页特征不中时仍要问一次 /dsh-remote/self（保持识别能力）
  const stranger = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(STRANGER); });
  let n = 0;
  const real = (input, init) => { n += 1; return realFetch(input, init); };
  try {
    assert.equal(await probeDshWeb(stranger.url, { fetchImpl: real }), false);
    assert.equal(n, 2, "拿到了 HTTP 响应（只是特征不中）→ 允许第二次探测 /dsh-remote/self");
  } finally {
    await close(stranger);
  }
});

test("★ 候选上限：超过 20 个时整层放弃 listen 扫描（只探 hint/进程/静态）", async () => {
  // 注入 24 个"像 node"的监听端口（超过 LISTEN_PROBE_LIMIT 与 MAX_PROBE_CANDIDATES）
  const listeners = Array.from({ length: 24 }, (_, i) => ({ port: 45000 + i, name: "node", pid: 1000 + i }));
  let calls = 0;
  const fetchImpl = () => { calls += 1; return Promise.reject(new Error("blocked")); };
  writeHint("not-a-url");
  const found = await discoverUpstreamFull({
    relayDir: DIR, env: {}, platform: "win32", listeners, fetchImpl, timeoutMs: 60
  });
  assert.ok(MAX_PROBE_CANDIDATES === 20);
  assert.ok(!found.probed.some((p) => p >= 45000 && p < 45024), "★ 超限时不得探测 listen 层的端口");
  // 静态候选仍会探（3080 + Desktop 区间），所以请求数应为 13 而不是 13+24
  assert.ok(calls <= DESKTOP_PORT_SCAN + 1, `请求数应被压到静态候选量级（实际 ${calls}）`);
});

test("微信通道与上游发现互不相干：不枚举/不探测本机端口（源级断言，Lead 补充报告第 3 条）", () => {
  for (const f of ["wechat-channel.mjs", "wechat-runtime.mjs"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/upstream-discovery/.test(src), `${f} 不得 import 上游发现（微信通道只跟 ilinkai.weixin.qq.com 通信）`);
    assert.ok(!/allLoopbackListeningPorts|candidatePorts|listeningPortsWithProcess/.test(src), `${f} 不得枚举本机监听端口`);
    assert.ok(!/lsof|netstat/.test(src), `${f} 不得调用 lsof/netstat 扫本机端口`);
  }
});

test("dsh-setup watcher：失败指数退避 + 端口文件事件驱动（源级契约）", () => {
  const setup = readFileSync(new URL("../../../dsh-setup.mjs", import.meta.url), "utf8");
  assert.match(setup, /UPSTREAM_DISCOVERY_BACKOFF_MS\s*=\s*\[15_000,\s*30_000,\s*60_000,\s*300_000\]/,
    "连续失败退避必须是 15s→30s→60s→300s");
  assert.match(setup, /if \(now < upstreamDiscoveryNextAt\) return upstreamUrl\(\);/, "退避检查必须在 force 分支之外（force 不得打穿退避）");
  assert.match(setup, /watchUpstreamFile\(ensureBridge\)/, "watcher 必须监听 .dsh-upstream 的变化（事件驱动替代全量扫描）");
  assert.match(setup, /fs\.watchFile\(file, \{ interval: 1000, persistent: false \}/, "监听用 1s stat（不扫端口）");
  assert.ok(/upstreamDiscoveryFails = 0;\s*\n\s*upstreamDiscoveryNextAt = 0;/.test(setup), "端口文件变化时必须清零退避，立即采用新端口");
});

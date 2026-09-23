#!/usr/bin/env node
/**
 * 上游（dsh web）地址发现契约测试。
 *
 * 背景（两起真实事故，见 upstream-discovery.mjs 顶部注释）：
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  candidatePorts,
  discoverUpstream,
  listeningPortsOfPid,
  looksLikeDshWeb,
  normalizeUpstream,
  probeDshWeb,
  resolveUpstreamHint,
  DESKTOP_DEFAULT_PORT,
  FALLBACK_UPSTREAM,
  UPSTREAM_FILE
} from "../upstream-discovery.mjs";

const DIR = mkdtempSync(path.join(os.tmpdir(), "dsh-upstream-"));
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
 * 把 3080 封掉的 fetch 包装。
 * 为什么需要:开发机上真实存在一个 dsh web 监听 3080,候选扫描会命中它 ——
 * 那是**宿主**而不是测试夹具,断言就变成了"看运气"。封掉它,测试才只依赖自己起的假服务。
 */
const realFetch = globalThis.fetch;
const blockedFetch = (input, init) => {
  const url = String(typeof input === "string" ? input : (input && input.url) || "");
  if (/:3080(\/|$)/.test(url)) return Promise.reject(new Error("blocked: host 3080"));
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

// 登录/首屏不再阻塞在「本机端口发现」上（2026-11-07 业主反馈：登录 7~8 秒太慢）。
//
// 根因定位（Lead）：登录后前端拉 /bridge-status 与 /account，服务端 composeConnect 里
// `await discoverUpstreamSelf()`（lsof/netstat + 数百端口探测）+ launchctl/ps 全在响应路径上；
// /config 还在响应里 `...(await composeStatus())`。
//
// 本文件锁三件事：
//   ① composeConnect **不 await** 慢发现（<300ms 返回，并标记 discoveryPending）；
//   ② POST /dsh-remote/config 立即返回（不带衍生状态，statusPending=true）；
//   ③ shell 探测（launchctl/ps）走 10s TTL 缓存（避免每次轮询重跑）。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  apply,
  __composeConnect as composeConnect,
  __setUpstreamTestState as setUpstreamTestState,
  __resetUpstreamTestState as resetUpstreamTestState,
  __clearStatusProbeCache as clearStatusProbeCache,
  __STATUS_PROBE_TTL_MS as STATUS_PROBE_TTL_MS,
} from "../lib/index.js";

// unref：模拟"慢发现"的定时器不能把测试进程空等到 5 秒（本套件对时长敏感）。
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); try { t.unref?.(); } catch { /* 忽略 */ } });
const tmpRelay = () => mkdtemp(path.join(os.tmpdir(), "dsh-login-fast-"));

test("composeConnect：端口发现再慢（5s）也不阻塞状态组装（<300ms），并标记 discoveryPending", async () => {
  const relayDir = await tmpRelay();
  setUpstreamTestState({ unsettled: true, discover: async () => { await sleep(5000); return "http://127.0.0.1:43210"; } });
  clearStatusProbeCache();
  try {
    const t0 = Date.now();
    const conn = await composeConnect(relayDir);
    const cost = Date.now() - t0;
    assert.ok(cost < 300, "★ composeConnect 必须 <300ms 返回（实测 " + cost + "ms）");
    assert.equal(conn.discoveryPending, true, "端口发现还没完成时，必须如实标记 discoveryPending（面板可显示骨架）");
    assert.ok(conn.phase, "状态阶段照常返回（不因发现未完成而缺字段）");
  } finally {
    resetUpstreamTestState();
    clearStatusProbeCache();
  }
});

test("composeConnect：发现已完成（缓存/hint）→ 不再触发发现、discoveryPending=false", async () => {
  const relayDir = await tmpRelay();
  setUpstreamTestState({ unsettled: false, discover: async () => { throw new Error("不该被调用"); } });
  clearStatusProbeCache();
  try {
    const conn = await composeConnect(relayDir);
    assert.equal(conn.discoveryPending, false, "发现已 settled 时不应标记 pending");
  } finally {
    resetUpstreamTestState();
    clearStatusProbeCache();
  }
});

test("POST /dsh-remote/config：立即返回（不 await 衍生状态），body.statusPending=true 且只回最小 config", async () => {
  const relayDir = await tmpRelay();
  setUpstreamTestState({ unsettled: true, discover: async () => { await sleep(5000); return "http://127.0.0.1:43210"; } });
  const routes = [];
  apply({
    webServer: { register(rt) { routes.push(rt); return () => {}; } },
    effect(reg) { return reg(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const rt = routes.find((r) => (r.kind === "prefix"
      ? url.pathname === r.path || url.pathname.startsWith(r.path + "/")
      : url.pathname === r.path));
    (rt ? rt.handler : ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${host.address().port}`;
  try {
    const t0 = Date.now();
    const r = await fetch(`${base}/dsh-remote/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "13800000000", password: "password123" }),
    });
    const cost = Date.now() - t0;
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.ok(cost < 300, "★ /config 必须 <300ms（实测 " + cost + "ms）—— 登录按钮的等待只该是登录请求本身");
    assert.equal(body.ok, true);
    assert.equal(body.statusPending, true, "★ 立即返回时必须声明 statusPending（前端据此异步补状态）");
    assert.equal(typeof body.config, "object", "回最小配置回显（供 UI 立刻切换已登录态）");
    assert.equal(body.config.hasPhone, true);
    assert.equal("connect" in body, false, "★ 响应里不得再带衍生状态（connect/隧道/端口探测结果）");
    assert.equal("service" in body, false, "★ 响应里不得再带 service 衍生信息");
  } finally {
    resetUpstreamTestState();
    clearStatusProbeCache();
    await new Promise((r) => host.close(r));
  }
});

test("shell 探测 TTL：STATUS_PROBE_TTL_MS 是 10s 级短缓存（不是每次轮询都重跑 launchctl/ps）", () => {
  assert.equal(STATUS_PROBE_TTL_MS, 10 * 1000, "缓存 TTL 必须是 10s（B1 约定）");
});

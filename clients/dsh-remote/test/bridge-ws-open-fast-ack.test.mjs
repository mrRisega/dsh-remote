#!/usr/bin/env node
/**
 * ws-open 快速应答 / 上游建立期间消息不丢 / 上游失败用 ws-close 收尾（2026-10-23）。
 *
 * 旧契约：收到 ws-open → 连上游 WebSocket → **等上游 open** 才回 ok。
 *   上游连不上（桌面端换端口 / 宿主重启）时，手机要等 router 的 20s 超时；
 *   bridge 发送队列被大响应占住时（见 bridge-control-priority），连"回 ok"都排不上。
 *
 * 新契约（本文件锁住）：
 *   ① 校验通过立刻回 `{ok:true, fast:true}`（同步、<100ms），再连上游；
 *   ② 上游建立期间手机发来的 ws-msg 进 pending 队列，open 后按序补发（不丢 mux 首帧）；
 *   ③ 上游最终失败 → 回 `ws-close`(1011, retryable) 而不是干等 20s（升级早已 ack）；
 *   ④ E2EE 语义不变：带 &e2ee= 的流先校验会话；未知/未验证 → 1008 +
 *      `retryable:true,action:"rehandshake"`（手机可自动重握手，不用让用户重新解锁）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocketServer } from "ws";

// ── 上游假 dsh web：三种升级行为 ───────────────────────────────────────────────
const upstream = http.createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    try { ws.send(data, { binary: isBinary }); } catch { /* 手机侧已断 */ }
  });
});
let upPort = 0;
await new Promise((resolve) => {
  upstream.listen(0, "127.0.0.1", () => {
    upPort = upstream.address().port;
    resolve();
  });
});
upstream.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://x").pathname; } catch { pathname = ""; }
  if (pathname === "/ws-slow") {
    // 上游建立要 400ms：足够断言"ok 已经先回来了"
    setTimeout(() => {
      try { wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); } catch { /* 手机已断 */ }
    }, 400);
    return;
  }
  if (pathname === "/ws-reject") {
    try { socket.destroy(); } catch { /* 忽略 */ }
    return;
  }
  try { wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); } catch { /* 忽略 */ }
});

// ── 环境必须在 import dsh-bridge 之前定好（模块级常量在 import 时求值）────────────
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-wsopen-"));
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, ".dsh-config.json");
process.env.DSH_BRIDGE_UPSTREAM = `http://127.0.0.1:${upPort}`;
process.env.DSH_BRIDGE_TUNNEL_URL = "ws://127.0.0.1:1"; // 本用例不连隧道
const bridge = await import("../dsh-bridge.mjs");
const {
  __setE2eeForTest,
  __wsSessionState,
  handleWsClose,
  handleWsMessage,
  handleWsOpen
} = bridge;
const e2eeMod = await import("../e2ee-client.mjs");

test.after(() => {
  try { wss.close(); } catch { /* 忽略 */ }
  try { upstream.close(); } catch { /* 忽略 */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 记录 bridge → router 的帧（等价于隧道 send）。 */
function spy() {
  const frames = [];
  const send = (obj) => {
    frames.push({ ...obj, __at: Date.now() });
    return true;
  };
  return { frames, send };
}

async function waitFor(label, pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await delay(10);
  }
}

test("① 先把 ok 回给手机（<100ms），再连上游；ok 不等于上游已建立", async () => {
  const { frames, send } = spy();
  const t0 = Date.now();
  await handleWsOpen(send, { id: "fast1", type: "ws-open", path: "/ws-slow", headers: {} });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `ok 必须立刻回（实测 ${elapsed}ms）`);
  assert.equal(frames.length, 1, "此刻只有 ws-open 回包，没有上游消息");
  assert.equal(frames[0].ok, true);
  assert.equal(frames[0].fast, true, "回包应带 fast:true（可观测：这是快速应答）");
  // 上游还没建立（400ms 后才 open）
  await delay(100);
  assert.equal(__wsSessionState("fast1").opened, false, "100ms 时上游仍未建立");
  await waitFor("上游 open", () => __wsSessionState("fast1")?.opened === true);
  handleWsClose(send, { id: "fast1", code: 1000 });
});

test("② 上游建立期间手机发来的 ws-msg 不丢：排队 → open 后按序补发", async () => {
  const { frames, send } = spy();
  await handleWsOpen(send, { id: "fast2", type: "ws-open", path: "/ws-slow", headers: {} });
  assert.equal(frames[0].ok, true);
  // 手机拿到 ok 后立刻发（真实 mux 首帧就是这样）：此时上游还没 open
  handleWsMessage(send, { id: "fast2", data: "first-frame", binary: false });
  handleWsMessage(send, { id: "fast2", data: "second-frame", binary: false });
  assert.equal(__wsSessionState("fast2").pending, 2, "两条消息应排队等上游");
  // 上游 open 后：消息被补发 → echo 回来（顺序必须与发出顺序一致）
  await waitFor("两条 echo", () => frames.filter((f) => f.type === "ws-msg").length >= 2, 5000);
  const echoed = frames.filter((f) => f.type === "ws-msg").map((f) => String(f.data));
  assert.deepEqual(echoed, ["first-frame", "second-frame"], "补发顺序必须与手机发出顺序一致");
  handleWsClose(send, { id: "fast2", code: 1000 });
});

test("③ 上游建立失败 → ws-close(1011, retryable)，不再让手机干等 20s", async () => {
  const { frames, send } = spy();
  await handleWsOpen(send, { id: "fast3", type: "ws-open", path: "/ws-reject", headers: {} });
  assert.equal(frames[0].ok, true, "先快速 ok");
  const close = await waitFor("失败收尾帧", () => frames.find((f) => f.type === "ws-close"), 4000);
  assert.equal(close.code, 1011);
  assert.equal(close.retryable, true);
  assert.match(String(close.reason || ""), /upstream_ws_open_failed/);
  assert.equal(__wsSessionState("fast3"), null, "失败后会话表应清掉");
});

test("④ 非法路径仍同步拒绝(400)，不做快速 ok", async () => {
  const { frames, send } = spy();
  await handleWsOpen(send, { id: "bad1", type: "ws-open", path: "//evil.example/x", headers: {} });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].ok, false);
  assert.equal(frames[0].code, 400);
});

test("⑤ E2EE：未知会话 → 1008 + action=rehandshake（手机可自动重握手）", async () => {
  const mk = Buffer.alloc(32, 7);
  const svc = new e2eeMod.E2eeService({ enabled: true, mk, profile: "pbkdf2-sha256-600k", salt: "salt-abc", epoch: 0 });
  __setE2eeForTest(svc);
  try {
    const { frames, send } = spy();
    const sessId = e2eeMod.newSessId();
    await handleWsOpen(send, {
      id: "e2ee-locked",
      type: "ws-open",
      path: `/ws-echo?e2ee=${sessId}&w=0123456789abcdef`,
      headers: {}
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].ok, false);
    assert.equal(frames[0].code, 1008);
    assert.equal(frames[0].retryable, true, "★ 必须显式告诉手机这是可自动重试的");
    assert.equal(frames[0].action, "rehandshake", "★ 让手机自动重握手，而不是弹「请重新解锁」");
    assert.match(String(frames[0].reason || ""), /e2ee_session_locked/);
  } finally {
    __setE2eeForTest(new e2eeMod.E2eeService({ enabled: false }));
  }
});

test("⑥ E2EE 语义保持：已验证会话 → 快速 ok；加密消息解封→上游 echo→重新封装一致", async () => {
  const mk = Buffer.alloc(32, 7);
  const salt = "salt-abc";
  const profile = "pbkdf2-sha256-600k";
  const svc = new e2eeMod.E2eeService({ enabled: true, mk, profile, salt, epoch: 0 });
  __setE2eeForTest(svc);
  try {
    // 跑 §5.2 握手（与生产同一条路径，只是"手机"在我们进程里）
    const sessId = e2eeMod.newSessId();
    const a = e2eeMod.randomB64(32);
    const { session, ack } = svc.handleHello({ v: 2, type: "e2ee-hello", role: "phone", s: sessId, a: a, salt, profile });
    const { shk, saltH } = e2eeMod.deriveShk(mk, a, ack.b);
    const client = new e2eeMod.E2eeSession({ sessId, shk, saltH, profile, epoch: 0 });
    const probe = client.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: JSON.stringify({ p: "dsh-e2ee-probe-v1", t: 1, c: 0 }) });
    svc.handleProbe(sessId, probe);
    assert.equal(session.verified, true);

    const w = "0123456789abcdef";
    const wsLabel = `/ws-echo?w=${w}`;
    const { frames, send } = spy();
    await handleWsOpen(send, {
      id: "e2ee-ok",
      type: "ws-open",
      path: `/ws-echo?e2ee=${sessId}&w=${w}`,
      headers: {}
    });
    assert.equal(frames[0].ok, true);
    assert.equal(frames[0].fast, true);
    await waitFor("上游 open", () => __wsSessionState("e2ee-ok")?.opened === true);

    const envP2b = client.seal({ kind: "w", dir: "p2b", counter: 0, data: "ping-加密-你好", wsLabel });
    handleWsMessage(send, { id: "e2ee-ok", data: JSON.stringify(envP2b), binary: false });
    const back = await waitFor("b2p 信封", () => frames.find((f) => f.type === "ws-msg" && String(f.data).includes('"k":"w"')), 5000);
    const envB2p = JSON.parse(String(back.data));
    const opened = client.open({ kind: "w", dir: "b2p", env: envB2p, counter: envB2p.c, wsLabel });
    assert.equal(opened.data.toString("utf8"), "ping-加密-你好", "端到端加解密后逐字节一致");
    handleWsClose(send, { id: "e2ee-ok", code: 1000 });
  } finally {
    __setE2eeForTest(new e2eeMod.E2eeService({ enabled: false }));
  }
});

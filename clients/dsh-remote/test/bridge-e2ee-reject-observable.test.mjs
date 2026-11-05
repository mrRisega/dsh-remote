// E2EE 死会话拒绝的**可观测字段**回归 · bridge 侧（0.7.10 / W1-T3）。
//
// 背景（2026-10 生产复盘）：手机端与电脑之间的 WS 升级被拒里 **71.8%** 是
// `e2ee_session_locked`（死会话），涉 163 用户；单个设备一天能撞 8997 次。
// 0.7.3+ 已闭环（行为回归见 e2ee-shim-selfheal / mobile-adapter-resume 两个用例）：
//   · 手机侧：清内存会话 + 清交接单 + 每标签页最多一次受控 reload，徽标写「加密会话已失效」；
//   · bridge 侧：拒绝时回 `retryable:true, action:"rehandshake"`，手机可自动重握手。
//
// 缺的那一半是「闭环之后还剩多少」：这个比例以前只在 nginx/router 侧算得出来，
// 客户端自己的支持包答不出。本文件锁死新增的可观测记账：
//   ① 拒绝次数进 `.dsh-bridge-state.json`（节流 ≥10s，不加定时器、不额外写盘）；
//   ② 协议行为一个字节都不变（拒绝帧仍带 retryable/action）。
// 插件侧「复制诊断信息」带出这一行的用例见 packages/dsh-remote-web/test/e2ee-reject-diag.test.mjs。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dsh-e2ee-rej-"));
// 环境必须在 import dsh-bridge 之前定好（模块级常量在 import 时求值）
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, ".dsh-config.json");
process.env.DSH_BRIDGE_UPSTREAM = "http://127.0.0.1:1"; // 本用例只走拒绝分支，不连上游
process.env.DSH_BRIDGE_TUNNEL_URL = "ws://127.0.0.1:1";
const bridge = await import("../dsh-bridge.mjs");
const e2eeMod = await import("../e2ee-client.mjs");
const STATE_FILE = path.join(tmpDir, ".dsh-bridge-state.json");

test.after(async () => {
  try { bridge.__setE2eeForTest(new e2eeMod.E2eeService({ enabled: false })); } catch { /* 忽略 */ }
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

function spy() {
  const frames = [];
  return { frames, send: (obj) => { frames.push(obj); return true; } };
}
const readState = async () => {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")) || {}; } catch { return {}; }
};

test("★ e2ee 会话失效拒绝：协议不变（retryable+rehandshake）且记进状态文件", async () => {
  bridge.__setE2eeForTest(new e2eeMod.E2eeService({
    enabled: true, mk: Buffer.alloc(32, 7), profile: "pbkdf2-sha256-600k", salt: "salt-abc", epoch: 0
  }));
  try {
    const before = bridge.__e2eeRejectStatsForTest().locked;
    const { frames, send } = spy();
    const sessId = e2eeMod.newSessId();
    await bridge.handleWsOpen(send, {
      id: "e2ee-locked",
      type: "ws-open",
      path: `/ws-echo?e2ee=${sessId}&w=0123456789abcdef`,
      headers: {}
    });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].ok, false);
    assert.equal(frames[0].code, 1008);
    assert.equal(frames[0].retryable, true, "★ 必须告诉手机这是可自动重试的（0.7.3+ 闭环的一半）");
    assert.equal(frames[0].action, "rehandshake", "★ 让手机自动重握手，而不是弹「请重新解锁」");
    assert.match(String(frames[0].reason || ""), /e2ee_session_locked/);

    assert.equal(bridge.__e2eeRejectStatsForTest().locked, before + 1, "拒绝必须记账（可观测字段的来源）");
    // 首次拒绝立即落盘（之后 10s 内节流合并）—— 支持包里不必等心跳就能看到
    const state = await readState();
    assert.equal(state.e2ee_ws_reject_locked, before + 1, "状态文件应带 e2ee_ws_reject_locked");
    assert.ok(Number(state.e2ee_ws_reject_at) > 0, "应有最近一次拒绝时间（判断是否还在持续撞）");
  } finally {
    bridge.__setE2eeForTest(new e2eeMod.E2eeService({ enabled: false }));
  }
});

test("★ e2ee 未启用（明文回退）的拒绝单独计数，不与死会话混在一起", async () => {
  bridge.__setE2eeForTest(new e2eeMod.E2eeService({ enabled: false }));
  try {
    const before = bridge.__e2eeRejectStatsForTest().disabled;
    const { frames, send } = spy();
    await bridge.handleWsOpen(send, {
      id: "e2ee-off",
      type: "ws-open",
      path: `/ws-echo?e2ee=${e2eeMod.newSessId()}&w=0123456789abcdef`,
      headers: {}
    });
    assert.equal(frames[0].ok, false);
    assert.match(String(frames[0].reason || ""), /e2ee_disabled/);
    assert.equal(bridge.__e2eeRejectStatsForTest().disabled, before + 1, "e2ee_disabled 必须单独计数");
  } finally {
    bridge.__setE2eeForTest(new e2eeMod.E2eeService({ enabled: false }));
  }
});

#!/usr/bin/env node
/**
 * 子进程治理契约测试。
 *
 * 由来（第 1 周实测，报告 §4.5）：经 `cli-wrapper.cjs` 启动时，SIGTERM 只杀 wrapper，
 * **原生 claude 会孤儿化（PPID=1 继续跑）**。手机上点"停止"却还在执行工具，是必须堵住的坑。
 *
 * 这里用**假 spawn / 假 kill / 假 execFile**验证三条路径，**不真的起进程、不真的杀进程**：
 *   ① posix「杀进程组 → 3s → SIGKILL」的升级链；
 *   ② 组信号 ESRCH 时退回单进程（未 detached / 已是孤儿）；
 *   ③ Windows 的 `taskkill /T /F` 分支只"请求"，结果**明确标 verified:false**
 *      （真机未验证，绝不向用户宣称"已确认杀死"）。
 *
 * 用法: node --test clients/dsh-remote/test/agent-proc.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GRACE_MS,
  isProcessAlive,
  spawnAgentProcess,
  terminateProcessTree
} from "../agent/proc.mjs";

/** 假 spawn：记录调用参数，返回一个带 pid 的假 child。 */
function fakeSpawn({ pid = 4242 } = {}) {
  const calls = [];
  const fn = (command, args, opts) => {
    calls.push({ command, args, opts });
    return { pid };
  };
  return { fn, calls };
}

test("spawn：参数数组 + 不走 shell + posix 建独立进程组（-pid 才能杀整组）", () => {
  const { fn, calls } = fakeSpawn();
  const r = spawnAgentProcess({ command: "/fake/claude", args: ["-p", "hello world"], cwd: "/tmp/p" }, { spawn: fn, platform: "linux" });
  assert.equal(r.pid, 4242);
  assert.equal(r.group, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/fake/claude");
  assert.deepEqual(calls[0].args, ["-p", "hello world"], "绝不能拼成一个字符串");
  assert.equal(calls[0].opts.shell, false, "绝不经过 shell（用户输入不走命令行解析）");
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.cwd, "/tmp/p");
});

test("spawn：Windows 不 detached（语义不同，杀树走 taskkill）", () => {
  const { fn } = fakeSpawn();
  const r = spawnAgentProcess({ command: "C:\\claude.exe", args: [] }, { spawn: fn, platform: "win32" });
  assert.equal(r.detached, false);
  assert.equal(r.group, false);
});

test("spawn：缺 command 直接抛（调用方写错要立即暴露，不能起个空进程）", () => {
  assert.throws(() => spawnAgentProcess({}, { spawn: () => ({}) }), /缺少 command/);
});

test("isProcessAlive：ESRCH=死、EPERM=活（存在但没权限）", () => {
  const dead = (pid, sig) => {
    if (sig === 0) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
  const denied = (pid, sig) => {
    if (sig === 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  };
  assert.equal(isProcessAlive(123, { kill: dead }), false);
  assert.equal(isProcessAlive(123, { kill: denied }), true);
  assert.equal(isProcessAlive(0, { kill: dead }), false);
  assert.equal(isProcessAlive("x", { kill: dead }), false);
});

test("posix：SIGTERM 后已死 → 不升级，method=group-term", async () => {
  let alive = true;
  const calls = [];
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === "SIGTERM") {
      alive = false; // 模拟收到 TERM 就退出
      return;
    }
    if (sig === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const r = await terminateProcessTree(777, { platform: "linux", kill, graceMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.method, "group-term");
  assert.equal(r.escalated, false);
  assert.equal(r.verified, true);
  assert.deepEqual(calls[0], [-777, "SIGTERM"], "必须先杀**进程组**");
});

test("posix：SIGTERM 后仍活 → 优雅期后 SIGKILL 整组（这是「不能留下孤儿」的兜底）", async () => {
  let alive = true;
  const calls = [];
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === "SIGTERM" || sig === "SIGKILL") return; // 模拟"不理 TERM"，但 KILL 前仍算活
    if (sig === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const r = await terminateProcessTree(778, { platform: "linux", kill, graceMs: DEFAULT_GRACE_MS });
  assert.equal(r.ok, true);
  assert.equal(r.escalated, true);
  assert.match(r.method, /kill9$/);
  const sigs = calls.map(([, s]) => s);
  assert.deepEqual(sigs.slice(0, 2), ["SIGTERM", 0], "先 TERM，再探活");
  assert.ok(calls.some(([pid, sig]) => pid === -778 && sig === "SIGKILL"), "必须对**整组**发 KILL");
  assert.ok(calls.some(([pid, sig]) => pid === 778 && sig === "SIGKILL"), "单进程也补一刀（组可能已散）");
});

test("posix：组信号 ESRCH（未 detached / 已是孤儿）→ 退回单进程 SIGTERM", async () => {
  const calls = [];
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (pid < 0) throw Object.assign(new Error("no such group"), { code: "ESRCH" });
    if (sig === "SIGTERM") return;
    if (sig === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const r = await terminateProcessTree(779, { platform: "linux", kill, graceMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.method, "pid-term");
  assert.deepEqual(calls.slice(0, 2), [[-779, "SIGTERM"], [779, "SIGTERM"]]);
});

test("posix：进程本来就不在 → already-gone（停止要幂等）", async () => {
  const kill = (pid, sig) => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  const r = await terminateProcessTree(780, { platform: "linux", kill, graceMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.method, "already-gone");
});

test("posix：EPERM（不是我们的进程）→ ok:false，不假装成功", async () => {
  const kill = (pid, sig) => {
    if (pid < 0) throw Object.assign(new Error("perm"), { code: "EPERM" });
  };
  const r = await terminateProcessTree(781, { platform: "linux", kill, graceMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.equal(r.error, "eperm");
});

test("win32：taskkill /T /F 成功 → verified:false（真机未验证，不得宣称已确认）", async () => {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    cb(null);
  };
  const r = await terminateProcessTree(782, { platform: "win32", execFile, kill: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.method, "taskkill-tree");
  assert.equal(r.verified, false);
  assert.equal(calls[0].file, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", "782", "/T", "/F"]);
});

test("win32：taskkill 失败 → 退回 kill，ok:true 但标 taskkill-failed", async () => {
  const killed = [];
  const execFile = (file, args, opts, cb) => cb(new Error("taskkill not found"));
  const r = await terminateProcessTree(783, {
    platform: "win32",
    execFile,
    kill: (pid, sig) => killed.push([pid, sig])
  });
  assert.equal(r.ok, true);
  assert.equal(r.method, "taskkill-fallback-kill");
  assert.equal(r.error, "taskkill-failed");
  assert.deepEqual(killed, [[783, "SIGKILL"]]);
});

test("非法 pid → noop（调用方传了垃圾不该炸）", async () => {
  const r = await terminateProcessTree(0, { platform: "linux" });
  assert.deepEqual(r, { ok: false, method: "noop", escalated: false, verified: false, error: "invalid-pid" });
});

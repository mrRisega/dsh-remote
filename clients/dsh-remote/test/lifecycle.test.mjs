import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childStopped, stopChildGracefully } from "../src/lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SRC = readFileSync(path.join(HERE, "..", "..", "..", "dsh-setup.mjs"), "utf8");
const BRIDGE_SRC = readFileSync(path.join(HERE, "..", "dsh-bridge.mjs"), "utf8");

test("被信号终止的 bridge 子进程可以重新拉起", () => {
  assert.equal(childStopped({ exitCode: null, signalCode: "SIGTERM" }), true);
});

// ───────── 优雅停机：Windows 上 kill() 跑不到退出钩子，必须靠 IPC 请退 ─────────

/** 假子进程：可控地「收到消息后自己退出」/「赖着不退」/「没有 IPC 通道」。 */
function fakeChild({ connected = true, exitAfterMs = null, sendThrows = false, stopped = false } = {}) {
  const calls = { sent: [], killed: 0 };
  const child = {
    exitCode: stopped ? 0 : null,
    signalCode: null,
    connected,
    send(m) {
      if (sendThrows) throw new Error("channel closed");
      calls.sent.push(m);
      if (exitAfterMs !== null) setTimeout(() => { child.exitCode = 0; }, exitAfterMs);
    },
    kill() { calls.killed += 1; child.exitCode = 0; },
  };
  return { child, calls };
}

test("优雅停机：有 IPC 通道时先请退，子进程自己退了就不强杀", async () => {
  const { child, calls } = fakeChild({ exitAfterMs: 10 });
  const how = await stopChildGracefully(child, { timeoutMs: 1000, intervalMs: 5 });
  assert.equal(how, "graceful", "子进程自己退出应报 graceful");
  assert.deepEqual(calls.sent, [{ type: "shutdown" }], "必须先发约定好的 shutdown 消息");
  assert.equal(calls.killed, 0, "已经优雅退出就绝不能再去 kill（Windows 上 kill 会跳过它的收尾）");
});

test("优雅停机：子进程赖着不退 → 超时后强杀，并如实报 killed", async () => {
  const { child, calls } = fakeChild({ exitAfterMs: null });
  const how = await stopChildGracefully(child, { timeoutMs: 120, intervalMs: 20 });
  assert.equal(how, "killed", "超时必须如实报 killed（不能假装优雅）");
  assert.deepEqual(calls.sent, [{ type: "shutdown" }], "仍应先礼后兵");
  assert.equal(calls.killed, 1, "超时后应强杀一次");
});

test("优雅停机：没有 IPC 通道（旧进程/别的拉起方式）→ 直接强杀，不假装优雅", async () => {
  const { child, calls } = fakeChild({ connected: false });
  const how = await stopChildGracefully(child, { timeoutMs: 50 });
  assert.equal(how, "killed");
  assert.equal(calls.sent.length, 0, "没有通道就不该尝试 send");
  assert.equal(calls.killed, 1);
});

test("优雅停机：send 抛错（通道刚断）→ 退回强杀，绝不把异常抛给调用方", async () => {
  const { child, calls } = fakeChild({ sendThrows: true });
  const how = await stopChildGracefully(child, { timeoutMs: 50 });
  assert.equal(how, "killed");
  assert.equal(calls.killed, 1, "send 失败必须退回 kill，否则子进程会变成孤儿");
});

test("优雅停机：已退出/null 不产生任何副作用", async () => {
  const { child, calls } = fakeChild({ stopped: true });
  assert.equal(await stopChildGracefully(child), "already-stopped");
  assert.equal(calls.killed, 0);
  assert.equal(calls.sent.length, 0);
  assert.equal(await stopChildGracefully(null), "none");
  assert.equal(await stopChildGracefully(undefined), "none");
});

test("契约：watcher 必须给 bridge 开 IPC 通道，且不能再裸 kill()", () => {
  // 这两条是本修复的**接线**：少了任何一条，Windows 上的 notifystop 又会静默失效。
  assert.match(SETUP_SRC, /stdio: \["inherit", "inherit", "inherit", "ipc"\]/,
    "watcher 生成 bridge 时必须带 IPC 通道（第 4 个 fd），否则请退消息发不出去");
  assert.ok(!/bridgeProc\.kill\(\)/.test(SETUP_SRC),
    "watcher 不得再直接 bridgeProc.kill()（Windows 上会跳过 bridge 的退出钩子）");
  assert.match(SETUP_SRC, /await stopChildGracefully\(bridgeProc\)/,
    "停止 bridge 必须走优雅停机");
  assert.match(BRIDGE_SRC, /process\.on\("message"/,
    "bridge 必须监听 IPC 消息，否则 watcher 请退没人应答");
  assert.match(BRIDGE_SRC, /m\.type === "shutdown"[\s\S]{0,40}shutdown\(/,
    "bridge 收到 shutdown 消息必须走与信号相同的优雅退出逻辑");
});

test("真实子进程：IPC 请退能跑完异步收尾再退出（不是假对象里的空转）", async () => {
  // 上面几条用的是假 child，只能证明"逻辑分支对"。这条起一个**真 node 子进程**，
  // 证明「IPC 通道 + 请退消息 + 子进程跑完异步收尾后退出」这条链路真的成立 ——
  // 而这正是 Windows 上 notifystop 唯一的执行机会。
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-lifecycle-"));
  const mark = path.join(dir, "flushed.txt");
  const script = `
    const fs = require("node:fs");
    process.on("message", async (m) => {
      if (!m || m.type !== "shutdown") return;
      await new Promise((r) => setTimeout(r, 50));  // 模拟 notifystop 这类异步收尾
      fs.writeFileSync(process.env.DSH_MARK, "flushed");
      process.exit(0);
    });
    setInterval(() => {}, 1000);                    // 保持存活等消息
  `;
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, DSH_MARK: mark },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    if (!child.pid) await new Promise((r) => child.on("spawn", r));
    const how = await stopChildGracefully(child, { timeoutMs: 3000, intervalMs: 20 });
    assert.equal(how, "graceful", "真实子进程应在收到 shutdown 后自己退出");
    assert.equal(readFileSync(mark, "utf8"), "flushed",
      "异步收尾必须真的跑完 —— 少了 IPC 通道这一步在 Windows 上就永远做不到");
  } finally {
    try { child.kill(); } catch { /* 已退出 */ }
    await rm(dir, { recursive: true, force: true });
  }
});

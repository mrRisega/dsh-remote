/**
 * Windows 进程发现：不再漏判活着的 bridge、不再误杀无关进程（2026-10-29 反馈取证）
 *
 * 【为什么单开一个文件】Windows 分支在 macOS/Linux 上跑不了，但它是**唯一**能解释
 * 「面板说 bridge 未运行、而 bridge 明明在跑」的那段代码（详见
 * dsh-relay-internal/2026-10-29-反馈bridge_wedged-取证/code-analysis.md）。本文件用
 * 「`DSH_RELAY_PLATFORM=win32` + 假 powershell.exe + 真 pid 替身 + pid/锁文件」在 macOS 上
 * **行为级**跑一遍 win32 分支，锁死五条不变量：
 *
 *   ① watcher pid 文件有效时，**bridge 缺失仍必须扫进程**（旧实现 `if (!watcher.length && !bridge.length)`
 *      直接跳过 → bridge 恒为空 → 90s 后误判「守护卡死」→ 误重启 → 3 次后 bridge_wedged）；
 *   ② 扫描不得认死镜像名 `node.exe`：Electron 宿主用 `process.execPath` 拉起 watcher，
 *      镜像名是桌面端 exe；bridge 的解释器是 NODE_BIN，也可能是同一个 exe。旧实现两者全漏；
 *   ③ bridge 自写的单实例锁 `.dsh-bridge-instance.lock`（{pid,at,script}）必须能当权威存活判据
 *      （插件以前完全不读它）——但**不许**假阳性（script 不对/pid 是无关进程时不认）；
 *   ④ PID 复用：pid 文件里的 pid 活着**不代表**它是我们的进程。校验不过 → 不判 wedged、
 *      **不 kill**（旧实现 taskkill /T /F 会杀掉一棵与产品无关的进程树）；
 *   ⑤ 扫描失败（PowerShell 不可用）必须与「扫到 0 个」区分开（scanDegraded），
 *      并随 /bridge-status 下发，用户「复制诊断信息」里能看出是「扫描不可用」还是「真没进程」。
 *
 * 隔离纪律（与 windows-compat.test.mjs 同一套）：
 *   · 平台分支用 `DSH_RELAY_PLATFORM=win32` 强制，绝不碰真实 Windows；
 *   · `HOME` 指向临时目录、`relayDir` 指向 mkdtemp —— 绝不写真实 `~/.dsh-remote`；
 *   · `powershell.exe` / `taskkill` / `pgrep` / `ps` / `launchctl` 全部是假 PATH 上的替身；
 *   · `DSH_RELAY_WIN_SCAN_TTL_MS=0` 关掉扫描缓存，否则同一进程内多条用例会互相串味（TTL 5s）；
 *   · 默认置位 `DSH_RELAY_SKIP_SERVICE=1`；只有「停止不得误杀」那条需要真走分支，它同时伪造 HOME。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { apply, __manualStatus, __composeConnect } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");

/** 假 powershell.exe：把 $DSH_TEST_CIM_JSON 原样当 ConvertTo-Json 的输出吐出来。
 *
 * 关键（让旧实现真的红、而不是"假脚本不认 Name 过滤所以蒙对"）：
 * 它会**解码 -EncodedCommand 并检查脚本里有没有 `Name='node.exe'`**，有则模拟 CIM 的
 * 服务端过滤（只留 Name === node.exe 的条目）。于是：
 *   · 旧脚本（Name 过滤）→ Electron 镜像名的 watcher 被滤掉 → 用例红；
 *   · 新脚本（无 Name 过滤）→ 全量返回 → 用例绿。
 * `$DSH_TEST_CIM_FAIL=1` 时故意非 0 退出，模拟「没有 PowerShell / 调用失败」。
 * 每次调用往 `$DSH_TEST_CIM_LOG` 追加一行（证明"扫描到底有没有执行"）。
 */
const FAKE_POWERSHELL = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("-EncodedCommand");
let script = "";
try { if (i >= 0 && args[i + 1]) script = Buffer.from(args[i + 1], "base64").toString("utf16le"); } catch {}
const log = process.env.DSH_TEST_CIM_LOG;
if (log) {
  try { fs.appendFileSync(log, JSON.stringify({ hasNameFilter: /Name\\s*=\\s*'node\\.exe'/.test(script), script: script.slice(0, 240) }) + "\\n"); } catch {}
}
if (process.env.DSH_TEST_CIM_FAIL === "1") { try { process.stderr.write("fake powershell: denied\\n"); } catch {}; process.exit(1); }
let procs = [];
try { procs = JSON.parse(process.env.DSH_TEST_CIM_JSON || "[]"); } catch { procs = []; }
if (!Array.isArray(procs)) procs = procs ? [procs] : [];
if (/Name\\s*=\\s*'node\\.exe'/.test(script)) procs = procs.filter((p) => String((p && p.Name) || "").toLowerCase() === "node.exe");
if (!procs.length) process.exit(0); // ConvertTo-Json 对空结果不输出任何东西
process.stdout.write(JSON.stringify(procs.length === 1 ? procs[0] : procs));
`;

/** 假 taskkill：先记一行，再真的把 /PID 指到的进程杀掉（模拟 Windows 的 /T /F 至少杀掉目标本身）。 */
const FAKE_TASKKILL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_KILL_LOG"
pid=""; prev=""
for a in "$@"; do if [ "$prev" = "/PID" ]; then pid="$a"; fi; prev="$a"; done
if [ -n "$pid" ]; then kill -9 "$pid" 2>/dev/null; fi
exit 0
`;

/** win32 分支不该调到 launchctl/pgrep/ps；放上替身是为了「万一调了也不会碰真机」。 */
const NOOP_BIN = "#!/bin/sh\nexit 0\n";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个真实存活的长命进程当「pid 替身」（判活必须用真 pid）。 */
function startFakeProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  return {
    pid: child.pid,
    alive() { try { process.kill(child.pid, 0); return true; } catch { return false; } },
    stop() { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } },
  };
}

const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v));
const readOrEmpty = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/**
 * 造一套隔离环境：假 HOME / 假 PATH（含 powershell.exe 与 taskkill）/ 临时 relayDir。
 * @param {{ cim?: object[], failScan?: boolean, skipService?: boolean }} opts
 */
async function setup({ cim = [], failScan = false, skipService = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-winproc-"));
  const fakeBin = path.join(root, "bin");
  const fakeHome = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(relayDir, { recursive: true });
  for (const [name, body] of [
    ["powershell.exe", FAKE_POWERSHELL],
    ["taskkill", FAKE_TASKKILL],
    ["pgrep", NOOP_BIN],
    ["ps", NOOP_BIN],
    ["launchctl", NOOP_BIN],
  ]) {
    const p = path.join(fakeBin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }

  const saved = {};
  const keys = ["HOME", "PATH", "DSH_RELAY_PLATFORM", "DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_WIN_SCAN_TTL_MS",
    "DSH_TEST_CIM_JSON", "DSH_TEST_CIM_LOG", "DSH_TEST_CIM_FAIL", "DSH_TEST_KILL_LOG",
    "DSH_REMOTE_TELEMETRY", "DSH_RELAY_DEFAULT_API", "DSH_SETUP_NPX_DIR", "DSH_BRIDGE_UPSTREAM",
    "DSH_WEB_URL", "DSH_TEST_PGREP", "DSH_RELAY_WEDGE_MS", "DSH_RELAY_DIR"];
  for (const k of keys) saved[k] = process.env[k];

  // PATH 首位放假 bin，同时把 node 自己所在目录带上（假 powershell.exe 的 `#!/usr/bin/env node` 要用）
  const nodeDir = path.dirname(process.execPath);
  process.env.HOME = fakeHome;
  process.env.PATH = [fakeBin, nodeDir, saved.PATH || ""].filter(Boolean).join(path.delimiter);
  process.env.DSH_RELAY_PLATFORM = "win32";
  process.env.DSH_RELAY_WIN_SCAN_TTL_MS = "0";      // 关掉 5s 扫描缓存，用例之间不串味
  process.env.DSH_TEST_CIM_JSON = JSON.stringify(cim);
  process.env.DSH_TEST_CIM_LOG = path.join(root, "cim.log");
  process.env.DSH_TEST_KILL_LOG = path.join(root, "taskkill.log");
  if (failScan) process.env.DSH_TEST_CIM_FAIL = "1"; else delete process.env.DSH_TEST_CIM_FAIL;
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1";  // 后台请求一律打到死端口
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  if (skipService) process.env.DSH_RELAY_SKIP_SERVICE = "1"; else delete process.env.DSH_RELAY_SKIP_SERVICE;
  delete process.env.DSH_BRIDGE_UPSTREAM;
  delete process.env.DSH_WEB_URL;
  delete process.env.DSH_TEST_PGREP;
  delete process.env.DSH_RELAY_WEDGE_MS;
  delete process.env.DSH_RELAY_DIR;

  // 运行环境入口：存在 + 没有额外 import ⇒ runtimeReady()=true（不触发补装）
  writeFileSync(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub（用例专用）\n");
  writeJson(path.join(relayDir, ".dsh-config.json"), {
    phone: "13800000000", password: "pw", device_id: "dev-winproc", api_url: "http://127.0.0.1:1",
  });

  return {
    root, fakeBin, fakeHome, relayDir,
    cimLog: process.env.DSH_TEST_CIM_LOG,
    killLog: process.env.DSH_TEST_KILL_LOG,
    /** 造一条「我们自己的进程」的 CIM 记录（命令行带 relayDir，够 pidRunsFrom 认）。 */
    procOf(pid, which = "bridge", extra = {}) {
      const script = which === "bridge"
        ? path.join(relayDir, "clients", "dsh-remote", "dsh-bridge.mjs")
        : path.join(relayDir, "dsh-setup.mjs");
      return {
        ProcessId: pid,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine: `"${process.execPath}" "${script}"${which === "watcher" ? " run" : ""}`,
        ...extra,
      };
    },
    writePid(name, pid, ageMs = 0) {
      const p = path.join(relayDir, name);
      writeFileSync(p, String(pid));
      if (ageMs > 0) {
        const t = (Date.now() - ageMs) / 1000;
        utimesSync(p, t, t);
      }
      return p;
    },
    async restore() {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 装载插件路由（与 windows-compat.test.mjs 同一套最小 ctx）。 */
function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${host.address().port}`, close: () => new Promise((r) => host.close(r)) };
}

const getJson = async (base, p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const postJson = async (base, p) => {
  const res = await fetch(base + p, { method: "POST" });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ─────────────── ① watcher 在跑、bridge pid 文件缺失 → 必须靠扫描补出 bridge ───────────────

test("T1 win32：watcher pid 有效 + bridge pid 文件缺失 → 兜底扫描必须把活着的 bridge 找出来", async () => {
  const watcher = startFakeProcess();
  const bridge = startFakeProcess();
  const env = await setup({ cim: [] });
  try {
    env.writePid(".dsh-watcher.pid", watcher.pid);
    // 注意：**不写** .dsh-bridge.pid —— 这正是事故现场（bridge 秒退时 watcher 会删掉它）
    process.env.DSH_TEST_CIM_JSON = JSON.stringify([env.procOf(bridge.pid, "bridge")]);

    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.bridge, [bridge.pid],
      "watcher pid 文件有效时也必须扫描 bridge（旧实现因 `!watcher.length && !bridge.length` 直接跳过 ⇒ 这里恒为空 ⇒ 面板「bridge 未运行」→ 误重启 → bridge_wedged）");
    assert.deepEqual(st.allBridge, [bridge.pid], "allBridge 也要带上（连接阶段判定用它）");
    assert.deepEqual(st.watcher, [watcher.pid], "watcher 仍来自 pid 文件");
    assert.deepEqual(st.bridgeEvidence, ["scan"], `bridge 的存活证据必须可解释，实际 ${JSON.stringify(st.bridgeEvidence)}`);
    assert.equal(st.scanDegraded, false, "扫描成功不得标成 degraded");
  } finally {
    watcher.stop(); bridge.stop(); await env.restore();
  }
});

// ─────────────── ② 扫描失败 ≠ 扫到 0 个 ───────────────

test("T2 win32：bridge 真没有时也要扫（0 个是结论，不是没扫），且扫描失败要标 degraded", async () => {
  const watcher = startFakeProcess();
  const env = await setup({ cim: [] });
  try {
    env.writePid(".dsh-watcher.pid", watcher.pid);
    const ok = __manualStatus(env.relayDir);
    assert.deepEqual(ok.bridge, [], "扫描返回空 ⇒ bridge 为空（真没有）");
    assert.equal(ok.scanDegraded, false, "扫描能跑通（即使 0 个）不得标 degraded");
    const ran = readOrEmpty(env.cimLog);
    assert.match(ran, /hasNameFilter/, `旧实现这里**一次都不会扫**（watcher 非空就跳过）；修复后必须真的执行过扫描：${ran}`);

    // 扫描失败（PowerShell 不可用）→ 必须与「0 个」区分开
    process.env.DSH_TEST_CIM_FAIL = "1";
    const degraded = __manualStatus(env.relayDir);
    assert.equal(degraded.scanDegraded, true, "PowerShell 调用失败必须标 scanDegraded（否则诊断里会谎报「0 个进程」）");
    assert.deepEqual(degraded.watcher, [watcher.pid], "扫描不可用时，新鲜的 watcher pid 文件仍应被信任");
  } finally {
    watcher.stop(); await env.restore();
  }
});

// ─────────────── ③ 不得认死镜像名 node.exe ───────────────

test("T3 win32：Electron 宿主拉起的 watcher（镜像名不是 node.exe）必须能识别", async () => {
  const watcher = startFakeProcess();
  const env = await setup({ cim: [] });
  try {
    // 没有 pid 文件（例如 pid 文件被删/旧版运行时），只能靠扫描。
    // 镜像名 = 桌面端 exe、命令行里是 `"…\DeepSeek Harness.exe" "…\dsh-setup.mjs" run`
    const electronWatcher = env.procOf(watcher.pid, "watcher", {
      Name: "DeepSeek Harness.exe",
      CommandLine: `"C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" "${path.join(env.relayDir, "dsh-setup.mjs")}" run`,
    });
    process.env.DSH_TEST_CIM_JSON = JSON.stringify([electronWatcher]);

    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.watcher, [watcher.pid],
      "插件用 process.execPath（Electron 宿主 = 桌面端 exe）拉起 watcher，镜像名一定不是 node.exe；`Name='node.exe'` 过滤会整体漏掉它");
  } finally {
    watcher.stop(); await env.restore();
  }
});

// ─────────────── ④ PID 复用：不得判 wedged、不得误杀 ───────────────

test("T4 win32：pid 文件指向被复用的无关进程（陈旧）→ 不得判成 watcher，也不得判 wedged", async () => {
  const unrelated = startFakeProcess();     // 与产品无关，只是"占着那个 pid"
  const env = await setup({ cim: [] });     // 扫描里没有它 ⇒ 取不到命令行 ⇒ 只能靠新鲜度
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    env.writePid(".dsh-watcher.pid", unrelated.pid, 30 * 60 * 1000); // 30 分钟前的 pid 文件
    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.watcher, [], "pid 活着 + 取不到命令行 + pid 文件陈旧 ⇒ 不能当 watcher（否则会去 taskkill 一棵无关进程树）");

    const conn = await __composeConnect(env.relayDir);
    assert.equal(conn.watcherRunning, false, "不得把被复用的 pid 报成「后台守护在运行」");
    assert.equal(conn.watcherWedged, false, "更不得据此判「守护卡死」——这正是「误重启 → bridge_wedged」的起点");
    assert.equal(conn.scanDegraded, false);

    const retry = await postJson(srv.base, "/dsh-remote/connect/retry");
    assert.ok(retry.body, "重试接口必须 200");
    assert.notEqual(retry.body.action, "restart-wedged-watcher",
      `不得因 PID 复用触发「重启卡死守护」，实际 ${retry.body.action}`);
  } finally {
    unrelated.stop(); await srv.close(); routes.dispose(); await env.restore();
  }
});

test("T5 win32：停止 bridge 时，无法确认归属的 pid 绝不能被 kill（PID 复用误杀）", async () => {
  const unrelated = startFakeProcess();
  const env = await setup({ cim: [], skipService: false }); // 真走 stop 分支（系统命令全是假的）
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    env.writePid(".dsh-watcher.pid", unrelated.pid, 30 * 60 * 1000);
    const r = await postJson(srv.base, "/dsh-remote/stop");
    assert.ok(r.status === 200 || r.status === 500, `停止接口不得崩溃：${r.status}`);
    assert.equal(unrelated.alive(), true,
      "无法确认 pid 归属（命令行取不到 + pid 文件陈旧）时必须跳过结束，旧实现会 taskkill /T /F 杀掉这棵无关进程树");
    assert.ok(!readOrEmpty(env.killLog).includes(String(unrelated.pid)),
      `不得把该 pid 交给 taskkill，实际调用：${readOrEmpty(env.killLog)}`);
    assert.match(readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log")),
      /无法确认 pid 归属/,
      "跳过结束必须留一行可回查的日志（否则用户/客服无法解释「为什么点了停止还在跑」）");
  } finally {
    unrelated.stop(); await srv.close(); routes.dispose(); await env.restore();
  }
});

// ─────────────── ⑤ bridge 自写证据（单实例锁 / 状态文件） ───────────────

test("T6 win32：只有 bridge 自写的单实例锁 .dsh-bridge-instance.lock 也要认出 bridge", async () => {
  const bridge = startFakeProcess();
  const env = await setup({ cim: [] }); // 扫描也看不到（模拟 PowerShell 不可用/命令行取不到）
  try {
    writeJson(path.join(env.relayDir, ".dsh-bridge-instance.lock"),
      { pid: bridge.pid, at: Date.now(), script: "dsh-bridge.mjs" });

    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.bridge, [bridge.pid],
      "锁文件是 bridge 进程**自己**写的（{pid,at,script}），是比 pid 文件更权威的存活判据（插件旧实现完全不读它）");
    assert.ok(st.bridgeEvidence.includes("instance-lock"), `证据里要能看出是锁文件认出来的，实际 ${JSON.stringify(st.bridgeEvidence)}`);
  } finally {
    bridge.stop(); await env.restore();
  }
});

test("T6b win32：锁文件 script 不对 / pid 是无关进程 → 不得假阳性", async () => {
  const unrelated = startFakeProcess();
  const env = await setup({ cim: [] });
  try {
    writeJson(path.join(env.relayDir, ".dsh-bridge-instance.lock"),
      { pid: unrelated.pid, at: Date.now(), script: "something-else.mjs" });
    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.bridge, [], "script 不是 dsh-bridge.mjs 的自写证据不可信（否则 PID 复用会让面板谎报运行中）");
  } finally {
    unrelated.stop(); await env.restore();
  }
});

test("T6c win32：状态文件的 pid + 新鲜心跳（bridge 自证）→ 认 bridge，且不必起 PowerShell", async () => {
  const bridge = startFakeProcess();
  const env = await setup({ cim: [] });
  try {
    // 新版 bridge 在心跳拍里节流刷新 {pid, heartbeat_at}（dsh-bridge.mjs 的 stampBridgeHeartbeat）
    writeJson(path.join(env.relayDir, ".dsh-bridge-state.json"),
      { pid: bridge.pid, heartbeat_at: Date.now(), device_id: "dev-winproc", phase: "online" });
    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.bridge, [bridge.pid], "pid 活着 + 心跳新鲜 ⇒ bridge 在跑（自证优先于任何扫描）");
    assert.ok(st.bridgeEvidence.includes("state-file"), `证据应含 state-file，实际 ${JSON.stringify(st.bridgeEvidence)}`);
    assert.equal(readOrEmpty(env.cimLog), "", "自写证据已确认时不得再白起一次 PowerShell 扫描");
  } finally {
    bridge.stop(); await env.restore();
  }
});

test("T6d win32：状态文件心跳已停 → 不得只凭「pid 活着」认 bridge（PID 复用假阳性）", async () => {
  const unrelated = startFakeProcess();
  const env = await setup({ cim: [] });
  try {
    writeJson(path.join(env.relayDir, ".dsh-bridge-state.json"),
      { pid: unrelated.pid, heartbeat_at: Date.now() - 10 * 60 * 1000, device_id: "dev-winproc", phase: "online" });
    const st = __manualStatus(env.relayDir);
    assert.deepEqual(st.bridge, [],
      "心跳已超 120s 且没有锁文件自证 ⇒ 这个 pid 可能已被回收给无关进程，不能谎报「bridge 在跑」（否则自愈会被永久挡住）");
  } finally {
    unrelated.stop(); await env.restore();
  }
});

// ─────────────── ⑥ 端到端：面板不再误报、不再误重启 ───────────────

test("T8 win32：/bridge-status 必须报出活着的 bridge（不再判卡死/不再自动重启守护）", async () => {
  const watcher = startFakeProcess();
  const bridge = startFakeProcess();
  const env = await setup({ cim: [] });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    // 守护已经跑了 3 分钟（>90s 的 wedger 阈值），但 bridge **确实活着**、只是 pid 文件没了
    env.writePid(".dsh-watcher.pid", watcher.pid, 180_000);
    process.env.DSH_TEST_CIM_JSON = JSON.stringify([env.procOf(bridge.pid, "bridge")]);
    writeJson(path.join(env.relayDir, ".dsh-bridge-state.json"), {
      device_id: "dev-winproc", phase: "online", tunnel_registered_at: Date.now(),
    });

    const r = await getJson(srv.base, "/dsh-remote/bridge-status");
    assert.equal(r.status, 200);
    const c = r.body.connect;
    assert.equal(c.bridgeRunning, true, "bridge 明明在跑（扫描/锁文件任一证据）⇒ bridgeRunning 必须为 true（旧实现恒 false）");
    assert.deepEqual(c.bridgePids, [bridge.pid]);
    assert.ok(Array.isArray(c.bridgeEvidence) && c.bridgeEvidence.includes("scan"), `证据要下发到面板：${JSON.stringify(c.bridgeEvidence)}`);
    assert.equal(c.scanDegraded, false);
    assert.equal(c.watcherWedged, false, "bridge 在跑就谈不上「守护拉不起 bridge」");
    assert.notEqual(c.phase, "starting", `不得再显示「正在启动 Bridge…」（实际 ${c.phase}：${c.detail}）`);
    assert.equal(c.phase, "online", "状态文件证明已在中继注册 ⇒ 应直接报 online");
    assert.match(String(c.diagnostics), /进程发现: /, "「复制诊断信息」里必须能看出进程发现的结论来源（扫描/锁文件/pid 文件/degraded）");

    const retry = await postJson(srv.base, "/dsh-remote/connect/retry");
    assert.notEqual(retry.body.action, "restart-wedged-watcher", `不得重启守护，实际 ${retry.body.action}`);
  } finally {
    watcher.stop(); bridge.stop(); await srv.close(); routes.dispose(); await env.restore();
  }
});

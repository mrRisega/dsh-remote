/**
 * C2 / C8 回归：客户端升级与守护层的「不折腾用户的那些约束」。
 *
 * 背景（2026-10-20 用户群故障诊断，报告 00 §6.2 / 04 §四·§五）：
 *   · C8-a **配置抖动**：loadConfig() 任何读失败都静默返回 {} → 账号指纹瞬间变化 →
 *     旧逻辑据此"账号变了，重启 bridge" → 下一轮再拉起。Windows 上被杀软/OneDrive
 *     放大的读抖动就这样变成每 10~20s 一次的重启循环（§4.3）。修法：指纹变化必须
 *     连续 2 轮（或持续 ≥5s）确认；saveConfig 改原子写（tmp + rename），让读方永远读不到半截。
 *   · C8-b **升级杀旧进程**：安装器覆盖写 clients/ 与 node_modules/ws 时，旧 watcher/bridge
 *     正在跑那份文件 → Windows 杀软持有句柄 → 半装（`Cannot find package 'ws'`）+ 孤儿互踢。
 *     修法：覆盖前按"本 relayDir 的命令行"停旧进程，装完按 pid 点名清残留；失败则恢复。
 *   · C2 **孤儿 bridge 清扫**：pid 文件之外的 bridge（watcher 被 TerminateProcess 收掉、
 *     升级后旧进程未退）由 watcher 按命令行清扫，绝不误杀无关进程。
 *
 * 这些分支里的"安全边界"（误杀/误停/误重启）代价都很高，所以纯函数 + 注入替身逐条上锁。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8").replace(/\r\n/g, "\n");
const SETUP_SRC = readFileSync(path.join(ROOT, "dsh-setup.mjs"), "utf8").replace(/\r\n/g, "\n");
const BRIDGE_SRC = readFileSync(path.join(ROOT, "clients", "dsh-remote", "dsh-bridge.mjs"), "utf8").replace(/\r\n/g, "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, step = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 提取 `function name(...) { ... }` 的完整源码（按花括号配对，忽略字符串里的括号风险极小）。 */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 function ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`function ${name} 花括号不配对`);
}

// ─────────────────────── ① C8：指纹确认（读抖动不得触发重启）───────────────────────

/** 从 dsh-setup.mjs 里取出"指纹变化确认"那段（两个常量 + 两个纯函数），单独求值。 */
function loadFingerprintConfirmers() {
  const start = SETUP_SRC.indexOf("const FINGERPRINT_CONFIRM_ROUNDS");
  const end = SETUP_SRC.indexOf("const LOGIN_RATELIMIT_FILE");
  assert.ok(start > 0 && end > start, "应在 dsh-setup.mjs 里找到指纹确认实现");
  return new Function(
    `${SETUP_SRC.slice(start, end)}\nreturn { FINGERPRINT_CONFIRM_ROUNDS, FINGERPRINT_CONFIRM_MS, noteFingerprintCandidate, fingerprintChangeConfirmed };`
  )();
}

test("C8 指纹抖动被抑制：单轮读到 {} / 半截配置不得触发「账号变了→重启 bridge」", () => {
  const { FINGERPRINT_CONFIRM_ROUNDS, FINGERPRINT_CONFIRM_MS, noteFingerprintCandidate, fingerprintChangeConfirmed } = loadFingerprintConfirmers();
  assert.ok(FINGERPRINT_CONFIRM_ROUNDS >= 2, "确认轮数至少 2");
  assert.ok(FINGERPRINT_CONFIRM_MS >= 5000, "确认时长至少 5s（等待跨轮）");

  // 模拟 ensureBridge 每 10s 一轮：真实指纹 A，某轮 loadConfig() 读失败 → {} → 指纹成 "saas|||"
  const A = "saas|13800000000|dev-1234|";
  const EMPTY = "saas|||";
  const t0 = 1_000_000;
  let pending = null;
  let restarts = 0;
  const rounds = [A, EMPTY, A, EMPTY, A, EMPTY, A];
  let maxRounds = 0;
  rounds.forEach((fp, i) => {
    const now = t0 + i * 10_000;
    if (fp === A) { pending = null; return; } // 指纹回到一致 → 疑似变化作废
    pending = noteFingerprintCandidate(pending, fp, now);
    maxRounds = Math.max(maxRounds, pending.rounds);
    if (fingerprintChangeConfirmed(pending, now)) restarts += 1;
  });
  assert.equal(restarts, 0, "★抖动（A/{} 交替）必须一次都不重启：旧实现每轮都会重启");
  assert.equal(maxRounds, 1, "待确认状态不得跨轮累积（相邻两轮看到的必须是同一个新值才算数）");
  assert.equal(pending, null, "指纹回到一致后，待确认状态必须清空");
});

test("C8 真·切号仍要生效：连续 2 轮看到新指纹（或持续 ≥5s）就重启", () => {
  const { noteFingerprintCandidate, fingerprintChangeConfirmed } = loadFingerprintConfirmers();
  const A = "saas|13800000000|dev-1234|";
  const B = "saas|13900000000|dev-1234|";
  const t0 = 2_000_000;
  let pending = noteFingerprintCandidate(null, B, t0);
  assert.equal(fingerprintChangeConfirmed(pending, t0), false, "第一轮只是「疑似」，不能立刻重启");
  // 第二轮（ensureBridge 下一轮，10s 后）看到同一个新指纹 → 确认
  pending = noteFingerprintCandidate(pending, B, t0 + 10_000);
  assert.equal(fingerprintChangeConfirmed(pending, t0 + 10_000), true, "连续 2 轮 → 确认真切号");

  // 只看到一次、但已经过去 ≥5s（例如被限流/上游离线跳过若干轮）→ 也确认
  const single = noteFingerprintCandidate(null, B, t0);
  assert.equal(fingerprintChangeConfirmed(single, t0 + 4_999), false);
  assert.equal(fingerprintChangeConfirmed(single, t0 + 5_000), true);

  // 换了另一个新值就把连击清零（B/C 交替不是"连续同一个"）
  const flip = noteFingerprintCandidate(noteFingerprintCandidate(null, B, t0), "saas|13700000000|dev-1234|", t0 + 100);
  assert.equal(flip.rounds, 1);
  assert.equal(fingerprintChangeConfirmed(flip, t0 + 100), false);

  // 集成形态：ensureBridge 里必须真的用这套判定，而不是"指纹一变就重启"
  const ensure = SETUP_SRC.slice(SETUP_SRC.indexOf("const ensureBridge = async () => {"), SETUP_SRC.indexOf("// watcher 自身的 pid 也要落盘"));
  assert.ok(/pendingFp = noteFingerprintCandidate\(pendingFp, fp\)/.test(ensure), "ensureBridge 必须走连续确认");
  assert.ok(/if \(!fingerprintChangeConfirmed\(pendingFp\)\)/.test(ensure), "未确认时必须直接 return（不重启）");
  assert.ok(/pendingFp = null;/.test(ensure), "指纹复位/确认后要清空待确认状态");
  assert.ok(/bridgeAccountFp !== fp/.test(ensure), "仍然只在「读到的指纹与当前子进程不同」时才考虑重启");
});

// ─────────────────────── ② C8：配置原子写 ───────────────────────

test("C8 配置原子写：写临时文件 + rename（读方永远读不到半截 JSON）；rename 失败才退回直写", () => {
  const fnSrc = extractFunction(SETUP_SRC, "saveConfig");
  const calls = [];
  const make = (fsFake) => new Function("fs", "CONFIG_PATH", "CONFIG_DIR", "sleepSync", "hardenFile", "process",
    `${fnSrc}\nreturn saveConfig;`)(fsFake, "/tmp/relay/.dsh-config.json", "/tmp/relay", () => {}, (p) => calls.push(["harden", p]), { pid: 4242 });

  // ① 正常路径：先写 <config>.<pid>.tmp，再 rename 覆盖；**绝不**直接写目标文件
  const fsOk = {
    mkdirSync: () => calls.push(["mkdir"]),
    writeFileSync: (p, body) => calls.push(["write", p, body]),
    renameSync: (from, to) => calls.push(["rename", from, to]),
    rmSync: (p) => calls.push(["rm", p]),
  };
  make(fsOk)({ phone: "13800000000" });
  const write = calls.find((c) => c[0] === "write");
  const rename = calls.find((c) => c[0] === "rename");
  assert.ok(write, "必须写临时文件");
  assert.equal(write[1], "/tmp/relay/.dsh-config.json.4242.tmp", "临时文件应带 pid（并发写互不覆盖）");
  assert.ok(rename, "必须 rename 到目标路径（原子替换）");
  assert.equal(rename[1], write[1], "rename 的源就是刚写的临时文件");
  assert.equal(rename[2], "/tmp/relay/.dsh-config.json");
  assert.ok(!calls.some((c) => c[0] === "write" && c[1] === "/tmp/relay/.dsh-config.json"),
    "★不得直接覆盖目标文件（旧实现先截断再写 = 读方可能读到半截）");
  assert.ok(calls.some((c) => c[0] === "harden"), "写完仍要收紧文件权限（内含明文账号密码）");

  // ② rename 一直失败（Windows 被杀软/备份工具持有句柄）→ 重试后兜底直写，绝不丢配置
  calls.length = 0;
  const fsBusy = {
    mkdirSync: () => {},
    writeFileSync: (p, body) => calls.push(["write", p, body]),
    renameSync: () => { const e = new Error("EBUSY"); e.code = "EBUSY"; throw e; },
    rmSync: (p) => calls.push(["rm", p]),
  };
  make(fsBusy)({ phone: "13800000000" });
  assert.ok(calls.some((c) => c[0] === "write" && c[1] === "/tmp/relay/.dsh-config.json"),
    "rename 不可用时必须兜底直写（宁可丢原子性，也不能保存失败把配置丢了）");
});

// ─────────────────────── ③ C8：升级前停旧进程 / 装完清残留 ───────────────────────

test("C8 更新流：覆盖运行时**之前**停旧 bridge；成功清残留、失败恢复（顺序与落点）", () => {
  const body = INDEX_SRC.slice(INDEX_SRC.indexOf("async function runOnlineUpdate(relayDir) {"), INDEX_SRC.indexOf("function tailOf("));
  assert.ok(/stopInfo = stopBridgeForRuntimeReplace\(relayDir\)/.test(body), "更新开始要停本 relayDir 的旧 watcher/bridge");
  const stopAt = body.indexOf("stopInfo = stopBridgeForRuntimeReplace(relayDir)");
  const runAt = body.indexOf("const child = run();");
  assert.ok(stopAt > 0 && runAt > 0 && stopAt < runAt, "★必须先停旧进程，再启动 npx 安装（否则覆盖写运行中的文件）");
  assert.ok(/sweepIfSucceeded\(\);/.test(body), "成功路径要清残留");
  assert.ok(/restoreIfStopped\(\);/.test(body), "失败/取消路径要把 bridge 拉回来（别让用户莫名失去远程访问）");
  // 失败分支的覆盖：三跳（官方源/默认源/离线）任一失败都要恢复
  const restoreCount = (body.match(/restoreIfStopped\(\);/g) || []).length;
  assert.ok(restoreCount >= 4, `失败/取消/异常各分支都要恢复（实际 ${restoreCount} 处）`);
  // 恢复只在本轮真停过进程时才执行（测试/无进程环境下不得乱拉）
  assert.ok(/if \(!stopInfo\.pids\.length\) return;/.test(body), "没停过进程就不要恢复（避免测试里碰真实服务）");
});

test("C8 清残留只按命令行点名：死 pid/无关进程/更新前不存在的新实例一律不动", () => {
  const fnSrc = extractFunction(INDEX_SRC, "sweepBridgeAfterRuntimeReplace");
  const make = () => new Function("skipsSystemOps", "pidAlive", "pidRunsFrom", "killPid",
    `${fnSrc}\nreturn sweepBridgeAfterRuntimeReplace;`)(
    () => false,
    (pid) => pid !== 999,                       // 999 = 已死
    (pid, relayDir) => {                        // 只有 11/12 的命令行属于本 relayDir（12 其实已被回收给无关进程）
      if (pid === 12) return false;
      return pid === 11 || pid === 10;
    },
    (pid, sig) => { killed.push([pid, sig]); return true; }
  );
  const killed = [];
  const sweep = make();
  const out = sweep("/tmp/relay", [10, 11, 12, 999]);
  assert.deepEqual(out, [10, 11], "只结束「还活着且命令行仍指向本 relayDir」的那批 pid");
  assert.deepEqual(killed.map((k) => k[0]).sort((a, b) => a - b), [10, 11]);
  // 不传 pid 列表 = 什么都不做（成功但没停过旧进程时绝不清扫，避免误杀安装器刚拉起的新实例）
  assert.deepEqual(sweep("/tmp/relay", []), []);
});

test("C8 停旧进程前必须做命令行校验：看不清就不动（误杀无关进程不可接受）", () => {
  const fnSrc = extractFunction(INDEX_SRC, "pidRunsFrom");
  const make = (cmd) => new Function("commandLineOfPid", `${fnSrc}\nreturn pidRunsFrom;`)(() => cmd);
  assert.equal(make("")(123, "/home/u/.dsh-remote"), false, "取不到命令行 → 不动");
  assert.equal(make("node /home/u/.dsh-remote/clients/dsh-remote/dsh-bridge.mjs")(123, "/home/u/.dsh-remote"), true);
  assert.equal(make("node /opt/other/.dsh-remote/clients/dsh-remote/dsh-bridge.mjs")(123, "/home/u/.dsh-remote"), false,
    "别的目录的 bridge 不得被停");
  assert.equal(make("node C:\\Users\\u\\.dsh-remote\\clients\\dsh-remote\\dsh-bridge.mjs")(123, "C:\\Users\\u\\.dsh-remote"), true,
    "Windows 反斜杠路径也要能匹配");
});

// ─────────────────────── ④ C2：watcher 侧孤儿 bridge 清扫 ───────────────────────

test("C2 watcher 孤儿清扫：按「本运行时命令行」双重校验，且退出码 4 时暂停拉起", () => {
  // 清扫函数必须同时校验脚本名与**本运行时**路径（别的配置目录/用户的 bridge 不碰）
  const isCmd = extractFunction(SETUP_SRC, "isThisRuntimeBridgeCmd");
  const make = (thisDir) => new Function("path", "THIS_DIR", `${isCmd}\nreturn isThisRuntimeBridgeCmd;`)(path, thisDir);
  const check = make("/home/u/.dsh-remote");
  assert.equal(check(`node /home/u/.dsh-remote/clients/dsh-remote/dsh-bridge.mjs --x`), true);
  assert.equal(check(`node /opt/other/.dsh-remote/clients/dsh-remote/dsh-bridge.mjs`), false, "别的配置目录的 bridge 绝不能被扫到");
  assert.equal(check(`node /home/u/.dsh-remote/clients/dsh-remote/wechat-channel.mjs`), false, "不是 bridge 脚本");

  // 接管/退出时都要清扫孤儿（否则孤儿与新实例同 deviceId 互踢）
  const run = SETUP_SRC.slice(SETUP_SRC.indexOf("async function runBridge() {"), SETUP_SRC.indexOf("// ---------- setup：一键安装"));
  assert.ok(/const strays = sweepStrayBridges\(\);/.test(run), "watcher 启动/接管时要清扫 pid 文件之外的孤儿 bridge");
  assert.ok(/sweepStrayBridges\(\{ fast: true \}\)/.test(run), "watcher 退出时也要顺手清扫（fast）");
  // bridge 侧"重复实例"退出码必须与 watcher 侧一致（否则 watcher 不会暂停、继续 10s 重拉互踢）
  assert.match(BRIDGE_SRC, /export const DUPLICATE_INSTANCE_EXIT_CODE = 4;/);
  assert.match(SETUP_SRC, /const DUPLICATE_INSTANCE_EXIT_CODE = 4;/);
  assert.ok(/code === DUPLICATE_INSTANCE_EXIT_CODE/.test(SETUP_SRC), "watcher 要识别这个退出码");
  assert.ok(/duplicateBridgeBackoffUntil = Date\.now\(\) \+ DUPLICATE_BRIDGE_BACKOFF_MS/.test(SETUP_SRC),
    "识别后必须暂停拉起（否则 10s 后又去顶撞对方）");
});

// ─────────────────────── ⑤ 端到端：一键更新真的会停掉本 relayDir 的旧 bridge ───────────────────────

/** 假 npx：写一行进度（避免被"无输出看门狗"判卡住）后成功退出。 */
const FAKE_NPX = `#!/bin/sh
echo "[fake-npx] progress"
sleep 0.3
exit 0
`;

test("C8 端到端：一键更新覆盖运行时前，先结束本 relayDir 的旧 bridge（命令行校验通过才杀）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-update-stop-"));
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  const home = path.join(root, "home");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(fakeBin, "npx"), FAKE_NPX);
  await chmod(path.join(fakeBin, "npx"), 0o755);
  // 假"旧 bridge"：真进程 + 真命令行（路径在本 relayDir 下），才能过 collectRuntimePids/pidRunsFrom
  const stub = path.join(relayDir, "clients", "dsh-remote", "dsh-bridge.mjs");
  await mkdir(path.dirname(stub), { recursive: true });
  await writeFile(stub, "setTimeout(() => {}, 600000);\n");
  const oldBridge = spawn(process.execPath, [stub], { stdio: "ignore" });
  await writeFile(path.join(relayDir, ".dsh-bridge.pid"), String(oldBridge.pid));

  const saved = {};
  for (const k of ["HOME", "DSH_SETUP_NPX_DIR", "DSH_RELAY_SKIP_SERVICE", "DSH_UPDATE_IDLE_MS", "DSH_INSTALL_IDLE_MS",
    "DSH_STALL_POLL_MS", "DSH_REMOTE_TELEMETRY", "DSH_RELAY_SELFHEAL_MS"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_SELFHEAL_MS = "600000"; // 别让自愈在我们观察期间另外拉起东西
  delete process.env.DSH_RELAY_SKIP_SERVICE;    // 要真的走"停旧进程"分支

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${host.address().port}`;
  try {
    const started = await (await fetch(base + "/dsh-remote/self/update", { method: "POST" })).json();
    assert.equal(started.ok, true, `更新应能启动：${JSON.stringify(started)}`);
    const logPath = path.join(relayDir, ".dsh-update.log");
    const stopped = await waitFor(() => {
      try { process.kill(oldBridge.pid, 0); return false; } catch { return true; }
    }, { timeout: 8000 });
    assert.equal(stopped, true, "★覆盖运行时的旧 bridge 必须被结束（否则半装 + 新老互踢）");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    assert.match(log, /覆盖运行时前已停旧 bridge\/watcher（pid /, `更新日志要写明停了哪些进程，实际：\n${log.slice(-600)}`);
  } finally {
    try { oldBridge.kill("SIGKILL"); } catch { /* 已退出 */ }
    await new Promise((resolve) => host.close(resolve));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  }
});

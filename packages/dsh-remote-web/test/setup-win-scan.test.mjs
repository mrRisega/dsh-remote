#!/usr/bin/env node
/**
 * `dsh-setup.mjs` 的 **Windows 进程发现 / 自检扫描** —— 行为级回归（2026-10-29 反馈取证）。
 *
 * 【为什么单开一个文件】事故（见 dsh-relay-internal/2026-10-29-反馈bridge_wedged-取证/
 * code-analysis.md §二 Q4/Q5、§四 F2/F3/F5/F7/F8）：Windows/Electron 宿主下，插件把
 * **活着的孤儿 bridge** 判成「未运行」→ 反复 taskkill 重拉 → 3 次后 `bridge_wedged` 永久红字，
 * 而中继数据面全程在线。运行期/安装器侧的三个结构性缺陷都在 Windows 分支里，而 Windows
 * 分支在开发机上**根本跑不到** —— 本文件用「`DSH_SETUP_PLATFORM=win32` + 假 powershell.exe +
 * 假 PATH + 行为级调用」在 macOS/Linux 上把这些分支真的跑一遍：
 *
 *   ① `listRuntimeBridgePids()` 不得再认死镜像名 `Name='node.exe'`：
 *      Electron 宿主拉起的 bridge 可能叫 `DeepSeek Harness.exe`，旧过滤必然全漏 ⇒
 *      `sweepStrayBridges()` 清不掉孤儿 ⇒ code=4 之后 5 分钟退避永远清不掉；
 *      同时**必须保持 `isThisRuntimeBridgeCmd` 的严格性**（另一个运行时目录的进程不许碰）；
 *   ② `doctor` 的进程扫描旧实现是 `tasklist /FI "IMAGENAME eq node.exe" /FO CSV`，而 tasklist
 *      **没有命令行列**，再用 `dsh-setup.mjs`/`dsh-bridge.mjs` 正则过滤 ⇒ Windows 上恒为 0/0
 *      —— 这条"假证据"把本次排查带偏。现在改为 CIM 全量枚举（带 CommandLine），
 *      计数必须与假数据一致，并打出 pid + 解释器名 + 命令行摘要；扫描不可用要**显式说**
 *      「扫描不可用」，绝不能输出一个会被读成"没有进程"的 0；
 *   ③ `looksLikeWatcher()/looksLikeBridge()` 旧实现用 `ps` ⇒ Windows 恒 false ⇒
 *      接管/回收上一任进程这两条安全回收路径在 Windows 上从不生效。补 Windows 分支后，
 *      按 pid 查到的命令行必须能认出 watcher / bridge，且**认不出就绝不动**（PID 复用安全）；
 *   ④ pid 文件必须"谁持有谁负责"：`removePidFile(name, expectPid)` 只在内容等于自己的 pid 时删
 *      （旧实现无条件删 = 事故根因链第 2 步：新 bridge 秒退把孤儿活着的证据删掉）；
 *      写/删失败必须往 `.dsh-setup-install.log` 留一行（不再静默 catch）；
 *   ⑤ bridge 自证：状态文件里写 `pid` 并节流刷新 `heartbeat_at`（插件侧另一条线读取）。
 *
 * 【怎么测 dsh-setup.mjs 里的函数】它是 **CLI 单文件**（`import` 就会执行 main、没有 export），
 * 所以只能沿用仓库既有手法（见 windows-compat.test.mjs 的 new Function 用例）：按锚点切出
 * 函数源码，用 `new Function` 注入模块级依赖（IS_WIN / THIS_DIR / spawnSync / path / fs / sh）
 * 后调用。假 `powershell.exe` 放在 PATH 最前面（macOS/Linux 能按 PATH 解析带扩展名的可执行脚本）。
 *
 * 【隔离纪律】不碰真实 Windows / 真实 `~/.dsh-remote`：HOME 与 relayDir 全部 mkdtemp，
 * 平台分支用 `DSH_SETUP_PLATFORM=win32` 强制；「子进程 env」只传给 spawnSync，不改本进程环境
 * （只有切函数用的 PATH/假 JSON 会临时置位并在 finally 还原）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
// DSH_TEST_SETUP_PATH：只给"红/绿对照"用 —— 指向改动前的 dsh-setup.mjs，验证本文件的新用例
// 在旧实现上真的会红（而不是"假脚本不认 Name 过滤所以蒙对"）。
const SETUP = process.env.DSH_TEST_SETUP_PATH || path.join(ROOT, "dsh-setup.mjs");
const BRIDGE = path.join(ROOT, "clients", "dsh-remote", "dsh-bridge.mjs");
// 本文件就是 Windows 专项：CRLF 检出时源码锚点必须仍然匹配
const SETUP_SRC = readFileSync(SETUP, "utf8").replace(/\r\n/g, "\n");
const BRIDGE_SRC = readFileSync(BRIDGE, "utf8").replace(/\r\n/g, "\n");

/**
 * 假 `powershell.exe`（node 实现，便于解码 -EncodedCommand 做"服务端过滤"模拟）。
 *
 * 关键：它会**解码 -EncodedCommand 并检查脚本里有没有 `Name='node.exe'`**，有则模拟 CIM 的
 * 服务端过滤（只留 `Name === "node.exe"` 的条目）—— 于是旧实现（带 Name 过滤）在
 * 「Electron 命名的 bridge」用例里必然红，新实现（无 Name 过滤）绿。这不是蒙对，是照旧实现的
 * 查询语义真的过滤了一遍。
 *
 * 另外两种用法：
 *   · 脚本含 `ProcessId=`（`windowsProcessCommandLine` 点查）→ 原样输出 `$DSH_TEST_CMDLINE`；
 *   · `$DSH_TEST_CIM_FAIL=1` → 非 0 退出，模拟「没装 PowerShell / 调用失败 / 超时」。
 * 每次调用往 `$DSH_TEST_CIM_LOG` 追加一行（证明扫描执行过 + 用的是哪种查询）。
 */
const FAKE_POWERSHELL = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("-EncodedCommand");
let script = "";
try { if (at >= 0 && args[at + 1]) script = Buffer.from(args[at + 1], "base64").toString("utf16le"); } catch {}
const hasNameFilter = /Name\\s*=\\s*'node\\.exe'/.test(script);
const log = process.env.DSH_TEST_CIM_LOG;
if (log) {
  try {
    fs.appendFileSync(log, JSON.stringify({ hasNameFilter, pointQuery: /ProcessId\\s*=/.test(script), script: script.slice(0, 200) }) + "\\n");
  } catch {}
}
if (process.env.DSH_TEST_CIM_FAIL === "1") {
  try { process.stderr.write("fake powershell: 不可用\\n"); } catch {}
  process.exit(1);
}
if (/ProcessId\\s*=/.test(script)) {
  process.stdout.write(String(process.env.DSH_TEST_CMDLINE || ""));
  process.exit(0);
}
let procs = [];
try { procs = JSON.parse(process.env.DSH_TEST_CIM_JSON || "[]"); } catch { procs = []; }
if (!Array.isArray(procs)) procs = procs ? [procs] : [];
if (hasNameFilter) procs = procs.filter((p) => String((p && p.Name) || "").toLowerCase() === "node.exe");
if (!procs.length) process.exit(0); // ConvertTo-Json 对空结果不输出任何东西
process.stdout.write(JSON.stringify(procs.length === 1 ? procs[0] : procs));
`;

/** 造隔离环境：临时 root / 假 bin（含假 powershell.exe）/ 假 HOME / 临时 relayDir。 */
function makeEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-setup-winscan-"));
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(relayDir, { recursive: true });
  const ps = path.join(fakeBin, "powershell.exe");
  writeFileSync(ps, FAKE_POWERSHELL);
  chmodSync(ps, 0o755);
  return {
    root, fakeBin, home, relayDir,
    cimLog: path.join(root, "cim.log"),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* 已清理 */ } },
  };
}

/** 临时置位本进程环境（给"切函数直接调用"用），返回后原样还原。 */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * 按锚点切出 dsh-setup.mjs 里的函数源码，用 `new Function` 注入模块级依赖后执行。
 * @param {{ start: string, end: string, params: Record<string, unknown>, exports: string[] }} spec
 */
function loadSetupFns({ start, end, params = {}, exports }) {
  const a = SETUP_SRC.indexOf(start);
  const b = SETUP_SRC.indexOf(end);
  assert.ok(a >= 0, `切片起点锚点失效（代码可能改过）：${start.slice(0, 60)}`);
  assert.ok(b > a, `切片终点锚点失效：${end.slice(0, 60)}`);
  const src = SETUP_SRC.slice(a, b);
  const keys = Object.keys(params);
  const make = new Function(...keys, `${src}\nreturn { ${exports.join(", ")} };`);
  return make(...keys.map((k) => params[k]));
}

/** POSIX 分支 stub：win32 用例里若走到它，说明平台分支接错了 —— 直接炸出来。 */
const posixBranchSh = () => { throw new Error("win32 用例不该走 POSIX 分支（sh/ps）"); };

/** 「按本运行时 CLI 的 Windows 分支」加载 isThisRuntimeBridgeCmd + windowsCimProcesses + listRuntimeBridgePids。 */
function loadPidDiscovery(thisDir) {
  return loadSetupFns({
    start: "function isThisRuntimeBridgeCmd(cmd) {",
    end: "function sweepStrayBridges(",
    params: { IS_WIN: true, THIS_DIR: thisDir, path, spawnSync, sh: posixBranchSh },
    exports: ["isThisRuntimeBridgeCmd", "windowsCimProcesses", "listRuntimeBridgePids"],
  });
}

/** 加载 processCommandLine / looksLikeWatcher / looksLikeBridge + Windows 的 windowsProcessCommandLine。 */
function loadLookalike() {
  const first = SETUP_SRC.slice(
    SETUP_SRC.indexOf("function processCommandLine(pid) {"),
    SETUP_SRC.indexOf("function shouldReapLeftoverBridge("),
  );
  const second = SETUP_SRC.slice(
    SETUP_SRC.indexOf("/** 读某进程的完整命令行"),
    SETUP_SRC.indexOf("/**\n * 把 Windows 命令行拆成 argv"),
  );
  assert.ok(first.includes("function looksLikeWatcher") && first.includes("function looksLikeBridge"),
    "应能切出 processCommandLine / looksLikeWatcher / looksLikeBridge");
  assert.ok(second.includes("function windowsProcessCommandLine"),
    "应能切出 windowsProcessCommandLine（Windows 按 pid 查命令行）");
  const make = new Function("IS_WIN", "sh", "spawnSync",
    `${first}\n${second}\nreturn { processCommandLine, looksLikeWatcher, looksLikeBridge, windowsProcessCommandLine };`);
  return make(true, posixBranchSh, spawnSync);
}

/** 加载 pid 文件三件套（写在 run() 里、被「只删自己的」契约约束）。 */
function loadPidFileHelpers(configDir) {
  return loadSetupFns({
    start: "function logSetupIssue(line) {",
    end: "function processCommandLine(pid) {",
    params: { CONFIG_DIR: configDir, fs, path },
    exports: ["logSetupIssue", "writePidFile", "removePidFile", "readPidFile"],
  });
}

/** 跑 `dsh-setup.mjs doctor`（子进程；env 全部显式给，不改本进程环境）。 */
function runDoctor(env, extra = {}) {
  const r = spawnSync(process.execPath, [SETUP, "doctor"], {
    encoding: "utf8",
    timeout: 90000,
    env: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      DSH_RELAY_DIR: env.relayDir,
      DSH_SETUP_PLATFORM: "win32", // 平台覆盖：让 macOS/Linux 也真的走 win32 的扫描分支
      DSH_REMOTE_TELEMETRY: "0",
      DSH_RELAY_DEFAULT_API: "http://127.0.0.1:1",
      DSH_RELAY_SKIP_SERVICE: "1",
      DSH_TEST_CIM_LOG: env.cimLog,
      ...extra,
    },
  });
  return { out: String(r.stdout || "") + String(r.stderr || ""), status: r.status };
}

const CIM_WATCHER = {
  ProcessId: 1111,
  Name: "DeepSeek Harness.exe",
  CommandLine: '"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" "C:\\Users\\u\\.dsh-remote\\dsh-setup.mjs" run',
};
const CIM_BRIDGE = {
  ProcessId: 2222,
  Name: "DeepSeek Harness.exe", // ← 关键：不是 node.exe（Electron 宿主回落解释器）
  CommandLine: '"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" "C:\\Users\\u\\.dsh-remote\\clients\\dsh-remote\\dsh-bridge.mjs"',
};
const CIM_UNRELATED = {
  ProcessId: 3333,
  Name: "node.exe",
  CommandLine: '"C:\\Program Files\\nodejs\\node.exe" -e "setTimeout(() => {}, 120000)"',
};

// ─────────────────── ① listRuntimeBridgePids：非 node.exe 的 bridge 必须被认出 ───────────────────

test("★ listRuntimeBridgePids：非 node.exe 命名的 bridge 也要能识别（旧实现 Name='node.exe' 过滤必漏）", () => {
  const env = makeEnv();
  try {
    const thisDir = path.join(env.root, "runtime-dir", ".dsh-remote");
    const thisBridge = path.join(thisDir, "clients", "dsh-remote", "dsh-bridge.mjs");
    const otherBridge = path.join(env.root, "other-runtime", "clients", "dsh-remote", "dsh-bridge.mjs");
    const cim = [
      // Electron 宿主回落的解释器：镜像名 = 桌面端 exe（旧实现 100% 漏）
      { ProcessId: 4101, Name: "DeepSeek Harness.exe", CommandLine: `"C:\\Apps\\DeepSeek Harness.exe" "${thisBridge}"` },
      // 真 node 当解释器（旧实现能扫到）
      { ProcessId: 4102, Name: "node.exe", CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${thisBridge}"` },
      // 另一个运行时目录的 bridge：**不许**算进本运行时（严格性不能丢，否则跨配置目录误杀）
      { ProcessId: 4103, Name: "node.exe", CommandLine: `"node.exe" "${otherBridge}"` },
      // 无关进程（PID 复用场景）：命令行不含 dsh-bridge.mjs
      { ProcessId: 4104, Name: "node.exe", CommandLine: '"node.exe" -e "setTimeout(() => {}, 120000)"' },
      // watcher 不是 bridge：不能混进来
      { ProcessId: 4105, Name: "DeepSeek Harness.exe", CommandLine: `"DeepSeek Harness.exe" "${path.join(thisDir, "dsh-setup.mjs")}" run` },
    ];
    const fns = loadPidDiscovery(thisDir);
    const pids = withEnv({
      PATH: `${env.fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      DSH_TEST_CIM_JSON: JSON.stringify(cim),
      DSH_TEST_CIM_LOG: env.cimLog,
      DSH_TEST_CIM_FAIL: undefined,
    }, () => fns.listRuntimeBridgePids());

    assert.deepEqual(pids, [4101, 4102],
      `必须认出「Electron 命名的桥 + node.exe 的桥」，且排除别的运行时/无关进程/watcher（实际 ${JSON.stringify(pids)}）`);

    // 反向证据：新实现的 CIM 脚本**不得**再带 Name 过滤（假 powershell 会如实记录）
    const log = readFileSync(env.cimLog, "utf8");
    assert.ok(log.trim().length > 0, "扫描应该真的执行过（假 powershell 没被调用？）");
    assert.ok(!/"hasNameFilter":true/.test(log),
      "win32 的 CIM 枚举不得再带 Name='node.exe' 过滤（Electron 宿主下必然全漏）");
  } finally { env.cleanup(); }
});

test("★ listRuntimeBridgePids：扫描不可用 → 空数组（宁漏杀不误杀，绝不因扫不到就当没有）", () => {
  const env = makeEnv();
  try {
    const fns = loadPidDiscovery(path.join(env.root, "runtime-dir"));
    const pids = withEnv({
      PATH: `${env.fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      DSH_TEST_CIM_JSON: JSON.stringify([CIM_BRIDGE]),
      DSH_TEST_CIM_LOG: env.cimLog,
      DSH_TEST_CIM_FAIL: "1", // 模拟没 PowerShell / 被策略禁用 / 超时
    }, () => fns.listRuntimeBridgePids());
    assert.deepEqual(pids, [], "扫描不可用时必须返回空（失败方向是漏杀，不能拿空结果当'确认没有'去杀别的东西）");
    assert.equal(fns.windowsCimProcesses(), null, "windowsCimProcesses 必须用 null 表示「扫描不可用」，与空数组 [] 区分");
  } finally { env.cleanup(); }
});

// ─────────────────── ② doctor：不再输出恒 0/0 的假证据 ───────────────────

test("★ doctor：win32 进程计数与 fake CIM 一致，并带 pid/解释器/命令行摘要（旧实现 tasklist 无命令行 ⇒ 恒 0/0）", () => {
  const env = makeEnv();
  try {
    const { out } = runDoctor(env, { DSH_TEST_CIM_JSON: JSON.stringify([CIM_WATCHER, CIM_BRIDGE, CIM_UNRELATED]) });
    assert.match(out, /③ 进程与自启动/, "doctor 的进程段必须存在");
    assert.match(out, /实测进程\s*: watcher 1 个 \/ bridge 1 个/,
      `计数必须与 fake CIM 一致（旧实现恒 0/0）：\n${out}`);
    assert.match(out, /· watcher pid=1111 解释器=DeepSeek Harness\.exe 命令行=/,
      "必须打出 watcher 的 pid + 解释器名（下次取证一眼看出谁在跑）");
    assert.match(out, /· bridge pid=2222 解释器=DeepSeek Harness\.exe 命令行=/,
      "必须打出 bridge 的 pid + 解释器名（Electron 宿主下不是 node.exe）");
    assert.match(out, /dsh-bridge\.mjs/, "命令行摘要要能看出是哪个脚本");
    assert.ok(!/pid=3333/.test(out), "无关进程（node -e）不得被算成 watcher/bridge");
    // 平台覆盖要如实标注：否则"平台 darwin 却走 win32 扫描"根本没法解释
    assert.match(out, /平台\s*:.*win32.*DSH_SETUP_PLATFORM 覆盖/,
      "DSH_SETUP_PLATFORM 覆盖时 doctor 必须把这件事写在报告里");
  } finally { env.cleanup(); }
});

test("★ doctor：扫描不可用时显式打印「扫描不可用」，绝不输出会被读成「没有进程」的 0", () => {
  const env = makeEnv();
  try {
    const { out } = runDoctor(env, { DSH_TEST_CIM_FAIL: "1", DSH_TEST_CIM_JSON: "[]" });
    assert.match(out, /实测进程\s*: 扫描不可用/, `扫描失败必须如实说不可用：\n${out}`);
    assert.match(out, /不能\*\*当作|不能当作/, "要明确提示这条结论不能当「进程没在跑」的证据");
    assert.ok(!/实测进程\s*: watcher 0 个 \/ bridge 0 个/.test(out),
      "🔴 旧实现的核心假证据：扫描失败时输出 0/0 —— 这条绝不能再出现");
  } finally { env.cleanup(); }
});

// ─────────────────── ③ looksLikeWatcher / looksLikeBridge：补 Windows 分支 ───────────────────

test("★ looksLikeWatcher/looksLikeBridge：Windows 按 pid 查命令行（旧实现只用 ps ⇒ Windows 恒 false）", () => {
  const env = makeEnv();
  const fns = loadLookalike();
  // 环境（PATH 上的假 powershell + DSH_TEST_CMDLINE）必须在调用**执行期间**有效
  const withCmdline = (cmdline, fn) => withEnv({
    PATH: `${env.fakeBin}${path.delimiter}${process.env.PATH || ""}`,
    DSH_TEST_CMDLINE: cmdline,
    DSH_TEST_CIM_FAIL: undefined,
  }, fn);
  try {
    // watcher：Electron 宿主（process.execPath）+ dsh-setup.mjs run
    withCmdline('"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" "C:\\Users\\u\\.dsh-remote\\dsh-setup.mjs" run', () => {
      assert.equal(fns.looksLikeWatcher(5001), true, "Windows 上必须能认出 watcher（旧实现 ps 不存在 ⇒ 恒 false）");
      assert.equal(fns.looksLikeBridge(5001), false, "watcher 不能被当成 bridge");
    });

    // bridge：命令行走 Windows 反斜杠路径（Electron 宿主命名，非 node.exe）
    withCmdline('"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" "C:\\Users\\u\\.dsh-remote\\clients\\dsh-remote\\dsh-bridge.mjs"', () => {
      assert.equal(fns.looksLikeBridge(5002), true, "Windows 上必须能认出 bridge（clients\\dsh-remote + dsh-bridge.mjs）");
      assert.equal(fns.looksLikeWatcher(5002), false, "bridge 不能被当成 watcher（接管时会对它 SIGTERM）");
    });

    // PID 复用：pid 活着但命令行是无关进程 → 两个都必须是 false（否则会误杀一棵无关进程树）
    withCmdline('"C:\\Program Files\\nodejs\\node.exe" -e "setTimeout(() => {}, 120000)"', () => {
      assert.equal(fns.looksLikeWatcher(5003), false, "★认不出就绝不动（PID 复用安全）");
      assert.equal(fns.looksLikeBridge(5003), false, "★认不出就绝不动（PID 复用安全）");
    });

    // 取不到命令行（PowerShell 不可用）→ false（失败方向必须是"漏杀"）
    withEnv({ PATH: `${env.fakeBin}${path.delimiter}${process.env.PATH || ""}`, DSH_TEST_CIM_FAIL: "1", DSH_TEST_CMDLINE: undefined },
      () => {
        assert.equal(fns.looksLikeWatcher(5004), false, "取不到命令行 → 不认");
        assert.equal(fns.looksLikeBridge(5004), false, "取不到命令行 → 不认");
      });

    // 源码级：Windows 分支必须真的存在（这是本条修复的"为什么"）
    assert.match(SETUP_SRC, /if \(IS_WIN\) return windowsProcessCommandLine\(pid\);/,
      "processCommandLine 必须有 Windows 分支（Windows 没有 ps）");
  } finally { env.cleanup(); }
});

// ─────────────────── ④ pid 文件：只删自己的 + 失败留痕 ───────────────────

test("★ pid 文件归属：removePidFile 只在内容等于自己的 pid 时才删（旧实现无条件删 = 事故根因链第 2 步）", () => {
  const env = makeEnv();
  try {
    const fns = loadPidFileHelpers(env.relayDir);
    const file = path.join(env.relayDir, ".dsh-bridge.pid");

    fns.writePidFile(".dsh-bridge.pid", 4321);
    assert.equal(readFileSync(file, "utf8"), "4321", "writePidFile 应写入纯数字 pid");

    fns.removePidFile(".dsh-bridge.pid", 9999); // 别的实例的 pid
    assert.ok(existsSync(file), "★内容不等于自己的 pid → 一个字节都不许动（旧实现无条件删把孤儿活着的证据删掉）");
    assert.equal(readFileSync(file, "utf8"), "4321");

    fns.removePidFile(".dsh-bridge.pid", 4321); // 自己的
    assert.ok(!existsSync(file), "内容等于自己的 pid → 必须删掉");

    // 极端情况：文件已被别人改写/删除 → 不报错、不误删
    fns.writePidFile(".dsh-watcher.pid", 5555);
    fns.writePidFile(".dsh-watcher.pid", 6666); // 被改写
    fns.removePidFile(".dsh-watcher.pid", 5555);
    assert.equal(readFileSync(path.join(env.relayDir, ".dsh-watcher.pid"), "utf8"), "6666",
      "文件被改写后，旧 pid 的持有者不得删掉它");
  } finally { env.cleanup(); }
});

test("★ pid 文件写/删失败必须留痕（旧实现静默 catch ⇒ 文件'莫名消失'永远查不到原因）", () => {
  const env = makeEnv();
  try {
    const fns = loadPidFileHelpers(env.relayDir);
    const logFile = path.join(env.relayDir, ".dsh-setup-install.log");

    // 写失败：父目录不存在 → ENOENT
    fns.writePidFile(path.join("不存在目录", "x.pid"), 7);
    let log = readFileSync(logFile, "utf8");
    assert.match(log, /写 pid 文件失败/, "写失败必须留一行日志");
    assert.match(log, /ENOENT/, "日志要带错误码（否则还是查不到原因）");
    assert.match(log, /不存在目录/, "日志要带文件名");

    // 删失败：目标是个目录 → EISDIR
    mkdirSync(path.join(env.relayDir, "dir-as-pid.pid"));
    fns.removePidFile("dir-as-pid.pid");
    log = readFileSync(logFile, "utf8");
    assert.match(log, /删除 pid 文件失败/, "删失败也必须留一行日志");
    assert.match(log, /EISDIR|EPERM|EACCES/, "删失败日志要带错误码");
  } finally { env.cleanup(); }
});

test("★ run() 的 pid 接线：bridge 退出/man 退出清理都必须带 expectPid（源码契约）", () => {
  // 行为级覆盖不到 run()（要起真 watcher/bridge），按仓库既有手法锁源码接线。
  assert.ok(!/removePidFile\(BRIDGE_PID_FILE\);/.test(SETUP_SRC),
    "🔴 不得再无条件删 bridge pid 文件（事故根因链第 2 步）");
  assert.ok(!/removePidFile\(WATCHER_PID_FILE\);/.test(SETUP_SRC),
    "watcher pid 文件同样只删自己的");

  const exitAt = SETUP_SRC.indexOf('bridgeProc.on("exit"');
  assert.ok(exitAt > 0, "应能找到 bridge 子进程的 exit 接线");
  const exitBlock = SETUP_SRC.slice(exitAt, exitAt + 1200);
  assert.match(exitBlock, /removePidFile\(BRIDGE_PID_FILE, spawnedBridgePid\)/,
    "bridge 退出时只删**这个子进程**的 pid 文件（内容 == spawnedBridgePid）");

  const cleanupAt = SETUP_SRC.indexOf("const cleanup = () => {");
  assert.ok(cleanupAt > 0, "应能找到 watcher 的退出清理");
  const cleanupBlock = SETUP_SRC.slice(cleanupAt, cleanupAt + 1200);
  assert.match(cleanupBlock, /removePidFile\(WATCHER_PID_FILE, process\.pid\)/,
    "watcher 退出只删自己的 pid 文件");
  assert.match(cleanupBlock, /removePidFile\(BRIDGE_PID_FILE, childPid\)/,
    "watcher 退出只删自己子进程的 bridge pid 文件");

  const reapAt = SETUP_SRC.indexOf("removePidFile(BRIDGE_PID_FILE, leftover)");
  assert.ok(reapAt > 0, "回收上一任 bridge 后删 pid 文件时也要带 leftover（已经过 looksLikeBridge 校验）");
});

// ─────────────────── ⑤ bridge 自证：pid + 心跳新鲜度 ───────────────────

test("★ bridge 自证：启动写 pid、心跳拍节流刷新 heartbeat_at（供插件做第二存活判据）", () => {
  assert.match(BRIDGE_SRC, /persistBridgeState\(\{ pid: process\.pid, heartbeat_at: Date\.now\(\), device_id: DEVICE_ID, started_at: Date\.now\(\)/,
    "启动 reset 处必须写入 pid（插件据此判断 state.pid 是否活着）");
  assert.match(BRIDGE_SRC, /STATE_HEARTBEAT_MIN_MS = 10_000/, "心跳刷新要节流（≥10s，避免写盘过频）");
  assert.match(BRIDGE_SRC, /function stampBridgeHeartbeat\(\)/, "应有心跳刷新函数");
  const fn = BRIDGE_SRC.slice(
    BRIDGE_SRC.indexOf("function stampBridgeHeartbeat()"),
    BRIDGE_SRC.indexOf("// ---------- 安装来源 / 版本"),
  );
  assert.match(fn, /if \(now - lastStateHeartbeatAt < STATE_HEARTBEAT_MIN_MS\) return;/,
    "心跳刷新必须真的节流");
  assert.match(fn, /heartbeat_at: now/, "心跳刷新必须更新 heartbeat_at");

  const beatAt = BRIDGE_SRC.indexOf("const beat = () => {");
  assert.ok(beatAt > 0, "应能找到隧道心跳拍");
  const beatBlock = BRIDGE_SRC.slice(beatAt, beatAt + 700);
  assert.match(beatBlock, /stampBridgeHeartbeat\(\)/,
    "★心跳拍里必须调用自证刷新（否则状态文件永远停在启动那一刻）");
  // 2xx/4xx 语义不变：状态文件只是附加判据，写失败静默（persistBridgeState 内部已兜底）
  assert.match(BRIDGE_SRC, /\.dsh-bridge-state\.json/, "状态文件名必须保持不变（插件侧按这个名字读）");
});

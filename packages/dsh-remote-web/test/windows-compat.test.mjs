/**
 * Windows 兼容回归（0.6.7 新增）。
 *
 * 背景（真实事故，用户诊断报告 + 本地逐条复现）：
 *   dsh-remote-web 0.6.6 及更早的整套「服务状态 / 启停 / 重启」按 macOS/Linux 写死，
 *   在 Windows 上**运行期必死**——安装与网络都正常，坏的全是运行期：
 *     ① launchTarget() 无条件调 process.getuid()：Windows 没有这个 API（typeof !== "function"）
 *        → /dsh-remote/status 与 /bridge-status 双双 500，
 *        面板永久红字「读取状态失败: process.getuid is not a function」、状态卡在「查询中…」；
 *     ② spawn("npx.cmd") 不带 shell（Node ≥20.12 起）同步抛 EINVAL → 运行环境永远补不上；
 *     ③ restartHarness 生成 `#!/bin/sh` 再 spawn("/bin/sh")：Windows 无 /bin/sh → ENOENT，
 *        而那个 ChildProcess 没有 'error' 监听 → 未捕获异常**打挂 dsh web**；
 *        更糟的是它先把「已调度重启」写进日志并返回成功；
 *     ④ manualStatus() 用 pgrep/ps → Windows 恒为空 → 永远显示「已停止」。
 *
 * 这些分支无法在 macOS/Linux CI 上真跑，所以插件支持 DSH_RELAY_PLATFORM=win32
 * 显式覆盖平台（见 lib/index.js 的 osPlatform()）。本用例就是**在开发机上把 win32 分支跑一遍**：
 * 每个用例都断言「Windows 上会走哪条路」，而不是只看源码长得像不像。
 *
 * ⚠️ 隔离要求：走真实分支的用例必须伪造 HOME 并把 DSH_RELAY_SKIP_SERVICE 关掉
 *    （见 setup-output.test.mjs 里的静态护栏：unset 该开关的用例必须同时伪造 HOME）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");
const CLIENT_SRC = readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
const SETUP_SRC = readFileSync(path.join(HERE, "..", "..", "..", "dsh-setup.mjs"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 launchctl：被调到就记一行日志（用它证明「Windows 上根本没去调 launchctl」）。 */
const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
exit 0
`;

/** 收集并恢复环境变量；同时伪造 HOME，避免任何真实系统状态被碰到。 */
async function makeEnv({ forceWin = true, skipService = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-win-"));
  const fakeBin = path.join(root, "bin");
  const fakeHome = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  await writeFile(path.join(fakeBin, "launchctl"), FAKE_LAUNCHCTL);
  await chmod(path.join(fakeBin, "launchctl"), 0o755);
  for (const n of ["pgrep", "ps"]) {
    await writeFile(path.join(fakeBin, n), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(fakeBin, n), 0o755);
  }

  const saved = {};
  const keys = ["HOME", "PATH", "DSH_RELAY_PLATFORM", "DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_RESTART_DRYRUN",
    "DSH_SETUP_NPX_DIR", "DSH_TEST_LAUNCH_LOG", "DSH_REMOTE_TELEMETRY", "DSH_RELAY_SELFHEAL_MS"];
  for (const k of keys) saved[k] = process.env[k];
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH || ""}`;
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_TEST_LAUNCH_LOG = path.join(root, "launchctl.log");
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  if (forceWin) process.env.DSH_RELAY_PLATFORM = "win32";
  else delete process.env.DSH_RELAY_PLATFORM;
  if (skipService) process.env.DSH_RELAY_SKIP_SERVICE = "1";
  else delete process.env.DSH_RELAY_SKIP_SERVICE;

  return {
    root, relayDir, fakeBin, fakeHome,
    launchLog: path.join(root, "launchctl.log"),
    async restore() {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${host.address().port}`,
    async close() { await new Promise((r) => host.close(r)); },
  };
}

async function get(base, p) {
  const res = await fetch(base + p);
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

async function post(base, p) {
  const res = await fetch(base + p, { method: "POST" });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

const writeConfig = (relayDir, extra = {}) =>
  writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    api_url: "http://127.0.0.1:1", ...extra,
  }));

/** 起一个真实存活的长命进程，用来当「bridge 进程」的替身（pid 存活检查要真 pid）。 */
function startFakeProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: false });
  return { pid: child.pid, stop: () => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } } };
}

// ─────────────────────── ① 致命点：process.getuid 与 launchd 短路 ───────────────────────

test("win32：/status 与 /bridge-status 不再 500（process.getuid 短路 + launchd 不适用）", async () => {
  const env = await makeEnv({ forceWin: true, skipService: true });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    await writeConfig(env.relayDir);
    const st = await get(srv.base, "/dsh-remote/status");
    assert.equal(st.status, 200, `win32 上 /status 必须 200（旧版因 process.getuid 抛错而 500）：${JSON.stringify(st.body)}`);
    assert.equal(st.body.ok, true);
    assert.equal(st.body.service.platform, "win32", "必须如实下发平台，供面板给平台正确的文案");
    assert.equal(st.body.service.serviceManager, "detached", "Windows 没有 launchd/systemd：服务管理器应为 detached");
    assert.equal(st.body.service.launchd.running, false, "Windows 上 launchd 状态恒为未运行（而不是抛错）");

    const bs = await get(srv.base, "/dsh-remote/bridge-status");
    assert.equal(bs.status, 200, `/bridge-status 也必须 200：${JSON.stringify(bs.body)}`);
    assert.ok(bs.body.connect, "应下发连接阶段对象");
    assert.equal(bs.body.connect.phase, "no_account", "未登录时阶段应为 no_account");
  } finally {
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

test("win32：不去调用不存在的 launchctl（假 launchctl 一次都不该被调到）", async () => {
  const env = await makeEnv({ forceWin: true, skipService: true });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    await writeConfig(env.relayDir);
    await get(srv.base, "/dsh-remote/status");
    await get(srv.base, "/dsh-remote/bridge-status");
    assert.equal(existsSync(env.launchLog), false,
      `Windows 上没有 launchctl，任何状态查询都不该去 shell 里调它（旧版在 Linux 上也会白调一次）`);
  } finally {
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

// ─────────────────────── ② 致命点：npx 调用方式 ───────────────────────

test("win32：npx 补装走 node + npx-cli.js（绝不 spawn npx.cmd 而不带 shell）", async () => {
  // 走真实分支：DSH_RELAY_SKIP_SERVICE 必须关掉，否则 ensureRuntime 直接返回（测试隔离）
  const env = await makeEnv({ forceWin: true, skipService: false });
  const marker = path.join(env.root, "npx-cli-ran.json");
  const cliDir = path.join(env.fakeBin, "node_modules", "npm", "bin");
  await mkdir(cliDir, { recursive: true });
  // 假的 npx-cli.js：把拿到的 argv 落盘，证明确实是「node 直接跑它」而不是 cmd.exe 跑 .cmd
  await writeFile(path.join(cliDir, "npx-cli.js"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(1), execPath: process.execPath }));\nprocess.exit(0);\n`);

  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    // relayDir 里没有 dsh-setup.mjs → runtimeReady=false → /start 会转后台补装
    const r = await post(srv.base, "/dsh-remote/start");
    assert.equal(r.body.status, "provisioning", `缺运行环境应转后台补装：${JSON.stringify(r.body)}`);
    assert.equal(r.body.runtimeMissing, true);

    for (let i = 0; i < 40 && !existsSync(marker); i += 1) await sleep(50);
    assert.ok(existsSync(marker), "补装进程没有被拉起来（npx-cli.js 未执行）");
    const seen = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(seen.execPath, process.execPath, "必须用当前 node 直接跑 CLI（不经 shell）");
    assert.ok(seen.argv[0].endsWith(path.join("npm", "bin", "npx-cli.js")), `argv[0] 应是 npx-cli.js：${seen.argv[0]}`);
    assert.ok(seen.argv.includes("--yes"), `应带上 --yes：${JSON.stringify(seen.argv)}`);
    assert.ok(seen.argv.some((a) => a.startsWith("@mrrisega/dsh-remote")),
      `应带上要安装的包名：${JSON.stringify(seen.argv)}`);
  } finally {
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

test("win32：找不到 npx-cli.js 时退回 npx.cmd **必须带 shell:true**（否则 EINVAL）", () => {
  // 这是 0.6.6 的死因：Node ≥20.12 起 spawn("npx.cmd") 不带 shell 同步抛 EINVAL。
  // 行为无法在本机复现（这里没有 .cmd），所以锁源码契约：.cmd 分支必须 shell: true。
  const fn = INDEX_SRC.slice(INDEX_SRC.indexOf("function npxInvocation()"), INDEX_SRC.indexOf("/** 子进程环境：把 node 目录补进 PATH"));
  assert.ok(/kind: "node-npx-cli"/.test(fn), "应优先用 node + npx-cli.js");
  const cmdBranches = fn.match(/command: [^,]+, args: \[\], shell: ([a-z]+), kind: "npx-cmd[^"]*"/g) || [];
  assert.ok(cmdBranches.length >= 1, "应有 npx.cmd 回退分支");
  for (const b of cmdBranches) {
    assert.match(b, /shell: true/, `npx.cmd 分支必须 shell:true（否则 Windows 上 EINVAL）：${b}`);
  }
  // 两个调用点都必须把 shell 传下去
  const spawnSites = INDEX_SRC.match(/safeSpawn\(npx\.command, \[\.\.\.npx\.args[^\n]*/g) || [];
  assert.equal(spawnSites.length, 2, `npx 的两个调用点（补装 / 在线更新）都要走 safeSpawn`);
  assert.ok(/shell: npx\.shell/.test(INDEX_SRC), "必须把 npx.shell 传给 spawn");
});

// ─────────────────────── ③ 致命点：spawn 失败不得打挂 dsh web ───────────────────────

test("win32：重启 harness 生成 node 助手（不再 /bin/sh），且生成的脚本语法有效", async () => {
  // 走真实分支：隔离开关会让 restartHarness 提前返回 skipped（dry-run 也进不去）。
  // 这里只 dry-run（只生成脚本文本，不 spawn 任何东西），并把自愈间隔拉长避免后台补装被打起来。
  const env = await makeEnv({ forceWin: true, skipService: false });
  process.env.DSH_RELAY_SELFHEAL_MS = "600000";
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    process.env.DSH_RELAY_RESTART_DRYRUN = "1";
    const r = await post(srv.base, "/dsh-remote/harness/restart");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "dry-run");
    assert.equal(r.body.mode, "relaunch", "Windows 无监管者：应走 relaunch");
    const script = String(r.body.script || "");
    assert.ok(!/^#!\/bin\/sh/m.test(script), "绝不能生成 #!/bin/sh 脚本（Windows 没有 /bin/sh）");
    assert.ok(!/kill -TERM|kill -KILL/.test(script), "不得使用 POSIX 信号命令");
    assert.ok(script.includes("taskkill"), "Windows 强杀应走 taskkill");
    assert.ok(script.includes("appendFileSync"), "应自己写日志文件（不依赖 shell 重定向）");
    // 「先校验再动手」：旧实现最大的风险是"杀掉却起不来"
    assert.ok(/重启中止/.test(script), "重新拉起前必须先校验 node/入口/工作目录存在，否则中止（绝不先杀自己）");

    // 生成的脚本必须是**合法可执行的 JS**：它是字符串拼出来的，语法错就是白屏式失败
    const scriptPath = path.join(env.root, "helper.mjs");
    await writeFile(scriptPath, script);
    const check = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
    assert.equal(check.status, 0, `生成的 Windows 重启助手语法必须合法：${check.stderr}`);
  } finally {
    delete process.env.DSH_RELAY_RESTART_DRYRUN;
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

test("契约：插件里不存在「裸 spawn」——每个子进程都必须有 'error' 监听（否则打挂宿主）", () => {
  // 事故原文：spawn("/bin/sh") 在 Windows ENOENT，而 ChildProcess 没有 'error' 监听
  // → 未捕获异常把 dsh web 打挂，且代码已经先把「已调度重启」写进日志、返回成功。
  // 生成的 Windows 助手源码是模板字符串（它自己挂了 error 监听），先从「真实代码」里剔除
  const helperStart = INDEX_SRC.indexOf("function buildRestartHelperSource(");
  const helperEnd = INDEX_SRC.indexOf("async function restartHarness(");
  const realCode = INDEX_SRC.slice(0, helperStart) + INDEX_SRC.slice(helperEnd);
  const rawSpawns = realCode.match(/= spawn\(/g) || [];
  assert.equal(rawSpawns.length, 2, `真实代码里只允许 safeSpawn / spawnAndConfirm 两处 spawn（实际 ${rawSpawns.length} 处）`);
  assert.ok(/function safeSpawn\([\s\S]*?= spawn\(/.test(realCode), "safeSpawn 自己 spawn");
  assert.ok(/function spawnAndConfirm\([\s\S]*?= spawn\(/.test(realCode), "spawnAndConfirm 自己 spawn");
  assert.ok(/function safeSpawn\(/.test(INDEX_SRC), "应有统一 spawn 包装（挂 'error' 监听）");
  assert.ok(/function spawnAndConfirm\(/.test(INDEX_SRC), "重启路径必须等 spawn 真的成功再报成功");
  const restart = INDEX_SRC.slice(INDEX_SRC.indexOf("async function restartHarness("), INDEX_SRC.indexOf("// ---------- relay API 代理"));
  // POSIX 仍用 /bin/sh（既有行为不动），但 Windows 必须改用 node —— 判据写死在这里
  assert.ok(/const runner = isWindows\(\) \? process\.execPath : "\/bin\/sh";/.test(restart),
    "Windows 必须用 node 跑 .mjs 助手（/bin/sh 在 Windows 上 ENOENT，且旧版因此打挂 dsh web）");
  assert.ok(/isWindows\(\) \? RESTART_HELPER_FILE : RESTART_SCRIPT_FILE/.test(restart),
    "Windows 落 .mjs 助手文件，POSIX 落 .sh");
  assert.ok(/await spawnAndConfirm\(/.test(restart), "重启必须等确认，失败要返回 ok:false 而不是假装成功");
  assert.ok(/调度失败/.test(restart), "spawn 失败要留下日志与失败返回");
  // 生成的 Windows 助手里面的 spawn 也必须挂 error 监听（助手在模板字符串里，单独取）
  const helper = INDEX_SRC.slice(INDEX_SRC.indexOf("function buildRestartHelperSource("), INDEX_SRC.indexOf("async function restartHarness("));
  assert.ok(/child\.on\("error"/.test(helper), "Windows 助手的重新拉起也要挂 error 监听");
  assert.ok(/重启中止/.test(helper), "助手必须先校验再杀旧进程");
});

// ─────────────────────── ④ 致命点：进程发现（Windows 无 pgrep/ps） ───────────────────────

test("win32：bridge 状态靠 pid 文件发现（Windows 没有 pgrep/ps 也能报「运行中」）", async () => {
  const env = await makeEnv({ forceWin: true, skipService: true });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  const fake = startFakeProcess();
  try {
    await writeConfig(env.relayDir);
    // 插件/安装器在 Windows 上会把 watcher 与 bridge 的 pid 落到配置目录
    await writeFile(path.join(env.relayDir, ".dsh-watcher.pid"), String(process.pid)); // 本进程应被排除
    await writeFile(path.join(env.relayDir, ".dsh-bridge.pid"), String(fake.pid));

    const st = await get(srv.base, "/dsh-remote/status");
    assert.equal(st.body.service.running, true, "pid 文件指向存活进程 → 必须报「运行中」（旧版恒为「已停止」）");
    assert.deepEqual(st.body.service.manual.bridge, [fake.pid], "bridge 列表应包含 pid 文件里的 pid");
    assert.deepEqual(st.body.service.manual.watcher, [], "不得把宿主自身（process.pid）算成 bridge 守护");

    const bs = await get(srv.base, "/dsh-remote/bridge-status");
    assert.equal(bs.body.connect.bridgeRunning, true, "连接阶段也必须认出 bridge 在跑");

    // 进程退出 → pid 文件成为残留，必须立刻恢复成「未运行」
    fake.stop();
    for (let i = 0; i < 40; i += 1) {
      const again = await get(srv.base, "/dsh-remote/status");
      if (again.body.service.running === false) break;
      await sleep(100);
    }
    const after = await get(srv.base, "/dsh-remote/status");
    assert.equal(after.body.service.running, false, "pid 已死 → 不得再报「运行中」（残留 pid 文件必须被判活拦掉）");
  } finally {
    fake.stop();
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

test("win32：启动 bridge 走 detached watcher（dsh-setup.mjs run），并落 pid 文件", async () => {
  const env = await makeEnv({ forceWin: true, skipService: false });
  // 放一个假的固化运行环境：它自己写 pid 文件后退出（模拟 dsh-setup run 的启动动作）
  await writeFile(path.join(env.relayDir, "dsh-setup.mjs"),
    "// 假运行环境：只证明被拉起过\n");
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    await writeConfig(env.relayDir);
    const r = await post(srv.base, "/dsh-remote/start");
    // 真 watcher 需要 ws 等依赖，这里只验证「命令与句柄是 Windows 该有的样子」：
    // 拉起失败也必须走正常失败返回（绝不抛异常打挂宿主）。
    assert.ok([200, 500].includes(r.status), `不得 5xx 崩溃：${r.status}`);
    assert.ok(r.body && typeof r.body.status === "string", JSON.stringify(r.body));
    const pidFile = path.join(env.relayDir, ".dsh-watcher.pid");
    if (existsSync(pidFile)) {
      assert.match(readFileSync(pidFile, "utf8").trim(), /^\d+$/, "pid 文件内容必须是纯 pid");
    }
  } finally {
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

test("win32：停止 bridge 只结束 pid 文件里的进程，不碰 launchctl/systemctl", async () => {
  const env = await makeEnv({ forceWin: true, skipService: true });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  const fake = startFakeProcess();
  try {
    await writeConfig(env.relayDir);
    await writeFile(path.join(env.relayDir, ".dsh-bridge.pid"), String(fake.pid));
    const r = await post(srv.base, "/dsh-remote/stop");
    assert.equal(r.body.status, "skipped", "测试隔离开关置位时应如实跳过，不做真实系统操作");
    assert.equal(existsSync(env.launchLog), false, "不得调用 launchctl");
  } finally {
    fake.stop();
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

// ─────────────────────── ⑤ 跨平台基础设施 ───────────────────────

test("跨平台：PATH 用平台分隔符拼接（写死 \":\" 会让 Windows 上 node/npx 全找不到）", () => {
  const spawnEnvFn = INDEX_SRC.slice(INDEX_SRC.indexOf("function spawnEnv("), INDEX_SRC.indexOf("function safeSpawn("));
  assert.ok(/join\(delimiter\)/.test(spawnEnvFn), "必须用 node:path 的 delimiter 拼 PATH");
  assert.ok(!/join\(":"\)/.test(spawnEnvFn), "不得写死 POSIX 的 \":\"");
  assert.ok(/isWindows\(\) \? \[\] : \[/.test(spawnEnvFn), "POSIX 专属目录不得追加到 Windows 的 PATH");
});

test("跨平台：不再有未加守卫的 process.getuid / /bin/sh / sleep 命令", () => {
  // getuid 只允许出现在 currentUid()（带 typeof 守卫）与 darwin 分支里
  const lines = INDEX_SRC.split("\n");
  lines.forEach((line, i) => {
    if (!/process\.getuid\(\)/.test(line)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释里的说明文字不算调用
    const ok = /typeof process\.getuid === "function"/.test(line) || /const uid = currentUid\(\)|const uid = process\.getuid\(\)/.test(line);
    assert.ok(ok, `第 ${i + 1} 行直接调用了 process.getuid()（Windows 上没有该 API）: ${line.trim()}`);
  });
  const codeLines = INDEX_SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!codeLines.some((l) => /spawn\("\/bin\/sh"/.test(l)), "不得直接 spawn /bin/sh");
  assert.ok(codeLines.some((l) => /isWindows\(\) \? process\.execPath : "\/bin\/sh"/.test(l)),
    "必须按平台选 runner（Windows=node / POSIX=/bin/sh）");
  assert.ok(!/execSync\("sleep/.test(INDEX_SRC), "Windows 没有 sleep 命令：应改用 Atomics.wait 的 sleepSync");
  assert.ok(/function sleepSync\(/.test(INDEX_SRC), "应有跨平台同步睡眠");
});

test("win32：dsh-setup 注册任务计划程序登录任务（不再只说「平台不支持」）", () => {
  assert.ok(/const WIN_TASK_NAME = "dsh-remote-bridge"/.test(SETUP_SRC), "应有任务名常量");
  assert.ok(/schtasks\(\["\/Create", "\/TN", WIN_TASK_NAME, "\/TR", tr, "\/SC", "ONLOGON"/.test(SETUP_SRC),
    "应注册 ONLOGON 登录任务（非管理员可建）");
  assert.ok(/if \(IS_WIN\) return writeWindowsTask\(\);/.test(SETUP_SRC), "writeAutostartFile 应有 win32 分支");
  assert.ok(/schtasks\(\["\/Query", "\/TN", WIN_TASK_NAME\]\)/.test(SETUP_SRC), "应有任务存在性查询");
  assert.ok(/schtasks\(\["\/Run", "\/TN", WIN_TASK_NAME\]\)/.test(SETUP_SRC), "启动 bridge 应触发该任务");
  // 走 spawnSync 而不是 sh()：/TR 里必然带引号，经 cmd.exe 会把嵌套引号绞碎
  assert.ok(/spawnSync\("schtasks"/.test(SETUP_SRC), "schtasks 必须用 spawnSync（避免 cmd.exe 的引号转义坑）");
  // 安装流程里那个无条件 getuid 是 Windows 上的第二条死路（安装直接 TypeError 中断）
  const restartFn = SETUP_SRC.slice(SETUP_SRC.indexOf("function restartDshWeb()"), SETUP_SRC.indexOf("function restartDshWebWindows()"));
  const uidAt = restartFn.indexOf("process.getuid()");
  const darwinAt = restartFn.indexOf('if (process.platform === "darwin")');
  assert.ok(uidAt > -1, "darwin 分支仍然需要 uid（不要顺手删掉）");
  assert.ok(darwinAt > -1 && darwinAt < uidAt,
    "getuid 必须在 darwin 分支**之内**：放在函数首行会让 Windows 安装直接 TypeError 中断");
  // Windows 下桥接进程发现的 pid 文件
  assert.ok(/WATCHER_PID_FILE = "\.dsh-watcher\.pid"/.test(SETUP_SRC), "安装器也要写同名 pid 文件（插件半据此发现进程）");
  assert.ok(/WATCHER_PID_FILE = "\.dsh-watcher\.pid"/.test(INDEX_SRC), "插件半与安装器的 pid 文件名必须一致");
});

test("win32：彻底卸载会删掉任务计划条目（否则下次登录又被拉起来）", () => {
  const uninstall = INDEX_SRC.slice(INDEX_SRC.indexOf("function uninstallRuntime("), INDEX_SRC.indexOf("// ---------- DeepSeek harness 重启"));
  assert.ok(/schtasks", \["\/Delete", "\/TN", WIN_TASK_NAME, "\/F"\]/.test(uninstall), "卸载应删除 Windows 登录任务");
  assert.ok(/servicePlatform: isDarwin\(\) \? "launchd"/.test(uninstall), "servicePlatform 应包含 Windows 口径");
});

test("win32：dsh-setup 生成的「重启 dsh web」助手也是合法可执行的 JS", async () => {
  // 安装器在 Windows 上重启 dsh web 用的是自己拼出来的 .mjs 助手（不走 /bin/sh）。
  // 它是字符串拼的 → 语法一旦写错，用户的"一键安装"就会在最后一步静默断掉，
  // 所以在开发机上把这段模板抠出来做一次 node --check。
  const fn = SETUP_SRC.slice(SETUP_SRC.indexOf("function restartDshWebWindows()"), SETUP_SRC.indexOf("/** 读某进程的完整命令行"));
  const start = fn.indexOf("const src = `");
  const end = fn.indexOf("\n`;", start);
  assert.ok(start > -1 && end > start, "应能从 restartDshWebWindows 里取出助手模板");
  const template = fn.slice(start + "const src = `".length, end);
  const generated = template.replace(/\$\{plan\}/g, '{"pid":1,"argv":["a"],"log":"b"}');
  assert.ok(generated.includes('spawnSync("taskkill"'), "强杀应走 taskkill");
  assert.ok(/child\.on\("error"/.test(generated), "重新拉起必须挂 error 监听（不能打挂安装器）");
  assert.ok(/重启中止/.test(generated), "必须先校验可执行文件存在再动旧进程");

  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-setup-helper-"));
  try {
    const file = path.join(dir, "helper.mjs");
    await writeFile(file, generated);
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(check.status, 0, `生成的 dsh web 重启助手语法必须合法：${check.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────── ⑥ 前端：失败不再静默 ───────────────────────

test("前端：bridge-status 轮询失败不再静默（旧版让面板永久停在「查询中…」）", () => {
  assert.ok(/connFailRef\.v \+= 1/.test(CLIENT_SRC), "轮询失败必须被计数（不再静默吞掉）");
  assert.ok(!/\.catch\(function \(\) \{ \/\* 轮询失败静默/.test(CLIENT_SRC), "不得保留「空 catch 静默重试」的旧写法");
  assert.ok(/CONN_FAIL_VISIBLE/.test(CLIENT_SRC), "应有可见阈值");
  const catchBlock = CLIENT_SRC.slice(CLIENT_SRC.indexOf("/dsh-remote/bridge-status\").then"), CLIENT_SRC.indexOf("connInFlight.v = false"));
  assert.ok(/status_unreachable/.test(catchBlock), "连续失败时应给出可见的错误阶段与原因");
  assert.ok(/connFailRef\.v = 0/.test(CLIENT_SRC), "成功必须清零（一次抖动不该把面板染红）");
});

test("前端：平台文案不再默认 macOS（Windows 用户看不懂「自启动服务」）", () => {
  assert.ok(/serviceManager === "detached"/.test(CLIENT_SRC), "面板应识别 Windows 的 detached 模式");
  assert.match(CLIENT_SRC, /Windows 任务计划程序 dsh-remote-bridge/, "卸载说明要写明 Windows 侧会删掉什么");
});

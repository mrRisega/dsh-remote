// 「插件市场装完 → bridge 起不来」回归（0.6.2）。
//
// 现场（用户机器，2026-09）：
//   市场只装了「插件半」（dsh-remote-ui / dsh-remote-web），桌面运行环境半
//   （固化运行时 <relayDir>/dsh-setup.mjs + clients + ws）从未装上；
//   用户登录那一刻 /dsh-remote/login 与面板「启动 bridge」都会调 startBridge()，
//   旧实现无条件写 plist（ProgramArguments 指向并不存在的 dsh-setup.mjs）并 bootstrap
//   → launchd KeepAlive 无限重拉：日志 20+ 次 MODULE_NOT_FOUND，`runs = 23 / last exit code = 1`。
//   更糟的是崩溃循环中 `launchctl list` 的 PID 列会闪现已死 pid（本机实测 `40213 1`），
//   旧 launchdStatus 据此谎报 running=true → scheduleRuntime 判定「已在运行」直接停摆，
//   自动补装（ensureRuntime）永不执行，用户永远恢复不了。
//
// 本用例锁死五点（每点对应一处修复）：
//   1. launchdStatus：print 成功时以 state 为准，绝不回退 list（崩溃循环不再谎报运行中）；
//   2. startBridge：运行环境缺失时拒绝 bootstrap，不生成指向空路径的 plist，改为后台补装；
//   3. scheduleRuntime：运行环境检查先于「服务是否在跑」，并摘除失效自启动（止住崩溃循环）；
//   4. apply()：插件加载即开始补装运行环境——不再等用户先登录（市场安装路径的第一步）；
//   5. 正常路径不受影响：运行环境就绪时照常 bootstrap（fake launchctl 全程接管，不碰真机）。
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（固定 sleep 在整包并行/高负载下会假失败）。 */
async function waitFor(fn, { timeout = 4000, step = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 假 launchctl：把每次调用记进日志，并按环境变量回放 print/list 的输出。 */
const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
case "$1" in
  print)
    if [ -n "$DSH_TEST_PRINT_FAIL" ]; then printf 'Could not find service\\n'; exit 113; fi
    printf 'state = %s\\n' "$DSH_TEST_STATE"
    printf 'runs = %s\\n' "$DSH_TEST_RUNS"
    printf 'last exit code = %s\\n' "$DSH_TEST_EXIT"
    printf 'active count = 0\\n'
    ;;
  list)
    printf '%s\\n' "$DSH_TEST_LIST"
    ;;
esac
exit 0
`;

/** 假 npx：只记录被调用的参数与 npm 源，绝不做真实安装。 */
const FAKE_NPX = `#!/bin/sh
printf '%s|%s\\n' "$*" "$npm_config_registry" >> "$DSH_TEST_NPX_LOG"
exit 0
`;

/**
 * 搭建隔离环境：假 HOME（plist 落在这里）+ 假 launchctl/pgrep/ps/npx + 临时 relayDir。
 * 调用方负责在 finally 里 restore()。
 */
async function setup({ state = "running", runs = 0, exitCode = 0, list = "", printFail = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-runtime-prov-"));
  const fakeHome = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(relayDir, { recursive: true });

  const launchLog = path.join(root, "launchctl.log");
  const npxLog = path.join(root, "npx.log");
  for (const [name, script] of [
    ["launchctl", FAKE_LAUNCHCTL],
    ["pgrep", "#!/bin/sh\nexit 1\n"],
    ["ps", "#!/bin/sh\nexit 0\n"],
    ["npx", FAKE_NPX],
  ]) {
    await writeFile(path.join(fakeBin, name), script);
    await chmodSync(path.join(fakeBin, name), 0o755);
  }

  const saved = {};
  for (const k of ["HOME", "PATH", "DSH_TEST_LAUNCH_LOG", "DSH_TEST_NPX_LOG", "DSH_TEST_STATE", "DSH_TEST_RUNS",
    "DSH_TEST_EXIT", "DSH_TEST_LIST", "DSH_TEST_PRINT_FAIL", "DSH_RELAY_SKIP_SERVICE", "DSH_SETUP_NPX_DIR",
    "DSH_RELAY_SELFHEAL_MS"]) {
    saved[k] = process.env[k];
  }
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = launchLog;
  process.env.DSH_TEST_NPX_LOG = npxLog;
  process.env.DSH_TEST_STATE = state;
  process.env.DSH_TEST_RUNS = String(runs);
  process.env.DSH_TEST_EXIT = String(exitCode);
  process.env.DSH_TEST_LIST = list;
  if (printFail) process.env.DSH_TEST_PRINT_FAIL = "1"; else delete process.env.DSH_TEST_PRINT_FAIL;
  process.env.DSH_SETUP_NPX_DIR = fakeBin; // 假 npx 优先（显式覆盖 > 当前 node 目录）
  delete process.env.DSH_RELAY_SKIP_SERVICE; // 走「真实」分支，但系统命令全是假的
  process.env.DSH_RELAY_SELFHEAL_MS = "5000"; // 除非用例自己调小，否则 watcher 不参与

  return {
    root, fakeHome, fakeBin, relayDir, launchLog, npxLog,
    plistPath: path.join(fakeHome, "Library", "LaunchAgents", "com.dshremote.bridge.plist"),
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * 装载插件路由（HOME/PATH 已由 setup 指向假环境）。
 * ctx.effect 的返回值即 disposer（卸载自愈 watcher 等定时器）——必须收集并在用例结束
 * 时调用：否则前序用例的自愈定时器会跨用例继续跑，用 ap 到的 HOME 去摘后一个用例的 plist。
 */
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
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

/** 写一份最小配置（api_url 指向必然拒连的本地端口，避免测试期间访问真实中继）。 */
async function writeConfig(relayDir, extra = {}) {
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", api_url: "http://127.0.0.1:1",
    ...extra,
  }));
}

/** 预置「正在安装中」标记（pid 用当前进程 → 不会被 apply 的残留清理误删）→ 挡住真实 npx。 */
async function plantInstallMarker(relayDir) {
  await writeFile(path.join(relayDir, ".dsh-setup-installing"), JSON.stringify({ pid: process.pid, at: Date.now() }));
}

const readOrEmpty = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };
const exists = (p) => existsSync(p);

test("崩溃循环不再谎报「运行中」：print=spawn scheduled + list 闪现已死 pid → running=false、crashing=true", async () => {
  // 复刻现场：launchctl list 报 `40213 1 com.dshremote.bridge`（进程其实早没了）
  const env = await setup({ state: "spawn scheduled", runs: 23, exitCode: 1, list: "999998\t1\tcom.dshremote.bridge" });
  try {
    await writeConfig(env.relayDir);
    await plantInstallMarker(env.relayDir); // 运行环境缺失 + 正在补装
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.service.running, false, "崩溃循环中 list 的瞬时 pid 绝不能被当成「运行中」");
      assert.equal(st.service.launchd.running, false);
      assert.equal(st.service.launchd.pid, null, "不应回传已死进程的 pid");
      assert.equal(st.service.launchd.crashing, true, "state≠running + lastExit≠0 → 崩溃循环");
      assert.equal(st.service.launchd.runs, 23);
      assert.equal(st.service.launchd.lastExitCode, 1);
      assert.equal(st.service.runtimeReady, false, "缺 dsh-setup.mjs → 运行环境未就绪（面板据此提示补装中）");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

test("print 不可用时回退 list：pid 已死 → 不报运行；pid 存活 → 报运行", async () => {
  const dead = await setup({ printFail: true, list: "999998\t1\tcom.dshremote.bridge" });
  try {
    await writeConfig(dead.relayDir);
    await plantInstallMarker(dead.relayDir);
    const routes = boot(dead.relayDir);
    const { host, base } = await serve(routes);
    try {
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.service.launchd.running, false, "回退路径必须校验 pid 存活（999998 不存在）");
    } finally { host.close(); routes.dispose(); }
  } finally { await dead.restore(); }

  const alive = await setup({ printFail: true, list: `${process.pid}\t0\tcom.dshremote.bridge` });
  try {
    await writeFile(path.join(alive.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeConfig(alive.relayDir);
    const routes = boot(alive.relayDir);
    const { host, base } = await serve(routes);
    try {
      const st = await (await fetch(`${base}/dsh-remote/status`)).json();
      assert.equal(st.service.launchd.running, true, "真实存活 pid → 正常运行");
    } finally { host.close(); routes.dispose(); }
  } finally { await alive.restore(); }
});

test("运行环境缺失 → /dsh-remote/start 拒绝 bootstrap：不生成指向空路径的 plist，转为后台补装", async () => {
  const env = await setup({ state: "spawn scheduled", runs: 3, exitCode: 1 });
  try {
    await writeConfig(env.relayDir);
    await plantInstallMarker(env.relayDir);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const res = await fetch(`${base}/dsh-remote/start`, { method: "POST" });
      const body = await res.json();
      assert.equal(body.ok, false, "运行环境缺失时不得报「已启动」");
      assert.equal(body.status, "provisioning");
      assert.equal(body.runtimeMissing, true);
      assert.match(String(body.detail), /运行环境|自动安装/);
      assert.equal(exists(env.plistPath), false, "绝不能写一个指向不存在脚本的 plist（旧版崩溃循环的根源）");
      const log = await readOrEmpty(env.launchLog);
      assert.ok(!log.includes("bootstrap"), "不得 bootstrap：实际调用 " + log);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

test("自愈：崩溃循环 + 运行环境缺失 → 摘除失效自启动（bootout+删 plist）并转入补装", async () => {
  const env = await setup({ state: "spawn scheduled", runs: 23, exitCode: 1, list: "999998\t1\tcom.dshremote.bridge" });
  try {
    await writeConfig(env.relayDir);
    await plantInstallMarker(env.relayDir);
    // 现场同款失效自启动：ProgramArguments 指向并不存在的 dsh-setup.mjs
    await mkdir(path.dirname(env.plistPath), { recursive: true });
    await writeFile(env.plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshremote.bridge</string>
  <key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${path.join(env.relayDir, "dsh-setup.mjs")}</string><string>run</string></array>
</dict></plist>`);
    process.env.DSH_RELAY_SELFHEAL_MS = "200"; // 把 12s 轮询压到 200ms，亚秒级验证
    const routes = boot(env.relayDir);
    await waitFor(async () => (await readOrEmpty(env.launchLog)).includes("bootout"));
    const log = await readOrEmpty(env.launchLog);
    assert.ok(log.includes("bootout"), "崩溃循环的作业已加载在 launchd 里，只删 plist 无效，必须 bootout：实际 " + log);
    assert.equal(exists(env.plistPath), false, "失效自启动文件应被摘除");
    const installLog = await readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log"));
    assert.match(installLog, /摘除失效自启动/, "应留下可诊断的日志");
    routes.dispose();
  } finally { await env.restore(); }
});

test("apply() 即开始补装运行环境（市场安装路径，无需先登录）", async () => {
  const env = await setup();
  try {
    // 只有插件半：没有 dsh-setup.mjs，也没有任何账号配置
    const routes = boot(env.relayDir);
    await waitFor(async () => (await readOrEmpty(env.npxLog)) !== "");
    const npxLog = await readOrEmpty(env.npxLog);
    assert.match(npxLog, /--yes @mrrisega\/dsh-remote@/, "应在插件加载时就后台跑安装器，不等用户登录：实际 " + npxLog);
    assert.match(npxLog, /registry\.npmjs\.org/, "首次补装优先官方源（镜像滞后会装到旧版）");
    const installLog = await readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log"));
    assert.match(installLog, /\[auto-install\] npx 退出/, "安装子进程退出应落日志");
    routes.dispose();
  } finally { await env.restore(); }
});

test("运行环境已就绪 → 不重复安装", async () => {
  const env = await setup();
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeConfig(env.relayDir);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const self = await (await fetch(`${base}/dsh-remote/self`)).json();
      assert.equal(self.runtimeReady, true);
    } finally { host.close(); routes.dispose(); }
    await sleep(300);
    assert.equal(await readOrEmpty(env.npxLog), "", "运行环境已就绪时不得再跑安装器");
  } finally { await env.restore(); }
});

test("正常路径不受影响：运行环境就绪 → 照常 bootstrap（plist 入口指向真实运行时）", async () => {
  const env = await setup({ state: "running", runs: 1, exitCode: 0 });
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeConfig(env.relayDir);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const body = await (await fetch(`${base}/dsh-remote/start`, { method: "POST" })).json();
      assert.equal(body.ok, true, "运行环境就绪时启动应成功：" + JSON.stringify(body.detail || ""));
      assert.equal(body.status, "running");
      const plist = readFileSync(env.plistPath, "utf8");
      assert.ok(plist.includes(path.join(env.relayDir, "dsh-setup.mjs")), "plist 入口应指向已就绪的运行时");
      assert.ok(plist.includes("ThrottleInterval"), "应有节流，避免崩溃时空转重拉");
      assert.match(await readOrEmpty(env.launchLog), /bootstrap/);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); }
});

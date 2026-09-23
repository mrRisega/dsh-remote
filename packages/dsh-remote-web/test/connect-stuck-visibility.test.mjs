// 「卡在 starting、而且**看不出为什么**」的定位用例（2026-09-23 用户反馈）。
//
// 反馈原文（Windows，插件 0.6.10）：
//   连接阶段: starting（正在启动 Bridge…） / 设备 ID:（未生成） / 运行环境: 已就绪 /
//   bridge 进程: 未运行（pid=-，launchd state=-，崩溃循环=否） / 中继注册: 未注册 /
//   最近错误: **无** / 自动重试: 已尝试 6 次 → 「手机显示还没有绑定任何电脑，多次修复都没有解决」
//
// 生产遥测（近 14 天 Windows 427 台）显示这一层不是个例：
//   注册成功 152 / install_failed 138 / **bridge_started 却从未 registered 52** / 从未登录 60 / 只装了插件 25。
//
// 这份诊断本身**不足以**区分「三种都会长得一模一样」的机制，代码里三种都真实存在：
//   ① 半装运行时：入口 dsh-setup.mjs 在、它 import 的 clients/… 不在 → runtimeReady 恒为 true，
//      插件再也不补装，插起来的 watcher 秒退（Cannot find module）→ 面板永远「运行环境已就绪 + starting」；
//   ② 守护活着却拉不起 bridge：startBridgeDetached 只要读到活着的 `.dsh-watcher.pid` 就返回「已在运行」
//      → 面板的「启动 / 立即重试 / 一键修复」与插件每轮自愈**全是 no-op**（这正是「多次修复都没解决」）；
//      而 watcher 的判据是「dsh web 在线吗」，端口**写死 127.0.0.1:3080** → dsh web 不在默认端口时必然如此；
//   ③ bridge 子进程起来就崩（例如缺依赖/端口冲突）：面板只看到「进程未运行」，而 `bridge_exit` 这个
//      白名单 fail_code 从来没有调用方，`bridgeLogState` 也只认几种中文文案 → node 的崩溃栈不算「错误」。
//
// 本文件锁死四条不变量（前三条是修复，第四条是「下次这类反馈必须一次定位」）：
//   ① 运行环境就绪 = 入口**点名的文件真的都在**；半装 → 判未就绪 → 自动补装（自愈重新可用）；
//   ② 守护活着但迟迟没有 bridge → **真的重启它**（有阈值、有上限，正常窗口内不打扰）；
//   ③ 上游地址取自 dsh web 实际监听端口（并透传给 watcher），不再写死 3080；
//   ④ 诊断信息给出守护态 / 上游态 / 缺文件 / 两个日志尾部，且手机号与令牌**先脱敏**再出机器。
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SETUP_SRC = readFileSync(path.join(HERE, "..", "..", "..", "dsh-setup.mjs"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 4000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}
const readOrEmpty = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };

/** 假 npx：只记参数，绝不做真实安装（否则用例会去真的装包）。 */
const FAKE_NPX = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_NPX_LOG"
exit 0
`;
/** 假 pgrep：回放 $DSH_TEST_PGREP（模拟「守护/bridge 进程在跑」）。 */
const FAKE_PGREP = `#!/bin/sh
if [ -n "$DSH_TEST_PGREP" ]; then printf '%s\\n' "$DSH_TEST_PGREP"; exit 0; fi
exit 1
`;
const FAKE_PS = `#!/bin/sh
printf '1\\n'
exit 0
`;
/** 假 launchctl：**必须存在**，否则用例会去碰开发机上真实运行的 bridge 服务。exit 1 = 托管不了。 */
const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
exit 1
`;

/** 一个「内容像真的」的运行环境入口：它点名要求 clients/… 下的文件必须在（用于半装运行时用例）。 */
const REAL_ENTRY = `import { childStopped } from "./clients/dsh-remote/src/lifecycle.mjs";
const bridge = new URL("./clients/dsh-remote/dsh-bridge.mjs", import.meta.url);
export { childStopped, bridge };
`;

/**
 * 假运行环境入口（用于「守护/上游」用例）：它只把继承到的上游地址写出来，
 * 于是用例可以断言插件**真的**把 DSH_BRIDGE_UPSTREAM 透传给了 watcher。
 */
const ENV_ENTRY = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.DSH_STUB_OUT, JSON.stringify({
  upstream: process.env.DSH_BRIDGE_UPSTREAM || "",
  args: process.argv.slice(2),
}));
`;

async function setup({ runtime = "stub", platform = "darwin" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-stuck-"));
  const fakeHome = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  const npxLog = path.join(root, "npx.log");
  await writeFile(npxLog, "");
  // win32 分支找的是 npx.cmd（且优先 DSH_SETUP_NPX_DIR），POSIX 分支找 npx —— 两个都放上
  for (const name of ["npx", "npx.cmd"]) {
    await writeFile(path.join(fakeBin, name), FAKE_NPX);
    await chmodSync(path.join(fakeBin, name), 0o755);
  }
  await writeFile(path.join(fakeBin, "pgrep"), FAKE_PGREP);
  await writeFile(path.join(fakeBin, "ps"), FAKE_PS);
  await writeFile(path.join(fakeBin, "launchctl"), FAKE_LAUNCHCTL);
  for (const name of ["pgrep", "ps", "launchctl"]) await chmodSync(path.join(fakeBin, name), 0o755);
  if (runtime === "stub") await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub\n");
  if (runtime === "entry-only") await writeFile(path.join(relayDir, "dsh-setup.mjs"), REAL_ENTRY);
  if (runtime === "env") await writeFile(path.join(relayDir, "dsh-setup.mjs"), ENV_ENTRY);

  const saved = {};
  for (const k of ["HOME", "PATH", "DSH_TEST_NPX_LOG", "DSH_TEST_PGREP", "DSH_TEST_LAUNCH_LOG", "DSH_STUB_OUT", "DSH_RELAY_SKIP_SERVICE", "DSH_SETUP_NPX_DIR", "DSH_RELAY_WEDGE_MS",
    "DSH_RELAY_PLATFORM", "DSH_REMOTE_TELEMETRY", "DSH_RELAY_DEFAULT_API", "DSH_BRIDGE_UPSTREAM",
    "DSH_WEB_URL", "DSH_RELAY_DIR"]) saved[k] = process.env[k];
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH || ""}`;
  process.env.DSH_TEST_NPX_LOG = npxLog;
  process.env.DSH_SETUP_NPX_DIR = fakeBin; // 假 npx（与 windows-compat 用例同一手法：绝不真装包）
  process.env.DSH_TEST_LAUNCH_LOG = path.join(root, "launchctl.log");
  delete process.env.DSH_TEST_PGREP;
  delete process.env.DSH_RELAY_WEDGE_MS;
  process.env.DSH_STUB_OUT = path.join(root, "stub-env.json");
  process.env.DSH_REMOTE_TELEMETRY = "0";              // 用例绝不发匿名遥测
  process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1"; // 后台请求一律打到死端口
  process.env.DSH_RELAY_PLATFORM = platform;
  delete process.env.DSH_RELAY_SKIP_SERVICE;           // 走真实分支（系统命令全是假的/不存在）
  delete process.env.DSH_BRIDGE_UPSTREAM;
  delete process.env.DSH_WEB_URL;
  delete process.env.DSH_RELAY_DIR;

  return {
    root, fakeHome, relayDir, npxLog,
    stubEnvFile: process.env.DSH_STUB_OUT,
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 装载插件路由（webServer 可带真实端口，模拟 dsh web 监听在非默认端口）。 */
function boot(relayDir, { port } = {}) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { ...(port ? { port } : {}), register(route) { routes.set(route.path, route.handler); return () => {}; } },
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
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

async function writeConfig(relayDir, extra = {}) {
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", device_id: "",
    api_url: "http://127.0.0.1:1", ...extra,
  }));
}

const bridgeStatus = async (base) => (await (await fetch(`${base}/dsh-remote/bridge-status`)).json());
const connectRetry = async (base) => (await (await fetch(`${base}/dsh-remote/connect/retry`, { method: "POST" })).json());

/** 起一个「活着但不是我们的 bridge」的进程，冒充卡死的守护。 */
function startFakeWatcher() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", windowsHide: true });
  return {
    pid: child.pid,
    stop() { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } },
  };
}

// ───────────────────── ① 半装运行时：入口在、依赖不在 ─────────────────────

test("半装运行环境（入口在、依赖不在）必须判为未就绪并自动补装，绝不显示成「已就绪」", async () => {
  const env = await setup({ runtime: "entry-only", platform: "win32" });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    await writeConfig(env.relayDir);

    const first = await bridgeStatus(base);
    assert.equal(first.connect.runtimeReady, false, "入口在但依赖缺失 → 绝不能报「运行环境已就绪」");
    // 清单必须来自**入口脚本自己点名**的文件（import 的 lifecycle.mjs 与它引用的 dsh-bridge.mjs），
    // 不是写死的一张表 —— 后者会随版本漂移，把好机器误判成坏机器。
    assert.deepEqual([...first.connect.runtimeMissing].sort(),
      ["clients/dsh-remote/dsh-bridge.mjs", "clients/dsh-remote/src/lifecycle.mjs"],
      "缺的必须是入口脚本点名的那些文件（不能写死一张表）");
    assert.ok(["no_runtime", "installing"].includes(first.connect.phase),
      "阶段应落在「准备运行环境」，实际 " + first.connect.phase);
    assert.match(first.connect.detail, /运行环境不完整/, "要如实说是「不完整」，而不是让它看起来像在正常安装");
    // 关键：半装运行时**必须**触发补装（旧实现里 runtimeReady 恒为 true → 自愈从此停摆）
    assert.ok(await waitFor(async () => (await readOrEmpty(env.npxLog)).includes("@mrrisega/dsh-remote")),
      "半装运行环境必须走自动补装，实际 npx 日志：" + (await readOrEmpty(env.npxLog)));

    const st = await (await fetch(`${base}/dsh-remote/status`)).json();
    assert.equal(st.service.runtimeReady, false, "/status 也必须如实报未就绪（面板两个入口不能互相矛盾）");
    assert.match(String(first.connect.diagnostics), /运行环境缺文件: clients\/dsh-remote\/src\/lifecycle\.mjs/,
      "诊断信息要直接点出缺哪个文件");

    // 依赖补齐（= 补装完成）→ 立刻恢复就绪，不再重复补装
    await mkdir(path.join(env.relayDir, "clients", "dsh-remote", "src"), { recursive: true });
    await writeFile(path.join(env.relayDir, "clients", "dsh-remote", "src", "lifecycle.mjs"), "export const childStopped = () => true;\n");
    await writeFile(path.join(env.relayDir, "clients", "dsh-remote", "dsh-bridge.mjs"), "// bridge stub\n");
    const npxBefore = await readOrEmpty(env.npxLog);
    const after = await bridgeStatus(base);
    assert.equal(after.connect.runtimeReady, true, "依赖补齐后必须立刻恢复就绪");
    assert.equal(after.connect.phase, "starting", "就绪后应回到「正在启动 Bridge」（本用例没有真 bridge）");
    assert.equal(await readOrEmpty(env.npxLog), npxBefore, "已就绪不得再触发补装");
  } finally { host.close(); routes.dispose(); await env.restore(); }
});

// ───────────────────── ② 守护活着却拉不起 bridge ─────────────────────

test("win32：守护活着却迟迟拉不起 bridge → 真的重启它（旧实现每次都 no-op，这正是「多次修复都没解决」）", async () => {
  const env = await setup({ runtime: "stub", platform: "win32" });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  const fake = startFakeWatcher();
  try {
    await writeConfig(env.relayDir);
    const pidFile = path.join(env.relayDir, ".dsh-watcher.pid");
    await writeFile(pidFile, String(fake.pid));
    const old = Date.now() / 1000 - 180;                 // 守护已经活了 3 分钟
    utimesSync(pidFile, old, old);

    const r = await connectRetry(base);                  // 用户点了「立即重试 / 一键修复」
    assert.equal(r.action, "restart-wedged-watcher",
      "守护活着但 3 分钟没拉起 bridge：重试必须真的重启它，实际 " + r.action);
    assert.match(await readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log")),
      /后台守护已存活 180 秒仍无 bridge 进程/, "要留下可回查的记录（含上游地址）");
    assert.ok(await waitFor(async () => Number(await readOrEmpty(pidFile)) !== fake.pid),
      "必须真的重新拉起（pid 文件被新守护覆盖），实际仍是 " + (await readOrEmpty(pidFile)));
  } finally { fake.stop(); host.close(); routes.dispose(); await env.restore(); }
});

test("win32：守护刚起来（正常启动窗口内）不得被误重启", async () => {
  const env = await setup({ runtime: "stub", platform: "win32" });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  const fake = startFakeWatcher();
  try {
    await writeConfig(env.relayDir);
    const pidFile = path.join(env.relayDir, ".dsh-watcher.pid");
    await writeFile(pidFile, String(fake.pid));           // mtime = 现在（刚拉起）

    const r = await connectRetry(base);
    assert.notEqual(r.action, "restart-wedged-watcher", "刚起来就重启会把正常启动流程打断，实际 " + r.action);
    assert.equal(Number(await readOrEmpty(pidFile)), fake.pid, "pid 文件不得被改写");
    assert.ok(!/后台守护已存活/.test(await readOrEmpty(path.join(env.relayDir, ".dsh-setup-install.log"))));
  } finally { fake.stop(); host.close(); routes.dispose(); await env.restore(); }
});

test("登录限流窗口内：如实说明在等限流，不判错、也不重启守护", async () => {
  const env = await setup({ runtime: "stub", platform: "win32" });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  const fake = startFakeWatcher();
  try {
    await writeConfig(env.relayDir);
    const pidFile = path.join(env.relayDir, ".dsh-watcher.pid");
    await writeFile(pidFile, String(fake.pid));
    const old = Date.now() / 1000 - 600;
    utimesSync(pidFile, old, old);
    await writeFile(path.join(env.relayDir, ".dsh-login-ratelimited"), String(Date.now() + 600_000));

    const r = await connectRetry(base);
    assert.equal(r.connect.phase, "starting", "限流是等待，不是错误");
    assert.match(r.connect.detail, /限流/, "必须说清在等服务端限流窗口（否则用户只能反复改密码）");
    assert.notEqual(r.action, "restart-wedged-watcher", "限流期间重启守护没有任何意义");
  } finally { fake.stop(); host.close(); routes.dispose(); await env.restore(); }
});

// ───────────────────── ③ 上游端口：取自 dsh web 实际监听端口 ─────────────────────

test("上游地址取自 dsh web 实际监听端口，并透传给 watcher（不再写死 3080）", async () => {
  const env = await setup({ runtime: "env", platform: "win32" });
  const upstream = http.createServer((_req, res) => res.end("dsh web"));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const webPort = upstream.address().port;
  const routes = boot(env.relayDir, { port: webPort });
  const { host, base } = await serve(routes);
  try {
    await writeConfig(env.relayDir);
    const r = await bridgeStatus(base);
    assert.equal(r.connect.upstreamUrl, `http://127.0.0.1:${webPort}`, "上游必须是 dsh web 真正监听的端口");
    assert.equal(r.connect.upstreamSource, "dsh web 实际监听端口");
    assert.equal(r.connect.upstreamReachable, true, "上游在听 → 诊断应报可达");

    assert.ok(await waitFor(async () => existsSync(env.stubEnvFile)), "应真的把 watcher 拉起来");
    const seen = JSON.parse(await readOrEmpty(env.stubEnvFile) || "{}");
    assert.equal(seen.upstream, `http://127.0.0.1:${webPort}`,
      "上游端口必须透传给 watcher（它用它判断 dsh web 在线、bridge 用它转发），实际 " + seen.upstream);
    assert.equal((await readOrEmpty(path.join(env.relayDir, ".dsh-upstream"))).trim(),
      `http://127.0.0.1:${webPort}`, "开机自启拉起的守护没有 env，只能靠这个文件拿到端口");
  } finally { upstream.close(); host.close(); routes.dispose(); await env.restore(); }
});

test("取不到实际端口时：回落到 3080 且如实标注来源，上游不通时把原因写进 detail", async () => {
  const env = await setup({ runtime: "stub", platform: "win32" });
  const routes = boot(env.relayDir); // 不传 port，也没有 DSH_WEB_URL
  const { host, base } = await serve(routes);
  try {
    await writeConfig(env.relayDir);
    const r = await bridgeStatus(base);
    assert.equal(r.connect.upstreamUrl, "http://127.0.0.1:3080");
    assert.match(r.connect.upstreamSource, /默认值 3080/, "回落到默认值时必须说明是回落，不能装作是实测端口");
    // 用例环境里 3080 上没有 dsh web（或即使有也断言「探测结论一定被写出来」）
    assert.equal(typeof r.connect.upstreamReachable, "boolean");
    if (r.connect.upstreamReachable === false) {
      assert.match(r.connect.detail, /探测不通/, "bridge 起不来时，上游不通必须出现在面板文案里（旧版这里是空白）");
    }
  } finally { host.close(); routes.dispose(); await env.restore(); }
});

// ───────────────────── ④ 诊断信息：说清卡在哪 + 脱敏 ─────────────────────

test("诊断信息：守护态 / 上游态 / 缺文件 / 两个日志尾部都带上，且手机号与令牌先脱敏", async () => {
  const env = await setup({ runtime: "stub", platform: "win32" });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  const fake = startFakeWatcher();
  try {
    await writeConfig(env.relayDir);
    await writeFile(path.join(env.relayDir, ".dsh-watcher.pid"), String(fake.pid));
    await writeFile(path.join(env.relayDir, ".dsh-bridge.log"), [
      "[bridge] 用账号 13800000000 登录换取 JWT...",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop",
      '{"password":"MySecretPassw0rd"}',
      "Error: Cannot find module '/Users/Scarlet/.dsh-remote/clients/dsh-remote/dsh-bridge.mjs'",
    ].join("\n") + "\n");
    await writeFile(path.join(env.relayDir, ".dsh-setup-install.log"),
      "[dsh-remote-web] 自动启动 bridge 未成功(not-installed): 运行环境入口脚本不存在\n");

    const r = await bridgeStatus(base);
    const diag = String(r.connect.diagnostics);
    assert.match(diag, /后台守护: 在运行（pid=/, "守护态必须可见（旧版只报 bridge 进程，守护是隐身的）");
    assert.match(diag, /上游 dsh web: http:\/\/127\.0\.0\.1:3080（默认值 3080/, "上游与来源必须可见");
    assert.match(diag, /连接阶段: starting/, "本用例复现的正是用户那份「卡在 starting」的现场");
    assert.match(diag, /运行环境: 已就绪/, "（缺文件那一行由半装运行时用例单独锁死）");
    assert.match(diag, /--- bridge 日志（末尾）---/, "必须带上 bridge 日志尾部");
    assert.match(diag, /--- 安装日志（末尾）---/, "必须带上安装日志尾部");
    assert.match(diag, /Cannot find module/, "真实崩溃原因必须原样带上（旧版只说「最近错误: 无」）");
    // 隐私：这份文本用户会贴到群里/发给客服 → 先脱敏再出机器
    assert.ok(!diag.includes("13800000000"), "手机号必须脱敏");
    assert.match(diag, /138\*\*\*\*0000/);
    assert.ok(!diag.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "令牌必须隐去");
    assert.ok(!diag.includes("MySecretPassw0rd"), "密码字段必须隐去");
  } finally { fake.stop(); host.close(); routes.dispose(); await env.restore(); }
});

// ───────────────────── ⑤ 运行时侧的源级契约（桥的另一半） ─────────────────────

test("运行时 dsh-setup.mjs：上游端口只有一处真相源，watcher/子进程/探测共用它", () => {
  assert.ok(/function upstreamUrl\(\)/.test(SETUP_SRC), "必须有统一的上游解析函数");
  // 环境变量 > 插件留下的端口文件 > DSH_WEB_URL > 3080
  const fn = SETUP_SRC.slice(SETUP_SRC.indexOf("function upstreamUrl()"), SETUP_SRC.indexOf("function upstreamPort()"));
  assert.ok(/DSH_BRIDGE_UPSTREAM/.test(fn) && /UPSTREAM_FILE/.test(fn) && /DSH_WEB_URL/.test(fn),
    "上游优先级必须是 env > 端口文件 > DSH_WEB_URL > 默认");
  // 不许再有「写死 3080 的 fetch / netstat / lsof / 命令行」（注释除外）
  const code = SETUP_SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/fetch\("http:\/\/127\.0\.0\.1:3080/.test(code), "探测不得写死 3080（dsh web 可能在别的端口）");
  assert.ok(!/findstr ":3080"|iTCP:3080/.test(code), "按端口找 dsh web 进程也不得写死 3080");
  assert.ok(/async function upstreamReachable\(url = upstreamUrl\(\)/.test(code), "在线判据必须用解析出来的上游地址");
  assert.ok(/await upstreamReachable\(upstreamUrl\(\)/.test(code), "isDshWebUp 必须基于 upstreamUrl() 探测");
  assert.ok(/DSH_BRIDGE_UPSTREAM: upstreamUrl\(\)/.test(code), "必须把上游显式透传给 bridge 子进程");
  // ── 上游端口动态发现（2026-09-23 第二起实测：DSH Desktop 默认 43120，占用还会 +1）──
  // 只靠"端口文件"不够：文件可能还没写、或写着上一轮的旧端口；那时必须自己去找。
  assert.ok(
    /from "\.\/clients\/dsh-remote\/upstream-discovery\.mjs"/.test(SETUP_SRC),
    "必须复用共享的上游发现实现（watcher/bridge 同一份，避免两边漂移）"
  );
  assert.ok(
    /const after = await refreshUpstreamDiscovery\(true\)/.test(code),
    "探测失败必须主动做一次动态发现再试（否则端口一变就永远卡在 starting）"
  );
  assert.ok(
    /await refreshUpstreamDiscovery\(true\);/.test(code),
    "启动时先发现再打印：日志不得再谎称固定端口"
  );
  // 半装运行时的根因之一：本安装器自己 import 的 src/lifecycle.mjs 必须在同步表里
  assert.ok(/"src\/lifecycle\.mjs"/.test(SETUP_SRC), "RUNTIME_CLIENT_FILES 必须包含 src/lifecycle.mjs（否则会漏同步出半装运行时）");
});

test("无 pid 文件的守护（0.6.7 之前的运行时/文件被删）也能算出年龄并按同样规则重启", async () => {
  const env = await setup({ runtime: "stub", platform: "darwin" });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  process.env.DSH_RELAY_WEDGE_MS = "200"; // 仅供测试把节奏压到亚秒级（生产不设置）
  try {
    await writeConfig(env.relayDir);
    // 只有 pgrep 能看到守护（没有 .dsh-watcher.pid）→ 年龄只能来自「本进程第一次看到它」的时刻
    process.env.DSH_TEST_PGREP = "4242 dsh-setup.mjs run";
    await connectRetry(base);
    await sleep(260);
    const r = await connectRetry(base);
    assert.equal(r.action, "restart-wedged-watcher",
      "没有 pid 文件时也必须能判定卡死（否则这类机器永远无人救），实际 " + r.action);
  } finally {
    host.close(); routes.dispose(); await env.restore();
  }
});

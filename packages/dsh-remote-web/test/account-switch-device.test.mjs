/**
 * 「切换账号后设备没登记到新账号」回归（0.6.7-beta.4 新增）。
 *
 * 现场（2026-09-19 用户实测，本机复现）：
 *   23:55 装好插件 → 00:03 登录账号 A → bridge 用 A 的凭据登记（dev-xxxx 进 A 的设备列表）
 *   → 00:29 退出 A、登录账号 B（配置已改、device_id 已清）
 *   → **B 的设备列表里永远看不到这台 Mac**，而 A 那边它还在线。
 *
 * 三个缺陷叠加（本文件逐个锁死）：
 *   ① bridge 的账号/密码是**进程启动时**从环境变量固化的；`dsh-setup run` 每 10s 重读配置，
 *      但只在子进程**已退出**时才重新拉起它 → 换了账号，进程不换凭据。
 *   ② 切换账号时那次"重启 bridge"其实失败了：插件只认 `gui/<uid>` 域，而安装器按 macOS 26 的
 *      修复把作业装在 `user/<uid>` 域 → `Could not find service ... in user gui: 501`，
 *      而面板**不看 bridgeRestart 的返回值** → 静默失败。
 *   ③ 旧账号留下的 `.dsh-bridge-state.json`（phase=online + 旧 device_id）没被清理，
 *      面板据此谎报「已连接」，自愈（只判"有没有进程在跑"）也就永远不会去纠正。
 *
 * ⚠️ 隔离：unset 隔离开关的用例必须同时伪造 HOME 与 PATH（否则会碰真实 HOME 下的 launchd）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_SRC = readFileSync(path.join(HERE, "..", "..", "..", "dsh-setup.mjs"), "utf8");
const CLIENT_SRC = readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

/** 假 launchctl：user 域报告 running、gui 域报告不存在（复刻 macOS 26 + 安装器实际形态）。 */
const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
if [ "$1" = print ]; then
  case "$2" in
    user/*) printf 'state = running\\npid = 4242\\nruns = 3\\n'; exit 0 ;;
    gui/*) echo "Could not find service in domain for user gui" >&2; exit 1 ;;
  esac
fi
exit 0
`;

async function makeEnv({ fakeLaunchd = true, fakeBridgeJobs = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-acct-dev-"));
  const fakeHome = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeHome, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  if (fakeLaunchd) {
    await writeFile(path.join(fakeBin, "launchctl"), FAKE_LAUNCHCTL);
    await chmod(path.join(fakeBin, "launchctl"), 0o755);
  }
  const saved = {};
  for (const k of ["HOME", "PATH", "DSH_TEST_LAUNCH_LOG", "DSH_RELAY_SKIP_SERVICE", "DSH_REMOTE_TELEMETRY"]) {
    saved[k] = process.env[k];
  }
  process.env.HOME = fakeHome;
  if (fakeLaunchd) process.env.PATH = `${fakeBin}:${saved.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = path.join(root, "launchctl.log");
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 默认隔离：用例按需 unset
  // 假的 pgrep/ps：让 manualStatus「看得见」一个**旧账号的 bridge 进程**。
  // 🔴 2026-09-25：本文件测的现场就是「旧账号的 bridge 还在跑」（否则面板压根看不到 accountCurrent=false）,
  //   而旧实现只伪造了 launchctl、**没伪造 pgrep/ps** —— 于是用例偷偷依赖「开发机上正好有 bridge 在跑」：
  //   开发机有 → 绿；CI 上没有 → 红（`npm test` 在 router 那步就断了，所以这个红一直被挡住）。
  //   真实进程状态不该影响用例结果，所以这里显式伪造。
  let fakeJob = null;
  if (fakeBridgeJobs) {
    fakeJob = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const stub = (body) => `#!/bin/sh\n${body}\n`;
    await writeFile(path.join(fakeBin, "pgrep"), stub(`echo "${fakeJob.pid} node /x/clients/dsh-remote/dsh-bridge.mjs"`));
    await chmod(path.join(fakeBin, "pgrep"), 0o755);
    await writeFile(path.join(fakeBin, "ps"), stub('echo "1"')); // ppid=1 → 不会被当成 launchd 托管
    await chmod(path.join(fakeBin, "ps"), 0o755);
  }
  return {
    root, relayDir, fakeHome, launchLog: path.join(root, "launchctl.log"),
    async restore() {
      try { fakeJob?.kill("SIGKILL"); } catch { /* 已退出 */ }
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function boot(relayDir) {
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
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

const json = async (p, init) => {
  const res = await fetch(p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

// ─────────── ① 旧账号的 bridge 不得被当成「已连接」 ───────────

test("切换账号后：旧账号留下的 online 状态不得再当作注册证据", async () => {
  // fakeBridgeJobs：这个现场的前提就是「旧账号的 bridge 进程还在跑」——必须伪造出来，
  // 而不是指望跑用例的那台机器上恰好有一个（CI 上没有 → 曾经必红）。
  const env = await makeEnv({ fakeBridgeJobs: true });
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    // 切账号后的配置：新账号、device_id 已被清空
    await writeFile(path.join(env.relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "account-B", password: "pw", api_url: "http://127.0.0.1:1",
    }));
    // 旧账号 bridge 留下的状态：device_id 是旧的、还写着 online
    await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({
      device_id: "dev-old", phase: "online", tunnel_registered_at: 1789747521560, account_bound_at: 1789747429422,
    }));
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    const stateFile = path.join(env.relayDir, ".dsh-bridge-state.json");
    try {
      // ① /status 是纯读接口：必须如实报告"跑着的是上一个账号的 bridge"
      const { body: st } = await json(`${base}/dsh-remote/status`);
      assert.equal(st.connect.accountCurrent, false, "必须识别出「跑着的是上一个账号的 bridge」");
      assert.equal(st.connect.registered, false, "★旧账号的注册证据必须作废（否则面板谎报已连接）");
      assert.notEqual(st.connect.phase, "online", "★不得报 online");
      assert.match(String(st.connect.detail), /上一个账号|重启/, "应说明正在用新账号重新登记");
      assert.match(String(st.connect.diagnostics), /bridge 账号: ⚠️/, "诊断信息里要能一眼看出");
      assert.equal(existsSync(stateFile), true, "纯读接口不得改动状态文件");

      // ② /bridge-status 会自愈：清掉过期状态（下一轮用新账号重新登记）
      const { body: bs } = await json(`${base}/dsh-remote/bridge-status`);
      assert.equal(existsSync(stateFile), false, "★过期状态必须被自愈清掉（否则面板一直谎报，永不纠正）");
      assert.equal(bs.connect.registered, false, "清掉之后也不得凭空报已连接");
    } finally {
      host.close();
    }
  } finally {
    await env.restore();
  }
});

test("账号一致时行为不变：同一 device_id 的 online 状态仍算已连接（回归）", async () => {
  const env = await makeEnv();
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(path.join(env.relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "account-A", password: "pw", device_id: "dev-1", api_url: "http://127.0.0.1:1",
    }));
    await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({
      device_id: "dev-1", phase: "online", tunnel_registered_at: 1789747521560,
    }));
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const { body } = await json(`${base}/dsh-remote/bridge-status`);
      assert.equal(body.connect.accountCurrent, true);
      assert.equal(body.connect.registered, true, "同一账号的注册证据仍然有效");
      assert.match(String(body.connect.diagnostics), /bridge 账号: 当前账号/);
    } finally {
      host.close();
    }
  } finally {
    await env.restore();
  }
});

// ─────────── ② 切换账号要真的把旧 bridge 停掉 + 清掉过期状态 ───────────

test("切换账号：停掉旧 bridge 并清除过期状态文件（否则新账号永远等不到设备）", async () => {
  const env = await makeEnv();
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(path.join(env.relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "account-A", password: "pw", device_id: "dev-old", api_url: "http://127.0.0.1:1",
    }));
    await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({
      device_id: "dev-old", phase: "online", tunnel_registered_at: 1789747521560,
    }));
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const { body } = await json(`${base}/dsh-remote/config`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "account-B", password: "pw2" }),
      });
      assert.equal(body.ok, true);
      assert.ok(body.bridgeRestart, "响应必须带上重启结果（前端据此提示，不再静默）");
      const cfg = JSON.parse(await readFile(path.join(env.relayDir, ".dsh-config.json"), "utf8"));
      assert.equal(cfg.phone, "account-B");
      assert.equal(cfg.device_id, undefined, "设备身份必须轮换");
      assert.equal(existsSync(path.join(env.relayDir, ".dsh-bridge-state.json")), false,
        "★旧账号的注册证据必须删除（否则面板一直谎报已连接，自愈永不纠正）");
    } finally {
      host.close();
    }
  } finally {
    await env.restore();
  }
});

test("退出登录：必须停 bridge 并作废设备身份（否则旧账号的隧道还在对外服务）", async () => {
  const env = await makeEnv();
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(path.join(env.relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "account-A", password: "pw", device_id: "dev-1",
      device_private_key: "pk", device_public_key: "pub", api_url: "http://127.0.0.1:1",
    }));
    await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({
      device_id: "dev-1", phase: "online", tunnel_registered_at: 1,
    }));
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const { body } = await json(`${base}/dsh-remote/logout`, { method: "POST" });
      assert.equal(body.ok, true);
      const cfg = JSON.parse(await readFile(path.join(env.relayDir, ".dsh-config.json"), "utf8"));
      assert.equal(cfg.phone, undefined, "账号应被清除");
      assert.equal(cfg.password, undefined);
      assert.equal(cfg.device_id, undefined, "★设备身份必须一起作废");
      assert.equal(existsSync(path.join(env.relayDir, ".dsh-bridge-state.json")), false, "★状态记录应清除");
    } finally {
      host.close();
    }
  } finally {
    await env.restore();
  }
});

// ─────────── ③ launchd 域名阶梯（事故的直接技术原因） ───────────

test("launchd：作业在 user/<uid> 域时也必须被认成「运行中」（旧实现只看 gui/<uid>）", { skip: process.platform !== "darwin" }, async () => {
  const env = await makeEnv();
  delete process.env.DSH_RELAY_SKIP_SERVICE; // 本用例要真的去调（假）launchctl
  try {
    await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
    await writeFile(path.join(env.relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "account-A", password: "pw", api_url: "http://127.0.0.1:1",
    }));
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      const { body } = await json(`${base}/dsh-remote/status`);
      assert.equal(body.service.launchd.running, true,
        "★安装器把作业装在 user/<uid>：插件必须查到这个域，否则会误判「未运行」并反复重复启动");
      assert.equal(body.service.launchd.pid, 4242);
      const log = existsSync(env.launchLog) ? readFileSync(env.launchLog, "utf8") : "";
      assert.match(log, new RegExp(`print user/${process.getuid()}/com\\.dshremote\\.bridge`), "应先查 user 域");
    } finally {
      host.close();
    }
  } finally {
    await env.restore();
  }
});

test("源码契约：启动/停止都要覆盖两个 launchd 域（只认 gui 就是本次事故）", () => {
  assert.ok(/function launchDomains\(\)/.test(INDEX_SRC), "应有统一的域阶梯");
  const startFn = INDEX_SRC.slice(INDEX_SRC.indexOf("function startBridge(relayDir)"), INDEX_SRC.indexOf("function scheduleRuntime("));
  assert.ok(/for \(const domain of launchDomains\(\)\)/.test(startFn), "启动必须遍历域阶梯（user 优先）");
  assert.ok(/com\.dshremote\.bridge`\)\}/.test(startFn) || /launchDomains\(\)/.test(startFn));
  const stopFn = INDEX_SRC.slice(INDEX_SRC.indexOf("/** 停止 bridge"), INDEX_SRC.indexOf("function uninstallRuntime("));
  assert.ok(/launchTargets\(\)/.test(stopFn), "停止必须覆盖两个域（作业可能在 user 域）");
  assert.ok(/resetBridgeForAccountChange/.test(INDEX_SRC), "应有「账号变更 → 停旧 bridge + 清过期状态」的统一入口");
  // 自愈必须判账号归属，而不是只看"有没有进程在跑"
  const ensureFn = INDEX_SRC.slice(INDEX_SRC.indexOf("function ensureConnection("), INDEX_SRC.indexOf("// ---------- 匿名装机"));
  assert.ok(/bridgeMatchesCurrentAccount\(relayDir, cfg\)/.test(ensureFn), "自愈必须判账号归属");
  assert.ok(/action: "restart"/.test(ensureFn), "账号不符时应重启而不是返回 none");
});

test("源码契约：watcher（dsh-setup run）也要能发现账号变化并重启子进程", () => {
  assert.ok(/function accountFingerprint\(/.test(SETUP_SRC), "应有账号指纹");
  assert.ok(/let bridgeAccountFp = ""/.test(SETUP_SRC), "应记录当前子进程用的凭据");
  assert.ok(/bridgeAccountFp !== fp/.test(SETUP_SRC), "配置里的账号一变就要重启 bridge 子进程");
  assert.ok(/账号配置已变化 → 重启 bridge/.test(SETUP_SRC), "应打日志说明为什么重启");
  // pid 文件与去重护栏不再只服务 Windows（脱离进程兜底在 POSIX 上也用）
  assert.ok(!/if \(IS_WIN\) writePidFile\(BRIDGE_PID_FILE/.test(SETUP_SRC), "pid 文件应全平台写");
  assert.ok(!/  if \(IS_WIN\) \{\n    const other = readPidFile\(WATCHER_PID_FILE\)/.test(SETUP_SRC), "去重护栏应全平台生效");
});

test("限流：429 不得被当成「密码错」，且 watcher 要退避而不是空撞", () => {
  const bridge = readFileSync(path.join(HERE, "..", "..", "..", "clients", "dsh-remote", "dsh-bridge.mjs"), "utf8");
  assert.ok(/r\.status === 429/.test(bridge), "bridge 必须单独处理 429");
  assert.ok(/retry_after_ms/.test(bridge), "应读取服务端给的 retry_after_ms");
  assert.ok(/凭据没错|无需改密码/.test(bridge), "必须明确告诉用户不是密码问题（旧文案会误导人去改密码）");
  const rateStart = bridge.indexOf("r.status === 429");
  const rateBlock = bridge.slice(rateStart, bridge.indexOf("process.exit(3)", rateStart)); // 只取 429 分支自身
  assert.ok(/\.dsh-login-ratelimited/.test(rateBlock), "应落盘「最早可重试时刻」供 watcher 退避");
  // 只看**真实打印**的行（注释里引用旧文案是可以的）
  const emitted = rateBlock.split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .filter((l) => /请检查 DSH_BRIDGE_EMAIL/.test(l));
  assert.equal(emitted.length, 0, `429 分支不得再提示去检查密码：${emitted.join(" / ")}`);
  // 登录成功要清掉退避提示（服务端成功即清零）
  assert.ok(/rmSync\(path\.join\(path\.dirname\(CONFIG_PATH\), "\.dsh-login-ratelimited"/.test(bridge));
  // watcher 侧：限流窗口内不反复拉起 bridge
  assert.ok(/function loginRateLimitUntil\(/.test(SETUP_SRC), "watcher 应能读限流退避时间");
  assert.ok(/if \(rlUntil > Date\.now\(\)\)/.test(SETUP_SRC), "窗口内应直接返回，不空撞");
  assert.ok(/凭据无需修改/.test(SETUP_SRC), "提示要说清楚不是凭据问题");
});

test("前端：登录/注册落盘后必须检查 bridgeRestart，不再静默失败", () => {
  assert.ok(/function applyAccountSaved\(/.test(CLIENT_SRC), "应有统一的账号落盘提示");
  assert.ok(/br\.ok === false/.test(CLIENT_SRC), "必须检查 bridgeRestart.ok === false");
  assert.ok(/未能自动重启/.test(CLIENT_SRC), "失败时给出可见提示");
  // 只数**调用点**（第二个实参是字符串字面量），别把函数定义也算进去
  const calls = CLIENT_SRC.match(/applyAccountSaved\(cfg, "/g) || [];
  assert.equal(calls.length, 2, `登录与注册两条路径都要用它（实际 ${calls.length} 处）`);
});

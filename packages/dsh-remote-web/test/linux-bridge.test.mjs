/**
 * Linux（含**飞牛 fnOS / 群晖这类 NAS**）能真正跑起 bridge —— 0.6.15 回归。
 *
 * 背景（2026-09-25 用户诊断原文，插件 0.6.14，平台 linux）：
 *   连接阶段: starting（正在启动 Bridge…）
 *   bridge 进程: 未运行（pid=-，launchd state=-，崩溃循环=否）
 *   后台守护: 未运行
 *   上游 dsh web: http://127.0.0.1:3080（默认值 3080（未取到 dsh web 实际监听端口），⚠️ 不可达）
 *   安装日志: [dsh-remote-web] 自动启动 bridge 未成功(unsupported): 当前平台（linux）暂不支持自启动服务
 *
 * 根因（两条，缺一不可）：
 *   ① `startBridge` 只认 macOS 的 launchd —— 非 darwin 且非 win32 时直接返回 `unsupported`，
 *      而 Linux 恰恰既不是 darwin 也不是 win32 → **bridge 从来没被拉起来过**。
 *      自愈轮次每轮都调它、每轮都被挡回，面板于是永远停在「正在启动 Bridge…」。
 *      用户以为"端口没匹配上"，反复改端口号（改到 3080 也不好使）—— 因为根本没人在起进程。
 *   ② 自愈的就绪判据只对 Windows 放行（`isWindows() && manualStatus().watcher.length`），
 *      Linux 即使被拉起来也会每轮重复"写 unit + 起进程"。
 *
 * 这里在开发机上把 **linux 分支真跑一遍**（DSH_RELAY_PLATFORM=linux + 伪造 HOME/PATH），
 * 断言的是行为（真的派生了守护进程、状态不再说"暂不支持"、systemd 不可用时如实降级），
 * 而不是"源码长得像不像"。
 *
 * ⚠️ 隔离：走真实分支的用例必须伪造 HOME 并去掉 DSH_RELAY_SKIP_SERVICE
 *    （static 护栏见 setup-output.test.mjs）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import * as nodeFs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";
import {
  __noteAutostartFailure,
  __clearAutostartFailure,
} from "../lib/index.js";
import {
  allLoopbackListeningPorts,
  candidatePorts,
  looksLikeDshRemoteSelf,
  procNetLoopbackPorts,
  probeDshWeb
} from "../../../clients/dsh-remote/upstream-discovery.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 systemctl：`show-environment` 是否成功由 env 开关决定（模拟"有没有 user systemd 会话"）。 */
const FAKE_SYSTEMCTL = `#!/bin/sh
case "$*" in
  *show-environment*) [ "$DSH_TEST_HAVE_SYSTEMD" = "1" ] && { echo "PATH=/usr/bin"; exit 0; } || exit 1 ;;
  *is-active*) [ "$DSH_TEST_HAVE_SYSTEMD" = "1" ] && { echo active; exit 0; } || exit 3 ;;
esac
exit 0
`;

async function makeEnv({ haveSystemd = false, skipService = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-linux-"));
  const fakeBin = path.join(root, "bin");
  const fakeHome = path.join(root, "home");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  await writeFile(path.join(fakeBin, "systemctl"), FAKE_SYSTEMCTL);
  await chmod(path.join(fakeBin, "systemctl"), 0o755);
  for (const n of ["pgrep", "ps"]) {
    await writeFile(path.join(fakeBin, n), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(fakeBin, n), 0o755);
  }
  // 假运行环境入口：**没有 import**（manifest 为空 → runtimeReady=true），被派生前写一个 marker 然后长睡，
  // 好让 pid 文件里的进程真的活着（状态判定要读真实 pid）。
  await writeFile(path.join(relayDir, "dsh-setup.mjs"), `
import { writeFileSync } from "node:fs";
try { writeFileSync(process.env.DSH_TEST_SPAWN_MARKER, "spawned"); } catch {}
setTimeout(() => {}, 60000);
`);
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    api_url: "http://127.0.0.1:1",
    local_key: "test-local-key",
    device_id: "dev-test-linux"
  }));

  const saved = {};
  const keys = ["HOME", "PATH", "DSH_RELAY_PLATFORM", "DSH_RELAY_SKIP_SERVICE", "DSH_REMOTE_TELEMETRY",
    "DSH_RELAY_SELFHEAL_MS", "DSH_TEST_HAVE_SYSTEMD", "DSH_TEST_SPAWN_MARKER", "XDG_RUNTIME_DIR",
    "DSH_BRIDGE_UPSTREAM", "DSH_WEB_URL"];
  for (const k of keys) saved[k] = process.env[k];
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH || ""}`;
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_SELFHEAL_MS = "600000"; // 关掉自愈定时器：本例要的是"确定性的一次调用结果"
  process.env.DSH_RELAY_PLATFORM = "linux";
  process.env.DSH_TEST_HAVE_SYSTEMD = haveSystemd ? "1" : "0";
  process.env.DSH_TEST_SPAWN_MARKER = path.join(root, "spawned.marker");
  delete process.env.XDG_RUNTIME_DIR; // NAS 上没有 runtime dir
  delete process.env.DSH_BRIDGE_UPSTREAM;
  delete process.env.DSH_WEB_URL;
  if (skipService) process.env.DSH_RELAY_SKIP_SERVICE = "1";
  else delete process.env.DSH_RELAY_SKIP_SERVICE;

  return {
    root, relayDir, fakeBin, fakeHome,
    marker: path.join(root, "spawned.marker"),
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
    webServer: { port: 0, register(route) { routes.set(route.path, route.handler); return () => {}; } },
    get(name) { return name === "loader" ? null : null; },
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

async function getJson(base, p) {
  const res = await fetch(base + p);
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

async function postJson(base, p) {
  const res = await fetch(base + p, { method: "POST" });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

const killPidFile = (relayDir) => {
  try {
    const pid = Number(readFileSync(path.join(relayDir, ".dsh-watcher.pid"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
  } catch { /* 没有就没有 */ }
};

// ─────────────────── ① 主用例：没有 user systemd（飞牛/NAS）时必须真的把守护拉起来 ───────────────────

test("★ linux 无 user systemd（NAS）：bridge 必须被真的拉起，绝不再回「暂不支持自启动」", async () => {
  const env = await makeEnv({ haveSystemd: false });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    const retry = await postJson(srv.base, "/dsh-remote/connect/retry");
    assert.equal(retry.status, 200);
    const connect = retry.body.connect;
    assert.ok(connect, "必须下发连接阶段");
    assert.ok(!/暂不支持自启动/.test(connect.detail || ""),
      `★ 0.6.14 的死路必须消失，实际 detail: ${connect.detail}`);
    assert.ok(!["error"].includes(connect.phase) || !/unsupported/.test(JSON.stringify(connect.error || {})),
      "不得把「平台不支持」当成错误结论抛给用户");

    // 真的派生了守护进程：marker 由被派生的 dsh-setup.mjs 写出
    for (let i = 0; i < 100 && !existsSync(env.marker); i += 1) await sleep(50);
    assert.ok(existsSync(env.marker), "★ 必须真的派生了 bridge 守护进程（0.6.14 在 Linux 上什么都不会发生）");
    assert.ok(existsSync(path.join(env.relayDir, ".dsh-watcher.pid")), "派生的守护必须写 pid 文件（状态判定要用）");

    // 状态接口要如实说明走的是"后台进程"而不是 systemd
    const st = await getJson(srv.base, "/dsh-remote/status");
    assert.equal(st.status, 200);
    assert.equal(st.body.service.platform, "linux");
    assert.equal(st.body.service.serviceManager, "detached",
      "没有 user systemd 会话时，服务管理器必须如实报 detached（否则面板会给错的文案）");
  } finally {
    killPidFile(env.relayDir);
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

test("★ linux 有 user systemd：写 unit + enable + restart，状态报 systemd（可自愈优先）", async () => {
  const env = await makeEnv({ haveSystemd: true });
  process.env.XDG_RUNTIME_DIR = path.join(env.root, "run");
  await mkdir(process.env.XDG_RUNTIME_DIR, { recursive: true });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    const retry = await postJson(srv.base, "/dsh-remote/connect/retry");
    assert.equal(retry.status, 200);
    const unit = path.join(env.fakeHome, ".config", "systemd", "user", "dsh-bridge.service");
    assert.ok(existsSync(unit), "有 user systemd 会话时必须写 unit（开机自启 + 崩溃自愈）");
    const text = await readFile(unit, "utf8");
    assert.match(text, /ExecStart=.*dsh-setup\.mjs run/, "unit 必须指向运行环境入口");
    assert.match(text, /DSH_BRIDGE_UPSTREAM=/, "★ unit 必须带上游地址：否则开机自启的守护会回落到写死的 3080");

    const st = await getJson(srv.base, "/dsh-remote/status");
    assert.equal(st.body.service.serviceManager, "systemd", "有会话时如实报 systemd");
  } finally {
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

// ─────────────────── ①b 停止路径：Linux 也不能是「没有 launchd 服务可停」的死路 ───────────────────

test("★ linux：/dsh-remote/stop 必须真的把守护停掉（旧版只会回「没有 launchd 服务可停」）", async () => {
  const env = await makeEnv({ haveSystemd: false });
  const routes = boot(env.relayDir);
  const srv = await serve(routes);
  try {
    await postJson(srv.base, "/dsh-remote/connect/retry"); // 先把守护拉起来
    for (let i = 0; i < 100 && !existsSync(env.marker); i += 1) await sleep(50);
    assert.ok(existsSync(env.marker), "前置条件：守护已被拉起");
    const pid = Number(readFileSync(path.join(env.relayDir, ".dsh-watcher.pid"), "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 1, "pid 文件里应有真实 pid");

    const stop = await postJson(srv.base, "/dsh-remote/stop");
    assert.equal(stop.status, 200, `停止必须成功，实际 ${JSON.stringify(stop.body && stop.body.detail)}`);
    assert.ok(!/launchd/.test(String(stop.body.detail || "")), "不该再说「没有 launchd 服务可停」");
    // 进程真的没了。⚠️ 不能用 `process.kill(pid, 0)` 单独判：已死但**尚未被 reap** 的进程
    // 处于僵尸态（Z），对它发信号仍然成功 —— 直接断言会把"其实已经停了"判成失败（实测踩到）。
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    assert.ok(stat === "" || /^Z/.test(stat),
      `★ 停止后守护进程必须真的退出（当前 stat=${stat || "已不存在"}）—— 否则切换账号会继续用旧凭据跑`);
  } finally {
    killPidFile(env.relayDir);
    await srv.close();
    routes.dispose();
    await env.restore();
  }
});

// ─────────────────── ② 上游发现：NAS 上 dsh web 在非默认端口（实测 2298） ───────────────────

test("★ 候选端口包含「本机所有回环监听端口」，且排在静态 3080/43120 之前", () => {
  const list = candidatePorts({ relayDir: "", env: {}, platform: "linux", listenPorts: [2298, 22] });
  const hit = list.find((e) => e.port === 2298);
  assert.ok(hit, "★ 2298 必须在候选里 —— 飞牛用户就是卡在它不在候选里");
  assert.equal(hit.source, "listen");
  // ⚠️ 不能断言"2298 的下标 < 3080 的下标"：开发机自己就可能在 3080 上跑着 dsh web，
  //    那样 3080 会先以 process 来源入表（去重后 static 那条就没了）→ 断言与机器状态耦合。
  //    要锁的是**不变量**：监听端口整段排在静态兜底候选之前。
  const firstListen = list.findIndex((e) => e.source === "listen");
  const firstStatic = list.findIndex((e) => e.source === "static");
  assert.ok(firstListen >= 0 && firstStatic >= 0, "两个来源都必须存在");
  assert.ok(firstListen < firstStatic, "监听端口必须排在静态候选之前，否则永远轮不到它");
});

test("身份校验 /dsh-remote/self：认自己的路由、拒陌生 JSON", () => {
  assert.equal(looksLikeDshRemoteSelf(200, '{"ok":true,"version":"0.6.15","channel":"latest","runtimeReady":true,"relayDir":"/x/.dsh-remote"}'), true);
  assert.equal(looksLikeDshRemoteSelf(200, '{"hello":"world"}'), false);
  assert.equal(looksLikeDshRemoteSelf(404, '{"relayDir":"/x"}'), false, "404 不算");
});

test("★ 行为：首页认不出来但 /dsh-remote/self 认得出 → 仍判为 dsh web（登录页/门户场景）", async () => {
  // 模拟"首页是登录页/门户，一个 dsh 特征都没有"的部署：只有插件自己的路由能证明身份
  const host = http.createServer((req, res) => {
    if (new URL(req.url, "http://x").pathname === "/dsh-remote/self") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"version":"0.6.15","channel":"latest","runtimeReady":true,"relayDir":"/x"}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>Welcome</title><body>please sign in</body></html>");
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${host.address().port}`;
  try {
    assert.equal(await probeDshWeb(url), true, "★ 第二条判据必须救回这类部署");
  } finally {
    await new Promise((r) => host.close(r));
  }
});

test("Linux：/proc/net/tcp 解析（NAS 上没有任何外部命令也能列出监听端口）", () => {
  // 只能断言"真机上这个函数不抛、且返回整数端口"（内容随环境变化，不锁死具体值）
  const ports = procNetLoopbackPorts();
  assert.ok(Array.isArray(ports));
  for (const p of ports) assert.ok(Number.isInteger(p) && p > 0 && p < 65536, `端口非法: ${p}`);
  const all = allLoopbackListeningPorts("linux");
  assert.ok(Array.isArray(all));
  for (const p of all) assert.ok(Number.isInteger(p) && p > 0 && p < 65536, `端口非法: ${p}`);
});

test("静态护栏：本文件里的关键接线必须还在（lest 回归时静默失效）", () => {
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(src, /if \(isLinux\(\)\) return startBridgeLinux\(relayDir\)/, "startBridge 必须有 Linux 分支");
  assert.match(src, /if \(!isDarwin\(\) && manualStatus\(relayDir\)\.watcher\.length > 0\)/, "自愈就绪判据必须覆盖 Linux");
  assert.match(src, /async function discoverUpstreamSelf\(/, "插件半必须能主动发现上游");
  assert.match(src, /\.\.\/runtime\/clients\/dsh-remote\/upstream-discovery\.mjs/, "发现实现必须复用运行时那一份（不写第三份）");
  assert.ok(!/当前平台（\$\{osPlatform\(\)\}）暂不支持自启动服务/.test(src) || /isLinux\(\)/.test(src),
    "Linux 不再走 unsupported 分支");
  void nodeFs;
});

// ─────────────────── ③ 日志噪音：同一条失败不许每轮刷一遍 ───────────────────

test("★ 用户反馈锁：同一条自动启动失败**不许每轮刷日志**（实测被刷了 13~19 遍）", async () => {
  // 现场：两条用户反馈的安装日志里，同一行
  //   `自动启动 bridge 未成功(unsupported): 当前平台（linux）暂不支持自启动服务`
  // 分别重复 19 次 / 13 次（自愈每轮都重试，每次都写一行）。用户复制过来的诊断里全是重复行，
  // 第一现场被淹没 —— 那次我们只能靠"数行数 ÷ 每分钟行数"才推出时间线。
  const env = await makeEnv({ haveSystemd: false });
  const logPath = path.join(env.relayDir, ".dsh-setup-install.log");
  const lines = () => {
    try { return readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("自动启动 bridge 未成功")); }
    catch { return []; }
  };
  try {
    assert.equal(__noteAutostartFailure(env.relayDir, "unsupported", "当前平台（linux）暂不支持自启动服务"), 1);
    assert.equal(lines().length, 1, "第一次失败必须记一行（否则用户什么都看不到）");
    for (let i = 0; i < 3; i += 1) __noteAutostartFailure(env.relayDir, "unsupported", "当前平台（linux）暂不支持自启动服务");
    assert.equal(lines().length, 1, `同一条结论不得重复刷屏，实际 ${lines().length} 行`);
    assert.ok(lines()[0].includes("自动启动 bridge 未成功"), "第一行要是人话原话");
    // 到 5 次时补一行"还在失败、已 5 次"，让用户知道不是一次性的
    __noteAutostartFailure(env.relayDir, "unsupported", "当前平台（linux）暂不支持自启动服务");
    assert.equal(lines().length, 2, "第 5 次补一行累计说明");
    assert.match(lines()[1], /已连续 5 次/, "要说明是「还在失败」，而不是新的故障");
    // 结论变了（换了个原因）→ 必须立刻记新的一行
    __noteAutostartFailure(env.relayDir, "failed", "运行环境入口脚本不存在");
    assert.equal(lines().length, 3, "原因变了就是新信息，要记");
    // 成功后清状态 → 下次失败重新记第一行
    __clearAutostartFailure(env.relayDir);
    assert.equal(__noteAutostartFailure(env.relayDir, "unsupported", "当前平台（linux）暂不支持自启动服务"), 1);
    assert.equal(lines().length, 4);
  } finally {
    killPidFile(env.relayDir);
    await env.restore();
  }
});

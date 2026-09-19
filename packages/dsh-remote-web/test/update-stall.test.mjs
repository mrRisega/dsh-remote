/**
 * 「更新/补装 卡死」回归（0.6.9 新增）—— 直接对应用户侧 0.6.8 诊断报告。
 *
 * 报告的核心结论：旧的三套卡死治理（sweepStaleMarkers / runOnlineUpdate 的陈旧判定 / 镜像回退）
 * **判据全选错了** —— 它们问的是"标记还在不在 / 进程还活不活"，没有一套在问"它还在不在往前推进"。
 * 而中国网络访问 `registry.npmjs.org` 的**典型**失败形态恰恰是**挂起**：
 * 进程活着、标记是新的、却永远不产出任何事件（没有 exit、没有新日志）→
 * 回退永不触发、标记永不清除、用户永久停在「更新中」，而装机数就是不涨。
 *
 * 本文件用**真的会卡住的子进程**（假 npx：只 sleep、什么都不写）把链路压到亚秒级验证：
 *   ① 卡住会被判定出来（stalled）→ ② 进程被结束 → ③ 自动换源重试 → ④ 仍失败则如实记 `update_stalled`
 *   → ⑤ 标记被清掉（用户可以重试，不再永久转圈）；另有孤儿回收、轮询驱动自愈、取消接口、通道自洽。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 15000, step = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

/** 造一个"会卡住"的假 npx：只睡、不写任何输出（= 挂起的形态）。 */
const HANGING_NPX = `#!/bin/sh
sleep 600
`;

/**
 * 隔离环境：假 HOME、假 npx 目录、极短的看门狗阈值。
 * 注意 DSH_UPDATE_IDLE_MS / DSH_STALL_POLL_MS 只用于把链路压到亚秒级，生产不设。
 */
async function makeEnv({ npxBody = HANGING_NPX } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-stall-"));
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  const home = path.join(root, "home");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(fakeBin, "npx"), npxBody);
  await chmod(path.join(fakeBin, "npx"), 0o755);

  const saved = {};
  for (const k of ["HOME", "DSH_SETUP_NPX_DIR", "DSH_RELAY_SKIP_SERVICE", "DSH_UPDATE_IDLE_MS",
    "DSH_INSTALL_IDLE_MS", "DSH_STALL_POLL_MS", "DSH_REMOTE_TELEMETRY", "DSH_UPDATE_TAG"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_UPDATE_IDLE_MS = "400";     // 400ms 无输出即判卡住
  process.env.DSH_STALL_POLL_MS = "80";
  delete process.env.DSH_RELAY_SKIP_SERVICE;  // 要 spawn 真子进程（隔离只靠假 HOME/npx 目录）

  return {
    root, relayDir, home, fakeBin,
    marker: path.join(relayDir, ".dsh-update-running"),
    log: path.join(relayDir, ".dsh-update.log"),
    async restore() {
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

const post = async (base, p, body) => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })).json();
const get = async (base, p) => (await fetch(base + p)).json();

// ─────────────── ① 卡住 → 判定 → 结束 → 换源重试 → 如实记失败 ───────────────

test("更新卡住（进程活着但零输出）：看门狗结束进程、换源重试、最终如实记 update_stalled", async () => {
  const env = await makeEnv();
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    const started = await post(base, "/dsh-remote/self/update");
    assert.equal(started.ok, true, `更新应能启动：${JSON.stringify(started)}`);
    assert.ok(started.pid > 0);

    // ① 进行中就要能看到"距离上次输出多久"（面板据此显示"疑似卡住"）
    const during = await get(base, "/dsh-remote/self/update-log");
    assert.equal(during.running, true);
    assert.equal(typeof during.elapsedMs, "number");
    assert.equal(typeof during.idleMs, "number");
    assert.equal(during.idleThresholdMs, 400);

    // ② 卡住后必须被判出来（stalled）并被结束 → 标记最终清掉、失败如实记录
    const cleared = await waitFor(() => !existsSync(env.marker), { timeout: 12000 });
    assert.equal(cleared, true, "★卡住后标记必须被清掉（否则用户永久停在「更新中」，且无法重试）");

    const log = readFileSync(env.log, "utf8");
    assert.match(log, /无输出/, "日志要写明卡住判据" + `\n实际日志：\n${log.slice(-800)}`);
    assert.match(log, /回退默认源/, "★卡住必须触发与 exit≠0 相同的换源回退（旧实现只认退出码）");

    const after = await get(base, "/dsh-remote/self/update-log");
    assert.equal(after.running, false);
    assert.ok(after.failure, "必须给用户一个可查询的失败原因，而不是静默");
    assert.equal(after.failure.failCode, "update_stalled", "★归因码必须是 update_stalled（否则统计里看不到「卡死」这一类）");
    assert.match(String(after.failure.detail), /没有响应|无输出|卡住/);
  } finally {
    host.close();
    await env.restore();
  }
});

test("看门狗不会误杀在推进的进程（有输出就持续放行）", async () => {
  // 假 npx：每 200ms 往日志写一行 —— 一直在推进，绝不能被杀
  const env = await makeEnv({ npxBody: `#!/bin/sh
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  echo "[fake-npx] progress $i" >> "\${DSH_TEST_UPDATE_LOG:-/dev/null}"
  sleep 0.2
done
sleep 600
` });
  // 让假 npx 把进度写进真正的更新日志
  const realLog = env.log;
  const prevEnvLog = process.env.DSH_TEST_UPDATE_LOG;
  process.env.DSH_TEST_UPDATE_LOG = realLog;
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    const r = await post(base, "/dsh-remote/self/update");
    assert.equal(r.ok, true);
    await sleep(2400); // 远超 400ms 的卡死阈值，但进程一直在写
    assert.equal(existsSync(env.marker), true, "★在推进的进程不得被判定卡住");
    const st = await get(base, "/dsh-remote/self/update-log");
    assert.equal(st.running, true);
    assert.equal(st.stalled, false, "有持续输出时 stalled 必须为 false");
    // 收尾：取消它
    const c = await post(base, "/dsh-remote/self/update/cancel");
    assert.equal(c.ok, true);
  } finally {
    if (prevEnvLog === undefined) delete process.env.DSH_TEST_UPDATE_LOG; else process.env.DSH_TEST_UPDATE_LOG = prevEnvLog;
    host.close();
    await env.restore();
  }
});

// ─────────────── ② 孤儿回收（P2） ───────────────

test("孤儿回收：宿主启动时，把「活着但早已不推进」的更新进程结束掉并清标记", async () => {
  const env = await makeEnv();
  // 造一个真实的挂起子进程，并把它的 pid 写进 marker（模拟宿主被重启后的残留）
  const { spawn } = await import("node:child_process");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  await writeFile(env.marker, JSON.stringify({ pid: sleeper.pid, at: Date.now() - 60 * 60 * 1000 }));
  await writeFile(env.log, "[update] 开始在线更新（旧的、早就卡住的一轮）\n");
  // 把日志 mtime 推到很久以前：等价于"一小时没有任何输出"
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(env.log, old, old);
  try {
    boot(env.relayDir); // apply() 内部会跑 sweepStaleMarkers
    const dead = await waitFor(() => {
      try { process.kill(sleeper.pid, 0); return false; } catch { return true; }
    }, { timeout: 5000 });
    assert.equal(dead, true, "★挂死的子进程必须被结束（旧实现只「判活」、从不「结束」 → 孤儿累积）");
    assert.equal(existsSync(env.marker), false, "标记也要清掉，用户才能重试");
  } finally {
    try { sleeper.kill("SIGKILL"); } catch { /* 已退出 */ }
    await env.restore();
  }
});

// ─────────────── ③ 复用面板轮询驱动自愈（F5） ───────────────

test("面板轮询驱动自愈：/bridge-status 顺手结束卡住的更新并给出可重试的失败原因", async () => {
  const env = await makeEnv();
  const { spawn } = await import("node:child_process");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  await writeFile(env.marker, JSON.stringify({ pid: sleeper.pid, at: Date.now() - 30 * 60 * 1000 }));
  await writeFile(env.log, "[update] 开始在线更新（卡住的一轮）\n");
  const old = new Date(Date.now() - 30 * 60 * 1000);
  await utimes(env.log, old, old);
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  // ⚠️ 标记必须在 boot **之后**重新写一遍：boot 时的 sweepStaleMarkers 会先把残留清掉，
  //    那验证的就不是"轮询驱动"了（那是上一个用例的职责）。
  await writeFile(env.marker, JSON.stringify({ pid: sleeper.pid, at: Date.now() - 30 * 60 * 1000 }));
  await utimes(env.log, old, old);
  try {
    assert.equal(existsSync(env.marker), true, "前置：标记应存在");
    await get(base, "/dsh-remote/bridge-status"); // 面板每 2~3s 就在打这个接口
    assert.equal(existsSync(env.marker), false, "★轮询必须顺手清掉卡死的更新（补装能自愈靠的就是「每次轮询再试一次」）");
    const st = await get(base, "/dsh-remote/self/update-log");
    assert.equal(st.failure && st.failure.failCode, "update_stalled");
    let alive = true;
    try { process.kill(sleeper.pid, 0); } catch { alive = false; }
    assert.equal(alive, false, "卡住的进程要被结束");
  } finally {
    try { sleeper.kill("SIGKILL"); } catch { /* 已退出 */ }
    host.close();
    await env.restore();
  }
});

// ─────────────── ④ 取消接口 ───────────────

test("取消更新：结束子进程 + 清标记 + 不把「用户主动取消」算成失败遥测", async () => {
  const env = await makeEnv();
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    const r = await post(base, "/dsh-remote/self/update");
    assert.equal(r.ok, true);
    const c = await post(base, "/dsh-remote/self/update/cancel");
    assert.equal(c.ok, true);
    assert.equal(c.cleared, true);
    assert.equal(existsSync(env.marker), false);
    const st = await get(base, "/dsh-remote/self/update-log");
    assert.equal(st.running, false);
    assert.equal(st.failure && st.failure.failCode, "user_cancelled", "取消要留本地记录（面板据此说「已取消」而不是「已完成」）");
    const log = readFileSync(env.log, "utf8");
    assert.match(log, /用户取消/);
  } finally {
    host.close();
    await env.restore();
  }
});

// ─────────────── ⑤ 通道自洽（F4） ───────────────

test("通道自洽：面板能看到当前通道；预发版装机不再被默认拉到稳定版", () => {
  const src = INDEX_SRC.slice(INDEX_SRC.indexOf("function updateChannel()"), INDEX_SRC.indexOf("const UPDATE_TAG = updateChannel();"));
  const mk = (envTag, version) => new Function("process", "PLUGIN_VERSION",
    `${src}; return updateChannel();`)({ env: envTag ? { DSH_UPDATE_TAG: envTag } : {} }, version);
  assert.equal(mk("", "0.6.8"), "latest", "正式版装机 → latest");
  assert.equal(mk("", "0.6.9-beta.1"), "beta", "★预发版装机必须沿用 beta（否则面板点更新 = 降级）");
  assert.equal(mk("alpha", "0.6.8"), "alpha", "显式指定优先（作者主动切通道）");
  assert.equal(mk("@beta", "0.6.8"), "beta", "允许带 @ 前缀");
  // 接口要把它下发出去
  assert.match(INDEX_SRC, /channel: UPDATE_TAG/, "/self 与 /self/update-log 都要下发 channel");
  const logStart = INDEX_SRC.indexOf('path: "/dsh-remote/self/update-log"');
  const logRoute = INDEX_SRC.slice(logStart, logStart + 1600); // 取该路由自身的一段，不依赖相邻路由顺序
  for (const f of ["channel", "elapsedMs", "idleMs", "idleThresholdMs", "stalled"]) {
    assert.ok(new RegExp(`${f}[:,]`).test(logRoute), `update-log 必须下发 ${f}`);
  }
});

// ─────────────── ⑥ 旧格式标记（潜伏缺陷） ───────────────

test("旧格式标记（纯时间戳数字）不再抛错、且能被超时清理", async () => {
  const env = await makeEnv();
  try {
    // 旧格式：文件内容就是一个数字时间戳（历史版本写的形态）
    await writeFile(env.marker, String(Date.now() - 40 * 60 * 1000));
    boot(env.relayDir); // apply() → sweepStaleMarkers
    assert.equal(existsSync(env.marker), false,
      "★旧格式标记必须能被清理（readMarkerInfo 曾因 raw 作用域写错而对旧格式抛 ReferenceError，导致它们永远清不掉）");
    // 未超时的旧格式标记则不该被清
    await writeFile(env.marker, String(Date.now()));
    boot(env.relayDir);
    assert.equal(existsSync(env.marker), true, "没过期的标记不动它");
  } finally {
    await env.restore();
  }
});

// ─────────────── ⑦ 补装路径同样有看门狗 ───────────────

test("补装（运行环境安装）同样受看门狗保护：卡住即结束并按 runtime_install_timeout 归因", async () => {
  const env = await makeEnv();
  process.env.DSH_INSTALL_IDLE_MS = "400";
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    // 触发补装：环境缺失 + 已登录账号
    await writeFile(path.join(env.relayDir, ".dsh-config.json"), JSON.stringify({
      phone: "13800000000", password: "pw", api_url: "http://127.0.0.1:1",
    }));
    await post(base, "/dsh-remote/start"); // 缺运行环境 → ensureRuntime 后台补装
    const installMarker = path.join(env.relayDir, ".dsh-setup-installing");
    const started = await waitFor(() => existsSync(installMarker), { timeout: 5000 });
    assert.equal(started, true, "应已开始后台补装");

    // 卡住 400ms 后：标记必须被清掉（否则会一直显示"正在安装"）
    const cleared = await waitFor(() => !existsSync(installMarker), { timeout: 12000 });
    assert.equal(cleared, true, "★补装卡住后标记必须清理，否则「正在安装…」永远不动（装机流失的直接原因）");
    const log = readFileSync(path.join(env.relayDir, ".dsh-setup-install.log"), "utf8");
    assert.match(log, /无输出/, "补装日志要写明卡住判据：" + log.slice(-500));
  } finally {
    host.close();
    await env.restore();
  }
});

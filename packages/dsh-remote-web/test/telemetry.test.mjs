// 匿名装机/连接遥测（客户端半）回归 —— 契约 + 隐私边界（2026-09）。
//
// 现场（2026-09 生产数据）：11 个新注册用户里只有 3 人把设备连上——6 人电脑端从未安装、2 人装了但
// bridge 没连上；而「装不上」的人没有任何账号、也就没有任何数据，「本地 OK、新机器失败」无法归因。
// 本用例锁死这条补上的通道：
//   ① 触发点正确：plugin_loaded / install_started / install_failed(fail_code) / runtime_ready /
//      bridge_started / bridge_registered / tunnel_disconnected / first_remote_ok(只一次) / panel_opened；
//   ② 契约形状：POST <api_url>/api/telemetry/events + content-type + x-dsh-client: dsh-remote/<version>，
//      **无 Authorization**；body { install_id, source, events[] }，单批 ≤20、≤32KB、事件名/失败码白名单；
//   ③ install_id：本机随机 UUID、落盘 0600、复用同一值（不跨机器派生）；
//   ④ 队列：0600、上限 200 丢最旧；≥5 条立即发、否则 60s 心跳；失败退避、6 次后丢弃该批；
//   ⑤ 开关：DSH_REMOTE_TELEMETRY=0 → 零请求零文件（连 install_id 都不生成）；
//   ⑥ 隐私：payload 里不得出现 phone/password/hostname/machine_fp/IP/路径等任何禁止字段（含对抗性 extra）；
//   ⑦ 静默：发送失败/退避/关闭时必须不影响面板路由与连接流程（响应照常返回）。
//
// 手法与 connect-loop.test.mjs 一致：真实分支 + PATH 上的假 launchctl/pgrep/ps/npx，绝不碰本机真实服务。
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply, __telemetryInternals as TELEMETRY } from "../lib/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（避免固定 sleep 在并行/高负载下假失败）。 */
async function waitFor(fn, { timeout = 5000, step = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
}

const ALLOWED_EVENT_KEYS = new Set(["name", "at", "version", "os", "arch", "node", "fail_code"]);
/** 禁止出现在遥测 payload 里的字段/取值（隐私边界；见 docs/telemetry.md「不采集什么」）。 */
const FORBIDDEN = [
  "phone", "password", "passwd", "email", "token", "secret", "authorization", "bearer",
  "hostname", "username", "machine_fp", "device_id", "/Users/", "/home/", "13800000000",
];

const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
case "$1" in
  print)
    printf 'state = %s\\n' "$DSH_TEST_STATE"
    printf 'pid = %s\\n' "$DSH_TEST_PID"
    printf 'runs = %s\\n' "$DSH_TEST_RUNS"
    printf 'last exit code = %s\\n' "$DSH_TEST_EXIT"
    ;;
  list)
    printf '%s\\n' "$DSH_TEST_LIST"
    ;;
esac
exit 0
`;
const FAKE_PGREP = `#!/bin/sh
if [ -n "$DSH_TEST_PGREP" ]; then printf '%s\\n' "$DSH_TEST_PGREP"; exit 0; fi
exit 1
`;
const FAKE_PS = `#!/bin/sh
printf '1\\n'
exit 0
`;
/** 假 npx：只记录参数，绝不做真实安装；退出码由 DSH_TEST_NPX_EXIT 控制。 */
const FAKE_NPX = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_NPX_LOG"
exit ${"${DSH_TEST_NPX_EXIT:-0}"}
`;

const SECRET = "secret-telemetry-1";
const TMP_DIRS = [];

/** 假账号 API：只关心 /api/telemetry/events（可切换 500/200 以验证退避与出队）。 */
function startFakeRelay(opts = {}) {
  const telemetry = [];       // {headers, body, raw}
  const seen = [];
  let telemetryStatus = opts.telemetryStatus === undefined ? 200 : opts.telemetryStatus;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    seen.push({ method: req.method, path: url.pathname });
    if (req.method === "POST" && url.pathname === "/api/telemetry/events") {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      telemetry.push({ headers: req.headers, body, raw });
      if (telemetryStatus !== 200) return send(telemetryStatus, { error: { code: "boom" } });
      return send(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/public-config") {
      return send(200, { service: "dsh-remote", app_url: "https://app.test/", api_url: `http://127.0.0.1:${srv.address().port}`, bridge_secret: SECRET });
    }
    if (req.method === "POST" && url.pathname === "/api/device-login") return send(200, { token: "jwt-tel" });
    if (req.method === "GET" && url.pathname === "/api/devices") return send(200, { devices: [] });
    return send(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    srv, telemetry, seen, port: srv.address().port,
    setTelemetryStatus(s) { telemetryStatus = s; },
    count(p) { return seen.filter((s) => s.path === p).length; },
  })));
}

/**
 * 隔离环境：假 HOME + 假 launchctl/pgrep/ps/npx + 临时 relayDir。
 * 默认加速节奏（DSH_REMOTE_TELEMETRY_MS）+ 走真实分支（unset DSH_RELAY_SKIP_SERVICE）。
 */
async function setup({ runtime = true, telemetryMs = "10", skipService = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-telemetry-"));
  TMP_DIRS.push(root);
  const fakeHome = path.join(root, "home");
  const fakeBin = path.join(root, "bin");
  const relayDir = path.join(root, "relay");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(relayDir, { recursive: true });
  const launchLog = path.join(root, "launchctl.log");
  const npxLog = path.join(root, "npx.log");
  await writeFile(launchLog, "");
  await writeFile(npxLog, "");
  for (const [name, script] of [["launchctl", FAKE_LAUNCHCTL], ["pgrep", FAKE_PGREP], ["ps", FAKE_PS], ["npx", FAKE_NPX]]) {
    await writeFile(path.join(fakeBin, name), script);
    await chmodSync(path.join(fakeBin, name), 0o755);
  }
  if (runtime) await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub");

  const saved = {};
  const KEYS = ["HOME", "PATH", "DSH_TEST_LAUNCH_LOG", "DSH_TEST_NPX_LOG", "DSH_TEST_STATE", "DSH_TEST_PID",
    "DSH_TEST_RUNS", "DSH_TEST_EXIT", "DSH_TEST_LIST", "DSH_TEST_PGREP", "DSH_TEST_NPX_EXIT",
    "DSH_RELAY_SKIP_SERVICE", "DSH_SETUP_NPX_DIR", "DSH_RELAY_SELFHEAL_MS", "DSH_BRIDGE_INSTALL_SOURCE",
    "DSH_REMOTE_TELEMETRY", "DSH_REMOTE_TELEMETRY_MS", "DSH_RELAY_RESTART_DRYRUN"];
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = launchLog;
  process.env.DSH_TEST_NPX_LOG = npxLog;
  process.env.DSH_TEST_STATE = "stopped";
  process.env.DSH_TEST_PID = "0";
  process.env.DSH_TEST_RUNS = "0";
  process.env.DSH_TEST_EXIT = "0";
  process.env.DSH_TEST_LIST = "";
  process.env.DSH_TEST_NPX_EXIT = "0";
  delete process.env.DSH_TEST_PGREP;
  delete process.env.DSH_BRIDGE_INSTALL_SOURCE;
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  process.env.DSH_REMOTE_TELEMETRY = "1";               // 显式开启（用例要验证真实发送；关掉的分支另有专门用例）
  if (telemetryMs) process.env.DSH_REMOTE_TELEMETRY_MS = telemetryMs; else delete process.env.DSH_REMOTE_TELEMETRY_MS;
  process.env.DSH_RELAY_SELFHEAL_MS = "60000";          // 让后台 watcher 不参与用例节奏
  if (skipService) process.env.DSH_RELAY_SKIP_SERVICE = "1"; else delete process.env.DSH_RELAY_SKIP_SERVICE;

  return {
    root, fakeHome, fakeBin, relayDir, launchLog, npxLog,
    setState(v) { process.env.DSH_TEST_STATE = v; },
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      TELEMETRY.reset(relayDir);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 装载插件路由（收集 disposer：否则自愈/遥测定时器会跨用例继续跑）。 */
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
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

async function writeConfig(relayDir, relayPort, extra = {}) {
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", device_id: "dev-telemetry",
    api_url: `http://127.0.0.1:${relayPort}`, bridge_secret: SECRET,
    ...extra,
  }));
}

const bridgeStatus = async (base) => (await (await fetch(`${base}/dsh-remote/bridge-status`)).json());
const telemetryFilesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".telemetry")) : []);
const readOrEmpty = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/**
 * 「本机已产生过的事件」= 已送达的（假中继收到的）∪ 仍在本地队列里的。
 * 按 name|at|version 去重，避免「正在发送中的那一批」在队列与中继两边被重复计数。
 */
function observed(relay, relayDir) {
  const map = new Map();
  const add = (ev) => { if (ev && ev.name) map.set(`${ev.name}|${ev.at}|${ev.version || ""}`, ev); };
  for (const req of relay.telemetry) for (const ev of (req.body?.events || [])) add(ev);
  for (const ev of TELEMETRY.queueOf(relayDir)) add(ev);
  const list = [...map.values()];
  return { list, names: list.map((e) => e.name), count: (n) => list.filter((e) => e.name === n).length, has: (n) => list.some((e) => e.name === n) };
}

/** 断言一次请求完全符合冻结契约与隐私边界（形状 + 白名单 + 禁止字段）。 */
function assertContractRequest(req, { eventNames, failCodes }) {
  // 头：content-type + x-dsh-client，且**不带 Authorization**（完全匿名）
  assert.match(String(req.headers["content-type"] || ""), /application\/json/, "必须声明 application/json");
  assert.match(String(req.headers["x-dsh-client"] || ""), /^dsh-remote\/\d+\.\d+\.\d+/, "x-dsh-client 必须是 dsh-remote/<version>");
  assert.equal(req.headers.authorization, undefined, "匿名通道：绝不能带 Authorization");
  assert.ok(!/authorization/i.test(req.raw), "payload 里不得出现 authorization");
  // body 形状
  assert.match(String(req.body.install_id), /^[0-9a-f-]{36}$/i, "install_id 必须是随机 UUID");
  assert.equal(req.body.source, "plugin");
  assert.ok(Array.isArray(req.body.events) && req.body.events.length > 0, "events 必须是非空数组");
  assert.ok(req.body.events.length <= TELEMETRY.batchMax, "单批 ≤ 20 条");
  assert.ok(Buffer.byteLength(req.raw, "utf8") <= TELEMETRY.bodyMax, "body ≤ 32KB");
  for (const ev of req.body.events) {
    assert.ok(eventNames.includes(ev.name), "事件名必须在白名单内：" + ev.name);
    for (const k of Object.keys(ev)) assert.ok(ALLOWED_EVENT_KEYS.has(k), "payload 出现契约外字段：" + k);
    assert.equal(typeof ev.at, "number");
    assert.equal(typeof ev.version, "string");
    assert.equal(typeof ev.os, "string");
    assert.equal(typeof ev.arch, "string");
    assert.match(String(ev.node), /^\d+$/, "node 只能是主版本号数字字符串");
    if (ev.name === "install_failed" || ev.name === "update_failed") {
      assert.ok(failCodes.includes(ev.fail_code), "fail_code 必须在白名单内：" + ev.fail_code);
    }
  }
  // 禁止字段（含取值形态）：hostname / 用户名 / 路径 / 手机号 / 凭据 / 设备指纹 / IP 一律不得出现
  for (const bad of FORBIDDEN) {
    assert.ok(!req.raw.toLowerCase().includes(bad.toLowerCase()), "遥测 payload 不得包含禁止字段：" + bad);
  }
  assert.ok(!/"\d{1,3}(\.\d{1,3}){3}"/.test(req.raw), "不得上报 IP");
}

test("触发点：plugin_loaded → install_started → runtime_ready → bridge_started → bridge_registered/first_remote_ok", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: false }); // 市场只装了面板插件：缺运行环境
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    // ① apply() 一次 → plugin_loaded；② 缺运行环境 → 后台补装 → install_started
    let seen = observed(relay, env.relayDir);
    assert.ok(seen.has("plugin_loaded"), "插件装载必须入队 plugin_loaded，实际：" + seen.names.join(","));
    assert.ok(seen.has("install_started"), "缺运行环境必须入队 install_started，实际：" + seen.names.join(","));

    const { host, base } = await serve(routes);
    try {
      // ③ 运行环境补齐（dsh-setup.mjs 落地）→ 面板轮询触达探针 → runtime_ready
      await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
      let r = await bridgeStatus(base);
      assert.equal(r.ok, true);
      assert.equal(r.connect.phase, "starting", "环境在但服务没起 → starting");
      seen = observed(relay, env.relayDir);
      assert.ok(seen.has("runtime_ready"), "环境补齐后必须入队 runtime_ready，实际：" + seen.names.join(","));
      assert.ok(seen.has("bridge_started"), "阶段 starting 必须入队 bridge_started，实际：" + seen.names.join(","));

      // ④ 反复轮询不得重复计数（每进程每阶段只发一次）
      await bridgeStatus(base);
      await bridgeStatus(base);
      assert.equal(observed(relay, env.relayDir).count("bridge_started"), 1, "bridge_started 每进程只一条");

      // ⑤ 中继注册成功（状态文件 tunnel_registered_at + 进程在跑 + 账号设备表已登记）→ online
      await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({
        device_id: "dev-telemetry", phase: "online", tunnel_registered_at: Date.now(), account_bound_at: Date.now(),
      }));
      env.setState("running");
      process.env.DSH_TEST_PID = String(process.pid);
      process.env.DSH_TEST_PGREP = "4242 /path/dsh-bridge.mjs";
      r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "online", "注册证据齐备 → online");
      seen = observed(relay, env.relayDir);
      assert.ok(seen.has("bridge_registered"), "online 必须入队 bridge_registered，实际：" + seen.names.join(","));
      assert.ok(seen.has("first_remote_ok"), "首次 online 且账号可见 → first_remote_ok，实际：" + seen.names.join(","));
      await bridgeStatus(base);
      seen = observed(relay, env.relayDir);
      assert.equal(seen.count("bridge_registered"), 1);
      assert.equal(seen.count("first_remote_ok"), 1, "first_remote_ok 只一次");

      // ⑥ 面板打开（浏览器半调用的本地路由）：每进程一次
      await fetch(`${base}/dsh-remote/telemetry/panel-opened`, { method: "POST" });
      await fetch(`${base}/dsh-remote/telemetry/panel-opened`, { method: "POST" });
      await sleep(60); // 让进行中的批次落定，再统一统计
      assert.equal(observed(relay, env.relayDir).count("panel_opened"), 1);
      assert.equal(TELEMETRY.queueOf(env.relayDir).length, 0, "假中继 200 → 应全部送达并出队");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("契约：批量发送的形状/头/白名单完全符合冻结契约，且身份是匿名随机 UUID", async () => {
  const relay = await startFakeRelay();
  const env = await setup();
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      // 造够 ≥5 条事件 → 立即发送
      TELEMETRY.record(env.relayDir, "install_started");
      TELEMETRY.record(env.relayDir, "install_failed", { fail_code: "npm_unreachable" });
      TELEMETRY.record(env.relayDir, "install_failed", { fail_code: "不在白名单里的原因" }); // → unknown
      TELEMETRY.record(env.relayDir, "runtime_ready");
      TELEMETRY.record(env.relayDir, "harness_restart");
      TELEMETRY.record(env.relayDir, "update_failed", { fail_code: "npm_eacces" });

      const sent = await waitFor(() => (relay.telemetry.length ? relay.telemetry : false));
      assert.ok(sent, "队列 ≥5 条必须立即批量发送");
      const req = sent[0];
      assertContractRequest(req, { eventNames: TELEMETRY.eventNames, failCodes: TELEMETRY.failCodes });
      const names = req.body.events.map((e) => e.name);
      assert.ok(names.includes("install_started") && names.includes("runtime_ready") && names.includes("harness_restart"));
      const unknown = req.body.events.find((e) => e.name === "install_failed" && e.fail_code === "unknown");
      assert.ok(unknown, "白名单外的 fail_code 必须归为 unknown（原始文本不外发）");
      // 未登录/无账号也照发：这是匿名通道，与账号体系无关
      assert.equal(req.body.events.every((e) => !("device_id" in e)), true);
      // 已送达 → 出队
      await waitFor(() => TELEMETRY.queueOf(env.relayDir).length === 0);
      assert.equal(TELEMETRY.queueOf(env.relayDir).length, 0, "成功送达必须出队");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("隐私审计：对抗性 extra 字段（手机号/hostname/machine_fp/路径/密码）一律进不了 payload", async () => {
  const relay = await startFakeRelay();
  const env = await setup();
  try {
    await writeConfig(env.relayDir, relay.port);
    boot(env.relayDir);
    // 直接往唯一的构造点灌脏数据：字段白名单 + 事件名校验必须把它们全部丢掉
    TELEMETRY.record(env.relayDir, "install_started", { device_id: "dev-telemetry", machine_fp: "fp-abc" });
    TELEMETRY.record(env.relayDir, "plugin_loaded", { hostname: "mac.local", username: "mac" });
    TELEMETRY.record(env.relayDir, "panel_opened", { path: "/Users/mac/.dsh-remote", phone: "13800000000" });
    TELEMETRY.record(env.relayDir, "update_started", { email: "a@b.c", token: "jwt", password: "pw" });
    TELEMETRY.record(env.relayDir, "harness_restart", { ip: "1.2.3.4" });
    // 白名单外的事件名：一条都不入队
    assert.equal(TELEMETRY.record(env.relayDir, "user_login", { phone: "13800000000" }), false, "白名单外事件名必须被拒");
    assert.equal(TELEMETRY.record(env.relayDir, "page_view", {}), false);

    const sent = await waitFor(() => (relay.telemetry.length ? relay.telemetry : false));
    assert.ok(sent, "应发出这一批");
    for (const req of sent) assertContractRequest(req, { eventNames: TELEMETRY.eventNames, failCodes: TELEMETRY.failCodes });
    const raw = sent.map((s) => s.raw).join("");
    for (const bad of ["13800000000", "mac.local", "fp-abc", "/Users/mac", "1.2.3.4", "a@b.c"]) {
      assert.ok(!raw.includes(bad), "payload 泄漏了敏感取值：" + bad);
    }
    // 源码级约束：唯一的 payload 构造点里不得出现禁止字段名
    const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
    const start = src.indexOf("function telemetryEventOf(");
    assert.ok(start > 0, "必须存在唯一的 payload 构造点 telemetryEventOf");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    for (const bad of ["phone", "password", "hostname", "machine_fp", "username", "device_id", "\\bip\\b", "path"]) {
      assert.ok(!new RegExp(bad).test(body), "payload 构造点里不得出现禁止字段：" + bad);
    }
    for (const allowed of ["name", "at", "version", "os", "arch", "node", "fail_code"]) {
      assert.ok(body.includes(allowed), "payload 构造点应只含白名单字段：" + allowed);
    }
  } finally { await env.restore(); relay.srv.close(); }
});

test("开关：DSH_REMOTE_TELEMETRY=0 → 零请求零文件（连 install_id 都不生成）", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ runtime: false });
  try {
    process.env.DSH_REMOTE_TELEMETRY = "0";
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      await bridgeStatus(base);
      await fetch(`${base}/dsh-remote/telemetry/panel-opened`, { method: "POST" });
      await writeFile(path.join(env.relayDir, "dsh-setup.mjs"), "// runtime stub");
      await bridgeStatus(base);
      await sleep(120); // 给心跳/立即发送若干轮机会
      assert.equal(relay.count("/api/telemetry/events"), 0, "关闭后不得发任何请求");
      assert.deepEqual(telemetryFilesIn(env.relayDir), [], "关闭后不得生成任何 .telemetry-* 文件");
      assert.equal(TELEMETRY.installId(env.relayDir), null, "关闭后不得生成 install_id");
      assert.equal(TELEMETRY.queueOf(env.relayDir).length, 0);
      assert.equal(TELEMETRY.record(env.relayDir, "install_started"), false, "关闭后不得入队");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("install_id：0600 落盘、跨批次复用；队列文件 0600、上限 200 丢最旧", async () => {
  const relay = await startFakeRelay();
  const env = await setup();
  try {
    // api 指向不可达端口：让发送失败，队列得以观察
    await writeConfig(env.relayDir, 1);
    TELEMETRY.reset(env.relayDir);
    const id1 = TELEMETRY.installId(env.relayDir);
    assert.match(String(id1), /^[0-9a-f-]{36}$/i, "install_id 必须是随机 UUID");
    assert.equal(TELEMETRY.installId(env.relayDir), id1, "再次调用必须复用同一个 install_id");
    assert.equal((statSync(path.join(env.relayDir, ".telemetry-install-id")).mode & 0o777), 0o600, "install_id 必须 0600");

    // 队列上限：205 条 → 只留最后 200 条（丢最旧）
    TELEMETRY.reset(env.relayDir);
    TELEMETRY.record(env.relayDir, "plugin_loaded");                       // 最旧，应被挤掉
    for (let i = 0; i < 204; i++) TELEMETRY.record(env.relayDir, "panel_opened");
    const q = TELEMETRY.queueOf(env.relayDir);
    assert.equal(q.length, TELEMETRY.queueMax, "队列上限必须是 " + TELEMETRY.queueMax);
    assert.ok(!q.some((e) => e.name === "plugin_loaded"), "超出上限必须丢最旧");
    assert.equal((statSync(path.join(env.relayDir, ".telemetry-queue.json")).mode & 0o777), 0o600, "队列文件必须 0600");
    await sleep(80); // 让进行中的失败发送收尾（失败不出队）
    assert.equal(TELEMETRY.queueOf(env.relayDir).length, TELEMETRY.queueMax, "发送失败不得丢事件");
    assert.ok(relay.count("/api/telemetry/events") === 0, "不该碰假中继（api 指向不可达端口）");
  } finally { await env.restore(); relay.srv.close(); }
});

test("失败退避：不阻塞主流程；退避窗口内不重试；累计 6 次后丢弃该批", async () => {
  const relay = await startFakeRelay({ telemetryStatus: 500 });
  const env = await setup({ telemetryMs: "10" });
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    const { host, base } = await serve(routes);
    try {
      TELEMETRY.record(env.relayDir, "install_started");
      TELEMETRY.record(env.relayDir, "install_failed", { fail_code: "npm_unreachable" });
      TELEMETRY.record(env.relayDir, "runtime_ready");
      TELEMETRY.record(env.relayDir, "bridge_started");
      TELEMETRY.record(env.relayDir, "bridge_registered");
      await waitFor(() => relay.count("/api/telemetry/events") >= 1);
      const st = TELEMETRY.stateOf(env.relayDir);
      assert.equal(st.attempts, 1, "第一次失败后应进入退避计数 1");
      assert.ok(st.nextAt > Date.now(), "退避窗口内必须推后重试时间");

      // 退避窗口内显式再发一次：不得产生新请求（避免失败风暴）
      const before = relay.count("/api/telemetry/events");
      await TELEMETRY.flush(env.relayDir);
      assert.equal(relay.count("/api/telemetry/events"), before, "退避窗口内不得重试");

      // 静默：发送一直失败时，面板/连接路由照常可用（响应时间不受影响）
      const t0 = Date.now();
      const r = await fetch(`${base}/dsh-remote/bridge-status`);
      const body = await r.json();
      const cost = Date.now() - t0;
      assert.equal(r.status, 200, "发送失败不得影响面板路由");
      assert.equal(body.ok, true);
      assert.ok(cost < 2000, "面板路由不得被遥测发送拖慢，实际 " + cost + "ms");

      // 累计 6 次仍失败 → 丢弃该批（不永久堆积）
      const ok = await waitFor(() => TELEMETRY.queueOf(env.relayDir).length === 0, { timeout: 8000 });
      assert.ok(ok, "6 次失败后必须丢弃该批（队列清零）");
      const total = relay.count("/api/telemetry/events");
      assert.ok(total >= 6, "必须真的重试到 6 次，实际 " + total);
      assert.ok(total <= 12, "重试次数不得失控，实际 " + total);
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("送达即出队：失败过一批后恢复 200 → 队列清空且不再重复发送", async () => {
  const relay = await startFakeRelay({ telemetryStatus: 500 });
  const env = await setup({ telemetryMs: "20" });
  try {
    await writeConfig(env.relayDir, relay.port);
    boot(env.relayDir);
    TELEMETRY.record(env.relayDir, "install_started");
    TELEMETRY.record(env.relayDir, "runtime_ready");
    TELEMETRY.record(env.relayDir, "bridge_started");
    TELEMETRY.record(env.relayDir, "bridge_registered");
    TELEMETRY.record(env.relayDir, "panel_opened");
    await waitFor(() => relay.count("/api/telemetry/events") >= 1);
    const queuedAfterFail = TELEMETRY.queueOf(env.relayDir).length;
    assert.ok(queuedAfterFail >= 5, "失败不得丢事件，实际队列 " + queuedAfterFail);
    relay.setTelemetryStatus(200);
    const drained = await waitFor(() => TELEMETRY.queueOf(env.relayDir).length === 0, { timeout: 8000 });
    assert.ok(drained, "退避到期后重试应送达并清空队列");
    assert.equal(observed(relay, env.relayDir).count("install_started"), 1, "送达后不得重复发送（install_started 只有一条）");
    const sentCount = relay.count("/api/telemetry/events");
    const delivered = relay.telemetry[relay.telemetry.length - 1];
    assertContractRequest(delivered, { eventNames: TELEMETRY.eventNames, failCodes: TELEMETRY.failCodes });
    await sleep(120);
    assert.equal(relay.count("/api/telemetry/events"), sentCount, "送达后不得重复发送");
  } finally { await env.restore(); relay.srv.close(); }
});

test("掉线与重启：tunnel_disconnected 同一掉线周期只一条；harness_restart 触发即入队并跨进程补发", async () => {
  const relay = await startFakeRelay();
  const env = await setup();
  try {
    await writeConfig(env.relayDir, relay.port);
    const routes = boot(env.relayDir);
    // 掉线前：日志显示已注册成功；状态文件曾 online（wasRegistered 记忆）
    await writeFile(path.join(env.relayDir, ".dsh-bridge.log"),
      "[bridge] 隧道已连 wss://relay/_bridge,注册 dev-telemetry...\n[bridge] ✅ router 注册成功: dev-telemetry\n");
    await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({ phase: "online", tunnel_registered_at: Date.now() }));
    const { host, base } = await serve(routes);
    try {
      // online（进程在跑）→ 建立「曾注册」记忆
      env.setState("running");
      process.env.DSH_TEST_PGREP = "4242 /path/dsh-bridge.mjs";
      let r = await bridgeStatus(base);
      assert.equal(r.connect.phase, "online");

      // 掉线：日志新增「隧道断开」，状态文件回到 connecting（KeepAlive 仍在跑）
      await writeFile(path.join(env.relayDir, ".dsh-bridge.log"),
        "[bridge] 隧道已连 wss://relay/_bridge,注册 dev-telemetry...\n[bridge] ✅ router 注册成功: dev-telemetry\n"
        + "[bridge] 隧道断开(code=1006)\n[bridge] 2s 后重连...\n");
      await writeFile(path.join(env.relayDir, ".dsh-bridge-state.json"), JSON.stringify({ phase: "connecting" }));
      await bridgeStatus(base);
      await bridgeStatus(base); // 同一掉线周期再轮询两次
      await sleep(60);          // 让已排队的事件落定（假中继 200 会很快发出去）
      assert.equal(observed(relay, env.relayDir).count("tunnel_disconnected"), 1,
        "同一掉线周期只发一条 tunnel_disconnected");

      // 重启：dry-run 也走同一入口（真实重启会换进程，用例只锁埋点）
      process.env.DSH_RELAY_RESTART_DRYRUN = "1";
      const rr = await fetch(`${base}/dsh-remote/harness/restart`, { method: "POST" });
      assert.equal(rr.status, 200);
      await sleep(60);
      assert.equal(observed(relay, env.relayDir).count("harness_restart"), 1, "重启触发一次记一条");
    } finally { host.close(); routes.dispose(); }
  } finally { await env.restore(); relay.srv.close(); }
});

test("跨进程补发：上一进程遗留的磁盘队列在下次装载时立刻发出（重启前的事件不丢）", async () => {
  const relay = await startFakeRelay();
  const env = await setup();
  try {
    await writeConfig(env.relayDir, relay.port);
    // 模拟「上一进程把 harness_restart 落在盘上就退出了」
    await writeFile(path.join(env.relayDir, ".telemetry-queue.json"), JSON.stringify({
      v: 1,
      events: [{ name: "harness_restart", at: Date.now() - 5000, version: "0.0.0-test", os: "darwin", arch: "arm64", node: "22" }],
    }), { mode: 0o600 });
    const routes = boot(env.relayDir); // apply() → telemetryStart 读回队列并立即补发
    assert.ok(TELEMETRY.queueOf(env.relayDir).some((e) => e.name === "harness_restart"), "磁盘队列必须被读回");
    const sent = await waitFor(() => (relay.telemetry.length ? relay.telemetry : false));
    assert.ok(sent, "遗留队列必须在下次装载时立刻补发");
    assert.ok(sent[0].body.events.some((e) => e.name === "harness_restart"));
    // 队列文件里的外来垃圾（非白名单事件名）不得被转发
    await writeFile(path.join(env.relayDir, ".telemetry-queue.json"), JSON.stringify({
      v: 1, events: [{ name: "user_login", phone: "13800000000" }],
    }), { mode: 0o600 });
    TELEMETRY.reset(env.relayDir);
    routes.dispose();
    const before = relay.telemetry.length;
    boot(env.relayDir);
    await sleep(120);
    for (const req of relay.telemetry.slice(before)) {
      assert.ok(!(req.body?.events || []).some((e) => e.name === "user_login"), "队列里的非白名单事件不得被发出");
      assert.ok(!req.raw.includes("13800000000"), "队列里的非白名单事件内容不得被转发");
    }
    assert.equal(TELEMETRY.queueOf(env.relayDir).filter((e) => e.name === "user_login").length, 0);
  } finally { await env.restore(); relay.srv.close(); }
});

test("不为遥测创建配置目录 / 测试隔离：隔离开关下零副作用，且代码里没有为遥测建目录", async () => {
  const relay = await startFakeRelay();
  const env = await setup({ skipService: true }); // 诊断/测试隔离（DSH_RELAY_SKIP_SERVICE=1）
  try {
    await rm(env.relayDir, { recursive: true, force: true }); // 模拟「只装了插件、从未生成过配置目录」
    boot(env.relayDir);
    await sleep(120);
    assert.equal(existsSync(env.relayDir), false, "隔离开关下遥测不得创建任何东西");
    assert.equal(telemetryFilesIn(env.relayDir).length, 0);
    assert.equal(relay.count("/api/telemetry/events"), 0, "隔离开关下绝不得把事件发到真实端点");
    assert.equal(TELEMETRY.record(env.relayDir, "install_started"), false, "隔离开关下不得入队");
    // 源码级：遥测段落不得出现「为统计创建配置目录」的动作（否则会改变卸载/安装判定的既有语义）
    const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
    const section = src.slice(src.indexOf("// ---------- 匿名装机/连接遥测"), src.indexOf("/**\n * 安装信息上报（插件侧通道）"));
    assert.ok(section.length > 2000, "必须定位到遥测段落");
    assert.ok(!/mkdirSync\(\s*relayDir/.test(section), "遥测不得为统计创建配置目录");
    assert.ok(section.includes("telemetryDirReady"), "落盘必须先判断配置目录已存在");
  } finally { await env.restore(); relay.srv.close(); }
});

test("面板可见性：关于卡片写明「匿名统计 + 关闭方式」，并链到 README/docs/telemetry.md", () => {
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(client, /匿名装机统计/, "面板必须有匿名统计说明");
  assert.match(client, /DSH_REMOTE_TELEMETRY=0/, "面板必须写明关闭方法");
  assert.ok(client.includes("README.md#匿名装机统计与隐私"), "面板必须链到 README 对应段落");
  assert.ok(client.includes("docs/telemetry.md"), "面板必须链到完整字段清单");
  assert.match(client, /不含任何账号、手机号、会话或文件内容/, "面板必须写明不采集什么");
  assert.ok(client.includes("/dsh-remote/telemetry/panel-opened"), "面板打开事件必须走本地路由（浏览器半不直连遥测端点）");
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.match(readme, /## 匿名装机统计与隐私/, "README 必须有对应小节（面板链接的锚点）");
  assert.ok(readme.includes("docs/telemetry.md"), "README 必须链到 docs/telemetry.md");
  assert.match(readme, /DSH_REMOTE_TELEMETRY=0/, "README 必须写明关闭方法");
  const doc = readFileSync(new URL("../../../docs/telemetry.md", import.meta.url), "utf8");
  for (const line of ["不采集什么", "如何关闭", "hostname", "machine_fp", "IP", "DSH_REMOTE_TELEMETRY=0"]) {
    assert.ok(doc.includes(line), "docs/telemetry.md 必须覆盖：" + line);
  }
  for (const name of TELEMETRY.eventNames) assert.ok(doc.includes(name), "docs/telemetry.md 必须列出事件：" + name);
  for (const code of TELEMETRY.failCodes) assert.ok(doc.includes(code), "docs/telemetry.md 必须列出失败码：" + code);
});

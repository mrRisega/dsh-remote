// 微信机器人通道「绑定 / 解绑」跳变的匿名遥测（客户端半）回归 —— 2026-09。
//
// 现场：微信通道是**两态**的（未绑定 / 已绑定，见 docs/wechat-bot-channel.md §9），
// 但「有多少人真的绑上了、绑上之后会不会掉」此前完全没有数据面。本用例锁死这件事的四个要点：
//   ① **跳变才发**：unbound→bound = wechat_bound，bound→unbound = wechat_unbound；
//      连续读到同一个 bound（面板打开期间会反复轮询 status）**一条都不发** —— 按次计数会让
//      "一台机器的一次绑定"变成几十条，指标直接失去意义；
//   ② **首次观测不是跳变**：启动时状态文件已经是 bound:true，说明绑定可能发生在几天前，
//      只播种基线、不发事件（把它当新绑定会系统性虚高 —— 这是最容易写错的一条）；
//   ③ **读不出 = 没有观测**：状态文件缺失 / 损坏 / 半写既不抛进面板路由，也**不当作 unbound**；
//   ④ **隐私**：只发事件名 + 版本/平台串；bot_id / bot_token / 绑定的微信用户标识 / 手机号
//      一个都不许出现在 payload 里（本文件对**序列化后的**事件断言，不看源码文字）。
//
// 手法：与 telemetry.test.mjs 一致 —— 假 HOME + PATH 上的假 launchctl/pgrep/ps/npx（绝不碰本机真实服务），
// 与 wechat-proxy.test.mjs 一致 —— 假控制面 + 真面板路由（观测点挂在唯一的代理出口上）。
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply, __telemetryInternals as TELEMETRY } from "../lib/index.js";

const SECRET = "sec-wechat-tel-abc123";
/** 控制面契约里唯一的密钥头（与 wechat-runtime.mjs 的 CONTROL_HEADER 同值）。 */
const HDR = "x-dsh-bridge-secret";
/** 事件 payload 允许出现的字段（与 telemetry.test.mjs / telemetryEventOf() 同一份白名单）。 */
const ALLOWED_EVENT_KEYS = new Set(["name", "at", "version", "harness_version", "channel", "os", "arch", "node", "fail_code"]);
/** 绝不允许出现在 payload 里的字段名/取值（隐私边界）。 */
const FORBIDDEN = ["bot_id", "bot_token", "token", "phone", "password", "openid", "wxid", "bound_at", "last_error", "13800000000", "wxbot-secret-9f8e"];

const TMP_ROOTS = [];

const FAKE_LAUNCHCTL = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_LAUNCH_LOG"
case "$1" in
  print) printf 'state = %s\\n' "$DSH_TEST_STATE"; printf 'pid = %s\\n' "$DSH_TEST_PID"; ;;
  list) printf '%s\\n' "$DSH_TEST_LIST"; ;;
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
const FAKE_NPX = `#!/bin/sh
printf '%s\\n' "$*" >> "$DSH_TEST_NPX_LOG"
exit ${"${DSH_TEST_NPX_EXIT:-0}"}
`;

/**
 * 隔离环境（沿用 telemetry.test.mjs 的 setup）：假 HOME + 假 launchctl/pgrep/ps/npx + 临时 relayDir。
 * 与那边唯一的差别：这里**必须走真实遥测分支**（删掉 DSH_RELAY_SKIP_SERVICE，否则 telemetryEnabled() 恒 false），
 * 所以假二进制一个都不能少 —— 真实分支会去碰 launchctl/pgrep/npx。
 * api_url 指向本地死端口 127.0.0.1:9：发送必然失败并留在本地队列（用例断言的就是队列），
 * 且 scripts/test-net-guard.cjs 只放行 loopback，绝不会打到生产。
 */
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-wx-tel-"));
  TMP_ROOTS.push(root);
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
  // 运行环境已就绪（dsh-setup.mjs 在）→ ensureRuntime 是零副作用 no-op，不会触发任何真实安装
  await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub");
  // ⚠️ 只放 bridge_secret + 本地 api_url，**不放账号凭据**：本用例只走微信代理与匿名遥测，
  //    不需要登录。放了 phone/password 会顺带触发装机上报链（失败后 350ms 重试一次），
  //    而用例在几十毫秒内就拆掉了临时目录 → 重试时会读到空配置并回落到 DEFAULT_API 去打生产公开配置
  //    （被 scripts/test-net-guard.cjs 拦下，但那是一条不该出现的真实请求）。
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    api_url: "http://127.0.0.1:9", bridge_secret: SECRET,
  }));

  const KEYS = ["HOME", "PATH", "DSH_TEST_LAUNCH_LOG", "DSH_TEST_NPX_LOG", "DSH_TEST_STATE", "DSH_TEST_PID",
    "DSH_TEST_LIST", "DSH_TEST_PGREP", "DSH_TEST_NPX_EXIT", "DSH_RELAY_SKIP_SERVICE", "DSH_SETUP_NPX_DIR",
    "DSH_RELAY_SELFHEAL_MS", "DSH_REMOTE_TELEMETRY", "DSH_REMOTE_TELEMETRY_MS"];
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBin}:${saved.PATH}`;
  process.env.DSH_TEST_LAUNCH_LOG = launchLog;
  process.env.DSH_TEST_NPX_LOG = npxLog;
  process.env.DSH_TEST_STATE = "stopped";
  process.env.DSH_TEST_PID = "0";
  process.env.DSH_TEST_LIST = "";
  process.env.DSH_TEST_NPX_EXIT = "0";
  delete process.env.DSH_TEST_PGREP;
  process.env.DSH_SETUP_NPX_DIR = fakeBin;
  process.env.DSH_REMOTE_TELEMETRY = "1";               // 显式开启（关闭的分支另有专门用例）
  delete process.env.DSH_REMOTE_TELEMETRY_MS;           // 不加速心跳：本用例只观察队列，60s 心跳期内不会发送
  process.env.DSH_RELAY_SELFHEAL_MS = "60000";
  delete process.env.DSH_RELAY_SKIP_SERVICE;            // ★ 必须删：否则 telemetryEnabled() 恒 false

  return {
    root, relayDir,
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      TELEMETRY.reset(relayDir);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 假控制面（与 wechat-proxy.test.mjs 同一套语义）：只认密钥头，status 回一个合法状态体。 */
function startFakeControl() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      seen.push({ method: req.method, path: url.pathname, header: req.headers[HDR] || "" });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
      if ((req.headers[HDR] || "") !== SECRET) return send(401, { ok: false, error: "unauthorized" });
      if (`${req.method} ${url.pathname}` === "GET /wechat/status") {
        return send(200, { ok: true, bound: false, bot_id: "", bound_at: 0, connected_at: 0, last_push_ok_at: 0, last_error: "" });
      }
      return send(404, { ok: false, error: "no such route" });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port })));
}

/** 装载插件路由（与 wechat-proxy.test.mjs / quota-absent.test.mjs 同一套 boot 方式）。 */
async function bootHost(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  return { host, base: `http://127.0.0.1:${host.address().port}`, dispose: () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } } };
}

/** 起一个完整环境：假控制面 + 配置 + 发现文件 + 面板宿主。 */
async function boot(opts = {}) {
  const control = await startFakeControl();
  const env = await setup();
  // 关闭遥测的用例必须在**装载之前**关掉：apply() 本身会记 plugin_loaded，
  // 装载后再关会留下一条"开启期间"的队列文件，断言"零文件"就变成假阳性/假阴性。
  if (opts.telemetry === false) process.env.DSH_REMOTE_TELEMETRY = "0";
  await writeFile(path.join(env.relayDir, ".wechat-control.json"),
    JSON.stringify({ port: control.port, pid: process.pid, started_at: Date.now(), header: HDR }));
  const host = await bootHost(env.relayDir);
  return {
    ...env, control, base: host.base, host: host.host,
    async close() {
      host.host.close();
      host.dispose();
      control.srv.close();
      await env.restore();
    },
  };
}

/** 写 <relayDir>/.wechat-state.json（bridge 的财产；本用例只**写**它，插件只读它）。 */
async function writeState(relayDir, state) {
  await writeFile(path.join(relayDir, ".wechat-state.json"),
    typeof state === "string" ? state : JSON.stringify(state));
}

const UNBOUND = { bound: false, bot_id: "", bound_at: 0, connected_at: 0, last_push_ok_at: 0, last_error: "" };
const BOUND = {
  bound: true, bot_id: "wxbot-secret-9f8e", bound_at: 1758000000000, connected_at: 1758000001000,
  last_push_ok_at: 1758000002000, last_error: "",
};

async function status(base) {
  const res = await fetch(`${base}/dsh-remote/wechat/status`);
  let body = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; }
  return { status: res.status, body };
}

/** 本机已产生的绑定类事件（只看队列：api_url 指向死端口，事件不会出队）。 */
function wechatEvents(relayDir) {
  return TELEMETRY.queueOf(relayDir).filter((e) => e.name === "wechat_bound" || e.name === "wechat_unbound");
}
const namesOf = (relayDir) => wechatEvents(relayDir).map((e) => e.name).join(",");
const telemetryFilesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".telemetry")) : []);

test("跳变：unbound→bound 恰好一条 wechat_bound；稳态 bound 反复读不再发", async () => {
  const env = await boot();
  try {
    // ① 首次观测到未绑定：只播种基线，没有任何事件
    await writeState(env.relayDir, UNBOUND);
    let r = await status(env.base);
    assert.equal(r.status, 200);
    assert.equal(namesOf(env.relayDir), "", "首次观测（未绑定）不得发任何事件");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), false, "首次观测必须播种基线 false");

    // ② 用户扫码绑定完成 → 跳变，恰好一条 wechat_bound
    await writeState(env.relayDir, BOUND);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "wechat_bound", "unbound→bound 必须发且只发一条 wechat_bound");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), true, "基线必须前进到 true");

    // ③ 稳态：面板会反复轮询 status，一条都不能再多（按次计数会让一次绑定刷成几十条）
    await status(env.base);
    await status(env.base);
    await status(env.base);
    assert.equal(wechatEvents(env.relayDir).length, 1, "稳态 bound 不得重复计数");
    assert.equal(namesOf(env.relayDir), "wechat_bound");

    // ④ 未观测（文件被删）不得被当成 unbound → 不得出现假跳变
    await rm(path.join(env.relayDir, ".wechat-state.json"), { force: true });
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "wechat_bound", "文件缺失 = 没有观测，不得伪造跳变");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), true, "没有观测时基线必须原地不动");
  } finally { await env.close(); }
});

test("跳变：bound→unbound 恰好一条 wechat_unbound；之后反复读不再发", async () => {
  const env = await boot();
  try {
    // 启动时已经绑好（首次观测 = 播种，不发事件；这条规则另有专门用例）
    await writeState(env.relayDir, BOUND);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "", "首次观测（已绑定）不得发 wechat_bound");

    await writeState(env.relayDir, { ...UNBOUND, last_error: "用户主动解绑" });
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "wechat_unbound", "bound→unbound 必须发且只发一条 wechat_unbound");

    await status(env.base);
    await status(env.base);
    assert.equal(wechatEvents(env.relayDir).length, 1, "稳态 unbound 不得重复计数");

    // 再次绑定 → 又一次 wechat_bound（同一条链路可反复绑定/解绑，每次都如实记一条）
    await writeState(env.relayDir, BOUND);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "wechat_unbound,wechat_bound");
  } finally { await env.close(); }
});

test("★ 首次观测不是跳变：进程启动时状态文件已经是 bound:true → 一条 wechat_bound 都不发", async () => {
  const env = await boot();
  try {
    // bridge 在几天前就绑好了，宿主/面板现在才第一次读到它
    await writeState(env.relayDir, BOUND);
    await status(env.base);
    await status(env.base);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "", "启动时已绑定必须只播种基线，绝不能计入新增绑定（否则存量被每天虚报一遍）");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), true);

    // 反向同理：启动时未绑定 → 也只是一次播种
    await rm(path.join(env.relayDir, ".telemetry-once.json"), { force: true });
    TELEMETRY.reset(env.relayDir);
    await writeState(env.relayDir, UNBOUND);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "", "首次观测未绑定同样只是播种");
  } finally { await env.close(); }
});

test("开关：DSH_REMOTE_TELEMETRY=0 → 零事件、零遥测文件；观测本身返回 null", async () => {
  const env = await boot({ telemetry: false });
  try {
    await writeState(env.relayDir, UNBOUND);
    let r = await status(env.base);
    assert.equal(r.status, 200, "关闭遥测不得影响面板路由");
    await writeState(env.relayDir, BOUND);
    r = await status(env.base);
    assert.equal(r.status, 200);
    await status(env.base);

    assert.equal(wechatEvents(env.relayDir).length, 0, "关闭后不得产生任何绑定/解绑事件");
    assert.equal(TELEMETRY.observeWeChat(env.relayDir), null, "关闭后观测必须是 no-op（返回 null）");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), null, "关闭后连基线都不许落盘");
    assert.deepEqual(telemetryFilesIn(env.relayDir), [], "关闭后不得生成任何 .telemetry-* 文件");
  } finally { await env.close(); }
});

test("读不出 = 没有观测：状态文件缺失 / 损坏 / 非对象 / bound 不是布尔，都不抛、都不算 unbound", async () => {
  const env = await boot();
  try {
    // ① 从来没有过状态文件（bridge 还没装微信通道）
    let r = await status(env.base);
    assert.equal(r.status, 200, "状态文件缺失不得影响面板路由");
    assert.equal(namesOf(env.relayDir), "");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), null, "没观测过 → 基线必须仍是 null（不是 false）");

    // ② 损坏（半写 / 手改坏）
    await writeState(env.relayDir, "<<<broken>>>");
    r = await status(env.base);
    assert.equal(r.status, 200, "状态文件损坏不得抛进面板路由");
    assert.equal(namesOf(env.relayDir), "", "损坏 = 没有观测，不得当作 unbound");
    assert.equal(TELEMETRY.wechatBoundBaseline(env.relayDir), null);

    // ③ 形状不对（null / 数组 / bound 是字符串）→ 同样视为没有观测
    for (const bad of ["null", "[]", JSON.stringify({ bound: "true" }), JSON.stringify({})]) {
      await writeState(env.relayDir, bad);
      r = await status(env.base);
      assert.equal(r.status, 200, `形状不合法(${bad})不得抛`);
      assert.equal(namesOf(env.relayDir), "", `形状不合法(${bad})不得产生事件`);
    }

    // ④ 损坏之后第一次真正读到的值仍然是「首次观测」→ 只播种，不发
    await writeState(env.relayDir, BOUND);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "", "损坏期不得留下任何基线痕迹，恢复后第一次读到只能是播种");
    // ⑤ 之后真正的跳变照常记一条（且只记 unbound 这一条，不补发 bound）
    await writeState(env.relayDir, UNBOUND);
    await status(env.base);
    assert.equal(namesOf(env.relayDir), "wechat_unbound");
  } finally { await env.close(); }
});

test("隐私：序列化后的 payload 不含 bot_id / token / 绑定标识 / 手机号，且字段只有白名单那 9 个", async () => {
  const env = await boot();
  try {
    await writeState(env.relayDir, UNBOUND);
    await status(env.base);
    await writeState(env.relayDir, BOUND);
    await status(env.base);
    const events = wechatEvents(env.relayDir);
    assert.equal(events.length, 1);
    const ev = events[0];
    // 字段白名单：一条事件只允许这 9 个键（其余一律进不来）
    for (const k of Object.keys(ev)) assert.ok(ALLOWED_EVENT_KEYS.has(k), "payload 出现契约外字段：" + k);
    assert.equal(ev.name, "wechat_bound");
    assert.equal(typeof ev.harness_version, "string");
    assert.equal(typeof ev.channel, "string");
    // 序列化后的整条事件里不得出现任何标识性字段名或取值
    const raw = JSON.stringify(ev) + JSON.stringify(TELEMETRY.queueOf(env.relayDir));
    for (const bad of FORBIDDEN) {
      assert.ok(!raw.toLowerCase().includes(bad.toLowerCase()), "遥测 payload 不得包含：" + bad);
    }
    // 反向确认：状态文件里确实有这些标识（否则上面的断言是空转）
    const stateRaw = await (await import("node:fs/promises")).readFile(path.join(env.relayDir, ".wechat-state.json"), "utf8");
    assert.ok(stateRaw.includes("wxbot-secret-9f8e"), "夹具必须真的把 bot_id 写进状态文件，否则隐私断言是空转");
  } finally { await env.close(); }
});

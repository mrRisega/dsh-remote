/**
 * dingtalk-auth — 扫码授权会话「持久化 + 断点续轮询」单测（2026-11-08）。
 *
 * 零真实网络：注入假 fetch 模拟 `/app/registration/{init,begin,poll}`，用临时 relayDir 验证落盘/清理/状态。
 * 覆盖：begin 写 0600 文件、重启后 resume 继续轮询、成功后写 im-bots.json 并删 auth 文件、
 * FAIL/EXPIRED 清理、网络错误继续重试、过期不重试、并发 begin 覆盖旧会话、secret 不进日志、bridge 接线源级契约。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DINGTALK_AUTH_CMD_FILE,
  DINGTALK_AUTH_FILE,
  __resetDingtalkAuthForTest,
  authStatus,
  beginDingtalkAuth,
  cancelDingtalkAuth,
  handleDingtalkAuthCommand,
  readDingtalkAuthSession,
  resumeDingtalkAuth,
  startDingtalkAuthCommandWatcher,
  stopDingtalkAuthCommandWatcher,
  stopDingtalkAuthPolling
} from "../dingtalk-auth.mjs";
import {
  IM_BOTS_FILE,
  IM_BOT_STATUS_FILE,
  fileMode
} from "../wecom-bot.mjs";

const SECRET = "ScanSecret-Never-Log-987654";
const CLIENT = "ding-scan-client-xyz";
const URL_OK = "https://dingtalk.test/registration/verify?nonce=abc";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { label = "条件", timeout = 5000, interval = 15 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

function tmpRelayDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ding-auth-"));
}

/**
 * 假钉钉注册 API。
 * @param {{init?:object, begins?:object[], polls?:any[]}} script
 *   polls 每项：{status:"WAITING"|"SUCCESS"|"FAIL"|"EXPIRED", client_id?, client_secret?} 或 "throw"（网络错误）
 */
function fakeApi(script = {}) {
  const calls = [];
  let initCount = 0;
  let beginCount = 0;
  let pollCount = 0;
  const respond = (json, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  const fetchImpl = async (url, init0) => {
    const u = String(url);
    let body = {};
    try { body = JSON.parse(init0 && init0.body ? init0.body : "{}"); } catch { body = {}; }
    calls.push({ url: u, body });
    if (u.endsWith("/app/registration/init")) {
      initCount += 1;
      return respond(script.init || { nonce: `nonce-${initCount}` });
    }
    if (u.endsWith("/app/registration/begin")) {
      const begins = Array.isArray(script.begins) ? script.begins : [];
      const item = begins[beginCount] || {
        device_code: `dc-${beginCount + 1}`,
        verification_uri_complete: URL_OK,
        interval: 1,
        expires_in: 7200
      };
      beginCount += 1;
      if (item && item.__throw) throw new Error("network down");
      return respond(item);
    }
    if (u.endsWith("/app/registration/poll")) {
      const polls = Array.isArray(script.polls) ? script.polls : [];
      const item = polls[pollCount];
      pollCount += 1;
      if (item === "throw") throw new Error("network down");
      if (!item) return respond({ status: "WAITING" });
      if (typeof item === "function") return respond(item(body));
      return respond(item);
    }
    throw new Error(`unexpected url ${u}`);
  };
  return {
    fetchImpl,
    calls,
    get initCalls() { return calls.filter((c) => c.url.endsWith("/init")); },
    get beginCalls() { return calls.filter((c) => c.url.endsWith("/begin")); },
    get pollCalls() { return calls.filter((c) => c.url.endsWith("/poll")); }
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function cleanup(relayDir) {
  try { cancelDingtalkAuth({ relayDir }); } catch { /* 忽略 */ }
  __resetDingtalkAuthForTest();
  fs.rmSync(relayDir, { recursive: true, force: true });
}

// ─────────────────────────── begin ───────────────────────────

test("★ begin：init({source}) → begin({nonce})；会话原子落盘 0600（deviceCode/interval/expiresAt/url）；返回 {url,expiresIn}", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi();
  const logs = [];
  try {
    const r = await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: (l, m) => logs.push(m), pollMs: 30 });
    assert.equal(r.ok, true);
    assert.equal(r.url, URL_OK);
    assert.ok(r.expiresIn >= 60, "expiresIn 来自钉钉 expires_in（分钟级）");
    assert.equal(r.interval, 1);
    // 请求体
    assert.deepEqual(api.initCalls[0].body, { source: "DING_DWS_CLAW" });
    assert.deepEqual(api.beginCalls[0].body, { nonce: "nonce-1" });
    // 落盘
    const file = path.join(relayDir, DINGTALK_AUTH_FILE);
    assert.ok(fs.existsSync(file), "★ 授权会话必须落盘（重启不丢）");
    const sess = readDingtalkAuthSession(relayDir);
    assert.equal(sess.deviceCode, "dc-1");
    assert.equal(sess.url, URL_OK);
    assert.equal(sess.interval, 1);
    assert.ok(sess.expiresAt > Date.now());
    assert.ok(sess.createdAt > 0);
    const disk = readJson(file);
    assert.equal(disk.credentialSource, "scan");
    if (process.platform !== "win32") {
      assert.equal(fileMode(file) & 0o777, 0o600, "★ auth 文件必须 0600（含 device_code）");
    }
    // 插件可读状态
    const st = authStatus({ relayDir });
    assert.equal(st.status, "waiting");
    assert.ok(st.remainingSeconds > 0);
    assert.equal(st.url, URL_OK);
    // 日志不泄漏 device_code
    assert.ok(!logs.join("\n").includes("dc-1"), "日志不得打印 device_code");
  } finally { cleanup(relayDir); }
});

// ─────────────────────────── 断点续轮询 ───────────────────────────

test("★ 重启后 resume 继续轮询 → 拿到凭据写 im-bots.json（scan/enabled/robotCode 缺省 clientId）→ 删 auth 文件 + 状态 connected", async () => {
  const relayDir = tmpRelayDir();
  const logs = [];
  const logger = (l, m) => logs.push(m);
  const api = fakeApi({ polls: [{ status: "WAITING" }, { status: "WAITING" }, { status: "SUCCESS", client_id: CLIENT, client_secret: SECRET }] });
  try {
    await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger, pollMs: 25 });
    await waitFor(() => api.pollCalls.length >= 1, { label: "begin 后立刻 poll" });
    // 模拟「bridge 正常退出」：只停定时器，保留 auth 文件
    stopDingtalkAuthPolling();
    const callsAtStop = api.pollCalls.length;
    await sleep(60);
    assert.equal(api.pollCalls.length, callsAtStop, "停表后不得再 poll");
    assert.ok(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), "★ 停表必须保留 auth 文件（否则重启就丢）");

    // 模拟「bridge 重启」：resume 继续轮询（同一个 device_code）
    const successes = [];
    const resumed = await resumeDingtalkAuth({
      relayDir, fetchImpl: api.fetchImpl, logger, pollMs: 20,
      onSuccess: (info) => successes.push(info)
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.status, "waiting");
    await waitFor(() => readJson(path.join(relayDir, IM_BOTS_FILE)), { label: "写 im-bots.json" });

    const bots = readJson(path.join(relayDir, IM_BOTS_FILE));
    const d = bots.dingtalk;
    assert.equal(d.enabled, true, "★ 扫码成功后自动启用");
    assert.equal(d.clientId, CLIENT);
    assert.equal(d.clientSecret, SECRET);
    assert.equal(d.credentialSource, "scan", "★ 标记扫码来源");
    assert.equal(d.robotCode, CLIENT, "robotCode 缺省用 clientId（Lead 约定）");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), "★ 成功后必须删除 auth 文件（device_code 作废）");
    const st = readJson(path.join(relayDir, IM_BOT_STATUS_FILE));
    assert.equal(st.dingtalk.state, "connected", "★ 写状态 dingtalk.state=connected（实际连接由 controller 热更新完成）");
    assert.equal(st.dingtalk.credentialSource, "scan");
    assert.deepEqual(successes, [{ clientIdTail: CLIENT.slice(-4), credentialSource: "scan" }], "onSuccess 回调一次");
    assert.equal(authStatus({ relayDir }).status, "success");
    // 所有 poll 必须带同一个 device_code（来自磁盘）
    assert.ok(api.pollCalls.every((c) => c.body.device_code === "dc-1"));
    // secret 不落日志
    assert.ok(!logs.join("\n").includes(SECRET), "★ secret 不得进日志（只打 clientId 尾号）");
    assert.ok(!logs.join("\n").includes(SECRET.slice(0, 8)));
  } finally { cleanup(relayDir); }
});

test("★ FAIL / EXPIRED：写状态原因并清理 auth 文件，不无限重试", async () => {
  for (const [status, expectCode] of [["FAIL", "rejected"], ["EXPIRED", "expired"]]) {
    const relayDir = tmpRelayDir();
    const api = fakeApi({ polls: [{ status }] });
    try {
      await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, pollMs: 20 });
      await waitFor(() => authStatus({ relayDir }).status === "failed", { label: `${status} → failed` });
      const st = readJson(path.join(relayDir, IM_BOT_STATUS_FILE));
      assert.equal(st.dingtalk.state, "failed");
      assert.ok(/授权|过期|拒绝/.test(String(st.dingtalk.lastError || "")), `失败原因要是中文人话（实际：${st.dingtalk.lastError}）`);
      assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), "失败后清理 auth 文件");
      const calls = api.pollCalls.length;
      await sleep(80);
      assert.equal(api.pollCalls.length, calls, "失败后不得继续轮询");
      assert.equal(authStatus({ relayDir }).code, expectCode);
    } finally { cleanup(relayDir); }
  }
});

test("★ 网络错误继续重试（不丢会话）：几次 throw 之后成功", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({
    polls: ["throw", "throw", { status: "WAITING" }, { status: "SUCCESS", client_id: CLIENT, client_secret: SECRET }]
  });
  try {
    await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, pollMs: 15 });
    await waitFor(() => readJson(path.join(relayDir, IM_BOTS_FILE)), { label: "网络恢复后拿到凭据", timeout: 5000 });
    assert.ok(api.pollCalls.length >= 4, `网络错误必须继续重试（实际 poll ${api.pollCalls.length} 次）`);
    assert.equal(readJson(path.join(relayDir, IM_BOTS_FILE)).dingtalk.clientId, CLIENT);
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)));
  } finally { cleanup(relayDir); }
});

test("★ 已过期会话：resume 不轮询、清理文件并写失败状态；无会话时 authStatus=idle", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi();
  try {
    fs.writeFileSync(path.join(relayDir, DINGTALK_AUTH_FILE), JSON.stringify({
      version: 1, deviceCode: "dc-expired", interval: 1,
      expiresAt: Date.now() - 1000, url: URL_OK, createdAt: Date.now() - 60_000, credentialSource: "scan"
    }), { mode: 0o600 });
    const r = await resumeDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, "expired");
    assert.equal(api.pollCalls.length, 0, "★ 过期不得再 poll");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), "过期要清理 auth 文件");
    const st = readJson(path.join(relayDir, IM_BOT_STATUS_FILE));
    assert.equal(st.dingtalk.state, "failed");
    assert.match(String(st.dingtalk.lastError), /过期/);
    // 空目录 → idle
    const empty = tmpRelayDir();
    try { assert.equal(authStatus({ relayDir: empty }).status, "idle"); }
    finally { fs.rmSync(empty, { recursive: true, force: true }); }
  } finally { cleanup(relayDir); }
});

// ─────────────────────────── 并发覆盖 / 取消 / 安全 ───────────────────────────

test("★ 并发 begin：新授权覆盖旧会话（旧 device_code 停止轮询、文件只留新的）", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({
    begins: [
      { device_code: "dc-old", verification_uri_complete: "https://dingtalk.test/old", interval: 1, expires_in: 7200 },
      { device_code: "dc-new", verification_uri_complete: "https://dingtalk.test/new", interval: 1, expires_in: 7200 }
    ],
    polls: [] // 全部 WAITING（新会话不会提前结束）
  });
  try {
    await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, pollMs: 20 });
    await waitFor(() => readDingtalkAuthSession(relayDir).deviceCode === "dc-old", { label: "旧会话" });
    const oldPolls = api.pollCalls.filter((c) => c.body.device_code === "dc-old").length;
    // 立刻发起新的 begin（用户重新扫码）
    const r2 = await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, pollMs: 20 });
    assert.equal(r2.ok, true);
    assert.equal(readDingtalkAuthSession(relayDir).deviceCode, "dc-new", "★ 文件只保留最新会话");
    await sleep(90);
    assert.equal(api.pollCalls.filter((c) => c.body.device_code === "dc-old").length, oldPolls, "★ 旧会话的轮询必须停止（旧 device_code 不再被 poll）");
    assert.ok(api.pollCalls.some((c) => c.body.device_code === "dc-new"), "新会话在轮询");
  } finally { cleanup(relayDir); }
});

test("★ 取消：停轮询 + 删文件 + 状态标记取消；不泄漏 secret", async () => {
  const relayDir = tmpRelayDir();
  const logs = [];
  const api = fakeApi({ polls: [] }); // 一直 WAITING：专门测取消
  try {
    cancelDingtalkAuth({ relayDir }); // 无会话也可安全调用
    await beginDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: (l, m) => logs.push(m), pollMs: 50 });
    await waitFor(() => fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "会话写入" });
    const polls = api.pollCalls.length;
    cancelDingtalkAuth({ relayDir });
    await sleep(80);
    assert.equal(api.pollCalls.length, polls, "取消后不得继续轮询");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)));
    assert.equal(authStatus({ relayDir }).status, "failed");
    assert.equal(authStatus({ relayDir }).code, "cancelled");
    assert.ok(!logs.join("\n").includes(SECRET));
  } finally { cleanup(relayDir); }
});

test("★ bridge 接线（源级契约）：启动时 fire-and-forget resumeDingtalkAuth，退出时 stopDingtalkAuthPolling", () => {
  const bridge = fs.readFileSync(new URL("../dsh-bridge.mjs", import.meta.url), "utf8");
  assert.match(bridge, /from "\.\/dingtalk-auth\.mjs"/);
  assert.match(bridge, /resumeDingtalkAuth\(\{/, "bridge 启动必须调用 resumeDingtalkAuth");
  assert.match(bridge, /void resumeDingtalkAuth\(/, "必须是 fire-and-forget（不阻塞隧道启动）");
  assert.match(bridge, /stopDingtalkAuthPolling\(\)/, "退出时必须停轮询");
  assert.ok(/stopDingtalkAuthPolling\(\);/.test(bridge.split("async function stopImBots")[1] || ""), "停轮询要挂在 stopImBots 里");
});

// ─────────────────────── 控制命令文件（插件 → 桥）───────────────────────

function writeCmd(relayDir, cmd) {
  fs.writeFileSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE), JSON.stringify(cmd), { mode: 0o600 });
}

function authSnapshot(relayDir) {
  const st = readJson(path.join(relayDir, IM_BOT_STATUS_FILE));
  return st && st.dingtalk && st.dingtalk.auth ? st.dingtalk.auth : null;
}

test("★ 命令文件 begin：桥执行 beginDingtalkAuth → 删命令文件；`dingtalk.auth` 就绪且不含 deviceCode/secret", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({ polls: [] });
  try {
    writeCmd(relayDir, { action: "begin", at: 111 });
    const w = startDingtalkAuthCommandWatcher({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, intervalMs: 15, pollMs: 20 });
    assert.equal(w.ok, true);
    await waitFor(() => fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "begin 生效（auth 文件）" });
    await waitFor(() => !fs.existsSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE)), { label: "命令文件被删除" });
    const auth = await waitFor(() => authSnapshot(relayDir), { label: "状态外露 dingtalk.auth" });
    assert.equal(auth.state, "waiting");
    assert.equal(auth.url, URL_OK);
    assert.ok(auth.expiresAt > Date.now());
    assert.ok(auth.remainingSec > 0, "要有剩余秒数（面板显示倒计时）");
    assert.equal(auth.clientIdTail, "");
    const raw = fs.readFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), "utf8");
    assert.ok(!raw.includes("dc-1"), "★ dingtalk.auth 不得含 deviceCode");
    assert.ok(!raw.includes(SECRET), "★ 不得含 secret");
    assert.ok(api.initCalls.length === 1);
  } finally {
    stopDingtalkAuthCommandWatcher();
    cleanup(relayDir);
  }
});

test("★ 重复 at 不重复处理（同 at 再来一次不会重新发起 begin）", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({ polls: [] });
  try {
    writeCmd(relayDir, { action: "begin", at: 222 });
    startDingtalkAuthCommandWatcher({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, intervalMs: 15, pollMs: 20 });
    await waitFor(() => fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "第一次 begin 生效" });
    const initCalls = api.initCalls.length;
    // 删掉 auth 文件以便检测"是否又被 begin 了一次"，再写同 at 命令
    fs.rmSync(path.join(relayDir, DINGTALK_AUTH_FILE), { force: true });
    writeCmd(relayDir, { action: "begin", at: 222 });
    await sleep(120);
    assert.equal(api.initCalls.length, initCalls, "★ 同一 at 不得重复执行");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), "不得重新生成会话");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE)), "重复命令文件也要删掉（避免刷轮询）");
  } finally {
    stopDingtalkAuthCommandWatcher();
    cleanup(relayDir);
  }
});

test("★ 命令文件 cancel：停轮询 + 删 auth 文件；`dingtalk.auth.state=failed` 且 message 是人话", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({ polls: [] });
  try {
    writeCmd(relayDir, { action: "begin", at: 301 });
    startDingtalkAuthCommandWatcher({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, intervalMs: 15, pollMs: 20 });
    await waitFor(() => fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "begin" });
    writeCmd(relayDir, { action: "cancel", at: 302 });
    await waitFor(() => !fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "cancel 生效（auth 文件删除）" });
    await waitFor(() => { const a = authSnapshot(relayDir); return a && a.state === "failed"; }, { label: "状态 failed" });
    const auth = authSnapshot(relayDir);
    assert.match(String(auth.message), /取消/);
    assert.equal(auth.remainingSec, 0);
    assert.equal(auth.url, "");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE)));
    // 取消后不得继续 poll
    const polls = api.pollCalls.length;
    await sleep(80);
    assert.equal(api.pollCalls.length, polls);
  } finally {
    stopDingtalkAuthCommandWatcher();
    cleanup(relayDir);
  }
});

test("★ 扫码成功后 `dingtalk.auth`：state=success + clientIdTail；状态文件不含 deviceCode/secret", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({ polls: [{ status: "WAITING" }, { status: "SUCCESS", client_id: CLIENT, client_secret: SECRET }] });
  try {
    writeCmd(relayDir, { action: "begin", at: 401 });
    startDingtalkAuthCommandWatcher({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, intervalMs: 15, pollMs: 20 });
    await waitFor(() => readJson(path.join(relayDir, IM_BOTS_FILE)), { label: "凭据落盘" });
    const auth = await waitFor(() => { const a = authSnapshot(relayDir); return a && a.state === "success" && a; }, { label: "auth success" });
    assert.equal(auth.clientIdTail, CLIENT.slice(-4));
    assert.equal(auth.remainingSec, 0);
    const raw = fs.readFileSync(path.join(relayDir, IM_BOT_STATUS_FILE), "utf8");
    assert.ok(!raw.includes(SECRET), "★ 状态文件不得含 secret");
    assert.ok(!raw.includes("dc-1"), "★ 状态文件不得含 deviceCode");
    assert.ok(!fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)));
    const botsRaw = fs.readFileSync(path.join(relayDir, IM_BOTS_FILE), "utf8");
    assert.ok(botsRaw.includes(SECRET), "凭据只应写进 im-bots.json（0600）");
    if (process.platform !== "win32") assert.equal(fileMode(path.join(relayDir, IM_BOTS_FILE)) & 0o777, 0o600);
  } finally {
    stopDingtalkAuthCommandWatcher();
    cleanup(relayDir);
  }
});

test("★ 重启后 resume 与命令文件互不干扰：先续轮询旧会话，cancel 命令能停掉它", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({ polls: [] });
  try {
    // 模拟上一轮 bridge 退出时留下的未完成会话
    fs.writeFileSync(path.join(relayDir, DINGTALK_AUTH_FILE), JSON.stringify({
      version: 1, deviceCode: "dc-seed", interval: 1, expiresAt: Date.now() + 60_000,
      url: URL_OK, createdAt: Date.now(), credentialSource: "scan"
    }), { mode: 0o600 });
    const resumed = await resumeDingtalkAuth({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, pollMs: 20 });
    assert.equal(resumed.ok, true);
    await waitFor(() => api.pollCalls.some((c) => c.body.device_code === "dc-seed"), { label: "重启后续轮询旧 device_code" });
    // 同时启动命令监听（bridge 启动流程就是 resume + watcher）
    startDingtalkAuthCommandWatcher({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, intervalMs: 15, pollMs: 20 });
    await waitFor(() => authSnapshot(relayDir), { label: "auth 状态外露" });
    assert.equal(authSnapshot(relayDir).state, "waiting");
    // cancel 命令应停掉续轮询的会话
    writeCmd(relayDir, { action: "cancel", at: 501 });
    await waitFor(() => !fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "cancel 清掉旧会话" });
    const polls = api.pollCalls.length;
    await sleep(80);
    assert.equal(api.pollCalls.length, polls, "cancel 后旧会话轮询必须停止（互不干扰）");
  } finally {
    stopDingtalkAuthCommandWatcher();
    cleanup(relayDir);
  }
});

test("★ stop 命令监听后不再处理命令（bridge 退出语义；文件保留给下次处理）", async () => {
  const relayDir = tmpRelayDir();
  const api = fakeApi({ polls: [] });
  try {
    startDingtalkAuthCommandWatcher({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, intervalMs: 15, pollMs: 20 });
    stopDingtalkAuthCommandWatcher();
    writeCmd(relayDir, { action: "begin", at: 601 });
    await sleep(100);
    assert.equal(api.initCalls.length, 0, "★ 停监听后不得再处理命令");
    assert.ok(fs.existsSync(path.join(relayDir, DINGTALK_AUTH_CMD_FILE)), "文件保留（下次启动会先检查一次）");
    // handleDingtalkAuthCommand 可被直接调用（启动时的一次性检查路径）
    const r = await handleDingtalkAuthCommand({ relayDir, fetchImpl: api.fetchImpl, logger: () => {}, pollMs: 20 });
    assert.equal(r.ok, true);
    assert.equal(r.action, "begin");
    await waitFor(() => fs.existsSync(path.join(relayDir, DINGTALK_AUTH_FILE)), { label: "手动检查能处理" });
  } finally {
    stopDingtalkAuthCommandWatcher();
    cleanup(relayDir);
  }
});

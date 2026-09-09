#!/usr/bin/env node
/**
 * bridge×router E2EE Phase-2 集成测试(全本地:内存/临时目录,不起任何真实服务):
 *   本地 relay-router + 三个 bridge(同一账号 user 42,不同 deviceId)+ 本地 HTTP/WS echo 上游 +
 *   mock 账号 API(/api/e2ee-params 按 Bearer 内 phone claim 分流 on/off/401,/api/devices 201)。
 *
 * 覆盖:
 *   1. 开关与回退:on → .e2ee-state.json {enabled:true} + tunnel-register caps=["e2ee-v2"]
 *      → /_devices 透传 caps;off/401 → 状态文件 reason 明确、caps 空、明文 v1 路径原样;
 *   2. E2EE 控制通道握手(device 形态 /remote/<dev>/_e2ee/ctrl 与 channel 形态
 *      /remote/_e2ee/ctrl?device=):hello→hello-ack→probe→probe-ok(会话 verified);
 *   3. E2EE HTTP:信封请求(方法/路径/头/正文)经 router 透明转发 → bridge 解封→上游→封回
 *      → 手机开包还原;篡改密文 → 显式 502 + x-dsh-e2ee-error,绝不静默降级;
 *   4. E2EE WS 数据流(&e2ee=<sessId>&w= 标记):桥剥除标记连上游、逐消息加/解密、echo 一致;
 *   5. 解封失败显式拒绝:disabled bridge 收到信封标记帧 → 502 e2ee_disabled(不误转发明文)。
 *
 * 用法: node --test --test-concurrency=1 test/e2ee-bridge.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import {
  E2eeSession,
  decodeHttpResponsePlain,
  deriveMasterKey,
  deriveShk,
  envelopeRequestHeaders,
  fetchE2eeParams,
  newSessId,
  parseWsE2eeParams,
  randomB64,
  randomHex
} from "../e2ee-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const ROUTER_SRC = path.join(ROOT, "packages/relay-router/src/index.mjs");
const BRIDGE_SRC = path.join(HERE, "..", "dsh-bridge.mjs");

const SECRET = "test-e2ee-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "e2ee-integration-password";
const SALT_B64 = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i)).toString("base64url");
const DEV_ON = "dev-eeeeon000001";  // e2ee-params → enabled:true
const DEV_OFF = "dev-eeeoff000002"; // e2ee-params → enabled:false
const DEV_401 = "dev-eee401000003"; // e2ee-params → 401

function signJwt(claims, ttlSec = 7200) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...claims, iat: now, exp: now + ttlSec });
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}
const phoneJwt = signJwt({ sub: "42", phone: "13800000000", plan: "free" });
const COOKIE = "dsh_token=" + encodeURIComponent(phoneJwt);

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const sleep = (ms) => delay(ms, null, { ref: false });
async function waitFor(desc, fn, timeoutMs = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`等待超时: ${desc}${last ? " — " + last.message : ""}`);
}

// ---------- 进程/目录 ----------
const procs = [];
const tmpDirs = [];
const spawnProc = (name, args, env) => {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tail = [];
  p.stdout.on("data", (d) => { const s = String(d); tail.push(s); });
  p.stderr.on("data", (d) => { const s = String(d); tail.push(s); });
  p._tail = () => tail.join("").slice(-4000);
  procs.push(p);
  return p;
};

// ---------- 本地上游:HTTP echo + /ws-echo ----------
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ method: req.method, url: req.url, ct: req.headers["content-type"] || "", auth: req.headers["x-dsh-test-auth"] || "", body }));
  });
});
let upstreamWss = null;

// mock 账号 API:按 Bearer JWT 的 phone claim 尾号分流(0001→on 0002→off 0003→401)。
// 客户端(桥/手机)把 {API_BASE}/api/e2ee-params 请求发到 /relay-api/api/e2ee-params,这里剥前缀后匹配。
const mockApi = http.createServer((req, res) => {
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const path = req.url.replace(/^\/relay-api/, "") || "/";
  if (req.method === "GET" && path === "/api/e2ee-params") {
    let phone = "";
    try {
      const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      phone = JSON.parse(Buffer.from(auth.split(".")[1] || "", "base64url").toString("utf8")).phone || "";
    } catch { /* keep "" */ }
    if (phone.endsWith("0003")) return send(401, { error: { code: "unauthorized" } });
    if (!phone.endsWith("0001")) {
      return send(200, { e2ee: { enabled: false, profile: "pbkdf2-sha256-600k", kdf: { alg: "pbkdf2-sha256", iter: 600000, dkLen: 32, hash: "sha256" }, salt: "", epoch: 0 } });
    }
    return send(200, { e2ee: { enabled: true, profile: "pbkdf2-sha256-600k", kdf: { alg: "pbkdf2-sha256", iter: 600000, dkLen: 32, hash: "sha256" }, salt: SALT_B64, epoch: 2 } });
  }
  if (req.method === "POST" && path === "/api/devices") return send(201, { device: { id: "dev" } });
  return send(404, { error: { code: "not_found" } });
});

let routerBase = "";
let apiBase = "";
const stateDirs = {};

before(async () => {
  const [upPort, apiPort, routerPort] = [await freePort(), await freePort(), await freePort()];
  await new Promise((r) => mockApi.listen(apiPort, "127.0.0.1", r));
  await new Promise((r) => upstream.listen(upPort, "127.0.0.1", r));
  upstreamWss = new WebSocketServer({ server: upstream, path: "/ws-echo" });
  upstreamWss.on("connection", (ws) => ws.on("message", (d, isBinary) => ws.send(d, { binary: isBinary })));

  spawnProc("router", [ROUTER_SRC], {
    DSH_ENTERPRISE_JWT_SECRET: SECRET,
    DSH_ROUTER_HOST: "127.0.0.1",
    DSH_ROUTER_PORT: String(routerPort)
  });
  await waitFor("router 就绪", async () => (await fetch(`http://127.0.0.1:${routerPort}/`)).status === 404);

  for (const k of ["a", "b", "c"]) {
    const d = mkdtempSync(path.join(os.tmpdir(), `dsh-e2ee-${k}-`));
    writeFileSync(path.join(d, "config.json"), "{}");
    stateDirs[k] = d;
    tmpDirs.push(d);
  }
  const spawnBridge = (deviceId, phone, dir) => spawnProc(`bridge-${deviceId.slice(-4)}`, [BRIDGE_SRC], {
    DSH_BRIDGE_TUNNEL_URL: `ws://127.0.0.1:${routerPort}`,
    DSH_BRIDGE_DEVICE_ID: deviceId,
    DSH_BRIDGE_TOKEN: signJwt({ sub: "42", phone, plan: "free" }),
    DSH_BRIDGE_PASSWORD: PASSWORD,
    DSH_BRIDGE_UPSTREAM: `http://127.0.0.1:${upPort}`,
    DSH_BRIDGE_API: `http://127.0.0.1:${apiPort}/relay-api`,
    DSH_BRIDGE_CONFIG: path.join(dir, "config.json")
  });
  spawnBridge(DEV_ON, "13811110001", stateDirs.a);
  spawnBridge(DEV_OFF, "13811110002", stateDirs.b);
  spawnBridge(DEV_401, "13811110003", stateDirs.c);

  routerBase = `http://127.0.0.1:${routerPort}`;
  apiBase = `http://127.0.0.1:${apiPort}/relay-api`;
});

after(() => {
  for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { upstreamWss?.close(); } catch {}
  try { upstream.close(); } catch {}
  try { mockApi.close(); } catch {}
});

const readState = (k) => {
  try { return JSON.parse(readFileSync(path.join(stateDirs[k], ".e2ee-state.json"), "utf8")); } catch { return null; }
};
const devicesOf = async () => (await (await fetch(`${routerBase}/_devices`, { headers: { cookie: COOKIE } })).json()).devices || [];

/** 手机侧:拉参数(与 bridge 相同服务端)→ 派生 MK → 建手机端会话对象。 */
async function phonePrepare() {
  const params = await fetchE2eeParams(apiBase, signJwt({ sub: "42", phone: "13811110001", plan: "free" }));
  assert.equal(params.enabled, true);
  const mk = deriveMasterKey(PASSWORD, params.salt, params.kdf);
  return { mk, params };
}

/**
 * 手机侧解锁:对任意 ctrl URL(device 或 channel 形态)跑 §5.2 全握手。
 * @returns {Promise<{ctrl: WebSocket, client: E2eeSession, sessId: string}>}
 */
function unlock(ctrlWsUrl, { mk, params }) {
  return new Promise((resolve, reject) => {
    const sessId = newSessId();
    const aB64 = randomB64(32);
    const ctrl = new WebSocket(ctrlWsUrl, { headers: { cookie: COOKIE } });
    let client = null;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); try { ctrl.terminate(); } catch {} reject(e); } };
    const timer = setTimeout(() => fail(new Error("解锁握手超时")), 10000);
    ctrl.on("error", (e) => fail(e));
    ctrl.on("close", () => { if (!settled) fail(new Error("ctrl 提前关闭")); });
    ctrl.on("open", () => {
      ctrl.send(JSON.stringify({ v: 2, type: "e2ee-hello", role: "phone", s: sessId, a: aB64, salt: params.salt, profile: params.profile, ts: Date.now() }));
    });
    ctrl.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "e2ee-error") return fail(new Error(`e2ee-error: ${msg.code} ${msg.message || ""}`));
      if (msg.type === "e2ee-hello-ack" && !client) {
        const { shk, saltH } = deriveShk(mk, aB64, msg.b);
        client = new E2eeSession({ sessId, shk, saltH, profile: params.profile, epoch: params.epoch });
        const probe = client.seal({ kind: "ctrl", dir: "p2b", counter: 0, data: JSON.stringify({ p: "dsh-e2ee-probe-v1", t: Date.now(), c: 0 }) });
        ctrl.send(JSON.stringify(probe));
        return;
      }
      if (msg && msg.v === 2 && msg.k === "ctrl" && client) {
        // probe-ok:开包校验通过 = 双方 MK 一致
        client.open({ kind: "ctrl", dir: "b2p", env: msg, counter: msg.c ?? 0 });
        done({ ctrl, client, sessId });
      }
    });
  });
}

// ---------- 测试 ----------

test("开关与回退:enabled bridge 上报 caps + 状态文件;off/401 明文回退原样", async () => {
  // 等待三台 bridge 注册 + A 的 e2ee 状态落盘
  await waitFor("三台 bridge 注册进 /_devices", async () => {
    const devs = await devicesOf();
    const ids = devs.map((d) => d.id);
    return ids.includes(DEV_ON) && ids.includes(DEV_OFF) && ids.includes(DEV_401);
  });
  await waitFor("A .e2ee-state.json 已写", () => readState("a")?.enabled === true);
  await waitFor("B .e2ee-state.json 已写", () => readState("b") !== null);
  await waitFor("C .e2ee-state.json 已写", () => readState("c") !== null);

  // 状态文件:{enabled,reason}
  const stA = readState("a");
  assert.equal(stA.enabled, true);
  assert.equal(stA.reason, "ok");
  assert.deepEqual(stA.caps, ["e2ee-v2"]);
  const stB = readState("b");
  assert.equal(stB.enabled, false);
  assert.equal(stB.reason, "server_disabled");
  const stC = readState("c");
  assert.equal(stC.enabled, false);
  assert.equal(stC.reason, "server_unauthorized");

  // /_devices:router 原样透传 caps(§6.2)
  const devs = await devicesOf();
  const capsOf = (id) => (devs.find((d) => d.id === id) || {}).caps || [];
  assert.deepEqual(capsOf(DEV_ON), ["e2ee-v2"]);
  assert.deepEqual(capsOf(DEV_OFF), []);
  assert.deepEqual(capsOf(DEV_401), []);

  // 明文 v1 路径:三台都不带信封标记 → 照常 200(回退不破坏隧道)
  for (const dev of [DEV_ON, DEV_OFF, DEV_401]) {
    const r = await fetch(`${routerBase}/remote/${dev}/api/echo?plain=1`, { headers: { cookie: COOKIE } });
    assert.equal(r.status, 200, `${dev} 明文应 200`);
    const j = await r.json();
    assert.equal(j.method, "GET");
    assert.equal(j.url, "/api/echo?plain=1");
  }

  // disabled bridge 收到信封标记帧 → 显式 502 e2ee_disabled,不误转发明文
  const off = new E2eeSession({ sessId: newSessId(), shk: Buffer.alloc(32, 7), saltH: Buffer.alloc(32, 8) });
  const env = off.seal({ kind: "http", dir: "p2b", counter: 0, data: "x" });
  const r = await fetch(`${routerBase}/remote/${DEV_OFF}/api/echo`, {
    method: "POST",
    headers: { ...envelopeRequestHeaders(env.s, "http"), cookie: COOKIE },
    body: JSON.stringify(env)
  });
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("x-dsh-e2ee-error"), "e2ee_disabled");
  assert.match(await r.text(), /⚠/);
});

test("E2EE 解锁握手(device 形态)+ channel 形态可开,探针通过后会话可用", async () => {
  const { mk, params } = await phonePrepare();
  const { ctrl, client, sessId } = await unlock(`${routerBase}/remote/${DEV_ON}/_e2ee/ctrl`, { mk, params });
  assert.equal(sessId.length, 32);
  assert.ok(client.sessId);
  // channel 形态:/remote/_e2ee/ctrl?device=<dev>(router CHANNEL_MARKERS 含 _e2ee)
  const chan = await unlock(`${routerBase}/remote/_e2ee/ctrl?device=${DEV_ON}`, { mk, params });
  assert.equal(chan.sessId.length, 32);
  chan.ctrl.close(1000);
  // 保留 A 的解锁会话供后续 http/ws 用例复用
  globalThis.__unlocked = { mk, params, ctrl, client, sessId };
  ctrl.on("close", () => { globalThis.__ctrlClosed = true; });
  assert.equal(globalThis.__ctrlClosed, undefined);
});

test("E2EE HTTP:信封请求解封→上游→封回往返一致;篡改密文 → 显式 502", async () => {
  const u = globalThis.__unlocked;
  assert.ok(u, "需要先解锁");
  const { client } = u;
  // 1) 正常往返:POST /api/echo?b=2,信封内带头/正文
  const bodyPayload = JSON.stringify({ hello: "世界", n: 42 });
  const plain = Buffer.from(JSON.stringify({
    m: "POST",
    p: "/api/echo?b=2",
    h: { "content-type": "application/json; charset=utf-8", "x-dsh-test-auth": "secret-value" },
    b: Buffer.from(bodyPayload, "utf8").toString("base64")
  }), "utf8");
  const envReq = client.seal({ kind: "http", dir: "p2b", counter: 1, data: plain });
  const res = await fetch(`${routerBase}/remote/${DEV_ON}/api/echo?b=2`, {
    method: "POST",
    headers: { ...envelopeRequestHeaders(client.sessId, "http"), cookie: COOKIE },
    body: JSON.stringify(envReq)
  });
  assert.equal(res.status, 200);
  const ct = res.headers.get("content-type") || "";
  assert.ok(ct.startsWith("application/vnd.dsh.e2ee-v2"), `外层应为信封 content-type, got ${ct}`);
  assert.ok((res.headers.get("x-dsh-e2ee") || "").includes(`s=${client.sessId}`));
  // 手机开包:http-resp 子密钥 = 请求 n
  const envResp = JSON.parse(await res.text());
  assert.equal(envResp.k, "http-resp");
  const opened = client.open({ kind: "http-resp", dir: "b2p", env: envResp, counter: envResp.c, reqNonceB64: envReq.n });
  const resp = decodeHttpResponsePlain(opened.data);
  assert.equal(resp.status, 200);
  const up = JSON.parse(resp.bodyBuffer.toString("utf8"));
  assert.equal(up.method, "POST");
  assert.equal(up.url, "/api/echo?b=2");
  assert.equal(up.auth, "secret-value");
  assert.equal(up.body, bodyPayload);
  // resp 内头部:content-encoding 已被移入 enc(无则空),content-type 保留
  assert.equal(resp.headers["content-type"], "application/json; charset=utf-8");

  // 2) 篡改密文 → 502 + x-dsh-e2ee-error,不开包即失败、不回退明文
  const envBad = client.seal({ kind: "http", dir: "p2b", counter: 2, data: plain });
  const buf = Buffer.from(envBad.d, "base64url");
  buf[5] ^= 0x55;
  envBad.d = buf.toString("base64url");
  const bad = await fetch(`${routerBase}/remote/${DEV_ON}/api/echo`, {
    method: "POST",
    headers: { ...envelopeRequestHeaders(client.sessId, "http"), cookie: COOKIE },
    body: JSON.stringify(envBad)
  });
  assert.equal(bad.status, 502);
  assert.equal(bad.headers.get("x-dsh-e2ee-error"), "auth_failed");
  const badText = await bad.text();
  assert.match(badText, /⚠/);
  assert.match(badText, /auth_failed|无法解密/);
});

test("E2EE WS 数据流:&e2ee=&w= 标记 → 桥剥除标记连上游,逐消息加解密 echo 一致", async () => {
  const u = globalThis.__unlocked;
  assert.ok(u, "需要先解锁");
  const { client, sessId } = u;
  const w = randomHex(8);
  const wsUrl = `${routerBase}/remote/${DEV_ON}/ws-echo?e2ee=${sessId}&w=${w}`;
  const wsUrlObj = new URL(wsUrl);
  // bridge 收到的 ws-open 帧 path 是 router 剥离 /remote/<dev> 后的上游路径(§6.2/§4.6)
  const bridgePath = wsUrlObj.pathname.replace(/^\/remote\/[^/]+/, "") + wsUrlObj.search;
  const parsed = parseWsE2eeParams(bridgePath);
  assert.equal(parsed.sessId, sessId);
  assert.equal(parsed.wsLabel, `/ws-echo?w=${w}`);
  assert.equal(parsed.upstreamPath, "/ws-echo");

  const data = new WebSocket(wsUrl.replace(/^http/, "ws"), { headers: { cookie: COOKIE } });
  try {
    const echoed = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws e2ee echo 超时")), 10000);
      data.on("open", () => {
        // 手机 → bridge:密封 w 信封(文本)
        const env = client.seal({ kind: "w", dir: "p2b", counter: 0, data: "ping-e2ee-你好", wsLabel: parsed.wsLabel });
        data.send(JSON.stringify(env));
      });
      data.on("message", (raw) => {
        try {
          const env = JSON.parse(String(raw));
          if (env && env.k === "w") {
            const opened = client.open({ kind: "w", dir: "b2p", env, counter: env.c, wsLabel: parsed.wsLabel });
            clearTimeout(t);
            resolve(opened.data.toString("utf8"));
          }
        } catch (e) { clearTimeout(t); reject(e); }
      });
      data.on("close", (code, reason) => { clearTimeout(t); reject(new Error(`ws e2ee 提前关闭 code=${code} reason=${reason}`)); });
      data.on("error", (e) => { clearTimeout(t); reject(new Error(`ws e2ee error: ${e.message}`)); });
    });
    assert.equal(echoed, "ping-e2ee-你好");
  } finally {
    try { data.close(1000); } catch {}
  }
});


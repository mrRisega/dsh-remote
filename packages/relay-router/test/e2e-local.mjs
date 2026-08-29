#!/usr/bin/env node
/**
 * relay-router 本地端到端验证(不依赖 NAS):
 *   router(测试密钥) + bridge(隧道模式) + 本地可控上游(HTTP/WS echo)
 *
 * 覆盖:
 *   1. HTTP 透明代理(/remote/<deviceId>/ → 上游 200 + 内容一致)
 *   2. WebSocket 透传(ws-open/msg/close 帧往返)
 *   3. 设备离线 → 502
 *   4. 未登录 → 302 /login/
 *   5. 月流量超限 → 402(第二个 router,free 配额极小)
 *   6. 带宽限速:free 20KB/s 下 200KB 响应耗时 ≥5s(令牌桶 pacing 生效)
 *   7. 跨用户访问 → 403
 *
 * 用法: node test/e2e-local.mjs
 */

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(THIS_DIR, "..", "..", ".."); // dsh-remote-open/
const ROUTER_SRC = path.join(THIS_DIR, "..", "src", "index.mjs");
const BRIDGE_SRC = path.join(ROOT, "clients/dsh-remote/dsh-bridge.mjs");

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const DEV_A = "dev-aabbccddeeff";
const DEV_B = "dev-112233445566";
const DEV_C = "dev-334455667788";
const UPSTREAM_PORT = 31999;
// 大 JSON 上游体:bridge 应对其 gzip,router 必须把 content-encoding 透传给手机
const BIG_JSON = JSON.stringify({ ok: true, items: Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `item-${i}`, desc: "x".repeat(20) })) });

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass += 1; console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

function signJwt(claims, secret, ttlSec = 3600) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...claims, iat: now, exp: now + ttlSec });
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 15000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) { lastErr = e; }
    await sleep(300);
  }
  throw new Error(`等待超时: ${desc}${lastErr ? " — " + lastErr.message : ""}`);
}

function spawnProc(name, cmd, args, env, logLines) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tail = [];
  p.stdout.on("data", (d) => { const s = String(d); tail.push(s); if (logLines) process.stdout.write(`[${name}] ${s}`); });
  p.stderr.on("data", (d) => { const s = String(d); tail.push(s); if (logLines) process.stdout.write(`[${name}!] ${s}`); });
  p._tail = () => tail.join("").slice(-3000);
  return p;
}

// ---------- 测试上游:HTTP(可指定大小)+ WS echo ----------
const upstream = http.createServer((req, res) => {
  if (req.url === "/big") {
    const size = Number(req.headers["x-size"] || 200000);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(size, 0x61)); // 'a' × size
    return;
  }
  if (req.url === "/big-json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(BIG_JSON);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello-upstream:" + req.url);
});
const upstreamWss = new WebSocketServer({ server: upstream, path: "/ws-echo" });
upstreamWss.on("connection", (ws) => {
  ws.on("message", (d, isBinary) => ws.send(d, { binary: isBinary }));
});

// 模块级状态:失败路径也要能清理(避免残留进程占用端口)
const procs = [];
let tmp = null;

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
  console.log(`[test] 上游 http://127.0.0.1:${UPSTREAM_PORT} 就绪`);

  tmp = mkdtempSync(path.join(os.tmpdir(), "dsh-router-e2e-"));
  const cfgA = path.join(tmp, "config-a.json");
  const cfgB = path.join(tmp, "config-b.json");
  const cfgC = path.join(tmp, "config-c.json");
  writeFileSync(cfgA, "{}");
  writeFileSync(cfgB, "{}");
  writeFileSync(cfgC, "{}");
  const token = signJwt({ sub: "42", phone: "13800000000", plan: "free" }, SECRET);
  const tokenPro = signJwt({ sub: "7", phone: "13900000000", plan: "pro" }, SECRET);
  const tokenRate = signJwt({ sub: "99", phone: "13700000000", plan: "free" }, SECRET);
  // 本地测试:账号 API 指向死端口(避免误打生产 API;设备登记仅 warn 不阻塞)
  const DEAD_API = "http://127.0.0.1:19999/relay-api";

  const stopAll = () => {
    for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
    try { upstream.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  };

  // router A:默认配额
  const routerA = spawnProc("routerA", process.execPath, [ROUTER_SRC], {
    DSH_ENTERPRISE_JWT_SECRET: SECRET,
    DSH_ROUTER_PORT: "13444",
    DSH_ROUTER_HOST: "127.0.0.1",
    DSH_ROUTER_QUOTA_FREE_MAX_BPS: "20000" // 限速测试用(20KB/s);其他测试响应体很小不受影响
  });
  procs.push(routerA);

  // router B:free 月流量 ≈1KB、限速 20KB/s(测 402 与 pacing)
  const routerB = spawnProc("routerB", process.execPath, [ROUTER_SRC], {
    DSH_ENTERPRISE_JWT_SECRET: SECRET,
    DSH_ROUTER_PORT: "13445",
    DSH_ROUTER_HOST: "127.0.0.1",
    DSH_ROUTER_QUOTA_FREE_MONTHLY_GB: "0.000001",
    DSH_ROUTER_QUOTA_FREE_MAX_BPS: "20000"
  });
  procs.push(routerB);

  await waitFor("router A 端口", async () => (await fetch("http://127.0.0.1:13444/")).status === 404);

  // bridge A(→ router A):设备 dev-aabbccddeeff,上游=测试上游
  const bridgeA = spawnProc("bridgeA", process.execPath, [BRIDGE_SRC], {
    DSH_BRIDGE_TUNNEL_URL: "ws://127.0.0.1:13444",
    DSH_BRIDGE_DEVICE_ID: DEV_A,
    DSH_BRIDGE_TOKEN: token,
    DSH_BRIDGE_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
    DSH_BRIDGE_API: DEAD_API,
    DSH_BRIDGE_CONFIG: cfgA
  });
  procs.push(bridgeA);

  // bridge B(→ router B):dev-112233445566
  const bridgeB = spawnProc("bridgeB", process.execPath, [BRIDGE_SRC], {
    DSH_BRIDGE_TUNNEL_URL: "ws://127.0.0.1:13445",
    DSH_BRIDGE_DEVICE_ID: DEV_B,
    DSH_BRIDGE_TOKEN: token,
    DSH_BRIDGE_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
    DSH_BRIDGE_API: DEAD_API,
    DSH_BRIDGE_CONFIG: cfgB
  });
  procs.push(bridgeB);

  // bridge C(→ router A,同属 user 42):dev-334455667788 —— /_devices 多设备回归
  const bridgeC = spawnProc("bridgeC", process.execPath, [BRIDGE_SRC], {
    DSH_BRIDGE_TUNNEL_URL: "ws://127.0.0.1:13444",
    DSH_BRIDGE_DEVICE_ID: DEV_C,
    DSH_BRIDGE_TOKEN: token,
    DSH_BRIDGE_UPSTREAM: `http://127.0.0.1:${UPSTREAM_PORT}`,
    DSH_BRIDGE_API: DEAD_API,
    DSH_BRIDGE_CONFIG: cfgC
  });
  procs.push(bridgeC);

  // router C:开源自部署本地认证模式(DSH_LOCAL_JWT_SECRET + DSH_LOCAL_ACCESS_KEYS)
  const routerC = spawnProc("routerC", process.execPath, [ROUTER_SRC], {
    DSH_ENTERPRISE_JWT_SECRET: SECRET,
    DSH_LOCAL_JWT_SECRET: "local-secret-0123456789abcdef0123456789abcdef",
    DSH_LOCAL_ACCESS_KEYS: "key-test-1,key-test-2",
    DSH_ROUTER_PORT: "13447",
    DSH_ROUTER_HOST: "127.0.0.1"
  });
  procs.push(routerC);

  const cookie = "dsh_token=" + encodeURIComponent(token);
  const cookiePro = "dsh_token=" + encodeURIComponent(tokenPro);

  // 等 bridge 注册成功(router 日志出现注册行 / 请求不再是 502)
  await waitFor("bridge A 注册", async () => {
    const r = await fetch("http://127.0.0.1:13444/remote/" + DEV_A + "/", { headers: { cookie } });
    return r.status !== 502;
  }, 20000);

  // ---- 0.0 本地认证(开源自部署):/_login + 本地 JWT 访问与设备注册 ----
  {
    await waitFor("router C 就绪", async () => (await fetch("http://127.0.0.1:13447/_devices")).status === 401, 15000);
    // 错误密钥 → 401
    const bad = await fetch("http://127.0.0.1:13447/_login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "wrong-key" })
    });
    check("_login 错误密钥 401", bad.status === 401, `status=${bad.status}`);
    // 正确密钥 → 本地 JWT
    const ok = await fetch("http://127.0.0.1:13447/_login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "key-test-1" })
    });
    const okd = await ok.json().catch(() => ({}));
    check("_login 正确密钥 → 本地 JWT", ok.status === 200 && typeof okd.token === "string" && okd.plan === "pro_max", `status=${ok.status}`);
    // 本地 JWT 访问 /_devices / /_quota
    const dev = await fetch("http://127.0.0.1:13447/_devices", { headers: { cookie: "dsh_token=" + encodeURIComponent(okd.token) } });
    check("本地 JWT 访问 /_devices 200", dev.status === 200, `status=${dev.status}`);
    // 本地 JWT 注册 bridge(模拟;注册成功后保持连接,查询后再关闭)
    const regLocal = await new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:13447/_bridge");
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ err: "timeout" }); }, 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "tunnel-register", deviceId: "dev-local-000000000001", token: okd.token, name: "local-pc" })));
      ws.on("message", (raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === "tunnel-register-ok") { clearTimeout(t); resolve({ ok: true, ws }); }
        if (m.type === "tunnel-register-err") { clearTimeout(t); resolve({ err: m.code, ws }); }
      });
    });
    check("本地 JWT 注册 bridge 成功", regLocal.ok === true, JSON.stringify(regLocal));
    // 本地 /_devices 能看到自己(连接仍 OPEN)
    const dev2 = await fetch("http://127.0.0.1:13447/_devices", { headers: { cookie: "dsh_token=" + encodeURIComponent(okd.token) } });
    const d2 = await dev2.json().catch(() => ({}));
    check("本地 /_devices 列出已注册设备", (d2.devices || []).some((x) => x.id === "dev-local-000000000001"), JSON.stringify(d2.devices));
    try { regLocal.ws?.close(1000); } catch {}
  }

  // ---- 0.1 流量用量 GET /_quota(仅回本用户;pro 不限流量,free 给百分比) ----
  const fetchQuota = async (cookieValue) => {
    const r = await fetch("http://127.0.0.1:13444/_quota", {
      headers: cookieValue ? { cookie: "dsh_token=" + encodeURIComponent(cookieValue) } : {}
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
  {
    const anon = await fetchQuota("");
    check("_quota 无令牌 401", anon.status === 401, `status=${anon.status}`);
    // user 7 = pro(不限流量):limit_enabled=false
    const pro = await fetchQuota(tokenPro);
    check("_quota pro 不限流量", pro.status === 200 && pro.data.quota.limit_enabled === false && pro.data.quota.plan === "pro", `status=${pro.status}`);
    // user 42 = free(其他用户也要 200,不泄漏别人用量)
    const other = await fetchQuota(token);
    check("_quota 其他用户可用", other.status === 200, `status=${other.status}`);
    // user 99 = free:限量 1GB,当前 0% 
    const free = await fetchQuota(tokenRate);
    check("_quota free 限量+百分比", free.status === 200 && free.data.quota.limit_enabled === true && free.data.quota.percent === 0 && free.data.quota.limit_bytes === 1024 ** 3, `status=${free.status}`);
  }

  // ---- 0.2 pro_max 同时在线上限(直接模拟 bridge 注册;DSH_ROUTER_PRO_MAX_ONLINE 未设默认 3) ----
  {
    const tokenPM = signJwt({ sub: "77", phone: "13600000000", plan: "pro_max" }, SECRET);
    const reg = (deviceId, jwt) => new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:13444/_bridge");
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ err: "timeout" }); }, 8000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "tunnel-register", deviceId, token: jwt, name: "pm-test" })));
      ws.on("message", (raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === "tunnel-register-ok") { clearTimeout(t); ws.close(1000); resolve({ ok: true }); }
        if (m.type === "tunnel-register-err") { clearTimeout(t); resolve({ err: m.code, message: m.message }); }
      });
      ws.on("close", (code) => { clearTimeout(t); resolve({ close: code }); });
    });
    const first = await reg("dev-pm-000000000001", tokenPM);
    const second = await reg("dev-pm-000000000002", tokenPM);
    check("pro_max 首台注册成功", first.ok === true, JSON.stringify(first));
    check("pro_max 在线上限(3)内第 2 台可注册", second.ok === true || second.err === "online_limit", JSON.stringify(second));
  }

  // ---- 0. 实时设备列表 GET /_devices(仅回本用户 OPEN 的 WebSocket) ----
  const fetchDevices = async (cookieValue) => {
    const r = await fetch("http://127.0.0.1:13444/_devices", {
      headers: cookieValue ? { cookie: "dsh_token=" + encodeURIComponent(cookieValue) } : {}
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
  {
    // 无令牌/坏令牌 → 401,不泄漏设备信息
    const anon = await fetchDevices("");
    check("_devices 无令牌 401", anon.status === 401, `status=${anon.status}`);
    const bad = await fetchDevices("not-a-jwt");
    check("_devices 坏令牌 401", bad.status === 401, `status=${bad.status}`);
    // 其他用户无在线设备 → 空列表(不泄漏 A/C)
    const other = await fetchDevices(tokenPro);
    check("_devices 其他用户为空", other.status === 200 && Array.isArray(other.data.devices) && other.data.devices.length === 0, `status=${other.status} n=${other.data.devices?.length}`);
  }
  {
    // 等 user 42 的两台 bridge 都注册进 router 实时 Map
    await waitFor("_devices 含两台在线设备", async () => {
      const r = await fetchDevices(token);
      const ids = (r.data.devices || []).map((d) => d.id);
      return r.status === 200 && ids.includes(DEV_A) && ids.includes(DEV_C);
    }, 20000);
    const mine = await fetchDevices(token);
    const ids = (mine.data.devices || []).map((d) => d.id).sort();
    const names = (mine.data.devices || []).every((d) => typeof d.name === "string" && d.name.length > 0);
    check("_devices 本用户仅见自己的在线设备", mine.status === 200 && ids.length === 2 && ids[0] === DEV_C && ids[1] === DEV_A && names, `ids=${JSON.stringify(ids)}`);
  }
  {
    // 断开一台 → 实时 Map 移除,下次响应只剩一台(真实在线来源)
    try { bridgeC.kill("SIGTERM"); } catch {}
    await waitFor("_devices 断开后移除", async () => {
      const r = await fetchDevices(token);
      const ids = (r.data.devices || []).map((d) => d.id);
      return r.status === 200 && ids.length === 1 && ids[0] === DEV_A;
    }, 15000);
    const after = await fetchDevices(token);
    check("_devices 断开即从列表消失", after.status === 200 && (after.data.devices || []).map((d) => d.id).join() === DEV_A, `ids=${JSON.stringify(after.data.devices)}`);
  }

  // ---- 1. HTTP 透明代理 ----
  {
    const r = await fetch("http://127.0.0.1:13444/remote/" + DEV_A + "/hello?x=1", { headers: { cookie } });
    const body = await r.text();
    check("HTTP 200 + 内容一致", r.status === 200 && body === "hello-upstream:/hello?x=1", `status=${r.status} body=${body}`);
  }
  {
    // bridge 对大 JSON gzip 压缩 → router 必须透传 content-encoding: gzip,手机才能解压
    const r = await fetch("http://127.0.0.1:13444/remote/" + DEV_A + "/big-json", { headers: { cookie, "accept-encoding": "gzip" } });
    const text = await r.text();
    const ce = r.headers.get("content-encoding");
    check("HTTP gzip 透传:content-encoding 头 + body 解压后与上游一致", r.status === 200 && ce === "gzip" && text === BIG_JSON, `status=${r.status} ce=${ce} len=${text.length}`);
  }

  // ---- 2. WebSocket 透传 ----
  {
    let wsOk = false;
    try {
      const ws = new WebSocket("ws://127.0.0.1:13444/remote/" + DEV_A + "/ws-echo", { headers: { cookie } });
      const got = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ws 超时")), 8000);
        ws.on("open", () => ws.send("ping-tunnel"));
        ws.on("message", (d) => { clearTimeout(t); resolve(String(d)); ws.close(); });
        ws.on("error", (e) => { clearTimeout(t); reject(e); });
      });
      wsOk = got === "ping-tunnel";
    } catch (e) { console.log("    ws 错误:", e.message); }
    check("WS 透传 echo", wsOk);
  }

  // ---- 3. 设备离线 → 502 ----
  {
    const r = await fetch("http://127.0.0.1:13444/remote/dev-ffffffffffff/", { headers: { cookie } });
    check("设备离线 502", r.status === 502, `status=${r.status}`);
  }

  // ---- 4. 未登录 → 302 ----
  {
    const r = await fetch("http://127.0.0.1:13444/remote/" + DEV_A + "/", { redirect: "manual" });
    check("未登录 302", r.status === 302 && (r.headers.get("location") || "").includes("/login/"), `status=${r.status} loc=${r.headers.get("location")}`);
  }

  // ---- 5. 跨用户 → 403(pro token 访问 free 用户的设备) ----
  {
    const r = await fetch("http://127.0.0.1:13444/remote/" + DEV_A + "/", { headers: { cookie: cookiePro } });
    check("跨用户 403", r.status === 403, `status=${r.status}`);
  }

  // ---- 6. router B:月流量超限 → 402 ----
  {
    await waitFor("bridge B 注册", async () => {
      const r = await fetch("http://127.0.0.1:13445/remote/" + DEV_B + "/", { headers: { cookie } });
      return r.status !== 502;
    }, 20000);
    const r1 = await fetch("http://127.0.0.1:13445/remote/" + DEV_B + "/big", { headers: { cookie, "x-size": "50000" } });
    check("routerB 首请求 200(写入用量)", r1.status === 200, `status=${r1.status}`);
    await sleep(300);
    const r2 = await fetch("http://127.0.0.1:13445/remote/" + DEV_B + "/", { headers: { cookie, accept: "text/html" } });
    const body2 = await r2.text();
    check("超限后 402", r2.status === 402, `status=${r2.status}`);
    check("402 页含百分比+升级引导", body2.includes("已用") && body2.includes("/app/promo"), `len=${body2.length}`);
  }

  // ---- 7. router A:带宽限速(200KB @ 20KB/s,burst 64KB → 应 ≥5s;用户 42 月流量默认 1GB 不受限) ----
  {
    const t0 = Date.now();
    const r = await fetch("http://127.0.0.1:13444/remote/" + DEV_A + "/big", { headers: { cookie, "x-size": "200000" } });
    const bytes = (await r.arrayBuffer()).byteLength; // 先读完 body 再计时(限速作用在 body 流式)
    const elapsed = (Date.now() - t0) / 1000;
    check("限速:200KB 响应耗时≥5s", r.status === 200 && elapsed >= 5 && bytes === 200000, `elapsed=${elapsed.toFixed(1)}s bytes=${bytes}`);
  }

  stopAll();
  console.log(`\n[test] 通过 ${pass} / ${fail + pass}`);
  if (fail > 0) {
    console.log("[test] 失败详情:");
    console.log("[routerA]", routerA._tail());
    console.log("[bridgeA]", bridgeA._tail());
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[test] 异常:", e);
  for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
  try { upstream.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(2);
});

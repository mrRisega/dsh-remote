// 「中继不提供额度接口」时的降级回归。
//
// 背景：插件是**开源侧产物，自建与 SaaS 两种模式共用**。自建中继不限制带宽与流量，
// 也不提供 `/_quota`；此时面板必须：
//   ① 代理不报错（返回 {ok:true, quota:null} 而不是 5xx）；
//   ② 不显示任何**服务端并未下发的**限制文案（例如硬编码的“本月流量限额 1GB”）。
//
// 曾在 2026-09 修过一次：面板在拿不到额度数据时硬编码回退成
// 「免费额度: 带宽 ≈1Mbps · 本月流量限额 1GB」——对自建用户就是凭空捏造限制。
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const CLIENT_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"),
  "utf8"
);

/** 假 relay：只提供 device-login；其余 404（模拟极简自建账号服务）。 */
function startFakeRelay() {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && url.pathname === "/api/device-login") return send(200, { token: "jwt-self" });
    send(404, { error: { code: "not_found" } });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

/** 假中继：**没有 `/_quota`**（干净自建中继就是这样）。 */
function startFakeRelayRouter() {
  const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

test("中继无 /_quota：代理返回 {ok:true,quota:null} 且不报错", async () => {
  const relay = await startFakeRelay();
  const router = await startFakeRelayRouter();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ui-noquota-"));
  await writeFile(path.join(tempDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000",
    password: "pw",
    device_id: "dev-selfhost0001",
    api_url: `http://127.0.0.1:${relay.port}`,
    tunnel_url: `ws://127.0.0.1:${router.port}`
  }));

  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} }
  }, { relayDir: tempDir });

  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));

  try {
    const r = await fetch(`http://127.0.0.1:${host.address().port}/dsh-remote/quota`);
    assert.equal(r.status, 200, "拿不到额度不应变成 5xx");
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.quota, null, "中继没有额度接口 → quota 必须是 null（而不是编造一份）");
  } finally {
    host.close(); relay.srv.close(); router.srv.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("面板文案：额度数据缺失时不得断言任何限制", () => {
  // 有额度数据 + 限量 → 才允许出现带宽/用量文案，且带宽值必须来自服务端
  assert.match(CLIENT_SRC, /if \(quota && quota\.limit_enabled\) \{/, "有额度且限量时才展示用量");
  assert.doesNotMatch(CLIENT_SRC, /带宽 ≈1Mbps/, "不得硬编码带宽数值，应从服务端下发");
  assert.match(CLIENT_SRC, /quota\.max_mbps \? "带宽 ≈" \+ quota\.max_mbps/, "带宽值服务端有才写");
  // 无额度数据 → 只说明是免费用户，不得出现硬编码的限额
  assert.doesNotMatch(
    CLIENT_SRC,
    /quotaPct !== null \?[^:]*:[^"]*本月流量限额 1GB/,
    "不得在拿不到额度时硬编码“本月流量限额 1GB”"
  );
  assert.doesNotMatch(CLIENT_SRC, /:\s*" · 本月流量限额 1GB"/, "硬编码限额回退已移除");
  // 中继报告「不限量」时也不该说限额
  assert.match(CLIENT_SRC, /免费用户 · 当前不限速、不限流量/, "不限量应如实说明");
});

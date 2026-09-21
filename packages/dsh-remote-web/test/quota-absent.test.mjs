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
  // 【0.6.11 改断言】旧断言是
  //   assert.match(CLIENT_SRC, /quota\.max_mbps \? "带宽 ≈" \+ quota\.max_mbps/, "带宽值服务端有才写")
  // 它编码的是**旧行为**（账号卡「更多」档位明细里的「当前：带宽 ≈N Mbps」那一行），不是不变量。
  // 业主口径：「插件面板里面不要展示『更多』里的 PRO 版本流量带宽，我看你把数字都展示出来了。
  // 在本地的设置面板里面，把这个功能删掉。」→ 整块（renderPlanDetail + planSpecText/freeMbpsOf）
  // 已删，那个字符串在代码里不再存在。保留下来的**不变量**（比原来更强）：
  //   客户端不得渲染任何带宽/流量/价格**数值** —— 服务端没下发时不许编（旧约束），下发了也不摆（新口径）。
  assert.doesNotMatch(CLIENT_SRC, /" Mbps"/, "面板不再渲染带宽数值（业主口径：本地面板不展示规格数字）");
  assert.doesNotMatch(CLIENT_SRC, /" GB\/月，¥"/, "面板不再渲染流量/价格数值（档位明细已删）");
  // 但「已限速 / 不限速」这条**定性**提示仍在，且仍由服务端字段驱动（只是不再带数值）——
  // 这是上面第 ① 条不变量「服务端没说的限制一个字都不许编」的正面表达，也是必须保留的行为。
  assert.match(CLIENT_SRC, /quota\.max_mbps \? remainText : "已限速 · " \+ remainText/, "「已限速」提示仍由服务端字段驱动（不再带数值）");
  // 无额度数据 → 不得出现硬编码的限额（首屏文案不再挂档位名，所以这里也不再断言「免费用户」前缀）
  assert.doesNotMatch(
    CLIENT_SRC,
    /quotaPct !== null \?[^:]*:[^"]*本月流量限额 1GB/,
    "不得在拿不到额度时硬编码“本月流量限额 1GB”"
  );
  assert.doesNotMatch(CLIENT_SRC, /:\s*" · 本月流量限额 1GB"/, "硬编码限额回退已移除");
  // 中继报告「不限量」时也不该说限额。
  // 【0.6.10 改断言】旧断言是 /免费用户 · 当前不限速、不限流量/ —— 那是**旧产品文案**（首屏挂档位名、
  // 用「流量」这个词），不是不变量；业主口径改为「首页面不展示会员相关信息」「流量一律叫额度」，
  // 所以文案变成「当前不限速、不限额度」。这里保留的**不变量**是：中继明确报告不限量时必须如实说明
  // （下面这条分支仍在、仍由服务端字段驱动），不是那句具体措辞。
  assert.match(CLIENT_SRC, /当前不限速、不限额度/, "不限量应如实说明（首屏不再带档位名）");
});

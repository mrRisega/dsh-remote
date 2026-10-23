// 📄 会员服务购买协议 URL —— **宿主半边**（lib/index.js）契约回归。
//
// 背景（业主 2026-10-23）：客户端 0.7.5-beta.1 要求购买入口带《会员服务购买协议》链接。
// 正式协议由企业端提供，URL 来源优先级：
//   1) 企业端 public-config 的 `agreement_url`（**新字段**；没上线时没有 → 忽略）；
//   2) 固定兜底 DEFAULT_PURCHASE_AGREEMENT_URL。
//
// 本文件锁四件：
//   ① 纯函数 `purchaseAgreementUrlFrom`：优先级 + 只认 http(s) 绝对地址（其它协议/相对路径回兜底）；
//   ② 路由 `GET /dsh-remote/purchase-agreement` 的端到端行为（假 relay 发 public-config）；
//   ③ 失败软着陆：public-config 不可达也返回 `ok:true` + 兜底 URL —— 协议链接不得成为购买流程的故障点；
//   ④ 只接受 GET（错误方法 404）。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply, DEFAULT_PURCHASE_AGREEMENT_URL, purchaseAgreementUrlFrom } from "../lib/index.js";

const FALLBACK = DEFAULT_PURCHASE_AGREEMENT_URL;

test("兜底常量就是业主约定的正式兜底地址（企业端 /api/purchase-agreement 的 302/200 入口）", () => {
  assert.equal(FALLBACK, "https://n.risegao.cn:13443/relay-api/api/purchase-agreement");
});

test("纯函数：public-config.agreement_url 优先；非 http(s)/相对/缺失一律回兜底", () => {
  // ① 正常：绝对 https / http 都接受（企业端可能配 http 的内网地址）
  assert.equal(purchaseAgreementUrlFrom({ agreement_url: "https://relay.test/agreement.html" }), "https://relay.test/agreement.html");
  assert.equal(purchaseAgreementUrlFrom({ agreement_url: "http://127.0.0.1:8080/agreement" }), "http://127.0.0.1:8080/agreement");
  assert.equal(purchaseAgreementUrlFrom({ agreement_url: "  https://relay.test/a?b=1  " }), "https://relay.test/a?b=1", "两端空白应被裁掉");

  // ② 没这个字段 / 空串 / 非对象 → 兜底
  assert.equal(purchaseAgreementUrlFrom({}), FALLBACK);
  assert.equal(purchaseAgreementUrlFrom({ agreement_url: "" }), FALLBACK);
  assert.equal(purchaseAgreementUrlFrom({ agreement_url: "   " }), FALLBACK);
  assert.equal(purchaseAgreementUrlFrom(null), FALLBACK);
  assert.equal(purchaseAgreementUrlFrom("https://relay.test/x"), FALLBACK, "非对象（被改坏的类型）→ 兜底");
  assert.equal(purchaseAgreementUrlFrom({ agreement_url: 123 }), FALLBACK, "非字符串 → 兜底");

  // ③ 安全性：这个值最终进 <a href>，绝不吃可执行协议/协议相对/相对路径
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example/agreement",
    "/relay-api/api/purchase-agreement",
    "agreement.html",
    "ftp://relay.test/agreement",
    " https://relay.test/a b", // 含空白 → 不当作合法 URL
  ]) {
    assert.equal(purchaseAgreementUrlFrom({ agreement_url: bad }), FALLBACK, `非法 agreement_url 必须回兜底: ${bad}`);
  }
});

/** 起一个假 relay：只实现 /api/public-config（内容可配）。 */
async function startFakeRelay(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, seen, base: `http://127.0.0.1:${srv.address().port}` };
}

function boot(relayDir) {
  const routes = new Map();
  apply({
    webServer: { register(rt) { routes.set(rt.path, rt.handler); return () => {}; } },
    effect(reg) { return reg(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const handler = routes.get(url.pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  return host;
}

async function withPlugin(fn) {
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-agr-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 套件级隔离：绝不真的去后台装运行环境
  let host = null;
  try {
    return await fn({ relayDir, startHost: () => { host = boot(relayDir); return host; } });
  } finally {
    try { if (host) host.close(); } catch { /* 忽略 */ }
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    await rm(relayDir, { recursive: true, force: true });
  }
}

const writeCfg = (relayDir, apiUrl) => writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
  device_id: "dev-agr-1", api_url: apiUrl,
}));

async function listen(host) {
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${host.address().port}`;
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("路由：public-config 配了 agreement_url → 原样下发（source=public_config）", async () => {
  const up = await startFakeRelay((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/public-config") {
      return json(res, { service: "dsh-remote", agreement_url: "https://relay.test/relay-api/agreement.html" });
    }
    json(res, { error: { code: "not_found" } }, 404);
  });
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const r = await (await fetch(`${base}/dsh-remote/purchase-agreement`)).json();
      assert.equal(r.ok, true);
      assert.equal(r.url, "https://relay.test/relay-api/agreement.html");
      assert.equal(r.source, "public_config", "应能看出这个 URL 是服务端配的");
      assert.ok(up.seen.some((e) => e.url === "/api/public-config"), "node 半应读企业端 public-config");
    });
  } finally {
    up.srv.close();
  }
});

test("路由：public-config 没有 agreement_url（企业端未上线）→ 忽略该字段，回固定兜底", async () => {
  const up = await startFakeRelay((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/public-config") return json(res, { service: "dsh-remote", plans: {} });
    json(res, {}, 404);
  });
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const r = await (await fetch(`${base}/dsh-remote/purchase-agreement`)).json();
      assert.equal(r.ok, true);
      assert.equal(r.url, FALLBACK);
      assert.equal(r.source, "fallback");
    });
  } finally {
    up.srv.close();
  }
});

test("路由：字段给了但非法（javascript:/data:/相对）→ 回兜底，并标记 source=public_config_invalid", async () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example/a", "/relay-api/api/purchase-agreement"]) {
    const up = await startFakeRelay((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/public-config") return json(res, { agreement_url: bad });
      json(res, {}, 404);
    });
    try {
      await withPlugin(async ({ relayDir, startHost }) => {
        await writeCfg(relayDir, up.base);
        const base = await listen(startHost());
        const r = await (await fetch(`${base}/dsh-remote/purchase-agreement`)).json();
        assert.equal(r.url, FALLBACK, `非法字段必须回兜底: ${bad}`);
        assert.equal(r.source, "public_config_invalid", "排障需要能看出'配了但非法'（不是没配）");
      });
    } finally {
      up.srv.close();
    }
  }
});

test("路由：public-config 不可达 → 仍 ok:true + 兜底（协议链接不得拖挂购买流程）", async () => {
  await withPlugin(async ({ relayDir, startHost }) => {
    await writeCfg(relayDir, "http://127.0.0.1:1"); // 一定没人监听的端口
    const base = await listen(startHost());
    const res = await fetch(`${base}/dsh-remote/purchase-agreement`);
    assert.equal(res.status, 200, "永远 200：购买入口的协议链接不该因服务端故障消失");
    const r = await res.json();
    assert.equal(r.ok, true);
    assert.equal(r.url, FALLBACK);
  });
});

test("路由：只接受 GET（POST → 404），不会把它当成可写接口", async () => {
  const up = await startFakeRelay((_req, res) => json(res, { agreement_url: "https://relay.test/a" }));
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const res = await fetch(`${base}/dsh-remote/purchase-agreement`, { method: "POST" });
      assert.equal(res.status, 404);
    });
  } finally {
    up.srv.close();
  }
});

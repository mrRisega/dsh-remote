// relay-router → 企业端「设备在线态」上报契约(源码级 + 行为级)。
//
// 背景:在线态只靠「最后见到时间」判定不可靠 —— 长时间运行的 bridge 不会刷新它,会被误判离线。
// router 是唯一真正知道 bridge 是否在线的进程,因此需要在 ①注册 ②断开 ③每 60s 心跳 三个时机上报。
// 本用例锁死这三条链路与上报形状(端点/令牌/字段),并保证失败不抛错(绝不影响隧道)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = readFileSync(path.join(ROOT, "packages/relay-router/src/index.mjs"), "utf8");

test("上报形状:POST /api/internal/device-presence + 内部令牌 + device_id/user_id/online 三字段", () => {
  assert.match(SRC, /function reportPresence\(deviceId, userId, online\)/);
  assert.match(SRC, /\/api\/internal\/device-presence/);
  assert.match(SRC, /authorization: `Bearer \$\{INTERNAL_TOKEN\}`/);
  assert.match(SRC, /body: JSON\.stringify\(\{ device_id: String\(deviceId\), user_id: uid, online: online === true \}\)/);
  // 无内部令牌/非法 user_id → 直接返回,不发请求(自建/未配置环境零副作用)
  assert.match(SRC, /if \(!deviceId \|\| !Number\.isInteger\(uid\) \|\| uid <= 0 \|\| !INTERNAL_TOKEN\) return;/);
  // 失败静默:enterprise 不可达不影响隧道
  assert.match(SRC, /\}\)\.catch\(\(\) => \{ \/\* 静默:企业端不可达不影响隧道 \*\/ \}\);/);
});

test("三个上报时机:注册成功→true;断开(且确实从在线表摘除)→false;每 60s 心跳补 true", () => {
  // ① 注册成功 → 紧接着上报 online=true
  //    (2026-09-17 起「bridge 注册」日志改走 logBridgeChurn 抑制器以躲开重连风暴刷屏,
  //     但**上报链路本身不变**;文案仍为 `[router] bridge 注册: <deviceId> (user=.., plan=.., name=..)`)
  assert.match(SRC, /logBridgeChurn\(deviceId, "注册"[\s\S]{0,400}?reportPresence\(deviceId, dev\.userId, true\)/);
  // 注册文案由抑制器统一产出(仍带 user/plan/name 详情)
  assert.match(SRC, /\[router\] bridge \$\{kind\}: \$\{deviceId\}/);
  assert.match(SRC, /dev\.userId\}, plan=\$\{dev\.plan\}, name=\$\{dev\.name\}/);
  // ② 断开:仅当设备确实已不在内存在线表中才上报离线(避免重复 close 把刚重连的设备误标离线)
  assert.match(SRC, /if \(!devices\.has\(dev\.deviceId\)\) reportPresence\(dev\.deviceId, dev\.userId, false\)/);
  // ③ 心跳扫描:60s 间隔、无在线设备不发请求、unref 不阻塞退出
  assert.match(SRC, /const PRESENCE_SWEEP_MS = 60_000;/);
  assert.match(SRC, /const presenceSweep = setInterval\(\(\) => \{[\s\S]{0,200}?if \(devices\.size === 0\) return;[\s\S]{0,200}?reportPresence\(dev\.deviceId, dev\.userId, true\);[\s\S]{0,80}?\}, PRESENCE_SWEEP_MS\);/);
  assert.match(SRC, /presenceSweep\.unref\?\.\(\);/);
});

test("行为:reportPresence 真发请求且失败不抛(企业端不可达也必须静默)", async () => {
  // 用假企业端接住上报,验证 ① 请求路径/头/体正确 ② 不可达时静默
  const seen = [];
  const fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ path: req.url, auth: req.headers.authorization || "", body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, updated: true }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = fake.address().port;

  // 抽取真实的 reportPresence 实现,注入可控的 INTERNAL_TOKEN / 端点,直接调用
  const from = SRC.indexOf("function reportPresence(");
  const to = SRC.indexOf("\n}", from) + 2;
  const impl = SRC.slice(from, to);
  const factory = new Function(
    "INTERNAL_TOKEN", "ENTERPRISE_INTERNAL_URL", "fetch", "AbortSignal",
    `${impl}; return reportPresence;`
  );
  const call = factory("tok-123", `http://127.0.0.1:${port}`, fetch, AbortSignal);

  call("dev-x", 42, true);
  call("dev-x", 42, false);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(seen.length, 2, "两次上报都应发出");
  assert.equal(seen[0].path, "/api/internal/device-presence");
  assert.equal(seen[0].auth, "Bearer tok-123");
  assert.deepEqual(seen[0].body, { device_id: "dev-x", user_id: 42, online: true });
  assert.deepEqual(seen[1].body, { device_id: "dev-x", user_id: 42, online: false });

  // 令牌缺失 → 一个请求都不发;端点不可达 → 不抛
  const noTok = factory("", `http://127.0.0.1:${port}`, fetch, AbortSignal);
  noTok("dev-y", 7, true);
  const dead = factory("tok-123", "http://127.0.0.1:1", fetch, AbortSignal);
  assert.doesNotThrow(() => dead("dev-z", 7, true));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(seen.length, 2, "缺令牌不得发出请求");
  await new Promise((r) => fake.close(r));
});

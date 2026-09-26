// 📣 公告 / 📶 镜像页耗时 —— **宿主半边**（lib/index.js）的路由契约回归。
//
// 为什么单独一个文件：announcements-ui.test.mjs 锁的是浏览器半的行为（徽标/入口/弹窗/不轮询），
// 这里锁的是 node 半的两条**代理**路由 —— 它们是被浏览器半当"不存在的接口"来对待的
// （fail closed 的前提是"拿不到就什么都不显示"），所以最要紧的用例是 **失败也不抛**。
//
// 两条路由：
//   GET  /dsh-remote/announcements        → 上游 GET  {api}/api/announcements?client=desktop[&install_id=]
//   POST /dsh-remote/announcements/click  → 上游 POST {api}/api/announcements/click {id[, install_id]}
//   POST /dsh-remote/telemetry/mirror-load → 入队 mirror_load（ms / at / outcome），非法入参**静默丢弃**
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply, __telemetryInternals as TELEMETRY } from "../lib/index.js";

/** 起一个假上游中继（只实现本文件关心的两个端点），把收到的请求记下来。 */
async function startUpstream(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, seen, base: `http://127.0.0.1:${srv.address().port}` };
}

function boot(relayDir) {
  const routes = [];
  apply({
    webServer: { register(rt) { routes.push(rt); return () => {}; } },
    effect(reg) { return reg(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    // 与 lib/index.js 的注册语义一致：kind=exact 精确匹配；kind=prefix 匹配自身或子路径。
    // 🔴 注册对象上**只有** {kind, path, handler} —— 没有 method/prefix 字段，
    //    方法判定与子路径分发都在插件自己的 handler 里（见 registerRoutes 的注册循环）。
    //    2026-09-27 修：本文件原来按 `route.prefix` / `route.method` 去匹配（那两个字段根本不存在）
    //    ⇒ methodOk 恒为 false ⇒ 所有请求都落到兜底 404、body 为空 ⇒ 真路由的用例集体报
    //    "Unexpected end of JSON input"（假红，不是实现的问题）。照 community-qr-ui.test.mjs 的写法对齐。
    const rt = routes.find((r) => (r.kind === "prefix"
      ? url.pathname === r.path || url.pathname.startsWith(r.path + "/")
      : url.pathname === r.path));
    (rt ? rt.handler : ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  return host;
}

// 注：本文件**不需要**自己管理 DSH_RELAY_SKIP_SERVICE —— `npm run test:plugin` 已给整个套件设了 `=1`。
// 曾经这里有个 withEnv() 提前 delete 它（既无人调用，又会被 setup-output.test.mjs 的静态护栏判为
// 「unset 开关却没伪造 HOME」）。删掉它，隔离与护栏两边都干净。

/**
 * 从假上游收到的请求里**只挑公告那一条**。
 * 为什么不能写 `up.seen[0]`：插件装载时还会对同一个 api_url 发起旁路请求
 * （harness 会话代持 scheduleHarnessMint、账号 device-login 等），它们同样落进 seen，
 * 谁先到不确定 —— 按下标取会变成**偶发假红**（2026-09-27 实测踩到一次）。
 */
const annReq = (up) => up.seen.find((e) => String(e.url || "").startsWith("/api/announcements"));

const writeCfg = (relayDir, apiUrl, extra = {}) => writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
  device_id: "dev-ann-1", api_url: apiUrl, ...extra,
}));

// ───────────────────────────── GET 代理 ─────────────────────────────

test("GET /dsh-remote/announcements：显式带 client=desktop，未登录时带本机 install_id（复用 device_id，不新造 ID）", async () => {
  const up = await startUpstream((_e, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, bubble_enabled: true, items: [], unread_count: 0, popup: null })); });
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    await writeCfg(relayDir, up.base);
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    const r = await (await fetch(`${base}/dsh-remote/announcements?client=desktop`)).json();
    assert.equal(r.ok, true);

    const got = annReq(up);
    assert.ok(got, "必须真的打到上游 /api/announcements");
    assert.equal(got.method, "GET");
    const u = new URL(got.url, "http://x");
    assert.equal(u.pathname, "/api/announcements", "必须打到上游 /api/announcements");
    assert.equal(u.searchParams.get("client"), "desktop", "必须显式声明桌面端（926 迭代 §1）");
    assert.equal(u.searchParams.get("install_id"), "dev-ann-1", "未登录时用本机既有 device_id 做维度");
    assert.equal(got.headers.authorization, undefined, "没有账号时不得凭空造 Bearer");
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    up.srv.close();
    await rm(relayDir, { recursive: true, force: true });
  }
});

test("GET：浏览器已带 Bearer → 透传，且**不再**带 install_id（两种身份维度绝不能混用）", async () => {
  const up = await startUpstream((_e, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}"); });
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    await writeCfg(relayDir, up.base, { phone: "13800000000", password: "pw" });
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    await fetch(`${base}/dsh-remote/announcements?client=desktop`, { headers: { authorization: "Bearer browser-jwt" } });
    const got = annReq(up);
    assert.ok(got, "必须真的打到上游 /api/announcements");
    assert.equal(got.headers.authorization, "Bearer browser-jwt", "浏览器带上的身份必须原样透传");
    const u = new URL(got.url, "http://x");
    assert.equal(u.searchParams.get("install_id"), null,
      "有 user 维度时不得再带 install_id —— 唯一索引会把同一人两台机器算成两行，UV 翻倍");
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    up.srv.close();
    await rm(relayDir, { recursive: true, force: true });
  }
});

test("GET：上游 404（老服务端）→ 原样透传 404（浏览器半据此 fail closed），路由本身不抛", async () => {
  const up = await startUpstream((_e, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end("{\"error\":{\"code\":\"not_found\"}}"); });
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    await writeCfg(relayDir, up.base);
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    const res = await fetch(`${base}/dsh-remote/announcements?client=desktop`);
    assert.equal(res.status, 404);
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    up.srv.close();
    await rm(relayDir, { recursive: true, force: true });
  }
});

test("GET：上游不可达 → 502 + {ok:false}（软着陆：绝不抛成 500 堆栈）", async () => {
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    // 指向一个已经关掉的端口：连接必然失败
    await writeCfg(relayDir, "http://127.0.0.1:1");
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    const res = await fetch(`${base}/dsh-remote/announcements?client=desktop`);
    assert.equal(res.status, 502, "不可达必须是 502（不是 500、不是抛异常）");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(String(body.error), /公告服务不可达/);
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    await rm(relayDir, { recursive: true, force: true });
  }
});

// ───────────────────────────── click 代理 ─────────────────────────────

test("POST /dsh-remote/announcements/click：转发 {id} 到上游 /api/announcements/click，并补 install_id", async () => {
  const up = await startUpstream((_e, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}"); });
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    await writeCfg(relayDir, up.base);
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    const r = await (await fetch(`${base}/dsh-remote/announcements/click`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 7 }),
    })).json();
    assert.equal(r.ok, true);

    const got = annReq(up);
    assert.ok(got, "必须真的打到上游 /api/announcements/click");
    assert.equal(got.method, "POST");
    assert.equal(new URL(got.url, "http://x").pathname, "/api/announcements/click");
    const sent = JSON.parse(got.body);
    assert.equal(sent.id, 7, "id 必须原样转发");
    assert.equal(sent.install_id, "dev-ann-1", "未登录维度要补 install_id，否则点击记不到这台机器名下");
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    up.srv.close();
    await rm(relayDir, { recursive: true, force: true });
  }
});

test("未知子路径 → 404（不自造接口，也不把奇怪路径代理到上游）", async () => {
  const up = await startUpstream((_e, res) => { res.writeHead(200); res.end("{}"); });
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    await writeCfg(relayDir, up.base);
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    // 契约里没有 /read —— 老客户端若按错的路径打过来，必须明确 404（而不是打到上游去）
    const res = await fetch(`${base}/dsh-remote/announcements/read`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    assert.equal(up.seen.length, 0, "未命中子路径时不得触碰上游");
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    up.srv.close();
    await rm(relayDir, { recursive: true, force: true });
  }
});

// ───────────────────────────── mirror_load 事件 ─────────────────────────────

test("mirror_load 事件形状：ms / at / outcome 三个字段，且越界由 eventOf 兜底钳制", () => {
  const ev = TELEMETRY.eventOf("mirror_load", { ms: 1234, at: 1758500000000, outcome: "slow" });
  assert.ok(ev, "mirror_load 必须在白名单里（否则事件被静默丢弃）");
  assert.equal(ev.name, "mirror_load");
  assert.equal(ev.ms, 1234);
  assert.equal(ev.at, 1758500000000, "at 必须是客户端事件时刻（覆盖默认的 Date.now）");
  assert.equal(ev.outcome, "slow");
  // 缺 at → 保留默认时刻（绝不发 0，0 会被读成 1970 年）
  const noAt = TELEMETRY.eventOf("mirror_load", { ms: 10 });
  assert.ok(noAt.at > 0, "没给 at 时必须退回事件构造时刻，绝不发 0");
  assert.equal(noAt.outcome, "ok", "outcome 只认 slow，其余一律 ok");
  // 越界 / 非法 ms：不写入该字段（路由层已先挡掉，这是第二道防线）
  const bad = TELEMETRY.eventOf("mirror_load", { ms: "abc" });
  assert.equal("ms" in bad, false, "非法 ms 不得进 payload");
  const huge = TELEMETRY.eventOf("mirror_load", { ms: 10 ** 9 });
  assert.equal(huge.ms, 600000, "越界 ms 钳到契约上限");
});

test("POST /dsh-remote/telemetry/mirror-load：合法/非法入参都回 200 {ok:true}，非法**静默丢弃**", async () => {
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ann-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    const host = boot(relayDir);
    await new Promise((r) => host.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${host.address().port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/dsh-remote/telemetry/mirror-load`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    // 隔离开关（DSH_RELAY_SKIP_SERVICE=1）下遥测整体关闭 → 这里看到的就是"路由**永远**回 200"，
    // 而不是 4xx/5xx —— 手机镜像页的加载路径绝不能被一条统计请求打扰。
    for (const payload of [
      { ms: 800, at: Date.now(), outcome: "ok" },
      { ms: -1, at: Date.now() },                 // 负数
      { ms: 600001, at: Date.now() },             // 超上限
      { ms: "abc" },                              // 非数字
      {},                                          // 缺字段
    ]) {
      const r = await post(payload);
      assert.equal(r.status, 200, "任何入参都必须是 200 " + JSON.stringify(payload));
      assert.equal(r.body.ok, true);
    }
    // 极端：连 JSON 都不是 → 仍然 200（绝不因为一条统计把页面打成错误）
    const raw = await fetch(`${base}/dsh-remote/telemetry/mirror-load`, { method: "POST", body: "not-json" });
    assert.equal(raw.status, 200);
    host.close();
  } finally {
    // 恢复套件级隔离（**不要 delete**）：package.json 的 test:plugin 就是把 DSH_RELAY_SKIP_SERVICE=1
    // 设给整个套件的；这里 delete 会把它一起删掉 → 本文件之后的用例失去隔离，真的去后台
    // `npx @mrrisegao/dsh-remote` 装运行环境（2026-09-27 实测：日志里刷出一串
    // 「检测到缺少桌面运行环境,已在后台自动安装」，既慢又有真实副作用）。
    // 本文件只测路由，不需要走真实分支。
    process.env.DSH_RELAY_SKIP_SERVICE = "1";
    TELEMETRY.reset(relayDir);
    await rm(relayDir, { recursive: true, force: true });
  }
});

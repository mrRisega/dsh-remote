// 🎉 企微交流群引导（使用满 2 小时弹一次）—— **宿主半边**（lib/index.js）代理路由回归。
//
// 背景（业主 2026-10-23 需求）：用户实际使用满 2 小时后要「加入企业微信群」引导，
// 每用户全局只弹一次；手机 Web 端已实现，桌面端插件面板复用**同一套企业端接口**：
//   GET  /api/community-invite/status → { ok, show, reason, used_seconds, required_seconds, qr_url }
//   POST /api/community-invite/shown  → { ok:true }（幂等）
//
// 桌面端浏览器半没有企业端用户 token 直连，所以本文件锁 node 半两条代理路由的契约：
//   GET  /dsh-remote/community-invite/status → 上游 GET  {api}/api/community-invite/status
//   POST /dsh-remote/community-invite/shown  → 上游 POST {api}/api/community-invite/shown
//
// 最要紧的四件（都是"写错就出事故"的点）：
//   ① 身份只认本机 device-login token，**不透传浏览器带来的 Authorization**；
//   ② 判定/记账全在服务端：show/reason/时长字段原样透传，node 半**不自己算**；
//   ③ qr_url 归一化成企业端绝对地址（相对路径在 dsh web 源上会解析到 127.0.0.1），
//      非 http(s)/站内路径一律丢弃（前端降级），绝不把 data:/javascript: 交给 <img src>；
//   ④ 一切失败软着陆：未登录/自建 → 200 + ok:false（面板静默）；上游 4xx/5xx 透传；
//      不可达 → 502 JSON，**绝不抛回 webServer**（否则面板会看到 500 堆栈）。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

/** 假 relay：device-login 发 token；community-invite 两个端点按 opts 返回（并记录收到的请求）。 */
async function startFakeRelay(opts = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw };
      seen.push(entry);
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const url = new URL(req.url, "http://x");
      // 模拟"token 拿到了、但企业端 community-invite 端点不可达"：直接掐连接（fetch 端表现为 status 0）
      if (opts.killCommunity && url.pathname.startsWith("/api/community-invite")) {
        try { req.socket.destroy(); } catch { /* 忽略 */ }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/device-login") {
        // device-login 失败场景：返回 401（插件 node 半应静默降级成 not_logged_in）
        if (opts.loginStatus && opts.loginStatus !== 200) return send(opts.loginStatus, { error: { code: "bad_credentials", message: "密码错误" } });
        return send(200, { token: "jwt-abc" });
      }
      if (url.pathname === "/api/community-invite/status") {
        if (opts.statusCode && opts.statusCode !== 200) {
          return send(opts.statusCode, { error: { code: "boom", message: "服务端炸了" } });
        }
        return send(200, opts.statusBody || {
          ok: true,
          show: true,
          reason: "ok",
          used_seconds: 7205,
          required_seconds: 7200,
          qr_url: "/qr/group-qr.png"
        });
      }
      if (req.method === "POST" && url.pathname === "/api/community-invite/shown") {
        return send(200, { ok: true });
      }
      send(404, { error: { code: "not_found" } });
    });
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
    // 与 announcements-proxy.test.mjs 对齐：注册对象只有 {kind,path,handler}，
    // prefix 路由的 handler 自己判别子路径（没有 route.prefix 字段）。
    const handler = routes.get(url.pathname) || routes.get("/dsh-remote/community-invite");
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  return host;
}

const writeCfg = (relayDir, apiUrl, extra = {}) => writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
  device_id: "dev-ci-1", api_url: apiUrl, phone: "13800000000", password: "pw", ...extra,
}));

/** 只挑 community-invite 的上游请求（插件装载时还会打 public-config / device-login 等旁路请求）。 */
const ciReqs = (up) => up.seen.filter((e) => String(e.url || "").startsWith("/api/community-invite"));

async function withPlugin(fn) {
  const relayDir = await mkdtemp(path.join(os.tmpdir(), "dsh-ci-"));
  process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 套件级隔离：绝不真的去后台装运行环境
  let host = null;
  try {
    return await fn({ relayDir, startHost: () => { host = boot(relayDir); return host; } });
  } finally {
    try { if (host) host.close(); } catch { /* 忽略 */ }
    process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 恢复（不要 delete：套件本来就靠它隔离）
    await rm(relayDir, { recursive: true, force: true });
  }
}

async function listen(host) {
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${host.address().port}`;
}

test("GET status：device-login token 打企业端，show/qr_url 原样透传（qr_url 归一化成绝对地址）", async () => {
  const up = await startFakeRelay();
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const r = await (await fetch(`${base}/dsh-remote/community-invite/status`)).json();
      assert.equal(r.ok, true);
      assert.equal(r.show, true);
      assert.equal(r.reason, "ok");
      assert.equal(r.used_seconds, 7205, "时长口径由服务端算，node 半只透传");
      assert.equal(r.required_seconds, 7200);
      assert.equal(r.qr_url, `${up.base}/qr/group-qr.png`, "相对路径必须拼成企业端绝对地址（否则图片落在 127.0.0.1 上打不开）");

      const got = ciReqs(up).find((e) => e.method === "GET" && e.url === "/api/community-invite/status");
      assert.ok(got, "必须真的打到企业端 GET /api/community-invite/status");
      assert.equal(got.headers.authorization, "Bearer jwt-abc", "必须用 device-login 换来的 token（sub = user）");
    });
  } finally {
    up.srv.close();
  }
});

test("GET status：show=false（未满 2h / 已弹过 / 没配二维码）原样透传，node 半绝不自己算", async () => {
  const up = await startFakeRelay({
    statusBody: { ok: true, show: false, reason: "already_shown", used_seconds: 9000, required_seconds: 7200, qr_url: "/qr/group-qr.png" }
  });
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const r = await (await fetch(`${base}/dsh-remote/community-invite/status`)).json();
      assert.equal(r.ok, true);
      assert.equal(r.show, false, "服务端说不弹就不弹");
      assert.equal(r.reason, "already_shown", "reason 要透传（面板/排障用）");
      assert.equal(r.used_seconds, 9000);
    });
  } finally {
    up.srv.close();
  }
});

test("GET status：qr_url 为空 / 非法协议（data:/javascript:/协议相对）→ 下发空串（前端降级）", async () => {
  for (const bad of ["", "  ", "data:image/png;base64,AAA", "javascript:alert(1)", "//evil.example/qr.png"]) {
    const up = await startFakeRelay({
      statusBody: { ok: true, show: true, reason: "ok", used_seconds: 7300, required_seconds: 7200, qr_url: bad }
    });
    try {
      await withPlugin(async ({ relayDir, startHost }) => {
        await writeCfg(relayDir, up.base);
        const base = await listen(startHost());
        const r = await (await fetch(`${base}/dsh-remote/community-invite/status`)).json();
        assert.equal(r.show, true, `show 仍然透传（${JSON.stringify(bad)}）`);
        assert.equal(r.qr_url, "", `非法/空 qr_url 必须下发空串，交给前端降级（实际 ${JSON.stringify(r.qr_url)}）`);
      });
    } finally {
      up.srv.close();
    }
  }
});

test("POST shown：幂等上报打到企业端 POST /api/community-invite/shown（Bearer）", async () => {
  const up = await startFakeRelay();
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const res = await fetch(`${base}/dsh-remote/community-invite/shown`, { method: "POST" });
      assert.equal(res.status, 200);
      const r = await res.json();
      assert.equal(r.ok, true);
      const got = ciReqs(up).find((e) => e.method === "POST" && e.url === "/api/community-invite/shown");
      assert.ok(got, "必须真的打到企业端 POST /api/community-invite/shown");
      assert.equal(got.headers.authorization, "Bearer jwt-abc");
      // 上报两次也必须都成功（幂等契约：展示时一次 + 关闭时一次）
      const again = await (await fetch(`${base}/dsh-remote/community-invite/shown`, { method: "POST" })).json();
      assert.equal(again.ok, true);
      assert.equal(ciReqs(up).filter((e) => e.method === "POST").length, 2, "两次上报都要转发（服务端幂等）");
    });
  } finally {
    up.srv.close();
  }
});

test("鉴权：没配账号 → 200 + ok:false/not_logged_in，且完全不碰企业端（不白跑 device-login）", async () => {
  const up = await startFakeRelay();
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base, { phone: "", password: "" });
      const base = await listen(startHost());
      const r = await (await fetch(`${base}/dsh-remote/community-invite/status`)).json();
      assert.equal(r.ok, false);
      assert.equal(r.show, false, "未登录绝不能让面板弹引导");
      assert.equal(r.reason, "not_logged_in");
      assert.equal(ciReqs(up).length, 0, "不得向企业端发任何 community-invite 请求");
      assert.equal(up.seen.filter((e) => e.url === "/api/device-login").length, 0, "没凭据就不该尝试 device-login");
    });
  } finally {
    up.srv.close();
  }
});

test("鉴权：自建（local_key）没有企业端账号体系 → local_mode，不发请求", async () => {
  const up = await startFakeRelay();
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base, { phone: "", password: "", local_key: "selfhost-key" });
      const base = await listen(startHost());
      const r = await (await fetch(`${base}/dsh-remote/community-invite/status`)).json();
      assert.equal(r.ok, false);
      assert.equal(r.show, false);
      assert.equal(r.reason, "local_mode");
      assert.equal(ciReqs(up).length, 0, "自建模式不得请求企业端");
    });
  } finally {
    up.srv.close();
  }
});

test("鉴权：device-login 换 token 失败 → 静默 not_logged_in（面板不弹、不报错）", async () => {
  const up = await startFakeRelay({ loginStatus: 401 });
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const res = await fetch(`${base}/dsh-remote/community-invite/status`);
      assert.equal(res.status, 200, "对面板而言是静默降级，不是 500");
      const r = await res.json();
      assert.equal(r.ok, false);
      assert.equal(r.show, false);
      assert.equal(r.reason, "not_logged_in");
    });
  } finally {
    up.srv.close();
  }
});

test("错误语义：企业端 401/500 → 状态码透传 + ok:false + 可读 error（面板依旧静默）", async () => {
  for (const code of [401, 500]) {
    const up = await startFakeRelay({ statusCode: code });
    try {
      await withPlugin(async ({ relayDir, startHost }) => {
        await writeCfg(relayDir, up.base);
        const base = await listen(startHost());
        const res = await fetch(`${base}/dsh-remote/community-invite/status`);
        assert.equal(res.status, code, "上游状态码透传（排障能看见，不伪装成 200）");
        const r = await res.json();
        assert.equal(r.ok, false);
        assert.equal(r.show, false);
        assert.equal(r.reason, "status_failed");
        assert.ok(String(r.error || "").length > 0, "必须给可读错误");
      });
    } finally {
      up.srv.close();
    }
  }
});

test("软着陆：整个企业端不可达（连 token 都拿不到）→ 200 + not_logged_in，面板不弹不报错", async () => {
  await withPlugin(async ({ relayDir, startHost }) => {
    // 指向一个一定没人监听的端口
    await writeCfg(relayDir, "http://127.0.0.1:1");
    const base = await listen(startHost());
    const res = await fetch(`${base}/dsh-remote/community-invite/status`);
    assert.equal(res.status, 200, "拿不到 token 属于'未登录'，不是服务端错误（面板静默）");
    const r = await res.json();
    assert.equal(r.ok, false);
    assert.equal(r.show, false);
    assert.equal(r.reason, "not_logged_in");
  });
});

test("错误语义：token 拿到了但企业端 community-invite 端点不可达 → 502 JSON（路由自身绝不抛）", async () => {
  const up = await startFakeRelay({ killCommunity: true });
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      const res = await fetch(`${base}/dsh-remote/community-invite/status`);
      assert.equal(res.status, 502, "已确认登录、失败发生在上游请求 → 502（排障可见，不是静默 200）");
      const r = await res.json();
      assert.equal(r.ok, false);
      assert.equal(r.show, false);
      assert.equal(r.reason, "status_failed");
      assert.ok(String(r.error || "").length > 0);
      // 路由本身绝不能把异常抛回 webServer（那会变成 500 + 堆栈）
      assert.notEqual(res.status, 500);
    });
  } finally {
    up.srv.close();
  }
});

test("未知子路径 / 错误方法 → 404，不代理到奇怪的上游路径", async () => {
  const up = await startFakeRelay();
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      for (const [p, method] of [["/dsh-remote/community-invite/other", "GET"], ["/dsh-remote/community-invite/status", "POST"], ["/dsh-remote/community-invite/shown", "GET"]]) {
        const res = await fetch(`${base}${p}`, { method });
        assert.equal(res.status, 404, `${method} ${p} 必须 404`);
        const r = await res.json();
        assert.equal(r.reason, "unknown_route");
      }
      assert.equal(ciReqs(up).length, 0, "未知路由绝不请求企业端");
    });
  } finally {
    up.srv.close();
  }
});

test("身份纪律：浏览器带来的 Authorization **不透传**（用户级接口只认本机 node 半 token）", async () => {
  const up = await startFakeRelay();
  try {
    await withPlugin(async ({ relayDir, startHost }) => {
      await writeCfg(relayDir, up.base);
      const base = await listen(startHost());
      await fetch(`${base}/dsh-remote/community-invite/status`, { headers: { authorization: "Bearer browser-forged" } });
      const got = ciReqs(up).find((e) => e.method === "GET");
      assert.ok(got);
      assert.equal(got.headers.authorization, "Bearer jwt-abc",
        "身份必须是本机 device-login 换来的 token；浏览器带的 token 不能替代（否则'谁的身份'就含糊了）");
    });
  } finally {
    up.srv.close();
  }
});

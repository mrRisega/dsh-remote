// 故障上报（用户主动）＋「让 DeepSeek 帮我修」的用例（0.6.12）。
//
// 产品原则（2026-09-23 定的，本文件把它锁死）：
//   ① **绝不**后台自动上传日志 —— 只有用户在面板里点「确认上报」才会发；
//   ② 发之前必须能把**将要发送的每一个字**摊给用户看（预览），并且日志可取消附带；
//   ③ 走**既有反馈通道**（企业端 /api/feedback），不需要服务端部署：正文 1 条 +
//      日志/报告作为**同一条反馈的回复**分片（服务端 content 硬限 2000 字）；
//   ④ 手机号/令牌/密码一律先脱敏再出机器；
//   ⑤ 「让 DeepSeek 帮我修」= 给用户提示词 + 让用户把结论报告贴回来（我们发版前就能自救）。
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const readOrEmpty = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };

/** 假反馈服务：只收 /api/feedback 与 /api/feedback/:id/replies（与企业端契约同构）。 */
function startFakeFeedback() {
  const seen = [];
  let nextId = 0;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { body = null; }
    seen.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      nextId += 1;
      return send(201, { ok: true, feedback: { id: `fb_test_${nextId}`, kind: body?.kind }, thread_token: `tt_${nextId}` });
    }
    if (req.method === "POST" && /^\/api\/feedback\/[^/]+\/replies$/.test(url.pathname)) {
      return send(201, { ok: true });
    }
    return send(404, { error: { code: "not_found" } });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    srv,
    seen,
    port: srv.address().port,
    creates: () => seen.filter((s) => s.method === "POST" && s.path === "/api/feedback"),
    replies: () => seen.filter((s) => /replies$/.test(s.path)),
  })));
}

async function makeEnv({ feedbackPort }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-diag-"));
  const relayDir = path.join(root, "relay");
  await mkdir(relayDir, { recursive: true });
  // 一个"能加载"的运行环境（入口 + 它点名的文件都在），避免半装判定把用例带偏
  await writeFile(path.join(relayDir, "dsh-setup.mjs"), "// runtime stub\n");
  await writeFile(path.join(relayDir, ".dsh-config.json"), JSON.stringify({
    phone: "13800000000", password: "pw", device_id: "dev-diag",
    api_url: `http://127.0.0.1:${feedbackPort}`, feedback_url: `http://127.0.0.1:${feedbackPort}`,
  }));
  const saved = {};
  for (const k of ["DSH_RELAY_SKIP_SERVICE", "DSH_RELAY_PLATFORM", "DSH_REMOTE_TELEMETRY",
    "DSH_RELAY_DEFAULT_API", "DSH_RELAY_BUNDLED_RUNTIME", "DSH_RELAY_WEDGE_MS"]) saved[k] = process.env[k];
  process.env.DSH_RELAY_SKIP_SERVICE = "1";       // 隔离：用例不碰任何真实服务
  process.env.DSH_RELAY_PLATFORM = "win32";       // 现场是 Windows
  process.env.DSH_REMOTE_TELEMETRY = "0";
  process.env.DSH_RELAY_DEFAULT_API = "http://127.0.0.1:1";
  delete process.env.DSH_RELAY_BUNDLED_RUNTIME;
  delete process.env.DSH_RELAY_WEDGE_MS;
  return {
    relayDir,
    async restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function boot(relayDir) {
  const routes = new Map();
  const disposers = [];
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { const d = register(); if (typeof d === "function") disposers.push(d); return d; },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  routes.dispose = () => { for (const d of disposers) { try { d(); } catch { /* 忽略 */ } } };
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

const getJson = async (url) => (await fetch(url)).json();
const postJson = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("预览：把「将要发送的每一个字」摊开，且不含手机号（脱敏后再出机器）", async () => {
  const fb = await startFakeFeedback();
  const env = await makeEnv({ feedbackPort: fb.port });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    // 日志里塞进手机号 / 令牌 / 崩溃栈：预览必须脱敏，且**保留**真实崩溃原因（那才是能定位的东西）
    await writeFile(path.join(env.relayDir, ".dsh-bridge.log"),
      "[bridge] 用账号 13800000000 登录换取 JWT...\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop\nError: Cannot find module 'ws'\n");
    await writeFile(path.join(env.relayDir, ".dsh-setup-install.log"),
      "[dsh-remote-web] 自动启动 bridge 未成功(not-installed): 运行环境入口脚本不存在\n");

    const b = await getJson(`${base}/dsh-remote/diag/bundle`);
    assert.equal(b.ok, true);
    assert.match(b.title, /\[诊断\]/);
    assert.match(b.title, /0\.6\./, "标题要带插件版本，便于后台按版本分桶");
    const all = b.summary + "\n" + b.parts.join("\n");
    for (const need of ["【阶段】", "【bridge】", "【上游】", "【配置目录】", env.relayDir]) {
      assert.ok(all.includes(need), `预览必须包含 ${need}（这些正是 2026-09-23 那次反馈里缺失的证据）`);
    }
    assert.match(all, /守护=/, "守护进程态必须可见（旧版诊断里它是隐身的）");
    assert.equal(b.parts.length, 2, "默认附带两个日志各一份分片");
    assert.ok(!all.includes("13800000000"), "手机号绝不能出现在将发送的内容里");
    assert.match(all, /138\*\*\*\*0000/, "日志里的手机号要被掩码");
    assert.match(all, /Bearer <已隐去>/, "令牌必须隐去");
    assert.match(all, /Cannot find module/, "真实崩溃原因必须保留（否则还是查不出来）");
    assert.match(all, /已登录/, "只说「已登录」，不把手机号外发（服务端据登录态已知是谁）");
    assert.equal(b.noteMax > 0, true, "要告诉前端备注上限");
  } finally { host.close(); routes.dispose(); await env.restore(); fb.srv.close(); }
});

test("上报：正文 1 条 + 日志分片作为同一条反馈的回复；不点就不发（零自动上报）", async () => {
  const fb = await startFakeFeedback();
  const env = await makeEnv({ feedbackPort: fb.port });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    await writeFile(path.join(env.relayDir, ".dsh-bridge.log"), "line-1\nline-2\n");
    await writeFile(path.join(env.relayDir, ".dsh-setup-install.log"), "install-line-1\n");
    // ① 只打开面板、不点上报 → 反馈服务**一次都不该被打到**
    await getJson(`${base}/dsh-remote/diag/bundle`);
    assert.equal(fb.creates().length + fb.replies().length, 0,
      "预览阶段绝不允许提交任何反馈（隐私红线；插件装载时的装机上报走的是别的端点，不算）");

    // ② 用户点「确认上报」→ 正文（含他的描述）+ 分片
    const r = await postJson(`${base}/dsh-remote/diag/report`, { note: "手机一直显示没有绑定任何电脑", attachLogs: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(String(r.body.id), /^fb_test_/);
    const creates = fb.creates();
    assert.equal(creates.length, 1, "正文只能是一条反馈");
    assert.equal(creates[0].body.kind, "feedback");
    assert.equal(creates[0].body.category, "bug");
    assert.match(String(creates[0].body.content), /手机一直显示没有绑定任何电脑/, "用户描述必须在正文里");
    assert.match(String(creates[0].body.content), /【阶段】/);
    assert.ok(!String(creates[0].body.content).includes("13800000000"), "正文同样不得带手机号");
    const replies = fb.replies();
    assert.equal(replies.length, 2, "两个日志各一条分片回复（服务端正文 2000 字上限的绕行方案）");
    assert.ok(replies.some((x) => String(x.body.content).includes("line-1")), "bridge 日志必须在分片里");
    assert.equal(creates[0].headers["x-dsh-device"], "dev-diag", "要带上设备身份（服务端据此关联机器）");

    // ③ 用户取消「附带日志」→ 只有正文
    const r2 = await postJson(`${base}/dsh-remote/diag/report`, { note: "只发正文", attachLogs: false });
    assert.equal(r2.body.parts, 0);
    assert.equal(fb.creates().length, 2);
    assert.equal(fb.replies().length, 2, "取消附带的这一条不产生新的分片");

    // ④ 回传「结论报告」：作为分片进同一条反馈
    const r3 = await postJson(`${base}/dsh-remote/diag/report`, { note: "来自让 DeepSeek 帮我修", attachLogs: false, report: "=== dsh-remote 诊断结论 ===\n机制判定: ②守护活着没起作用" });
    assert.equal(r3.body.parts, 1);
    assert.match(String(fb.replies().at(-1).body.content), /机制判定/, "用户回传的报告必须到达");
  } finally { host.close(); routes.dispose(); await env.restore(); fb.srv.close(); }
});

test("上报：坏 JSON 与超大 body 都要给人话，且绝不打挂宿主", async () => {
  const fb = await startFakeFeedback();
  const env = await makeEnv({ feedbackPort: fb.port });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    const bad = await fetch(`${base}/dsh-remote/diag/report`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{不是 JSON",
    });
    assert.equal(bad.status, 400);
    assert.match(String((await bad.json()).error), /JSON/);

    const huge = await fetch(`${base}/dsh-remote/diag/report`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x", report: "y".repeat(300 * 1024) }),
    });
    assert.equal(huge.status, 413, "超大 body 必须被挡下（保护宿主内存）");
    assert.equal(fb.creates().length, 0, "被挡下的请求不得提交到反馈服务");
  } finally { host.close(); routes.dispose(); await env.restore(); fb.srv.close(); }
});

test("修复提示词：带当前故障上下文（目录/上游/版本），便于用户本机 DSH 直接照做", async () => {
  const fb = await startFakeFeedback();
  const env = await makeEnv({ feedbackPort: fb.port });
  const routes = boot(env.relayDir);
  const { host, base } = await serve(routes);
  try {
    const b = await getJson(`${base}/dsh-remote/diag/fix-prompt`);
    assert.equal(b.ok, true);
    assert.match(b.prompt, new RegExp(env.relayDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "提示词要带上本机配置目录");
    assert.match(b.prompt, /127\.0\.0\.1:3080/, "提示词要带上上游地址（端口错配是本次事故的最大嫌疑）");
    assert.match(b.prompt, /\.dsh-bridge\.log/);
    assert.match(b.prompt, /\.dsh-setup-install\.log/);
    assert.match(b.reportTitle, /dsh-remote 诊断结论/, "报告格式要有固定首行，便于后台机器解析");
    assert.ok(Array.isArray(b.reportKeys) && b.reportKeys.includes("机制判定") && b.reportKeys.includes("修复结果"));
  } finally { host.close(); routes.dispose(); await env.restore(); fb.srv.close(); }
});

test("前端契约：两个入口都在连接卡上；上报只在用户点击后发生（源码级）", () => {
  const client = readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
  assert.match(client, /上报故障给开发者/, "面板必须有「上报故障给开发者」入口");
  assert.match(client, /让 DeepSeek 帮我修/, "面板必须有「让 DeepSeek 帮我修」入口");
  assert.match(client, /将要发送/, "上报前必须明确告诉用户「将要发送」的是什么");
  assert.match(client, /复制提示词/, "修复提示词必须可一键复制");
  assert.match(client, /回传结论报告/, "用户要能把 DSH 的结论报告回传给我们");
  // 只在用户点击后调用：这两个接口各只有**一个**调用点，且都在对应的事件处理函数里
  assert.equal((client.match(/dsh-remote\/diag\/report/g) || []).length, 1,
    "上报接口只能有一个调用点（防止有人在渲染/挂载时就发）");
  assert.equal((client.match(/dsh-remote\/diag\/bundle/g) || []).length, 1);
  assert.equal((client.match(/dsh-remote\/diag\/fix-prompt/g) || []).length, 1);
  const openFn = client.slice(client.indexOf("var openDiagReport = function"), client.indexOf("var openFixPrompt = function"));
  assert.match(openFn, /diag\/bundle/, "预览只在用户打开上报时才拉取");
  assert.ok(!/useEffect/.test(openFn), "预览不得挂在 useEffect 里自动触发");
});

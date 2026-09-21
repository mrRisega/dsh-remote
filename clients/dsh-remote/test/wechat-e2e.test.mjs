/**
 * 微信通道**端到端**联调测试。
 *
 * 为什么必须单独有这一个文件:它覆盖的是**集成缝**,而这条缝恰好最容易出问题 ——
 * 上线途中真的在缝里抓到过 bug(两个并行模块的 kind 词表不一致,各自单测全绿、
 * 拼起来用户收到「未知节点」;以及编排层的订阅器事件处理器压根没挂上)。
 *
 *   wechat-channel.test.mjs  用**假 client**  测协议与状态机
 *   dsh-events.test.mjs      用**假 mux**     测事件订阅
 *   wechat-runtime.test.mjs  用**假订阅器**   测编排
 *   ← 本文件:三者**全是真的**,只把腾讯 ilink 与 DSH mux 换成假上游
 *
 * 走的正是产品的第一条完整链路:
 *   DSH 发出审批 → 通道推送到微信 → 用户回数字 → 回执真的 POST 回 DSH
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import { createWeChatRuntime } from "../wechat-runtime.mjs";
import { saveAccount } from "../wechat-channel.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立(避免用固定 sleep 造成 flake)。 */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 25, label = "条件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor 超时:${label}`);
    await sleep(stepMs);
  }
}

/**
 * 假 DSH:一个 HTTP server 同时承载 `/api/$events/result`(回执 POST)
 * 与 WebSocket 升级(`/api/remote.mux`)。记录收到的回执与开过的流。
 */
async function fakeDsh() {
  const state = { results: [], streams: [], sockets: [], eventsStreamId: "" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url && req.url.startsWith("/api/$events/result")) {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* 记录原文 */ }
        state.results.push(parsed || { raw: body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: (parsed && parsed.rpcId) || "r", result: { ok: true } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  const wss = new WebSocketServer({ server, path: "/api/remote.mux" });
  wss.on("connection", (ws) => {
    state.sockets.push(ws);
    ws.on("message", (raw) => {
      let frame = null;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame.type !== "open") return;
      state.streams.push({ endpoint: frame.endpoint, streamId: frame.streamId });
      if (frame.endpoint === "$events") {
        // ⚠️ 必须记下订阅器**自己生成的** streamId:回推帧只有带上它才会被
        // `#onTextFrame` 认领(`if (stream === undefined) return;` 会丢掉未知流的帧)。
        // 早先我写死 "ev" 导致帧被丢弃,还误判成"顶层 waterfall 是协议形状" —— 两个错叠在一起。
        state.eventsStreamId = frame.streamId;
        // 真实 DSH 连接后的首帧就是这个形状(含 clientId —— 回执必须带它)
        ws.send(JSON.stringify({
          type: "item",
          streamId: frame.streamId,
          value: { type: "ready", clientId: "cli-e2e-1", host: { home: "/tmp" } }
        }));
      } else if (frame.endpoint === "session/control") {
        ws.send(JSON.stringify({
          type: "item", streamId: frame.streamId,
          value: { type: "baseline", value: { queues: {}, jobs: {}, projections: {} } }
        }));
      } else if (frame.endpoint === "session/follow") {
        ws.send(JSON.stringify({
          type: "item", streamId: frame.streamId,
          value: { type: "snapshot", header: {}, cursor: 0, records: [], projections: {} }
        }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${port}`,
        /**
         * 推一条审批请求,**按真实 DSH 的线上形状**。
         *
         * ⚠️ 形状经过对 DSH 源码的核对,不是猜的 —— 这里曾是本文件最大的错误来源:
         * 早先我按"顶层 waterfall 帧"构造,于是 e2e 只验证了我自己的假上游,
         * 对真实链路毫无背书。真实形状是**包在 item 里**的:
         *   · `dsh-api-gateway/lib/index.js` 的 `pump()`:
         *       `for await (const value of source) await this.send({type:"item",streamId,value})`
         *     —— **每一个**生成器产出都被这层包住(waterfall 也不例外)。
         *   · 生产者在同一文件把 `{type:"waterfall",event,eventId,agentId,request}` 推进
         *     per-client queue,queue 的产出就是上面那个 `value`。
         *   · DSH **自己的浏览器客户端** `dsh-api-gateway/lib/client.js:729` 同样在
         *     `value.type === "waterfall"` 上解析 —— 若真机发顶层帧,DSH 自己的 UI 会把
         *     每一次审批都丢掉,而审批恰恰是那个 UI 在答的。这是最硬的一条反证。
         *   · `dsh-client-connection/lib/client.js:5599` 那个顶层字面量是**测试 fixture**
         *     (`approvalInvocation`,reason 写着「fixture 常驻审批」),不是协议。
         *
         * 另外 request 里**不能带 `agent` / `signal`**:客户端校验器
         * `hasExactRemoteEventKeys` + `!Object.hasOwn(request,"agent")` 会直接判非法。
         */
        pushApproval({ eventId = "evt-1", agentId = "agent-1", toolName = "Bash", reason = "安装依赖" } = {}) {
          const ws = state.sockets[0];
          assert.ok(ws, "还没有 $events 连接");
          ws.send(JSON.stringify({
            type: "item",
            streamId: state.eventsStreamId,
            value: {
              type: "waterfall",
              event: "approval/request",
              eventId,
              agentId,
              request: { toolName, reason }
            }
          }));
        },
        close: () => new Promise((r) => {
          for (const ws of state.sockets) { try { ws.close(); } catch { /* 忽略 */ } }
          try { wss.close(); } catch { /* 忽略 */ }
          try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
          server.close(() => r());
        })
      });
    });
  });
}

/** 假腾讯 ilink:收 sendmessage、发 getupdates。 */
async function fakeIlink() {
  const state = { sends: [], queue: [], notifyStart: 0, notifyStop: 0, getUpdates: 0, statusQueue: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const reply = (obj) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname.endsWith("/getupdates")) {
        state.getUpdates += 1;
        return reply({ ret: 0, msgs: state.queue.splice(0), get_updates_buf: "b" + state.getUpdates });
      }
      if (url.pathname.endsWith("/sendmessage")) {
        try { state.sends.push(JSON.parse(body)); } catch { state.sends.push({ raw: body }); }
        return reply({ ret: 0, message_id: "m" + state.sends.length });
      }
      if (url.pathname.endsWith("/notifystart")) { state.notifyStart += 1; return reply({ ret: 0 }); }
      if (url.pathname.endsWith("/notifystop")) { state.notifyStop += 1; return reply({ ret: 0 }); }
      if (url.pathname.endsWith("/get_bot_qrcode")) {
        return reply({ ret: 0, qrcode: "Q-e2e", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x?qrcode=Q-e2e&bot_type=3" });
      }
      if (url.pathname.endsWith("/get_qrcode_status")) {
        // 脚本化扫码状态机:绑定流程测试靠它推进(qrcode 状态是长轮询,一次一步)
        return reply(state.statusQueue.length ? state.statusQueue.shift() : { status: "wait" });
      }
      return reply({ ret: 0 });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      state,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      /** 模拟用户在微信里发一句话。 */
      userSays(text) {
        state.queue.push({ from_user_id: "user-e2e", client_id: "c1", item_list: [{ type: 1, text_item: { text } }] });
      },
      lastText() {
        const last = state.sends[state.sends.length - 1];
        return last && last.msg && last.msg.item_list && last.msg.item_list[0] && last.msg.item_list[0].text_item
          ? last.msg.item_list[0].text_item.text : "";
      },
      close: () => new Promise((r) => {
        try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
        server.close(() => r());
      })
    }));
  });
}

async function bootE2e() {
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-e2e-"));
  const ilink = await fakeIlink();
  const dsh = await fakeDsh();
  saveAccount(relayDir, { token: "tok-e2e", accountId: "bot-e2e", baseUrl: ilink.baseUrl, userId: "user-e2e", boundAt: 1 });
  // ⚠️ v2 起 beginBind 有**登录门槛**(必须已登录才给二维码,不让用户白扫一次)。
  //    判据是 .dsh-config.json 里有 phone —— 这里必须种一个,否则绑定流程测试会被门槛拦下。
  fs.writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify({ phone: "13800000000" }));
  const rt = createWeChatRuntime({
    relayDir,
    upstream: dsh.baseUrl,
    cookieOf: () => "dsh-auth-e2e=1",
    secret: "sec-e2e",
    logger: { info() {}, warn() {}, error() {}, debug() {}, addSecret() {} }
  });
  await rt.start();
  // 等真实的 dsh-events 订阅器连上并拿到 ready
  await waitFor(() => dsh.state.streams.some((s) => s.endpoint === "$events"), { label: "$events 打开" });
  await waitFor(() => dsh.state.sockets.length > 0, { label: "mux 连接" });
  return { rt, ilink, dsh, relayDir, close: async () => { await rt.stop(); await ilink.close(); await dsh.close(); } };
}

test("★ 端到端:DSH 审批 → 微信推送 → 用户回 1 → 回执真的回到 DSH", async () => {
  const { ilink, dsh, close } = await bootE2e();
  try {
    // 1) DSH 侧发出审批请求
    dsh.pushApproval({ eventId: "evt-e2e-1", toolName: "Bash", reason: "安装依赖" });

    // 2) 通道应把它推成微信消息,且带可回执的编号选项
    await waitFor(() => ilink.state.sends.length > 0, { label: "推送通知" });
    const text = ilink.lastText();
    assert.match(text, /需要你拍板/, `推送文案不对:${text}`);
    assert.match(text, /Bash/, "必须带工具名(否则用户不知道在批准什么)");
    assert.match(text, /安装依赖/, "必须带原因");
    assert.match(text, /回复 1/, "必须给出编号选项(可回执)");
    assert.match(text, /回复 2/);

    // 3) 用户在微信里回 "1"
    ilink.userSays("1");
    await waitFor(() => dsh.state.results.length > 0, { label: "回执到达 DSH" });

    // 4) 回执必须是**合法的 DSH 信封**,且 outcome 是 allowed-once
    const body = dsh.state.results[0];
    assert.equal(body.method, "$events/result", `method 不对:${JSON.stringify(body)}`);
    const args = body.payload && body.payload.args;
    assert.ok(args, "缺少 payload.args");
    assert.equal(args.clientId, "cli-e2e-1", "clientId 必须取自 ready 帧,否则服务端认不出是哪条流");
    assert.equal(args.eventId, "evt-e2e-1", "eventId 必须是那条审批的 id");
    assert.deepEqual(args.outcome, { kind: "result", value: "allowed-once" }, "回 1 必须解码成 allowed-once");

    // 5) 用户应收到确认
    await waitFor(() => ilink.state.sends.length >= 2, { label: "确认回复" });
    assert.match(ilink.lastText(), /已按你的选择/, `确认文案不对:${ilink.lastText()}`);
  } finally {
    await close();
  }
});

test("防御:顶层 waterfall 帧也要能收(未观测形态的兜底,非主路径)", async () => {
  // 主路径是 item 内嵌(真实线上形状,见本文件 pushApproval 的注释)。
  // 这条只保证:万一服务端将来改成顶层下发,我们不会**静默丢掉审批**。
  const { ilink, dsh, close } = await bootE2e();
  try {
    const ws = dsh.state.sockets[0];
    assert.ok(ws, "还没有 mux 连接");
    ws.send(JSON.stringify({
      type: "waterfall",
      event: "approval/request",
      eventId: "evt-top-1",
      agentId: "agent-top",
      request: { toolName: "Bash", reason: "顶层形态兜底" }
    }));
    await waitFor(() => ilink.state.sends.length > 0, { label: "顶层帧也应被识别" });
    assert.match(ilink.lastText(), /需要你拍板/);
    ilink.userSays("1");
    await waitFor(() => dsh.state.results.length > 0, { label: "顶层帧的回执" });
    assert.deepEqual(dsh.state.results[0].payload.args.outcome, { kind: "result", value: "allowed-once" });
    assert.equal(dsh.state.results[0].payload.args.eventId, "evt-top-1");
  } finally {
    await close();
  }
});

test("★ 端到端:回 2 必须解码成 rejected(而不是「也是同意」)", async () => {
  const { ilink, dsh, close } = await bootE2e();
  try {
    // ⚠️ 刻意用**非破坏性**理由:破坏性操作现在会被降级为"回电脑确认"、不给编号选项,
    //    那条路径由下面单独一条用例覆盖。这里要验的是正常的 1/2 映射。
    dsh.pushApproval({ eventId: "evt-e2e-2", toolName: "Bash", reason: "跑一下单元测试" });
    await waitFor(() => ilink.state.sends.length > 0, { label: "推送" });
    ilink.userSays("2");
    await waitFor(() => dsh.state.results.length > 0, { label: "回执" });
    const args = dsh.state.results[0].payload.args;
    assert.deepEqual(args.outcome, { kind: "result", value: "rejected" });
    assert.equal(args.eventId, "evt-e2e-2");
  } finally {
    await close();
  }
});

test("★ 端到端:没有待办时回数字,不得凭空发出任何回执(过期≠同意)", async () => {
  const { ilink, dsh, close } = await bootE2e();
  try {
    ilink.userSays("1");
    await waitFor(() => ilink.state.sends.length > 0, { label: "回复" });
    assert.match(ilink.lastText(), /没有代你做出任何选择/, `应明确拒绝,实际:${ilink.lastText()}`);
    assert.equal(dsh.state.results.length, 0, "绝不能在没有待办时发出回执");
  } finally {
    await close();
  }
});

test("★ 端到端:同一条审批回两次,只回执一次", async () => {
  const { ilink, dsh, close } = await bootE2e();
  try {
    dsh.pushApproval({ eventId: "evt-e2e-3" });
    await waitFor(() => ilink.state.sends.length > 0, { label: "推送" });
    ilink.userSays("1");
    await waitFor(() => dsh.state.results.length === 1, { label: "第一次回执" });
    ilink.userSays("1");
    await sleep(400);
    assert.equal(dsh.state.results.length, 1, "第二次回复不得再产生回执");
  } finally {
    await close();
  }
});

test("★ 端到端:通道上线要通知腾讯侧(notifystart),退出要 notifystop", async () => {
  const { ilink, close } = await bootE2e();
  try {
    await waitFor(() => ilink.state.notifyStart > 0, { label: "notifystart" });
    assert.ok(ilink.state.notifyStart > 0, "上线必须 notifystart —— 否则腾讯侧不知道通道在跑");
  } finally {
    await close();
  }
  assert.ok(ilink.state.notifyStop > 0, "优雅退出必须 notifystop —— 否则腾讯侧会一直以为通道在线");
});

test("端到端:面板控制面在真实运行时下可用,且不回显 token", async () => {
  const { rt, dsh, close } = await bootE2e();
  try {
    const port = rt.boundPort;
    assert.ok(port > 0, "控制面应已监听");
    const r = await fetch(`http://127.0.0.1:${port}/wechat/status`, { headers: { "x-dsh-bridge-secret": "sec-e2e" } });
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.bound, true);
    assert.equal(s.channel_running, true);
    assert.ok(!JSON.stringify(s).includes("tok-e2e"), `状态泄漏 token:${JSON.stringify(s)}`);
    // 未带密钥必须 401
    assert.equal((await fetch(`http://127.0.0.1:${port}/wechat/status`)).status, 401);
    void dsh;
  } finally {
    await close();
  }
});

test("★ 绑定流程走**真实控制面 API**(面板就是这么调的):取二维码 → 轮询 → 配对码 → 已绑定", async () => {
  // 这条补的是最后一个没人测过的缝:面板宿主半边代理 ↔ bridge 真实控制面。
  // 两边各自都有测试,但一边用假 bridge、另一边直接调对象 —— 没有一条串起来过。
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-bind-"));
  const ilink = await fakeIlink();
  const dsh = await fakeDsh();
  // v2 登录门槛:这条路要验的是**绑定流程本身**,所以先满足"已登录"前提
  fs.writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify({ phone: "13800000000" }));
  // 脚本化:wait → need_verifycode → scaned → confirmed
  ilink.state.statusQueue.push(
    { status: "wait" },
    { status: "need_verifycode" },
    { status: "scaned" },
    { status: "confirmed", bot_token: "tok-bind", ilink_bot_id: "bot-bind", baseurl: ilink.baseUrl, ilink_user_id: "u-bind" }
  );
  const rt = createWeChatRuntime({
    relayDir,
    upstream: dsh.baseUrl,
    cookieOf: () => "x=1",
    secret: "sec-bind",
    baseUrl: ilink.baseUrl,
    logger: { info() {}, warn() {}, error() {}, debug() {}, addSecret() {} }
  });
  const H = { "x-dsh-bridge-secret": "sec-bind", "content-type": "application/json" };
  const call = async (pathname, init = {}) => {
    const r = await fetch(`http://127.0.0.1:${rt.boundPort}${pathname}`, { headers: H, ...init });
    return { status: r.status, body: await r.json() };
  };
  try {
    await rt.startControl();
    const st0 = await call("/wechat/status");
    assert.equal(st0.body.bound, false, "初始应是未绑定");

    const started = await call("/wechat/bind/start", { method: "POST" });
    assert.equal(started.body.ok, true, `取二维码失败:${JSON.stringify(started.body)}`);
    assert.match(started.body.qrcode_svg, /^data:image\/svg\+xml;base64,/, "面板要的是一张能直接 <img src> 的 data URL");

    // 推进到 need_verifycode —— 这一步是真实的:手机扫码后微信会让用户输数字配对码
    const states = [];
    let needCode = false;
    for (let i = 0; i < 6; i++) {
      const r = await call("/wechat/bind/poll");
      states.push(r.body.state);
      if (r.body.need_verify_code) { needCode = true; break; }
    }
    assert.ok(needCode, `应派出 need_verifycode(否则面板不会弹配对码输入框),实际:${JSON.stringify(states)}`);

    const verified = await call("/wechat/bind/verify", { method: "POST", body: JSON.stringify({ code: "4321" }) });
    assert.equal(verified.body.ok, true, `提交配对码失败:${JSON.stringify(verified.body)}`);

    let bound = false;
    for (let i = 0; i < 8; i++) {
      const r = await call("/wechat/bind/poll");
      if (r.body.state === "confirmed" || r.body.bound) { bound = true; break; }
    }
    assert.ok(bound, "绑定应最终走到 confirmed");

    const st = await call("/wechat/status");
    assert.equal(st.body.bound, true, "绑定后状态必须是已绑定");
    assert.equal(st.body.bot_id, "bot-bind");
    assert.ok(!JSON.stringify(st.body).includes("tok-bind"), `状态泄漏 token:${JSON.stringify(st.body)}`);
    // 凭据确实落盘了(后续长轮询要用)
    assert.ok(fs.existsSync(path.join(relayDir, ".wechat-account.json")), "凭据应已落盘");
    const mode = fs.statSync(path.join(relayDir, ".wechat-account.json")).mode & 0o777;
    assert.equal(mode, 0o600, `凭据文件权限必须是 0600,实际 ${mode.toString(8)}`);

    const un = await call("/wechat/unbind", { method: "POST" });
    assert.equal(un.body.ok, true);
    assert.equal((await call("/wechat/status")).body.bound, false, "解绑后必须回到未绑定");
  } finally {
    await rt.stop();
    await ilink.close();
    await dsh.close();
  }
});

test("★ 端到端:破坏性操作不给一步回执,必须回电脑确认(安全边界)", async () => {
  const { ilink, dsh, close } = await bootE2e();
  try {
    dsh.pushApproval({ eventId: "evt-destr-1", toolName: "Bash", reason: "rm -rf /important" });
    await waitFor(() => ilink.state.sends.length > 0, { label: "破坏性审批推送" });
    const text = ilink.lastText();
    assert.match(text, /到电脑上确认/, `破坏性操作必须要求回电脑,实际:${text}`);
    assert.ok(!/回复 1/.test(text), "破坏性操作**不得**给出可一步回执的编号选项");

    // 关键:此时回数字**绝不能**产生回执 —— 一键放行破坏性操作正是要防的事
    ilink.userSays("1");
    await sleep(500);
    assert.equal(dsh.state.results.length, 0, "破坏性操作绝不能被微信一键放行");
  } finally {
    await close();
  }
});

test("★ 端到端:未登录时连二维码都不给(不让用户白扫一次)", async () => {
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-nologin-"));
  const ilink = await fakeIlink();
  const dsh = await fakeDsh();
  // 刻意**不写** .dsh-config.json → 未登录
  const rt = createWeChatRuntime({
    relayDir,
    upstream: dsh.baseUrl,
    cookieOf: () => "x=1",
    secret: "sec-nologin",
    baseUrl: ilink.baseUrl,
    logger: { info() {}, warn() {}, error() {}, debug() {}, addSecret() {} }
  });
  try {
    await rt.startControl();
    const r = await fetch(`http://127.0.0.1:${rt.boundPort}/wechat/bind/start`, {
      method: "POST",
      headers: { "x-dsh-bridge-secret": "sec-nologin", "content-type": "application/json" }
    });
    const body = await r.json();
    assert.equal(body.ok, false, "未登录必须拒绝绑定");
    assert.equal(body.code, "login_required");
    assert.match(body.error, /登录/, `错误信息要能照做,实际:${body.error}`);
    assert.ok(!body.qrcode_svg, "不得下发二维码");
  } finally {
    await rt.stop();
    await ilink.close();
    await dsh.close();
  }
});

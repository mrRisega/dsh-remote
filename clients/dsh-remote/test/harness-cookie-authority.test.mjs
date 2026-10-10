#!/usr/bin/env node
/**
 * Cookie **按 authority 隔离**回归（2026-10-09 故障根治）。
 *
 * 【故障原貌】`~/.dsh-remote/` 只有一份 `.harness-cookie.json`，而 Web 端(3080)与桌面端
 *   (每次启动随机端口)是**两个宿主进程**，各自的插件都往里写自己 authority 的 Cookie →
 *   互相覆盖。桥撞 401 后重读磁盘拿到的是**另一个宿主刚写的** Cookie（与失败的不是同一个）
 *   → 重试 → 还是 401 → 再读 → 又被覆盖回去……**乒乓，永不自愈**，手机端持续白页。
 *   现场极具迷惑性：`bridge-status` 显示 online、页面能开，只有日志里 401 刷屏。
 *
 * 【修法】每个宿主只写自己 authority 的文件 `.harness-cookie.<authority>.json`；桥只认
 *   **当前上游 authority** 的那一份，旧版共享文件仅在 authority 对得上（或旧插件根本没写
 *   authority）时才用，**声明了别的 authority 一律不用** —— 那一份必然 401，用它就是乒乓。
 *
 * 本用例走真实 `handleHttpFrame` → `doHttp` 全链路：假上游把"收到的 Cookie"回显出来，
 * 因此可以逐字断言桥**到底发了什么**（而不是只断言状态码）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsh-cookie-authority-"));
const LEGACY = path.join(tmpDir, ".harness-cookie.json");

/** 与两份源码同名的规则（漂移由下面的"源码约束"用例兜住）。 */
const slug = (authority) => String(authority).replace(/[^A-Za-z0-9._-]/g, "_");
const cookieFileFor = (authority) => path.join(tmpDir, `.harness-cookie.${slug(authority)}.json`);

let upstreamAuthority = "";
function writeDoc(file, doc) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
}
function clearCookies() {
  for (const f of [LEGACY, cookieFileFor(upstreamAuthority)]) rmSync(f, { force: true });
}

/** 假 dsh web：把收到的 Cookie 原样回显（200），便于断言"桥发了哪一份"。 */
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(req.headers.cookie || "");
});

process.env.DSH_BRIDGE_DEVICE_ID = "dev-cookieauth1";
process.env.DSH_BRIDGE_CONFIG = path.join(tmpDir, "config.json");

const { handleHttpFrame } = await new Promise((resolve, reject) => {
  upstream.listen(0, "127.0.0.1", () => {
    upstreamAuthority = `127.0.0.1:${upstream.address().port}`;
    process.env.DSH_BRIDGE_UPSTREAM = `http://${upstreamAuthority}`;
    import("../dsh-bridge.mjs").then(resolve, reject);
  });
});

async function ask(pathname = "/echo") {
  let reply;
  await handleHttpFrame((obj) => { reply = obj; return true; }, { type: "http", id: `req-${Math.random()}`, method: "GET", path: pathname, headers: {} });
  return { status: reply.status, cookie: Buffer.from(reply.body || "", "base64").toString("utf8") };
}

test("本宿主专属文件优先：`.harness-cookie.<authority>.json` 收到的就是它", async () => {
  clearCookies();
  writeDoc(cookieFileFor(upstreamAuthority), { authority: upstreamAuthority, cookie: "dsh-auth-OWN", mintedAt: Date.now() });
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.cookie, "dsh-auth-OWN");
});

test("★ 回归锁：旧版共享文件里是**另一个宿主**的 Cookie → 一个字节都不许发出去", async () => {
  clearCookies();
  // 这正是故障现场：共享文件被另一宿主(3080)覆盖过
  writeDoc(LEGACY, { authority: "127.0.0.1:3080", cookie: "dsh-auth-FOREIGN", mintedAt: Date.now() });
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(r.cookie, "", "foreign authority 的 Cookie 必须被跳过（发出去必然 401 → 乒乓）");
});

test("旧版共享文件 authority 对得上 → 继续用（向后兼容）", async () => {
  clearCookies();
  writeDoc(LEGACY, { authority: upstreamAuthority, cookie: "dsh-auth-LEGACY-OK", mintedAt: Date.now() });
  const r = await ask();
  assert.equal(r.cookie, "dsh-auth-LEGACY-OK");
});

test("旧插件没写 authority 字段 → 按兼容采用（不能因为缺字段就 401 白页）", async () => {
  clearCookies();
  writeDoc(LEGACY, { cookie: "dsh-auth-NO-AUTHORITY", mintedAt: Date.now() });
  const r = await ask();
  assert.equal(r.cookie, "dsh-auth-NO-AUTHORITY");
});

test("两份都在且互相矛盾 → 用本宿主那份（专属文件优先级高于共享镜像）", async () => {
  clearCookies();
  writeDoc(LEGACY, { authority: "127.0.0.1:3080", cookie: "dsh-auth-FOREIGN", mintedAt: Date.now() });
  writeDoc(cookieFileFor(upstreamAuthority), { authority: upstreamAuthority, cookie: "dsh-auth-OWN", mintedAt: Date.now() });
  const r = await ask();
  assert.equal(r.cookie, "dsh-auth-OWN");
});

test("源码约束（跨文件漂移锁）：命名规则与文件名模板两份必须逐字一致", () => {
  const bridge = readFileSync(new URL("../dsh-bridge.mjs", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../../../packages/dsh-remote-web/lib/index.js", import.meta.url), "utf8");
  const rule = 'return String(authority).replace(/[^A-Za-z0-9._-]/g, "_");';
  const nameTpl = '`${HARNESS_COOKIE_FILE.slice(0, -".json".length)}.${authoritySlug(authority)}.json`';
  const revokedTpl = "`${HARNESS_COOKIE_REVOKED_FILE}.${authoritySlug(authority)}`";
  for (const [label, src] of [["桥半", bridge], ["插件半", plugin]]) {
    assert.ok(src.includes(rule), `${label} 缺少 authoritySlug 规则（两份必须一致，否则各写各的文件名）`);
    assert.ok(src.includes(nameTpl), `${label} 缺少专属文件名模板`);
    assert.ok(src.includes(revokedTpl), `${label} 缺少专属作废标记名模板`);
  }
  assert.ok(bridge.includes("claimed === authority"), "桥半必须显式判 foreign authority（乒乓的根源）");
  assert.ok(plugin.includes("claimed === authority"), "插件半必须在读的时候判 foreign authority");
});

after(() => {
  try { upstream.close(); } catch { /* ignore */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

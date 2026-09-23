#!/usr/bin/env node
/**
 * 设备无关静态资源(manifest / favicon)兜底 —— 源码级 + 行为级契约测试。
 *
 * 用户实测:`https://<中继>/manifest.webmanifest` → **404**。
 * 根因:dsh web 的 HTML 里有 `<base href="/">`,于是 `./manifest.webmanifest` 永远解析成
 *   **根路径**;而根路径要靠 `dsh_device` cookie 才能路由到某台设备。浏览器抓取 PWA manifest
 *   按规范是 **credentials: omit**(不带 cookie),所以永远解析不到设备 → 404,
 *   控制台一条红色报错,「添加到主屏幕」也拿不到名字与图标。
 *
 * 修法:manifest / favicon 与"哪台设备"无关,由 router 在**解析不到设备**时本地应答。
 *
 * ⚠️ 白名单必须只覆盖这两条:兜底若变成"什么都回 200",会把真实的 404 诊断信息吃掉。
 *
 * 用法: node --test test/device-free-assets.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = readFileSync(path.join(ROOT, "packages/relay-router/src/index.mjs"), "utf8");

/** 从源码里抽出真实实现(与 presence-report.test.mjs 同一手法:不起整个服务也能测行为)。 */
function loadServeDeviceFreeAsset() {
  const start = SRC.indexOf("const REMOTE_ICON_SVG =");
  const end = SRC.indexOf("\n}\n", SRC.indexOf("function serveDeviceFreeAsset(")) + 3;
  assert.ok(start > 0 && end > start, "源码里找不到兜底实现");
  const impl = SRC.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function("Buffer", `${impl}; return { serveDeviceFreeAsset, DEVICE_FREE_ASSETS, REMOTE_ICON_SVG };`)(Buffer);
}

/** 假的响应对象:只记账。 */
function fakeRes() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

test("源码:白名单只含 manifest 与 favicon,且只在**解析不到设备**时兜底", () => {
  assert.match(SRC, /const DEVICE_FREE_ASSETS = new Map\(\[/);
  const mapBlock = SRC.slice(SRC.indexOf("const DEVICE_FREE_ASSETS"), SRC.indexOf("const DEVICE_FREE_ASSETS") + 1200);
  assert.match(mapBlock, /"\/manifest\.webmanifest"/);
  assert.match(mapBlock, /"\/favicon\.svg"/);
  // 不得顺手把一堆路径塞进白名单(每多一条,真实 404 就少一条)
  const entries = [...mapBlock.matchAll(/^\s{2}\["(\/[^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(entries, ["/manifest.webmanifest", "/favicon.svg"], `白名单应只有这两条,实际 ${entries.join(", ")}`);
});

test("源码:HTTP 处理里先兜底、再走 404;upgrade 通道**不得**兜底", () => {
  // HTTP 请求处理:兜底调用出现在 "const parsed = resolveRoute" 之后、"404" 之前
  const httpBlock = SRC.slice(SRC.indexOf("  const parsed = resolveRoute(req, url);\n  if (!parsed) {"), SRC.indexOf("  const parsed = resolveRoute(req, url);\n  if (!parsed) {") + 700);
  assert.match(httpBlock, /serveDeviceFreeAsset\(res, url\.pathname\)/, "HTTP 路径必须调用兜底");
  assert.match(httpBlock, /req\.method === "GET" \|\| req\.method === "HEAD"/, "只对 GET/HEAD 兜底");
  // upgrade 通道必须保持原样:往正在升级的 socket 上写 200 会把连接搞坏
  const upgradeTail = SRC.slice(SRC.indexOf('server.on("upgrade"'));
  assert.ok(!/serveDeviceFreeAsset/.test(upgradeTail), "upgrade 通道不得调用兜底");
});

test("行为:/manifest.webmanifest → 200,是合法 manifest,start_url 指向手机外壳", () => {
  const { serveDeviceFreeAsset } = loadServeDeviceFreeAsset();
  const res = fakeRes();
  assert.equal(serveDeviceFreeAsset(res, "/manifest.webmanifest"), true, "应命中白名单");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /application\/manifest\+json/);
  assert.ok(Number(res.headers["content-length"]) > 0, "必须给 content-length");
  const j = JSON.parse(res.body.toString("utf8"));
  assert.equal(j.start_url, "/app/", "start_url 必须是设备无关的手机外壳,而不是需要 deviceId 的镜像页");
  assert.equal(j.scope, "/");
  assert.equal(j.display, "standalone");
  assert.ok(Array.isArray(j.icons) && j.icons.length > 0, "没有图标就不可安装");
  assert.ok(j.name && j.short_name, "名字缺失会让「添加到主屏幕」显示成一个裸域名");
});

test("行为:/favicon.svg → 200 且是 SVG;未知路径仍然不命中(保住 404)", () => {
  const { serveDeviceFreeAsset } = loadServeDeviceFreeAsset();
  const icon = fakeRes();
  assert.equal(serveDeviceFreeAsset(icon, "/favicon.svg"), true);
  assert.equal(icon.status, 200);
  assert.match(String(icon.headers["content-type"]), /image\/svg\+xml/);
  assert.match(icon.body.toString("utf8"), /^<svg[\s>]/);

  for (const p of ["/robots.txt", "/", "/api/session/list", "/manifest.json", "/favicon.ico"]) {
    const r = fakeRes();
    assert.equal(serveDeviceFreeAsset(r, p), false, `${p} 不该被兜底(必须保持原 404 行为)`);
    assert.equal(r.status, null, `${p} 不该被写响应`);
  }
});

test("行为:兜底不依赖任何请求上下文(manifest 抓取没有 cookie,签名里就不该有 req)", () => {
  const { serveDeviceFreeAsset } = loadServeDeviceFreeAsset();
  assert.equal(serveDeviceFreeAsset.length, 2, "签名应为 (res, pathname) —— 绝不依赖 cookie/设备");
});

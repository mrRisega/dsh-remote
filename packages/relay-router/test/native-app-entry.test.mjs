/**
 * 手机端外壳（开源/自建版 clients/dsh-web/native.html）—— 「进设备路径 / 会话有效期 / 引导回跳」契约。
 * 与闭源仓库 relay-router/test/native-app-entry.test.mjs 同源同断言，两边行为必须一致。
 *
 * 事故与需求背景（2026-09-19 用户反馈）：
 *   ① 「点进某个设备之后，后面的路径没有了，直接就是 13443 的端口」——
 *      enterDevice 以前跳根路径 "/"，地址栏看不出在哪台设备上；而 dsh_device cookie 2 小时就过期，
 *      刷新根路径 → router 找不到设备 → 一句纯文本 404（手机上就是白屏）。
 *   ② 「会话过期时间要跟设备列表拿取的会话过期时间差不多」——
 *      cookie 写死 2 小时，而账号令牌（jwtTtlMs / 移动端会话默认 30 天）可配，
 *      于是"令牌还有效、cookie 先死"，界面过一段时间就必然报错。
 *   ③ 「会话过期/设备不在线时应该回到设备拉取的那个界面，不能让用户遇到白屏报错」——
 *      router 现在把出问题的页面导航 302 回 /app/?reason=…，外壳必须接住并给出
 *      「一句能照做的话」+ 停在正确的位置（登录页 or 设备列表）。
 *
 * 这些点都在"浏览器与用户之间"的最后一公里上：服务端测试覆盖不到，只能守源码契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "clients", "dsh-web", "native.html");
const html = readFileSync(HTML_PATH, "utf8");

/** 取出 `function NAME(...) { ... }` 的函数体(按大括号配平)。 */
function functionBody(src, name, keyword = "function ") {
  const start = src.indexOf(`${keyword}${name}(`);
  assert.notEqual(start, -1, `找不到 ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`函数 ${name} 大括号不配平`);
}

test("进设备走显式路径 /remote/<deviceId>/（不再是裸根路径）", () => {
  const body = functionBody(html, "enterDevice");
  assert.match(body, /window\.location\.replace\("\/remote\/" \+ encodeURIComponent\(deviceId\) \+ "\/"\)/,
    "必须跳到 /remote/<deviceId>/：地址栏要能看出设备，刷新/收藏/返回都指向同一台设备");
  assert.ok(!/location\.replace\("\/"\)/.test(body), "不得再跳根路径（设备 cookie 一过期就是纯文本 404）");
  assert.match(body, /writeDeviceCookie\(deviceId\)/, "设备 cookie 仍要写（绝对路径请求走 router 根路径兜底）");
});

test("会话 cookie 有效期跟随令牌 exp（与设备列表会话同生共死）", () => {
  const helper = functionBody(html, "sessionMaxAgeSeconds");
  assert.match(helper, /payload\.exp/, "必须从 JWT 的 exp 反推有效期");
  assert.match(helper, /left > 0 \? left : 0/, "已过期则 max-age=0（浏览器立即丢弃，不再留一个'假活着'的 cookie）");

  const write = functionBody(html, "writeSessionCookie");
  assert.match(write, /sessionMaxAgeSeconds\(token\)/, "写 cookie 的 max-age 必须由 exp 推导");
  assert.match(write, /max-age=\$\{maxAge\}/, "max-age 必须是推导值，不得写死");

  const dev = functionBody(html, "writeDeviceCookie");
  assert.match(dev, /sessionMaxAgeSeconds\(state\.token\)/, "设备 cookie 也要与令牌同寿命");

  // 反面：不得再出现写死的 2 小时 cookie
  assert.ok(!/max-age=\$\{hours \* 3600\}/.test(html), "不得再有写死 hours=2 的会话 cookie");
  assert.match(functionBody(html, "enterMirror", "async function "), /writeSessionCookie\("dsh_token", token\)/);
});

test("Router 引导回跳：四种 reason 都有能照做的文案，且落到正确的位置", () => {
  const body = functionBody(html, "handleEntryReason");
  for (const reason of ["expired", "offline", "forbidden", "unknown_device"]) {
    assert.match(body, new RegExp(`${reason}:`), `缺少 ${reason} 的处理分支`);
  }
  assert.match(body, /dsh-bridge/, "设备离线要说清「电脑端没在运行」，而不是只说「离线」");
  assert.match(body, /history\.replaceState\(null, "", "\/app\/"\)/, "处理完要清掉地址栏参数（刷新不重复提示）");
  assert.match(body, /tokenExpired\(state\.token\)/, "令牌已失效时要走登录页提示（此时设备视图不可见）");

  // init 必须真的接住 reason（两种分支都要接：令牌仍有效 / 已失效）
  const init = html.slice(html.indexOf("(async function init()"));
  assert.match(init, /const entryReason = \(new URLSearchParams\(window\.location\.search\)\.get\("reason"\) \|\| ""\)\.trim\(\)/);
  assert.ok(init.includes("handleEntryReason(entryReason)"), "令牌有效的分支要提示");
  assert.ok(init.includes('handleEntryReason(entryReason === "expired" ? "expired" : entryReason)'), "令牌失效的分支也要提示");
});

test("引导提示条是可关闭的、且不挡主流程", () => {
  assert.match(html, /id="entry-hint"/, "应有提示条容器");
  assert.match(html, /id="entry-hint-close"/, "应有可点击的关闭按钮");
  assert.match(html, /\$\("entry-hint-close"\)\.onclick = \(\) => \$\("entry-hint"\)\.classList\.add\("hidden"\)/, "关闭按钮要真的能关掉");
  assert.match(html, /\.entry-hint\.hidden \{ display: none; \}/, "hidden 必须显式声明 display:none（否则被 .card 的样式盖掉）");
});

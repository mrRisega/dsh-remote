/**
 * 「点入口怎么打开设置」契约测试（2026-10-11 业主反馈后的最终形态）。
 *
 * 背景（业主原话）：
 *   ① 「账号菜单里面的那个删掉。只保留官方槽位的那个。」
 *   ② 「设置界面出现了两个远程访问菜单。」—— 因为账号菜单注入的判据里加了"以设置结尾"，
 *      而「通用设置」正好以"设置"结尾 → 注入行被插进了**设置面板**里，多出一个"远程访问"。
 *   ③ 「点击……会触发一个小弹窗，同时也会把设置反馈的弹窗呼出来，有一瞬间会闪出一下，体验不好。」
 *      —— 那是"点账号菜单 → 再点设置"这条路带来的中间弹层。
 *
 * 现在的契约：
 *   · **不再往账号菜单里插任何东西**（dru-menu-row / accountMenuInjectTick 一律不得回来）；
 *   · 侧栏入口在桌面端用**官方设置快捷键**（⌥⌘, / Alt+Meta+,）直接打开设置面板，
 *     不产生任何中间弹层；打开后自动点中我们的栏目；
 *   · 面板里只能有**一个**「远程访问」栏目。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");

/** 把快捷键打开逻辑切出来，在最小环境里跑一遍。 */
function loadShortcut({ sectionFound = true } = {}) {
  const start = SOURCE.indexOf("function openSettingsViaShortcut()");
  assert.ok(start > 0, "应能定位 openSettingsViaShortcut");
  const end = SOURCE.indexOf("/**\n     * 打开「远程访问」设置栏目。", start);
  assert.ok(end > start, "应能定位函数结尾");
  const src = SOURCE.slice(start, end);

  const dispatched = [];
  const clicked = [];
  class KeyboardEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  }
  const document = { dispatchEvent: (e) => { dispatched.push(e); return true; } };
  const pickNavByToken = () => (sectionFound ? { click: () => clicked.push("远程访问") } : null);
  const fn = new Function(
    "document", "KeyboardEvent", "navTrace", "pickNavByToken", "NAV_POLL_MAX", "setInterval", "clearInterval",
    `${src}; return openSettingsViaShortcut;`
  )(document, KeyboardEvent, () => {}, pickNavByToken, 3, (f) => { f(); return 1; }, () => {});
  return { run: fn, dispatched, clicked };
}

test("★ 用官方设置快捷键（⌥⌘,）直接打开：不经过任何中间弹层", () => {
  const { run, dispatched } = loadShortcut();
  run();
  assert.equal(dispatched.length, 1, "应恰好派发一次快捷键事件");
  const ev = dispatched[0];
  assert.equal(ev.type, "keydown");
  assert.equal(ev.key, ",");
  assert.equal(ev.code, "Comma");
  assert.equal(ev.metaKey, true, "必须带 Meta（⌘）");
  assert.equal(ev.altKey, true, "必须带 Alt（⌥）—— 与设置行自带的 aria-keyshortcuts=\"Alt+Meta+,\" 一致");
});

test("★ 设置面板打开后自动点中「远程访问」栏目", () => {
  const { run, clicked } = loadShortcut({ sectionFound: true });
  run();
  assert.deepEqual(clicked, ["远程访问"], "面板开了要顺手切到我们的栏目");
});

test("★ 不再往账号菜单里插任何东西（业主明确要求删掉）", () => {
  for (const banned of ["dru-menu-row", "accountMenuInjectTick", "MENU_ENTRY_SIG", "viaAccountMenu"]) {
    assert.ok(!SOURCE.includes(banned), `不得再出现 ${banned}（账号菜单注入已按业主要求删除）`);
  }
  // 兜底也不许"点账号菜单"：那会闪出中间弹层（业主实测体验差）
  assert.ok(!/aria-haspopup="menu"[\s\S]{0,200}click\(\)/.test(SOURCE), "不得再通过点账号菜单来打开设置");
});

test("★ 反复出现的坑：判据不得用「以设置结尾」（会命中「通用设置」）", () => {
  // 这次设置面板里冒出两个「远程访问」，根因就是结尾匹配把「通用设置」当成了「设置」行。
  // 直接把这种判据钉死：源码里不得再出现「以设置/Settings 结尾」的正则片段。
  assert.ok(!SOURCE.includes("(设置|Settings)$"), "不得再用「以设置结尾」的判据");
  assert.ok(!SOURCE.includes("(设置|Settings)/$"), "不得再用「以设置结尾」的判据（另一种写法）");
});

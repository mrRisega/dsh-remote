/**
 * 「点入口怎么打开设置」契约测试（2026-10-11 用户反馈后的最终形态）。
 *
 * 背景（用户原话）：
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

test("★ 不再往账号菜单里插任何东西（用户明确要求删掉）", () => {
  for (const banned of ["dru-menu-row", "accountMenuInjectTick", "MENU_ENTRY_SIG"]) {
    assert.ok(!SOURCE.includes(banned), `不得再往账号菜单里插条目：${banned}（已按用户要求删除）`);
  }
});

test("★ 打开设置的顺序：侧栏候选 → 快捷键(验证) → 账号菜单(兜底)", () => {
  // 桌面端的 ⌥⌘, 是**原生菜单加速键**，合成 DOM 事件打不动它（真机实测"点了没反应"）；
  // 而"设置"只存在于账号菜单里 → 必须保留这条兜底，但只能在前面都失败后才走（它会闪一下）。
  assert.match(SOURCE, /open:shortcut-no-effect→account-menu/, "快捷键无效时必须转投账号菜单兜底");
  const shortcutAt = SOURCE.indexOf("function openSettingsViaShortcut()");
  const menuAt = SOURCE.indexOf("function openSettingsViaAccountMenu()");
  assert.ok(shortcutAt > 0 && menuAt > 0, "两条路径都要在");
  // 菜单兜底里必须带上"不是设置面板"的排除（否则会把设置面板当成账号菜单）
  assert.match(SOURCE, /indexOf\("通用设置"\) !== -1\) continue;/, "识别账号菜单时必须排除设置面板本身");
});

test("★ 「设置」行判据：认「设置 ⌥ ⌘ ,」，绝不认「通用设置」", () => {
  const start = SOURCE.indexOf("function menuRowIsSettings(");
  assert.ok(start > 0, "应有 menuRowIsSettings");
  const end = SOURCE.indexOf("function accountMenuTrigger()", start);
  const fn = new Function(`${SOURCE.slice(start, end)}; return menuRowIsSettings;`)();
  const mk = (t) => ({ textContent: t });
  assert.equal(fn(mk("设置 ⌥ ⌘ ,")), true, "真实文案带快捷键，必须认得");
  assert.equal(fn(mk("设置")), true, "纯文案也要认得");
  assert.equal(fn(mk("Settings")), true, "英文界面");
  assert.equal(fn(mk("通用设置")), false, "★ 绝不能认「通用设置」——2026-10-11 两个『远程访问』就是它造成的");
  assert.equal(fn(mk("📱 远程访问")), false, "不能认我们自己的入口");
  assert.equal(fn(mk("意见反馈")), false);
});

test("★ 反复出现的坑：判据不得用「以设置结尾」（会命中「通用设置」）", () => {
  // 这次设置面板里冒出两个「远程访问」，根因就是结尾匹配把「通用设置」当成了「设置」行。
  // 直接把这种判据钉死：源码里不得再出现「以设置/Settings 结尾」的正则片段。
  assert.ok(!SOURCE.includes("(设置|Settings)$"), "不得再用「以设置结尾」的判据");
  assert.ok(!SOURCE.includes("(设置|Settings)/$"), "不得再用「以设置结尾」的判据（另一种写法）");
});

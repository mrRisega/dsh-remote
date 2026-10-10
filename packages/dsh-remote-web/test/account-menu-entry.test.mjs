/**
 * 「账号菜单里的远程访问入口」行为测试（2026-10-11 业主指定位置）。
 *
 * 那个「小弹窗」= 桌面端自带的**账号菜单**（设置/意见反馈/登录/更多），由
 * `@deepseek-ai/dsh-client-ui-settings-account` 渲染 —— 它只在桌面渲染器里注册
 * （`dshDesktop` 判断）、且**没有给插件留菜单槽位**，所以放进它只能 DOM 插入。
 * 这类插入历史上出过两次事故（位置错、点到别的按钮），所以这里用行为测试把契约钉死：
 *   · 只在「确实是账号菜单」（含独有文案「意见反馈」）的浮层里动手
 *   · 插到「设置」那一行的**上方**
 *   · 幂等（重复调用不会插第二个）
 *   · 不 cloneNode（克隆会继承官方事件委托）
 *   · 找不到「设置」行 → 什么都不做（绝不猜位置）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");

/** 极简 DOM 替身：只实现该函数用到的能力（简单 tag/attr 选择器、textContent、insertBefore）。 */
class N {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...(opts.attrs || {}) };
    this.ownText = opts.text || "";
    this.children = [];
    this.parentNode = null;
    this.className = opts.cls || "";
  }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  // 真 DOM 里 `el.textContent = "x"` 会清空子节点再设文本；替身照做（否则断言取不到文案）
  set textContent(v) { this.ownText = String(v); this.children = []; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? String(this.attrs[n]) : null; }
  setAttribute(n, v) { this.attrs[n] = v; }
  append(...ns) { for (const c of ns) { c.parentNode = this; this.children.push(c); } return this; }
  _all(out = []) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  querySelectorAll(sel) { return this._all().filter((e) => N.match(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    node.parentNode = this;
    if (i === -1) this.children.push(node); else this.children.splice(i, 0, node);
    return node;
  }
  static match(el, sel) {
    return String(sel).split(",").some((one) => {
      const m = /^([a-zA-Z]*)((?:\[[^\]]*\])*)$/.exec(one.trim());
      if (!m) return false;
      const [, tag, attrPart] = m;
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      for (const a of (attrPart.match(/\[[^\]]*\]/g) || [])) {
        const inner = a.slice(1, -1);
        const eq = /^([^=]+)(?:="?([^"]*)"?)?$/.exec(inner);
        if (!eq) return false;
        const actual = el.getAttribute(eq[1].trim());
        if (eq[2] === undefined) { if (actual === null) return false; }
        else if (actual !== eq[2]) return false;
      }
      return true;
    });
  }
}

/** 从源码里切出被测函数（连同它用到的常量），在最简 document 上执行。 */
function loadTick(popups) {
  const start = SOURCE.indexOf("var MENU_ENTRY_SIG");
  const end = SOURCE.indexOf("function navEnsureStart()");
  assert.ok(start > 0 && end > start, "应能定位账号菜单注入代码");
  const src = SOURCE.slice(start, end);
  const document = {
    _popups: popups,
    querySelectorAll: (sel) => popups.filter((p) => N.match(p, sel)),
    createElement: (tag) => new N(tag),
    body: { click() { this.clicked = (this.clicked || 0) + 1; } },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function("document", "setTimeout", `${src}; return accountMenuInjectTick;`)(document, (f) => f());
  return { tick: fn, document };
}

function accountPopup(items) {
  const pop = new N("div", { attrs: { role: "menu" } });
  for (const t of items) pop.append(new N("button", { text: t, attrs: { role: "menuitem" } }));
  return pop;
}

test("★ 插到「设置」那一行**上方**，且文案是「📱 远程访问」", () => {
  const pop = accountPopup(["设置", "意见反馈", "登录", "更多"]);
  const { tick } = loadTick([pop]);
  tick();
  const texts = pop.children.map((c) => c.textContent);
  assert.deepEqual(texts, ["📱 远程访问", "设置", "意见反馈", "登录", "更多"],
    `入口必须紧邻「设置」上方，实际：${texts.join(" | ")}`);
  const btn = pop.children[0];
  assert.equal(btn.getAttribute("data-dru-account-menu"), "1", "应带幂等标记");
  assert.equal(btn.getAttribute("data-dru-remote"), "1", "应带我们自己的标记");
});

test("★ 真实文案带快捷键「设置 ⌥ ⌘ ,」也要认（业主现场就是这个文案）", () => {
  // 2026-10-11 实测：桌面端账号菜单里那一项是「设置 ⌥ ⌘ ,」（快捷键写在行内）。
  // 旧实现按全等匹配 "设置" → 插不进去也点不动，表现就是"点了一点反应都没有"。
  const pop = accountPopup(["设置 ⌥ ⌘ ,", "意见反馈", "退出登录"]);
  const { tick } = loadTick([pop]);
  tick();
  const texts = pop.children.map((c) => c.textContent);
  assert.equal(texts[0], "📱 远程访问", `必须插在带快捷键的设置行上方，实际：${texts.join(" | ")}`);
  assert.equal(texts[1], "设置 ⌥ ⌘ ,", "原有条目不得被改动");
});

test("★ 幂等：重复调用不会插出第二个入口", () => {
  const pop = accountPopup(["设置", "意见反馈"]);
  const { tick } = loadTick([pop]);
  tick(); tick(); tick();
  const n = pop.children.filter((c) => c.getAttribute("data-dru-account-menu") === "1").length;
  assert.equal(n, 1, "账号菜单里只能有一个我们的入口");
});

test("★ 不碰别的浮层：没有「意见反馈」的弹窗（如模型选择菜单）一律不动", () => {
  const modelMenu = accountPopup(["DeepSeek-V4", "DeepSeek-V3"]);
  const { tick } = loadTick([modelMenu]);
  tick();
  assert.deepEqual(modelMenu.children.map((c) => c.textContent), ["DeepSeek-V4", "DeepSeek-V3"],
    "不是账号菜单的浮层，一个字节都不能改");
});

test("★ 找不到「设置」那一行 → 什么都不做（绝不猜位置）", () => {
  const pop = accountPopup(["意见反馈", "登录", "更多"]);
  const { tick } = loadTick([pop]);
  tick();
  assert.deepEqual(pop.children.map((c) => c.textContent), ["意见反馈", "登录", "更多"],
    "没有锚点行时不得插入，避免又落错位置");
});

test("源码约束：绝不 cloneNode（克隆会继承官方事件委托，历史事故）", () => {
  const start = SOURCE.indexOf("var MENU_ENTRY_SIG");
  const end = SOURCE.indexOf("function navEnsureStart()");
  assert.ok(!/cloneNode/.test(SOURCE.slice(start, end)), "这段插入逻辑里不得出现 cloneNode");
});

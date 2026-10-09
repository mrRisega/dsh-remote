// dsh-remote-web 侧栏快捷入口「落点」回归（2026-10-09 桌面端事故）。
//
// 【事故】桌面端（DSH 0.2）设置面板本身就是 `role="dialog" aria-modal="true"` 的弹层，
//   它左侧栏目列表的第一项叫 **「通用设置」**。旧代码用「文本包含『设置』」（`indexOf !== -1`）
//   去找侧栏那颗齿轮按钮 → **命中的是弹层里的「通用设置」**，于是我们的「📱 远程访问」
//   快捷按钮被插进了设置面板栏目列表的最上面。业主截图反馈：「植入错了地方」。
//
// 本用例把 client.js 里的导航注入辅助函数**原样切出来**，喂一个最小 DOM，逐条锁住：
//   ① 官方「设置」触发器只按**语义锚点**（aria-haspopup="dialog"）识别，且必须在弹层之外；
//   ② 弹层内的「通用设置」**永远不能**被当成落点；
//   ③ 精确相等优先于子串匹配；
//   ④ 栏目项（在弹层内）仍能被找到 —— 修好落点不能把「点开栏目」这条路径弄坏。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** 把 `var NAV_ENTRY_ID` 到 `openRemoteSettings` 之前的那段辅助函数切出来（含依赖的常量）。 */
function navHelpersSource() {
  const start = SOURCE.indexOf('var NAV_ENTRY_ID = "dru-nav-remote";');
  const end = SOURCE.indexOf("/** 打开「远程访问」设置栏目");
  assert.ok(start > 0 && end > start, "切片锚点失效：侧栏入口辅助函数结构变了");
  return SOURCE.slice(start, end);
}

// ───────────────────────── 最小 DOM ─────────────────────────
// 只实现被测代码真正用到的那几个能力：属性/类名/文本、closest、querySelectorAll。
class El {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.id = opts.id || "";
    this.className = opts.cls || "";
    this.attrs = opts.attrs || {};
    this.ownText = opts.text || "";
    this.parentNode = null;
    this.children = [];
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  getAttribute(name) {
    if (name === "class") return this.className;
    if (name === "id") return this.id;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }
  append(...nodes) {
    for (const n of nodes) { n.parentNode = this; this.children.push(n); }
    return this;
  }
  /** 冒泡查最近的祖先（含自身）是否匹配选择器。 */
  closest(selector) {
    let cur = this;
    while (cur) {
      if (matches(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}
function descendants(root, out = []) {
  for (const c of root.children) { out.push(c); descendants(c, out); }
  return out;
}
/** 单条复合选择器：tag + [attr] / [attr="v"] / [class*="x" i]。够用即可，不求完整 CSS。 */
function matchesSimple(el, sel) {
  const m = /^([a-zA-Z]*)((?:\[[^\]]*\])*)$/.exec(sel.trim());
  if (!m) return false;
  const [, tag, attrPart] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const attrs = attrPart.match(/\[[^\]]*\]/g) || [];
  for (const a of attrs) {
    const inner = a.slice(1, -1);
    const eq = /^([^=*^$|~]+)(?:([*^$|~]?=)"?([^"]*)"?)?(?:\s+i)?$/.exec(inner);
    if (!eq) return false;
    const [, name, op, val] = eq;
    const caseInsensitive = /\si$/.test(inner);
    const actual = el.getAttribute(name.trim());
    if (op === undefined) { if (actual === null) return false; continue; }
    const hay = String(actual ?? "");
    const needle = String(val ?? "");
    const [H, N] = caseInsensitive ? [hay.toLowerCase(), needle.toLowerCase()] : [hay, needle];
    if (op === "=" && H !== N) return false;
    if (op === "*=" && H.indexOf(N) === -1) return false;
    if (op === "^=" && H.indexOf(N) !== 0) return false;
    if (op === "$=" && !H.endsWith(N)) return false;
  }
  return true;
}
function matches(el, selector) {
  return String(selector).split(",").some((one) => matchesSimple(el, one));
}
function makeDocument(roots) {
  const all = roots.flatMap((r) => [r, ...descendants(r)]);
  return {
    _all: all,
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelectorAll: (selector) => all.filter((e) => matches(e, selector)),
  };
}
function loadNavHelpers(doc) {
  const src = navHelpersSource() + "\nreturn { pickSettingsTrigger, pickNavByToken, navInDialog };";
  // eslint-disable-next-line no-new-func
  return new Function("document", "window", src)(doc, {});
}

/** 复刻桌面端 0.2 的真实结构：侧栏一颗齿轮 + 设置弹层（首项「通用设置」）。 */
function desktopFixture() {
  const sidebar = new El("div", { cls: "sidebar" });
  const trigger = new El("button", {
    cls: "Dws9Sa_trigger",
    attrs: { "aria-label": "设置", "aria-haspopup": "dialog", "aria-expanded": "false" },
    text: "设置"
  });
  sidebar.append(trigger);

  const dialog = new El("div", { attrs: { role: "dialog", "aria-modal": "true" } });
  const nav = new El("nav", { cls: "Dws9Sa_nav" });
  const general = new El("button", { cls: "Dws9Sa_navCell", text: "通用设置" });
  const remote = new El("button", { cls: "Dws9Sa_navCell", text: "📱 远程访问" });
  const models = new El("button", { cls: "Dws9Sa_navCell", text: "模型" });
  nav.append(general, models, remote);
  dialog.append(nav);

  const doc = makeDocument([sidebar, dialog]);
  return { doc, trigger, dialog, general, remote };
}

// ───────────────────────── 用例 ─────────────────────────

test("★ 事故锁：官方「设置」触发器只认语义锚点，且必须落在**设置弹层之外**", () => {
  const { doc, trigger } = desktopFixture();
  const { pickSettingsTrigger } = loadNavHelpers(doc);
  assert.equal(pickSettingsTrigger(), trigger, "必须命中侧栏那颗 aria-haspopup=dialog 的齿轮按钮");
});

test("★ 事故锁：弹层里的「通用设置」永远不能成为落点", () => {
  const { doc, general } = desktopFixture();
  const { pickSettingsTrigger, pickNavByToken } = loadNavHelpers(doc);
  assert.notEqual(pickSettingsTrigger(), general, "「通用设置」在弹层内，绝不能被当成侧栏设置按钮");
  // 严格等值 + 只要弹层外：结果只能是侧栏触发器，不能是「通用设置」
  assert.notEqual(pickNavByToken("设置", { exactOnly: true, insideDialog: false }), general);
  // 老写法（子串匹配）现在只能作为**兜底**，精确命中优先 —— 先保证不误伤
  assert.notEqual(pickNavByToken("设置"), general, "子串匹配不得再压过精确匹配");
});

test("弹层内没有 aria-haspopup 的栏目项，不能被当成「设置」触发器", () => {
  const dialogOnly = new El("div", { attrs: { role: "dialog", "aria-modal": "true" } });
  const nav = new El("nav");
  nav.append(new El("button", { cls: "navCell", text: "通用设置" }));
  dialogOnly.append(nav);
  const { pickSettingsTrigger } = loadNavHelpers(makeDocument([dialogOnly]));
  assert.equal(pickSettingsTrigger(), null, "找不到可信锚点时必须**不注入**，绝不将就一个错落点");
});

test("栏目项仍在弹层内被找到（修落点不能把「打开远程访问栏目」这条路弄坏）", () => {
  const { doc, remote } = desktopFixture();
  const { pickNavByToken } = loadNavHelpers(doc);
  assert.equal(pickNavByToken("远程访问", { insideDialog: true }), remote);
});

test("精确相等优先于子串：给了 exactOnly 时子串一律不算", () => {
  const root = new El("div", { cls: "sidebar" });
  const general = new El("button", { cls: "navCell", text: "通用设置" });
  const settings = new El("button", { cls: "navCell", text: "设置" });
  root.append(general, settings);
  const { pickNavByToken } = loadNavHelpers(makeDocument([root]));
  assert.equal(pickNavByToken("设置", { exactOnly: true, insideDialog: false }), settings);
});

test("源码约束：注入路径不得再出现「按文案模糊找设置」的写法", () => {
  assert.ok(!/pickNavByToken\(\s*"设置"\s*\)/.test(SOURCE),
    "侧栏落点不得再用 pickNavByToken(\"设置\")（子串会命中「通用设置」→ 按钮进设置面板）");
  assert.match(SOURCE, /aria-haspopup="dialog"/, "必须按 aria-haspopup=dialog 认官方设置触发器");
  assert.match(SOURCE, /\[role="dialog"\], \[aria-modal="true"\]/, "必须有「在设置弹层内」的判据");
  assert.match(SOURCE, /var host = pickSettingsTrigger\(\)/, "常驻注入必须走语义锚点");
  assert.match(SOURCE, /if \(navInDialog\(host\)\) return;/, "mountNavEntry 必须有最后一道弹层防线");
});

/**
 * 激活点唯一性 —— 配置不变量 + 安装器方向守护。
 *
 * 背景（2026-09-22 实测事故）：插件被两处同时激活时，dsh web **启动即挂**：
 *   `duplicate loader entry id: dsh-remote-web` → `plugin tree failed to load`。
 * 不是"插件不生效"，是**dsh 起不来**。
 *
 * 两处激活来自：① `dsh.profile.bundles` 里有插件自带 bundle；② profile 的
 * `cordis.patch.yml` 里又有激活行。而**自动维护流程会周期性把 bundle 写回** bundles，
 * 所以"删 bundles、留 patch"的修法会被撤销 → 又变两处 → 再崩。
 *
 * 稳定方向只有一个（本文件就是把它钉死）：
 *   **bundle 归包管理器管、我们不动它；我们保证自己不写第二个激活点。**
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { activationPoints, checkInvariant } from "../../../scripts/check-profile-activation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP_SRC = readFileSync(join(HERE, "..", "..", "..", "dsh-setup.mjs"), "utf8");

/** 造一个假 profile 目录。 */
function fakeProfile({ bundles = [], patch = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-act-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", dsh: { profile: { bundles } } }));
  writeFileSync(join(dir, "cordis.patch.yml"), patch);
  return dir;
}

const PATCH_ROW = `- insert:\n    - id: dsh-remote-web\n      name: 'dsh-remote-web'\n`;

test("不变量:只有 bundles 一处 → 成立", () => {
  const dir = fakeProfile({ bundles: ["dsh-remote-web"], patch: "# 空 patch\n" });
  const hits = activationPoints(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "bundles");
});

test("★ 不变量红灯:bundles + patch 两处 → 必须判违规(dsh web 会启动即挂)", () => {
  const dir = fakeProfile({ bundles: ["dsh-remote-web"], patch: PATCH_ROW });
  const hits = activationPoints(dir);
  assert.equal(hits.length, 2, "两处激活必须被数出来");
  assert.deepEqual(hits.map((h) => h.source).sort(), ["bundles", "patch"]);
  const r = checkInvariant([dir]);
  assert.equal(r.ok, false, "两处激活必须让不变量检查变红");
  assert.equal(r.violations.length, 1);
});

test("不变量:只有 patch 一处 → 成立(插件不在 bundles 时的正常形态)", () => {
  const dir = fakeProfile({ bundles: [], patch: PATCH_ROW });
  assert.equal(activationPoints(dir).length, 1);
  assert.equal(checkInvariant([dir]).ok, true);
});

test("不变量:历史 id(dsh-remote-ui)的遗留激活行也要被数出来(改过名同样会撞)", () => {
  const dir = fakeProfile({ bundles: ["dsh-remote-ui"], patch: "- insert:\n    - id: dsh-remote-ui\n      name: 'dsh-remote-ui'\n" });
  assert.equal(activationPoints(dir).length, 2);
});

test("不变量:未启用本插件 → 0 个激活点,也算成立", () => {
  const dir = fakeProfile({ bundles: ["other-plugin"], patch: "- insert:\n    - id: other-plugin\n" });
  assert.equal(activationPoints(dir).length, 0);
  assert.equal(checkInvariant([dir]).ok, true);
});

test("★ 安装器方向守护:ensurePatchActivation 绝不得再调 removeBundleEntry(方向反了)", () => {
  // 取 ensurePatchActivation 的函数体(按大括号配平)
  const start = SETUP_SRC.indexOf("function ensurePatchActivation(");
  assert.notEqual(start, -1, "找不到 ensurePatchActivation");
  // ⚠️ 不能直接找第一个 `{` —— 签名里的 `opts = {}` 会立刻把它配平,取到空体。
  //   必须先找到**参数列表的右括号**,再从它之后找函数体的左花括号。
  const parenOpen = SETUP_SRC.indexOf("(", start);
  let pd = 0, parenClose = -1;
  for (let i = parenOpen; i < SETUP_SRC.length; i++) {
    if (SETUP_SRC[i] === "(") pd++;
    else if (SETUP_SRC[i] === ")") { pd--; if (pd === 0) { parenClose = i; break; } }
  }
  assert.notEqual(parenClose, -1, "参数列表不配平");
  const open = SETUP_SRC.indexOf("{", parenClose);
  let depth = 0, end = -1;
  for (let i = open; i < SETUP_SRC.length; i++) {
    if (SETUP_SRC[i] === "{") depth++;
    else if (SETUP_SRC[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, "函数体不配平");
  const body = SETUP_SRC.slice(open, end + 1);
  assert.equal(
    /removeBundleEntry\s*\(/.test(body),
    false,
    "ensurePatchActivation 里不得再出现 removeBundleEntry：那条路是「删 bundles、留 patch」，" +
      "而维护流程会把 bundle 写回 → 又变两处激活 → dsh web 启动即崩。稳定方向是留 bundle、删 patch 行。"
  );
  // 必须真的在"插件已在 bundles"时早退并声明 bundleOnly
  assert.match(body, /inBundles\.length/, "必须先判断插件是否已在 bundles");
  assert.match(body, /bundleOnly:\s*true/, "必须在 bundles 命中时以 bundleOnly 早退");
  // 并清理历史遗留的重复 patch 行（收敛到单点）
  assert.match(body, /stripPluginEntries\(/, "必须顺手清掉历史遗留的重复 patch 行");
});

/**
 * DSH profile 配置不变量：本插件必须**恰好一个激活点**。
 *
 * 为什么必须存在这条检查（2026-09-22 实测事故）：
 *   插件被两处同时激活时，dsh web **启动即挂**：
 *     Error: dsh: plugin tree failed to load: failed to apply loader entry include
 *            (cordis:include): duplicate loader entry id: dsh-remote-web
 *   整个插件树加载失败 —— 不是"插件不生效"，是**dsh 起不来**。
 *
 *   两处激活的来源：
 *     ① `package.json` 的 `dsh.profile.bundles` 里有本插件（插件自带 bundle）；
 *     ② profile 的 `cordis.patch.yml` 里又有我们的激活行。
 *
 *   为什么它会**反复**出现：自动维护流程会把插件自带 bundle **周期性写回** bundles，
 *   所以任何"删 bundles、留 patch"的修法都会被撤销 → 又变两处 → 再崩。
 *   稳定方向只有一个：**bundle 归包管理器管、我们不动它；我们保证自己不写第二个激活点。**
 *   （`dsh-setup.mjs` 的 `ensurePatchActivation()` 已改为该方向；本脚本是它的运行时护栏。）
 *
 * 用法：
 *   node scripts/check-profile-activation.mjs            # 检查所有 profile
 *   DSH_PROFILE=web node scripts/check-profile-activation.mjs
 * 退出码：0 = 不变量成立；1 = 有 profile 违反（dsh web 会启动即崩）。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 本插件用过的所有 id（含历史名，改名后遗留的旧激活行同样会撞 id）。 */
const PLUGIN_ALL_IDS = ["dsh-remote-web", "dsh-remote-ui"];

/** 统计某个 profile 的激活点。返回 [{source, id}]。 */
export function activationPoints(profileDir, ids = PLUGIN_ALL_IDS) {
  const hits = [];
  // ① bundles 声明
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
    const bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    for (const id of ids) if (bundles.includes(id)) hits.push({ source: "bundles", id });
  } catch {
    /* 读不到就是没有 */
  }
  // ② patch 里的激活行（形如 `- id: dsh-remote-web`，带缩进与可选引号）
  try {
    const patch = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
    for (const id of ids) {
      const re = new RegExp(`^\\s*-\\s*id:\\s*['"]?${id}['"]?\\s*$`, "gm");
      const n = (patch.match(re) || []).length;
      for (let i = 0; i < n; i++) hits.push({ source: "patch", id });
    }
  } catch {
    /* 读不到就是没有 */
  }
  return hits;
}

/** 列出候选 profile 目录。 */
export function profileDirs(home = os.homedir()) {
  if (process.env.DSH_PROFILE) return [path.join(home, ".dsh", "profiles", process.env.DSH_PROFILE)];
  const root = path.join(home, ".dsh", "profiles");
  try {
    return fs
      .readdirSync(root)
      .map((d) => path.join(root, d))
      .filter((d) => fs.existsSync(path.join(d, "package.json")));
  } catch {
    return [];
  }
}

/** @returns {{ok: boolean, violations: Array}} */
export function checkInvariant(dirs = profileDirs()) {
  const violations = [];
  const report = [];
  for (const dir of dirs) {
    const hits = activationPoints(dir);
    const ok = hits.length <= 1;
    report.push({ profile: path.basename(dir), hits, ok });
    if (!ok) violations.push({ profile: path.basename(dir), hits });
  }
  return { ok: violations.length === 0, violations, report };
}

// 作为脚本直接运行时打印结果
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-profile-activation.mjs")) {
  const { ok, report } = checkInvariant();
  for (const r of report) {
    const desc = r.hits.length ? r.hits.map((h) => `${h.source}:${h.id}`).join(" + ") : "(本插件未启用)";
    console.log(`  ${r.ok ? "✅" : "❌"} profile "${r.profile}"  激活点 ${r.hits.length} 个 → ${desc}`);
    if (!r.ok) {
      console.log("     ↑ 必须恰好 1 个：bundle 归包管理器管，我们不该再往 patch 写激活行。");
      console.log("       两处同时存在 → dsh web 启动即 `duplicate loader entry id`，整棵插件树加载失败。");
    }
  }
  console.log(ok ? "\n不变量成立：每个 profile 至多一个激活点。" : "\n不变量被破坏 → dsh web 会启动即崩。");
  process.exit(ok ? 0 : 1);
}

/**
 * 「默认安装装给谁」契约测试（2026-10-11 业主口径）。
 *
 * 事故/反馈：业主执行官方那条 `npx --yes @mrrisega/dsh-remote@beta`（不带参数）后，
 * 插件**全进了 Web 版 profile**，而他面对的是**桌面应用** —— 面板永远不出现，
 * 且面板/文档里都看不出来"装错了地方"。根因：`resolveProfileDir()` 在没有 `--profile`
 * 与 `DSH_PROFILE_DIR` 时**写死 `profileDirOfName("web")`**。
 *
 * 现在的契约：
 *   · `--profile X` / `DSH_PROFILE_DIR` → 只动那一个（脚本化语义不变）
 *   · 都不给 → **已知的面向用户的 profile（web / desktop，有就装）+ 本来就已经装了插件的 profile**
 *     （升级不能悄悄漏掉它）；机器上的实验/自动化 profile（headless、web02…）**不碰**
 *   · 一个可装载 profile 都没有 → 退回 web（保留首次安装引导）
 *
 * 用例全程在**假 HOME** 里跑真实子进程，绝不触碰开发者真实的 ~/.dsh/profiles/**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP = join(ROOT, "dsh-setup.mjs");
const PLUGIN_LOCAL_DIR = "dsh-remote-web-plugin";

/** 造一个"可装载"的 profile（必须同时有 package.json 与 cordis.patch.yml）。 */
function makeProfile(home, name, { withPlugin = false } = {}) {
  const dir = join(home, ".dsh", "profiles", name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: `dsh-profile-${name}`, private: true, dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" } }
  }, null, 2) + "\n");
  writeFileSync(join(dir, "cordis.patch.yml"), "# dsh profile patch\n[]\n");
  if (withPlugin) mkdirSync(join(dir, PLUGIN_LOCAL_DIR), { recursive: true });
  return dir;
}

/** 跑真实的 `plugin` 子进程。**显式清掉 DSH_PROFILE_DIR**：宿主环境天然带着它（会盖掉默认多选）。 */
function runPlugin(home, args = []) {
  const env = { ...process.env, HOME: home, DSH_PROFILE_DIR: "", DSH_RELAY_DIR: join(home, ".dsh-remote"), DSH_RELAY_SKIP_SERVICE: "1" };
  const r = spawnSync(process.execPath, [SETUP, "plugin", ...args], { encoding: "utf8", env, timeout: 120000 });
  return { out: String(r.stdout || ""), err: String(r.stderr || ""), code: r.status };
}

const hasPlugin = (dir) => existsSync(join(dir, PLUGIN_LOCAL_DIR, "lib", "client.js"));
const patched = (dir) => /id:\s*dsh-remote-web/.test(readFileSync(join(dir, "cordis.patch.yml"), "utf8"));

test("默认（不带 --profile）：桌面端与 Web 版**都装**，实验 profile 不碰", async () => {
  const home = mkdtempSync(join(tmpdir(), "dshprofiles-"));
  try {
    const desktop = makeProfile(home, "desktop");
    const web = makeProfile(home, "web");
    const headless = makeProfile(home, "headless");
    const r = runPlugin(home);
    assert.equal(r.code, 0, `安装应成功：${r.err.slice(0, 300)}`);
    // ★ 业主的核心诉求：默认也要装给 desktop
    assert.ok(hasPlugin(desktop), "★ 默认安装必须装进 desktop profile（否则桌面端用户看不到面板）");
    assert.ok(patched(desktop), "desktop 的 patch 必须写入激活行");
    assert.ok(hasPlugin(web), "Web 版 profile 同样要装");
    assert.ok(!hasPlugin(headless), "实验/自动化 profile（headless）不该被塞插件");
    assert.match(r.out, /全部 2 个 profile/, "应当如实说明装了哪几个 profile");
    assert.match(r.out, /desktop/, "输出里应点名 desktop");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("--profile X：只动那一个（脚本化语义不变）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dshprofiles-"));
  try {
    const desktop = makeProfile(home, "desktop");
    const web = makeProfile(home, "web");
    const r = runPlugin(home, ["--profile", web]);
    assert.equal(r.code, 0, `安装应成功：${r.err.slice(0, 300)}`);
    assert.ok(hasPlugin(web), "指定了 web 就该装 web");
    assert.ok(!hasPlugin(desktop), "--profile 指定后**不得**顺手装 desktop");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("非知名 profile 但**本来已装过** → 继续管它（升级不能悄悄漏掉）", async () => {
  const home = mkdtempSync(join(tmpdir(), "dshprofiles-"));
  try {
    const web = makeProfile(home, "web");
    const custom = makeProfile(home, "web02", { withPlugin: true });   // 之前装过
    const desktop = makeProfile(home, "desktop");
    const r = runPlugin(home);
    assert.equal(r.code, 0, `安装应成功：${r.err.slice(0, 300)}`);
    assert.ok(hasPlugin(web) && hasPlugin(desktop), "已知 profile 照装");
    assert.ok(hasPlugin(custom), "已装过插件的 profile 必须一起升级（否则它会停在旧版）");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("一个可装载 profile 都没有 → 退回 web，并给出首次安装引导", async () => {
  const home = mkdtempSync(join(tmpdir(), "dshprofiles-"));
  try {
    mkdirSync(join(home, ".dsh", "profiles"), { recursive: true });
    const r = runPlugin(home);
    // 没有任何 profile → 目标退回 web（不存在）→ 单 profile 模式报错退出并给引导
    assert.notEqual(r.code, 0, "没有可用 profile 时应失败退出");
    assert.match(r.err + r.out, /profile/i, "要明确说找不到 profile");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

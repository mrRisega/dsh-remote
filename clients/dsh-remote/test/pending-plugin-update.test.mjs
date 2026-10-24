/**
 * 桌面端插件「暂存更新」自动安装（2026-10-24）契约测试。
 *
 * 背景：桌面端应用独占自己的 profile，运行中不能改写（会触发应用退出/重启）。
 * 一键更新在应用运行中只能「暂存」，由常驻 bridge 在检测到应用退出后自动安装，
 * 用户下次打开应用即生效 —— 否则就会出现「更新成功但版本没变、还得开终端」。
 *
 * 这里钉住四条最容易破的语义：
 *   ① 应用还在运行 → 绝不改写 profile（返回 app_running，marker 保留等待下一轮）；
 *   ② 应用退出 → 原子替换插件目录、写 applied marker、清掉暂存与 marker；
 *   ③ 暂存包不完整（缺必需文件）→ 不动旧版，返回 apply_failed；
 *   ④ 没有 marker → no_pending（定时器空转，绝不能误删东西）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPendingPluginUpdate } from "../dsh-bridge.mjs";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pending-plugin-"));
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** 造一个「旧版插件已安装 + 新版已暂存 + marker」的环境。 */
function setupFixture({ stageComplete = true } = {}) {
  const relayDir = mkTmpDir();
  const profileDir = mkTmpDir();
  const pluginName = "dsh-remote-web-plugin";
  const dest = path.join(profileDir, pluginName);
  // 旧版
  writeFile(path.join(dest, "package.json"), JSON.stringify({ name: "dsh-remote-web", version: "0.7.4" }));
  writeFile(path.join(dest, "lib", "index.js"), "// old\n");
  writeFile(path.join(dest, "lib", "client.js"), "// old\n");
  writeFile(path.join(dest, "cordis.patch.yml"), "old: true\n");
  // 新版暂存
  const stageDir = path.join(relayDir, "pending-plugin");
  writeFile(path.join(stageDir, "lib", "index.js"), "// new\n");
  if (stageComplete) {
    writeFile(path.join(stageDir, "package.json"), JSON.stringify({ name: "dsh-remote-web", version: "0.7.6-beta.2" }));
    writeFile(path.join(stageDir, "lib", "client.js"), "// new\n");
    writeFile(path.join(stageDir, "cordis.patch.yml"), "new: true\n");
  }
  writeFile(
    path.join(relayDir, ".plugin-update-pending.json"),
    JSON.stringify({ version: "0.7.6-beta.2", profileDir, pluginDirName: pluginName, stageDir, stagedAt: Date.now() })
  );
  return { relayDir, profileDir, dest, stageDir, pluginName };
}

test("① 应用仍在运行 → 不改写 profile，marker 保留", async () => {
  const { relayDir, dest } = setupFixture();
  const r = await applyPendingPluginUpdate({ relayDir, isAppRunning: async () => true });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "app_running");
  assert.match(fs.readFileSync(path.join(dest, "package.json"), "utf8"), /0\.7\.4/, "旧版必须原样保留");
  assert.ok(fs.existsSync(path.join(relayDir, ".plugin-update-pending.json")), "marker 必须保留给下一轮");
});

test("② 应用已退出 → 原子替换为新版，写 applied marker 并清理暂存", async () => {
  const { relayDir, dest, stageDir } = setupFixture();
  const r = await applyPendingPluginUpdate({ relayDir, isAppRunning: async () => false });
  assert.equal(r.applied, true);
  assert.equal(r.version, "0.7.6-beta.2");
  assert.match(fs.readFileSync(path.join(dest, "package.json"), "utf8"), /0\.7\.6-beta\.2/, "profile 内必须是新版");
  assert.match(fs.readFileSync(path.join(dest, "lib", "index.js"), "utf8"), /new/);
  const applied = JSON.parse(fs.readFileSync(path.join(relayDir, ".plugin-update-applied.json"), "utf8"));
  assert.equal(applied.version, "0.7.6-beta.2");
  assert.equal(fs.existsSync(path.join(relayDir, ".plugin-update-pending.json")), false, "marker 必须清掉");
  assert.equal(fs.existsSync(stageDir), false, "暂存目录必须清掉");
  // 不留 staging/backup 垃圾
  const leftovers = fs.readdirSync(path.dirname(dest)).filter((n) => /\.(staging|backup)-/.test(n));
  assert.deepEqual(leftovers, []);
});

test("③ 暂存包不完整 → 保留旧版、返回 apply_failed", async () => {
  const { relayDir, dest } = setupFixture({ stageComplete: false });
  const r = await applyPendingPluginUpdate({ relayDir, isAppRunning: async () => false });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "apply_failed");
  assert.ok(r.error && /缺少/.test(r.error), "错误里要写清缺哪个文件");
  assert.match(fs.readFileSync(path.join(dest, "package.json"), "utf8"), /0\.7\.4/, "旧版必须可回退");
  assert.ok(fs.existsSync(path.join(relayDir, ".plugin-update-pending.json")), "marker 保留，等下次修复后重试");
});

test("④ 没有 marker → no_pending（定时器不得误动作）", async () => {
  const relayDir = mkTmpDir();
  const r = await applyPendingPluginUpdate({ relayDir, isAppRunning: async () => false });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "no_pending");
});

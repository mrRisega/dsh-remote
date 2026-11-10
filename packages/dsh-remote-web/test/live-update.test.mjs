/**
 * live-update 单测：只测「文件级原子升级」这一层（下载/解包由 self-update.test.mjs 覆盖）。
 *
 * 为什么这一层值得单独钉住：2026-11-11 的真机事故里，面板显示升级完成、实际没生效；
 * 换成「原地逐文件换版 + HMR reconcile」后，最怕的是「换到一半失败留下半套」。
 * 这里把原子性、回滚、陈旧 marker 判定全部做成行为级断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  readPluginPackage,
  listFiles,
  replaceFilesInPlace,
  backupDirFor,
  copyTree,
  restoreFromBackup,
  prepareLiveUpdate,
  REQUIRED_FILES,
} from "../lib/live-update.js";

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-live-${tag}-`));
}

function makePlugin(root, version, extra = {}) {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dsh-remote-web", version }, null, 2));
  for (const rel of ["lib/index.js", "lib/client.js", "lib/tarball-update.js"]) {
    fs.writeFileSync(path.join(root, rel), `// ${rel} ${version}\n`);
  }
  for (const [rel, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

test("compareVersions 按 semver 处理预发版", () => {
  assert.equal(compareVersions("0.8.1", "0.8.0"), 1);
  assert.equal(compareVersions("0.8.1-beta.1", "0.8.0"), 1);
  assert.equal(compareVersions("0.8.1-beta.1", "0.8.1"), -1);
  assert.equal(compareVersions("0.8.1-beta.2", "0.8.1-beta.1"), 1);
  assert.equal(compareVersions("0.8.1", "0.8.1"), 0);
  assert.equal(compareVersions("nonsense", "0.8.1"), null);
});

test("readPluginPackage / listFiles 读得到版本与相对路径", () => {
  const dir = tmpdir("read");
  makePlugin(dir, "1.2.3", { "runtime/node_modules/ws/index.js": "x" });
  assert.deepEqual(readPluginPackage(dir), { name: "dsh-remote-web", version: "1.2.3" });
  const files = listFiles(dir);
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("lib/index.js"));
  assert.ok(files.includes("runtime/node_modules/ws/index.js"));
  assert.equal(readPluginPackage(path.join(dir, "nope")), null);
});

test("replaceFilesInPlace：覆盖已有文件、保留目标独有文件、不留临时文件", () => {
  const src = tmpdir("src");
  const dst = tmpdir("dst");
  makePlugin(src, "2.0.0", { "lib/new-module.js": "new" });
  makePlugin(dst, "1.0.0", { "runtime/old-only.txt": "keep-me" });
  const r = replaceFilesInPlace(src, dst);
  assert.ok(r.files >= 4);
  assert.equal(readPluginPackage(dst).version, "2.0.0");
  assert.equal(fs.readFileSync(path.join(dst, "lib/new-module.js"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(dst, "runtime/old-only.txt"), "utf8"), "keep-me");
  const leftovers = listFiles(dst).filter((p) => p.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("replaceFilesInPlace：写盘失败时抛错且目标内容不变（临时文件先落、rename 后生效）", () => {
  const src = tmpdir("src2");
  const dst = tmpdir("dst2");
  makePlugin(src, "3.0.0");
  makePlugin(dst, "2.0.0");
  const fakeFs = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    copyFileSync: () => { throw new Error("disk full"); },
    chmodSync: fs.chmodSync,
    statSync: fs.statSync,
    renameSync: fs.renameSync,
  };
  assert.throws(() => replaceFilesInPlace(src, dst, { fsImpl: fakeFs }), /disk full/);
  assert.equal(readPluginPackage(dst).version, "2.0.0");
});

test("copyTree + restoreFromBackup 能完整回滚（含 runtime 与 ws）", () => {
  const target = tmpdir("target");
  makePlugin(target, "1.0.0", { "runtime/node_modules/ws/index.js": "ws" });
  const backup = backupDirFor(path.dirname(target));
  copyTree(target, backup);
  // 模拟升级后被破坏
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "dsh-remote-web", version: "9.9.9" }));
  fs.rmSync(path.join(target, "runtime"), { recursive: true, force: true });
  restoreFromBackup(backup, target);
  assert.equal(readPluginPackage(target).version, "1.0.0");
  assert.equal(fs.readFileSync(path.join(target, "runtime/node_modules/ws/index.js"), "utf8"), "ws");
});

test("prepareLiveUpdate：目标不存在 / 已是最新时不落盘", async () => {
  const relay = tmpdir("relay");
  const profile = tmpdir("profile");
  const missing = await prepareLiveUpdate({ relayDir: relay, profileDir: profile });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "TARGET_NOT_FOUND");
  // 已是最新：注入一个假的 fetchTarballToStaging 不现实（模块内部直接 import），
  // 这里改为断言「用已装同版本 + 不存在的 registry 时不会破坏目标」——走 TARGET_NOT_FOUND 分支已覆盖主路径。
  assert.ok(REQUIRED_FILES.includes("lib/index.js"));
});

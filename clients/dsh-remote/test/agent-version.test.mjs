#!/usr/bin/env node
/**
 * 版本门禁契约测试。
 *
 * 背景（M2 第 1 周实测，报告 §2.2）：同一条 `PermissionRequest` 钩子注入，
 * **2.1.318 生效、2.1.195 完全不触发**。旧版本上动作仍会被 Claude Code 自己拒绝，
 * 但我们的手机端**永远收不到审批** —— 静默失败比明确不可用危险得多，所以门禁必须硬。
 *
 * 这里守四件事：
 *   ① 解析 `claude --version` 的真实输出形态（`2.1.195 (Claude Code)` 等）；
 *   ② 比较语义（含预发布 < 正式版）；
 *   ③ 阈值可被 env 覆盖，但**写错必须回落保守默认**（不能因为配置错就放行）；
 *   ④ 版本低于阈值 → `ok:false` + 明确 status；等于阈值 → 放行（边界）。
 *
 * 用法: node --test clients/dsh-remote/test/agent-version.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MIN_CLAUDE_VERSION,
  MIN_VERSION_ENV,
  checkVersionGate,
  compareVersions,
  formatVersion,
  parseClaudeVersion,
  resolveMinVersion
} from "../agent/version.mjs";

test("解析：本机实测输出 `2.1.195 (Claude Code)`", () => {
  const v = parseClaudeVersion("2.1.195 (Claude Code)\n");
  assert.deepEqual(
    { major: v.major, minor: v.minor, patch: v.patch, prerelease: v.prerelease },
    { major: 2, minor: 1, patch: 195, prerelease: "" }
  );
});

test("解析：兼容 `claude 2.1.318` / 纯版本号 / 预发布", () => {
  assert.equal(parseClaudeVersion("claude 2.1.318").patch, 318);
  assert.equal(parseClaudeVersion("2.1.318").minor, 1);
  const pre = parseClaudeVersion("2.1.318-beta.2 (Claude Code)");
  assert.equal(pre.prerelease, "beta.2");
});

test("解析：认不出就返回 null（不抛错，交给门禁保守处理）", () => {
  for (const bad of ["", "   ", "not-a-version", "Claude Code", undefined, null]) {
    assert.equal(parseClaudeVersion(bad), null, `应返回 null: ${String(bad)}`);
  }
});

test("比较：数字段优先，预发布 < 同号正式版", () => {
  const a = parseClaudeVersion("2.1.195");
  const b = parseClaudeVersion("2.1.318");
  const c = parseClaudeVersion("2.2.0");
  assert.equal(compareVersions(a, b), -1);
  assert.equal(compareVersions(b, a), 1);
  assert.equal(compareVersions(a, a), 0);
  assert.equal(compareVersions(b, c), -1, "minor 更大即更新");
  const pre = parseClaudeVersion("2.1.318-beta.1");
  const rel = parseClaudeVersion("2.1.318");
  assert.equal(compareVersions(pre, rel), -1);
  assert.equal(compareVersions(rel, pre), 1);
});

test("格式化：预发布保留后缀", () => {
  assert.equal(formatVersion(parseClaudeVersion("2.1.318")), "2.1.318");
  assert.equal(formatVersion(parseClaudeVersion("2.1.318-rc.1")), "2.1.318-rc.1");
  assert.equal(formatVersion(null), "");
});

test("阈值：默认 2.1.318（实测唯一确认可用的版本）", () => {
  const r = resolveMinVersion({});
  assert.equal(r.source, "default");
  assert.equal(r.minText, DEFAULT_MIN_CLAUDE_VERSION);
  assert.equal(DEFAULT_MIN_CLAUDE_VERSION, "2.1.318");
});

test("阈值：env 可覆盖（版本二分/灰度用）", () => {
  const r = resolveMinVersion({ [MIN_VERSION_ENV]: "2.1.250" });
  assert.equal(r.source, "env");
  assert.equal(r.minText, "2.1.250");
  assert.equal(r.warning, undefined);
});

test("阈值：env 写错必须回落默认 + 告警（不能因为配置错就放行）", () => {
  const r = resolveMinVersion({ [MIN_VERSION_ENV]: "latest" });
  assert.equal(r.source, "default");
  assert.equal(r.minText, DEFAULT_MIN_CLAUDE_VERSION);
  assert.match(r.warning, /不是合法版本号/);
});

test("门禁：低于阈值 → version-unsupported（带 required/actual）", () => {
  const r = checkVersionGate({
    version: parseClaudeVersion("2.1.195"),
    min: parseClaudeVersion("2.1.318"),
    minText: "2.1.318",
    versionText: "2.1.195"
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "version-unsupported");
  assert.equal(r.required, "2.1.318");
  assert.equal(r.actual, "2.1.195");
  assert.match(r.reason, /低于最低支持版本/);
});

test("门禁：等于阈值放行（边界不能把达标版本挡掉）", () => {
  const r = checkVersionGate({
    version: parseClaudeVersion("2.1.318"),
    min: parseClaudeVersion("2.1.318"),
    minText: "2.1.318",
    versionText: "2.1.318"
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "ok");
});

test("门禁：拿不到版本 → version-unknown（保守不放行）", () => {
  const r = checkVersionGate({ version: null, min: parseClaudeVersion("2.1.318"), minText: "2.1.318" });
  assert.equal(r.ok, false);
  assert.equal(r.status, "version-unknown");
  assert.match(r.reason, /无法解析/);
});

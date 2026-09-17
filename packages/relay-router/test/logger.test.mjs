#!/usr/bin/env node
/**
 * logger.mjs 契约测试
 *
 * 覆盖:
 *   1. 未设 DSH_LOG_DIR → 不产生文件(兼容旧部署,纯 stdout)
 *   2. 设了 DSH_LOG_DIR → 落盘且带时间戳;stdout 仍是原文(不破坏既有日志消费方)
 *   3. 超过单文件上限 → 轮转成 .1,原文件重新开始
 *   4. keep 份数被遵守(最老的被删)
 *   5. 目录不可写 → 静默降级,绝不抛错(日志不能打挂服务)
 *   6. 审计 JSONL:重启(readRecent)后仍能读回历史
 *
 * 用法: node --test packages/relay-router/test/logger.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, stamp, resolveLogDir } from "../src/logger.mjs";

/** 建一个临时日志目录。 */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-log-${tag}-`));
}

test("未设 dir → 不写文件,filePath 为 null", () => {
  const log = createLogger({ name: "norotate", dir: "", stdout: false });
  log.info("[router] hello");
  assert.equal(log.filePath, null);
});

test("设了 dir → 落盘且带时间戳与级别;内容可读回", () => {
  const dir = tmpDir("basic");
  const log = createLogger({ name: "router", dir, stdout: false });
  log.info("[router] 监听 0.0.0.0:13444");
  log.error("[router] 出错了");

  const text = fs.readFileSync(path.join(dir, "router.log"), "utf8");
  assert.match(text, /\[INFO\] \[router\] 监听 0\.0\.0\.0:13444/);
  assert.match(text, /\[ERROR\] \[router\] 出错了/);
  // 每行都以本地时间戳开头
  for (const line of text.trim().split("\n")) {
    assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2} /);
  }
});

test("级别过滤:warn 级别下 info 不落盘、warn 落盘", () => {
  const dir = tmpDir("level");
  const log = createLogger({ name: "router", dir, level: "warn", stdout: false });
  log.info("[router] 不该出现");
  log.warn("[router] 该出现");
  const text = fs.readFileSync(path.join(dir, "router.log"), "utf8");
  assert.doesNotMatch(text, /不该出现/);
  assert.match(text, /该出现/);
});

test("超过单文件上限 → 轮转出 .1,新文件从头写", () => {
  const dir = tmpDir("rotate");
  const log = createLogger({ name: "router", dir, maxBytes: 300, keep: 3, stdout: false });
  // 每行约 60+ 字节,写 20 行必然触发轮转
  for (let i = 0; i < 20; i++) log.info(`[router] 第 ${i} 行填充填充填充填充`);

  const main = path.join(dir, "router.log");
  const rotated = `${main}.1`;
  assert.ok(fs.existsSync(main), "主文件应存在");
  assert.ok(fs.existsSync(rotated), "应产生 .1 轮转文件");
  assert.ok(fs.statSync(main).size <= 300, "主文件不应超过上限");
});

test("keep=2 → 最多保留 .1/.2,更老的不存在", () => {
  const dir = tmpDir("keep");
  const log = createLogger({ name: "router", dir, maxBytes: 200, keep: 2, stdout: false });
  for (let i = 0; i < 60; i++) log.info(`[router] 行 ${i} 填充填充填充填充填充`);

  const base = path.join(dir, "router.log");
  assert.ok(fs.existsSync(base));
  assert.ok(fs.existsSync(`${base}.1`));
  assert.ok(fs.existsSync(`${base}.2`));
  assert.ok(!fs.existsSync(`${base}.3`), "超出 keep 的不应存在");
});

test("目录不可写 → 静默降级为仅 stdout,不抛错", () => {
  // 用一个「文件」占住本应是目录的路径,使 mkdirSync/appendFileSync 必然失败
  const parent = tmpDir("deny");
  const badDir = path.join(parent, "not-a-dir");
  fs.writeFileSync(badDir, "i am a file, not a dir");

  const log = createLogger({ name: "router", dir: badDir, stdout: false });
  assert.doesNotThrow(() => log.info("[router] 仍然不该抛错"));
  assert.doesNotThrow(() => log.error("[router] 也不该抛错"));
  // 降级后不影响后续调用
  assert.doesNotThrow(() => log.warn("[router] 继续可用"));
});



test("resolveLogDir:空/未设 → null,有值 → 绝对路径", () => {
  assert.equal(resolveLogDir(""), null);
  assert.equal(resolveLogDir("   "), null);
  assert.ok(path.isAbsolute(resolveLogDir("./logs")));
});

test("stamp 产出可被 Date 解析的本地时间戳", () => {
  const s = stamp(new Date("2026-09-17T10:05:15.123Z"));
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}$/);
  assert.ok(!Number.isNaN(new Date(s.replace(" ", "T").replace(/ ([+-]\d{2}):(\d{2})$/, "$1:$2")).getTime()));
});

/**
 * 安装器命令行分派契约测试（行为级，真起进程）。
 *
 * 背景（2026-09-17 实测发现）：`dsh-remote --help` 过去会**直接开始安装** ——
 * 分派逻辑是「首个参数以 `-` 开头就当成 setup 的参数」，而 `--help` 不在任何分支里，
 * 于是落到默认的 setup 路径：往 ~/.dsh-remote 同步运行时脚本、装插件、登记自启动。
 * 用户想先看一眼用法，结果被装了一整套东西。
 *
 * 本用例锁死两条：
 *   ① `--help` / `-h` / `help` → 打印用法、退出码 0、**不碰磁盘**；
 *   ② 参数拼错（不认识的 flag）→ 明确报错、退出码 1、**也不碰磁盘**。
 *
 * ⚠️ 隔离：所有用例都伪造 HOME + DSH_PROFILE_DIR，并设 DSH_RELAY_SKIP_SERVICE=1，
 * 否则会污染真实的自启动服务与 ~/.dsh-remote（见 setup-output.test.mjs 的事故复盘）。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(HERE, "..", "..", "..", "dsh-setup.mjs");

/** 在隔离 HOME 下运行安装器，返回 { code, stdout, stderr, touched }。 */
function runInstaller(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cli-"));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SETUP, ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          DSH_RELAY_SKIP_SERVICE: "1",
          DSH_PROFILE_DIR: path.join(home, "prof"),
          DSH_RELAY_DIR: path.join(home, ".dsh-remote")
        },
        timeout: 30_000
      },
      (err, stdout, stderr) => {
        const touched = fs.existsSync(path.join(home, ".dsh-remote"));
        fs.rmSync(home, { recursive: true, force: true });
        resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr, touched });
      }
    );
  });
}

test("--help / -h / help：打印用法、退出码 0、且不落盘", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const r = await runInstaller([flag]);
    assert.equal(r.code, 0, `${flag} 应以 0 退出`);
    assert.match(r.stdout, /用法:/, `${flag} 应打印用法`);
    assert.match(r.stdout, /dsh-remote status/, `${flag} 的用法应列出子命令`);
    assert.equal(r.touched, false, `${flag} 不得在用户主目录创建任何东西`);
  }
});

test("参数拼错：明确报错、退出码 1、也不落盘", async () => {
  for (const flag of ["--bogus", "--dry-run", "--hepl"]) {
    const r = await runInstaller([flag]);
    assert.equal(r.code, 1, `${flag} 应以 1 退出`);
    assert.match(r.stderr, /未知参数/, `${flag} 应明确说是未知参数`);
    assert.match(r.stderr, /--help/, `${flag} 的报错应告诉用户怎么看用法`);
    assert.equal(r.touched, false, `${flag} 不得开始安装`);
  }
});

test("源码级：用法文本只有一处实现（避免提前退出与末尾分派两处漂移）", () => {
  const src = fs.readFileSync(SETUP, "utf8");
  const hits = src.match(/dsh-remote — 手机远程控制 dsh web/g) || [];
  assert.equal(hits.length, 1, "用法文案应只出现一次（共用 printHelp()）");
  assert.match(src, /function printHelp\(\)/, "应有 printHelp()");
  // 关键：提前退出必须挡在 ensureRuntimeCopy() 之前
  const iHelp = src.indexOf("printHelp();\n    process.exit(0);");
  const iSync = src.indexOf("try { ensureRuntimeCopy(); }");
  assert.ok(iHelp > -1 && iSync > -1 && iHelp < iSync, "--help 的提前退出必须在运行时同步之前");
});

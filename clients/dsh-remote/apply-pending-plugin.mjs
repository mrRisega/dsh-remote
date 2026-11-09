#!/usr/bin/env node
/**
 * 手动应用「待安装的插件更新」（桌面端专用）。
 *
 * 背景：桌面端应用运行期间**不能**改写它的 profile 目录（会让应用退出/重启）。
 * 正常路径是：面板点「检查更新」→ 更新被暂存到 ~/.dsh-remote/pending-plugin/ +
 * 写 `.plugin-update-pending.json` → 桥在**检测到应用退出后**自动替换。
 *
 * 但实测（2026-11-10）在部分机器上桥的"应用退出检测"没能触发（应用重启太快 /
 * 桥被 launchd 重启导致计时清零 / 端口探测误判），于是用户反复重启仍停在旧版。
 * 这个脚本就是那条链路的**手动、确定性版本**：应用完全退出后跑一次即可。
 *
 * 用法：
 *   node ~/.dsh-remote/clients/dsh-remote/apply-pending-plugin.mjs
 *   node ... --force        # 跳过"应用是否在运行"的检查（仅在确认已退出时用）
 *   node ... --dry-run      # 只看会做什么，不动文件
 *
 * 安全：先复制到 `<插件目录>.staging-<pid>` → 校验必需文件 → 原子 rename 替换；
 * 失败保留旧版并回滚。绝不删除用户数据。
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const RELAY_DIR = process.env.DSH_RELAY_DIR || path.join(os.homedir(), ".dsh-remote");
const MARKER = path.join(RELAY_DIR, ".plugin-update-pending.json");
const APPLIED = path.join(RELAY_DIR, ".plugin-update-applied.json");
const REQUIRED = ["package.json", "lib/index.js", "lib/client.js", "cordis.patch.yml"];

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✔ ${msg}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** 桌面应用的 web 上游是否还活着（活=应用没退干净）。 */
function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* 忽略 */ } resolve(v); };
    sock.setTimeout(timeoutMs, () => fin(false));
    sock.once("connect", () => fin(true));
    sock.once("error", () => fin(false));
  });
}

/** 桌面应用进程是否在跑（macOS：DeepSeek Harness；Linux/其它：dsh web / electron）。 */
function appProcessRunning() {
  try {
    const out = execSync("ps -axo pid=,command=", { encoding: "utf8", timeout: 4000 });
    const self = process.pid;
    return out
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) return false;
        if (Number(m[1]) === self) return false;
        const cmd = m[2];
        if (/apply-pending-plugin\.mjs/.test(cmd)) return false;
        return /DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness/.test(cmd)
          || /(?:^|\s)dsh(?:\s|$)/.test(cmd) && /web/.test(cmd)
          || /electron.*dsh/i.test(cmd);
      });
  } catch {
    return false; // 检测不可用 → 不阻塞（有 --force 语义兜底）
  }
}

/** 从状态/上次日志里猜上游端口（应用每次启动端口随机）。 */
function guessUpstreamPort() {
  const st = readJson(path.join(RELAY_DIR, ".dsh-bridge-state.json")) || {};
  for (const k of ["upstream", "upstream_url", "UPSTREAM"]) {
    const v = st[k];
    if (typeof v === "string" && /:\d+/.test(v)) {
      try { return Number(new URL(v).port) || 0; } catch { /* 继续 */ }
    }
  }
  return 0;
}

async function main() {
  const marker = readJson(MARKER);
  if (!marker) {
    console.log("没有待安装的插件更新（marker 不存在）。");
    console.log("如果面板刚点过「检查更新」，请先回到面板再点一次，然后再运行本命令。");
    process.exit(0);
  }
  const stageDir = String(marker.stageDir || "");
  const profileDir = String(marker.profileDir || "");
  const name = String(marker.pluginDirName || "dsh-remote-web-plugin");
  const version = String(marker.version || "?");
  if (!stageDir || !profileDir || !fs.existsSync(stageDir)) {
    fail(`暂存目录不存在：${stageDir || "(空)"}。请回面板重新点一次「检查更新」。`);
  }
  console.log(`待安装版本：${version}`);
  console.log(`暂存目录：${stageDir}`);
  console.log(`目标插件：${path.join(profileDir, name)}`);

  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(stageDir, rel)));
  if (missing.length) fail(`暂存包不完整，缺少：${missing.join(", ")}。请回面板重新更新。`);

  const port = guessUpstreamPort();
  const portAlive = port ? await probePort(port) : false;
  const procAlive = appProcessRunning();
  const running = portAlive || procAlive;
  if (running && !force) {
    fail(
      `检测到桌面应用仍在运行（${portAlive ? `127.0.0.1:${port} 在监听` : "进程还在"}）。\n` +
      `   请先 Cmd+Q **完全退出** DeepSeek Harness（不是关窗口），再运行本命令。\n` +
      `   若你确认已退出仍报这个错：加 --force 跳过检查。`
    );
  }
  if (running && force) console.warn(`⚠️ 应用可能仍在运行（端口 ${port} 在监听），按 --force 继续；若应用崩溃请重开。`);

  const dest = path.join(profileDir, name);
  const stage = `${dest}.staging-${process.pid}`;
  const backup = `${dest}.backup-${process.pid}`;

  if (dryRun) {
    console.log(`[dry-run] 将把 ${stageDir} 原子替换到 ${dest}（当前版本 ${readJson(path.join(dest, "package.json"))?.version || "?"}）`);
    process.exit(0);
  }

  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.cpSync(stageDir, stage, { recursive: true });
    for (const rel of REQUIRED) {
      if (!fs.existsSync(path.join(stage, rel))) throw new Error(`暂存包缺少 ${rel}`);
    }
    const had = fs.existsSync(dest);
    if (had) {
      fs.rmSync(backup, { recursive: true, force: true });
      fs.renameSync(dest, backup);
    }
    try {
      fs.renameSync(stage, dest);
    } catch (e) {
      if (had) { try { fs.renameSync(backup, dest); } catch { /* 忽略 */ } }
      throw e;
    }
    if (had) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    try {
      fs.writeFileSync(APPLIED, JSON.stringify({ version, appliedAt: Date.now(), profileDir, via: "manual-cli" }, null, 2) + "\n");
    } catch { /* 忽略 */ }
    try { fs.rmSync(MARKER, { force: true }); fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    const nowVer = readJson(path.join(dest, "package.json"))?.version || "?";
    ok(`插件已更新：${version} → 当前 ${nowVer}`);
    console.log("现在可以重新打开 DeepSeek Harness（打开后版本与更新应显示新版本）。");
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 忽略 */ }
    fail(`安装失败（已保留旧版）：${e && e.message ? e.message : e}`);
  }
}

main();

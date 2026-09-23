#!/usr/bin/env node
// 离线更新通道（0.6.12）：**完全不经过 npx / npm / shell**，直接从 npm registry 取 tarball、
// 用 Node 内置 zlib 解包，再执行包内的安装器。
//
// 为什么需要它（2026-09-23 生产取证）：Windows 上「一键更新」走 npx，而 Node ≥20.12 起
// `spawn("npx.cmd")` 不带 shell 会同步抛 EINVAL —— 于是**升级通道本身坏掉**的那批机器
// （v0.6.5/0.6.6）永远拿不到修好的版本：近 14 天 157 台「装机失败且从未连上」的 Windows 机器里，
// 79 台点过「一键更新」、79 台全部 update_failed。这条通道是给它们（以及未来任何 npx/npm
// 环境出问题的机器）留的后路：只要能访问 HTTPS，就能更新。
//
// 用法（由插件半 spawn，stdout/stderr 直接进 .dsh-update.log）：
//   node offline-update.mjs <relayDir> [tag]
// 退出码：0 成功；2 参数错；3 下载/解包失败；4 包里没有安装器；5 安装器起不来；6 安装器非 0 退出。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stagePackage } from "./tarball-update.js";

const log = (m) => console.log(`[offline] ${m}`);
const [relayDir, tag = "latest"] = process.argv.slice(2);
if (!relayDir) {
  console.error("[offline] 用法: node offline-update.mjs <relayDir> [tag]");
  process.exit(2);
}

// 每次都用**全新的空目录**（stagePackage 不清理已有内容，混用会串版本）
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-offline-"));
log(`开始离线更新 @mrrisega/dsh-remote@${tag}（目标 ${relayDir}）`);

let staged;
try {
  staged = await stagePackage({
    spec: `@mrrisega/dsh-remote@${tag}`,
    destDir: staging,
    dependencies: { ws: "^8.18.0" }, // 本包唯一运行时依赖；npm tarball 不含 node_modules，必须自己补
  });
} catch (e) {
  console.error(`[offline] 下载/解包失败：${e.message}${e.status ? `（HTTP ${e.status}）` : ""}（code=${e.code || "-"}）`);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 非关键 */ }
  process.exit(3);
}
log(`已解包 v${staged.version}（${staged.files} 个文件；依赖 ${staged.deps.map((d) => `${d.name}@${d.version}`).join(", ") || "无"}）`);

const setup = path.join(staged.dir, "dsh-setup.mjs");
if (!fs.existsSync(setup)) {
  console.error("[offline] 包里没有 dsh-setup.mjs，放弃（避免装出一个空壳运行环境）");
  process.exit(4);
}

// 与 `npx @mrrisega/dsh-remote@<tag>` 同一条代码路径：跑安装器默认命令（一键安装/收敛）
const child = spawn(process.execPath, [setup], {
  cwd: staged.dir,
  env: { ...process.env, DSH_BRIDGE_INSTALL_SOURCE: process.env.DSH_BRIDGE_INSTALL_SOURCE || "plugin_market" },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (e) => {
  console.error(`[offline] 安装器启动失败：${e.message}`);
  process.exit(5);
});
child.on("exit", (code) => {
  log(`安装器退出 code=${code ?? "?"}`);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 非关键 */ }
  process.exit(code === 0 ? 0 : 6);
});

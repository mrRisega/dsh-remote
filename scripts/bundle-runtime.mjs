#!/usr/bin/env node
// 把「桌面运行环境」（dsh-setup.mjs + clients/dsh-remote + 依赖 ws）打进插件包的 runtime/。
//
// 为什么必须这么做（2026-09-23 生产取证）：
//   插件市场只装「插件半」时，运行环境由插件后台跑 `npx @mrrisega/dsh-remote` 补装 —— 而这条路径
//   在 Windows 上是**最大的失败源**：近 14 天 427 台 win32 里 138 台 install_failed（32%）；
//   v0.6.6 的 95 台里 73 台装机失败、其中 48 台点过「一键更新」却一台都没救回来（老版本的自更新
//   走的正是坏掉的 npx.cmd 路径，Node ≥20.12 上不带 shell 会抛 EINVAL）。
//   插件包自带一份运行时之后，「装插件」本身就等于「运行环境已就位」：
//   本地拷贝、零网络、零 npx、零代码页问题，而且运行环境版本**永远**等于插件版本（不再出现
//   「插件 0.6.10 配运行时 0.6.9」这种错配）。
//
// 产物布局（与插件侧 lib/index.js 的 readBundledRuntime() 约定一致）：
//   packages/dsh-remote-web/runtime/dsh-setup.mjs
//   packages/dsh-remote-web/runtime/clients/dsh-remote/**
//   packages/dsh-remote-web/runtime/node_modules/ws/**
//
// 用法：
//   node scripts/bundle-runtime.mjs                 # 写进 packages/dsh-remote-web/runtime（发版用）
//   node scripts/bundle-runtime.mjs --out /tmp/x    # 指定输出目录（测试用）
//   node scripts/bundle-runtime.mjs --check         # 只自检、不写（发布门禁用）
//
// ⚠️ runtime/ 是**构建产物**，已在 .gitignore 里：绝不入库（否则 dsh-setup.mjs / clients 会有两份
//    互相漂移的副本，而它们正是历史上最容易漂移的一对，见 launchd-domain.test.mjs 的跨文件不变量）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = path.join(ROOT, "packages", "dsh-remote-web");
const DEFAULT_OUT = path.join(PKG_DIR, "runtime");

/** 运行环境里必须有的文件（缺任何一个 = 这份产物不该发出去）。 */
const REQUIRED = [
  "dsh-setup.mjs",
  "clients/dsh-remote/dsh-bridge.mjs",
  "clients/dsh-remote/src/lifecycle.mjs",
  "node_modules/ws/package.json",
];
/** 拷贝 clients 时排除的东西：测试、依赖目录、系统垃圾、备份文件。 */
const CLIENT_SKIP_DIRS = new Set(["node_modules", "test"]);
const isJunk = (name) => name === ".DS_Store" || /\.bak(-|$)/.test(name);

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

/** 递归拷一个目录，按 CLIENT_SKIP_DIRS / isJunk 过滤。返回写出的文件数。 */
function copyTree(src, dest) {
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (isJunk(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      if (CLIENT_SKIP_DIRS.has(ent.name)) continue;
      n += copyTree(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
      n += 1;
    }
  }
  return n;
}

/** 入口脚本里点名的 clients/… 文件（与插件侧 runtimeReady 同一判据：不写死文件表，避免版本漂移）。 */
function declaredRuntimeFiles(entrySrc) {
  const out = new Set();
  for (const m of entrySrc.matchAll(/["'](?:\.\/)?(clients[\\/]dsh-remote[\\/][^"'\n]+?\.mjs)["']/g)) {
    out.add(m[1].replace(/\\/g, "/"));
  }
  return [...out];
}

/** ws 的位置：仓库根（workspace 提升）或 clients/dsh-remote 自己的 node_modules。 */
function findWs() {
  const candidates = [
    path.join(ROOT, "node_modules", "ws"),
    path.join(ROOT, "clients", "dsh-remote", "node_modules", "ws"),
    path.join(PKG_DIR, "node_modules", "ws"),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, "package.json"))) || null;
}

function build(outDir) {
  const setupSrc = path.join(ROOT, "dsh-setup.mjs");
  const clientsSrc = path.join(ROOT, "clients");
  if (!fs.existsSync(setupSrc)) fail(`找不到入口脚本：${setupSrc}`);
  if (!fs.existsSync(clientsSrc)) fail(`找不到 clients 目录：${clientsSrc}`);
  const ws = findWs();
  if (!ws) fail("找不到依赖 ws（先 npm install / pnpm install）：bridge 的 dsh-bridge.mjs 顶层 import 它，缺了必崩");

  fs.rmSync(outDir, { recursive: true, force: true }); // 幂等：每次重建，绝不让上一版的残留混进来
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(setupSrc, path.join(outDir, "dsh-setup.mjs"));
  const files = copyTree(clientsSrc, path.join(outDir, "clients"));
  copyTree(ws, path.join(outDir, "node_modules", "ws"));
  return { files };
}

/** 自检：REQUIRED + 入口脚本点名的文件都在（这正是「半装运行环境」的判据）。 */
function check(outDir) {
  const missing = [];
  for (const rel of REQUIRED) if (!fs.existsSync(path.join(outDir, rel))) missing.push(rel);
  try {
    const src = fs.readFileSync(path.join(outDir, "dsh-setup.mjs"), "utf8");
    for (const rel of declaredRuntimeFiles(src)) {
      if (!fs.existsSync(path.join(outDir, rel))) missing.push(rel);
    }
  } catch (e) {
    missing.push(`dsh-setup.mjs 不可读（${e.message}）`);
  }
  return missing;
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  };
  try { walk(dir); } catch { /* 不存在 */ }
  return (total / 1024 / 1024).toFixed(2);
}

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = outArg > -1 ? path.resolve(args[outArg + 1]) : DEFAULT_OUT;
const CHECK_ONLY = args.includes("--check");

if (CHECK_ONLY) {
  const missing = check(OUT);
  if (missing.length) fail(`runtime 产物不完整（缺 ${missing.length} 项）：${missing.slice(0, 5).join(", ")}`);
  console.log(`✅ runtime 自检通过：${OUT}（${dirSizeMB(OUT)} MB）`);
  process.exit(0);
}

const { files } = build(OUT);
const missing = check(OUT);
if (missing.length) {
  fail(`runtime 产物不完整（缺 ${missing.length} 项）：${missing.slice(0, 5).join(", ")}\n`
    + "   半装运行环境会让用户卡在「正在启动 Bridge…」且永远修不好 —— 宁可这里失败，也不发出去。");
}
console.log(`✅ 运行环境已打进插件包：${path.relative(ROOT, OUT)}（clients ${files} 个文件 + ws，共 ${dirSizeMB(OUT)} MB）`);

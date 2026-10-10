#!/usr/bin/env node
/**
 * 把本机环境同步成**仓库当前代码**（桥半 + 插件半），一条命令搞定。
 *
 * 为什么需要它（用户约定 2026-10-10：「开发完每次让本地是最新代码和插件」）：
 *   · 桥半跑在 `~/.dsh-remote`（客户端的运行环境），插件半跑在
 *     `~/.dsh/profiles/<profile>/dsh-remote-web-plugin`（宿主进程里）；
 *   · 两者都**不是**仓库里的文件，改了仓库不等于本机在跑新代码 ——
 *     手工同步过一次就漏一次（漏掉的那次表现为"我明明改好了，怎么还是旧行为"）。
 *   所以把同步固化成一条命令，并且**自带逐字节核验**：同步完就证明本机 == 仓库。
 *
 * 用法：
 *   node scripts/sync-local.mjs                 # 同步并重启桥（插件半由宿主热加载）
 *   node scripts/sync-local.mjs --no-restart     # 只同步，不动正在跑的桥
 *   node scripts/sync-local.mjs --dry-run        # 只报告差异，不写任何文件
 *   node scripts/sync-local.mjs --profile web    # 指定 profile（默认 desktop）
 *
 * 绝不触碰：profile 的 `cordis.patch.yml`（宿主 live 重载的工具面靠它，手改会打挂）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = path.join(ROOT, "packages", "dsh-remote-web");
const RUNTIME = path.join(PKG_DIR, "runtime");
const PLUGIN_ID = "dsh-remote-web";
const PLUGIN_LOCAL_DIR = `${PLUGIN_ID}-plugin`;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f, d) => { const i = args.indexOf(f); return i > -1 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry-run");
const FORCE_PLUGIN = has("--force-plugin");
const RESTART = !has("--no-restart");
const PROFILE = valOf("--profile", "desktop");

/**
 * DeepSeek Harness 桌面应用是否在运行。
 *
 * 🔴 2026-10-11 故障：在应用运行中改写 `~/.dsh/profiles/desktop/` 的插件文件，
 *    应用会**自己退出/重启**（用户："怎么又触发了 dsh 的关闭"）。安装器早就写明
 *    「请先完全退出应用再安装」。这条必须由脚本强制，不能靠人记得。
 */
function dshDesktopAppRunning() {
  // 显式覆盖（测试隔离 / 探测误报时的逃生口）：DSH_DESKTOP_APP_RUNNING=0|1
  const override = String(process.env.DSH_DESKTOP_APP_RUNNING || "").trim();
  if (override === "0" || override === "1") return override === "1";
  if (process.platform !== "darwin") return false;
  try {
    // 实测（2026-10-11）：`pgrep -x DeepSeek` 与 `pgrep -f "...app/Contents/MacOS"` 都匹配不到，
    // 必须用下面的写法（`Contents/MacOS/DeepSeek` 或短名 `DeepSeek Harness.app` 均可命中）。
    const a = spawnSync("pgrep", ["-f", "Contents/MacOS/DeepSeek"], { encoding: "utf8" });
    if (a.status === 0 && String(a.stdout || "").trim()) return true;
    const b = spawnSync("lsof", ["-nP", "-iTCP:19387", "-sTCP:LISTEN"], { encoding: "utf8" });
    return b.status === 0 && /LISTEN/.test(String(b.stdout || ""));
  } catch { return false; }
}

const REPO_VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const RELAY_DIR = process.env.DSH_RELAY_DIR || path.join(homedir(), ".dsh-remote");
const PROFILE_DIR = path.join(homedir(), ".dsh", "profiles", PROFILE);
const PLUGIN_DIR = path.join(PROFILE_DIR, PLUGIN_LOCAL_DIR);
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);

const log = (...a) => console.log(...a);
const ok = (m) => log(`  ✅ ${m}`);
const warn = (m) => log(`  ⚠️  ${m}`);
const bad = (m) => log(`  ❌ ${m}`);

/** 逐字节比较两个文件（不存在 = 不同）。 */
function sameFile(a, b) {
  try {
    if (!existsSync(a) || !existsSync(b)) return false;
    return createHash("sha1").update(readFileSync(a)).digest("hex") === createHash("sha1").update(readFileSync(b)).digest("hex");
  } catch { return false; }
}

/** 递归列出目录下所有文件的相对路径。 */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, out);
    else if (ent.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

/** 插件拷贝的过滤规则 —— 必须与安装器 dsh-setup.mjs 的 cpOpts.filter 一致：
 *  自带 runtime 之内的 node_modules **保留**（ws 是桥唯一的裸依赖），runtime 之外的依赖目录剔除。 */
function keepEntry(srcRel) {
  const segs = String(srcRel).split(path.sep);
  if (segs.some((s) => s === ".git" || s === ".DS_Store")) return false;
  const inRuntime = segs[0] === "runtime";
  if (!inRuntime && segs.some((s) => s === "node_modules")) return false;
  return true;
}

/** 带备份地同步一个文件；返回是否真的变了。 */
function syncFile(from, to) {
  if (sameFile(from, to)) return false;
  if (DRY) { log(`     [dry] 将更新 ${path.relative(homedir(), to)}`); return true; }
  mkdirSync(path.dirname(to), { recursive: true });
  if (existsSync(to)) { try { cpSync(to, `${to}.bak-${STAMP}`); } catch { /* 备份失败不阻断 */ } }
  cpSync(from, to);
  return true;
}

/** 带备份地同步一棵目录树（按 keepEntry 过滤）。 */
function syncTree(fromDir, toDir, relBase = "") {
  let changed = 0;
  for (const rel of walk(fromDir)) {
    if (!keepEntry(path.join(relBase, rel))) continue;
    if (syncFile(path.join(fromDir, rel), path.join(toDir, rel))) changed += 1;
  }
  return changed;
}

// ───────────────────────── 1) 重打运行时 ─────────────────────────
log(`\n=== 1) 重打运行环境（仓库版本 ${REPO_VERSION}）===`);
if (DRY) { log("  [dry] 跳过打包（dry-run 只报告差异）"); }
else {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "bundle-runtime.mjs")], { encoding: "utf8" });
  if (r.status !== 0) { bad(`打包失败：${r.stdout || ""}${r.stderr || ""}`); process.exit(1); }
  ok(String(r.stdout || "").trim().replace(/^✅ /, ""));
}

// ───────────────────────── 2) 桥半 → ~/.dsh-remote ─────────────────────────
log(`\n=== 2) 桥半 → ${RELAY_DIR} ===`);
{
  let changed = 0;
  changed += syncTree(path.join(RUNTIME, "clients"), path.join(RELAY_DIR, "clients"));
  changed += syncTree(path.join(RUNTIME, "node_modules"), path.join(RELAY_DIR, "node_modules"));
  if (syncFile(path.join(RUNTIME, "dsh-setup.mjs"), path.join(RELAY_DIR, "dsh-setup.mjs"))) changed += 1;
  // 版本标记：面板据它显示「运行时 x.y.z」。必须等于仓库版本，否则会出现"插件新、运行时旧"的错配。
  const verFile = path.join(RELAY_DIR, ".dsh-setup-version");
  const wantVer = `${REPO_VERSION}\n`;
  const curVer = existsSync(verFile) ? readFileSync(verFile, "utf8") : "";
  if (curVer !== wantVer) {
    if (!DRY) { mkdirSync(RELAY_DIR, { recursive: true }); writeFileSync(verFile, wantVer); }
    changed += 1;
  }
  log(changed === 0 ? "  已是最新（0 个文件需要更新）" : `  更新了 ${changed} 个文件`);
  // 就绪判据：与插件半 missingRuntimeFiles 同约定（含裸依赖 ws）
  const need = ["dsh-setup.mjs", "clients/dsh-remote/dsh-bridge.mjs", "clients/dsh-remote/src/lifecycle.mjs", "node_modules/ws/package.json"];
  const miss = need.filter((rel) => !existsSync(path.join(RELAY_DIR, rel)));
  miss.length === 0 ? ok("运行环境完整（含 ws）") : bad(`仍缺：${miss.join(", ")}`);
}

// ───────────────────────── 3) 插件半 → profile ─────────────────────────
log(`\n=== 3) 插件半 → ${PLUGIN_DIR} ===`);
if (!existsSync(PLUGIN_DIR)) {
  warn(`该 profile 下没有插件目录（${PROFILE}）。若确实要装：npx @mrrisega/dsh-remote@${REPO_VERSION.includes("-") ? "beta" : "latest"} plugin --profile ${PROFILE}`);
} else if (PROFILE === "desktop" && dshDesktopAppRunning() && !FORCE_PLUGIN) {
  /* 桌面端应用独占该 profile：运行中改写会让应用自己退出/重启（实测故障）。
     这里**只跳过插件半** —— 桥半照常同步、桥照常重启，都不影响应用。 */
  warn("DeepSeek Harness 应用正在运行 → **跳过插件半**（应用独占该 profile，运行中改写会让应用退出/重启）");
  warn("  要更新桌面端插件：先完全退出应用再跑本命令，或用应用内「插件」页安装（官方路径）；");
  warn("  确实要强行写入：npm run sync:local -- --force-plugin");
} else {
  let changed = 0;
  changed += syncTree(path.join(PKG_DIR, "lib"), path.join(PLUGIN_DIR, "lib"));
  changed += syncTree(RUNTIME, path.join(PLUGIN_DIR, "runtime"), "runtime");
  if (syncFile(path.join(PKG_DIR, "package.json"), path.join(PLUGIN_DIR, "package.json"))) changed += 1;
  log(changed === 0 ? "  已是最新（0 个文件需要更新）" : `  更新了 ${changed} 个文件`);
  // 核验：lib/ 与 runtime/ 必须与仓库逐字节一致
  const libDiff = walk(path.join(PKG_DIR, "lib")).filter((rel) => !sameFile(path.join(PKG_DIR, "lib", rel), path.join(PLUGIN_DIR, "lib", rel)));
  const rtDiff = walk(RUNTIME).filter((rel) => !sameFile(path.join(RUNTIME, rel), path.join(PLUGIN_DIR, "runtime", rel)));
  libDiff.length === 0 ? ok("lib/ 与仓库逐字节一致") : bad(`lib/ 仍不一致：${libDiff.slice(0, 3).join(", ")}`);
  rtDiff.length === 0 ? ok("runtime/ 与仓库逐字节一致（含 node_modules/ws）") : bad(`runtime/ 仍不一致：${rtDiff.slice(0, 3).join(", ")}`);
  // 明确声明：绝不动 profile 的 cordis.patch.yml
  const patch = path.join(PROFILE_DIR, "cordis.patch.yml");
  if (existsSync(patch)) {
    const hasBlock = readFileSync(patch, "utf8").includes("dsh-remote-web");
    hasBlock ? ok("profile 的 cordis.patch.yml 完好（本脚本绝不改它）") : warn("profile 的 cordis.patch.yml 里没有 dsh-remote-web 块");
  }
}

// ───────────────────────── 4) 让新代码真正跑起来 ─────────────────────────
log("\n=== 4) 生效 ===");
if (DRY) { log("  [dry] 跳过重启"); }
else if (!RESTART) { warn("按要求没有重启桥：桥半的新代码要等下次重启才生效"); }
else {
  const uid = process.getuid ? process.getuid() : null;
  const label = "com.dshremote.bridge";
  let done = false;
  for (const domain of [`user/${uid}`, `gui/${uid}`]) {
    const r = spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { encoding: "utf8" });
    if (r.status === 0) { ok(`已重启桥（${domain}/${label}）`); done = true; break; }
  }
  if (!done) warn("没找到 launchd 里的桥（可能未装自启动）：桥半新代码要等下次启动才生效");
}
log("  插件半：宿主通常**热加载**（改完刷新窗口即可）；若没生效，重启一次 DeepSeek Harness。");

log("\n=== 同步完成 ===");
log(`  仓库版本 ${REPO_VERSION} ｜ 桥半 ${RELAY_DIR} ｜ 插件半 ${PLUGIN_DIR}`);

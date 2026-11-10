/**
 * 插件半「立即升级」：下载新版本 → 原子换文件 → 让宿主 HMR 重新 import。
 *
 * 为什么需要这个模块（2026-11-11 真机审计结论）：
 *   · 现有「一键更新」在桌面端只会把新插件**暂存**到 `~/.dsh-remote/pending-plugin`，而唯一
 *     落地者（bridge 的 15s watcher）要求「应用已经关掉 ≥30s」——应用一直开着就永远不落地，
 *     用户只能退出应用再自己 `npx`。
 *   · 宿主其实提供了活体升级通道：`hmr.reconcileProfile()` 会按 `ino:size:mtime` 比对本插件
 *     已加载的模块文件，驱逐 ESM 缓存并用磁盘上的新代码重新 import（见 @deepseek-ai/dsh-hmr
 *     lib/index.js 的 reconcileProfile 注释）。所以正确做法是「把新版本文件原地换掉 + 触发 reconcile」，
 *     而不是「整目录 rename」——整目录会被判成 package-moved，要求重启应用。
 *   · 换文件必须逐文件 temp+rename（不能原地写半成品）：HMR 在重新 import 时读到半个文件会让
 *     宿主插件抛出、宿主子进程退出，Electron 随即弹「启动失败」= 用户看到的闪退。
 *
 * 这个模块只做文件与备份，不依赖宿主服务；reconcile 由调用方用 ctx.get('hmr') 执行。
 */

import fs from "node:fs";
import path from "node:path";
import { fetchTarballToStaging, resolveRegistryOrder } from "./self-update.js";

/** 插件目录名（profile 内）。历史名 dsh-remote-ui-plugin 也认。 */
export const PLUGIN_DIR_NAMES = Object.freeze(["dsh-remote-web-plugin", "dsh-remote-ui-plugin"]);
/** npm tarball 里插件半相对路径（解包时已剥掉 tarball 顶层 package/ 前缀）。 */
export const TARBALL_PLUGIN_SUBDIR = path.posix.join("packages", "dsh-remote-web");
/** 必需文件（缺任何一个都判为坏包，不落盘）。 */
export const REQUIRED_FILES = Object.freeze(["package.json", "lib/index.js", "lib/client.js", "lib/tarball-update.js"]);

/** semver 比较（与 index.js 的 compareVersions 同义，独立一份避免循环依赖）。 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || "").trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const len = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < len; i += 1) {
    const p1 = x.pre[i];
    const p2 = y.pre[i];
    if (p1 === undefined) return -1;
    if (p2 === undefined) return 1;
    if (p1 === p2) continue;
    const n1 = /^\d+$/.test(p1);
    const n2 = /^\d+$/.test(p2);
    if (n1 && n2) return Number(p1) > Number(p2) ? 1 : -1;
    if (n1) return -1;
    if (n2) return 1;
    return p1 > p2 ? 1 : -1;
  }
  return 0;
}

export function readPluginPackage(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return { name: String(raw.name || ""), version: String(raw.version || "") };
  } catch {
    return null;
  }
}

/** 递归列出目录下所有普通文件（相对路径，POSIX 分隔）。符号链接跳过（安全：不跟随到目录外）。 */
export function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(root, "");
  return out;
}

/** 把目录完整复制成一份备份（保留权限位；不跟随符号链接）。 */
export function copyTree(srcDir, dstDir) {
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true, dereference: false, force: true, errorOnExist: false });
}

/**
 * 逐文件原子替换：新文件先写进目标同目录的 `.tmp-*`，再逐个 rename 覆盖。
 * rename 在同一文件系统内是原子的，HMR 重新 import 时不会看到半个文件。
 * @returns {{files:number, dirs:number}}
 */
export function replaceFilesInPlace(srcDir, targetDir, { fsImpl = fs } = {}) {
  const files = listFiles(srcDir);
  if (files.length === 0) throw new Error("新版本里没有任何文件");
  let dirs = 0;
  const pending = [];
  for (const rel of files) {
    const src = path.join(srcDir, rel);
    const dst = path.join(targetDir, rel);
    const dstDir = path.dirname(dst);
    if (!fsImpl.existsSync(dstDir)) { fsImpl.mkdirSync(dstDir, { recursive: true }); dirs += 1; }
    const tmp = path.join(dstDir, `.tmp-${path.basename(dst)}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
    fsImpl.copyFileSync(src, tmp);
    try { fsImpl.chmodSync(tmp, fsImpl.statSync(src).mode & 0o777); } catch { /* 权限位失败不致命 */ }
    pending.push([tmp, dst]);
  }
  // 先写完全部临时文件，再连续 rename（窗口尽可能短）
  for (const [tmp, dst] of pending) fsImpl.renameSync(tmp, dst);
  return { files: files.length, dirs };
}

/** 旧版本备份目录（profile 内、插件目录外；不影响 HMR 的模块比对）。 */
export function backupDirFor(profileDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(profileDir, ".dsh-remote-backups", stamp);
}

/** 备份数量上限（保留最近 3 份）。 */
export function pruneBackups(profileDir, keep = 3) {
  const root = path.join(profileDir, ".dsh-remote-backups");
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => !n.startsWith(".")); } catch { return 0; }
  names.sort();
  let removed = 0;
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}

/**
 * 准备一次插件半升级：下载 → 校验 → 备份 → 逐文件替换。
 * 不触发 HMR；调用方拿到结果后再决定何时 reconcile（必须在响应发出之后）。
 * @returns {Promise<{ok:boolean, code?:string, detail?:string, fromVersion?:string, toVersion?:string, backupDir?:string, stageRoot?:string, files?:number, registry?:string, registryAttempts?:object[], ms?:number}>}
 */
export async function prepareLiveUpdate({
  relayDir,
  profileDir,
  targetDir,
  tag = "latest",
  version = "",
  stageDir = path.join(relayDir, "live-update-stage"),
  registries = resolveRegistryOrder(),
  timeoutMs = 20000,
} = {}) {
  const startedAt = Date.now();
  const dir = targetDir || path.join(profileDir, PLUGIN_DIR_NAMES[0]);
  const before = readPluginPackage(dir);
  if (!before) return { ok: false, code: "TARGET_NOT_FOUND", detail: `没有找到已安装的插件目录：${dir}` };

  const fetched = await fetchTarballToStaging({ tag, version, stageDir, registries, timeoutMs })
    .catch((e) => ({
      ok: false,
      code: (e && e.code) || "FETCH_FAILED",
      detail: String(e && e.message ? e.message : e),
      attempts: e && e.attempts,
    }));
  if (!fetched || !fetched.ok) {
    return { ok: false, code: (fetched && fetched.code) || "FETCH_FAILED", detail: (fetched && fetched.detail) || "下载新版本失败", attempts: fetched && fetched.attempts, ms: Date.now() - startedAt };
  }
  // self-update 会在 stageRoot 里给出根包（@mrrisega/dsh-remote），其中插件半在 packages/dsh-remote-web；
  // 优先用它的 payloadRoot（若返回），否则按约定路径取。
  const payloadRoot = fetched.payloadRoot || path.join(fetched.stageRoot, TARBALL_PLUGIN_SUBDIR);
  const pkgDir = payloadRoot;
  const next = readPluginPackage(pkgDir);
  if (!next) return { ok: false, code: "BAD_TARBALL", detail: `新版本包里没有插件半：${TARBALL_PLUGIN_SUBDIR}` };
  if (next.name && next.name !== "dsh-remote-web") return { ok: false, code: "NAME_MISMATCH", detail: `包内插件名不是 dsh-remote-web：${next.name}` };
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(pkgDir, rel))) return { ok: false, code: "BAD_TARBALL", detail: `新版本缺文件：${rel}` };
  }
  const cmp = compareVersions(next.version, before.version);
  if (cmp === 0) return { ok: false, code: "VERSION_UNCHANGED", detail: `已经是最新版本 ${before.version}`, fromVersion: before.version, toVersion: next.version };
  if (cmp !== null && cmp < 0) return { ok: false, code: "DOWNGRADE_REFUSED", detail: `拒绝降级：${before.version} → ${next.version}`, fromVersion: before.version, toVersion: next.version };

  const backupDir = backupDirFor(profileDir);
  try {
    copyTree(dir, backupDir);
  } catch (e) {
    return { ok: false, code: "BACKUP_FAILED", detail: `备份旧版本失败：${e.message}` };
  }
  try {
    const r = replaceFilesInPlace(pkgDir, dir);
    const installed = readPluginPackage(dir);
    if (!installed || installed.version !== next.version) {
      // 读回来的版本不对 → 立即回滚，避免留下半套
      try { restoreFromBackup(backupDir, dir); } catch { /* ignore */ }
      return { ok: false, code: "VERIFY_FAILED", detail: `替换后版本校验失败：期望 ${next.version}，实际 ${installed && installed.version}` };
    }
    pruneBackups(profileDir);
    return {
      ok: true,
      fromVersion: before.version,
      toVersion: installed.version,
      backupDir,
      stageRoot: fetched.stageRoot,
      files: r.files,
      registry: fetched.registry,
      registryAttempts: fetched.attempts,
      ms: Date.now() - startedAt,
    };
  } catch (e) {
    try { restoreFromBackup(backupDir, dir); } catch { /* ignore */ }
    return { ok: false, code: "APPLY_FAILED", detail: `替换文件失败（已回滚）：${e.message}` };
  }
}

/** 用备份恢复目标目录（失败路径用；目录整体替换，随后必须重新 reconcile）。 */
export function restoreFromBackup(backupDir, targetDir) {
  if (!fs.existsSync(backupDir)) throw new Error(`备份不存在：${backupDir}`);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(backupDir, targetDir, { recursive: true, dereference: false, force: true });
}

/**
 * 让宿主 HMR 重新 import 插件（免重启的核心一步）。
 * 调用方必须在 HTTP 响应已经发出之后调用，避免旧实例被停止时把响应截断。
 * @returns {Promise<{applied:boolean, restartReason?:string, warnings?:string[], error?:string}>}
 */
export async function reconcilePluginLive(ctx, { entryIds = [] } = {}) {
  let hmr = null;
  try { hmr = typeof ctx.get === "function" ? ctx.get("hmr") : null; } catch { hmr = null; }
  if (!hmr || typeof hmr.runExclusive !== "function" || typeof hmr.reconcileProfile !== "function") {
    return { applied: false, error: "宿主没有 hmr 服务，无法热加载（需要重启应用）" };
  }
  try {
    const result = await hmr.runExclusive(() => hmr.reconcileProfile(entryIds));
    const restartReason = result && result.restartReason;
    const warnings = (result && result.warnings) || [];
    return restartReason ? { applied: false, restartReason, warnings } : { applied: true, warnings };
  } catch (e) {
    return { applied: false, error: String(e && e.message ? e.message : e) };
  }
}

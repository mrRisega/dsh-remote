/**
 * 能力探测：找 Claude Code、问它版本、看用户有没有自己的审批钩子。
 *
 * ## 三件事，一件也不能省
 *
 * ① **找 CLI**（四级解析，见 `buildClaudeCandidates`）。真实世界里 Claude Code 至少有三种装法：
 *    npm 全局（`npm i -g @anthropic-ai/claude-code`）、原生安装器、以及"npm 装了但 postinstall 没跑"
 *    （此时 `bin/claude.exe` 只有占位、要靠 `cli-wrapper.cjs` 兜底）。**只认一种装法 = 一部分用户直接不可用**。
 *
 * ② **问版本**。第 1 周实测：2.1.195 不咨询 `PermissionRequest` 钩子，2.1.318 可以（报告 §2.2）。
 *    版本不够就必须**明确不可用**，不能静默丢审批。
 *
 * ③ **看既有审批钩子**。实测：用户/项目已有的 `PermissionRequest` 钩子会被我们"抢先放行"
 *    （项目钩子 deny + 我们 allow → 工具执行了，报告 §6.5）。企业里那是策略拦截，绕过去是安全事故。
 *    所以只要发现既有钩子，我们就**让位**（notify-only），不注入自己的。
 *
 * ## 为什么实现得这么"碎"
 *
 * 每个外部动作（找文件、跑进程、读配置）都通过参数注入，默认实现用 Node 内置。
 * 这样单测可以完全不依赖真机：不 spawn 真 claude、不读真 `~/.claude`。
 * 这是"零依赖 + 可测"的代价，也是 M2 敢在没有 Windows 真机的情况下先把逻辑写对的前提。
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync as nodeSpawnSync, execFileSync as nodeExecFileSync } from "node:child_process";

import {
  checkVersionGate,
  formatVersion,
  parseClaudeVersion,
  resolveMinVersion
} from "./version.mjs";

/** 显式覆盖 CLI 路径（排障/企业定制）。 */
export const CLAUDE_BIN_ENV = "DSH_AGENT_CLAUDE_BIN";
/** 显式覆盖 npm 全局根（Windows 自定义 prefix、以及单测注入）。 */
export const NPM_ROOT_ENV = "DSH_AGENT_NPM_ROOT";

/** npm 包名（与 `npm root -g` 拼出包内路径）。 */
const PKG = "@anthropic-ai/claude-code";
/** 包内原生可执行名。**注意：macOS/Linux 上也是 `claude.exe` 这个文件名**（install.cjs 的复制目标）。 */
const PKG_EXE = "bin/claude.exe";
/** postinstall 没跑时的兜底启动器（Node 脚本，跨平台）。 */
const PKG_WRAPPER = "cli-wrapper.cjs";

/** 钩子扫描覆盖的 settings 位置（只读，不写）。 */
export const SETTINGS_SCOPES = Object.freeze([
  { scope: "user", rel: path.join(".claude", "settings.json") },
  { scope: "project", rel: path.join(".claude", "settings.json") },
  { scope: "local", rel: path.join(".claude", "settings.local.json") }
]);

const DEFAULT_FS = {
  existsSync: (p) => fsSync.existsSync(p),
  statSync: (p) => fsSync.statSync(p),
  readFileSync: (p, enc) => fsSync.readFileSync(p, enc),
  realpathSync: (p) => fsSync.realpathSync(p),
  constants: fsSync.constants
};

/** 按平台拆 PATH（Windows 用 `;`，其余用 `:`）。 */
export function splitPathList(pathEnv, platform = process.platform) {
  const sep = platform === "win32" ? ";" : ":";
  return String(pathEnv ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 可执行判定：存在 + 是文件 + （posix）有执行位。Windows 只看扩展名（.exe）。 */
function defaultIsExecutable(p, { fs, platform }) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (platform === "win32") return /\.exe$/i.test(p);
    // 有执行位才算（防止把普通文本文件当 CLI 跑）
    return (Number(st.mode) & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** 解析符号链接到真实文件（macOS 的 /opt/homebrew/bin/claude 是指向包内 exe 的软链）。 */
function defaultRealpath(p, fs) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 找 npm 全局根。**不抛错**（探测阶段任何异常都不该让启动崩掉）。
 *
 * 顺序：
 *   1. `DSH_AGENT_NPM_ROOT`（显式覆盖 / 单测注入）；
 *   2. `npm root -g`（**Windows 上这条基本走不通**：`npm.cmd` 在 `shell:false` 下不可执行；
 *      这里仍试一次，失败就往下走，不报错）；
 *   3. 平台启发式路径（Windows 尤其是 main 路径：`%APPDATA%\npm\node_modules`）。
 *
 * 为什么 Windows 必须有启发式：只看 PATH 只能看到 `claude.cmd`（Node 无 shell 跑不了它），
 * 真正可执行的是 npm 全局根下的 `@anthropic-ai/claude-code/bin/claude.exe`。
 * 找不到 npm 根 = Windows 上直接"不可用"，所以这一步值得多给几个候选。
 */
export function probeNpmRoot({
  execFileSync = nodeExecFileSync,
  platform = process.platform,
  env = {},
  fs = DEFAULT_FS,
  execPath = process.execPath
} = {}) {
  const override = String(env?.[NPM_ROOT_ENV] ?? "").trim();
  if (override) return override;

  try {
    const npmExe = platform === "win32" ? "npm.cmd" : "npm";
    const out = execFileSync(npmExe, ["root", "-g"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      shell: false
    });
    const line = String(out ?? "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    if (line) return line;
  } catch {
    /* 往下走启发式 */
  }

  const hasPkg = (root) => {
    try {
      return fs.existsSync(path.join(root, "@anthropic-ai", "claude-code"));
    } catch {
      return false;
    }
  };

  const nodeDir = path.dirname(execPath || "");
  const guesses =
    platform === "win32"
      ? [
          env?.APPDATA ? path.join(env.APPDATA, "npm", "node_modules") : "",
          path.join(nodeDir, "node_modules"),
          env?.ProgramFiles ? path.join(env.ProgramFiles, "nodejs", "node_modules") : ""
        ]
      : [
          path.join(nodeDir, "..", "lib", "node_modules"),
          "/opt/homebrew/lib/node_modules",
          "/usr/local/lib/node_modules",
          "/usr/lib/node_modules"
        ];

  const list = guesses.filter(Boolean);
  const hit = list.find(hasPkg);
  return hit || list[0] || "";
}

/**
 * 构造 CLI 候选（按优先级从高到低）。**每一项都只是候选**，最终由 `--version` 探测决定谁可用。
 *
 *   1. `DSH_AGENT_CLAUDE_BIN`（显式覆盖，运维/企业定制）
 *   2. PATH 上的 `claude`（posix 会解软链到真实可执行；Windows 只认 `claude.exe`，**不用 .cmd**）
 *   3. npm 全局包内原生 exe：`<npm root -g>/@anthropic-ai/claude-code/bin/claude.exe`
 *   4. `node <npm root -g>/@anthropic-ai/claude-code/cli-wrapper.cjs`（postinstall 未跑时兜底）
 *
 * ⚠️ 为什么不直接用 Windows 的 `claude.cmd`：Node 的 `spawn` 不带 shell 时**不会**解析 `.cmd`
 *    （且自 CVE-2024-27980 起拒绝执行），带 shell 又会给用户输入开出命令注入面。
 *    所以要么解析到真实 exe，要么走 wrapper。
 *
 * @returns {Array<{kind:string, command:string, argsPrefix:string[], pathHint?:string}>}
 */
export function buildClaudeCandidates({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  fs = DEFAULT_FS,
  npmRoot = "",
  isExecutable = (p) => defaultIsExecutable(p, { fs, platform }),
  realpath = (p) => defaultRealpath(p, fs)
} = {}) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    // 去重只看"实际要执行的命令 + 参数"：同一条命令不该因为来源不同被探测两次
    // （显式 env 与 PATH 指到同一个可执行文件很常见）
    const key = `${c.command}:${(c.argsPrefix || []).join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // 1) 显式覆盖：用户说了算（是否可用仍要探测）
  const explicit = String(env?.[CLAUDE_BIN_ENV] ?? "").trim();
  if (explicit) {
    if (/\.cjs$/i.test(explicit)) {
      push({ kind: "explicit-wrapper", command: execPath, argsPrefix: [explicit], pathHint: explicit });
    } else {
      push({ kind: "explicit", command: explicit, argsPrefix: [], pathHint: explicit });
    }
  }

  // 2) PATH 上的 claude
  for (const dir of splitPathList(env?.PATH, platform)) {
    const names = platform === "win32" ? ["claude.exe"] : ["claude"];
    for (const name of names) {
      const p = path.join(dir, name);
      if (!isExecutable(p)) continue;
      const real = platform === "win32" ? p : realpath(p);
      push({ kind: "path", command: real, argsPrefix: [], pathHint: p });
      break;
    }
  }

  // 3) npm 全局包内原生 exe（Windows 上这是最可靠的一条：不依赖 PATH 里的 .cmd）
  if (npmRoot) {
    const exe = path.join(npmRoot, "@anthropic-ai", "claude-code", PKG_EXE);
    if (isExecutable(exe)) push({ kind: "npm-global-exe", command: exe, argsPrefix: [], pathHint: exe });

    // 4) wrapper 兜底（Node 脚本；跨平台，实测可跑）
    const wrapper = path.join(npmRoot, "@anthropic-ai", "claude-code", PKG_WRAPPER);
    try {
      if (fs.statSync(wrapper).isFile()) {
        push({ kind: "npm-wrapper", command: execPath, argsPrefix: [wrapper], pathHint: wrapper });
      }
    } catch {
      /* 不存在就跳过 */
    }
  }
  return out;
}

/** 探测一个候选的版本。失败不抛错，返回带原因的 object。 */
export function probeCandidateVersion(candidate, { spawnSync = nodeSpawnSync, timeoutMs = 10_000 } = {}) {
  try {
    const r = spawnSync(candidate.command, [...(candidate.argsPrefix || []), "--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = String(r?.stdout ?? "");
    const stderr = String(r?.stderr ?? "");
    if (r?.error) {
      return { ok: false, reason: `启动失败: ${r.error.code || r.error.message}`, stdout, stderr };
    }
    if (typeof r?.status === "number" && r.status !== 0) {
      return { ok: false, reason: `退出码 ${r.status}`, stdout, stderr };
    }
    const version = parseClaudeVersion(stdout) || parseClaudeVersion(stderr);
    if (!version) return { ok: false, reason: "输出里没有版本号", stdout, stderr };
    return { ok: true, version, stdout, stderr };
  } catch (err) {
    return { ok: false, reason: `探测异常: ${err?.code || err?.message || err}`, stdout: "", stderr: "" };
  }
}

/**
 * 扫描已有 `PermissionRequest` 钩子（**只读**，绝不写任何 settings）。
 *
 * 找到就必须让位：实测我们的 allow 会抢先于用户/企业自己的 deny 钩子生效（报告 §6.5）。
 *
 * @returns {{present:boolean, sources:Array<{path:string,scope:string}>, warnings:Array<{path:string,error:string}>}}
 */
export function scanExistingPermissionHooks({
  homeDir = os.homedir(),
  cwd = process.cwd(),
  fs = DEFAULT_FS,
  extraPaths = []
} = {}) {
  const targets = [];
  for (const { scope, rel } of SETTINGS_SCOPES) {
    const base = scope === "user" ? homeDir : cwd;
    if (!base) continue;
    targets.push({ path: path.join(base, rel), scope });
  }
  for (const p of extraPaths) targets.push({ path: p, scope: "extra" });

  const sources = [];
  const warnings = [];
  for (const t of targets) {
    let text;
    try {
      text = fs.readFileSync(t.path, "utf8");
    } catch {
      continue; // 不存在 = 正常情况，不告警
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      warnings.push({ path: t.path, error: "invalid-json" });
      continue;
    }
    const list = json && typeof json === "object" ? json?.hooks?.PermissionRequest : undefined;
    if (Array.isArray(list) && list.length > 0) sources.push({ path: t.path, scope: t.scope });
  }
  return { present: sources.length > 0, sources, warnings };
}

/**
 * 一站式探测：找 CLI → 问版本 → 门禁 → 扫既有钩子。
 *
 * **永远不抛错**（返回 `ok:false` + `status`），因为它是 bridge 启动路径上的第一环，
 * 抛错会让挂载方陷入"要不要 try/catch"的不确定性。
 *
 * status 取值：`ok` | `cli-missing` | `version-unknown` | `version-unsupported` | `existing-hooks` | `error`
 */
export function detectClaude({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  homeDir = os.homedir(),
  execPath = process.execPath,
  fs = DEFAULT_FS,
  spawnSync = nodeSpawnSync,
  execFileSync = nodeExecFileSync,
  npmRoot,
  extraSettingsPaths = [],
  probeTimeoutMs = 10_000,
  isExecutable,
  realpath
} = {}) {
  const minInfo = resolveMinVersion(env);
  const warnings = [];
  if (minInfo.warning) warnings.push({ code: "min-version-env", message: minInfo.warning });

  const hooks = scanExistingPermissionHooks({ homeDir, cwd, fs, extraPaths: extraSettingsPaths });
  for (const w of hooks.warnings) warnings.push({ code: "settings-unreadable", ...w });

  let root = npmRoot;
  if (root === undefined) root = probeNpmRoot({ execFileSync, platform, env });

  let candidates;
  try {
    candidates = buildClaudeCandidates({ env, platform, execPath, fs, npmRoot: root, isExecutable, realpath });
  } catch (err) {
    return {
      ok: false,
      status: "error",
      mode: "notify-only",
      reason: `构建 CLI 候选时异常: ${err?.message || err}`,
      min: { version: minInfo.min, text: minInfo.minText, source: minInfo.source },
      hooks,
      warnings
    };
  }

  const attempts = [];
  for (const c of candidates) {
    const r = probeCandidateVersion(c, { spawnSync, timeoutMs: probeTimeoutMs });
    attempts.push({ kind: c.kind, path: c.pathHint || c.command, ok: r.ok, reason: r.ok ? "" : r.reason });
    if (!r.ok) continue;

    const gate = checkVersionGate({
      version: r.version,
      min: minInfo.min,
      minText: minInfo.minText,
      versionText: formatVersion(r.version)
    });
    const base = {
      min: { version: minInfo.min, text: minInfo.minText, source: minInfo.source },
      cli: { kind: c.kind, path: c.pathHint || c.command, command: c.command, argsPrefix: c.argsPrefix || [] },
      version: { ...r.version, text: formatVersion(r.version) },
      gate,
      hooks,
      attempts,
      warnings
    };
    if (!gate.ok) return { ...base, ok: false, status: gate.status, mode: "notify-only", reason: gate.reason };
    if (hooks.present) {
      return {
        ...base,
        ok: false,
        status: "existing-hooks",
        mode: "notify-only",
        reason: "检测到本机已有 PermissionRequest 审批钩子，远程审批已让位（只通知、不回执），避免绕过本机策略",
        hookSources: hooks.sources
      };
    }
    return { ...base, ok: true, status: "ok", mode: "approval", reason: "" };
  }

  // 所有候选都探测失败
  const anyCandidate = candidates.length > 0;
  return {
    ok: false,
    status: anyCandidate ? "version-unknown" : "cli-missing",
    mode: "notify-only",
    reason: anyCandidate
      ? "找到了 CLI 候选但都拿不到版本（可能安装损坏，或该版本不支持 --version 的输出格式）"
      : "没有找到 Claude Code（未安装，或不在 PATH / npm 全局目录里）",
    min: { version: minInfo.min, text: minInfo.minText, source: minInfo.source },
    hooks,
    attempts,
    warnings
  };
}

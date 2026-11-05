#!/usr/bin/env node
/**
 * 能力探测契约测试：找 CLI / 问版本 / 看既有钩子。
 *
 * 为什么这些点值得测（每条都对应一个真实翻车方式）：
 *   ① **只认一种装法** → 换装法的用户直接不可用（npm 全局 / 原生安装器 / postinstall 没跑）；
 *   ② **Windows 上用了 `claude.cmd`** → Node 无 shell spawn 会 ENOENT/EINVAL，且带 shell 有注入面；
 *   ③ **不扫既有审批钩子** → 我们的 allow 会抢先于用户的 deny（第 1 周实测），绕过企业策略；
 *   ④ **探测期抛错** → bridge 启动路径多一个崩溃面（探测必须永远返回状态，不抛）。
 *
 * 全部外部动作注入假实现：不读真 `~/.claude`、不跑真 `claude`、不碰真实 PATH。
 *
 * 用法: node --test clients/dsh-remote/test/agent-detect.test.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CLAUDE_BIN_ENV,
  NPM_ROOT_ENV,
  buildClaudeCandidates,
  detectClaude,
  probeCandidateVersion,
  probeNpmRoot,
  scanExistingPermissionHooks,
  splitPathList
} from "../agent/detect.mjs";

/** ENOENT 风格的 fs 假实现（默认"什么都没有"）。 */
function makeFs(overrides = {}) {
  const enoent = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  return {
    existsSync: () => false,
    statSync: () => enoent(),
    readFileSync: () => enoent(),
    realpathSync: (p) => p,
    constants: {},
    ...overrides
  };
}

const okVersion = (text) => () => ({ status: 0, stdout: `${text} (Claude Code)\n`, stderr: "" });

test("PATH 拆分：posix 用冒号、Windows 用分号", () => {
  assert.deepEqual(splitPathList("/a:/b::/c", "linux"), ["/a", "/b", "/c"]);
  assert.deepEqual(splitPathList("C:\\a;C:\\b", "win32"), ["C:\\a", "C:\\b"]);
  assert.deepEqual(splitPathList("", "linux"), []);
});

test("CLI 候选①：显式 env 最高优先（.cjs 走 node wrapper 形态）", () => {
  const c = buildClaudeCandidates({
    env: { [CLAUDE_BIN_ENV]: "/opt/claude" },
    platform: "linux",
    fs: makeFs(),
    npmRoot: ""
  });
  assert.equal(c[0].kind, "explicit");
  assert.equal(c[0].command, "/opt/claude");

  const w = buildClaudeCandidates({
    env: { [CLAUDE_BIN_ENV]: "/pkg/cli-wrapper.cjs" },
    platform: "linux",
    execPath: "/usr/bin/node",
    fs: makeFs(),
    npmRoot: ""
  });
  assert.equal(w[0].kind, "explicit-wrapper");
  assert.equal(w[0].command, "/usr/bin/node");
  assert.deepEqual(w[0].argsPrefix, ["/pkg/cli-wrapper.cjs"]);
});

test("CLI 候选②：posix 从 PATH 找 claude，并解软链到真实可执行", () => {
  const c = buildClaudeCandidates({
    env: { PATH: "/usr/local/bin:/opt/homebrew/bin" },
    platform: "linux",
    fs: makeFs(),
    npmRoot: "",
    isExecutable: (p) => p === "/opt/homebrew/bin/claude",
    realpath: (p) => (p === "/opt/homebrew/bin/claude" ? "/pkg/bin/claude.exe" : p)
  });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "path");
  assert.equal(c[0].command, "/pkg/bin/claude.exe", "软链必须解开：真正可执行的是包内文件");
  assert.equal(c[0].pathHint, "/opt/homebrew/bin/claude");
});

test("CLI 候选②：Windows 只认 claude.exe，**绝不把 claude.cmd 当候选**", () => {
  const seen = [];
  const c = buildClaudeCandidates({
    env: { PATH: "C:\\Users\\x\\AppData\\Roaming\\npm" },
    platform: "win32",
    fs: makeFs(),
    npmRoot: "",
    isExecutable: (p) => {
      seen.push(p);
      return /claude\.exe$/i.test(p);
    }
  });
  assert.deepEqual(
    seen.map((p) => path.basename(p)),
    ["claude.exe"],
    "只探测 .exe，不该去看 .cmd（Node 无 shell 跑不了它）"
  );
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "path");
});

test("CLI 候选③④：npm 全局包内 exe 优先于 wrapper 兜底", () => {
  const npmRoot = "/usr/lib/node_modules";
  const exe = path.join(npmRoot, "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const wrapper = path.join(npmRoot, "@anthropic-ai", "claude-code", "cli-wrapper.cjs");
  const c = buildClaudeCandidates({
    env: {},
    platform: "linux",
    execPath: "/usr/bin/node",
    fs: makeFs({ statSync: () => ({ isFile: () => true }) }),
    npmRoot,
    isExecutable: (p) => p === exe
  });
  assert.deepEqual(c.map((x) => x.kind), ["npm-global-exe", "npm-wrapper"]);
  assert.equal(c[0].command, exe);
  assert.equal(c[1].command, "/usr/bin/node");
  assert.deepEqual(c[1].argsPrefix, [wrapper]);
});

test("CLI 候选：同一路径不重复入列（显式 + PATH 命中也只有一条）", () => {
  const c = buildClaudeCandidates({
    env: { [CLAUDE_BIN_ENV]: "/same/claude", PATH: "/same" },
    platform: "linux",
    fs: makeFs(),
    npmRoot: "",
    isExecutable: () => true,
    realpath: (p) => p
  });
  assert.equal(c.length, 1);
});

test("npm root：env 覆盖优先，且不调外部命令", () => {
  let called = false;
  const r = probeNpmRoot({
    env: { [NPM_ROOT_ENV]: "/custom/root" },
    execFileSync: () => {
      called = true;
      return "/should/not/use";
    }
  });
  assert.equal(r, "/custom/root");
  assert.equal(called, false);
});

test("npm root：外部命令失败 → 不抛错，回落到启发式候选（可能是猜测路径）", () => {
  const r = probeNpmRoot({
    execFileSync: () => {
      throw new Error("npm 不存在");
    },
    fs: makeFs(), // 什么都不存在 → 命中第一个猜测路径，由后续 isExecutable 兜底
    execPath: "/usr/bin/node"
  });
  assert.equal(typeof r, "string");
  assert.ok(r.length > 0, "至少要给出一个候选根，让 buildClaudeCandidates 去探");
});

test("npm root：Windows 上 npm.cmd 跑不通时，回落到 %APPDATA%\\npm\\node_modules 启发式", () => {
  const appData = "C:\\Users\\x\\AppData\\Roaming";
  const expected = path.join(appData, "npm", "node_modules");
  const pkgDir = path.join(expected, "@anthropic-ai", "claude-code");
  const r = probeNpmRoot({
    platform: "win32",
    env: { APPDATA: appData },
    execFileSync: () => {
      // 真实行为：Node 在 shell:false 下执行 .cmd 会抛 EINVAL
      throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    },
    fs: makeFs({ existsSync: (p) => p === pkgDir }),
    execPath: "C:\\Program Files\\nodejs\\node.exe"
  });
  assert.equal(r, expected, "Windows 必须靠启发式找到全局根，否则只剩跑不了的 .cmd");
});

test("npm root：posix 上 npm 跑不通时回落到常见全局目录（存在包才选它）", () => {
  const expected = path.join("/usr/lib/node_modules");
  const pkgDir = path.join(expected, "@anthropic-ai", "claude-code");
  const r = probeNpmRoot({
    platform: "linux",
    env: {},
    execFileSync: () => {
      throw new Error("npm not found");
    },
    fs: makeFs({ existsSync: (p) => p === pkgDir }),
    execPath: "/usr/bin/node"
  });
  assert.equal(r, expected);
});

test("探测版本：成功解析 / 非零退出 / 输出不含版本 / 启动异常，四种都不抛", () => {
  const ok = probeCandidateVersion({ command: "claude", argsPrefix: [] }, { spawnSync: okVersion("2.1.318") });
  assert.equal(ok.ok, true);
  assert.equal(ok.version.patch, 318);

  const exit1 = probeCandidateVersion(
    { command: "claude", argsPrefix: [] },
    { spawnSync: () => ({ status: 1, stdout: "", stderr: "boom" }) }
  );
  assert.equal(exit1.ok, false);
  assert.match(exit1.reason, /退出码 1/);

  const noVersion = probeCandidateVersion(
    { command: "claude", argsPrefix: [] },
    { spawnSync: () => ({ status: 0, stdout: "hello", stderr: "" }) }
  );
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.reason, /没有版本号/);

  const err = probeCandidateVersion(
    { command: "claude", argsPrefix: [] },
    { spawnSync: () => ({ error: { code: "ENOENT", message: "no such file" } }) }
  );
  assert.equal(err.ok, false);
  assert.match(err.reason, /ENOENT/);
});

test("既有钩子扫描：user / project / local 三处都能发现", () => {
  const home = "/home/u";
  const cwd = "/work/p";
  const files = {
    [path.join(home, ".claude", "settings.json")]: JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "deny.sh" }] }] }
    }),
    [path.join(cwd, ".claude", "settings.local.json")]: JSON.stringify({
      hooks: { PermissionRequest: [{ hooks: [{ type: "http", url: "http://127.0.0.1:1/x" }] }] }
    })
  };
  const fs = makeFs({
    readFileSync: (p) => {
      if (p in files) return files[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  const r = scanExistingPermissionHooks({ homeDir: home, cwd, fs });
  assert.equal(r.present, true);
  assert.deepEqual(r.sources.map((s) => s.scope).sort(), ["local", "user"]);
  assert.equal(r.warnings.length, 0);
});

test("既有钩子扫描：空数组 / 缺字段 / 坏 JSON 的语义", () => {
  const home = "/home/u";
  const cwd = "/work/p";
  const settings = path.join(cwd, ".claude", "settings.json");
  const bad = path.join(home, ".claude", "settings.json");
  const fs = makeFs({
    readFileSync: (p) => {
      if (p === settings) return JSON.stringify({ hooks: { PermissionRequest: [] } }); // 空数组 ≠ 有钩子
      if (p === bad) return "{ not json";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  const r = scanExistingPermissionHooks({ homeDir: home, cwd, fs });
  assert.equal(r.present, false, "空数组不算既有钩子");
  assert.deepEqual(r.warnings, [{ path: bad, error: "invalid-json" }], "坏 JSON 要告警但不能崩");
});

test("既有钩子扫描：文件都不存在是正常情况（不告警）", () => {
  const r = scanExistingPermissionHooks({ homeDir: "/nope", cwd: "/nope", fs: makeFs() });
  assert.deepEqual(r, { present: false, sources: [], warnings: [] });
});

test("detectClaude 正常路径：找到 CLI + 版本达标 + 无既有钩子 → ok/approval", () => {
  const r = detectClaude({
    env: { [CLAUDE_BIN_ENV]: "/fake/claude" },
    platform: "linux",
    cwd: "/work/p",
    homeDir: "/home/u",
    fs: makeFs(),
    spawnSync: okVersion("2.1.318"),
    execFileSync: () => {
      throw new Error("no npm");
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "ok");
  assert.equal(r.mode, "approval");
  assert.equal(r.version.text, "2.1.318");
  assert.equal(r.cli.kind, "explicit");
});

test("detectClaude：版本低于阈值 → 不启用，reason 说明要升级", () => {
  const r = detectClaude({
    env: { [CLAUDE_BIN_ENV]: "/fake/claude" },
    platform: "linux",
    cwd: "/work/p",
    homeDir: "/home/u",
    fs: makeFs(),
    spawnSync: okVersion("2.1.195"),
    execFileSync: () => {
      throw new Error("no npm");
    }
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "version-unsupported");
  assert.equal(r.mode, "notify-only");
  assert.match(r.reason, /2\.1\.195/);
  assert.match(r.reason, /2\.1\.318/);
});

test("detectClaude：env 覆盖阈值后，2.1.195 也能被认为达标（二分版本用）", () => {
  const r = detectClaude({
    env: { [CLAUDE_BIN_ENV]: "/fake/claude", DSH_AGENT_MIN_CLAUDE_VERSION: "2.1.100" },
    platform: "linux",
    cwd: "/work/p",
    homeDir: "/home/u",
    fs: makeFs(),
    spawnSync: okVersion("2.1.195"),
    execFileSync: () => {
      throw new Error("no npm");
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.min.source, "env");
});

test("detectClaude：既有钩子 → 让位（notify-only），不启用审批", () => {
  const home = "/home/u";
  const fs = makeFs({
    readFileSync: (p) => {
      if (p === path.join(home, ".claude", "settings.json")) {
        return JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "x" }] }] } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  const r = detectClaude({
    env: { [CLAUDE_BIN_ENV]: "/fake/claude" },
    platform: "linux",
    cwd: "/work/p",
    homeDir: home,
    fs,
    spawnSync: okVersion("2.1.318"),
    execFileSync: () => {
      throw new Error("no npm");
    }
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "existing-hooks");
  assert.equal(r.mode, "notify-only");
  assert.match(r.reason, /让位/);
  assert.equal(r.hookSources.length, 1);
  // 关键：即使让位，也要把 claude/version 带出去 —— 上层仍可启动 CLI（只是不注入钩子）
  assert.equal(r.cli.path, "/fake/claude");
  assert.equal(r.version.text, "2.1.318");
});

test("detectClaude：一个候选都没有 → cli-missing（不抛错）", () => {
  const r = detectClaude({
    env: { PATH: "" },
    platform: "linux",
    cwd: "/work/p",
    homeDir: "/home/u",
    fs: makeFs(),
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    execFileSync: () => {
      throw new Error("no npm");
    },
    npmRoot: ""
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "cli-missing");
  assert.match(r.reason, /没有找到 Claude Code/);
  assert.deepEqual(r.attempts, []);
});

test("detectClaude：候选都探测失败 → version-unknown（带 attempts 便于排障）", () => {
  const r = detectClaude({
    env: { [CLAUDE_BIN_ENV]: "/fake/claude" },
    platform: "linux",
    cwd: "/work/p",
    homeDir: "/home/u",
    fs: makeFs(),
    spawnSync: () => ({ status: 0, stdout: "weird output", stderr: "" }),
    execFileSync: () => {
      throw new Error("no npm");
    }
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "version-unknown");
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].ok, false);
});

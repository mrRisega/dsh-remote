/**
 * 插件挂载（node_modules/<id> 链接）回归 —— 0.6.7-beta.2 新增。
 *
 * 背景（Windows 用户实测，2026-09-18）：0.6.7-beta.1 的 `ensurePluginLinked` 用
 * `fs.symlinkSync(target, path, "dir")` 建链接，并把 junction / 整目录拷贝两级兜底写在它的 `catch` 里。
 * 在 **非特权进程 + 开发者模式关闭**（= 普通用户默认状态）下，`'dir'` 在 Windows 上
 * **既不抛错也产不出可用链接**（实测：用户目录下留一个空目录，%TEMP% 下什么都不留；
 * 同一位置两次运行一次报成功一次抛 UNKNOWN）。于是：
 *   · 报成功 → catch 不进入 → 两级兜底永不执行 → 留下空壳/什么都没有；
 *   · 报错   → catch 进入 → 但上一步已留空目录 → junction 撞 EEXIST → 只剩 cpSync 一支。
 * 而调用方把返回值丢掉、patch 照写、还打印「✅ 插件已就绪」，最终
 * dsh web 按裸包名解析到空目录 → `plugin tree failed to load` → **整个 dsh web 起不来**。
 *
 * ⚠️ 本文件存在的意义就是"上一版为什么漏测"：老用例只断言"函数没抛错 / 返回 true"，
 * 而这里的断言对象是**通过 node_modules/<id> 这条路径到底能不能读到东西**，
 * 并且用注入式 fs 代理**复现**了 Windows 那种"不抛错但落盘是空壳"的形态。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(HERE, "..", "..", "..", "dsh-setup.mjs");
const PLUGIN_SRC = path.join(HERE, "..");
const PLUGIN_ID = "dsh-remote-web";
const SETUP_SRC = fs.readFileSync(SETUP, "utf8");

// ─────────────── 源码内取函数（安装器是 CLI 脚本，import 会直接执行 main） ───────────────

/** 取出 dsh-setup.mjs 里某个函数的源码文本。 */
function fnSrc(name, nextMarker) {
  const start = SETUP_SRC.indexOf(`function ${name}(`);
  const end = SETUP_SRC.indexOf(nextMarker, start);
  assert.ok(start > -1 && end > start, `应能从安装器源码里取出 ${name}`);
  return SETUP_SRC.slice(start, end);
}

/** 用真实 fs/path 组装出被测函数（纯函数，可安全求值）。 */
function loadLinkFns() {
  const src = fnSrc("pluginLinkUsable", "/**\n * 把插件挂到")
    + fnSrc("ensurePluginLinked", "/**\n * 独立验收：复刻 dsh 客户端模块系统的真实动作");
  return new Function("fs", "path", "PLUGIN_ID", "PLUGIN_LEGACY_IDS",
    `${src}; return { pluginLinkUsable, ensurePluginLinked };`)(fs, path, PLUGIN_ID, ["dsh-remote-ui"]);
}

/** 造一份"像真的"插件目录（package.json + lib/index.js 已是可用性判据的最低要求）。 */
function makePluginDir(root, { name = PLUGIN_ID, withEntry = true } = {}) {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "0.0.0-test" }));
  if (withEntry) fs.writeFileSync(path.join(root, "lib", "index.js"), "export const x = 1;\n");
  return root;
}

function tmpDir(prefix = "dsh-link-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─────────────── ① 可用性判据必须否定所有畸形形态 ───────────────

test("pluginLinkUsable：空目录/畸形链接一律判为不可用（不能只看'没抛错'）", () => {
  const { pluginLinkUsable } = loadLinkFns();
  const root = tmpDir();
  try {
    const local = makePluginDir(path.join(root, "local"));
    const nm = path.join(root, "node_modules", PLUGIN_ID);
    fs.mkdirSync(path.dirname(nm), { recursive: true });

    assert.equal(pluginLinkUsable(nm, local), false, "不存在 → 不可用");

    // 这就是本 bug 的落盘形态：一个同名空目录
    fs.mkdirSync(nm, { recursive: true });
    assert.equal(pluginLinkUsable(nm, local), false, "★空目录必须判为不可用（老实现正是在这里当作成功）");

    // 有 package.json 但 name 不对（旧的别名包残留 / 别的包）
    fs.writeFileSync(path.join(nm, "package.json"), JSON.stringify({ name: "dsh-remote-ui" }));
    fs.mkdirSync(path.join(nm, "lib"), { recursive: true });
    fs.writeFileSync(path.join(nm, "lib", "index.js"), "x");
    assert.equal(pluginLinkUsable(nm, local), false, "name 不匹配 → 不可用（面板注入靠裸包名）");

    // name 对了但没有节点半入口
    fs.writeFileSync(path.join(nm, "package.json"), JSON.stringify({ name: PLUGIN_ID }));
    fs.rmSync(path.join(nm, "lib", "index.js"));
    assert.equal(pluginLinkUsable(nm, local), false, "缺 lib/index.js → 不可用");

    // 内容完整 + realpath 指回本地目录 → 可用
    fs.writeFileSync(path.join(nm, "lib", "index.js"), fs.readFileSync(path.join(local, "lib", "index.js")));
    fs.rmSync(nm, { recursive: true, force: true });
    // 正向对照必须按平台取链接类型：Windows 非特权进程下 'dir' 本来就建不出来（正是本 bug），
    // 拿它当"正确答案"会让用例在真 Windows 上自己失败。
    if (process.platform === "win32") fs.symlinkSync(local, nm, "junction");
    else fs.symlinkSync(local, nm, "dir");
    assert.equal(pluginLinkUsable(nm, local), true, "真链接 → 可用");

    // 整目录拷贝（内容一致）→ 也算可用
    fs.rmSync(nm, { recursive: true, force: true });
    fs.cpSync(local, nm, { recursive: true });
    assert.equal(pluginLinkUsable(nm, local), true, "整目录拷贝（内容一致）→ 可用");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────── ② 注入 Windows 的失败形态：不抛错但落盘是空壳 ───────────────

/** 造一个 fs 代理：可按需让某个策略"静默失败"（不抛错、也不产出任何东西）。 */
function fsProxy({ silentFail = [], emptyDirInstead = [] } = {}) {
  return {
    ...fs,
    symlinkSync(target, p, type) {
      if (emptyDirInstead.includes(type)) { fs.mkdirSync(p, { recursive: true }); return; } // ← 本 bug 的落盘形态
      if (silentFail.includes(type)) return;                                               // ← 本 bug 的"报成功"
      return fs.symlinkSync(target, p, type);
    },
    cpSync(...args) {
      if (silentFail.includes("copy")) return;
      return fs.cpSync(...args);
    },
  };
}

function loadLinkFnsWithFs(fakeFs) {
  const src = fnSrc("pluginLinkUsable", "/**\n * 把插件挂到")
    + fnSrc("ensurePluginLinked", "/**\n * 独立验收：复刻 dsh 客户端模块系统的真实动作");
  return new Function("fs", "path", "PLUGIN_ID", "PLUGIN_LEGACY_IDS",
    `${src}; return { pluginLinkUsable, ensurePluginLinked };`)(fakeFs, path, PLUGIN_ID, ["dsh-remote-ui"]);
}

test("ensurePluginLinked：'不抛错但什么都没建' 时，兜底链必须继续生效（本 bug 的核心）", () => {
  const root = tmpDir();
  try {
    const local = makePluginDir(path.join(root, "local"));
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { recursive: true });
    // 模拟 Windows：junction 报告成功但落盘什么都没有（老实现据此当作成功、直接 return）
    const { ensurePluginLinked } = loadLinkFnsWithFs(fsProxy({ silentFail: ["junction"] }));
    const changed = ensurePluginLinked(profile, local);
    assert.equal(changed, true, "应当重建并报告发生了变更");
    const nm = path.join(profile, "node_modules", PLUGIN_ID);
    assert.ok(fs.existsSync(path.join(nm, "package.json")), "★兜底必须真的把内容落盘（老实现在这里留下空壳）");
    assert.ok(fs.existsSync(path.join(nm, "lib", "index.js")), "★节点半入口必须可读");
    assert.ok(fs.readdirSync(nm).length > 0, "node_modules/<id> 是空目录 = 本 bug 复现");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePluginLinked：上一支留下空目录残留时，下一支不得被 EEXIST 顶掉", () => {
  const root = tmpDir();
  try {
    const local = makePluginDir(path.join(root, "local"));
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const { ensurePluginLinked } = loadLinkFnsWithFs(fsProxy({ emptyDirInstead: ["junction"] }));
    ensurePluginLinked(profile, local);
    const nm = path.join(profile, "node_modules", PLUGIN_ID);
    assert.ok(fs.existsSync(path.join(nm, "lib", "index.js")),
      "★先留空目录再走兜底也必须成功（老实现这里撞 EEXIST，三级兜底退化成一级）");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePluginLinked：所有策略都失败时必须抛错，绝不返回成功", () => {
  const root = tmpDir();
  try {
    const local = makePluginDir(path.join(root, "local"));
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const { ensurePluginLinked } = loadLinkFnsWithFs(fsProxy({ silentFail: ["junction", "dir", "copy"] }));
    assert.throws(() => ensurePluginLinked(profile, local), /插件挂载失败/,
      "全失败必须抛错 —— 否则调用方会写出一个起不来的 profile");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePluginLinked：已经挂好时幂等返回 false（不重复重建）", () => {
  const root = tmpDir();
  try {
    const local = makePluginDir(path.join(root, "local"));
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const { ensurePluginLinked } = loadLinkFns();
    assert.equal(ensurePluginLinked(profile, local), true, "首次应重建");
    assert.equal(ensurePluginLinked(profile, local), false, "已就绪应幂等返回 false");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────── ③ 真起进程：装完必须真的能被裸包名解析到 ───────────────

/** 准备一个最小可用 profile（package.json + 空的 cordis.patch.yml）。 */
function makeProfile(root) {
  const profile = path.join(root, "prof");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-web", version: "0.0.0" }, null, 2));
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "[]\n");
  return profile;
}

/** 在隔离 HOME 下跑安装器命令。 */
function runInstaller(args, env = {}) {
  const home = env.HOME || fs.mkdtempSync(path.join(os.tmpdir(), "dsh-link-home-"));
  return new Promise((resolve) => {
    execFile(process.execPath, [SETUP, ...args], {
      env: { ...process.env, HOME: home, DSH_RELAY_SKIP_SERVICE: "1", DSH_RELAY_DIR: path.join(home, ".dsh-remote"), ...env },
      timeout: 60_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

/** 复刻 dsh 的真实解析动作（浏览器半注入设置面板靠它）。 */
function resolveFromProfile(profile, spec) {
  const req = createRequire(path.join(profile, "__probe.cjs"));
  return req.resolve(spec);
}

test("端到端：安装器装完插件后，node_modules/<id> 必须真的可读、可解析（不能只看退出码）", async () => {
  const root = tmpDir();
  try {
    const profile = makeProfile(root);
    const r = await runInstaller(["plugin"], { DSH_PROFILE_DIR: profile });
    assert.equal(r.code, 0, `安装应成功：${r.stdout}\n${r.stderr}`);

    const nm = path.join(profile, "node_modules", PLUGIN_ID);
    // ① 落盘可读 —— Windows 非特权下老代码在这里就挂了
    const pkg = JSON.parse(fs.readFileSync(path.join(nm, "package.json"), "utf8"));
    assert.equal(pkg.name, PLUGIN_ID);
    assert.ok(fs.existsSync(path.join(nm, "lib", "index.js")), "节点半入口必须存在");
    assert.ok(fs.readdirSync(nm).length > 0, "★空目录 = 本 bug 复现");

    // ② 复刻 dsh 的解析动作
    assert.ok(resolveFromProfile(profile, `${PLUGIN_ID}/package.json`).endsWith("package.json"));
    assert.ok(resolveFromProfile(profile, PLUGIN_ID), "裸包名必须能解析到入口");
    assert.equal(pkg.dsh.client.platform, "web", "浏览器半声明必须在（面板注入的前提）");

    // ③ 激活行必须写进 patch
    const patch = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    assert.match(patch, /dsh-remote-web/, "patch 里应有插件激活行");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("端到端：node_modules/<id> 已是空壳时，重新安装必须自愈", async () => {
  const root = tmpDir();
  try {
    const profile = makeProfile(root);
    // 复现中招现场：同名空目录
    fs.mkdirSync(path.join(profile, "node_modules", PLUGIN_ID), { recursive: true });
    const r = await runInstaller(["plugin"], { DSH_PROFILE_DIR: profile });
    assert.equal(r.code, 0, `重装应自愈：${r.stdout}\n${r.stderr}`);
    const nm = path.join(profile, "node_modules", PLUGIN_ID);
    assert.ok(fs.existsSync(path.join(nm, "lib", "index.js")), "★空壳必须被重建（空目录不许当作已挂载）");
    assert.ok(resolveFromProfile(profile, `${PLUGIN_ID}/package.json`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("端到端：挂载失败必须中止安装，且**不写** patch（宁可不装，也不能写出起不来的 profile）", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return; // root 不受权限位约束
  // Windows 的 chmod 只改只读属性、**不限制目录写入**，制造不出"必然失败"的落盘环境。
  // 该场景由上面三条注入式 fs 代理用例覆盖（含"全失败必须抛错"）。
  if (process.platform === "win32") { t.skip("Windows 无 POSIX 权限位语义"); return; }
  const root = tmpDir();
  try {
    const profile = makeProfile(root);
    const nmDir = path.join(profile, "node_modules");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.chmodSync(nmDir, 0o500); // 只读：symlink 与 cpSync 都必然失败
    try {
      const r = await runInstaller(["plugin"], { DSH_PROFILE_DIR: profile });
      assert.equal(r.code, 1, `应中止安装（非 0 退出）：${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /已中止安装/, "必须明确告知已中止");
      const patch = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
      assert.ok(!/dsh-remote-web/.test(patch), "★绝不能写激活行：那会让 dsh web 起不来");
      assert.ok(!/插件已就绪/.test(r.stdout), "不得谎报成功");
    } finally {
      fs.chmodSync(nmDir, 0o700);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────── ④ 自救入口：repair ───────────────

test("repair：空壳现场能被修好，并打印挂载诊断三行", async () => {
  const root = tmpDir();
  try {
    const profile = makeProfile(root);
    await runInstaller(["plugin"], { DSH_PROFILE_DIR: profile });
    // 破坏：把链接换成空壳（= 用户中招后的现场）
    const nm = path.join(profile, "node_modules", PLUGIN_ID);
    fs.rmSync(nm, { recursive: true, force: true });
    fs.mkdirSync(nm, { recursive: true });

    const r = await runInstaller(["repair"], { DSH_PROFILE_DIR: profile });
    assert.equal(r.code, 0, `repair 应成功：${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[link\]/, "应打印链接诊断");
    assert.match(r.stdout, /\[resolve\]/, "应打印解析诊断");
    assert.match(r.stdout, /\[client\]/, "应打印客户端半声明诊断");
    assert.match(r.stdout, /🛟/, "挂载不可用时应先摘掉激活行保命");
    assert.ok(fs.existsSync(path.join(nm, "lib", "index.js")), "★应修好挂载");
    assert.ok(resolveFromProfile(profile, `${PLUGIN_ID}/package.json`), "★应可解析");
    assert.match(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), /dsh-remote-web/, "应恢复激活行");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repair：本地插件目录缺失时明确报错并给重装命令（不静默成功）", async () => {
  const root = tmpDir();
  try {
    const profile = makeProfile(root);
    const r = await runInstaller(["repair"], { DSH_PROFILE_DIR: profile });
    assert.equal(r.code, 1, `无本地拷贝应失败：${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /请重新安装/, "必须给出可照抄的重装命令");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────── ⑤ 包管理器识别（Windows 上 `command -v` 恒失效） ───────────────

test("detectPackageManager：按声明文件识别，且代码里不得再用 command -v pnpm", () => {
  const src = fnSrc("detectPackageManager", "/**\n * 市场装法下把插件包升到最新");
  const detect = new Function("fs", "path", "spawnSync", "process", `${src}; return detectPackageManager;`)(
    fs, path, () => ({ status: 1 }), process);

  const root = tmpDir();
  try {
    const a = path.join(root, "a"); fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, "pnpm-workspace.yaml"), "packages: []\n");
    assert.equal(detect(a), "pnpm", "有 pnpm-workspace.yaml → pnpm");

    const b = path.join(root, "b"); fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, "package-lock.json"), "{}");
    assert.equal(detect(b), "npm", "有 package-lock.json → npm");

    const c = path.join(root, "c"); fs.mkdirSync(c);
    assert.equal(detect(c), "pnpm", "都探测不到时兜底 pnpm（dsh profile 默认就是 pnpm）");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 源码契约：不得再用 POSIX 内建 `command -v`（Windows 走 cmd.exe，永远命中 || 分支）
  const codeLines = SETUP_SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!codeLines.some((l) => /command -v pnpm/.test(l)), "不得再用 command -v pnpm 探测");
  assert.ok(/const pm = detectPackageManager\(profileDir\);/.test(SETUP_SRC), "升级路径必须用 detectPackageManager");
});

// ─────────────── ⑥ 源码契约：策略顺序与失败即中止 ───────────────

test("源码契约：Windows 首选 junction（不用 'dir'），且每支之间清理残留", () => {
  const fn = fnSrc("ensurePluginLinked", "/**\n * 独立验收：复刻 dsh 客户端模块系统的真实动作");
  const winBranch = fn.slice(fn.indexOf('process.platform === "win32"'), fn.indexOf('["copy"'));
  assert.ok(winBranch.includes('"junction"'), "Windows 首选必须是 junction");
  assert.ok(!/"dir"/.test(winBranch), "★Windows 分支不得再尝试 symlinkSync(...,'dir')");
  assert.ok(/fs\.rmSync\(nmPlugin, \{ recursive: true, force: true \}\);\s*\}\s*catch/.test(fn) || /rmSync\(nmPlugin[^\n]*\n/.test(fn),
    "每次尝试前必须清残留（否则下一支撞 EEXIST）");
  assert.ok(/for \(const \[how, run\] of attempts\)/.test(fn), "必须是「逐支验证」的循环，而不是 try 嵌套 catch");
  assert.ok(/throw new Error\(`插件挂载失败/.test(fn), "全部失败必须抛错");
  // POSIX 行为保持不变（原生 symlink 无需特权）
  const posixBranch = fn.slice(fn.indexOf(':\n    [') >= 0 ? fn.indexOf(':\n    [') : fn.indexOf('['), fn.indexOf("const failures"));
  assert.ok(/"dir"/.test(posixBranch), "POSIX 仍用原生 symlink");
});

test("源码契约：调用方必须检查结果并在失败时中止（老代码丢返回值还报成功）", () => {
  // 调用必须被 try/catch 包住（老代码是裸调用 + 丢返回值）
  assert.ok(/try \{\s*\n\s*ensurePluginLinked\(profileDir, pluginLocalDir\);/.test(SETUP_SRC),
    "ensurePluginLinked 必须在 try 里调用（否则失败会变成未捕获异常）");
  const call = SETUP_SRC.slice(SETUP_SRC.indexOf("try {\n    ensurePluginLinked(profileDir, pluginLocalDir);"), SETUP_SRC.indexOf("const r = ensurePatchActivation"));
  assert.ok(/catch \(e\) \{[\s\S]*?process\.exit\(1\);/.test(call), "挂载失败必须 process.exit(1)");
  // 顺序（只在 activateLocalCopy 函数体内看）：挂载 → 独立验收 → 才 declarePluginDep / 写 patch
  const body = SETUP_SRC.slice(
    SETUP_SRC.indexOf("function activateLocalCopy("),
    SETUP_SRC.indexOf("function convergePluginActivation("));
  assert.ok(body.length > 0, "应能定位 activateLocalCopy");
  const order = [
    "ensurePluginLinked(profileDir, pluginLocalDir)",
    "const probe = probePluginResolve(profileDir);",
    "declarePluginDep(pkgFile);",
    "ensurePatchActivation(patchFile",
  ];
  let last = -1;
  for (const marker of order) {
    const i = body.indexOf(marker);
    assert.ok(i > last, `activateLocalCopy 内的顺序必须是：挂载 → 验收 → 依赖 → 激活（${marker}）`);
    last = i;
  }
  assert.ok(/function probePluginResolve\(/.test(SETUP_SRC), "应有独立验收（复刻 dsh 的裸包名解析）");
});

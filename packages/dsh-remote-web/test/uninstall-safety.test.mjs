/**
 * 卸载安全回归（0.6.7-beta.3 新增）—— 两个"卸载把 dsh web 弄坏"的致命缺陷。
 *
 * 缺陷一：卸载后 cordis.patch.yml 只剩注释。
 *   dsh 要求该文件顶层是**数组**，而纯注释文档的 YAML 解析结果是 `null`（不是空数组），
 *   于是 dsh 直接启动失败：
 *     `Error: dsh: overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries`
 *   官方空 profile 模板是「注释 + `[]`」，这个占位符不能省。用户卸载后 dsh web 起不来，
 *   而面板也在那个进程里 → 只能靠 CLI 自救。
 *
 * 缺陷二：卸载全链路同步执行在 dsh web 的事件循环里，且把易卡的运行时清理排在前面。
 *   一次 spawnSync 卡住（Windows 沙箱拦 schtasks；spawnSync 的 timeout 在 Windows 上不可靠，
 *   实测 18s+ 未返回）→ 真正"卸载插件"的那步永远不执行，且**整个 dsh web 僵死**
 *   （端口在听、连接建立、永不响应）。
 *
 * ⚠️ 本文件的断言对象刻意落在**可用性**上（文件还能不能被解析成数组、进程结果、响应契约），
 *    而不是"函数返回了什么"——上一轮正是因为只断言后者才漏掉了挂载缺陷。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = fs.readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8");
const CLIENT_SRC = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
const SETUP = path.join(HERE, "..", "..", "..", "dsh-setup.mjs");
const SETUP_SRC = fs.readFileSync(SETUP, "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLUGIN_ID = "dsh-remote-web";
const LEGACY_ID = "dsh-remote-ui";

/**
 * 独立复刻 dsh 的判定：顶层必须是 YAML 数组。
 * 只认**顶层（无缩进）非注释行** —— 缩进行属于上一条目；纯注释 → 结构行数为 0 → 判定不合法
 * （这正是缺陷一的形态）。刻意不引用被测实现里的同名函数，避免自证。
 */
function isTopLevelArrayDoc(text) {
  const structural = String(text).split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !/^\s*#/.test(l) && !/^[ \t]/.test(l)) // 只保留顶层非注释行
    .map((l) => l.trim());
  if (structural.length === 0) return false;
  return structural.every((l) => l === "[]" || l.startsWith("-"));
}

function boot(relayDir) {
  const routes = new Map();
  apply({
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    effect(register) { return register(); },
    logger: { info() {}, warn() {} },
  }, { relayDir });
  return routes;
}

async function serve(routes) {
  const host = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, "http://x").pathname);
    (handler || ((_r, rs) => { rs.writeHead(404); rs.end(); }))(req, res);
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  return { host, base: `http://127.0.0.1:${host.address().port}` };
}

/** 造一个装了插件的 profile：patch（标记块形式）+ 依赖 + 本地拷贝 + node_modules 链接。 */
async function plantProfile(home, { extraPatch = "", unmarked = false } = {}) {
  const profile = path.join(home, ".dsh", "profiles", "web");
  fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
  const block = unmarked
    ? `- insert:\n    - id: ${PLUGIN_ID}\n      name: '${PLUGIN_ID}'\n`
    : `# >>> ${PLUGIN_ID} (managed by dsh-remote plugin; do not edit)\n- insert:\n    - id: ${PLUGIN_ID}\n      name: '${PLUGIN_ID}'\n      config:\n        relayDir: '${path.join(home, "relay")}'\n# <<< ${PLUGIN_ID}\n`;
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), `# 空 profile 的 patch 层\n${extraPatch}${block}`);
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    dependencies: { [PLUGIN_ID]: "file:./dsh-remote-web-plugin", other: "^1.0.0" },
    dsh: { profile: { bundles: [] } },
  }, null, 2));
  const local = path.join(profile, "dsh-remote-web-plugin");
  fs.mkdirSync(path.join(local, "lib"), { recursive: true });
  fs.writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: PLUGIN_ID, version: "0.0.0" }));
  fs.writeFileSync(path.join(local, "lib", "index.js"), "export const x = 1;\n");
  fs.symlinkSync(local, path.join(profile, "node_modules", PLUGIN_ID), "dir");
  fs.mkdirSync(path.join(home, "relay"), { recursive: true });
  fs.writeFileSync(path.join(home, "relay", ".dsh-config.json"), JSON.stringify({ phone: "13800000000", password: "pw" }));
  return { profile, patchFile: path.join(profile, "cordis.patch.yml") };
}

// ─────────────────────── ① patch 占位符（缺陷一） ───────────────────────

test("对照：纯注释文档必须判为「不是顶层数组」（这正是 dsh 起不来的形态）", () => {
  assert.equal(isTopLevelArrayDoc("# 只有注释\n# 再来一行\n"), false);
  assert.equal(isTopLevelArrayDoc(""), false);
  assert.equal(isTopLevelArrayDoc("[]\n"), true);
  assert.equal(isTopLevelArrayDoc("# c\n[]\n"), true);
  assert.equal(isTopLevelArrayDoc("- insert:\n    - id: x\n      name: 'x'\n"), true, "缩进行属于条目，不能判成非法");
});

test("卸载：patch 条目被摘光后必须补回 `[]` 占位（否则 dsh web 起不来）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-safety-"));
  const prevHome = process.env.HOME;
  const prevSkip = process.env.DSH_RELAY_SKIP_SERVICE;
  process.env.HOME = home;
  process.env.DSH_RELAY_SKIP_SERVICE = "1"; // 隔离：绝不碰真实系统服务
  try {
    const { profile, patchFile } = await plantProfile(home);
    const routes = boot(path.join(home, "relay"));
    const { host, base } = await serve(routes);
    try {
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      assert.equal(r.ok, true);
      assert.equal(r.removedPatch, true, "插件引用应被摘除");

      const after = fs.readFileSync(patchFile, "utf8");
      assert.ok(!after.includes(PLUGIN_ID), "patch 里不该再有本插件：" + JSON.stringify(after));
      assert.ok(isTopLevelArrayDoc(after), "★卸载后 patch 必须仍是合法顶层数组（含 [] 占位）：" + JSON.stringify(after));
      assert.match(after, /\[\]/, "被摘空时必须补回 `[]` 占位");

      // 依赖 / 本地拷贝 / 链接也被移除（市场卸载才能接手）
      const pkg = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8"));
      assert.equal(pkg.dependencies[PLUGIN_ID], undefined);
      assert.equal(pkg.dependencies.other, "^1.0.0", "别人的依赖不得被误删");
      assert.equal(fs.existsSync(path.join(profile, "dsh-remote-web-plugin")), false);
      assert.equal(fs.existsSync(path.join(profile, "node_modules", PLUGIN_ID)), false);
    } finally {
      host.close();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.DSH_RELAY_SKIP_SERVICE; else process.env.DSH_RELAY_SKIP_SERVICE = prevSkip;
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("卸载：无标记的 `- insert:` 块（旧版/其它工具写入的形式）也要被摘掉", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-safety-unmarked-"));
  const prevHome = process.env.HOME;
  const prevSkip = process.env.DSH_RELAY_SKIP_SERVICE;
  process.env.HOME = home;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    const { patchFile } = await plantProfile(home, { unmarked: true });
    const routes = boot(path.join(home, "relay"));
    const { host, base } = await serve(routes);
    try {
      await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      const after = fs.readFileSync(patchFile, "utf8");
      // 只摘标记块是不够的：目录已删而 patch 仍引用 → dsh 插件树加载失败 → 整个 dsh web 起不来
      assert.ok(!after.includes(PLUGIN_ID), "无标记的 insert 块也必须摘掉：" + JSON.stringify(after));
      assert.ok(isTopLevelArrayDoc(after), "摘空后仍须是合法数组：" + JSON.stringify(after));
    } finally {
      host.close();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.DSH_RELAY_SKIP_SERVICE; else process.env.DSH_RELAY_SKIP_SERVICE = prevSkip;
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("卸载：别人的 patch 条目必须原样保留（不许顺手清空整份文件）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-safety-other-"));
  const prevHome = process.env.HOME;
  const prevSkip = process.env.DSH_RELAY_SKIP_SERVICE;
  process.env.HOME = home;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    const other = "- insert:\n    - id: some-other-plugin\n      name: 'other'\n";
    const { patchFile } = await plantProfile(home, { extraPatch: other });
    const routes = boot(path.join(home, "relay"));
    const { host, base } = await serve(routes);
    try {
      await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      const after = fs.readFileSync(patchFile, "utf8");
      assert.ok(after.includes("some-other-plugin"), "别人的条目必须保留：" + JSON.stringify(after));
      assert.ok(!after.includes(PLUGIN_ID), "我们的条目必须摘掉");
      assert.ok(isTopLevelArrayDoc(after));
      assert.ok(!/\[\]/.test(after), "还有条目时不该多写 `[]`（会变成 YAML 语法错误）");
    } finally {
      host.close();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.DSH_RELAY_SKIP_SERVICE; else process.env.DSH_RELAY_SKIP_SERVICE = prevSkip;
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI 卸载（dsh-remote plugin --uninstall）：同样必须留下合法数组", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-safety-cli-"));
  try {
    const { patchFile } = await plantProfile(home);
    // 用真实安装器跑一遍 CLI 卸载（隔离 HOME + 隔离开关）
    const r = spawnSync(process.execPath, [SETUP, "plugin", "--uninstall"], {
      encoding: "utf8", timeout: 60000,
      env: { ...process.env, HOME: home, DSH_RELAY_SKIP_SERVICE: "1", DSH_RELAY_DIR: path.join(home, "relay"), DSH_PROFILE_DIR: path.dirname(patchFile) },
    });
    assert.equal(r.status, 0, `CLI 卸载应成功：${r.stdout}\n${r.stderr}`);
    const after = fs.readFileSync(patchFile, "utf8");
    assert.ok(!after.includes(PLUGIN_ID), "CLI 卸载也应摘掉条目：" + JSON.stringify(after));
    assert.ok(isTopLevelArrayDoc(after), "★CLI 卸载后同样必须是合法数组：" + JSON.stringify(after));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** 本机是否有真正的 dsh CLI（CI 通常没有 → 该用例自动跳过）。 */
function dshAvailable() {
  try { return spawnSync("dsh", ["--help"], { stdio: "ignore", timeout: 20000 }).status === 0; }
  catch { return false; }
}
const HAS_DSH = dshAvailable();

/**
 * 最强的一条：把卸载结果交给**真实 dsh 解析器**判定。
 * 报告的 Fix E 正是要求这个 —— 断言对象不是"我们写了什么"，而是"dsh 能不能 compose 出插件树"
 *（compose 成功 ≈ dsh web 能启动）。另外附一条反例：纯注释文档必须被 dsh 拒绝，
 * 否则这条用例就是空断言（证明它有牙齿）。
 */
test("（需本机装有 dsh）卸载后的 patch 必须能被真实 dsh 解析：--dump-config 成功", { skip: !HAS_DSH && "本机没有 dsh CLI" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-real-"));
  const prevHome = process.env.HOME;
  const prevSkip = process.env.DSH_RELAY_SKIP_SERVICE;
  process.env.HOME = home;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  const dshHome = path.join(home, "dshhome");
  const profile = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({ name: "web", version: "0.0.0", dsh: { profile: {} } }));
  const patchFile = path.join(profile, "cordis.patch.yml");
  const comments = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries\n";
  const runDsh = () => spawnSync("dsh", ["--profile", "web", "--dump-config"], {
    encoding: "utf8", timeout: 60000, env: { ...process.env, DSH_HOME: dshHome },
  });
  try {
    // 反例（负向对照）：纯注释 → dsh 必须报错（否则本用例没有牙齿）
    fs.writeFileSync(patchFile, comments);
    const negative = runDsh();
    assert.notEqual(negative.status, 0, "纯注释文档必须被 dsh 拒绝（这就是用户遇到的启动失败）");
    assert.match(String(negative.stderr || "") + String(negative.stdout || ""), /top-level YAML array/);

    // 正向：我们的安装器写入的 patch → dsh 必须接受
    fs.writeFileSync(patchFile, `${comments}[]\n`);
    fs.mkdirSync(path.join(profile, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(profile, "node_modules", "probe"), "");
    const ok = runDsh();
    assert.equal(ok.status, 0, `安装态 patch 应能被 dsh 接受：${ok.stderr}`);

    // 关键：走一遍真实卸载（插件路由），卸载后 dsh 仍必须能 compose
    const { patchFile: installedPatch } = await (async () => {
      const { profile: p2, patchFile: pf } = await plantProfile(home);
      return { patchFile: pf };
    })();
    const routes = boot(path.join(home, "relay"));
    const { host, base } = await serve(routes);
    try {
      await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
    } finally { host.close(); }
    fs.copyFileSync(installedPatch, patchFile); // 把"卸载后的 patch"交给真实 dsh 判定
    const after = runDsh();
    assert.equal(after.status, 0, `★卸载后的 patch 必须仍能被 dsh 接受（否则 dsh web 起不来）：${after.stderr}`);
    assert.ok(isTopLevelArrayDoc(fs.readFileSync(patchFile, "utf8")));
  } finally {
    if (prevSkip === undefined) delete process.env.DSH_RELAY_SKIP_SERVICE; else process.env.DSH_RELAY_SKIP_SERVICE = prevSkip;
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────── ② 卸载顺序与阻塞（缺陷二） ───────────────────────

test("源码契约：卸载必须先卸插件、再关自愈、最后才把慢活交子进程", () => {
  const route = INDEX_SRC.slice(INDEX_SRC.indexOf('path: "/dsh-remote/self/uninstall"'), INDEX_SRC.indexOf("// ---------- 路由", INDEX_SRC.indexOf('path: "/dsh-remote/self/uninstall"')));
  const iSelf = route.indexOf("uninstallSelf(relayDir, profileDir");
  const iMark = route.indexOf("markUninstalled(relayDir)");
  const iSpawn = route.indexOf("spawnRuntimeCleanupDetached(relayDir, profileDir)");
  const iSend = route.indexOf("sendJson(res, 200");
  assert.ok(iSelf > -1 && iMark > -1 && iSpawn > -1 && iSend > -1, "应能定位四个关键步骤");
  assert.ok(iSelf < iSpawn, "★先卸插件（快、纯 fs），再交子进程做慢活 —— 旧实现顺序相反，卡住就「什么都没卸载」");
  assert.ok(iMark < iSpawn, "自愈标记必须在慢步骤之前置位，否则慢步骤期间可能被复活");
  // 兜底路径（进程内同步清理）必须在响应之后：它会阻塞事件循环，用户不能先等它
  const iFallback = route.indexOf("uninstallRuntime(relayDir, profileDir)");
  assert.ok(iFallback === -1 || iSend < iFallback, "兜底的进程内清理必须排在响应之后");
  assert.ok(!/const rt = uninstallRuntime\(relayDir, profileDir\);/.test(route), "不得再同步执行 uninstallRuntime");
  // 事件循环禁令：请求路径上不许出现同步子进程调用
  assert.ok(!/spawnSync\(/.test(route), "卸载请求路径不得出现 spawnSync（会把事件循环钉死）");
});

test("行为：响应里插件引用已经卸掉（不依赖慢步骤先跑完）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-order-"));
  const prevHome = process.env.HOME;
  const prevSkip = process.env.DSH_RELAY_SKIP_SERVICE;
  process.env.HOME = home;
  process.env.DSH_RELAY_SKIP_SERVICE = "1";
  try {
    const { patchFile } = await plantProfile(home);
    const routes = boot(path.join(home, "relay"));
    const { host, base } = await serve(routes);
    try {
      const t0 = Date.now();
      const r = await (await fetch(`${base}/dsh-remote/self/uninstall`, { method: "POST" })).json();
      const ms = Date.now() - t0;
      assert.equal(r.removedPatch, true, "响应必须已包含「插件引用已移除」");
      assert.ok(isTopLevelArrayDoc(fs.readFileSync(patchFile, "utf8")), "响应返回时 patch 必须已写好");
      assert.equal(r.runtimeCleanup, "deferred", "运行时清理应交给子进程");
      assert.ok(ms < 5000, `响应不该等运行时清理（实测 ${ms}ms）`);
    } finally {
      host.close();
    }
  } finally {
    if (prevSkip === undefined) delete process.env.DSH_RELAY_SKIP_SERVICE; else process.env.DSH_RELAY_SKIP_SERVICE = prevSkip;
    process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────── ③ 运行时清理助手 ───────────────────────

/** 从插件源码里取出助手生成函数（安装器/插件都是 CLI+ESM，import 会执行 main）。 */
function loadCleanupHelperBuilder() {
  const src = INDEX_SRC.slice(
    INDEX_SRC.indexOf("function buildRuntimeCleanupHelper("),
    INDEX_SRC.indexOf("/**\n * 把「运行时清理」交给一个 detached 子进程"));
  return new Function("osPlatform", "WIN_TASK_NAME", "WATCHER_PID_FILE", "BRIDGE_PID_FILE", "join", "homedir", "tmpdir",
    `${src}; return buildRuntimeCleanupHelper;`)(
    () => process.platform, "dsh-remote-bridge", ".dsh-watcher.pid", ".dsh-bridge.pid", path.join, os.homedir, os.tmpdir);
}

test("清理助手：生成的脚本语法合法，且每个外部命令都有 timeout（超时不能当唯一防线，但要有）", () => {
  const src = loadCleanupHelperBuilder()(path.join(os.tmpdir(), "relay-x"), path.join(os.tmpdir(), "prof-x"));
  const file = path.join(os.tmpdir(), `dsh-helper-check-${process.pid}.mjs`);
  fs.writeFileSync(file, src);
  try {
    const chk = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(chk.status, 0, `生成的清理助手语法必须合法：${chk.stderr}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
  // 外部命令一律经 run(cmd, args, timeout)
  const calls = src.match(/run\("[a-z]+", \[[^\]]*\], (\d+)\)/g) || [];
  assert.ok(calls.length >= 2, `应通过 run(...) 调外部命令（实际 ${calls.length} 处）`);
  assert.ok(!/spawnSync\("[a-z]+", \[[^\]]*\](?!, \{)/.test(src), "不得有裸 spawnSync（缺 timeout）");
  assert.ok(/DSH_RELAY_SKIP_SERVICE === "1"/.test(src), "助手必须遵守测试隔离开关（否则用例会动到真实服务）");
});

test("清理助手：真跑一遍 → 结束 pid 文件里的进程并清空配置目录", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-helper-"));
  const relayDir = path.join(home, "relay");
  fs.mkdirSync(relayDir, { recursive: true });
  fs.writeFileSync(path.join(relayDir, ".dsh-config.json"), JSON.stringify({ phone: "x", password: "y" }));
  // 用一个真实存活的长命进程当"残留 bridge"
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(relayDir, ".dsh-bridge.pid"), String(sleeper.pid));
  const src = loadCleanupHelperBuilder()(relayDir, path.join(home, "prof"));
  const helper = path.join(home, "helper.mjs");
  fs.writeFileSync(helper, src);
  try {
    // 注意：这里**不**设隔离开关，用来验证真实的 kill 路径；
    // 但 HOME 已指向临时目录 → 自启动 plist 路径落在临时目录、不存在 → 不会碰真实 launchd。
    // 显式去掉隔离开关：本用例要验证**真实**的 kill 路径；HOME 指向临时目录保证不碰真实服务
    const env = { ...process.env, HOME: home };
    delete env.DSH_RELAY_SKIP_SERVICE;
    const r = spawnSync(process.execPath, [helper], { encoding: "utf8", timeout: 30000, env });
    assert.equal(r.status, 0, `助手应正常退出：${r.stderr}`);
    assert.equal(fs.existsSync(relayDir), false, "★配置目录必须被清空");
    assert.equal(fs.existsSync(path.join(relayDir, ".dsh-config.json")), false);
    // pid 文件里的进程应被结束
    let alive = true;
    for (let i = 0; i < 40; i += 1) {
      try { process.kill(sleeper.pid, 0); } catch { alive = false; break; }
      await sleep(50);
    }
    assert.equal(alive, false, "★pid 文件里记录的残留进程必须被结束");
  } finally {
    try { sleeper.kill("SIGKILL"); } catch { /* 已退出 */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("清理助手：护栏命中时绝不删 profile（relayDir 误配成 profile 的兜底）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-un-helper-guard-"));
  const profile = path.join(home, "prof");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), "{}");
  const src = loadCleanupHelperBuilder()(profile, profile); // relayDir === protectedPath
  const helper = path.join(home, "helper.mjs");
  fs.writeFileSync(helper, src);
  try {
    spawnSync(process.execPath, [helper], { encoding: "utf8", timeout: 30000, env: { ...process.env, HOME: home, DSH_RELAY_SKIP_SERVICE: "1" } });
    assert.equal(fs.existsSync(path.join(profile, "package.json")), true, "★护栏命中：profile 必须完好");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─────────────────────── ④ Windows ACL 收紧（mode 0600 是空操作） ───────────────────────

test("安全：三处机密写入都要显式收紧 ACL（Windows 上 mode 0o600 无效）", () => {
  for (const [label, src, callSites] of [
    ["安装器", SETUP_SRC, [/hardenFile\(CONFIG_PATH\)/]],
    ["插件半", INDEX_SRC, [/hardenFile\(configPathOf\(relayDir\)\)/, /hardenFile\(join\(relayDir, HARNESS_COOKIE_FILE\)\)/]],
    ["bridge", fs.readFileSync(path.join(HERE, "..", "..", "..", "clients", "dsh-remote", "dsh-bridge.mjs"), "utf8"), [/hardenFile\(CONFIG_PATH\)/]],
  ]) {
    assert.ok(/function hardenFile\(file\)/.test(src), `${label} 应有 hardenFile`);
    assert.ok(/icacls/.test(src) && /inheritance:r/.test(src), `${label} 必须在 Windows 上断开继承并只授权当前用户`);
    assert.ok(/process\.platform !== "win32"/.test(src), `${label} 非 Windows 走 chmod 即可`);
    for (const re of callSites) assert.ok(re.test(src), `${label} 的机密写入点必须调用 hardenFile：${re}`);
  }
});

test("安全：hardenFile 在非 Windows 上只 chmod（不引入任何子进程，零副作用）", () => {
  const src = SETUP_SRC.slice(SETUP_SRC.indexOf("function hardenFile(file)"), SETUP_SRC.indexOf("// ---------- 配置读写 ----------"));
  const calls = [];
  const fakeSpawn = () => { calls.push("spawn"); return { status: 0 }; };
  const fakeFs = { ...fs, chmodSync: (f, m) => { calls.push(`chmod:${m.toString(8)}`); } };
  const harden = new Function("fs", "spawnSync", "process", "hardenWarned", `${src}; return hardenFile;`)(fakeFs, fakeSpawn, process, false);
  const file = path.join(os.tmpdir(), `dsh-harden-${process.pid}.tmp`);
  fs.writeFileSync(file, "x");
  try {
    harden(file);
    if (process.platform !== "win32") {
      assert.deepEqual(calls, ["chmod:600"], `非 Windows 只应 chmod 600，实际 ${JSON.stringify(calls)}`);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ─────────────────────── ⑤ 前端：请求超时 ───────────────────────

test("前端：任何请求都有超时上界（node 半僵死时不再永久转圈）", () => {
  assert.ok(/var API_TIMEOUT_MS = \d+/.test(CLIENT_SRC), "应有默认请求超时");
  assert.ok(/AbortController/.test(CLIENT_SRC), "应通过 AbortController 实现超时");
  assert.ok(/postWithTimeout\("\/dsh-remote\/self\/uninstall"/.test(CLIENT_SRC), "卸载这类可能拖住的操作应使用更短超时");
  assert.ok(/请求超时/.test(CLIENT_SRC), "超时后必须给用户一句能照做的话");
  assert.ok(/clearTimeout\(timer\)/.test(CLIENT_SRC), "请求结束必须清掉定时器（否则泄漏）");
});

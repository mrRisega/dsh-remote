/**
 * 桌面端（DeepSeek Harness Desktop / Electron）适配回归。
 *
 * 背景：DeepSeek Harness 于 2026-09-29 发布桌面端 v0.2 预览（Electron 薄壳 + 完整 dsh Web Host，
 * Host 以 `--no-open --port 0` 启动，端口随机、每进程令牌鉴权）。dsh-remote 的两大难点
 * （随机端口、会话 Cookie）此前已因真实事故适配过，因此这次新增的适配**集中在三处**：
 *
 *   ① **Electron 宿主下 process.execPath 不是 node**：它是 Electron 应用二进制。
 *      直接 `spawn(process.execPath, [script])` 得到的不是"跑脚本的 node"，而是**又开一个桌面端应用**
 *      （还会撞桌面端单实例锁）。必须补 `ELECTRON_RUN_AS_NODE=1` —— 官方桌面端自己也正是这么做的
 *      （其内置 CLI 就是 `ELECTRON_RUN_AS_NODE=1 exec <Electron> --expose-internals <cli.js>`）。
 *   ② **自启动服务里的解释器必须活过桌面应用的退出与更新**：`.app` 路径会变、可能被换掉，
 *      所以"真实 node 优先，找不到才回落 Electron 自身（并带上 ① 的变量）"。
 *   ③ **重启语义不同**：桌面端 Host 由 Electron 托管，插件杀掉它会触发桌面端**原生致命恢复弹窗**，
 *      用户观感是"应用崩了"。故 restartHarness 在 Electron 宿主下**有意拒绝**并如实说明，
 *      面板据此不摆一个点了必然失败的按钮。
 *
 * ⚠️ 这些分支无法在开发机上"真装一个桌面端"来跑，所以本用例用两种手段：
 *   · 对纯函数（spawnEnv / resolveProfileDir）用**行为断言**（切片 eval，注入宿主相关常量）；
 *   · 对散落在多文件的模板与分支用**锚点不变量**（跨文件必须同构，防漂移）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "lib", "index.js"), "utf8").replace(/\r\n/g, "\n");
const CLIENT_SRC = readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8").replace(/\r\n/g, "\n");
const SETUP_SRC = readFileSync(path.join(HERE, "..", "..", "..", "dsh-setup.mjs"), "utf8").replace(/\r\n/g, "\n");

// ─────────────── ① 子进程环境：Electron 宿主必须补 ELECTRON_RUN_AS_NODE ───────────────

/**
 * 以给定的宿主形态构造一个真实的 spawnEnv 并调用它。
 * 切片只含 spawnEnv 函数体，故它引用的模块级常量/工具必须显式注入。
 *
 * ⚠️ 必须注入 **process 桩**（2026-10-09）：`spawnEnv` 的第一件事是 `...process.env`，
 *   而这个套件**是在 DSH 宿主里跑的** —— 从桌面端应用内跑 `npm run test:plugin` 时，
 *   环境里天然带着 `ELECTRON_RUN_AS_NODE=1`（那正是"宿主是 Electron"的标志）。
 *   于是"Web 版绝不得注入这个变量"那条断言会读到**宿主自己的**变量而必红 ——
 *   可被测代码其实一个字节都没往 env 里加。注入干净环境后，这条用例检验的才是插件的行为
 *   （而不是"运行测试的这台机器是不是桌面端"）。
 *
 * @param {object} selfNodeEnv 该宿主形态下 SELF_NODE_ENV 的值
 * @param {object} [extra] 调用方业务变量
 * @param {object} [sourceEnv] 宿主进程环境（默认干净：只含 PATH）
 */
function makeSpawnEnv(selfNodeEnv, extra, sourceEnv) {
  const start = INDEX_SRC.indexOf("function spawnEnv(extra)");
  const end = INDEX_SRC.indexOf("function safeSpawn(");
  assert.ok(start > 0 && end > start, "切片锚点失效：spawnEnv / safeSpawn 结构变了");
  const src = INDEX_SRC.slice(start, end);
  const make = new Function("SELF_NODE_ENV", "isWindows", "delimiter", "dirname", "process", "path",
    `${src}\nreturn spawnEnv;`);
  const processStub = { env: sourceEnv ?? { PATH: "/usr/bin:/bin" }, execPath: "/usr/bin/node" };
  return make(selfNodeEnv, () => false, path.posix.delimiter, path.posix.dirname, processStub, path.posix)(extra);
}

test("桌面端：Electron 宿主下 spawnEnv 必须注入 ELECTRON_RUN_AS_NODE=1", () => {
  const env = makeSpawnEnv({ ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1",
    "缺这个变量时 spawn(process.execPath, [script]) 会变成'又开一个桌面端应用'，bridge/watcher 永远起不来");
});

test("Web 版（真实 node）：绝不得注入 ELECTRON_RUN_AS_NODE（不能污染既有环境）", () => {
  const env = makeSpawnEnv({});
  assert.ok(!("ELECTRON_RUN_AS_NODE" in env),
    "非 Electron 宿主下注入该变量会污染子进程环境、并让 node 版本探测类工具困惑");
});

test("Web 版：宿主环境**已经带着** ELECTRON_RUN_AS_NODE 时，最终 env 与宿主逐键一致（插件没加料）", () => {
  // 这条是上面那条的补充（2026-10-09）：上面那条断言"结果里没有这个键"，在 Electron 宿主里
  // 跑测试时**天然不成立**（键来自宿主 process.env）。真正的判据是"插件有没有往 env 里加料"，
  // 故这里显式把宿主环境造成带这个变量，验证：最终 env **逐键等于宿主环境 + PATH 调整**，
  // 一个多余的键都没有（`{}` 展开是恒等）。这样这条用例在任何宿主里都恒真且有意义。
  const hostEnv = { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", HOME: "/Users/tester" };
  const env = makeSpawnEnv({}, undefined, hostEnv);
  const expectedPath = ["/usr/bin", "/usr/bin:/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  assert.deepEqual(env, { ...hostEnv, PATH: expectedPath },
    "除 PATH 外不得新增/删除/改动任何键（否则就是插件在污染子进程环境）");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1", "宿主自己的值原样透传，不算插件注入");
});

test("spawnEnv：NODE_INTERPRETER 变量不得挤掉调用方的业务变量，PATH 仍按平台分隔符拼接", () => {
  const env = makeSpawnEnv({ ELECTRON_RUN_AS_NODE: "1" }, { DSH_BRIDGE_INSTALL_SOURCE: "npx" });
  assert.equal(env.DSH_BRIDGE_INSTALL_SOURCE, "npx", "业务变量必须仍能覆盖");
  assert.ok(env.PATH.includes(path.delimiter), "PATH 必须用平台分隔符（写死 ':' 会让 Windows 上 node/npx 全找不到）");
});

// ─────────────── ② 服务定义：plist / systemd 必须带上解释器变量（跨文件同构）───────────────

test("跨文件不变量：插件与安装器的 plist / systemd 模板都必须带解释器变量占位", () => {
  // 为什么是"两份都要查"：历史上前述两份模板漂移过、并因此各造成一个真机事故
  // （插件每次自愈都会重写 plist，谁写谁说了算 → 漂移等于把另一份正确的覆盖掉）。
  for (const [name, src] of [["lib/index.js", INDEX_SRC], ["dsh-setup.mjs", SETUP_SRC]]) {
    assert.match(src, /const SERVICE_NODE_ENV\b/, `${name}: 必须有 SERVICE_NODE_ENV`);
    assert.match(src, /<key>PATH<\/key><string>\$\{SERVICE_PATH\}<\/string>\$\{SERVICE_NODE_ENV_PLIST\}/,
      `${name}: plist 的 EnvironmentVariables 必须紧跟 PATH 注入 SERVICE_NODE_ENV_PLIST`);
    // ⚠️ systemd 模板两种写法都要认：lib/index.js 是多行模板（真换行），
    //    dsh-setup.mjs 是单行模板（字面量 `\n`）。只认其中一种就会漏掉另一份 —— 那正是"漂移"本身。
    assert.match(src, /Environment=PATH=\$\{SERVICE_PATH\}(?:\n|\\n)\$\{SERVICE_NODE_ENV_UNIT\}Environment=DSH_BRIDGE/,
      `${name}: systemd unit 必须在 PATH 之后注入 SERVICE_NODE_ENV_UNIT`);
  }
});

test("桌面端：真实 node 存在时服务定义必须优先登记它（.app 路径会随更新失效）", () => {
  for (const [name, src] of [["lib/index.js", INDEX_SRC], ["dsh-setup.mjs", SETUP_SRC]]) {
    assert.match(src, /electron: IS_ELECTRON_HOST/,
      `${name}: 解释器解析结果必须显式标注"是不是 Electron 二进制"（服务定义据此决定要不要补变量）`);
  }
  // 安装器额外要求：把"当前可执行文件"归一化后再比对，避免 symlink/node@20 造成误判
  assert.match(SETUP_SRC, /const selfReal = resolveExecutable\(process\.execPath\)/,
    "dsh-setup.mjs: 必须归一化自身可执行文件再判断是否为 Electron 本体");
});

// ─────────────── ③ 重启语义：桌面端必须拒绝，且如实说明 ───────────────

test("桌面端：restartHarness 在 Electron 宿主下**行为级**拒绝（不靠源码字符串）", async () => {
  // 为什么需要行为级：源码锚点（下面那条）只能证明"代码里写了"，证明不了"跑起来真的是这个结果"。
  // 注入 IS_ELECTRON_HOST=true、skipsSystemOps=false（模拟**生产**：
  // 桌面端下 DSH_RELAY_SKIP_SERVICE 不会设置，故必须走到 Electron 守卫而不是被测试隔离短路）。
  const start = INDEX_SRC.indexOf("async function restartHarness(");
  const end = INDEX_SRC.indexOf("async function relayFetch(");
  assert.ok(start > 0 && end > start, "切片锚点失效：restartHarness 结构变了");
  const src = INDEX_SRC.slice(start, end);
  // 只注入守卫之前会被求值的两个依赖；函数体其余部分不会被走到（守卫提前 return），
  // 故其引用的模块级标识符无需注入（new Function 只在**执行**时才解析标识符）。
  const make = new Function("IS_ELECTRON_HOST", "skipsSystemOps", `${src}\nreturn restartHarness;`);
  const restartHarness = make(true, () => false);
  const r = await restartHarness("/tmp/does-not-matter");
  assert.equal(r.ok, false, "桌面端重启必须如实返回失败，不得假装成功");
  assert.equal(r.status, "desktop-managed", "面板据该状态改文案，不能是通用错误");
  assert.equal(r.mode, "desktop");
  assert.match(r.detail, /退出并重新打开/, "必须告诉用户正确做法");
  // 对照组：非 Electron 宿主**不得**走这条分支（否则 Web 版重启会被误禁）
  const restartWeb = make(false, () => true); // skipsSystemOps=true 模拟测试隔离，避免真的重启
  const rw = await restartWeb("/tmp/does-not-matter");
  assert.notEqual(rw.status, "desktop-managed", "Web 版绝不能返回桌面端状态");
});

test("桌面端：restartHarness 必须拒绝重启 Host，并返回可识别的 desktop-managed 状态", () => {
  // 切片终点用 restartHarness **之后**的下一个顶层函数（buildRestartHelperSource 在它之前，不能用）
  const fn = INDEX_SRC.slice(INDEX_SRC.indexOf("async function restartHarness("),
    INDEX_SRC.indexOf("async function relayFetch("));
  assert.ok(fn.length > 0, "切片锚点失效：restartHarness 找不到了");
  assert.match(fn, /if \(IS_ELECTRON_HOST\)/, "必须先有 Electron 宿主守卫");
  assert.match(fn, /status: "desktop-managed"/, "必须返回可识别状态（面板据此换文案、不摆失败按钮）");
  assert.match(fn, /退出并重新打开 DeepSeek Harness/, "必须如实告诉用户正确做法");
  // 守卫必须在真正生成重启脚本**之前**：否则仍会写脚本、动 launchd
  assert.ok(fn.indexOf("if (IS_ELECTRON_HOST)") < fn.indexOf("const cmd = selfCommand();"),
    "守卫必须早于 selfCommand()/脚本生成");
});

test("桌面端：状态接口必须下发宿主形态，面板才能自适应", () => {
  assert.match(INDEX_SRC, /desktopHost: IS_ELECTRON_HOST,/, "composeStatus 必须下发 desktopHost");
  assert.match(INDEX_SRC, /restartSupported: !IS_ELECTRON_HOST,/, "必须下发 restartSupported");
});

test("桌面端：面板不得自动倒计时重启，且不摆点了必然失败的重启按钮", () => {
  assert.match(CLIENT_SRC, /var desktopHost = !!\(st && st\.desktopHost\)/, "面板必须读 desktopHost");
  assert.match(CLIENT_SRC, /isRestartHard \|\| desktopHost \|\| busy !== ""/,
    "自动倒计时重启必须在桌面端短路（Host 由 Electron 托管，不能替用户重启）");
  assert.match(CLIENT_SRC, /\(desktopHost && !isRefreshOnly\) \? null : h\("button"/,
    "桌面端且非'刷新即可'时不得渲染重启按钮");
  // 旧版 host 不下发该字段 → undefined → 行为必须与改动前一致
  assert.match(CLIENT_SRC, /\? "🔄 插件已更新：重启 dsh web 后生效"[\s\S]{0,40}: "🔄 插件已更新：刷新页面即可生效"\);/,
    "非桌面端文案必须保留原有判据 isRestartHard（不得顺手改发布版文案）");
});

test("桌面端：面板文案改为引导'退出并重开应用'，且不影响 Web 版", () => {
  assert.match(CLIENT_SRC, /退出并重新打开 DeepSeek Harness 后生效/, "桌面端要有明确引导");
  assert.match(CLIENT_SRC, /桌面端由应用本身托管运行环境/, "底部常驻按钮位置要有桌面端说明");
});

// ─────────────── ④ 安装：--profile desktop 必须真的生效 ───────────────

/**
 * 用安装器切片构造真实的 resolveProfileDir（注入 os / path / process，伪造 HOME 与空环境）。
 *
 * ⚠️ 必须注入 **process 桩**（2026-10-09）：`resolveProfileDir` 的第二来源是
 *   `process.env.DSH_PROFILE_DIR`，而这个测试套件**是在 DSH 宿主里跑的** ——
 *   从桌面端应用内跑 `npm run test:plugin` 时，环境里天然带着
 *   `DSH_PROFILE_DIR=/Users/<me>/.dsh/profiles/desktop`，于是"缺省仍是 Web 版"那条断言
 *   会读到真实 HOME 下的 desktop，**在任何装了桌面端的机器上必红**（假红，且指向错误结论）。
 *   注空环境 = 这条用例从此只验证被测逻辑，不受宿主环境影响。
 */
function makeResolveProfileDir(home) {
  const start = SETUP_SRC.indexOf("const KNOWN_PROFILE_NAMES");
  const end = SETUP_SRC.indexOf("function warnIfDesktopProfile");
  assert.ok(start > 0 && end > start, "切片锚点失效：profile 解析函数结构变了");
  const src = SETUP_SRC.slice(start, end);
  const osStub = { homedir: () => home };
  const processStub = { env: {} };
  const make = new Function("os", "path", "process", `${src}\nreturn { resolveProfileDir, profileArgvOf, isDesktopProfileDir, profileDirOfName };`);
  return make(osStub, path, processStub);
}

test("安装器：--profile desktop 解析到桌面端 profile 目录，不再是相对路径/被忽略", () => {
  const { resolveProfileDir, isDesktopProfileDir } = makeResolveProfileDir("/Users/tester");
  assert.equal(resolveProfileDir(["--profile", "desktop"]), path.join("/Users/tester", ".dsh", "profiles", "desktop"));
  assert.ok(isDesktopProfileDir(resolveProfileDir(["--profile", "desktop"])), "必须能识别出这是桌面端 profile");
  // 老行为必须原样保留
  assert.equal(resolveProfileDir(["--profile", "web"]), path.join("/Users/tester", ".dsh", "profiles", "web"));
  assert.equal(resolveProfileDir(["--profile", "/custom/dir"]), "/custom/dir", "任意路径仍原样当目录用");
  assert.equal(resolveProfileDir([]), path.join("/Users/tester", ".dsh", "profiles", "web"), "缺省仍是 Web 版");
});

test("安装器：setup() 必须把 --profile 透传给插件挂载步骤", () => {
  const { profileArgvOf } = makeResolveProfileDir("/Users/tester");
  assert.deepEqual(profileArgvOf(["--profile", "desktop"]), ["--profile", "desktop"]);
  assert.deepEqual(profileArgvOf([]), [], "未指定时不得凭空塞参数");
  // 事故面：setup() 原本调 pluginCmd([]) → --profile desktop 被静默忽略、插件装进 web profile
  assert.match(SETUP_SRC, /pluginCmd\(profileArgvOf\(argv\)\)/, "setup 必须透传 profile 选择");
  assert.ok(!/pluginCmd\(\[\]\)/.test(SETUP_SRC), "不得再有硬编码空参数（会把 --profile 吞掉）");
});

test("安装器：desktop profile 未初始化时给桌面端专属引导（不得照抄 Web 版的 npx 说法）", () => {
  // 用定长切片而不是尾部锚点：这段逻辑就在 pluginCmd 开头，之后的结构变化不该让用例变脆。
  const start = SETUP_SRC.indexOf("async function pluginCmd(");
  assert.ok(start > 0, "切片锚点失效：pluginCmd 找不到了");
  const fn = SETUP_SRC.slice(start, start + 2500);
  assert.match(fn, /isDesktopProfileDir\(profileDir\)/, "必须区分桌面端 profile");
  assert.match(fn, /启动一次 DeepSeek Harness 应用/, "必须给桌面端专属引导：profile 由应用自己创建");
  assert.match(fn, /完全退出应用/, "必须提醒完全退出（应用独占 profile，运行中安装不会被装载）");
  // 事故面：桌面端 profile 由 Electron 应用初始化，npm 版 dsh 明确拒绝管理它
  //（apps/cli 的 rejectElectronProfile）—— 照抄 Web 版那句会让用户白折腾。
  assert.ok(!/未找到 dsh web profile/.test(fn), "不得再把桌面端统一报成 'dsh web profile'");
});

// ─────────────── ⑤ 桌面端自带 Node：跨平台候选（Windows 用 node.exe）───────────────

test("桌面端自带 Node 的候选：跨平台 + 命中官方真实布局 + 稳定落点优先", () => {
  for (const [name, src] of [["lib/index.js", INDEX_SRC], ["dsh-setup.mjs", SETUP_SRC]]) {
    assert.match(src, /function desktopRuntimeNodeCandidates\(\)/, `${name}: 必须有候选构造器`);
    // 真实布局（2026-10-07 拆官方 0.2.0-rc.2 DMG 实测）：
    //   …/Resources/runtime/primary-runtime/dependencies/node/bin/node  （Node v24.21.0）
    assert.match(src, /"dependencies", "node", "bin"/,
      `${name}: 必须命中官方真实布局 dependencies/node/bin（猜错路径等于没这个候选）`);
    assert.match(src, /DSH_DESKTOP_NODE_EXECUTABLE/,
      `${name}: 必须采信应用自报的 node 路径（平台无关，比猜路径可靠）`);
    assert.match(src, /\.\.\.desktopRuntimeNodeCandidates\(\)/,
      `${name}: 必须真的并入解释器候选（不是死代码）`);
  }

  // 行为断言：注入平台与 HOME，验证真实产出（而不是只查字符串）
  const start = SETUP_SRC.indexOf("function desktopRuntimeNodeCandidates()");
  const end = SETUP_SRC.indexOf("function preferredNode()");
  assert.ok(start > 0 && end > start, "切片锚点失效：候选构造器结构变了");
  const src = SETUP_SRC.slice(start, end);
  const make = new Function("process", "os", "path", `${src}\nreturn desktopRuntimeNodeCandidates;`);
  const home = path.join(path.sep, "Users", "tester");
  const win = make({ platform: "win32", env: {} }, { homedir: () => home }, path)();
  const mac = make({ platform: "darwin", env: {} }, { homedir: () => home }, path)();

  assert.ok(win.length > 0 && win.every((p) => p.endsWith("node.exe")),
    `Windows 候选必须都是 node.exe（否则永远解析不到解释器），实际 ${JSON.stringify(win)}`);
  assert.ok(mac.length > 0 && mac.every((p) => p.endsWith("node")),
    `POSIX 候选必须都是 node，实际 ${JSON.stringify(mac)}`);
  // 稳定落点优先：首条必须落在用户目录，且命中官方真实布局
  assert.ok(mac[0].startsWith(home),
    `首条候选必须在用户目录（要活过桌面端更新），实际 ${mac[0]}`);
  assert.ok(mac[0].endsWith(path.join("dependencies", "node", "bin", "node")),
    `首条候选必须是官方真实布局 dependencies/node/bin/node，实际 ${mac[0]}`);
  // 会随桌面端更新失效的 .app 路径只能当后手
  assert.ok(!mac[0].startsWith("/Applications"),
    "不得把 .app 内部路径排在稳定落点之前（桌面端一升级自启动就失效）");
});

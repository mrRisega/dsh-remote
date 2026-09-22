/**
 * macOS 自启动（launchd）契约测试（node:test，零框架）。
 *
 * 背景：用户（macOS 26.1）反馈自启动服务登记后**从未被派生**（`runs = 0`），
 * 安装脚本报「自启动服务启动失败：服务未在运行」。根因：
 *   ① macOS 26 会把 `gui/<uid>` domain 置于 on-demand-only 模式，`RunAtLoad` / `KeepAlive`
 *      全部失效（只登记不派生）；系统日志：`pending spawn, domain in on-demand-only mode`。
 *      迁到 `user/<uid>` domain（并带 `LimitLoadToSessionType`）才能恢复派生与崩溃自愈。
 *   ② 旧实现 `bootstrap` 后**立刻** `print` 一次就判定失败 —— launchd 派生是异步的。
 *   ③ 从不调用 `launchctl kickstart`，所以被挂起时没有任何东西会把它拉起来。
 *   ④ plist 的 PATH 缺 `/usr/sbin`、`/sbin`，bridge 日志里刷 `ioreg: command not found`。
 *
 * 本机实测（macOS 14.4.1，同机验证）：
 *   · `bootstrap user/501 <plist 无 LimitLoadToSessionType>` → rc=5 `Input/output error`
 *   · 带 `[Aqua, Background]` 后：user/501 与 gui/501 都装载成功且 `runs = 1`
 *   · user/501 下 `kill -9` 后 launchd 自动重建 → `runs = 2`（KeepAlive 真生效）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dsh-setup.mjs");
const src = readFileSync(SETUP, "utf8");
/** 插件半边也会写同一份 plist —— 两份模板必须一致（谁写谁说了算）。 */
const INDEX_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "index.js"), "utf8");

test("launchd 修复：plist 必须带 LimitLoadToSessionType（user domain 的必要条件）", () => {
  assert.match(
    src,
    /<key>LimitLoadToSessionType<\/key><array><string>Aqua<\/string><string>Background<\/string><\/array>/,
    "缺该键时 user/<uid> bootstrap 直接 EIO(rc=5);macOS 26 上它也是恢复派生的前提"
  );
  // RunAtLoad / KeepAlive 仍需保留：user domain 下它们才真正生效
  assert.match(src, /<key>RunAtLoad<\/key><true\/>/, "RunAtLoad 不能删（user domain 下靠它开机自启）");
  assert.match(src, /<key>KeepAlive<\/key><true\/>/, "KeepAlive 不能删（user domain 下靠它崩溃自愈）");
  // ★ 插件那份模板**也**必须有：它每次自愈/启动都会重写 plist（谁写谁说了算）。
  //   真机实证 2026-09-22：插件模板漏了它 → bootstrap user/<uid> 失败 → 回退 gui/<uid> →
  //   macOS 26 上该域 on-demand-only、KeepAlive 失效 → 服务被系统回收后再也回不来，
  //   现场表现就是「自启动服务偶尔整个消失，连 kickstart 都报域里找不到该服务」。
  assert.match(
    INDEX_SRC,
    /<key>LimitLoadToSessionType<\/key><array><string>Aqua<\/string><string>Background<\/string><\/array>/,
    "★插件半边的 plist 模板也必须有 LimitLoadToSessionType（否则它会覆盖掉安装器那份正确的）"
  );
  assert.match(INDEX_SRC, /<key>KeepAlive<\/key><true\/>/, "插件模板也要保留 KeepAlive");
});

test("launchd 修复：启动走 user → gui 阶梯，且每次都 kickstart", () => {
  assert.ok(/function startBridgeDarwin/.test(src), "应有专门的 darwin 启动阶梯函数");
  const fn = src.slice(src.indexOf("function startBridgeDarwin"), src.indexOf("function restartBridgeService"));
  // 首选 user domain（macOS 26 上唯一支持自启动语义的 domain）
  assert.ok(/for \(const domain of \[`user\/\$\{uid\}`, `gui\/\$\{uid\}`\]\)/.test(fn), "应为 user → gui 的阶梯顺序");
  assert.ok(/launchctl kickstart -k/.test(fn), "bootstrap 只是登记,必须 kickstart 才能确保这次起来");
  // 清掉另一个 domain 的残留，避免两处并存跑出两个 bridge
  assert.ok(/bootout \$\{d\}\/\$\{BRIDGE_LABEL\}/.test(fn), "切换到某 domain 时应清掉另一 domain 的历史注册");
  // 终极兜底：launchd 托管不了也要保证「现在能用」
  assert.ok(/spawnDetachedBridge/.test(fn), "launchd 不可用时应退化为后台进程兜底");
  assert.ok(/degraded-detached/.test(fn), "兜底状态要与完全失败区分开");
});

test("launchd 修复：不再只 print 一次就判定失败（异步派生必须轮询）", () => {
  assert.ok(/function waitLaunchdRunning/.test(src), "应有轮询等待函数");
  const fn = src.slice(src.indexOf("function launchdState"), src.indexOf("function spawnDetachedBridge"));
  assert.ok(/for \(let i = 0; i < tries; i \+= 1\)/.test(fn), "应循环轮询而非单次检查");
  assert.ok(/sleepSync\(gapMs\)/.test(fn), "轮询之间要真正等待");
  assert.ok(/tries = 20/.test(fn), "总等待时长应足够 launchd 完成异步派生");
  // 必须能识别「登记了但从未派生」这一 macOS 26 特征，才能给出正确建议而不是干等
  assert.ok(/pended nondemand spawn/.test(fn) && /on-demand-only/.test(fn), "应识别 on-demand-only 挂起特征");
});

test("launchd 修复：被挂起后靠 kickstart 起来时，不得报成完全成功", () => {
  assert.ok(/selfHealing/.test(src), "应回报是否具备崩溃自愈能力");
  assert.ok(/本机 launchd 处于 on-demand-only/.test(src), "安装输出要如实说明不支持崩溃自愈");
  const summary = src.slice(src.indexOf("const svcFragile"), src.indexOf("const L = [];"));
  assert.ok(/svcFragile/.test(summary), "汇总里应区分「可自愈」与「仅拉起一次」");
});

test("launchd 修复：服务 PATH 必须含 /usr/sbin 与 /sbin（否则 ioreg 找不到）", () => {
  const m = src.match(/const SERVICE_PATH = "([^"]+)"/);
  assert.ok(m, "应集中定义 SERVICE_PATH");
  for (const dir of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    assert.ok(m[1].split(":").includes(dir), `PATH 缺少 ${dir}`);
  }
  // plist 与 systemd unit 都必须用这个常量，不能各写各的
  assert.ok(/\$\{SERVICE_PATH\}/.test(src), "plist/systemd 应使用 SERVICE_PATH 常量");
  assert.ok(!/Environment=PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/.test(src), "systemd unit 不应再写死旧 PATH");
});

test("★ 两份 plist 模板的 PATH 必须一致（插件那份曾漏掉 /usr/sbin，覆盖掉正确的那份）", () => {
  // 真机实证（2026-09-22）：插件半边在 plist 模板里**硬编码**了不含 /usr/sbin 的 PATH，
  // 而它每次自愈/启动都会重写 plist → 覆盖掉 dsh-setup.mjs 里正确的那份 →
  // bridge 日志刷 `/bin/sh: ioreg: command not found` → 机器指纹静默退化成 hostname 哈希。
  const setupPath = /const SERVICE_PATH = "([^"]+)"/.exec(src);
  const pluginPath = /const SERVICE_PATH = "([^"]+)"/.exec(INDEX_SRC);
  assert.ok(setupPath, "dsh-setup.mjs 应定义 SERVICE_PATH");
  assert.ok(pluginPath, "插件半边也必须定义 SERVICE_PATH（它也会写 plist）");
  assert.equal(pluginPath[1], setupPath[1], "★两处 PATH 必须逐字一致：同一个 plist 谁写谁说了算");

  // 插件写 plist 时必须用它，不能再硬编码
  assert.ok(/\$\{SERVICE_PATH\}/.test(INDEX_SRC), "插件的 plist 模板必须使用 SERVICE_PATH");
  assert.ok(!/<key>PATH<\/key><string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/.test(INDEX_SRC),
    "插件不得再硬编码不含 /usr/sbin 的 PATH");
  // spawnEnv 拉起的是 watcher → 它会再拉起 bridge → 也必须能用到系统管理命令
  for (const dir of ["/usr/sbin", "/sbin"]) {
    assert.ok(INDEX_SRC.includes(`"${dir}"`), `spawnEnv 的 posixDirs 也应含 ${dir}`);
  }
});

test("★ 被监管者(launchd)拉起的实例不得因『已有游离守护』而秒退", () => {
  // 真机事故链：KeepAlive 重拉 → 本进程发现 pid 文件里已有游离守护 → 秒退
  //   → 监管者判为崩溃并节流（`launchctl print` = `state = spawn scheduled`）
  //   → 插件自愈认定"服务坏了" → bootout 摘作业（入口判定成立时连 plist 一起删）
  //   → **自启动彻底消失，`launchctl kickstart` 报"域里找不到该服务"**。
  const from = src.indexOf("function dedupDecision(");
  assert.ok(from > -1, "应能找到 dedupDecision");
  const body = src.slice(from, src.indexOf("function writeWindowsTask("));
  assert.ok(body.length > 0, "切片边界应正确");
  const decide = new Function(`${body}\nreturn dedupDecision;`)();

  assert.equal(decide({ existingPid: 123, selfPid: 456, supervisor: "com.dshremote.bridge" }), "takeover",
    "★被监管者拉起时必须接管，绝不能退出（否则自启动会被监管者与自愈联手摘掉）");
  assert.equal(decide({ existingPid: 123, selfPid: 456, supervisor: "" }), "yield",
    "手动/插件脱离进程拉起时仍必须让位（两个 bridge 会抢同一设备登记）");
  assert.equal(decide({ existingPid: 0, selfPid: 456, supervisor: "" }), "run", "没有别的守护 → 正常跑");
  assert.equal(decide({ existingPid: 456, selfPid: 456, supervisor: "" }), "run", "pid 就是自己 → 正常跑");
  assert.equal(decide({ existingPid: null, selfPid: 456, supervisor: "" }), "run");

  // 接管路径的接线：判据用监管者注入的 XPC_SERVICE_NAME；动那个 pid 之前必须先认命令行
  const rb = src.slice(src.indexOf("async function runBridge()"), src.indexOf("// ---------- setup"));
  assert.ok(rb.length > 0, "应能切出 runBridge");
  assert.match(rb, /XPC_SERVICE_NAME/, "必须用监管者注入的 XPC_SERVICE_NAME 作判据");
  assert.match(rb, /looksLikeWatcher\(other\)/, "★接管前必须确认那个 pid 真的是 watcher（pid 会被回收给无关进程）");
  assert.match(rb, /dedupDecision\(/, "决策必须走 dedupDecision（保证被判为活代码且可测）");
});

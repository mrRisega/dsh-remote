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

test("launchd 修复：plist 必须带 LimitLoadToSessionType（user domain 的必要条件）", () => {
  assert.match(
    src,
    /<key>LimitLoadToSessionType<\/key><array><string>Aqua<\/string><string>Background<\/string><\/array>/,
    "缺该键时 user/<uid> bootstrap 直接 EIO(rc=5);macOS 26 上它也是恢复派生的前提"
  );
  // RunAtLoad / KeepAlive 仍需保留：user domain 下它们才真正生效
  assert.match(src, /<key>RunAtLoad<\/key><true\/>/, "RunAtLoad 不能删（user domain 下靠它开机自启）");
  assert.match(src, /<key>KeepAlive<\/key><true\/>/, "KeepAlive 不能删（user domain 下靠它崩溃自愈）");
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

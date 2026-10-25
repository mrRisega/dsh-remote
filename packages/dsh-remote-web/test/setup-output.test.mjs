/**
 * 安装脚本输出契约测试(node:test,零框架)。
 *
 * 背景:安装输出一度太长且重复 —— 同一段「下一步: 打开 dsh web → 设置 → 远程控制」
 * 在插件阶段和结尾汇总各打印一遍,「已创建自启动服务」也打印两遍;更糟的是 dsh web
 * 没开时只甩一句「自启动服务启动失败」,用户以为安装坏了(其实是正常状态:bridge 依赖
 * dsh web,dsh web 没开时它起来即退)。
 *
 * 这里盯三条边界:
 *  ① 输出里「下一步」引导只出现一次(去重不靠人眼);
 *  ② dsh web 未运行 + bridge 未跑 → 明确说明"打开 dsh web 后会自动启动",且不出现
 *     「启动失败」这种误导措辞;
 *  ③ dsh web 在运行但 bridge 没跑 → 是真的异常,必须给出原因与日志路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, "..", "..", "..", "dsh-setup.mjs");

const src = readFileSync(SETUP, "utf8");

test("测试隔离：unset 系统操作开关的用例必须同时伪造 HOME（否则污染真实自启动）", () => {
  // 故障回顾:harness-restart 用例 unset DSH_RELAY_SKIP_SERVICE 去走真实分支,
  // 但没伪造 HOME → 插件写 plist 的路径是 join(homedir(), "Library/LaunchAgents/…"),
  // 于是把**指向测试临时目录**的 plist 覆盖到开发者真实的 ~/Library/LaunchAgents,
  // 临时目录随即被删 → 真实 bridge 自启动彻底失效(本机实测踩到,macOS 26 用户反馈排查时发现)。
  // 静态护栏:凡 unset 该开关的用例,文件里必须出现 process.env.HOME =。
  const rows = readdirSync(HERE).filter((f) => f.endsWith(".test.mjs"));
  const offenders = [];
  for (const f of rows) {
    const text = readFileSync(join(HERE, f), "utf8");
    if (/delete process\.env\.DSH_RELAY_SKIP_SERVICE/.test(text) && !/process\.env\.HOME\s*=/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `这些用例会碰真实 HOME(必须伪造 HOME): ${offenders.join(", ")}`);
  // 反向确认:护栏本身确有保护对象,否则是空断言
  const guarded = rows.filter((f) => /delete process\.env\.DSH_RELAY_SKIP_SERVICE/.test(readFileSync(join(HERE, f), "utf8")));
  assert.ok(guarded.length >= 3, `应至少有 3 个用例走真实分支(实际 ${guarded.length})`);
});

test("安装输出:拼接汇总时「下一步」引导只有一处文案源(不再多处重复打印)", () => {
  // 引导语只由汇总的 L.push 产出:自建 / 热挂载 / 需重启 / 普通 四个**互斥**分支,
  // 运行时只可能走其中一条 → 用户始终只看到一条引导。
  const pushes = src.match(/L\.push\("   下一步[:：]/g) || [];
  assert.equal(pushes.length, 4, `「下一步」应只由汇总的 4 个互斥分支产出(实际 ${pushes.length} 处)`);
  // 源码里不得再有其它直接打印引导的地方
  const direct = src.match(/console\.log\((?!.*L\.join)[^)]*下一步/g) || [];
  assert.equal(direct.length, 0, "除汇总外不得再直接打印引导");
  // 插件阶段不得再打印用户引导
  const converge = src.slice(src.indexOf("function convergePluginActivation"), src.indexOf("async function pluginCmd"));
  assert.ok(!/下一步|打开 dsh web → 设置/.test(converge), "插件阶段不应再重复打印引导");
  // 互斥性:这些分支必须挂在同一条 if/else-if 链上,否则可能同时打出两条引导
  const chain = src.slice(src.indexOf("} else if (hotMounted) {"), src.indexOf('L.push("\\n" + L.join'));
  assert.ok(chain.length > 0, "应能定位到引导分支链");
  assert.ok(/else if \(needRestart && restartResult/.test(chain), "热挂载与需重启必须在同一条 else-if 链上");
  assert.ok(/else if \(needRestart\)/.test(chain), "兜底的手动重启分支也必须在同一条链上");
});

test("安装输出:「已创建自启动服务」路径只在汇总里打印一次", () => {
  const createMsgs = src.match(/已创建自启动服务/g) || [];
  assert.equal(createMsgs.length, 0, "创建路径不再单独打印(汇总里统一展示),避免同一信息两遍");
  assert.ok(/自启动服务: \$\{svc\.path/.test(src), "汇总里应展示自启动服务路径");
});

test("安装输出:dsh web 未运行时的措辞 —— 说明会自动启动,且不出现「启动失败」误导", () => {
  assert.ok(/async function isDshWebUp/.test(src), "应探测 dsh web 是否在运行(127.0.0.1:3080)");
  const block = src.slice(src.indexOf("const webUp = await isDshWebUp();"));
  // 未运行分支必须明说"会自动启动"
  assert.ok(/dsh web 当前没有运行/.test(block), "未运行分支应直说检测结果");
  assert.ok(/自动启动，无需任何命令/.test(block), "未运行分支应说明何时自动启动");
  assert.ok(/不是安装出错/.test(block), "未运行分支应明确否定「安装出错」");
  // 未运行分支的**用户可见文案**里不能出现「失败」(真失败分支才有)
  const notUpBranch = block.slice(block.indexOf("if (!st.ok && !webUp)"), block.indexOf("} else if (!st.ok) {"));
  // 只看 L.push(...) 的实参(注释里的说明文字不算用户可见文案)
  const texts = (notUpBranch.match(/L\.push\((\s*)"([^"]*)"/g) || [])
    .map((m) => (m.match(/"([^"]*)"/) || [])[1]).join("\n");
  assert.ok(texts.length > 0, "该分支应有用户可见文案");
  assert.ok(!/失败/.test(texts), `dsh web 未运行≠bridge 启动失败,该分支文案不得出现「失败」:\n${texts}`);
});

test("安装输出:真失败(dsh web 在运行但 bridge 没起来)必须给原因与日志路径", () => {
  const block = src.slice(src.indexOf("const webUp = await isDshWebUp();"));
  const failBranch = block.slice(block.indexOf("else if (!st.ok)"), block.indexOf("if (selfHosted) {", block.indexOf("else if (!st.ok)")));
  assert.ok(/bridge 未能启动/.test(failBranch), "真失败分支要明说未能启动");
  assert.ok(/\.dsh-bridge\.log/.test(failBranch), "真失败分支要给出日志路径供排查");
});

test("安装输出:跳过/不支持自启动时不得自相矛盾地显示「运行中」", () => {
  const block = src.slice(src.indexOf("const webUp = await isDshWebUp();"));
  // 三态判定必须存在:未安装 与 运行中/未运行 分开
  assert.ok(/const svcSkipped = st\.status === "skipped"/.test(block), "应识别 skipped/unsupported/无路径三态");
  assert.ok(/未安装（本次显式跳过）/.test(block), "显式跳过要说清是跳过");
  assert.ok(/未安装（当前平台不支持自启动）/.test(block), "平台不支持要说清原因");
  // 跳过分支的文案里不能出现「运行中」
  const skippedBranch = block.slice(block.indexOf("if (svcSkipped) {"), block.indexOf("} else if (!st.ok && !webUp) {"));
  const texts = (skippedBranch.match(/L\.push\((`[^`]*`|"[^"]*")/g) || []).join("\n");
  assert.ok(!/运行中/.test(texts), `未安装自启动服务时不得声称「运行中」:\n${texts}`);
  // 未安装时也不该承诺「打开 dsh web 就会自动启动」(那是自启动服务在管)
  assert.ok(!/自动启动/.test(texts), "未安装自启动服务时不得承诺自动启动");
});

test("安装输出:服务状态字符串仍是插件面板可解析的稳定契约", () => {
  // 插件半按 running / 未运行 解析,不能因为排版调整改约定
  assert.ok(/\? `✅ 运行中/.test(src), "running 约定保留(带 pid)");
  assert.ok(/`未运行 \(\$\{st\.detail \|\| st\.status\}\)`/.test(src), "未运行约定保留(带原因)");
});

test("版本比较：预设版 < 同号正式版；beta.10 < beta.11（更新提示不能误判）", () => {
  // 故障背景：面板原本用 `latest !== current` 判断"有没有新版本"，于是
  // ① 0.6.4-beta.11 与 0.6.4-beta.10 无法比大小；② 正式版 0.6.4 发布后，
  // 装了 0.6.4-beta.11 的人反而被当成"落后"（其实预设版 semver 低于正式版）。
  const src = readFileSync(join(HERE, "..", "lib", "index.js"), "utf8");
  const fnSrc = src.slice(src.indexOf("function compareVersions(a, b)"), src.indexOf("/** 以 detached 子进程执行"));
  const compare = new Function(`${fnSrc}; return compareVersions;`)();
  // semver §11：预设版低于同号正式版
  assert.equal(compare("0.6.4-beta.11", "0.6.4"), -1, "预设版应低于同号正式版");
  assert.equal(compare("0.6.4", "0.6.4-beta.11"), 1, "正式版应高于同号预设版");
  // 预设版之间按数字标识符比较（不是字符串比较）
  assert.equal(compare("0.6.4-beta.11", "0.6.4-beta.10"), 1, "beta.11 > beta.10");
  assert.equal(compare("0.6.4-beta.10", "0.6.4-beta.9"), 1, "beta.10 > beta.9");
  assert.equal(compare("0.6.4-beta.10", "0.6.4-beta.10"), 0);
  // 正式版之间
  assert.equal(compare("0.6.5", "0.6.4"), 1);
  assert.equal(compare("0.7.0", "0.6.9"), 1);
  assert.equal(compare("0.6.4", "0.6.4"), 0);
  // 解析不了 → null（调用方退回保守判断）
  assert.equal(compare("weird", "0.6.4"), null);
  // 路由必须用严格大于判断 outdated
  assert.match(src, /const cmp = compareVersions\(latest, current\)/, "update-check 应用 semver 比较");
  assert.match(src, /cmp === null \? Boolean\(latest && latest !== current\) : cmp > 0/);
});

test("★ 插件覆盖必须原子：staging → 必需文件自检 → rename 切换（2026-09-26「dsh 起不来」故障）", () => {
  // 故障：旧实现 `rmSync(dest)` → `cpSync(pluginDir, dest)`，于是拷贝期间 dest 是"半个插件"：
  //   dsh 恰在此刻启动 → package.json 已声明 bundle，但 cordis.patch.yml 还没拷到 →
  //   `failed to read overlay … cordis.patch.yml: ENOENT` → **整个 GUI 起不来**。
  //   时间证据：dsh 报错 23:46:03，cordis.patch.yml 写完 23:46:05（差 2 秒）。
  const reqFn = src.slice(src.indexOf("const PLUGIN_REQUIRED_FILES"), src.indexOf("function copyPluginIntoProfile"));
  for (const f of ["package.json", "lib/index.js", "lib/client.js", "cordis.patch.yml"]) {
    assert.match(reqFn, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `必需文件清单缺 ${f}（缺了就又会出现"半个插件"）`);
  }
  const fn = src.slice(src.indexOf("function copyPluginIntoProfile"), src.indexOf("function ensurePluginLinked"));
  assert.match(fn, /\.staging-/, "必须先拷到 staging（全程不碰 dest）");
  assert.match(fn, /missingPluginFiles\(stage\)/, "🔴 切换前必须自检必需文件");
  assert.ok(fn.indexOf("missingPluginFiles(stage)") < fn.indexOf("renameSync(stage, dest)"),
    "🔴 自检必须发生在 rename 切换**之前**");
  assert.match(fn, /renameSync\(dest, backup\)/, "旧版本要先挪成 backup");
  assert.match(fn, /renameSync\(backup, dest\)/, "切换失败必须把 backup 改回来（旧版仍可用）");
  // 反向锁：绝不允许回到"先 rm dest、再 cpSync 逐文件"的旧写法
  assert.ok(!/fs\.rmSync\(dest,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\);\s*\n\s*fs\.cpSync\(/.test(fn),
    "🔴 不得再出现「先删 dest 再原地逐文件拷贝」——那正是这次故障的成因");
  assert.match(fn, /\.staging-\$\{process\.pid\}|\.staging-/, "被强杀留下的 staging 要能清理");
});

test("★ 插件拷贝必须保留**自带的 runtime/node_modules**（ws 是桥唯一的裸依赖）", () => {
  // 2026-10-10 故障形态：过滤规则写的是"任何一段叫 node_modules 就剔除"，
  // 本意只想去掉插件自己的依赖目录（那些由 profile 的包管理器管），
  // 却把 `runtime/node_modules/ws` 一起剔了 —— 而这份运行时正是"只有插件半"的机器
  // **自愈补装时的唯一来源**。剔掉它 → 自愈出来的运行环境缺 ws
  // （bridge 顶层 `import WebSocket from "ws"`）→ 一启动就崩，而且自检还说"已就绪"。
  const src = readFileSync(SETUP, "utf8");
  const i = src.indexOf("const cpOpts = {");
  assert.ok(i > 0, "应能定位 cpOpts");
  const j = src.indexOf("};", i);
  const objSrc = src.slice(i, j + 2);
  const pluginDir = "/some/node_modules/dsh-remote-web";   // 源本身就在 node_modules 之下（历史坑）
  const path = require$path();
  // eslint-disable-next-line no-new-func
  const make = new Function("path", "pluginDir", `${objSrc}\nreturn cpOpts;`);
  const cpOpts = make(path, pluginDir);
  const keep = (p) => cpOpts.filter(p) === true;

  assert.equal(keep(pluginDir), true, "插件根目录本身必须保留");
  assert.equal(keep(path.join(pluginDir, "lib", "index.js")), true, "普通文件必须保留");
  // ① 自带运行时的 node_modules **必须保留**（本次修复的核心）
  assert.equal(keep(path.join(pluginDir, "runtime", "node_modules")), true, "runtime/node_modules 必须保留");
  assert.equal(keep(path.join(pluginDir, "runtime", "node_modules", "ws", "package.json")), true,
    "★ runtime/node_modules/ws 必须被拷进 profile —— 否则自愈出来的运行环境起不来");
  // ② runtime 之外的 node_modules 仍然要剔除（profile 的包管理器管那部分）
  assert.equal(keep(path.join(pluginDir, "node_modules", "foo", "index.js")), false,
    "runtime 之外的依赖目录仍应剔除（避免把解析器裁决权抢过来）");
  // ③ 垃圾照旧剔除
  assert.equal(keep(path.join(pluginDir, ".git", "config")), false, ".git 必须剔除");
  assert.equal(keep(path.join(pluginDir, "lib", ".DS_Store")), false, ".DS_Store 必须剔除");
});

/** 只在本用例里用到的 path 注入（避免为一行断言引入模块级 require 语义）。 */
function require$path() {
  return { join: (...a) => a.join("/"), sep: "/", relative: (from, to) => to.startsWith(from + "/") ? to.slice(from.length + 1) : to };
}

test("★ launchd bootout 后必须等 label 摘干净再 bootstrap（否则随机 5: Input/output error）", () => {
  // 2026-10-11 实测：bootout 是**异步**的，紧接着 bootstrap 同一个 label 大约一半次数失败 →
  // 失败后走 spawnDetachedBridge() 兜底 → 用户看到"⚠️ 未被系统托管 / 不会开机自启"。
  // 手工在两条命令之间加 sleep 就 100% 成功 —— 所以这里必须有"等到摘干净"的轮询。
  const src = readFileSync(SETUP, "utf8");
  assert.match(src, /function waitLaunchdGone\(/, "必须有 waitLaunchdGone（等 label 从 launchd 摘干净）");
  const start = src.indexOf("function startBridgeDarwin(");
  const end = src.indexOf("function restartBridgeService(");
  assert.ok(start > 0 && end > start, "应能定位 startBridgeDarwin");
  const fn = src.slice(start, end);
  const bootoutAt = fn.indexOf("launchctl bootout ${target}");
  const waitAt = fn.indexOf("waitLaunchdGone(target)");
  const bootAt = fn.indexOf("launchctl bootstrap ${domain}");
  assert.ok(bootoutAt > 0 && waitAt > 0 && bootAt > 0, "bootout / waitLaunchdGone / bootstrap 三者都要在");
  assert.ok(bootoutAt < waitAt && waitAt < bootAt,
    "顺序必须是 bootout → waitLaunchdGone → bootstrap（差一步就会随机失败）");
  // 失败重试：摘除竞态可能还没结束，要能再试一次，而不是直接掉进脱离进程兜底
  assert.match(fn, /bootok|!boot\.ok[\s\S]{0,400}launchctl bootstrap/, "bootstrap 失败应重试一次再兜底");
});

test("★ 自启动配置**默认不钉**上游端口；仅在 DSH_BRIDGE_PIN_UPSTREAM=1 时显式 opt-in", () => {
  // 2026-10-25 事故：把安装时的动态端口写进 launchd plist 后，dsh 每次重启换端口，
  // 守护/桥就永远连旧端口（upstream_unreachable / 设备掉线）。所以默认改为不钉。
  const src = readFileSync(SETUP, "utf8");
  assert.match(src, /function desktopAppPort\(/, "要有桌面端端口探测（lsof -c DeepSeek）");
  assert.match(src, /DSH_BRIDGE_PIN_UPSTREAM/, "要有显式 opt-in 开关（部署方需要固定上游时用）");
  // plist 模板仍支持写 DSH_BRIDGE_UPSTREAM（opt-in 时），但默认 PINNED_UPSTREAM 必须为空
  assert.match(src, /DSH_BRIDGE_UPSTREAM<\/key><string>\$\{PINNED_UPSTREAM\}/,
    "opt-in 时 plist 仍要能写入 DSH_BRIDGE_UPSTREAM");
  // 关键回归锁：安装流程里不能再出现「把探测到的端口赋给 PINNED_UPSTREAM」
  assert.doesNotMatch(src, /PINNED_UPSTREAM = `http:\/\/127\.0\.0\.1:\$\{p\}`/,
    "不得再把动态端口回填进 PINNED_UPSTREAM（否则又会写进 plist，dsh 换端口即掉线）");
  // 运行时端口仍必须写进 .dsh-upstream（守护/桥按它取最新端口）
  assert.match(src, /UPSTREAM_FILE\)[^\n]*\n/);
  const writeFileAt = src.indexOf("fs.writeFileSync(path.join(CONFIG_DIR, UPSTREAM_FILE)");
  const svcAt = src.indexOf("svc = installAutostart()");
  assert.ok(writeFileAt > 0 && svcAt > 0 && writeFileAt < svcAt, "运行时端口文件要在 installAutostart() 之前写好");
});

test("★ 桌面应用在运行时，绝不改写它的 profile（否则应用会自己退出/重启）", () => {
  // 2026-10-11 故障：在应用运行中改写 ~/.dsh/profiles/desktop/ 的插件文件 →
  // 应用随即自己退出/重启（用户："怎么又触发了 dsh 的关闭"）。安装器文案早就写了"先完全退出应用"，
  // 但必须由程序强制，不能靠人记得。
  const src = readFileSync(SETUP, "utf8");
  assert.match(src, /function dshDesktopAppRunning\(/, "要有「桌面应用是否在运行」的探测");
  assert.match(src, /Contents\/MacOS\/DeepSeek/, "探测要匹配 App 包内可执行文件（-x DeepSeek 匹配不到，实测）");
  // 必须在真正写 profile **之前**判断
  const loopAt = src.indexOf("for (const t of targets) {");
  const guardAt = src.indexOf("dshDesktopAppRunning()", loopAt);
  const applyAt = src.indexOf("await pluginApplyTo(", loopAt);
  assert.ok(loopAt > 0 && guardAt > loopAt && applyAt > guardAt,
    "顺序必须是：循环 → 应用在运行？→ 跳过；否则才 pluginApplyTo()");
  // 2026-10-24：应用在运行时不再只是"跳过"，而是把插件更新**暂存**，由 bridge 在应用退出后自动安装。
  assert.match(src, /stagePluginUpdateForProfile\(/, "应用在运行时必须暂存插件更新（否则一键更新永远装不上桌面端）");
  assert.match(src, /\.plugin-update-pending\.json/, "暂存要写 marker 供 bridge 落地");
  assert.match(src, /退出 DeepSeek Harness 后会自动安装/, "要如实告诉用户：退出应用后自动安装、重开生效");
  assert.match(src, /应用内「插件」页安装/, "要给出官方替代路径（应用内插件页）");
  assert.match(src, /"--force"/, "要留 --force 逃生口");
  // sync-local 脚本同样要保护（本机同步最常用）
  const sync = readFileSync(join(HERE, "..", "..", "..", "scripts", "sync-local.mjs"), "utf8");
  assert.match(sync, /function dshDesktopAppRunning\(/, "本机同步脚本也要有同样的保护");
  assert.match(sync, /跳过插件半/, "要明确说「只跳过插件半」（桥半不受影响）");
  assert.match(sync, /--force-plugin/, "要留逃生口");
});

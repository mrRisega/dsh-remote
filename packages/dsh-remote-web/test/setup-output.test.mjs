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

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, "..", "..", "..", "dsh-setup.mjs");

const src = readFileSync(SETUP, "utf8");

test("安装输出:拼接汇总时「下一步」引导只有一处文案源(不再多处重复打印)", () => {
  // 引导语只由汇总的 L.push 产出:selfHosted 与非自建各一条(互斥分支,用户只会看到一条)
  const pushes = src.match(/L\.push\("   下一步[:：]/g) || [];
  assert.equal(pushes.length, 2, `「下一步」应只由汇总的 2 个互斥分支产出(实际 ${pushes.length} 处)`);
  // 源码里不得再有其它直接打印引导的地方
  const direct = src.match(/console\.log\((?!.*L\.join)[^)]*下一步/g) || [];
  assert.equal(direct.length, 0, "除汇总外不得再直接打印引导");
  // 插件阶段不得再打印用户引导
  const converge = src.slice(src.indexOf("function convergePluginActivation"), src.indexOf("async function pluginCmd"));
  assert.ok(!/下一步|打开 dsh web → 设置/.test(converge), "插件阶段不应再重复打印引导");
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

test("安装输出:服务状态字符串仍是插件面板可解析的稳定契约", () => {
  // 插件半按 running / 未运行 解析,不能因为排版调整改口径
  assert.ok(/\? `✅ 运行中/.test(src), "running 口径保留(带 pid)");
  assert.ok(/`未运行 \(\$\{st\.detail \|\| st\.status\}\)`/.test(src), "未运行口径保留(带原因)");
});

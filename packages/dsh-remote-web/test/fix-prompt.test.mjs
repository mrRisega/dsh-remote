/**
 * 「连接卡住 → 一键修复提示词 + 结论报告」契约测试（node:test，零框架）。
 *
 * 背景（真实事故，2026-09-23，Windows 用户）：
 *   插件面板卡在「连接阶段: starting（正在启动 Bridge…）」，手机端看不到任何设备，反复修都没用。
 *   事后定位到三种机制（半装运行环境 / 守护活着没起作用 / bridge 起来就崩），它们在面板上长得一模一样，
 *   面板侧诊断分不开；只能由用户本机的 agent 在自己电脑上取证。
 *   所以面板给用户一段可一键复制的中文提示词，并要求回传一份**固定格式**的报告。
 *
 * 这份用例锁死提示词的**可执行性与边界**，而不是文风：
 *   ① 六步齐备且顺序正确（第一步读日志、最后一步出报告），每步都有「验证」；
 *   ② 三条判据各自依赖的关键路径/命令都要出现在文案里（日志、lifecycle.mjs、ws、端口、守护、状态文件）；
 *   ③ 隐私红线：脱敏示例、禁止贴手机号/密码/token、禁止删除 ~/.dsh-remote；
 *   ④ 报告格式固定：模板首行就是标题，六个字段齐全，「修复结果」只允许已修复/未修复；
 *   ⑤ buildFixPrompt() 无参不崩、任何情况下不出现 undefined，传入 ctx 的值真的进了文案。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_LOG_FILE,
  BRIDGE_STATE_FILE,
  DEFAULT_RELAY_DIR,
  DEFAULT_UPSTREAM_PORT,
  FIX_PROMPT,
  INSTALL_LOG_FILE,
  REPORT_FORMAT,
  REPORT_KEYS,
  REPORT_TITLE,
  UPSTREAM_FILE,
  buildFixPrompt,
} from "../lib/fix-prompt.js";

/** 默认 ctx 渲染出来的提示词（无参调用的结果）。 */
const DEFAULT_PROMPT = buildFixPrompt();

test("提示词覆盖两份日志：既有默认值，也支持面板传入的绝对路径", () => {
  // 默认值（占位符之外必须写明默认位置，否则用户找不到日志）
  assert.ok(FIX_PROMPT.includes(`~/.dsh-remote/${BRIDGE_LOG_FILE}`), "模板里应写明 bridge 日志的默认位置");
  assert.ok(FIX_PROMPT.includes(`~/.dsh-remote/${INSTALL_LOG_FILE}`), "模板里应写明安装日志的默认位置");
  assert.ok(DEFAULT_PROMPT.includes(`~/.dsh-remote/${BRIDGE_LOG_FILE}`), "无参渲染后应含 bridge 日志默认路径");
  assert.ok(DEFAULT_PROMPT.includes(`~/.dsh-remote/${INSTALL_LOG_FILE}`), "无参渲染后应含安装日志默认路径");
  // 面板上报的真实路径（Windows 形态）必须原样出现，且不能再留占位符
  const prompt = buildFixPrompt({
    bridgeLogPath: "C:\\Users\\u\\.dsh-remote\\.dsh-bridge.log",
    installLogPath: "C:\\Users\\u\\.dsh-remote\\.dsh-setup-install.log",
  });
  assert.ok(prompt.includes("C:\\Users\\u\\.dsh-remote\\.dsh-bridge.log"), "传入的 bridge 日志路径应出现在提示词里");
  assert.ok(prompt.includes("C:\\Users\\u\\.dsh-remote\\.dsh-setup-install.log"), "传入的安装日志路径应出现在提示词里");
  assert.ok(!prompt.includes("{{"), `渲染后不应残留占位符: ${prompt.match(/\{\{[^}]*\}\}/g)}`);
});

test("六步齐备且顺序正确，每一步都要求 agent 自己验证", () => {
  // 用「第 N 步 ·」定位标题（正文里会出现「需按第 3 步核实」这类交叉引用，不能只匹配「第 N 步」）
  const marks = ["第 1 步 ·", "第 2 步 ·", "第 3 步 ·", "第 4 步 ·", "第 5 步 ·", "第 6 步 ·"];
  let last = -1;
  for (const m of marks) {
    const at = DEFAULT_PROMPT.indexOf(m);
    assert.ok(at > last, `${m} 应存在且顺序在 ${marks[marks.indexOf(m) - 1] || "开头"} 之后`);
    last = at;
  }
  // 每步都要有「验证:」小节（6 步各自验证，而不是最后统一看一眼）
  const checks = DEFAULT_PROMPT.match(/验证[:：]/g) || [];
  assert.ok(checks.length >= 6, `每一步都应自带验证要求（实际 ${checks.length} 处）`);
  // 第 1 步必须是读日志，第 6 步必须是出报告
  assert.match(DEFAULT_PROMPT.slice(DEFAULT_PROMPT.indexOf("第 1 步 ·"), DEFAULT_PROMPT.indexOf("第 2 步 ·")), /日志/);
  assert.match(DEFAULT_PROMPT.slice(DEFAULT_PROMPT.indexOf("第 6 步 ·")), /报告/);
});

test("第 2 步：运行环境完整性清单（lifecycle.mjs / dsh-bridge.mjs / ws）与重新补装命令", () => {
  assert.ok(DEFAULT_PROMPT.includes("clients/dsh-remote/src/lifecycle.mjs"), "必须点名 lifecycle.mjs（① 号机制缺的就是它）");
  assert.ok(DEFAULT_PROMPT.includes("clients/dsh-remote/dsh-bridge.mjs"), "必须点名 dsh-bridge.mjs");
  assert.ok(DEFAULT_PROMPT.includes("node_modules/ws"), "必须点名 node_modules/ws（缺 ws = bridge 起来就崩）");
  assert.ok(/dsh-setup\.mjs/.test(DEFAULT_PROMPT), "必须点名 dsh-setup.mjs 是否在（半装的判据）");
  assert.ok(DEFAULT_PROMPT.includes("Cannot find module"), "应给出半装的典型报错原文，便于对号入座");
  assert.ok(DEFAULT_PROMPT.includes("npx @mrrisega/dsh-remote"), "缺失时应指导用一键安装器补装");
  assert.ok(/node --check/.test(DEFAULT_PROMPT), "补装后要求自己做语法/加载验证");
});

test("第 3 步：核对 dsh web 实际监听端口（netstat / --port / .dsh-upstream / 3080）", () => {
  assert.ok(DEFAULT_PROMPT.includes("netstat -ano | findstr LISTENING"), "Windows 要给出 netstat 查监听端口");
  assert.ok(DEFAULT_PROMPT.includes("--port"), "要提示看 dsh web 启动命令里的 --port");
  assert.ok(DEFAULT_PROMPT.includes(`~/.dsh-remote/${UPSTREAM_FILE}`) || DEFAULT_PROMPT.includes(UPSTREAM_FILE), "要读 .dsh-upstream 端口文件");
  assert.ok(DEFAULT_PROMPT.includes(String(DEFAULT_UPSTREAM_PORT)), "要写明默认端口 3080 只是回退值");
  assert.ok(DEFAULT_PROMPT.includes("DSH_BRIDGE_UPSTREAM"), "端口不一致时应给出显式覆盖上游地址的手段");
  // 端口不一致 → 按实际端口修正并重启 bridge
  assert.match(DEFAULT_PROMPT, /不一致[^]{0,200}重启 bridge/);
});

test("第 4 步：能识别「守护活着但没起作用」，并结束卡死守护后重新拉起", () => {
  assert.ok(DEFAULT_PROMPT.includes("dsh-setup.mjs run"), "要给出守护进程的命令行形态");
  assert.ok(DEFAULT_PROMPT.includes("活着但没起作用"), "要显式命名②号机制的现场特征");
  assert.ok(DEFAULT_PROMPT.includes("taskkill /PID <pid> /T /F"), "Windows 要用 taskkill 连子进程一起收");
  assert.ok(/\bkill <pid>/.test(DEFAULT_PROMPT), "macOS/Linux 要给出 kill（并有 kill -9 兜底）");
  assert.ok(DEFAULT_PROMPT.includes("kill -9"), "不退出时的兜底信号应写明");
  assert.match(DEFAULT_PROMPT, /taskkill[\s\S]{0,400}\bkill <pid>/, "两种平台的结束方式应写在一起（用户不一定在哪个系统上）");
});

test("第 5 步：以 .dsh-bridge-state.json 的 device_id + phase=online 收口，并要求如实回报", () => {
  assert.ok(DEFAULT_PROMPT.includes(`~/.dsh-remote/${BRIDGE_STATE_FILE}`), "状态文件的默认路径必须出现");
  assert.ok(DEFAULT_PROMPT.includes("device_id"), "要看 device_id（设备身份是否落盘）");
  assert.ok(DEFAULT_PROMPT.includes("online"), "phase=online 是唯一成功判据");
  assert.ok(DEFAULT_PROMPT.includes("last_error"), "没通时要摘 last_error 原文");
  assert.match(DEFAULT_PROMPT, /没修好也要照实写/, "必须允许并鼓励如实报告失败");
});

test("隐私红线：脱敏示例、禁止凭据/贴文件内容、禁止删 ~/.dsh-remote", () => {
  assert.ok(DEFAULT_PROMPT.includes("138****0000"), "必须给出手机号掩码示例");
  assert.match(DEFAULT_PROMPT, /不得[\s\S]{0,80}(手机号|密码|token)/, "必须明文禁止把凭据写进报告");
  assert.ok(/密码/.test(DEFAULT_PROMPT) && /token/i.test(DEFAULT_PROMPT) && /bridge_secret/.test(DEFAULT_PROMPT), "手机号/密码/token/bridge_secret 都要点名");
  assert.ok(DEFAULT_PROMPT.includes("JWT") && /cookie/i.test(DEFAULT_PROMPT), "JWT 与 cookie 也要点名");
  assert.match(DEFAULT_PROMPT, /不要删除/, "必须明确不要删除运行环境目录");
  assert.match(DEFAULT_PROMPT, /不要删除[^]{0,60}账号与设备身份/, "要给出「删了就丢账号/设备身份」的理由");
  assert.match(DEFAULT_PROMPT, /不要把用户的文件内容、会话内容/, "禁止把用户文件/会话内容贴进报告");
  assert.ok(/已隐去/.test(DEFAULT_PROMPT), "token/密钥应统一写成 <已隐去>");
  // 反向：提示词不得示范真实凭据形态
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{8,}/.test(DEFAULT_PROMPT), "提示词本身不得出现形似真实 token 的串");
});

test("报告格式：REPORT_KEYS 六个字段齐全，REPORT_FORMAT 首行即固定标题", () => {
  for (const key of ["症状", "机制判定", "关键证据", "已做的修复", "修复结果", "仍需人工处理"]) {
    assert.ok(REPORT_KEYS.includes(key), `REPORT_KEYS 应覆盖「${key}」`);
  }
  assert.equal(REPORT_KEYS.length, 6, "REPORT_KEYS 就是这六项（多了会让解析口径漂移）");
  assert.equal(REPORT_FORMAT.split("\n")[0], REPORT_TITLE, "报告模板首行必须是固定标题");
  assert.equal(REPORT_TITLE, "=== dsh-remote 诊断结论 ===");
  // 六项在模板里都要有对应行，且顺序与 REPORT_KEYS 一致
  const positions = REPORT_KEYS.map((k) => REPORT_FORMAT.indexOf(k + ":"));
  assert.ok(positions.every((p) => p >= 0), "六项都要在模板里有 <字段>: 行");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "模板字段顺序应与 REPORT_KEYS 一致");
  // 机制判定四选一 + 修复结果二选一（机器解析靠这两个枚举）
  assert.match(REPORT_FORMAT, /①半装运行环境[\s\S]*②守护活着没起作用[\s\S]*③bridge 起来就崩[\s\S]*其它/);
  assert.match(REPORT_FORMAT, /修复结果: 已修复 \| 未修复/);
  // 报告模板本身也要进提示词，并要求放进围栏里、标题在围栏内第一行
  assert.ok(DEFAULT_PROMPT.includes(REPORT_FORMAT), "提示词里应内嵌完整报告模板");
  assert.match(DEFAULT_PROMPT, /```[\s\S]*=== dsh-remote 诊断结论 ===/, "模板应被要求放进 ``` 围栏且标题是围栏内第一行");
});

test("buildFixPrompt() 无参不崩、任何字段缺省都不出现 undefined；传入 ctx 的值真的进文案", () => {
  assert.equal(typeof DEFAULT_PROMPT, "string");
  assert.ok(DEFAULT_PROMPT.length > 1000, "应是一段完整可执行的提示词");
  assert.ok(!DEFAULT_PROMPT.includes("undefined"), "缺省时不得出现 undefined");
  assert.ok(!DEFAULT_PROMPT.includes("null"), "缺省时不得出现 null");
  assert.ok(!DEFAULT_PROMPT.includes("{{"), "缺省时不得残留占位符");
  // 默认值本身要可读（而不是空白或 "unknown"）
  assert.ok(DEFAULT_PROMPT.includes(DEFAULT_RELAY_DIR), "应回退到默认运行环境目录");
  assert.ok(DEFAULT_PROMPT.includes("starting（正在启动 Bridge…）"), "应回退到面板的 starting 阶段文案");
  assert.ok(DEFAULT_PROMPT.includes(`http://127.0.0.1:${DEFAULT_UPSTREAM_PORT}`), "应回退到默认上游地址");
  assert.ok(/未知/.test(DEFAULT_PROMPT), "版本缺失时应写「未知」而不是留空");

  // 显式 ctx：每个字段都要在文本里出现，且日志路径能由 relayDir 推导
  const prompt = buildFixPrompt({
    relayDir: "/home/u/.dsh-remote",
    pluginVersion: "0.6.12",
    runtimeVersion: "0.6.12",
    upstreamUrl: "http://127.0.0.1:8090",
    phaseText: "connecting",
  });
  for (const value of ["/home/u/.dsh-remote", "0.6.12", "http://127.0.0.1:8090", "connecting"]) {
    assert.ok(prompt.includes(value), `ctx 值应出现在提示词里: ${value}`);
  }
  assert.ok(prompt.includes(`/home/u/.dsh-remote/${BRIDGE_LOG_FILE}`), "relayDir 应能推导出 bridge 日志路径");
  assert.ok(prompt.includes(`/home/u/.dsh-remote/${INSTALL_LOG_FILE}`), "relayDir 应能推导出安装日志路径");
  assert.ok(prompt.includes(`/home/u/.dsh-remote/${BRIDGE_STATE_FILE}`), "relayDir 应能推导出状态文件路径");
  assert.ok(!prompt.includes("undefined"));
  // 尾部斜杠 / 全空白 / 非字符串 都要优雅降级，不能拼出 "//" 或 undefined
  const sloppy = buildFixPrompt({ relayDir: "/home/u/.dsh-remote/", pluginVersion: "   ", runtimeVersion: null, upstreamUrl: undefined, phaseText: 42 });
  assert.ok(!sloppy.includes("undefined") && !sloppy.includes("//" + BRIDGE_LOG_FILE), "非法/空白 ctx 必须降级，不得拼出坏路径");
  assert.ok(sloppy.includes(`/home/u/.dsh-remote/${BRIDGE_LOG_FILE}`), "带尾斜杠的 relayDir 应被规整");
  assert.equal(buildFixPrompt(null), DEFAULT_PROMPT, "ctx 为 null 时与无参调用等价");
});

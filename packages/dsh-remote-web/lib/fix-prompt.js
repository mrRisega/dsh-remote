/**
 * 「连接卡住」一键修复提示词 + 固定格式结论报告（纯文本，中文）。
 *
 * 为什么要有这段提示词（真实事故，2026-09-23，Windows 用户）：
 *   用户电脑上插件面板一直停在「连接阶段: starting（正在启动 Bridge…）」，手机端看不到任何设备，
 *   反复重装都没用。事后定位到三种机制，它们在面板上**长得一模一样**，光看面板诊断分不开：
 *     ① 半装运行环境：~/.dsh-remote/dsh-setup.mjs 在，但它 import 的
 *        clients/dsh-remote/src/lifecycle.mjs 不在 → 拉起守护进程时秒退（Cannot find module）；
 *     ② 守护（watcher，`node <relayDir>/dsh-setup.mjs run`）活着却一直没拉起 bridge，
 *        最常见原因是上游 dsh web 不在默认端口 3080（代码里曾写死 3080）；
 *     ③ bridge 子进程起来就崩（缺 ws、端口冲突等），崩因只写在 ~/.dsh-remote/.dsh-bridge.log。
 *   这三种机制都只能在用户**本机的真实环境**里取证。所以产品决定：面板给用户一段可一键复制的
 *   提示词，让他在自己电脑的 DeepSeek Harness 里跑，由本机 agent 读日志、验环境、查端口、
 *   重启守护、验证结果，并产出一份固定格式的报告回传给我们。
 *
 * 本文件只产出文本，不做任何 IO；面板侧「复制修复提示词」直接用 buildFixPrompt(ctx)。
 */

/** 默认运行环境目录（与 lib/index.js 的 DEFAULT_RELAY_DIR 一致；可被 DSH_RELAY_DIR 覆盖）。 */
export const DEFAULT_RELAY_DIR = "~/.dsh-remote";
/** 默认上游端口（与 index.js 的 FALLBACK_UPSTREAM 一致：仅在读不到实际监听端口时使用）。 */
export const DEFAULT_UPSTREAM_PORT = 3080;
/** 相对 relayDir 的固定文件名（与 index.js / dsh-bridge.mjs 保持一致）。 */
export const BRIDGE_LOG_FILE = ".dsh-bridge.log";
export const INSTALL_LOG_FILE = ".dsh-setup-install.log";
export const BRIDGE_STATE_FILE = ".dsh-bridge-state.json";
export const UPSTREAM_FILE = ".dsh-upstream";

/** 报告第一行（固定标题，机器解析靠它定位）。 */
export const REPORT_TITLE = "=== dsh-remote 诊断结论 ===";

/** 报告必须出现的六个字段（顺序即报告里的顺序）。 */
export const REPORT_KEYS = ["症状", "机制判定", "关键证据", "已做的修复", "修复结果", "仍需人工处理"];

/**
 * 结论报告模板。首行固定为 REPORT_TITLE，随后是六个字段；「机制判定」要求四选一，
 * 「修复结果」要求明确写「已修复」或「未修复」。
 */
export const REPORT_FORMAT = `${REPORT_TITLE}
症状: <一句话说清现象，例如「面板停在 starting（正在启动 Bridge…），手机端无任何设备」>
机制判定: ①半装运行环境 | ②守护活着没起作用 | ③bridge 起来就崩 | 其它 —— 四选一，并写一句理由
关键证据: <日志/命令输出的原文（手机号等凭据已掩码），每条一行；确实没有时写明「文件不存在」或「末尾 N 行无错误」>
已做的修复: <按顺序列出你实际执行的命令与改动；没动过任何东西就写「未做修改」>
修复结果: 已修复 | 未修复（必须明确写其中之一）—— 再补一句验证依据
仍需人工处理: <需要用户或我们继续做的事；没有就写「无」>`;

/**
 * 提示词模板：`{{字段名}}` 是占位符，由 buildFixPrompt(ctx) 替换（缺省时用默认值）。
 * 模板里同时写出关键路径的**默认值**，即使占位符没被替换也能看懂。
 */
export const FIX_PROMPT = `你是这台电脑上的 DeepSeek Harness 本机 agent。用户用 dsh-remote 插件从手机远程控制这台电脑上的 dsh web；现在插件面板卡在「连接阶段: {{phaseText}}」，手机端看不到任何设备。请在**本机**按下面 6 步顺序诊断并修复，**每一步都要自己验证**（真的跑命令、看输出）之后再进入下一步，不要跳步、不要凭猜下结论。

【现场信息】（面板已上报；下面的缺省值已在括号里写明）
- 插件版本: {{pluginVersion}}
- 运行环境版本: {{runtimeVersion}}
- 运行环境目录 relayDir: {{relayDir}}（默认 ~/.dsh-remote，可被环境变量 DSH_RELAY_DIR 覆盖）
- 面板当前阶段: {{phaseText}}
- 上游 dsh web 地址: {{upstreamUrl}}
- bridge 日志: {{bridgeLogPath}}
- 安装日志: {{installLogPath}}
- 状态文件: {{statePath}}（默认 ~/.dsh-remote/.dsh-bridge-state.json；字段 device_id / phase）
- 上游端口文件: {{upstreamFilePath}}（默认 ~/.dsh-remote/.dsh-upstream）
- 两个日志的默认位置（上面的路径读不到时先看这里）: ~/.dsh-remote/.dsh-bridge.log 、 ~/.dsh-remote/.dsh-setup-install.log

第 1 步 · 读两个日志的末尾，摘出真实报错原文
- 读 {{bridgeLogPath}} 与 {{installLogPath}} 的最后 80 行（Windows: \`powershell -Command "Get-Content -Tail 80 '<路径>'"\`；macOS/Linux: \`tail -n 80 '<路径>'\`）。
- 把**真实报错原文**摘进报告：Cannot find module、EADDRINUSE、ECONNREFUSED、缺 ws、退出码等。日志为空时要写明「文件不存在」或「末尾 N 行无错误」，**不要只写「无错误」**。
- 验证: 确认你读到的最后一行日志的时间，与面板卡住的时间对得上。

第 2 步 · 检查运行环境是否完整（半装 = ① 号机制）
- 逐个确认存在: {{relayDir}}/dsh-setup.mjs 、 {{relayDir}}/clients/dsh-remote/src/lifecycle.mjs 、 {{relayDir}}/clients/dsh-remote/dsh-bridge.mjs 、 {{relayDir}}/node_modules/ws 。
  （Windows: \`dir\` 或 \`Test-Path\`；macOS/Linux: \`ls -l\`）
- 任一缺失就是「半装运行环境」，用一键安装器重新补装: \`npx @mrrisega/dsh-remote\`（网络受限时用 \`npx @mrrisega/dsh-remote@latest\`）。
- 验证: 补装后上述 4 个路径必须全部存在；再跑 \`node --check "{{relayDir}}/clients/dsh-remote/src/lifecycle.mjs"\` 与 \`node --check "{{relayDir}}/clients/dsh-remote/dsh-bridge.mjs"\`，语法检查必须无输出。

第 3 步 · 核对上游端口（② 号机制最常见的成因）
- 先查这台电脑上 dsh web 到底监听哪个端口: Windows \`netstat -ano | findstr LISTENING\`（再按 PID 找出 dsh/node 那行）；macOS/Linux \`lsof -nP -iTCP -sTCP:LISTEN\`；也可以直接看启动 dsh web 的命令行里有没有 \`--port\`。
- 再读 {{upstreamFilePath}}（文件不存在就按默认 {{defaultUpstreamUrl}}，即默认端口 3080 判断）。
- 两者不一致（例如实际监听 8090，而文件/默认是 3080）→ 按**实际端口**修正: 把正确地址写进 {{upstreamFilePath}}（形如 http://127.0.0.1:8090），或给守护显式设置 DSH_BRIDGE_UPSTREAM，然后重启 bridge。
- 验证: 确认 bridge 日志里不再出现连不上上游的报错，且 bridge 进程真的活下来。

第 4 步 · 检查守护进程是否在跑、是不是「活着但没起作用」
- 找到守护进程（命令行形如 \`node {{relayDir}}/dsh-setup.mjs run\`）: Windows \`wmic process where "name='node.exe'" get ProcessId,CommandLine\` 或任务管理器；macOS/Linux \`ps aux | grep dsh-setup.mjs\`。
- 「活着但没起作用」的判据: 守护进程在，但 bridge 进程没被拉起，且 {{bridgeLogPath}} 长时间没有新行。命中就**先结束卡死的守护，再重新拉起**:
  Windows \`taskkill /PID <pid> /T /F\`（/T 连子进程一起收）；macOS/Linux \`kill <pid>\`，不退出再用 \`kill -9 <pid>\`。
- 重新拉起: \`node "{{relayDir}}/dsh-setup.mjs run"\`（后台方式运行，别阻塞你自己的会话）；装了自启动服务的也可以重启那个服务。
- 验证: 确认守护进程确实在以新 PID 运行，并且它把 bridge 拉起来了。

第 5 步 · 验证结果（必须如实）
- 读 {{statePath}}: 出现 \`device_id\` 且 \`phase\` 为 \`online\` 就算通了；若还是 connecting / bound / error，把 \`last_error\` 原文摘出来。
- 同时看面板是否从「正在启动 Bridge…」变成「已连接 ✅」（手机上能看到本机设备）。
- 如实说明是否成功: **没修好也要照实写**，并把你判断的下一个可疑点写进「仍需人工处理」。
- 验证: 上面两项（状态文件字段 + 面板文案）都要真的看过；只看进程在就宣布成功不算。

第 6 步 · 输出结论报告（固定格式，我们会机器解析）
把下面模板**原样**放进一个 \`\`\` 围栏里（Markdown 代码块），作为你回复的最后一段；围栏内第一行必须是 ${REPORT_TITLE}，六个字段一个都不能少：

\`\`\`
${REPORT_FORMAT}
\`\`\`

- 「机制判定」只能四选一，并给出理由:
  · ① 半装运行环境 —— {{relayDir}}/dsh-setup.mjs 在，但 clients/... 里的文件（尤其 clients/dsh-remote/src/lifecycle.mjs）缺失，或日志里出现 \`Cannot find module\` 且守护一拉起就秒退；
  · ② 守护活着没起作用 —— 守护进程在跑、bridge 却从未被拉起，且端口核对发现 dsh web 的实际监听端口与 {{upstreamFilePath}}（或默认 3080）不一致；
  · ③ bridge 起来就崩 —— bridge 进程确实起来过又退出，且 {{bridgeLogPath}} 里有明确崩因（缺 ws、EADDRINUSE 端口冲突等）；
  · 三条都对不上时才写「其它」，并把你的证据写清楚。
- 「修复结果」必须明确写 \`已修复\` 或 \`未修复\`（二者之一），后面补一句验证依据。
- 验证: 自己核对一遍——围栏内第一行是标题、六个字段一个不少、没有任何凭据与未脱敏的手机号。

【安全与隐私红线（必须遵守）】
1. 报告里**不得**出现手机号、密码、token、JWT、bridge_secret、cookie、访问密钥等任何凭据；日志摘录里的手机号必须掩码，例如 138****0000，token / 密钥一律写成 \`<已隐去>\`。
2. **不要删除** {{relayDir}} 目录（默认 ~/.dsh-remote）——删了会丢账号与设备身份；也不要为了「重来一次」卸载自启动服务，除非用户明确要求。
3. 只做本机修复与取证: 不要把用户的文件内容、会话内容、业务数据贴进报告，报告只写与本次连接问题有关的命令、日志原文（脱敏后）与结论。
4. 改任何配置前先看原值（要能改回去）；不要执行 rm -rf、格式化磁盘等破坏性操作。`;

/** 提示词里使用的占位符: {{字段名}}（双花括号，避免与 JSON/shell 里的单花括号冲突）。 */
const TOKEN_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** 展示用路径拼接: 统一用正斜杠（Windows 的反斜杠放在提示词里更难读）。 */
function displayJoin(dir, name) {
  return String(dir).replace(/[\\/]+$/, "") + "/" + name;
}

/** 取一个「有内容的字符串」；空白、非字符串一律当缺省处理（避免 undefined / null 漏进文案）。 */
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * 把 ctx 归一化成占位符表: 缺省字段一律回退到可读的默认文案，
 * 且日志/状态/端口文件路径都能从 relayDir 推导出来（所以给一个 relayDir 就够用）。
 */
function contextValues(ctx) {
  const src = ctx && typeof ctx === "object" ? ctx : {};
  const relayDir = text(src.relayDir) || DEFAULT_RELAY_DIR;
  const defaultUpstreamUrl = `http://127.0.0.1:${DEFAULT_UPSTREAM_PORT}`;
  return {
    relayDir,
    bridgeLogPath: text(src.bridgeLogPath) || displayJoin(relayDir, BRIDGE_LOG_FILE),
    installLogPath: text(src.installLogPath) || displayJoin(relayDir, INSTALL_LOG_FILE),
    statePath: displayJoin(relayDir, BRIDGE_STATE_FILE),
    upstreamFilePath: displayJoin(relayDir, UPSTREAM_FILE),
    pluginVersion: text(src.pluginVersion) || "未知（面板未上报）",
    runtimeVersion: text(src.runtimeVersion) || "未知（未读到 .dsh-setup-version）",
    upstreamUrl: text(src.upstreamUrl) || `${defaultUpstreamUrl}（默认端口 ${DEFAULT_UPSTREAM_PORT}，需按第 3 步核实）`,
    phaseText: text(src.phaseText) || "starting（正在启动 Bridge…）",
    defaultUpstreamUrl,
  };
}

/**
 * 用 ctx 渲染完整提示词。
 * @param {object} [ctx] { relayDir, bridgeLogPath, installLogPath, pluginVersion, runtimeVersion, upstreamUrl, phaseText }
 * @returns {string} 可直接复制给用户本机 agent 的提示词全文
 */
export function buildFixPrompt(ctx = {}) {
  const values = contextValues(ctx);
  // 未识别的占位符原样保留（宁可留下 {{x}} 也不写出 "undefined"）
  return FIX_PROMPT.replace(TOKEN_RE, (raw, key) => (key in values ? String(values[key]) : raw));
}

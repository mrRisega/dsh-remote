# agent/ —— 本地 Agent 运行时（M2 第 2 周：PermissionBridge 雏形）

> **状态**：M2 第 2 周交付。**默认关闭**，只有被 bridge/插件显式调用 `start()` 才生效。
> **零依赖**（只用 Node 内置）、**不 import 任何 DSH 模块**、**不碰现有链路**。
>
> 依据：`dsh-relay-enterprise/docs/multi-agent-design.md`（设计稿）+
> `research/2026-11-strategy/12-multiagent-m2/00-第1周验证报告.md`（实测结论）。

---

## 1. 这个目录解决什么问题

Claude Code 要弹审批时，会调用我们注入的 `PermissionRequest` 钩子。本模块：

```
Claude Code ──HTTP POST──▶ 127.0.0.1:<随机端口>/permission?t=<token>
                                │
                                ├─ 四道闸：token / 事件名 / 体积 / 并发
                                ├─ 归一化：toolName / kind / detail（命令原文或路径）
                                ├─ 决策来源 = 可注入回调（M2 第 3 周接手机；现在缺省 fail-closed）
                                └─ 回写第 1 周实测确认过的响应体
```

同时负责：**版本门禁**（旧版本 Claude Code 不触发钩子 → 明确不可用，不静默丢审批）、
**既有钩子让位**（用户/企业已有 `PermissionRequest` 钩子时，我们不注入，避免绕过他们的策略）、
**子进程治理**（"停止"必须杀掉整棵进程树，否则 Claude 会孤儿化继续跑）。

---

## 2. 导出什么（挂载方只需要这些）

```js
import { createAgentRuntime, AGENT_STATUS } from "./agent/index.mjs";
```

> 第 4 周新增：`agent/events.mjs` 的通用驱动 `createJsonlDriver`、`agent/codex.mjs` 的
> `mapCodexObject` / `createCodexDriver` / `detectCodex`（接入清单见 §9）。

`createAgentRuntime(opts)` 返回一个对象，**默认不启动**：

| 方法 | 说明 |
|---|---|
| `start()` | 探测 + 门禁 + 起桥接。**永不抛错**，返回状态对象 |
| `stop()` | 关端口、删临时 settings、结算未决审批（一律 deny）。幂等 |
| `probe()` | 只探测（不占端口、不写盘），给"入口灰显 + 原因"用 |
| `status()` | 同步读当前状态 |

`start()` 的返回（`ok:true` 时）：

```js
{
  ok: true,
  status: "ready",
  mode: "approval",
  claude: { kind: "npm-global-exe", path: "…/bin/claude.exe", command: "…", argsPrefix: [] },
  version: { major:2, minor:1, patch:318, text:"2.1.318" },
  minVersion: "2.1.318",
  settingsPath: "/tmp/dsh-agent-perm-xxxx/settings.json",
  port: 51234,
  launch: { args: ["--permission-mode", "default", "--settings", "<settingsPath>"] },
  permission: { ttlMs: 90000, hookTimeoutSec: 120, url: "http://127.0.0.1:51234", pendingCount: [Function] },
  stop: [Function]
}
```

**挂载方式（最小接入）**：

```js
const runtime = createAgentRuntime({
  log: (e) => logger.info(JSON.stringify(e)),   // 结构化日志；不会收到命令原文
  decide: async (req) => ({ decision: "deny" }) // 第 3 周换成"手机回执"；缺省 fail-closed
});

const r = await runtime.start();
if (r.ok) {
  // 起 Claude Code 时把 r.launch.args 追加进参数数组（不要拼 shell 字符串）：
  //   spawn(claudeBin.path, [...r.launch.args, "-p", prompt], {...})
  // 手机端审批回调接通后，r.permission.pendingCount() 可做自检
}
// 退出/关闭时：
await runtime.stop();
```

### 状态 → 降级（UI 直接映射）

| `status` | 含义 | 建议行为 |
|---|---|---|
| `disabled` | 未启用（默认） | 不渲染 Agent 入口 |
| `cli-missing` | 找不到 Claude Code | 灰显 + "请安装 / 检查 PATH 或 DSH_AGENT_CLAUDE_BIN" |
| `version-unsupported` | 版本低于阈值 | 灰显 + "请升级 Claude Code ≥ `<minVersion>`" |
| `version-unknown` | 找到候选但认不出版本 | 灰显 + "安装可能损坏" |
| `existing-hooks` | 本机已有审批钩子（或强制 notify-only） | **只通知模式**，明示"远程审批已让位" |
| `bridge-error` | 端口/临时目录失败 | 只通知模式 + `reason` 排障 |
| `ready` | 审批通道就绪 | 正常启用 |

> **降级原则**：任何异常都返回 `ok:false` + `status`，**不抛错**；绝不"没审批就默认放行"。

---

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AGENT_ENABLED` | 关 | `1` 打开（也可用 `createAgentRuntime({ enabled:true })`） |
| `DSH_AGENT_CLAUDE_BIN` | — | 显式指定 CLI 路径（排障/企业定制；`.cjs` 会被当成 wrapper 用 node 启动） |
| `DSH_AGENT_MIN_CLAUDE_VERSION` | `2.1.318` | 最低版本阈值。写错会回落默认并告警（**不会因为配置错就放行**） |
| `DSH_AGENT_NOTIFY_ONLY` | 关 | `1` = 强制只通知（不注入钩子） |
| `DSH_AGENT_PERMISSION_TTL_MS` | `90000` | 决策窗口；到期一律 deny |
| `DSH_AGENT_HOOK_TIMEOUT_SEC` | `120` | 写进临时 settings 的钩子超时（秒；上游单位实测是秒） |
| `DSH_AGENT_BRIDGE_PORT` | `0` | 桥接端口；`0`=随机（只绑 `127.0.0.1`） |
| `DSH_AGENT_SETTINGS_DIR` | 系统临时目录 | 临时 settings 的父目录 |
| `DSH_AGENT_NPM_ROOT` | 自动探测 | npm 全局根（Windows 自定义 prefix 时用） |
| `DSH_AGENT_PROBE_CACHE_MS` | `300000` | `probe()` 结果缓存；避免面板重绘反复 spawn CLI（杀软敏感）。`probe({force:true})` 可强测 |

---

## 4. 隐私与日志契约

- `log` 回调只会收到**元数据**：`{event, requestId, toolName, kind, outcome, durationMs, …}`；
  **绝不包含命令原文 / 文件内容 / token**（有专门单测锁住）。
- `detail`（命令原文或路径）只交给 `decide()` —— 因为手机审批要给人看。
- 临时 settings 文件含 token → 写入即 `0600`，`stop()` 必删。
- 不写 stdout、不落业务日志文件。

---

## 5. 子进程治理（`proc.mjs`）

`spawnAgentProcess()`：参数数组 + `shell:false` + posix `detached`（独立进程组）+ `windowsHide`。

`terminateProcessTree(pid)`：posix 先 `process.kill(-pid, SIGTERM)`（**整组**）→ 3s → `SIGKILL`
（升级）；Windows 走 `taskkill /PID <pid> /T /F`。

> ⚠️ **Windows 分支未真机验证**：返回 `verified:false`，上层只能显示"已请求停止"，
> 不得宣称"已确认杀死"。真机验证清单见第 1 周报告 §4.4（W7）。

**为什么必须整组杀**（第 1 周实测）：经 `cli-wrapper.cjs` 启动时，SIGTERM 只杀 wrapper，
原生 claude 会 reparent 到 PPID=1 继续跑 —— 手机上点"停止"却还在执行工具。

---

## 6. 已做 / 未做（M2 边界）

**已做（M2 第 2 周）**
- 版本门禁（默认 2.1.318，env 可覆盖）+ CLI 四级解析 + `--version` 探测
- 既有 `PermissionRequest` 钩子扫描（user/project/local，只读）→ 让位
- PermissionBridge：loopback 随机端口、临时 settings 0600、token/事件名/体积/并发四道闸、
  fail-closed 90s、实测响应体、幂等 stop
- 进程治理：参数数组 spawn、进程组 kill、SIGTERM→SIGKILL、Windows taskkill 预留
- 全部外部依赖可注入；单测覆盖门禁/让位/fail-closed/响应体/kill/清理

**已做（M2 第 3 周）**
- `events.mjs`：`claude --output-format stream-json` 逐行 → 5 种归一化事件
  （`status` / `message.delta` / `tool.call` / `tool.result` / `turn.end`），可落 append-only jsonl；
  未知行/坏 JSON/超长行计数丢弃、落盘失败静默。
- `agent-e2e-real.mjs`：**真实 Claude Code 端到端联调**（默认跳过），实测 allow 真跑 / deny 不跑 /
  TTL 到期自动拒；顺带用真实输出校验事件映射（`unknown=0`）。

**已做（M2 第 4 周）**
- `events.mjs` 拆成 **通用 jsonl 驱动**（`createJsonlDriver`）+ Claude 映射（`mapClaudeObject` / `mapClaudeLine`），
  对外行为不变；新增 `frameLine` / `parseLineJson` / `mapClaudeObject` 等可复用件。
- `codex.mjs`：**第二家 harness 样板** —— `mapCodexObject`（`codex exec --json` → 同一套 5 类事件）、
  `createCodexDriver`（跨行去重）、`detectCodex`（找 CLI / 版本 / `exec --help` 能力位）。
- 本机实测：`codex-cli 0.150.1`，`--json` / `--output-schema` / `--sandbox` / `--approve-for-me` 均存在，
  但 **没有"审批回调外部程序"的开关** ⇒ Codex 走 `exec` 时只能 `mode:"notify-only"`。

**已做（M2 第 5 周：四家接入骨架齐）**
- `gemini.mjs`：Gemini CLI 的 **ACP（JSON-RPC over stdio）** 映射（`session/update` 全变体、`tool_call*`、
  `session/request_permission`、`stopReason`），`detectGemini` 实测 ACP 能力位
  （本机 `gemini 0.31.0` 的开关是 **`--experimental-acp`**，不是文档里的 `--acp`）。
- `opencode.mjs`：OpenCode 的 **HTTP/SSE** 映射（`message.part.updated`、`permission.updated/replied`、
  `session.idle/status/error`）+ **SSE→事件桥接**（`createSseParser` / `attachOpenCodeSse`），`detectOpenCode`。
- `agent-e2e-codex.mjs` + **Codex 真实校准 1 次**：实得 6 行 JSONL、`unknown=0`；发现并修掉两处差异
  （error item 可早于 turn.started；error.message 是嵌套 JSON 字符串 → `normalizeErrorMessage`）。

**未做（后续周）**
- 手机端决策来源（`decide` 现在缺省 fail-closed）、SessionStore 落盘、`/_agent` 隧道挂载、E2EE、微信 sink、插件面板入口
- Codex 正常路径校准（本机 model 与账号不兼容 → 只拿到错误路径；修好 model 后可复跑 `agent-e2e-codex.mjs`）
- Codex 审批（需 `codex app-server`，experimental；exec 模式做不到）
- Gemini ACP 真实握手（`initialize` / 版本代际 / `request_permission` 回写）与 OpenCode 真实流校准
  （本机未安装 opencode；两家都只有"按官方类型定义映射"）
- Windows 真机验证（`taskkill /T /F` 的实际效果、中文/空格路径）
- `allow_always` / `updatedPermissions`（会写用户 settings，风险大于收益，M2 不做）
- 企业 managed settings 检测（M3）

---

## 7. 已知风险 / 未验证（挂载前请知悉）

| 项 | 状态 | 说明 |
|---|---|---|
| Windows `taskkill /T /F` 实际效果 | **未验证**（无真机） | 返回 `verified:false`；真机清单见第 1 周报告 §4.4 W7 |
| 用户已在别处传 `--dangerously-skip-permissions` | **未验证** | 命令行参数谁生效取决于参数顺序与权限模式优先级；第 3 周需验证，若不成立则改为"检测到 bypass 模式就拒绝启用审批" |
| 企业 managed settings（`allowManagedPermissionRulesOnly` 等） | **未验证** | M3 企业版前补检测 |
| 多个会话并发审批 | 已支持（`maxPending=8`，超限 429） | 但**同一会话多请求的排序/取消**未验证 |
| Claude Code 版本门槛精确定值 | **未确定** | 只测了 2.1.195 ❌ / 2.1.318 ✅；默认阈值保守取 2.1.318，第 3 周二分 |

## 8. 事件层：通用 jsonl 驱动 + 两家映射（`events.mjs` / `codex.mjs`）+ 真实联调

### 8.1 分层：驱动不认识任何一家 CLI

```js
import { createJsonlDriver, createJsonlSink } from "./agent/events.mjs";
import { createCodexMapper } from "./agent/codex.mjs";

const driver = createJsonlDriver({
  mapLine: (obj, ctx) => myMap(obj, ctx),      // ← 一家一份（Claude 用 mapClaudeObject，Codex 用 createCodexMapper()）
  sink: createJsonlSink({ filePath }),          // 可选；不给 filePath = 默认不落盘
  onEvent: (e) => phone.send(e),                // 每条归一化事件
  onUnknown: (reason, raw) => metrics.count(reason)  // 未识别行（计数+忽略，不崩）
});
driver.writeLine(rawLine);   // 喂一行，返回本行产出的事件
driver.stats();              // {driverName,lines,events,badJson,tooLong,empty,unknown,mapperErrors,byType,byReason,unknownReasons}
```

现成的两家：`createEventMapper()`（Claude，第 3 周 API 不变）、`createCodexDriver()`（Codex，内部跨行去重）。
第 3 周的 `mapStreamJsonLine` 保留为 `mapClaudeLine` 的别名（行为一致）。

### 8.2 Claude Code 映射

| 归一化事件 | 来源 | 说明 |
|---|---|---|
| `status` | `system/init`、`hook_started/hook_response`、`api_retry`、**`permission_denied`** | `permission_denied` 是实测拿到的"审批被拒"回执 |
| `message.delta` | `assistant` 文本（final=true）、`stream_event` 的 `text_delta`（final=false） | 不重复成 final 事件 |
| `tool.call` | `tool_use` | **只带 id/name/kind/输入字节数**，不带命令原文 |
| `tool.result` | `tool_result` | 只带 isError/输出字节数/截断预览（默认 120 字符，可设 0 关闭） |
| `turn.end` | `result` | reason: completed / error / max-turns / interrupted / aborted |

### 8.3 Codex 映射（`codex.mjs`）与依据来源

| Codex 事件（官方 `exec --json`） | 归一化事件 | 说明 |
|---|---|---|
| `thread.started` | `status(working, phase=thread)` | 带 `threadId`（未来续接用） |
| `turn.started` | `status(working, phase=turn)` | |
| `item.*` + item.type=`agent_message` | `message.delta(final=true)` | 只在 `item.completed` 发 |
| `item.*` + `reasoning` | `status(thinking)` | **只带 textBytes**，推理内容不落 |
| `item.*` + `command_execution` | `tool.call(shell/execute)` / `tool.result` | **命令原文不落**，只带字节数；`exit_code`/`status` 判成败 |
| `item.*` + `file_change` | `tool.call(file_change/edit)` + `tool.result` | 只带文件数，路径不落 |
| `item.*` + `mcp_tool_call` | `tool.call(mcp:server/tool)` / `tool.result` | arguments 只算字节数 |
| `item.*` + `web_search` | `tool.call(web_search/fetch)` / `tool.result` | query 不落，完成带结果数 |
| `item.*` + `todo_list` | `status(plan)` | 只带条数/完成数 |
| `item.*` + `error` / 顶层 `error` | `status(error, scope=item/stream)` | 错误文案截断 |
| `turn.completed` | `turn.end(completed)` | `usage` 只保留 token 数与 `cacheWriteInputTokens`（缺失按 0） |
| `turn.failed` | `turn.end(error)` | error.message 截断 |
| `item.updated` | **忽略** | 增量语义官方未给样本【未核实】 |

**依据来源（全部官方；2026-11 读取）**

| 依据 | 出处 |
|---|---|
| 顶层事件枚举 + 官方样本 JSONL（测试夹具逐字摘录） | <https://learn.chatgpt.com/docs/non-interactive-mode>（"Make output machine-readable" / "Sample JSON stream"） |
| 字段级权威定义（`ThreadEvent` / `ThreadItem` / 各 Item 结构体 / 状态枚举） | `openai/codex` → `codex-rs/exec/src/exec_events.rs` |
| 同款 TS 类型（跨语言对照） | `openai/codex` → `sdk/typescript/src/events.ts`、`sdk/typescript/src/items.ts` |
| 本机能力位（`--json` / `--output-schema` / `--sandbox` / `--approve-for-me`） | 本机 `codex exec --help`（`codex-cli 0.150.1`，实测） |

**本机真实探测结果（2026-11，`codex-cli 0.150.1`）**：`ok:true`，`mode:"notify-only"`；
`caps={jsonOutput:true, structuredOutput:true, resume:true, appServer:true, approvalsAutoReview:true, sandboxFlag:true, externalApprovalHook:false}`。

**未核实项（不要当事实）**：`item.started` 是否总带 `aggregated_output`；`item.updated` 增量语义；
`command_execution.status` 是否出现 `declined`（Rust 有、TS 无）；`web_search`/`file_change`/`todo_list`/`collab_tool_call` 线上形状；
以及最关键的 —— **exec 模式无法把审批回调给外部程序**（本机 help 只有 `--approve-for-me` 与 bypass），
所以 Codex 要么只通知，要么走 `codex app-server`（experimental）。

### 8.4 真实联调（默认跳过）

```bash
export DSH_AGENT_E2E=1
export DSH_AGENT_CLAUDE_BIN=/path/to/@anthropic-ai/claude-code/bin/claude.exe   # 必须 ≥ 2.1.318
node clients/dsh-remote/agent/agent-e2e-real.mjs

# 只跑某一个用例（省额度）：allow | deny | timeout
DSH_AGENT_E2E_CASES=deny node clients/dsh-remote/agent/agent-e2e-real.mjs
# 保留现场 / 落原始流以便排障
DSH_AGENT_E2E_KEEP=1 DSH_AGENT_E2E_DUMP_RAW=1 node clients/dsh-remote/agent/agent-e2e-real.mjs
```

- 退出码：`0` 通过 / `1` 断言失败 / `2` 环境不具备（未开启、CLI 版本不够、起不来）。
- 每次最多 3 次真实 `claude -p`（脚本硬上限 6 次）。
- 每个用例都在**临时项目**里写 `permissions.ask` 强制升权，并把探测用的 `homeDir` 指向空目录，
  避免"用户级 allow 规则吞掉审批"（第 1 周报告 §1.2）与"既有钩子让位"两种干扰。

### 8.5 Gemini CLI（ACP）映射要点

ACP 的 stdio 规定**一行一条 JSON-RPC**（官方 transports 原文），所以**直接复用 `createJsonlDriver`**，
只用换 `mapLine`（`createGeminiDriver`）。

| ACP 消息 | 归一化事件 | 说明 |
|---|---|---|
| `session/update` → `agent_message_chunk` | `message.delta(final:false)` | ACP 是流式增量，按 `messageId` 拼 |
| `session/update` → `agent_thought_chunk` | `status(thinking)` | 只带 `textBytes`，推理内容不落 |
| `session/update` → `tool_call` | `tool.call` | `kind` 直接用 ACP 词表；`title`/`rawInput` 不落 |
| `session/update` → `tool_call_update`（completed/failed） | `tool.result` | `in_progress` 增量忽略（避免重复） |
| `session/update` → `plan` / `notice` / `usage_update` | `status(plan/notice/usage)` | 其余变体（`available_commands_update` 等）**忽略而非 unknown** |
| `session/request_permission` | `status(waiting_approval)` | JSON-RPC `id` 即回执 id；只暴露 `optionKinds`，不落 title/命令 |
| `session/prompt` 响应 `stopReason` | `turn.end` | end_turn→completed / max_tokens→max-tokens / max_turn_requests→max-turns / refusal→refused / cancelled→aborted |
| JSON-RPC `error` 响应 | `status(error, scope=jsonrpc)` | 精确归属 prompt 需状态机（下一步） |

**依据**：ACP v1 的 [prompt-turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、
[tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls)、
[transports](https://agentclientprotocol.com/protocol/v1/transports)；
本机 `gemini --help`（`0.31.0`）实测 ACP 开关为 `--experimental-acp`。

### 8.6 OpenCode（HTTP/SSE）映射与 **SSE 桥接**

OpenCode 的事件不是 stdout，而是 `GET /event` 的 **SSE**。桥接做法（`attachOpenCodeSse`）：

```
HTTP SSE 流 ──stream.on("data")──▶ createSseParser.push(chunk)   // 分帧：

 分隔、data: 多行拼接、: 心跳
                                  └▶ {event, data} ──JSON.stringify(data)──▶ createJsonlDriver.writeLine
                                                       // 之后 seq/统计/sink/unknown 全部复用通用驱动
```

| SSE 事件（SDK v1.19.5 类型） | 归一化事件 | 说明 |
|---|---|---|
| `server.connected` | `status(connected)` | |
| `session.status`（busy/idle/retry） | `status(working/idle/retrying)` | |
| `session.idle` | `turn.end(completed)` | 文档语义：空闲=回合结束 |
| `session.error` | `turn.end(error)` | 带 errorName + message 预览 |
| `message.part.updated`（text） | `message.delta` | 有 `delta` 用增量（final=false），否则全文（final=true，按 part.id 去重） |
| `message.part.updated`（reasoning） | `status(thinking)` | 只带 `textBytes` |
| `message.part.updated`（tool） | `tool.call` / `tool.result` | state.status pending/running→call；completed/error→result；input/output 只落字节数/截断预览 |
| `permission.updated` | `status(waiting_approval)` | **不落 title/pattern**（可能含命令）；真回执走 `POST /session/:id/permissions/:permissionID` |
| `permission.replied` | `status(approval_replied)` | |
| 其余（`message.updated`/`session.created`/`file.edited`/`todo.updated`/`pty.*`…） | 忽略 | 明确列在 `OPENCODE_IGNORED_EVENTS`，不计 unknown |

**依据**：`@opencode-ai/sdk@1.19.5` 的 `dist/gen/types.gen.d.ts`（官方发布产物，逐字对照 `Event`/`Part`/`ToolState`/`Permission`）
+ [opencode.ai/docs/server](https://opencode.ai/docs/server/)。

### 8.7 Codex 真实校准脚本（默认跳过）

```bash
export DSH_AGENT_E2E_CODEX=1
node clients/dsh-remote/agent/agent-e2e-codex.mjs     # 恰好 1 次 `codex exec --json`（只读沙箱）
```
- 断言：真实流喂 `createCodexDriver` 后 **unknown=0 / badJson=0 / 有 turn 边界**；
- 退出码：`0` 映射通过（**即使 CLI 因账号/模型配置退出非 0**，只要流合法就算校准成功）、`1` 断言失败、`2` 环境不具备；
- 本机首次实测：CLI 退出 1（`gpt-6.1-sol` 不被当前 ChatGPT 账号支持），但 6 行流 `unknown=0`，
  并暴露两处差异（已在 `codex.mjs` 修掉/记录）；正常路径待修好 model 后再跑一次。

## 9. 接入清单：四家 × 能力位 × 审批通道 × 下一步

> 这是本轮"驱动可复用"的验收口径：Codex 接入**没有**改 events 词表、没有改审批桥、没有改 index。

### 9.1 四家能力表（2026-11 实测/官方依据）

| Agent | 驱动 | 结构化输出 | 审批通道 | 需要外部审批通道？ | 当前接入状态 | 下一步验证动作 |
|---|---|---|---|---|---|---|
| **Claude Code** | jsonl（stream-json） | ✅ `--output-format stream-json` | `PermissionRequest` 钩子（http/command） | ✅ 是（钩子→PermissionBridge） | **真实联调 3/3**，`mode:approval` | Windows 真机；版本阈值二分（2.1.195❌/2.1.318✅） |
| **Codex CLI** | jsonl（`exec --json`） | ✅ `--json` / `--output-schema` | ❌ exec 无外部审批开关（只有 `--approve-for-me` 自动审查/bypass）；审批在 `app-server`（experimental） | **exec 不需要**（只通知）；要审批需改接 app-server | 骨架 + **真实校准 1 次**（unknown=0，仅错误路径），`mode:notify-only` | 修本机 model 后跑 `agent-e2e-codex.mjs` 校准正常路径；实测 `codex app-server` 的审批请求形状 |
| **Gemini CLI** | ACP（JSON-RPC over stdio，一行一条） | ✅ 官方 `--acp`（本机 0.31.0 为 `--experimental-acp`） | `session/request_permission`（**协议内双向请求**，我们作为 ACP client 必须回 outcome） | ❌ 不需要外部钩子（审批在协议内） | 骨架 + 本机探测通过（`mode:approval`，`approvalChannel:acp-jsonrpc`），**未真实握手** | `gemini --experimental-acp` 握手：`initialize` 版本/能力协商、`request_permission` 回写、fs 代理显式拒绝 |
| **OpenCode** | HTTP + SSE | ✅ `opencode serve` + `GET /event` | `permission.updated` 事件 + `POST /session/:id/permissions/:permissionID` | ❌ 不需要外部钩子（HTTP 端点直接答） | 骨架 + **SSE 桥接实现**，本机未安装（探测 SKIP） | 装 `opencode` 后：`serve` 认证、SSE 真实事件形状、permission response 枚举、`prompt_async` 时序 |

### 9.2 接第二家要改的 3 处

| # | 改什么 | 位置 | 本轮实例 |
|---|---|---|---|
| ① **mapLine** | 该 CLI 的结构化输出 → 5 类事件 | `agent/<harness>.mjs` | `mapCodexObject` / `mapGeminiObject` / `mapOpenCodeObject` |
| ② **CLI 探测 + 能力声明** | 找 CLI、`--version`、从 `--help` 探能力位（**探不到就 false，不许默认 true**） | 同文件 `detectXxx()` | `detectCodex` / `detectGemini` / `detectOpenCode` |
| ③ **传输形态差异** | stdout 行 / SSE / JSON-RPC 的"最后一公里" | 同文件 | ACP 与 jsonl **同构**（直接复用驱动）；OpenCode 需 `createSseParser`+`attachOpenCodeSse` 桥接 |

### 9.3 **不许动**的 2 处（动了就说明抽象漏了）

| # | 不动什么 | 为什么 |
|---|---|---|
| ① **事件词表 + 通用驱动 + sink**（`EVENT_TYPES` / `createJsonlDriver` / `createJsonlSink` / 隐私规则） | 手机端/微信/审计都按这 5 类消费；每接一家改一次 = 每个下游都要跟着改 |
| ② **审批链路**（`index.mjs` 的 `PermissionBridge` 接线、fail-closed、让位逻辑） | 安全语义只有一套。做不到外部审批的 harness 就明确 `mode:"notify-only"`（Codex exec 是典型），不自己发明一套 |

### 9.4 Gemini ACP 下一步要验什么

1. 本机 0.31.0 的 ACP 代际（文档有 v1/v2）与 `initialize` 能力协商字段；`--experimental-acp` 是否等同 v1。
2. `session/new` + `prompt` 时序；`request_permission` 回写 `{outcome:{outcome:"selected",optionId}}` 与 `cancelled` 语义。
3. `tool_call_update` 的真实 `status` 序列（pending→in_progress→completed/failed）是否与文档一致。
4. **显式拒绝 fs 代理 capability**（否则文件读写要经客户端，行为不可控）。
5. `session/cancel` 的落点；会话列表能否通过 ACP 拿到（拿不到就自建 SessionStore）。
6. 验收：ACP 驱动产出的 5 类事件与 Claude 同构（同一手机端页面可渲染）。

### 9.5 OpenCode 下一步要验什么

1. `opencode serve` 绑定/认证（`OPENCODE_SERVER_PASSWORD`、默认 127.0.0.1:4096）。
2. `GET /event` 真实 SSE：是否带 `event:` 行、心跳格式、`/event` vs `/global/event` 的包装差异。
3. `permission.updated` 的 `pattern`/`title` 真实内容（决定审批卡能显示什么；当前为隐私一律不落）。
4. `POST /session/:id/permissions/:permissionID` 的 `response` 枚举与 `remember`。
5. `prompt_async` 时序（立即 204，结果只从事件流看）与 `session.idle` 是否等价回合结束。
6. 验收：同一条任务在 OpenCode 下事件序列与 Claude 一致（status→tool→turn.end）。

## 10. 测试

```bash
# 本目录相关用例（8 个文件）
DSH_PROFILE_DIR= NODE_OPTIONS="--require $PWD/scripts/test-net-guard.cjs" \
  node --test --test-concurrency=1 \
  clients/dsh-remote/test/agent-version.test.mjs \
  clients/dsh-remote/test/agent-detect.test.mjs \
  clients/dsh-remote/test/agent-permission-bridge.test.mjs \
  clients/dsh-remote/test/agent-proc.test.mjs \
  clients/dsh-remote/test/agent-runtime.test.mjs \
  clients/dsh-remote/test/agent-events.test.mjs \
  clients/dsh-remote/test/agent-jsonl-driver.test.mjs \
  clients/dsh-remote/test/agent-codex.test.mjs \
  clients/dsh-remote/test/agent-gemini.test.mjs \
  clients/dsh-remote/test/agent-opencode.test.mjs
```

Codex 真实校准（默认跳过，**恰好 1 次**真实调用）：
`DSH_AGENT_E2E_CODEX=1 node clients/dsh-remote/agent/agent-e2e-codex.mjs`

（真实跑请用仓库标准入口：`npm run test:bridge` —— 它带测试期网络护栏，只允许打本地。）

> 注：`npm run check` 的检查清单是**显式文件列表**，本轮新增文件不在其中（未改 `package.json`，
> 避免与其它线冲突）；新增文件已逐个 `node --check` 通过，见交付说明。

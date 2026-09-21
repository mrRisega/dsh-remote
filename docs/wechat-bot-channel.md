# 微信机器人通道（ClawBot 通知）

> 状态：**设计已定稿**，实现中。产品决策见文末「决策记录」。

## 1. 目标与范围

把 DSH 的关键事件推送到用户微信，并支持**一步回执**。

**v1 做什么**
- 关键节点**通知**（见 §5）
- 需要用户决策的节点支持**一步回执**：消息带编号选项，用户回一个数字即可完成放行/拒绝/选择
- 面板内绑定 / 解绑，显示绑定状态

**v1 不做什么**
- 不做自由文本对话（用户回任意文本 → DSH 会话）。产品形态未定，留待后续。
- 不经过我们的 SaaS 中转
- 不依赖 OpenClaw 宿主（见 §3）

## 2. 架构

```
用户微信  ⇄  腾讯 ilink (ilinkai.weixin.qq.com)
                  ⇅  HTTPS + Bearer bot_token
        ┌────────────────────────────────────────┐
        │ dsh-bridge（受控电脑本地守护进程）        │
        │                                        │
        │  wechat-channel.mjs                    │
        │    ├ get_bot_qrcode / get_qrcode_status │── 绑定
        │    ├ getupdates 长轮询（收用户回复）      │
        │    ├ sendmessage（发通知）               │
        │    └ notifystart / notifystop           │
        │                                        │
        │  dsh-events.mjs                        │
        │    ├ ws://127.0.0.1:3080/api/remote.mux │── $events（全局）
        │    └ session/follow（按活跃会话）         │── 精确 turn/end
        └────────────────────────────────────────┘
                  ⇅ 本地 loopback（同进程内直接调用）
              收到回执 → POST /api/$events/result
```

**关键性质**：微信流量只经过「腾讯 ilink ↔ 本机 bridge」。我们的 SaaS relay **完全不参与**。面板读本地状态文件。

## 3. 为什么自建而不驱动 OpenClaw

腾讯的 `@tencent-weixin/openclaw-weixin` 是 OpenClaw 的渠道插件，它的登录逻辑绑在 OpenClaw 自己的 gateway 生命周期里，**没有暴露可调用的 RPC**。更关键的是：一个 bot 只有**一个 `getupdates` 长轮询消费者**，我们的 bridge 和 OpenClaw 会互抢。

而 ilink 协议本身是**公开的 JSON over HTTP**，实测无需鉴权即可取二维码：

```
POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
Headers: iLink-App-Id: bot
Body:    {"local_token_list":[]}
→ 200 {"qrcode":"1e60…","qrcode_img_content":"https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=…&bot_type=3","ret":0}
```

`qrcode_img_content` **是一个 URL**，面板自行渲染成二维码 —— 正是我们要的形态。

> ⚠️ 这是一个**未公开接口**，腾讯可能变更。协议客户端必须把「响应形状不认识」当作一等错误处理，不能崩。

### 协议端点全集（从腾讯插件源码提取）

| 端点 | 用途 |
|---|---|
| `POST ilink/bot/get_bot_qrcode?bot_type=3` | 取绑定二维码 |
| `GET ilink/bot/get_qrcode_status?qrcode=&verify_code=` | 长轮询扫码状态（客户端超时 35s） |
| `POST ilink/bot/msg/notifystart` | 上报「通道客户端已上线」 |
| `POST ilink/bot/msg/notifystop` | 上报下线 |
| `POST ilink/bot/getupdates` | 长轮询收消息（`get_updates_buf` 游标） |
| `POST ilink/bot/sendmessage` | 发消息 |
| `POST ilink/bot/sendtyping` / `getconfig` / `getuploadurl` | 打字态 / 配置 / 传文件（v1 不做） |

### 扫码状态机（8 态，全部要处理）

| 状态 | 处理 |
|---|---|
| `wait` | 继续轮询 |
| `scaned` | 面板提示「已扫码，请在手机上确认」 |
| `need_verifycode` | **面板弹输入框**，用户填手机上的数字配对码后带回轮询 |
| `confirmed` | 拿到 `bot_token` / `ilink_bot_id` / `baseurl` / `ilink_user_id` → 落盘 → 绑定成功 |
| `expired` | 自动刷新二维码（最多 3 次） |
| `scaned_but_redirect` | 切 `redirect_host` 继续 |
| `verify_code_blocked` | 提示稍后再试 |
| `binded_redirect` | 视为已绑定（该 bot 之前绑过） |

### 错误码

- `errcode: -14` / `session timeout` → token 失效或会话过期。腾讯官方插件的处理是**把该账号静默冷却 1 小时**。我们必须同样退避，不能打爆接口。

## 4. 事件源

**权威白名单**：`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js` 的 `API_REMOTE_FORWARDED_EVENTS`（19 项）。

### 全局流：`/api/remote.mux`，endpoint `$events`

请求：`{type:'open', streamId, endpoint:'$events', payload:{args:{}}}`
应答帧：

```json
{"type":"item","streamId":"s1","value":{"type":"ready","clientId":"<uuid>","host":{…}}}
{"type":"item","streamId":"s1","value":{"type":"emit","event":"api-session/status","args":["<sessionId>",true]}}
{"type":"item","streamId":"s1","value":{"type":"emit","event":"api-session/error","args":["<sessionId>","<message>"]}}
{"type":"item","streamId":"s1","value":{"type":"waterfall","event":"approval/request","eventId":"<id>","agentId":"<id>","request":{…}}}
```

### 回答的通道是 HTTP，不是 socket

```
POST /api/$events/result
{"type":"client-request","rpcId":"…","method":"$events/result",
 "payload":{"args":{"clientId":"<来自 ready 帧>","eventId":"<来自 waterfall 帧>","outcome":…}}}
```

- 审批：`outcome = {kind:'result', value:'allowed-once' | 'rejected'}`
- 提问：`outcome = {kind:'result', value:{answers:[{id, selected:[label]}]}}`

### 按会话流：`session/follow`（用于精确区分「怎么停的」）

```
open  payload: {"request":{"address":{"kind":"session","sessionId":"session-<uuid>"}}}
```

- ⚠️ `sessionId` 必须用**持久的 `session-<uuid>` 形式**，裸 uuid 会 `session/not-found`
- ⚠️ **子代理会话会被拒**（`session/agent-busy`）
- 开流后首帧 `{type:'snapshot', header, cursor, records:[…], projections}`
- `turn/end` 的 `reason.kind` ∈ `completed | aborted | blocked | error | max-tokens | interrupted`

### 不能用的事件

- 🔴 `approval/asked` / `approval/decided` —— **只写日志，明确「不是 surface event」**，永远不到线上
- 🔴 `permission/preset` —— 同上，只写日志
- 🔴 `turn/end` **不在** `$events` 白名单里，只能经 `session/follow` 拿

## 5. 关键节点清单

### P0 —— 必做

| # | 节点 | 事件源 | 可回执 |
|---|---|---|---|
| 1 | **要你拍板**（工具放行） | `approval/request` waterfall | ✅ 允许一次 / 拒绝 |
| 2 | **在等你回答**（agent 提问 / 计划待批） | `user-questions/request` waterfall | ✅ 选项 |
| 3 | **任务报错** | `api-session/error` | ❌ |
| 4 | **任务停止**（精确区分） | `session/follow` 的 `turn/end` | ❌ |

节点 2 的 `intent.kind === 'plan-review'` 是**计划模式待批**，文案要与普通提问区分。

### P1 —— 本版本一并做

| # | 节点 | 来源 | 备注 |
|---|---|---|---|
| 5 | **每日简报** | 本地定时 | **兼作 24h 推送窗口的心跳**（见 §7） |
| 6 | **额度将尽 / 被限流** | 本地额度查询 | 挂「升级 or 带新用户」双路钩子 |
| 7 | **会员即将过期 / 已过期** | 账号订阅到期时间 | 挂「续费 or 带新用户换时长」双路钩子 |

节点 6、7 是**痛点时刻**，复用既有的双路增长逻辑（升级 ↔ 带新用户）。文案必须遵守既有口径：**只有邀请人得奖励，绝不写「双方都得」**。

## 6. 三个硬约束（直接影响产品形态）

### ① 审批有寿命，过期静默丢失
审批只在 turn 开着时有效，绑在请求的 `AbortSignal` 上。**用户回晚了，答案被丢弃，而任务那边已经按「没批准」失败收场了。**

→ **绝不能把「没回复」当默认同意。** 消息上必须能显示「这条已过期」。

### ② 事件不重放
`$events` 的 emit **不重放**。bridge 不在线时发生的审批直接 `unavailable`（fail-closed），**事后补不了通知**。

→ 重连要快；「漏了」要能识别并如实告诉用户，不能装作没事。

### ③ fail-closed 是默认
`ctx.approval` 的水位下降回退是 `"unavailable"` —— 没有任何应答者时，请求**失败**而非放行。

→ 我们的通道挂掉绝不能导致「意外放行」。这是安全性质，测试要覆盖。

## 7. 24 小时推送窗口

微信对主动推送有会话窗口限制，超时后推送会失败（实测 `notifystart` 带无效 token 返回 `errcode:-14 session timeout`）。

**尚未真机验证**：窗口是否就是 `-14`，需要真实绑定后等 24 小时再发一次才能确认。

防御式设计：
- 任何推送失败**都不丢事件**，降级为面板内提示「微信推送已静默，回复一条即可恢复」
- **每日简报是维持窗口的产品机制**：用户每天回一句，窗口就续上

## 8. 安全

| 面 | 措施 |
|---|---|
| 微信 ↔ ilink | TLS |
| bridge ↔ ilink | HTTPS + `Bearer bot_token` |
| `bot_token` 落盘 | `0600` + Windows 显式收紧 ACL（沿用 `hardenFile`） |
| 面板 API | **永不回显 token**，只回 `{bound, botId, boundAt}` |
| 解绑 | 停轮询 → `notifystop` → 删凭据 |
| bridge ↔ DSH | loopback + 复用 bridge 已有的 `.harness-cookie.json` |

> 📌 本模块**不需要** E2EE：微信方向走 TLS，DSH 方向走 loopback。`E2eeSession.keyFor` 的 kind 是闭集（`http|http-resp|w|ctrl`），新增 kind 会牵动浏览器侧字节级对等测试 —— **不要复用 E2EE 通道**。

## 9. 状态模型

**只有两态：已绑定 / 未绑定。** 在线离线不参与产品逻辑。

面板显示：`已绑定 · 连接正常` / `已绑定 · 最近一次推送失败` / `未绑定`。健康指示只是提示，**不改变绑定状态**。

状态经 `<relayDir>/.wechat-state.json` 暴露给插件宿主半边（沿用 `persistBridgeState` 的文件约定，`0600`）。

## 10. 绑定流程

1. 面板点「连接微信机器人」
2. bridge `get_bot_qrcode` → 拿 `qrcode` + `qrcode_img_content`(URL)
3. bridge 返回 URL，面板**本地渲染二维码**（零依赖 QR 编码器，实现在 bridge 侧，面板与手机端复用同一接口）
4. bridge 轮询 `get_qrcode_status`（35s 长轮询）
5. 按 §3 状态机推进；`need_verifycode` 时面板弹配对码输入框
6. `confirmed` → 落盘凭据 → 启动 `getupdates` 长轮询 → `notifystart`
7. 上报「已绑定」信号

## 11. 待验证清单（未经真机确认，验收时必须标注）

> **2026-09-20 更新**：下列 1–3 已做实测复核，结论见 §14。剩余项仍需真机扫码/长跑才能定论。

1. 真实的 `approval/request` **帧形状** —— 本机 `approval: never`，发不出该事件；现有形状来自类型定义与网关校验器
2. `user-questions/request` 的真实帧形状 —— 同上
3. `session/follow` 上**实时** `turn/end` 帧 —— 只验证过 snapshot，未捕捉到实时 turn 边界
4. `$events/result` 的 `outcome` 编码在真实审批上的往返 —— 只验证到路由/信封/参数校验正确
5. 24h 窗口与 `-14` 的对应关系
6. `session/control` 返回约 19 个会话且无可见的按会话授权 —— 作为通知器读取前需确认这是预期的授权性质

## 14. 实测复核记录（2026-09-20，真实 DSH，非 mock）

用真实 `~/.dsh-remote/.harness-cookie.json` 对 `ws://127.0.0.1:3080/api/remote.mux` 做的实测。

### 14.1 已验证成立

- **连接与鉴权 OK**：订阅 `$events` 后收到 `ready`，含真实 `clientId` 与 `host.home`；无 `auth-error`、无 `fault`。cookie 认证与 mux 信封都对。
- **`session/control` 可用且零参数**：首帧 `{type:"baseline", value:{queues,jobs,projections}}`，随后持续 `{type:"projection", sessionId, key, value, seq}`。
  - ⚠️ `baseline` 的键实测是 `queues / jobs / projections` —— **没有 `sessions` 键**，别去读不存在的字段。
  - `projection` 帧**带真实 sessionId**（实测看到两个正在跑的会话）。
  - 观测到的 projection key：`sessionStats`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`subagentTiming`。

### 14.2 🔴 重要限制：`$events` 连接时**不给快照**

`$events` **只在变化时发帧，不回放，也不告诉你有谁已经存在**。实测：订阅后 10 秒内只有 1 帧 `ready`、0 条业务帧（裸 mux 探针与 `dsh-events.mjs` 结果一致，故非实现问题，是协议语义）。

**后果**：bridge 重启时若有任务正在跑，我们**永远不会 follow 那个会话**，拿不到它的 `turn/end` —— 而「任务停止（精确区分完成/中断/中止/超 token）」正是 P0 节点 4。叠加「事件不重放」，这条通知会静默丢失，用户会以为任务还在跑。

**解法（已实测可行）**：把 `session/control` 作为**会话发现源** —— 连接（含每次重连）时同时开一条，从 `baseline`/`projection` 发现活跃会话 id，据此开 `session/follow`。

### 14.3 顺带确认的实现约定

- `SessionCooldown` **没有 `isActive()`**，只有 `remainingMs()` / `remainingMinutes()` / `arm()`。编排层必须用 `remainingMs() > 0` 判冷却 —— 写成 `cooldown.isActive && cooldown.isActive()` 会**静默短路成 false**，导致 `-14` 冷却完全失效、猛打接口。已由测试锁死。

### 14.4 🔴 `waterfall`（审批/提问）的真实帧形状是**包在 `item` 里**

```
{"type":"item","streamId":"<订阅器自己生成的 id>","value":{"type":"waterfall","event":"approval/request","eventId":…,"agentId":…,"request":{…}}}
```

证据（均已查 DSH 源码）：
- `dsh-api-gateway/lib/index.js` 的 `pump()`：`for await (const value of source) await this.send({type:"item",streamId,value})` —— **每一个**生成器产出都被这层包住。
- 生产者在同文件把 `{type:"waterfall",…}` 推进 per-client queue，queue 的产出就是上面那个 `value`。
- DSH **自己的浏览器客户端** `dsh-api-gateway/lib/client.js:729` 在 `value.type === "waterfall"` 上解析 —— 若真机发顶层帧，DSH 自己的 UI 会把**每一次审批**都丢掉，而审批正是那个 UI 在答的。这是最硬的反证。
- `dsh-client-connection/lib/client.js:5599` 的顶层字面量是**测试 fixture**（`approvalInvocation`，reason 写着「fixture 常驻审批」），不是协议。

**两个必须注意的坑**：
1. `request` 里**不能带 `agent` / `signal`** —— 客户端校验器 `hasExactRemoteEventKeys` + `!Object.hasOwn(request,"agent")` 会直接判非法。
2. 回推帧必须带**订阅器自己生成的 `streamId`**：`#onTextFrame` 有 `if (stream === undefined) return;`，未知流的帧会被直接丢掉。

> ⚠️ **一条方法论教训（真实踩过）**：本文件的端到端测试最初用**顶层** waterfall 构造假上游，
> 于是它只验证了假上游自己 —— 对真实链路零背书，还让我把"我的假上游不对"误判成
> "协议是顶层形态"。**假上游的形状必须逐条对着真源码核**，否则 e2e 给的是假信心。
> 现已按真实形状重写，并做变异校验：砍掉**内嵌**（真实）分支 → 恰好 3 条审批用例失败，
> 而"顶层兜底"那条仍通过（说明用例能精确区分主路径与兜底，不是一起红）。

## 15. 两个上游模块的**词表不一致**（集成踩坑记录）

`dsh-events.mjs`（事件侧，按"事件语义"命名）与 `wechat-channel.mjs`（文案侧，按"展示语义"命名）是并行开发的，**两边各自单测全绿，拼起来互不认识** —— 表现为用户收到「未知节点 digest-due」，提问消息没有任何可回选项。

翻译点**只在编排层**（`wechat-runtime.mjs` 的 `EVENT_KIND_TO_FORMATTER_KIND`），不改任一上游：两边各自的名字都对，耦合点只有一处，放这里能被一条测试完整覆盖。

| 事件侧 kind | 文案侧 kind |
|---|---|
| `approval-request` | `approval` |
| `user-question` | `question` |
| `plan-review` | `plan` |
| `session-error` | `error` |
| `turn-end` | `stopped` |
| `digest-due` | `daily` |
| `quota-low` | `quota` |
| `membership-expiring` | `membership` |

字段名同样错位，必须对齐：事件侧 `toolName` → 文案侧 `tool`；提问的选项埋在 `questions[].options` → 文案侧读 `options`；简报读 `lines`。

`assertKindCoverage()` 会**在启动时**检查事件侧每个 kind 都有归宿 —— 上游将来新增节点而编排层忘了接，会当场抛错，而不是等用户收到「未知节点」。

## 12. 决策记录

| 决策 | 结论 |
|---|---|
| 通道实现方式 | **自建直连 ilink**，不驱动 OpenClaw |
| 发布方式 | **插件一次性下发**，本版本不再追加 |
| 回执能力 | **通知 + 一步回执**（回复编号） |
| 关键节点 | P0 四项 + P1 每日简报 / 额度提醒 / 会员过期提醒 |
| 停止的精确度 | **精确区分**（完成/中断/中止/超 token），需 `session/follow` |
| 后台首页 | **融合经营数据，不新增独立页** |
| v1 不做 | 自由文本对话 |

## 13. 顺带修复

`clients/dsh-remote/dsh-bridge.mjs:26` 的注释写的是 `/api/events.mux`，但 DSH 内 `events.mux` **零命中**，真路径是 `/api/remote.mux`（`REMOTE_STREAM_MUX_PATH`）。

线上无影响（bridge 透明代理，路径由浏览器决定），但这个注释会直接误导本模块的实现者。一并修正。注意 `clients/dsh-remote/test/` 下有若干测试把 `events.mux` 当**样本字符串**用（E2EE WS 策略），那些是无害的，但改名时需一并核对。

## 16. v2：从「通知器」到「DSH 遥控器」的产品决策记录

v2 起微信通道能 `session/create` + `session/prompt` —— 也就是**能真正驱动电脑上的 agent**。
下面是随之定下的边界，避免以后被"顺手放宽"或"顺手收紧"。

### 16.1 权限：必须注册登录

两道闸，缺一不可：
- **bridge 侧**：`beginBind()` 先查 `<relayDir>/.dsh-config.json` 有没有 `phone`，没有就返回
  `login_required` —— **连二维码都不下发**。刻意这样做：给码再拦会让用户白扫一次，体验更差。
- **面板侧**：未登录时**不渲染** `微信机器人通道` tab；若登录态在 tab 打开期间失效，回落首页。

### 16.2 破坏性操作的审批：**不给一步回执**

能跑命令之后，手机上点一下的代价太低。命中破坏性判定时，微信只推「需要你到电脑上确认」，
**不带编号选项**；用户就算回数字也**不产生任何回执**。

⚠️ **这条边界曾经过严，已按业主决定放宽（2026-09-22）**：最初还有一条
「能跑命令的工具 + 完全看不到内容 → 也算破坏性」。但 DSH 的审批节点**本来就只有
`toolName`、常常不带命令原文**，那条规则会把**绝大多数正常 Bash 审批**都变成
"只能回电脑确认"。业主明确：安全边界可以松一点，**DSH 自身有权限控制**。

现在的判据**只看内容**：
- 内容里看得出删除 / 强推 / DROP / 批量覆盖 → 拦；
- **内容为空 → 不拦**，按普通审批给一步回执。

文案必须与实现一致（不得出现"因为看不见所以不给点"这种说法）：
| 降级原因 | 微信文案 |
|---|---|
| 内容命中破坏性模式 | 「这一步的**内容**被判定为破坏性操作(删除/强推/覆盖等)」 |
| 工具本身是删除/覆盖类（按工具名判） | 「这个**工具本身**属于删除/覆盖类」 |

> 判定仍刻意**不**涵盖 `Write`/`Edit` 改普通仓库文件、以及非强推的 `git push`——
> 把 agent 的日常动作也算危险，用户会对提示脱敏，安全网就废了。

### 16.3 完成推送必须带「会话名称 + 结论」

只推「任务已停止」信息量为零。现在推：
```
【任务正常完成】            ← 停止原因精确区分(完成/中止/中断/超token)
会话:<session/list 的 title>
结论:<session/page 最后一条助手消息,超长显式标注已截断>
回复这条消息就能接着这个会话往下做,不用重新交代背景。
```
名称取自 `session/list` 的 `projections.values.title`，结论取自 `session/page` 的
`records[]` —— **都是 DSH 原生能力，不是我们拼凑的**。

### 16.4 「当前会话」指针必须落盘

微信是线性的、DSH 是多会话的，所以需要一个"当前会话"指针。它**必须持久化**：
否则 bridge 一重启，用户之前选好的任务就丢了，他再发一句话会**静默开成一个新任务**，
而用户完全无从察觉。已由测试锁死（"重启后必须接着原会话"）。

### 16.5 指令表

| 指令 | 作用 |
|---|---|
| `/new <任务>` | 建会话 + 下发任务（`cwd` 默认沿用最近/当前会话的项目） |
| `/ls`（别名 `/list` `/sessions`） | 列出最近会话（**带名称**）+ 编号 |
| `/use <n>` | 切换当前会话（落盘） |
| `/stop` | 中断当前会话的回合 |
| `/status` | 绑定状态 + 当前会话 |
| `/summary` | 重发当前会话的最近结论 |
| `/quiet` `/unbind` `/help` | 免打扰 / 解绑 / 帮助 |
| **纯文本** | 有当前会话 → 发给它；没有 → 等同 `/new` |

⚠️ 分派顺序必须是 **命令 → 数字 → 普通消息**：数字若不优先于普通消息，
用户回复「1」做审批时会被当成给会话的文本发进去。


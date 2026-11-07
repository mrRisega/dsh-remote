# 飞书机器人通道 —— 模块 API / 契约 / 真实联调步骤（2026-11-08）

> 实现：`clients/dsh-remote/feishu-bot.mjs`（bridge 侧，懒加载官方 SDK）
> 调研依据：`research/2026-11-strategy/06-multiagent/feishu-long-connection.md`
> 依赖策略：`research/2026-11-strategy/06-multiagent/feishu-lazy-sdk-plan.md`

## 0. 一句话

飞书「企业自建应用」长连接机器人：**收消息 / 发通知 / 卡片拍板**，与企微、钉钉、微信并列的第四条通道；
**官方 SDK 不随安装包分发**（约 41MB），用户在面板点「下载依赖」后才懒加载；`package.json` 里**没有**这个依赖。
**接收人不需要用户填**：默认自动绑定（连上后用 `chat.list` 选机器人所在的群；或用户第一句话即绑定）。

---

## 1. 依赖策略（业主明确要求）

| 项 | 做法 |
|---|---|
| `package.json` | **不声明** `@larksuiteoapi/node-sdk`（安装体积不变） |
| 下载位置 | `<relayDir>/im-deps/node_modules/@larksuiteoapi/node-sdk`（npm `--prefix` 本地安装；relayDir 默认 `~/.dsh-remote`） |
| 下载命令（插件/安装器执行） | `npm install --prefix <relayDir>/im-deps --no-save --no-audit --no-fund @larksuiteoapi/node-sdk` |
| 进度/失败 | 面板显示下载/解压/完成/失败；失败给人话（网络/磁盘/权限），可重试 |
| 运行时 | `loadFeishuSdk()` 动态 `import()` 入口（从 `package.json` 的 `main` 解析）+ 缓存；**没启用飞书就不加载** |
| 未下载 | 状态 `feishu.state = "sdk_missing"`、`deps.feishu.installed=false`，**不崩、不阻塞其它通道**；面板显示「下载依赖（约 41MB）」 |
| 卸载 | 「彻底卸载」默认一并删除 `im-deps/`（与调研方案一致） |

> 可选环境变量：`DSH_IM_DEPS_DIR` 覆盖依赖根目录（自建/测试用）。

---

## 2. 配置文件契约：`im-bots.json`（插件写、桥只读，0600）

```jsonc
{
  "version": 1,
  "wecom":  { "...": "不变" },
  "dingtalk": { "...": "不变" },
  "feishu": {
    "enabled": false,
    "appId": "",                 // cli_ 开头；SDK 有严格正则（cli_+16 hex），不匹配会"保存成功但连不上"
    "appSecret": "",
    "domain": "feishu",          // feishu=open.feishu.cn | lark=open.larksuite.com（国际版）
    "receiveId": "",             // **可选/高级场景**：手工指定推送目标；空 = 自动绑定（推荐留空）
    "receiveIdType": "",         // **可选**："open_id" | "chat_id"；空 = 按 boundChatType 自动判断
    "boundChatId": "",           // 桥写回/可预填：自动绑定的目标（面板只读展示）
    "allowFrom": [],             // open_id 白名单（空 = 不限制；建议填写）
    "cardApproval": true,        // 审批用卡片按钮（false = 纯文本 + 回电脑拍板）
    "sdkVersion": "",            // 下载成功后回写（面板展示）
    "sessionId": "",             // 可选：固定转发目标会话（空 = 跟随当前活跃会话）
    "sessionTitle": ""
  }
}
```

**不加** `verifyToken` / `encryptKey`：长连接模式下事件/回调由 SDK 内部解密分发，那两个字段只属于 HTTP 回调模式。

## 3. 状态契约：`im-bot-status.json`（桥写，原子替换 + 0600）

```jsonc
{
  "version": 1, "updatedAt": 0,
  "wecom": { "...": "不变" },
  "dingtalk": { "...": "不变" },
  "feishu": {
    "enabled": true, "state": "idle|connecting|connected|reconnecting|failed|sdk_missing",
    "connected": true, "authenticated": true,
    "lastError": "", "lastConnectedAt": 0, "lastMessageAt": 0,
    "boundChatId": "oc_xxx 或 ou_xxx",   // 自动绑定的目标
    "boundChatType": "chat_id|open_id",  // 决定发送用的 receive_id_type
    "boundChatName": "项目群",            // 群名（面板显示「已自动绑定：<群名>」）
    "chatCount": 1,                      // 机器人所在群数（chat.list；null=没权限/没查到）
    "receiveIdSource": "auto_group|auto|config|none", // 接收人来源
    "receiveIdConfigured": false,        // 用户是否手工填了 receiveId
    "appId": "cli_9f42***b1", "domain": "feishu", "receiveIdType": "open_id",
    "cardApproval": true, "sdkVersion": "1.76.0",
    "tier": "free", "caps": ["..."], "limits": { "messages_per_month": 20 },
    "usage": { "month": "2026-11", "messages": 0 },
    "ackCount": 0, "decisionCount": 0
  },
  "deps": {
    "feishu": { "installed": true, "version": "1.76.0", "path": "<...>/node_modules/@larksuiteoapi/node-sdk/index.js", "lastError": "" }
  }
}
```

- 与企微/钉钉字段对齐；飞书**多一个 `state`**（5 态便于排查）。
- **只加不改**：写状态时先读旧文件再合并，绝不覆盖 `wecom` / `dingtalk` 段。
- `secret` 不出现在状态文件与日志里。

---

## 4. 模块 API

```js
import {
  feishuSdkStatus, loadFeishuSdk,              // 依赖
  validateAppId, normalizeFeishuConfig, readFeishuConfig,
  buildApprovalCard, buildDecidedCard, parseCardAction,
  formatFeishuText, extractFeishuMessageText, normalizeInboundEvent,
  feishuErrorHint, mapConnectError,
  createFeishuSender, createFeishuBot, createFeishuBotController,
  FEISHU_SETUP_GUIDE, FEISHU_ERROR_HINTS
} from "./feishu-bot.mjs";
```

| 导出 | 用途 |
|---|---|
| `feishuSdkStatus({relayDir, env})` | 只读探测依赖：`{installed,version,path,depsDir,lastError}`（面板用；不发网络） |
| `loadFeishuSdk({relayDir, env, sdkFactory, importImpl})` | 懒加载 + 缓存；`sdkFactory` 注入供测试 |
| `validateAppId(appId)` | `{ok,strict,warning?}`：宽松只拦明显错；不通过 SDK 严格正则时给 warning |
| `normalizeFeishuConfig / readFeishuConfig` | 配置归一 / 读 `im-bots.json` |
| `buildApprovalCard / buildDecidedCard` | 卡片 JSON 2.0（按钮 `behaviors:[{type:"callback",value}]`） |
| `parseCardAction` | 解析 `card.action.trigger`（operator/context/expiresAt） |
| `createFeishuSender` | tenant_access_token（缓存+失效刷新一次）+ 发消息 + PATCH 卡片 |
| `createFeishuBot` | `{start,stop,sendText,sendCard,patchCard,status,on}`；事件 `message/cardAction/ready/status` |
| `createFeishuBotController` | bridge 只接这个：`{start,stop,status}`；读配置 + 2s 热更新 + 状态原子写 + 会员闸 + 通知 |
| `FEISHU_SETUP_GUIDE` | 官方链接 + **8 步向导文案** + 顺序坑提示（插件半直接渲染） |

### 4.1 卡片回执时序（3 秒铁律）

```
用户点按钮 → card.action.trigger（长连接）
   ├─① 同步返回 {toast:{type:"success"}, card:{type:"raw",data:已决定卡片}}   ← 必须在 3s 内
   ├─② 幂等：同一 requestId+action 第二次点只回 toast（10 分钟 TTL）
   ├─③ 过期（expiresAt 已过）→ toast「已过期（未回复按拒绝处理）」，**不交决策**
   └─④ 异步把决策交给 onApprovalDecision(requestId, "allow"|"deny")
          ↓ bridge 注入的是 applyApprovalDecision（与手机拍板/企微卡片同一条路）
```

`allow` 只对应「允许一次」，不会变成永久放行；无决策来源时只 ACK 不生效（并记日志）。

### 4.2 接收人自动绑定（业主口径：不用用户填）

```
连接成功 ──▶ chat.list({page_size:20})            ← 需要可选权限 im:chat:readonly
   ├─ 1 个群       → 绑定它（receiveIdSource=auto_group，状态写 boundChatId/boundChatType=chat_id/boundChatName）
   ├─ 多个群       → 取第一个并计 chatCount（用户发消息即改绑；面板可提示"多个群"）
   ├─ 空列表       → 不绑定，等首条消息
   └─ 无权限/失败  → 只记日志（连接、发消息、消息绑定都不受影响）
首次收到消息 ──▶ 绑定该会话（单聊=sender.open_id；群=chat_id），覆盖 auto_group（receiveIdSource=auto）
配置里填了 receiveId ──▶ 永远优先（receiveIdSource=config；chat.list 只记录 chatCount，不覆盖）
未绑定 ──▶ 主动通知/审批卡跳过 + 记一条可读日志（不报错、不发请求）；绑定成功后立即写状态
```

- 发送时 `receive_id_type` 优先级：显式传参（内部回复）＞ **配置 `receiveId` 存在时**的 `receiveIdType` ＞ 按 `boundChatType` 自动判断（`chat_id`/`open_id`）。
  注意：`receiveId` 为空时，插件写的默认 `receiveIdType:"open_id"` **不生效**（否则会把群 `oc_…` 当 open_id 发）。
- chat.list 拿到群列表后，即使不覆盖绑定（配置优先/预填），也会按 `boundChatId` 补上 `boundChatName`（面板显示群名）。
- 配置里可预填 `boundChatId`（兼容旧配置/排障）：`oc_` 开头按群、其余按 open_id；
  **预填优先于 chat.list**（不会被"第一个群"覆盖，群数仍记录）。

---

## 5. 配置页向导（插件半照抄 `FEISHU_SETUP_GUIDE`）

**主路径只有两件事**（展示在第一层）：
1. 创建一个企业自建应用，复制 **App ID / App Secret**（接收人不用填）
2. 填进面板 → 下载依赖 → 在飞书里给机器人**发一句话**（或机器人已在群里则自动绑定）

官方链接（业主 2026-11-08 提供，一字不改）：
- 创建企业自建应用：<https://open.feishu.cn/app?lang=zh-CN>
- 卡片交互机器人文档：<https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/develop-a-card-interactive-bot>
- 使用长连接接收事件：<https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case>

其余后台步骤折叠在「**需要更细的步骤**」里（首次配置仍需做完）：

| # | 步骤 |
|---|---|
| 1 | 打开飞书开放平台 → 创建**企业自建应用**（商店应用不支持长连接） |
| 2 | 「凭证与基础信息」→ 复制 **App ID / App Secret** |
| 3 | 「添加应用能力」→ 开启**机器人** |
| 4 | 「权限管理」→ 申请收消息（`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`）与发消息（`im:message:send_as_bot`） |
| 5 | 「事件与回调 → 事件配置」→ 订阅方式选**使用长连接接收事件** → 添加「接收消息 v2.0」 |
| 6 | 「事件与回调 → 回调配置」→ 订阅方式选**使用长连接接收回调** → 添加 `card.action.trigger` |
| 7 | 「版本管理与发布」→ 创建版本并**发布**（不发布不生效）；「可用范围」包含自己/目标成员 |
| 8 | 回到面板：填 App ID / Secret → **下载依赖** → **测试连接** → 在飞书里给机器人发一句话完成绑定 |

⚠️ **顺序坑**：保存事件/回调配置时，**必须已经有一个长连接在线**（否则提示「应用未建立长连接」）。
所以先在本机填凭据让连接起来，再去后台保存配置。
⚠️ **一个应用只挂一台电脑**（官方集群随机分发，多台会互抢事件；单应用上限 50 连接）。

---

## 6. 真实联调步骤（最小路径：只填 App ID/Secret）

> Lead 2026-11-08 用业主真实凭据实测：SDK 动态加载成功、`tenant_access_token` OK（781ms）、
> `WSClient` `state:"connected"`（**只要 App ID/Secret 就能连上，不需要额外配置**）、
> `client.im.v1.chat.list()` 能列出机器人所在群、`im.v1.message.create({receive_id_type:"chat_id"})` 发送成功。

1. **建应用**（企业自建）→ 复制 **App ID / App Secret**；开机器人能力、申请收发消息权限、事件/回调切长连接、发版（按 §5 折叠的步骤）。
2. **本机下载依赖**（面板按钮等价命令）：
   `npm install --prefix ~/.dsh-remote/im-deps --no-save --no-audit --no-fund @larksuiteoapi/node-sdk`
3. **写配置（只需要两样）**：`im-bots.json` 的 `feishu.{enabled:true, appId, appSecret}`。
   **`receiveId` / `receiveIdType` 留空** —— 不需要填。
4. **启动 bridge** → 状态 `feishu.state → connected`；随后自动绑定：
   - 机器人已在群里 → `chat.list` 自动选中并写 `boundChatId`（`receiveIdSource:"auto_group"`，面板显示「已自动绑定：<群名>」）；
   - 机器人还没进群 → 状态 `boundChatId:""`，此时通知会跳过（只记日志），**在飞书里给机器人发一句话**即自动绑定（私聊记 `open_id`、群聊记 `chat_id`）。
5. **验收**：
   - 出站：电脑上让 agent 跑一个任务 → 飞书收到「任务完成/出错」通知；
   - 入站：飞书发一句话 → 电脑端当前会话收到（免费档每月 20 条，超出有升级提示）；
   - 拍板：触发一次需要审批的操作 → 飞书收到卡片 → 点「允许一次」→ 卡片原地变「已允许」+ 电脑端继续；点「拒绝」→ 电脑端拒绝；**不回** → 90s 后按拒绝处理。
8. **排障对照**（状态文件 `feishu.lastError`）：
   - 凭据错 / 应用未发版 / 权限未申请 / 订阅方式没切长连接 / 可用范围不含你 / 机器人不在群 —— 都有对应人话（`FEISHU_ERROR_HINTS` / `mapConnectError`）。
   - 企业网络走代理 → 明确提示「长连接不支持代理」。

---

## 7. 已知限制 / 未核实

1. **本模块未做真机联调**：SDK/网络全部注入假实现单测（51 条）；真实建连、卡片回调、发版生效需按 §6 验一次。
   （已做只读验证：本机真实 SDK 1.76.0 能被 `loadFeishuSdk` 动态加载，`Client/WSClient/EventDispatcher` 均存在。）
2. **卡片回调能否走长连接**：官方文档说可以；SDK README 有一句相反表述（调研 R8）。真机点一次按钮确认。
3. `patchCard`（原地更新）用 REST PATCH，官方权限/版本限制未核实；失败只记日志（不影响 ACK）。
4. 流式回复：飞书没有该能力（调研 §4.3），本模块不提供；通知/审批不需要。
5. 群聊只处理 @机器人 的消息由飞书侧决定（我们按收到的消息处理）；多设备抢事件需「一个应用一台电脑」。
6. **自动选群**（`chat.list`）需要可选权限 `im:chat:readonly`：**没这个权限也能用**（回落到"首条消息绑定"），
   只是不能"连上即绑定群"；多个群时取第一个（用户发消息会改绑），面板可用 `chatCount` 提示。
7. 私聊绑定记的是 `sender.open_id`（不是 chat_id）：用户换群/换会话不会发错地方；群绑定记 `chat_id`。

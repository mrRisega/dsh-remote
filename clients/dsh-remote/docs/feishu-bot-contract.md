# 飞书机器人通道 —— 模块 API / 契约 / 真实联调步骤（2026-11-08）

> 实现：`clients/dsh-remote/feishu-bot.mjs`（bridge 侧，懒加载官方 SDK）
> 调研依据：`research/2026-11-strategy/06-multiagent/feishu-long-connection.md`
> 依赖策略：`research/2026-11-strategy/06-multiagent/feishu-lazy-sdk-plan.md`

## 0. 一句话

飞书「企业自建应用」长连接机器人：**收消息 / 发通知 / 卡片拍板**，与企微、钉钉、微信并列的第四条通道；
**官方 SDK 不随安装包分发**（约 41MB），用户在面板点「下载依赖」后才懒加载；`package.json` 里**没有**这个依赖。

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
    "receiveId": "",             // 主动推送目标（open_id 或 chat_id）；空 = 用最近一次入站的 chat_id
    "receiveIdType": "",         // "open_id" | "chat_id"（空 = 按有无绑定推导）
    "boundChatId": "",           // 桥写回：最近一次收到消息的 chat_id（面板只读展示）
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
    "lastError": "", "lastConnectedAt": 0, "lastMessageAt": 0, "boundChatId": "",
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

---

## 5. 配置页 8 步向导（插件半照抄 `FEISHU_SETUP_GUIDE`）

顶部固定两条官方链接（**业主明确要求**）：
- 使用长连接接收事件：<https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case>
- 注册/创建应用：<https://open.feishu.cn/app>

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

## 6. 真实联调步骤（需要业主：建应用 + 发版）

前置：Windows/macOS 任一真机、能访问公网（**长连接不支持代理**）、企业管理员权限（发版）。

1. **建应用并配置**（按上面 8 步，先只做 1–4 与 7 的权限/能力部分，事件/回调等第 4 步做完再回来配）。
2. **本机下载依赖**（面板按钮等价命令）：
   `npm install --prefix ~/.dsh-remote/im-deps --no-save --no-audit --no-fund @larksuiteoapi/node-sdk`
3. **写配置**（面板写入或手工）：`im-bots.json` 的 `feishu.{enabled:true,appId,appSecret,allowFrom:[你的 open_id]}`。
4. **看状态**：bridge 日志出现 `[feishu] 长连接已发起`；`im-bot-status.json` 的 `feishu.state → connected`。
5. **回去配事件/回调**（第 5、6 步）→ 发布版本（第 7 步）。
6. **绑定**：在飞书里给机器人发一句话 → 状态 `boundChatId` 出现 → 面板显示已绑定。
7. **验收**：
   - 出站：电脑上让 agent 跑一个任务 → 飞书收到「任务完成/出错」通知；
   - 入站：飞书发一句话 → 电脑端当前会话收到（免费档每月 20 条，超出有升级提示）；
   - 拍板：触发一次需要审批的操作 → 飞书收到卡片 → 点「允许一次」→ 卡片原地变「已允许」+ 电脑端继续；点「拒绝」→ 电脑端拒绝；**不回** → 90s 后按拒绝处理。
8. **排障对照**（状态文件 `feishu.lastError`）：
   - 凭据错 / 应用未发版 / 权限未申请 / 订阅方式没切长连接 / 可用范围不含你 / 机器人不在群 —— 都有对应人话（`FEISHU_ERROR_HINTS` / `mapConnectError`）。
   - 企业网络走代理 → 明确提示「长连接不支持代理」。

---

## 7. 已知限制 / 未核实

1. **本模块未做真机联调**：SDK/网络全部注入假实现单测（42 条）；真实建连、卡片回调、发版生效需业主按 §6 验一次。
2. **卡片回调能否走长连接**：官方文档说可以；SDK README 有一句相反表述（调研 R8）。真机点一次按钮确认。
3. `patchCard`（原地更新）用 REST PATCH，官方权限/版本限制未核实；失败只记日志（不影响 ACK）。
4. 流式回复：飞书没有该能力（调研 §4.3），本模块不提供；通知/审批不需要。
5. 群聊只处理 @机器人 的消息由飞书侧决定（我们按收到的消息处理）；多设备抢事件需「一个应用一台电脑」。

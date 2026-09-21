# 匿名装机统计（遥测）与隐私边界

本文面向**用户与审计者**：dsh-remote 的「匿名装机统计」通道到底采集什么、不采集什么、
数据长什么样、如何**彻底关闭**，以及你如何自己核实这些说法。

- 实现代码（客户端半）：[`packages/dsh-remote-web/lib/index.js`](../packages/dsh-remote-web/lib/index.js)
  中的「匿名装机/连接遥测」段落（唯一的 payload 构造点是 `telemetryEventOf()`）。
- 关闭开关：环境变量 `DSH_REMOTE_TELEMETRY=0`（见下文「如何关闭」）。
- README 摘要：[README「匿名装机统计与隐私」](../README.md#匿名装机统计与隐私)。

---

## 1. 为什么要做这个统计

2026-09 的生产诊断显示：11 个新注册用户里只有 3 人最终把设备连上——**6 人电脑端从未装上**、
**2 人装了但 bridge 没连上**。而「装不上」的机器**没有任何账号、也就没有任何数据**，
于是「我本地好好的，新机器上失败」这类问题在服务端永远无法归因。

这条通道只补这一段事实：**装机与连接是否成功、卡在哪一步**，用来：

- 判断某个版本的补装成功率是否下降（回归预警）；
- 判断失败集中在哪一类原因（没装 node / npm 源不通 / 权限不足 / 平台不支持 / 安装超时）；
- 判断「注册了但手机端看不到设备」的用户，是卡在补装、卡在 bridge 拉起，还是卡在中继注册。

它**不**用于、也**不能**用于：识别具体用户、分析使用内容、投放或画像。

## 2. 采集什么（全部字段，无其他）

一次请求（批量）的 body：

```json
{
  "install_id": "3f2b1c8e-9a4d-4c1e-8b77-0d5f6a2e9c31",
  "source": "plugin",
  "events": [
    { "name": "install_started", "at": 1789000000000, "version": "0.6.4-beta.4", "os": "darwin", "arch": "arm64", "node": "22" },
    { "name": "install_failed", "fail_code": "npm_unreachable", "at": 1789000000000, "version": "0.6.4-beta.4", "os": "darwin", "arch": "arm64", "node": "22" }
  ]
}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `install_id` | 本机随机 UUID | **本机生成**的随机 ID（`crypto.randomUUID()`），非硬件派生、不含机器信息；换机或删除后重装即变，**不可跨机器关联同一个人** |
| `source` | `plugin` | 目前只由插件（node 半）上报 |
| `name` | 事件名白名单 | 见下表 |
| `fail_code` | 失败码白名单 | 仅 `install_failed` / `update_failed` 附带 |
| `at` | 毫秒时间戳 | 事件发生时间 |
| `version` | 插件版本号 | 例如 `0.6.4-beta.4` |
| `os` | `process.platform` | 仅平台名：`darwin` / `linux` / `win32` |
| `arch` | `process.arch` | 仅架构：`arm64` / `x64` |
| `node` | 主版本号字符串 | 例如 `"22"`（**不含**次版本、补丁、路径） |

### 事件名白名单（只发这些，其它一律不发）

`install_started`（开始补装运行环境）· `install_failed`（附 `fail_code`）· `runtime_ready`（运行环境就绪）·
`bridge_started`（bridge 进程拉起）· `bridge_registered`（设备已在中继注册成功 = 真正可用）·
`tunnel_disconnected` · `first_remote_ok`（首次远程打通）· `plugin_loaded` · `panel_opened` ·
`harness_restart`（自动重启触发）· `update_started` · `update_failed`（附 `fail_code`）·
`wechat_bound` / `wechat_unbound`（微信机器人通道的**绑定态跳变**，语义见下）

### 微信机器人通道的绑定 / 解绑（`wechat_bound` / `wechat_unbound`）

微信机器人通道是**两态**的：**未绑定**或**已绑定**（状态存在用户自己电脑上的
`<relayDir>/.wechat-state.json`，只有 `bound` 这一个布尔量决定态）。为了知道"这个功能有没有人真的用起来"，
插件会在 `bound` **发生翻转**时各发一条事件：

| 事件 | 何时发 |
| --- | --- |
| `wechat_bound` | 未绑定 → 已绑定（用户扫码完成了绑定） |
| `wechat_unbound` | 已绑定 → 未绑定（用户在面板里解绑） |

口径边界（这三条决定了这些数字**能**读成什么、**不能**读成什么）：

- **只在跳变时发**：连续多次读到同一个 `bound` 值**一条都不发**。面板在扫码/绑定期间会反复轮询状态，
  若按"读到已绑定就记一条"，同一台机器的一次绑定会被刷成几十条。
- **首次观测不算绑定**：进程启动后第一次读到状态文件时，如果它**已经是** `bound: true`，说明这次绑定
  可能发生在几天前（宿主与面板过一段时间才会被打开）——此时只**播种基线**、不发 `wechat_bound`。
  把"启动时就已经绑好"当成新绑定，会把历史存量每天都虚报一遍。基线记在 `.telemetry-once.json`（`0600`）。
- **这是客户端上报的事件，不是服务端的实时存量**：绑定关系只存在用户自己的电脑上，服务端没有设备侧
  权威清单。因此统计里出现的 `0` 只代表「这个窗口内没有上报」——老版本客户端不上报、从未打开过面板或
  没跑过后台服务的机器也会漏报——**不代表「没有人绑定」**；任何"当前绑定数"都只是按 `bound − unbound`
  的**近似**（且下限为 0：解绑一台更早时期绑定的机器会让差值偏小）。
- 读取失败不等于"未绑定"：状态文件缺失、损坏或写入中断（半写）时，本次**没有观测**，不产生任何事件，
  基线也不动 —— 否则会凭空造出一次假的"跳变"。


### 失败码白名单（`fail_code`）

`node_missing` · `node_too_old` · `npm_unreachable` · `npm_eacces` · `platform_unsupported` ·
`runtime_install_timeout` · `launchd_failed` · `bridge_exit` · `bind_conflict` · `bind_device_limit` ·
`npx_cmd_unavailable` · `registry_timeout` · `install_script_missing` · `npx_exit_nonzero` ·
`npx_output_encoding` · `update_stalled`（更新进程长时间无输出、判定卡住）· `unknown`

> 原始错误文本**绝不外发**（它可能含文件路径、用户名、主机名）：只做白名单归类，
> 归不进去的一律记 `unknown`。
>
> `npx_cmd_unavailable` / `registry_timeout` / `install_script_missing` / `npx_exit_nonzero` /
> `npx_output_encoding` 是 2026-09 为定位「Windows 上装不上运行环境」而拆细的形态
> （命令调不起来 / 注册表超时 / 包或安装脚本缺失 / 退出码非零 / 输出乱码）——
> 它们仍然只是**枚举值**，不包含任何原始文本。
>
> `update_stalled`（0.6.9 新增）：更新进程**活着但长时间没有任何输出**（中国网络访问 npm 官方源的
> 典型失败形态是"挂起"而非快速失败）。它被单列出来，是为了让"卡死"这一类在统计里可见 ——
> 此前它只会落进 `unknown` 或干脆不产生事件，导致规模被持续低估。

## 3. 不采集什么（硬边界）

以下内容**不会**出现在遥测里，代码里也不存在对应字段（见 `telemetryEventOf()`）：

- ❌ 手机号、邮箱、账号 ID、设备 `device_id`、访问密钥、任何登录凭据
- ❌ 任何会话内容与文件内容（对话、工具执行、审批、凭据、文件正文、WebSocket 消息）
- ❌ 真实 **hostname**、系统用户名、家目录、任何文件路径
- ❌ 密码、JWT、`bridge_secret`、E2EE 密钥或口令
- ❌ 设备指纹 `machine_fp`（同机识别用，**只**上报给账号 API 用于顶替旧设备，不进遥测）
- ❌ 原始 IP（服务端只看到 TCP 来源，客户端不上报 IP）、精确地理位置、GPS
- ❌ 用户行为轨迹、页面浏览路径、点击流、崩溃堆栈原文
- ❌ 微信通道的任何标识：`bot_id`、`bot_token`、被绑定的微信用户标识、绑定时间等
  （`wechat_bound` / `wechat_unbound` 这两条事件**只带事件名**，代码里连读都不读状态文件里的其它字段）

遥测请求**不带 `Authorization` 头**：它是一个与账号体系解耦的匿名通道，
服务端也不接受用账号凭据关联这些事件。

## 4. 如何关闭

```bash
# 完全关闭：不生成 install_id、不落任何遥测文件、不发任何请求
export DSH_REMOTE_TELEMETRY=0
```

- 判定规则：`DSH_REMOTE_TELEMETRY` 取值 `0` / `false` / `off` / `no` → 关闭；
  未设置或 `1` / `true` → 开启（**默认开启**）。判定在每次记录/发送时读取，改完重启 dsh web 生效。
- 诊断/测试隔离开关 `DSH_RELAY_SKIP_SERVICE=1` 同样会让遥测完全不发送
  （它本来就是「不要碰外部世界」的隔离开关，本仓库测试脚本全局置位它）。
- 关闭后插件**连本机队列都不读**，`<relayDir>/.telemetry-*.json` 不会新增或发送。
- 也可以在**网络侧**屏蔽：中继/Nginx/防火墙里丢弃 `POST /api/telemetry/events`
  （插件对任何失败都静默退避，不会影响你的正常使用与面板）。
- 已经产生的本机文件可以随时删除（它们只是待发队列）：

  ```bash
  rm -f ~/.dsh-remote/.telemetry-install-id ~/.dsh-remote/.telemetry-queue.json ~/.dsh-remote/.telemetry-once.json
  ```

## 5. 本机都有哪些文件、怎么发

| 文件（`<relayDir>` 默认 `~/.dsh-remote`） | 权限 | 内容 |
| --- | --- | --- |
| `.telemetry-install-id` | `0600` | 一行随机 UUID（首次生成后复用） |
| `.telemetry-queue.json` | `0600` | 待发事件队列（上限 200 条，超出**丢最旧**） |
| `.telemetry-once.json` | `0600` | 一次性事件标记（如 `first_remote_ok` 只发一次）+ 微信通道**绑定态的基线**（上次观测到已绑定/未绑定，见第 2 节的跳变规则） |

发送行为：

- 端点：`POST <api_url>/api/telemetry/events`（`api_url` 取本机 `.dsh-config.json` 的 `api_url`，
  与安装上报同源；自建部署即你自己的服务地址）；
- 请求头：`content-type: application/json`、`x-dsh-client: dsh-remote/<version>`，**无 Authorization**；
- 批量：单批 ≤ 20 条、body ≤ 32KB；队列 ≥ 5 条立即发送，否则每 60s 一次；
- 失败退避：30s → 2m → 10m → 1h，累计 6 次仍失败则丢弃该批（不永久堆积）；
- 全程静默：任何异常都被吞掉，**不会**影响面板、bridge、连接流程或任何用户可见行为。

> 仓库测试/诊断用的加速开关 `DSH_REMOTE_TELEMETRY_MS` 会把上面的心跳与退避**按比例缩放**
> （默认不设置；生产环境请勿设置，生产值就是本文写明的这串）。

## 6. 你可以自己核实

1. 读代码：`packages/dsh-remote-web/lib/index.js` 搜 `匿名装机/连接遥测`；
   事件与失败码白名单是 `TELEMETRY_EVENT_NAMES` / `TELEMETRY_FAIL_CODES`，
   payload 唯一构造点是 `telemetryEventOf()`——字段表就是上面第 2 节。
2. 跑测试（仓库自带，含「禁止字段不得出现在 payload」的断言）：

   ```bash
   DSH_RELAY_SKIP_SERVICE=1 node --test packages/dsh-remote-web/test/telemetry.test.mjs
   ```

3. 关掉开关后抓包/看日志验证：`DSH_REMOTE_TELEMETRY=0` 时不会有任何 `/api/telemetry/events` 请求，
   也不会有 `.telemetry-*` 文件生成。

## 7. 服务端怎么处理（约定）

- 按 `install_id` + `name` 做**匿名漏斗**统计（装机成功率、失败原因分布、注册→可用转化）；
- 不与会话/账号/设备表做关联分析；不长期保存原始 `at` 精度以外的东西；
- 未知事件名、未知 `fail_code` 一律丢弃（避免脏数据污染口径）。

> 本项目的许可（PolyForm Noncommercial）与隐私承诺都建立在「如实披露」之上：
> 如果这条通道将来要增加任何字段或事件，必须先改本文与 README，再改代码。

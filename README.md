# dsh-remote — 手机远程控制 DeepSeek Harness（全功能 · App 级体验）

<p align="left">
  <a href="https://github.com/mrRisega/dsh-remote/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/mrRisega/dsh-remote?style=flat-square&label=Stars"></a>
  <img alt="npm downloads" src="https://img.shields.io/npm/dt/@mrrisega/dsh-remote?style=flat-square&label=npm%20downloads">
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f8cff?style=flat-square">
  <img alt="dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-blueviolet?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-2ea44f?style=flat-square">
</p>

> **离开电脑也能用手机 100% 全功能接管电脑上的 DeepSeek Harness（`dsh web`）**——发消息、看工具执行、审批权限、改设置、管凭据（含特权操作），操作体验与坐在电脑前完全一致。免内网穿透，局域网即连。
>
> **一条命令安装**：`npx @mrrisega/dsh-remote`

dsh-remote 是一个轻量的**隧道模式**远程控制方案：电脑端运行一个守护进程（bridge），
主动连接中继服务器（relay-router）注册为在线设备；手机浏览器打开 PWA 页面，
登录后选择设备，即可经隧道进入电脑上的 `dsh web`（HTTP / WebSocket 全量透传）。

```
手机浏览器
  └─ /app/ (PWA) 登录 → /_devices 实时设备列表 → 选择设备
       │
  nginx (HTTPS)
    ├─ /app/            → 静态 PWA (native.html)
    ├─ /_devices /_login /remote/ /_bridge / → relay-router
    └─ /_bridge         → relay-router (WebSocket)
                           └→ bridge (电脑端) → 127.0.0.1:3080 (dsh web)
```

## 0.6.7 速览（Windows 可用版）

> **预发中**：先以 `0.6.7-beta.x` 发布在 npm `beta` 通道（`latest` 仍是 0.6.6），
> 待 Windows 真机验证通过后转正式版。安装预发版：
> `npx @mrrisega/dsh-remote@0.6.7-beta.3`；若 dsh web 已起不来，用
> `npx @mrrisega/dsh-remote@0.6.7-beta.3 repair`（只修 profile，不联网）。


0.6.6 及更早的插件半整套「服务状态 / 启停 / 重启」是按 macOS/Linux 写死的
（launchctl / systemd / pgrep / ps / /bin/sh），**在 Windows 上安装一切正常、运行期必死**：
面板红字「读取状态失败: process.getuid is not a function」、状态永远停在「查询中…」、
运行环境补不上、点「重启 DeepSeek harness」还会把 dsh web 打挂。本轮全部修掉：

- **Windows 不再 500**：`process.getuid` 在 Windows 上根本不存在（不是返回 undefined），
  旧的 `launchTarget()` 无条件调它 → 所有读状态接口抛错。现在非 macOS 直接短路 launchd 查询。
- **Windows 能补上运行环境**：`spawn("npx.cmd")` 在 Node ≥20.12 起不带 shell 会抛 EINVAL。
  现在用**当前 node 直接跑 npm 自带的 `npx-cli.js`**（不经 cmd.exe），退回 `.cmd` 时必带 `shell: true`。
- **「重启 DeepSeek harness」不再打挂进程**：Windows 改用 node 跑的 `.mjs` 助手（不再 `/bin/sh`），
  且**先校验 node/入口/工作目录存在再动旧进程**，spawn 真正成功才回报成功。
- **Windows 进程发现**：安装器落 `.dsh-watcher.pid` / `.dsh-bridge.pid`，插件按 pid 判活
  （不再依赖 Windows 上不存在的 `pgrep`/`ps`），必要时用 PowerShell 扫 node 进程兜底。
- **Windows 自启动**：安装器在**任务计划程序**注册登录任务 `dsh-remote-bridge`，卸载时一并删除；
  插件自愈也会隐藏地把 bridge 拉起来（日常使用看不到控制台窗口）。
- **面板不再无限转圈**：`bridge-status` 轮询连续失败 3 次会把原因摆到连接卡上（原先静默 catch）。

> 平台支持：**macOS / Linux / Windows** 均可运行。自启动方式按平台分别是
> launchd、systemd --user、任务计划程序（Windows）。macOS/Linux 的行为与 0.6.6 完全一致。

## 0.6.4 速览（首次安装不再卡）

- **登录后 bridge 自动连上，全程零刷新**：面板自动补运行环境 → 拉起 bridge → 显示「正在连接中继…」，连上后自动变成「已连接 ✅」并刷新二维码与设备列表；失败有可读原因、自动重试倒计时和「复制诊断信息」。
- **手机端自动等待电脑上线**：空设备列表不再让人干等或手动刷新，电脑一上线设备自己出现。
- **安装引导改版**：有插件市场入口就搜索 `dsh-remote` 安装（不用敲命令）；没有就复制一条命令；两条路都收敛到「登录后稍等，电脑会自己出现」。
- **安装输出更干净**：不再重复打印同一段引导，结尾只给一份汇总（地址 / 自启动服务 / 下一步）；装完当下 dsh web 没开着也会如实说明「打开 dsh web 后 bridge 会自动启动」，不再像报错。
- **macOS 26 自启动死角已修**：macOS 26 会把 `gui/<uid>` 会话域置为 on-demand-only，`RunAtLoad` / `KeepAlive` 失效（服务只登记不启动，`runs = 0`）。现在优先用 `user/<uid>` 域启动（该域仍支持开机自启与崩溃自愈），失败才回退 `gui/<uid>` + `kickstart`（只拉起这一次，会**明确告知**不支持崩溃自愈），再不行退化为后台进程（现在能用、无自启）。自启动服务的 PATH 也补了 `/usr/sbin`、`/sbin`（bridge 要调 `ioreg`）。

**0.6.2 起已有**

- **插件市场安装即可用**：市场只装「面板插件」，桌面运行环境（bridge + 自启动）由插件在后台自动补齐；修掉了
  「装完 bridge 起不来且永远不自愈」的三处根因（运行环境缺失仍写自启动 → launchd 崩溃循环；崩溃循环被误判成
  「运行中」→ 自愈停摆；自愈顺序把运行环境排到最后）。
- **首次安装/更新后一键重启 DeepSeek harness**：面板顶部醒目提示「首次安装需要重启 DeepSeek harness」+
  「重启」按钮，面板最底部常驻「🔄 重启 DeepSeek harness」；重启后页面自动恢复，不用手动刷新。
- **状态不再说谎**：面板把「运行环境安装中 / 启动失败（已自动转入修复）」如实展示，不再把崩溃循环显示成「运行中」。

**0.6.1 起已有**

- **首次安装体验修复**：装完插件立即登录，二维码与已授权设备列表不再报「尚未登录」红字；中继未就绪时面板自动退避重试，不用再手动刷新页面。
- **企微交流群**：README 底部扫码入群；服务端可在管理后台「推广」页配置交流群二维码，设置面板「加入交流群」按钮与用户反馈页会同步展示。

**0.6.0 起已有**

- **扫码即加密，不再要求再输一次密码**：用电脑生成的二维码/一次性链接进入后，由电脑自动授权开启端到端加密；密码登录点设备也自动解锁。全程不输 E2EE 密码、不存服务端。
- **记住本机：刷新/重开不掉回明文**：解锁一次后，手机 App 刷新、镜像页刷新都自动恢复加密（退出登录即清除；浏览器无痕可不用此功能）。
- **移动端体验**：选完会话抽屉自动收起；加密状态徽标几秒后自动缩成小 🔒 不挡界面；修复了移动端设置里“模型提供方目录加载失败”。
- **电脑端侧栏**：官方「设置」旁新增「📱 远程访问」快捷按钮（与官方按钮共存、不遮挡），一键进入远程访问面板。

## 界面预览

| 手机端进入 dsh web，100% 还原电脑端体验 | 手机端密钥登录后的在线设备列表 |
|---|---|
| ![手机端进入 dsh web](https://cdn.jsdelivr.net/gh/mrRisega/dsh-remote@main/image/phone-mirror.png) | ![手机端在线设备列表](https://cdn.jsdelivr.net/gh/mrRisega/dsh-remote@main/image/phone-devices.png) |

| 电脑端 dsh web 插件设置（自建服务模式） |
|---|
| ![客户端设置-自建服务](https://cdn.jsdelivr.net/gh/mrRisega/dsh-remote@main/image/selfhost-settings.png) |

## 两个版本

| | 开源版（本仓库） | SaaS 云服务版 |
|---|---|---|
| 服务器 | 你自己部署（任意有公网 IP 的机器） | 由服务商托管 |
| 账号体系 | 无需账号：访问密钥认证（`/_login` 换本地 JWT） | 手机号 + 短信验证码 |
| 后台管理 | 无（密钥即实例管理员） | 超管后台（用户/套餐/审计） |
| 许可证 | 本仓库（见下文 License） | 商业授权，闭源 |

两者可随时切换：电脑端插件面板「连接模式」一键切换，互不影响。

> 👉 **不想自建服务器 / 没有公网 IP？** 直接使用**官方云服务版**（托管 relay，无公网、4G、异地也稳定，多设备 + 超管后台）：
> **https://n.risegao.cn:13443/app/** （免费版 + PRO ¥19/月 + Pro Max ¥49/月，新用户送 7 天 PRO）。
> 客户端仍是同一条命令安装 `npx @mrrisega/dsh-remote`，登录后选择「云服务模式」即可。

## 安装

需要 Node.js ≥ 20（macOS / Linux / Windows 均可）。电脑端**一条命令**完成安装：
自动安装 bridge 与 dsh web 插件、写入配置、创建开机自启（macOS launchd / Linux systemd --user /
Windows 任务计划程序）：

```bash
npx @mrrisega/dsh-remote
```

安装完成后**无需任何命令**：打开 dsh web → 设置 → 「远程访问」，注册/登录手机号即可
（注册在手机端完成，登录后 bridge 自动启动；自建用户在同一面板切「自建服务」标签）。
原来的独立设置页（`dsh-remote settings`）已移除，避免与插件面板重复造成困惑。

自建模式（自己部署了 relay-router，无需账号体系）：

```bash
npx @mrrisega/dsh-remote setup --server wss://<你的域名>:端口 --key <访问密钥>
```

其他命令：`status`（查看状态）、`run`（前台调试）、`settings`（仅显示登录指引）、
`plugin`（重装/卸载 dsh web 插件）。运行 `npx @mrrisega/dsh-remote --help` 查看完整说明。

> **版本与更新 / 卸载**：dsh 官方插件市场目前不提供更新按钮，也不会改写用户补丁（因此市场
> 卸载会提示「仍通过 insert 引用 dsh-remote-web」而拒绝）。插件设置面板里已内置管理入口
> （dsh web → 设置 → 「远程访问」→「🔄 版本与更新」卡片）：显示当前版本、自动检测 npm 新版、
> **一键在线更新**（后台补运行环境并重启 bridge，完成后重启 dsh web 生效）、以及**彻底卸载**
> （移除补丁 include / 依赖 / bundle 与本地文件，之后市场卸载或直接重启均可完成卸载）。

源码安装（开发 / 自建服务器）：`git clone https://github.com/mrRisega/dsh-remote.git`
并 `npm install`，见下文各组件说明。

## 安全与隐私

**传输与会话**

- 全程 HTTPS/WSS（TLS）加密传输；远程访问需先在电脑端登录你的手机号账号，登录会话不
  在中继之外暴露，bridge 按需代持浏览器会话仅供你本人手机使用。
- 电脑端生成的访问链接为**一次性扫码登录**：30 分钟有效、访问一次即失效、可随时在
  「已授权设备」里取消配对；链接不会二次使用，不用时也可点「刷新」立即作废旧链接。

**端到端加密（E2EE，灰度开启中）**

- 开启后，手机 ↔ 电脑之间远程操作的**消息内容**（对话、工具执行、审批、凭据与文件等
  正文及 WebSocket 消息）在离开手机前用**你的账号密码派生密钥**加密、进入电脑后才解密；
  中继（router/nginx/enterprise）只可见路由所需信息——目标路径、数据大小与时间——**无法读取内容**。
- **服务端与中继不保存你的密码明文，也不保存解密密钥**：只保存密码经不可逆 KDF 派生的
  校验值用于登录，与加密密钥域分离（详见 [docs/e2ee-protocol.md](docs/e2ee-protocol.md)）。
- 请**牢记账号密码**：修改/重置密码会使全部旧设备会话失效，且服务端不保存你的内容、
  无法代为解密旧会话；改密后需在电脑端面板重新登录并重启 bridge，手机端重新解锁。
- 电脑端本机配置（`.dsh-config.json`）会保存账号密码用于自动登录，等于该账号
  内容的“解密权”，请妥善保护电脑；电脑被他人使用期间请退出登录。
  - macOS / Linux：文件权限 **0600**（仅本人可读写）。
  - Windows：**`0600` 在 Windows 上无效**（Windows 用 ACL，不是 POSIX 权限位）——
    早期版本只写了 `mode: 0o600`，实测该文件拿到的仍是用户目录的**默认继承 ACL**，
    等于没有这层保护。0.6.7-beta.3 起安装器/插件/bridge 都会显式收紧：`icacls` 断开继承、
    只授予当前用户。若收紧失败（无 icacls / 权限异常），安装日志会明确告警，不会假装成功。
  - 无论哪个平台：**不要把 `.dsh-remote` 目录交给备份/同步盘/他人排查**——
    里面的 `.dsh-config.json`（明文账号密码）与 `.harness-cookie.json`（dsh web 会话 Cookie，
    等于该会话的完整访问权）被复制走就等于把钥匙一起给了对方。发支持包前请先删除这两项。

**边界与建议（如实告知）**

- E2EE 保护的是**内容**：HTTPS 下的静态页面壳与路由元数据（页面骨架、路径、大小、时间、
  是否加密）仍对中继可见；既有登录与审计不受影响。
- E2EE 为**分阶段开启的功能**：以服务端开关逐步放量（默认关闭 = 走 HTTPS 明文回退），面板会显示
  当前加密状态与原因（已启用 / 等待服务端开启 / 普通安全连接等），不会静默降级。
- 建议上线前用**真机回归**一次完整链路：手机登录解锁 → 🔒 加密访问（对话/工具/审批/凭据）→
  明文回退提示 → 修改密码后旧会话全部失效、重新登录恢复。

## 匿名装机统计与隐私

生产诊断发现「注册了但设备一直没连上」的用户没有任何账号数据、无法归因，因此插件内置了一条
**匿名装机统计**通道，只上报**装机与连接是否成功**：

- **采**：事件名（安装开始/失败原因/运行环境就绪/bridge 是否注册成功/首次远程打通/面板打开/重启/更新）、
  失败码（白名单，如 `npm_unreachable`、`npm_eacces`、`runtime_install_timeout`）、插件版本号、
  系统平台（`darwin`/`linux`/`win32`）、架构（`arm64`/`x64`）、node 主版本号，
  以及一个**本机随机 ID**（`crypto.randomUUID()`，非硬件派生、重装即变、不可跨机器关联）；
- **不采**：手机号 / 邮箱 / 账号 ID、任何会话或文件内容、真实 hostname / 用户名 / 文件路径、
  密码与密钥、设备指纹 `machine_fp`、原始 IP、精确地理位置；请求**不带 Authorization**（匿名、与账号解耦）；
- **可关**：`export DSH_REMOTE_TELEMETRY=0` → 完全关闭（不生成随机 ID、不落任何文件、不发任何请求）；
  也可在中继/Nginx 侧直接丢弃 `POST /api/telemetry/events`；
- **可查**：面板「关于 dsh-remote」卡片底部有一行说明与链接，完整字段清单与核实方法见
  [docs/telemetry.md](docs/telemetry.md)。

## 数据与隐私

上一节讲的是「匿名装机统计」这条通道本身；这一节回答更常见的问题：**你的数据落在哪里、我们到底统计什么**。

**开源部分采集 / 不采集**

- **采**（开源部分只有一件事）：装机与连接是否成功这条**匿名**统计通道，字段清单见上一节。
- **不采**：**你的会话内容**（对话、工具执行、审批、凭据、文件正文与 WebSocket 消息——中继侧不采集内容）、
  **你的账号**（匿名通道不接受任何账号/设备关联，请求不带 Authorization）、**原始 IP**
  （匿名通道不上报 IP，也不做任何按 IP 的关联分析）、真实 hostname / 用户名 / 文件路径。
- **官方云服务额外记录的**：只有**接入事件**（注册 / 设备接入 / 真实登录 / 首次打通 / 首次看到安装引导），
  同样是事件级、不含任何内容。**开源部分不产生也不上报这类事件。**
- **装机漏斗统计的粒度**：云服务的漏斗统计**建立在审计日志之上**，因此口径是「注册 / 新增设备 /
  真实登录 / 首次打通」这类**事件条数**——**不是内容，也不是行为轨迹**。
  桥接进程每次启动都会重新登记设备，**重复登记不记为新增**，所以「新增设备数」对得上真实装机量，
  不会被反复重连刷高。
- 完整字段级清单、可核实方法与自行关闭方式见 [docs/telemetry.md](docs/telemetry.md)。

**如何关闭**

```bash
export DSH_REMOTE_TELEMETRY=0     # 完全关闭匿名装机统计：不生成随机 ID、不落文件、不发请求
```

也可在网络侧直接丢弃 `POST /api/telemetry/events`（中继 / Nginx / 防火墙），
关闭后不影响面板、bridge 与连接流程的任何功能。

**自建模式（self-hosted）**

自己部署 `relay-router` 时，**数据只落到你自己的服务器**：

- 匿名统计发往你在 `.dsh-config.json` 里配置的 `api_url`（即你的实例），不经过任何第三方服务；
- 没有账号体系、也没有管理端后台，不存在「注册 / 接入事件」的云侧统计；
- 远程操作的内容只经过**你自己的**中继；开启 E2EE 后端到端加密（手机 ↔ 电脑），中继也读不到内容；
- 是否保留数据、保留多久，完全由你决定；不想留任何统计就 `DSH_REMOTE_TELEMETRY=0`。

## 自建部署（开源版）

1. 在有公网 HTTPS 入口的服务器上部署 `relay-router`（见 [docs/self-hosting.md](docs/self-hosting.md)）：

   ```bash
   git clone https://github.com/mrRisega/dsh-remote.git && cd dsh-remote
   npm install
   bash deploy/install-open.sh        # 生成 open.env（0600）并启动 router
   ```

   或 Docker：`DSH_LOCAL_JWT_SECRET=… DSH_LOCAL_ACCESS_KEYS=… docker compose up -d`

2. nginx 反代：参考 [deploy/nginx-13443-remote-router.conf](deploy/nginx-13443-remote-router.conf)
   （`/app/` 静态 PWA、`/_bridge` WebSocket 升级、其余路径转 router）。
3. 手机打开 `https://<你的域名>/app/`，用访问密钥登录。
4. 被控电脑执行上面的 `npx … setup --server … --key …`。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| relay-router | `packages/relay-router/` | 中继服务器：bridge 注册表、实时设备列表、HTTP/WS 透明代理 |
| bridge | `clients/dsh-remote/` | 电脑端守护进程：连 router 注册，把转发帧代理到本地 `dsh web`；心跳自愈 |
| PWA | `clients/dsh-web/native.html` | 手机端：登录 / 注册 / 设备选择（单文件，零构建） |
| dsh web 插件 | `packages/dsh-remote-web/` | 设置页「远程访问」面板：连接模式 / 账号 / bridge 启停 / 反馈 |
| 部署脚本 | `deploy/` | `install-open.sh` 自建引导、nginx 参考配置、Dockerfile / compose |

测试：`npm test`（router 契约 + 插件 + bridge 全部单测与回归）。

## 企微交流群

扫码加入 **企微交流群**：安装/使用答疑、问题反馈、版本更新都会在群里同步，欢迎来聊。

<img src="image/企微交流群.jpg" alt="企微交流群" width="240">

> 也可以在仓库提 [Issue](https://github.com/mrRisega/dsh-remote/issues)；安全相关问题请按 [SECURITY.md](SECURITY.md) 私下反馈。

## 文档

- [docs/self-hosting.md](docs/self-hosting.md) — 开源自建完整指南（含安全提示）
- [docs/telemetry.md](docs/telemetry.md) — 匿名装机统计：采集/不采集清单与关闭方法
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南
- [SECURITY.md](SECURITY.md) — 安全策略与漏洞报告流程
- [CHANGELOG.md](CHANGELOG.md) — 版本记录

## License

本仓库使用 **PolyForm Noncommercial 1.0.0**（[LICENSE](LICENSE)）：
个人、研究与非商业用途免费；商业用途（含内部自用与对外服务）需要商业授权，
见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

> 说明：本仓库是**源码公开、非商业许可**的项目，不属于 OSI 意义上的“开源”；
> 云服务（多用户账号、超管后台）为闭源商业组件，不在本仓库内。

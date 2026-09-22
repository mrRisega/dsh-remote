# dsh-remote — 手机远程控制 DeepSeek Harness（全功能 · App 级体验）

<p align="left">
  <a href="https://github.com/mrRisega/dsh-remote/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/mrRisega/dsh-remote?style=flat-square&label=Stars"></a>
  <img alt="npm downloads" src="https://img.shields.io/npm/dt/@mrrisega/dsh-remote?style=flat-square&label=npm%20downloads">
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f8cff?style=flat-square">
  <img alt="dsh-plugin" src="https://img.shields.io/badge/topic-dsh--plugin-blueviolet?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-2ea44f?style=flat-square">
</p>

> **离开电脑也能用手机 100% 全功能接管电脑上的 DeepSeek Harness（`dsh web`）**——发消息、看工具执行、审批权限、改设置、管凭据，体验与坐在电脑前一致。免内网穿透，局域网即连。
>
> **一条命令安装**：`npx @mrrisega/dsh-remote`

## 核心功能

- **100% 全功能接管**：`dsh web` 的 HTTP / WebSocket 全量透传 —— 对话、工具执行与输出、审批、设置、凭据（含特权操作）都能在手机上完成，不是阉割版。
- **免内网穿透**：电脑端 bridge 主动连中继注册为在线设备，手机浏览器打开 PWA 即可用；不需要公网 IP，也不用配路由器。
- **端到端加密（E2EE）**：内容在离开手机前用你的账号密码派生密钥加密、进入电脑后才解密；中继只见路由元数据（路径、大小、时间），读不到内容。
- **微信机器人通道**：任务完成 / 出错 / 需要拍板时推到微信；在微信里**回一个数字**就能完成审批，会员还能直接派活、切换会话。
- **两端体验一致**：手机 PWA 还原电脑端界面；电脑端 `dsh web` 侧栏新增「📱 远程访问」入口。
- **一条命令 + 开机自启**：自动装好 bridge 与 dsh web 插件，并按平台配置自启动与崩溃自愈（macOS launchd / Linux systemd --user / Windows 任务计划程序）。
- **两种模式随时切**：官方云服务（手机号登录、含超管后台）或自建 relay（访问密钥认证），面板一键切换，互不影响。
- **插件市场可装**：在 dsh 插件市场搜索 **`dsh-remote-web`** 即可；桌面运行环境由插件在后台自动补齐。

```
手机浏览器
  └─ /app/ (PWA) 登录 → /_devices 设备列表 → 选择设备
       │
  nginx (HTTPS)
    ├─ /app/     → 静态 PWA
    ├─ /_devices /_login /remote/ → relay-router
    └─ /_bridge  → relay-router (WebSocket)
                     └→ bridge (电脑端) → 127.0.0.1:3080 (dsh web)
```

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
| 账号体系 | 无需账号：访问密钥认证 | 手机号 + 短信验证码 |
| 后台管理 | 无（密钥即实例管理员） | 超管后台（用户 / 套餐 / 审计） |
| 许可证 | 本仓库（见下文 License） | 商业授权，闭源 |

> 👉 **不想自建服务器 / 没有公网 IP？** 直接用**官方云服务版**（无公网、4G、异地都稳定，多设备 + 超管后台）：
> **https://n.risegao.cn:13443/app/** —— 免费版 + PRO ¥19/月 + Pro Max ¥49/月，新用户送 7 天 PRO。
> 客户端仍是同一条安装命令，登录后选「云服务模式」即可。

## 安装

需要 Node.js ≥ 20（macOS / Linux / Windows 均可）。电脑端**一条命令**：

```bash
npx @mrrisega/dsh-remote
```

装完**无需任何命令**：打开 `dsh web` → 设置 → 「远程访问」，注册 / 登录手机号即可
（注册在手机端完成；登录后 bridge 自动启动）。自建用户在同一个面板切「自建服务」标签。

自建模式（已部署 relay-router，无需账号体系）：

```bash
npx @mrrisega/dsh-remote setup --server wss://<你的域名>:端口 --key <访问密钥>
```

其他命令：`status` 查看状态、`run` 前台调试、`plugin` 重装 / 卸载 dsh web 插件；`--help` 看完整说明。
升级与卸载都在面板里：dsh web → 设置 → 「远程访问」→「🔄 版本与更新」（检测新版 / 一键在线更新 / 彻底卸载）。

## 安全与隐私

- **传输**：全程 HTTPS / WSS；远程访问需先在电脑端登录你的账号，一次性扫码链接 30 分钟有效、访问一次即失效、可随时取消配对。
- **端到端加密（E2EE）**：开启后内容在中继侧不可读（中继只见路径、大小、时间）。这是**分阶段开启**的功能（服务端开关逐步放量，默认关闭 = 走 HTTPS），面板会显示当前加密状态与原因，不会静默降级。服务端只保存密码经不可逆 KDF 派生的校验值，**不保存明文密码、也不保存解密密钥**——请牢记密码，改密会使旧设备会话全部失效。协议见 [docs/e2ee-protocol.md](docs/e2ee-protocol.md)。
- ⚠️ 电脑端 `.dsh-config.json` 保存账号密码用于自动登录（等于该账号内容的解密权），**不要把 `.dsh-remote` 目录交给备份 / 同步盘 / 他人排查**——要发支持包请先删掉 `.dsh-config.json` 与 `.harness-cookie.json`。

## 匿名装机统计与隐私

为了让「装完却连不上」可归因，插件内置一条**匿名装机统计**通道，只上报**装机与连接是否成功**：

- **采**：事件名（安装开始/失败原因/运行环境就绪/bridge 是否注册成功/首次远程打通/面板打开/重启/更新、微信机器人通道的绑定与解绑）、白名单失败码、插件版本、系统平台与架构、Node 主版本，以及一个**本机随机 ID**（`crypto.randomUUID()`，非硬件派生、重装即变、不可跨机器关联）。
- **不采**：手机号 / 邮箱 / 账号 ID、任何会话或文件内容、真实 hostname / 用户名 / 文件路径、密码与密钥、设备指纹、原始 IP、精确地理位置；请求**不带 Authorization**（匿名、与账号解耦）。
- **关闭**：`export DSH_REMOTE_TELEMETRY=0` —— 不生成随机 ID、不落任何文件、不发任何请求；也可在网络侧直接丢弃 `POST /api/telemetry/events`。关闭不影响面板、bridge 与连接流程的任何功能。
- **自建模式**：统计只发往你自己配置的 `api_url`（不经第三方）；没有账号体系与云侧统计，数据只落在你自己的服务器。

完整字段清单与可核实方法见 [docs/telemetry.md](docs/telemetry.md)。

## 自建部署（开源版）

```bash
git clone https://github.com/mrRisega/dsh-remote.git && cd dsh-remote
npm install
bash deploy/install-open.sh          # 生成 open.env（0600）并启动 router
```

或 Docker：`DSH_LOCAL_JWT_SECRET=… DSH_LOCAL_ACCESS_KEYS=… docker compose up -d`。
nginx 反代参考 [deploy/nginx-13443-remote-router.conf](deploy/nginx-13443-remote-router.conf)；
之后手机打开 `https://<你的域名>/app/` 用访问密钥登录，被控电脑执行上面的 `setup --server … --key …`。
完整步骤见 [docs/self-hosting.md](docs/self-hosting.md)。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| relay-router | `packages/relay-router/` | 中继服务器：bridge 注册表、实时设备列表、HTTP/WS 透明代理 |
| bridge | `clients/dsh-remote/` | 电脑端守护进程：连 router 注册，把转发帧代理到本地 `dsh web`；心跳自愈 |
| PWA | `clients/dsh-web/native.html` | 手机端：登录 / 注册 / 设备选择（单文件，零构建） |
| dsh web 插件 | `packages/dsh-remote-web/` | 设置页「远程访问」面板：连接模式 / 账号 / bridge 启停 / 反馈 |
| 部署脚本 | `deploy/` | `install-open.sh`、nginx 参考配置、Dockerfile / compose |

测试：`npm test`。

## 交流与反馈

扫码加入 **企微交流群**（安装答疑、问题反馈、版本更新同步）：

<img src="image/企微交流群.jpg" alt="企微交流群" width="240">

也可以在仓库提 [Issue](https://github.com/mrRisega/dsh-remote/issues)；安全相关问题请按 [SECURITY.md](SECURITY.md) 私下反馈。

## 文档

- [CHANGELOG.md](CHANGELOG.md) — 版本记录
- [docs/self-hosting.md](docs/self-hosting.md) — 开源自建完整指南
- [docs/telemetry.md](docs/telemetry.md) — 匿名装机统计：采集 / 不采集清单与关闭方法
- [docs/e2ee-protocol.md](docs/e2ee-protocol.md) — 端到端加密协议
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md)

## License

本仓库使用 **PolyForm Noncommercial 1.0.0**（[LICENSE](LICENSE)）：个人、研究与非商业用途免费；
商业用途（含内部自用与对外服务）需要商业授权，见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

> 本仓库是**源码公开、非商业许可**的项目，不属于 OSI 意义上的「开源」；
> 云服务（多用户账号、超管后台）为闭源商业组件，不在本仓库内。

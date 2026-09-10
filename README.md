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
    ├─ /_devices /_quota /_login /remote/ /_bridge / → relay-router
    └─ /_bridge         → relay-router (WebSocket)
                           └→ bridge (电脑端) → 127.0.0.1:3080 (dsh web)
```

## 0.6.1 速览（用户最关心的新能力）

- **首次安装体验修复**：装完插件立即登录，二维码与已授权设备列表不再报「尚未登录」红字；中继未就绪时面板自动退避重试，不用再手动刷新页面。
- **企微交流群**：README 底部扫码入群；服务端可在管理后台「推广」页上传交流群二维码，官网、付费页底部、设置面板「加入交流群」按钮与用户反馈页会同步展示。

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
| 流量配额 | 可选（环境变量覆盖默认值） | 按套餐分层限速限流 |
| 许可证 | 本仓库（见下文 License） | 商业授权，闭源 |

两者可随时切换：电脑端插件面板「连接模式」一键切换，互不影响。

> 👉 **不想自建服务器 / 没有公网 IP？** 直接使用**官方云服务版**（托管 relay，无公网、4G、异地也稳定，多设备 + 超管后台）：
> **https://n.risegao.cn:13443/app/** （免费版 + PRO ¥19/月 + Pro Max ¥49/月，新用户送 7 天 PRO）。
> 客户端仍是同一条命令安装 `npx @mrrisega/dsh-remote`，登录后选择「云服务模式」即可。

## 安装

需要 Node.js ≥ 20。电脑端**一条命令**完成安装：自动安装 bridge 与 dsh web 插件、
写入配置、创建开机自启服务：

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
- 电脑端本机配置（`.dsh-config.json`，0600）会保存账号密码用于自动登录，等于该账号
  内容的“解密权”，请妥善保护电脑；电脑被他人使用期间请退出登录。

**边界与建议（如实告知）**

- E2EE 保护的是**内容**：HTTPS 下的静态页面壳与路由元数据（页面骨架、路径、大小、时间、
  是否加密）仍对中继可见；既有登录、配额与审计不受影响。
- E2EE 为**灰度功能**：以服务端开关逐步放量（默认关闭 = 走 HTTPS 明文回退），面板会显示
  当前加密状态与原因（已启用 / 等待服务端开启 / 普通安全连接等），不会静默降级。
- 建议上线前用**真机回归**一次完整链路：手机登录解锁 → 🔒 加密访问（对话/工具/审批/凭据）→
  明文回退提示 → 修改密码后旧会话全部失效、重新登录恢复。

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
| relay-router | `packages/relay-router/` | 中继服务器：bridge 注册表、实时设备列表、HTTP/WS 透明代理、配额 |
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
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南
- [SECURITY.md](SECURITY.md) — 安全策略与漏洞报告流程
- [CHANGELOG.md](CHANGELOG.md) — 版本记录

## License

本仓库使用 **PolyForm Noncommercial 1.0.0**（[LICENSE](LICENSE)）：
个人、研究与非商业用途免费；商业用途（含内部自用与对外服务）需要商业授权，
见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

> 说明：本仓库是**源码公开、非商业许可**的项目，不属于 OSI 意义上的“开源”；
> 云服务（多用户账号、超管后台）为闭源商业组件，不在本仓库内。

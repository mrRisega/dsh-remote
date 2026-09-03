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

安装完成后运行下面命令打开设置页，用手机号+密码登录即可（注册在手机端完成，
登录后 bridge 自动启动）：

```bash
npx @mrrisega/dsh-remote settings
```

自建模式（自己部署了 relay-router，无需账号体系）：

```bash
npx @mrrisega/dsh-remote setup --server wss://<你的域名>:端口 --key <访问密钥>
```

其他命令：`settings`（设置页）、`status`（查看状态）、`run`（前台调试）、
`plugin`（重装/卸载 dsh web 插件）。运行 `npx @mrrisega/dsh-remote --help` 查看完整说明。

源码安装（开发 / 自建服务器）：`git clone https://github.com/mrRisega/dsh-remote.git`
并 `npm install`，见下文各组件说明。

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
| dsh web 插件 | `packages/dsh-remote-ui/` | 设置页「远程控制」面板：连接模式 / 账号 / bridge 启停 / 反馈 |
| 部署脚本 | `deploy/` | `install-open.sh` 自建引导、nginx 参考配置、Dockerfile / compose |

测试：`npm test`（router 契约 + 插件 + bridge 全部单测与回归）。

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

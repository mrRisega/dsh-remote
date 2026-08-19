<div align="center">

# dsh-remote

**在手机浏览器上全功能远程控制 DeepSeek Harness(`dsh web`)**

零侵入 · 功能全覆盖 · 端到端直达 · 安全默认

`dsh-remote` 是一个**安全反向代理网关**:在运行 `dsh web` 的电脑上启动它,
手机浏览器即可登录并**全功能接管**桌面端 DeepSeek Harness —— 发消息、看工具
执行、审批权限、改设置、管凭据,与本地浏览器能力完全一致(含特权操作)。

</div>

---

## ✨ 特性

- **零侵入**:不改 DSH 任何代码/配置;`dsh web` 仍只监听 `127.0.0.1`。
- **功能全覆盖**:把远程请求"伪装"成本机 loopback,通过 DSH 的信任围栏,
  包括 `--trusted-host` 也拿不到的特权方法(`settings.*` / `credentials.*` 等)。
- **端到端直达**:局域网直连即可(零服务器);要公网访问时,经你自己的
  反代服务器(NAS / 云主机)+ NAT 即可。
- **安全默认**:强口令登录(scrypt 哈希)、会话 cookie、失败限流、可选 IP
  白名单、可选 TLS。
- **移动端优先**:深色终端美学的登录页 + PWA 能力,手机"添加到主屏幕"即用。
- **零运行时依赖**:纯 Node.js 原生模块(`node:http` / `https` / `crypto`),
  无 npm install、无外部服务。

## 📦 快速开始(一键安装)

需要 **Node.js ≥ 20**。运行下面的命令,按提示设置口令即可:

```bash
# macOS / Linux 通用
curl -fsSL https://raw.githubusercontent.com/<你的用户名>/dsh-remote/main/install.sh | bash
```

非交互式(环境变量方式,适合脚本化):

```bash
DSH_REMOTE_PASSWORD='你的强口令' \
DSH_REMOTE_PORT=3443 \
bash <(curl -fsSL https://raw.githubusercontent.com/<你的用户名>/dsh-remote/main/install.sh)
```

安装脚本会:
1. 下载项目到 `~/.dsh-remote`;
2. 生成 `config.json`(口令以 scrypt 哈希存储,权限 600);
3. 安装系统服务并开机自启(macOS → launchd,Linux → systemd);
4. 打印本机/局域网访问地址。

然后手机浏览器打开 `http://<电脑IP>:3443/login` 输入口令即可。

> 局域网直连建议启用 TLS(自签证书),或至少使用强口令。详见 [安全](#-安全)。

## 🚀 手动启动

```bash
git clone https://github.com/<你的用户名>/dsh-remote.git
cd dsh-remote

# 生成自签证书(可选,局域网 HTTPS)
./scripts/gen-cert.sh

# 启动(临时)
DSH_REMOTE_PASSWORD='你的强口令' \
DSH_REMOTE_PORT=3443 \
DSH_REMOTE_TLS_CERT=$PWD/certs/server.crt \
DSH_REMOTE_TLS_KEY=$PWD/certs/server.key \
node bin/dsh-remote.js start
```

## ⚙️ 配置

配置文件 `config.json`(参考 `config.example.json`)或环境变量(`DSH_REMOTE_*`,
优先级更高):

| 配置项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `host` | `DSH_REMOTE_HOST` | `0.0.0.0` | 监听地址 |
| `port` | `DSH_REMOTE_PORT` | `3443` | 监听端口 |
| `upstream` | `DSH_REMOTE_UPSTREAM` | `http://127.0.0.1:3080` | `dsh web` 地址 |
| `password` | `DSH_REMOTE_PASSWORD` | — | 访问口令(明文,不推荐) |
| `passwordHash` | `DSH_REMOTE_PASSWORD_HASH` | — | scrypt 哈希(推荐) |
| `sessionTtlHours` | `DSH_REMOTE_SESSION_TTL_HOURS` | `12` | 会话有效期(小时) |
| `rateLimit` | `DSH_REMOTE_RATE_LIMIT` | `5:900000` | 登录失败限流(次数:窗口ms) |
| `allowIps` | `DSH_REMOTE_ALLOW_IPS` | `[]` | IP 白名单(空=不限) |
| `tls.cert/key` | `DSH_REMOTE_TLS_CERT/KEY` | — | HTTPS 证书/私钥路径 |
| `distDir` | `DSH_REMOTE_DIST_DIR` | 包内 `public/` | 登录页静态资源目录 |

生成口令哈希:

```bash
node bin/dsh-remote.js hash-password
# passwordHash: scrypt$16384$8$1$<salt>$<hash>
```

命令行:

```bash
node bin/dsh-remote.js start --config ./config.json   # 启动
node bin/dsh-remote.js hash-password                  # 生成口令哈希
node bin/dsh-remote.js --help                         # 帮助
```

## 🌐 公网访问

局域网直连之外,可通过一台**有公网 IP 的反代服务器**(NAS / 云主机)暴露到公网,
手机在任意网络访问。完整指南见 [`deploy/nas/DEPLOY-NAS.md`](deploy/nas/DEPLOY-NAS.md):

```
手机 ──TLS──▶ https://<你的域名>:<端口>
              (反代服务器 Nginx,证书终止)
                  │ proxy_pass 直连,或 SSH 反向隧道
                  ▼
              dsh-remote 网关(电脑, 3443)
                  ▼
              dsh web(127.0.0.1:3080)
```

两种后端连通方式:

- **局域网直连**:反代服务器与电脑同网段 → `proxy_pass http://<电脑IP>:3443`;
- **SSH 反向隧道**:不同网段 → 电脑跑 [`scripts/tunnel-nas.sh`](scripts/tunnel-nas.sh),
  反代服务器 `proxy_pass http://127.0.0.1:<端口>`。

## 🔒 安全

`dsh web` 能执行任意本地命令(工具如 bash/fs),因此**网关是唯一信任边界**:

- 强口令(≥12 位建议),scrypt 哈希存储,恒定时间比较;
- 会话 cookie:`HttpOnly; SameSite=Strict`,HTTPS 下追加 `Secure`,短有效期滑动续期;
- 登录失败限流(默认每 IP 15 分钟 5 次,429 + Retry-After);
- 可选 IP 白名单;
- WebSocket 升级同样必须先通过认证;
- 公网场景:反代服务器 Nginx 应拒绝未知 Host(返回 444),仅放行你的域名;
- **切勿**把 `dsh web` 自身端口(3080)暴露到局域网/公网,只有网关端口对外。

## 📁 目录结构

```
dsh-remote/
├── install.sh              # 一键安装脚本(macOS / Linux)
├── uninstall.sh            # 卸载脚本
├── bin/dsh-remote.js       # CLI 入口
├── lib/
│   ├── config.js           # 配置加载与校验
│   ├── auth.js             # 口令哈希、会话、限流
│   ├── proxy.js            # 反向代理(HTTP + WebSocket 升级、头重写)
│   └── server.js           # 主服务(路由/静态/登录/代理挂载)
├── public/                 # 移动端登录页
├── scripts/
│   ├── gen-cert.sh         # 自签证书生成
│   ├── install-macos.sh    # macOS launchd 安装
│   └── tunnel-nas.sh       # SSH 反向隧道(公网反代模式)
├── deploy/
│   ├── com.dshremote.daemon.plist   # launchd 服务模板
│   └── nas/                # 公网反代部署指南 + Nginx 片段
├── config.example.json     # 配置示例
└── DESIGN.md               # 架构设计
```

## 🧰 常见问题

**Q: 手机提示证书不受信任?**
自签证书需要首次信任。把 `certs/server.crt` 发送到手机安装并信任
(iOS: 设置 → 通用 → VPN与设备管理 → 安装;再 关于本机 → 证书信任设置 →
开启完全信任)。或使用反代服务器的正规证书。

**Q: 能同时用手机和电脑控制吗?**
可以。`dsh web` 的事件流是广播制,手机与桌面浏览器可同时在线,实时同步。

**Q: 支持哪些系统?**
电脑端 macOS / Linux(Node.js ≥ 20);手机端任意现代浏览器(iOS Safari /
Android Chrome),建议添加到主屏幕获得全屏体验。

**Q: 多人可以用吗?**
当前为单口令共享。如需多用户独立账号,可扩展 `lib/auth.js` 的用户表。

## 📄 License

[MIT](./LICENSE)

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 被远程控制的对象

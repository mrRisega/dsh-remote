# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格。

## [0.1.0] - 2026-08-20

首个可发布版本:完整的手机远程控制能力,一键安装,已公网验证。

### 新增

- **安全反向代理网关**:在运行 `dsh web` 的电脑上提供 TLS + 登录认证,
  向内把请求伪装成本机 loopback,手机获得与本地浏览器完全一致的全部权限
  (含 `settings.*` / `credentials.*` 等特权方法)。
- **零侵入**:不修改 DeepSeek Harness 任何代码/配置;`dsh web` 保持
  `127.0.0.1` 监听原样。
- **认证与安全**:
  - 口令登录,scrypt 哈希存储,恒定时间比较;
  - 会话 cookie(`HttpOnly; SameSite=Strict`,HTTPS 下 `Secure`),滑动续期;
  - 登录失败限流(默认每 IP 15 分钟 5 次,429 + Retry-After);
  - 可选 IP 白名单。
- **反向代理**:HTTP 全透传 + WebSocket 升级透传(原生 socket 管道,
  不依赖 ws 库),Host 重写为 loopback、剥离 Origin/Sec-Fetch-*,注入
  X-Forwarded-For/Proto。
- **移动端登录页**:深色终端美学,移动视口优先,健康检查状态提示。
- **一键安装** `install.sh`:
  - macOS(launchd)与 Linux(systemd)系统服务,开机自启;
  - 交互式 / 环境变量两种模式;
  - 口令自动生成 scrypt 哈希,`config.json` 权限 600。
- **部署脚本**:自签证书生成、macOS launchd 安装、SSH 反向隧道。
- **公网部署指南**:反代服务器(Nginx)配置模板 + NAT 说明,含两种后端
  连通方式(局域网直连 / SSH 反向隧道)。

### 验证

- 移动视口(390×844)登录 → 进入 dsh web SPA,零控制台错误;
- 登录/会话列表/特权方法/WebSocket 经局域网与独立公网路径全部通过;
- 登录限流、未认证拦截(HTTP 401 / WebSocket 401 / 重定向)行为正确;
- HTTPS 自签证书模式(含 Secure cookie)通过。

### 技术要点

- 纯 Node.js 原生模块,零运行时依赖;
- 网关是唯一信任边界,`dsh web` 端口不对局域网开放;
- 事件流广播制,手机与桌面可同时在线实时同步。

## [Unreleased]

- 多用户账号支持(扩展 `lib/auth.js` 用户表);
- 登录页 PWA manifest 完善(独立图标/启动画面);
- 会话持久化(可选文件存储)。

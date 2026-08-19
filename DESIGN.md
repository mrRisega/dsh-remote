# dsh-remote — DSH 手机远程控制网关 · 架构设计

> 目标:让手机浏览器可以像操作本地一样,远程控制运行在 Mac 上的
> DeepSeek Harness(`dsh web`),功能全覆盖(含设置、凭据等特权操作),
> 端到端直达;如需公网,可经用户自有的反代服务器(如 NAS 或云主机)提供 TLS 入口。

---

## 1. 背景与已确认的约束(来自源码调研)

`dsh web`(DeepSeek Harness 浏览器 UI,`apps/cli` 的 web profile)当前:

| 事实 | 出处 |
|---|---|
| 只绑定 `127.0.0.1`(loopback);`--host 0.0.0.0` 被显式拒绝,注释:会向网络暴露远程代码执行 | `@deepseek-ai/dsh-web-app/lib/startup.js` |
| 前端是响应式 SPA,带 viewport meta 与 PWA manifest,已具备手机端基础 | `index.html` / `manifest.webmanifest` |
| API 传输 = HTTP `POST /api/<method>`(JSON-RPC 信封)+ 两条 WebSocket 下行流 `/api/events.mux`、`/api/events.host` | `@deepseek-ai/dsh-client-connection` |
| 浏览器客户端用 `window.location.origin` 解析相对 `/api/*` 路径(天然适配反代) | `client.js resolveBase()` |
| `/api` 有"浏览器信任围栏":校验 Host(loopback 或 `--trusted-host`)、Origin、`Sec-Fetch-Site` | `client-connection/lib/index.js isTrustedApiRequest()` |
| **特权方法**(`settings.*`、`credentials.*`、`agentPreset.*`、`host.pickDirectory/openPath`、`llm.discoverModels`)**在 trusted-host 部署下仍被钉死在 loopback** | `PRIVILEGED_METHODS` + `isTrustedApiRequest(req, [])` |
| mux 事件流是广播制(`broadcast(payload)` 发给所有已连接 mux 消费者)——手机与桌面可同时在线 | `host-apiproxy` |

**核心推论**:要让手机获得"几乎全覆盖"能力(包括设置/凭据),不能简单把
`dsh web` 绑到 `0.0.0.0`(被禁止),也不能只靠 `--trusted-host`(特权方法不放行)。
唯一干净的做法是:在**运行 dsh web 的同一台机器**上放一个**反向代理网关**,
对外提供 TLS + 登录认证,对内把请求**伪装成本机 loopback** 转发给 `127.0.0.1:3080`
(Host 重写为 loopback、剥离 Origin/Sec-Fetch-*),从而:

- 通过全部信任围栏,包括特权方法 → 功能全覆盖;
- 完全不修改 DSH 本身,升级无侵入;
- 认证、限流、审计都落在网关这一层。

## 2. 总体架构

```
                 ┌─────────────────────── Mac (运行 dsh web) ───────────────────────┐
 手机浏览器 ──TLS──▶ dsh-remote 网关 ──127.0.0.1:3080(伪装 loopback)──▶ dsh web
 (LAN 直连)        (认证+限流+代理)                                   (原始进程,零改动)
                 └──────────────────────────────────────────────────────────────┘

 手机浏览器 ──TLS──▶ 反代服务器 Nginx (你的域名:新端口) ──▶ dsh-remote 网关
 (公网)              (证书终止)                     └─ 直连 LAN IP 或 SSH 反向隧道
```

### 2.1 两种网络拓扑

1. **端到端直连(首选,零服务器)**:Mac 与手机在同一局域网(或后续可经
   Tailscale/自建隧道组网),手机直接访问 `https://<Mac-LAN-IP>:<端口>`,
   网关自带 TLS(自签证书,手机安装信任)或 http+强口令。
2. **经反代服务器公网入口**:手机在任意网络访问 `https://<你的域名>:<新端口>`,
   反代服务器(如 NAS 或云主机)上的 Nginx 做 TLS 终止并反代到 Mac 的网关:
   - 直连模式:Nginx `proxy_pass http://<Mac-LAN-IP>:<网关端口>`;
   - 隧道模式(推荐,Mac 无公网/动态 IP):Mac 用 SSH 反向隧道把网关端口映射到
     NAS 的 `127.0.0.1`,Nginx 反代到 `127.0.0.1` 上的隧道口。

### 2.2 网关组件

| 模块 | 职责 |
|---|---|
| `config` | JSON 配置(监听端口、上游 URL、认证口令、TLS 证书、限流、IP 白名单) |
| `auth` | 口令登录(恒定时间比较)、会话 cookie(HttpOnly+Secure+SameSite)、每 IP 失败限流、会话存储 |
| `proxy` | HTTP/HTTPS 反向代理 + WebSocket 升级透传;重写 Host→`127.0.0.1:<port>`,剥离 Origin/Sec-Fetch-*;支持大 body 与流式响应 |
| `server` | 组装:登录页/静态资源/健康检查 + 代理挂载;HTTPS 可选 |
| `public/` | 移动端优先的登录页(PWA,可"添加到主屏幕") |

### 2.3 安全模型

- `dsh web` 能执行任意本地命令(工具如 bash/fs),因此**网关是唯一信任边界**:
  - 强口令(≥12 位建议),scrypt 哈希存储;
  - 会话 cookie:`HttpOnly; Secure; SameSite=Strict`,短有效期 + 滑动续期;
  - 登录失败限流(每 IP),可选 IP 白名单;
  - 网关监听默认 `0.0.0.0` 但未认证一律 401/登录页;
  - WebSocket 升级同样先过认证;
  - 局域网自签证书场景在 README 说明"首次信任"步骤;公网场景由反代服务器证书保证。
- **不暴露**:`dsh web` 自身端口(3080)绝不对局域网开放,只有网关端口对外。

## 3. 实现要点(与 DSH 源码对齐)

### 3.1 代理头处理

转发前(对上游 `http://127.0.0.1:3080`):

```
请求行/URL 原样保留(相对路径,客户端已按 origin 解析)
Host        → 重写为 127.0.0.1:<上游端口>
Origin      → 剥离(围栏:无 Origin 直接放行)
Sec-Fetch-* → 剥离(围栏:cross-site 拒绝)
X-Forwarded-* → 注入(供网关内日志/审计)
```

WebSocket 升级:`Connection: Upgrade` / `Upgrade: websocket` 头原样透传,
用 Node 原生 `http.request` 的 `upgrade` 事件把两个 socket 对接(不依赖 ws 库,
纯字节管道,天然支持任意子协议/扩展)。

### 3.2 会话与会话存储

- 内存 Map 存储(重启即失效,安全默认);可选 file 持久化(配置开关)。
- cookie 名 `dshr_session`,值为 256 位随机 token。

### 3.3 健康检查

`GET /healthz`(无需认证):返回 `{"ok":true,"upstream":"127.0.0.1:3080","reachable":true|false}`,
便于监控与"dsh web 未启动"时手机端给出友好提示。

## 4. 交付物

```
dsh-remote/
  package.json            # 零运行时依赖(node:http/https/crypto 原生)
  bin/dsh-remote.js       # CLI 入口
  lib/{config,auth,proxy,server}.js
  public/                 # 登录页 + PWA
  scripts/
    gen-cert.sh           # 自签证书(局域网模式)
    install-macos.sh      # launchd 自启
    tunnel-nas.sh         # SSH 反向隧道(公网反代模式)
  deploy/nas/             # NAS Nginx 片段 + 部署说明(遵守 single-nginx 规则)
  README.md               # 中文使用文档
  DESIGN.md               # 本文档
```

## 5. 里程碑

1. M1:网关核心(认证+代理+WS)+ 本地验证(独立 dsh web 实例)。
2. M2:登录页 PWA + 移动视口端到端验证(headless/手机)。
3. M3:macOS launchd + 自签证书 + 局域网直连验收。
4. M4:公网反代部署(按 single-nginx 流程:备份→nginx -t→reload→外网验证)。
5. M5:README 文档收尾。

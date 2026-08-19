# dsh-remote · 公网部署指南(反代服务器 + NAT)

本文说明如何把 dsh-remote 通过一台**有公网 IP 的反代服务器**(例如你的 NAS
或云服务器)暴露到公网,让手机在任意网络访问。

```
手机浏览器 ──TLS──▶ https://<域名>:<端口>
                    (反代服务器上的 Nginx,证书终止)
                        │ proxy_pass 直连网关,或经 SSH 反向隧道
                        ▼
                    dsh-remote 网关(Mac, 3443)
                        ▼
                    dsh web(Mac, 127.0.0.1:3080)
```

## 两种后端连通方式

| 方式 | 适用场景 | 反代服务器配置 |
|---|---|---|
| **A. 局域网直连** | 反代服务器与 Mac 同一网段 | `proxy_pass http://<Mac-LAN-IP>:3443` |
| **B. SSH 反向隧道** | 反代服务器与 Mac 不同网段 | Mac 跑 `scripts/tunnel-nas.sh`,反代服务器 `proxy_pass http://127.0.0.1:13443` |

> 方式 A 更简单;方式 B 不依赖 Mac 固定 IP,但需隧道常驻(autossh / systemd / launchd)。

## 步骤 1:Mac 侧启动网关

```bash
cd dsh-remote
# 方式一:交互式安装(生成 config.json + launchd 自启)
./scripts/install-macos.sh

# 方式二:手动启动(临时)
DSH_REMOTE_PASSWORD='你的强口令' node bin/dsh-remote.js start
```

确认本机可访问: `curl http://127.0.0.1:3443/login` → 200

## 步骤 2:反代服务器配置 Nginx

1. 按 [`nginx-route.conf.example`](nginx-route.conf.example) 的模板,
   替换 `__DOMAIN__` / `__PUBLIC_PORT__` / `__GATEWAY_BACKEND__` / `__CERT_DIR__`。
2. 若使用 Docker Compose 的 Nginx(如 fnOS 的 `fast-note-sync-proxy`),
   在 `ports` 增加 `"<PUBLIC_PORT>:<PUBLIC_PORT>"`,并确认 `$connection_upgrade` map 存在。
3. **修改前先备份**,然后校验:

```bash
# 校验 nginx 配置(Docker 环境示例)
docker run --rm --network <你的nginx网络> --add-host host.docker.internal:host-gateway \
  -v /path/to/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /path/to/certs:/etc/nginx/certs:ro \
  nginx:1.27-alpine nginx -t
```

4. 重载或重建 Nginx 容器,确认新端口已监听。

## 步骤 3:路由器 NAT(若反代服务器在家用路由器后)

把公网端口转发到反代服务器的内网地址:

```
公网 <PUBLIC_PORT> → 反代服务器内网 IP:<PUBLIC_PORT>
```

## 步骤 4:验证(两条独立路径)

```bash
# 1. 反代服务器本机(绕开 NAT)
curl -sk -o /dev/null -w '%{http_code}\n' --resolve <域名>:<端口>:127.0.0.1 https://<域名>:<端口>/login

# 2. 独立外部网络(如云服务器 / 手机 4G)
curl -sk -o /dev/null -w '%{http_code}\n' https://<域名>:<端口>/login
```

两条都应返回 200。完整功能验证(登录 / API / WebSocket / 特权方法):

```bash
# 登录拿 cookie
COOKIE=$(curl -sk -D - -o /dev/null -X POST https://<域名>:<端口>/api/login \
  -H 'content-type: application/json' -d '{"password":"你的口令"}' \
  | grep -i set-cookie | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

# 会话列表(应返回 ok:true)
curl -sk -b "$COOKIE" -X POST https://<域名>:<端口>/api/session.list \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"00000000-0000-4000-8000-000000000001","method":"session.list","payload":{}}'

# WebSocket 升级(wss://<域名>:<端口>/api/events.mux)应能建立连接
```

## 安全核对表

- [ ] `dsh web` 自身端口(默认 3080)未对局域网/公网开放。
- [ ] 网关口令为强口令(≥12 位),生产用 `dsh-remote hash-password` 生成哈希。
- [ ] 登录限流已生效(默认每 IP 15 分钟 5 次失败)。
- [ ] 公网链路为 HTTPS;未知 Host 被 Nginx 444 拒绝。
- [ ] NAT 仅映射网关端口,不额外暴露 dsh web / 数据库等端口。

## 回滚

恢复备份的 nginx.conf 与 compose.yaml,重载/重建 Nginx 容器即可。

## 故障排查

| 现象 | 可能原因 |
|---|---|
| 反代本机 200,外部超时 | NAT 未配置或公网 IP 变化,检查路由器端口转发 |
| 登录页 200,登录后 API 401 | 会话 cookie 未携带(Nginx 需透传 Cookie 头,默认已透传) |
| WebSocket 连不上 | Nginx 缺 `Upgrade`/`Connection` 头透传,或 `proxy_read_timeout` 过短 |
| 502 Bad Gateway | `__GATEWAY_BACKEND__` 指向的网关未运行或地址错误 |

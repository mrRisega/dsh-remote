# Self-Hosting Guide

dsh-remote is designed so that anyone with a server can run the entire remote-control
stack themselves. The self-hosted edition needs **no account system**: authentication
is a simple access key, exchanged for short-lived local JWTs by the router.

The self-hosted stack:

```
手机浏览器
  └─ /app/ 访问密钥登录(POST /_login) → /_devices 选设备 → /remote/<deviceId>/…
       │
  你的 nginx (HTTPS)
     ├─ /app/        → 静态 PWA (clients/dsh-web/native.html)
     ├─ /_devices /_quota /_login /remote/ /_bridge / → relay-router
```

- **relay-router** is the only server component. It registers bridges over
  WebSocket (`/_bridge`), serves the real-time device list (`/_devices`), proxies
  HTTP/WS traffic to the right device (`/remote/<deviceId>/…`), and enforces
  per-plan bandwidth/traffic quotas.
- Authentication: `DSH_LOCAL_ACCESS_KEYS` (comma-separated) → `POST /_login`
  → 2h local JWT. The router also accepts SaaS JWTs if
  `DSH_ENTERPRISE_JWT_SECRET` is set, so a router can serve both modes at once.

## Requirements

- A server with Node.js ≥ 22 and a public HTTPS endpoint (your own domain +
  certificate). The router itself speaks plain HTTP/WS; terminate TLS at nginx
  or Caddy in front of it.
- The phone and the desktop machine must reach the same HTTPS endpoint.

## Option A — Docker (recommended)

```bash
git clone https://github.com/mrRisega/dsh-remote.git && cd dsh-remote

# 生成密钥与访问密钥(建议 >= 32 字节随机串)
DSH_LOCAL_JWT_SECRET=$(openssl rand -hex 32) \
DSH_LOCAL_ACCESS_KEYS=$(openssl rand -base64 9) \
docker compose up -d

curl -i http://127.0.0.1:13444/_devices    # 401 = 正常(需登录态)
```

Then put nginx in front (see `deploy/nginx-13443-remote-router.conf` for the
location blocks and `map $http_upgrade $connection_upgrade`).

## Option B — Bare Node

```bash
git clone https://github.com/mrRisega/dsh-remote.git && cd dsh-remote
npm install
bash deploy/install-open.sh                # 生成 open.env(0600)并启动 router
```

`install-open.sh` prints your access key and the public entry URL. `open.env`
holds `DSH_ENTERPRISE_JWT_SECRET`, `DSH_LOCAL_JWT_SECRET`,
`DSH_LOCAL_ACCESS_KEYS` and `DSH_ROUTER_PORT` — treat it as a credential file.

## Serving the phone app (PWA)

`clients/dsh-web/native.html` is a single-file PWA. Point nginx at it:

```nginx
location /app/ {
    alias /srv/dsh-remote/app/;
    index native.html;
    add_header Cache-Control "no-cache";
}
```

Self-hosted users sign in with the access key (`/app/` login form). The PWA then
lists online devices from `/_devices` and routes into `dsh web` through the tunnel.

## Connecting the desktop (controlled computer)

```bash
npx @mrrisega/dsh-remote setup --server wss://你的域名:端口 --key 你的访问密钥
```

This writes the local config, verifies the key against `/_login`, and installs a
launchd/systemd service that keeps the bridge alive. The bridge auto-starts when
`dsh web` (127.0.0.1:3080) is up.

## Configuration reference (open.env)

| Variable | Meaning |
|---|---|
| `DSH_ENTERPRISE_JWT_SECRET` | JWT secret (also accepts SaaS tokens; generate randomly) |
| `DSH_LOCAL_JWT_SECRET` | JWT secret for local (self-hosted) auth |
| `DSH_LOCAL_ACCESS_KEYS` | Comma-separated access keys for `/_login` |
| `DSH_ROUTER_PORT` | Listen port (default 13444) |
| `DSH_ROUTER_QUOTA_FREE_MAX_BPS` etc. | Optional quota overrides (see `packages/relay-router/README.md`) |
| `DSH_ROUTER_PRO_MAX_ONLINE` | Max simultaneously online devices (default 3) |

## Security notes

- The access key is the root credential of your instance. Keep `open.env` at
  mode 0600, never commit or share it; rotate it like a password.
- Always serve `/_login` and the tunnel over HTTPS/WSS in production.
- Self-hosted mode has no account system: device access is governed by the
  router's live registry, not by an account database.

## Switching back to SaaS

In the dsh web plugin panel choose connection mode → **Cloud service**, sign in
with your phone account. Local keys are cleared from the client config; SaaS
data is unaffected.

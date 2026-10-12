# @dsh-remote/router

Server-side router for dsh-remote (tunnel mode): bridge registry, real-time device
list and transparent HTTP/WS proxy.

```
手机 → nginx /remote/<deviceId>/<path> → relay-router(:13444) → WS 隧道 → 各电脑 bridge → 127.0.0.1:3080
```

- Bridges connect over WebSocket to `/_bridge` and register
  `{ type: "tunnel-register", deviceId, token }` (JWT HS256).
- Phones access devices through `/remote/<deviceId>/<path>`; the router proxies
  frames using the bridge frame protocol.
- `GET /_devices` — same-origin real-time device list. Validates the `dsh_token`
  JWT cookie and returns only the caller's online devices
  (`{ devices: [{ id, name }] }`); no/expired token → 401.
- `POST /_login` — self-hosted auth: access key (`DSH_LOCAL_ACCESS_KEYS`) → local
  JWT, TTL `DSH_LOCAL_SESSION_TTL_MS` (default **30 days**; hard-clamped to
  `[7 days, 1 year]`; invalid values fall back to the default). Enabled when both
  `DSH_LOCAL_JWT_SECRET` and `DSH_LOCAL_ACCESS_KEYS` are set; the router validates
  SaaS JWTs (`DSH_ENTERPRISE_JWT_SECRET`) as well, so one instance can serve both
  modes.
- Local sessions **slide**: whenever a `dsh_token` signed with
  `DSH_LOCAL_JWT_SECRET` arrives with less than half its TTL left, the router
  re-issues a full-TTL token via `Set-Cookie` (`Path=/; SameSite=Lax; Secure`, no
  `HttpOnly` — the phone's JS reads it). Each local JWT carries a `sat` claim
  (first-login anchor, **milliseconds**); once `now - sat` exceeds
  `DSH_LOCAL_SESSION_ABS_MAX_MS` (default 1 year, floor 7 days) renewal stops and
  the cookie expires on its own. Tokens signed with
  `DSH_ENTERPRISE_JWT_SECRET` are **never** re-signed here — the enterprise side
  owns its own renewal, revocation and absolute cap.

## Run

```sh
# 自建模式(密钥 0600,勿提交 git)
DSH_ENTERPRISE_JWT_SECRET=<随机串> \
DSH_LOCAL_JWT_SECRET=<随机串> \
DSH_LOCAL_ACCESS_KEYS=<访问密钥> \
node src/index.mjs

# 或从文件加载(--env-file 简易 KEY=VALUE)
node src/index.mjs --env-file /path/to/open.env
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_ROUTER_PORT` | 13444 | Listen port |
| `DSH_ROUTER_HOST` | 0.0.0.0 | Listen address |
| `DSH_ENTERPRISE_JWT_SECRET` | — | JWT secret (required; SaaS tokens) |
| `DSH_LOCAL_JWT_SECRET` | — | JWT secret for local (self-hosted) auth |
| `DSH_LOCAL_ACCESS_KEYS` | — | Comma-separated access keys for `/_login` |
| `DSH_LOCAL_SESSION_TTL_MS` | 2592000000 (30 days) | Local session TTL; clamped to `[7 days, 1 year]` |
| `DSH_LOCAL_SESSION_ABS_MAX_MS` | 31536000000 (1 year) | Absolute cap counted from the `sat` first-login anchor; floor 7 days |

## Dependencies

Only `ws` (Node built-ins for HTTP/crypto). The Docker image installs it via
`npm ci`; bare-metal setups can `npm install --no-save ws` in the package dir.

## Frame protocol

Identical to `clients/dsh-remote/dsh-bridge.mjs` (including the `__chunk`
fragmentation envelope):

- HTTP: `→ {id,type:"http",method,path,headers,body?,bodyBase64?}` /
  `← {id,type:"http",status,headers,body,bodyBase64}`
- WS: `→ {id,type:"ws-open",path,headers}` / `← {id,type:"ws-open",ok,code?,reason?}`;
  `→|← {id,type:"ws-msg",data,binary?}`; `→|← {id,type:"ws-close",code?,reason?}`
- Register: `→ {type:"tunnel-register",deviceId,token}` /
  `← {type:"tunnel-register-ok",deviceId}`

## Known limitations

- Multi-instance routers would need a shared registry (Redis or DB);
  a single instance is sufficient at this scale.

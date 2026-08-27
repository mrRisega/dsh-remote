# Contributing

Thanks for your interest in dsh-relay. Bug reports, documentation improvements and
feature work are all welcome.

## Code of Conduct

Be kind and professional. Harassment, discrimination and personal attacks will not
be tolerated.

## Issues

- **Bugs**: include reproduction steps, expected vs. actual behavior, and your
  environment (Node version, OS, network topology).
- **Feature requests**: describe the use case and the motivation, so we can judge
  whether it fits the project's direction.
- Search existing issues before opening a new one.

## Pull Requests

1. Fork this repository and create a branch from `main`.
2. Match the existing code style: ESM, `node:`-prefixed imports, JSDoc comments,
   Chinese inline comments are fine but not required.
3. **Tests**: changes to `relay-router`, `dsh-remote-ui` or the bridge must come
   with tests (`npm test`).
4. Follow conventional commits (`feat:` / `fix:` / `docs:` / `test:` / `chore:`).
5. Describe the motivation and how you verified the change in the PR description.

## Local Development

```bash
npm install
npm test          # router contract tests + plugin tests + bridge tests
npm run check     # syntax checks (node --check, bash -n)
```

## Architecture

```
手机浏览器
  └─ /app/ (PWA) → /_devices → 选设备 → /remote/<deviceId>/<path>
       │
  你的 nginx (HTTPS)
     ├─ /app/            → 静态 PWA (clients/dsh-web/native.html)
     ├─ /_devices /_quota /_login /remote/ /_bridge → relay-router
     └─ /_bridge         → relay-router (WebSocket)
                            └→ bridge (clients/dsh-remote) → 127.0.0.1:3080 (dsh web)
```

- `packages/relay-router/` — server-side router: bridge registry, real-time device
  list, transparent HTTP/WS proxy, per-plan bandwidth/traffic quotas, optional
  local access-key auth (`/_login`) for self-hosting.
- `clients/dsh-remote/` — the desktop bridge daemon (tunnel mode only).
- `clients/dsh-web/` — the phone PWA (login / device selection).
- `packages/dsh-remote-ui/` — the dsh web plugin (settings-page panel + bridge
  lifecycle + feedback card).

## Commercial Edition

The multi-user account system, admin console and SaaS operations live in the
closed-source `dsh-relay-enterprise` repository. It is not part of this project.
The open source router interoperates with it via shared JWT secrets; self-hosted
deployments do not need it at all.

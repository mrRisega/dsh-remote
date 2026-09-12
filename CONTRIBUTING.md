# Contributing

Thanks for your interest in dsh-remote. Bug reports, documentation improvements and
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
3. **Tests**: changes to `relay-router`, `dsh-remote-web` or the bridge must come
   with tests (`npm test`).
4. Follow conventional commits (`feat:` / `fix:` / `docs:` / `test:` / `chore:`).
5. Describe the motivation and how you verified the change in the PR description.

## Local Development

```bash
npm install
npm test          # router contract tests + plugin tests + bridge tests
npm run check     # syntax checks + legacy-alias drift check
```

## Releases & Plugin Marketplaces

The full rules live in **[docs/release-and-market.md](docs/release-and-market.md)**. The
non-negotiables, because each of them has already broken something in production:

1. **Bump three versions together** — root `package.json`, `packages/dsh-remote-web/package.json`,
   and `PLUGIN_VERSION` in `packages/dsh-remote-web/lib/index.js`.
2. **Commit before you publish** — release code must never live only in a working tree.
3. **Publish both npm packages**, always with `--registry=https://registry.npmjs.org`
   (the machine default is a mirror).
4. **Never pin a version in a marketplace `tarball:` URL.** Entries must use
   `releases/latest/download/<name>.tgz` with a **version-free asset name**, and every release
   must attach those assets — run `npm run release:tarballs` (or let
   `.github/workflows/release-tarballs.yml` do it on a `v*` tag). A pinned URL silently keeps
   shipping the old build to every storefront.
5. **Keep the legacy alias until the renamed entry is merged.** `packages/dsh-remote-ui/` is
   generated from `packages/dsh-remote-web/` by `npm run sync:alias` (`npm run check` fails
   when it drifts). Deleting it while the renamed entry is still under review makes the
   already-listed entry — and every install pointing at it — 404.
6. **Market copy says "highlights", never "selling points".** Descriptions must stay factual
   and checkable against the code, and must touch only our own entry.

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
- `packages/dsh-remote-web/` — the dsh web plugin (settings-page panel + bridge
  lifecycle + feedback card).

## Commercial Edition

The multi-user account system, admin console and SaaS operations live in the
closed-source `dsh-remote-enterprise` repository. It is not part of this project.
The open source router interoperates with it via shared JWT secrets; self-hosted
deployments do not need it at all.

# Changelog

All notable changes to dsh-remote are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-08-30

### Changed

- Feedback captcha is now optional: anonymous users (including self-hosted
  deployments without a phone account) can submit feedback and satisfaction
  ratings directly; the server still records the device IP and enforces
  per-identity/IP/global rate limits. A captcha is validated when provided.
- Payment modal shows a prominent announcement block from the server config
  (`upgrade_announcement`, `{wechat}` substituted with the configured WeChat
  id); admin console textarea enlarged for editing it.
- README: added screenshot gallery (phone mirror view, device list,
  self-hosted settings).

## [0.3.0] - 2026-08-28

### Changed

- **Project renamed to `dsh-remote`** — package, binaries, docs and commands
  now use `dsh-remote` (`npx @mrrisega/dsh-remote`). The old npm package
  `@mrrisega/dsh-relay` is deprecated.

### Fixed

- Feedback: logged-in users (SaaS account or self-hosted key) no longer need a
  captcha — the plugin's node half attaches the account JWT automatically, and
  the panel/popup hide the captcha field accordingly. Anonymous submissions
  keep the captcha requirement.
- Satisfaction popup: submit no longer blocks on a hidden captcha when
  anonymous users cannot load it; captcha is loaded on demand and errors are
  actionable.

## [0.2.1] - 2026-08-28

### Fixed

- `setup` / settings page now fetch the server-issued `bridge_secret` from
  `public-config` automatically, so a fresh one-command install can sign in to
  the cloud service without manual configuration.
- Bridge no longer misreports `device_limit_exceeded` (409) as "device bound to
  another account"; it now prints the server's actual message with guidance to
  remove the old device first.

## [0.2.0] - 2026-08-27

First public release of the tunnel-mode architecture.

### Added

- One-command client install via npm: `npx @mrrisega/dsh-remote`
  (installs bridge + dsh web plugin + autostart in one shot; login happens in
  the local settings page afterwards).
  Self-hosted mode: `npx @mrrisega/dsh-remote setup --server wss://… --key …`.
- Self-hosted mode: `relay-router` local authentication
  (`DSH_LOCAL_ACCESS_KEYS` → `POST /_login` → short-lived local JWT),
  with zero dependency on the closed-source account system.
- Router: real-time device list (`GET /_devices`), quota status (`GET /_quota`),
  per-plan token-bucket bandwidth limiting and monthly traffic caps, gzip
  pass-through for tunneled responses.
- Bridge: tunnel-only daemon with heartbeat-based half-open detection and
  exponential-backoff reconnect; gzip compression for compressible upstream
  responses.
- dsh web plugin (`dsh-remote-ui`): settings-page panel with connection-mode
  switching (cloud / self-hosted), account login & registration, invite links,
  plan status, user feedback card, and bridge lifecycle control.
- Docker deployment for self-hosting: `Dockerfile` + `docker-compose.yml`.
- CI: Node 20/22 test matrix, syntax checks, dependency audit.

### Removed

- WebRTC / P2P / signaling / STUN / TURN stack (and all related packages and
  endpoints) — replaced by the tunnel-mode architecture.

## License

PolyForm Noncommercial 1.0.0 — free for personal, research and non-commercial
use; commercial use requires a license (see `COMMERCIAL-LICENSE.md`).

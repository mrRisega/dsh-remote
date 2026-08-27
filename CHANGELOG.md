# Changelog

All notable changes to dsh-relay are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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

- One-command client install via npm: `npx @mrrisega/dsh-relay`
  (installs bridge + dsh web plugin + autostart in one shot; login happens in
  the local settings page afterwards).
  Self-hosted mode: `npx @mrrisega/dsh-relay setup --server wss://… --key …`.
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

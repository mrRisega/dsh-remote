# Security Policy

dsh-relay operates public-facing relay infrastructure. Security issues are taken
seriously and handled with priority.

## Reporting a Vulnerability

**Do not** disclose vulnerabilities publicly (no details in issues or discussions).

Please report privately through GitHub's security reporting flow:

- Open a **Security Advisory** (private): https://github.com/mrRisega/dsh-relay/security/advisories/new
  or
- Use GitHub's private vulnerability reporting on the repository page
  (*Security → Report a vulnerability*).

Include, when possible:

- Affected component (relay-router / bridge / dsh-remote-ui plugin / PWA / docs)
- Steps to reproduce and a proof of concept (if any)
- Impact assessment (data disclosure? privilege escalation? denial of service?)

## Response Commitment

- Acknowledgment of receipt within 48 hours.
- High-severity issues: a fix plan within 72 hours.
- Fixes are released through the changelog, marked `[security]`.
- Reporters are credited unless they ask to stay anonymous.

## Security Model (tunnel mode)

| Surface | Design |
|---|---|
| Account passwords | scrypt (`N=16384, r=8, p=1`, keyLen=64), constant-time comparison |
| Sessions | JWT HMAC-SHA256, 2h expiry, `jti` revocation (in-memory, single instance) |
| Device identity | Stable `dev-<12hex>` id persisted locally (file mode 0600); the router enforces device ownership — a device is only reachable by its owner |
| Self-hosted auth | Access keys (`DSH_LOCAL_ACCESS_KEYS`) exchanged for short-lived local JWTs via `POST /_login`; one key governs one instance |
| Transport | Account API and tunnel must be served over HTTPS/WSS in production; the router proxies between phone and bridge without content inspection |
| Path safety | `/remote/<deviceId>/<path>` rejects traversal and non-conforming device ids; forwarded headers are sanitized hop-by-hop |
| Rate limits | Per-IP login throttling, SMS anti-abuse (captcha after 2 requests in 24h), per-plan token-bucket bandwidth and monthly traffic caps |

## Known Design Notes

- Traffic quotas are process-memory state: a router restart resets monthly counters.
- `/_login` local JWTs are issued with the `pro_max` plan: in self-hosted mode the
  access key is the instance's root credential — keep it secret (0600), rotate it
  like a password.
- The router is a transparent proxy: it does not terminate TLS itself. Terminate
  TLS at a reverse proxy (nginx/Caddy) in front of it.

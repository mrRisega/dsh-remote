# dsh-relay self-hosted router image (tunnel mode)
#
# Runs the relay-router: bridge registry + real-time device list + transparent
# HTTP/WS proxy + per-plan quotas + optional local access-key auth (/ _login).
#
# Usage:  docker compose up -d   (see docker-compose.yml)
# TLS:    terminate HTTPS/WSS at a reverse proxy (nginx/Caddy) in front of this
#         container; the router itself speaks plain HTTP/WS.
FROM node:22-alpine

WORKDIR /app

# Dependency manifests first (layer caching)
COPY package.json package-lock.json ./
COPY packages/relay-router/package.json packages/relay-router/

RUN npm ci

# Source
COPY packages/relay-router/ packages/relay-router/
COPY clients/dsh-remote/ clients/dsh-remote/

# Default router port (overridable via DSH_ROUTER_PORT)
EXPOSE 13444

ENV DSH_ROUTER_PORT=13444

CMD ["node", "packages/relay-router/src/index.mjs"]

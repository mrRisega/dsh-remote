# dsh-remote self-hosted router image (tunnel mode)
#
# Runs the relay-router: bridge registry + real-time device list + transparent
# HTTP/WS proxy + optional local access-key auth (/ _login).
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

# ---- 日志 ----
# 应用把日志写进 /var/log/dsh-remote,并把该目录声明为 VOLUME:
#   1) 直接 docker run 时,日志落在卷里而不是容器可写层,容器重建不丢;
#   2) 用 docker-compose.yml 时绑定到宿主机 ./logs/router,便于排查。
# 轮转由应用自己做(DSH_LOG_MAX_MB / DSH_LOG_KEEP),不依赖宿主机 logrotate。
RUN mkdir -p /var/log/dsh-remote
ENV DSH_LOG_DIR=/var/log/dsh-remote \
    DSH_LOG_MAX_MB=10 \
    DSH_LOG_KEEP=5
VOLUME ["/var/log/dsh-remote"]

CMD ["node", "packages/relay-router/src/index.mjs"]

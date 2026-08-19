#!/bin/bash
# dsh-remote · SSH 反向隧道(当 Mac 与反代服务器不在同一网段时使用)
#
# 原理:Mac → SSH 连中转服务器,把服务器的 127.0.0.1:<SERVER_PORT> 反向映射
#       到 Mac 的 127.0.0.1:<MAC_GATEWAY_PORT>。服务器上的 Nginx 反代到
#       服务器本机 127.0.0.1:<SERVER_PORT>,即可把公网请求送进 Mac 网关。
#
# 用法:
#   DSH_REMOTE_SSH_HOST=your-server.example.com \
#   DSH_REMOTE_SSH_PORT=22 \
#   DSH_REMOTE_SSH_USER=your-user \
#   ./scripts/tunnel-nas.sh
#
# 常用环境变量:
#   DSH_REMOTE_SSH_HOST      中转服务器地址(必填)
#   DSH_REMOTE_SSH_PORT      中转服务器 SSH 端口(默认 22)
#   DSH_REMOTE_SSH_USER      中转服务器用户名(必填)
#   DSH_REMOTE_SERVER_PORT   服务器侧监听端口(默认 13443)
#   DSH_REMOTE_MAC_PORT      Mac 侧网关端口(默认 3443)
#   DSH_REMOTE_SSH_OPTS      附加 ssh 参数(如 "-i ~/.ssh/id_rsa")
#
# 提示:建议配合 autossh 或 systemd/launchd KeepAlive 保持隧道常驻。

set -euo pipefail

: "${DSH_REMOTE_SSH_HOST:?需要设置 DSH_REMOTE_SSH_HOST(中转服务器地址)}"
: "${DSH_REMOTE_SSH_USER:?需要设置 DSH_REMOTE_SSH_USER(中转服务器用户名)}"

SSH_PORT="${DSH_REMOTE_SSH_PORT:-22}"
SERVER_PORT="${DSH_REMOTE_SERVER_PORT:-13443}"
MAC_PORT="${DSH_REMOTE_MAC_PORT:-3443}"
SSH_OPTS="${DSH_REMOTE_SSH_OPTS:-}"

echo "[tunnel] ${DSH_REMOTE_SSH_USER}@${DSH_REMOTE_SSH_HOST}:${SSH_PORT}"
echo "[tunnel] 服务器 127.0.0.1:${SERVER_PORT}  <-  Mac 127.0.0.1:${MAC_PORT}"
echo "[tunnel] 按 Ctrl-C 退出"

# -N 不执行远程命令;-R 反向隧道;-o ServerAliveInterval 保活
# shellcheck disable=SC2086
exec ssh -N $SSH_OPTS \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -p "$SSH_PORT" \
  -R "127.0.0.1:${SERVER_PORT}:127.0.0.1:${MAC_PORT}" \
  "${DSH_REMOTE_SSH_USER}@${DSH_REMOTE_SSH_HOST}"

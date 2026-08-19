#!/bin/bash
# dsh-remote · macOS 一键安装(launchd 自启 + 可选自签证书)
#
# 用法:
#   ./scripts/install-macos.sh                          # 生成 config.json 并安装(交互输入口令)
#   DSH_REMOTE_PASSWORD=xxxx ./scripts/install-macos.sh # 用环境变量口令
#   ./scripts/install-macos.sh --with-tls               # 同时生成自签证书并启用 HTTPS
#
# 服务名: com.dshremote.daemon
# 口令以 scrypt 哈希存于项目 config.json(权限 600),不进 plist。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/deploy/com.dshremote.daemon.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.dshremote.daemon.plist"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
CONFIG="$ROOT/config.json"

if [ ! -f "$PLIST_SRC" ]; then
  echo "错误: 找不到 $PLIST_SRC" >&2
  exit 1
fi

# 口令:环境变量 > 交互输入
PASSWORD="${DSH_REMOTE_PASSWORD:-}"
if [ -z "$PASSWORD" ]; then
  read -r -s -p "设置访问口令(≥8 位): " PASSWORD; echo
  if [ -z "$PASSWORD" ]; then
    echo "错误: 口令不能为空" >&2
    exit 1
  fi
fi

# 生成 scrypt 哈希
HASH="$(printf '%s' "$PASSWORD" | "$NODE_BIN" "$ROOT/bin/dsh-remote.js" hash-password 2>/dev/null | grep -o 'scrypt.*')"
if [ -z "$HASH" ]; then
  echo "错误: 口令哈希生成失败" >&2
  exit 1
fi

# TLS 可选
TLS_BLOCK=""
if [ "${1:-}" = "--with-tls" ]; then
  bash "$ROOT/scripts/gen-cert.sh"
  TLS_BLOCK="  \"tls\": { \"cert\": \"$ROOT/certs/server.crt\", \"key\": \"$ROOT/certs/server.key\" },"
fi

# 写入 config.json(600)
umask 177
cat > "$CONFIG" <<EOF
{
  "host": "0.0.0.0",
  "port": 3443,
  "upstream": "http://127.0.0.1:3080",
  "passwordHash": "$HASH",
  "sessionTtlHours": 12,
  "rateLimit": { "max": 5, "windowMs": 900000 },
  "allowIps": [],
$TLS_BLOCK
  "distDir": "$ROOT/public"
}
EOF
chmod 600 "$CONFIG"
echo "[install] config.json 已写入(600,口令哈希)"

mkdir -p "$HOME/Library/LaunchAgents"

# 生成实际 plist(替换模板占位符)
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__INSTALL_DIR__|$ROOT|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# 若已加载则先卸载
if launchctl list | grep -q "com.dshremote.daemon"; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi
launchctl load "$PLIST_DST"
echo "[install] 已安装并启动: $PLIST_DST"
sleep 1
if curl -s -o /dev/null http://127.0.0.1:3443/login 2>/dev/null; then
  echo "[install] 本机访问: http://127.0.0.1:3443/login"
fi
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || echo '<本机IP>')"
echo "[install] 局域网访问: http://${LAN_IP}:3443/login"
echo "[install] 日志: tail -f /tmp/dsh-remote.log"

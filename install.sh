#!/usr/bin/env bash
# =============================================================================
# dsh-remote · 一键安装脚本
#
# 用法(任选其一):
#   1) 直接运行(交互式问答,自动写 config.json + 安装系统服务):
#        curl -fsSL https://raw.githubusercontent.com/mrgaoang/dsh-remote/main/install.sh | bash
#
#   2) 环境变量方式(非交互,适合脚本化):
#        DSH_REMOTE_PASSWORD='强口令' \
#        DSH_REMOTE_PORT=3443 \
#        DSH_REMOTE_UPSTREAM=http://127.0.0.1:3080 \
#        DSH_REMOTE_INSTALL_DIR=$HOME/dsh-remote \
#        bash <(curl -fsSL https://raw.githubusercontent.com/mrgaoang/dsh-remote/main/install.sh)
#
#   3) 本地仓库运行(开发/离线):
#        DSH_REMOTE_SOURCE_DIR=. DSH_REMOTE_PASSWORD='x' ./install.sh
#
# 需要: Node.js >= 20, bash。可选: git(从仓库克隆)或 curl(下载 tarball)。
# 安装内容:
#   - 项目文件(克隆/复制到 DSH_REMOTE_INSTALL_DIR,默认 ~/.dsh-remote)
#   - config.json(口令以 scrypt 哈希存储,权限 600)
#   - 系统服务:macOS 用 launchd,Linux 用 systemd(默认开启,开机自启)
#
# 所有环境变量(均可选,除 PASSWORD 在非交互模式下必填):
#   DSH_REMOTE_INSTALL_DIR   安装目录(默认 ~/.dsh-remote)
#   DSH_REMOTE_REPO_URL      仓库地址(默认 GitHub 占位,发布后替换)
#   DSH_REMOTE_REPO_BRANCH   分支(默认 main)
#   DSH_REMOTE_TARBALL_URL   无 git 时的 tarball 地址(可选)
#   DSH_REMOTE_SOURCE_DIR    本地源码目录(复制模式,测试/离线用)
#   DSH_REMOTE_PASSWORD      访问口令(必填,非交互模式)
#   DSH_REMOTE_PORT          监听端口(默认 3443)
#   DSH_REMOTE_HOST          绑定地址(默认 0.0.0.0)
#   DSH_REMOTE_UPSTREAM      dsh web 地址(默认 http://127.0.0.1:3080)
#   DSH_REMOTE_SESSION_TTL_HOURS  会话有效期(默认 12)
#   DSH_REMOTE_ALLOW_IPS     IP 白名单,逗号分隔(默认空)
#   DSH_REMOTE_TLS_CERT/KEY  TLS 证书/私钥路径(可选)
#   DSH_REMOTE_NO_SERVICE=1  不安装系统服务(仅部署文件)
#   DSH_REMOTE_NONINTERACTIVE=1  非交互(缺口令时报错)
#   DSH_REMOTE_FORCE=1       覆盖已有 config.json
# =============================================================================
set -euo pipefail

# ---------- 解析输入 ----------
INSTALL_DIR="${DSH_REMOTE_INSTALL_DIR:-$HOME/.dsh-remote}"
REPO_URL="${DSH_REMOTE_REPO_URL:-https://github.com/mrgaoang/dsh-remote.git}"
REPO_BRANCH="${DSH_REMOTE_REPO_BRANCH:-main}"
PORT="${DSH_REMOTE_PORT:-3443}"
UPSTREAM="${DSH_REMOTE_UPSTREAM:-http://127.0.0.1:3080}"
PASSWORD="${DSH_REMOTE_PASSWORD:-}"
HOST="${DSH_REMOTE_HOST:-0.0.0.0}"
SESSION_TTL_HOURS="${DSH_REMOTE_SESSION_TTL_HOURS:-12}"
ALLOW_IPS="${DSH_REMOTE_ALLOW_IPS:-}"
TLS_CERT="${DSH_REMOTE_TLS_CERT:-}"
TLS_KEY="${DSH_REMOTE_TLS_KEY:-}"

# ---------- 工具函数 ----------
log()  { printf '\033[1;34m[dsh-remote]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dsh-remote][warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[dsh-remote][error]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "需要命令: $1 (请先安装)"; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      fail "不支持的系统: $(uname -s)(仅支持 macOS / Linux)" ;;
  esac
}

# ---------- 前置检查 ----------
need_cmd node
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 版本过低: $(node --version)(需要 >= 20)"
fi
log "Node.js $(node --version) ✓"

OS="$(detect_os)"
log "检测到系统: $OS"

# ---------- 获取项目文件 ----------
# 优先级: 1) 本地源码目录 2) 已存在安装目录 3) git clone 4) tarball
if [ -n "${DSH_REMOTE_SOURCE_DIR:-}" ] && [ -d "$DSH_REMOTE_SOURCE_DIR" ]; then
  log "从本地目录复制: $DSH_REMOTE_SOURCE_DIR → $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -R "$DSH_REMOTE_SOURCE_DIR/." "$INSTALL_DIR/"
  rm -rf "$INSTALL_DIR/config.json" "$INSTALL_DIR/certs" "$INSTALL_DIR/.git" 2>/dev/null || true
elif [ -d "$INSTALL_DIR/.git" ]; then
  log "更新已有安装: $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "git pull 失败,继续使用现有文件"
elif [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  log "复用已有安装目录: $INSTALL_DIR"
else
  log "获取项目文件 → $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" \
      || fail "git clone 失败: $REPO_URL"
  elif command -v curl >/dev/null 2>&1; then
    TARBALL="${DSH_REMOTE_TARBALL_URL:-}"
    [ -n "$TARBALL" ] || fail "未安装 git 且未设置 DSH_REMOTE_TARBALL_URL,无法获取源码"
    curl -fsSL "$TARBALL" -o /tmp/dsh-remote.tar.gz || fail "下载失败"
    mkdir -p "$INSTALL_DIR"
    tar -xzf /tmp/dsh-remote.tar.gz -C "$INSTALL_DIR" --strip-components=1
    rm -f /tmp/dsh-remote.tar.gz
  else
    fail "需要 git 或 curl 之一来获取源码"
  fi
fi

cd "$INSTALL_DIR"
log "项目目录: $INSTALL_DIR"

# ---------- 口令 ----------
if [ -z "$PASSWORD" ]; then
  if [ -n "${DSH_REMOTE_NONINTERACTIVE:-}" ]; then
    fail "非交互模式下必须提供 DSH_REMOTE_PASSWORD"
  fi
  read -r -s -p "设置访问口令(≥8 位,输入不显示): " PASSWORD; echo
  [ -n "$PASSWORD" ] || fail "口令不能为空"
fi

# ---------- 生成 config.json ----------
if [ -f "$INSTALL_DIR/config.json" ] && [ -z "${DSH_REMOTE_FORCE:-}" ]; then
  log "检测到已有 config.json,跳过生成(设置 DSH_REMOTE_FORCE=1 可覆盖)"
else
  HASH="$(node "$INSTALL_DIR/bin/dsh-remote.js" hash-password --password "$PASSWORD" 2>/dev/null | grep -o 'scrypt.*')"
  [ -n "$HASH" ] || fail "口令哈希生成失败"

  TLS_BLOCK=""
  if [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ]; then
    TLS_BLOCK="  \"tls\": { \"cert\": \"$TLS_CERT\", \"key\": \"$TLS_KEY\" },"
  fi

  if [ -n "$ALLOW_IPS" ]; then
    ALLOW_BLOCK="\"allowIps\": [\"$(echo "$ALLOW_IPS" | tr ',' '"","')\"],"
  else
    ALLOW_BLOCK="\"allowIps\": [],"
  fi

  umask 177
  cat > "$INSTALL_DIR/config.json" <<EOF
{
  "host": "$HOST",
  "port": $PORT,
  "upstream": "$UPSTREAM",
  "passwordHash": "$HASH",
  "sessionTtlHours": $SESSION_TTL_HOURS,
  "rateLimit": { "max": 5, "windowMs": 900000 },
  $ALLOW_BLOCK
$TLS_BLOCK
  "distDir": "$INSTALL_DIR/public"
}
EOF
  chmod 600 "$INSTALL_DIR/config.json"
  log "config.json 已生成(口令哈希,权限 600)"
fi

# ---------- 安装系统服务 ----------
install_service() {
  case "$OS" in
    macos)
      need_cmd launchctl
      PLIST_DST="$HOME/Library/LaunchAgents/com.dshremote.daemon.plist"
      NODE_BIN="$(command -v node)"
      mkdir -p "$HOME/Library/LaunchAgents"
      sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
          -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
          "$INSTALL_DIR/deploy/com.dshremote.daemon.plist" > "$PLIST_DST"
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      launchctl load "$PLIST_DST"
      log "launchd 服务已安装: com.dshremote.daemon"
      ;;
    linux)
      need_cmd systemctl
      NODE_BIN="$(command -v node)"
      if [ "$(id -u)" -eq 0 ]; then
        SERVICE_DST="/etc/systemd/system/dsh-remote.service"
        cat > "$SERVICE_DST" <<EOF
[Unit]
Description=dsh-remote — DeepSeek Harness remote gateway
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $INSTALL_DIR/bin/dsh-remote.js start --config $INSTALL_DIR/config.json
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable --now dsh-remote
        log "systemd 服务已安装并启动: dsh-remote"
      else
        mkdir -p "$HOME/.config/systemd/user"
        cat > "$HOME/.config/systemd/user/dsh-remote.service" <<EOF
[Unit]
Description=dsh-remote — DeepSeek Harness remote gateway
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $INSTALL_DIR/bin/dsh-remote.js start --config $INSTALL_DIR/config.json
WorkingDirectory=$INSTALL_DIR
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now dsh-remote
        log "systemd 用户服务已安装并启动: dsh-remote (--user)"
      fi
      ;;
  esac
}

if [ -n "${DSH_REMOTE_NO_SERVICE:-}" ]; then
  log "跳过系统服务安装(DSH_REMOTE_NO_SERVICE=1)"
else
  install_service
fi

# ---------- 收尾 ----------
sleep 1
SCHEME="http"
[ -n "$TLS_CERT" ] && SCHEME="https"

LAN_IP=""
case "$OS" in
  macos) LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || echo '')" ;;
  linux) LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" ;;
esac

echo
log "✅ dsh-remote 安装完成!"
echo
echo "   访问地址:"
echo "     本机:   $SCHEME://127.0.0.1:$PORT/login"
if [ -n "$LAN_IP" ]; then
  echo "     局域网: $SCHEME://$LAN_IP:$PORT/login"
fi
echo
echo "   管理:"
if [ "$OS" = macos ]; then
  echo "     日志:   tail -f /tmp/dsh-remote.log"
else
  echo "     日志:   journalctl -u dsh-remote -f"
fi
echo "     卸载:   $INSTALL_DIR/uninstall.sh"
echo
log "下一步:手机浏览器打开上面的地址,输入口令即可远程控制 DeepSeek Harness。"
log "公网访问请参考 deploy/nas/DEPLOY-NAS.md。"

#!/bin/bash
# ============================================================
# install-open.sh — dsh-remote 开源自部署一键引导(router + 本地认证)
#
# 适用:有服务器/域名,不想依赖 SaaS 账号体系的用户。
# 产出:
#   - open.env        生成密钥与访问密钥(0600,勿提交)
#   - 启动 relay-router(隧道 + /_devices + /_login)
#   - 输出:公网地址、访问密钥(手机 App / bridge 用)
#
# 用法:
#   bash deploy/install-open.sh [--port 13444]
# 依赖:Node ≥ 22、ws(自动安装)、自己的 nginx(反代见 docs/self-hosting.md)
# ============================================================
set -e
cd "$(dirname "$0")/.."
PORT="${1:-13444}"
if [ "$PORT" = "--port" ]; then PORT="${2:-13444}"; fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 需要 Node ≥ 22(含 node:sqlite 不需要,router 仅需 node:http + ws)"
  exit 1
fi

echo "==> 生成密钥与访问密钥..."
OPEN_ENV="open.env"
LOG_DIR_ABS="$(pwd)/logs/router"
if [ ! -f "$OPEN_ENV" ]; then
  LOCAL_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  ACCESS_KEY=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  cat > "$OPEN_ENV" <<EOF
# dsh-remote 开源自部署配置(0600,勿提交、勿外传)
DSH_ENTERPRISE_JWT_SECRET=${LOCAL_SECRET}
DSH_LOCAL_JWT_SECRET=${LOCAL_SECRET}
DSH_LOCAL_ACCESS_KEYS=${ACCESS_KEY}
DSH_ROUTER_PORT=${PORT}
# 日志目录(轮转由应用自己做)
DSH_LOG_DIR=${LOG_DIR_ABS}
DSH_LOG_MAX_MB=10
DSH_LOG_KEEP=5
EOF
  chmod 600 "$OPEN_ENV"
  echo "   已生成 $OPEN_ENV(访问密钥: ${ACCESS_KEY})"
else
  ACCESS_KEY=$(grep DSH_LOCAL_ACCESS_KEYS "$OPEN_ENV" | cut -d= -f2)
  echo "   已存在 $OPEN_ENV,沿用配置"
  # 老安装升级:补上日志落盘配置(缺失才追加,不覆盖用户已有设置)
  if ! grep -q '^DSH_LOG_DIR=' "$OPEN_ENV"; then
    {
      echo "# 日志目录(老安装自动补齐)"
      echo "DSH_LOG_DIR=${LOG_DIR_ABS}"
      echo "DSH_LOG_MAX_MB=10"
      echo "DSH_LOG_KEEP=5"
    } >> "$OPEN_ENV"
    echo "   已追加日志落盘配置:DSH_LOG_DIR=${LOG_DIR_ABS}"
  fi
fi
mkdir -p "$LOG_DIR_ABS"

echo "==> 检查 ws 依赖..."
if [ ! -d packages/relay-router/node_modules/ws ] && [ ! -d node_modules/ws ]; then
  (cd packages/relay-router && npm install --no-save ws >/dev/null 2>&1) || {
    echo "❌ ws 安装失败:请执行 cd packages/relay-router && npm install ws"
    exit 1
  }
fi

# 端口占用检测:`ss` 是 Linux(iproute2)专有,macOS 上没有 → 退回 lsof;都没有就交给启动阶段报错。
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$1 "
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

echo "==> 启动 relay-router(:$PORT)..."
if port_busy "$PORT"; then
  echo "❌ 端口 $PORT 已被占用"
  exit 1
fi
set -a; . ./open.env; set +a
# setsid 也是 Linux(util-linux)专有,macOS 上没有:有就用它彻底脱离终端会话,没有就退回 nohup。
if command -v setsid >/dev/null 2>&1; then
  setsid nohup node packages/relay-router/src/index.mjs >> open-router.log 2>&1 < /dev/null &
else
  nohup node packages/relay-router/src/index.mjs >> open-router.log 2>&1 < /dev/null &
fi
sleep 1.5
if ! kill -0 $! 2>/dev/null; then
  echo "❌ 启动失败,见 open-router.log"
  exit 1
fi
echo "   router 已启动 pid=$! 日志 ${DSH_LOG_DIR:-open-router.log}"

echo ""
echo "============================================================"
echo "✅ 部署完成"
echo "   公网入口   : https://<你的域名>:${PORT}/ (nginx 反代,见 docs/self-hosting.md)"
echo "   手机端     : https://<你的域名>:${PORT}/app/ (密钥登录)"
echo "   访问密钥   : ${ACCESS_KEY}"
echo "   电脑端     : 插件面板「连接模式 → 自建」填地址+密钥即可"
echo "============================================================"

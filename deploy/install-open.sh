#!/bin/bash
# ============================================================
# install-open.sh — dsh-relay 开源自部署一键引导(router + 本地认证)
#
# 适用:有服务器/域名,不想依赖 SaaS 账号体系的用户。
# 产出:
#   - open.env        生成密钥与访问密钥(0600,勿提交)
#   - 启动 relay-router(隧道 + /_devices + /_quota + /_login)
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
if [ ! -f "$OPEN_ENV" ]; then
  LOCAL_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  ACCESS_KEY=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  cat > "$OPEN_ENV" <<EOF
# dsh-relay 开源自部署配置(0600,勿提交、勿外传)
DSH_ENTERPRISE_JWT_SECRET=${LOCAL_SECRET}
DSH_LOCAL_JWT_SECRET=${LOCAL_SECRET}
DSH_LOCAL_ACCESS_KEYS=${ACCESS_KEY}
DSH_ROUTER_PORT=${PORT}
EOF
  chmod 600 "$OPEN_ENV"
  echo "   已生成 $OPEN_ENV(访问密钥: ${ACCESS_KEY})"
else
  ACCESS_KEY=$(grep DSH_LOCAL_ACCESS_KEYS "$OPEN_ENV" | cut -d= -f2)
  echo "   已存在 $OPEN_ENV,沿用配置"
fi

echo "==> 检查 ws 依赖..."
if [ ! -d packages/relay-router/node_modules/ws ] && [ ! -d node_modules/ws ]; then
  (cd packages/relay-router && npm install --no-save ws >/dev/null 2>&1) || {
    echo "❌ ws 安装失败:请执行 cd packages/relay-router && npm install ws"
    exit 1
  }
fi

echo "==> 启动 relay-router(:$PORT)..."
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "❌ 端口 $PORT 已被占用"
  exit 1
fi
set -a; . ./open.env; set +a
setsid nohup node packages/relay-router/src/index.mjs >> open-router.log 2>&1 < /dev/null &
sleep 1.5
if ! kill -0 $! 2>/dev/null; then
  echo "❌ 启动失败,见 open-router.log"
  exit 1
fi
echo "   router 已启动 pid=$! 日志 open-router.log"

echo ""
echo "============================================================"
echo "✅ 部署完成"
echo "   公网入口   : https://<你的域名>:${PORT}/ (nginx 反代,见 docs/self-hosting.md)"
echo "   手机端     : https://<你的域名>:${PORT}/app/ (密钥登录)"
echo "   访问密钥   : ${ACCESS_KEY}"
echo "   电脑端     : 插件面板「连接模式 → 自建」填地址+密钥即可"
echo "============================================================"

#!/bin/bash
# dsh-remote · 生成自签名 TLS 证书(局域网/直连模式)
#
# 用法: ./scripts/gen-cert.sh [域名或IP...]
#   默认使用本机局域网 IP 与 localhost。
# 手机端首次访问需安装并信任该证书(见 README「证书信任」一节)。

set -euo pipefail

CERT_DIR="${DSH_REMOTE_CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
mkdir -p "$CERT_DIR"

# 收集 SAN:localhost + 本机所有非回环 IPv4
HOSTS=("localhost")
for ip in $(ipconfig getifaddr en0 2>/dev/null || true) \
         $(ipconfig getifaddr en1 2>/dev/null || true); do
  [ -n "$ip" ] && HOSTS+=("$ip")
done
# 额外参数
for extra in "$@"; do HOSTS+=("$extra"); done

# 去重
HOSTS=($(printf '%s\n' "${HOSTS[@]}" | awk '!seen[$0]++'))

SAN=""
for h in "${HOSTS[@]}"; do
  SAN="${SAN}DNS:${h},IP:${h}," 2>/dev/null || true
done
# 若含 IP 形式则用 IP:,否则 DNS:
SAN=""
for h in "${HOSTS[@]}"; do
  if [[ "$h" =~ ^[0-9.]+$ ]]; then SAN="${SAN}IP:${h},"; else SAN="${SAN}DNS:${h},"; fi
done
SAN="${SAN%,}"

KEY="$CERT_DIR/server.key"
CRT="$CERT_DIR/server.crt"

echo "[gen-cert] 输出目录: $CERT_DIR"
echo "[gen-cert] SAN: $SAN"

openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=${HOSTS[0]}" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1

chmod 600 "$KEY"
echo "[gen-cert] 完成:"
echo "  $CRT"
echo "  $KEY"
echo "[gen-cert] 网关启动时设置:"
echo "  DSH_REMOTE_TLS_CERT=$CRT"
echo "  DSH_REMOTE_TLS_KEY=$KEY"

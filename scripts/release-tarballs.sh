#!/usr/bin/env bash
# 每次发版后运行：为当前版本生成预构建插件包并挂到 GitHub Release。
#
#   bash scripts/release-tarballs.sh            # 按 package.json 版本发 v<version>
#   bash scripts/release-tarballs.sh --dry-run  # 只打包不发布
#
# 为什么必须每次跑：插件市场条目用 releases/latest/download/<name>.tgz（资产名不带版本号）
# 指向我们的预构建包；如果新版本的 Release 没挂上同名资产，latest/download 会 404，
# 市场里的一键安装就会失败。本脚本保证「每个版本的 Release 都有那两个常量名资产」。
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

REPO="mrRisega/dsh-remote"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -p "require('$ROOT/package.json').version")
TAG="v$VERSION"
OUT="$(mktemp -d)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

echo "版本: ${VERSION}  标签: ${TAG}"


# 从 CHANGELOG.md 提取本版本小节作为 Release 正文（插件市场的「更新说明」直接读它）
extract_notes() {
  local ver="$1" out="$2"
  awk -v ver="$ver" '
    index($0, "## [" ver "]") == 1 { f = 1; next }
    f && index($0, "## [") == 1 { exit }
    f { print }
  ' "$ROOT/CHANGELOG.md" | awk 'NF {p=1} p' | sed -e :a -e '/^\n*$/{$d;N;ba}' > "$out"
  [ -s "$out" ] || printf '维护性发布：%s。详见仓库 CHANGELOG。\n' "$ver" > "$out"
}

for pkg in dsh-remote-web dsh-remote-ui; do
  [ -d "$ROOT/packages/$pkg" ] || { echo "跳过（不存在）: packages/$pkg"; continue; }
  (cd "$ROOT/packages/$pkg" && npm pack --pack-destination "$OUT" >/dev/null)
  # 重命名为不带版本号的常量名 —— latest/download 才能长期有效
  mv "$OUT/$pkg-$VERSION.tgz" "$OUT/$pkg.tgz"
  inner=$(tar -xzOf "$OUT/$pkg.tgz" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
  [ "$inner" = "$VERSION" ] || { echo "✖ $pkg 包内版本($inner) 与 $VERSION 不一致"; exit 1; }
  echo "  ✅ $pkg.tgz (包内 $inner)"
done

if [ "$DRY" = 1 ]; then
  echo "dry-run：产物在 ${OUT}（未发布）"
  ls -lh "$OUT"
  exit 0
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG 已存在 → 覆盖上传资产并刷新说明"
  gh release upload "$TAG" "$OUT"/*.tgz --repo "$REPO" --clobber
  NOTES=$(mktemp); extract_notes "$VERSION" "$NOTES"
  gh release edit "$TAG" --repo "$REPO" --notes-file "$NOTES" >/dev/null
else
  echo "创建 Release $TAG"
  NOTES=$(mktemp)
  extract_notes "$VERSION" "$NOTES"
  gh release create "$TAG" --repo "$REPO" --target main \
    --title "dsh-remote $VERSION" \
    --notes-file "$NOTES" \
    "$OUT"/*.tgz
fi

echo "== 校验 latest/download 是否指向本版本 =="
sleep 3
tmp=$(mktemp)
curl -sL -o "$tmp" "https://github.com/$REPO/releases/latest/download/dsh-remote-web.tgz?cb=$(date +%s)"
got=$(tar -xzOf "$tmp" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
rm -f "$tmp"
if [ "$got" = "$VERSION" ]; then
  echo "  ✅ latest/download/dsh-remote-web.tgz = $got"
else
  echo "  ⚠️ latest/download 目前是 $got（CDN 缓存或另有更新的 release）——稍后复查"
fi

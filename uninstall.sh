#!/usr/bin/env bash
# dsh-remote · 卸载脚本
#
# 用法:
#   ./uninstall.sh             # 停止并移除服务(保留项目文件与 config.json)
#   ./uninstall.sh --purge     # 完全移除(含项目文件与 config.json)
set -euo pipefail

INSTALL_DIR="${DSH_REMOTE_INSTALL_DIR:-$HOME/.dsh-remote}"
PURGE="${1:-}"

log() { printf '\033[1;34m[dsh-remote]\033[0m %s\n' "$*"; }

case "$(uname -s)" in
  Darwin)
    PLIST_DST="$HOME/Library/LaunchAgents/com.dshremote.daemon.plist"
    if [ -f "$PLIST_DST" ]; then
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      rm -f "$PLIST_DST"
      log "已移除 launchd 服务"
    fi
    ;;
  Linux)
    if [ "$(id -u)" -eq 0 ]; then
      systemctl disable --now dsh-remote 2>/dev/null || true
      rm -f /etc/systemd/system/dsh-remote.service
      systemctl daemon-reload
      log "已移除 systemd 服务"
    else
      systemctl --user disable --now dsh-remote 2>/dev/null || true
      rm -f "$HOME/.config/systemd/user/dsh-remote.service"
      systemctl --user daemon-reload
      log "已移除 systemd 用户服务"
    fi
    ;;
  *)
    log "未知系统,仅清理文件"
    ;;
esac

if [ "$PURGE" = "--purge" ]; then
  rm -rf "$INSTALL_DIR"
  log "已完全移除项目目录: $INSTALL_DIR"
else
  log "已停止服务;项目文件保留在 $INSTALL_DIR(如需删除: ./uninstall.sh --purge)"
fi
echo "✅ dsh-remote 卸载完成"

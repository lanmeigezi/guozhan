#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# guozhan 停止脚本（配合 scripts/start.sh -d 的 PID 文件；找不到则 pgrep 兜底）
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

DATA_DIR="${GUOZHAN_DATA_DIR:-${DATA_DIR:-$ROOT/data}}"
if [ -f "$ROOT/.env" ]; then
  # 只取 DATA_DIR 一行，避免整份 .env 进环境
  _d="$(grep -E '^(GUOZHAN_)?DATA_DIR=' "$ROOT/.env" | tail -n1 | cut -d= -f2- || true)"
  [ -n "$_d" ] && DATA_DIR="$_d"
fi

PIDFILE="$DATA_DIR/guozhan.pid"

stop_pid() {
  local pid="$1"
  if kill -0 "$pid" 2>/dev/null; then
    echo "[stop] 发送 SIGTERM 给 PID=$pid"
    kill "$pid"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || { echo "[stop] 进程已退出 ✓"; rm -f "$PIDFILE"; return 0; }
      sleep 1
    done
    echo "[stop] 10 秒未退出，SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
  else
    echo "[stop] PID=$pid 不存在（陈旧 pid 文件），已清理"
    rm -f "$PIDFILE"
  fi
}

if [ -f "$PIDFILE" ]; then
  stop_pid "$(cat "$PIDFILE")"
  exit 0
fi

# 无 PID 文件：pgrep 兜底（只匹配本仓库的 dist/main.js，避免误杀别的 node 服务）
if command -v pgrep >/dev/null 2>&1; then
  pids="$(pgrep -f "node .*dist/main\.js" || true)"
  if [ -n "$pids" ]; then
    for p in $pids; do stop_pid "$p"; done
    exit 0
  fi
fi

echo "[stop] 未找到运行中的 guozhan 进程"

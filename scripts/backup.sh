#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# guozhan 备份脚本 —— 遍历 data/rooms/*.db 做原子备份
#
# 优先用 sqlite3 的 .backup（在线原子备份，WAL 一致性由 SQLite 保证）；
# 机器上没有 sqlite3 时降级为"db + -wal + -shm 三件套一起复制"
# （三件套必须同刻复制，缺 wal 会丢最近事务）。
#
# 用法：./scripts/backup.sh [目标目录]     默认 data/backups/<UTC 时间戳>/
# 建议 cron：0 * * * * cd /opt/guozhan && ./scripts/backup.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

DATA_DIR="${GUOZHAN_DATA_DIR:-${DATA_DIR:-$ROOT/data}}"
if [ -f "$ROOT/.env" ]; then
  _d="$(grep -E '^(GUOZHAN_)?DATA_DIR=' "$ROOT/.env" | tail -n1 | cut -d= -f2- || true)"
  [ -n "$_d" ] && DATA_DIR="$_d"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-$DATA_DIR/backups/$STAMP}"
mkdir -p "$DEST/rooms"

count=0
fail=0

backup_one() {
  local db="$1" rel="$2"
  local out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"
  if command -v sqlite3 >/dev/null 2>&1; then
    # .backup 是 SQLite 官方在线备份 API：加读锁、复制页、放锁，服务不用停
    # ★stderr 必须吞掉：Windows 上 sqlite3 CLI 遇到非 ASCII 路径会打印
    #   "unable to open database"，那是 CLI 的编码问题、不是库坏了；
    #   让它留在输出里会把运维吓一跳，而实际会走下面的三件套兜底。
    if sqlite3 "$db" ".backup '$out'" 2>/dev/null; then
      echo "[backup] $rel ✓ (sqlite3 .backup)"
      return 0
    fi
    echo "[backup] $rel：sqlite3 .backup 不可用（路径编码/权限/版本），降级为三件套复制" >&2
  fi
  # 降级：三件套复制（服务写入的瞬间可能撕裂，恢复时 SQLite 会按 wal 校验回滚到最后一致点）
  cp "$db" "$out"
  [ -f "$db-wal" ] && cp "$db-wal" "$out-wal"
  [ -f "$db-shm" ] && cp "$db-shm" "$out-shm"
  echo "[backup] $rel ✓ (db+wal+shm 复制)"
}

# 房间库
shopt -s nullglob
for db in "$DATA_DIR"/rooms/*.db; do
  name="$(basename "$db")"
  if backup_one "$db" "rooms/$name"; then count=$((count+1)); else fail=$((fail+1)); fi
done

# 房间注册表（同样重要，别只备房间库）
if [ -f "$DATA_DIR/index.db" ]; then
  if backup_one "$DATA_DIR/index.db" "index.db"; then count=$((count+1)); else fail=$((fail+1)); fi
fi
shopt -u nullglob

if [ "$count" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo "[backup] 警告：$DATA_DIR 下没有任何 .db 可备份（服务从未启动过？）" >&2
  exit 1
fi

echo "[backup] 完成：$count 个库 → $DEST（失败 $fail）"
[ "$fail" -eq 0 ]

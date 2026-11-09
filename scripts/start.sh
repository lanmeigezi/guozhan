#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# guozhan 裸跑启动脚本（无 Docker）
#   ./scripts/start.sh        # 前台运行（Ctrl-C 停止，适合 systemd/nohup 托管）
#   ./scripts/start.sh -d     # 后台运行，PID 写入 $DATA_DIR/guozhan.pid
#
# 前置检查：Node ≥24（node:sqlite 免标志）、config/ 存在、data/ 可写
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# .env 存在则加载（KEY=VALUE，忽略注释与空行）
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
  echo "[start] 已加载 .env"
fi

DATA_DIR="${GUOZHAN_DATA_DIR:-${DATA_DIR:-$ROOT/data}}"
PORT="${PORT:-8788}"
HOST="${HOST:-127.0.0.1}"

# ── 前置检查 ──
command -v node >/dev/null 2>&1 || { echo "[start] 错误：未找到 node，请先安装 Node.js ≥24" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "[start] 错误：Node 版本过低（当前 $(node -v)，要求 ≥24）" >&2
  echo "        原因：存储用内置 node:sqlite，Node 22.5–23.3 仍需要 --experimental-sqlite 标志。" >&2
  exit 1
fi
echo "[start] Node $(node -v) ✓"

if [ ! -d "$ROOT/config" ] || [ ! -f "$ROOT/config/map/regions.json" ]; then
  echo "[start] 错误：config/ 目录缺失或不完整（需要 config/map/regions.json）" >&2
  exit 1
fi
echo "[start] config/ ✓"

mkdir -p "$DATA_DIR/rooms"
if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "[start] 错误：数据目录不可写：$DATA_DIR" >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"
echo "[start] data 目录可写 ✓ ($DATA_DIR)"

# ── 安装依赖与构建 ──
# 依赖已装好时默认跳过 npm ci（启动快、也不会在弱网机器上卡住）；
# 需要严格复现锁文件时设 GUOZHAN_FORCE_INSTALL=1。
if [ "${GUOZHAN_SKIP_INSTALL:-0}" = "1" ]; then
  echo "[start] 跳过 npm ci（GUOZHAN_SKIP_INSTALL=1）"
elif [ -d "$ROOT/node_modules" ] && [ "${GUOZHAN_FORCE_INSTALL:-0}" != "1" ]; then
  echo "[start] node_modules 已存在，跳过安装（GUOZHAN_FORCE_INSTALL=1 可强制 npm ci）"
else
  echo "[start] npm ci（含 devDependencies，构建需要 tsup）..."
  npm ci --no-audit --no-fund
fi
echo "[start] npm run build ..."
npm run build

if [ ! -f "$ROOT/dist/main.js" ]; then
  echo "[start] 错误：构建产物 dist/main.js 不存在" >&2
  exit 1
fi

# ── 启动 ──
export NODE_ENV="${NODE_ENV:-production}" HOST PORT DATA_DIR
export GUOZHAN_DATA_DIR="$DATA_DIR"   # ★服务端读的是这个；DATA_DIR 只是脚本内的简写
if [ "${1:-}" = "-d" ]; then
  nohup node --enable-source-maps dist/main.js >>"$DATA_DIR/guozhan.log" 2>&1 &
  echo $! > "$DATA_DIR/guozhan.pid"
  echo "[start] 已后台启动 PID=$(cat "$DATA_DIR/guozhan.pid")，日志：$DATA_DIR/guozhan.log"
else
  echo "[start] 前台启动 http://$HOST:$PORT （Ctrl-C 停止）"
  exec node --enable-source-maps dist/main.js
fi

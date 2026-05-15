#!/usr/bin/env bash
set -euo pipefail
PORT=8000
PIDS="$(lsof -ti ":$PORT" 2>/dev/null || true)"
if [[ -z "$PIDS" ]]; then
  echo "端口 $PORT 上没有运行中的服务。"
  exit 0
fi
echo "$PIDS" | xargs kill 2>/dev/null || true
echo "已停止端口 $PORT 上的服务。"

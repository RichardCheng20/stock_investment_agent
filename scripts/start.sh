#!/usr/bin/env bash
# 一键启动：准备环境 → 启动 FastAPI → 打开浏览器
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV="$BACKEND/.venv"
PORT=8000
URL="http://127.0.0.1:${PORT}/"

cd "$ROOT"

echo "==> stock_investment_agent"
echo "    项目目录: $ROOT"

if [[ ! -f "$BACKEND/.env" ]]; then
  echo ""
  echo "⚠️  未找到 backend/.env"
  echo "    请先复制: cp backend/.env.example backend/.env"
  echo "    并填写 DASHSCOPE_API_KEY 等密钥后重试。"
  echo ""
  read -r -p "按 Enter 退出…"
  exit 1
fi

if [[ ! -d "$VENV" ]]; then
  echo "==> 创建 Python 虚拟环境…"
  python3 -m venv "$VENV"
fi

echo "==> 安装/更新 Python 依赖…"
"$VENV/bin/pip" install -q -r "$BACKEND/requirements.txt"

if [[ ! -d "$FRONTEND/dist" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo ""
    echo "⚠️  缺少 frontend/dist，且未安装 Node.js，无法自动构建前端。"
    echo "    请安装 Node 后执行: cd frontend && npm install && npm run build"
    echo ""
    read -r -p "按 Enter 退出…"
    exit 1
  fi
  echo "==> 首次运行：构建前端…"
  (cd "$FRONTEND" && npm install && npm run build)
fi

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  echo "==> 端口 $PORT 已有服务在运行，直接打开浏览器。"
  open "$URL"
  read -r -p "按 Enter 关闭此窗口…"
  exit 0
fi

echo "==> 启动服务 $URL"
open "$URL"

cd "$BACKEND"
# shellcheck disable=SC2064
trap 'echo ""; echo "==> 已停止服务"; kill $UVICORN_PID 2>/dev/null || true' EXIT INT TERM

"$VENV/bin/uvicorn" main:app --host 127.0.0.1 --port "$PORT" &
UVICORN_PID=$!

echo "    进程 PID: $UVICORN_PID"
echo "    关闭本终端窗口或按 Ctrl+C 即停止服务。"
echo ""

wait "$UVICORN_PID"

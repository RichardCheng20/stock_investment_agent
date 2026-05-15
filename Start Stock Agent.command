#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ -x "$HERE/scripts/start.sh" ]]; then
  exec "$HERE/scripts/start.sh"
fi

ROOT="${STOCK_AGENT_ROOT:-}"
for cand in \
  "$HOME/Desktop/project/stock_investment_agent" \
  "$HOME/Documents/project/stock_investment_agent" \
  "$HOME/project/stock_investment_agent"; do
  if [[ -x "$cand/scripts/start.sh" ]]; then
    ROOT="$cand"
    break
  fi
done

if [[ -z "$ROOT" || ! -x "$ROOT/scripts/start.sh" ]]; then
  echo "找不到 scripts/start.sh"
  read -r -p "按 Enter 退出…"
  exit 1
fi

exec "$ROOT/scripts/start.sh"

#!/usr/bin/env bash
# 在「桌面」生成带绝对路径的启动器（可双击，不依赖项目旁的 scripts 目录）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="${HOME}/Desktop"
LAUNCHER="${DESKTOP}/Start Stock Agent.command"
START_SH="${ROOT}/scripts/start.sh"

if [[ ! -x "$START_SH" ]]; then
  chmod +x "$ROOT/scripts/start.sh" "$ROOT/Start Stock Agent.command" 2>/dev/null || true
fi

cat > "$LAUNCHER" <<EOF
#!/bin/bash
# 由 install-desktop-launcher.sh 生成，指向本机项目路径
exec "${START_SH}"
EOF

chmod +x "$LAUNCHER"

echo "已创建桌面启动器："
echo "  ${LAUNCHER}"
echo ""
echo "请双击桌面上的「Start Stock Agent」启动（不要移动项目文件夹）。"
echo "若移动了项目目录，请重新运行："
echo "  ${ROOT}/scripts/install-desktop-launcher.sh"

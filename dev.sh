#!/usr/bin/env bash
# 猜历史 · 开发启动（macOS / Linux，对应 Windows 的 dev.cmd）
# 真正的启动逻辑在 scripts/dev.mjs
set -euo pipefail
cd "$(dirname "$0")"
exec node scripts/dev.mjs "$@"

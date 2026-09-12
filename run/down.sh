#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# run/down.sh — run/up.sh로 띄운 모드 종료
#   bash run/down.sh dev | prod
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  dev)  FILES="-f docker-compose.yml -f docker-compose.dev.yml" ;;
  prod) FILES="-f docker-compose.yml -f docker-compose.prod.yml" ;;
  *) echo "Usage: $0 <dev|prod>" >&2; exit 1 ;;
esac

docker compose $FILES down
echo "✓ stopped"
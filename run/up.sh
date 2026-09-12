#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# run/up.sh — 하나로 통합된 서비스 기동 스크립트
#   bash run/up.sh dev   → Vite HMR 개발 서버 (:3000, no TLS)
#   bash run/up.sh prod  → 프로덕션 (Caddy HTTPS :80/:443)
#   FORCE=1             → 이미 떠 있어도 재기동(재빌드) 허용
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
case "$MODE" in
  dev)
    FILES="-f docker-compose.yml -f docker-compose.dev.yml"
    NEEDLE="calc-dev"
    # dev는 127.0.0.1 전용 — 외부 노출 0. 집에서만 ssh -L 3000:localhost:3000 tunnel로 접속.
    URL="http://localhost:3000 (로컬호스트 전용 — SSH 터널 필요)"
    ;;
  prod)
    FILES="-f docker-compose.yml -f docker-compose.prod.yml"
    NEEDLE="calc-caddy"
    URL="https://calc.rlawjddn00.online"
    ;;
  *)
    echo "Usage: $0 <dev|prod>" >&2
    exit 1
    ;;
esac

# 상호 배타 가드 — dev/prod는 같은 calc-api 이름을 공유하므로 동시 기동 불가.
# 이미 해당 모드가 떠 있으면 중단하고, FORCE=1이면 재빌드/재기동을 허용한다.
if [ "${FORCE:-}" != "1" ] && docker ps --format '{{.Names}}' | grep -qx "$NEEDLE"; then
  echo "⚠ '$MODE' 이미 실행 중 ($NEEDLE). 재기동하려면 FORCE=1, 종료하려면 'run/down.sh $MODE'." >&2
  exit 1
fi

docker compose $FILES up -d --build
echo "✓ $MODE running at $URL"
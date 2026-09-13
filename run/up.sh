#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# run/up.sh — 하나로 통합된 서비스 기동 스크립트 (+ 자동 커널 튜닝)
#   bash run/up.sh dev   → Vite HMR 개발 서버 (:3000, no TLS)
#   bash run/up.sh prod  → 프로덕션 (Caddy HTTPS :80/:443)
#   FORCE=1             → 이미 떠 있어도 재기동(재빌드) 허용
#   NET_TUNE=0          → 1Gbps 커널 TCP 튜닝 자동 적용 생략
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

# ── 1Gbps 커널 TCP 튜닝 (자동, 멱등) ──────────────────────────────
# 이미 튜닝됐으면(소켓 버퍼 ≥ 8MB) 스킵 → sudo 프롬프트가 반복 안 됨.
# 미적용이면 대화형 터미널에서 sudo로 1회 적용+영속화. 비대화형/sudo 없으면 안내만.
tune_kernel() {
  if [ "${NET_TUNE:-1}" != "1" ]; then
    echo "NET_TUNE=0 → 커널 튜닝 생략"
    return 0
  fi

  local cur
  cur="$(sysctl -n net.core.wmem_max 2>/dev/null || true)"
  if [ "${cur:-0}" -ge 8388608 ] 2>/dev/null; then
    echo "✓ 커널 TCP 튜닝 이미 적용됨 (net.core.wmem_max=${cur})"
    return 0
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "⚠ sudo가 없어 커널 튜닝을 건너뜀. (필요 시: sudo bash run/sysctl-net.sh --persist)" >&2
    return 0
  fi

  echo "── 1Gbps 커널 TCP 튜닝 적용 준비 (sudo 비밀번호가 필요할 수 있음) ──"
  if [ -t 1 ]; then
    if sudo bash run/sysctl-net.sh --persist; then
      echo "✓ 커널 TCP 튜닝 적용+영속화 완료"
    else
      echo "⚠ 커널 튜닝 실패 — 기동은 계속 (수동: sudo bash run/sysctl-net.sh --persist)" >&2
    fi
  else
    echo "⚠ 비대화형 실행이라 커널 튜닝 생략. 1회 적용 필요: sudo bash run/sysctl-net.sh --persist" >&2
  fi
}
tune_kernel

# 상호 배타 가드 — dev/prod는 같은 calc-api 이름을 공유하므로 동시 기동 불가.
# 이미 해당 모드가 떠 있으면 중단하고, FORCE=1이면 재빌드/재기동을 허용한다.
if [ "${FORCE:-}" != "1" ] && docker ps --format '{{.Names}}' | grep -qx "$NEEDLE"; then
  echo "⚠ '$MODE' 이미 실행 중 ($NEEDLE). 재기동하려면 FORCE=1, 종료하려면 'run/down.sh $MODE'." >&2
  exit 1
fi

docker compose $FILES up -d --build
echo "✓ $MODE running at $URL"
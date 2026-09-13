#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# run/sysctl-net.sh — 1Gbps 라인 최대 활용을 위한 커널 TCP 튜닝
#   · sudo bash run/sysctl-net.sh            → 즉시 적용(비영속)
#   · sudo bash run/sysctl-net.sh --persist  → 적용 + /etc/sysctl.d 영속화
#
# ⚠️ root 권한 필요. 위험 수치는 호스트 커널(컨테이너 포함) 전체에 적용되므로
#    신중히, 그리고 반드시 변경 내용을 확인한 뒤 사용하세요.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SYSCTL_CONF="/etc/sysctl.d/99-net-tuning.conf"

# ── 권장값 (1Gbps × 수십 ms RTT 기준, 여유 있게 설정) ──
# /proc/sys 에 전달할 "key=value" 목록
declare -a TUNABLES=(
  # 소켓 버퍼: BDP(대역폭×RTT)만큼 수용해 대역폭 포화 가능
  "net.core.rmem_max=33554432"          # 32MB
  "net.core.wmem_max=33554432"          # 32MB
  "net.core.netdev_max_backlog=16384"
  "net.core.somaxconn=16384"
  # TCP 수신/송신 창 최대 32MB (Caddy/http2/3 동시 연결 대비)
  "net.ipv4.tcp_rmem=4096 1048576 33554432"
  "net.ipv4.tcp_wmem=4096 1048576 33554432"
  # TCP 창 확장 확인
  "net.ipv4.tcp_window_scaling=1"
  # TCP Fast Open: 3 = 리스너+클라이언트 모두 (연결 설정 RTT 절약)
  "net.ipv4.tcp_fastopen=3"
  # MTU 블랙홀 회피 (검출 시 자동 Path-MTU 재탐색)
  "net.ipv4.tcp_mtu_probing=1"
  # slow start 시간 초과를 집계 단위로 — 대용량 전송 초반 가속
  "net.ipv4.tcp_slow_start_timeouts=8"
  # keepalive 세부
  "net.ipv4.tcp_keepalive_time=60"
  "net.ipv4.tcp_keepalive_intvl=10"
  "net.ipv4.tcp_keepalive_probes=5"
)

apply_once() { # "$key" "$value"
  local key="$1" val="$2"
  if sysctl -q -w "$key=$val" 2>/dev/null; then
    echo "  [적용] $key = $val"
  else
    echo "  [건너뜀] $key = $val  (해당 커널 미지원/권한부족)" >&2
  fi
}

echo "=== 커널 네트워크 튜닝 시작 (1Gbps) ==="
if [[ "$(id -u)" -ne 0 ]]; then
  echo "❌ root 권한이 필요합니다:  sudo bash $0" >&2
  exit 1
fi

for entry in "${TUNABLES[@]}"; do
  key="${entry%%=*}"
  val="${entry#*=}"
  apply_once "$key" "$val"
done

# ── 영속화 옵션 ──
if [[ "${1:-}" == "--persist" ]]; then
  umask 022
  : > "$SYSCTL_CONF"
  for entry in "${TUNABLES[@]}"; do
    echo "$entry" >> "$SYSCTL_CONF"
  done
  echo "✅ 영속화됨 → $SYSCTL_CONF (재부팅 후에도 유지)"
  echo "   (취소: sudo rm $SYSCTL_CONF && sudo sysctl --system)"
fi

echo "=== 완료 ==="
echo "힌트: 혼잡제어는 기본 cubic을 유지했고, 지원하면 bbr로도 시도 가능:"
echo "   modprobe tcp_bbr; sysctl -w net.ipv4.tcp_congestion_control=bbr"
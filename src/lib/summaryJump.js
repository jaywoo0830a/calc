// ═══════════════════════════════════════════════════════════════
// summaryJump — Summaries 탭에서 Viewer로 요약 점프 핸드오프
// Summaries 페이지가 썸네일을 클릭하면 저장 → /viewer로 이동 →
// Viewer가 ZIP 로드 완료 후 takePendingSummary()로 꺼내 점프한다.
// ═══════════════════════════════════════════════════════════════

let pending = null;

export function setPendingSummary(summary) {
  pending = summary;
}

export function takePendingSummary() {
  const s = pending;
  pending = null;
  return s;
}

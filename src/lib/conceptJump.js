// ═══════════════════════════════════════════════════════════════
// conceptJump — Concepts 탭에서 Viewer로 개념 점프 핸드오프
// Concepts 페이지가 노드를 클릭하면 저장 → /viewer로 이동 →
// Viewer가 ZIP 로드 완료 후 takePendingConcept()으로 꺼내 점프한다.
// ═══════════════════════════════════════════════════════════════

let pending = null;

export function setPendingConcept(concept) {
  pending = concept;
}

export function takePendingConcept() {
  const c = pending;
  pending = null;
  return c;
}

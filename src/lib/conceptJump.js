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

// ── Viewer ↔ Concepts 전체화면 양방향 텔레포트 ──
// Viewer(전체화면)의 🧭 Concepts 버튼 → 저장 → /concepts 이동 →
// Concepts가 마운트 후 take로 꺼내 해당 문서를 전체화면 트리로 연다.
let pendingConceptsFullscreen = null;

export function setPendingConceptsFullscreen(filePath) {
  pendingConceptsFullscreen = filePath;
}

export function takePendingConceptsFullscreen() {
  const fp = pendingConceptsFullscreen;
  pendingConceptsFullscreen = null;
  return fp;
}

// ═══════════════════════════════════════════════════════════════
// problemJump — Problems 탭에서 Viewer로 문제 점프 핸드오프
// Problems 페이지가 문제를 클릭하면 저장 → /viewer로 이동 →
// Viewer가 ZIP 로드 완료 후 takePendingProblem()으로 꺼내 점프한다.
// ═══════════════════════════════════════════════════════════════

let pending = null;

export function setPendingProblem(problem) {
  pending = problem;
}

export function takePendingProblem() {
  const p = pending;
  pending = null;
  return p;
}

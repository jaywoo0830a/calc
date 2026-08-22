// ============================================================
// canvasMath — 세계 좌표(y↑) ⇄ 화면 좌표(y↓) 변환
// ⚠️ 세계 좌표는 수학 방향(y 위), 캔버스 화면은 y 아래.
// 화살표/오프셋에 세계 각도를 쓰면 수직 방향이 반전되므로
// 반드시 이 헬퍼를 거쳐야 함 (2026-08-22 버그 교훈).
// ============================================================

/** 세계 좌표 각도(라디안)를 화면 좌표 각도로 변환 */
export function screenAngle(worldAngle) {
  return -worldAngle;
}

/** 세계 각도로 dist만큼 이동했을 때의 화면 오프셋 {dx, dy} */
export function screenOffset(worldAngle, dist) {
  return {
    dx: Math.cos(worldAngle) * dist,
    dy: -Math.sin(worldAngle) * dist,
  };
}

/** 세계 방향 벡터(wx, wy)를 화면 방향 벡터로 변환 */
export function screenVector(wx, wy) {
  return { x: wx, y: -wy };
}

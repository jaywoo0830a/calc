// ============================================================
// zoomView — 전체화면 이미지 뷰어(라이트박스)의 줌/팬 계산
// 화면 좌표계: viewport 좌상단 기준, 뷰 중심 = (w/2, h/2)
// 이미지는 중심 기준 transform: translate(x,y) scale(s)
// ============================================================

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

export function clampScale(s) {
  if (!Number.isFinite(s)) return ZOOM_MIN;
  return Math.min(Math.max(s, ZOOM_MIN), ZOOM_MAX);
}

// 확대/축소 시 커서(앵커) 아래의 이미지 점이 그대로 유지되도록 팬을 보정
export function zoomAt(state, factor, anchor, view, img) {
  const scale = clampScale(state.scale * factor);
  const cx = view.w / 2;
  const cy = view.h / 2;
  const relX = (anchor.x - cx - state.x) / state.scale;
  const relY = (anchor.y - cy - state.y) / state.scale;
  const x = anchor.x - cx - relX * scale;
  const y = anchor.y - cy - relY * scale;
  return { scale, ...clampPan(x, y, scale, view, img) };
}

// 화면 가장자리보다 이미지가 안쪽으로 들어가도록(빈틈 없이) 팬을 클램프
export function clampPan(x, y, scale, view, img) {
  const dispW = img.w * scale;
  const dispH = img.h * scale;
  const mx = Math.max(0, (dispW - view.w) / 2);
  const my = Math.max(0, (dispH - view.h) / 2);
  const nx = Math.min(Math.max(x, -mx), mx);
  const ny = Math.min(Math.max(y, -my), my);
  return { x: nx || 0, y: ny || 0 }; // -0 → 0 정규화
}

// 클릭 토글: fit(1)이면 2배, 확대 중이면 fit
export function toggleZoom(scale) {
  return scale > ZOOM_MIN + 1e-6 ? ZOOM_MIN : 2;
}

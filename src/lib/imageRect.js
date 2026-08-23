// ============================================================
// imageRect — 이미지 주석이 PDF 페이지(정규화 좌표) 안에 들어오도록
// rect: { x, y, w, h } (0~1 정규화), aspect: 이미지 가로/세로 비
// pageAspect: 페이지 세로/가로 비 (height / width)
// ============================================================

const MIN_W = 0.12;

export function fitImageRect(rect, aspect, pageAspect) {
  const src = rect || {};
  const a = Math.max(aspect || 1, 0.01);            // 이미지 가로/세로
  const pa = Math.max(pageAspect || 1, 0.01);       // 페이지 세로/가로

  // 높이(페이지 비율)가 1을 넘지 않도록 폭 상한 결정
  const maxW = Math.min(1, a * pa);
  const w = Math.min(Math.max(src.w || MIN_W, MIN_W), maxW);
  const h = w / (a * pa);                           // w/(aspect) 를 페이지 비율로 환산

  const x = Math.min(Math.max(src.x || 0, 0), 1 - w);
  const y = Math.min(Math.max(src.y || 0, 0), 1 - h);
  return { x, y, w, h };
}

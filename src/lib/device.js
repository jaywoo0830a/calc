// ═══════════════════════════════════════════════════════════════
// device — 터치 우선(primary pointer: coarse) 기기 감지
// ─────────────────────────────────────────────────────────────
// 터치 기기 : RangeSelect(✂️ 모드 + 두 번 탭) 사용
// 데스크톱  : 클릭·드래그 기반(선택 툴바) 사용
// ═══════════════════════════════════════════════════════════════

export const IS_TOUCH_PRIMARY = typeof window !== 'undefined' && (() => {
  try {
    if (window.matchMedia) return window.matchMedia('(pointer: coarse)').matches;
  } catch { /* ignore */ }
  return false;
})();

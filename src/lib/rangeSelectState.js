// ═══════════════════════════════════════════════════════════════
// rangeSelectState — RangeSelect(✂️ 모드 + 두 번 탭)의 armed 상태를
// CustomCursor 등 다른 전역 컴포넌트와 공유하는 초경량 스토어
// ═══════════════════════════════════════════════════════════════

const listeners = new Set();
let state = { armed: false, step: 0, mode: null };

export function setRangeSelectState(next) {
  state = { ...state, ...next };
  for (const fn of listeners) fn(state);
}

export function getRangeSelectState() {
  return state;
}

export function subscribeRangeSelect(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

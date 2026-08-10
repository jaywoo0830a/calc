// ═══════════════════════════════════════════════════════════════
// rangeSelectState — RangeSelect(✂️ Selecting)의 상태를
// CustomCursor 등 다른 전역 컴포넌트와 공유하는 초경량 스토어
// state: { active: boolean, step: 0|1 }  (0=시작점 대기, 1=끝점 대기)
// ═══════════════════════════════════════════════════════════════

const listeners = new Set();
let state = { active: false, step: 0 };

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

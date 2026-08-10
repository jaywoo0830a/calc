// ═══════════════════════════════════════════════════════════════
// recentHistory — Viewer의 최근 문서 히스토리를 전역 🕘 버튼과 공유
// state: { items: [{ path, name }], active: boolean }
//   active = Viewer가 내비게이션 핸들러를 등록했는지 (🕘 버튼 표시 여부)
// ═══════════════════════════════════════════════════════════════

const listeners = new Set();
let items = [];             // [{ path, name }] 최신순, 최대 8
let navigateHandler = null; // Viewer가 등록 (path → openRecent)

function emit() {
  const state = { items, active: !!navigateHandler };
  for (const fn of listeners) fn(state);
}

export function subscribeRecent(fn) {
  listeners.add(fn);
  fn({ items, active: !!navigateHandler });
  return () => listeners.delete(fn);
}

export function getRecentState() {
  return { items, active: !!navigateHandler };
}

export function pushRecent(path) {
  if (!path) return;
  const name = path.split('/').pop();
  items = [{ path, name }, ...items.filter((r) => r.path !== path)].slice(0, 8);
  emit();
}

export function clearRecent() {
  if (items.length === 0) return;
  items = [];
  emit();
}

export function registerRecentNavigate(fn) {
  navigateHandler = fn;
  emit();
}

export function navigateRecent(path) {
  if (navigateHandler) navigateHandler(path);
}

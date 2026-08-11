// ═══════════════════════════════════════════════════════════════
// recentHistory — Viewer의 최근 문서 히스토리를 전역 🕘 버튼과 공유
// state: { items: [{ zipId, zipName, path, name }], active: boolean }
//   zipId = 소속 ZIP (IndexedDB 키) — ZIP을 여러 개 열어도 서로 전환 가능
//   active = Viewer가 내비게이션 핸들러를 등록했는지 (🕘 버튼 표시 여부)
// ═══════════════════════════════════════════════════════════════

const listeners = new Set();
let items = [];             // [{ zipId, zipName, path, name }] 최신순, 최대 12
let navigateHandler = null; // Viewer가 등록 (item → openRecent)

function keyOf(r) { return (r.zipId || '') + '|' + (r.path || ''); }

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

export function pushRecent(entry) {
  if (!entry || !entry.path) return;
  const item = {
    zipId: entry.zipId || '',
    zipName: entry.zipName || '',
    path: entry.path,
    name: entry.name || entry.path.split('/').pop(),
  };
  items = [item, ...items.filter((r) => keyOf(r) !== keyOf(item))].slice(0, 12);
  emit();
}

export function clearRecent() {
  if (items.length === 0) return;
  items = [];
  emit();
}

export function removeRecent(entry) {
  const k = keyOf(entry);
  const next = items.filter((r) => keyOf(r) !== k);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function registerRecentNavigate(fn) {
  navigateHandler = fn;
  emit();
}

export function navigateRecent(item) {
  if (navigateHandler) navigateHandler(item);
}

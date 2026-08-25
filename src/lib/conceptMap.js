// ============================================================
// conceptMap — 개념 노드 계층 코어
// ------------------------------------------------------------
// 개념 노드 계층 시스템 명세의 순수 로직 구현.
//
// · 저장 모델: parent 링크 단일 진실원 (children은 파생)
//   → §3.1의 부모-자식 양방향 일관성 불일치가 구조적으로 불가능
//   (마크다운 export 시 children 배열을 materialize 하면 됨)
// · 노드: { id, label, summary, status, parent, order,
//           pageNumber, createdAt, updatedAt }
// · status: ●(이해) ◐(애매) ○(모름) △(보류) — 명세 §2
// · 모든 연산은 순수 함수 — 입력 map을 변경하지 않고 새 map 반환
// · 잘못된 연산은 Error throw (UI에서 토스트로 표시)
// ============================================================

export const STATUS = {
  KNOWN: '●',   // 이해
  FUZZY: '◐',   // 애매
  UNKNOWN: '○', // 모름
  HOLD: '△',    // 보류
};

// §7.3 복습 우선순위 — ○ 최우선, △ 보류(사용자 확인 필요)
export const REVIEW_PRIORITY = [STATUS.UNKNOWN, STATUS.FUZZY, STATUS.KNOWN, STATUS.HOLD];
export const VALID_STATUSES = REVIEW_PRIORITY;

const byOrder = (a, b) =>
  (a.order - b.order)
  || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  || (a.id < b.id ? -1 : 1);

/** 특정 부모(또는 null=최상위) 바로 아래 노드들의 최대 order */
function maxOrderOf(map, parent) {
  return childrenOf(map, parent).reduce((m, n) => Math.max(m, n.order), -1);
}

/** candidateId의 조상 체인에 ancestorId가 있는지 (사이클 판정용) */
function isDescendantOf(map, candidateId, ancestorId) {
  let cur = map[candidateId]?.parent ?? null;
  while (cur != null) {
    if (cur === ancestorId) return true;
    if (!map[cur]) return false; // 사라진 부모 — 위로 더 못 올라감
    cur = map[cur].parent;
  }
  return false;
}

// ── §4.1 추가 ────────────────────────────────────────────────
// 새 노드를 생성한다. parent(없으면 null=최상위)에 연결하고,
// order를 명시하지 않으면 형제 끝(max+1)에 배치한다.
// status 기본값은 ○(모름) — 명세 §4.1.
export function addNode(map, input = {}) {
  const {
    id, label, summary = '', status = STATUS.UNKNOWN,
    parent = null, pageNumber = 1, order, now,
  } = input;
  const ts = now ?? new Date().toISOString();

  if (typeof id !== 'string' || !id.trim()) throw new Error('addNode: id is required');
  if (map[id]) throw new Error(`addNode: id already exists: ${id}`);
  if (typeof label !== 'string' || !label.trim()) throw new Error('addNode: label must be non-empty');
  if (!VALID_STATUSES.includes(status)) throw new Error(`addNode: invalid status: ${status}`);

  const p = parent == null ? null : parent;
  if (p !== null && !map[p]) throw new Error(`addNode: parent not found: ${p}`);

  const finalOrder = order != null && Number.isFinite(order) ? order : maxOrderOf(map, p) + 1;
  const node = {
    id: id.trim(),
    label: label.trim(),
    summary,
    status,
    parent: p,
    order: finalOrder,
    pageNumber,
    createdAt: ts,
    updatedAt: ts,
  };
  return { ...map, [node.id]: node };
}

// ── §4.2 수정 ────────────────────────────────────────────────
// summary/label/status/pageNumber 를 갱신한다. updatedAt은 항상 갱신,
// createdAt·parent·order는 불변. id 변경은 명세 원칙상 금지.
export function updateNode(map, id, patch = {}, now = new Date().toISOString()) {
  const node = map[id];
  if (!node) throw new Error(`updateNode: node not found: ${id}`);
  if ('id' in patch) throw new Error('updateNode: id is immutable (§4.2)');
  if (patch.label != null && !String(patch.label).trim()) throw new Error('updateNode: label must be non-empty');
  if (patch.status != null && !VALID_STATUSES.includes(patch.status)) {
    throw new Error(`updateNode: invalid status: ${patch.status}`);
  }
  const ts = patch.now !== undefined ? patch.now : now;
  const next = { ...node };
  for (const key of ['label', 'summary', 'status', 'pageNumber']) {
    if (key in patch) next[key] = patch[key];
  }
  next.updatedAt = ts;
  return { ...map, [id]: next };
}

// ── §4.4 이동 (부모 변경) ─────────────────────────────────────
// 새 부모의 끝(order max+1)으로 이동한다. 자기 자신/자손을 부모로
// 하는 사이클은 금지. 같은 부모로의 이동은 no-op(updatedAt 보존).
export function reparentNode(map, id, newParent, now = new Date().toISOString()) {
  const node = map[id];
  if (!node) throw new Error(`reparentNode: node not found: ${id}`);
  const p = newParent == null ? null : newParent;
  if (p !== null && !map[p]) throw new Error(`reparentNode: parent not found: ${p}`);
  if (p === id) throw new Error('reparentNode: a node cannot be its own parent (cycle)');
  if (p !== null && isDescendantOf(map, p, id)) {
    throw new Error(`reparentNode: cycle — ${p} is a descendant of ${id}`);
  }
  if (node.parent === p) return map; // no-op
  const next = { ...node, parent: p, order: maxOrderOf(map, p) + 1, updatedAt: now };
  return { ...map, [id]: next };
}

/** order 값을 직접 설정 (드래그/수동 배치용) */
export function setOrder(map, id, order) {
  const node = map[id];
  if (!node) throw new Error(`setOrder: node not found: ${id}`);
  if (!Number.isFinite(order)) throw new Error(`setOrder: order must be a number: ${order}`);
  return { ...map, [id]: { ...node, order } };
}

/**
 * 형제 사이를 ▲▼(delta)로 이동 — 클램프 + order 재정규화.
 * order가 겹쳐 있어도 결정적으로 동작한다.
 */
export function moveNode(map, id, delta) {
  const node = map[id];
  if (!node) throw new Error(`moveNode: node not found: ${id}`);
  const siblings = Object.values(map)
    .filter((n) => n.id !== id && n.parent === node.parent)
    .sort(byOrder);
  if (siblings.length === 0) return map;

  const all = [...siblings, node].sort(byOrder);
  const idx = all.findIndex((n) => n.id === id);
  const target = Math.max(0, Math.min(all.length - 1, idx + delta));
  if (target !== idx) {
    const without = all.filter((n) => n.id !== id);
    without.splice(target, 0, node);
    all.length = 0;
    all.push(...without);
  }
  // order를 0..n-1로 재정규화 (변경된 노드만 교체)
  let next = map;
  all.forEach((n, i) => {
    if (next[n.id].order !== i) next = { ...next, [n.id]: { ...next[n.id], order: i } };
  });
  return next;
}

// ── §4.3 삭제 ────────────────────────────────────────────────
// 노드를 제거하고, 자식들은 조부모(노드의 부모)로 승격시킨다.
// 승격된 자식의 순서는 유지되고 updatedAt은 갱신(부모 이동).
export function deleteNode(map, id, now = new Date().toISOString()) {
  const node = map[id];
  if (!node) throw new Error(`deleteNode: node not found: ${id}`);
  const newParent = node.parent ?? null;
  const base = maxOrderOf(map, newParent) + 1;
  let next = map;
  childrenOf(map, id).forEach((child, i) => {
    next = { ...next, [child.id]: { ...child, parent: newParent, order: base + i, updatedAt: now } };
  });
  const { [id]: _removed, ...rest } = next;
  return rest;
}

// ── §4.5 병합 ────────────────────────────────────────────────
// drop 노드를 keep으로 병합 — drop의 자식을 keep의 자식 끝에 이전,
// drop 제거, keep.updatedAt 갱신. keep이 drop의 자손이면
// keep은 drop의 부모 위치로 먼저 승격된다(사이클 방지).
export function mergeNodes(map, keepId, dropId, now = new Date().toISOString()) {
  if (keepId === dropId) throw new Error('mergeNodes: keep and drop must differ');
  const keep = map[keepId];
  const drop = map[dropId];
  if (!keep) throw new Error(`mergeNodes: keep not found: ${keepId}`);
  if (!drop) throw new Error(`mergeNodes: drop not found: ${dropId}`);

  let keepNext = { ...keep, updatedAt: now };
  if (isDescendantOf(map, keepId, dropId)) {
    const p = drop.parent ?? null;
    keepNext = { ...keepNext, parent: p, order: maxOrderOf(map, p) + 1 };
  }
  let next = map;
  const base = maxOrderOf(map, keepId) + 1;
  childrenOf(map, dropId).forEach((child, i) => {
    if (child.id === keepId) return;
    next = { ...next, [child.id]: { ...child, parent: keepId, order: base + i, updatedAt: now } };
  });
  const { [dropId]: _removed, ...rest } = next;
  rest[keepId] = keepNext;
  return rest;
}

// ── 파생 조회 ────────────────────────────────────────────────
/** 특정 노드의 자식 목록 (order 순, 항상 파생) */
export function childrenOf(map, id) {
  return Object.values(map).filter((n) => n.parent === id).sort(byOrder);
}

/** 최상위 노드 목록 (parent === null, order 순) */
export function rootsOf(map) {
  return Object.values(map).filter((n) => n.parent === null).sort(byOrder);
}

/**
 * 전체 트리 재구성 — 부모가 사라진 노드는 루트로 끌어올리고(유실 방지),
 * 사이클 노드도 루트로 살려둔다. §6의 _index.md 트리와 동일한 형태.
 */
export function buildTree(map) {
  const all = Object.values(map);
  const visited = new Set();
  const make = (node) => {
    if (visited.has(node.id)) return null;
    visited.add(node.id);
    return {
      ...node,
      children: childrenOf(map, node.id).map(make).filter(Boolean),
    };
  };
  const roots = all
    .filter((n) => n.parent === null || !map[n.parent])
    .sort(byOrder)
    .map(make)
    .filter(Boolean);
  for (const n of all) {
    if (!visited.has(n.id)) roots.push({ ...n, children: [] });
  }
  return roots;
}

// ── §7.3 복습 큐 ─────────────────────────────────────────────
// 상태 우선순위(○ > ◐ > ● > △)로 정렬, 같은 상태끼리는 원래 순서 유지.
export function reviewQueue(map) {
  const prio = new Map(REVIEW_PRIORITY.map((s, i) => [s, i]));
  return Object.values(map)
    .filter((n) => prio.has(n.status))
    .sort((a, b) => prio.get(a.status) - prio.get(b.status)); // stable sort
}

// ── §7.4 구조 검증 ───────────────────────────────────────────
// parent-children 불일치(사라진 부모)·사이클·잘못된 status를 보고한다.
export function validate(map) {
  const issues = [];
  for (const node of Object.values(map)) {
    if (!VALID_STATUSES.includes(node.status)) {
      issues.push({ code: 'invalid-status', id: node.id, status: node.status });
    }
    if (node.parent !== null && !map[node.parent]) {
      issues.push({ code: 'missing-parent', id: node.id, parent: node.parent });
    }
    const seen = new Set([node.id]);
    let cur = map[node.parent]?.id ?? null;
    while (cur != null) {
      if (seen.has(cur)) { issues.push({ code: 'cycle', id: node.id, via: cur }); break; }
      seen.add(cur);
      cur = map[cur]?.parent ?? null;
    }
  }
  return issues;
}

/** 사용 가능한 가장 작은 번호의 새 id 제안 (기본 "CN-1", "CN-2", …) */
export function suggestId(map, prefix = 'CN') {
  let n = 1;
  while (map[`${prefix}-${n}`]) n++;
  return `${prefix}-${n}`;
}

// ═══════════════════════════════════════════════════════════════
// 서버 레코드 ↔ 코어 노드 변환 + UI 공용 헬퍼
// (앱 전역에서 재사용 — PdfAnnotator/Concepts/ConceptInput)
// ═══════════════════════════════════════════════════════════════

/** 서버 레코드(flat 목록) → 코어 노드 map */
export function conceptsToMap(list) {
  const map = {};
  for (const c of list || []) {
    map[c.id] = {
      id: c.id,
      label: c.label || '',
      summary: c.summary || '',
      status: c.status || STATUS.UNKNOWN,
      parent: c.parentId || null,
      order: Number(c.order) || 0,
      pageNumber: Number(c.pageNumber) || 1,
      createdAt: c.createdAt || '',
      updatedAt: c.updatedAt || '',
    };
  }
  return map;
}

/** 파일별 고유 id 접두사 — 서로 다른 PDF에서 CN-n이 겹치지 않게 */
export function conceptIdBase(filePath) {
  let h = 2166136261;
  const s = String(filePath || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6) + '-CN';
}

/** 🧭 부모 선택용 — 계층 들여쓰기된 옵션 목록 (top level 제외) */
export function conceptOptionList(list) {
  const out = [];
  const walk = (n, d) => {
    out.push({ id: n.id, label: '— '.repeat(d) + n.label });
    (n.children || []).forEach((c) => walk(c, d + 1));
  };
  buildTree(conceptsToMap(list)).forEach((r) => walk(r, 0));
  return out;
}

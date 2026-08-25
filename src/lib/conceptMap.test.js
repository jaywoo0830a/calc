// ============================================================
// conceptMap 테스트 — 개념 노드 계층 코어 (TDD)
// 실행: npm test
//
// 명세 근거 (개념 노드 계층 시스템 명세):
//   §3.1  부모-자식 양방향 일관성
//   §4.1  추가   — parent 연결 + 초기 status ○/◐
//   §4.2  수정   — id 불변, updated 갱신
//   §4.3  삭제   — 자식을 다른 부모로 이동
//   §4.4  이동   — 부모 변경 (사이클 금지)
//   §4.5  병합   — 자식/연결 이전
//   §7.3  상태 우선순위 — ○ > ◐ > ● > △
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, VALID_STATUSES, REVIEW_PRIORITY,
  addNode, updateNode, reparentNode, moveNode, setOrder,
  deleteNode, mergeNodes, childrenOf, rootsOf, buildTree,
  reviewQueue, validate, suggestId,
} from './conceptMap.js';

const NOW = '2026-08-25T00:00:00.000Z';

// ── 기본 노드 생성 헬퍼 ──────────────────────────────────────
function seed() {
  let map = {};
  map = addNode(map, { id: 'TD-00', label: '열역학', status: STATUS.KNOWN, pageNumber: 1, now: NOW });
  map = addNode(map, { id: 'TD-01', label: '제1법칙', status: STATUS.KNOWN, parent: 'TD-00', pageNumber: 2, now: NOW });
  map = addNode(map, { id: 'TD-02', label: '내부에너지', status: STATUS.UNKNOWN, parent: 'TD-01', pageNumber: 3, now: NOW });
  map = addNode(map, { id: 'TD-03', label: '일과 열', status: STATUS.FUZZY, parent: 'TD-01', pageNumber: 4, now: NOW });
  map = addNode(map, { id: 'TD-05', label: '제2법칙', status: STATUS.HOLD, parent: 'TD-00', pageNumber: 5, now: NOW });
  return map;
}

// ── §4.1 추가 ────────────────────────────────────────────────
test('addNode: 기본값 — status ○, summary "", 생성 시각 기록', () => {
  const map = addNode({}, { id: 'TD-07', label: '엔트로피', pageNumber: 3, now: NOW });
  const n = map['TD-07'];
  assert.equal(n.label, '엔트로피');
  assert.equal(n.summary, '');
  assert.equal(n.status, STATUS.UNKNOWN);
  assert.equal(n.parent, null);
  assert.equal(n.order, 0);
  assert.equal(n.pageNumber, 3);
  assert.equal(n.createdAt, NOW);
  assert.equal(n.updatedAt, NOW);
});

test('addNode: 라벨이 없으면 실패', () => {
  assert.throws(() => addNode({}, { id: 'X', label: '  ', now: NOW }), /label/);
});

test('addNode: 중복 id는 실패', () => {
  const map = seed();
  assert.throws(() => addNode(map, { id: 'TD-01', label: '중복', now: NOW }), /already exists/);
});

test('addNode: 존재하지 않는 parent는 실패', () => {
  assert.throws(() => addNode({}, { id: 'X-1', label: '고아', parent: 'NOPE', now: NOW }), /parent/);
});

test('addNode: parent 없이(=null) 생성하면 최상위 노드', () => {
  const map = addNode({}, { id: 'R-1', label: '루트', now: NOW });
  assert.equal(map['R-1'].parent, null);
});

test('addNode: 형제 order는 자동으로 끝에 추가 (0,1,2 순)', () => {
  let map = seed();
  map = addNode(map, { id: 'TD-06', label: '새 형제', parent: 'TD-00', now: NOW });
  const orders = childrenOf(map, 'TD-00').map((n) => [n.id, n.order]);
  assert.deepEqual(orders, [['TD-01', 0], ['TD-05', 1], ['TD-06', 2]]);
});

test('addNode: order를 명시하면 그대로 사용', () => {
  const map = addNode(seed(), { id: 'TD-06', label: '첫 번째', parent: 'TD-00', order: -1, now: NOW });
  assert.equal(map['TD-06'].order, -1);
});

test('addNode: 잘못된 status는 실패', () => {
  assert.throws(() => addNode({}, { id: 'X', label: '상태', status: '★', now: NOW }), /status/);
});

// ── §4.2 수정 ────────────────────────────────────────────────
test('updateNode: summary/label/status/pageNumber 갱신 + updatedAt 갱신', () => {
  let map = seed();
  map = updateNode(map, 'TD-02', { summary: '무질서도가 증가한다', status: STATUS.FUZZY, pageNumber: 9, now: '2026-08-25T01:00:00.000Z' });
  const n = map['TD-02'];
  assert.equal(n.summary, '무질서도가 증가한다');
  assert.equal(n.status, STATUS.FUZZY);
  assert.equal(n.pageNumber, 9);
  assert.equal(n.updatedAt, '2026-08-25T01:00:00.000Z');
  assert.equal(n.createdAt, NOW); // 생성 시각 불변
  assert.equal(n.parent, 'TD-01'); // 부모 불변
});

test('updateNode: id는 변경할 수 없다 (§4.2 원칙)', () => {
  assert.throws(() => updateNode(seed(), 'TD-02', { id: 'TD-99', now: NOW }), /id/);
});

test('updateNode: 잘못된 status는 실패', () => {
  assert.throws(() => updateNode(seed(), 'TD-02', { status: '?', now: NOW }), /status/);
});

test('updateNode: 없는 노드는 실패', () => {
  assert.throws(() => updateNode(seed(), 'NOPE', { label: 'x', now: NOW }), /not found/);
});

// ── §4.4 이동 (부모 변경) ─────────────────────────────────────
test('reparentNode: 새 부모의 끝(order 최대+1)으로 이동 + updatedAt 갱신', () => {
  let map = seed();
  map = reparentNode(map, 'TD-05', 'TD-01', '2026-08-25T02:00:00.000Z');
  const n = map['TD-05'];
  assert.equal(n.parent, 'TD-01');
  assert.equal(n.order, 2); // TD-01의 기존 자식 2명(order 0,1) 뒤
  assert.equal(n.updatedAt, '2026-08-25T02:00:00.000Z');
  assert.deepEqual(childrenOf(map, 'TD-01').map((c) => c.id), ['TD-02', 'TD-03', 'TD-05']);
});

test('reparentNode: null로 이동하면 최상위 노드', () => {
  let map = seed();
  map = reparentNode(map, 'TD-02', null, NOW);
  assert.equal(map['TD-02'].parent, null);
  assert.ok(rootsOf(map).some((n) => n.id === 'TD-02'));
});

test('reparentNode: 자기 자신을 부모로는 불가', () => {
  assert.throws(() => reparentNode(seed(), 'TD-02', 'TD-02', NOW), /itself|cycle/);
});

test('reparentNode: 자손을 부모로는 불가 (사이클 방지)', () => {
  // TD-00 → TD-01 → TD-02. TD-01을 TD-02 아래로 이동하면 사이클.
  assert.throws(() => reparentNode(seed(), 'TD-01', 'TD-02', NOW), /cycle/);
});

test('reparentNode: 같은 부모로의 이동은 무해한 no-op', () => {
  const before = seed();
  const after = reparentNode(before, 'TD-03', 'TD-01', NOW);
  assert.equal(after['TD-03'].parent, 'TD-01');
  assert.equal(after['TD-03'].updatedAt, NOW); // updatedAt 변경 없음
  assert.deepEqual(childrenOf(after, 'TD-01').map((c) => c.id), ['TD-02', 'TD-03']);
});

test('reparentNode: 없는 부모/노드는 실패', () => {
  assert.throws(() => reparentNode(seed(), 'NOPE', null, NOW), /not found/);
  assert.throws(() => reparentNode(seed(), 'TD-02', 'NOPE', NOW), /parent/);
});

// ── 형제 재배치 (▲▼) ────────────────────────────────────────
test('moveNode: ▲/▼로 형제 사이를 이동', () => {
  let map = seed(); // TD-01 자식: TD-02(0), TD-03(1)
  map = moveNode(map, 'TD-02', +1);
  assert.deepEqual(childrenOf(map, 'TD-01').map((c) => c.id), ['TD-03', 'TD-02']);
  map = moveNode(map, 'TD-02', -1);
  assert.deepEqual(childrenOf(map, 'TD-01').map((c) => c.id), ['TD-02', 'TD-03']);
});

test('moveNode: 끝에서는 클램프 (벗어나도 무해)', () => {
  let map = seed();
  map = moveNode(map, 'TD-02', -5); // 이미 첫째
  assert.deepEqual(childrenOf(map, 'TD-01').map((c) => c.id), ['TD-02', 'TD-03']);
  map = moveNode(map, 'TD-02', +5); // 끝으로
  assert.deepEqual(childrenOf(map, 'TD-01').map((c) => c.id), ['TD-03', 'TD-02']);
});

test('moveNode: order가 겹쳐 있어도 정상 재배치 (재정규화)', () => {
  let map = seed();
  map = setOrder(map, 'TD-03', 0); // TD-02와 동률
  map = moveNode(map, 'TD-02', -1); // 첫째로
  const orders = childrenOf(map, 'TD-01').map((n) => [n.id, n.order]);
  assert.deepEqual(orders, [['TD-02', 0], ['TD-03', 1]]);
});

// ── §4.3 삭제 — 자식은 조부모로 승격 ──────────────────────────
test('deleteNode: 자식을 조부모(새 부모 끝)로 승격시키고 노드 제거', () => {
  let map = seed();
  map = deleteNode(map, 'TD-01', NOW);
  assert.equal(map['TD-01'], undefined);
  assert.equal(map['TD-02'].parent, 'TD-00');
  assert.equal(map['TD-03'].parent, 'TD-00');
  // 기존 TD-00 자식 order 0,1(TD-05) 뒤에 순서 유지하며 붙음
  assert.deepEqual(childrenOf(map, 'TD-00').map((c) => c.id), ['TD-05', 'TD-02', 'TD-03']);
  assert.equal(map['TD-02'].order, 2);
  assert.equal(map['TD-03'].order, 3);
  assert.equal(map['TD-02'].updatedAt, NOW); // 이동 시 updated 갱신
});

test('deleteNode: 최상위 노드를 지우면 자식들이 최상위로', () => {
  let map = seed();
  map = deleteNode(map, 'TD-00', NOW);
  assert.equal(map['TD-00'], undefined);
  assert.equal(map['TD-01'].parent, null);
  assert.equal(map['TD-05'].parent, null);
  assert.ok(rootsOf(map).length >= 2);
});

test('deleteNode: 없는 노드는 실패', () => {
  assert.throws(() => deleteNode(seed(), 'NOPE', NOW), /not found/);
});

// ── §4.5 병합 ────────────────────────────────────────────────
test('mergeNodes: drop의 자식을 keep으로 이전하고 drop 제거 + updatedAt 갱신', () => {
  let map = seed();
  map = mergeNodes(map, 'TD-02', 'TD-01', '2026-08-25T03:00:00.000Z');
  assert.equal(map['TD-01'], undefined);
  assert.equal(map['TD-03'].parent, 'TD-02'); // drop의 자식 → keep
  assert.equal(map['TD-02'].updatedAt, '2026-08-25T03:00:00.000Z');
  assert.deepEqual(childrenOf(map, 'TD-02').map((c) => c.id), ['TD-03']);
});

test('mergeNodes: 부모를 자식으로 병합하면 keep의 parent는 drop의 parent 승계', () => {
  let map = seed();
  // TD-01(부모)을 TD-02(자식)로 병합 → TD-02가 TD-00의 자식으로 승격
  map = mergeNodes(map, 'TD-02', 'TD-01', NOW);
  assert.equal(map['TD-01'], undefined);
  assert.equal(map['TD-02'].parent, 'TD-00');
  assert.equal(map['TD-03'].parent, 'TD-02');
});

test('mergeNodes: 같은 노드끼리/없는 노드는 실패', () => {
  assert.throws(() => mergeNodes(seed(), 'TD-01', 'TD-01', NOW), /differ|same/);
  assert.throws(() => mergeNodes(seed(), 'NOPE', 'TD-01', NOW), /not found/);
  assert.throws(() => mergeNodes(seed(), 'TD-01', 'NOPE', NOW), /not found/);
});

// ── 트리 구축 ────────────────────────────────────────────────
test('buildTree: 계층 구조 재구성 + 형제는 order 순', () => {
  const tree = buildTree(seed());
  assert.deepEqual(tree.map((n) => n.id), ['TD-00']);
  const td00 = tree[0];
  assert.deepEqual(td00.children.map((n) => n.id), ['TD-01', 'TD-05']);
  assert.deepEqual(td00.children[0].children.map((n) => n.id), ['TD-02', 'TD-03']);
});

test('buildTree: 부모가 사라진 노드는 루트로 끌어올림 (유실 방지)', () => {
  const map = seed();
  const broken = { ...map, 'TD-02': { ...map['TD-02'], parent: 'GONE' } };
  const tree = buildTree(broken);
  const ids = tree.map((n) => n.id);
  assert.ok(ids.includes('TD-02'));
  assert.equal(tree.length, 2); // TD-00, TD-02
});

test('childrenOf/rootsOf: 파생 목록은 항상 order 순', () => {
  const map = seed();
  assert.deepEqual(rootsOf(map).map((n) => n.id), ['TD-00']);
  assert.deepEqual(childrenOf(map, 'TD-00').map((n) => n.id), ['TD-01', 'TD-05']);
  assert.deepEqual(childrenOf(map, 'TD-05'), []);
});

// ── §7.3 복습 우선순위 ───────────────────────────────────────
test('reviewQueue: ○ > ◐ > ● > △ 순서', () => {
  const map = seed(); // ● ● ○ ◐ △
  const q = reviewQueue(map).map((n) => [n.id, n.status]);
  assert.deepEqual(q, [
    ['TD-02', STATUS.UNKNOWN],
    ['TD-03', STATUS.FUZZY],
    ['TD-00', STATUS.KNOWN],
    ['TD-01', STATUS.KNOWN],
    ['TD-05', STATUS.HOLD],
  ]);
});

test('reviewQueue: 같은 상태끼리는 원래 순서 유지 (stable)', () => {
  let map = {};
  map = addNode(map, { id: 'A', label: 'a', status: STATUS.KNOWN, now: NOW });
  map = addNode(map, { id: 'B', label: 'b', status: STATUS.UNKNOWN, now: NOW });
  map = addNode(map, { id: 'C', label: 'c', status: STATUS.KNOWN, now: NOW });
  assert.deepEqual(reviewQueue(map).map((n) => n.id), ['B', 'A', 'C']);
});

test('REVIEW_PRIORITY/VALID_STATUSES: 명세 기호 4종 정확히', () => {
  assert.deepEqual(REVIEW_PRIORITY, [STATUS.UNKNOWN, STATUS.FUZZY, STATUS.KNOWN, STATUS.HOLD]);
  assert.deepEqual(VALID_STATUSES, [STATUS.UNKNOWN, STATUS.FUZZY, STATUS.KNOWN, STATUS.HOLD]);
  assert.equal(STATUS.UNKNOWN, '○');
  assert.equal(STATUS.FUZZY, '◐');
  assert.equal(STATUS.KNOWN, '●');
  assert.equal(STATUS.HOLD, '△');
});

// ── 검증 (§7.4 불일치 보고) ─────────────────────────────────
test('validate: 건강한 지도는 문제 없음', () => {
  assert.deepEqual(validate(seed()), []);
});

test('validate: 사라진 부모 참조 보고', () => {
  const map = seed();
  const broken = { ...map, 'TD-02': { ...map['TD-02'], parent: 'GONE' } };
  const issues = validate(broken);
  assert.ok(issues.some((i) => i.code === 'missing-parent' && i.id === 'TD-02'));
});

test('validate: 사이클 보고', () => {
  const map = seed();
  const cyclic = { ...map, 'TD-00': { ...map['TD-00'], parent: 'TD-02' } };
  const issues = validate(cyclic);
  assert.ok(issues.some((i) => i.code === 'cycle'));
});

test('validate: 잘못된 status 보고', () => {
  const map = seed();
  const bad = { ...map, 'TD-01': { ...map['TD-01'], status: '★' } };
  const issues = validate(bad);
  assert.ok(issues.some((i) => i.code === 'invalid-status' && i.id === 'TD-01'));
});

// ── id 제안 ──────────────────────────────────────────────────
test('suggestId: 비어 있는 가장 작은 번호 제안', () => {
  assert.equal(suggestId({}), 'CN-1');
  assert.equal(suggestId({ 'CN-1': {}, 'CN-2': {} }), 'CN-3');
  assert.equal(suggestId({ 'CN-2': {} }), 'CN-1');
});

test('suggestId: 접두사 지정 가능', () => {
  assert.equal(suggestId({}, 'TD'), 'TD-1');
  assert.equal(suggestId({ 'TD-1': {} }, 'TD'), 'TD-2');
});

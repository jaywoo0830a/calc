// ============================================================
// electrostatics 테스트 — 오늘 발견된 모든 버그의 회귀 고정
// 실행: npm test
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  K,
  fieldAt,
  forceOnCharge,
  traceFieldLine,
  potentialCorners,
  contourPaths,
} from './electrostatics.js';

const approx = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} |a−b| = ${Math.abs(a - b)} (a=${a}, b=${b})`);

// ── fieldAt: E와 V의 기본 물리 ──────────────────────────────────
test('fieldAt: +전하에서 E는 방사형으로 밖을 향한다', () => {
  const c = [{ id: 'a', x: 0, y: 0, q: 1 }];
  const right = fieldAt(c, 2, 0);
  approx(right.ex, K / 4);            // kq/r² = 1/4
  approx(right.ey, 0);
  approx(right.v, K / 2);             // kq/r = 1/2
  const top = fieldAt(c, 0, 3);
  approx(top.ey, K / 9);
  approx(top.ex, 0);
});

test('fieldAt: −전하에서는 E가 안쪽(전하)을 향한다', () => {
  const c = [{ id: 'a', x: 0, y: 0, q: -1 }];
  const right = fieldAt(c, 2, 0);
  assert.ok(right.ex < 0, 'E at right of − charge must point left');
  approx(right.v, -K / 2);
});

test('fieldAt: 여러 전하 중첩 + skipId 자기 제외', () => {
  const cs = [
    { id: 'a', x: -1, y: 0, q: 1 },
    { id: 'b', x: 1, y: 0, q: 1 },
  ];
  const mid = fieldAt(cs, 0, 0);
  approx(mid.ex, 0); // 대칭 소거
  approx(mid.v, 2);  // 1/1 + 1/1
  const atA = fieldAt(cs, -1, 0, 'a');
  approx(atA.ex, -0.25); // b(+1에 있음)에 의한 장은 b에서 멀어지는 쪽 = 왼쪽
});

test('fieldAt: minR 클램프 — 전하 정확 위치에서 V가 0이 되면 안 됨 (특이점 회귀)', () => {
  const cs = [{ id: 'a', x: 0, y: 0, q: 2 }];
  const at = fieldAt(cs, 0, 0, null, 0.1);
  approx(at.v, 2 / 0.1);
});

// ── forceOnCharge: 인력/척력 방향 ───────────────────────────────
test('forceOnCharge: 쌍극자는 서로를 향해 끌어당긴다 (수평)', () => {
  const cs = [
    { id: 'p', x: -1.5, y: 0, q: 1 },
    { id: 'm', x: 1.5, y: 0, q: -1 },
  ];
  const onP = forceOnCharge(cs, 'p');
  const onM = forceOnCharge(cs, 'm');
  assert.ok(onP.fx > 0, '+는 오른쪽(− 쪽)으로');
  assert.ok(onM.fx < 0, '−는 왼쪽(+ 쪽)으로');
  approx(onP.f, 1 / 9);   // kQ₁Q₂/r² = 1/3²
  approx(onM.f, 1 / 9);
});

test('forceOnCharge: 수직 쌍극자도 서로를 향한다 (화면 반전 회귀의 물리 기준)', () => {
  const cs = [
    { id: 'p', x: 0, y: 1.5, q: 1 },
    { id: 'm', x: 0, y: -1.5, q: -1 },
  ];
  const onP = forceOnCharge(cs, 'p');
  assert.ok(onP.fy < 0, '+는 아래(− 쪽)로');
  const onM = forceOnCharge(cs, 'm');
  assert.ok(onM.fy > 0, '−는 위(+ 쪽)로');
});

test('forceOnCharge: 같은 부호는 밀어낸다', () => {
  const cs = [
    { id: 'a', x: -1, y: 0, q: 2 },
    { id: 'b', x: 1, y: 0, q: 2 },
  ];
  const onA = forceOnCharge(cs, 'a');
  assert.ok(onA.fx < 0, '같은 부호 → 바깥쪽');
  approx(onA.f, 4 / 4); // 2·2/2² = 1
});

test('forceOnCharge: 단일 전하는 힘 0', () => {
  const f = forceOnCharge([{ id: 'a', x: 0, y: 0, q: 3 }], 'a');
  approx(f.f, 0);
});

// ── 등전위선: 중심/반지름/위상 (오늘의 버그들 회귀) ───────────────
function circleStats(charges, level, n = 100, bound = 5.4) {
  const grid = potentialCorners(charges, n, bound);
  const paths = contourPaths(grid, level);
  let sx = 0;
  let sy = 0;
  let cnt = 0;
  for (const p of paths) for (let k = 0; k < p.length; k += 2) { sx += p[k]; sy += p[k + 1]; cnt++; }
  if (!cnt) return { paths: 0, center: [NaN, NaN], rMin: NaN, rMax: NaN };
  const cx = sx / cnt;
  const cy = sy / cnt;
  let rMin = Infinity;
  let rMax = 0;
  for (const p of paths) for (let k = 0; k < p.length; k += 2) {
    const r = Math.hypot(p[k] - cx, p[k + 1] - cy);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  return { paths: paths.length, center: [cx, cy], rMin, rMax };
}

test('등전위선: x축 밖 전하에도 원 중심이 전하와 일치 (y반전 버그 회귀)', () => {
  for (const [cx, cy] of [[0, 2], [0.5, -1.3], [-2.1, 1.7]]) {
    const s = circleStats([{ id: 'a', x: cx, y: cy, q: 1 }], 1);
    assert.equal(s.paths, 1, `charge(${cx},${cy}): 닫힌 원 1개`);
    approx(s.center[0], cx, 0.02, `center x`);
    approx(s.center[1], cy, 0.02, `center y`);
    approx(s.rMin, 1, 0.03, 'radius min');
    approx(s.rMax, 1, 0.03, 'radius max');
  }
});

test('등전위선: 전하가 그리드 꼭짓점에 정확히 놓여도 가짜 고리 없음 (특이점 회귀)', () => {
  const s = circleStats([{ id: 'a', x: 0, y: 0, q: 1 }], 1);
  assert.equal(s.paths, 1, '가짜 고리 없이 원 1개');
  assert.ok(s.rMin > 0.9, `최소 반지름 > 0.9 (실제: ${s.rMin})`);
});

test('등전위선: 쌍극자 V=0은 x=0 평면', () => {
  const g = potentialCorners([
    { id: 'a', x: -1.5, y: 0, q: 1 },
    { id: 'b', x: 1.5, y: 0, q: -1 },
  ], 100, 5.4);
  for (const p of contourPaths(g, 0)) {
    for (let k = 0; k < p.length; k += 2) {
      assert.ok(Math.abs(p[k]) < 0.01, `V=0 점의 |x| < 0.01 (실제: ${p[k]})`);
    }
  }
});

test('등전위선: 4전하 정사각형 — 닫힌 고리 개수 1/4/4', () => {
  const cs = [
    { id: 'a', x: -1.5, y: 1.5, q: 1 },
    { id: 'b', x: 1.5, y: 1.5, q: 1 },
    { id: 'c', x: -1.5, y: -1.5, q: 1 },
    { id: 'd', x: 1.5, y: -1.5, q: 1 },
  ];
  const grid = potentialCorners(cs, 100, 5.4);
  const closed = (paths) => paths.filter((p) => {
    const n = p.length;
    return Math.abs(p[0] - p[n - 2]) < 1e-6 && Math.abs(p[1] - p[n - 1]) < 1e-6;
  }).length;
  assert.equal(closed(contourPaths(grid, 1)), 1);
  assert.equal(closed(contourPaths(grid, 2)), 4);
  assert.equal(closed(contourPaths(grid, 4)), 4);
});

test('등전위선: 같은 부호 전하쌍 — 사이에 V=0 없음, 밀어낸 윤곽', () => {
  const cs = [
    { id: 'a', x: -1.2, y: 0, q: 1 },
    { id: 'b', x: 1.2, y: 0, q: 1 },
  ];
  const grid = potentialCorners(cs, 100, 5.4);
  const p0 = contourPaths(grid, 0);
  assert.equal(p0.length, 0, 'V=0 등전위선 없음');
  // V=2: 전하 두 개 주위에 각각 닫힌 고리
  const s = circleStats(cs, 2);
  assert.ok(s.paths >= 2, `V=2 고리 ≥ 2 (실제: ${s.paths})`);
});

// ── 장선 추적 ──────────────────────────────────────────────────
test('장선: +에서 나와 −에서 끝난다', () => {
  const cs = [
    { id: 'p', x: -1.5, y: 0, q: 1 },
    { id: 'm', x: 1.5, y: 0, q: -1 },
  ];
  const pts = traceFieldLine(cs, -1.5 + 0.3, 0.2, 1, { excludeId: 'p' });
  assert.ok(pts.length > 2, '장선이 진행함');
  const end = pts[pts.length - 1];
  const dEnd = Math.hypot(end.x - 1.5, end.y);
  assert.ok(dEnd < 0.24, `−전하 근처(rStop)에서 종료 (실제 거리: ${dEnd})`);
});

test('장선: 단일 +전하에서는 계속 밖으로 뻗어나간다', () => {
  const pts = traceFieldLine([{ id: 'a', x: 0, y: 0, q: 1 }], 0.3, 0, 1, { excludeId: 'a' });
  const far = Math.hypot(pts[pts.length - 1].x, pts[pts.length - 1].y);
  assert.ok(far > 4, `경계 근처까지 도달 (실제: ${far})`);
});

test('장선: 같은 부호 사이 E=0 지점에서 시드로 되돌아가지 않음', () => {
  const cs = [
    { id: 'a', x: -1.2, y: 0, q: 1 },
    { id: 'b', x: 1.2, y: 0, q: 1 },
  ];
  const pts = traceFieldLine(cs, -1.2 + 0.27, 0, 1, { excludeId: 'a' });
  for (const p of pts) {
    const d = Math.hypot(p.x + 1.2, p.y);
    assert.ok(d > 0.16, `시드 전하 근처로 되돌아가지 않음 (실제 거리: ${d})`);
  }
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'NaN 없음');
  }
});

// ── 장선 접선 불변식 (기하 정확성) ───────────────────────────────
function segmentCos(pts) {
  // 각 세그먼트 방향과 "전하로부터 바깥 반경 방향"의 cos 값들 반환
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const m = Math.hypot(dx, dy);
    const mid = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
    const rm = Math.hypot(mid.x, mid.y);
    out.push((dx * (mid.x / rm) + dy * (mid.y / rm)) / m);
  }
  return out;
}

test('장선: 단일 +전하 — 곡선이 E에 정확히 접함 (바깥 방향)', () => {
  const pts = traceFieldLine([{ id: 'a', x: 0, y: 0, q: 1 }], 0.27, 0.12, 1, { excludeId: 'a' });
  assert.ok(pts.length > 10);
  for (const c of segmentCos(pts)) {
    assert.ok(c > 0.98, `세그먼트가 방사 방향에서 벗어남 (cos=${c.toFixed(4)})`);
  }
});

test('장선: 단일 −전하 — 곡선은 같지만 장(E)은 전하를 향함 (화살표 방향 불변식)', () => {
  const charge = [{ id: 'a', x: 0, y: 0, q: -1 }];
  const pts = traceFieldLine(charge, 0.27, 0.12, -1, { excludeId: 'a' });
  assert.ok(pts.length > 10);
  // trace는 −E 방향(바깥)이지만, 모든 점에서 실제 장은 전하를 향해 안쪽
  for (const p of pts) {
    const e = fieldAt(charge, p.x, p.y);
    const inward = (e.ex * -p.x + e.ey * -p.y) / Math.hypot(e.ex, e.ey) / Math.hypot(p.x, p.y);
    assert.ok(inward > 0.99, `E가 전하를 향해야 함 (cos=${inward.toFixed(4)} at (${p.x.toFixed(2)},${p.y.toFixed(2)}))`);
  }
});

// ── 쌍극자: 종료/무한대 분류 + 축 위 장 방향 ──────────────────────
const DIPOLE = [
  { id: 'p', x: -1.5, y: 0, q: 1 },
  { id: 'm', x: 1.5, y: 0, q: -1 },
];

const nearCharge = (pt, c, tol = 0.26) => Math.hypot(pt.x - c.x, pt.y - c.y) < tol;
const exitsBound = (pt, bound = 5.8) => Math.abs(pt.x) > bound || Math.abs(pt.y) > bound;

test('쌍극자: +의 바깥 축 시드는 −∞로 나가는 선 (플럭스 균형)', () => {
  const seed = { x: -1.5 - 0.27, y: 0 }; // + 왼쪽, 정확히 축 위
  const pts = traceFieldLine(DIPOLE, seed.x, seed.y, 1, { excludeId: 'p' });
  const end = pts[pts.length - 1];
  assert.ok(exitsBound(end), `축 선이 경계로 나가야 함 (끝: ${end.x.toFixed(2)})`);
  assert.ok(end.x < -5.7, '왼쪽 −∞ 방향');
});

test('쌍극자: −의 바깥 축 시드는 +∞에서 오는 선 (무한대에서 −로)', () => {
  const seed = { x: 1.5 + 0.27, y: 0 }; // − 오른쪽, 정확히 축 위
  const pts = traceFieldLine(DIPOLE, seed.x, seed.y, -1, { excludeId: 'm' });
  const end = pts[pts.length - 1];
  assert.ok(exitsBound(end), `축 선이 경계로 나가야 함 (끝: ${end.x.toFixed(2)})`);
  assert.ok(end.x > 5.7, '오른쪽 +∞ 방향');
  // 이 선의 화살표(장 방향)는 − 전하를 향함 (오른쪽 → 왼쪽)
  const mid = pts[Math.floor(pts.length / 2)];
  const e = fieldAt(DIPOLE, mid.x, mid.y);
  assert.ok(e.ex < 0, `축 오른쪽에서 E는 − 전하를 향해 왼쪽 (ex=${e.ex})`);
});

test('쌍극자: +에서 −로 이어지는 선 (안쪽 시드는 −에서 종료)', () => {
  const pts = traceFieldLine(DIPOLE, -1.5 + 0.27, 0, 1, { excludeId: 'p' });
  const end = pts[pts.length - 1];
  assert.ok(nearCharge(end, DIPOLE[1]), `− 전하 근처에서 종료 (끝 거리: ${Math.hypot(end.x - 1.5, end.y).toFixed(3)})`);
});

test('쌍극자: −에서 +로 이어지는 선 (trace는 −E 방향이지만 곡선은 동일)', () => {
  const pts = traceFieldLine(DIPOLE, 1.5 - 0.27, 0, -1, { excludeId: 'm' });
  const end = pts[pts.length - 1];
  assert.ok(nearCharge(end, DIPOLE[0]), `+ 전하 근처에서 종료 (끝 거리: ${Math.hypot(end.x + 1.5, end.y).toFixed(3)})`);
});

test('쌍극자 축 위 장 방향: 사이는 +→−, − 오른쪽은 −를 향함, + 왼쪽은 바깥', () => {
  const between = fieldAt(DIPOLE, 0, 0);
  assert.ok(between.ex > 0, '두 전하 사이 E는 +에서 −로 (오른쪽)');
  const rightOfM = fieldAt(DIPOLE, 3, 0);
  assert.ok(rightOfM.ex < 0, '− 오른쪽 E는 −를 향함 (왼쪽)');
  const leftOfP = fieldAt(DIPOLE, -3, 0);
  assert.ok(leftOfP.ex < 0, '+ 왼쪽 E는 바깥(왼쪽) — 무한대로 나가는 선');
});

test('장선: − 시드 trace가 E와 반평행 (곡선이 유효한 장선임)', () => {
  const pts = traceFieldLine([{ id: 'a', x: 0, y: 0, q: -1 }], 0.27, 0.12, -1, { excludeId: 'a' });
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const m = Math.hypot(dx, dy);
    const e = fieldAt([{ id: 'a', x: 0, y: 0, q: -1 }], pts[i].x, pts[i].y);
    const em = Math.hypot(e.ex, e.ey);
    const cos = (dx * e.ex + dy * e.ey) / (m * em);
    assert.ok(cos < -0.98, `trace 세그먼트는 E와 반평행이어야 함 (cos=${cos.toFixed(4)})`);
  }
});

// ============================================================
// 물리 불변식 검증 스위트 — 교육용이므로 엄격하게.
// 객체 수준이 아니라 물리 법칙/수학 항등식으로 계산 검증:
//   E = −∇V, ∇×E = 0, ∮E·dl = 0(경로 독립), 작용-반작용,
//   역제곱 법칙, 중첩 원리, 등전위선 V==level, 등전위선⊥E,
//   장선 V 단조성, 장선 접선=E, 쌍극자 원거리, 평행판 ΔV=Ed.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  K,
  fieldAt,
  forceOnCharge,
  forceOnChargeScene,
  sceneField,
  traceFieldLine,
  potentialCorners,
  contourPaths,
  plateField,
  fieldLineCount,
} from './electrostatics.js';

// 결정적 난수 (재현 가능한 fuzz)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} |a−b| = ${Math.abs(a - b)} (a=${a}, b=${b}, tol=${tol})`);

const minDist = (charges, x, y) => Math.min(...charges.map((c) => Math.hypot(x - c.x, y - c.y)));

// ── 1. E = −∇V ─────────────────────────────────────────────────
test('불변식: E = −∇V (유한 차분, 무작위 다전하 배치 30회)', () => {
  const rand = rng(42);
  let checked = 0;
  for (let t = 0; t < 200 && checked < 30; t++) {
    const charges = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i}`,
      x: rand() * 6 - 3,
      y: rand() * 6 - 3,
      q: [1, -1, 2][i % 3],
    }));
    const x = rand() * 4 - 2;
    const y = rand() * 4 - 2;
    if (minDist(charges, x, y) < 0.6) continue;
    checked++;
    const h = 0.001;
    const V = (xx, yy) => fieldAt(charges, xx, yy).v;
    const gradX = (V(x + h, y) - V(x - h, y)) / (2 * h);
    const gradY = (V(x, y + h) - V(x, y - h)) / (2 * h);
    const e = fieldAt(charges, x, y);
    approx(e.ex, -gradX, 0.05, 'Ex == −∂V/∂x');
    approx(e.ey, -gradY, 0.05, 'Ey == −∂V/∂y');
  }
  assert.ok(checked === 30);
});

// ── 2. ∇×E = 0 (보존장) ────────────────────────────────────────
test('불변식: ∇×E = 0 — 전기장은 보존장', () => {
  const rand = rng(7);
  const charges = [
    { id: 'a', x: -1, y: 0.5, q: 2 },
    { id: 'b', x: 1.2, y: -0.8, q: -1 },
  ];
  for (let t = 0; t < 30; t++) {
    const x = rand() * 6 - 3;
    const y = rand() * 6 - 3;
    if (minDist(charges, x, y) < 0.5) continue;
    const h = 0.001;
    const ex = (xx, yy) => fieldAt(charges, xx, yy).ex;
    const ey = (xx, yy) => fieldAt(charges, xx, yy).ey;
    const curl = (ey(x + h, y) - ey(x - h, y)) / (2 * h) - (ex(x, y + h) - ex(x, y - h)) / (2 * h);
    approx(curl, 0, 0.02, `curl == 0 at (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }
});

// ── 3. ∮E·dl = 0 + 경로 독립 ───────────────────────────────────
function lineIntegral(charges, path) {
  const N = 400;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const t0 = i / N;
    const t1 = (i + 1) / N;
    const x0 = path.x(t0), y0 = path.y(t0);
    const x1 = path.x(t1), y1 = path.y(t1);
    const e = fieldAt(charges, (x0 + x1) / 2, (y0 + y1) / 2);
    sum += e.ex * (x1 - x0) + e.ey * (y1 - y0);
  }
  return sum;
}

test('불변식: ∮E·dl = 0 (사각형 폐루프) + 경로 독립 = V(A) − V(B)', () => {
  const charges = [
    { id: 'a', x: -1, y: 0, q: 1 },
    { id: 'b', x: 1, y: 0, q: -1 },
    { id: 'c', x: 0, y: 1.5, q: 1 },
  ];
  // 폐루프: (1.5,1.5) → (−1.5,1.5) → (−1.5,−1.5) → (1.5,−1.5) → 닫음
  const square = {
    x: (t) => (t < 0.25 ? 1.5 - 12 * (t - 0) : t < 0.5 ? -1.5 : t < 0.75 ? -1.5 + 12 * (t - 0.5) : 1.5),
    y: (t) => (t < 0.25 ? 1.5 : t < 0.5 ? 1.5 - 12 * (t - 0.25) : t < 0.75 ? -1.5 : -1.5 + 12 * (t - 0.75)),
  };
  const loop = lineIntegral(charges, square);
  approx(loop, 0, 0.01, '폐루프 선적분 == 0');

  // 경로 독립: 직선 경로 vs 굽은 경로, ∫E·dl == V(A) − V(B)
  const A = { x: 2, y: 2 };
  const B = { x: -2, y: -2 };
  const straight = { x: (t) => A.x + (B.x - A.x) * t, y: (t) => A.y + (B.y - A.y) * t };
  const detour = {
    x: (t) => A.x + (B.x - A.x) * t,
    y: (t) => A.y + (B.y - A.y) * t + Math.sin(t * Math.PI) * 1.2,
  };
  const s1 = lineIntegral(charges, straight);
  const s2 = lineIntegral(charges, detour);
  const dv = fieldAt(charges, A.x, A.y).v - fieldAt(charges, B.x, B.y).v;
  approx(s1, dv, 0.01, '직선 경로 == V(A)−V(B)');
  approx(s2, dv, 0.01, '굽은 경로 == V(A)−V(B)');
  approx(s1, s2, 0.01, '경로 독립');
});

// ── 4. 뉴턴 제3법칙 ─────────────────────────────────────────────
test('불변식: 작용-반작용 — 쌍힘은 크기 같고 방향 반대', () => {
  const rand = rng(123);
  for (let t = 0; t < 30; t++) {
    const qa = [1, -1, 2, -2][t % 4];
    const qb = [1, -1, 3, -1][t % 4];
    const cs = [
      { id: 'a', x: 0, y: 0, q: qa },
      { id: 'b', x: rand() * 4 - 2, y: rand() * 4 - 2, q: qb },
    ];
    if (Math.hypot(cs[1].x, cs[1].y) < 0.5) continue;
    const fa = forceOnCharge(cs, 'a');
    const fb = forceOnCharge(cs, 'b');
    approx(fa.fx, -fb.fx, 1e-12, 'F_ax == −F_bx');
    approx(fa.fy, -fb.fy, 1e-12, 'F_ay == −F_by');
    approx(fa.f, fb.f, 1e-12, '|F_ab| == |F_ba|');
  }
});

// ── 5. 쿨롱 역제곱 법칙 ─────────────────────────────────────────
test('불변식: 단일 전하 |E|·r² = k|q|, 방향은 q 부호를 따름', () => {
  const rand = rng(9);
  for (const q of [1, -1, 2, -3]) {
    const cs = [{ id: 'a', x: 0, y: 0, q }];
    for (let t = 0; t < 30; t++) {
      const r = 0.5 + rand() * 3.5;
      const th = rand() * Math.PI * 2;
      const x = r * Math.cos(th);
      const y = r * Math.sin(th);
      const e = fieldAt(cs, x, y);
      approx(Math.hypot(e.ex, e.ey) * r * r, K * Math.abs(q), 1e-9, '|E|r² == k|q|');
      const radial = (e.ex * x + e.ey * y) / (Math.hypot(e.ex, e.ey) * r);
      approx(radial, Math.sign(q), 1e-9, 'E가 q 부호대로 방사형');
    }
  }
});

// ── 6. 중첩 원리 (선형성) ───────────────────────────────────────
test('불변식: 중첩 원리 — E(s·qᵢ) = s·E(qᵢ), V(s·qᵢ) = s·V(qᵢ)', () => {
  const base = [
    { id: 'a', x: -1.3, y: 0.4, q: 1 },
    { id: 'b', x: 0.9, y: -0.7, q: -2 },
    { id: 'c', x: 0.2, y: 1.8, q: 3 },
  ];
  const scaled = base.map((c) => ({ ...c, q: c.q * 1.7 }));
  for (const [x, y] of [[0.5, 0.2], [-1.9, -1.6], [2.1, 1.1], [-0.4, 2.3]]) {
    const e1 = fieldAt(base, x, y);
    const e2 = fieldAt(scaled, x, y);
    approx(e2.ex, 1.7 * e1.ex, 1e-9, 'Ex 선형');
    approx(e2.ey, 1.7 * e1.ey, 1e-9, 'Ey 선형');
    approx(e2.v, 1.7 * e1.v, 1e-9, 'V 선형');
  }
});

// ── 7. 등전위선 위 V == level (직접 항등식) ──────────────────────
test('불변식: 등전위선 위 모든 점에서 V ≈ level', () => {
  const configs = [
    [{ id: 'a', x: 0.4, y: 1.8, q: 1 }],
    [
      { id: 'a', x: -1.5, y: 0, q: 1 },
      { id: 'b', x: 1.5, y: 0, q: -1 },
    ],
    [
      { id: 'a', x: -1.5, y: 1.5, q: 1 },
      { id: 'b', x: 1.5, y: 1.5, q: 1 },
      { id: 'c', x: -1.5, y: -1.5, q: 1 },
      { id: 'd', x: 1.5, y: -1.5, q: 1 },
    ],
  ];
  for (const charges of configs) {
    const grid = potentialCorners(charges, 120, 5.4);
    let mn = Infinity;
    let mx = -Infinity;
    for (const val of grid.v) { mn = Math.min(mn, val); mx = Math.max(mx, val); }
    const maxQ = Math.max(1, ...charges.map((c) => Math.abs(c.q)));
    const levels = [0.5, 1, 2].map((k) => k * maxQ);
    let pts = 0;
    for (const level of levels) {
      if (level <= mn || level >= mx) continue;
      for (const path of contourPaths(grid, level)) {
        for (let k = 0; k < path.length; k += 2) {
          const x = path[k];
          const y = path[k + 1];
          if (minDist(charges, x, y) < 0.35) continue; // 특이점 근처 보간 오차 허용 구간
          const v = fieldAt(charges, x, y).v;
          approx(v, level, 0.06, `V(p)==level ${level} at (${x.toFixed(2)},${y.toFixed(2)})`);
          pts++;
        }
      }
    }
    assert.ok(pts > 50, '충분한 샘플 수 확보');
  }
});

// ── 8. 등전위선 ⊥ 장선 (E·t ≈ 0) ────────────────────────────────
test('불변식: 등전위선과 장선은 수직 (E·tangent ≈ 0)', () => {
  const charges = [
    { id: 'a', x: -1.5, y: 0, q: 1 },
    { id: 'b', x: 1.5, y: 0, q: -1 },
  ];
  const grid = potentialCorners(charges, 240, 5.4); // 고해상도 — 내측 고리까지 커버
  let checked = 0;
  for (const level of [0.5, 1, 2]) {
    for (const path of contourPaths(grid, level)) {
      for (let k = 0; k + 3 < path.length; k += 2) {
        const x = (path[k] + path[k + 2]) / 2;
        const y = (path[k + 1] + path[k + 3]) / 2;
        if (minDist(charges, x, y) < 0.3) continue; // 곡률 큰 곳은 선형 보간 오차
        const e = fieldAt(charges, x, y);
        const em = Math.hypot(e.ex, e.ey);
        const tx = path[k + 2] - path[k];
        const ty = path[k + 3] - path[k + 1];
        const tm = Math.hypot(tx, ty);
        const dot = (e.ex * tx + e.ey * ty) / (em * tm);
        approx(Math.abs(dot), 0, 0.05, `E ⊥ 등전위선 (level ${level})`);
        checked++;
      }
    }
  }
  assert.ok(checked > 200);
});

// ── 9. 등전위선 경로 연결성 ─────────────────────────────────────
test('불변식: 등전위선 경로는 연속 (인접 점 간격 ≤ 셀 대각선)', () => {
  const charges = [
    { id: 'a', x: 0.4, y: 1.8, q: 1 },
    { id: 'b', x: -1.6, y: -1.2, q: -1 },
  ];
  const grid = potentialCorners(charges, 120, 5.4);
  for (const level of [0.5, 1, 2]) {
    for (const path of contourPaths(grid, level)) {
      for (let k = 0; k + 3 < path.length; k += 2) {
        const d = Math.hypot(path[k + 2] - path[k], path[k + 3] - path[k + 1]);
        const maxStep = grid.step * Math.SQRT2 + 1e-9;
        assert.ok(d <= maxStep, `연속 점 간격 ${d.toFixed(4)} ≤ ${maxStep.toFixed(4)}`);
      }
    }
  }
});

// ── 10. 장선 따라 V 단조 변화 ───────────────────────────────────
test('불변식: 장선을 따라 V는 단조 (E 방향 감소, −E 방향 증가)', () => {
  const cs = [
    { id: 'p', x: -1.5, y: 0, q: 1 },
    { id: 'm', x: 1.5, y: 0, q: -1 },
  ];
  // + 시드, dir=+1: V 감소
  const alongE = traceFieldLine(cs, -1.5 + 0.27, 0.15, 1, { excludeId: 'p' });
  let checked = 0;
  for (let i = 1; i < alongE.length; i++) {
    const e = fieldAt(cs, alongE[i].x, alongE[i].y);
    if (Math.hypot(e.ex, e.ey) < 0.01) continue;
    const dv = fieldAt(cs, alongE[i].x, alongE[i].y).v - fieldAt(cs, alongE[i - 1].x, alongE[i - 1].y).v;
    assert.ok(dv < 0, `E 방향 이동 → V 감소 (dv=${dv.toExponential(2)})`);
    checked++;
  }
  // − 시드, dir=−1 (E 역행): V 증가
  const againstE = traceFieldLine(cs, 1.5 - 0.27, -0.15, -1, { excludeId: 'm' });
  for (let i = 1; i < againstE.length; i++) {
    const e = fieldAt(cs, againstE[i].x, againstE[i].y);
    if (Math.hypot(e.ex, e.ey) < 0.01) continue;
    const dv = fieldAt(cs, againstE[i].x, againstE[i].y).v - fieldAt(cs, againstE[i - 1].x, againstE[i - 1].y).v;
    assert.ok(dv > 0, '−E 방향 이동 → V 증가');
    checked++;
  }
  assert.ok(checked > 20);
});

// ── 11. 장선 접선 = E (fuzz) ────────────────────────────────────
test('불변식: 장선 세그먼트는 E에 접함 (무작위 배치 fuzz)', () => {
  const rand = rng(2024);
  for (let t = 0; t < 8; t++) {
    const charges = Array.from({ length: 2 }, (_, i) => ({
      id: `c${i}`,
      x: rand() * 3 - 1.5,
      y: rand() * 3 - 1.5,
      q: 1,
    }));
    // 서로 너무 가까우면 E≈0 영역이 넓어져 샘플이 줄 뿐, 접선성은 유지
    const seedX = charges[0].x + 0.27;
    const pts = traceFieldLine(charges, seedX, charges[0].y, 1, { excludeId: charges[0].id });
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const m = Math.hypot(dx, dy);
      const e = fieldAt(charges, (pts[i].x + pts[i - 1].x) / 2, (pts[i].y + pts[i - 1].y) / 2);
      const em = Math.hypot(e.ex, e.ey);
      if (em < 1e-3) continue;
      const cos = (dx * e.ex + dy * e.ey) / (m * em);
      assert.ok(cos > 0.97, `접선 cos=${cos.toFixed(4)} (E=${em.toFixed(3)})`);
    }
  }
});

// ── 12. 쌍극자 원거리 근사 ───────────────────────────────────────
test('불변식: 쌍극자 원거리 V ≈ p·cosθ/r², 중앙면 V=0', () => {
  const cs = [
    { id: 'p', x: -1.5, y: 0, q: 1 },
    { id: 'm', x: 1.5, y: 0, q: -1 },
  ];
  // p = q·d = 3, 방향 −x (+에서 −로 = 왼쪽) → (5,0)은 θ=π
  // 정확값: V(5,0) = 1/6.5 − 1/3.5 = −0.1319
  const axialExact = 1 / 6.5 - 1 / 3.5;
  approx(fieldAt(cs, 5, 0).v, axialExact, 1e-12, '축 방향 정확값');
  approx(axialExact, -3 / 25, 0.015, '근사: V ≈ p·cosθ/r² = −3/25');
  // 중앙면 (0, 5): V = 0 (대칭)
  approx(fieldAt(cs, 0, 5).v, 0, 1e-12);
  // θ=60° (p=−x 기준): V ≈ 3·cos120°? — (2.5, 4.33)에서 p방향과의 각 cos = −0.5
  const offExact = 1 / Math.hypot(4, 4.3301) - 1 / Math.hypot(1, 4.3301);
  approx(fieldAt(cs, 2.5, 4.3301).v, offExact, 1e-12, '경사 방향 정확값');
  approx(offExact, (-3 * 0.5) / 25, 0.015, '근사: V ≈ p·cosθ/r² (cosθ=−0.5)');
});

// ── 13. 평행판: 균일 E, 선형 V, E=−∇V, ΔV=Ed ─────────────────────
test('불변식: 평행판 — E 일정, V 선형, ΔV = Ed, 밖은 0', () => {
  const PLATE_X = 2;
  const V0 = 4;
  // 판 사이 균일
  for (const x of [-1.5, 0, 1.9]) {
    const f = plateField(x, PLATE_X, V0);
    approx(f.ex, 1, 1e-12, 'E = ΔV/d = 1');
    approx(f.ey, 0, 1e-12);
    approx(f.v, 2 - x, 1e-12, 'V = 2 − x (선형)');
  }
  // E = −∇V
  const h = 1e-4;
  const dvdx = (plateField(0.8 + h, PLATE_X, V0).v - plateField(0.8 - h, PLATE_X, V0).v) / (2 * h);
  approx(-dvdx, plateField(0.8, PLATE_X, V0).ex, 1e-6, 'E == −dV/dx');
  // ΔV = Ed
  const dV = plateField(-PLATE_X, PLATE_X, V0).v - plateField(PLATE_X, PLATE_X, V0).v;
  approx(dV, 1 * 2 * PLATE_X, 1e-12, 'ΔV == E·d = 4');
  // 판 밖: E=0, V 일정
  const left = plateField(-2.5, PLATE_X, V0);
  const right = plateField(2.5, PLATE_X, V0);
  approx(left.ex, 0, 1e-12);
  approx(left.v, V0, 1e-12, '왼쪽 밖 V = V0');
  approx(right.v, 0, 1e-12, '오른쪽 밖 V = 0');
});

// ── 14. 장선 수 ∝ |q| ───────────────────────────────────────────
test('불변식: 장선 수가 전하량에 비례 (플럭스 직관)', () => {
  approx(fieldLineCount(1), 8, 0);
  approx(fieldLineCount(2), 16, 0);
  approx(fieldLineCount(4), 32, 0);
  assert.ok(fieldLineCount(2) === 2 * fieldLineCount(1));
  assert.ok(fieldLineCount(4) === 4 * fieldLineCount(1));
  approx(fieldLineCount(0.5), 8, 0, '최소 8선');
});

// ── 15. 평행판 + 점전하 중첩 (Plates 모드에 전하 배치) ─────────────
test('불변식: 평행판 + 점전하 합성장 = 중첩 원리', () => {
  const cs = [{ id: 'a', x: 0, y: 1, q: 1 }];
  const PX = 2;
  const V0 = 4;
  for (const [x, y] of [[0.5, 0.3], [-1.2, 0.9], [0.9, -1.1]]) {
    const s = sceneField('plates', cs, x, y, null, PX, V0);
    const p = plateField(x, PX, V0);
    const f = fieldAt(cs, x, y);
    approx(s.ex, p.ex + f.ex, 1e-12, 'Ex 합성');
    approx(s.ey, p.ey + f.ey, 1e-12, 'Ey 합성');
    approx(s.v, p.v + f.v, 1e-12, 'V 합성');
  }
});

test('불변식: 균일장 안 전하의 힘 F = qE (전하 하나)', () => {
  const cs = [{ id: 'a', x: 0.3, y: 0.5, q: 2 }];
  const fa = forceOnChargeScene('plates', cs, 'a', 2, 4);
  approx(fa.fx, 2 * 1, 1e-12, 'F = q·E = 2');
  approx(fa.fy, 0, 1e-12);
  const neg = [{ id: 'b', x: -0.7, y: 0.2, q: -3 }];
  const fb = forceOnChargeScene('plates', neg, 'b', 2, 4);
  approx(fb.fx, -3 * 1, 1e-12, 'F = q·E = −3 (음전하는 반대)');
});

test('불변식: 균일장 안 두 전하는 서로의 힘 + qE 합성', () => {
  const cs = [
    { id: 'a', x: -1, y: 0, q: 1 },
    { id: 'b', x: 1, y: 0, q: 1 },
  ];
  const fa = forceOnChargeScene('plates', cs, 'a', 2, 4);
  approx(fa.fx, 1 * (1 - 0.25), 1e-12, 'Fx = q·(E_plate − E_b) = 0.75'); // b는 밀어냄(왼쪽)
  approx(fa.fy, 0, 1e-12);
  const fb = forceOnChargeScene('plates', cs, 'b', 2, 4);
  approx(fb.fx, 1 * (1 + 0.25), 1e-12, 'F = q·(E_plate + E_a) = 1.25');
});

test('불변식: 균일장 속 +전하 장선은 오른쪽으로 휘어짐', () => {
  const ext = () => ({ ex: 1, ey: 0 });
  const pts = traceFieldLine([{ id: 'a', x: 0, y: 0, q: 1 }], 0.27, 0.15, 1, { excludeId: 'a', ext });
  const end = pts[pts.length - 1];
  assert.ok(end.x > 3, `먼 지점에서 장은 균일장(+x)에 수렴 — x=${end.x.toFixed(2)}`);
});

test('불변식: 선형 외부 전위의 등전위선은 수직선 (extV)', () => {
  // V_ext = 2 − x (평행판) → V=1 등전위선은 x=1
  const grid = potentialCorners([], 120, 5.4, (x) => 2 - x);
  for (const path of contourPaths(grid, 1)) {
    for (let k = 0; k < path.length; k += 2) {
      approx(path[k], 1, 0.02, `V=1 → x≈1 (x=${path[k].toFixed(3)})`);
    }
  }
  // V=3 → x=−1
  for (const path of contourPaths(grid, 3)) {
    for (let k = 0; k < path.length; k += 2) {
      approx(path[k], -1, 0.02, 'V=3 → x≈−1');
    }
  }
});

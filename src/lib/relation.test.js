// ============================================================
// relation 테스트 — Relation Analyzer 코어 (TDD)
// 실행: npm test
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePoint, findZeros, classifyCritical, analyzeRange } from './relation.js';

const approx = (a, b, tol = 1e-6, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} |a−b| = ${Math.abs(a - b)} (a=${a}, b=${b})`);

// ── analyzePoint: 부호·탄력성·곡률·문장 ─────────────────────
test('analyzePoint: 양의 기울기 + 탄력적', () => {
  const r = analyzePoint({ a: 10, b: 20, slope: 4, curvature: 0 });
  assert.equal(r.sign, 'positive');
  approx(r.elasticity, 2, 1e-9);
  assert.equal(r.elasticityClass, 'elastic');
  assert.equal(r.curvatureClass, 'linear');
  assert.match(r.sentence, /increases/);
  assert.match(r.sentence, /elastic/);
});

test('analyzePoint: 음의 기울기 — 반비례 경향', () => {
  const r = analyzePoint({ a: 10, b: 20, slope: -4, curvature: 0 });
  assert.equal(r.sign, 'negative');
  approx(r.elasticity, -2, 1e-9);
  assert.equal(r.elasticityClass, 'elastic');
  assert.match(r.sentence, /decreases/);
});

test('analyzePoint: ε=1 → 정비례', () => {
  const r = analyzePoint({ a: 2, b: 4, slope: 2 });
  approx(r.elasticity, 1, 1e-9);
  assert.equal(r.elasticityClass, 'proportional');
  assert.match(r.sentence, /proportional/);
});

test('analyzePoint: ε=−1 → 반비례', () => {
  const r = analyzePoint({ a: 2, b: 4, slope: -2 });
  approx(r.elasticity, -1, 1e-9);
  assert.equal(r.elasticityClass, 'inverse-proportional');
});

test('analyzePoint: |ε|<1 → 비탄력적', () => {
  const r = analyzePoint({ a: 1, b: 10, slope: 1 });
  assert.equal(r.elasticityClass, 'inelastic');
  approx(r.elasticity, 0.1, 1e-9);
});

test('analyzePoint: 기울기 0 → 정지점', () => {
  const r = analyzePoint({ a: 5, b: 7, slope: 0, curvature: 0 });
  assert.equal(r.sign, 'zero');
  approx(r.elasticity, 0, 1e-9);
  assert.equal(r.elasticityClass, 'zero');
  assert.match(r.sentence, /stationary|flat/i);
});

test('analyzePoint: B=0 → 탄력성 미정의', () => {
  const r = analyzePoint({ a: 5, b: 0, slope: 2 });
  assert.equal(r.elasticity, null);
  assert.equal(r.elasticityClass, null);
});

test('analyzePoint: 곡률 분류와 문장', () => {
  const up = analyzePoint({ a: 1, b: 1, slope: 1, curvature: 2 });
  assert.equal(up.curvatureClass, 'convex');
  assert.match(up.sentence, /accelerat/i);

  const down = analyzePoint({ a: 1, b: 1, slope: 1, curvature: -2 });
  assert.equal(down.curvatureClass, 'concave');
  assert.match(down.sentence, /saturat|diminish/i);
});

test('analyzePoint: 정지점 곡률 → 극값 해석', () => {
  const mn = analyzePoint({ a: 0, b: 0, slope: 0, curvature: 1 });
  assert.match(mn.sentence, /minimum/i);
  const mx = analyzePoint({ a: 0, b: 0, slope: 0, curvature: -1 });
  assert.match(mx.sentence, /maximum/i);
});

// ── findZeros: 수치 근 탐색 ──────────────────────────────────
test('findZeros: x²−4 → ±2', () => {
  const f = (x) => x * x - 4;
  const roots = findZeros(f, -3, 3);
  assert.equal(roots.length, 2);
  approx(roots[0], -2, 1e-5);
  approx(roots[1], 2, 1e-5);
});

test('findZeros: sin → 0, π, 2π (경계 포함)', () => {
  const roots = findZeros(Math.sin, 0, 2 * Math.PI);
  assert.equal(roots.length, 3);
  approx(roots[0], 0, 1e-5);
  approx(roots[1], Math.PI, 1e-4);
  approx(roots[2], 2 * Math.PI, 1e-4);
});

test('findZeros: 근 없음 → 빈 배열', () => {
  assert.deepEqual(findZeros(() => 3, -1, 1), []);
});

// ── classifyCritical ─────────────────────────────────────────
test('classifyCritical: fpp 부호 → 극값 종류', () => {
  assert.equal(classifyCritical(1), 'min');
  assert.equal(classifyCritical(-1), 'max');
  assert.equal(classifyCritical(0), 'flat');
});

// ── analyzeRange: 구간 프로파일 ──────────────────────────────
const sq = (x) => x * x;
const twoA = (x) => 2 * x;
const two = () => 2;

test('analyzeRange: A² → [−,0) 감소 (0,+2] 증가, x=0 최소', () => {
  const r = analyzeRange(sq, twoA, two, -2, 2);
  assert.deepEqual(r.intervals, [
    { from: -2, to: 0, sign: 'negative' },
    { from: 0, to: 2, sign: 'positive' },
  ]);
  assert.equal(r.critical.length, 1);
  approx(r.critical[0].x, 0, 1e-5);
  assert.equal(r.critical[0].kind, 'min');
  assert.deepEqual(r.inflections, []);
});

test('analyzeRange: −A² → x=0 최대', () => {
  const r = analyzeRange((x) => -x * x, (x) => -2 * x, () => -2, -2, 2);
  assert.equal(r.critical[0].kind, 'max');
});

test('analyzeRange: A³ → 단조 증가, x=0은 flat + 변곡점', () => {
  const r = analyzeRange((x) => x ** 3, (x) => 3 * x * x, (x) => 6 * x, -2, 2);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].sign, 'positive');
  assert.equal(r.critical.length, 1);
  assert.equal(r.critical[0].kind, 'flat');
  assert.equal(r.inflections.length, 1);
  approx(r.inflections[0], 0, 1e-5);
});

test('analyzeRange: sin → 극대·극소·변곡점', () => {
  const r = analyzeRange(Math.sin, Math.cos, (x) => -Math.sin(x), 0, 2 * Math.PI);
  const kinds = r.critical.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['max', 'min']);
  const xs = r.critical.map((c) => c.x).sort((p, q) => p - q);
  approx(xs[0], Math.PI / 2, 1e-4);
  approx(xs[1], (3 * Math.PI) / 2, 1e-4);
  assert.equal(r.inflections.length, 1);
  approx(r.inflections[0], Math.PI, 1e-4);
  // 단조 구간: + / − / +
  assert.deepEqual(r.intervals.map((i) => i.sign), ['positive', 'negative', 'positive']);
});

test('analyzeRange: 뒤집힌 구간 [b,a]는 정규화되어 동일한 결과', () => {
  const r = analyzeRange(sq, twoA, two, 2, -2);
  assert.deepEqual(r.intervals.map((i) => i.sign), ['negative', 'positive']);
});

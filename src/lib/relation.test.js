// ============================================================
// relation 테스트 — Relation Analyzer 코어 (TDD)
// 실행: npm test
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePoint, findZeros, classifyCritical, analyzeRange, validateVarName, variableLabel } from './relation.js';

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

test('findZeros: 상수 0 함수는 근 하나만 (제로-런 시작점)', () => {
  const roots = findZeros(() => 0, -2, 2);
  assert.equal(roots.length, 1);
  approx(roots[0], -2, 1e-6);
});

test('findZeros: 일부 구간만 0인 함수 — 런 시작점 + 부호 변화 근', () => {
  const f = (x) => (x < 0 ? 0 : x - 1);
  const roots = findZeros(f, -2, 2);
  assert.equal(roots.length, 2);
  approx(roots[0], -2, 1e-6);
  approx(roots[1], 1, 1e-5);
});

test('analyzeRange: 상수 함수 → 임계점/변곡점 없음, 단조 구간 하나', () => {
  const r = analyzeRange(() => 5, () => 0, () => 0, -2, 2);
  assert.deepEqual(r.critical, []);
  assert.deepEqual(r.inflections, []);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].sign, 'zero');
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

// ── 변수 이름(레이블) 주입 — 멘탈 매핑 최소화 ───────────────
test('analyzePoint: 기본 레이블은 A/B', () => {
  const r = analyzePoint({ a: 10, b: 20, slope: 4 });
  assert.match(r.sentence, /B increases as A grows/);
});

test('analyzePoint: 사용자 이름 v/t가 문장에 반영된다', () => {
  const r = analyzePoint({ a: 10, b: 20, slope: 4 }, { varA: 'v', varB: 't' });
  assert.match(r.sentence, /t increases as v grows/);
  assert.match(r.sentence, /a 1% rise in v moves t by 200%/);
  assert.doesNotMatch(r.sentence, /\bA\b|\bB\b/);
});

test('analyzePoint: 반비례 문장에 이름 반영', () => {
  const r = analyzePoint({ a: 2, b: 4, slope: -2 }, { varA: 'v', varB: 't' });
  assert.match(r.sentence, /t is inversely proportional to v/);
});

test('analyzePoint: 정지점·영점 문장에 이름 반영', () => {
  const z = analyzePoint({ a: 5, b: 7, slope: 0 }, { varA: 'v', varB: 't' });
  assert.match(z.sentence, /t is stationary/);
  const zero = analyzePoint({ a: 5, b: 0, slope: 2 }, { varA: 'v', varB: 't' });
  assert.match(zero.sentence, /t passes through zero/);
});

// ── validateVarName ────────────────────────────────────────
test('validateVarName: 식별자 규칙', () => {
  assert.equal(validateVarName('v'), true);
  assert.equal(validateVarName('t'), true);
  assert.equal(validateVarName('A'), true);
  assert.equal(validateVarName('v2'), true);
  assert.equal(validateVarName('_x'), true);
  assert.equal(validateVarName('2v'), false);
  assert.equal(validateVarName(''), false);
  assert.equal(validateVarName('a b'), false);
  assert.equal(validateVarName('x-y'), false);
  assert.equal(validateVarName(null), false);
});

// ── Variable → Natural Language ─────────────────────────────
test('variableLabel: 자연어 이름이 있으면 심볼과 함께 표기', () => {
  assert.equal(variableLabel('t', 'Total Duration'), 'Total Duration (t)');
  assert.equal(variableLabel('v', 'Constant Car Speed'), 'Constant Car Speed (v)');
});

test('variableLabel: 이름이 없거나 빈 문자열이면 심볼만', () => {
  assert.equal(variableLabel('t', null), 't');
  assert.equal(variableLabel('t', ''), 't');
  assert.equal(variableLabel('t', '   '), 't');
  assert.equal(variableLabel('t', undefined), 't');
});

test('analyzePoint: 자연어 이름이 문장에 반영된다', () => {
  const r = analyzePoint(
    { a: 2, b: 4, slope: -2 },
    { varA: 'v', varB: 't', nameA: 'Constant Car Speed', nameB: 'Total Duration' }
  );
  assert.match(r.sentence, /Total Duration \(t\) decreases as Constant Car Speed \(v\) grows/);
  assert.match(r.sentence, /Total Duration \(t\) is inversely proportional to Constant Car Speed \(v\)/);
});

test('analyzePoint: 탄력성 % 문장에도 자연어 이름이 반영된다', () => {
  const r = analyzePoint(
    { a: 10, b: 20, slope: 4 },
    { varA: 'v', varB: 't', nameA: 'Speed', nameB: 'Time' }
  );
  assert.match(r.sentence, /a 1% rise in Speed \(v\) moves Time \(t\) by 200%/);
});

test('analyzePoint: 한쪽만 이름이 있어도 정상 동작', () => {
  const r = analyzePoint({ a: 5, b: 7, slope: 0 }, { varA: 'v', varB: 't', nameA: 'Speed' });
  assert.match(r.sentence, /t is stationary here — the slope is zero/);
});

test('analyzePoint: 자연어 이름 없으면 기존 문장 그대로', () => {
  const r = analyzePoint({ a: 10, b: 20, slope: 4 }, { varA: 'v', varB: 't' });
  assert.match(r.sentence, /t increases as v grows/);
  assert.doesNotMatch(r.sentence, /\(t\)|\(v\)/);
});

// ============================================================
// units 테스트 — 단위 분해·병합 코어 로직 (TDD)
// 실행: npm test
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_UNITS,
  UNITS,
  SI_PREFIXES,
  lookupUnit,
  decomposeUnit,
  parseUnitExpr,
  mergeUnits,
  formatDim,
  formatValue,
  prefixedValue,
} from './units.js';

const approx = (a, b, tol = 1e-9, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} |a−b| = ${Math.abs(a - b)} (a=${a}, b=${b})`);

const dim = (obj) => obj; // 가독성 헬퍼

// ── 데이터 무결성 ─────────────────────────────────────────────
test('데이터: 단위 심볼은 중복이 없고 유효한 형태다', () => {
  const seen = new Set();
  for (const u of UNITS) {
    assert.ok(typeof u.sym === 'string' && u.sym.length > 0, 'sym must be non-empty string');
    assert.ok(!seen.has(u.sym), `duplicate symbol: ${u.sym}`);
    seen.add(u.sym);
    assert.ok(['derived', 'common'].includes(u.kind), `bad kind for ${u.sym}`);
    assert.ok(u.factor === undefined || (Number.isFinite(u.factor) && u.factor > 0), `bad factor for ${u.sym}`);
    for (const [b, e] of Object.entries(u.dim || {})) {
      assert.ok(BASE_UNITS.some((x) => x.sym === b), `dim base '${b}' not in BASE_UNITS (${u.sym})`);
      assert.ok(Number.isInteger(e) && e !== 0, `dim exponent must be non-zero integer (${u.sym}.${b}=${e})`);
    }
  }
  for (const b of BASE_UNITS) {
    assert.ok(typeof b.sym === 'string' && b.name, 'base unit needs sym + name');
  }
});

test('데이터: SI 접두사는 양수 팩터와 유일한 심볼을 가진다', () => {
  const seen = new Set();
  for (const p of SI_PREFIXES) {
    assert.ok(Number.isFinite(p.factor) && p.factor > 0, `bad prefix factor: ${p.sym}`);
    assert.ok(!seen.has(p.sym), `duplicate prefix: ${p.sym}`);
    seen.add(p.sym);
  }
});

// ── lookupUnit: 정확한 심볼 ───────────────────────────────────
test('lookupUnit: N → newton, kg·m·s⁻²', () => {
  const u = lookupUnit('N');
  assert.ok(u);
  assert.equal(u.sym, 'N');
  assert.equal(u.name, 'newton');
  assert.equal(u.factor, 1);
  assert.equal(u.prefixFactor, 1);
  assert.deepEqual(u.dim, { kg: 1, m: 1, s: -2 });
});

test('lookupUnit: 기본 단위 s, kg', () => {
  assert.deepEqual(lookupUnit('s').dim, { s: 1 });
  assert.deepEqual(lookupUnit('kg').dim, { kg: 1 });
  assert.equal(lookupUnit('kg').factor, 1);
});

test('lookupUnit: rad/sr은 무차원(dim = {})', () => {
  assert.deepEqual(lookupUnit('rad').dim, {});
  assert.deepEqual(lookupUnit('sr').dim, {});
});

test('lookupUnit: J → kg·m²·s⁻², W → kg·m²·s⁻³', () => {
  assert.deepEqual(lookupUnit('J').dim, { kg: 1, m: 2, s: -2 });
  assert.deepEqual(lookupUnit('W').dim, { kg: 1, m: 2, s: -3 });
});

test('lookupUnit: Ω·S 등 전기 단위', () => {
  assert.deepEqual(lookupUnit('V').dim, { kg: 1, m: 2, s: -3, A: -1 });
  assert.deepEqual(lookupUnit('Ω').dim, { kg: 1, m: 2, s: -3, A: -2 });
  assert.deepEqual(lookupUnit('C').dim, { s: 1, A: 1 });
});

// ── lookupUnit: SI 접두사 ─────────────────────────────────────
test('lookupUnit: kN → 1000 × N', () => {
  const u = lookupUnit('kN');
  assert.equal(u.factor, 1000);
  assert.equal(u.prefixFactor, 1000);
  assert.equal(u.baseSym, 'N');
  assert.deepEqual(u.dim, { kg: 1, m: 1, s: -2 });
});

test('lookupUnit: MPa → 10⁶ Pa', () => {
  const u = lookupUnit('MPa');
  assert.equal(u.factor, 1e6);
  assert.deepEqual(u.dim, { kg: 1, m: -1, s: -2 });
});

test('lookupUnit: nm/mm/µm → 10⁻⁹/10⁻³/10⁻⁶ m', () => {
  assert.equal(lookupUnit('nm').factor, 1e-9);
  assert.deepEqual(lookupUnit('nm').dim, { m: 1 });
  assert.equal(lookupUnit('mm').factor, 1e-3);
  assert.equal(lookupUnit('µm').factor, 1e-6);
  assert.equal(lookupUnit('um').factor, 1e-6); // 'u'는 µ의 별칭
});

test('lookupUnit: kWh → 3.6×10⁶ J 차원', () => {
  const u = lookupUnit('kWh');
  assert.equal(u.baseSym, 'Wh');
  approx(u.factor, 3.6e6, 1e-3);
  assert.deepEqual(u.dim, { kg: 1, m: 2, s: -2 });
});

test('lookupUnit: µF, mK, dam', () => {
  approx(lookupUnit('µF').factor, 1e-6, 1e-18);
  assert.equal(lookupUnit('mK').factor, 1e-3);
  assert.equal(lookupUnit('dam').factor, 10); // deca + metre
});

test('lookupUnit: 정확한 심볼이 접두사보다 우선한다', () => {
  assert.equal(lookupUnit('min').factor, 60);     // minute (m+? 아님)
  assert.equal(lookupUnit('h').factor, 3600);      // hour (hecto 아님)
  assert.equal(lookupUnit('T').name, 'tesla');     // tera 아님
  assert.equal(lookupUnit('d'), null);             // d는 접두사일 뿐 단위가 아님
});

test('lookupUnit: 대소문자 구분 — "j", "n", "pa"는 알 수 없음', () => {
  assert.equal(lookupUnit('j'), null);
  assert.equal(lookupUnit('n'), null);
  assert.equal(lookupUnit('pa'), null);
});

test('lookupUnit: 빈 값/비문자열/미지의 단위 → null', () => {
  assert.equal(lookupUnit(''), null);
  assert.equal(lookupUnit('   '), null);
  assert.equal(lookupUnit(null), null);
  assert.equal(lookupUnit(123), null);
  assert.equal(lookupUnit('X'), null);
  assert.equal(lookupUnit('qq'), null);
});

// ── decomposeUnit ────────────────────────────────────────────
test('decomposeUnit: lookupUnit과 동일하게 동작한다', () => {
  assert.deepEqual(decomposeUnit('N').dim, { kg: 1, m: 1, s: -2 });
  assert.equal(decomposeUnit('kW').factor, 1000);
  assert.equal(decomposeUnit('???'), null);
});

// ── parseUnitExpr: 기본 문법 ─────────────────────────────────
test('parse: "kg m / s^2" → N 차원', () => {
  const { factor, dim: d } = parseUnitExpr('kg m / s^2');
  assert.equal(factor, 1);
  assert.deepEqual(d, { kg: 1, m: 1, s: -2 });
});

test('parse: "kg·m·s⁻²" (유니코드 위첨자) → N 차원', () => {
  const { dim: d } = parseUnitExpr('kg·m·s⁻²');
  assert.deepEqual(d, { kg: 1, m: 1, s: -2 });
});

test('parse: "kg m s^-2" → N 차원', () => {
  assert.deepEqual(parseUnitExpr('kg m s^-2').dim, { kg: 1, m: 1, s: -2 });
});

test('parse: "*"와 "×" 구분자 지원', () => {
  assert.deepEqual(parseUnitExpr('kg*m/s²').dim, { kg: 1, m: 1, s: -2 });
  assert.deepEqual(parseUnitExpr('kg×m/s²').dim, { kg: 1, m: 1, s: -2 });
});

test('parse: 명명된 파생 단위가 식 안에 들어오면 기저로 분해된다', () => {
  assert.deepEqual(parseUnitExpr('N·m').dim, { kg: 1, m: 2, s: -2 }); // J
  assert.deepEqual(parseUnitExpr('N/m^2').dim, { kg: 1, m: -1, s: -2 }); // Pa
  assert.deepEqual(parseUnitExpr('J/s').dim, { kg: 1, m: 2, s: -3 });   // W
});

test('parse: 팩터 곱 — "W h" → 3600 J', () => {
  const { factor, dim: d } = parseUnitExpr('W h');
  approx(factor, 3600, 1e-9);
  assert.deepEqual(d, { kg: 1, m: 2, s: -2 });
});

test('parse: "/" 뒤의 모든 항은 분모가 된다', () => {
  assert.deepEqual(parseUnitExpr('kg / s / m').dim, { kg: 1, s: -1, m: -1 });
  assert.deepEqual(parseUnitExpr('kg / s m').dim, { kg: 1, s: -1, m: -1 });
});

test('parse: 지수 — "m^2", "s^-1", "kg^2 m^-2"', () => {
  assert.deepEqual(parseUnitExpr('m^2').dim, { m: 2 });
  assert.deepEqual(parseUnitExpr('s^-1').dim, { s: -1 });
  assert.deepEqual(parseUnitExpr('kg^2 m^-2').dim, { kg: 2, m: -2 });
});

test('parse: 접두사가 붙은 단위도 팩터에 반영된다', () => {
  const { factor, dim: d } = parseUnitExpr('kN·m');
  approx(factor, 1000, 1e-12);
  assert.deepEqual(d, { kg: 1, m: 2, s: -2 });
});

test('parse: 상쇄되는 지수는 제거된다 — "m²/m²" → {}', () => {
  const { factor, dim: d } = parseUnitExpr('m^2 / m^2');
  assert.equal(factor, 1);
  assert.deepEqual(d, {});
});

test('parse: "h / day" → 팩터 1/24, 무차원', () => {
  const { factor, dim: d } = parseUnitExpr('h / day');
  approx(factor, 1 / 24, 1e-12);
  assert.deepEqual(d, {});
});

test('parse: 공백 입력/알 수 없는 단위 → throw', () => {
  assert.throws(() => parseUnitExpr(''), /empty/);
  assert.throws(() => parseUnitExpr('   '), /empty/);
  assert.throws(() => parseUnitExpr('X'), /unknown unit/);
  assert.throws(() => parseUnitExpr('kg X m'), /unknown unit/);
  assert.throws(() => parseUnitExpr(null), /empty|string/i);
});

test('parse: 잘못된 지수/끝나는 슬래시 → throw', () => {
  assert.throws(() => parseUnitExpr('m^'), /exponent|parse/i);
  assert.throws(() => parseUnitExpr('m^-'), /exponent|parse/i);
  assert.throws(() => parseUnitExpr('kg /'), /ends with|parse/i);
  assert.throws(() => parseUnitExpr('²'), /unknown|no units/i);
});

test('parse: 연산자 없이 단일 심볼 "N"도 식으로 파싱된다', () => {
  const { factor, dim: d } = parseUnitExpr('N');
  assert.equal(factor, 1);
  assert.deepEqual(d, { kg: 1, m: 1, s: -2 });
});

// ── mergeUnits: 병합 ─────────────────────────────────────────
test('merge: N 차원 → SI 단위 N이 먼저, dyn은 10⁵', () => {
  const out = mergeUnits({ kg: 1, m: 1, s: -2 }, 1);
  assert.equal(out[0].sym, 'N');
  approx(out[0].value, 1, 1e-12);
  const dyn = out.find((r) => r.sym === 'dyn');
  assert.ok(dyn, 'dyn이 결과에 포함되어야 함');
  approx(dyn.value, 1e5, 1e-6);
});

test('merge: J 차원 factor 3600 → Wh = 1, J = 3600', () => {
  const out = mergeUnits({ kg: 1, m: 2, s: -2 }, 3600);
  const wh = out.find((r) => r.sym === 'Wh');
  const j = out.find((r) => r.sym === 'J');
  approx(wh.value, 1, 1e-12);
  approx(j.value, 3600, 1e-9);
});

test('merge: 무차원 → rad, sr (값 1)', () => {
  const out = mergeUnits({}, 1);
  assert.deepEqual(out.map((r) => r.sym).sort(), ['rad', 'sr']);
  out.forEach((r) => approx(r.value, 1, 1e-12));
});

test('merge: m³ 차원 factor 10⁻³ → L = 1, mL = 1000', () => {
  const out = mergeUnits({ m: 3 }, 1e-3);
  const l = out.find((r) => r.sym === 'L');
  const ml = out.find((r) => r.sym === 'mL');
  approx(l.value, 1, 1e-12);
  approx(ml.value, 1000, 1e-6);
});

test('merge: SI 단위가 common 단위보다 앞에 정렬된다', () => {
  const out = mergeUnits({ kg: 1, m: 2, s: -3 }, 1); // W 차원
  assert.equal(out[0].sym, 'W');
  const hp = out.find((r) => r.sym === 'hp');
  assert.ok(hp);
  const wi = out.findIndex((r) => r.sym === 'W');
  const hi = out.findIndex((r) => r.sym === 'hp');
  assert.ok(wi < hi, 'W가 hp보다 먼저');
});

test('merge: 차원이 일치하는 단위가 없으면 빈 배열', () => {
  assert.deepEqual(mergeUnits({ kg: 1, m: 1, s: -1, mol: 3 }, 1), []);
});

// ── formatDim ────────────────────────────────────────────────
test('formatDim: 표준 순서 + 위첨자', () => {
  assert.equal(formatDim({ kg: 1, m: 1, s: -2 }), 'kg·m·s⁻²');
  assert.equal(formatDim({ s: -2, m: 1, kg: 1 }), 'kg·m·s⁻²'); // 순서 무관 입력
  assert.equal(formatDim({ m: -3 }), 'm⁻³');
  assert.equal(formatDim({ s: 1 }), 's');
  assert.equal(formatDim({ s: -1 }), 's⁻¹');
  assert.equal(formatDim({}), '1');
});

test('formatDim: 다자리/복합 지수', () => {
  assert.equal(formatDim({ m: 2 }), 'm²');
  assert.equal(formatDim({ s: 12 }), 's¹²');
  assert.equal(formatDim({ A: -2 }), 'A⁻²');
});

// ── formatValue ──────────────────────────────────────────────
test('formatValue: 정수·소수 기본', () => {
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue(1), '1');
  assert.equal(formatValue(1000), '1000');
  assert.equal(formatValue(-2), '-2');
  assert.equal(formatValue(0.00001), '0.00001');
  assert.equal(formatValue(133.322), '133.322');
});

test('formatValue: 지수 표기 경계', () => {
  assert.equal(formatValue(1e-5), '0.00001');
  assert.match(formatValue(1.5e-19), /e-19$/);
  assert.match(formatValue(6.02e23), /e\+23$/);
});

test('formatValue: 부동소수점 잡음 제거', () => {
  assert.equal(formatValue(0.1 + 0.2), '0.3');
  assert.equal(formatValue(1 / 3), '0.333333');
});

test('formatValue: Infinity/NaN 방어', () => {
  assert.equal(formatValue(Infinity), '—');
  assert.equal(formatValue(NaN), '—');
});

// ── prefixedValue ────────────────────────────────────────────
test('prefixedValue: 1500 N → 1.5 kN', () => {
  assert.deepEqual(prefixedValue(1500, 'N'), { sym: 'kN', value: '1.5' });
});

test('prefixedValue: 3.6e6 Wh → 3.6 MWh (공학용 3승 간격 접두사)', () => {
  assert.deepEqual(prefixedValue(3.6e6, 'Wh'), { sym: 'MWh', value: '3.6' });
});

test('prefixedValue: 0.001 m → 1 mm', () => {
  assert.deepEqual(prefixedValue(0.001, 'm'), { sym: 'mm', value: '1' });
});

test('prefixedValue: 0.5 s → 500 ms', () => {
  assert.deepEqual(prefixedValue(0.5, 's'), { sym: 'ms', value: '500' });
});

test('prefixedValue: kg에는 접두사를 붙이지 않는다', () => {
  assert.deepEqual(prefixedValue(1500, 'kg'), { sym: 'kg', value: '1500' });
});

test('prefixedValue: 1은 그대로', () => {
  assert.deepEqual(prefixedValue(1, 'N'), { sym: 'N', value: '1' });
});

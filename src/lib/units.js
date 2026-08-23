// ============================================================
// units — 물리량 단위 분해·병합 코어 로직
// ------------------------------------------------------------
// · lookupUnit/decomposeUnit : 심볼(또는 접두사+심볼) → 기저 차원 {kg,m,s,A,K,mol,cd}
// · parseUnitExpr           : "kg·m/s²", "N·m", "kg m s^-2" → { factor, dim }
// · mergeUnits              : 기저 차원 → 이름 붙은 단위 목록 (환산값 포함)
// · formatDim / formatValue / prefixedValue : 표시 헬퍼
// ============================================================

// ── SI 기본 단위 ─────────────────────────────────────────────
export const BASE_UNITS = [
  { sym: 'kg', name: 'kilogram' },
  { sym: 'm',  name: 'metre' },
  { sym: 's',  name: 'second' },
  { sym: 'A',  name: 'ampere' },
  { sym: 'K',  name: 'kelvin' },
  { sym: 'mol', name: 'mole' },
  { sym: 'cd', name: 'candela' },
];

// ── SI 접두사 (전체 범위 — 조회용) ─────────────────────────────
export const SI_PREFIXES = [
  { sym: 'y',  factor: 1e-24 }, { sym: 'z', factor: 1e-21 }, { sym: 'a', factor: 1e-18 },
  { sym: 'f',  factor: 1e-15 }, { sym: 'p', factor: 1e-12 }, { sym: 'n', factor: 1e-9 },
  { sym: 'µ',  factor: 1e-6 },  { sym: 'u', factor: 1e-6 },  { sym: 'm', factor: 1e-3 },
  { sym: 'c',  factor: 1e-2 },  { sym: 'd', factor: 1e-1 },  { sym: 'da', factor: 1e1 },
  { sym: 'h',  factor: 1e2 },   { sym: 'k', factor: 1e3 },   { sym: 'M', factor: 1e6 },
  { sym: 'G',  factor: 1e9 },   { sym: 'T', factor: 1e12 },  { sym: 'P', factor: 1e15 },
  { sym: 'E',  factor: 1e18 },  { sym: 'Z', factor: 1e21 },  { sym: 'Y', factor: 1e24 },
];

// 공학용 3승 간격 접두사 — prefixedValue(병합 결과 표시) 전용
const ENG_PREFIXES = SI_PREFIXES.filter((p) => {
  const e = Math.log10(p.factor);
  return Math.abs(e % 3) < 1e-9 && !['u', 'c', 'd', 'da', 'h'].includes(p.sym);
}).sort((a, b) => b.factor - a.factor);

// ── 파생/관용 단위 ─────────────────────────────────────────────
// dim: 기저 단위 지수 맵, factor: 1 기저(또는 해당 표현) 기준 환산값
export const UNITS = [
  { sym: 'rad', name: 'radian',       dim: {},                              factor: 1,                 kind: 'derived', si: true },
  { sym: 'sr',  name: 'steradian',    dim: {},                              factor: 1,                 kind: 'derived', si: true },
  { sym: 'Hz',  name: 'hertz',        dim: { s: -1 },                       factor: 1,                 kind: 'derived', si: true },
  { sym: 'N',   name: 'newton',       dim: { kg: 1, m: 1, s: -2 },          factor: 1,                 kind: 'derived', si: true },
  { sym: 'Pa',  name: 'pascal',       dim: { kg: 1, m: -1, s: -2 },         factor: 1,                 kind: 'derived', si: true },
  { sym: 'J',   name: 'joule',        dim: { kg: 1, m: 2, s: -2 },          factor: 1,                 kind: 'derived', si: true },
  { sym: 'W',   name: 'watt',         dim: { kg: 1, m: 2, s: -3 },          factor: 1,                 kind: 'derived', si: true },
  { sym: 'C',   name: 'coulomb',      dim: { s: 1, A: 1 },                  factor: 1,                 kind: 'derived', si: true },
  { sym: 'V',   name: 'volt',         dim: { kg: 1, m: 2, s: -3, A: -1 },   factor: 1,                 kind: 'derived', si: true },
  { sym: 'F',   name: 'farad',        dim: { kg: -1, m: -2, s: 4, A: 2 },   factor: 1,                 kind: 'derived', si: true },
  { sym: 'Ω',   name: 'ohm',          dim: { kg: 1, m: 2, s: -3, A: -2 },   factor: 1,                 kind: 'derived', si: true },
  { sym: 'S',   name: 'siemens',      dim: { kg: -1, m: -2, s: 3, A: 2 },   factor: 1,                 kind: 'derived', si: true },
  { sym: 'Wb',  name: 'weber',        dim: { kg: 1, m: 2, s: -2, A: -1 },   factor: 1,                 kind: 'derived', si: true },
  { sym: 'T',   name: 'tesla',        dim: { kg: 1, s: -2, A: -1 },         factor: 1,                 kind: 'derived', si: true },
  { sym: 'H',   name: 'henry',        dim: { kg: 1, m: 2, s: -2, A: -2 },   factor: 1,                 kind: 'derived', si: true },
  { sym: 'lm',  name: 'lumen',        dim: { cd: 1 },                       factor: 1,                 kind: 'derived', si: true },
  { sym: 'lx',  name: 'lux',          dim: { m: -2, cd: 1 },                factor: 1,                 kind: 'derived', si: true },
  { sym: 'Bq',  name: 'becquerel',    dim: { s: -1 },                       factor: 1,                 kind: 'derived', si: true },
  { sym: 'Gy',  name: 'gray',         dim: { m: 2, s: -2 },                 factor: 1,                 kind: 'derived', si: true },
  { sym: 'Sv',  name: 'sievert',      dim: { m: 2, s: -2 },                 factor: 1,                 kind: 'derived', si: true },
  { sym: 'kat', name: 'katal',        dim: { s: -1, mol: 1 },               factor: 1,                 kind: 'derived', si: true },
  // 관용/비SI 단위
  { sym: 'min',  name: 'minute',                 dim: { s: 1 },            factor: 60,         kind: 'common' },
  { sym: 'h',    name: 'hour',                   dim: { s: 1 },            factor: 3600,       kind: 'common' },
  { sym: 'day',  name: 'day',                    dim: { s: 1 },            factor: 86400,      kind: 'common' },
  { sym: 'L',    name: 'litre',                  dim: { m: 3 },            factor: 1e-3,       kind: 'common' },
  { sym: 'mL',   name: 'millilitre',             dim: { m: 3 },            factor: 1e-6,       kind: 'common' },
  { sym: 'Å',    name: 'ångström',               dim: { m: 1 },            factor: 1e-10,      kind: 'common' },
  { sym: 't',    name: 'tonne',                  dim: { kg: 1 },           factor: 1e3,        kind: 'common' },
  { sym: 'dyn',  name: 'dyne',                   dim: { kg: 1, m: 1, s: -2 },  factor: 1e-5,   kind: 'common' },
  { sym: 'erg',  name: 'erg',                    dim: { kg: 1, m: 2, s: -2 },  factor: 1e-7,   kind: 'common' },
  { sym: 'eV',   name: 'electronvolt',           dim: { kg: 1, m: 2, s: -2 },  factor: 1.602176634e-19, kind: 'common' },
  { sym: 'cal',  name: 'calorie',                dim: { kg: 1, m: 2, s: -2 },  factor: 4.184,  kind: 'common' },
  { sym: 'kcal', name: 'kilocalorie',            dim: { kg: 1, m: 2, s: -2 },  factor: 4184,   kind: 'common' },
  { sym: 'Wh',   name: 'watt-hour',              dim: { kg: 1, m: 2, s: -2 },  factor: 3600,   kind: 'common' },
  { sym: 'bar',  name: 'bar',                    dim: { kg: 1, m: -1, s: -2 }, factor: 1e5,    kind: 'common' },
  { sym: 'atm',  name: 'standard atmosphere',    dim: { kg: 1, m: -1, s: -2 }, factor: 101325, kind: 'common' },
  { sym: 'Torr', name: 'torr',                   dim: { kg: 1, m: -1, s: -2 }, factor: 133.32236842105263, kind: 'common' },
  { sym: 'mmHg', name: 'millimetre of mercury',  dim: { kg: 1, m: -1, s: -2 }, factor: 133.322387415, kind: 'common' },
  { sym: 'hp',   name: 'horsepower (metric)',    dim: { kg: 1, m: 2, s: -3 },  factor: 735.49875, kind: 'common' },
];

// ── 내부: 기본 단위를 같은 모양으로 정규화 ─────────────────────
const ALL = [
  ...BASE_UNITS.map((b) => ({ sym: b.sym, name: b.name, dim: { [b.sym]: 1 }, factor: 1, kind: 'base', si: true })),
  ...UNITS,
];

const PREFIX_SORTED = [...SI_PREFIXES].sort((a, b) => b.sym.length - a.sym.length);

const DIM_ORDER = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'];

const SUP_DIGITS = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const SUP_INPUT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

function normalizeDim(dim) {
  const out = {};
  for (const [b, e] of Object.entries(dim || {})) {
    if (e !== 0) out[b] = e;
  }
  return out;
}

function dimsEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// ── 심볼 조회 (정확 일치 → 접두사 분해) ─────────────────────────
export function lookupUnit(sym) {
  if (typeof sym !== 'string' || !sym.trim()) return null;
  const s = sym.trim();
  const exact = ALL.find((u) => u.sym === s);
  if (exact) return { ...exact, prefixFactor: 1 };
  for (const p of PREFIX_SORTED) {
    if (s.startsWith(p.sym) && s.length > p.sym.length) {
      const rest = s.slice(p.sym.length);
      const u = ALL.find((x) => x.sym === rest);
      if (u) {
        return {
          sym: s,
          baseSym: u.sym,
          name: u.name,
          dim: u.dim,
          kind: u.kind,
          si: u.si,
          factor: u.factor * p.factor,
          prefixFactor: p.factor,
        };
      }
    }
  }
  return null;
}

export function decomposeUnit(sym) {
  return lookupUnit(sym);
}

// ── 유니코드 위첨자를 ^exp 표기로 정규화 ────────────────────────
function normalizeSuperscripts(s) {
  let out = '', pending = null;
  for (const ch of s) {
    if (ch === '⁻') { pending = '-'; continue; }
    if (SUP_INPUT[ch] !== undefined) {
      if (ch === '⁻') { pending = '-'; continue; }
      pending = (pending == null ? '' : pending) + SUP_INPUT[ch];
      continue;
    }
    if (pending != null) { out += '^' + pending; pending = null; }
    out += ch;
  }
  if (pending != null) out += '^' + pending;
  return out;
}

// ── 식 파싱: "kg·m/s²", "N m", "kg m s^-2" ────────────────────
// 구분자: · * × / 공백. "/" 이후의 모든 항은 분모(지수 부호 반전).
export function parseUnitExpr(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('empty expression');
  }
  const norm = normalizeSuperscripts(input.trim());
  const parts = norm.split(/([·*×/]+|\s+)/).filter((p) => p.trim() !== '');
  const dim = {};
  let factor = 1;
  let inverse = false;
  let sawToken = false;

  for (const part of parts) {
    if (/^[·*×]+$/.test(part)) continue;
    if (part === '/') { inverse = true; continue; }

    let name, exp = 1;
    if (part.includes('^')) {
      const em = part.match(/\^(-?\d+)$/);
      if (!em) throw new Error(`invalid exponent in '${part}'`);
      exp = parseInt(em[1], 10);
      name = part.slice(0, em.index);
    } else {
      name = part;
    }
    if (!name) throw new Error(`unknown unit in '${part}'`);
    if (inverse) exp = -exp;

    const u = lookupUnit(name);
    if (!u) throw new Error(`unknown unit '${name}'`);
    for (const [b, e] of Object.entries(u.dim)) dim[b] = (dim[b] || 0) + e * exp;
    factor *= Math.pow(u.factor, exp);
    sawToken = true;
  }

  if (!sawToken) {
    throw new Error('no units found');
  }
  if (parts[parts.length - 1] === '/') throw new Error('expression ends with /');
  return { factor, dim: normalizeDim(dim) };
}

// ── 병합: 기저 차원 → 이름 붙은 단위 목록 ───────────────────────
export function mergeUnits(dim, factor = 1) {
  const norm = normalizeDim(dim);
  const out = [];
  for (const u of ALL) {
    if (!dimsEqual(norm, u.dim)) continue;
    const value = factor / u.factor;
    if (!Number.isFinite(value)) continue;
    out.push({
      sym: u.sym,
      name: u.name,
      value,
      si: !!u.si,
      kind: u.kind,
    });
  }
  // SI 파생 → SI 기본 → 관용 순, 같은 계열은 1에 가까운 환산값 우선
  const kindRank = (k, si) => (si ? (k === 'derived' ? 0 : 1) : 2);
  out.sort((a, b) => {
    const ra = kindRank(a.kind, a.si), rb = kindRank(b.kind, b.si);
    if (ra !== rb) return ra - rb;
    const va = Math.abs(Math.log10(Math.abs(a.value) || 1e-300));
    const vb = Math.abs(Math.log10(Math.abs(b.value) || 1e-300));
    if (va !== vb) return va - vb;
    return a.sym.localeCompare(b.sym);
  });
  return out;
}

// ── 표시 헬퍼 ─────────────────────────────────────────────────
function toSup(n) {
  let out = '';
  for (const ch of String(n)) out += SUP_DIGITS[ch] || ch;
  return out;
}

export function formatDim(dim) {
  const parts = [];
  for (const b of DIM_ORDER) {
    const e = dim && dim[b];
    if (!e) continue;
    parts.push(e === 1 ? b : b + toSup(e));
  }
  return parts.length ? parts.join('·') : '1';
}

export function formatValue(n) {
  if (!Number.isFinite(n)) return '—';
  if (Object.is(n, -0)) n = 0;
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e12 || a < 1e-6) {
    return n.toExponential(4).replace(/\.?0+e/, 'e');
  }
  return String(Number(n.toPrecision(6)));
}

// 공학용 3승 간격 접두사로 값에 가장 잘 맞는 표현 찾기
export function prefixedValue(value, sym) {
  if (!Number.isFinite(value) || value === 0 || sym === 'kg') {
    return { sym, value: formatValue(value) };
  }
  const a = Math.abs(value);
  let bestF = 0, bestSym = sym;
  for (const p of ENG_PREFIXES) {
    const mant = a / p.factor;
    if (mant >= 1 && mant < 1000 && p.factor > bestF) {
      bestF = p.factor;
      bestSym = p.sym + sym;
    }
  }
  return { sym: bestSym, value: formatValue(bestF > 0 ? value / bestF : value) };
}

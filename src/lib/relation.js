// ============================================================
// relation — Relation Analyzer 코어 로직
// ------------------------------------------------------------
// · analyzePoint   : 한 지점에서 부호·탄력성·곡률 + 자연어 해석
// · findZeros      : 수치 근 탐색 (샘플링 + 이분법)
// · classifyCritical : f'' 부호 → 극대/극소/변곡형
// · analyzeRange   : 구간 프로파일 — 단조 구간·임계점·변곡점
// ============================================================
import { formatValue } from './units.js';

const TOL = 1e-9;

// ── 변수 이름 검증 — mathjs 식별자와 호환되는 규칙 ─────────────
export function validateVarName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// 자연어 이름 표기 — "Total Duration (t)", 이름이 없으면 "t"
export function variableLabel(sym, name) {
  const n = name && String(name).trim();
  return n ? `${n} (${sym})` : sym;
}

// ── 한 지점 해석 ──────────────────────────────────────────────
export function analyzePoint({ a, b, slope, curvature = 0 }, labels = {}) {
  const labelA = variableLabel(labels.varA || 'A', labels.nameA);
  const labelB = variableLabel(labels.varB || 'B', labels.nameB);
  const sign = slope > TOL ? 'positive' : slope < -TOL ? 'negative' : 'zero';
  const curvatureClass = curvature > TOL ? 'convex' : curvature < -TOL ? 'concave' : 'linear';

  let elasticity = null;
  let elasticityClass = null;
  if (Math.abs(b) > TOL) {
    elasticity = (slope * a) / b;
    if (Math.abs(slope) <= TOL) elasticityClass = 'zero';
    else if (Math.abs(elasticity - 1) < 1e-2) elasticityClass = 'proportional';
    else if (Math.abs(elasticity + 1) < 1e-2) elasticityClass = 'inverse-proportional';
    else if (Math.abs(elasticity) > 1 + 1e-2) elasticityClass = 'elastic';
    else if (Math.abs(Math.abs(elasticity) - 1) < 1e-2) elasticityClass = 'unitary';
    else elasticityClass = 'inelastic';
  }

  const sentence = buildSentence({ sign, elasticity, elasticityClass, curvatureClass, labelA, labelB });
  return { sign, elasticity, elasticityClass, curvatureClass, sentence };
}

function buildSentence({ sign, elasticity, elasticityClass, curvatureClass, labelA, labelB }) {
  if (sign === 'zero') {
    if (curvatureClass === 'convex') return `${labelB} is stationary here — this is a local minimum.`;
    if (curvatureClass === 'concave') return `${labelB} is stationary here — this is a local maximum.`;
    return `${labelB} is stationary here — the slope is zero (flat).`;
  }

  const parts = [];
  parts.push(sign === 'positive' ? `${labelB} increases as ${labelA} grows.` : `${labelB} decreases as ${labelA} grows.`);

  if (elasticity == null) {
    parts.push(`${labelB} passes through zero here — elasticity is undefined.`);
  } else {
    const pct = formatValue(Math.abs(elasticity) * 100);
    switch (elasticityClass) {
      case 'proportional':
        parts.push(`ε = 1 — ${labelB} is proportional to ${labelA} (a 1% rise in ${labelA} lifts ${labelB} by 1%).`);
        break;
      case 'inverse-proportional':
        parts.push(`ε = −1 — ${labelB} is inversely proportional to ${labelA}.`);
        break;
      case 'elastic':
        parts.push(`ε = ${formatValue(elasticity)} — elastic: a 1% rise in ${labelA} moves ${labelB} by ${pct}%.`);
        break;
      case 'inelastic':
        parts.push(`ε = ${formatValue(elasticity)} — inelastic: a 1% rise in ${labelA} moves ${labelB} by only ${pct}%.`);
        break;
      case 'unitary':
        parts.push(`ε = ${formatValue(elasticity)} — about a 1:1 response.`);
        break;
      case 'zero':
        parts.push(`ε ≈ 0 — ${labelB} barely responds to ${labelA}.`);
        break;
      default:
        parts.push(`ε = ${formatValue(elasticity)}.`);
    }
  }

  if (curvatureClass === 'convex') parts.push('The change is accelerating.');
  else if (curvatureClass === 'concave') parts.push('Diminishing returns — the effect saturates.');
  else if (sign !== 'zero') parts.push('The relation is linear around this point.');

  return parts.join(' ');
}

// ── 수치 근 탐색 ─────────────────────────────────────────────
export function findZeros(fn, a, b, n = 1000) {
  if (a > b) [a, b] = [b, a];
  const h = (b - a) / n;
  const roots = [];
  const pushRoot = (x) => {
    if (!roots.length || Math.abs(x - roots[roots.length - 1]) > h * 0.5) roots.push(x);
  };

  let prev = fn(a);
  if (Math.abs(prev) < TOL) pushRoot(a);

  for (let i = 1; i <= n; i++) {
    const x = i === n ? b : a + i * h;
    const cur = fn(x);
    if (!Number.isFinite(cur)) { prev = cur; continue; }
    if (Math.abs(cur) < TOL) {
      pushRoot(x);
    } else if (Number.isFinite(prev) && prev * cur < 0) {
      // 부호 변화 → 이분법
      let lo = i === 1 ? a : a + (i - 1) * h, hi = x;
      let flo = fn(lo);
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        const fm = fn(mid);
        if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
      }
      pushRoot((lo + hi) / 2);
    }
    prev = cur;
  }
  if (Math.abs(fn(b)) < TOL) pushRoot(b);
  return roots;
}

// ── 임계점 분류 ──────────────────────────────────────────────
export function classifyCritical(fppAt) {
  if (fppAt > TOL) return 'min';
  if (fppAt < -TOL) return 'max';
  return 'flat';
}

// ── 구간 프로파일 ────────────────────────────────────────────
export function analyzeRange(f, fp, fpp, a, b, n = 1000) {
  if (a > b) [a, b] = [b, a];
  const eps = (b - a) / n;

  const interior = (xs) => xs.filter((x) => x > a + eps && x < b - eps);

  const roots = interior(findZeros(fp, a, b, n));
  const breaks = [a, ...roots, b];
  const intervals = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    const mid = (breaks[i] + breaks[i + 1]) / 2;
    const s = fp(mid);
    const sign = s > TOL ? 'positive' : s < -TOL ? 'negative' : 'zero';
    const last = intervals[intervals.length - 1];
    if (last && last.sign === sign) last.to = breaks[i + 1];
    else intervals.push({ from: breaks[i], to: breaks[i + 1], sign });
  }

  const critical = roots.map((x) => ({ x, kind: classifyCritical(fpp(x)) }));
  const inflections = interior(findZeros(fpp, a, b, n));

  return { intervals, critical, inflections };
}

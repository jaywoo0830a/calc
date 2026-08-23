import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parse } from 'mathjs';
import { analyzePoint, analyzeRange, validateVarName } from '../lib/relation.js';
import {
  parseUnitExpr,
  formatDim,
  quotientDim,
  substituteDim,
  formatSubstitution,
  activeAliases,
  formatValue,
} from '../lib/units.js';

// ── Relation Analyzer — B(A)의 부호·탄력성·곡률 해석 ────────────
// · 한 지점: dB/dA 부호, 무차원 탄력성 ε = (A/B)(dB/dA), 곡률
// · 구간: 단조 구간 / 극대·극소 / 변곡점 프로파일
// · 단위: dB/dA의 단위 [b/a]를 Units 엔진으로 분해 + 별칭 치환

function loadAliases() {
  try {
    const raw = JSON.parse(localStorage.getItem('units_aliases') || '[]');
    return Array.isArray(raw) ? raw.map((a) => ({ ...a, enabled: !!a.enabled })) : [];
  } catch { return []; }
}

const fmt = (n) => (Number.isFinite(n) ? formatValue(n) : '—');

// ── 미니 SVG 곡선 차트 ─────────────────────────────────────────
function CurveChart({ f, a, b, aCur, color }) {
  const W = 360, H = 130, PX = 10, PY = 10;
  const pts = useMemo(() => {
    const out = [];
    let min = Infinity, max = -Infinity;
    const n = 120;
    for (let i = 0; i <= n; i++) {
      const x = a + ((b - a) * i) / n;
      const y = f(x);
      if (!Number.isFinite(y)) continue;
      out.push([x, y]);
      if (y < min) min = y;
      if (y > max) max = y;
    }
    if (!Number.isFinite(min)) { min = -1; max = 1; }
    if (max - min < 1e-9) { max = min + 1; min = min - 1; }
    return { pts: out, min, max };
  }, [f, a, b]);
  const px = (x) => PX + ((x - a) / (b - a)) * (W - 2 * PX);
  const py = (y) => PY + (1 - (y - pts.min) / (pts.max - pts.min)) * (H - 2 * PY);
  const poly = pts.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(' ');
  const cy = Number.isFinite(f(aCur)) ? py(f(aCur)) : null;
  return (
    <svg className="relation__chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      <line x1={PX} y1={py(0)} x2={W - PX} y2={py(0)} className="relation__axis" />
      <path d={poly} className="relation__curve" style={{ stroke: color }} />
      {cy != null && <circle cx={px(aCur)} cy={cy} r={3.5} className="relation__dot" />}
    </svg>
  );
}

export default function Relation() {
  const [expr, setExpr] = useState('A^2');
  const [varA, setVarA] = useState('A');
  const [varB, setVarB] = useState('B');
  const [nameA, setNameA] = useState('');
  const [nameB, setNameB] = useState('');
  const [aMin, setAMin] = useState(-2);
  const [aMax, setAMax] = useState(2);
  const [aCur, setACur] = useState(0.5);
  const [unitA, setUnitA] = useState('');
  const [unitB, setUnitB] = useState('');
  const [aliases] = useState(loadAliases);

  const lo = Math.min(aMin, aMax), hi = Math.max(aMin, aMax);
  const cur = Math.min(hi, Math.max(lo, aCur));

  const nameError = useMemo(() => {
    if (!validateVarName(varA)) return `Variable name '${varA}' is invalid — use letters, digits, _ (starting with a letter or _).`;
    if (!validateVarName(varB)) return `Variable name '${varB}' is invalid — use letters, digits, _ (starting with a letter or _).`;
    if (varA === varB) return 'Variable names must differ.';
    return null;
  }, [varA, varB]);

  // B(A) 및 수치 도함수
  const compiled = useMemo(() => {
    try {
      const node = parse(expr);
      const f = (x) => {
        try { return node.evaluate({ [varA]: x }); } catch { return NaN; }
      };
      const h1 = (x) => 1e-5 * Math.max(1, Math.abs(x));
      const fp = (x) => {
        const h = h1(x);
        return (f(x + h) - f(x - h)) / (2 * h);
      };
      const fpp = (x) => {
        const h = 1e-3 * Math.max(1, Math.abs(x));
        return (f(x + h) - 2 * f(x) + f(x - h)) / (h * h);
      };
      return { f, fp, fpp, error: null };
    } catch (e) {
      return { f: () => NaN, fp: () => NaN, fpp: () => NaN, error: e.message };
    }
  }, [expr, varA]);

  const point = useMemo(() => {
    const { f, fp, fpp } = compiled;
    const b = f(cur);
    const slope = fp(cur);
    const curvature = fpp(cur);
    if (!Number.isFinite(b) || !Number.isFinite(slope) || !Number.isFinite(curvature)) return null;
    return analyzePoint({ a: cur, b, slope, curvature }, { varA, varB, nameA, nameB });
  }, [compiled, cur, varA, varB, nameA, nameB]);

  const range = useMemo(() => {
    try {
      return analyzeRange(compiled.f, compiled.fp, compiled.fpp, lo, hi, 300);
    } catch {
      return null;
    }
  }, [compiled, lo, hi]);

  // dB/dA의 단위 [b/a]
  const unitInfo = useMemo(() => {
    try {
      const dimA = unitA.trim() ? parseUnitExpr(unitA).dim : {};
      const dimB = unitB.trim() ? parseUnitExpr(unitB).dim : {};
      const q = quotientDim(dimB, dimA);
      const base = formatDim(q);
      const { terms, remainder } = substituteDim(q, activeAliases(aliases));
      const alias = terms.length ? formatSubstitution(terms, remainder) : '';
      return { base, alias, error: null };
    } catch (e) {
      return { base: '', alias: '', error: e.message };
    }
  }, [unitA, unitB, aliases]);

  const SIGN_ICON = { positive: '↗', negative: '↘', zero: '→' };

  return (
    <main className="relation">
      <nav className="calculator__nav">
        <Link to="/" className="calculator__nav-tab">Calc</Link>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <Link to="/math" className="calculator__nav-tab">Math Space</Link>
        <Link to="/fields" className="calculator__nav-tab">Fields</Link>
        <Link to="/units" className="calculator__nav-tab">Units</Link>
        <span className="calculator__nav-tab calculator__nav-tab--active">Relation</span>
        <Link to="/problems" className="calculator__nav-tab">Problems</Link>
        <Link to="/vocab" className="calculator__nav-tab">Vocab</Link>
      </nav>

      <div className="relation__head">
        <h1 className="relation__title">🔗 Relation Analyzer</h1>
        <p className="relation__subtitle">
          See how B responds to A — sign, dimensionless elasticity, curvature, and the unit of dB/dA.
        </p>
      </div>

      <div className="relation__panel">
        <div className="relation__form">
          <label className="relation__field">
            <span>{varB}({varA}) =</span>
            <input className="relation__input" type="text" spellCheck={false} value={expr} onChange={(e) => setExpr(e.target.value)} />
          </label>
          <label className="relation__field">
            <span>Variables</span>
            <span className="relation__domain">
              <input className="relation__unit" type="text" value={varA} onChange={(e) => setVarA(e.target.value)} title={`Input variable — appears in the expression as ${varA || '?'}`} />
              <em>→</em>
              <input className="relation__unit" type="text" value={varB} onChange={(e) => setVarB(e.target.value)} title="Output variable" />
            </span>
            <span className="relation__domain">
              <input className="relation__unit" type="text" placeholder="name (e.g. Constant Car Speed)" value={nameA} onChange={(e) => setNameA(e.target.value)} title="Natural-language name for the input variable" />
              <em>→</em>
              <input className="relation__unit" type="text" placeholder="name (e.g. Total Duration)" value={nameB} onChange={(e) => setNameB(e.target.value)} title="Natural-language name for the output variable" />
            </span>
          </label>
          <label className="relation__field">
            <span>Domain</span>
            <span className="relation__domain">
              <input className="relation__num" type="number" value={aMin} onChange={(e) => setAMin(parseFloat(e.target.value))} />
              <em>…</em>
              <input className="relation__num" type="number" value={aMax} onChange={(e) => setAMax(parseFloat(e.target.value))} />
            </span>
          </label>
          <label className="relation__field">
            <span>Units</span>
            <span className="relation__domain">
              <input className="relation__unit" type="text" placeholder={`[${varA}] e.g. m`} value={unitA} onChange={(e) => setUnitA(e.target.value)} />
              <em>→</em>
              <input className="relation__unit" type="text" placeholder={`[${varB}] e.g. m/s`} value={unitB} onChange={(e) => setUnitB(e.target.value)} />
            </span>
          </label>
        </div>
        {nameError && <p className="relation__error">{nameError}</p>}
        {compiled.error && <p className="relation__error">Expression error — {compiled.error}</p>}
        {unitInfo.error && <p className="relation__error">Unit error — {unitInfo.error}</p>}
        {!compiled.error && !nameError && !point && <p className="relation__error">No result — check that the expression uses “{varA}” and the domain is valid.</p>}
      </div>

      {point && (
        <div className="relation__panel">
          <div className="relation__slider-row">
            <span className="relation__slider-label">{varA} = {fmt(cur)}</span>
            <input
              className="relation__slider"
              type="range"
              min={lo}
              max={hi}
              step={(hi - lo) / 200}
              value={cur}
              onChange={(e) => setACur(parseFloat(e.target.value))}
            />
          </div>

          <div className="relation__grid">
            <div className="relation__card">
              <span className="relation__card-label">{varB}({varA})</span>
              <span className="relation__card-value">{fmt(compiled.f(cur))}</span>
            </div>
            <div className="relation__card">
              <span className="relation__card-label">d{varB}/d{varA} {SIGN_ICON[point.sign]}</span>
              <span className="relation__card-value">{fmt(compiled.fp(cur))}</span>
              {unitInfo.base && (
                <span className="relation__card-unit">
                  [{unitInfo.base}]{unitInfo.alias && <em className="relation__via"> = {unitInfo.alias}</em>}
                </span>
              )}
            </div>
            <div className="relation__card">
              <span className="relation__card-label">Elasticity ε</span>
              <span className="relation__card-value">{point.elasticity == null ? '—' : fmt(point.elasticity)}</span>
              <span className="relation__card-unit">{point.elasticityClass ?? 'undefined (B = 0)'}</span>
            </div>
            <div className="relation__card">
              <span className="relation__card-label">Curvature</span>
              <span className="relation__card-value">{fmt(compiled.fpp(cur))}</span>
              <span className="relation__card-unit">{point.curvatureClass}</span>
            </div>
          </div>

          <p className="relation__sentence">{point.sentence}</p>
        </div>
      )}

      {range && (
        <div className="relation__panel">
          <p className="relation__section">Monotonic intervals</p>
          <div className="relation__chips">
            {range.intervals.map((iv, i) => (
              <span key={i} className={'relation__chip relation__chip--' + iv.sign}>
                {iv.sign === 'positive' ? '↗' : iv.sign === 'negative' ? '↘' : '→'} [{fmt(iv.from)}, {fmt(iv.to)}]
              </span>
            ))}
          </div>
          {(range.critical.length > 0 || range.inflections.length > 0) && (
            <div className="relation__landmarks">
              {range.critical.map((c, i) => (
                <span key={'c' + i} className="relation__chip">
                  {c.kind === 'min' ? '▼ min' : c.kind === 'max' ? '▲ max' : '— flat'} at A = {fmt(c.x)}
                </span>
              ))}
              {range.inflections.map((x, i) => (
                <span key={'i' + i} className="relation__chip">∿ inflection at A = {fmt(x)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="relation__panel">
        <p className="relation__section">{varB}({varA})</p>
        <CurveChart f={compiled.f} a={lo} b={hi} aCur={cur} color="#5c3d2e" />
        <p className="relation__section">d{varB}/d{varA}</p>
        <CurveChart f={compiled.fp} a={lo} b={hi} aCur={cur} color="#3d5a80" />
      </div>
    </main>
  );
}

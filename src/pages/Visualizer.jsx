import { useState, useCallback, useRef, useEffect } from 'react';
import { create, all } from 'mathjs';
import Plotly from 'plotly.js-dist-min';

// ── math.js instance ─────────────────────────────────────────────────────────
const math = create(all, { number: 'number', precision: 15 });

function compileExpr(expr) {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('Empty expression');
  try {
    return math.parse(trimmed).compile();
  } catch (e) {
    throw new Error(e.message.replace(/Value expected \(char \d+\)/g, 'Syntax error').replace(/Undefined symbol (\w+)/g, 'Unknown: "$1"'));
  }
}

// ── Space definitions ────────────────────────────────────────────────────────
const SPACES = [
  { id: 'cartesian',    label: '2D Cartesian',    icon: '📈', inputs: ['y ='],             examples: ['sin(x)', 'x^2, sqrt(x), cos(2x)'] },
  { id: 'polar',        label: 'Polar',            icon: '🌀', inputs: ['r(θ) ='],          examples: ['1+cos(theta)', 'sin(2*theta), 2'] },
  { id: 'parametric2d', label: 'Parametric 2D',    icon: '🔗', inputs: ['x(t) =', 'y(t) ='], examples: ['cos(t)', 'sin(t)'] },
  { id: 'surface3d',    label: '3D Surface',       icon: '🏔️', inputs: ['z = f(x,y)'],      examples: ['sin(x)*cos(y)', 'x^2+y^2', 'sin(sqrt(x^2+y^2))'] },
  { id: 'parametric3d', label: '3D Parametric',    icon: '🎯', inputs: ['x(t)=', 'y(t)=', 'z(t)='], examples: ['cos(t)', 'sin(t)', 't/5'] },
  { id: 'contour',      label: 'Contour',          icon: '🗺️', inputs: ['f(x,y) ='],        examples: ['sin(x)*cos(y)', 'x^2-y^2'] },
];

// ── Plotly theme (academic paper) ────────────────────────────────────────────
const PLOT_THEME = {
  paper_bgcolor: '#fffef7',
  plot_bgcolor: '#f8f4eb',
  font: { family: 'Noto Serif, Times New Roman, serif', color: '#2c2416', size: 12 },
  title: { font: { size: 14 } },
  colorway: ['#5c3d2e', '#3d5a80', '#3d5a40', '#b5433a', '#7a5240', '#4f7255'],
};

const COMMON_LAYOUT = {
  ...PLOT_THEME,
  margin: { l: 50, r: 20, t: 30, b: 40 },
  hovermode: 'closest',
  dragmode: 'pan',
};

// ── Sampling helpers ─────────────────────────────────────────────────────────
function linspace(start, end, n) {
  const arr = new Float64Array(n);
  const step = (end - start) / (n - 1);
  for (let i = 0; i < n; i++) arr[i] = start + step * i;
  return arr;
}

function sample2D(fn, varName, rangeMin, rangeMax, nPts = 500) {
  const xs = linspace(rangeMin, rangeMax, nPts);
  const ys = new Float64Array(nPts);
  for (let i = 0; i < nPts; i++) {
    try {
      const scope = {}; scope[varName] = xs[i];
      ys[i] = fn.evaluate(scope);
      if (!isFinite(ys[i])) ys[i] = NaN;
    } catch { ys[i] = NaN; }
  }
  return { x: Array.from(xs), y: Array.from(ys) };
}

function sampleParametric2D(fnX, fnY, tMin, tMax, nPts = 800) {
  const ts = linspace(tMin, tMax, nPts);
  const xs = new Float64Array(nPts);
  const ys = new Float64Array(nPts);
  for (let i = 0; i < nPts; i++) {
    try {
      xs[i] = fnX.evaluate({ t: ts[i] });
      ys[i] = fnY.evaluate({ t: ts[i] });
      if (!isFinite(xs[i]) || !isFinite(ys[i])) { xs[i] = NaN; ys[i] = NaN; }
    } catch { xs[i] = NaN; ys[i] = NaN; }
  }
  return { x: Array.from(xs), y: Array.from(ys) };
}

function sampleParametric3D(fnX, fnY, fnZ, tMin, tMax, nPts = 1000) {
  const ts = linspace(tMin, tMax, nPts);
  const xs = new Float64Array(nPts);
  const ys = new Float64Array(nPts);
  const zs = new Float64Array(nPts);
  for (let i = 0; i < nPts; i++) {
    try {
      xs[i] = fnX.evaluate({ t: ts[i] });
      ys[i] = fnY.evaluate({ t: ts[i] });
      zs[i] = fnZ.evaluate({ t: ts[i] });
      if (!isFinite(xs[i]) || !isFinite(ys[i]) || !isFinite(zs[i])) { xs[i] = NaN; ys[i] = NaN; zs[i] = NaN; }
    } catch { xs[i] = NaN; ys[i] = NaN; zs[i] = NaN; }
  }
  return { x: Array.from(xs), y: Array.from(ys), z: Array.from(zs) };
}

function sampleSurface(fn, xMin, xMax, yMin, yMax, nx = 60, ny = 60) {
  const xs = linspace(xMin, xMax, nx);
  const ys = linspace(yMin, yMax, ny);
  const zs = [];
  for (let j = 0; j < ny; j++) {
    const row = new Float64Array(nx);
    for (let i = 0; i < nx; i++) {
      try {
        row[i] = fn.evaluate({ x: xs[i], y: ys[j] });
        if (!isFinite(row[i])) row[i] = NaN;
      } catch { row[i] = NaN; }
    }
    zs.push(Array.from(row));
  }
  return { x: Array.from(xs), y: Array.from(ys), z: zs };
}

// ── Component ────────────────────────────────────────────────────────────────
export default function Visualizer() {
  const plotRef = useRef(null);
  const [plotReady, setPlotReady] = useState(false);

  // ── State ──────────────────────────────────────────────────────────────────
  const [space, setSpace] = useState('cartesian');
  const [exprInputs, setExprInputs] = useState(['sin(x)', '']);
  const [error, setError] = useState(null);

  // Range controls
  const [xMin, setXMin] = useState(-5);
  const [xMax, setXMax] = useState(5);
  const [yMin, setYMin] = useState(-5);
  const [yMax, setYMax] = useState(5);
  const [tMin, setTMin] = useState(0);
  const [tMax, setTMax] = useState(Math.PI * 2);
  const [nPts, setNPts] = useState(500);
  const [gridRes, setGridRes] = useState(60);

  // ── Switch space ───────────────────────────────────────────────────────────
  const switchSpace = useCallback((newSpace) => {
    setSpace(newSpace);
    setError(null);
    const sp = SPACES.find((s) => s.id === newSpace);
    if (sp) {
      setExprInputs(sp.examples);
      if (newSpace === 'polar') { setXMin(-3); setXMax(3); setYMin(-3); setYMax(3); }
      else { setXMin(-5); setXMax(5); setYMin(-5); setYMax(5); }
    }
  }, []);

  // ── Build Plotly data ──────────────────────────────────────────────────────
  const buildPlotData = useCallback(() => {
    const traces = [];
    const parseMulti = (input) => (input || '').split(',').map((s) => s.trim()).filter(Boolean);

    try {
      switch (space) {
        case 'cartesian': {
          for (const expr of parseMulti(exprInputs[0])) {
            const fn = compileExpr(expr);
            const { x, y } = sample2D(fn, 'x', xMin, xMax, nPts);
            traces.push({ type: 'scatter', mode: 'lines', x, y, name: expr, line: { width: 2 } });
          }
          break;
        }
        case 'polar': {
          for (const expr of parseMulti(exprInputs[0])) {
            const fn = compileExpr(expr);
            const thetas = linspace(0, Math.PI * 2, nPts);
            const rs = new Float64Array(nPts);
            for (let i = 0; i < nPts; i++) {
              try { rs[i] = fn.evaluate({ theta: thetas[i] }); if (!isFinite(rs[i]) || rs[i] < 0) rs[i] = NaN; }
              catch { rs[i] = NaN; }
            }
            traces.push({ type: 'scatterpolar', mode: 'lines', theta: Array.from(thetas), r: Array.from(rs), name: expr, line: { width: 2 } });
          }
          break;
        }
        case 'parametric2d': {
          const exprsX = parseMulti(exprInputs[0]);
          const exprsY = parseMulti(exprInputs[1]);
          const n = Math.max(exprsX.length, exprsY.length);
          for (let i = 0; i < n; i++) {
            const fnX = compileExpr(exprsX[i] || exprsX[0] || 't');
            const fnY = compileExpr(exprsY[i] || exprsY[0] || 't');
            const { x, y } = sampleParametric2D(fnX, fnY, tMin, tMax, nPts);
            traces.push({ type: 'scatter', mode: 'lines', x, y, name: `(${exprsX[i]||'t'},${exprsY[i]||'t'})`, line: { width: 2 } });
          }
          break;
        }
        case 'surface3d': {
          for (const expr of parseMulti(exprInputs[0])) {
            const fn = compileExpr(expr);
            const { x, y, z } = sampleSurface(fn, xMin, xMax, yMin, yMax, gridRes, gridRes);
            traces.push({ type: 'surface', x, y, z, name: expr, colorscale: 'Earth', contours: { z: { show: true, usecolormap: true, project: { z: true } } } });
          }
          break;
        }
        case 'parametric3d': {
          const fnX = compileExpr(exprInputs[0] || 'cos(t)');
          const fnY = compileExpr(exprInputs[1] || 'sin(t)');
          const fnZ = compileExpr(exprInputs[2] || 't');
          const { x, y, z } = sampleParametric3D(fnX, fnY, fnZ, tMin, tMax, nPts);
          traces.push({ type: 'scatter3d', mode: 'lines', x, y, z, name: `${exprInputs[0]},${exprInputs[1]},${exprInputs[2]}`, line: { width: 4, colorscale: 'Earth' } });
          break;
        }
        case 'contour': {
          for (const expr of parseMulti(exprInputs[0])) {
            const fn = compileExpr(expr);
            const { x, y, z } = sampleSurface(fn, xMin, xMax, yMin, yMax, gridRes, gridRes);
            traces.push({ type: 'contour', x, y, z, name: expr, contours: { coloring: 'heatmap' }, colorscale: 'Earth' });
          }
          break;
        }
      }
    } catch (e) {
      setError(e.message);
      return [];
    }
    setError(null);
    return traces;
  }, [space, exprInputs, xMin, xMax, yMin, yMax, tMin, tMax, nPts, gridRes]);

  // ── Build layout ───────────────────────────────────────────────────────────
  const buildLayout = useCallback(() => {
    const base = { ...COMMON_LAYOUT };

    if (space === 'polar') {
      return { ...base, polar: { radialaxis: { range: [0, Math.max(Math.abs(xMax), Math.abs(yMax), 5)] }, angularaxis: { tickfont: { size: 10 } } } };
    }
    if (space === 'surface3d' || space === 'parametric3d') {
      return { ...base, scene: { xaxis: { title: 'x', range: [xMin, xMax] }, yaxis: { title: 'y', range: [yMin, yMax] }, zaxis: { title: 'z' }, camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } } } };
    }
    if (space === 'contour') {
      return { ...base, xaxis: { title: 'x', range: [xMin, xMax] }, yaxis: { title: 'y', range: [yMin, yMax], scaleanchor: 'x', scaleratio: 1 } };
    }
    return { ...base, xaxis: { title: 'x', range: [xMin, xMax], zeroline: true, zerolinecolor: '#2c2416', gridcolor: '#e5ddcc' }, yaxis: { title: 'y', range: [yMin, yMax], zeroline: true, zerolinecolor: '#2c2416', gridcolor: '#e5ddcc', scaleanchor: 'x', scaleratio: 1 } };
  }, [space, xMin, xMax, yMin, yMax]);

  // ── Render to Plotly ───────────────────────────────────────────────────────
  const renderPlot = useCallback(() => {
    const el = plotRef.current;
    if (!el) return;
    const data = buildPlotData();
    const layout = buildLayout();
    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d', 'sendDataToCloud'],
      displaylogo: false,
      toImageButtonOptions: { format: 'png', filename: 'calc-visualizer' },
    };
    Plotly.react(el, data, layout, config).then(() => setPlotReady(true));
  }, [buildPlotData, buildLayout]);

  // ── Re-render on change (debounced) ────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(renderPlot, 150);
    return () => clearTimeout(timer);
  }, [renderPlot]);

  useEffect(() => {
    const onResize = () => { if (plotRef.current) Plotly.Plots.resize(plotRef.current); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Input handlers ─────────────────────────────────────────────────────────
  const updateInput = useCallback((idx, value) => {
    setExprInputs((prev) => { const next = [...prev]; next[idx] = value; return next; });
    setError(null);
  }, []);

  const spaceDef = SPACES.find((s) => s.id === space);
  const is2D = space === 'cartesian' || space === 'polar' || space === 'parametric2d' || space === 'contour';
  const is3D = space === 'surface3d' || space === 'parametric3d';
  const isParametric = space === 'parametric2d' || space === 'parametric3d';

  return (
    <main className="visualizer" tabIndex={-1}>
      {/* ── Nav ─────────────────────────────────────────── */}
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">Visualizer</span>
      </nav>

      {/* ── Space selector ──────────────────────────────── */}
      <div className="visualizer__spaces">
        {SPACES.map((s) => (
          <button
            key={s.id}
            className={'visualizer__space-btn' + (space === s.id ? ' visualizer__space-btn--active' : '')}
            onClick={() => switchSpace(s.id)}
            title={s.inputs.join(' ')}
          >
            <span className="visualizer__space-icon">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      {/* ── Expression inputs ───────────────────────────── */}
      <div className="visualizer__inputs">
        {spaceDef?.inputs.map((label, i) => (
          <div className="visualizer__input-group" key={i}>
            <label className="visualizer__label">{label}</label>
            <input
              className="visualizer__input"
              type="text"
              value={exprInputs[i] || ''}
              onChange={(e) => updateInput(i, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') renderPlot(); }}
              placeholder={spaceDef.examples[i] || ''}
              spellCheck={false}
              autoCapitalize="off"
            />
          </div>
        ))}
      </div>

      {/* ── Range controls ──────────────────────────────── */}
      <div className="visualizer__ranges">
        {is2D && (
          <>
            <div className="visualizer__range-group">
              <label className="visualizer__label">x ∈ [</label>
              <input className="visualizer__input visualizer__input--small" type="number" value={xMin} onChange={(e) => setXMin(parseFloat(e.target.value) || 0)} step="any" />
              <label className="visualizer__label">,</label>
              <input className="visualizer__input visualizer__input--small" type="number" value={xMax} onChange={(e) => setXMax(parseFloat(e.target.value) || 0)} step="any" />
              <label className="visualizer__label">]</label>
            </div>
            {space !== 'polar' && (
              <div className="visualizer__range-group">
                <label className="visualizer__label">y ∈ [</label>
                <input className="visualizer__input visualizer__input--small" type="number" value={yMin} onChange={(e) => setYMin(parseFloat(e.target.value) || 0)} step="any" />
                <label className="visualizer__label">,</label>
                <input className="visualizer__input visualizer__input--small" type="number" value={yMax} onChange={(e) => setYMax(parseFloat(e.target.value) || 0)} step="any" />
                <label className="visualizer__label">]</label>
              </div>
            )}
          </>
        )}
        {is3D && (
          <>
            <div className="visualizer__range-group">
              <label className="visualizer__label">x,y ∈ [</label>
              <input className="visualizer__input visualizer__input--small" type="number" value={xMin} onChange={(e) => { setXMin(parseFloat(e.target.value)||0); setYMin(parseFloat(e.target.value)||0); }} step="any" />
              <label className="visualizer__label">,</label>
              <input className="visualizer__input visualizer__input--small" type="number" value={xMax} onChange={(e) => { setXMax(parseFloat(e.target.value)||0); setYMax(parseFloat(e.target.value)||0); }} step="any" />
              <label className="visualizer__label">]</label>
            </div>
            <div className="visualizer__range-group">
              <label className="visualizer__label">Res: </label>
              <input className="visualizer__input visualizer__input--small" type="number" value={gridRes} onChange={(e) => setGridRes(Math.max(10, Math.min(150, parseInt(e.target.value)||60)))} step="10" />
            </div>
          </>
        )}
        {isParametric && (
          <div className="visualizer__range-group">
            <label className="visualizer__label">t ∈ [</label>
            <input className="visualizer__input visualizer__input--small" type="number" value={tMin} onChange={(e) => setTMin(parseFloat(e.target.value) || 0)} step="any" />
            <label className="visualizer__label">,</label>
            <input className="visualizer__input visualizer__input--small" type="number" value={tMax} onChange={(e) => setTMax(parseFloat(e.target.value) || 0)} step="any" />
            <label className="visualizer__label">]</label>
          </div>
        )}
        {!is3D && (
          <div className="visualizer__range-group">
            <label className="visualizer__label">Pts: </label>
            <input className="visualizer__input visualizer__input--small" type="number" value={nPts} onChange={(e) => setNPts(Math.max(50, Math.min(3000, parseInt(e.target.value)||500)))} step="100" />
          </div>
        )}
      </div>

      {/* ── Error ───────────────────────────────────────── */}
      {error && (
        <div className="visualizer__error">
          <span>⚠️ {error}</span>
        </div>
      )}

      {/* ── Plot ────────────────────────────────────────── */}
      <div className="visualizer__plot-wrap">
        <div ref={plotRef} className="visualizer__plot" />
        {!plotReady && (
          <div className="visualizer__loading">Loading plot…</div>
        )}
      </div>

      {/* ── Help ────────────────────────────────────────── */}
      <div className="visualizer__help">
        <span>
          <strong>math.js</strong> syntax: sin cos tan log sqrt abs exp pow &middot;
          log = ln &middot; Use commas for multiple curves &middot;
          Plotly.js for interactive visualization
        </span>
      </div>
    </main>
  );
}

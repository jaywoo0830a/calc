import { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import Plotly from 'plotly.js-dist-min';
import { create, all } from 'mathjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

const math = create(all, { number: 'number', precision: 15 });

// ── Default starter: 2D + 3D + Contour 예시 ────────────────────────────
const DEFAULT_CODE = `const { width, height } = container.getBoundingClientRect();

// ── 데이터 생성 (mathjs로 수식 계산) ─────────────────────────────────
const n = 80;
const x = math.range(-5, 5, 10 / n).toArray();
const y = math.range(-5, 5, 10 / n).toArray();
const z = y.map(yi => x.map(xi => Math.sin(Math.sqrt(xi*xi + yi*yi))));

// ── Surface plot (3D 곡면) ──────────────────────────────────────────
Plotly.newPlot(container, [{
  z, x, y,
  type: 'surface',
  colorscale: 'Earth',
  contours: {
    z: { show: true, project: { z: true } }  // 바닥에 contour 투영
  }
}], {
  title: 'z = sin(√(x²+y²))  —  Surface + Contour',
  scene: {
    xaxis: { title: 'x' },
    yaxis: { title: 'y' },
    zaxis: { title: 'z' }
  },
  autosize: true,
  paper_bgcolor: '#f8f4eb',
  plot_bgcolor: '#f8f4eb',
  font: { family: 'Noto Serif, serif', color: '#2c2416' }
}, { responsive: true });
`;

const EDITOR_THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: '#f8f4eb' },
  '.cm-scroller': { fontFamily: "'Fira Code','Cascadia Code','Consolas',monospace", lineHeight: '1.6' },
  '.cm-content': { padding: '8px 0' },
  '.cm-gutters': { borderRight: '1px solid #e5ddcc', backgroundColor: '#f8f4eb', color: '#9b907e' },
  '.cm-activeLine': { backgroundColor: 'rgba(92,61,46,0.04)' },
});

export default function MathSpace() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const plotRef = useRef(null);
  const [error, setError] = useState(null);
  const [plotType, setPlotType] = useState('surface');
  const [collapsed, setCollapsed] = useState(null); // 'editor' | 'preview' | null

  const run = useCallback((code) => {
    setError(null);
    const el = plotRef.current;
    if (!el) return;
    try {
      Plotly.purge(el);
    } catch {}
    try {
      const fn = new Function('Plotly', 'container', 'math', '"use strict";\n' + code);
      fn(Plotly, el, math);
    } catch (e) { setError(e.message || String(e)); }
  }, []);

  // 사전 정의된 예제
  const examples = useCallback((type) => {
    setPlotType(type);
    const codes = {
      surface: DEFAULT_CODE,
      contour: `const { width, height } = container.getBoundingClientRect();

const n = 120;
const x = math.range(-3, 3, 6 / n).toArray();
const y = math.range(-3, 3, 6 / n).toArray();
const z = y.map(yi => x.map(xi => xi*xi - yi*yi));

Plotly.newPlot(container, [{
  z, x, y,
  type: 'contour',
  colorscale: 'Viridis',
  contours: { coloring: 'heatmap' }
}], {
  title: 'z = x² − y²  (hyperbolic paraboloid)',
  xaxis: { title: 'x' },
  yaxis: { title: 'y' },
  autosize: true,
  paper_bgcolor: '#f8f4eb',
  plot_bgcolor: '#f8f4eb',
  font: { family: 'Noto Serif, serif', color: '#2c2416' }
}, { responsive: true });
`,
      scatter3d: `const { width, height } = container.getBoundingClientRect();

// parametric helix
const t = math.range(0, 20, 0.05).toArray();
const x = t.map(v => Math.cos(v));
const y = t.map(v => Math.sin(v));
const z = t.map(v => v * 0.3);

Plotly.newPlot(container, [{
  x, y, z,
  type: 'scatter3d',
  mode: 'lines+markers',
  marker: { size: 3, color: z, colorscale: 'Viridis' },
  line: { width: 4, color: '#5c3d2e' }
}], {
  title: 'Parametric Helix (cos t, sin t, 0.3t)',
  scene: { xaxis: { title: 'x' }, yaxis: { title: 'y' }, zaxis: { title: 'z' } },
  autosize: true,
  paper_bgcolor: '#f8f4eb',
  plot_bgcolor: '#f8f4eb',
  font: { family: 'Noto Serif, serif', color: '#2c2416' }
}, { responsive: true });
`,
      scatter2d: `const { width, height } = container.getBoundingClientRect();

const x = math.range(-2*Math.PI, 2*Math.PI, 0.05).toArray();
const y1 = x.map(v => Math.sin(v));
const y2 = x.map(v => Math.cos(v));

Plotly.newPlot(container, [
  { x, y: y1, type: 'scatter', mode: 'lines', name: 'sin(x)', line: { color: '#5c3d2e', width: 2 } },
  { x, y: y2, type: 'scatter', mode: 'lines', name: 'cos(x)', line: { color: '#3d5a80', width: 2, dash: 'dash' } }
], {
  title: 'sin(x) & cos(x)',
  xaxis: { title: 'x', zeroline: true },
  yaxis: { title: 'y', zeroline: true },
  autosize: true,
  paper_bgcolor: '#f8f4eb',
  plot_bgcolor: '#f8f4eb',
  font: { family: 'Noto Serif, serif', color: '#2c2416' }
}, { responsive: true });
`,
    };
    const code = codes[type];
    if (viewRef.current) {
      viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: code } });
    }
    run(code);
  }, [run]);

  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: DEFAULT_CODE,
      extensions: [
        lineNumbers(), history(), bracketMatching(), javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EDITOR_THEME,
      ],
    });
    viewRef.current = new EditorView({ state, parent: editorRef.current });
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, []);

  useEffect(() => { setTimeout(() => run(DEFAULT_CODE), 300); }, [run]);

  return (
    <main className="mathspace">
      <nav className="calculator__nav">
        <Link to="/" className="calculator__nav-tab">Calc</Link>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <span className="calculator__nav-tab calculator__nav-tab--active">Math Space</span>
        <Link to="/vocab" className="calculator__nav-tab">Vocab</Link>
      </nav>
      <div className="mathspace__examples">
        <button className={'mathspace__chip' + (plotType === 'surface' ? ' mathspace__chip--active' : '')} onClick={() => examples('surface')}>🔮 Surface</button>
        <button className={'mathspace__chip' + (plotType === 'contour' ? ' mathspace__chip--active' : '')} onClick={() => examples('contour')}>🎯 Contour</button>
        <button className={'mathspace__chip' + (plotType === 'scatter3d' ? ' mathspace__chip--active' : '')} onClick={() => examples('scatter3d')}>🧬 3D Curve</button>
        <button className={'mathspace__chip' + (plotType === 'scatter2d' ? ' mathspace__chip--active' : '')} onClick={() => examples('scatter2d')}>📈 2D Plot</button>
      </div>
      <div className="mathspace__toggle-bar">
        <button className={'mathspace__toggle-btn' + (collapsed === 'editor' ? ' mathspace__toggle-btn--active' : '')} onClick={() => setCollapsed(collapsed === 'editor' ? null : 'editor')}>
          {collapsed === 'editor' ? '◀ Code' : 'Code ▶'}
        </button>
        <button className={'mathspace__toggle-btn' + (collapsed === 'preview' ? ' mathspace__toggle-btn--active' : '')} onClick={() => setCollapsed(collapsed === 'preview' ? null : 'preview')}>
          {collapsed === 'preview' ? 'Plot ◀' : '▶ Plot'}
        </button>
      </div>
      <div className={'mathspace__split' + (collapsed ? ' mathspace__split--collapsed-' + collapsed : '')}>
        <div className="mathspace__editor-pane">
          <div className="mathspace__toolbar">
            <span>JavaScript + Plotly + mathjs</span>
            <button className="mathspace__render-btn" onClick={() => run(viewRef.current?.state.doc.toString() || '')}>▶ Render</button>
          </div>
          <div ref={editorRef} className="mathspace__editor" />
          {error && <div className="mathspace__error">{error}</div>}
        </div>
        <div className="mathspace__preview-pane">
          <div ref={plotRef} className="mathspace__plot" />
        </div>
      </div>
    </main>
  );
}

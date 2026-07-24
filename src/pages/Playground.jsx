import { useState, useCallback, useRef, useEffect } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

// ── iframe HTML (computed once at module level — never changes) ──────────────
const IFRAME_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{width:100%;height:100%;overflow:hidden;background:#f8f4eb;}
  #mathbox{width:100%;height:100%;}
  #error{position:fixed;bottom:0;left:0;right:0;background:#b5433a;color:#fff;padding:8px 14px;font:12px monospace;display:none;z-index:100;}
</style>
<link rel="stylesheet" href="/lib/mathbox.css"></head><body>
<div id="mathbox"></div>
<div id="error"></div>
<script type="importmap">
{ "imports": { "three": "/lib/three.module.min.js" } }
</script>
<script type="module">
import * as THREE from 'three';
window.THREE = THREE;
// Now that THREE is ready, load mathbox
var mbScript = document.createElement('script');
mbScript.src = '/lib/mathbox.min.js';
mbScript.onload = function() { window._mathboxReady = true; };
document.head.appendChild(mbScript);
</script>
<script>
  var errorEl = document.getElementById('error');
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
    setTimeout(function() { errorEl.style.display = 'none'; }, 4000);
  }
  var currentCleanup = null;
  function run(code) {
    if (!window.mathbox) { showError('mathbox not loaded yet — retrying...'); setTimeout(function() { run(code); }, 200); return; }
    if (currentCleanup) { try { currentCleanup(); } catch(e){} currentCleanup = null; }
    var container = document.getElementById('mathbox');
    container.innerHTML = '';
    try {
      var fn = new Function('THREE', 'mathbox', 'container', '"use strict";' + code);
      var result = fn(window.THREE, window.mathbox, container);
      if (typeof result === 'function') currentCleanup = result;
      errorEl.style.display = 'none';
    } catch(e) {
      showError(e.message || String(e));
    }
  }
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'run') run(e.data.code);
  });
  window.parent.postMessage({ type: 'ready' }, '*');
</script>
</body></html>`;

// ── Preset examples (math) ───────────────────────────────────────────────────
const PRESETS = [
  {
    label: 'Surface: sin(x)·cos(y)',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2, 3);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-4, 4], [-4, 4], [-4, 4]] });\nview.axis({ detail: 8 });\nview.area({\n  axes: [1, 3],\n  expr: function (emit, x, y) {\n    emit(x, y, Math.sin(x) * Math.cos(y));\n  },\n  channels: 3, items: 2, width: 64, height: 64,\n});\n`,
  },
  {
    label: 'Torus knot (2,3)',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(4, 2.5, 4);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-4, 4], [-4, 4], [-4, 4]] });\nview.axis({ detail: 8 });\nview.area({\n  axes: [1, 3],\n  expr: function (emit, u, v) {\n    const R = 2, r = 0.6, p = 2, q = 3;\n    const x = (R + r * Math.cos(q * u)) * Math.cos(p * v);\n    const y = (R + r * Math.cos(q * u)) * Math.sin(p * v);\n    const z = r * Math.sin(q * u);\n    emit(x, y, z);\n  },\n  channels: 3, items: 2, width: 128, height: 128,\n});\n`,
  },
  {
    label: 'Klein bottle',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2, 4);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-3, 3], [-3, 3], [-3, 3]] });\nview.axis({ detail: 6 });\nfunction klein(emit, u, v) {\n  u *= Math.PI * 2; v *= Math.PI * 2;\n  const cu = Math.cos(u), su = Math.sin(u);\n  const r = 2 - Math.cos(u);\n  emit((cu < 0 ? r * Math.cos(v) : r * Math.cos(v) + 2) * 0.5, r * Math.sin(v) * 0.5, su * 0.5);\n}\nview.area({ axes: [1, 3], expr: klein, channels: 3, items: 2, width: 100, height: 100 });\n`,
  },
  {
    label: 'Möbius strip',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2, 3);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-2.5, 2.5], [-2.5, 2.5], [-2.5, 2.5]] });\nview.axis({ detail: 5 });\nview.area({\n  axes: [1, 3],\n  expr: function(emit, u, v) {\n    u = (u - 0.5) * Math.PI * 2;\n    v = (v - 0.5) * 1.5;\n    emit((1+v*Math.cos(u/2))*Math.cos(u), (1+v*Math.cos(u/2))*Math.sin(u), v*Math.sin(u/2));\n  },\n  channels: 3, items: 2, width: 80, height: 40,\n});\n`,
  },
  {
    label: 'Sphere',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2, 3);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-2, 2], [-2, 2], [-2, 2]] });\nview.axis({ detail: 4 });\nview.area({\n  axes: [1, 3],\n  expr: function(emit, theta, phi) {\n    emit(Math.sin(theta)*Math.cos(phi), Math.cos(theta), Math.sin(theta)*Math.sin(phi));\n  },\n  channels: 3, items: 2, width: 64, height: 64,\n});\n`,
  },
  {
    label: 'Saddle: x² − y²',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2.5, 3);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-3, 3], [-3, 3], [-3, 3]] });\nview.axis({ detail: 6 });\nview.area({\n  axes: [1, 3],\n  expr: function(emit, x, y) {\n    emit(x, y, (x*x - y*y) / 2);\n  },\n  channels: 3, items: 2, width: 64, height: 64,\n});\n`,
  },
  {
    label: 'Helix (3D curve)',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(4, 2, 5);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-3, 3], [-3, 3], [-5, 5]] });\nview.axis({ detail: 5 });\n\nconst n = 500, pts = new Float32Array(n * 3);\nfor (let i = 0; i < n; i++) {\n  const t = (i / n - 0.5) * 20;\n  pts[i*3] = Math.cos(t); pts[i*3+1] = Math.sin(t); pts[i*3+2] = t / 4;\n}\nview.array({ data: pts, channels: 3, width: n }).line({ color: 0x5c3d2e, width: 2 });\n`,
  },
  {
    label: 'Ripple: sin(r)/r',
    code: `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(5, 4, 5);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-6, 6], [-6, 6], [-2, 2]] });\nview.axis({ detail: 6 });\nview.area({\n  axes: [1, 3],\n  expr: function(emit, x, y) {\n    const r = Math.sqrt(x*x + y*y) + 0.01;\n    emit(x, y, Math.sin(r * 2) / r);\n  },\n  channels: 3, items: 2, width: 100, height: 100,\n});\n`,
  },
];

const DEFAULT_CODE = `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2, 3);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-4, 4], [-4, 4], [-4, 4]] });\nview.axis({ detail: 8 });\n\nview.area({\n  axes: [1, 3],\n  expr: function (emit, x, y) {\n    emit(x, y, Math.sin(x) * Math.cos(y));\n  },\n  channels: 3,\n  items: 2,\n  width: 64,\n  height: 64,\n});\n`;

// ── Component ────────────────────────────────────────────────────────────────
export default function Playground() {
  const editorContainer = useRef(null);
  const editorView = useRef(null);
  const iframeRef = useRef(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  // ── Initialize CodeMirror ──────────────────────────────────────────────────
  useEffect(() => {
    if (!editorContainer.current || editorView.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        setCode(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: DEFAULT_CODE,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        rectangularSelection(),
        history(),
        javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        updateListener,
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', monospace" },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': { borderRight: '1px solid #e5ddcc', backgroundColor: '#f8f4eb', color: '#9b907e' },
          '.cm-activeLine': { backgroundColor: 'rgba(92,61,46,0.05)' },
        }),
      ],
    });

    editorView.current = new EditorView({
      state,
      parent: editorContainer.current,
    });

    return () => {
      editorView.current?.destroy();
      editorView.current = null;
    };
  }, []);

  // ── Update editor content when preset is loaded ────────────────────────────
  const loadCode = useCallback((newCode) => {
    if (editorView.current) {
      editorView.current.dispatch({
        changes: { from: 0, to: editorView.current.state.doc.length, insert: newCode },
      });
    }
    setCode(newCode);
  }, []);

  // ── Send code to iframe ────────────────────────────────────────────────────
  const sendCode = useCallback((source) => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'run', code: source }, '*');
    setError(null);
  }, []);

  // ── Auto-run with debounce ─────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => sendCode(code), 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [code, sendCode]);

  // ── Listen for iframe ready ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === 'ready') sendCode(DEFAULT_CODE);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="playground" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>

      {/* ── Presets ─────────────────────────────────────── */}
      <div className="playground__toolbar">
        <div className="playground__presets">
          {PRESETS.map((p, i) => (
            <button key={i} className="playground__preset-chip" onClick={() => loadCode(p.code)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Editor + Preview ───────────────────────────── */}
      <div className="playground__split">
        <div className="playground__editor-pane">
          <div className="playground__editor-header">
            <span>📝 JavaScript — Three.js + Mathbox 2</span>
          </div>
          <div ref={editorContainer} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <iframe
            ref={iframeRef}
            className="playground__iframe"
            srcDoc={IFRAME_HTML}
            title="3D Preview"
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      </div>

      <div className="playground__help">
        <span>mathbox + Three.js · Write JS · Auto-run on edit · Return cleanup function for hot-reload</span>
      </div>
    </main>
  );
}

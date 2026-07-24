import { useState, useCallback, useRef, useEffect } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  rectangularSelection,
  highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
} from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';

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
{ "imports": { "three": "/lib/three.module.min.js", "three/addons/": "/lib/three-addons/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
THREE.OrbitControls = OrbitControls;
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

// ── Starter example (official Mathbox2 + Three.js) ───────────────────────────
// See: https://github.com/unconed/mathbox — docs/primitives.md for all primitives
//      https://threejs.org/docs/ — Three.js API reference
const STARTER_CODE = `// Mathbox2 — Presentation-quality WebGL math diagrams
// API: mathbox({ element, plugins, controls }).cartesian({ range }).area({ ... })

const root = mathbox({
  element: container,
  plugins: ['core', 'controls', 'cursor'],
  controls: { klass: THREE.OrbitControls },
});

const three = root.three;
three.camera.position.set(3, 2.5, 3);
three.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);

// ── Cartesian view with axes ─────────────────────────────────────
const view = root.cartesian({
  range: [[-4, 4], [-4, 4], [-4, 4]],
  scale: [1, 1, 1],
});

view.axis({ axis: 1, detail: 8 });  // x-axis
view.axis({ axis: 2, detail: 8 });  // y-axis
view.axis({ axis: 3, detail: 8 });  // z-axis

// ── Parametric surface: z = sin(x) · cos(y) ─────────────────────
view.area({
  axes: [1, 3],          // map u→x, v→z (height)
  expr: function (emit, x, y) {
    emit(x, y, Math.sin(x) * Math.cos(y));
  },
  channels: 3,            // x, y, z
  items: 2,               // 2D grid
  width: 64,              // resolution
  height: 64,
});

// Return cleanup for hot-reload (optional)
return function cleanup() {
  three.renderer.dispose();
};
`;

const DEFAULT_CODE = `const mb = mathbox({\n  element: container,\n  plugins: ['core', 'controls', 'cursor'],\n  controls: { klass: THREE.OrbitControls },\n});\nconst three = mb.three;\nthree.camera.position.set(3, 2, 3);\nthree.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);\n\nconst view = mb.cartesian({ range: [[-4, 4], [-4, 4], [-4, 4]] });\nview.axis({ detail: 8 });\n\nview.area({\n  axes: [1, 3],\n  expr: function (emit, x, y) {\n    emit(x, y, Math.sin(x) * Math.cos(y));\n  },\n  channels: 3,\n  items: 2,\n  width: 64,\n  height: 64,\n});\n`;

// ── Component ────────────────────────────────────────────────────────────────
export default function Playground() {
  const editorContainer = useRef(null);
  const editorView = useRef(null);
  const iframeRef = useRef(null);
  const [code, setCode] = useState(STARTER_CODE);
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
      doc: STARTER_CODE,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        rectangularSelection(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        updateListener,
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '13px',
            backgroundColor: '#f8f4eb',
          },
          '.cm-scroller': {
            fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', 'SF Mono', monospace",
            lineHeight: '1.6',
          },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': {
            borderRight: '1px solid #e5ddcc',
            backgroundColor: '#f8f4eb',
            color: '#9b907e',
          },
          '.cm-activeLine': { backgroundColor: 'rgba(92,61,46,0.04)' },
          '.cm-selectionBackground': { backgroundColor: 'rgba(92,61,46,0.15)' },
          '.cm-cursor': { borderLeftColor: '#2c2416' },
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
      if (e.data?.type === 'ready') sendCode(STARTER_CODE);
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

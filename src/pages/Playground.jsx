import { useState, useCallback, useRef, useEffect } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

// ── Starter code ─────────────────────────────────────────────────────────────
const STARTER = `const root = mathbox({
  element: container,
  plugins: ['core', 'controls', 'cursor'],
  controls: { klass: THREE.OrbitControls },
});
const three = root.three;
three.camera.position.set(3, 2.5, 3);
three.renderer.setClearColor(new THREE.Color(0xf8f4eb), 1);

const view = root.cartesian({ range: [[-4, 4], [-4, 4], [-4, 4]] });
view.axis({ axis: 1, detail: 8 });
view.axis({ axis: 2, detail: 8 });
view.axis({ axis: 3, detail: 8 });

view.area({
  axes: [1, 3],
  expr: function (emit, x, y) {
    emit(x, y, Math.sin(x) * Math.cos(y));
  },
  channels: 3,
  items: 2,
  width: 64,
  height: 64,
});
`;

// ── Self-contained iframe HTML ────────────────────────────────────────────────
// All scripts loaded via import map. Ready signal sent ONLY after everything is loaded.
function iframeHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#f8f4eb}#mathbox{width:100%;height:100%}#error{position:fixed;bottom:0;left:0;right:0;background:#b5433a;color:#fff;padding:8px 14px;font:12px monospace;display:none;z-index:100}</style>
<link rel="stylesheet" href="/lib/mathbox.css">
<script type="importmap">{"imports":{"three":"/lib/three.module.min.js","three/addons/":"/lib/three-addons/"}}</script>
</head><body>
<div id="mathbox"></div><div id="error"></div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
THREE.OrbitControls = OrbitControls;
window.THREE = THREE;

// Load mathbox after THREE is ready
await new Promise(function(resolve, reject) {
  var s = document.createElement('script');
  s.src = '/lib/mathbox.min.js';
  s.onload = resolve;
  s.onerror = reject;
  document.head.appendChild(s);
});

var errEl = document.getElementById('error');
function show(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
function hide() { errEl.style.display = 'none'; }

var cleanupFn = null;
function run(code) {
  if (cleanupFn) { try { cleanupFn(); } catch(e){} cleanupFn = null; }
  document.getElementById('mathbox').innerHTML = '';
  try {
    var fn = new Function('THREE', 'mathbox', 'container', '"use strict";' + code);
    var result = fn(THREE, mathbox, document.getElementById('mathbox'));
    if (typeof result === 'function') cleanupFn = result;
    hide();
  } catch(e) { show(e.message || String(e)); }
}

window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'run') run(e.data.code);
});

// Signal ready — ONLY now is everything loaded
window.parent.postMessage({ type: 'ready' }, '*');
</script>
</body></html>`;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function Playground() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const iframeRef = useRef(null);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);
  const readyRef = useRef(false);

  // ── CodeMirror ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;
    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged) debounceRef.current = u.state.doc.toString();
    });
    const state = EditorState.create({
      doc: STARTER,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        listener,
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: '#f8f4eb' },
          '.cm-scroller': { fontFamily: "'Fira Code','Cascadia Code','Consolas',monospace", lineHeight: '1.6' },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': { borderRight: '1px solid #e5ddcc', backgroundColor: '#f8f4eb', color: '#9b907e' },
          '.cm-activeLine': { backgroundColor: 'rgba(92,61,46,0.04)' },
        }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: editorRef.current });

    // Auto-run: send code 400ms after last change
    const interval = setInterval(() => {
      if (debounceRef.current && readyRef.current) {
        iframeRef.current?.contentWindow?.postMessage({ type: 'run', code: debounceRef.current }, '*');
        debounceRef.current = null;
      }
    }, 400);
    return () => {
      clearInterval(interval);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  // ── Iframe ready handler ──────────────────────────────────────────────────
  const handleIframeLoad = useCallback(() => {
    readyRef.current = false;
    const handler = (e) => {
      if (e.data?.type === 'ready') {
        readyRef.current = true;
        debounceRef.current = STARTER; // trigger initial render
        window.removeEventListener('message', handler);
      }
    };
    window.addEventListener('message', handler);
  }, []);

  return (
    <main className="playground" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>

      <div className="playground__split">
        <div className="playground__editor-pane">
          <div className="playground__editor-header">JavaScript — Three.js + Mathbox2</div>
          <div ref={editorRef} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <iframe
            ref={iframeRef}
            className="playground__iframe"
            srcDoc={iframeHtml()}
            title="3D Preview"
            sandbox="allow-scripts allow-same-origin"
            onLoad={handleIframeLoad}
          />
        </div>
      </div>

      <div className="playground__help">
        mathbox + Three.js · Write JavaScript · Auto-run on edit
      </div>
    </main>
  );
}

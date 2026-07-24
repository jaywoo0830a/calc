import { useState, useCallback, useRef, useEffect } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

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
  expr: function (emit, x, y) { emit(x, y, Math.sin(x) * Math.cos(y)); },
  channels: 3, items: 2, width: 64, height: 64,
});
`;

export default function Playground() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const canvasRef = useRef(null);
  const cleanupRef = useRef(null);
  const [error, setError] = useState(null);
  const readyRef = useRef(false);

  // ── Wait for mathbox to be ready ──────────────────────────────────────────
  useEffect(() => {
    const check = setInterval(() => {
      if (window.mathbox && window.THREE) {
        readyRef.current = true;
        clearInterval(check);
        runCode(STARTER);
      }
    }, 100);
    return () => clearInterval(check);
  }, []);

  // ── Run user code safely ──────────────────────────────────────────────────
  const runCode = useCallback((code) => {
    if (!readyRef.current || !canvasRef.current) return;
    // Clean up previous render
    if (cleanupRef.current) {
      try { cleanupRef.current(); } catch (e) { /* ignore */ }
      cleanupRef.current = null;
    }
    // Clear canvas
    canvasRef.current.innerHTML = '';
    try {
      const fn = new Function('THREE', 'mathbox', 'container', '"use strict";' + code);
      const result = fn(window.THREE, window.mathbox, canvasRef.current);
      if (typeof result === 'function') cleanupRef.current = result;
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // ── CodeMirror ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: STARTER,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
    // Initial render
    setTimeout(() => runCode(STARTER), 500);
    return () => { viewRef.current?.destroy(); viewRef.current = null; };
  }, [runCode]);

  const handleRender = () => {
    const code = viewRef.current?.state.doc.toString() || '';
    runCode(code);
  };

  return (
    <main className="playground" tabIndex={-1}>
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">Code</span>
      </nav>
      <div className="playground__split">
        <div className="playground__editor-pane">
          <div className="playground__editor-header">
            <span>Code</span>
            <button className="playground__render-btn" onClick={handleRender}>Render</button>
          </div>
          <div ref={editorRef} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <div className="playground__preview-header">Render</div>
          <div ref={canvasRef} className="playground__canvas" />
        </div>
      </div>
    </main>
  );
}

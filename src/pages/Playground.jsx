import { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from '../lib/OrbitControls.js';
import { create, all } from 'mathjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { C2D, C3D, CCX, PRESETS } from './playground-presets.js';

const math = create(all, { number: 'number', precision: 15 });

const MODES = [
  { id: '2d', label: '2D', code: C2D },
  { id: '3d', label: '3D', code: C3D },
  { id: 'complex', label: 'Complex', code: CCX },
];

const EDITOR_THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: '#f8f4eb' },
  '.cm-scroller': { fontFamily: "'Fira Code','Cascadia Code','Consolas',monospace", lineHeight: '1.6' },
  '.cm-content': { padding: '8px 0' },
  '.cm-gutters': { borderRight: '1px solid #e5ddcc', backgroundColor: '#f8f4eb', color: '#9b907e' },
  '.cm-activeLine': { backgroundColor: 'rgba(92,61,46,0.04)' },
});

export default function Playground() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const canvasRef = useRef(null);
  const cleanupRef = useRef(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('2d');

  const run = useCallback((code) => {
    setError(null);
    const el = canvasRef.current;
    if (!el) return;
    if (cleanupRef.current) { try { cleanupRef.current(); } catch (e) {} cleanupRef.current = null; }
    el.innerHTML = '';
    try {
      const fn = new Function('THREE', 'OrbitControls', 'container', 'math', '"use strict";\n' + code);
      const result = fn(THREE, OrbitControls, el, math);
      if (typeof result === 'function') cleanupRef.current = result;
    } catch (e) { setError(e.message || String(e)); }
  }, []);

  const switchMode = useCallback((m) => {
    setMode(m);
    const code = MODES.find((x) => x.id === m).code;
    if (viewRef.current) viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: code } });
    run(code);
  }, [run]);

  const loadCode = useCallback((code) => {
    if (viewRef.current) viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: code } });
    run(code);
  }, [run]);

  useEffect(() => {
    if (!editorRef.current || viewRef.current) return;
    const state = EditorState.create({
      doc: C2D,
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

  useEffect(() => { setTimeout(() => run(C2D), 200); }, [run]);

  return (
    <main className="playground">
      <nav className="calculator__nav">
        <a href="/" className="calculator__nav-tab">Calc</a>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <span className="calculator__nav-tab calculator__nav-tab--active">3D</span>
      </nav>
      <div className="playground__modes">
        {MODES.map((m) => (
          <button key={m.id} className={'playground__mode-btn' + (mode === m.id ? ' playground__mode-btn--active' : '')} onClick={() => switchMode(m.id)}>{m.label}</button>
        ))}
      </div>
      <div className="playground__presets">
        {(PRESETS[mode] || []).map((p, i) => (
          <button key={i} className="playground__chip" onClick={() => loadCode(p.code)}>{p.label}</button>
        ))}
      </div>
      <div className="playground__split">
        <div className="playground__editor-pane">
          <div className="playground__toolbar">
            <span>JavaScript</span>
            <button className="playground__render-btn" onClick={() => run(viewRef.current?.state.doc.toString() || '')}>Render</button>
          </div>
          <div ref={editorRef} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <div ref={canvasRef} className="playground__canvas" />
        </div>
      </div>
    </main>
  );
}

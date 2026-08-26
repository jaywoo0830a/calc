import { useState, useRef, useEffect, useCallback } from 'react';
import AppLayout from '../components/AppLayout.jsx';
import * as THREE from 'three';
import { OrbitControls } from '../lib/OrbitControls.js';
import { create, all } from 'mathjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';

const math = create(all, { number: 'number', precision: 15 });

// ── Default starter template ──────────────────────────────────────────────
const DEFAULT_CODE = `const { width, height } = container.getBoundingClientRect();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(width, height);
renderer.setClearColor(0xf8f4eb);
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera.position.set(5, 4, 6);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const scene = new THREE.Scene();

// ── Your code here ──────────────────────────────────────────────────────


function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
`;

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
  const [collapsed, setCollapsed] = useState(null); // 'editor' | 'preview' | null

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

  useEffect(() => { setTimeout(() => run(DEFAULT_CODE), 200); }, [run]);

  return (
    <AppLayout className="playground">
      <div className="playground__toggle-bar">
        <button className={'playground__toggle-btn' + (collapsed === 'editor' ? ' playground__toggle-btn--active' : '')} onClick={() => setCollapsed(collapsed === 'editor' ? null : 'editor')}>
          {collapsed === 'editor' ? '◀ Code' : 'Code ▶'}
        </button>
        <button className={'playground__toggle-btn' + (collapsed === 'preview' ? ' playground__toggle-btn--active' : '')} onClick={() => setCollapsed(collapsed === 'preview' ? null : 'preview')}>
          {collapsed === 'preview' ? 'Canvas ◀' : '▶ Canvas'}
        </button>
      </div>
      <div className={'playground__split' + (collapsed ? ' playground__split--collapsed-' + collapsed : '')}>
        <div className="playground__editor-pane">
          <div className="playground__toolbar">
            <span>JavaScript + Three.js</span>
            <button className="playground__render-btn" onClick={() => run(viewRef.current?.state.doc.toString() || '')}>▶ Render</button>
          </div>
          <div ref={editorRef} className="playground__editor" />
          {error && <div className="playground__error">{error}</div>}
        </div>
        <div className="playground__preview-pane">
          <div ref={canvasRef} className="playground__canvas" />
        </div>
      </div>
    </AppLayout>
  );
}

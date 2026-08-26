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
import { api } from '../lib/api.js';
import { useClearGate } from '../hooks/useClearGate.js';
import ClearGate from '../components/ClearGate.jsx';

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

// ── Practice 기본 템플릿 — 서버 Vitest로 실행 (첫 줄 // @uses로 lib 주입 가능) ──
const DEFAULT_PRACTICE = `// ▶ Run — 서버에서 실행 (console.log 캡처)
// 🧪 Test — 서버 Vitest로 실행
// lib가 필요하면 첫 줄에 추가: // @uses electrostatics

describe('practice — smoke', () => {
  it('basic math', () => {
    expect(1 + 1).toBe(2);
  });

  it('array works', () => {
    expect([1, 2, 3].map((n) => n * 2)).toEqual([2, 4, 6]);
  });
});
`;

export default function Playground() {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const canvasRef = useRef(null);
  const cleanupRef = useRef(null);
  const [error, setError] = useState(null);
  const [collapsed, setCollapsed] = useState(null); // 'editor' | 'preview' | null
  const [mode, setMode] = useState('canvas');       // 'canvas' | 'practice'

  // 📝 Practice 상태
  const practiceEditorRef = useRef(null);
  const practiceViewRef = useRef(null);
  const [practiceId, setPracticeId] = useState(null);
  const [practiceName, setPracticeName] = useState('');
  const [savedList, setSavedList] = useState([]);
  const [result, setResult] = useState(null);       // { mode, summary, results, stdout, stderr, error }
  const [busy, setBusy] = useState(false);
  const { requireClear, gateProps } = useClearGate();

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

  // 📝 Practice 에디터 (캔버스와 별도 인스턴스 — 모드 전환에도 코드 유지)
  const practiceDocRef = useRef(DEFAULT_PRACTICE);
  useEffect(() => {
    if (mode !== 'practice') {
      if (practiceViewRef.current) {
        practiceDocRef.current = practiceViewRef.current.state.doc.toString();
        practiceViewRef.current.destroy();
        practiceViewRef.current = null;
      }
      return;
    }
    if (!practiceEditorRef.current || practiceViewRef.current) return;
    const state = EditorState.create({
      doc: practiceDocRef.current,
      extensions: [
        lineNumbers(), history(), bracketMatching(), javascript(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EDITOR_THEME,
      ],
    });
    practiceViewRef.current = new EditorView({ state, parent: practiceEditorRef.current });
  }, [mode]);

  useEffect(() => { api.listPractice().then(setSavedList).catch(() => {}); }, []);

  const practiceCode = useCallback(() => practiceViewRef.current?.state.doc.toString() || '', []);

  const exec = useCallback(async (kind) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.execPractice(practiceCode(), kind));
    } catch (e) {
      setResult({ mode: kind, error: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [practiceCode]);

  const savePractice = useCallback(async () => {
    try {
      const saved = await api.savePractice({
        id: practiceId || (globalThis.crypto?.randomUUID?.() || 'p' + Date.now()),
        name: practiceName.trim() || 'untitled',
        kind: 'practice',
        code: practiceCode(),
      });
      setPracticeId(saved.id);
      setPracticeName(saved.name);
      setSavedList(await api.listPractice());
    } catch (e) {
      setResult({ mode: 'run', error: 'Save failed: ' + (e.message || String(e)) });
    }
  }, [practiceId, practiceName, practiceCode]);

  const loadPractice = useCallback(async (id) => {
    try {
      const row = await api.getPractice(id);
      setPracticeId(row.id);
      setPracticeName(row.name);
      practiceViewRef.current?.dispatch({
        changes: { from: 0, to: practiceViewRef.current.state.doc.length, insert: row.code },
      });
    } catch (e) {
      setResult({ mode: 'test', error: 'Load failed: ' + (e.message || String(e)) });
    }
  }, []);

  const deletePractice = useCallback(() => {
    if (!practiceId) return;
    requireClear('Delete practice snippet?', async () => {
      try {
        await api.deletePractice(practiceId);
        setPracticeId(null);
        setPracticeName('');
        setSavedList(await api.listPractice());
      } catch (e) {
        setResult({ mode: 'test', error: 'Delete failed: ' + (e.message || String(e)) });
      }
    });
  }, [practiceId, requireClear]);

  return (
    <AppLayout className="playground">
      <div className="playground__toggle-bar">
        <button className={'playground__mode-btn' + (mode === 'canvas' ? ' playground__mode-btn--active' : '')} onClick={() => setMode('canvas')}>🎨 Canvas</button>
        <button className={'playground__mode-btn' + (mode === 'practice' ? ' playground__mode-btn--active' : '')} onClick={() => setMode('practice')}>📝 Practice</button>
        {mode === 'canvas' && (
          <>
            <button className={'playground__toggle-btn' + (collapsed === 'editor' ? ' playground__toggle-btn--active' : '')} onClick={() => setCollapsed(collapsed === 'editor' ? null : 'editor')}>
              {collapsed === 'editor' ? '◀ Code' : 'Code ▶'}
            </button>
            <button className={'playground__toggle-btn' + (collapsed === 'preview' ? ' playground__toggle-btn--active' : '')} onClick={() => setCollapsed(collapsed === 'preview' ? null : 'preview')}>
              {collapsed === 'preview' ? 'Canvas ◀' : '▶ Canvas'}
            </button>
          </>
        )}
      </div>

      {mode === 'canvas' ? (
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
      ) : (
        <div className="playground__practice">
          <div className="playground__practice-toolbar">
            <input
              className="playground__practice-name"
              placeholder="Snippet name…"
              value={practiceName}
              onChange={(e) => setPracticeName(e.target.value)}
            />
            <select
              className="playground__practice-select"
              value=""
              onChange={(e) => e.target.value && loadPractice(e.target.value)}
              title="Load saved snippet"
            >
              <option value="">📂 Load…</option>
              {savedList.filter((s) => s.kind === 'practice').map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button className="playground__practice-btn" onClick={() => exec('run')} disabled={busy} title="Run code on the server (node)">▶ Run</button>
            <button className="playground__practice-btn playground__practice-btn--test" onClick={() => exec('test')} disabled={busy} title="Run tests on the server (Vitest)">🧪 Test</button>
            <button className="playground__practice-btn" onClick={savePractice} disabled={busy}>💾 Save</button>
            {practiceId && <button className="playground__practice-btn playground__practice-btn--danger" onClick={deletePractice} title="Delete snippet">🗑</button>}
            {busy && <span className="playground__practice-busy">running…</span>}
          </div>
          <div ref={practiceEditorRef} className="playground__editor playground__practice-editor" />
          {result && (
            <div className="playground__practice-results">
              {result.error ? (
                <pre className="playground__practice-error">{result.error}</pre>
              ) : result.mode === 'run' ? (
                <>
                  {result.stdout && <pre className="playground__practice-out">{result.stdout}</pre>}
                  {result.stderr && <pre className="playground__practice-err">{result.stderr}</pre>}
                  {!result.stdout && !result.stderr && <p className="playground__practice-none">No output.</p>}
                </>
              ) : (
                <>
                  <p className={'playground__test-summary' + (result.summary?.failed ? ' playground__test-summary--fail' : '')}>
                    {result.summary?.passed ?? 0} passed · {result.summary?.failed ?? 0} failed · {result.summary?.total ?? 0} total
                  </p>
                  {(result.results || []).map((r, i) => (
                    <div key={i} className={'playground__test-row playground__test-row--' + r.status}>
                      <span className="playground__test-mark">{r.status === 'passed' ? '✔' : '✘'}</span>
                      <span className="playground__test-name">{r.name}</span>
                      <span className="playground__test-dur">{Math.round(r.duration)}ms</span>
                      {r.error && <pre className="playground__test-error">{r.error}</pre>}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <ClearGate {...gateProps} />
    </AppLayout>
  );
}

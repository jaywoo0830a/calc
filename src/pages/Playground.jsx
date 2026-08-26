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

// ANSI(SGR) 이스케이프 → HTML span — vitest 콘솔 색상 재현
function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FG = {
    30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef',
    35: '#c678dd', 36: '#56b6c2', 37: '#e8e2d4', 90: '#8a8577', 91: '#e06c75',
    92: '#98c379', 93: '#e5c07b', 94: '#61afef', 95: '#c678dd', 96: '#56b6c2', 97: '#f5f1e6',
  };
  let style = '';
  const parts = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const chunk = esc(text.slice(last, m.index));
      parts.push(style ? `<span style="${style}">${chunk}</span>` : chunk);
    }
    const params = (m[1] || '0').split(';').map(Number);
    for (const p of params) {
      if (p === 0) style = '';
      else if (p === 1) style += 'font-weight:700;';
      else if (p === 2) style += 'opacity:0.7;';
      else if (p === 22) style = style.replace('font-weight:700;', '');
      else if (FG[p]) {
        style = style.replace(/color:[^;]+;/, '');
        style += `color:${FG[p]};`;
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    const chunk = esc(text.slice(last));
    parts.push(style ? `<span style="${style}">${chunk}</span>` : chunk);
  }
  return parts.join('');
}

// vitest 콘솔 라인별 색상 (터미널 팔레트 재현 — ✓초록/×빨강/요약 굵게 등)
function vitestConsoleHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const C = {
    green: '#98c379', red: '#e06c75', yellow: '#e5c07b', dim: '#8a8577', fg: '#e8e2d4',
  };
  const colorize = (line) => {
    if (line.includes('\x1b')) return ansiToHtml(line); // ANSI가 있으면 그대로 변환
    const t = line.trimStart();
    if (t.startsWith('✓')) return `<span style="color:${C.green};font-weight:700">${esc(line)}</span>`;
    if (t.startsWith('×')) return `<span style="color:${C.red};font-weight:700">${esc(line)}</span>`;
    if (t.startsWith('❯')) return `<span style="color:${C.yellow}">${esc(line)}</span>`;
    if (t.startsWith('→')) return `<span style="color:${C.red}">${esc(line)}</span>`;
    if (/Test Files/.test(line) || /^\s*Tests\s/.test(line)) {
      const ok = !/failed/.test(line);
      return `<span style="color:${ok ? C.green : C.red};font-weight:700">${esc(line)}</span>`;
    }
    if (/Start at|Duration/.test(line)) return `<span style="color:${C.dim}">${esc(line)}</span>`;
    return esc(line);
  };
  return String(text).split('\n').map(colorize).join('\n');
}

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

  // 항상 새 스니펫으로 저장 (현재 항목을 덮어쓰지 않음)
  const saveAsNew = useCallback(async () => {
    try {
      const saved = await api.savePractice({
        id: globalThis.crypto?.randomUUID?.() || 'p' + Date.now() + Math.random().toString(36).slice(2, 8),
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
  }, [practiceName, practiceCode]);

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
            <button className="playground__practice-btn" onClick={savePractice} disabled={busy} title="Save — update current snippet">💾 Save</button>
            <button className="playground__practice-btn" onClick={saveAsNew} disabled={busy} title="Save as new snippet (does not overwrite current)">➕ New</button>
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
                  {/* 실제 vitest 터미널 콘솔 (verbose + vitest 팔레트 색상) */}
                  <pre className="playground__test-console" dangerouslySetInnerHTML={{ __html: vitestConsoleHtml(result.stdout || result.stderr || 'No output.') }} />
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

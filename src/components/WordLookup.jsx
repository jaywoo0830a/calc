import { useState, useCallback, useEffect, useRef } from 'react';
import { IS_TOUCH_PRIMARY } from '../lib/device.js';

// ═══════════════════════════════════════════════════════════════
// WordLookup — 영영사전(dictionaryapi.dev) 오버레이
// ─────────────────────────────────────────────────────────────
// 트리거는 모두 "명시적"이다 (단순 드래그 선택만으로는 뜨지 않는다):
//   1. 📖 Lookup 토글(좌하단) ON → 단어 선택 시 자동 표시
//   2. 단어 더블클릭 → 항상 표시 (데스크톱)
//   3. 텍스트 선택 후 Ctrl/Cmd+Alt+D → 항상 표시
//   4. Viewer/PDF 선택 툴바의 📖 버튼 → 해당 선택 텍스트 표시
// PWA 오프라인 대응: 조회 결과를 localStorage에 캐시한다.
// ═══════════════════════════════════════════════════════════════

// 단일 영어 단어 또는 짧은 영어 구문 (아포스트로피/하이픈/공백 허용)
const WORD_RE = /^[A-Za-z][A-Za-z' -]{0,49}$/;

// 사전 조회 대상인지 판별 (단어/짧은 구문만 — 그 외엔 절대 트리거 안 됨)
export function isCandidate(text) {
  if (!text) return false;
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 50 && WORD_RE.test(t);
}

// 선택이 무시되어야 하는 영역 (에디터, 입력창, 기존 선택 툴바 등)
const EXCLUDE_SELECTOR = [
  'input', 'textarea', 'select', 'button',
  '[contenteditable="true"]',
  '.cm-content',                      // CodeMirror (MathSpace / Playground)
  '.viewer__md-sel',                  // 마크다운 문제 등록 툴바
  '.pdf-annotator__sel-trigger',      // PDF 하이라이트/문제 툴바
  '.word-lookup',                     // 사전 카드 자체
].join(', ');

// 더블클릭 트리거가 가로채지 말아야 할 영역 (링크/이미지/버튼/에디터 등)
const DBLCLICK_EXCLUDE_SELECTOR = [
  'a', 'img',
  'input', 'textarea', 'select', 'button',
  '[contenteditable="true"]',
  '.cm-content',
  '.viewer__md-sel',
  '.pdf-annotator__sel-trigger',
  '.word-lookup',
].join(', ');

const API_URL = (word) => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;

// ── 조회 결과 캐시 (메모리 + localStorage) ─────────────────────
const CACHE_STORE_KEY = 'wordlookup:cache';
const MODE_STORE_KEY = 'wordlookup:mode';   // 📖 Lookup 토글 상태
const CACHE_MAX = 300;
const cache = new Map();

function loadPersistentCache() {
  try {
    const raw = localStorage.getItem(CACHE_STORE_KEY);
    if (!raw) return;
    for (const [k, v] of Object.entries(JSON.parse(raw))) cache.set(k, v);
  } catch { /* private mode 등 — 무시 */ }
}

function persist(word, data) {
  cache.set(word, data);
  try {
    const raw = localStorage.getItem(CACHE_STORE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[word] = data;
    const keys = Object.keys(obj);
    if (keys.length > CACHE_MAX) {
      for (let i = 0; i < keys.length - CACHE_MAX; i++) delete obj[keys[i]];
    }
    localStorage.setItem(CACHE_STORE_KEY, JSON.stringify(obj));
  } catch { /* quota exceeded — 메모리 캐시만 유지 */ }
}

async function fetchDefinition(word) {
  const cached = cache.get(word);
  if (cached) return cached;
  try {
    const res = await fetch(API_URL(word));
    if (res.status === 404) {
      const data = { notFound: true };
      persist(word, data);
      return data;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();
    const entry = entries && entries[0];
    if (!entry) {
      const data = { notFound: true };
      persist(word, data);
      return data;
    }
    const data = {
      word: entry.word || word,
      phonetic: entry.phonetic || '',
      audio: '',
      meanings: (entry.meanings || []).map((m) => ({
        partOfSpeech: m.partOfSpeech || '',
        definitions: (m.definitions || []).slice(0, 3).map((d) => ({
          definition: d.definition || '',
          example: d.example || '',
        })),
      })),
      origin: entry.origin || '',
    };
    for (const p of entry.phonetics || []) {
      if (!data.phonetic && p.text) data.phonetic = p.text;
      if (!data.audio && p.audio) data.audio = p.audio;
    }
    persist(word, data);
    return data;
  } catch (e) {
    return { error: e.message || 'Network error' };
  }
}

export default function WordLookup() {
  const [state, setState] = useState(null); // { word, x, y, status, data } | null
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(MODE_STORE_KEY) === 'on' ? 'on' : 'off'; } catch { return 'off'; }
  });
  const currentRef = useRef(null);          // 현재 표시 중인 단어 (경쟁 방지)
  const modeRef = useRef(mode);             // 안정 콜백에서 읽을 mode 미러
  const detectTimerRef = useRef(null);
  const fetchTimerRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => { loadPersistentCache(); }, []);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const dismiss = useCallback(() => {
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    currentRef.current = null;
    setState(null);
  }, []);

  const showWord = useCallback((word, x, y) => {
    if (currentRef.current?.word === word) return; // 이미 같은 단어 — 중복 표시 방지
    currentRef.current = { word, x, y };
    const cached = cache.get(word);
    if (cached) {
      setState({ word, x, y, status: 'done', data: cached });
      return;
    }
    setState({ word, x, y, status: 'loading', data: null });
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      fetchDefinition(word).then((data) => {
        if (currentRef.current?.word !== word) return; // 새 단어로 바뀜 — 폐기
        setState((prev) => (prev && prev.word === word ? { ...prev, status: 'done', data } : prev));
      });
    }, 60);
  }, []);

  // 카드를 주어진 사각형 기준으로 열기 (위치 계산 + 중복 방지)
  const openCard = useCallback((word, rect) => {
    if (currentRef.current?.word === word) return; // 이미 같은 단어 표시 중
    const cardW = 320, cardH = 300, gap = 10;
    let x = rect.left + (rect.right - rect.left) / 2 - cardW / 2;
    x = Math.max(gap, Math.min(x, window.innerWidth - cardW - gap));
    let y = rect.top - cardH - gap;
    if (y < gap) y = rect.bottom + gap;
    if (y + cardH > window.innerHeight - gap) y = Math.max(gap, window.innerHeight - cardH - gap);
    showWord(word, Math.round(x), Math.round(y));
  }, [showWord]);

  // 현재 브라우저 선택 텍스트를 카드로 (모드 무관 — 명시적 트리거 전용)
  const openForSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!isCandidate(text)) return;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (!el || !el.closest) return;
    if (el.closest(EXCLUDE_SELECTOR)) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    openCard(text.toLowerCase(), rect);
  }, [openCard]);

  // 선택 변화 감지 — 📖 Lookup 모드가 ON일 때만 자동 표시 (터치 기기는 ✂️ 사용)
  const detect = useCallback(() => {
    if (IS_TOUCH_PRIMARY || modeRef.current !== 'on') return;
    openForSelection();
  }, [openForSelection]);

  // 선택 변화 감지 (데스크톱 드래그 + 모바일 long-press 모두)
  useEffect(() => {
    const onSel = () => {
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
      detectTimerRef.current = setTimeout(detect, 40);
    };
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('mouseup', onSel);
    document.addEventListener('touchend', onSel);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('mouseup', onSel);
      document.removeEventListener('touchend', onSel);
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    };
  }, [detect]);

  // ── 명시적 트리거 ①: 단어 더블클릭 (모드 무관) ──────────────
  useEffect(() => {
    const onDblClick = (e) => {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest(DBLCLICK_EXCLUDE_SELECTOR)) return;
      setTimeout(openForSelection, 0); // 네이티브 단어 선택 반영 대기
    };
    document.addEventListener('dblclick', onDblClick);
    return () => document.removeEventListener('dblclick', onDblClick);
  }, [openForSelection]);

  // ── 명시적 트리거 ②: Ctrl/Cmd+Alt+D (모드 무관) ─────────────
  useEffect(() => {
    const onKey = (e) => {
      if (!((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'd' || e.key === 'D'))) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      if (!isCandidate(sel.toString())) return;
      e.preventDefault();
      openForSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openForSelection]);

  // ── 명시적 트리거 ③: Viewer/PDF 툴바 📖 버튼 (wordlookup:open) ──
  useEffect(() => {
    const onOpen = (e) => {
      const { text, rect } = e.detail || {};
      if (!text || !rect) return;
      if (!isCandidate(text)) return;
      openCard(String(text).replace(/\s+/g, ' ').trim().toLowerCase(), {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      });
    };
    window.addEventListener('wordlookup:open', onOpen);
    return () => window.removeEventListener('wordlookup:open', onOpen);
  }, [openCard]);

  // 바깥 클릭 / 스크롤 / Esc → 닫기
  useEffect(() => {
    if (!state) return;
    const onDown = (e) => { if (!e.target.closest('.word-lookup')) dismiss(); };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [state, dismiss]);

  // 언마운트 시 오디오 정리
  useEffect(() => () => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } }, []);

  const playAudio = useCallback((url) => {
    try {
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      const a = new Audio(url);
      audioRef.current = a;
      a.play().catch(() => { /* autoplay 제한 등 — 무시 */ });
    } catch { /* ignore */ }
  }, []);

  // 📖 Lookup 모드 토글 (localStorage에 유지)
  const toggleMode = () => {
    setMode((m) => {
      const next = m === 'on' ? 'off' : 'on';
      try { localStorage.setItem(MODE_STORE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  };

  const { word, x, y, status, data } = state || {};
  const hasEntry = status === 'done' && data && !data.notFound && !data.error;

  return (
    <>
      {/* 좌하단 고정 토글 — ON이면 단어 선택 시 자동 조회 (데스크톱 전용, 터치는 ✂️ 사용) */}
      {!IS_TOUCH_PRIMARY && (
        <button
          className={'word-lookup__toggle' + (mode === 'on' ? ' word-lookup__toggle--on' : '')}
          onClick={toggleMode}
          aria-pressed={mode === 'on'}
          title={mode === 'on'
            ? 'Lookup mode is ON — select a word to look it up. (Double-click a word also works.)'
            : 'Lookup mode is OFF. Double-click a word, press Ctrl+Alt+D, or use the 📖 button in the selection toolbar.'}
        >
          📖 Lookup{mode === 'on' ? ' ON' : ''}
        </button>
      )}

      {state && (
      <div
        className="word-lookup"
        style={{ left: x, top: y }}
        role="dialog"
        aria-label={`Dictionary: ${word}`}
      >
      <div className="word-lookup__head">
        <span className="word-lookup__word">{word}</span>
        {hasEntry && data.phonetic && <span className="word-lookup__phonetic">{data.phonetic}</span>}
        {hasEntry && data.audio && (
          <button
            className="word-lookup__audio"
            onClick={() => playAudio(data.audio)}
            title="Play pronunciation"
            aria-label="Play pronunciation"
          >🔊</button>
        )}
        <button className="word-lookup__close" onClick={dismiss} aria-label="Close dictionary">×</button>
      </div>

      <div className="word-lookup__body">
        {status === 'loading' && (
          <div className="word-lookup__loading">
            <span className="word-lookup__spinner" />
            Looking up…
          </div>
        )}
        {status === 'done' && data && data.notFound && (
          <div className="word-lookup__empty">No dictionary entry found for “{word}”.</div>
        )}
        {status === 'done' && data && data.error && (
          <div className="word-lookup__empty">Couldn’t load the dictionary ({data.error}).</div>
        )}
        {hasEntry && (
          <ul className="word-lookup__meanings">
            {data.meanings.map((m, i) => (
              <li key={i} className="word-lookup__meaning">
                {m.partOfSpeech && <div className="word-lookup__pos">{m.partOfSpeech}</div>}
                <ol className="word-lookup__defs">
                  {m.definitions.map((d, j) => (
                    <li key={j} className="word-lookup__def">
                      <span className="word-lookup__def-text">{d.definition}</span>
                      {d.example && <span className="word-lookup__example">“{d.example}”</span>}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
        {hasEntry && data.origin && <div className="word-lookup__origin">Origin: {data.origin}</div>}
      </div>

      <div className="word-lookup__foot">English–English · dictionaryapi.dev</div>
      </div>
      )}
    </>
  );
}

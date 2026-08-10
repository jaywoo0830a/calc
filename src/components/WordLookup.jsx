import { useState, useCallback, useEffect, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════
// WordLookup — 마크다운/PDF 텍스트에서 단어를 드래그하면
// 영영사전(dictionaryapi.dev) 정의가 오버레이로 표시된다.
// PWA 오프라인 대응: 조회 결과를 localStorage에 캐시한다.
// ═══════════════════════════════════════════════════════════════

// 단일 영어 단어 또는 짧은 영어 구문 (아포스트로피/하이픈/공백 허용)
const WORD_RE = /^[A-Za-z][A-Za-z' -]{0,49}$/;

// 선택이 무시되어야 하는 영역 (에디터, 입력창, 기존 선택 툴바 등)
const EXCLUDE_SELECTOR = [
  'input', 'textarea', 'select', 'button',
  '[contenteditable="true"]',
  '.cm-content',                      // CodeMirror (MathSpace / Playground)
  '.viewer__md-sel',                  // 마크다운 문제 등록 툴바
  '.pdf-annotator__sel-trigger',      // PDF 하이라이트/문제 툴바
  '.word-lookup',                     // 사전 카드 자체
].join(', ');

const API_URL = (word) => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;

// ── 조회 결과 캐시 (메모리 + localStorage) ─────────────────────
const CACHE_STORE_KEY = 'wordlookup:cache';
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
  const currentRef = useRef(null);          // 현재 표시 중인 단어 (경쟁 방지)
  const detectTimerRef = useRef(null);
  const fetchTimerRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => { loadPersistentCache(); }, []);

  const dismiss = useCallback(() => {
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    currentRef.current = null;
    setState(null);
  }, []);

  const showWord = useCallback((word, x, y) => {
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

  // ── 선택 감지: 영어 단어/짧은 구문이면 카드 표시 ─────────────
  const detect = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 50 || !WORD_RE.test(text)) return;

    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentElement : node;
    if (!el || !el.closest) return;
    if (el.closest(EXCLUDE_SELECTOR)) return;

    const word = text.toLowerCase();
    if (currentRef.current?.word === word) return; // 이미 같은 단어 표시 중

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const cardW = 320, cardH = 300, gap = 10;
    let x = rect.left + rect.width / 2 - cardW / 2;
    x = Math.max(gap, Math.min(x, window.innerWidth - cardW - gap));
    let y = rect.top - cardH - gap;
    if (y < gap) y = rect.bottom + gap;
    if (y + cardH > window.innerHeight - gap) y = Math.max(gap, window.innerHeight - cardH - gap);

    showWord(word, Math.round(x), Math.round(y));
  }, [showWord]);

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

  if (!state) return null;
  const { word, x, y, status, data } = state;
  const hasEntry = status === 'done' && data && !data.notFound && !data.error;

  return (
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
  );
}

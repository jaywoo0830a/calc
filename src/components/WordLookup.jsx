import { useState, useCallback, useEffect, useRef } from 'react';

// ═══════════════════════════════════════════════════════════════
// WordLookup — 영영사전(dictionaryapi.dev) 표시 전용 컴포넌트
// ─────────────────────────────────────────────────────────────
// 자체 트리거가 없다. 오직 RangeSelect(✂️ Selecting)의 액션 바에서
// 발생하는 'wordlookup:open' 이벤트를 받아 정의 카드를 띄운다.
// (Android 네이티브 AI 선택 팝업과 겹치지 않도록 트리거를 단일화)
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
  const fetchTimerRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => { loadPersistentCache(); }, []);

  const dismiss = useCallback(() => {
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

  // ── 유일한 트리거: RangeSelect 액션 바의 📖 (wordlookup:open) ──
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

  const { word, x, y, status, data } = state || {};
  const hasEntry = status === 'done' && data && !data.notFound && !data.error;

  if (!state) return null;
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

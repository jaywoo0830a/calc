import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { isCandidate, lookupDefinition, PROVIDER_LABEL } from '../lib/dictionary.js';
import { api } from '../lib/api.js';

// ═══════════════════════════════════════════════════════════════
// WordLookup — 영영사전(Wiktionary) 표시 전용 컴포넌트
// ─────────────────────────────────────────────────────────────
// 자체 트리거가 없다. 오직 RangeSelect(✂️ Selecting)의 액션 바에서
// 발생하는 'wordlookup:open' 이벤트를 받아 정의 카드를 띄운다.
// (Android 네이티브 AI 선택 팝업과 겹치지 않도록 트리거를 단일화)
// PWA 오프라인 대응: 조회 결과를 localStorage에 캐시한다.
// ═══════════════════════════════════════════════════════════════

// RangeSelect가 여기서 import함 — 재수출로 호환 유지
export { isCandidate };

// ── 조회 결과 캐시 (메모리 + localStorage) ─────────────────────
// v2: 빈 정의를 담던 옛 Wiktionary 응답 캐시 폐기
const CACHE_STORE_KEY = 'wordlookup:cache:v2';
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
  const data = await lookupDefinition(word);
  persist(word, data);
  return data;
}

export default function WordLookup() {
  const [state, setState] = useState(null); // { word, x, y, status, data } | null
  const [aliases, setAliases] = useState([]); // 나만의 의미 (⭐)
  const currentRef = useRef(null);          // 현재 표시 중인 단어 (경쟁 방지)
  const fetchTimerRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => { loadPersistentCache(); }, []);

  // 카드가 떠 있을 때마다 나만의 의미 목록 로드 (실패는 조용히 빈 목록)
  useEffect(() => {
    const word = state?.word;
    if (!word) { setAliases([]); return; }
    let live = true;
    api.listVocabAliases(word).then((list) => {
      if (live) setAliases(list || []);
    }).catch(() => { if (live) setAliases([]); });
    return () => { live = false; };
  }, [state?.word]);

  const dismiss = useCallback(() => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    currentRef.current = null;
    setState(null);
  }, []);

  // 찾아본 단어 기록 — 정의가 있는 경우에만 서버 단어장에 저장 (실패는 조용히 무시)
  const recordLookup = useCallback((word, data) => {
    if (data && !data.notFound && !data.error) api.recordVocab(word).catch(() => {});
  }, []);

  const showWord = useCallback((word, x, y) => {
    if (currentRef.current?.word === word) return; // 이미 같은 단어 — 중복 표시 방지
    currentRef.current = { word, x, y };
    setAliases([]);

    // 사전 카드 표시 (기존 경로 — 캐시/API)
    const showDictionary = (cached, record) => {
      if (cached) {
        if (record) recordLookup(word, cached);
        setState({ word, x, y, status: 'done', data: cached });
        return;
      }
      setState({ word, x, y, status: 'loading', data: null });
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = setTimeout(() => {
        fetchDefinition(word).then((data) => {
          if (currentRef.current?.word !== word) return; // 새 단어로 바뀜 — 폐기
          recordLookup(word, data);
          setState((prev) => (prev && prev.word === word ? { ...prev, status: 'done', data } : prev));
        });
      }, 60);
    };

    // ⭐ 나만의 의미가 정의돼 있으면 사전 API 없이 그것만 표시
    api.listVocabAliases(word).then((list) => {
      if (currentRef.current?.word !== word) return;
      if (list && list.length > 0) {
        setAliases(list);
        recordLookup(word, { ok: true }); // 단어장 기록만
        setState({ word, x, y, status: 'done', data: null });
        return;
      }
      setAliases([]);
      showDictionary(cache.get(word), true);
    }).catch(() => {
      // 서버 응답 없음(오프라인 등) — 기존 사전 경로로 폴백
      if (currentRef.current?.word !== word) return;
      showDictionary(cache.get(word), true);
    });
  }, [recordLookup]);

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

  // 명시적으로 닫을 때만 사라짐 — 카드의 × 버튼 또는 Esc
  // (스크롤/바깥 클릭으로는 닫히지 않는다 — 읽다가 사라지는 것 방지)
  useEffect(() => {
    if (!state) return;
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, dismiss]);

  // 언마운트 시 오디오 정리
  useEffect(() => () => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } }, []);

  // 언마운트 시 진행 중인 fetch 타이머 정리 (누수 방지)
  useEffect(() => () => { if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current); }, []);

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

  // Native Fullscreen(예: PDF)에서는 body 외부 요소가 안 보이므로 포털로 이동
  const portalTarget = useFullscreenPortal();
  if (!state || !portalTarget) return null;
  return createPortal(
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
        {aliases.length > 0 && (
          <div className="word-lookup__aliases">
            <div className="word-lookup__aliases-title">⭐ My meaning</div>
            <ol className="word-lookup__aliases-list">
              {aliases.map((a, i) => (
                <li key={i} className="word-lookup__alias">
                  {a.alias}
                  {a.example && <span className="word-lookup__alias-example">“{a.example}”</span>}
                </li>
              ))}
            </ol>
          </div>
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

      <div className="word-lookup__foot">
        {hasEntry ? `English–English · ${PROVIDER_LABEL}` : aliases.length > 0 ? '⭐ My meaning' : `English–English · ${PROVIDER_LABEL}`}
      </div>
    </div>,
    portalTarget
  );
}

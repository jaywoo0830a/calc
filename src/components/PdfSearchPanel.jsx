import { useState, useEffect, useRef } from 'react';
import { pdfjs } from 'react-pdf';

// ============================================================
// PDF 전체 텍스트 검색 — 문서 텍스트 인덱스를 백그라운드로 구축하고
// 페이지별 매치(스니펫 + 정규화 하이라이트 좌표)를 제공한다.
// ============================================================

const CACHE_MAX = 3;
const MAX_MATCHES_PER_PAGE = 100; // 페이지당 하이라이트 상한
const MAX_RESULT_PAGES = 300;     // 결과 목록 페이지 상한
const MAX_SNIPPETS = 2;

// 모듈 레벨 인덱스 캐시 — filePath 키. 문서를 오가도 재구축하지 않는다.
const indexCache = new Map(); // filePath -> { pages, done, building, progress, promise, abort }

function pruneCache(keepKey) {
  for (const key of indexCache.keys()) {
    if (indexCache.size <= CACHE_MAX) break;
    if (key !== keepKey) indexCache.delete(key);
  }
}

/** 읽기 순서(y 내림차순 → x 오름차순)로 정렬된 페이지 텍스트 모델을 만든다. */
async function buildPageEntry(page) {
  const tc = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const raw = (tc.items || []).filter((i) => i.str && i.str.trim());
  const sorted = [...raw].sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    return Math.abs(dy) < 1 ? a.transform[4] - b.transform[4] : dy;
  });

  const parts = [];
  let text = '';
  for (const item of sorted) {
    if (text && !text.endsWith(' ')) text += ' ';
    const start = text.length;
    text += item.str;
    parts.push({ start, end: text.length, item });
  }
  return { text, parts, viewport: { width: viewport.width, height: viewport.height, transform: viewport.transform } };
}

/** 인덱스가 없으면 구축 시작, 이미 있으면 공유 (중복 구축 방지). */
function getOrStartIndex({ filePath, pdf, numPages, onProgress }) {
  const cached = indexCache.get(filePath);
  if (cached && (cached.done || cached.building)) return cached;

  const controller = new AbortController();
  const entry = { pages: new Map(), done: false, building: true, progress: 0, promise: null, abort: () => controller.abort() };
  entry.promise = (async () => {
    for (let p = 1; p <= numPages; p++) {
      if (controller.signal.aborted) break;
      try {
        const page = await pdf.getPage(p);
        entry.pages.set(p, await buildPageEntry(page));
      } catch { /* 단일 페이지 실패는 건너뜀 */ }
      entry.progress = p / numPages;
      onProgress?.(entry.progress);
    }
    if (!controller.signal.aborted) {
      entry.done = true;
      entry.building = false;
    } else {
      entry.building = false;
    }
    return entry;
  })();
  indexCache.set(filePath, entry);
  pruneCache(filePath);
  return entry;
}

/** PDF 좌표 → 페이지 크기 대비 정규화 사각형 (0..1). */
function itemRect(item, viewport) {
  const t = pdfjs.Util.transform(viewport.transform, item.transform);
  const h = (item.height > 0 ? item.height : Math.hypot(t[2], t[3]) * 0.9) || 1;
  const w = (item.width > 0 ? item.width : Math.hypot(t[0], t[1]) * 0.5) || 1;
  const x = Math.max(0, t[4] / viewport.width);
  const y = Math.max(0, (t[5] - h) / viewport.height);
  return {
    x,
    y,
    w: Math.min(w / viewport.width, 1 - x),
    h: Math.min(h / viewport.height, 1 - y),
  };
}

/** 매치 범위에 걸친 아이템들을 연속 런으로 묶고, 매치 부분만 덮도록 가로로 좁혀 사각형 목록을 만든다. */
function matchRects(pageEntry, m) {
  const { parts, viewport } = pageEntry;
  const involved = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.end > m.start && part.start < m.end) involved.push(i);
  }
  if (involved.length === 0) return [];

  // 아이템 내 매치 부분만큼 가로 비율로 잘라낸 사각형
  const partial = (i) => {
    const part = parts[i];
    const len = Math.max(1, part.end - part.start);
    const lo = (Math.max(m.start, part.start) - part.start) / len;
    const hi = (Math.min(m.end, part.end) - part.start) / len;
    const r = itemRect(part.item, viewport);
    return { x: r.x + lo * r.w, y: r.y, w: Math.max(0.004, (hi - lo) * r.w), h: r.h };
  };

  const rects = [];
  let run = [involved[0]];
  for (let i = 1; i < involved.length; i++) {
    if (involved[i] === run[run.length - 1] + 1) {
      run.push(involved[i]);
    } else {
      rects.push(unionRun(run, partial));
      run = [involved[i]];
    }
  }
  rects.push(unionRun(run, partial));
  return rects;
}

function unionRun(indices, partial) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of indices) {
    const r = partial(i);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 매치 주변 문맥 스니펫 (검색어는 따로 분리해 하이라이트). */
function makeSnippet(text, m) {
  const ctx = 45;
  const start = Math.max(0, m.start - ctx);
  const end = Math.min(text.length, m.end + ctx);
  return {
    pre: text.slice(start, m.start).replace(/\s+/g, ' '),
    q: text.slice(m.start, m.end).replace(/\s+/g, ' '),
    post: text.slice(m.end, end).replace(/\s+/g, ' '),
  };
}

/** 인덱스 전체에서 대소문자 무시 부분 문자열 검색. */
function searchEntry(entry, query) {
  const q = query.toLowerCase();
  const results = [];
  for (const [pageNumber, pageEntry] of entry.pages) {
    const lower = pageEntry.text.toLowerCase();
    const matches = [];
    let idx = lower.indexOf(q);
    while (idx !== -1 && matches.length < MAX_MATCHES_PER_PAGE) {
      matches.push({ start: idx, end: idx + q.length });
      idx = lower.indexOf(q, idx + 1);
    }
    if (matches.length === 0) continue;

    const rects = [];
    for (const m of matches) rects.push(...matchRects(pageEntry, m));
    const snippets = matches.slice(0, MAX_SNIPPETS).map((m) => makeSnippet(pageEntry.text, m));
    results.push({ pageNumber, count: matches.length, rects, snippets });
    if (results.length >= MAX_RESULT_PAGES) break;
  }
  return results;
}

// ============================================================

export default function PdfSearchPanel({ filePath, pdf, numPages, open, onClose, onJump, onHitsChange }) {
  const [query, setQuery] = useState('');
  const [progress, setProgress] = useState(0);      // 0..1
  const [indexReady, setIndexReady] = useState(false);
  const [results, setResults] = useState([]);
  const entryRef = useRef(null);
  const inputRef = useRef(null);

  // 문서가 바뀌면 인덱스 구축/공유 — pdf 프록시는 onLoadSuccess 후에 들어온다
  useEffect(() => {
    setIndexReady(false);
    setProgress(0);
    setResults([]);
    entryRef.current = null;
    if (!filePath || !pdf || !numPages) return;

    let cancelled = false;
    const entry = getOrStartIndex({
      filePath,
      pdf,
      numPages,
      onProgress: (p) => { if (!cancelled) setProgress(p); },
    });
    entryRef.current = entry;
    if (entry.done) {
      setIndexReady(true);
      setProgress(1);
    } else {
      entry.promise.then((e) => {
        if (!cancelled && e.done) {
          setIndexReady(true);
          setProgress(1);
        }
      });
    }
    return () => { cancelled = true; };
  }, [filePath, pdf, numPages]);

  // 검색 (디바운스) — 인덱스가 점점 채워질 때마다 재실행
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      onHitsChange?.(new Map());
      return;
    }
    const t = setTimeout(() => {
      const entry = entryRef.current;
      if (!entry || entry.pages.size === 0) {
        setResults([]);
        return;
      }
      const res = searchEntry(entry, q);
      setResults(res);
      const hits = new Map();
      for (const r of res) {
        if (r.rects.length > 0) hits.set(r.pageNumber, r.rects);
      }
      onHitsChange?.(hits);
    }, 200);
    return () => clearTimeout(t);
  }, [query, progress, indexReady, filePath, onHitsChange]);

  // 열릴 때 입력 포커스
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const q = query.trim();
  const totalHits = results.reduce((sum, r) => sum + r.count, 0);

  return (
    <>
      <div className={'pdf-annotator__toc-sidebar' + (open ? ' pdf-annotator__toc-sidebar--open' : '')}>
        <div className="pdf-annotator__toc-header">
          <span>🔎 Search</span>
          <button className="pdf-annotator__toc-close" onClick={onClose}>×</button>
        </div>
        <div className="pdf-annotator__search-body">
          <input
            ref={inputRef}
            className="pdf-annotator__search-input"
            type="search"
            placeholder="Search this document…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && results.length > 0) onJump(results[0].pageNumber);
            }}
          />
          <div className="pdf-annotator__search-status">
            {!indexReady ? (
              `Indexing text… page ${Math.min(numPages, Math.max(1, Math.round(progress * numPages)))} / ${numPages}`
            ) : q ? (
              `${results.length} page${results.length === 1 ? '' : 's'} · ${totalHits} match${totalHits === 1 ? '' : 'es'}`
            ) : (
              'Type to search all pages'
            )}
          </div>
          <div className="pdf-annotator__toc-list">
            {!indexReady ? (
              <div className="pdf-annotator__toc-item" style={{ opacity: 0.5, cursor: 'default' }}>
                {Math.round(progress * 100)}%
              </div>
            ) : q && results.length === 0 ? (
              <div className="pdf-annotator__toc-item" style={{ opacity: 0.5, cursor: 'default' }}>
                No matches
              </div>
            ) : (
              results.map((r) => (
                <button
                  key={r.pageNumber}
                  className="pdf-annotator__search-item"
                  onClick={() => onJump(r.pageNumber)}
                  title={`Go to page ${r.pageNumber}`}
                >
                  <span className="pdf-annotator__search-head">
                    <span className="pdf-annotator__search-page">p.{r.pageNumber}</span>
                    <span className="pdf-annotator__search-count">{r.count}×</span>
                  </span>
                  {r.snippets.map((s, i) => (
                    <span key={i} className="pdf-annotator__search-snippet">
                      …{s.pre}<mark>{s.q}</mark>{s.post}…
                    </span>
                  ))}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="pdf-annotator__toc-overlay" onClick={onClose} />
    </>
  );
}

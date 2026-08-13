import { useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { lookupDefinition } from '../lib/dictionary.js';

// ── Vocab — 찾아본 단어장 (서버 DB) ─────────────────────────────────────────
// WordLookup이 정의 카드를 띄울 때마다 서버에 기록되고, 이 페이지에서
// 단어 목록/횟수/마지막 조회 시각을 보고 클릭하면 정의를 다시 볼 수 있다.

/** "3m ago / 2h ago / 5d ago / 날짜" 상대 시각 */
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
}

export default function Vocab() {
  const [items, setItems] = useState(null);        // null = 로딩 중
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState(null);  // { word, status, data }
  const expandedRef = useRef(null);

  const refresh = useCallback(() => {
    setLoadError(false);
    api.listVocab().then(setItems).catch(() => { setItems(null); setLoadError(true); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // 단어 클릭 → 정의 펼치기/접기
  const toggleWord = useCallback((word) => {
    if (expandedRef.current === word) {
      expandedRef.current = null;
      setExpanded(null);
      return;
    }
    expandedRef.current = word;
    setExpanded({ word, status: 'loading', data: null });
    lookupDefinition(word).then((data) => {
      if (expandedRef.current !== word) return;
      setExpanded({ word, status: 'done', data });
    });
  }, []);

  const removeWord = useCallback((word, e) => {
    e.stopPropagation();
    api.deleteVocab(word).then(refresh).catch(() => {});
  }, [refresh]);

  const clearAll = useCallback(() => {
    if (!window.confirm('Clear the whole vocabulary list?')) return;
    api.clearVocab().then(refresh).catch(() => {});
  }, [refresh]);

  return (
    <main className="vocab">
      <nav className="calculator__nav">
        <Link to="/" className="calculator__nav-tab">Calc</Link>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <Link to="/math" className="calculator__nav-tab">Math Space</Link>
        <span className="calculator__nav-tab calculator__nav-tab--active">Vocab</span>
      </nav>

      <div className="vocab__head">
        <h1 className="vocab__title">📖 Vocabulary</h1>
        <span className="vocab__count">
          {items ? items.length + (items.length === 1 ? ' word' : ' words') : '…'}
        </span>
        {items && items.length > 0 && (
          <button className="vocab__clear" onClick={clearAll}>Clear all</button>
        )}
      </div>

      {loadError ? (
        <div className="vocab__empty">Couldn't load vocabulary — check the server.</div>
      ) : items === null ? (
        <div className="vocab__empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="vocab__empty">No words yet — select a word in the Viewer and press 📖 Lookup.</div>
      ) : (
        <ul className="vocab__list">
          {items.map((it) => (
            <li key={it.word} className="vocab__item">
              <div
                className="vocab__row"
                role="button"
                tabIndex={0}
                onClick={() => toggleWord(it.word)}
                onKeyDown={(e) => { if (e.key === 'Enter') toggleWord(it.word); }}
              >
                <span className="vocab__word">{it.word}</span>
                <span className="vocab__meta">×{it.count} · {timeAgo(it.last_at)}</span>
                <button
                  className="vocab__delete"
                  onClick={(e) => removeWord(it.word, e)}
                  title="Remove"
                  aria-label={`Remove ${it.word}`}
                >🗑</button>
              </div>
              {expanded && expanded.word === it.word && (
                <div className="vocab__defs">
                  {expanded.status === 'loading' && <div className="vocab__loading">Looking up…</div>}
                  {expanded.status === 'done' && expanded.data.notFound && (
                    <div className="vocab__loading">No entry found.</div>
                  )}
                  {expanded.status === 'done' && expanded.data.error && (
                    <div className="vocab__loading">Couldn't load ({expanded.data.error}).</div>
                  )}
                  {expanded.status === 'done' && !expanded.data.notFound && !expanded.data.error && (
                    expanded.data.meanings.map((m, i) => (
                      <div key={i} className="vocab__meaning">
                        {m.partOfSpeech && <span className="vocab__pos">{m.partOfSpeech}</span>}
                        <ol className="vocab__def-list">
                          {m.definitions.map((d, j) => (
                            <li key={j} className="vocab__def">
                              {d.definition}
                              {d.example && <span className="vocab__example">“{d.example}”</span>}
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

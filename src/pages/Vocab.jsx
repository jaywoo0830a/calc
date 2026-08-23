import { useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { lookupDefinition } from '../lib/dictionary.js';
import { useClearGate } from '../hooks/useClearGate.js';
import ClearGate from '../components/ClearGate.jsx';

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
  const [aliases, setAliases] = useState([]);      // 나만의 의미 (⭐)
  const [aliasInput, setAliasInput] = useState('');
  const [exampleInput, setExampleInput] = useState(''); // 의미와 함께 입력할 예문
  const [quiz, setQuiz] = useState(null);          // 🧠 퀴즈 (My meaning 정의된 단어만)
  const [quizCount, setQuizCount] = useState(0);   // 퀴즈 가능 단어 수
  const { requireClear, gateProps } = useClearGate(); // 파괴적 작업 비밀번호 게이트
  const expandedRef = useRef(null);

  const refreshQuizCount = useCallback(() => {
    api.listAllVocabAliases().then((list) => {
      setQuizCount(new Set((list || []).map((r) => r.word)).size);
    }).catch(() => setQuizCount(0));
  }, []);

  const refresh = useCallback(() => {
    setLoadError(false);
    api.listVocab().then(setItems).catch(() => { setItems(null); setLoadError(true); });
    refreshQuizCount();
  }, [refreshQuizCount]);
  useEffect(() => { refresh(); }, [refresh]);

  const refreshAliases = useCallback((word) => {
    api.listVocabAliases(word).then(setAliases).catch(() => setAliases([]));
  }, []);

  // 단어 클릭 → 정의 펼치기/접기
  const toggleWord = useCallback((word) => {
    if (expandedRef.current === word) {
      expandedRef.current = null;
      setExpanded(null);
      return;
    }
    expandedRef.current = word;
    setExpanded({ word, status: 'loading', data: null });
    setAliasInput('');
    setExampleInput('');
    refreshAliases(word);
    lookupDefinition(word).then((data) => {
      if (expandedRef.current !== word) return;
      setExpanded({ word, status: 'done', data });
    });
  }, [refreshAliases]);

  // 나만의 의미 추가 (1단어 → N개, 예문 선택)
  const addAlias = useCallback((e) => {
    e.preventDefault();
    const word = expandedRef.current;
    const alias = aliasInput.replace(/\s+/g, ' ').trim();
    const example = exampleInput.replace(/\s+/g, ' ').trim();
    if (!word || !alias) return;
    api.addVocabAlias(word, alias, example).then(() => {
      setAliasInput('');
      setExampleInput('');
      refreshAliases(word);
      refreshQuizCount();
    }).catch(() => {});
  }, [aliasInput, exampleInput, refreshAliases, refreshQuizCount]);

  const removeAlias = useCallback((word, alias) => {
    requireClear('Delete this meaning', () => {
      api.deleteVocabAlias(word, alias).then(() => {
        refreshAliases(word);
        refreshQuizCount();
      }).catch(() => {});
    });
  }, [requireClear, refreshAliases, refreshQuizCount]);

  const removeWord = useCallback((word, e) => {
    e.stopPropagation();
    requireClear('Delete this word', () => {
      api.deleteVocab(word).then(refresh).catch(() => {});
    });
  }, [requireClear, refresh]);

  const clearAll = useCallback(() => {
    api.clearVocab().then(() => { refresh(); refreshQuizCount(); }).catch(() => {});
  }, [refresh, refreshQuizCount]);

  // ── 🧠 퀴즈: My meaning이 정의된 단어만 (meaning → word 리콜) ──
  const startQuiz = useCallback(async () => {
    const list = await api.listAllVocabAliases().catch(() => []);
    const byWord = new Map();
    for (const row of list || []) {
      if (!byWord.has(row.word)) byWord.set(row.word, []);
      byWord.get(row.word).push(row); // { alias, example } 객체 통째로 보관
    }
    const entries = [...byWord.entries()].map(([word, meanings]) => {
      const q = meanings[Math.floor(Math.random() * meanings.length)]; // 뜻 중 하나를 문제로
      return { word, q: q.alias, qExample: q.example || '', meanings };
    });
    // 셔플
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    if (entries.length === 0) return;
    setQuiz({ items: entries, index: 0, score: 0, input: '', feedback: null, done: false });
  }, []);

  const closeQuiz = useCallback(() => setQuiz(null), []);

  const submitQuiz = useCallback(() => {
    setQuiz((q) => {
      if (!q || q.feedback) return q;
      const ok = q.input.trim().toLowerCase() === q.items[q.index].word.toLowerCase();
      return { ...q, feedback: ok ? 'correct' : 'wrong', score: q.score + (ok ? 1 : 0) };
    });
  }, []);

  const nextQuiz = useCallback(() => {
    setQuiz((q) => {
      if (!q) return q;
      if (q.index + 1 >= q.items.length) return { ...q, done: true };
      return { ...q, index: q.index + 1, input: '', feedback: null };
    });
  }, []);

  // 퀴즈 중 Esc 닫기
  useEffect(() => {
    if (!quiz) return;
    const onKey = (e) => { if (e.key === 'Escape') closeQuiz(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quiz, closeQuiz]);

  return (
    <main className="vocab">
      <nav className="calculator__nav">
        <Link to="/" className="calculator__nav-tab">Calc</Link>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <Link to="/math" className="calculator__nav-tab">Math Space</Link>
        <Link to="/fields" className="calculator__nav-tab">Fields</Link>
        <Link to="/units" className="calculator__nav-tab">Units</Link>
        <Link to="/relation" className="calculator__nav-tab">Relation</Link>
        <Link to="/problems" className="calculator__nav-tab">Problems</Link>
        <span className="calculator__nav-tab calculator__nav-tab--active">Vocab</span>
      </nav>

      <div className="vocab__head">
        <h1 className="vocab__title">📖 Vocabulary</h1>
        <span className="vocab__count">
          {items ? items.length + (items.length === 1 ? ' word' : ' words') : '…'}
        </span>
        {quizCount > 0 && (
          <button className="vocab__quiz-start" onClick={startQuiz} title="Quiz your own meanings">
            🧠 Quiz ({quizCount})
          </button>
        )}
        {items && items.length > 0 && (
          <button className="vocab__clear" onClick={() => requireClear('Clear the vocabulary list', clearAll)}>Clear all</button>
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
                  <div className="vocab__aliases">
                    <div className="vocab__aliases-title">⭐ My meaning</div>
                    {aliases.length > 0 && (
                      <ul className="vocab__aliases-list">
                        {aliases.map((a, i) => (
                          <li key={a.alias} className="vocab__alias">
                            <span className="vocab__alias-num">{i + 1}.</span>
                            <span className="vocab__alias-body">
                              <span className="vocab__alias-text">{a.alias}</span>
                              {a.example && <span className="vocab__alias-example">“{a.example}”</span>}
                            </span>
                            <button
                              className="vocab__alias-delete"
                              onClick={() => removeAlias(it.word, a.alias)}
                              title="Remove"
                              aria-label={`Remove ${a.alias}`}
                            >×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <form className="vocab__alias-add" onSubmit={addAlias}>
                      <input
                        className="vocab__alias-input"
                        placeholder="Add your own meaning…"
                        value={aliasInput}
                        onChange={(e) => setAliasInput(e.target.value)}
                      />
                      <input
                        className="vocab__alias-input"
                        placeholder="Example sentence (optional)…"
                        value={exampleInput}
                        onChange={(e) => setExampleInput(e.target.value)}
                      />
                      <button className="vocab__alias-btn" type="submit">Add</button>
                    </form>
                  </div>
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

      {/* 🧠 퀴즈 오버레이 — My meaning이 정의된 단어만 (meaning → word 리콜) */}
      {quiz && (        <div className="vocab__quiz" onClick={closeQuiz} role="dialog" aria-modal="true" aria-label="Vocabulary quiz">
          <div className="vocab__quiz-card" onClick={(e) => e.stopPropagation()}>
            <div className="vocab__quiz-head">
              <span>🧠 Quiz — recall the word</span>
              <button className="vocab__quiz-close" onClick={closeQuiz} aria-label="Close quiz">×</button>
            </div>
            {quiz.done ? (
              <div className="vocab__quiz-result">
                <div className="vocab__quiz-score">Score {quiz.score} / {quiz.items.length}</div>
                <div className="vocab__quiz-actions">
                  <button className="vocab__quiz-btn" onClick={startQuiz}>Try again</button>
                  <button className="vocab__quiz-btn vocab__quiz-btn--ghost" onClick={closeQuiz}>Done</button>
                </div>
              </div>
            ) : (
              <div className="vocab__quiz-body">
                <div className="vocab__quiz-progress">
                  <span>Question {quiz.index + 1} / {quiz.items.length}</span>
                  <span className="vocab__quiz-score-chip">✓ {quiz.score}</span>
                </div>
                <div className="vocab__quiz-q">
                  <span className="vocab__quiz-label">Meaning</span>
                  <span className="vocab__quiz-meaning">{quiz.items[quiz.index].q}</span>
                  {quiz.items[quiz.index].qExample && (
                    <span className="vocab__quiz-example">“{quiz.items[quiz.index].qExample}”</span>
                  )}
                </div>
                <input
                  className="vocab__quiz-input"
                  placeholder="Type the word…"
                  value={quiz.input}
                  autoFocus
                  onChange={(e) => setQuiz((q) => q && { ...q, input: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { quiz.feedback ? nextQuiz() : submitQuiz(); }
                  }}
                />
                {quiz.feedback && (
                  <div className={'vocab__quiz-feedback' + (quiz.feedback === 'correct' ? ' vocab__quiz-feedback--ok' : ' vocab__quiz-feedback--no')}>
                    {quiz.feedback === 'correct'
                      ? '✓ Correct!'
                      : `✗ The word is “${quiz.items[quiz.index].word}”`}
                  </div>
                )}
                <button className="vocab__quiz-btn" onClick={quiz.feedback ? nextQuiz : submitQuiz}>
                  {quiz.feedback ? 'Next' : 'Check'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <ClearGate {...gateProps} />
    </main>
  );
}

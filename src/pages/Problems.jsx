import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { setPendingProblem } from '../lib/problemJump.js';
import { useClearGate } from '../hooks/useClearGate.js';
import ClearGate from '../components/ClearGate.jsx';

// ── Problems — 푼/틀린 문제 모아보기 (서버 DB, Vocab 탭과 유사) ──────────────
// Viewer에서 ✂️ Selecting으로 등록한 문제들을 문서/상태별로 모아 보고,
// 클릭하면 Viewer로 이동해 해당 문제 위치로 점프한다.

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

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'wrong', label: '✗ Wrong' },
  { id: 'solved', label: '✓ Solved' },
];

export default function Problems() {
  const [items, setItems] = useState(null);        // null = 로딩 중
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState('all');
  const navigate = useNavigate();
  const { requireClear, gateProps } = useClearGate(); // 파괴적 작업 비밀번호 게이트

  const refresh = useCallback(() => {
    setLoadError(false);
    api.listProblems().then(setItems).catch(() => { setItems(null); setLoadError(true); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const visible = items ? items.filter((p) => filter === 'all' || p.status === filter) : null;
  const wrongCount = items ? items.filter((p) => p.status === 'wrong').length : 0;

  const docName = (p) => String(p.doc_path || p.doc_id || '').split('/').pop() || 'Document';

  // 행 클릭 → Viewer로 이동 후 해당 문제로 점프
  const openProblem = useCallback((p) => {
    setPendingProblem(p);
    navigate('/viewer');
  }, [navigate]);

  const setStatus = useCallback((p, status, e) => {
    e.stopPropagation();
    api.updateProblem(p.id, { status, attempts: p.attempts + 1 }).then(refresh).catch(() => {});
  }, [refresh]);

  const removeItem = useCallback((p, e) => {
    e.stopPropagation();
    requireClear('Delete this problem', () => {
      api.deleteProblem(p.id).then(refresh).catch(() => {});
    });
  }, [requireClear, refresh]);

  const clearAll = useCallback(() => {
    api.clearProblems().then(refresh).catch(() => {});
  }, [refresh]);

  return (
    <main className="problems">
      <nav className="calculator__nav">
        <Link to="/" className="calculator__nav-tab">Calc</Link>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <Link to="/math" className="calculator__nav-tab">Math Space</Link>
        <Link to="/fields" className="calculator__nav-tab">Fields</Link>
        <Link to="/units" className="calculator__nav-tab">Units</Link>
        <Link to="/relation" className="calculator__nav-tab">Relation</Link>
        <span className="calculator__nav-tab calculator__nav-tab--active">Problems</span>
        <Link to="/vocab" className="calculator__nav-tab">Vocab</Link>
      </nav>

      <div className="problems__head">
        <h1 className="problems__title">📋 Problems</h1>
        <span className="problems__count">
          {items ? items.length + (items.length === 1 ? ' problem' : ' problems') : '…'}
          {wrongCount > 0 && <em className="problems__wrong-count"> · {wrongCount} wrong</em>}
        </span>
        <div className="problems__filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={'problems__filter' + (filter === f.id ? ' problems__filter--active' : '')}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {items && items.length > 0 && (
          <button className="problems__clear" onClick={() => requireClear('Clear all problems', clearAll)}>Clear all</button>
        )}
      </div>

      {loadError ? (
        <div className="problems__empty">Couldn't load problems — check the server.</div>
      ) : items === null ? (
        <div className="problems__empty">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="problems__empty">
          {items.length === 0
            ? 'No problems yet — select text in the Viewer and press ✂️ Selecting.'
            : 'No problems match this filter.'}
        </div>
      ) : (
        <ul className="problems__list">
          {visible.map((p) => (
            <li key={p.id} className={'problems__item problems__item--' + p.status}>
              <div
                className="problems__row"
                role="button"
                tabIndex={0}
                onClick={() => openProblem(p)}
                onKeyDown={(e) => { if (e.key === 'Enter') openProblem(p); }}
                title="Open in Viewer"
              >
                <span className="problems__status" aria-hidden>{p.status === 'solved' ? '✓' : '✗'}</span>
                <span className="problems__body">
                  <span className="problems__src">
                    {docName(p)}{p.ref && !String(p.ref).startsWith('{') ? ` · p.${p.ref}` : ''}
                  </span>
                  <span className="problems__text">{p.text}</span>
                </span>
                <span className="problems__meta">
                  {p.solved_at && (
                    <span className="problems__solved-at" title="Last solved">✓ {timeAgo(p.solved_at)}</span>
                  )}
                  {p.attempts} trie{p.attempts === 1 ? '' : 's'} · {p.wrong_count} wrong · {timeAgo(p.updated_at)}
                </span>
                <button
                  className="problems__solve"
                  title="Mark as solved"
                  aria-label="Mark as solved"
                  onClick={(e) => setStatus(p, 'solved', e)}
                >✓</button>
                <button
                  className="problems__wrong"
                  title="Mark as wrong"
                  aria-label="Mark as wrong"
                  onClick={(e) => setStatus(p, 'wrong', e)}
                >✗</button>
                <button
                  className="problems__delete"
                  title="Delete"
                  aria-label="Delete problem"
                  onClick={(e) => removeItem(p, e)}
                >🗑</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ClearGate {...gateProps} />
    </main>
  );
}

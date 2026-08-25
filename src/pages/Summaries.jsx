import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import AppNav from '../components/AppNav.jsx';
import { getAllSummaries, deleteAnnotation } from '../lib/storage.js';
import { setPendingSummary } from '../lib/summaryJump.js';

// ── 📒 Summaries — 요약 필기 모아보기 (PDF 뷰어에서 분리된 탭) ──
// 스캔한 요약 필기(이미지 주석, 페이지 범위 포함)를 문서별로 모아 보여준다.
// 썸네일 클릭 → Viewer로 이동해 해당 페이지로 점프.

const docName = (fp) => String(fp || '').split('/').pop() || 'Document';

export default function Summaries() {
  const [items, setItems] = useState(null); // null = 로딩 중
  const [loadError, setLoadError] = useState(false);
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    setLoadError(false);
    getAllSummaries().then((list) => {
      setItems(list || []);
      if (list == null) setLoadError(true);
    }).catch(() => { setItems(null); setLoadError(true); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const groups = useMemo(() => {
    if (!items) return [];
    const m = new Map();
    for (const s of items) {
      if (!m.has(s.filePath)) m.set(s.filePath, []);
      m.get(s.filePath).push(s);
    }
    return [...m.entries()];
  }, [items]);

  const openSummary = useCallback((s) => {
    setPendingSummary({ filePath: s.filePath, pageNumber: s.pageNumber });
    navigate('/viewer');
  }, [navigate]);

  const removeItem = useCallback((s, e) => {
    e.stopPropagation();
    deleteAnnotation(s.id).then(() => {
      setItems((prev) => (prev || []).filter((x) => x.id !== s.id));
    }).catch(() => {});
  }, []);

  return (
    <main className="summaries">
      <AppNav />

      <div className="summaries__head">
        <h1 className="summaries__title">📒 Summaries</h1>
        <span className="summaries__count">
          {items ? items.length + (items.length === 1 ? ' summary' : ' summaries') : '…'}
        </span>
      </div>

      {loadError ? (
        <div className="summaries__empty">Couldn't load summaries — check the server.</div>
      ) : items === null ? (
        <div className="summaries__empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="summaries__empty">
          No summaries yet — open a PDF in the Viewer, use 🖼️ Image and pick 📒 Summary in the scan modal.
        </div>
      ) : (
        <div className="summaries__list">
          {groups.map(([fp, list]) => (
            <section key={fp} className="summaries__group">
              <header className="summaries__doc">
                <span>📕 {docName(fp)}</span>
                <span className="summaries__doc-count">{list.length}</span>
              </header>
              <div className="summaries__grid">
                {list.map((s) => (
                  <div
                    key={s.id}
                    className="summaries__card"
                    role="button"
                    tabIndex={0}
                    onClick={() => openSummary(s)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openSummary(s); }}
                    title={`Open p.${s.pageNumber}`}
                  >
                    <img className="summaries__thumb" src={s.dataUrl} alt="" />
                    <span className="summaries__meta">
                      <span className="summaries__range">
                        p.{s.rangeStart || s.pageNumber}–{s.rangeEnd || s.pageNumber}
                      </span>
                      {s.scanner && (
                        <span className="summaries__scanner">
                          {s.scanner === 'ml' ? 'ML' : 'Classic'}
                        </span>
                      )}
                    </span>
                    <button
                      className="summaries__delete"
                      title="Delete summary"
                      aria-label="Delete summary"
                      onClick={(e) => removeItem(s, e)}
                    >×</button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

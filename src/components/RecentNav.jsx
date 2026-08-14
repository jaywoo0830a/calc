import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { subscribeRecent, clearRecent, removeRecent, navigateRecent } from '../lib/recentHistory.js';

// ═══════════════════════════════════════════════════════════════
// RecentNav — 🕘 최근 문서 히스토리 버튼 (✂️ Selecting 옆, 좌하단)
// ─────────────────────────────────────────────────────────────
// 버튼을 누르면 최근에 읽은 문서 목록이 오버레이 패널로 열린다.
// 항목을 탭하면 Viewer가 해당 문서로 바로 이동 (트리 탐색 불필요).
// Native Fullscreen(예: PDF)에서도 보이도록 포털로 렌더링한다.
// ═══════════════════════════════════════════════════════════════

export default function RecentNav() {
  const [state, setState] = useState({ items: [], active: false });
  const [open, setOpen] = useState(false);

  // Viewer의 히스토리 스토어 구독
  useEffect(() => subscribeRecent(setState), []);

  // 바깥 클릭 / Esc / 스크롤 → 패널 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => { if (!e.target.closest('.recent-nav')) setOpen(false); };
    // 패널 내부 리스트 스크롤은 무시 — 배경 문서가 스크롤될 때만 닫기
    const onScroll = (e) => {
      if (e.target.closest && e.target.closest('.recent-nav')) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const portalTarget = useFullscreenPortal();
  // Viewer가 열려 있을 때만(active) 버튼 표시
  if (!portalTarget || !state.active) return null;

  return createPortal(
    <div className="recent-nav">
      <button
        className={'recent-nav__btn' + (open ? ' recent-nav__btn--open' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-pressed={open}
        aria-label="Recent documents"
        title="Recent documents — quickly jump between files"
      >🕘</button>

      {open && (
        <div className="recent-nav__panel">
          <div className="recent-nav__header">
            <span>🕘 Recent</span>
            {state.items.length > 0 && (
              <button className="recent-nav__clear" onClick={clearRecent} title="Clear history">✕</button>
            )}
          </div>
          {state.items.length === 0 ? (
            <div className="recent-nav__empty">No recent documents</div>
          ) : (
            <ul className="recent-nav__list">
              {state.items.map((r) => (
                <li key={r.zipId + '|' + r.path} className="recent-nav__row">
                  <button
                    className="recent-nav__item"
                    onClick={() => { setOpen(false); navigateRecent(r); }}
                    title={r.zipName ? `${r.zipName} / ${r.path}` : r.path}
                  >
                    <span className="recent-nav__icon">{r.path.endsWith('.pdf') ? '📕' : '📄'}</span>
                    <span className="recent-nav__meta">
                      <span className="recent-nav__name">{r.name}</span>
                      {r.zipName && <span className="recent-nav__zip">{r.zipName}</span>}
                    </span>
                  </button>
                  <button
                    className="recent-nav__delete"
                    onClick={() => removeRecent(r)}
                    title={`Remove ${r.name} from recent`}
                    aria-label={`Remove ${r.name} from recent`}
                  >🗑</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>,
    portalTarget
  );
}

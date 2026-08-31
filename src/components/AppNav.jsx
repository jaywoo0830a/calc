import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';

// ============================================================
// AppNav — 전역 내비게이션 (초슬림 2계층 구조)
//  · primary  : Calc / Viewer / Concepts — 상시 노출
//  · secondary: 나머지 탭 — ⋯ 더보기 메뉴 안에 접힘 (활성 시 ⋯에 표시)
// ============================================================

const TABS = [
  { to: '/', label: 'Calc', end: true, primary: true },
  { to: '/viewer', label: 'Viewer', primary: true },
  { to: '/concepts', label: 'Concepts', primary: true },
  { to: '/to-katex', label: 'KaTeX', primary: true },
  { to: '/playground', label: 'Three.js' },
  { to: '/units', label: 'Units' },
  { to: '/relation', label: 'Relation' },
  { to: '/problems', label: 'Problems' },
  { to: '/summaries', label: 'Summaries' },
  { to: '/vocab', label: 'Vocab' },
];

function Tab({ t, onNavigate }) {
  return (
    <NavLink
      to={t.to}
      end={t.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        'app-nav__tab' +
        (t.primary ? ' app-nav__tab--primary' : ' app-nav__tab--secondary') +
        (isActive ? ' app-nav__tab--active' : '')
      }
    >
      {t.label}
    </NavLink>
  );
}

export default function AppNav() {
  const primary = TABS.filter((t) => t.primary);
  const secondary = TABS.filter((t) => !t.primary);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);   // 메뉴 고정 위치 { top, left } (뷰포트 기준)
  const wrapRef = useRef(null);
  const moreRef = useRef(null);
  const menuRef = useRef(null);
  const MENU_W = 176; // 11rem — 메뉴 폭 고정 (우측 정렬 위치를 결정적으로 계산)

  // ⋯ 버튼 아래에 고정 위치 계산 — 내비 스크롤 컨테이너에 갇히지 않게 portal로 렌더.
  // left 기준: scrollbar-gutter(stable)는 우측에만 여백을 두므로 좌측 기준 좌표는 정확.
  const updatePos = () => {
    const r = moreRef.current?.getBoundingClientRect();
    if (r) {
      const cw = document.documentElement.clientWidth;
      setPos({
        top: r.bottom + 4,
        left: Math.min(Math.max(8, r.right - MENU_W), Math.max(8, cw - MENU_W - 8)),
      });
    }
  };

  const toggle = () => {
    if (open) { setOpen(false); setPos(null); return; }
    updatePos();
    setOpen(true);
  };

  // 열린 동안 스크롤/리사이즈에 따라 위치 추적
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  // 바깥 클릭 / Escape → 메뉴 닫기 (메뉴는 portal이므로 wrap+menu 둘 다 확인)
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      const inWrap = wrapRef.current && wrapRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inWrap && !inMenu) { setOpen(false); setPos(null); }
    };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setPos(null); } };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => { setOpen(false); setPos(null); };

  return (
    <nav className="app-nav" aria-label="Main navigation">
      {primary.map((t) => <Tab key={t.to} t={t} onNavigate={close} />)}
      <div className="app-nav__more-wrap" ref={wrapRef}>
        <button
          ref={moreRef}
          type="button"
          className="app-nav__more"
          aria-haspopup="menu"
          aria-expanded={open}
          title="More"
          onClick={toggle}
        >
          ⋯
        </button>
      </div>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="app-nav__more-menu"
          role="menu"
          style={{ top: pos.top, left: pos.left, width: MENU_W }}
        >
          {secondary.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              role="menuitem"
              onClick={close}
              className={({ isActive }) =>
                'app-nav__more-item' + (isActive ? ' app-nav__more-item--active' : '')
              }
            >
              {t.label}
            </NavLink>
          ))}
        </div>,
        document.body
      )}
    </nav>
  );
}

import { NavLink } from 'react-router-dom';

// ============================================================
// AppNav — 전역 내비게이션 탭 (모든 페이지 공용)
// 활성 탭은 현재 라우트로 자동 판정 (NavLink isActive)
// ============================================================

const TABS = [
  { to: '/', label: 'Calc', end: true },
  { to: '/viewer', label: 'Viewer' },
  { to: '/playground', label: 'Three.js' },
  { to: '/math', label: 'Math Space' },
  { to: '/fields', label: 'Fields' },
  { to: '/units', label: 'Units' },
  { to: '/relation', label: 'Relation' },
  { to: '/problems', label: 'Problems' },
  { to: '/concepts', label: 'Concepts' },
  { to: '/summaries', label: 'Summaries' },
  { to: '/vocab', label: 'Vocab' },
];

export default function AppNav() {
  return (
    <nav className="calculator__nav">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            'calculator__nav-tab' + (isActive ? ' calculator__nav-tab--active' : '')
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

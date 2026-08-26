import { forwardRef } from 'react';
import AppNav from './AppNav.jsx';

// ============================================================
// AppLayout — 모든 탭 공용 페이지 셸 (레이아웃은 styles/_layout.scss)
//  · <main className="app-page"> + <AppNav /> 일괄 렌더 — 전 탭 전체 폭 동일
//  · hideNav: 뷰어 풀스크린처럼 내비게이션 숨김
//  · 나머지 props(ref / onKeyDown / tabIndex / style 등)는 main으로 전달
// ============================================================
const AppLayout = forwardRef(function AppLayout(
  { className = '', hideNav = false, children, ...rest },
  ref
) {
  return (
    <main
      ref={ref}
      className={'app-page' + (className ? ' ' + className : '')}
      {...rest}
    >
      {!hideNav && <AppNav />}
      {children}
    </main>
  );
});

export default AppLayout;

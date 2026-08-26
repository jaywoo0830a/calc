import { useEffect } from 'react';

/**
 * usePdfPageKeys — PC 키보드 페이지 넘김.
 * →/PageDown=다음, ←/PageUp=이전, Home=첫 페이지, End=마지막 페이지.
 * 입력 필드·수정자 키 조합은 무시, 줌인(zoomRef>1) 중엔 기본 동작 유지.
 */
export function usePdfPageKeys({ goToPage, numPages, currentPage, zoomRef }) {
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (zoomRef?.current > 1) return; // 줌인 중엔 방향키 기본 동작(스크롤) 유지

      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          goToPage(Math.min(numPages, currentPage + 1));
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          goToPage(Math.max(1, currentPage - 1));
          break;
        case 'Home':
          e.preventDefault();
          goToPage(1);
          break;
        case 'End':
          e.preventDefault();
          goToPage(numPages);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToPage, numPages, currentPage, zoomRef]);
}

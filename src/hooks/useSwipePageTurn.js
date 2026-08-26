import { useCallback, useRef } from 'react';

/**
 * useSwipePageTurn — 터치 좌우 스와이프로 페이지 넘김 (paginated 모드).
 * 리드 모드(tool===null)·줌≤1·단일 손가락일 때만 동작,
 * 가로 스와이프가 세로보다 1.5배 우세하고 60px 이상이어야 한다.
 * @returns {{ onTouchStart, onTouchEnd }}
 */
export function useSwipePageTurn({ goToPage, numPages, currentPage, tool, zoomRef }) {
  const touchStart = useRef({ x: 0, y: 0, time: 0, count: 0 });

  const onTouchStart = useCallback((e) => {
    const count = e.touches?.length || 1;
    touchStart.current = { x: e.touches?.[0]?.clientX || e.clientX, y: e.touches?.[0]?.clientY || e.clientY, time: Date.now(), count };
  }, []);

  const onTouchEnd = useCallback((e) => {
    // Only allow page swiping in read mode (tool === null)
    if (tool !== null) return;
    // Don't swipe when zoomed — user needs to pan/scroll instead
    if (zoomRef?.current > 1) return;
    // Ignore multi-touch (pinch-zoom) — only single-finger swipes count
    if (touchStart.current.count > 1) return;
    if ((e.touches?.length || 0) > 0) return; // still touching with other fingers

    // Paginated mode: only horizontal swipes change pages (vertical = scroll)
    const x = e.changedTouches?.[0]?.clientX ?? e.clientX;
    const y = e.changedTouches?.[0]?.clientY ?? e.clientY;
    const dx = x - touchStart.current.x;
    const dy = y - touchStart.current.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Horizontal swipe must clearly dominate and exceed minimum distance
    const MIN_PAGE_SWIPE = 60;
    if (absDx > absDy * 1.5 && absDx > MIN_PAGE_SWIPE) {
      if (dx < 0) {
        goToPage(Math.min(numPages, currentPage + 1));
      } else {
        goToPage(Math.max(1, currentPage - 1));
      }
    }
  }, [goToPage, numPages, currentPage, tool, zoomRef]);

  return { onTouchStart, onTouchEnd };
}

import { useEffect, useState } from 'react';

/**
 * useVisualViewportKb — 온스크린 키보드 높이 추적 (px).
 * iOS 등 키보드가 오버레이로 덮는 환경에서 visualViewport 기준으로 계산.
 * Android `interactive-widget=resizes-content`에서는 레이아웃 뷰포트도
 * 줄어들어 자연히 0이 된다 (중복 리프트 없음).
 * @returns {number} 키보드 높이 (0 = 키보드 없음)
 */
export function useVisualViewportKb() {
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const compute = () => {
      const docH = document.documentElement.clientHeight;
      setKbH(Math.max(0, docH - (vv.offsetTop + vv.height)));
    };
    compute();
    vv.addEventListener('resize', compute);
    vv.addEventListener('scroll', compute);
    return () => {
      vv.removeEventListener('resize', compute);
      vv.removeEventListener('scroll', compute);
    };
  }, []);
  return kbH;
}

/**
 * 키보드 높이 → 시트를 키보드 위로 들어 올리는 인라인 스타일.
 * @returns {{ transform: string } | undefined}
 */
export function kbLiftStyleOf(kbH) {
  return kbH > 0 ? { transform: `translateY(-${Math.round(kbH)}px)` } : undefined;
}

import { useEffect, useState } from 'react';

// ═══════════════════════════════════════════════════════════════
// fullscreenPortal — Native Fullscreen API 대상 포털 훅
// ─────────────────────────────────────────────────────────────
// 전체화면 요소가 있으면 그 안으로, 없으면 document.body로 렌더링한다.
// (전체화면 모드에서는 body에 있는 외부 요소가 화면에 안 그려지므로,
//  고정 위치 오버레이(✂️ Selecting, 사전 카드)를 포털로 이동해야 보인다)
// ═══════════════════════════════════════════════════════════════
export function useFullscreenPortal() {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    const update = () => {
      setTarget(document.fullscreenElement || document.body);
    };
    update();
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, []);

  return target;
}

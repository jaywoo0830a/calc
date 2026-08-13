import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';

// ── ViewerProblemsFab — 좌하단 플로팅 📋 버튼 (풀스크린 포털) ──────────────────
// ✂️ Selecting / 🕘 Recents / ⏱ Timer / 🎲 Picker와 동일하게 useFullscreenPortal로
// 렌더링해 PDF 네이티브 풀스크린에서도 같은 위치에 표시된다.
// (Viewer DOM에 두면 풀스크린 요소 밖이라 안 보여 "이빨 빠진" 빈자리가 됨)

export default function ViewerProblemsFab({ active, pdfMode, onToggle }) {
  const portalTarget = useFullscreenPortal();
  if (!portalTarget) return null;
  return createPortal(
    <button
      className={'viewer__problems-fab' + (active ? ' viewer__problems-fab--open' : '')}
      onClick={onToggle}
      title={pdfMode ? 'Problems (PDF)' : 'Problems'}
      aria-label="Problems"
    >📋</button>,
    portalTarget
  );
}

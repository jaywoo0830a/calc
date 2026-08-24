import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createCornerEditor } from 'scanic';
import { imageFromDataUrl, detectCorners, scanWithCorners } from '../lib/docScan.js';

/**
 * 📐 scanic 스캔 영역 지정 모달
 * 사진 → 모서리 자동 감지(초기값) → 사용자가 코너 에디터로 4점 확정
 * → Apply 시 원근 보정 → onApply({ dataUrl, aspect })
 * Cancel/Esc → onCancel()
 */
export default function ScanAreaModal({ dataUrl, aspect = 1, onApply, onCancel }) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const busyRef = useRef(false);
  const cbRef = useRef({ onApply, onCancel });
  cbRef.current = { onApply, onCancel };

  useEffect(() => {
    let cancelled = false;
    let img = null;
    (async () => {
      try {
        img = await imageFromDataUrl(dataUrl);
      } catch {
        cbRef.current.onCancel();
        return;
      }
      if (cancelled || !hostRef.current) return;
      // 자동 감지 결과를 초기 모서리로 제시 — 실패하면 에디터 기본 인셋 사각형
      const detected = await detectCorners(img);
      if (cancelled || !hostRef.current) return;
      editorRef.current = createCornerEditor({
        container: hostRef.current,
        image: img,
        corners: detected || undefined,
        magnifier: { zoom: 2, size: 110 },
        onConfirm: async (corners) => {
          if (busyRef.current) return;
          busyRef.current = true;
          try {
            const result = await scanWithCorners(img, corners);
            try { editorRef.current?.destroy(); } catch { /* 이미 파괴됨 */ }
            cbRef.current.onApply(result);
          } catch (err) {
            busyRef.current = false;
            console.warn('[scan-area] extract failed:', err);
          }
        },
        onCancel: () => {
          try { editorRef.current?.destroy(); } catch { /* 이미 파괴됨 */ }
          cbRef.current.onCancel();
        },
      });
    })();
    return () => {
      cancelled = true;
      try { editorRef.current?.destroy(); } catch { /* 이미 파괴됨 */ }
    };
  }, [dataUrl]);

  return createPortal(
    <div className="scan-area-modal" role="dialog" aria-modal="true" aria-label="Adjust scan area">
      <div className="scan-area-modal__card">
        <div className="scan-area-modal__head">
          <span>✂️ Adjust scan area</span>
          <span className="scan-area-modal__hint">Drag the corners to the paper edges — then <b>Apply</b></span>
        </div>
        <div className="scan-area-modal__host" ref={hostRef} />
      </div>
    </div>,
    document.body
  );
}

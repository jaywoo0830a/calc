import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createCornerEditor } from 'scanic';
import { imageFromDataUrl, detectCorners, scanWithCorners } from '../lib/docScan.js';

const METHOD_LABEL = { ml: '🧠 Scanned by ML', classic: '📐 Scanned by Classic', manual: '✋ Manual' };

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
  const methodRef = useRef('manual'); // 어떤 디텍터가 감지했는지 — Apply 결과에 실어 보낸다
  const [method, setMethod] = useState(null);
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
      const m = detected ? detected.method : 'manual';
      methodRef.current = m;
      setMethod(m);
      editorRef.current = createCornerEditor({
        container: hostRef.current,
        image: img,
        corners: detected ? detected.corners : undefined,
        magnifier: { zoom: 2, size: 110 },
        onConfirm: async (corners) => {
          if (busyRef.current) return;
          busyRef.current = true;
          try {
            const result = await scanWithCorners(img, corners);
            try { editorRef.current?.destroy(); } catch { /* 이미 파괴됨 */ }
            cbRef.current.onApply({ dataUrl: result.dataUrl, aspect: result.aspect, method: methodRef.current });
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
          {method ? (
            <span className={'scan-area-modal__method scan-area-modal__method--' + method}>
              {METHOD_LABEL[method] || METHOD_LABEL.manual}
            </span>
          ) : (
            <span className="scan-area-modal__hint">Detecting document edges…</span>
          )}
        </div>
        <div className="scan-area-modal__host" ref={hostRef} />
      </div>
    </div>,
    document.body
  );
}

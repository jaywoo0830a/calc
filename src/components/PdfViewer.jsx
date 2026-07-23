import { useEffect } from 'react';
import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/**
 * 안전한 PDF 뷰어:
 * - 렌더링: 브라우저 내장 <iframe> (메모리 안전, 대용량 OK)
 * - 목차: pdfjs-dist 로 outline 만 추출 → 부모에 전달
 */
export default function PdfViewer({ url, onOutlineReady }) {
  // PDF outline 추출 (렌더링은 iframe이 처리)
  useEffect(() => {
    if (!url || !onOutlineReady) return;
    let cancelled = false;
    const loadingTask = pdfjs.getDocument(url);
    loadingTask.promise.then(async (pdf) => {
      if (cancelled) return;
      try {
        const outline = await pdf.getOutline();
        if (!cancelled && outline?.length) {
          onOutlineReady(outline);
        }
      } catch {}
    }).catch(() => {});
    return () => { cancelled = true; loadingTask.destroy(); };
  }, [url, onOutlineReady]);

  return (
    <iframe
      className="pdf-viewer"
      src={url}
      title="PDF viewer"
    />
  );
}

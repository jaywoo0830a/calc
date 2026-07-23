import { useState, useEffect } from 'react';

/**
 * PDF 뷰어 — 서버 poppler-utils 로 PDF → HTML 변환
 * - 클라이언트: blob → POST /api/pdf → HTML 응답 → 렌더링
 */
export default function PdfViewer({ url, onOutlineReady }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;

        const form = new FormData();
        form.append('file', blob, 'input.pdf');

        const apiRes = await fetch('/api/pdf', { method: 'POST', body: form });
        if (cancelled) return;
        if (!apiRes.ok) {
          const err = await apiRes.json().catch(() => ({}));
          throw new Error(err.error || 'Conversion failed');
        }
        const text = await apiRes.text();
        if (!cancelled) setHtml(text);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => { cancelled = true; };
  }, [url]);

  // outline 은 pdftotext 로는 추출 불가 → TOC 없음
  useEffect(() => {
    if (onOutlineReady && html) onOutlineReady(null);
  }, [html, onOutlineReady]);

  if (error) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__error">
          <p>📕 PDF를 불러올 수 없습니다</p>
          <p className="pdf-viewer__error-detail">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!html) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__loading">📄 서버에서 PDF 변환 중…</div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div
        className="pdf-viewer__content markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

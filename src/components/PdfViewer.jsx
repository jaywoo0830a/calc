import { useState, useEffect } from 'react';

/**
 * PDF → Markdown 변환 요청 + 로딩 상태만 담당
 * 실제 마크다운 렌더링은 부모(Viewer)의 processContent 엔진이 처리
 */
export default function PdfViewer({ url, onMarkdown }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setLoading(true);

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
        const md = await apiRes.text();
        if (!cancelled && md.trim()) {
          onMarkdown(md);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [url, onMarkdown]);

  if (error) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__error">
          <p>📕 PDF 변환 실패</p>
          <p className="pdf-viewer__error-detail">{error.message}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__loading">📄 pandoc 변환 중…</div>
      </div>
    );
  }

  return null; // 마크다운은 부모가 렌더링
}

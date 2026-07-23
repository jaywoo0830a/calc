import { useState, useEffect } from 'react';
import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

/**
 * PDF → HTML 변환 뷰어
 * - pdfjs-dist로 텍스트 추출 → HTML로 재구성
 * - iframe 없이 순수 HTML 렌더링 → 다운로드 링크 문제 없음
 */
export default function PdfViewer({ url, onOutlineReady }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const loadingTask = pdfjs.getDocument(url);

    loadingTask.promise.then(async (pdf) => {
      if (cancelled) return;
      // outline 추출
      if (onOutlineReady) {
        try {
          const outline = await pdf.getOutline();
          if (outline?.length) onOutlineReady(outline);
        } catch {}
      }
      // 모든 페이지 텍스트 추출
      const result = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) break;
        try {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const viewport = page.getViewport({ scale: 1 });
          result.push({ pageNum: i, items: content.items, width: viewport.width, height: viewport.height });
        } catch { result.push({ pageNum: i, items: [], width: 600, height: 800 }); }
      }
      if (!cancelled) setPages(result);
    }).catch((e) => {
      if (!cancelled) setError(e);
    });

    return () => { cancelled = true; loadingTask.destroy(); };
  }, [url, onOutlineReady]);

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

  if (!pages) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__loading">📄 PDF 변환 중…</div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer__content markdown-body">
        {pages.map((page) => {
          // 텍스트 아이템을 y 좌표로 그룹화 → 단락 추정
          const lines = [];
          let currentLine = [];
          let lastY = null;
          const sorted = [...page.items].sort((a, b) => a.transform[5] - b.transform[5] || a.transform[4] - b.transform[4]);

          for (const item of sorted) {
            const y = Math.round(item.transform[5]);
            if (lastY !== null && Math.abs(y - lastY) > 2) {
              if (currentLine.length) lines.push(currentLine);
              currentLine = [];
            }
            currentLine.push(item);
            lastY = y;
          }
          if (currentLine.length) lines.push(currentLine);

          // 행 → HTML
          const html = lines.map((line, li) => {
            const xSorted = [...line].sort((a, b) => a.transform[4] - b.transform[4]);
            const text = xSorted.map((item) => {
              let str = item.str;
              if (item.fontName?.toLowerCase().includes('bold')) {
                str = `<strong>${str}</strong>`;
              }
              return str;
            }).join('');

            const fontSize = line[0]?.height || 12;
            // 큰 글씨 → 제목으로 추정
            if (fontSize > 18) return `<h2>${text}</h2>`;
            if (fontSize > 15) return `<h3>${text}</h3>`;
            return `<span class="pdf-line">${text || '&#8203;'}</span>`;
          }).join('\n');

          return (
            <div key={page.pageNum} id={`pdf-page-${page.pageNum}`} className="pdf-viewer__page-html">
              <span className="pdf-viewer__page-num">{page.pageNum}</span>
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

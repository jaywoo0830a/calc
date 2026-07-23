import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const WINDOW_SIZE = 3;  // 현재 페이지 기준 앞뒤로 렌더링할 페이지 수

/** 간단한 scroll 기반 윈도우 — 대용량 PDF 안정적 처리 */
function useVisibleWindow(numPages, containerRef) {
  const [start, setStart] = useState(1);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!numPages) return;
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      if (timerRef.current) return;
      timerRef.current = requestAnimationFrame(() => {
        timerRef.current = null;
        const st = el.scrollTop;
        // 자식 중 placeholder 높이 기반으로 대략적인 페이지 추정
        const pageHeight = 800; // 대략적 페이지 높이
        const estimated = Math.floor(st / pageHeight) + 1;
        setStart(Math.max(1, estimated - WINDOW_SIZE));
      });
    };

    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => el.removeEventListener('scroll', update);
  }, [numPages]);

  const end = Math.min(numPages || 1, start + WINDOW_SIZE * 2);
  return { start, end };
}

const PdfViewer = forwardRef(function PdfViewer({ url, onOutlineReady }, ref) {
  const [numPages, setNumPages] = useState(null);
  const [pageWidth, setPageWidth] = useState(800);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const { start, end } = useVisibleWindow(numPages, containerRef);

  const scrollToPage = useCallback((page) => {
    const el = document.getElementById(`pdf-page-${page}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setPageWidth(e.contentRect.width - 16);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLoadSuccess = useCallback(async (pdf) => {
    setNumPages(pdf.numPages);
    try {
      const outline = await pdf.getOutline();
      if (onOutlineReady && outline?.length) onOutlineReady(outline);
    } catch {}
  }, [onOutlineReady]);

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

  return (
    <div className="pdf-viewer" ref={containerRef}>
      <Document
        file={url}
        onLoadSuccess={onLoadSuccess}
        onLoadError={setError}
        className="pdf-viewer__document"
      >
        {Array.from({ length: numPages || 0 }, (_, i) => {
          const pn = i + 1;
          const inWindow = pn >= start && pn <= end;
          return (
            <div key={pn} id={`pdf-page-${pn}`} className="pdf-viewer__page-wrap">
              {inWindow ? (
                <Page
                  pageNumber={pn}
                  width={pageWidth || undefined}
                  className="pdf-viewer__page"
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              ) : (
                <div className="pdf-viewer__placeholder" />
              )}
              <span className="pdf-viewer__page-num">{pn}</span>
            </div>
          );
        })}
      </Document>
      {numPages && numPages > 1 && (
        <nav className="pdf-viewer__mini-nav">
          <span className="pdf-viewer__nav-info">{start}-{end} / {numPages}</span>
        </nav>
      )}
    </div>
  );
});

export default PdfViewer;
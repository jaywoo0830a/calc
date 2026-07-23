import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const BUFFER = 2;   // 뷰포트 위아래로 미리 렌더링할 페이지 수

/** 개별 페이지 — 필요할 때만 렌더링 */
function LazyPage({ pageNumber, width, isVisible }) {
  return (
    <div id={`pdf-page-${pageNumber}`} className="pdf-viewer__page-wrap">
      {isVisible ? (
        <Page
          pageNumber={pageNumber}
          width={width || undefined}
          className="pdf-viewer__page"
          renderTextLayer={false}        // 대용량 최적화
          renderAnnotationLayer={false}
        />
      ) : (
        <div className="pdf-viewer__placeholder" />
      )}
      <span className="pdf-viewer__page-num">{pageNumber}</span>
    </div>
  );
}

const PdfViewer = forwardRef(function PdfViewer({ url, onOutlineReady }, ref) {
  const [numPages, setNumPages] = useState(null);
  const [visiblePages, setVisiblePages] = useState(new Set());
  const [pageWidth, setPageWidth] = useState(800);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const observerRef = useRef(null);
  const pageRefs = useRef({});

  // scrollToPage 노출
  const scrollToPage = useCallback((page) => {
    const el = document.getElementById(`pdf-page-${page}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  // 컨테이너 너비 측정
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setPageWidth(e.contentRect.width - 16);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // IntersectionObserver → 보이는 페이지만 렌더링
  useEffect(() => {
    if (!numPages) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const next = new Set(visiblePages);
        let changed = false;
        for (const e of entries) {
          const p = Number(e.target.dataset.page);
          if (e.isIntersecting) {
            if (!next.has(p)) { next.add(p); changed = true; }
          } else {
            if (next.has(p)) { next.delete(p); changed = true; }
          }
        }
        // 버퍼: 보이는 페이지 ± BUFFER 도 렌더링
        if (changed) {
          const min = Math.min(...next);
          const max = Math.max(...next);
          for (let i = Math.max(1, min - BUFFER); i <= Math.min(numPages, max + BUFFER); i++) {
            next.add(i);
          }
          setVisiblePages(next);
        }
      },
      { root: containerRef.current, rootMargin: '200px 0px' }
    );
    observerRef.current = obs;
    // 모든 페이지 placeholder observe
    Object.values(pageRefs.current).forEach((el) => { if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [numPages]);

  // PDF 로드 → outline 추출
  const onLoadSuccess = useCallback(async (pdf) => {
    setNumPages(pdf.numPages);
    try {
      const outline = await pdf.getOutline();
      if (onOutlineReady && outline?.length) {
        onOutlineReady(outline);
      }
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
          return (
            <div
              key={pn}
              ref={(el) => { pageRefs.current[pn] = el; if (el && observerRef.current) observerRef.current.observe(el); }}
              data-page={pn}
            >
              <LazyPage
                pageNumber={pn}
                width={pageWidth || undefined}
                isVisible={visiblePages.has(pn)}
              />
            </div>
          );
        })}
      </Document>
      {numPages && numPages > 1 && (
        <nav className="pdf-viewer__mini-nav">
          <span className="pdf-viewer__nav-info">
            {visiblePages.size > 0 ? `${Math.min(...visiblePages)}-${Math.max(...visiblePages)}` : '…'} / {numPages}
          </span>
        </nav>
      )}
    </div>
  );
});

export default PdfViewer;
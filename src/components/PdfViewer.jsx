import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const PdfViewer = forwardRef(function PdfViewer({ url, onOutlineReady }, ref) {
  const [numPages, setNumPages] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageWidth, setPageWidth] = useState(800);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  // parent 에게 scrollToPage 노출
  const scrollToPage = useCallback((page) => {
    setPageNumber(page);
    const el = document.getElementById(`pdf-page-${page}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  // 컨테이너 너비 측정 → fit-to-width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setPageWidth(e.contentRect.width - 16); // 패딩 보정
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // PDF 문서 로드 → outline 추출
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
        {/* 연속 스크롤: 모든 페이지를 fit-to-width 로 렌더링 */}
        {Array.from({ length: numPages || 0 }, (_, i) => (
          <div key={i} id={`pdf-page-${i + 1}`} className="pdf-viewer__page-wrap">
            <Page
              pageNumber={i + 1}
              width={pageWidth || undefined}
              className="pdf-viewer__page"
              renderTextLayer={true}
              renderAnnotationLayer={true}
            />
            <span className="pdf-viewer__page-num">{i + 1}</span>
          </div>
        ))}
      </Document>

      {/* 미니멀 하단 네비게이션 (현재 페이지만 표시) */}
      {numPages && numPages > 1 && (
        <nav className="pdf-viewer__mini-nav">
          <span className="pdf-viewer__nav-info">{pageNumber} / {numPages}</span>
        </nav>
      )}
    </div>
  );
});

export default PdfViewer;
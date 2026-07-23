import { useState, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Vite 호환 worker 설정
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

export default function PdfViewer({ url }) {
  const [numPages, setNumPages] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState(null);

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

  const zoomIn = useCallback(() => {
    setScale(s => {
      const next = ZOOM_STEPS.find(v => v > s + 0.01) || s * 1.25;
      return Math.min(ZOOM_MAX, next);
    });
  }, []);

  const zoomOut = useCallback(() => {
    setScale(s => {
      const reversed = [...ZOOM_STEPS].reverse();
      const next = reversed.find(v => v < s - 0.01) || s / 1.25;
      return Math.max(ZOOM_MIN, next);
    });
  }, []);

  const zoomReset = useCallback(() => setScale(1), []);

  return (
    <div className="pdf-viewer">
      <nav className="pdf-viewer__toolbar">
        <button className="pdf-viewer__nav-btn" onClick={zoomOut} disabled={scale <= ZOOM_MIN} title="축소">
          ➖
        </button>
        <button className="pdf-viewer__nav-btn" onClick={zoomReset} title="100%">
          {Math.round(scale * 100)}%
        </button>
        <button className="pdf-viewer__nav-btn" onClick={zoomIn} disabled={scale >= ZOOM_MAX} title="확대">
          ➕
        </button>
        {numPages && numPages > 1 && (
          <>
            <span className="pdf-viewer__nav-sep" />
            <button
              className="pdf-viewer__nav-btn"
              disabled={pageNumber <= 1}
              onClick={() => setPageNumber(p => Math.max(1, p - 1))}
              title="이전 페이지"
            >◀</button>
            <span className="pdf-viewer__nav-info">{pageNumber} / {numPages}</span>
            <button
              className="pdf-viewer__nav-btn"
              disabled={pageNumber >= numPages}
              onClick={() => setPageNumber(p => Math.min(numPages, p + 1))}
              title="다음 페이지"
            >▶</button>
          </>
        )}
      </nav>
      <Document
        file={url}
        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
        onLoadError={setError}
        className="pdf-viewer__document"
      >
        <Page
          pageNumber={pageNumber}
          scale={scale}
          className="pdf-viewer__page"
          renderTextLayer={true}
          renderAnnotationLayer={true}
        />
      </Document>
    </div>
  );
}

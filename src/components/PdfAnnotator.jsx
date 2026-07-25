import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { getAnnotations, saveAnnotation, deleteAnnotation } from '../lib/storage.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// ── PDF.js worker: CDN 사용 (Vite 프로덕션 배포에서 가장 안정적) ──
// react-pdf가 내장한 pdfjs-dist 버전과 정확히 일치하는 CDN 사용
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// ── Color palettes ───────────────────────────────────────────────────
const HIGHLIGHT_COLORS = [
  { id: 'yellow',  bg: 'rgba(255, 230, 100, 0.45)', label: '🟡', name: '노랑' },
  { id: 'green',   bg: 'rgba(130, 230, 130, 0.45)', label: '🟢', name: '초록' },
  { id: 'blue',    bg: 'rgba(130, 200, 255, 0.45)', label: '🔵', name: '파랑' },
  { id: 'pink',    bg: 'rgba(255, 180, 200, 0.45)', label: '🩷', name: '분홍' },
  { id: 'orange',  bg: 'rgba(255, 200, 130, 0.50)', label: '🟠', name: '주황' },
];

const UNDERLINE_COLORS = [
  { id: 'red',     color: '#e74c3c', style: 'solid',  label: '🔴', name: '빨강 실선' },
  { id: 'blue',    color: '#3498db', style: 'solid',  label: '🔵', name: '파랑 실선' },
  { id: 'green',   color: '#27ae60', style: 'solid',  label: '🟢', name: '초록 실선' },
  { id: 'red-dash',  color: '#e74c3c', style: 'dashed', label: '🔴〰', name: '빨강 점선' },
  { id: 'blue-dash', color: '#3498db', style: 'dashed', label: '🔵〰', name: '파랑 점선' },
];

const TOOLS = {
  highlight: { label: '🖍️ 형광펜', icon: '🖍️' },
  underline: { label: '⎁ 밑줄', icon: '⎁' },
  comment:   { label: '💬 주석', icon: '💬' },
  pen:       { label: '✒️ 펜', icon: '✒️' },
};

const PEN_COLORS = [
  { id: 'black',  color: '#2c2416', label: '⚫', name: '검정' },
  { id: 'red',    color: '#e74c3c', label: '🔴', name: '빨강' },
  { id: 'blue',   color: '#3498db', label: '🔵', name: '파랑' },
  { id: 'green',  color: '#27ae60', label: '🟢', name: '초록' },
  { id: 'accent', color: '#5c3d2e', label: '🟤', name: '갈색' },
];

function annoRect(a, pageEl) {
  if (!pageEl) return null;
  const pw = pageEl.offsetWidth;
  const ph = pageEl.offsetHeight;
  return {
    left: a.rect.x * pw,
    top: a.rect.y * ph,
    width: a.rect.w * pw,
    height: a.rect.h * ph,
  };
}

export default function PdfAnnotator({ url, filePath }) {
  const [numPages, setNumPages] = useState(0);
  const [annotations, setAnnotations] = useState([]);
  const [tool, setTool] = useState(null); // null = 읽기 모드 (기본)
  const [activeComment, setActiveComment] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  // pen drawing state
  const isDrawing = useRef(false);
  const currentPath = useRef([]);
  const currentPage = useRef(null);
  const containerRef = useRef(null);
  const pageRefs = useRef({});

  // ── Fullscreen API ──────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => setFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ── Load annotations from IndexedDB ─────────────────────
  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(setAnnotations).catch(() => {});
  }, [filePath]);

  // ── Text selection → highlight / underline ──────────────
  const handleMouseUp = useCallback((pageNumber) => (e) => {
    if (!tool || tool === 'comment' || tool === 'erase') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

    const range = sel.getRangeAt(0);
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;

    // Check selection is within this page
    if (!pageEl.contains(range.commonAncestorContainer)) return;

    const pageRect = pageEl.getBoundingClientRect();
    const rects = range.getClientRects();

    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const annotation = {
        filePath,
        pageNumber,
        type: tool,
        color: tool === 'underline' ? underlineColor.color : highlightColor.bg,
        style: tool === 'underline' ? underlineColor.style : undefined,
        text: sel.toString().trim(),
        rect: {
          x: (r.left - pageRect.left) / pageRect.width,
          y: (r.top - pageRect.top) / pageRect.height,
          w: r.width / pageRect.width,
          h: r.height / pageRect.height,
        },
      };
      saveAnnotation(annotation).then((saved) => {
        setAnnotations((prev) => [...prev, saved]);
      });
    }
    sel.removeAllRanges();
  }, [tool, filePath]);

  // ── Pen drawing handlers (pointer events — stylus + touch) ──
  const handlePointerDown = useCallback((pageNumber) => (e) => {
    if (tool !== 'pen') return;
    e.preventDefault();
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    isDrawing.current = true;
    currentPage.current = pageNumber;
    currentPath.current = [{ x, y }];
    pageEl.setPointerCapture?.(e.pointerId);
  }, [tool]);

  const handlePointerMove = useCallback((pageNumber) => (e) => {
    if (!isDrawing.current || tool !== 'pen' || currentPage.current !== pageNumber) return;
    e.preventDefault();
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    currentPath.current.push({ x, y });
  }, [tool]);

  const handlePointerUp = useCallback((pageNumber) => (e) => {
    if (!isDrawing.current || tool !== 'pen') return;
    e.preventDefault();
    isDrawing.current = false;
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) { currentPath.current = []; return; }
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    currentPath.current.push({ x, y });

    if (currentPath.current.length < 2) { currentPath.current = []; return; }

    // Build SVG path data
    const pts = currentPath.current;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i].x} ${pts[i].y}`;
    }

    const annotation = {
      filePath,
      pageNumber: currentPage.current,
      type: 'pen',
      color: penColor.color,
      text: '',
      pathData: d,
      rect: { x: 0, y: 0, w: 1, h: 1 }, // full page for SVG viewBox
    };
    saveAnnotation(annotation).then((saved) => {
      setAnnotations((prev) => [...prev, saved]);
    });
    currentPath.current = [];
    currentPage.current = null;
    pageEl.releasePointerCapture?.(e.pointerId);
  }, [tool, filePath, penColor]);
  const handlePageClick = useCallback((pageNumber) => (e) => {
    if (tool === 'comment') {
      const pageEl = pageRefs.current[pageNumber];
      if (!pageEl) return;
      const pageRect = pageEl.getBoundingClientRect();
      const x = (e.clientX - pageRect.left) / pageRect.width;
      const y = (e.clientY - pageRect.top) / pageRect.height;
      setActiveComment({ pageNumber, x, y });
      setCommentText('');
    }
    // erase tool: click annotation to delete (handled by AnnotationOverlay)
  }, [tool]);

  const submitComment = useCallback(() => {
    if (!activeComment || !commentText.trim()) {
      setActiveComment(null);
      return;
    }
    const annotation = {
      filePath,
      pageNumber: activeComment.pageNumber,
      type: 'comment',
      color: '#ffc864',
      text: commentText.trim(),
      rect: { x: activeComment.x, y: activeComment.y, w: 0.03, h: 0.03 },
    };
    saveAnnotation(annotation).then((saved) => {
      setAnnotations((prev) => [...prev, saved]);
    });
    setActiveComment(null);
    setCommentText('');
  }, [activeComment, commentText, filePath]);

  // ── Delete annotation ────────────────────────────────────
  const removeAnnotation = useCallback((id) => {
    deleteAnnotation(id).then(() => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    });
  }, []);

  // ── Filter annotations by page ──────────────────────────
  const pageAnnotations = useCallback((pageNumber) => {
    return annotations.filter((a) => a.pageNumber === pageNumber);
  }, [annotations]);

  // ── PDF.js 옵션 (cMaps, 표준 폰트 CDN) ────────────────────
  const documentOptions = useMemo(() => ({
    cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
  }), []);

  return (
    <div className={'pdf-annotator' + (fullscreen ? ' pdf-annotator--fullscreen' : '')} ref={containerRef}>
      {/* Toolbar */}
      <div className="pdf-annotator__toolbar">
        <div className="pdf-annotator__tools">
          <button
            className={'pdf-annotator__tool' + (tool === null ? ' pdf-annotator__tool--active' : '')}
            onClick={() => setTool(null)}
          >
            📖 읽기
          </button>
          {Object.entries(TOOLS).map(([key, val]) => (
            <button
              key={key}
              className={'pdf-annotator__tool' + (tool === key ? ' pdf-annotator__tool--active' : '')}
              onClick={() => setTool(key)}
            >
              {val.label}
            </button>
          ))}
        </div>
        {/* Color pickers */}
        <div className="pdf-annotator__tools">
          {tool === 'highlight' && (
            <div className="pdf-annotator__color-picker">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={'pdf-annotator__color-swatch' + (highlightColor.id === c.id ? ' pdf-annotator__color-swatch--active' : '')}
                  style={{ backgroundColor: c.bg }}
                  onClick={() => setHighlightColor(c)}
                  title={c.name}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {tool === 'underline' && (
            <div className="pdf-annotator__color-picker">
              {UNDERLINE_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={'pdf-annotator__color-swatch' + (underlineColor.id === c.id ? ' pdf-annotator__color-swatch--active' : '')}
                  style={{ borderBottom: `3px ${c.style} ${c.color}` }}
                  onClick={() => setUnderlineColor(c)}
                  title={c.name}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {tool === 'pen' && (
            <div className="pdf-annotator__color-picker">
              {PEN_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={'pdf-annotator__color-swatch' + (penColor.id === c.id ? ' pdf-annotator__color-swatch--active' : '')}
                  style={{ backgroundColor: c.color }}
                  onClick={() => setPenColor(c)}
                  title={c.name}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="pdf-annotator__tools">
          <button
            className={'pdf-annotator__tool' + (tool === 'erase' ? ' pdf-annotator__tool--active' : '')}
            onClick={() => setTool('erase')}
            title="클릭한 어노테이션 삭제"
          >
            🧹 지우개
          </button>
          {annotations.length > 0 && (
            <button
              className="pdf-annotator__tool pdf-annotator__tool--danger"
              onClick={() => {
                if (confirm(`모든 어노테이션(${annotations.length}개)을 삭제할까요?`)) {
                  import('../lib/storage.js').then(({ deleteAllAnnotations }) => {
                    deleteAllAnnotations(filePath).then(() => setAnnotations([]));
                  });
                }
              }}
              title="모든 어노테이션 삭제"
            >
              🗑️ 모두 삭제
            </button>
          )}
          <button
            className="pdf-annotator__fullscreen-btn"
            onClick={toggleFullscreen}
            title={fullscreen ? '전체화면 닫기' : '전체화면'}
          >
            {fullscreen ? '⊠' : '⛶'}
          </button>
        </div>
      </div>

      {/* Comment input overlay */}
      {activeComment && (
        <div
          className="pdf-annotator__comment-input"
          style={{
            left: `${activeComment.x * 100}%`,
            top: `${activeComment.y * 100}%`,
          }}
        >
          <textarea
            autoFocus
            rows={3}
            placeholder="주석을 입력하세요…"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) submitComment();
              if (e.key === 'Escape') { setActiveComment(null); setCommentText(''); }
            }}
          />
          <div className="pdf-annotator__comment-actions">
            <button onClick={submitComment}>저장</button>
            <button onClick={() => { setActiveComment(null); setCommentText(''); }}>취소</button>
          </div>
        </div>
      )}

      {/* PDF Document */}
      <div className="pdf-annotator__document">
        {loadError ? (
          <div className="pdf-annotator__error">
            <p>📕 PDF를 불러올 수 없습니다</p>
            <p className="pdf-annotator__error-detail">{loadError}</p>
            <button className="pdf-annotator__retry-btn" onClick={() => { setLoadError(null); setNumPages(0); }}>
              다시 시도
            </button>
          </div>
        ) : (
          <Document
            file={url}
            options={documentOptions}
            onLoadSuccess={({ numPages }) => { setNumPages(numPages); setLoadError(null); }}
            onLoadError={(err) => {
              const msg = err?.message || String(err);
              setLoadError(msg);
              console.error('PDF load error:', err);
            }}
            onSourceError={(err) => console.error('PDF source error:', err)}
            loading={<div className="pdf-annotator__loading">📄 PDF 불러오는 중…</div>}
            noData={<div className="pdf-annotator__error">PDF 파일이 비어있습니다</div>}
          >
          {Array.from({ length: numPages }, (_, i) => {
            const pageNumber = i + 1;
            const annos = pageAnnotations(pageNumber);
            return (
              <div
                key={pageNumber}
                className={'pdf-annotator__page-wrapper' + (tool === 'pen' ? ' pdf-annotator__page-wrapper--pen' : '')}
                ref={(el) => { if (el) pageRefs.current[pageNumber] = el; }}
                onMouseUp={handleMouseUp(pageNumber)}
                onClick={handlePageClick(pageNumber)}
                onPointerDown={handlePointerDown(pageNumber)}
                onPointerMove={handlePointerMove(pageNumber)}
                onPointerUp={handlePointerUp(pageNumber)}
                style={{ touchAction: tool === 'pen' ? 'none' : undefined }}
              >
                <Page
                  pageNumber={pageNumber}
                  width={Math.min(window.innerWidth - 48, 800)}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
                {/* Annotation overlay */}
                {annos.map((a) => (
                  <AnnotationOverlay
                    key={a.id}
                    annotation={a}
                    pageEl={pageRefs.current[pageNumber]}
                    onDelete={removeAnnotation}
                  />
                ))}
                <div className="pdf-annotator__page-number">
                  {pageNumber} / {numPages}
                </div>
              </div>
            );
          })}
        </Document>
        )}
      </div>
    </div>
  );
}

/** Renders a single annotation overlay */
function AnnotationOverlay({ annotation, pageEl, onDelete }) {
  const rect = annoRect(annotation, pageEl);

  // Pen strokes: render as SVG
  if (annotation.type === 'pen' && annotation.pathData) {
    return (
      <svg
        className="pdf-annotator__pen-stroke"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        <path
          d={annotation.pathData}
          fill="none"
          stroke={annotation.color || '#2c2416'}
          strokeWidth="0.003"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Invisible wider hit area for click-to-delete */}
        <path
          d={annotation.pathData}
          fill="none"
          stroke="transparent"
          strokeWidth="0.02"
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
        />
      </svg>
    );
  }

  if (annotation.type === 'comment') {
    return (
      <div
        className="pdf-annotator__comment-marker"
        style={{
          left: rect ? rect.left : `${annotation.rect.x * 100}%`,
          top: rect ? rect.top : `${annotation.rect.y * 100}%`,
        }}
        title={annotation.text}
      >
        <span className="pdf-annotator__comment-icon">💬</span>
        <span className="pdf-annotator__comment-tooltip">{annotation.text}</span>
        <button
          className="pdf-annotator__delete-btn"
          onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
        >
          ×
        </button>
      </div>
    );
  }

  if (!rect) return null;

  const isDashed = annotation.type === 'underline' && annotation.style === 'dashed';

  return (
    <div
      className={'pdf-annotator__mark pdf-annotator__mark--' + annotation.type + (isDashed ? ' pdf-annotator__mark--dashed' : '')}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        backgroundColor: annotation.type === 'highlight' ? annotation.color : 'transparent',
        borderBottom: !isDashed && annotation.type === 'underline'
          ? `2px solid ${annotation.color || UNDERLINE_COLORS[0].color}`
          : (isDashed ? `2px dashed ${annotation.color}` : 'none'),
      }}
      title={annotation.text}
    >
      <button
        className="pdf-annotator__delete-btn"
        onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
      >
        ×
      </button>
    </div>
  );
}

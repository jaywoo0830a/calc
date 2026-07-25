import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { getAnnotations, saveAnnotation, deleteAnnotation } from '../lib/storage.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// ── PDF.js worker: CDN (most reliable for Vite production builds) ──
// Uses the exact pdfjs-dist version bundled with react-pdf
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// ── Color palettes ───────────────────────────────────────────────────
const HIGHLIGHT_COLORS = [
  { id: 'yellow',  bg: 'rgba(255, 230, 100, 0.45)', label: '🟡', name: 'Yellow' },
  { id: 'green',   bg: 'rgba(130, 230, 130, 0.45)', label: '🟢', name: 'Green' },
  { id: 'blue',    bg: 'rgba(130, 200, 255, 0.45)', label: '🔵', name: 'Blue' },
  { id: 'pink',    bg: 'rgba(255, 180, 200, 0.45)', label: '🩷', name: 'Pink' },
  { id: 'orange',  bg: 'rgba(255, 200, 130, 0.50)', label: '🟠', name: 'Orange' },
];

const UNDERLINE_COLORS = [
  { id: 'red',     color: '#e74c3c', style: 'solid',  label: '🔴', name: 'Red Solid' },
  { id: 'blue',    color: '#3498db', style: 'solid',  label: '🔵', name: 'Blue Solid' },
  { id: 'green',   color: '#27ae60', style: 'solid',  label: '🟢', name: 'Green Solid' },
  { id: 'red-dash',  color: '#e74c3c', style: 'dashed', label: '🔴〰', name: 'Red Dashed' },
  { id: 'blue-dash', color: '#3498db', style: 'dashed', label: '🔵〰', name: 'Blue Dashed' },
];

const TOOLS = {
  highlight: { label: '🖍️ Highlight', icon: '🖍️' },
  underline: { label: '⎁ Underline', icon: '⎁' },
  comment:   { label: '💬 Comment', icon: '💬' },
  pen:       { label: '✒️ Pen', icon: '✒️' },
};

const PEN_COLORS = [
  { id: 'black',  color: '#2c2416', label: '⚫', name: 'Black' },
  { id: 'red',    color: '#e74c3c', label: '🔴', name: 'Red' },
  { id: 'blue',   color: '#3498db', label: '🔵', name: 'Blue' },
  { id: 'green',  color: '#27ae60', label: '🟢', name: 'Green' },
  { id: 'accent', color: '#5c3d2e', label: '🟤', name: 'Brown' },
];

const PEN_SIZES = [
  { id: 'thin',   width: 0.002,  label: 'Thin', icon: '·' },
  { id: 'medium', width: 0.004,  label: 'Medium', icon: '◉' },
  { id: 'thick',  width: 0.007,  label: 'Thick', icon: '●' },
];

// ── Bezier smoothing ──────────────────────────────────────────────────
function smoothPathData(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${pts[i].x} ${pts[i].y} ${midX} ${midY}`;
  }
  // final point: straight line
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

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
  const [tool, setTool] = useState(null); // null = read mode (default)
  const [activeComment, setActiveComment] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [layoutMode, setLayoutMode] = useState('vertical'); // 'vertical' | 'horizontal' | 'paginated'
  const [currentPage, setCurrentPage] = useState(1);        // paginated mode current page
  const [alignment, setAlignment] = useState('center');     // 'left' | 'center' | 'right'
  const touchStart = useRef({ x: 0, y: 0, time: 0 });
  const [toc, setToc] = useState(null);         // PDF outline
  const [tocOpen, setTocOpen] = useState(false);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penSize, setPenSize] = useState(PEN_SIZES[1]); // medium default
  // pen drawing state
  const isDrawing = useRef(false);
  const currentPath = useRef([]);
  const penPage = useRef(null);
  const [liveStroke, setLiveStroke] = useState(null); // { pageNumber, color, pathData } | null
  const containerRef = useRef(null);
  const documentRef = useRef(null);
  const pageRefs = useRef({});

  // ── Page navigation ─────────────────────────────────────
  const scrollToPage = useCallback((pageNumber) => {
    if (layoutMode === 'paginated') {
      setCurrentPage(Math.max(1, Math.min(numPages, pageNumber)));
      return;
    }
    const el = pageRefs.current[pageNumber];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: layoutMode === 'horizontal' ? 'nearest' : 'start', inline: 'start' });
    }
  }, [layoutMode, numPages]);

  // ── Swipe detection for paginated mode ──────────────────
  const handleSwipeStart = useCallback((e) => {
    touchStart.current = { x: e.touches?.[0]?.clientX || e.clientX, y: e.touches?.[0]?.clientY || e.clientY, time: Date.now() };
  }, []);

  const handleSwipeEnd = useCallback((e) => {
    if (layoutMode !== 'paginated' && layoutMode !== 'horizontal') return;
    const x = e.changedTouches?.[0]?.clientX ?? e.clientX;
    const y = e.changedTouches?.[0]?.clientY ?? e.clientY;
    const dx = x - touchStart.current.x;
    const dy = y - touchStart.current.y;
    const dt = Date.now() - touchStart.current.time;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Swipe threshold: 50px or fast flick (>0.3px/ms)
    if (absDx < 30 && absDy < 30) return;

    if (layoutMode === 'paginated') {
      if (absDy > absDx && absDy > 30) {
        if (dy < -30 || (dy < -10 && dt < 300)) {
          setCurrentPage((p) => Math.min(numPages, p + 1));
        } else if (dy > 30 || (dy > 10 && dt < 300)) {
          setCurrentPage((p) => Math.max(1, p - 1));
        }
      }
    }
  }, [layoutMode, numPages]);

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
    penPage.current = pageNumber;
    currentPath.current = [{ x, y }];
    setLiveStroke({ pageNumber, color: penColor.color, pathData: `M ${x} ${y}`, width: penSize.width });
    pageEl.setPointerCapture?.(e.pointerId);
  }, [tool, penColor, penSize]);

  // real-time smooth path preview
  const buildLivePath = useCallback((pts) => {
    if (pts.length < 2) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i].x} ${pts[i].y}`;
    }
    return d;
  }, []);

  const handlePointerMove = useCallback((pageNumber) => (e) => {
    if (!isDrawing.current || tool !== 'pen' || penPage.current !== pageNumber) return;
    e.preventDefault();
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    currentPath.current.push({ x, y });
    // real-time update: append point to pathData
    setLiveStroke((prev) => prev ? {
      ...prev,
      pathData: prev.pathData + ` L ${x} ${y}`,
    } : null);
  }, [tool]);

  const handlePointerUp = useCallback((pageNumber) => (e) => {
    if (!isDrawing.current || tool !== 'pen') return;
    e.preventDefault();
    isDrawing.current = false;
    const pageEl = pageRefs.current[pageNumber];
    setLiveStroke(null); // clear live preview

    if (!pageEl) { currentPath.current = []; return; }
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    currentPath.current.push({ x, y });

    if (currentPath.current.length < 2) { currentPath.current = []; return; }

    // Build SVG path data with bezier smoothing
    const d = smoothPathData(currentPath.current);

    const annotation = {
      filePath,
      pageNumber: penPage.current,
      type: 'pen',
      color: penColor.color,
      width: penSize.width,
      text: '',
      pathData: d,
      rect: { x: 0, y: 0, w: 1, h: 1 }, // full page for SVG viewBox
    };
    saveAnnotation(annotation).then((saved) => {
      setAnnotations((prev) => [...prev, saved]);
    });
    currentPath.current = [];
    penPage.current = null;
    pageEl.releasePointerCapture?.(e.pointerId);
  }, [tool, filePath, penColor, penSize]);
  // ── Click → comment note ────────────────────────────────
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
            📖 Read
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
                />
              ))}
            </div>
          )}
          {tool === 'pen' && (
            <>
              <div className="pdf-annotator__color-picker">
                {PEN_COLORS.map((c) => (
                  <button
                    key={c.id}
                    className={'pdf-annotator__color-swatch' + (penColor.id === c.id ? ' pdf-annotator__color-swatch--active' : '')}
                    style={{ backgroundColor: c.color }}
                    onClick={() => setPenColor(c)}
                    title={c.name}
                  >
                    
                  </button>
                ))}
              </div>
              <div className="pdf-annotator__size-picker">
                {PEN_SIZES.map((s) => (
                  <button
                    key={s.id}
                    className={'pdf-annotator__size-btn' + (penSize.id === s.id ? ' pdf-annotator__size-btn--active' : '')}
                    onClick={() => setPenSize(s)}
                    title={s.label}
                  >
                    <span style={{
                      display: 'inline-block',
                      width: (s.width * 300) + 'rem',
                      height: (s.width * 300) + 'rem',
                      borderRadius: '50%',
                      backgroundColor: penColor.color,
                    }} />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="pdf-annotator__tools">
          <button
            className={'pdf-annotator__tool' + (tool === 'erase' ? ' pdf-annotator__tool--active' : '')}
            onClick={() => setTool(tool === 'erase' ? null : 'erase')}
            title="Click annotation to delete"
          >
            🧹 Eraser
          </button>
          {toc && (
            <button
              className={'pdf-annotator__tool' + (tocOpen ? ' pdf-annotator__tool--active' : '')}
              onClick={() => setTocOpen(!tocOpen)}
              title="Outline"
            >
              📑 Outline
            </button>
          )}
          <button
            className="pdf-annotator__fullscreen-btn"
            onClick={toggleFullscreen}
            title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {fullscreen ? '⊠' : '⛶'}
          </button>
        </div>
      </div>

      {/* TOC Sidebar */}
      {toc && (
        <>
          <div className={'pdf-annotator__toc-sidebar' + (tocOpen ? ' pdf-annotator__toc-sidebar--open' : '')}>
            <div className="pdf-annotator__toc-header">
              <span>📑 Outline</span>
              <button className="pdf-annotator__toc-close" onClick={() => setTocOpen(false)}>×</button>
            </div>
            <div className="pdf-annotator__toc-list">
              {toc.map((item, i) => (
                <button
                  key={i}
                  className="pdf-annotator__toc-item"
                  style={{ paddingLeft: `${0.5 + (item.depth || 1) * 0.75}rem` }}
                  onClick={() => {
                    if (item.pageNumber) scrollToPage(item.pageNumber);
                    setTocOpen(false);
                  }}
                >
                  <span className="pdf-annotator__toc-label">{item.title || `(Untitled)`}</span>
                  {item.pageNumber && (
                    <span className="pdf-annotator__toc-page">{item.pageNumber}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <button
            className="pdf-annotator__toc-toggle"
            onClick={() => setTocOpen(!tocOpen)}
            aria-label="Open outline"
          />
          <div className="pdf-annotator__toc-overlay" onClick={() => setTocOpen(false)} />
        </>
      )}

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
            placeholder="Enter a comment…"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) submitComment();
              if (e.key === 'Escape') { setActiveComment(null); setCommentText(''); }
            }}
          />
          <div className="pdf-annotator__comment-actions">
            <button onClick={submitComment}>Save</button>
            <button onClick={() => { setActiveComment(null); setCommentText(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* PDF Document */}
      <div
        className={'pdf-annotator__document pdf-annotator__document--' + layoutMode + ' pdf-annotator__document--align-' + alignment}
        onTouchStart={layoutMode === 'paginated' ? handleSwipeStart : undefined}
        onTouchEnd={layoutMode === 'paginated' ? handleSwipeEnd : undefined}
      >
        {loadError ? (
          <div className="pdf-annotator__error">
            <p>📕 Failed to load PDF</p>
            <p className="pdf-annotator__error-detail">{loadError}</p>
            <button className="pdf-annotator__retry-btn" onClick={() => { setLoadError(null); setNumPages(0); }}>
              Try Again
            </button>
          </div>
        ) : (
          <Document
            file={url}
            options={documentOptions}
            onLoadSuccess={async ({ numPages, getOutline }) => {
              setNumPages(numPages);
              setLoadError(null);
              try {
                const outline = await getOutline();
                setToc(outline?.length > 0 ? outline : null);
              } catch { setToc(null); }
            }}
            onLoadError={(err) => {
              const msg = err?.message || String(err);
              setLoadError(msg);
              console.error('PDF load error:', err);
            }}
            onSourceError={(err) => console.error('PDF source error:', err)}
            loading={<div className="pdf-annotator__loading">📄 Loading PDF…</div>}
            noData={<div className="pdf-annotator__error">No PDF file specified</div>}
          >
          {(layoutMode === 'paginated'
            ? [currentPage - 1]
            : Array.from({ length: numPages }, (_, i) => i)
          ).filter(i => i >= 0 && i < numPages).map((i) => {
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
                  devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
                {/* Live pen stroke (real-time preview) */}
                {liveStroke && liveStroke.pageNumber === pageNumber && (
                  <svg
                    className="pdf-annotator__pen-stroke pdf-annotator__pen-stroke--live"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 25 }}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    <path
                      d={liveStroke.pathData}
                      fill="none"
                      stroke={liveStroke.color}
                      strokeWidth={liveStroke.width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {/* Annotation overlay */}
                {annos.map((a) => (
                  <AnnotationOverlay
                    key={a.id}
                    annotation={a}
                    pageEl={pageRefs.current[pageNumber]}
                    onDelete={removeAnnotation}
                    eraseMode={tool === 'erase'}
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

      {/* Page Navigation Bar */}
      {numPages > 0 && (
        <div className="pdf-annotator__nav">
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => scrollToPage(1)}
            disabled={numPages <= 1}
            title="First page"
          >
            ⟪
          </button>
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => scrollToPage(layoutMode === 'paginated' ? currentPage - 1 : 1)}
            disabled={layoutMode === 'paginated' ? currentPage <= 1 : numPages <= 1}
            title="Previous page"
          >
            ◀
          </button>
          <span className="pdf-annotator__nav-info">
            {layoutMode === 'paginated' ? `${currentPage} / ${numPages}` : `${numPages} pages`}
          </span>
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => scrollToPage(layoutMode === 'paginated' ? currentPage + 1 : numPages)}
            disabled={layoutMode === 'paginated' ? currentPage >= numPages : numPages <= 1}
            title="Next page"
          >
            ▶
          </button>
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => scrollToPage(numPages)}
            disabled={numPages <= 1}
            title="Last page"
          >
            ⟫
          </button>
          {/* Layout mode selector */}
          <div className="pdf-annotator__layout-modes">
            <button
              className={'pdf-annotator__layout-btn' + (layoutMode === 'vertical' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setLayoutMode('vertical')}
              title="Vertical scroll"
            >
              ⬍
            </button>
            <button
              className={'pdf-annotator__layout-btn' + (layoutMode === 'horizontal' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setLayoutMode('horizontal')}
              title="Horizontal scroll"
            >
              ⬌
            </button>
            <button
              className={'pdf-annotator__layout-btn' + (layoutMode === 'paginated' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => { setLayoutMode('paginated'); setCurrentPage(1); }}
              title="Swipe to flip"
            >
              📖
            </button>
          </div>
          {/* Alignment selector */}
          <div className="pdf-annotator__layout-modes">
            <button
              className={'pdf-annotator__layout-btn' + (alignment === 'left' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setAlignment('left')}
              title="Align left"
            >
              ◧
            </button>
            <button
              className={'pdf-annotator__layout-btn' + (alignment === 'center' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setAlignment('center')}
              title="Align center"
            >
              ◰
            </button>
            <button
              className={'pdf-annotator__layout-btn' + (alignment === 'right' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setAlignment('right')}
              title="Align right"
            >
              ◩
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders a single annotation overlay — memoized for performance */
const AnnotationOverlay = memo(function AnnotationOverlay({ annotation, pageEl, onDelete, eraseMode }) {
  const rect = annoRect(annotation, pageEl);
  const handleDelete = eraseMode ? (e) => { e.stopPropagation(); onDelete(annotation.id); } : undefined;

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
          strokeWidth={annotation.width || 0.003}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Invisible wider hit area for click-to-delete (erase mode only) */}
        {eraseMode && (
          <path
            d={annotation.pathData}
            fill="none"
            stroke="transparent"
            strokeWidth="0.02"
            style={{ pointerEvents: 'auto', cursor: 'pointer' }}
            onClick={handleDelete}
          />
        )}
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
        title={annotation.text + (eraseMode ? ' — 클릭하여 삭제' : '')}
        onClick={handleDelete}
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
      title={annotation.text + (eraseMode ? ' — 클릭하여 삭제' : '')}
      onClick={handleDelete}
    >
      <button
        className="pdf-annotator__delete-btn"
        onClick={(e) => { e.stopPropagation(); onDelete(annotation.id); }}
      >
        ×
      </button>
    </div>
  );
});

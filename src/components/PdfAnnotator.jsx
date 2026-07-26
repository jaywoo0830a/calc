import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
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
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

// ── Pressure-based variable-width segments ─────────────────────────────
// Groups consecutive points by pressure level → array of { pathData, width }
function buildPressureSegments(pts, baseWidth) {
  if (pts.length < 2) return [];
  const segments = [];
  let segPts = [pts[0]];
  let segPressure = pts[0].pressure ?? 0.5;

  for (let i = 1; i < pts.length; i++) {
    const p = pts[i].pressure ?? 0.5;
    // Start new segment when pressure changes significantly (>25% delta)
    if (Math.abs(p - segPressure) / Math.max(segPressure, 0.1) > 0.25) {
      if (segPts.length >= 2) {
        const d = smoothPathData(segPts.map(q => ({ x: q.x, y: q.y })));
        segments.push({ pathData: d, width: baseWidth * (0.3 + 0.7 * segPressure) });
      }
      segPts = [pts[i - 1], pts[i]]; // overlap for continuity
      segPressure = p;
    } else {
      segPts.push(pts[i]);
      // Running average pressure for smooth transition
      segPressure = segPressure * 0.7 + p * 0.3;
    }
  }
  // Final segment
  if (segPts.length >= 2) {
    const d = smoothPathData(segPts.map(q => ({ x: q.x, y: q.y })));
    segments.push({ pathData: d, width: baseWidth * (0.3 + 0.7 * segPressure) });
  }
  return segments;
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
  const [currentPage, setCurrentPage] = useState(1);
  const [alignment, setAlignment] = useState('center');
  const [zoomLevel, setZoomLevel] = useState(1); // continuous 0.5–3.0
  const [chromeVisible, setChromeVisible] = useState(true);
  // ── Reading mode (mobile: 2×4 grid sectors) ─────────────
  const [readingMode, setReadingMode] = useState(false);
  const [sectorIndex, setSectorIndex] = useState(0); // 0..7
  const SECTOR_COLS = 2;
  const SECTOR_ROWS = 4;
  const SECTORS = SECTOR_COLS * SECTOR_ROWS;
  // Stable mobile detection: use the shorter axis — works in both orientations
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    const w = window.innerWidth, h = window.innerHeight;
    return Math.min(w, h) < 768;
  });

  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const mobile = Math.min(w, h) < 768;
      setIsMobile(mobile);
      if (!mobile) setReadingMode(false); // exit reading mode on tablet/desktop
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Platform detection (set by inline script in index.html)
  const isIOS = typeof document !== 'undefined' && document.documentElement.classList.contains('is-ios');

  // ── Sector navigation helper ─────────────────────────────
  const navigateSector = useCallback((delta) => {
    const next = sectorIndex + delta;
    if (next < 0) {
      if (currentPage > 1) {
        setCurrentPage(p => p - 1);
        setSectorIndex(SECTORS - 1);
      }
    } else if (next >= SECTORS) {
      if (currentPage < numPages) {
        setCurrentPage(p => p + 1);
        setSectorIndex(0);
      }
    } else {
      setSectorIndex(next);
    }
  }, [sectorIndex, currentPage, numPages, SECTORS]);

  // Reset sector on page change + scroll to top
  const goToPage = useCallback((page) => {
    setCurrentPage(page);
    setSectorIndex(0);
  }, []);

  // Scroll document to top after page renders (runs after commit, not before)
  useEffect(() => {
    documentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [currentPage]);

  const touchStart = useRef({ x: 0, y: 0, time: 0, count: 0 });
  const [toc, setToc] = useState(null);         // PDF outline
  const [tocOpen, setTocOpen] = useState(false);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penSize, setPenSize] = useState(PEN_SIZES[1]); // medium default
  const [pageInput, setPageInput] = useState('');
  // pen drawing state
  const isDrawing = useRef(false);
  const currentPath = useRef([]);
  const penPage = useRef(null);
  const [liveStroke, setLiveStroke] = useState(null); // { pageNumber, color, pathData } | null
  const containerRef = useRef(null);
  const documentRef = useRef(null);
  const pageRefs = useRef({});

  // ── Swipe detection for paginated mode ──────────────────
  const handleSwipeStart = useCallback((e) => {
    // Don't interfere with active pen drawing
    if (isDrawing.current) return;
    const count = e.touches?.length || 1;
    touchStart.current = { x: e.touches?.[0]?.clientX || e.clientX, y: e.touches?.[0]?.clientY || e.clientY, time: Date.now(), count };
  }, []);

  const handleSwipeEnd = useCallback((e) => {
    // Don't interfere with active pen drawing
    if (isDrawing.current) return;
    // Ignore multi-touch (pinch-zoom) — only single-finger swipes count
    if (touchStart.current.count > 1) return;
    if ((e.touches?.length || 0) > 0) return; // still touching with other fingers
    if (isMobile && readingMode) {
      const dx = (e.changedTouches?.[0]?.clientX ?? e.clientX) - touchStart.current.x;
      const dy = (e.changedTouches?.[0]?.clientY ?? e.clientY) - touchStart.current.y;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      // Require meaningful swipe distance — avoid accidental triggers
      const MIN_SWIPE = 50;
      if (absDx < MIN_SWIPE && absDy < MIN_SWIPE) return;
      if (absDx > absDy) {
        navigateSector(dx > 0 ? -1 : 1);
      } else {
        navigateSector(dy > 0 ? -1 : 1);
      }
      return;
    }
    // Paginated mode: only horizontal swipes change pages (vertical = scroll)
    const x = e.changedTouches?.[0]?.clientX ?? e.clientX;
    const y = e.changedTouches?.[0]?.clientY ?? e.clientY;
    const dx = x - touchStart.current.x;
    const dy = y - touchStart.current.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Horizontal swipe must clearly dominate and exceed minimum distance
    const MIN_PAGE_SWIPE = 60;
    if (absDx > absDy * 1.5 && absDx > MIN_PAGE_SWIPE) {
      if (dx < 0) {
        goToPage(Math.min(numPages, currentPage + 1));
      } else {
        goToPage(Math.max(1, currentPage - 1));
      }
    }
  }, [numPages, currentPage, isMobile, readingMode, navigateSector, goToPage]);

  // ── Fullscreen (native API + CSS fallback for iOS/Safari) ──
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // Already in fullscreen (native or CSS fallback) → exit
    if (fullscreen) {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
      setFullscreen(false);
      return;
    }

    // Try native Fullscreen API first
    if (el.requestFullscreen) {
      el.requestFullscreen().then(() => setFullscreen(true)).catch(() => {
        // Native failed → use CSS fallback
        setFullscreen(true);
      });
    } else {
      // No native API (iOS Safari) → use CSS fallback
      setFullscreen(true);
    }
  }, [fullscreen]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
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
  }, [tool, filePath, highlightColor, underlineColor]);

  // ── Pen drawing handlers (pointer events — full stylus support) ──
  const hasStylus = useRef(false);

  const handlePointerDown = useCallback((pageNumber) => (e) => {
    if (tool !== 'pen') return;
    // Allow mouse and stylus; finger/touch passes through for scrolling
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;
    // Lock touch-action during active stroke (prevents browser scroll-jacking)
    pageEl.style.touchAction = 'none';
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    const pressure = e.pressure ?? 0.5;
    const tiltX = e.tiltX ?? 0;
    const tiltY = e.tiltY ?? 0;
    isDrawing.current = true;
    penPage.current = pageNumber;
    hasStylus.current = e.pointerType === 'pen';
    currentPath.current = [{ x, y, pressure, tiltX, tiltY }];
    const w = penSize.width * (0.3 + 0.7 * pressure); // pressure → width
    setLiveStroke({ pageNumber, color: penColor.color, pathData: `M ${x} ${y}`, width: w });
    pageEl.setPointerCapture?.(e.pointerId);
  }, [tool, penColor, penSize]);

  const handlePointerMove = useCallback((pageNumber) => (e) => {
    if (!isDrawing.current || tool !== 'pen' || penPage.current !== pageNumber) return;
    e.preventDefault();
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;
    const pageRect = pageEl.getBoundingClientRect();

    // Use getCoalescedEvents for high-frequency stylus input (smoother lines)
    const events = e.getCoalescedEvents?.() || [e];
    for (const ce of events) {
      const x = (ce.clientX - pageRect.left) / pageRect.width;
      const y = (ce.clientY - pageRect.top) / pageRect.height;
      const pressure = ce.pressure ?? 0.5;
      const tiltX = ce.tiltX ?? 0;
      const tiltY = ce.tiltY ?? 0;
      currentPath.current.push({ x, y, pressure, tiltX, tiltY });
    }
    // Live preview: use last event for real-time rendering
    const last = events[events.length - 1];
    const lx = (last.clientX - pageRect.left) / pageRect.width;
    const ly = (last.clientY - pageRect.top) / pageRect.height;
    const lp = last.pressure ?? 0.5;
    setLiveStroke((prev) => prev ? {
      ...prev,
      pathData: prev.pathData + ` L ${lx} ${ly}`,
      width: penSize.width * (0.3 + 0.7 * lp),
    } : null);
  }, [tool, penSize]);

  const handlePointerUp = useCallback((pageNumber) => (e) => {
    if (!isDrawing.current || tool !== 'pen') return;
    e.preventDefault();
    isDrawing.current = false;
    const pageEl = pageRefs.current[pageNumber];
    setLiveStroke(null);
    // Restore finger-scroll after stroke ends
    if (pageEl) pageEl.style.touchAction = 'pan-y';

    if (!pageEl) { currentPath.current = []; return; }
    const pageRect = pageEl.getBoundingClientRect();
    const x = (e.clientX - pageRect.left) / pageRect.width;
    const y = (e.clientY - pageRect.top) / pageRect.height;
    const pressure = e.pressure ?? 0.5;
    currentPath.current.push({ x, y, pressure, tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0 });

    if (currentPath.current.length < 2) { currentPath.current = []; return; }

    // Build variable-width SVG: split path into pressure-based segments
    const segments = buildPressureSegments(currentPath.current, penSize.width);
    const avgPressure = currentPath.current.reduce((s, p) => s + (p.pressure || 0.5), 0) / currentPath.current.length;
    const effectiveWidth = penSize.width * (0.3 + 0.7 * avgPressure);

    // Main path for backward compatibility (uniform width approximation)
    const d = smoothPathData(currentPath.current.map(p => ({ x: p.x, y: p.y })));

    const annotation = {
      filePath,
      pageNumber: penPage.current,
      type: 'pen',
      color: penColor.color,
      width: effectiveWidth,
      text: '',
      pathData: d,
      segments: segments.length > 1 ? segments : undefined, // store per-segment data if variable
      rect: { x: 0, y: 0, w: 1, h: 1 },
      stylusData: hasStylus.current ? {
        avgPressure,
        avgTiltX: currentPath.current.reduce((s, p) => s + (p.tiltX || 0), 0) / currentPath.current.length,
        avgTiltY: currentPath.current.reduce((s, p) => s + (p.tiltY || 0), 0) / currentPath.current.length,
      } : undefined,
    };
    saveAnnotation(annotation).then((saved) => {
      setAnnotations((prev) => [...prev, saved]);
    });
    currentPath.current = [];
    penPage.current = null;
    hasStylus.current = false;
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

  const isFakeFullscreen = fullscreen && !document.fullscreenElement;

  const content = (
    <div className={'pdf-annotator' + (fullscreen ? ' pdf-annotator--fullscreen' : '')} ref={containerRef}>
      {/* Toolbar */}
      {chromeVisible && (
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
                      backgroundColor: '#2c2416',
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
          <button
            className="pdf-annotator__fullscreen-btn"
            onClick={() => setChromeVisible(false)}
            title="Hide toolbar"
          >
            ▴
          </button>
        </div>
      </div>
      )}

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
                    if (item.pageNumber) goToPage(item.pageNumber);
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
        ref={documentRef}
        className={'pdf-annotator__document pdf-annotator__document--paginated pdf-annotator__document--align-' + alignment}
        style={{
          overflow: (fullscreen || isMobile && readingMode || zoomLevel > 1) ? 'auto' : undefined,
        }}
        onTouchStart={handleSwipeStart}
        onTouchEnd={handleSwipeEnd}
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
          {[currentPage - 1].filter(i => i >= 0 && i < numPages).map((i) => {
            const pageNumber = i + 1;
            const annos = pageAnnotations(pageNumber);
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const isReading = isMobile && readingMode;
            // Dynamic scaling: fit page within viewport comfortably
            const maxW = fullscreen ? Math.min(vw * 0.9, 1600) : 700;
            const pageW = isReading
              ? vw * SECTOR_COLS
              : Math.min(vw - 16, vw * 0.98, maxW) * zoomLevel;
            const col = sectorIndex % SECTOR_COLS;
            const row = Math.floor(sectorIndex / SECTOR_COLS);
            const handleSectorTap = (e) => {
              if (!isReading) return;
              e.stopPropagation();
              const next = sectorIndex + 1;
              if (next >= SECTORS) {
                setSectorIndex(0);
                if (currentPage < numPages) goToPage(currentPage + 1);
              } else {
                setSectorIndex(next);
              }
            };

            const pageContent = (
              <div
                key={pageNumber}
                className={'pdf-annotator__page-wrapper' + (tool === 'pen' ? ' pdf-annotator__page-wrapper--pen' : '') + (isIOS ? ' pdf-annotator__page-wrapper--ios' : '')}
                ref={(el) => { if (el) pageRefs.current[pageNumber] = el; }}
                onMouseUp={handleMouseUp(pageNumber)}
                onClick={isReading ? handleSectorTap : handlePageClick(pageNumber)}
                onPointerDown={handlePointerDown(pageNumber)}
                onPointerMove={handlePointerMove(pageNumber)}
                onPointerUp={handlePointerUp(pageNumber)}
                style={isReading
                  ? { width: pageW, height: 'auto', alignItems: 'flex-start', justifyContent: 'flex-start', touchAction: 'manipulation', transform: `translate(${-col * 100 / SECTOR_COLS}%, ${-row * 100 / SECTOR_ROWS}%)`, transition: 'transform 0.3s ease' }
                  : { width: pageW, touchAction: tool === 'pen' ? 'none' : undefined, cursor: tool === 'highlight' || tool === 'underline' ? 'text' : (tool === 'pen' ? undefined : 'default') }
                }
              >
                <Page
                  pageNumber={pageNumber}
                  width={pageW}
                  devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
                  renderTextLayer={!isReading}
                  renderAnnotationLayer={!isReading}
                />
                {/* Live pen stroke */}
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
                      style={{ stroke: liveStroke.color, strokeWidth: liveStroke.width }}
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
              </div>
            );

            if (isReading) {
              return (
                <div key={pageNumber} className="pdf-annotator__reading-sector" style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative', flexShrink: 0 }}>
                  {pageContent}
                  {/* Sector dots indicator */}
                  <div className="pdf-annotator__sector-dots">
                    {Array.from({ length: SECTORS }, (_, j) => (
                      <span key={j} className={'pdf-annotator__sector-dot' + (j === sectorIndex ? ' pdf-annotator__sector-dot--active' : '')} />
                    ))}
                  </div>
                </div>
              );
            }
            return pageContent;
          })}
        </Document>
        )}
      </div>

      {/* Page Navigation Bar */}
      {numPages > 0 && chromeVisible && (
        <div className="pdf-annotator__nav">
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => { if (isMobile && readingMode) { navigateSector(-SECTORS); } else { goToPage(Math.max(1, currentPage - 1)); } }}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            ◀
          </button>
          <div className="pdf-annotator__nav-page">
            <input
              className="pdf-annotator__page-input"
              type="number"
              min={1}
              max={numPages}
              value={pageInput}
              placeholder={String(currentPage)}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const p = parseInt(e.target.value, 10);
                  if (p >= 1 && p <= numPages) {
                    goToPage(p);
                    setPageInput('');
                  }
                }
              }}
              onBlur={() => setPageInput('')}
              title={`Go to page (1–${numPages})`}
            />
            <span className="pdf-annotator__nav-info">/ {numPages}</span>
          </div>
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => { if (isMobile && readingMode) { navigateSector(SECTORS); } else { goToPage(Math.min(numPages, currentPage + 1)); } }}
            disabled={currentPage >= numPages}
            title="Next page"
          >
            ▶
          </button>
          {/* Alignment */}
          <div className="pdf-annotator__layout-modes">
            <button
              className={'pdf-annotator__layout-btn' + (alignment === 'left' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setAlignment('left')}
              title="Align left"
            >◧</button>
            <button
              className={'pdf-annotator__layout-btn' + (alignment === 'center' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setAlignment('center')}
              title="Align center"
            >◰</button>
            <button
              className={'pdf-annotator__layout-btn' + (alignment === 'right' ? ' pdf-annotator__layout-btn--active' : '')}
              onClick={() => setAlignment('right')}
              title="Align right"
            >◩</button>
          </div>
          {/* Reading mode (mobile only) */}
          {isMobile && (
            <div className="pdf-annotator__layout-modes">
              <button
                className={'pdf-annotator__layout-btn' + (readingMode ? ' pdf-annotator__layout-btn--active' : '')}
                onClick={() => { setReadingMode(!readingMode); setSectorIndex(0); setTool(null); }}
                title="Reading mode"
              >📖</button>
            </div>
          )}
          {/* Zoom slider */}
          {!readingMode && (
          <div className="pdf-annotator__zoom-slider">
            <button className="pdf-annotator__layout-btn" onClick={() => setZoomLevel(Math.max(0.5, zoomLevel - 0.25))} title="Zoom out">−</button>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.05"
              value={zoomLevel}
              onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
              onDoubleClick={() => setZoomLevel(1)}
              title={`${Math.round(zoomLevel * 100)}%`}
            />
            <button className="pdf-annotator__layout-btn" onClick={() => setZoomLevel(Math.min(3, zoomLevel + 0.25))} title="Zoom in">+</button>
            <span className="pdf-annotator__zoom-label">{Math.round(zoomLevel * 100)}%</span>
          </div>
          )}
        </div>
      )}
      {/* Floating restore button when chrome is hidden */}
      {!chromeVisible && (
        <button
          className="pdf-annotator__chrome-toggle"
          onClick={() => setChromeVisible(true)}
          title="Show toolbar"
          aria-label="Show toolbar"
        >
          ▾
        </button>
      )}
    </div>
  );

  return isFakeFullscreen ? createPortal(content, document.body) : content;
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
          pointerEvents: eraseMode ? 'auto' : 'none',
          zIndex: 10,
        }}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        {annotation.segments && annotation.segments.length > 1 ? (
          // Variable-width rendering: one path per pressure segment
          annotation.segments.map((seg, i) => (
            <path
              key={i}
              d={seg.pathData}
              fill="none"
              stroke={annotation.color || '#2c2416'}
              strokeWidth={seg.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ stroke: annotation.color || '#2c2416', strokeWidth: seg.width }}
            />
          ))
        ) : (
          // Uniform width (fallback / backward compatibility)
          <path
            d={annotation.pathData}
            fill="none"
            stroke={annotation.color || '#2c2416'}
            strokeWidth={annotation.width || 0.003}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: annotation.color || '#2c2416', strokeWidth: annotation.width || 0.003 }}
          />
        )}
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

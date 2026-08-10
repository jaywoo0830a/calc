import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { getAnnotations, saveAnnotation, deleteAnnotation, getBookmarks, saveBookmark, deleteBookmark } from '../lib/storage.js';
import { api } from '../lib/api.js';
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
  { id: 'pencil',  color: '#3d3528', style: 'solid', label: '✏️', name: 'Pencil Black' },
  { id: 'pen',     color: '#1c1c2e', style: 'solid', label: '🖊️', name: 'Pen Black' },
  { id: 'red',     color: '#e74c3c', style: 'solid', label: '🔴', name: 'Red' },
  { id: 'blue',    color: '#3498db', style: 'solid', label: '🔵', name: 'Blue' },
];

const TOOLS = {
  highlight: { label: '🖍️ Highlight', icon: '🖍️' },
  underline: { label: '⎁ Underline', icon: '⎁' },
  comment:   { label: '💬 Comment', icon: '💬' },
  problem:   { label: '🎯 Problem', icon: '🎯' },
};
function getPageCanvasRect(pageEl) {
  if (!pageEl) return null;
  // The react-pdf Page wrapper maintains the correct PDF aspect ratio
  const pageDiv = pageEl.querySelector('.react-pdf__Page');
  if (pageDiv) return pageDiv.getBoundingClientRect();
  // Fallback: use the canvas element
  const canvas = pageEl.querySelector('canvas');
  if (canvas) return canvas.getBoundingClientRect();
  // Last resort: page-wrapper itself
  return pageEl.getBoundingClientRect();
}

function annoRect(a, pageEl) {
  if (!pageEl) return null;
  const canvasRect = getPageCanvasRect(pageEl);
  if (!canvasRect) return null;
  const wrapperRect = pageEl.getBoundingClientRect();
  // Position within page-wrapper = canvas offset + normalized coords × canvas size
  return {
    left: (canvasRect.left - wrapperRect.left) + a.rect.x * canvasRect.width,
    top: (canvasRect.top - wrapperRect.top) + a.rect.y * canvasRect.height,
    width: a.rect.w * canvasRect.width,
    height: a.rect.h * canvasRect.height,
  };
}

export default function PdfAnnotator({ url, filePath, initialPage }) {
  const [numPages, setNumPages] = useState(0);
  const [annotations, setAnnotations] = useState([]);
  const [tool, setTool] = useState(null); // null = read mode (default)
  const [activeComment, setActiveComment] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [alignment, setAlignment] = useState('center');
  const [zoomLevel, setZoomLevel] = useState(1); // 0.5–2.0 (50%–200%)
  const [chromeVisible, setChromeVisible] = useState(true);
  const [pageRenderTick, setPageRenderTick] = useState(0); // bumps on each Page render → forces annotation recalculation
  const [bookmarks, setBookmarks] = useState([]);  // { id, filePath, pageNumber, title?, createdAt }
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [problems, setProblems] = useState([]);      // 현재 문서의 푼/틀린 문제 (서버)
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [toast, setToast] = useState(null);        // 잠깐 표시되는 등록 피드백
  const [flashPage, setFlashPage] = useState(null); // 문제 점프 시 페이지 플래시

  // Platform detection (set by inline script in index.html)
  const isIOS = typeof document !== 'undefined' && document.documentElement.classList.contains('is-ios');

  // Scroll to top on page change
  const goToPage = useCallback((page) => {
    setCurrentPage(page);
  }, []);

  // ── Bookmark toggle ─────────────────────────────────────
  const isBookmarked = bookmarks.some(b => b.pageNumber === currentPage);
  const toggleBookmark = useCallback(async () => {
    if (!filePath) return;
    if (isBookmarked) {
      const bm = bookmarks.find(b => b.pageNumber === currentPage);
      if (bm) {
        await deleteBookmark(bm.id);
        setBookmarks(prev => prev.filter(b => b.id !== bm.id));
      }
    } else {
      const saved = await saveBookmark({ filePath, pageNumber: currentPage });
      setBookmarks(prev => [...prev, saved]);
    }
  }, [filePath, currentPage, isBookmarked, bookmarks]);

  // ── Resolve PDF outline: flatten first, then resolve all in parallel ──
  const resolveOutlineItems = useCallback(async (items, pdfDoc) => {
    if (!items || !pdfDoc) return [];

    // 1. Flatten the tree (sync — no async calls)
    const flat = [];
    const walk = (list, depth) => {
      for (const item of list) {
        flat.push({ item, depth });
        if (item.items?.length > 0) walk(item.items, depth + 1);
      }
    };
    walk(items, 1);

    // 2. Resolve all destinations in parallel
    const resolved = await Promise.all(flat.map(async ({ item, depth }) => {
      let pageNumber = null;
      try {
        if (item.dest) {
          if (typeof item.dest === 'string') {
            const destArray = await pdfDoc.getDestination(item.dest);
            if (destArray?.length > 0) pageNumber = await resolveDestToPage(destArray, pdfDoc);
          } else if (Array.isArray(item.dest) && item.dest.length > 0) {
            pageNumber = await resolveDestToPage(item.dest, pdfDoc);
          }
        }
      } catch { /* leave null */ }
      return {
        title: item.title || '(Untitled)',
        pageNumber,
        depth,
        bold: !!item.bold,
        italic: !!item.italic,
      };
    }));

    return resolved;
  }, []);

  /** Resolve a destination array to a 1-based page number */
  async function resolveDestToPage(destArray, pdfDoc) {
    if (!destArray || destArray.length === 0) return null;
    const first = destArray[0];
    try {
      if (typeof first === 'number') {
        // Page index (0-based) embedded directly
        return first + 1;
      }
      if (first && typeof first === 'object' && ('num' in first || 'gen' in first)) {
        // Page reference object { num, gen }
        const idx = await pdfDoc.getPageIndex(first);
        return idx + 1;
      }
    } catch { /* ignore */ }
    return null;
  }

  // Scroll document to top after page renders (runs after commit, not before)
  useEffect(() => {
    documentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [currentPage]);

  const touchStart = useRef({ x: 0, y: 0, time: 0, count: 0 });
  const [toc, setToc] = useState(null);         // PDF outline (resolved flat list)
  const [tocOpen, setTocOpen] = useState(false);
  const pdfDocRef = useRef(null);                // PDFDocumentProxy for dest resolution
  const initialPageRef = useRef(1);              // 외부에서 점프한 시작 페이지
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [pageInput, setPageInput] = useState('');
  const containerRef = useRef(null);
  const documentRef = useRef(null);
  const pageRefs = useRef({});
  const zoomRef = useRef(zoomLevel);             // always-current for event handlers
  zoomRef.current = zoomLevel;

  // ── Swipe detection for paginated mode ──────────────────
  const handleSwipeStart = useCallback((e) => {
    const count = e.touches?.length || 1;
    touchStart.current = { x: e.touches?.[0]?.clientX || e.clientX, y: e.touches?.[0]?.clientY || e.clientY, time: Date.now(), count };
  }, []);

  const handleSwipeEnd = useCallback((e) => {
    // Only allow page swiping in read mode (tool === null)
    if (tool !== null) return;
    // Don't swipe when zoomed — user needs to pan/scroll instead
    if (zoomRef.current > 1) return;
    // Ignore multi-touch (pinch-zoom) — only single-finger swipes count
    if (touchStart.current.count > 1) return;
    if ((e.touches?.length || 0) > 0) return; // still touching with other fingers

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
  }, [numPages, currentPage, goToPage, tool]);

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

  // ── Selection trigger (floating confirm toolbar) ──────────
  const [selTrigger, setSelTrigger] = useState(null); // { pageNumber, x, y } | null
  const savedSelectionRef = useRef(null); // capture selection data before click clears it
  const lastDetectedText = useRef(''); // avoid re-triggering on same selection

  // Clear trigger when switching away from selection-based tools
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline' && tool !== 'problem') {
      setSelTrigger(null);
      savedSelectionRef.current = null;
      lastDetectedText.current = '';
    }
  }, [tool]);

  // Reset detection state on page change — fresh start for new page
  useEffect(() => {
    setSelTrigger(null);
    savedSelectionRef.current = null;
    lastDetectedText.current = '';
  }, [currentPage]);

  // ── Load annotations from IndexedDB ─────────────────────
  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(setAnnotations).catch(() => {});
  }, [filePath]);

  // ── Load bookmarks from IndexedDB ──────────────────────
  useEffect(() => {
    if (!filePath) return;
    getBookmarks(filePath).then(setBookmarks).catch(() => {});
  }, [filePath]);

  // ── 현재 문서의 푼/틀린 문제 (서버 DB) — 풀스크린 포함 접근 ──
  const refreshProblems = useCallback(() => {
    if (!filePath) { setProblems([]); return; }
    api.listProblems({ doc: filePath }).then(setProblems).catch(() => setProblems([]));
  }, [filePath]);
  useEffect(() => { refreshProblems(); }, [refreshProblems]);

  const jumpToProblemPage = useCallback((p) => {
    if (p.doc_path !== filePath) return;
    const page = Number(p.ref);
    if (page > 0 && page <= numPages) {
      goToPage(page);
      setFlashPage(page);
      setTimeout(() => setFlashPage(null), 2200);
    }
    setProblemsOpen(false);
  }, [filePath, numPages, goToPage]);

  // 상태 지정(맞음/틀림) — 같은 상태 재클릭도 시도 횟수로 기록
  const setProblemStatus = useCallback((p, status) => {
    api.updateProblem(p.id, { status, attempts: p.attempts + 1 }).then(refreshProblems).catch(() => {});
  }, [refreshProblems]);

  const removeProblemItem = useCallback((p) => {
    api.deleteProblem(p.id).then(refreshProblems).catch(() => {});
  }, [refreshProblems]);

  // ── Reset state when PDF url changes ───────────────────
  useEffect(() => {
    setToc(null);
    setTocOpen(false);
    setLoadError(null);
    setNumPages(0);
    setFlashPage(null);
    return () => {
      // 이전 PDF 문서/페이지 참조 해제 (메모리 누수 방지)
      const doc = pdfDocRef.current;
      if (doc) {
        pdfDocRef.current = null;
        try {
          const p = doc.destroy?.();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch { /* already destroyed */ }
      }
      pageRefs.current = {};
    };
  }, [url]);

  // 외부 점프(문제 목록)로 지정한 시작 페이지 — 문서 로드 시 적용
  useEffect(() => {
    initialPageRef.current = (initialPage && initialPage > 0) ? initialPage : 1;
  }, [initialPage]);

  // ── Toast auto-dismiss ────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── 푼/틀린 문제 등록 (서버 DB) ───────────────────────
  const registerProblem = useCallback((status) => {
    const data = savedSelectionRef.current;
    if (!data || !data.text.trim()) return;
    api.saveProblem({
      docId: filePath,
      docPath: filePath,
      ref: String(data.pageNumber),
      text: data.text,
      status,
    }).then(() => {
      setSelTrigger(null);
      savedSelectionRef.current = null;
      window.getSelection()?.removeAllRanges();
      setToast(status === 'solved' ? '✓ Marked as solved' : '✗ Marked as wrong');
    }).catch(() => {
      setSelTrigger(null);
      savedSelectionRef.current = null;
      window.getSelection()?.removeAllRanges();
      setToast('Failed to save — check server');
    });
  }, [filePath]);

  // ── RangeSelect(✂️ 모드 + 두 번 탭) → 문제 등록 ──
  useEffect(() => {
    const onMark = (e) => {
      const { text, status } = e.detail || {};
      if (!text || !status || !filePath) return;
      api.saveProblem({
        docId: filePath,
        docPath: filePath,
        ref: String(currentPage),
        text: String(text).slice(0, 500),
        status,
      }).then(() => {
        setToast(status === 'solved' ? '✓ Marked as solved' : '✗ Marked as wrong');
        refreshProblems();
      }).catch(() => {
        setToast('Failed to save — check server');
      });
    };
    window.addEventListener('problems:mark', onMark);
    return () => window.removeEventListener('problems:mark', onMark);
  }, [filePath, currentPage, refreshProblems]);

  // ── Polling: check selection every 250ms (problem/highlight/underline) ──
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline' && tool !== 'problem') return;
    const id = setInterval(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        // Selection gone — hide trigger
        if (lastDetectedText.current) {
          setSelTrigger(null);
          savedSelectionRef.current = null;
          lastDetectedText.current = '';
        }
        return;
      }
      const text = sel.toString().trim();
      if (text === lastDetectedText.current) return; // already showing trigger for this
      const range = sel.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const ancestorEl = ancestor.nodeType === 3 ? ancestor.parentElement : ancestor;
      const pageEl = ancestorEl?.closest?.('.pdf-annotator__page-wrapper');
      if (!pageEl) return;
      const pageNumber = pageEl.dataset?.page;
      if (pageNumber == null) return;

      const canvasRect = getPageCanvasRect(pageEl);
      if (!canvasRect) return;

      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (rects.length === 0) return;

      lastDetectedText.current = text;
      savedSelectionRef.current = {
        pageNumber: Number(pageNumber),
        text,
        rects: rects.map(r => ({
          x: (r.left - canvasRect.left) / canvasRect.width,
          y: (r.top - canvasRect.top) / canvasRect.height,
          w: r.width / canvasRect.width,
          h: r.height / canvasRect.height,
        })),
      };

      const lastRect = rects[rects.length - 1];
      const vw = window.innerWidth, vh = window.innerHeight;
      const triggerW = 280, triggerH = 40, gap = 8;
      let tx = lastRect.right + gap;
      let ty = lastRect.bottom + gap;
      if (tx + triggerW > vw - gap) tx = lastRect.left - triggerW - gap;
      tx = Math.max(gap, Math.min(tx, vw - triggerW - gap));
      if (ty + triggerH > vh - gap) ty = lastRect.top - triggerH - gap;
      ty = Math.max(gap, Math.min(ty, vh - triggerH - gap));

      setSelTrigger({ pageNumber: Number(pageNumber), x: tx, y: ty });
    }, 250);
    return () => clearInterval(id);
  }, [tool]);

  // ── Text selection → highlight / underline (shared helper) ──
  const processTextSelection = useCallback((pageNumber) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

    const range = sel.getRangeAt(0);
    const pageEl = pageRefs.current[pageNumber];
    if (!pageEl) return;

    if (!pageEl.contains(range.commonAncestorContainer)) return;

    const pageRect = getPageCanvasRect(pageEl);
    if (!pageRect) { sel.removeAllRanges(); return; }
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (rects.length === 0) { sel.removeAllRanges(); return; }

    const sorted = [...rects].sort((a, b) => a.top - b.top);
    const lineHeight = sorted[0].height;
    const tolerance = lineHeight * 0.5;
    const lines = [];
    let currentLine = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].top - currentLine[0].top) < tolerance) {
        currentLine.push(sorted[i]);
      } else {
        lines.push(currentLine);
        currentLine = [sorted[i]];
      }
    }
    lines.push(currentLine);

    const isHighlight = tool === 'highlight';
    for (const lineRects of lines) {
      let minX = Infinity, maxX = -Infinity;
      let top = Infinity, bottom = -Infinity;
      for (const r of lineRects) {
        minX = Math.min(minX, r.left);
        maxX = Math.max(maxX, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      const annotation = {
        filePath, pageNumber, type: tool,
        color: isHighlight ? highlightColor.bg : underlineColor.color,
        style: isHighlight ? undefined : underlineColor.style,
        text: sel.toString().trim(),
        rect: {
          x: (minX - pageRect.left) / pageRect.width,
          y: (top - pageRect.top) / pageRect.height,
          w: (maxX - minX) / pageRect.width,
          h: (bottom - top) / pageRect.height,
        },
      };
      saveAnnotation(annotation).then((saved) => {
        setAnnotations((prev) => [...prev, saved]);
      });
    }
    sel.removeAllRanges();
  }, [tool, filePath, highlightColor, underlineColor]);

  // ── Confirm selection trigger → create annotation ──────
  const confirmSelection = useCallback(() => {
    const data = savedSelectionRef.current;
    if (!data || data.rects.length === 0) return;

    const isHighlight = tool === 'highlight';

    // Group rects by line (similar top coordinate)
    const sorted = [...data.rects].sort((a, b) => a.y - b.y);
    const lineHeight = sorted[0].h || 0.01;
    const tolerance = lineHeight * 0.5;
    const lines = [];
    let currentLine = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - currentLine[0].y) < tolerance) {
        currentLine.push(sorted[i]);
      } else {
        lines.push(currentLine);
        currentLine = [sorted[i]];
      }
    }
    lines.push(currentLine);

    for (const lineRects of lines) {
      let minX = Infinity, maxX = -Infinity;
      let top = Infinity, bottom = -Infinity;
      for (const r of lineRects) {
        minX = Math.min(minX, r.x);
        maxX = Math.max(maxX, r.x + r.w);
        top = Math.min(top, r.y);
        bottom = Math.max(bottom, r.y + r.h);
      }
      const annotation = {
        filePath,
        pageNumber: data.pageNumber,
        type: tool,
        color: isHighlight ? highlightColor.bg : underlineColor.color,
        style: isHighlight ? undefined : underlineColor.style,
        text: data.text,
        rect: {
          x: minX,
          y: top,
          w: maxX - minX,
          h: bottom - top,
        },
      };
      saveAnnotation(annotation).then((saved) => {
        setAnnotations((prev) => [...prev, saved]);
      });
    }

    setSelTrigger(null);
    savedSelectionRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, [tool, filePath, highlightColor, underlineColor]);
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
        {/* Color pickers — hidden for highlight/underline (use selection trigger) */}
        <div className="pdf-annotator__tools">
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
            className={'pdf-annotator__tool' + (bookmarksOpen ? ' pdf-annotator__tool--active' : '')}
            onClick={() => setBookmarksOpen(!bookmarksOpen)}
            title="Bookmarks"
          >
            🔖 Bookmarks
          </button>
          <button
            className={'pdf-annotator__tool' + (problemsOpen ? ' pdf-annotator__tool--active' : '')}
            onClick={() => { setProblemsOpen(!problemsOpen); if (!problemsOpen) refreshProblems(); }}
            title="Problems"
          >
            📋 Problems
          </button>
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
                  className={'pdf-annotator__toc-item' + (item.bold ? ' pdf-annotator__toc-item--bold' : '') + (item.italic ? ' pdf-annotator__toc-item--italic' : '')}
                  style={{ paddingLeft: `${0.5 + (item.depth || 1) * 0.75}rem` }}
                  onClick={() => {
                    if (item.pageNumber) {
                      goToPage(item.pageNumber);
                      setTocOpen(false);
                    }
                  }}
                  disabled={!item.pageNumber}
                  title={item.pageNumber ? `Page ${item.pageNumber}` : 'No destination'}
                >
                  <span className="pdf-annotator__toc-label">{item.title || '(Untitled)'}</span>
                  {item.pageNumber ? (
                    <span className="pdf-annotator__toc-page">{item.pageNumber}</span>
                  ) : (
                    <span className="pdf-annotator__toc-page" style={{ opacity: 0.3 }}>—</span>
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

      {/* Bookmarks Sidebar */}
      <div className={'pdf-annotator__toc-sidebar' + (bookmarksOpen ? ' pdf-annotator__toc-sidebar--open' : '')}>
        <div className="pdf-annotator__toc-header">
          <span>🔖 Bookmarks</span>
          <button className="pdf-annotator__toc-close" onClick={() => setBookmarksOpen(false)}>×</button>
        </div>
        <div className="pdf-annotator__toc-list">
          {bookmarks.length === 0 ? (
            <div className="pdf-annotator__toc-item" style={{ opacity: 0.5, cursor: 'default' }}>
              No bookmarks yet
            </div>
          ) : (
            [...bookmarks]
              .sort((a, b) => a.pageNumber - b.pageNumber)
              .map((bm) => (
                <button
                  key={bm.id}
                  className="pdf-annotator__toc-item"
                  onClick={() => {
                    goToPage(bm.pageNumber);
                    setBookmarksOpen(false);
                  }}
                >
                  <span className="pdf-annotator__toc-label">Page {bm.pageNumber}</span>
                  <button
                    className="pdf-annotator__delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBookmark(bm.id).then(() => {
                        setBookmarks(prev => prev.filter(b => b.id !== bm.id));
                      });
                    }}
                    title="Remove bookmark"
                  >
                    ×
                  </button>
                </button>
              ))
          )}
        </div>
      </div>
      <div className="pdf-annotator__toc-overlay" onClick={() => setBookmarksOpen(false)} />

      {/* Problems Sidebar — 풀스크린 포함 접근 가능 */}
      <div className={'pdf-annotator__toc-sidebar' + (problemsOpen ? ' pdf-annotator__toc-sidebar--open' : '')}>
        <div className="pdf-annotator__toc-header">
          <span>📋 Problems</span>
          <button className="pdf-annotator__toc-close" onClick={() => setProblemsOpen(false)}>×</button>
        </div>
        <div className="pdf-annotator__toc-list">
          {problems.length === 0 ? (
            <div className="pdf-annotator__toc-item" style={{ opacity: 0.5, cursor: 'default' }}>
              No problems in this document yet
            </div>
          ) : (
            problems.map((p) => (
              <div key={p.id} className={'pdf-annotator__problem pdf-annotator__problem--' + p.status}>
                <button className="pdf-annotator__problem-open" onClick={() => jumpToProblemPage(p)} title="Go to page">
                  <span className="pdf-annotator__problem-status">{p.status === 'solved' ? '✓' : '✗'}</span>
                  <span className="pdf-annotator__problem-body">
                    <span className="pdf-annotator__problem-src">
                      {p.ref ? `p.${p.ref}` : ''} · {p.attempts} attempt{p.attempts === 1 ? '' : 's'} · {p.wrong_count} wrong
                    </span>
                    <span className="pdf-annotator__problem-text">{p.text}</span>
                  </span>
                </button>
                <div className="pdf-annotator__problem-actions">
                  <button
                    className="pdf-annotator__problem-solve"
                    onClick={() => setProblemStatus(p, 'solved')}
                    title="Mark as solved (again)"
                  >✓</button>
                  <button
                    className="pdf-annotator__problem-wrong"
                    onClick={() => setProblemStatus(p, 'wrong')}
                    title="Mark as wrong (again)"
                  >✗</button>
                  <button
                    className="pdf-annotator__problem-delete"
                    onClick={() => removeProblemItem(p)}
                    title="Delete"
                  >🗑️</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="pdf-annotator__toc-overlay" onClick={() => setProblemsOpen(false)} />

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
          overflow: (fullscreen || zoomLevel > 1) ? 'auto' : undefined,
          justifyContent: (fullscreen || zoomLevel > 1) ? 'flex-start' : undefined,
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
            onLoadSuccess={async (pdf) => {
              setNumPages(pdf.numPages);
              const jump = initialPageRef.current;
              const start = Math.min(jump, pdf.numPages);
              setCurrentPage(start);
              if (jump > 1) {
                setFlashPage(start);
                setTimeout(() => setFlashPage(null), 2200);
              }
              setLoadError(null);
              pdfDocRef.current = pdf;
              try {
                const outline = await pdf.getOutline();
                if (outline?.length > 0) {
                  const resolved = await resolveOutlineItems(outline, pdf);
                  setToc(resolved.length > 0 ? resolved : null);
                } else {
                  setToc(null);
                }
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
            // Dynamic scaling: fit page within viewport comfortably
            const maxW = fullscreen ? Math.min(vw * 0.9, 1600) : 700;
            const pageW = Math.min(vw - 16, vw * 0.98, maxW) * zoomLevel;

            return (
              <div
                key={pageNumber}
                data-page={pageNumber}
                className={'pdf-annotator__page-wrapper' + (isIOS ? ' pdf-annotator__page-wrapper--ios' : '') + (flashPage === pageNumber ? ' pdf-annotator__page-wrapper--flash' : '')}
                ref={(el) => { if (el) pageRefs.current[pageNumber] = el; }}
                onClick={handlePageClick(pageNumber)}
                style={{
                  width: pageW,
                  maxWidth: (fullscreen || zoomLevel > 1) ? 'none' : undefined,
                  height: (fullscreen || zoomLevel > 1) ? 'auto' : undefined,
                  minHeight: (fullscreen || zoomLevel > 1) ? undefined : undefined,
                  cursor: (tool === 'highlight' || tool === 'underline' || tool === 'problem') ? 'text' : undefined,
                }}
              >
                <Page
                  pageNumber={pageNumber}
                  width={pageW}
                  devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
                  renderTextLayer={tool === 'highlight' || tool === 'underline' || tool === 'problem'}
                  renderAnnotationLayer={true}
                  onRenderSuccess={() => setPageRenderTick(t => t + 1)}
                />
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
          })}
        </Document>
        )}
      </div>

      {/* Selection trigger — floating confirm toolbar (problem / highlight / underline 전용) */}
      {selTrigger && (tool === 'problem' || tool === 'highlight' || tool === 'underline') && (
        <div
          className="pdf-annotator__sel-trigger"
          style={{
            position: 'fixed',
            left: selTrigger.x,
            top: selTrigger.y,
            zIndex: 200,
          }}
        >
          <div className="pdf-annotator__sel-trigger-inner">
            <button
              className="pdf-annotator__sel-lookup"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                const data = savedSelectionRef.current;
                if (!data) return;
                const r = e.currentTarget.getBoundingClientRect();
                window.dispatchEvent(new CustomEvent('wordlookup:open', {
                  detail: {
                    text: data.text,
                    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                  },
                }));
              }}
              title="Look up in dictionary"
            >📖</button>
            {tool === 'problem' && (
              <>
                <button
                  className="pdf-annotator__sel-problem"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => registerProblem('solved')}
                  title="Mark as solved (again)"
                >✓ Solved</button>
                <button
                  className="pdf-annotator__sel-problem pdf-annotator__sel-problem--wrong"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => registerProblem('wrong')}
                  title="Mark as wrong (again)"
                >✗ Wrong</button>
              </>
            )}
            {(tool === 'highlight' || tool === 'underline') && (
              <>
                {tool === 'highlight' && HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c.id}
                    className={'pdf-annotator__sel-swatch' + (highlightColor.id === c.id ? ' pdf-annotator__sel-swatch--active' : '')}
                    style={{ backgroundColor: c.bg }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setHighlightColor(c)}
                    title={c.name}
                  />
                ))}
                {tool === 'underline' && UNDERLINE_COLORS.map((c) => (
                  <button
                    key={c.id}
                    className={'pdf-annotator__sel-swatch' + (underlineColor.id === c.id ? ' pdf-annotator__sel-swatch--active' : '')}
                    style={{ borderBottom: `3px solid ${c.color}` }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setUnderlineColor(c)}
                    title={c.name}
                  />
                ))}
                <button
                  className="pdf-annotator__sel-confirm"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={confirmSelection}
                >
                  {tool === 'highlight' ? '🖍️' : '⎁'} Apply
                </button>
                <button
                  className="pdf-annotator__sel-cancel"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setSelTrigger(null); savedSelectionRef.current = null; window.getSelection()?.removeAllRanges(); }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Page Navigation Bar */}
      {numPages > 0 && chromeVisible && (
        <div className="pdf-annotator__nav">
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
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
            className={'pdf-annotator__nav-btn' + (isBookmarked ? ' pdf-annotator__nav-btn--active' : '')}
            onClick={toggleBookmark}
            title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          >
            {isBookmarked ? '🔖' : '🏷️'}
          </button>
          <button
            className="pdf-annotator__nav-btn"
            onClick={() => goToPage(Math.min(numPages, currentPage + 1))}
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
          {/* Zoom slider */}
          <div className="pdf-annotator__zoom-slider">
            <button className="pdf-annotator__layout-btn" onClick={() => setZoomLevel(Math.max(0.5, zoomLevel - 0.1))} title="Zoom out">−</button>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={zoomLevel}
              onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
              onDoubleClick={() => setZoomLevel(1)}
              title={`${Math.round(zoomLevel * 100)}%`}
            />
            <button className="pdf-annotator__layout-btn" onClick={() => setZoomLevel(Math.min(2.0, zoomLevel + 0.1))} title="Zoom in">+</button>
            <span className="pdf-annotator__zoom-label">{Math.round(zoomLevel * 100)}%</span>
            <button className="pdf-annotator__layout-btn" onClick={() => setZoomLevel(1)} title="Reset zoom" style={{ fontSize: '0.7rem' }}>1:1</button>
          </div>
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
      {toast && <div className="pdf-annotator__toast">{toast}</div>}
    </div>
  );

  return isFakeFullscreen ? createPortal(content, document.body) : content;
}

/** Renders a single annotation overlay — memoized to avoid re-renders on parent updates */
const AnnotationOverlay = memo(function AnnotationOverlay({ annotation, pageEl, onDelete, eraseMode }) {
  // Always find page element fresh from DOM — prop may be stale after page navigation
  const getPageEl = () => document.querySelector(`[data-page="${annotation.pageNumber}"]`) || pageEl;
  const [rect, setRect] = useState(null);
  const prevRectRef = useRef(null);

  // Recalculate rect after every render — onRenderSuccess on <Page> ensures
  // we re-render once the PDF canvas is actually in the DOM.
  // Compare by value (not reference) to avoid infinite re-render loops.
  useLayoutEffect(() => {
    const next = annoRect(annotation, getPageEl());
    const prev = prevRectRef.current;
    if (next && prev &&
        next.left === prev.left && next.top === prev.top &&
        next.width === prev.width && next.height === prev.height) {
      return;
    }
    prevRectRef.current = next;
    if (next) setRect(next);
  });

  const handleDelete = eraseMode ? (e) => { e.stopPropagation(); onDelete(annotation.id); } : undefined;

  if (annotation.type === 'comment') {
    return (
      <div
        className={'pdf-annotator__comment-marker' + (eraseMode ? ' pdf-annotator__comment-marker--erasable' : '')}
        style={{
          left: rect ? rect.left : `${annotation.rect.x * 100}%`,
          top: rect ? rect.top : `${annotation.rect.y * 100}%`,
        }}
        title={annotation.text + (eraseMode ? ' — click to delete' : '')}
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
      className={'pdf-annotator__mark pdf-annotator__mark--' + annotation.type + (isDashed ? ' pdf-annotator__mark--dashed' : '') + (eraseMode ? ' pdf-annotator__mark--erasable' : '')}
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
      title={annotation.text + (eraseMode ? ' — click to delete' : '')}
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

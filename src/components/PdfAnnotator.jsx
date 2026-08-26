import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { getRangeSelectState, subscribeRangeSelect } from '../lib/rangeSelectState.js';
import { IS_TOUCH_PRIMARY } from '../lib/device.js';
import { Document, Page, pdfjs } from 'react-pdf';
import { getAnnotations, saveAnnotation, deleteAnnotation, getBookmarks, saveBookmark, deleteBookmark, annotationsMeta, bookmarksMeta, reportPdfPosition, getPdfPosition, getConcepts, saveConcept, deleteConcept, conceptsMeta } from '../lib/storage.js';
import { api } from '../lib/api.js';
import { fitImageRect } from '../lib/imageRect.js';
import { rotateImageDataUrl, warmMl } from '../lib/docScan.js';
import { addNode, suggestId, STATUS, conceptsToMap, conceptIdBase } from '../lib/conceptMap.js';
import ConceptInput from './ConceptInput.jsx';
import ScanAreaModal from './ScanAreaModal.jsx';
import ClearGate from './ClearGate.jsx';
import { useClearGate } from '../hooks/useClearGate.js';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import PdfSearchPanel from './PdfSearchPanel.jsx';
import ImageLightbox from './ImageLightbox.jsx';

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
  image:     { label: '🖼️ Image', icon: '🖼️' },
  concept:   { label: '🧭 Concept', icon: '🧭' },
};

const MAX_IMAGE_MB = 10; // 🖼️ 이미지 업로드 상한
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
  const wrapperRect = pageEl.getBoundingClientRect();  // Position within page-wrapper = canvas offset + normalized coords × canvas size
  return {
    left: (canvasRect.left - wrapperRect.left) + a.rect.x * canvasRect.width,
    top: (canvasRect.top - wrapperRect.top) + a.rect.y * canvasRect.height,
    width: a.rect.w * canvasRect.width,
    height: a.rect.h * canvasRect.height,
  };
}

// ── 🖼️ 이미지 압축 — 2MB 이하는 1000px, 그 이상은 1600px (JPEG 0.82, PNG 무손실) ──
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('bad image'));
      img.onload = () => {
        const MAX = file.size > 2 * 1024 * 1024 ? 1600 : 1000;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = file.type === 'image/png'
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', 0.82);
        resolve({ dataUrl, aspect: w / h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// 메모화된 PDF 페이지 — 주석 저장 등 부모 상태 변경으로 인한 캔버스 재렌더(깜빡임) 방지.
// pageNumber/width/textLayer/onRenderSuccess가 바뀔 때만 react-pdf <Page>를 다시 그린다.
const PdfPageMemo = memo(function PdfPageMemo({ pageNumber, width, textLayer, onRenderSuccess }) {
  return (
    <Page
      pageNumber={pageNumber}
      width={width}
      devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
      renderTextLayer={textLayer}
      renderAnnotationLayer={true}
      onRenderSuccess={onRenderSuccess}
    />
  );
});

export default function PdfAnnotator({ url, filePath, initialPage, initialScrollTop, onOpenConcepts }) {
  const [numPages, setNumPages] = useState(0);
  const [annotations, setAnnotations] = useState([]);
  const [tool, setTool] = useState(null); // null = read mode (default)
  const [activeComment, setActiveComment] = useState(null);
  const [aim, setAim] = useState(null); // 터치 기기 배치 조준선 { kind: 'comment'|'image', pageNumber, px, py }
  const aimDragRef = useRef(null);       // 조준선 드래그 세션 { id, startX, startY, baseX, baseY }
  const [commentText, setCommentText] = useState('');
  const [commentStatus, setCommentStatus] = useState(''); // 새 코멘트의 문제 상태 '' | wrong | solved (스캔 PDF용)
  const [loadError, setLoadError] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1); // 0.5–2.0 (50%–200%)
  const [chromeVisible, setChromeVisible] = useState(true);
  const [pageRenderTick, setPageRenderTick] = useState(0); // bumps on each Page render → forces annotation recalculation
  // 안정적인 onRenderSuccess 콜백 — PdfPageMemo가 매 렌더 재마운트되지 않게
  const handleRenderSuccess = useCallback(() => setPageRenderTick((t) => t + 1), []);
  const [bookmarks, setBookmarks] = useState([]);  // { id, filePath, pageNumber, title?, createdAt }
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [openCommentId, setOpenCommentId] = useState(null); // READ 모드에서 내용을 연 코멘트 마커
  const [editingComment, setEditingComment] = useState(null); // 수정 중인 코멘트 { id, pageNumber, px, py }
  const [editText, setEditText] = useState(''); // 수정 중인 코멘트 텍스트
  const [editStatus, setEditStatus] = useState(''); // 수정 중인 코멘트의 문제 상태
  const [problems, setProblems] = useState([]);      // 현재 문서의 푼/틀린 문제 (서버)
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [annotationsOpen, setAnnotationsOpen] = useState(false); // 주석 모아보기 사이드바
  const [searchOpen, setSearchOpen] = useState(false); // 🔎 전체 텍스트 검색
  const [searchHits, setSearchHits] = useState(new Map()); // pageNumber → 정규화 사각형 목록
  const [annotationFocus, setAnnotationFocus] = useState(null);  // 점프한 주석 { id, pageNumber } — 렌더 후 플래시
  const [toast, setToast] = useState(null);        // 잠깐 표시되는 등록 피드백
  const [flashPage, setFlashPage] = useState(null); // 문제 점프 시 페이지 플래시
  const imageInputRef = useRef(null);              // 🖼️ 이미지 업로드용 숨김 input
  const cameraInputRef = useRef(null);             // 📷 카메라 촬영용 숨김 input (모바일 capture)
  const pendingImageRef = useRef(null);            // 이미지 배치 위치 { pageNumber, x, y }
  const scanPendingRef = useRef(null);             // 📐 스캔 세션 중 배치 위치 보관 — setTool(null) effect가 pendingImageRef를 비워도 유지
  const [imageChoice, setImageChoice] = useState(null); // 📷/🖼️ 선택 팝업 위치 { px, py }
  const [scanImage, setScanImage] = useState(null);     // 📐 scanic 스캔 영역 지정 세션 { dataUrl, aspect, suggestedRange }
  // ── 🧭 개념 노드 (concept map) — 생성 캡처만 담당 (모아보기는 Concepts 탭) ──
  const [concepts, setConcepts] = useState([]);          // 서버 저장 개념 노드 (flat 목록)
  const conceptsRef = useRef([]);                        // 폴링/비동기에서 최신 값
  const [conceptCapture, setConceptCapture] = useState(null); // 캡처 바 위치 { pageNumber, px, py }
  const [conceptLabel, setConceptLabel] = useState('');
  const [conceptParent, setConceptParent] = useState('');     // 캡처 시 부모 (항상 '' = 최상위 기본)

  // Platform detection (set by inline script in index.html)
  const isIOS = typeof document !== 'undefined' && document.documentElement.classList.contains('is-ios');

  // ✂️ Selecting(전역) 활성 여부 — 활성이면 PDF 텍스트 레이어를 켜서 선택 가능
  const [rangeActive, setRangeActive] = useState(false);
  useEffect(() => subscribeRangeSelect((s) => setRangeActive(!!s.active)), []);

  // 모바일(≤767px) 여부 — 풀스크린 유도 / 비풀스크린 최소 크롬용
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 767);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // ⌨️ 온스크린 키보드 높이 추적 — iOS 등 키보드가 오버레이로 덮는 환경에서
  // 입력 시트(코멘트/컨셉)를 키보드 위로 들어 올린다 (visualViewport 기준).
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const compute = () => {
      const docH = document.documentElement.clientHeight;
      setKbH(Math.max(0, docH - (vv.offsetTop + vv.height)));
    };
    compute();
    vv.addEventListener('resize', compute);
    vv.addEventListener('scroll', compute);
    return () => {
      vv.removeEventListener('resize', compute);
      vv.removeEventListener('scroll', compute);
    };
  }, []);

  // 키보드가 열린 동안 시트를 키보드 위로 들어 올리는 인라인 스타일
  const kbLiftStyle = kbH > 0 ? { transform: `translateY(-${Math.round(kbH)}px)` } : undefined;

  // Scroll to top on page change
  const goToPage = useCallback((page) => {
    setCurrentPage(page);
    setAim(null); // 페이지 이동 시 조준선 해제
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

  // ── 읽기 위치 복원/보고 ──
  // 열 때 외부에서 전달된 시작 스크롤 (일회성) — url(문서)이 바뀔 때만 갱신
  const initialScrollTopRef = useRef(initialScrollTop && initialScrollTop > 0 ? initialScrollTop : null);
  const lastUrlRef = useRef(url);
  if (lastUrlRef.current !== url) {
    lastUrlRef.current = url;
    initialScrollTopRef.current = (initialScrollTop && initialScrollTop > 0) ? initialScrollTop : null;
  }

  // 페이지/문서 로드 후 스크롤 — 복원값이 있으면 그 위치로, 아니면 맨 위로
  useEffect(() => {
    const el = documentRef.current;
    if (!el || !numPages) return;
    if (initialScrollTopRef.current != null) {
      el.scrollTop = initialScrollTopRef.current;
      initialScrollTopRef.current = null; // 일회성 — 이후 페이지 전환은 맨 위
    } else {
      el.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [currentPage, numPages]);

  // 페이지/스크롤 변경 → Viewer에 보고 (경로별 읽기 위치 보존용)
  useEffect(() => {
    if (!numPages) return;
    const el = documentRef.current;
    const report = () => {
      window.dispatchEvent(new CustomEvent('viewer:pdf-page', {
        detail: { path: filePath, page: currentPage, scrollTop: el ? el.scrollTop : 0 },
      }));
    };
    report();
    const onScroll = () => report();
    if (el) el.addEventListener('scroll', onScroll, { passive: true });
    return () => { if (el) el.removeEventListener('scroll', onScroll); };
  }, [filePath, currentPage, numPages]);

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
  const enterFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el || fullscreen) return;
    if (el.requestFullscreen) {
      el.requestFullscreen().then(() => setFullscreen(true)).catch(() => setFullscreen(true));
    } else {
      setFullscreen(true); // iOS/Safari CSS 폴백
    }
  }, [fullscreen]);

  // 🧭 Concepts 트리 전체화면에서 넘어온 경우 — PDF 로드 후 자동 전체화면
  const pendingFsRef = useRef(false);
  useEffect(() => {
    const onEnter = () => { pendingFsRef.current = true; };
    window.addEventListener('viewer:enter-pdf-fullscreen', onEnter);
    return () => window.removeEventListener('viewer:enter-pdf-fullscreen', onEnter);
  }, []);
  useEffect(() => {
    if (pendingFsRef.current && numPages > 0) {
      pendingFsRef.current = false;
      enterFullscreen();
    }
  }, [numPages, enterFullscreen]);

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

  // ── 모바일: PDF가 열리면 자동 풀스크린(CSS) 시작 — 읽기 몰입 유도 ──
  const autoFsRef = useRef(false); // 문서당 1회만 자동 진입 (나가면 ⛶로 재진입)
  useEffect(() => {
    if (!isMobile || !numPages || autoFsRef.current) return;
    autoFsRef.current = true;
    setFullscreen(true);
  }, [isMobile, numPages]);

  // ── Selection trigger (floating confirm toolbar) ──────────
  const [selTrigger, setSelTrigger] = useState(null); // { pageNumber, x, y } | null
  const savedSelectionRef = useRef(null); // capture selection data before click clears it
  const lastDetectedText = useRef(''); // avoid re-triggering on same selection

  // Clear trigger when switching away from selection-based tools
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline') {
      setSelTrigger(null);
      savedSelectionRef.current = null;
      lastDetectedText.current = '';
    }
    if (tool !== 'image') {
      setImageChoice(null);
      pendingImageRef.current = null;
    }
    if (tool !== 'concept') {
      setConceptCapture(null);
      setConceptLabel('');
      setConceptParent('');
    }
  }, [tool]);

  // Reset detection state on page change — fresh start for new page
  useEffect(() => {
    setSelTrigger(null);
    savedSelectionRef.current = null;
    lastDetectedText.current = '';
    setEditingComment(null);
    setEditText('');
    setOpenCommentId(null);
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

  // ── Load 🧭 concept nodes (서버 우선, 오프라인 로컬 폴백) ──
  useEffect(() => {
    if (!filePath) { setConcepts([]); return; }
    getConcepts(filePath).then(setConcepts).catch(() => {});
  }, [filePath]);
  useEffect(() => { conceptsRef.current = concepts; }, [concepts]);

  // ── 📡 PDF 주석 실시간 동기화 (폰 ↔ 태블릿) — 3초 폴링 ──
  // 서버가 진실의 원천: 메타 비교 → 변경 시 전체 당겨오기 + 오프라인 저장분 재업로드.
  // 삭제는 톰스톤으로 전파되어 되살아나지 않는다.
  const annotationsRef = useRef([]);

  // ── 👣 페이지 따라가기 (교육용) — follow ON이면 다른 기기의 페이지를 따라감 ──
  const [follow, setFollow] = useState(false);
  const followRef = useRef(false);
  useEffect(() => { followRef.current = follow; }, [follow]);
  const deviceIdRef = useRef(null);
  if (deviceIdRef.current == null) {
    let d = '';
    try { d = localStorage.getItem('calc-device-id') || ''; } catch {}
    if (!d) {
      d = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      try { localStorage.setItem('calc-device-id', d); } catch {}
    }
    deviceIdRef.current = d;
  }

  // follow OFF일 때 내 페이지를 보고 (리더 기기)
  useEffect(() => {
    if (!filePath || !numPages || followRef.current) return;
    reportPdfPosition(filePath, currentPage, deviceIdRef.current);
  }, [filePath, currentPage, numPages]);

  // follow ON일 때 리더의 페이지를 2초마다 따라감
  useEffect(() => {
    if (!filePath) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || typeof document === 'undefined' || document.hidden) return;
      if (!followRef.current) return;
      const pos = await getPdfPosition(filePath);
      if (!pos || !pos.page || pos.device === deviceIdRef.current) return;
      if (pos.page >= 1 && pos.page <= numPages && pos.page !== currentPageRef.current) {
        goToPage(pos.page);
      }
    };
    const id = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(id); };
  }, [filePath, numPages, goToPage]);

  // currentPage를 항상 최신으로 유지하는 ref (follow 틱에서 사용)
  const currentPageRef = useRef(currentPage);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);

  useEffect(() => {
    if (!filePath) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || typeof document === 'undefined' || document.hidden) return;
      // ── 어노테이션 ──
      try {
        const meta = await annotationsMeta(filePath);
        if (meta) {
          const items = new Map((meta.items || []).map((m) => [m.id, m.updatedAt]));
          const tombs = new Map((meta.tombstones || []).map((t) => [t.id, t.deletedAt]));
          const local = annotationsRef.current;
          const pushes = [];
          const survivors = local.filter((a) => {
            const t = tombs.get(a.id);
            if (t && (!a.updatedAt || a.updatedAt < t)) return false; // 다른 기기에서 삭제됨
            if (!items.has(a.id) && (!t || (a.updatedAt && a.updatedAt > t))) {
              pushes.push(saveAnnotation(a).catch(() => null)); // 오프라인 저장분 재업로드
            }
            return true;
          });
          if (survivors.length !== local.length) setAnnotations(survivors);
          const changed = survivors.some((a) => items.get(a.id) !== (a.updatedAt || undefined))
            || survivors.length !== items.size;
          if (pushes.length) await Promise.all(pushes);
          if (changed) {
            const remote = await getAnnotations(filePath);
            setAnnotations(remote);
          }
        }
      } catch { /* 네트워크 오류 무시 — 다음 틱에 재시도 */ }
      // ── 북마크 ──
      try {
        const meta = await bookmarksMeta(filePath);
        if (meta) {
          const items = meta.items || [];
          const tombs = new Map((meta.tombstones || []).map((t) => [t.id, t.deletedAt]));
          const local = bookmarksRef.current;
          const pushes = [];
          const survivors = local.filter((b) => {
            const t = tombs.get(b.id);
            if (t && (!b.createdAt || b.createdAt < t)) return false;
            if (!items.some((s) => s.id === b.id)) {
              pushes.push(saveBookmark(b).catch(() => null));
            }
            return true;
          });
          if (survivors.length !== local.length) setBookmarks(survivors);
          if (pushes.length) await Promise.all(pushes);
          const remote = await getBookmarks(filePath);
          const sig = (l) => JSON.stringify(l.map((x) => [x.id, x.pageNumber, x.createdAt || '']).sort());
          if (sig(remote) !== sig(bookmarksRef.current)) setBookmarks(remote);
        }
      } catch { /* 무시 */ }
      // ── 🧭 개념 노드 ──
      try {
        const meta = await conceptsMeta(filePath);
        if (meta) {
          const items = new Map((meta.items || []).map((m) => [m.id, m.updatedAt]));
          const tombs = new Map((meta.tombstones || []).map((t) => [t.id, t.deletedAt]));
          const local = conceptsRef.current;
          const pushes = [];
          const survivors = local.filter((c) => {
            const t = tombs.get(c.id);
            if (t && (!c.updatedAt || c.updatedAt < t)) return false; // 다른 기기에서 삭제됨
            if (!items.has(c.id) && (!t || (c.updatedAt && c.updatedAt > t))) {
              pushes.push(saveConcept(c).catch(() => null)); // 오프라인 저장분 재업로드
            }
            return true;
          });
          if (survivors.length !== local.length) setConcepts(survivors);
          const changed = survivors.some((c) => items.get(c.id) !== (c.updatedAt || undefined))
            || survivors.length !== items.size;
          if (pushes.length) await Promise.all(pushes);
          if (changed) {
            const remote = await getConcepts(filePath);
            setConcepts(remote);
          }
        }
      } catch { /* 무시 */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { stopped = true; clearInterval(id); };
  }, [filePath]);

  // ── 현재 문서의 푼/틀린 문제 (서버 DB) — 풀스크린 포함 접근 ──
  const refreshProblems = useCallback(() => {
    if (!filePath) { setProblems([]); return; }
    api.listProblems({ doc: filePath }).then(setProblems).catch(() => setProblems([]));
  }, [filePath]);
  useEffect(() => { refreshProblems(); }, [refreshProblems]);

  // Viewer 좌하단 📋 버튼 — PDF에서도 같은 위치에서 Problems 사이드바를 토글
  useEffect(() => {
    const onToggle = () => {
      setProblemsOpen((open) => !open);
      refreshProblems();
    };
    window.addEventListener('pdf:toggle-problems', onToggle);
    return () => window.removeEventListener('pdf:toggle-problems', onToggle);
  }, [refreshProblems]);

  const jumpToProblemPage = useCallback((p) => {
    if (p.doc_path !== filePath) {
      console.warn('[problem-jump] pdf doc mismatch', p.doc_path, filePath);
      setToast('That problem belongs to another document');
      setProblemsOpen(false);
      return;
    }
    const page = Number(p.ref);
    if (page > 0 && page <= numPages) {
      console.log('[problem-jump] pdf → page', page);
      goToPage(page);
      setFlashPage(page);
      setTimeout(() => setFlashPage(null), 2200);
    } else {
      console.warn('[problem-jump] pdf invalid page', p.ref, numPages);
      setToast("Couldn't find the page: " + (p.ref || '?'));
    }
    setProblemsOpen(false);
  }, [filePath, numPages, goToPage, setToast]);

  // 🔎 검색 결과 페이지로 점프 + 플래시 (검색 사이드바는 계속 열어 둠)
  const jumpToSearchHit = useCallback((p) => {
    goToPage(p);
    setFlashPage(p);
    setTimeout(() => setFlashPage(null), 2200);
  }, [goToPage]);

  const handleSearchHits = useCallback((m) => setSearchHits(m), []);
  const closeSearch = useCallback(() => { setSearchOpen(false); setSearchHits(new Map()); }, []);

  // 상태 지정(맞음/틀림) — 같은 상태 재클릭도 시도 횟수로 기록
  const setProblemStatus = useCallback((p, status) => {
    api.updateProblem(p.id, { status, attempts: p.attempts + 1 }).then(refreshProblems).catch(() => {});
  }, [refreshProblems]);

  const { requireClear, gateProps } = useClearGate(); // 파괴적 작업 비밀번호 게이트

  const removeProblemItem = useCallback((p) => {
    requireClear('Delete this problem', () => {
      api.deleteProblem(p.id).then(refreshProblems).catch(() => {});
    });
  }, [requireClear, refreshProblems]);

  // ── Reset state when PDF url changes ───────────────────
  useEffect(() => {
    setToc(null);
    setTocOpen(false);
    setLoadError(null);
    setNumPages(0);
    setFlashPage(null);
    setSearchOpen(false);
    setSearchHits(new Map());
    setEditingComment(null);
    setEditText('');
    setOpenCommentId(null);
    setConceptCapture(null);
    setConceptLabel('');
    setConceptParent('');
    autoFsRef.current = false; // 새 문서 → 다시 자동 풀스크린 유도
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

  // ── 🧭 키보드 단축키: N → 현재 페이지에 개념 캡처 바 (입력 중엔 무시) ──
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!filePath || !numPages) return;
      setConceptCapture({
        pageNumber: currentPage,
        px: Math.min(Math.max(window.innerWidth / 2 - 120, 8), window.innerWidth - 240),
        py: 72,
      });
      setConceptLabel('');
      setConceptParent(''); // 항상 최상위(Top Level) 기본 — 체인 생성 방지
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filePath, numPages, currentPage]);

  // ── RangeSelect(✂️ Selecting) → 문제 등록 ──
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

  // ── Polling: check selection every 250ms (highlight/underline) ──
  // ✂️ Selecting 중에는 비활성화 — 하이라이트 툴바와 겹치지 않게
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline') return;
    if (getRangeSelectState().active) return;
    const id = setInterval(() => {
      // Selecting이 켜지는 즉시 멈춤
      if (getRangeSelectState().active) {
        setSelTrigger(null);
        savedSelectionRef.current = null;
        lastDetectedText.current = '';
        return;
      }
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
      // 터치 기기: 즉시 팝오버 대신 ✛ 조준선 표시 — 드래그로 정밀 조정 후 ✓ 배치
      if (IS_TOUCH_PRIMARY) {
        setAim({
          kind: 'comment',
          pageNumber,
          px: Math.min(Math.max(e.clientX, 12), window.innerWidth - 12),
          py: Math.min(Math.max(e.clientY, 12), window.innerHeight - 12),
        });
        setCommentText('');
        setCommentStatus('');
        return;
      }
      // 하이라이트/밑줄과 동일하게 캔버스 기준으로 정규화 (렌더 경로와 일치)
      const pageRect = getPageCanvasRect(pageEl) || pageEl.getBoundingClientRect();
      const x = (e.clientX - pageRect.left) / pageRect.width;
      const y = (e.clientY - pageRect.top) / pageRect.height;
      // px/py: 입력창을 클릭한 뷰포트 좌표에 고정 배치 (화면 밖으로 나가지 않게 클램프)
      setActiveComment({
        pageNumber, x, y,
        px: Math.min(Math.max(e.clientX, 8), window.innerWidth - 240),
        py: Math.min(Math.max(e.clientY, 8), window.innerHeight - 200),
      });
      setCommentText('');
      setCommentStatus('');
    } else if (tool === 'image') {
      warmMl(); // 📐 ML 디텍터 워밍업 — 사진 선택 전에 모델 다운로드 시작
      const pageEl = pageRefs.current[pageNumber];
      if (!pageEl) return;
      // 터치 기기: ✛ 조준선으로 이미지/요약 배치 위치 정밀 지정
      if (IS_TOUCH_PRIMARY) {
        setAim({
          kind: 'image',
          pageNumber,
          px: Math.min(Math.max(e.clientX, 12), window.innerWidth - 12),
          py: Math.min(Math.max(e.clientY, 12), window.innerHeight - 12),
        });
        return;
      }
      const pageRect = getPageCanvasRect(pageEl) || pageEl.getBoundingClientRect();
      const x = (e.clientX - pageRect.left) / pageRect.width;
      const y = (e.clientY - pageRect.top) / pageRect.height;
      pendingImageRef.current = { pageNumber, x, y };
      // 📷/🖼️ 선택 팝업 — 탭 위치 근처에 표시
      setImageChoice({
        px: Math.min(Math.max(e.clientX, 8), window.innerWidth - 220),
        py: Math.min(Math.max(e.clientY, 8), window.innerHeight - 90),
      });
    } else if (tool === 'concept') {
      // 🧭 개념 노드 — 탭한 페이지에 캡처 바 (라벨 입력 → Enter = 생성)
      // 부모는 항상 최상위(Top Level) 기본 — 연속 생성 시 체인이 되지 않게
      // 탭 지점에서 살짝 비껴 배치 — 캔버스/노드와 여백 확보
      setConceptCapture({
        pageNumber,
        px: Math.min(Math.max(e.clientX + 10, 8), window.innerWidth - 260),
        py: Math.min(Math.max(e.clientY + 14, 8), window.innerHeight - 220),
      });
      setConceptLabel('');
      setConceptParent('');
    }
  }, [tool]);

  // ✛ 조준선 ✓ — 정밀 위치에 주석 배치 (터치 기기)
  const confirmAim = useCallback(() => {
    if (!aim) return;
    const pageEl = pageRefs.current[aim.pageNumber] || document.querySelector(`[data-page="${aim.pageNumber}"]`);
    const pageRect = getPageCanvasRect(pageEl);
    let x = 0.5, y = 0.5;
    if (pageRect) {
      x = Math.max(0.01, Math.min(0.99, (aim.px - pageRect.left) / pageRect.width));
      y = Math.max(0.01, Math.min(0.99, (aim.py - pageRect.top) / pageRect.height));
    }
    if (aim.kind === 'comment') {
      setActiveComment({
        pageNumber: aim.pageNumber, x, y,
        px: Math.min(Math.max(aim.px, 8), window.innerWidth - 240),
        py: Math.min(Math.max(aim.py, 8), window.innerHeight - 200),
      });
      setCommentText('');
      setCommentStatus('');
    } else if (aim.kind === 'image') {
      // 🖼️ 이미지/📒 요약 — 위치 확정 후 사진 선택 팝업 (스캔 → 원근 보정 → 배치)
      pendingImageRef.current = { pageNumber: aim.pageNumber, x, y };
      setImageChoice({
        px: Math.min(Math.max(aim.px, 8), window.innerWidth - 220),
        py: Math.min(Math.max(aim.py, 8), window.innerHeight - 90),
      });
    }
    setAim(null);
  }, [aim]);

  // 조준선 수명 관리 — 도구 변경/ESC로 해제
  useEffect(() => { setAim(null); }, [tool]);
  useEffect(() => {
    if (!aim) return;
    const onKey = (e) => { if (e.key === 'Escape') setAim(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aim]);

  // ── 🖼️ 이미지 주석 — 파일 압축 후 해당 위치에 배치 ──────────
  const placeImage = useCallback(async (dataUrl, aspect, scanner, opts = {}) => {
    const pending = pendingImageRef.current || scanPendingRef.current;
    pendingImageRef.current = null;
    scanPendingRef.current = null;
    if (!pending) return;
    // 세로 사진이 페이지를 벗어나 잘리지 않도록 처음부터 페이지 안으로 맞춘다
    const pageEl = pageRefs.current[pending.pageNumber] || document.querySelector(`[data-page="${pending.pageNumber}"]`);
    const canvasRect = getPageCanvasRect(pageEl);
    const pageAspect = canvasRect ? canvasRect.height / canvasRect.width : 1.4;
    // 📒 요약 범위 — 역전(start > end)이면 교환해서 항상 start ≤ end 유지
    let rangeStart = 0;
    let rangeEnd = 0;
    if (opts.kind === 'summary') {
      rangeStart = Number(opts.rangeStart) || 0;
      rangeEnd = Number(opts.rangeEnd) || 0;
      if (rangeStart > rangeEnd) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];
    }
    const annotation = {
      filePath,
      pageNumber: pending.pageNumber,
      type: opts.kind === 'summary' ? 'summary' : 'image',
      dataUrl,
      aspect,
      scanner: scanner || '', // 어떤 디텍터가 스캔했는지 (ml | classic | manual)
      rangeStart,
      rangeEnd,
      rect: fitImageRect({ x: pending.x, y: pending.y, w: 0.4 }, aspect, pageAspect),
    };
    const saved = await saveAnnotation(annotation);
    setAnnotations((prev) => [...prev, saved]);
    const label = scanner === 'ml' ? 'ML' : scanner === 'classic' ? 'Classic' : 'Manual';
    if (annotation.type === 'summary') {
      setToast(`📒 Summary added — p.${annotation.rangeStart || '?'}–${annotation.rangeEnd || '?'} (Scanned by ${label})`);
    } else {
      setToast(`🖼️ Image added — Scanned by ${label}`);
    }
  }, [filePath]);

  const handleImageSelected = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    const pending = pendingImageRef.current;
    setImageChoice(null);
    setTool(null); // 1회 배치 후 Read 모드로 복귀
    if (!file || !pending || !file.type.startsWith('image/')) {
      pendingImageRef.current = null;
      setToast('Please choose an image file');
      return;
    }
    if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
      pendingImageRef.current = null;
      setToast(`Image too large — ${MAX_IMAGE_MB}MB max`);
      return;
    }
    try {
      const { dataUrl, aspect } = await compressImageFile(file);
      // 📐 scanic — 스캔 영역 지정 모달 (모서리 드래그 → Apply → 원근 보정)
      // setTool(null)의 effect가 pendingImageRef를 비우므로 세션용 ref에 보관
      scanPendingRef.current = pending;
      // 📒 요약 범위 자동 제안 — 이전 요약의 끝 페이지 다음부터 현재 페이지까지.
      // 같은 페이지에 여러 요약을 쌓으면 역전(start > end)되지 않게 클램프한다.
      const lastEnd = annotations
        .filter((a) => a.type === 'summary')
        .reduce((m, s) => Math.max(m, Number(s.rangeEnd) || s.pageNumber || 0), 0);
      const rangeEnd = pending.pageNumber;
      setScanImage({
        dataUrl,
        aspect,
        suggestedRange: { start: lastEnd ? Math.min(lastEnd + 1, rangeEnd) : 1, end: rangeEnd },
      });
    } catch {
      pendingImageRef.current = null;
      scanPendingRef.current = null;
      setToast('Could not read that image');
    }
  }, [placeImage, annotations]);

  // 📐 scanic 영역 지정 결과 — Apply → 원근 보정된 이미지 배치
  const handleScanApply = useCallback(async (result) => {
    setScanImage(null);
    await placeImage(result.dataUrl, result.aspect, result.method, {
      kind: result.kind,
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
    });
  }, [placeImage]);

  const handleScanCancel = useCallback(() => {
    pendingImageRef.current = null;
    scanPendingRef.current = null;
    setScanImage(null);
  }, []);

  // 이미지 이동/크기 변경 저장
  const updateImageRect = useCallback((id, patch) => {
    const original = annotations.find((a) => a.id === id);
    if (!original) return;
    saveAnnotation({ ...original, ...patch }).then((saved) => {
      setAnnotations((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
    });
  }, [annotations]);

  const submitComment = useCallback(() => {
    if (!activeComment || !commentText.trim()) {
      setActiveComment(null);
      setCommentStatus('');
      return;
    }
    const annotation = {
      filePath,
      pageNumber: activeComment.pageNumber,
      type: 'comment',
      color: '#ffc864',
      text: commentText.trim(),
      status: commentStatus, // 스캔 PDF — ✗ Wrong / ✓ Solved 문제 코멘트
      attempts: commentStatus ? 1 : 0, // 문제로 등록하면 1회 시도로 시작
      wrong_count: commentStatus === 'wrong' ? 1 : 0,
      rect: { x: activeComment.x, y: activeComment.y, w: 0.03, h: 0.03 },
    };
    saveAnnotation(annotation).then((saved) => {
      setAnnotations((prev) => [...prev, saved]);
    });
    setActiveComment(null);
    setCommentText('');
    setCommentStatus('');
  }, [activeComment, commentText, commentStatus, filePath]);

  // ── 기존 코멘트 수정 — 마커/툴팁을 다시 터치하면 그 위치에 입력창 ──
  const startEditingComment = useCallback((annotation, e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOpenCommentId(null);
    setEditingComment({
      id: annotation.id,
      pageNumber: annotation.pageNumber,
      px: Math.min(Math.max(r.left, 8), window.innerWidth - 240),
      py: Math.min(Math.max(r.bottom + 8, 8), window.innerHeight - 220),
    });
    setEditText(annotation.text || '');
    setEditStatus(annotation.status || '');
  }, []);

  const submitEditComment = useCallback(() => {
    const editing = editingComment;
    if (!editing) return;
    const text = editText.replace(/\s+/g, ' ').trim();
    setEditingComment(null);
    setEditText('');
    setEditStatus('');
    if (!text) return; // 내용이 비어 있으면 변경 없이 닫기
    const original = annotations.find((a) => a.id === editing.id);
    // 상태가 바뀌면 한 번 더 풀었다고 간주 → attempts +1 (텍스트 문제와 동일)
    const statusChanged = editStatus !== (original?.status || '');
    const attempts = (original?.attempts || 0) + (statusChanged ? 1 : 0);
    const wrongCount = (original?.wrong_count || 0) + (editStatus === 'wrong' && (original?.status || '') !== 'wrong' ? 1 : 0);
    saveAnnotation({
      id: editing.id,
      filePath,
      pageNumber: editing.pageNumber,
      type: 'comment',
      color: original?.color || '#ffc864',
      text,
      status: editStatus, // 스캔 PDF — ✗ Wrong / ✓ Solved 문제 코멘트
      attempts,
      wrong_count: wrongCount,
      rect: original?.rect || { x: 0.5, y: 0.5, w: 0.03, h: 0.03 },
    }).then((saved) => {
      setAnnotations((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
    });
  }, [editingComment, editText, editStatus, filePath, annotations]);

  // ── 코멘트 문제 상태 전환 (스캔 PDF — 툴팁/Problems 패널의 ✓/✗, 매 탭 = 시도 1회) ──
  const updateCommentStatus = useCallback((a, status) => {
    const attempts = (a.attempts || 0) + 1; // 같은 상태 재클릭도 '한 번 더 풀었다' (텍스트 문제와 동일)
    const wrongCount = (a.wrong_count || 0) + (status === 'wrong' && a.status !== 'wrong' ? 1 : 0);
    saveAnnotation({ ...a, status, attempts, wrong_count: wrongCount }).then((saved) => {
      setAnnotations((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
      const n = saved.attempts ?? attempts;
      setToast(status === 'solved' ? `✓ Solved — attempt ${n}` : `✗ Wrong — attempt ${n}`);
    });
  }, []);

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

  // 스캔 PDF용 — ✗/✓ 상태가 붙은 코멘트를 문제처럼 Problems 패널에 합쳐 보여준다
  const commentProblems = useMemo(
    () => annotations.filter((a) => a.type === 'comment' && (a.status === 'wrong' || a.status === 'solved')),
    [annotations]
  );

  // 주석 모아보기에서 클릭 → 해당 페이지로 이동 후 주석 플래시
  const jumpToAnnotation = useCallback((a) => {
    setAnnotationsOpen(false);
    goToPage(a.pageNumber);
    setAnnotationFocus({ id: a.id, pageNumber: a.pageNumber });
  }, [goToPage]);

  // ── 🧭 개념 노드 — 코어 연산 후 변경분만 서버에 반영 (순수 diff) ──
  const persistConceptDiff = useCallback((oldMap, newMap) => {
    const ops = [];
    for (const id of Object.keys(oldMap)) {
      if (!newMap[id]) ops.push(deleteConcept(id));
    }
    for (const id of Object.keys(newMap)) {
      const n = newMap[id];
      const o = oldMap[id];
      if (!o
        || n.label !== o.label || n.summary !== o.summary || n.status !== o.status
        || n.parent !== o.parent || n.order !== o.order || n.pageNumber !== o.pageNumber) {
        ops.push(saveConcept({
          id: n.id, filePath, label: n.label, summary: n.summary, status: n.status,
          parentId: n.parent || '', pageNumber: n.pageNumber, order: n.order,
        }));
      }
    }
    return Promise.all(ops);
  }, [filePath]);

  const commitConceptMap = useCallback((oldMap, newMap) => {
    setConcepts(Object.values(newMap).map((n) => ({
      id: n.id, filePath, label: n.label, summary: n.summary, status: n.status,
      parentId: n.parent || '', pageNumber: n.pageNumber, order: n.order,
      createdAt: n.createdAt || new Date().toISOString(),
      updatedAt: n.updatedAt || new Date().toISOString(),
    })));
    persistConceptDiff(oldMap, newMap).catch(() => setToast('Concept sync failed — will retry'));
  }, [filePath, persistConceptDiff]);

  // 캡처 바 → 노드 생성 (status 기본 ○, 부모는 선택값)
  const submitConcept = useCallback(() => {
    const cap = conceptCapture;
    if (!cap) return;
    const label = conceptLabel.trim();
    setConceptCapture(null);
    setConceptLabel('');
    setConceptParent('');
    if (!label) return;
    const map = conceptsToMap(conceptsRef.current);
    const id = suggestId(map, conceptIdBase(filePath));
    try {
      const newMap = addNode(map, { id, label, parent: conceptParent || null, pageNumber: cap.pageNumber });
      commitConceptMap(map, newMap);
      setToast('🧭 Concept added');
    } catch (e) {
      setToast(String(e.message || e));
    }
  }, [conceptCapture, conceptLabel, conceptParent, filePath, commitConceptMap]);

  // 점프한 주석이 페이지 렌더 후 DOM에 나타나면 스크롤 + 플래시
  useEffect(() => {
    if (!annotationFocus) return;
    const el = document.querySelector(`[data-annotation-id="${CSS.escape(annotationFocus.id)}"]`);
    if (!el) return; // 아직 렌더 안 됨 — pageRenderTick 변경 시 재시도
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('pdf-annotator__focus-flash');
    const t = setTimeout(() => {
      el.classList.remove('pdf-annotator__focus-flash');
      setAnnotationFocus(null);
    }, 2600);
    return () => clearTimeout(t);
  }, [annotationFocus, pageRenderTick]);

  // ── PDF.js 옵션 (cMaps, 표준 폰트 CDN) ────────────────────
  const documentOptions = useMemo(() => ({
    cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
  }), []);

  const isFakeFullscreen = fullscreen && !document.fullscreenElement;

  const content = (
    <div className={'pdf-annotator' + (fullscreen ? ' pdf-annotator--fullscreen' : '') + (isMobile && fullscreen && (activeComment || editingComment || conceptCapture) ? ' pdf-annotator--input-open' : '')} ref={containerRef}>
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
          {/* 현재 페이지 북마크 — 페이지 넘김 버튼 옆에 있으면 실수로 눌리므로 툴바로 이동 */}
          <button
            className={'pdf-annotator__tool' + (isBookmarked ? ' pdf-annotator__tool--active' : '')}
            onClick={toggleBookmark}
            title={isBookmarked ? 'Remove bookmark from this page' : 'Add bookmark to this page'}
          >
            {isBookmarked ? '🔖 Bookmarked' : '🏷️ Bookmark'}
          </button>
          {/* 👣 교육용 따라가기 — ON이면 다른 기기의 페이지를 따라감 (리더 기기는 OFF 유지) */}
          <button
            className={'pdf-annotator__tool' + (follow ? ' pdf-annotator__tool--active' : '')}
            onClick={() => setFollow((v) => !v)}
            title="Follow the other device's page — for teaching (leader device keeps this OFF)"
          >
            👣 {follow ? 'Following' : 'Follow'}
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
            className={'pdf-annotator__tool' + (searchOpen ? ' pdf-annotator__tool--active' : '')}
            onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true); }}
            title="Search text in this document"
          >
            🔎 Search
          </button>
          <button
            className={'pdf-annotator__tool' + (annotationsOpen ? ' pdf-annotator__tool--active' : '')}
            onClick={() => setAnnotationsOpen(!annotationsOpen)}
            title="Notes"
          >
            🗒️ Notes
          </button>
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
            className="pdf-annotator__tool"
            onClick={() => { if (onOpenConcepts) onOpenConcepts(); }}
            title="Open this document's concepts — fullscreen tree"
          >
            🧭 Concepts
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
          {/* 🖼️ 이미지 주석 업로드 (숨김) — 갤러리 */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleImageSelected}
          />
          {/* 📷 카메라 직접 촬영 (모바일/태블릿: capture=environment) */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={handleImageSelected}
          />
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
                <div
                  key={bm.id}
                  className="pdf-annotator__toc-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    goToPage(bm.pageNumber);
                    setBookmarksOpen(false);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { goToPage(bm.pageNumber); setBookmarksOpen(false); } }}
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
                </div>
              ))
          )}
        </div>
      </div>
      <div className="pdf-annotator__toc-overlay" onClick={() => setBookmarksOpen(false)} />

      {/* Notes Sidebar — 주석 모아보기 (클릭 → 해당 페이지/주석으로 이동) */}
      <div className={'pdf-annotator__toc-sidebar' + (annotationsOpen ? ' pdf-annotator__toc-sidebar--open' : '')}>
        <div className="pdf-annotator__toc-header">
          <span>🗒️ Notes ({annotations.filter((a) => a.type !== 'summary').length})</span>
          <button className="pdf-annotator__toc-close" onClick={() => setAnnotationsOpen(false)}>×</button>
        </div>
        <div className="pdf-annotator__toc-list">
          {annotations.filter((a) => a.type !== 'summary').length === 0 ? (
            <div className="pdf-annotator__toc-item" style={{ opacity: 0.5, cursor: 'default' }}>
              No notes yet
            </div>
          ) : (
            [...annotations]
              .filter((a) => a.type !== 'summary') // 📒 요약은 Summaries 탭에서만
              .sort((a, b) => a.pageNumber - b.pageNumber)
              .map((a) => (
                <div key={a.id} className="pdf-annotator__note">
                  <button
                    className="pdf-annotator__note-open"
                    onClick={() => jumpToAnnotation(a)}
                    title={`Go to page ${a.pageNumber}`}
                  >
                    <span className="pdf-annotator__note-icon">
                      {a.type === 'comment'
                        ? (a.status === 'wrong' ? '✗' : a.status === 'solved' ? '✓' : '💬')
                        : a.type === 'image' ? '🖼️' : a.type === 'underline' ? '⎁' : '🖍️'}
                    </span>
                    <span className="pdf-annotator__note-body">
                      <span className="pdf-annotator__note-page">
                        p.{a.pageNumber} · {a.type}
                        {a.type === 'image' && a.scanner && (
                          <span className="pdf-annotator__note-scanner">
                            {' '}· {a.scanner === 'ml' ? 'ML' : 'Classic'}
                          </span>
                        )}
                      </span>
                      {a.type === 'image' ? (
                        <img className="pdf-annotator__note-thumb" src={a.dataUrl} alt="" />
                      ) : (
                        a.text && <span className="pdf-annotator__note-text">{a.text}</span>
                      )}
                    </span>
                  </button>
                  <button
                    className="pdf-annotator__delete-btn"
                    onClick={() => removeAnnotation(a.id)}
                    title="Delete note"
                  >×</button>
                </div>
              ))
          )}
        </div>
      </div>
      <div className="pdf-annotator__toc-overlay" onClick={() => setAnnotationsOpen(false)} />

      {/* Problems Sidebar — 풀스크린 포함 접근 가능 */}
      <div className={'pdf-annotator__toc-sidebar' + (problemsOpen ? ' pdf-annotator__toc-sidebar--open' : '')}>
        <div className="pdf-annotator__toc-header">
          <span>📋 Problems</span>
          <button className="pdf-annotator__toc-close" onClick={() => setProblemsOpen(false)}>×</button>
        </div>
        <div className="pdf-annotator__toc-list">
          {problems.length === 0 && commentProblems.length === 0 ? (
            <div className="pdf-annotator__toc-item" style={{ opacity: 0.5, cursor: 'default' }}>
              No problems in this document yet
            </div>
          ) : (
            <>
            {problems.map((p) => (
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
            ))}
            {/* 스캔 PDF용 — ✗/✓ 상태가 붙은 코멘트를 문제처럼 표시 */}
            {commentProblems.map((a) => (
              <div key={'c' + a.id} className={'pdf-annotator__problem pdf-annotator__problem--' + a.status}>
                <button
                  className="pdf-annotator__problem-open"
                  onClick={() => { jumpToAnnotation(a); setProblemsOpen(false); }}
                  title="Go to page"
                >
                  <span className="pdf-annotator__problem-status">{a.status === 'solved' ? '✓' : '✗'}</span>
                  <span className="pdf-annotator__problem-body">
                    <span className="pdf-annotator__problem-src">
                      p.{a.pageNumber} · comment
                      {(a.attempts || 0) > 0 && ` · ${a.attempts} attempt${a.attempts === 1 ? '' : 's'} · ${a.wrong_count || 0} wrong`}
                    </span>
                    <span className="pdf-annotator__problem-text">{a.text}</span>
                  </span>
                </button>
                <div className="pdf-annotator__problem-actions">
                  <button
                    className="pdf-annotator__problem-solve"
                    onClick={() => updateCommentStatus(a, 'solved')}
                    title="Mark as solved"
                  >✓</button>
                  <button
                    className="pdf-annotator__problem-wrong"
                    onClick={() => updateCommentStatus(a, 'wrong')}
                    title="Mark as wrong"
                  >✗</button>
                  <button
                    className="pdf-annotator__problem-delete"
                    onClick={() => removeAnnotation(a.id)}
                    title="Delete"
                  >🗑️</button>
                </div>
              </div>
            ))}
            </>
          )}
        </div>
      </div>
      <div className="pdf-annotator__toc-overlay" onClick={() => setProblemsOpen(false)} />

      {/* Search Sidebar — 문서 전체 텍스트 검색 (인덱스 페이지 등) */}
      <PdfSearchPanel
        filePath={filePath}
        pdf={pdfDocRef.current}
        numPages={numPages}
        open={searchOpen}
        onClose={closeSearch}
        onJump={jumpToSearchHit}
        onHitsChange={handleSearchHits}
      />

      {/* Comment input overlay — 클릭한 위치(뷰포트 좌표)에 고정 배치.
          모바일 풀스크린에서는 바닥 시트로 (키보드·FAB 행 안정, 입력창 잘림 방지) */}
      {activeComment && (
        <div
          className={'pdf-annotator__comment-input' + (isMobile && fullscreen ? ' pdf-annotator__comment-input--sheet' : '')}
          style={isMobile && fullscreen ? kbLiftStyle : {
            position: 'fixed',
            left: activeComment.px,
            top: activeComment.py,
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
              if (e.key === 'Escape') { setActiveComment(null); setCommentText(''); setCommentStatus(''); }
            }}
          />
          <div className="pdf-annotator__status-chips">
            <button
              className={'pdf-annotator__status-chip' + (commentStatus === '' ? ' pdf-annotator__status-chip--active' : '')}
              onClick={() => setCommentStatus('')}
              title="Plain note"
            >💬 Note</button>
            <button
              className={'pdf-annotator__status-chip pdf-annotator__status-chip--wrong' + (commentStatus === 'wrong' ? ' pdf-annotator__status-chip--active' : '')}
              onClick={() => setCommentStatus(commentStatus === 'wrong' ? '' : 'wrong')}
              title="Mark as a wrong problem"
            >✗ Wrong</button>
            <button
              className={'pdf-annotator__status-chip pdf-annotator__status-chip--solved' + (commentStatus === 'solved' ? ' pdf-annotator__status-chip--active' : '')}
              onClick={() => setCommentStatus(commentStatus === 'solved' ? '' : 'solved')}
              title="Mark as a solved problem"
            >✓ Solved</button>
          </div>
          <div className="pdf-annotator__comment-actions">
            <button onClick={submitComment}>Save</button>
            <button onClick={() => { setActiveComment(null); setCommentText(''); setCommentStatus(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Comment edit overlay — 기존 코멘트를 다시 터치하면 그 위치에서 수정 */}
      {editingComment && (
        <div
          className={'pdf-annotator__comment-input' + (isMobile && fullscreen ? ' pdf-annotator__comment-input--sheet' : '')}
          style={isMobile && fullscreen ? kbLiftStyle : {
            position: 'fixed',
            left: editingComment.px,
            top: editingComment.py,
          }}
        >
          <textarea
            autoFocus
            rows={3}
            placeholder="Enter a comment…"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) submitEditComment();
              if (e.key === 'Escape') { setEditingComment(null); setEditText(''); setEditStatus(''); }
            }}
          />
          <div className="pdf-annotator__status-chips">
            <button
              className={'pdf-annotator__status-chip' + (editStatus === '' ? ' pdf-annotator__status-chip--active' : '')}
              onClick={() => setEditStatus('')}
              title="Plain note"
            >💬 Note</button>
            <button
              className={'pdf-annotator__status-chip pdf-annotator__status-chip--wrong' + (editStatus === 'wrong' ? ' pdf-annotator__status-chip--active' : '')}
              onClick={() => setEditStatus(editStatus === 'wrong' ? '' : 'wrong')}
              title="Mark as a wrong problem"
            >✗ Wrong</button>
            <button
              className={'pdf-annotator__status-chip pdf-annotator__status-chip--solved' + (editStatus === 'solved' ? ' pdf-annotator__status-chip--active' : '')}
              onClick={() => setEditStatus(editStatus === 'solved' ? '' : 'solved')}
              title="Mark as a solved problem"
            >✓ Solved</button>
          </div>
          <div className="pdf-annotator__comment-actions">
            <button onClick={submitEditComment}>Save</button>
            <button onClick={() => { setEditingComment(null); setEditText(''); setEditStatus(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* 🧭 Concept capture — 재사용 ConceptInput (페이지 탭/단축키 N) */}
      {conceptCapture && (
        <div
          className={'pdf-annotator__concept-capture' + (isMobile && fullscreen ? ' pdf-annotator__concept-capture--sheet' : '')}
          style={isMobile && fullscreen ? kbLiftStyle : { position: 'fixed', left: conceptCapture.px, top: conceptCapture.py, zIndex: 50 }}
        >
          <ConceptInput
            label={conceptLabel}
            onLabelChange={setConceptLabel}
            parent={conceptParent}
            onParentChange={setConceptParent}
            concepts={concepts}
            onSubmit={submitConcept}
            onCancel={() => { setConceptCapture(null); setConceptLabel(''); setConceptParent(''); }}
          />
        </div>
      )}

      {/* ✛ 터치 조준선 — 주석(코멘트·이미지·요약) 배치 위치 정밀 조정 */}
      {aim && (
        <div
          className="pdf-annotator__comment-aim"
          style={{ left: aim.px, top: aim.py }}
          onPointerDown={(e) => {
            if (e.target.closest('button')) return;
            e.preventDefault();
            aimDragRef.current = {
              id: e.pointerId, startX: e.clientX, startY: e.clientY,
              baseX: aim.px, baseY: aim.py,
            };
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = aimDragRef.current;
            if (!d || d.id !== e.pointerId) return;
            const px = Math.max(12, Math.min(window.innerWidth - 12, d.baseX + (e.clientX - d.startX)));
            const py = Math.max(12, Math.min(window.innerHeight - 12, d.baseY + (e.clientY - d.startY)));
            setAim((a) => (a ? { ...a, px, py } : a));
          }}
          onPointerUp={() => { aimDragRef.current = null; }}
          onPointerCancel={() => { aimDragRef.current = null; }}
        >
          <span className="pdf-annotator__comment-aim-ring" />
          <span className="pdf-annotator__comment-aim-cross" />
          <div className="pdf-annotator__comment-aim-actions">
            <button onClick={confirmAim} title="Place here" aria-label="Place">✓</button>
            <button onClick={() => setAim(null)} title="Cancel" aria-label="Cancel aim">✕</button>
          </div>
          <div className="pdf-annotator__comment-aim-hint">Drag to fine-tune · ✓ to place</div>
        </div>
      )}

      {/* PDF Document */}
      <div
        ref={documentRef}
        className="pdf-annotator__document pdf-annotator__document--paginated"
        style={{
          overflow: (fullscreen || zoomLevel > 1) ? 'auto' : undefined,
          justifyContent: (fullscreen || zoomLevel > 1) ? 'flex-start' : undefined,
        }}
        onTouchStart={handleSwipeStart}
        onTouchEnd={handleSwipeEnd}
        onClick={() => setOpenCommentId(null)}
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
            const pageHits = searchOpen ? searchHits.get(pageNumber) : undefined;
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
                  cursor: (tool === 'highlight' || tool === 'underline' || rangeActive) ? 'text' : tool === 'concept' ? 'crosshair' : undefined,
                }}
              >
                <PdfPageMemo
                  pageNumber={pageNumber}
                  width={pageW}
                  textLayer={tool === 'highlight' || tool === 'underline' || rangeActive}
                  onRenderSuccess={handleRenderSuccess}
                />
                {/* Annotation overlay */}
                {annos.map((a) => (a.type === 'image' || a.type === 'summary') ? (
                  <ImageOverlay
                    key={a.id}
                    annotation={a}
                    pageEl={pageRefs.current[pageNumber]}
                    onSave={updateImageRect}
                    onDelete={removeAnnotation}
                    eraseMode={tool === 'erase'}
                  />
                ) : (
                  <AnnotationOverlay
                    key={a.id}
                    annotation={a}
                    pageEl={pageRefs.current[pageNumber]}
                    onDelete={removeAnnotation}
                    onSave={updateImageRect}
                    eraseMode={tool === 'erase'}
                    viewOpen={openCommentId === a.id}
                    onViewComment={setOpenCommentId}
                    onEditComment={startEditingComment}
                    onToggleStatus={updateCommentStatus}
                  />
                ))}
                {/* 🔎 검색 매치 하이라이트 (정규화 좌표 → 캔버스 기준) */}
                {pageHits && pageHits.map((r, i) => {
                  const pos = annoRect({ rect: r }, pageRefs.current[pageNumber]);
                  return (
                    <div
                      key={'s' + i}
                      className="pdf-annotator__search-hit"
                      style={pos ? {
                        left: pos.left,
                        top: pos.top,
                        width: pos.width,
                        height: pos.height,
                      } : {
                        left: `${r.x * 100}%`,
                        top: `${r.y * 100}%`,
                        width: `${r.w * 100}%`,
                        height: `${r.h * 100}%`,
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </Document>
        )}
      </div>

      {/* Selection trigger — floating confirm toolbar (highlight / underline 전용) */}
      {selTrigger && (tool === 'highlight' || tool === 'underline') && (
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

      {/* 📷/🖼️ 이미지 소스 선택 팝업 — 이미지 툴로 페이지 탭 시 표시 */}
      {imageChoice && tool === 'image' && (
        <div
          className="pdf-annotator__sel-trigger"
          style={{
            position: 'fixed',
            left: imageChoice.px,
            top: imageChoice.py,
            zIndex: 200,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="pdf-annotator__sel-trigger-inner">
            <button
              className="pdf-annotator__sel-confirm"
              onClick={() => cameraInputRef.current?.click()}
            >
              📷 Camera
            </button>
            <button
              className="pdf-annotator__sel-confirm"
              onClick={() => imageInputRef.current?.click()}
            >
              🖼️ Gallery
            </button>
            <button
              className="pdf-annotator__sel-cancel"
              onClick={() => { setImageChoice(null); pendingImageRef.current = null; }}
            >
              ✕
            </button>
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
            className="pdf-annotator__nav-btn"
            onClick={() => goToPage(Math.min(numPages, currentPage + 1))}
            disabled={currentPage >= numPages}
            title="Next page"
          >
            ▶
          </button>
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
      {/* 모바일 + 비풀스크린: 최소한의 풀스크린 진입 버튼 */}
      {isMobile && !fullscreen && (
        <button
          className="pdf-annotator__mobile-fullscreen-btn"
          onClick={toggleFullscreen}
          title="Enter fullscreen"
          aria-label="Enter fullscreen"
        >⛶</button>
      )}
      {toast && <div className="pdf-annotator__toast">{toast}</div>}
      {/* 📐 scanic 스캔 영역 지정 모달 — 사진 → 모서리 지정 → 원근 보정 */}
      {scanImage && (
        <ScanAreaModal
          dataUrl={scanImage.dataUrl}
          aspect={scanImage.aspect}
          suggestedRange={scanImage.suggestedRange}
          onApply={handleScanApply}
          onCancel={handleScanCancel}
        />
      )}
      {/* 📒 요약 필기 모아보기는 Summaries 탭에서 — PDF 쪽은 주석 렌더링만 유지 */}
      <ClearGate {...gateProps} />
    </div>
  );

  return isFakeFullscreen ? createPortal(content, document.body) : content;
}

/**
 * Renders a single annotation overlay.
 * (memo 미사용 — 줌/캔버스 재렌더/레이아웃 변경마다 useLayoutEffect가
 *  위치를 다시 계산해야 하므로 부모 리렌더마다 갱신한다. 값 비교로 불필요한
 *  setState는 막아 루프 없이 안정적으로 동작한다)
 */
function AnnotationOverlay({ annotation, pageEl, onDelete, onSave, eraseMode, viewOpen, onViewComment, onEditComment, onToggleStatus }) {
  // Always find page element fresh from DOM — prop may be stale after page navigation
  const getPageEl = () => document.querySelector(`[data-page="${annotation.pageNumber}"]`) || pageEl;
  const [rect, setRect] = useState(null);
  const [markerPos, setMarkerPos] = useState(null); // 엣지 보정된 코멘트 마커 위치 { left, top, edgeLeft, edgeRight, edgeTop }
  const prevRectRef = useRef(null);

  // Recalculate rect after every render — onRenderSuccess on <Page> ensures
  // we re-render once the PDF canvas is actually in the DOM.
  // Compare by value (not reference) to avoid infinite re-render loops.
  // 페이지 엣지에 가까운 코멘트는 아이콘이 잘리지 않게 좌표를 보정하고,
  // 툴팁이 페이지 밖으로 나가지 않도록 edge 플래그를 계산한다.
  useLayoutEffect(() => {
    const el = getPageEl();
    const next = annoRect(annotation, el);
    const pr = el ? el.getBoundingClientRect() : null;
    const pageW = pr ? pr.width : 0;
    const pageH = pr ? pr.height : 0;
    const pos = next ? {
      left: pageW ? Math.max(14, Math.min(next.left, pageW - 14)) : next.left,
      top: pageH ? Math.max(14, Math.min(next.top, pageH - 14)) : next.top,
      edgeLeft: next.left < 100,
      edgeRight: pageW - next.left < 100,
      edgeTop: next.top < 48,
    } : null;
    const prev = prevRectRef.current;
    if (next && prev && prev.rect && prev.pos &&
        next.left === prev.rect.left && next.top === prev.rect.top &&
        next.width === prev.rect.width && next.height === prev.rect.height &&
        pos.left === prev.pos.left && pos.top === prev.pos.top &&
        pos.edgeLeft === prev.pos.edgeLeft && pos.edgeRight === prev.pos.edgeRight && pos.edgeTop === prev.pos.edgeTop) {
      return;
    }
    prevRectRef.current = next ? { rect: next, pos } : null;
    setRect(next);
    setMarkerPos(pos);
  });

  const handleDelete = eraseMode ? (e) => { e.stopPropagation(); onDelete(annotation.id); } : undefined;
  // READ 모드: 첫 터치 = 툴팁 열기, 열린 상태에서 다시 터치 = 수정 입력창
  const handleCommentClick = eraseMode
    ? handleDelete
    : (e) => {
        e.stopPropagation();
        if (movedRef.current) return; // 드래그 직후 클릭 무시 (이미지 주석과 동일)
        if (viewOpen) onEditComment(annotation, e);
        else onViewComment(annotation.id);
      };
  // 툴팁 본문을 터치해도 바로 수정 (지우개 모드 제외, 드래그 직후 클릭 무시)
  const handleTooltipClick = eraseMode ? undefined : (e) => {
    e.stopPropagation();
    if (movedRef.current) return;
    onEditComment(annotation, e);
  };
  // 문제 코멘트(✗/✓ 상태)와 일반 텍스트 코멘트는 툴팁 액션이 다르다
  const isProblemComment = annotation.status === 'wrong' || annotation.status === 'solved';

  // ── 💬 코멘트 마커 드래그 — 이미지 주석처럼 끌어서 위치 갱신 (드래그 후 저장) ──
  const markerElRef = useRef(null);
  const dragRef = useRef(null);   // { px, py, left, top }
  const movedRef = useRef(false); // 탭(툴팁) vs 드래그 구분 — 다음 pointerdown까지 유지

  const startCommentDrag = (e) => {
    if (eraseMode) return;
    if (e.target && e.target.closest && e.target.closest('button')) return; // 툴팁 버튼/삭제 버튼은 클릭으로
    const el = markerElRef.current;
    if (!el) return;
    e.stopPropagation();
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      left: parseFloat(el.style.left) || (markerPos?.left ?? 0),
      top: parseFloat(el.style.top) || (markerPos?.top ?? 0),
    };
    movedRef.current = false;
    el.style.willChange = 'left, top';
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 합성 이벤트 무시 */ }
  };

  const moveCommentDrag = (e) => {
    const d = dragRef.current;
    const el = markerElRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedRef.current = true;
    el.style.left = `${d.left + dx}px`;
    el.style.top = `${d.top + dy}px`;
  };

  const endCommentDrag = () => {
    const el = markerElRef.current;
    if (!dragRef.current) {
      if (el) el.style.willChange = '';
      return;
    }
    dragRef.current = null;
    if (!el) return;
    el.style.willChange = '';
    if (!movedRef.current) return; // 탭 — 클릭 핸들러가 툴팁/수정 처리
    // 위치 저장 — wrapper 기준 px → 캔버스 기준 정규화 좌표 (렌더 경로와 동일한 역변환)
    const page = getPageEl();
    const canvasRect = getPageCanvasRect(page);
    const wrapperRect = page ? page.getBoundingClientRect() : null;
    if (!canvasRect || !wrapperRect) return;
    const x = (parseFloat(el.style.left) + wrapperRect.left - canvasRect.left) / canvasRect.width;
    const y = (parseFloat(el.style.top) + wrapperRect.top - canvasRect.top) / canvasRect.height;
    onSave(annotation.id, {
      rect: {
        x: Math.max(0.02, Math.min(0.98, x)),
        y: Math.max(0.02, Math.min(0.98, y)),
        w: annotation.rect.w || 0.03,
        h: annotation.rect.h || 0.03,
      },
    });
  };

  if (annotation.type === 'comment') {
    return (
      <div
        ref={markerElRef}
        data-annotation-id={annotation.id}
        className={'pdf-annotator__comment-marker' +
          (eraseMode ? ' pdf-annotator__comment-marker--erasable' : ' pdf-annotator__comment-marker--viewable') +
          (viewOpen ? ' pdf-annotator__comment-marker--open' : '') +
          (annotation.status === 'wrong' ? ' pdf-annotator__comment-marker--wrong' : '') +
          (annotation.status === 'solved' ? ' pdf-annotator__comment-marker--solved' : '') +
          (markerPos?.edgeLeft ? ' pdf-annotator__comment-marker--edge-left' : '') +
          (markerPos?.edgeRight ? ' pdf-annotator__comment-marker--edge-right' : '') +
          (markerPos?.edgeTop ? ' pdf-annotator__comment-marker--edge-top' : '')}
        style={{
          left: markerPos ? markerPos.left : rect ? rect.left : `${annotation.rect.x * 100}%`,
          top: markerPos ? markerPos.top : rect ? rect.top : `${annotation.rect.y * 100}%`,
        }}
        title={annotation.text}
        onPointerDown={startCommentDrag}
        onPointerMove={moveCommentDrag}
        onPointerUp={endCommentDrag}
        onPointerCancel={endCommentDrag}
        onClick={handleCommentClick}
      >
        <span className="pdf-annotator__comment-icon" aria-hidden>
          {annotation.status === 'wrong' ? '✗' : annotation.status === 'solved' ? '✓' : '💬'}
        </span>
        <span className="pdf-annotator__comment-tooltip" onClick={handleTooltipClick}>
          <span className="pdf-annotator__comment-tooltip-text">{annotation.text}</span>
          {!eraseMode && isProblemComment && (
            <>
              <button
                className="pdf-annotator__comment-status-btn pdf-annotator__comment-status-btn--solved"
                onClick={(e) => { e.stopPropagation(); onToggleStatus(annotation, 'solved'); }}
                aria-label="One more attempt — mark as solved"
                title="✓ One more attempt — solved"
              >✓</button>
              <button
                className="pdf-annotator__comment-status-btn pdf-annotator__comment-status-btn--wrong"
                onClick={(e) => { e.stopPropagation(); onToggleStatus(annotation, 'wrong'); }}
                aria-label="One more attempt — mark as wrong"
                title="✗ One more attempt — wrong"
              >✗</button>
            </>
          )}
        </span>
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
      data-annotation-id={annotation.id}
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
}

/**
 * 🖼️ 이미지 주석 오버레이 — 드래그 이동 + 우하단 핸들 리사이즈, 지우개 모드에서 삭제
 * 드래그 중에는 React 상태를 거치지 않고 DOM을 직접 조작해 지연을 없앤다.
 * (서버 동기화는 포인터를 놓는 순간 1회만 수행)
 */
function ImageOverlay({ annotation, pageEl, onSave, onDelete, eraseMode }) {
  const [open, setOpen] = useState(false);           // 기본 접힘 — 탭하면 펼침
  const [lightbox, setLightbox] = useState(false);   // 🖼️ 전체화면 뷰어 (Amazon-style)
  const [pos, setPos] = useState(null);
  const elRef = useRef(null);
  const dragRef = useRef(null);                      // { mode, px, py, dx, dy, rect, canvasRect, box }
  const movedRef = useRef(false);                    // 탭(열기) vs 드래그(이동) 구분
  const prevPosRef = useRef(null);                  // 무한 리렌더 방지용 값 비교

  // 캔버스 기준 정규화 좌표 → 픽셀 (AnnotationOverlay와 동일한 재계산 전략)
  useLayoutEffect(() => {
    if (dragRef.current) return; // 드래그 중에는 imperative 스타일 유지
    const el = document.querySelector(`[data-page="${annotation.pageNumber}"]`) || pageEl;
    const canvasRect = getPageCanvasRect(el);
    if (!canvasRect) { setPos(null); return; }
    const wrapperRect = el.getBoundingClientRect();
    const w = annotation.rect.w * canvasRect.width;
    const h = annotation.aspect ? w / annotation.aspect : (annotation.rect.h || annotation.rect.w) * canvasRect.height;
    const next = {
      left: (canvasRect.left - wrapperRect.left) + annotation.rect.x * canvasRect.width,
      top: (canvasRect.top - wrapperRect.top) + annotation.rect.y * canvasRect.height,
      width: w,
      height: h,
    };
    const prev = prevPosRef.current;
    if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) {
      return;
    }
    prevPosRef.current = next;
    setPos(next);
  });

  if (!pos || !annotation.dataUrl) return null;

  const startDrag = (e, mode) => {
    if (eraseMode) return;
    // ✕ 닫기 등 내부 <button> 클릭은 드래그로 처리하지 않는다 —
    // 포인터 캡처가 걸리면 click이 버튼 대신 부모로 리타겟되어 버튼이 먹통이 된다.
    if (e.target && e.target.closest && e.target.closest('button')) return;
    e.stopPropagation();
    e.preventDefault();
    const el = document.querySelector(`[data-page="${annotation.pageNumber}"]`) || pageEl;
    const canvasRect = getPageCanvasRect(el);
    if (!canvasRect) return;
    // 기준점은 뷰포트 좌표(bounding box)가 아니라 래퍼 기준 pos — 좌표계 혼합으로 인한
    // 드래그 시작 순간의 순간이동을 방지한다.
    dragRef.current = {
      mode, px: e.clientX, py: e.clientY, dx: 0, dy: 0,
      rect: { ...annotation.rect }, canvasRect,
      left: pos.left,
      top: pos.top,
      width: pos.width,
      height: pos.height,
    };
    movedRef.current = false;
    const node = elRef.current;
    if (node) node.style.willChange = 'transform'; // 합성 레이어 승격 — 드래그 중 리플로우 방지
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 합성 이벤트 등에서 무시 */ }
  };

  const onMove = (e) => {
    const d = dragRef.current;
    const node = elRef.current;
    if (!d || !node) return;
    d.dx = e.clientX - d.px;
    d.dy = e.clientY - d.py;
    if (Math.abs(d.dx) > 1 || Math.abs(d.dy) > 1) movedRef.current = true;
    if (d.mode === 'move') {
      // transform 기반 이동 — left/top 변경과 달리 레이아웃 없이 합성만 일어난다
      node.style.transform = `translate3d(${d.dx}px, ${d.dy}px, 0)`;
    } else {
      const w = Math.min(Math.max(d.width + d.dx, d.canvasRect.width * 0.12), d.canvasRect.width);
      node.style.width = w + 'px';
      node.style.height = (w / (annotation.aspect || 1)) + 'px';
    }
  };

  const onUp = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    const node = elRef.current;
    if (node) node.style.willChange = '';
    if (!movedRef.current) return; // 움직이지 않으면 저장 생략 (탭 = 열기)
    if (d.mode === 'move' && node) {
      // 같은 프레임에서 transform 해제 + 최종 위치를 left/top에 반영 — 시각 점프 없음
      node.style.transform = '';
      node.style.left = (d.left + d.dx) + 'px';
      node.style.top = (d.top + d.dy) + 'px';
    }
    // 페이지 밖으로 나가지 않도록 fit — contain:paint가 페이지 경계 밖을 잘라내므로
    // x/y/w 모두 페이지 안으로 클램프하고 h는 aspect로 재계산한다
    const pageAspect = d.canvasRect.height / d.canvasRect.width;
    const raw = d.mode === 'move'
      ? { ...d.rect, x: d.rect.x + d.dx / d.canvasRect.width, y: d.rect.y + d.dy / d.canvasRect.height }
      : { ...d.rect, w: Math.min(Math.max(d.rect.w + d.dx / d.canvasRect.width, 0.12), 1) };
    onSave(annotation.id, { rect: fitImageRect(raw, annotation.aspect, pageAspect) });
  };

  // 🔄 이미지 90° 회전 — dataUrl 회전 + aspect 역수 + 페이지 안으로 재맞춤 후 저장(동기화)
  // 풀스크린 라이트박스에서만 호출 — deg 270 = ↺ CCW, deg 90 = ↻ CW
  const rotateImageBy = async (deg) => {
    try {
      const rotated = await rotateImageDataUrl(annotation.dataUrl, deg);
      const newAspect = 1 / (annotation.aspect || 1);
      const el = document.querySelector(`[data-page="${annotation.pageNumber}"]`) || pageEl;
      const canvasRect = getPageCanvasRect(el);
      const patch = { dataUrl: rotated, aspect: newAspect };
      if (canvasRect) {
        const pageAspect = canvasRect.height / canvasRect.width;
        patch.rect = fitImageRect(annotation.rect, newAspect, pageAspect);
      }
      onSave(annotation.id, patch);
    } catch { /* 회전 실패 시 무시 */ }
  };

  // ── 접힘 상태: 작은 🖼️ 배지 — 탭하면 펼침, 드래그로 이동 ──
  if (!open) {
    return (
      <div
        ref={elRef}
        data-annotation-id={annotation.id}
        className={'pdf-annotator__image-stub' + (eraseMode ? ' pdf-annotator__image-stub--erasable' : '')}
        style={{ left: pos.left, top: pos.top }}
        onPointerDown={(e) => startDrag(e, 'move')}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={() => {
          if (eraseMode) { onDelete(annotation.id); return; }
          if (movedRef.current) return; // 드래그 후 클릭으로 열리지 않게
          // 펼치기 전에 페이지 안으로 맞춤 — 예전에 저장된 범위 밖 주석도 잘리지 않는다
          const el = document.querySelector(`[data-page="${annotation.pageNumber}"]`) || pageEl;
          const canvasRect = getPageCanvasRect(el);
          if (canvasRect) {
            const pageAspect = canvasRect.height / canvasRect.width;
            const fitted = fitImageRect(annotation.rect, annotation.aspect, pageAspect);
            const r = annotation.rect;
            if (Math.abs(fitted.x - r.x) > 1e-4 || Math.abs(fitted.y - r.y) > 1e-4 || Math.abs(fitted.w - r.w) > 1e-4 || Math.abs(fitted.h - r.h) > 1e-4) {
              onSave(annotation.id, { rect: fitted });
            }
          }
          setOpen(true);
        }}
        title={eraseMode ? 'Delete image' : 'Tap to view image'}
      >
        {annotation.type === 'summary' ? '📒' : '🖼️'}
        {eraseMode && <span className="pdf-annotator__image-note-erase">🗑️</span>}
      </div>
    );
  }

  return (
    <div
      ref={elRef}
      data-annotation-id={annotation.id}
      className={'pdf-annotator__image-note' + (eraseMode ? ' pdf-annotator__image-note--erasable' : '')}
      style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height }}
      onPointerDown={(e) => startDrag(e, 'move')}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => {
        if (eraseMode) { onDelete(annotation.id); return; }
        if (movedRef.current) return;               // 드래그 후 클릭 무시
        if (e.target.closest('.pdf-annotator__image-note-handle')) return; // 리사이즈 핸들 제외
        setLightbox(true);                          // 이미지 클릭 → 전체화면 뷰어
      }}
    >
      <img src={annotation.dataUrl} alt="" draggable={false} />
      {!eraseMode && annotation.scanner && (
        <span className="pdf-annotator__image-note-scanner" title="Document scanner detector">
          {annotation.scanner === 'ml' ? 'Scanned by ML' : annotation.scanner === 'classic' ? 'Scanned by Classic' : 'Manual'}
        </span>
      )}
      {!eraseMode && annotation.type === 'summary' && (annotation.rangeStart || annotation.rangeEnd) > 0 && (
        <span className="pdf-annotator__image-note-summary" title="Summary covers these pages">
          📒 p.{annotation.rangeStart || '?'}–{annotation.rangeEnd || '?'}
        </span>
      )}
      {!eraseMode && (
        <span
          className="pdf-annotator__image-note-handle"
          title="Drag to resize"
          onPointerDown={(e) => startDrag(e, 'resize')}
        />
      )}
      {!eraseMode && (
        <button
          className="pdf-annotator__image-note-expand"
          onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
          title="View fullscreen"
          aria-label="View fullscreen"
        >⛶</button>
      )}
      {!eraseMode && (
        <button
          className="pdf-annotator__image-note-close"
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
          title="Collapse image"
          aria-label="Collapse image"
        >✕</button>
      )}
      {eraseMode && <span className="pdf-annotator__image-note-erase">🗑️</span>}
      {lightbox && (
        <ImageLightbox
          dataUrl={annotation.dataUrl}
          onClose={() => setLightbox(false)}
          onRotate={rotateImageBy}
        />
      )}
    </div>
  );
}

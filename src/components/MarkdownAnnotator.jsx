import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { getAnnotations, saveAnnotation, deleteAnnotation, getBookmarks, saveBookmark, deleteBookmark } from '../lib/storage.js';

// ── Color palettes (same as PDF annotator) ────────────────────────────
const HIGHLIGHT_COLORS = [
  { id: 'yellow',  bg: 'rgba(255, 230, 100, 0.45)', label: '🟡' },
  { id: 'green',   bg: 'rgba(130, 230, 130, 0.45)', label: '🟢' },
  { id: 'blue',    bg: 'rgba(130, 200, 255, 0.45)', label: '🔵' },
  { id: 'pink',    bg: 'rgba(255, 180, 200, 0.45)', label: '🩷' },
  { id: 'orange',  bg: 'rgba(255, 200, 130, 0.50)', label: '🟠' },
];

const UNDERLINE_COLORS = [
  { id: 'pencil',  color: '#3d3528', label: '✏️' },
  { id: 'red',     color: '#e74c3c', label: '🔴' },
  { id: 'blue',    color: '#3498db', label: '🔵' },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inject annotation highlights into HTML string without touching tags */
export function injectAnnotations(html, annotations) {
  if (!annotations?.length) return html;
  const segments = html.split(/(<[^>]+>)/g);
  for (const anno of annotations) {
    if (!anno.text || anno.text.length < 2) continue;
    const isHL = anno.type === 'highlight';
    const style = isHL
      ? `background-color:${anno.color};border-radius:2px;`
      : `border-bottom:2px solid ${anno.color || '#e74c3c'};`;
    const rep = `<mark class="md-anno md-anno--${anno.type}" style="${style}" data-anno-id="${anno.id}">${anno.text}</mark>`;
    const re = new RegExp(escapeRegex(anno.text), 'g');
    for (let i = 0; i < segments.length; i += 2) {
      if (segments[i].includes(anno.text)) {
        segments[i] = segments[i].replace(re, rep);
        break;
      }
    }
  }
  return segments.join('');
}

/**
 * Markdown content annotator — adds highlight, underline, and bookmark support
 * to rendered HTML content, persisted via IndexedDB.
 */
export default function MarkdownAnnotator({ html, filePath, previewRef, onLinkClick }) {
  const [tool, setTool] = useState(null); // null=read, 'highlight', 'underline', 'erase'
  const [annotations, setAnnotations] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [selTrigger, setSelTrigger] = useState(null);
  const savedSelectionRef = useRef(null);
  const lastDetectedText = useRef('');
  const contentRef = useRef(null);

  // ── Load annotations & bookmarks ──────────────────────
  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(xs => setAnnotations(xs.filter(a => a.type !== 'comment' && a.type !== 'pen'))).catch(() => {});
    getBookmarks(filePath).then(setBookmarks).catch(() => {});
  }, [filePath]);

  // ── Bookmark toggle ───────────────────────────────────
  const scrollPos = useRef(0);
  const isBookmarked = bookmarks.some(b => b.title === filePath);
  const toggleBookmark = useCallback(async () => {
    if (!filePath) return;
    if (isBookmarked) {
      const bm = bookmarks.find(b => b.title === filePath);
      if (bm) { await deleteBookmark(bm.id); setBookmarks(prev => prev.filter(b => b.id !== bm.id)); }
    } else {
      const saved = await saveBookmark({ filePath, pageNumber: 0, title: filePath, scrollPos: scrollPos.current });
      setBookmarks(prev => [...prev, saved]);
    }
  }, [filePath, isBookmarked, bookmarks]);

  // Track scroll position
  useEffect(() => {
    const el = previewRef?.current;
    if (!el) return;
    const onScroll = () => { scrollPos.current = el.scrollTop; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [previewRef]);

  // ── Selection polling (highlight/underline mode) ──────
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline') {
      setSelTrigger(null);
      savedSelectionRef.current = null;
      lastDetectedText.current = '';
      return;
    }
    const id = setInterval(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        if (lastDetectedText.current) {
          setSelTrigger(null);
          savedSelectionRef.current = null;
          lastDetectedText.current = '';
        }
        return;
      }
      const text = sel.toString().trim();
      if (text === lastDetectedText.current) return;
      const range = sel.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (rects.length === 0) return;

      lastDetectedText.current = text;
      savedSelectionRef.current = { text };

      const lastRect = rects[rects.length - 1];
      const vw = window.innerWidth, vh = window.innerHeight;
      const gap = 8;
      let tx = lastRect.right + gap, ty = lastRect.bottom + gap;
      if (tx + 280 > vw - gap) tx = lastRect.left - 280 - gap;
      tx = Math.max(gap, Math.min(tx, vw - 280 - gap));
      if (ty + 40 > vh - gap) ty = lastRect.top - 40 - gap;
      ty = Math.max(gap, Math.min(ty, vh - 40 - gap));
      setSelTrigger({ x: tx, y: ty });
    }, 250);
    return () => clearInterval(id);
  }, [tool]);

  // ── Confirm annotation ────────────────────────────────
  const confirmSelection = useCallback(() => {
    const data = savedSelectionRef.current;
    if (!data?.text) return;
    const isHL = tool === 'highlight';
    const anno = {
      filePath, type: tool,
      color: isHL ? highlightColor.bg : underlineColor.color,
      style: isHL ? undefined : 'solid',
      text: data.text,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      pageNumber: 0,
    };
    saveAnnotation(anno).then(saved => {
      setAnnotations(prev => [...prev, saved]);
    });
    setSelTrigger(null);
    savedSelectionRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, [tool, filePath, highlightColor, underlineColor]);

  // ── Delete annotation ─────────────────────────────────
  const removeAnnotation = useCallback((id) => {
    deleteAnnotation(id).then(() => setAnnotations(prev => prev.filter(a => a.id !== id)));
  }, []);

  // ── Inject annotations into HTML ──────────────────────
  const annotatedHtml = injectAnnotations(html, annotations);

  // ── Handle click on annotated marks (erase mode) + link clicks ──
  const handleContentClick = useCallback((e) => {
    if (tool === 'erase') {
      const mark = e.target.closest('.md-anno');
      if (mark) {
        const id = mark.dataset.annoId;
        if (id) { removeAnnotation(id); return; }
      }
    }
    // Delegate link clicks to parent for internal navigation
    const a = e.target.closest('a');
    if (a && onLinkClick) {
      const href = a.getAttribute('href');
      if (href && !/^(https?:|data:|blob:|\/\/|#)/.test(href)) {
        e.preventDefault();
        onLinkClick(href);
      }
    }
  }, [tool, removeAnnotation, onLinkClick]);

  return (
    <div className="md-annotator">
      {/* Toolbar */}
      <div className="md-annotator__toolbar">
        <button className={'md-annotator__btn' + (tool === null ? ' md-annotator__btn--active' : '')} onClick={() => setTool(null)}>📖 Read</button>
        <button className={'md-annotator__btn' + (tool === 'highlight' ? ' md-annotator__btn--active' : '')} onClick={() => setTool('highlight')}>🖍️ Highlight</button>
        <button className={'md-annotator__btn' + (tool === 'underline' ? ' md-annotator__btn--active' : '')} onClick={() => setTool('underline')}>⎁ Underline</button>
        <button className={'md-annotator__btn' + (tool === 'erase' ? ' md-annotator__btn--active' : '')} onClick={() => setTool(tool === 'erase' ? null : 'erase')}>🧹 Eraser</button>
        <button className={'md-annotator__btn' + (bookmarksOpen ? ' md-annotator__btn--active' : '')} onClick={() => setBookmarksOpen(!bookmarksOpen)}>🔖 Bookmarks</button>
      </div>

      {/* Bookmarks sidebar */}
      <div className={'md-annotator__bm-sidebar' + (bookmarksOpen ? ' md-annotator__bm-sidebar--open' : '')}>
        <div className="md-annotator__bm-header">
          <span>🔖 Bookmarks</span>
          <button className="md-annotator__bm-close" onClick={() => setBookmarksOpen(false)}>×</button>
        </div>
        <div className="md-annotator__bm-list">
          {bookmarks.length === 0 ? (
            <div className="md-annotator__bm-empty">No bookmarks</div>
          ) : (
            [...bookmarks].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')).map(bm => (
              <div key={bm.id} className="md-annotator__bm-item">
                <button className="md-annotator__bm-goto" onClick={() => {
                  const el = previewRef?.current;
                  if (el) el.scrollTop = bm.scrollPos || 0;
                  setBookmarksOpen(false);
                }}>
                  📄 {bm.title?.split('/').pop() || 'Untitled'}
                  <span className="md-annotator__bm-pos">{Math.round((bm.scrollPos || 0) / 1000)}k</span>
                </button>
                <button className="md-annotator__bm-del" onClick={() => { deleteBookmark(bm.id); setBookmarks(prev => prev.filter(b => b.id !== bm.id)); }}>×</button>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="md-annotator__bm-overlay" onClick={() => setBookmarksOpen(false)} />

      {/* Content */}
      <div
        ref={contentRef}
        className={'md-annotator__content markdown-body' + (tool === 'highlight' || tool === 'underline' ? ' md-annotator__content--selectable' : '')}
        dangerouslySetInnerHTML={{ __html: annotatedHtml }}
        onClick={handleContentClick}
      />

      {/* Selection trigger — floating confirm toolbar */}
      {selTrigger && (tool === 'highlight' || tool === 'underline') && (
        <div className="md-annotator__sel-trigger" style={{ position: 'fixed', left: selTrigger.x, top: selTrigger.y, zIndex: 200 }}>
          <div className="md-annotator__sel-inner">
            {tool === 'highlight' && HIGHLIGHT_COLORS.map(c => (
              <button key={c.id} className={'md-annotator__sel-swatch' + (highlightColor.id === c.id ? ' md-annotator__sel-swatch--active' : '')} style={{ backgroundColor: c.bg }} onMouseDown={e => e.preventDefault()} onClick={() => setHighlightColor(c)} title={c.label} />
            ))}
            {tool === 'underline' && UNDERLINE_COLORS.map(c => (
              <button key={c.id} className={'md-annotator__sel-swatch' + (underlineColor.id === c.id ? ' md-annotator__sel-swatch--active' : '')} style={{ borderBottom: `3px solid ${c.color}` }} onMouseDown={e => e.preventDefault()} onClick={() => setUnderlineColor(c)} title={c.label} />
            ))}
            <button className="md-annotator__sel-confirm" onMouseDown={e => e.preventDefault()} onClick={confirmSelection}>
              {tool === 'highlight' ? '🖍️' : '⎁'} Apply
            </button>
            <button className="md-annotator__sel-cancel" onMouseDown={e => e.preventDefault()} onClick={() => { setSelTrigger(null); savedSelectionRef.current = null; window.getSelection()?.removeAllRanges(); }}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

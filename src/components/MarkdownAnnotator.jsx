import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo, memo } from 'react';
import { getAnnotations, saveAnnotation, deleteAnnotation } from '../lib/storage.js';

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

export default function MarkdownAnnotator({ html, filePath, onLinkClick }) {
  const [tool, setTool] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [selTrigger, setSelTrigger] = useState(null);
  const savedSelectionRef = useRef(null);
  const contentRef = useRef(null);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(xs => setAnnotations(xs.filter(a => a.type !== 'comment' && a.type !== 'pen'))).catch(() => {});
  }, [filePath]);

  // ── Simple selection: check on mouseup/touchend ──────────
  const handleSelectionCheck = useCallback(() => {
    if (tool !== 'highlight' && tool !== 'underline') return;
    // Small delay so the browser finishes updating the selection
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setSelTrigger(null);
        savedSelectionRef.current = null;
        return;
      }
      const range = sel.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      if (rects.length === 0) return;
      const container = contentRef.current;
      if (!container) return;
      const cr = container.getBoundingClientRect();
      savedSelectionRef.current = {
        text: sel.toString().trim(),
        rects: rects.map(r => ({
          x: (r.left - cr.left) / cr.width,
          y: (r.top - cr.top) / cr.height,
          w: r.width / cr.width,
          h: r.height / cr.height,
        })),
      };
      const lr = rects[rects.length - 1];
      const vw = window.innerWidth, vh = window.innerHeight, gap = 8;
      let tx = lr.right + gap, ty = lr.bottom + gap;
      if (tx + 280 > vw - gap) tx = lr.left - 280 - gap;
      tx = Math.max(gap, Math.min(tx, vw - 280 - gap));
      if (ty + 40 > vh - gap) ty = lr.top - 40 - gap;
      ty = Math.max(gap, Math.min(ty, vh - 40 - gap));
      setSelTrigger({ x: tx, y: ty });
    }, 0);
  }, [tool]);

  // Reset trigger when leaving annotation mode
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline') {
      setSelTrigger(null);
      savedSelectionRef.current = null;
    }
  }, [tool]);

  const confirmSelection = useCallback(() => {
    const data = savedSelectionRef.current;
    if (!data || !data.rects || !data.rects.length) return;
    const isHL = tool === 'highlight';
    const sorted = [...data.rects].sort((a, b) => a.y - b.y);
    const lh = sorted[0].h || 0.005;
    const tol = lh * 0.5;
    const lines = [];
    let cl = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - cl[0].y) < tol) { cl.push(sorted[i]); }
      else { lines.push(cl); cl = [sorted[i]]; }
    }
    lines.push(cl);
    for (const lr of lines) {
      let mx = Infinity, Mx = -Infinity, t = Infinity, b = -Infinity;
      for (const r of lr) {
        mx = Math.min(mx, r.x); Mx = Math.max(Mx, r.x + r.w);
        t = Math.min(t, r.y); b = Math.max(b, r.y + r.h);
      }
      saveAnnotation({
        filePath, type: tool,
        color: isHL ? highlightColor.bg : underlineColor.color,
        style: isHL ? undefined : 'solid',
        text: data.text,
        rect: { x: mx, y: t, w: Mx - mx, h: b - t },
        pageNumber: 0,
      }).then(saved => setAnnotations(prev => [...prev, saved]));
    }
    setSelTrigger(null);
    savedSelectionRef.current = null;
    window.getSelection()?.removeAllRanges();
  }, [tool, filePath, highlightColor, underlineColor]);

  const removeAnnotation = useCallback((id) => {
    deleteAnnotation(id).then(() => setAnnotations(prev => prev.filter(a => a.id !== id)));
  }, []);

  // Recalculate overlays on resize only (debounced). Scroll is automatic via position:absolute.
  useEffect(() => {
    let timer;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(() => setRenderTick(t => t + 1), 150); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); clearTimeout(timer); };
  }, []);

  const fileAnnotations = useMemo(
    () => annotations.filter(a => a.filePath === filePath),
    [annotations, filePath]
  );

  const handleContentClick = useCallback((e) => {
    if (tool === 'erase') {
      const el = e.target.closest('.md-anno-overlay');
      if (el) { removeAnnotation(el.dataset.annoId); return; }
    }
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
      <div className="md-annotator__toolbar" style={{ display: chromeVisible ? 'flex' : 'none' }}>
        <button className={'md-annotator__btn' + (tool === null ? ' md-annotator__btn--active' : '')} onClick={() => setTool(null)}>📖 Read</button>
        <button className={'md-annotator__btn' + (tool === 'highlight' ? ' md-annotator__btn--active' : '')} onClick={() => setTool('highlight')}>🖍️ Highlight</button>
        <button className={'md-annotator__btn' + (tool === 'underline' ? ' md-annotator__btn--active' : '')} onClick={() => setTool('underline')}>⎁ Underline</button>
        <button className={'md-annotator__btn' + (tool === 'erase' ? ' md-annotator__btn--active' : '')} onClick={() => setTool(tool === 'erase' ? null : 'erase')}>🧹 Eraser</button>
        <button className="md-annotator__chrome-toggle" onClick={() => setChromeVisible(false)} title="Hide toolbar">{'\u25b4'}</button>
      </div>
      {!chromeVisible && (
        <button className="md-annotator__chrome-restore" onClick={() => setChromeVisible(true)} title="Show toolbar">{'\u25be'}</button>
      )}

      <div
        ref={contentRef}
        className={'md-annotator__content markdown-body' + (tool === 'highlight' || tool === 'underline' ? ' md-annotator__content--selectable' : '')}
        onClick={handleContentClick}
        onMouseUp={handleSelectionCheck}
        onTouchEnd={handleSelectionCheck}
      >
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {fileAnnotations.map(a => (
          <MdAnnotationOverlay key={a.id} annotation={a} containerEl={contentRef.current} eraseMode={tool === 'erase'} onDelete={removeAnnotation} />
        ))}
      </div>

      {selTrigger && (tool === 'highlight' || tool === 'underline') && (
        <div className="md-annotator__sel-trigger" style={{ position: 'fixed', left: selTrigger.x, top: selTrigger.y, zIndex: 200 }}>
          <div className="md-annotator__sel-inner">
            {tool === 'highlight' && HIGHLIGHT_COLORS.map(c => (
              <button key={c.id} className={'md-annotator__sel-swatch' + (highlightColor.id === c.id ? ' md-annotator__sel-swatch--active' : '')} style={{ backgroundColor: c.bg }} onMouseDown={e => e.preventDefault()} onClick={() => setHighlightColor(c)} title={c.label} />
            ))}
            {tool === 'underline' && UNDERLINE_COLORS.map(c => (
              <button key={c.id} className={'md-annotator__sel-swatch' + (underlineColor.id === c.id ? ' md-annotator__sel-swatch--active' : '')} style={{ borderBottom: '3px solid ' + c.color }} onMouseDown={e => e.preventDefault()} onClick={() => setUnderlineColor(c)} title={c.label} />
            ))}
            <button className="md-annotator__sel-confirm" onMouseDown={e => e.preventDefault()} onClick={confirmSelection}>
              {tool === 'highlight' ? '🖍️ Apply' : '⎁ Apply'}
            </button>
            <button className="md-annotator__sel-cancel" onMouseDown={e => e.preventDefault()} onClick={() => { setSelTrigger(null); savedSelectionRef.current = null; window.getSelection()?.removeAllRanges(); }}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

const MdAnnotationOverlay = memo(function MdAnnotationOverlay({ annotation, containerEl, eraseMode, onDelete }) {
  const [rect, setRect] = useState(null);
  const prevRef = useRef(null);

  useLayoutEffect(() => {
    const el = containerEl;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const next = {
      left: annotation.rect.x * width,
      top: annotation.rect.y * height,
      width: annotation.rect.w * width,
      height: annotation.rect.h * height,
    };
    const prev = prevRef.current;
    if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height) return;
    prevRef.current = next;
    setRect(next);
  });

  if (!rect) return null;

  const isHL = annotation.type === 'highlight';
  return (
    <div
      className={'md-anno-overlay md-anno-overlay--' + annotation.type + (eraseMode ? ' md-anno-overlay--erasable' : '')}
      data-anno-id={annotation.id}
      style={{
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        backgroundColor: isHL ? annotation.color : 'transparent',
        borderBottom: isHL ? 'none' : '2px solid ' + (annotation.color || '#e74c3c'),
        pointerEvents: eraseMode ? 'auto' : 'none',
        zIndex: 5,
        borderRadius: isHL ? '2px' : undefined,
      }}
      title={annotation.text}
      onClick={eraseMode ? (e) => { e.stopPropagation(); onDelete(annotation.id); } : undefined}
    />
  );
});

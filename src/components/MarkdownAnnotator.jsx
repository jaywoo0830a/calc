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

export default function MarkdownAnnotator({ html, filePath, previewRef, layoutKey, onLinkClick }) {
  const [tool, setTool] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [underlineColor, setUnderlineColor] = useState(UNDERLINE_COLORS[0]);
  const [selTrigger, setSelTrigger] = useState(null);
  const savedSelectionRef = useRef(null);
  const contentRef = useRef(null);
  const [renderTick, setRenderTick] = useState(0);
  // ── Two-tap selection state ────────────────────────────
  const firstTapRef = useRef(null); // { x, y, range } | null
  const [firstTapActive, setFirstTapActive] = useState(false);

  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(xs => setAnnotations(xs.filter(a => a.type !== 'comment' && a.type !== 'pen'))).catch(() => {});
  }, [filePath]);

  // ── Two-tap selection (avoids Android AI overlay conflicts) ──
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline') {
      setSelTrigger(null);
      savedSelectionRef.current = null;
      firstTapRef.current = null;
      setFirstTapActive(false);
    }
  }, [tool]);

  const handleTwoTap = useCallback((e) => {
    if (tool !== 'highlight' && tool !== 'underline') return;
    // Ignore taps on links, buttons, etc.
    if (e.target.closest('a, button, .md-anno-overlay')) return;

    const x = e.clientX || (e.touches && e.touches[0]?.clientX);
    const y = e.clientY || (e.touches && e.touches[0]?.clientY);
    if (x == null || y == null) return;

    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(x, y)
      : (() => { const cp = document.caretPositionFromPoint(x, y); return cp ? document.createRange().setStart(cp.offsetNode, cp.offset) : null; })();

    const first = firstTapRef.current;

    if (!first) {
      // First tap — store position
      if (!range) return;
      firstTapRef.current = { x, y, range };
      setFirstTapActive(true);
      return;
    }

    // Second tap
    setFirstTapActive(false);
    firstTapRef.current = null;

    if (!range) return;
    const container = contentRef.current;
    if (!container) return;

    // Create a range from first tap to second tap (order doesn't matter)
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const newRange = document.createRange();
      // Compare positions: set start to the earlier point
      const cmp = first.range.compareBoundaryPoints(Range.START_TO_START, range);
      if (cmp <= 0) {
        newRange.setStart(first.range.startContainer, first.range.startOffset);
        newRange.setEnd(range.startContainer, range.startOffset);
      } else {
        newRange.setStart(range.startContainer, range.startOffset);
        newRange.setEnd(first.range.startContainer, first.range.startOffset);
      }
      sel.addRange(newRange);

      // Store text anchor: prefix + text + suffix for robust re-location
      const fullText = container.textContent || '';
      const selText = sel.toString().trim();
      const idx = fullText.indexOf(selText);
      const prefix = idx > 0 ? fullText.slice(Math.max(0, idx - 50), idx) : '';
      const suffix = idx >= 0 ? fullText.slice(idx + selText.length, idx + selText.length + 50) : '';

      // Also keep geometric fallback
      const rects = Array.from(newRange.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      const cr = container.getBoundingClientRect();
      savedSelectionRef.current = {
        text: selText,
        prefix,
        suffix,
        rects: rects.length > 0 ? rects.map(r => ({
          x: (r.left - cr.left) / cr.width,
          y: (r.top - cr.top + (previewRef?.current?.scrollTop || 0)) / (previewRef?.current?.scrollHeight || cr.height),
          w: r.width / cr.width,
          h: r.height / (previewRef?.current?.scrollHeight || cr.height),
        })) : [],
      };

      if (rects.length === 0) return;
      const lr = rects[rects.length - 1];
      const vw = window.innerWidth, vh = window.innerHeight, gap = 8;
      let tx = lr.right + gap, ty = lr.bottom + gap;
      if (tx + 280 > vw - gap) tx = lr.left - 280 - gap;
      tx = Math.max(gap, Math.min(tx, vw - 280 - gap));
      if (ty + 40 > vh - gap) ty = lr.top - 40 - gap;
      ty = Math.max(gap, Math.min(ty, vh - 40 - gap));
      setSelTrigger({ x: tx, y: ty });
    } catch {
      firstTapRef.current = null;
    }
  }, [tool]);

  const confirmSelection = useCallback(() => {
    const data = savedSelectionRef.current;
    if (!data || !data.rects || !data.rects.length) return;
    const isHL = tool === 'highlight';
    const sorted = [...data.rects].sort((a, b) => a.y - b.y);
    // Group by vertical overlap (handles KaTeX with different heights on same line)
    const lines = [];
    for (const r of sorted) {
      let merged = false;
      for (const line of lines) {
        // Check if this rect vertically overlaps with the line's bounding box
        const lineTop = line[0]._minY, lineBottom = line[0]._maxY;
        const rTop = r.y, rBottom = r.y + r.h;
        if (rTop < lineBottom && rBottom > lineTop) {
          line.push(r);
          line[0]._minY = Math.min(line[0]._minY, rTop);
          line[0]._maxY = Math.max(line[0]._maxY, rBottom);
          merged = true;
          break;
        }
      }
      if (!merged) {
        r._minY = r.y;
        r._maxY = r.y + r.h;
        lines.push([r]);
      }
    }
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
        prefix: data.prefix || '',
        suffix: data.suffix || '',
        rect: { x: mx, y: t, w: Mx - mx, h: b - t },
        pageNumber: 0,
      }).then(saved => setAnnotations(prev => [...prev, saved]));
    }
    setSelTrigger(null);
    savedSelectionRef.current = null;
    firstTapRef.current = null;
    setFirstTapActive(false);
    window.getSelection()?.removeAllRanges();
  }, [tool, filePath, highlightColor, underlineColor]);

  const removeAnnotation = useCallback((id) => {
    deleteAnnotation(id).then(() => setAnnotations(prev => prev.filter(a => a.id !== id)));
  }, []);

  // Recalculate overlays on resize, fullscreen, or readability change
  useEffect(() => {
    setRenderTick(t => t + 1);
  }, [layoutKey]);

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
        className={'md-annotator__content markdown-body' + (tool === 'highlight' || tool === 'underline' ? ' md-annotator__content--selectable' : '') + (firstTapActive ? ' md-annotator__content--first-tap' : '')}
        onClick={(e) => { handleTwoTap(e); handleContentClick(e); }}
        onTouchEnd={handleTwoTap}
      >
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {fileAnnotations.map(a => (
          <MdAnnotationOverlay key={a.id} annotation={a} containerEl={contentRef.current} previewEl={previewRef?.current} eraseMode={tool === 'erase'} onDelete={removeAnnotation} />
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
            <button className="md-annotator__sel-cancel" onMouseDown={e => e.preventDefault()} onClick={() => { setSelTrigger(null); savedSelectionRef.current = null; firstTapRef.current = null; setFirstTapActive(false); window.getSelection()?.removeAllRanges(); }}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

const MdAnnotationOverlay = memo(function MdAnnotationOverlay({ annotation, containerEl, previewEl, eraseMode, onDelete }) {
  const [rect, setRect] = useState(null);
  const prevRef = useRef(null);

  useLayoutEffect(() => {
    const el = containerEl;
    if (!el) return;
    const cw = el.getBoundingClientRect().width;
    if (cw === 0) return;

    // Try text anchoring first (prefix+text+suffix → find in DOM)
    let found = false;
    if (annotation.prefix !== undefined && annotation.text) {
      const fullText = el.textContent || '';
      const anchor = (annotation.prefix || '') + annotation.text + (annotation.suffix || '');
      const idx = fullText.indexOf(anchor);
      if (idx >= 0) {
        const startOffset = idx + (annotation.prefix || '').length;
        const endOffset = startOffset + annotation.text.length;
        const range = textOffsetToRange(el, startOffset, endOffset);
        if (range) {
          const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
          if (rects.length > 0) {
            const cr = el.getBoundingClientRect();
            let mx = Infinity, Mx = -Infinity, t = Infinity, b = -Infinity;
            for (const r of rects) {
              mx = Math.min(mx, r.left - cr.left);
              Mx = Math.max(Mx, r.right - cr.left);
              t = Math.min(t, r.top - cr.top);
              b = Math.max(b, r.bottom - cr.top);
            }
            const next = { left: mx, top: t, width: Mx - mx, height: b - t };
            const prev = prevRef.current;
            if (!prev || prev.left !== next.left || prev.top !== next.top || prev.width !== next.width || prev.height !== next.height) {
              prevRef.current = next;
              setRect(next);
            }
            found = true;
          }
        }
      }
    }

    // Fallback: geometric coordinates
    if (!found) {
      const scrollH = previewEl?.scrollHeight || el.getBoundingClientRect().height || 1;
      const next = {
        left: annotation.rect.x * cw,
        top: annotation.rect.y * scrollH,
        width: annotation.rect.w * cw,
        height: annotation.rect.h * scrollH,
      };
      const prev = prevRef.current;
      if (!prev || prev.left !== next.left || prev.top !== next.top || prev.width !== next.width || prev.height !== next.height) {
        prevRef.current = next;
        setRect(next);
      }
    }
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

/** Walk DOM text nodes to find a Range at the given character offsets */
function textOffsetToRange(rootEl, startOffset, endOffset) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  let current = 0;
  let startNode, startNodeOff, endNode, endNodeOff;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.textContent.length;
    if (!startNode && current + len >= startOffset) {
      startNode = node;
      startNodeOff = startOffset - current;
    }
    if (!endNode && current + len >= endOffset) {
      endNode = node;
      endNodeOff = endOffset - current;
      break;
    }
    current += len;
  }
  if (startNode && endNode) {
    const range = document.createRange();
    range.setStart(startNode, Math.min(startNodeOff, startNode.textContent.length));
    range.setEnd(endNode, Math.min(endNodeOff, endNode.textContent.length));
    return range;
  }
  return null;
}

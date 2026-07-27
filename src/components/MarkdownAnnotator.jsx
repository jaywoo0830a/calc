import { useState, useEffect, useCallback, useRef } from 'react';
import { getAnnotations, saveAnnotation, deleteAnnotation } from '../lib/storage.js';

const HL = [
  { id: 'yellow', bg: 'rgba(255, 230, 100, 0.45)' },
  { id: 'green',  bg: 'rgba(130, 230, 130, 0.45)' },
  { id: 'blue',   bg: 'rgba(130, 200, 255, 0.45)' },
  { id: 'pink',   bg: 'rgba(255, 180, 200, 0.45)' },
  { id: 'orange', bg: 'rgba(255, 200, 130, 0.50)' },
];
const UL = [
  { id: 'pencil', color: '#3d3528' },
  { id: 'red',    color: '#e74c3c' },
  { id: 'blue',   color: '#3498db' },
];

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function injectAnnotations(html, annos) {
  if (!annos || !annos.length) return html;
  const segs = html.split(/(<[^>]+>)/g);
  for (const a of annos) {
    if (!a.text || a.text.length < 2) continue;
    const hl = a.type === 'highlight';
    const st = hl
      ? 'background-color:' + a.color + ';border-radius:2px'
      : 'border-bottom:2px solid ' + (a.color || '#e74c3c');
    const tag = '<span class="md-anno md-anno--' + a.type + '" style="' + st + '" data-id="' + a.id + '">' + a.text + '</span>';
    for (let i = 0; i < segs.length; i += 2) {
      if (segs[i].includes(a.text)) { segs[i] = segs[i].replace(new RegExp(esc(a.text), 'g'), tag); break; }
    }
  }
  return segs.join('');
}

export default function MarkdownAnnotator({ html, filePath, onLinkClick }) {
  const [tool, setTool] = useState(null);
  const [annos, setAnnos] = useState([]);
  const [chrome, setChrome] = useState(true);
  const [hlColor, setHlColor] = useState(HL[0]);
  const [ulColor, setUlColor] = useState(UL[0]);
  const [selTrig, setSelTrig] = useState(null);
  const savedSel = useRef(null);
  const firstTap = useRef(null); // { range } | null for two-tap selection
  const [firstTapOn, setFirstTapOn] = useState(false);

  useEffect(() => {
    if (!filePath) return;
    getAnnotations(filePath).then(xs => setAnnos(xs.filter(a => a.type !== 'comment' && a.type !== 'pen'))).catch(() => {});
  }, [filePath]);

  // Reset when leaving annotation mode
  useEffect(() => {
    if (tool !== 'highlight' && tool !== 'underline') {
      setSelTrig(null); savedSel.current = null; firstTap.current = null; setFirstTapOn(false);
    }
  }, [tool]);

  // Two-tap selection: tap start, tap end → select range → show toolbar
  const handleTwoTap = useCallback((e) => {
    if (tool !== 'highlight' && tool !== 'underline') return;
    if (e.target.closest('a, button, .md-anno')) return;

    const x = e.clientX || (e.touches && e.touches[0]?.clientX);
    const y = e.clientY || (e.touches && e.touches[0]?.clientY);
    if (x == null || y == null) return;

    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(x, y)
      : null;
    if (!range) return;

    const first = firstTap.current;

    if (!first) {
      firstTap.current = { range };
      setFirstTapOn(true);
      return;
    }

    // Second tap
    firstTap.current = null;
    setFirstTapOn(false);
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const nr = document.createRange();
      const cmp = first.range.compareBoundaryPoints(Range.START_TO_START, range);
      if (cmp <= 0) {
        nr.setStart(first.range.startContainer, first.range.startOffset);
        nr.setEnd(range.startContainer, range.startOffset);
      } else {
        nr.setStart(range.startContainer, range.startOffset);
        nr.setEnd(first.range.startContainer, first.range.startOffset);
      }
      sel.addRange(nr);

      const text = sel.toString().trim();
      if (!text) return;

      const rects = Array.from(nr.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      savedSel.current = { text };
      if (rects.length > 0) {
        const lr = rects[rects.length - 1];
        const vw = window.innerWidth, vh = window.innerHeight, gap = 8;
        let tx = lr.right + gap, ty = lr.bottom + gap;
        if (tx + 280 > vw - gap) tx = lr.left - 280 - gap;
        if (ty + 40 > vh - gap) ty = lr.top - 40 - gap;
        setSelTrig({ x: Math.max(gap, Math.min(tx, vw - 288)), y: Math.max(gap, Math.min(ty, vh - 48)) });
      } else {
        setSelTrig({ x: x + 10, y: y + 10 });
      }
    } catch { firstTap.current = null; }
  }, [tool]);

  const apply = useCallback(() => {
    if (!savedSel.current || !savedSel.current.text) return;
    saveAnnotation({
      filePath, type: tool,
      color: tool === 'highlight' ? hlColor.bg : ulColor.color,
      text: savedSel.current.text,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      pageNumber: 0,
    }).then(a => setAnnos(prev => [...prev, a]));
    setSelTrig(null); savedSel.current = null; firstTap.current = null; setFirstTapOn(false);
    window.getSelection()?.removeAllRanges();
  }, [tool, filePath, hlColor, ulColor]);

  const remove = useCallback((id) => {
    deleteAnnotation(id).then(() => setAnnos(prev => prev.filter(a => a.id !== id)));
  }, []);

  const fileAnnos = annos.filter(a => a.filePath === filePath);
  const annoHtml = injectAnnotations(html, fileAnnos);

  return (
    <div className="md-annotator">
      <div className="md-annotator__toolbar" style={{ display: chrome ? 'flex' : 'none' }}>
        <button className={'md-annotator__btn' + (tool === null ? ' md-annotator__btn--active' : '')} onClick={() => setTool(null)}>Read</button>
        <button className={'md-annotator__btn' + (tool === 'highlight' ? ' md-annotator__btn--active' : '')} onClick={() => setTool('highlight')}>Highlight</button>
        <button className={'md-annotator__btn' + (tool === 'underline' ? ' md-annotator__btn--active' : '')} onClick={() => setTool('underline')}>Underline</button>
        <button className={'md-annotator__btn' + (tool === 'erase' ? ' md-annotator__btn--active' : '')} onClick={() => setTool(tool === 'erase' ? null : 'erase')}>Eraser</button>
        <button className="md-annotator__chrome-toggle" onClick={() => setChrome(false)} title="Hide">-</button>
      </div>
      {!chrome && <button className="md-annotator__chrome-restore" onClick={() => setChrome(true)} title="Show">+</button>}

      <div
        className={'md-annotator__content markdown-body' + (tool === 'highlight' || tool === 'underline' ? ' md-annotator__content--selectable' : '') + (firstTapOn ? ' md-annotator__content--first-tap' : '')}
        onClick={(e) => { handleTwoTap(e);
          if (tool === 'erase') {
            const el = e.target.closest('.md-anno');
            if (el) { remove(el.dataset.id); return; }
          }
          const a = e.target.closest('a');
          if (a && onLinkClick) {
            const href = a.getAttribute('href');
            if (href && !/^(https?:|data:|blob:|\/\/|#)/.test(href)) {
              e.preventDefault(); onLinkClick(href);
            }
          }
        }}
        dangerouslySetInnerHTML={{ __html: annoHtml }}
      />

      {selTrig && (
        <div className="md-annotator__sel-trigger" style={{ position: 'fixed', left: selTrig.x, top: selTrig.y, zIndex: 200 }}>
          <div className="md-annotator__sel-inner">
            {tool === 'highlight' && HL.map(c => (
              <button key={c.id} className={'md-annotator__sel-swatch' + (hlColor.id === c.id ? ' md-annotator__sel-swatch--active' : '')} style={{ backgroundColor: c.bg }} onMouseDown={e => e.preventDefault()} onClick={() => setHlColor(c)} />
            ))}
            {tool === 'underline' && UL.map(c => (
              <button key={c.id} className={'md-annotator__sel-swatch' + (ulColor.id === c.id ? ' md-annotator__sel-swatch--active' : '')} style={{ borderBottom: '3px solid ' + c.color }} onMouseDown={e => e.preventDefault()} onClick={() => setUlColor(c)} />
            ))}
            <button className="md-annotator__sel-confirm" onMouseDown={e => e.preventDefault()} onClick={apply}>Apply</button>
            <button className="md-annotator__sel-cancel" onMouseDown={e => e.preventDefault()} onClick={() => { setSelTrig(null); savedSel.current = null; firstTap.current = null; setFirstTapOn(false); window.getSelection()?.removeAllRanges(); }}>x</button>
          </div>
        </div>
      )}
    </div>
  );
}
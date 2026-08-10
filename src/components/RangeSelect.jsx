import { useState, useCallback, useEffect, useRef } from 'react';
import { isCandidate } from './WordLookup.jsx';

// ═══════════════════════════════════════════════════════════════
// RangeSelect — "모드 + 두 번 탭" 방식의 범위 선택 도구
// ─────────────────────────────────────────────────────────────
// ✂️ 도크를 펼쳐 모드를 고른 뒤 (✓ Solved / ✗ Wrong / 📖 Lookup),
// 시작점과 끝점을 차례로 탭하면 그 사이 텍스트에 대해 동작한다.
//   - Solved/Wrong → window 'problems:mark' 이벤트 (Viewer/PDF가 처리)
//   - Lookup       → window 'wordlookup:open' 이벤트 (WordLookup이 처리)
// 기존 드래그 선택 툴바와 별개로 동작하는 추가 트리거 방식이다.
// ═══════════════════════════════════════════════════════════════

// 탭이 무시되어야 하는 영역 (버튼/링크/에디터/기존 툴바/이 도크 자체)
const EXCLUDE_SELECTOR = [
  'button', 'a', 'input', 'textarea', 'select',
  '[contenteditable="true"]',
  '.cm-content',                       // CodeMirror (MathSpace / Playground)
  '.word-lookup',                      // 사전 카드
  '.viewer__md-sel',                   // 마크다운 선택 툴바
  '.pdf-annotator__sel-trigger',       // PDF 선택 툴바
  '.pdf-annotator__toolbar',
  '.pdf-annotator__nav',
  '.calculator__nav',
  '.viewer__controls',
  '.range-select',                     // 이 도크 자체
].join(', ');

// 좌표 → caret Range (브라우저별 호환)
function caretAtPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

// caret이 본문 텍스트 안에 있는지 (툴바/에디터/버튼 등 제외)
function caretInBody(range) {
  const node = range.startContainer;
  const el = node && node.nodeType === 3 ? node.parentElement : node;
  if (!el || !el.closest) return false;
  return !el.closest(EXCLUDE_SELECTOR);
}

// caret이 속한 PDF 페이지 래퍼 (마크다운이면 null)
function pageOf(range) {
  const node = range.startContainer;
  const el = node && node.nodeType === 3 ? node.parentElement : node;
  return el && el.closest ? el.closest('.pdf-annotator__page-wrapper') : null;
}

export default function RangeSelect() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(null);      // 'solved' | 'wrong' | 'lookup'
  const [step, setStep] = useState(0);         // 0 idle, 1 시작점, 2 끝점
  const [notice, setNotice] = useState(null);  // 일회성 안내 문구
  const startRangeRef = useRef(null);
  const noticeTimerRef = useRef(null);

  const flashNotice = useCallback((msg) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2000);
  }, []);

  const reset = useCallback(() => {
    setMode(null);
    setStep(0);
    startRangeRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current); }, []);

  // ── 탭 처리 (armed 중에만 capture로 가로챔) ──
  useEffect(() => {
    if (step === 0 || !mode) return;
    const onTap = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(EXCLUDE_SELECTOR)) return;
      e.preventDefault();
      e.stopPropagation();

      const caret = caretAtPoint(e.clientX, e.clientY);
      if (!caret || !caretInBody(caret)) return;

      if (step === 1) {
        startRangeRef.current = caret;
        setStep(2);
        return;
      }

      // 두 번째 탭 — 범위 확정
      let start = startRangeRef.current;
      let end = caret;

      // PDF: 같은 페이지 안에서만 허용
      const sp = pageOf(start), ep = pageOf(end);
      if (sp || ep) {
        if (sp !== ep) { flashNotice('PDF: tap both points on the same page'); reset(); return; }
      }

      // 시작/끝 순서 정규화 (거꾸로 탭해도 동작)
      if (start.compareBoundaryPoints(Range.END_TO_END, end) > 0) [start, end] = [end, start];

      const range = document.createRange();
      range.setStart(start.startContainer, start.startOffset);
      range.setEnd(end.endContainer, end.endOffset);
      const text = range.toString().replace(/\s+/g, ' ').trim();
      const rect = range.getBoundingClientRect();
      const rectObj = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      const m = mode;
      reset();
      if (!text) { flashNotice('No text in that range — try again'); return; }
      if (m === 'lookup') {
        if (!isCandidate(text)) { flashNotice('Dictionary: select a single word or short phrase'); return; }
        window.dispatchEvent(new CustomEvent('wordlookup:open', { detail: { text, rect: rectObj } }));
      } else {
        window.dispatchEvent(new CustomEvent('problems:mark', { detail: { text, status: m, rect: rectObj } }));
      }
    };
    document.addEventListener('click', onTap, true);
    document.addEventListener('touchstart', onTap, true);
    return () => {
      document.removeEventListener('click', onTap, true);
      document.removeEventListener('touchstart', onTap, true);
    };
  }, [step, mode, reset, flashNotice]);

  // Esc → 취소
  useEffect(() => {
    if (!open && step === 0) return;
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); reset(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step, reset]);

  const label = mode === 'solved' ? 'Mark solved' : mode === 'wrong' ? 'Mark wrong' : 'Look up';

  return (
    <div className="range-select">
      <button
        className={'range-select__trigger' + (open ? ' range-select__trigger--open' : '')}
        onClick={() => setOpen((o) => { if (o) reset(); return !o; })}
        aria-pressed={open}
        title="Range select — pick a mode, then tap the start and end points"
      >✂️</button>

      {open && (
        <div className="range-select__bar">
          <button
            className={'range-select__mode range-select__mode--solved' + (mode === 'solved' ? ' range-select__mode--active' : '')}
            onClick={() => { setMode('solved'); setStep(1); }}
            title="Mark the tapped range as solved"
          >✓ Solved</button>
          <button
            className={'range-select__mode range-select__mode--wrong' + (mode === 'wrong' ? ' range-select__mode--active' : '')}
            onClick={() => { setMode('wrong'); setStep(1); }}
            title="Mark the tapped range as wrong"
          >✗ Wrong</button>
          <button
            className={'range-select__mode range-select__mode--lookup' + (mode === 'lookup' ? ' range-select__mode--active' : '')}
            onClick={() => { setMode('lookup'); setStep(1); }}
            title="Look up the tapped range in the dictionary"
          >📖 Lookup</button>
          <button className="range-select__cancel" onClick={cancel} title="Close">✕</button>
        </div>
      )}

      {mode && step > 0 && (
        <div className="range-select__hint">
          {step === 1 ? `① Tap the start point (${label})` : `② Tap the end point (${label})`}
        </div>
      )}
      {notice && <div className="range-select__hint range-select__hint--notice">{notice}</div>}
    </div>
  );
}

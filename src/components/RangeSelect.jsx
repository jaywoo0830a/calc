import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isCandidate } from './WordLookup.jsx';
import { setRangeSelectState } from '../lib/rangeSelectState.js';
import { IS_TOUCH_PRIMARY } from '../lib/device.js';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { markdownRefFromRange } from '../lib/markdownRef.js';

// ═══════════════════════════════════════════════════════════════
// RangeSelect — ✂️ Selecting: 범위 먼저 선택 → 그다음 액션 (전 기기 단일 흐름)
// ─────────────────────────────────────────────────────────────
// 1. ✂️ Selecting 켜기
// 2. 범위 선택 — 데스크톱: 드래그 / 터치: 시작점·끝점 탭(①→②)
// 3. 범위가 하이라이트되고 근처 액션 바가 뜬다
// 4. 액션 선택: ✓ Solved / ✗ Wrong / 📖 Lookup / ✕
//   - Solved/Wrong → window 'problems:mark' (Viewer/PDF가 처리)
//   - Lookup       → window 'wordlookup:open' (WordLookup이 처리)
// 다른 선택 기반 오버레이(드래그 툴바 등)를 모두 제거해
// Android 네이티브 AI 팝업과도 겹치지 않는 단일 흐름을 만든다.
// ═══════════════════════════════════════════════════════════════

// 탭이 무시되어야 하는 영역 (버튼/링크/에디터/기존 툴바/이 도크 자체)
const EXCLUDE_SELECTOR = [
  'button', 'a', 'input', 'textarea', 'select',
  '[contenteditable="true"]',
  '.cm-content',                       // CodeMirror (MathSpace / Playground)
  '.word-lookup',                      // 사전 카드
  '.pdf-annotator__sel-trigger',       // PDF 하이라이트/밑줄 툴바
  '.pdf-annotator__toolbar',
  '.pdf-annotator__nav',
  '.app-nav',
  '.viewer__controls',
  '.range-select',                     // ✂️ 도크 자체
  '.recent-nav',                       // 🕘 히스토리 버튼/패널
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
  const [active, setActive] = useState(false);        // Selecting 모드 ON/OFF
  const [step, setStep] = useState(0);                // 0 시작점 대기, 1 끝점 대기
  const [selection, setSelection] = useState(null);   // 확정된 범위 { text, rect }
  const [barPos, setBarPos] = useState(null);         // 액션 바 위치 { x, y }
  const [notice, setNotice] = useState(null);         // 일회성 안내 문구
  const [startPoint, setStartPoint] = useState(null); // 시작점 탭 마커 { x, y } (터치)
  const [tapFlash, setTapFlash] = useState(null);     // 탭 지점 순간 표시 { x, y, key }
  const startRangeRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const flashTimerRef = useRef(null);

  const flashNotice = useCallback((msg) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2000);
  }, []);

  // 시작점 마커 재설정 (잘못 탭 → 재탭)
  const resetStart = useCallback(() => {
    setStep(0);
    setStartPoint(null);
    startRangeRef.current = null;
  }, []);

  // 선택 재실행 (잘못 선택 → 다시 선택)
  const redoSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setBarPos(null);
    setStep(0);
    setStartPoint(null);
    startRangeRef.current = null;
  }, []);

  // Selecting 종료 (선택/액션 바 정리 + 커서 복귀)
  const exit = useCallback(() => {
    setActive(false);
    setStep(0);
    setSelection(null);
    setBarPos(null);
    setStartPoint(null);
    setTapFlash(null);
    startRangeRef.current = null;
  }, []);

  // ✂️ Selecting 토글
  const toggle = useCallback(() => {
    const next = !active;
    setActive(next);
    setStep(0);
    setSelection(null);
    setBarPos(null);
    setStartPoint(null);
    setTapFlash(null);
    startRangeRef.current = null;
  }, [active]);

  // 탭 지점 표시 자동 소멸
  useEffect(() => {
    if (!tapFlash) return;
    flashTimerRef.current = setTimeout(() => setTapFlash(null), 400);
    return () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); };
  }, [tapFlash]);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  // Selecting 상태를 CustomCursor 등에 공유 — active면 타깃 커서 표시
  useEffect(() => {
    setRangeSelectState({ active, step: active ? step : 0 });
  }, [active, step]);

  // 선택 확정 후 액션 실행 (✓/✗ → problems:mark, 📖 → wordlookup:open)
  const dispatchAction = useCallback((action) => {
    if (!selection) return;
    if (action === 'lookup') {
      if (!isCandidate(selection.text)) { flashNotice('Dictionary: select a single word or short phrase'); return; }
      window.dispatchEvent(new CustomEvent('wordlookup:open', { detail: { text: selection.text, rect: selection.rect } }));
    } else {
      // ref는 선택이 살아있던 시점에 finishWithRange에서 미리 계산해 보관.
      // ✓/✗ 버튼 클릭 순간 브라우저가 선택을 지우므로 여기서 다시 계산하면 안 됨.
      window.dispatchEvent(new CustomEvent('problems:mark', {
        detail: { text: selection.text, status: action, rect: selection.rect, ref: selection.ref },
      }));
    }
    window.getSelection()?.removeAllRanges();
    exit();
  }, [selection, exit, flashNotice]);

  // 범위 확정 공용 처리 — 하이라이트 + 액션 바 표시
  const finishWithRange = useCallback((range) => {
    const text = range.toString().replace(/\s+/g, ' ').trim();
    if (!text) { flashNotice('No text in that range — try again'); setStep(0); startRangeRef.current = null; return; }
    // 선택이 살아있는 지금 ref(마크다운 좌표 앵커)를 미리 계산해 보관
    // (버튼 클릭 시 브라우저가 선택을 지우기 때문 — 문제 점프 정확도에 필수)
    const ref = markdownRefFromRange(range);
    const rect = range.getBoundingClientRect();
    // 실제 브라우저 선택을 적용해 사용자가 범위를 눈으로 확인 (안정감)
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* ignore */ }
    setStep(0);
    setStartPoint(null);
    setTapFlash(null);
    startRangeRef.current = null;
    setSelection({
      text,
      ref,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    });
    // 액션 바 위치 (선택 영역 위, 공간 부족 시 아래, 뷰포트 안으로 보정)
    const barW = 190, barH = 44, gap = 10;
    let bx = rect.left + (rect.right - rect.left) / 2 - barW / 2;
    bx = Math.max(gap, Math.min(bx, window.innerWidth - barW - gap));
    let by = rect.top - barH - gap;
    if (by < gap) by = rect.bottom + gap;
    by = Math.max(gap, Math.min(by, window.innerHeight - barH - gap));
    setBarPos({ x: Math.round(bx), y: Math.round(by) });
  }, [flashNotice]);

  // ── 데스크톱: 드래그로 범위 선택 ──
  useEffect(() => {
    if (!active || IS_TOUCH_PRIMARY || selection) return;
    const onMouseUp = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(EXCLUDE_SELECTOR)) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      const range = sel.getRangeAt(0);
      if (!caretInBody(range)) return;
      e.preventDefault();
      e.stopPropagation();
      finishWithRange(range);
    };
    document.addEventListener('mouseup', onMouseUp, true);
    return () => document.removeEventListener('mouseup', onMouseUp, true);
  }, [active, selection, finishWithRange]);

  // ── 터치: 시작점·끝점 두 번 탭 (Android AI 팝업과 안 겹치도록 capture 차단) ──
  useEffect(() => {
    if (!active || !IS_TOUCH_PRIMARY || selection) return;
    const onTap = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(EXCLUDE_SELECTOR)) return;
      e.preventDefault();
      e.stopPropagation();

      const caret = caretAtPoint(e.clientX, e.clientY);
      if (!caret || !caretInBody(caret)) return;

      if (step === 0) {
        startRangeRef.current = caret;
        setStartPoint({ x: e.clientX, y: e.clientY });
        setTapFlash({ x: e.clientX, y: e.clientY, key: Date.now() });
        setStep(1);
        return;
      }

      // 두 번째 탭 — 범위 확정
      let start = startRangeRef.current;
      let end = caret;

      // PDF: 같은 페이지 안에서만 허용
      const sp = pageOf(start), ep = pageOf(end);
      if (sp || ep) {
        if (sp !== ep) { flashNotice('PDF: tap both points on the same page'); resetStart(); return; }
      }

      // 시작/끝 순서 정규화 (거꾸로 탭해도 동작)
      if (start.compareBoundaryPoints(Range.END_TO_END, end) > 0) [start, end] = [end, start];

      const range = document.createRange();
      range.setStart(start.startContainer, start.startOffset);
      range.setEnd(end.endContainer, end.endOffset);
      setTapFlash({ x: e.clientX, y: e.clientY, key: Date.now() });
      finishWithRange(range);
    };
    document.addEventListener('click', onTap, true);
    document.addEventListener('touchstart', onTap, true);
    return () => {
      document.removeEventListener('click', onTap, true);
      document.removeEventListener('touchstart', onTap, true);
    };
  }, [active, step, selection, flashNotice, finishWithRange, resetStart]);

  // Esc → Selecting 종료
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => { if (e.key === 'Escape') { window.getSelection()?.removeAllRanges(); exit(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, exit]);

  // Native Fullscreen(예: PDF)에서는 body 외부 요소가 안 보이므로 포털로 이동
  const portalTarget = useFullscreenPortal();
  if (!portalTarget) return null;

  return createPortal(
    <div className="range-select">
      <button
        className={'range-select__trigger' + (active ? ' range-select__trigger--open' : '')}
        onClick={toggle}
        aria-pressed={active}
        aria-label={active
          ? 'Selecting is active — select a range, then choose Solved / Wrong / Lookup'
          : 'Selecting — select a range, then choose Solved / Wrong / Lookup'}
        title={active
          ? 'Selecting — select a range (drag on desktop, tap start & end on touch)'
          : 'Selecting — select a range, then choose Solved / Wrong / Lookup'}
      >✂️</button>

      {notice && <div className="range-select__hint range-select__hint--notice">{notice}</div>}

      {/* 탭 지점 순간 표시 (터치용 — 커서 대체 피드백) */}
      {tapFlash && (
        <div key={tapFlash.key} className="range-select__flash" style={{ left: tapFlash.x, top: tapFlash.y }} />
      )}

      {/* 시작점 마커 — 터치 지점 표시 + 탭하면 재탭 */}
      {IS_TOUCH_PRIMARY && startPoint && step === 1 && (
        <button
          className="range-select__marker"
          style={{ left: startPoint.x, top: startPoint.y }}
          onClick={resetStart}
          title="Start point — tap to redo"
          aria-label="Start point — tap to redo"
        >
          <span className="range-select__marker-dot" />
          <span className="range-select__marker-badge">①</span>
        </button>
      )}

      {/* 선택 확정 후 액션 바 — 위치는 선택 영역 근처 (컴팩트 아이콘) */}
      {selection && barPos && (
        <div className="range-select__bar range-select__bar--fixed" style={{ left: barPos.x, top: barPos.y }} title={selection.text}>
          <button className="range-select__mode range-select__mode--solved" onClick={() => dispatchAction('solved')} title="Mark as solved" aria-label="Mark as solved">✓</button>
          <button className="range-select__mode range-select__mode--wrong" onClick={() => dispatchAction('wrong')} title="Mark as wrong" aria-label="Mark as wrong">✗</button>
          <button className="range-select__mode range-select__mode--lookup" onClick={() => dispatchAction('lookup')} title="Look up in dictionary" aria-label="Look up in dictionary">📖</button>
          <button className="range-select__redo" onClick={redoSelection} title="Re-select the range" aria-label="Re-select the range">↺</button>
          <button
            className="range-select__cancel"
            onClick={() => { window.getSelection()?.removeAllRanges(); exit(); }}
            title="Dismiss selection"
            aria-label="Dismiss selection"
          >✕</button>
        </div>
      )}
    </div>,
    portalTarget
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { subscribeRangeSelect } from '../lib/rangeSelectState.js';
import { IS_TOUCH_PRIMARY } from '../lib/device.js';

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"]), .clickable, summary, details';
const PEN_SELECTOR = '.pdf-annotator__page-wrapper--pen';
const TEXT_SELECTOR = '.react-pdf__Page__textContent span, [contenteditable="true"], textarea, input[type="text"], input[type="search"]';
// 어두운 오버레이(이미지 라이트박스 등) — 회색 기본 커서가 안 보여서 고대비(흰색)로 렌더
const DARK_SELECTOR = '.pdf-annotator__lightbox';

// ── RangeSelect(✂️ Selecting) 상태의 정밀 타깃 커서 ────────────
// 단일 선택 색상 + 크로스헤어 눈금. 단계 배지(①/②)는 터치(두 번 탭) 전용.
// 데스크톱(드래그)에서는 배지를 없애고 더 작고 은은하게 표시해
// 화면이 엉켜 보이지 않게 한다.
const SELECTING_COLOR = '#3d5a80';

function RangeCursor({ pos, step }) {
  const color = SELECTING_COLOR;
  const size = IS_TOUCH_PRIMARY ? 30 : 22;
  const showBadge = IS_TOUCH_PRIMARY;
  const ticks = [
    { x: pos.x, y: pos.y - size / 2 - 4, w: 1.5, h: 7 }, // top
    { x: pos.x, y: pos.y + size / 2 + 4, w: 1.5, h: 7 }, // bottom
    { x: pos.x - size / 2 - 4, y: pos.y, w: 7, h: 1.5 }, // left
    { x: pos.x + size / 2 + 4, y: pos.y, w: 7, h: 1.5 }, // right
  ];
  return (
    <>
      {/* 타깃 링 (펄스) */}
      <div
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width: size,
          height: size,
          borderRadius: '50%',
          border: `1.5px solid ${color}`,
          boxShadow: `0 0 0 3px ${color}26, 0 1px 4px rgba(0,0,0,0.15)`,
          pointerEvents: 'none',
          zIndex: 2147483647,
          animation: 'rangeCursorPulse 1.1s ease-in-out infinite',
          willChange: 'transform, opacity',
        }}
      />
      {/* 크로스헤어 눈금 */}
      {ticks.map((t, i) => (
        <div
          key={i}
          style={{
            position: 'fixed',
            left: t.x,
            top: t.y,
            width: t.w,
            height: t.h,
            background: color,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 2147483647,
          }}
        />
      ))}
      {/* 중심점 */}
      <div
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width: IS_TOUCH_PRIMARY ? 5 : 4,
          height: IS_TOUCH_PRIMARY ? 5 : 4,
          borderRadius: '50%',
          background: color,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 2147483647,
        }}
      />
      {/* 단계 배지 ① / ② (터치 전용) */}
      {showBadge && (
        <div
          style={{
            position: 'fixed',
            left: pos.x + size / 2 - 5,
            top: pos.y + size / 2 - 5,
            width: 17,
            height: 17,
            borderRadius: '50%',
            background: color,
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: "'Noto Serif', serif",
            boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
            zIndex: 2147483647,
          }}
        >{step === 0 ? '1' : '2'}</div>
      )}
    </>
  );
}

function CursorElement({ pos, mode, range }) {
  const active = !!(range && range.active);
  if (active) {
    return <RangeCursor pos={pos} step={range.step} />;
  }
  const isHidden = mode === 'hidden';
  const isDark = mode === 'dark';
  const isPen = mode === 'pen';
  const isText = mode === 'text';
  const isHover = mode === 'hover';
  const isActive = mode === 'active';

  const size = isActive ? 12 : isDark ? 18 : isHover ? 22 : isPen ? 8 : isText ? 8 : 16;
  const opacity = isHidden ? 0 : isDark ? 0.45 : isHover ? 0.55 : isPen ? 0.7 : isText ? 0.7 : 0.3;
  const bg = isDark ? 'rgba(255, 255, 255, 0.45)' : isPen ? 'rgba(44, 36, 22, 0.8)' : isText ? 'rgba(44, 36, 22, 0.8)' : 'rgba(128, 128, 128, 0.25)';
  const border = isDark ? '1.2px solid rgba(255, 255, 255, 0.9)' : isPen ? 'none' : isText ? 'none' : '1.2px solid rgba(128, 128, 128, 0.45)';
  const showPenTip = isPen || isText;

  return (
    <>
      <div
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          width: size,
          height: size,
          borderRadius: '50%',
          background: (showPenTip || isDark) ? bg : `rgba(128, 128, 128, ${opacity})`,
          border: border,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 2147483647, // maximum z-index
          opacity: isHidden ? 0 : 1,
          transition: 'width 0.15s ease, height 0.15s ease, opacity 0.12s ease',
          willChange: 'left, top, width, height',
          boxShadow: showPenTip ? 'none' : '0 1px 3px rgba(0,0,0,0.10)',
        }}
      />
      {showPenTip && (
        <div
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: bg,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 2147483647,
            opacity: isHidden ? 0 : 1,
            transition: 'opacity 0.12s ease',
            willChange: 'left, top',
          }}
        />
      )}
    </>
  );
}

export default function CustomCursor() {
  const [pos, setPos] = useState({ x: -100, y: -100 });
  const [mode, setMode] = useState('default');
  const [range, setRange] = useState(null);
  const [portalTarget, setPortalTarget] = useState(null);
  const rafRef = useRef(null);
  const targetRef = useRef({ x: -100, y: -100 });
  // How many touch (finger) pointers are currently pressed. The cursor is
  // hidden only during finger interaction. Pen/stylus input has hover, so
  // it keeps the cursor — a one-shot `touchstart` flag hid it forever after
  // a single pen tap, and touchscreens stopped sending compatible mouse
  // hover events after a tap, freezing the cursor at the last point.
  const activeTouchesRef = useRef(0);

  // Track fullscreen element — render cursor inside it so it's visible
  useEffect(() => {
    const updatePortal = () => {
      const fsEl = document.fullscreenElement;
      setPortalTarget(fsEl || document.body);
    };
    updatePortal();
    document.addEventListener('fullscreenchange', updatePortal);
    // Also handle webkit variant
    document.addEventListener('webkitfullscreenchange', updatePortal);
    return () => {
      document.removeEventListener('fullscreenchange', updatePortal);
      document.removeEventListener('webkitfullscreenchange', updatePortal);
    };
  }, []);

  // RangeSelect(✂️) armed 상태 구독 — 장전되면 커서가 타깃으로 바뀐다
  useEffect(() => subscribeRangeSelect(setRange), []);

  const detectMode = useCallback((el) => {
    if (!el) return 'default';
    if (el.closest(DARK_SELECTOR)) return 'dark';   // 어두운 오버레이 위 — 최우선 (내부 버튼도 포함)
    if (el.closest(PEN_SELECTOR)) return 'pen';
    if (el.closest(TEXT_SELECTOR) || el.matches(TEXT_SELECTOR)) return 'text';
    if (el.closest(INTERACTIVE_SELECTOR)) return 'hover';
    return 'default';
  }, []);

  // Track coarse-pointer (finger-only) devices — keep the cursor hidden
  // after a tap there (they have no hover). Pen/mouse re-show it on the
  // next `pointermove`.
  const isCoarse = useCallback(() => {
    try { return window.matchMedia?.('(pointer: coarse)')?.matches ?? false; } catch { return false; }
  }, []);

  // Position/mode is driven by Pointer Events (not mouse events): pen and
  // mouse reliably fire `pointermove` on hover, whereas some touchscreen
  // browsers stop generating compatible mouse hover events after a tap —
  // which previously froze the cursor at the last pressed point.
  const handlePointerMove = useCallback((e) => {
    if (e.pointerType === 'touch') {
      setMode('hidden');
      return;
    }
    targetRef.current = { x: e.clientX, y: e.clientY };

    const el = document.elementFromPoint(e.clientX, e.clientY);
    setMode(prev => {
      if (prev === 'active') return 'active';
      // A real hover move (mouse / pen) always re-shows the cursor.
      return detectMode(el);
    });

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        setPos(targetRef.current);
        rafRef.current = null;
      });
    }
  }, [detectMode]);

  const handlePointerDown = useCallback((e) => {
    if (e.pointerType === 'touch') {
      activeTouchesRef.current += 1;
      setMode('hidden');
      return;
    }
    setMode('active');
  }, []);

  const restoreAfterTouch = useCallback(() => {
    if (activeTouchesRef.current > 0) return;
    // Finger-only (coarse-pointer) devices have no hover cursor — stay
    // hidden. Pen/mouse re-show via the next `pointermove`.
    setMode(isCoarse() ? 'hidden' : 'default');
  }, [isCoarse]);

  const handlePointerUp = useCallback((e) => {
    if (e.pointerType === 'touch') {
      activeTouchesRef.current = Math.max(0, activeTouchesRef.current - 1);
      restoreAfterTouch();
      return;
    }
    setMode(prev => prev === 'hidden' ? 'hidden' : 'default');
  }, [restoreAfterTouch]);

  const handlePointerCancel = useCallback((e) => {
    if (e.pointerType !== 'touch') return;
    activeTouchesRef.current = Math.max(0, activeTouchesRef.current - 1);
    restoreAfterTouch();
  }, [restoreAfterTouch]);

  const handlePointerLeave = useCallback(() => setMode('hidden'), []);
  const handlePointerEnter = useCallback(() => setMode('default'), []);

  useEffect(() => {
    // ⚠️ 캡처 단계에서 듣는다 — 라이트박스 등 오버레이가 pointermove에서
    // stopPropagation()으로 네이티브 버블링을 끊어도 커서가 멈추지 않게 한다.
    window.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    window.addEventListener('pointerup', handlePointerUp, { capture: true });
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true });
    document.addEventListener('pointerleave', handlePointerLeave, { capture: true });
    document.addEventListener('pointerenter', handlePointerEnter, { capture: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, { capture: true });
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('pointerup', handlePointerUp, { capture: true });
      window.removeEventListener('pointercancel', handlePointerCancel, { capture: true });
      document.removeEventListener('pointerleave', handlePointerLeave, { capture: true });
      document.removeEventListener('pointerenter', handlePointerEnter, { capture: true });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handlePointerMove, handlePointerDown, handlePointerUp, handlePointerCancel, handlePointerLeave, handlePointerEnter]);

  const cursor = <CursorElement pos={pos} mode={mode} range={range} />;

  // Portal into fullscreen element when native fullscreen is active,
  // otherwise render into document.body so it's always on top
  if (portalTarget) {
    return createPortal(cursor, portalTarget);
  }
  return null;
}

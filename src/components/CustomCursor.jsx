import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { subscribeRangeSelect } from '../lib/rangeSelectState.js';
import { IS_TOUCH_PRIMARY } from '../lib/device.js';

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"]), .clickable, summary, details';
const PEN_SELECTOR = '.pdf-annotator__page-wrapper--pen';
const TEXT_SELECTOR = '.react-pdf__Page__textContent span, [contenteditable="true"], textarea, input[type="text"], input[type="search"]';

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
  const isPen = mode === 'pen';
  const isText = mode === 'text';
  const isHover = mode === 'hover';
  const isActive = mode === 'active';

  const size = isActive ? 12 : isHover ? 22 : isPen ? 8 : isText ? 8 : 16;
  const opacity = isHidden ? 0 : isHover ? 0.55 : isPen ? 0.7 : isText ? 0.7 : 0.3;
  const bg = isPen ? 'rgba(44, 36, 22, 0.8)' : isText ? 'rgba(44, 36, 22, 0.8)' : 'rgba(128, 128, 128, 0.25)';
  const border = isPen ? 'none' : isText ? 'none' : '1.2px solid rgba(128, 128, 128, 0.45)';
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
          background: showPenTip ? bg : `rgba(128, 128, 128, ${opacity})`,
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
  const isTouchDevice = useRef(false);

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

  useEffect(() => {
    const onTouch = () => { isTouchDevice.current = true; setMode('hidden'); };
    window.addEventListener('touchstart', onTouch, { once: true });
    return () => window.removeEventListener('touchstart', onTouch);
  }, []);

  // RangeSelect(✂️) armed 상태 구독 — 장전되면 커서가 타깃으로 바뀐다
  useEffect(() => subscribeRangeSelect(setRange), []);

  const detectMode = useCallback((el) => {
    if (!el) return 'default';
    if (el.closest(PEN_SELECTOR)) return 'pen';
    if (el.closest(TEXT_SELECTOR) || el.matches(TEXT_SELECTOR)) return 'text';
    if (el.closest(INTERACTIVE_SELECTOR)) return 'hover';
    return 'default';
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (isTouchDevice.current) return;
    targetRef.current = { x: e.clientX, y: e.clientY };

    const el = document.elementFromPoint(e.clientX, e.clientY);
    setMode(prev => {
      if (prev === 'active') return 'active';
      if (prev === 'hidden') return 'hidden';
      return detectMode(el);
    });

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        setPos(targetRef.current);
        rafRef.current = null;
      });
    }
  }, [detectMode]);

  const handleMouseDown = useCallback(() => {
    if (isTouchDevice.current) return;
    setMode('active');
  }, []);

  const handleMouseUp = useCallback(() => {
    if (isTouchDevice.current) return;
    setMode(prev => prev === 'hidden' ? 'hidden' : 'default');
  }, []);

  const handleMouseLeave = useCallback(() => setMode('hidden'), []);
  const handleMouseEnter = useCallback(() => {
    if (isTouchDevice.current) return;
    setMode('default');
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [handleMouseMove, handleMouseDown, handleMouseUp, handleMouseLeave, handleMouseEnter]);

  const cursor = <CursorElement pos={pos} mode={mode} range={range} />;

  // Portal into fullscreen element when native fullscreen is active,
  // otherwise render into document.body so it's always on top
  if (portalTarget) {
    return createPortal(cursor, portalTarget);
  }
  return null;
}

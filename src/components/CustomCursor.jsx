import { useState, useEffect, useRef, useCallback } from 'react';

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"]), .clickable, summary, details';
const PEN_SELECTOR = '.pdf-annotator__page-wrapper--pen';
const TEXT_SELECTOR = '.react-pdf__Page__textContent span, [contenteditable="true"], textarea, input[type="text"], input[type="search"]';

export default function CustomCursor() {
  const [pos, setPos] = useState({ x: -100, y: -100 });
  const [mode, setMode] = useState('default'); // 'default' | 'hover' | 'active' | 'pen' | 'text' | 'hidden'
  const rafRef = useRef(null);
  const targetRef = useRef({ x: -100, y: -100 });
  const isTouchDevice = useRef(false);

  useEffect(() => {
    // Detect touch device — no custom cursor needed
    const onTouch = () => { isTouchDevice.current = true; setMode('hidden'); };
    window.addEventListener('touchstart', onTouch, { once: true });
    return () => window.removeEventListener('touchstart', onTouch);
  }, []);

  const detectMode = useCallback((el) => {
    if (!el) return 'default';
    // Pen drawing tool active
    if (el.closest(PEN_SELECTOR)) return 'pen';
    // Text selection / editing
    if (el.closest(TEXT_SELECTOR) || el.matches(TEXT_SELECTOR)) return 'text';
    // Interactive elements
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
    setMode(prev => {
      if (prev === 'hidden') return 'hidden';
      // Re-detect after click
      return 'default';
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setMode('hidden');
  }, []);

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

  // Cursor visual properties by mode
  const isHidden = mode === 'hidden';
  const isPen = mode === 'pen';
  const isText = mode === 'text';
  const isHover = mode === 'hover';
  const isActive = mode === 'active';

  const size = isActive ? 12 : isHover ? 22 : isPen ? 8 : isText ? 8 : 16;
  const opacity = isHidden ? 0 : isHover ? 0.55 : isPen ? 0.7 : isText ? 0.7 : 0.3;
  const bg = isPen ? 'rgba(44, 36, 22, 0.8)' : isText ? 'rgba(44, 36, 22, 0.8)' : 'rgba(128, 128, 128, 0.25)';
  const border = isPen ? 'none' : isText ? 'none' : `1.2px solid rgba(128, 128, 128, 0.45)`;
  const showPenTip = isPen || isText;

  return (
    <>
      {/* Main circle cursor */}
      <div
        className="custom-cursor"
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
          zIndex: 99999,
          opacity: isHidden ? 0 : 1,
          transition: 'width 0.15s ease, height 0.15s ease, opacity 0.12s ease',
          willChange: 'left, top, width, height',
          boxShadow: showPenTip ? 'none' : '0 1px 3px rgba(0,0,0,0.10)',
        }}
      />
      {/* Pen tip dot (small filled dot for pen/text modes) */}
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
            zIndex: 99999,
            opacity: isHidden ? 0 : 1,
            transition: 'opacity 0.12s ease',
            willChange: 'left, top',
          }}
        />
      )}
    </>
  );
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { clampPan, zoomAt, toggleZoom } from '../lib/zoomView.js';

/**
 * 🖼️ ImageLightbox — Amazon 스타일 전체화면 이미지 뷰어
 * ─ 클릭: 확대(2배)/fit 토글 · 드래그: 이동 · 휠: 커서 기준 줌
 * ─ Esc / ✕ / 배경 클릭: 닫기
 * 드래그 중에는 React 상태를 거치지 않고 DOM을 직접 조작한다 (ImageOverlay와 동일 전략).
 */
export default function ImageLightbox({ dataUrl, alt = '', onClose }) {
  const portalTarget = useFullscreenPortal();
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const stageRef = useRef(null);
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);                        // { px, py, x, y, natural }
  const movedRef = useRef(false);

  // 이미지 원본 크기 — onLoad 타이밍에 의존하지 않고 상호작용 시점에 DOM에서 직접 읽는다
  const getNatural = useCallback(() => {
    const el = imgRef.current;
    if (!el || !el.naturalWidth) return null;
    return { w: el.naturalWidth, h: el.naturalHeight };
  }, []);

  // Esc 닫기 + 배경 스크롤 잠금
  useEffect(() => {
    if (!portalTarget) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [portalTarget, onClose]);

  // 휠 줌 — React의 wheel은 passive라 preventDefault가 안 되므로 네이티브로 바인딩
  // (라이트박스 뒤의 PDF 스크롤이 함께 움직이는 것을 막는다)
  // ⚠️ portalTarget이 준비되기 전에는 stage가 없으므로 deps에 포함해 재실행한다
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const nat = getNatural();
      if (!nat) return;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const r = el.getBoundingClientRect();
      setView((v) => zoomAt(v, factor, { x: e.clientX, y: e.clientY }, { w: r.width, h: r.height }, nat));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [getNatural, portalTarget]);

  const applyTransform = useCallback((node, scale, x, y, animate) => {
    node.style.transition = animate ? '' : 'none';
    node.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  }, []);

  // 드래그 팬 — fit 상태면 clampPan이 0으로 고정하므로 확대 시에만 이동
  const onPointerDown = (e) => {
    const nat = getNatural();
    if (!nat || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, natural: nat };
    movedRef.current = false;
    const node = wrapRef.current;
    if (node) {
      node.style.transition = 'none';      // 드래그 중 애니메이션 지연 제거
      node.style.willChange = 'transform'; // 합성 레이어 승격
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 무시 */ }
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    const el = stageRef.current;
    const size = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
    const p = clampPan(d.x + dx, d.y + dy, view.scale, size, d.natural);
    d.x = p.x;
    d.y = p.y;
    const node = wrapRef.current;
    if (node) applyTransform(node, view.scale, p.x, p.y, false);
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    const node = wrapRef.current;
    if (!node) return;
    node.style.willChange = '';
    node.style.transition = ''; // CSS 전환 복원
    setView((v) => ({ scale: v.scale, x: d.x, y: d.y }));
  };

  if (!portalTarget || !dataUrl) return null;

  const zoomed = view.scale > 1.001;

  return createPortal(
    <div
      className="pdf-annotator__lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      // ⚠️ 라이트박스는 ImageOverlay(인라인 노트) JSX 안에서 portal로 렌더링된다.
      // React 이벤트는 portal 경계를 넘어 부모(노트) 핸들러까지 전파되므로,
      // 노트의 startDrag가 pointer capture를 가로채 클릭/드래그가 먹통이 된다.
      // 루트에서 전파를 차단해 라이트박스 내부로 이벤트를 가둔다.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerCancel={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="pdf-annotator__lightbox-stage"
        ref={stageRef}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          ref={wrapRef}
          className={'pdf-annotator__lightbox-wrap' + (zoomed ? ' pdf-annotator__lightbox-wrap--zoom' : '')}
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={() => {
            if (movedRef.current) return; // 팬 드래그 후 확대 토글이 발동하지 않게
            setView((v) => ({ scale: toggleZoom(v.scale), x: 0, y: 0 }));
          }}
          title={zoomed ? 'Click to fit' : 'Click to zoom'}
        >
          <img ref={imgRef} src={dataUrl} alt={alt} draggable={false} />
        </div>
        <button
          className="pdf-annotator__lightbox-close"
          onClick={onClose}
          aria-label="Close image viewer"
          title="Close (Esc)"
        >✕</button>
        <div className="pdf-annotator__lightbox-hint">Click: zoom · Drag: pan · Wheel: zoom · Esc: close</div>
      </div>
    </div>,
    portalTarget
  );
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { clampPan, pinchView, zoomAt, toggleZoom } from '../lib/zoomView.js';

/**
 * 🖼️ ImageLightbox — Amazon 스타일 전체화면 이미지 뷰어
 * ─ 클릭: 확대(2배)/fit 토글 · 드래그: 이동 · 휠: 커서 기준 줌 · 핀치: 두 손가락 줌/팬
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
  const pointersRef = useRef(new Map());               // pointerId → {x,y} (핀치용)
  const pinchRef = useRef(null);                       // { d0, m0x, m0y, scale0, x0, y0, natural, cur }
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
      // ⚠️ 감도 제한: 이벤트당 최대 ±25% — 트랙패드 모멘텀 연타에도 안정적
      const raw = Math.exp(-e.deltaY * 0.0008);
      const factor = Math.max(0.8, Math.min(1.25, raw));
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

  // ── 포인터 상호작용: 1개=팬 드래그 / 탭, 2개=핀치 줌+팬 (모바일) ──
  const onPointerDown = (e) => {
    const nat = getNatural();
    if (!nat || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const node = wrapRef.current;
    if (node) {
      node.style.transition = 'none';      // 제스처 중 애니메이션 지연 제거
      node.style.willChange = 'transform'; // 합성 레이어 승격
    }
    if (pointersRef.current.size === 2) {
      // 두 번째 손가락 → 핀치 시작 (단일 팬 취소)
      dragRef.current = null;
      movedRef.current = true; // 핀치 후 클릭 토글 방지
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        m0x: (a.x + b.x) / 2,
        m0y: (a.y + b.y) / 2,
        scale0: view.scale,
        x0: view.x,
        y0: view.y,
        natural: nat,
        cur: { scale: view.scale, x: view.x, y: view.y },
      };
    } else if (pointersRef.current.size === 1) {
      dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, natural: nat };
      movedRef.current = false;
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 무시 */ }
  };

  const onPointerMove = (e) => {
    const ptrs = pointersRef.current;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const node = wrapRef.current;
    const el = stageRef.current;
    const size = el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 };
    // 핀치 (두 손가락)
    const p = pinchRef.current;
    if (p && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const factor = Math.max(0.5, Math.min(2, d / p.d0));
      const v = pinchView(
        { scale: p.scale0, x: p.x0, y: p.y0 },
        factor,
        { x: mx, y: my },
        { dx: mx - p.m0x, dy: my - p.m0y },
        size,
        p.natural
      );
      p.cur = v;
      if (node) applyTransform(node, v.scale, v.x, v.y, false);
      return;
    }
    // 단일 손가락 팬
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    const pan = clampPan(d.x + dx, d.y + dy, view.scale, size, d.natural);
    d.x = pan.x;
    d.y = pan.y;
    if (node) applyTransform(node, view.scale, pan.x, pan.y, false);
  };

  const onPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    const node = wrapRef.current;
    // 핀치 종료 (손가락 하나가 떼지면 확정)
    const p = pinchRef.current;
    if (p && pointersRef.current.size < 2) {
      pinchRef.current = null;
      if (node) {
        node.style.willChange = '';
        node.style.transition = '';
      }
      setView(p.cur);
      return;
    }
    const d = dragRef.current;
    if (!d) {
      if (node) {
        node.style.willChange = '';
        node.style.transition = '';
      }
      return;
    }
    dragRef.current = null;
    if (!node) return;
    node.style.willChange = '';
    node.style.transition = ''; // CSS 전환 복원
    setView((v) => ({ scale: v.scale, x: d.x, y: d.y }));
  };

  const onPointerCancel = (e) => onPointerUp(e);

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
          onPointerCancel={onPointerCancel}
          onClick={() => {
            if (movedRef.current) return; // 팬/핀치 후 확대 토글이 발동하지 않게
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
        <div className="pdf-annotator__lightbox-hint">Click: zoom · Drag: pan · Wheel / Pinch: zoom · Esc: close</div>
      </div>
    </div>,
    portalTarget
  );
}

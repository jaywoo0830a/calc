import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { clampPan, pinchView, zoomAt } from '../lib/zoomView.js';

// 핀치 감도 — 1보다 크면 같은 손가락 벌림/모음으로 더 크게 확대/축소된다
const PINCH_GAIN = 1.2;

/**
 * 🖼️ ImageLightbox — Amazon 스타일 전체화면 이미지 뷰어
 * ─ 핀치(두 손가락): 줌인/줌아웃 · 드래그: 이동(팬)
 * ─ Esc / ✕ / 배경 클릭: 닫기
 * 드래그 중에는 React 상태를 거치지 않고 DOM을 직접 조작한다 (ImageOverlay와 동일 전략).
 */
export default function ImageLightbox({ dataUrl, alt = '', onClose, onRotate, onPrev, onNext, counter = '' }) {
  const portalTarget = useFullscreenPortal();
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const stageRef = useRef(null);
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);                        // { px, py, x, y, base }
  const pointersRef = useRef(new Map());               // pointerId → {x,y} (핀치용)
  const pinchRef = useRef(null);                       // { d0, m0x, m0y, scale0, x0, y0, base, cur }

  // 이미지 기준(레이아웃) 크기 — fit 렌더 기준 크기. transform(scale)과 무관한
  // clientWidth/Height를 쓴다. ⚠️ naturalWidth를 쓰면 원본이 스테이지보다 작은
  // 이미지(스크린샷 등)는 확대해도 clampPan이 수평 이동을 0으로 봉쇄한다.
  const getBase = useCallback(() => {
    const el = imgRef.current;
    if (!el || !el.clientWidth) return null;
    return { w: el.clientWidth, h: el.clientHeight };
  }, []);

  // 🔄 회전 후 이미지 치수가 바뀌면 뷰(줌/팬) 초기화
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, [dataUrl]);

  // Esc 닫기 + 배경 스크롤 잠금 (+ ‹ › 키보드 네비게이션)
  useEffect(() => {
    if (!portalTarget) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft') onPrev?.();
      if (e.key === 'ArrowRight') onNext?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [portalTarget, onClose, onPrev, onNext]);

  const applyTransform = useCallback((node, scale, x, y, animate) => {
    node.style.transition = animate ? '' : 'none';
    node.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  }, []);

  // 휠/트랙패드 제스처 처리 — 라이트박스 위 휠은 항상 앱이 소비(preventDefault)해
  // 페이지 스크롤·브라우저 "두 손가락 스와이프 = 뒤로가기"가 발동되지 않게 한다.
  // ─ ctrl/⌘+휠(트랙패드 핀치): 줌인/줌아웃
  // ─ 일반 휠(두 손가락 스와이프): 확대 상태에서 팬 (콘텐츠가 손가락을 따라감)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const size = { w: r.width, h: r.height };
      if (e.ctrlKey || e.metaKey) {
        const base = getBase();
        if (!base) return;
        const raw = Math.exp(-e.deltaY * 0.002);
        const factor = Math.max(0.7, Math.min(1.35, raw));
        setView((v) => zoomAt(v, factor, { x: e.clientX, y: e.clientY }, size, base));
        return;
      }
      // 두 손가락 스와이프 → 팬 (deltaMode 정규화: 1=줄, 2=페이지)
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      setView((v) => {
        if (v.scale <= 1) return v;   // fit 상태에서는 팬 없음
        const base = getBase();
        if (!base) return v;
        return clampPan(v.x - dx, v.y - dy, v.scale, size, base);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [getBase, portalTarget]);

  // 브라우저 뒤로가기 가드 — 트랙패드 스와이프·뒤로 버튼으로 앱 페이지가 이탈하는
  // 대신 라이트박스만 닫히고 앱은 제자리에 머문다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const open = !!dataUrl;
  const pushedRef = useRef(false);
  const poppedRef = useRef(false);
  useEffect(() => {
    if (!open || pushedRef.current) return;
    history.pushState({ imageLightboxGuard: true }, '');
    pushedRef.current = true;
    const onPopState = () => {
      poppedRef.current = true;       // 뒤로가기로 소비됨 → 정리용 back() 불필요
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (pushedRef.current && !poppedRef.current) {
        history.back();               // Esc/✕ 등으로 닫힌 경우 가드 엔트리 정리
      }
      pushedRef.current = false;
    };
  }, [open]);

  // ── 포인터 상호작용: 1개=팬 드래그, 2개=핀치 줌/팬 (휠·클릭 줌 없음) ──
  const onPointerDown = (e) => {
    const base = getBase();
    if (!base || (e.pointerType === 'mouse' && e.button !== 0)) return;
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
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        m0x: (a.x + b.x) / 2,
        m0y: (a.y + b.y) / 2,
        scale0: view.scale,
        x0: view.x,
        y0: view.y,
        base,
        cur: { scale: view.scale, x: view.x, y: view.y },
      };
    } else if (pointersRef.current.size === 1) {
      dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, base };
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
      const factor = Math.max(0.25, Math.min(4, (d / p.d0) * PINCH_GAIN)); // 감도 가산
      const v = pinchView(
        { scale: p.scale0, x: p.x0, y: p.y0 },
        factor,
        { x: mx, y: my },
        { dx: mx - p.m0x, dy: my - p.m0y },
        size,
        p.base
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
    const pan = clampPan(d.x + dx, d.y + dy, view.scale, size, d.base);
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
          className="pdf-annotator__lightbox-wrap"
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <img ref={imgRef} src={dataUrl} alt={alt} draggable={false} />
        </div>
        <button
          className="pdf-annotator__lightbox-close"
          onClick={onClose}
          aria-label="Close image viewer"
          title="Close (Esc)"
        >✕</button>
        {counter && <div className="pdf-annotator__lightbox-counter">{counter}</div>}
        {onPrev && (
          <button
            className="pdf-annotator__lightbox-prev"
            onClick={onPrev}
            aria-label="Previous image"
            title="Previous (←)"
          >‹</button>
        )}
        {onNext && (
          <button
            className="pdf-annotator__lightbox-next"
            onClick={onNext}
            aria-label="Next image"
            title="Next (→)"
          >›</button>
        )}
        {onRotate && (
          <>
            <button
              className="pdf-annotator__lightbox-rotate"
              onClick={() => onRotate(270)}
              aria-label="Rotate counterclockwise 90°"
              title="Rotate 90° counterclockwise"
            >↺</button>
            <button
              className="pdf-annotator__lightbox-rotate pdf-annotator__lightbox-rotate--cw"
              onClick={() => onRotate(90)}
              aria-label="Rotate clockwise 90°"
              title="Rotate 90° clockwise"
            >↻</button>
          </>
        )}
        <div className="pdf-annotator__lightbox-hint">Pinch: zoom · Drag/Swipe: pan · {onRotate ? '↺ ↻: rotate · ' : ''}Esc: close</div>
      </div>
    </div>,
    portalTarget
  );
}

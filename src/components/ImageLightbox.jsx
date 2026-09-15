import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';
import { clampScale } from '../lib/zoomView.js';

// 핀치 감도 — 1보다 크면 같은 손가락 벌림/모음으로 더 크게 확대/축소된다
const PINCH_GAIN = 1.2;

/**
 * 🖼️ ImageLightbox — Amazon 스타일 전체화면 이미지 뷰어
 * ─ 팬 = 네이티브 스크롤: 스테이지가 overflow 컨테이너이고 래퍼가 (fit × scale)
 *   로 실제로 커진다 → 트랙패드 두 손가락 스와이프·마우스 휠·터치 드래그(모멘텀)
 *   팬을 브라우저가 처리하고, 경계/뒤로가기 제스처도 브라우저 규칙을 따른다.
 * ─ 줌 = 핀치(두 손가락 pointer) / ctrl+휠(트랙패드 핀치): 앵커 보정은 scroll로.
 * ─ Esc / ✕ / 배경 클릭: 닫기 · history 가드로 브라우저 뒤로가기 시 앱 이탈 방지.
 */
export default function ImageLightbox({ dataUrl, alt = '', onClose, onRotate, onPrev, onNext, counter = '' }) {
  const portalTarget = useFullscreenPortal();
  const [fit, setFit] = useState(null);        // { w, h } — scale 1(화면 맞춤) 크기
  const [scale, setScale] = useState(1);
  const stageRef = useRef(null);
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const fitRef = useRef(null);                 // 핸들러용 최신 fit
  const scaleRef = useRef(1);                  // 핸들러용 최신 scale (DOM 직접 조작과 동기화)
  const dragRef = useRef(null);                // 마우스 드래그 팬 { px, py, sl, st }
  const pointersRef = useRef(new Map());       // pointerId → {x,y} (핀치용)
  const pinchRef = useRef(null);               // { d0, m0x, m0y, scale0, cx0, cy0 }

  // 화면 맞춤(fit) 크기 계산 — img 로드·리사이즈·풀스크린 전환 시 재계산.
  // scale 1 = 이 크기이며, 줌하면 wrap이 fit × scale 로 실제로 커진다.
  const computeFit = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !img.naturalWidth || !stage || !stage.clientWidth) return;
    const f = Math.min(1, stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
    fitRef.current = {
      w: Math.max(1, Math.floor(img.naturalWidth * f)),
      h: Math.max(1, Math.floor(img.naturalHeight * f)),
    };
    setFit(fitRef.current);
    if (scaleRef.current !== 1) {   // 리핏되면 뷰 초기화 (스크롤은 브라우저가 clamp)
      scaleRef.current = 1;
      setScale(1);
    }
  }, []);

  // 줌 적용 — wrap을 fit × ns 로 실제로 키우고, 콘텐츠 좌표(cx, cy: wrap 원점 기준,
  // s0 배율)가 화면 오프셋(ox, oy) 지점에 머무르도록 스크롤을 보정한다.
  // 팬 가능 범위는 브라우저 스크롤 clamp가 담당한다.
  const applyZoom = useCallback((ns, s0, cx, cy, ox, oy) => {
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    const base = fitRef.current;
    if (!stage || !wrap || !base) return;
    wrap.style.width = `${Math.round(base.w * ns)}px`;
    wrap.style.height = `${Math.round(base.h * ns)}px`;
    const ratio = ns / s0;
    // 스타일 쓰기 직후 offsetLeft/Top 읽기 → 동기 레이아웃으로 새 중앙정렬 반영
    stage.scrollLeft = cx * ratio - ox + wrap.offsetLeft;
    stage.scrollTop = cy * ratio - oy + wrap.offsetTop;
    scaleRef.current = ns;
    setScale(ns);
  }, []);

  // 이미지 교체(회전 포함) 시 줌 초기화 — fit은 onLoad에서 재계산
  useEffect(() => {
    scaleRef.current = 1;
    setScale(1);
  }, [dataUrl]);

  // 마운트/포털 대상 변경(풀스크린 전환) 시 fit 재계산 — 캐시된 이미지가 load를
  // 재발화하지 않는 경우의 안전망
  useEffect(() => {
    if (dataUrl) computeFit();
  }, [dataUrl, portalTarget, computeFit]);

  // 리사이즈/풀스크린 전환 시 fit 재계산
  useEffect(() => {
    if (!dataUrl) return;
    const onResize = () => computeFit();
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
    document.addEventListener('webkitfullscreenchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
      document.removeEventListener('webkitfullscreenchange', onResize);
    };
  }, [dataUrl, computeFit]);

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

  // 휠 — ─ ctrl/⌘+휠(트랙패드 핀치): 앵커 기준 줌.
  //       ─ 일반 휠(두 손가락 스와이프): 건드리지 않음 → 네이티브 overflow 스크롤이
  //         곧 팬. 확대 상태에서는 컨테이너가 스크롤을 소비해 브라우저 뒤로가기
  //         제스처가 발동되지 않는다.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;   // 팬은 네이티브 스크롤에 맡김
      e.preventDefault();
      const wrap = wrapRef.current;
      if (!wrap || !fitRef.current) return;
      const s0 = scaleRef.current;
      const raw = Math.exp(-e.deltaY * 0.002);
      const factor = Math.max(0.7, Math.min(1.35, raw));
      const ns = clampScale(s0 * factor);
      if (ns === s0) return;
      const rect = stage.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      // wrap 원점 기준 콘텐츠 좌표 — 커서 아래 이미지 점이 줌 후에도 그 자리에 머무르게
      const cx = ox + stage.scrollLeft - wrap.offsetLeft;
      const cy = oy + stage.scrollTop - wrap.offsetTop;
      applyZoom(ns, s0, cx, cy, ox, oy);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [applyZoom, portalTarget]);

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

  // ── 포인터 상호작용 — 터치: 2개=핀치(1개는 네이티브 스크롤 팬), 마우스: 드래그 팬 ──
  const onPointerDown = (e) => {
    if (!fitRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const stage = stageRef.current;
    if (pointersRef.current.size === 2) {
      // 두 번째 손가락 → 핀치 시작 (마우스 드래그 취소)
      dragRef.current = null;
      const [a, b] = [...pointersRef.current.values()];
      const wrap = wrapRef.current;
      const rect = stage.getBoundingClientRect();
      const m0x = (a.x + b.x) / 2;
      const m0y = (a.y + b.y) / 2;
      pinchRef.current = {
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        m0x, m0y,
        scale0: scaleRef.current,
        // 핀치 내내 고정될 콘텐츠 좌표 (scale0 배율, wrap 원점 기준)
        cx0: m0x - rect.left + stage.scrollLeft - wrap.offsetLeft,
        cy0: m0y - rect.top + stage.scrollTop - wrap.offsetTop,
      };
    } else if (pointersRef.current.size === 1 && e.pointerType === 'mouse') {
      // 마우스 드래그 팬 — 터치 한 손가락은 네이티브 스크롤(모멘텀 포함)에 맡긴다
      dragRef.current = { px: e.clientX, py: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 무시 */ }
  };

  const onPointerMove = (e) => {
    const ptrs = pointersRef.current;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const stage = stageRef.current;
    const p = pinchRef.current;
    if (p && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const factor = Math.max(0.25, Math.min(4, (d / p.d0) * PINCH_GAIN)); // 감도 가산
      const ns = clampScale(p.scale0 * factor);
      const rect = stage.getBoundingClientRect();
      // 고정 콘텐츠 점이 이동한 중점을 따라오게 — 핀치 줌+팬 동시 처리
      applyZoom(ns, p.scale0, p.cx0, p.cy0, mx - rect.left, my - rect.top);
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    stage.scrollLeft = d.sl - (e.clientX - d.px);
    stage.scrollTop = d.st - (e.clientY - d.py);
  };

  const onPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragRef.current = null;
  };

  const onPointerCancel = (e) => onPointerUp(e);

  // 핀치(두 손가락) 중에는 네이티브 터치 스크롤을 차단 — JS 핀치가 줌+팬을 처리
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onTouchMove = (e) => {
      if (e.touches.length >= 2) e.preventDefault();
    };
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => stage.removeEventListener('touchmove', onTouchMove);
  }, [portalTarget]);

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
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          ref={wrapRef}
          className="pdf-annotator__lightbox-wrap"
          style={fit ? { width: Math.round(fit.w * scale), height: Math.round(fit.h * scale) } : undefined}
        >
          <img ref={imgRef} src={dataUrl} alt={alt} draggable={false} onLoad={computeFit} />
        </div>
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
      <div className="pdf-annotator__lightbox-hint">Pinch: zoom · Scroll/Drag: pan · {onRotate ? '↺ ↻: rotate · ' : ''}Esc: close</div>
    </div>,
    portalTarget
  );
}

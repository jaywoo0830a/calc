import { useRef, useState, useCallback, useEffect } from 'react';
import AppLayout from '../components/AppLayout.jsx';
import katex from 'katex';
import { api } from '../lib/api.js';

// ═══════════════════════════════════════════════════════════════
// 🧮 To KaTeX — 드로잉 패드/손가락으로 그린 수식을 서버의
// PaddleOCR-VL(Formula Recognition)로 LaTeX 변환 → KaTeX 렌더.
// (서버 POST /api/math-ocr → vLLM OpenAI 호환 엔드포인트 호출)
// ═══════════════════════════════════════════════════════════════
const W = 1024, H = 640;        // 캔버스 내부 해상도 (OCR 정확도)
const INK = '#1a1a1a';          // 먹색 획
const PAPER = '#ffffff';        // 흰 배경
const LINE_W = Math.max(3, Math.round(W / 220)); // ~5 (1024 기준) — 얇은 필기선

export default function ToKaTeX() {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef({ x: 0, y: 0 });
  const [hasInk, setHasInk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [latex, setLatex] = useState('');
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [view, setView] = useState('draw'); // 'draw' | 'result' — 둘 중 하나만 표시
  const copiedTimer = useRef(null);

  // 캔버스 초기화 — 고해상도 + 흰 배경
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE_W;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
  }, []);

  // CSS 좌표 → 캔버스 픽셀 좌표
  const toCanvas = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (W / rect.width),
      y: (e.clientY - rect.top) * (H / rect.height),
    };
  }, []);

  // 필압 반영 — 펜(pointerType 'pen'): pressure 0~1 → 선 두께 변동
  // (가볍게=얇게, 세게=굵게). 마우스/손가락은 일정한 두께 유지.
  const strokeWidth = useCallback((e) => {
    if (e.pointerType === 'pen') {
      const p = Math.max(0, Math.min(1, Number(e.pressure) || 0.5));
      return LINE_W * (0.3 + 0.7 * p);
    }
    return LINE_W;
  }, []);

  const onDown = useCallback((e) => {
    e.preventDefault();
    const cv = canvasRef.current;
    cv.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const p = toCanvas(e);
    lastRef.current = p;
    const ctx = cv.getContext('2d');
    ctx.lineWidth = strokeWidth(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setHasInk(true);
  }, [toCanvas, strokeWidth]);

  const onMove = useCallback((e) => {
    if (!drawingRef.current) return;
    const p = toCanvas(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.lineWidth = strokeWidth(e);
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
  }, [toCanvas, strokeWidth]);

  const onUp = useCallback((e) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    try { canvasRef.current.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const clear = useCallback(() => {
    const cv = canvasRef.current;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    setHasInk(false);
    setLatex('');
    setError(null);
    setCopied(null);
    setView('draw');
  }, []);

  const convert = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLatex('');
    try {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      const data = await api.mathOcr(dataUrl);
      const text = String((data && data.latex) || '').trim();
      if (!text) setError('Empty result from the OCR server.');
      else {
        setLatex(text);
        setView('result'); // 성공 시 결과만 표시 — 캔버스는 숨김
      }
    } catch (e) {
      setError(e && e.message ? e.message : 'Conversion failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback((text) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1500);
    }).catch(() => { /* clipboard denied — 조용히 무시 */ });
  }, []);

  const rendered = latex
    ? katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: true, strict: false })
    : '';

  return (
    <AppLayout className="to-katex">
      <div className="to-katex__head">
        <h1 className="to-katex__title">🧮 To KaTeX</h1>
        <span className="to-katex__hint">
          Draw a formula with your pen or finger — the server's PaddleOCR-VL converts it to LaTeX, rendered here with KaTeX.
        </span>
      </div>

      {/* 드로잉 캔버스 — 결과가 보일 때는 숨김 (bitmap은 유지되어 돌아오면 그대로) */}
      <div className="to-katex__stage" hidden={view === 'result'}>
        <canvas
          ref={canvasRef}
          className="to-katex__canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {!hasInk && <div className="to-katex__placeholder">✍️ draw a formula here</div>}
      </div>

      {view === 'draw' ? (
        <>
          <div className="to-katex__actions">
            <button className="to-katex__btn to-katex__btn--primary" onClick={convert} disabled={busy || !hasInk}>
              {busy ? 'Converting…' : '⇄ Convert'}
            </button>
            <button className="to-katex__btn" onClick={clear} disabled={busy || !hasInk}>✕ Clear</button>
          </div>
          {error && <div className="to-katex__error">{error}</div>}
        </>
      ) : (
        <div className="to-katex__result">
          <div className="to-katex__result-math" dangerouslySetInnerHTML={{ __html: rendered }} />
          <div className="to-katex__source"><code>{latex}</code></div>
          <div className="to-katex__actions">
            <button className="to-katex__btn" onClick={() => copy(latex)}>
              {copied === latex ? '✓ Copied' : 'Copy LaTeX'}
            </button>
            <button className="to-katex__btn" onClick={() => copy('$$' + latex + '$$')}>
              {copied === '$$' + latex + '$$' ? '✓ Copied' : 'Copy $$…$$'}
            </button>
          </div>
          <button
            className="to-katex__btn to-katex__btn--primary"
            onClick={() => setView('draw')}
          >✏️ Draw again</button>
        </div>
      )}
    </AppLayout>
  );
}

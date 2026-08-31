import { useRef, useState, useCallback, useEffect } from 'react';
import AppLayout from '../components/AppLayout.jsx';
import katex from 'katex';
import { api } from '../lib/api.js';

// ═══════════════════════════════════════════════════════════════
// 🧮 To KaTeX — 드로잉 패드/손가락으로 그린 수식을 서버의
// GLM-OCR(Formula Recognition)로 LaTeX 변환 → KaTeX 렌더.
// (서버 POST /api/math-ocr → llama.cpp OpenAI 호환 엔드포인트 호출)
// ═══════════════════════════════════════════════════════════════
const W = 1024, H = 640;        // 캔버스 내부 해상도 (OCR 정확도)
const INK = '#1a1a1a';          // 먹색 획
const PAPER = '#ffffff';        // 흰 배경
const LINE_W = Math.max(3, Math.round(W / 220)); // ~5 (1024 기준) — 얇은 필기선

// 탭 전환(unmount)·페이지 새로고침 후에도 드로잉/결과 유지 — sessionStorage 캐시.
// (React Router가 페이지를 언마운트해도 캔버스 비트맵이 여기에 보존된다)
const SESSION_KEY = 'to-katex:session:v1';
const EMPTY_SESSION = { dataUrl: null, latex: '', view: 'draw', error: null };
function loadSession() {
  try { return { ...EMPTY_SESSION, ...(JSON.parse(sessionStorage.getItem(SESSION_KEY)) || {}) }; }
  catch { return { ...EMPTY_SESSION }; }
}
function saveSession(s) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* quota/보안 무시 */ }
}

// KaTeX 공식 지원 함수 표 (수식 교정 시 참조)
const KATEX_DOCS_URL = 'https://katex.org/docs/supported.html';

// 치트 시트 항목 인라인 렌더 (displayMode=false — 인라인 수식)
function renderInline(tex) {
  return katex.renderToString(tex, { displayMode: false, throwOnError: false, trust: true, strict: false });
}

// 📖 KaTeX 치트 시트 — 다항식/지수/로그/괄호/삼각/미분/적분 (katex.org 공식 문서 기준)
const CHEATSHEET = [
  { title: 'Polynomials', items: [
    { cmd: String.raw`x^2`, desc: 'superscript' },
    { cmd: String.raw`x_{n}`, desc: 'subscript' },
    { cmd: String.raw`x^{2n+1}`, desc: 'multi-digit exponent' },
    { cmd: String.raw`\frac{a}{b}`, desc: 'fraction' },
    { cmd: String.raw`\frac{ax^2+bx+c}{x-1}`, desc: 'polynomial fraction' },
    { cmd: String.raw`a_1 + a_2 + \cdots + a_n`, desc: 'sequence (cdots)' },
    { cmd: String.raw`\sqrt{x}`, desc: 'square root' },
    { cmd: String.raw`\sqrt[n]{x}`, desc: 'nth root' },
  ]},
  { title: 'Exponents', items: [
    { cmd: String.raw`e^{i\pi}`, desc: "Euler's identity" },
    { cmd: String.raw`10^{-3}`, desc: 'negative exponent' },
    { cmd: String.raw`x^{1/2}`, desc: 'fractional exponent' },
    { cmd: String.raw`a^{b^c}`, desc: 'nested exponent' },
    { cmd: String.raw`\exp(x)`, desc: 'exp function' },
    { cmd: String.raw`2^{10} = 1024`, desc: 'example' },
  ]},
  { title: 'Logarithms', items: [
    { cmd: String.raw`\log x`, desc: 'log' },
    { cmd: String.raw`\ln x`, desc: 'natural log' },
    { cmd: String.raw`\log_2 x`, desc: 'base-2 log' },
    { cmd: String.raw`\log_{10} x`, desc: 'base-10 log' },
    { cmd: String.raw`\log_a b^c`, desc: 'base + argument' },
    { cmd: String.raw`\ln(e) = 1`, desc: 'identity' },
  ]},
  { title: 'Parentheses', items: [
    { cmd: String.raw`(x+1)`, desc: 'parentheses' },
    { cmd: String.raw`\left( \frac{a}{b} \right)`, desc: 'auto-size' },
    { cmd: String.raw`[0, 1]`, desc: 'brackets' },
    { cmd: String.raw`\{ x \mid x > 0 \}`, desc: 'set braces' },
    { cmd: String.raw`\left| x \right|`, desc: 'absolute value' },
    { cmd: String.raw`\langle x \rangle`, desc: 'angle brackets' },
    { cmd: String.raw`\lfloor x \rfloor`, desc: 'floor' },
    { cmd: String.raw`\lceil x \rceil`, desc: 'ceiling' },
  ]},
  { title: 'Trig', items: [
    { cmd: String.raw`\sin x`, desc: 'sine' },
    { cmd: String.raw`\cos^2 x + \sin^2 x = 1`, desc: 'Pythagorean' },
    { cmd: String.raw`\tan \theta`, desc: 'tangent' },
    { cmd: String.raw`\sec x \quad \csc x \quad \cot x`, desc: 'reciprocals' },
    { cmd: String.raw`\arcsin x`, desc: 'inverse sine' },
    { cmd: String.raw`\sin^{-1} x`, desc: 'inverse (alt.)' },
    { cmd: String.raw`\sin(2x) = 2\sin x \cos x`, desc: 'double angle' },
  ]},
  { title: 'Derivatives', items: [
    { cmd: "f'(x)", desc: 'first derivative' },
    { cmd: "f''(x)", desc: 'second derivative' },
    { cmd: String.raw`\frac{dy}{dx}`, desc: 'Leibniz notation' },
    { cmd: String.raw`\frac{d}{dx} x^2 = 2x`, desc: 'power rule' },
    { cmd: String.raw`\frac{\partial f}{\partial x}`, desc: 'partial derivative' },
    { cmd: String.raw`\lim_{x \to 0} \frac{\sin x}{x}`, desc: 'limit' },
    { cmd: String.raw`\nabla f`, desc: 'gradient' },
  ]},
  { title: 'Integrals', items: [
    { cmd: String.raw`\int f(x) \, dx`, desc: 'indefinite' },
    { cmd: String.raw`\int_{a}^{b} f(x) \, dx`, desc: 'definite' },
    { cmd: String.raw`\int_0^{\infty} e^{-x} \, dx`, desc: 'improper' },
    { cmd: String.raw`\iint_R f \, dA`, desc: 'double integral' },
    { cmd: String.raw`\oint_C f \, dz`, desc: 'contour integral' },
    { cmd: String.raw`\sum_{n=1}^{\infty} \frac{1}{n^2}`, desc: 'series sum' },
  ]},
];

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
  const [cheatOpen, setCheatOpen] = useState(false); // 📖 치트 시트 펼침 여부
  const copiedTimer = useRef(null);
  // 드로잉/결과 영속화 — sessionStorage에 저장/복원
  const sessionRef = useRef(loadSession());
  const persist = useCallback((patch) => {
    Object.assign(sessionRef.current, patch);
    saveSession(sessionRef.current);
  }, []);

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
    // 이전 세션 복원 — 드로잉 비트맵 + 결과/오류/뷰
    const s = sessionRef.current;
    if (s.dataUrl) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0); setHasInk(true); };
      img.src = s.dataUrl;
    }
    setView(s.view || 'draw');
    if (s.latex) setLatex(s.latex);
    if (s.error) setError(s.error);
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
    // 스트로크 완료 — 캔버스를 세션 캐시에 저장 (탭 전환 복원용)
    persist({ dataUrl: canvasRef.current.toDataURL('image/png') });
  }, [persist]);

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
    persist({ dataUrl: null, latex: '', view: 'draw', error: null });
  }, [persist]);

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
        persist({
          dataUrl: canvasRef.current.toDataURL('image/png'),
          latex: text,
          view: 'result',
          error: null,
        });
      }
    } catch (e) {
      const msg = e && e.message ? e.message : 'Conversion failed';
      setError(msg);
      persist({ error: msg });
    } finally {
      setBusy(false);
    }
  }, [persist]);

  const copy = useCallback((text) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1500);
    }).catch(() => { /* clipboard denied — 조용히 무시 */ });
  }, []);

  // LaTeX 수동 교정 — 편집 즉시 KaTeX 재렌더 + sessionStorage 반영 (잘못 렌더링 시 몇 번이고 수정)
  const onLatexChange = useCallback((v) => {
    setLatex(v);
    persist({ latex: v });
  }, [persist]);

  const rendered = latex
    ? katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: true, strict: false })
    : '';

  return (
    <AppLayout className="to-katex">
      <div className="to-katex__head">
        <h1 className="to-katex__title">🧮 To KaTeX</h1>
        <span className="to-katex__hint">
          Draw a formula with your pen or finger — the server's GLM-OCR converts it to LaTeX, rendered here with KaTeX.
        </span>
        <a className="to-katex__docs" href={KATEX_DOCS_URL} target="_blank" rel="noreferrer">KaTeX Docs ↗</a>
      </div>

      {/* 📖 KaTeX 치트 시트 — 접었다 펼 수 있는 참조 */}
      <div className="to-katex__cheat">
        <button
          type="button"
          className="to-katex__cheat-toggle"
          onClick={() => setCheatOpen((v) => !v)}
          aria-expanded={cheatOpen}
        >
          📖 KaTeX Cheat Sheet {cheatOpen ? '▾' : '▸'}
        </button>
        {cheatOpen && (
          <div className="to-katex__cheat-body">
            {CHEATSHEET.map((cat) => (
              <section key={cat.title} className="to-katex__cs-cat">
                <h3 className="to-katex__cs-title">{cat.title}</h3>
                <div className="to-katex__cs-items">
                  {cat.items.map((it) => (
                    <div key={it.cmd} className="to-katex__cs-item">
                      <div className="to-katex__cs-left">
                        <code className="to-katex__cs-cmd">{it.cmd}</code>
                        <span className="to-katex__cs-desc">{it.desc}</span>
                      </div>
                      <span
                        className="to-katex__cs-out"
                        dangerouslySetInnerHTML={{ __html: renderInline(it.cmd) }}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
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
          <div className="to-katex__source-head">
            <span className="to-katex__source-label">LaTeX source — edit to correct</span>
            <a className="to-katex__docs" href={KATEX_DOCS_URL} target="_blank" rel="noreferrer">KaTeX Docs ↗</a>
          </div>
          <textarea
            className="to-katex__source"
            value={latex}
            onChange={(e) => onLatexChange(e.target.value)}
            spellCheck="false"
            rows="2"
          />
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
            onClick={() => { setView('draw'); persist({ view: 'draw' }); }}
          >✏️ Draw again</button>
        </div>
      )}
    </AppLayout>
  );
}

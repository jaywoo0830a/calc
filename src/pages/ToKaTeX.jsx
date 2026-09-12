import { useState, useRef, useCallback } from 'react';
import AppLayout from '../components/AppLayout.jsx';
import katex from 'katex';

// ═══════════════════════════════════════════════════════════════
// 🧮 KaTeX Playground — LaTeX를 입력하면 KaTeX로 즉시 렌더링하는
// 라이브 플레이그라운드. (하단 치트 시트를 클릭하면 커서 위치에 삽입)
// ═══════════════════════════════════════════════════════════════

// KaTeX 공식 지원 함수 표 (수식 교정 시 참조)
const KATEX_DOCS_URL = 'https://katex.org/docs/supported.html';

// 첫 진입 시 보여줄 샘플 수식
const DEFAULT_LATEX = String.raw`\int_{0}^{\infty} \frac{\sin x}{x} \, dx = \frac{\pi}{2}`;

const RENDER_OPTS = { throwOnError: false, trust: true, strict: false };

// KaTeX 공통 렌더 — 오류는 throw하지 않고 빨간 텍스트로 표시(throwOnError=false)
function renderTex(tex, displayMode) {
  return katex.renderToString(tex, { ...RENDER_OPTS, displayMode });
}

// 치트 시트 항목 인라인 렌더 (displayMode=false — 인라인 수식)
function renderInline(tex) {
  return katex.renderToString(tex, { ...RENDER_OPTS, displayMode: false });
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
  const [latex, setLatex] = useState(DEFAULT_LATEX);
  const [displayMode, setDisplayMode] = useState(true); // true=$$ 블록, false=인라인
  const [cheatOpen, setCheatOpen] = useState(false);     // 📖 치트 시트 펼침 여부
  const [copied, setCopied] = useState(null);
  const sourceRef = useRef(null);
  const copiedTimer = useRef(null);

  // 라이브 렌더 — 입력할 때마다 즉시 재계산 (throwOnError=false라 오류는 빨간 텍스트)
  const rendered = renderTex(latex, displayMode);

  // 치트 시트 항목을 커서 위치에 삽입
  const insertTemplate = useCallback((cmd) => {
    const el = sourceRef.current;
    const start = el ? el.selectionStart : latex.length;
    const end = el ? el.selectionEnd : latex.length;
    const next = latex.slice(0, start) + cmd + latex.slice(end);
    setLatex(next);
    requestAnimationFrame(() => {
      const pos = start + cmd.length;
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    });
  }, [latex]);

  const copy = useCallback((text) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1500);
    }).catch(() => { /* clipboard denied — 조용히 무시 */ });
  }, []);

  return (
    <AppLayout className="to-katex">
      <div className="to-katex__head">
        <h1 className="to-katex__title">🧮 KaTeX Playground</h1>
        <span className="to-katex__hint">
          Type LaTeX below and watch it render live — no server needed, everything happens in your browser.
        </span>
        <a className="to-katex__docs" href={KATEX_DOCS_URL} target="_blank" rel="noreferrer">KaTeX Docs ↗</a>
      </div>

      {/* 라이브 에디터 + 미리보기 */}
      <div className="to-katex__result">
        <textarea
          ref={sourceRef}
          className="to-katex__source"
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          spellCheck="false"
          rows="4"
          placeholder="\frac{a}{b} …"
        />
        <div className="to-katex__result-math" dangerouslySetInnerHTML={{ __html: rendered }} />
      </div>

      <div className="to-katex__actions">
        <button
          type="button"
          className={'to-katex__btn' + (displayMode ? ' to-katex__btn--active' : '')}
          onClick={() => setDisplayMode((v) => !v)}
          title="Toggle between block ($…$ display) and inline rendering"
        >
          {displayMode ? 'Display mode: on' : 'Display mode: off'}
        </button>
        <button type="button" className="to-katex__btn" onClick={() => copy(latex)}>
          {copied === latex ? '✓ Copied' : 'Copy LaTeX'}
        </button>
        <button type="button" className="to-katex__btn" onClick={() => copy('$$' + latex + '$$')}>
          {copied === '$$' + latex + '$$' ? '✓ Copied' : 'Copy $$…$$'}
        </button>
      </div>

      {/* 📖 KaTeX 치트 시트 — 접었다 펼 수 있는 참조 (클릭 → 에디터 커서 위치에 삽입) */}
      <div className="to-katex__cheat">
        <button
          type="button"
          className="to-katex__cheat-toggle"
          onClick={() => setCheatOpen((v) => !v)}
          aria-expanded={cheatOpen}
        >
          📖 KaTeX Cheat Sheet — click to insert {cheatOpen ? '▾' : '▸'}
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
                        <button
                          type="button"
                          className="to-katex__cs-cmd"
                          onClick={() => insertTemplate(it.cmd)}
                          title="Insert into the editor above"
                        >
                          {it.cmd}
                        </button>
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
    </AppLayout>
  );
}

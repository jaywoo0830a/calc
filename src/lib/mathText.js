// ═══════════════════════════════════════════════════════════════
// mathText — plain text → HTML with KaTeX math rendering
// $...$ (inline) and $$...$$ (display) segments are rendered via KaTeX;
// all other text is HTML-escaped, so the result is safe to inject with
// dangerouslySetInnerHTML. Used by Concepts (labels / CLEAR notes).
// ═══════════════════════════════════════════════════════════════
import katex from 'katex';

const KATEX_OPTS = { throwOnError: false, trust: true, strict: false };

/** HTML 이스케이프 — 비수식 텍스트는 그대로 이스케이프해 안전하게 주입 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 텍스트에서 $...$ / $$...$$ 수식만 KaTeX HTML로 렌더하고,
 * 나머지 텍스트는 HTML 이스케이프해서 반환한다.
 * - $$...$$: display math (문단/줄바꿈 허용, 닫히지 않으면 그대로 이스케이프)
 * - $...$  : inline math (빈 문단에서 중단 — 인라인 수식은 문단을 넘지 않음)
 * - 닫히지 않거나 렌더 실패한 수식은 원문 그대로 이스케이프해 표시
 */
export function renderMathText(text) {
  const s = String(text || '');
  if (!s.includes('$')) return escapeHtml(s);

  const out = [];
  let plain = '';
  let i = 0;
  const len = s.length;
  const flush = () => { if (plain) { out.push(escapeHtml(plain)); plain = ''; } };

  while (i < len) {
    // $$ display math
    if (s[i] === '$' && s[i + 1] === '$') {
      flush();
      const start = i;
      i += 2;
      let closed = false;
      while (i < len) {
        if (s[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '$') { i += 2; closed = true; break; }
        i++;
      }
      const raw = s.slice(start, i);
      if (closed) {
        const tex = raw.slice(2, -2).trim();
        try { out.push(katex.renderToString(tex, { ...KATEX_OPTS, displayMode: true })); }
        catch { out.push(escapeHtml(raw)); }
      } else {
        out.push(escapeHtml(raw));
      }
      continue;
    }
    // $ inline math (빈 문단에서 중단)
    if (s[i] === '$') {
      flush();
      const start = i;
      i++;
      let closed = false;
      while (i < len) {
        if (s[i] === '\n' && i + 1 < len && s[i + 1] === '\n') break;
        if (s[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (s[i] === '$') { i++; closed = true; break; }
        i++;
      }
      const raw = s.slice(start, i);
      if (closed && raw.length > 2) {
        const tex = raw.slice(1, -1).trim();
        try { out.push(katex.renderToString(tex, { ...KATEX_OPTS, displayMode: false })); }
        catch { out.push(escapeHtml(raw)); }
      } else {
        out.push(escapeHtml(raw));
      }
      continue;
    }
    plain += s[i];
    i++;
  }
  flush();
  return out.join('');
}

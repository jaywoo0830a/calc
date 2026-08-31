import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMathText } from './mathText.js';

test('plain text is escaped', () => {
  assert.equal(renderMathText('a < b & "c"'), 'a &lt; b &amp; &quot;c&quot;');
});

test('empty / no dollar returns escaped input', () => {
  assert.equal(renderMathText(''), '');
  assert.equal(renderMathText('just text'), 'just text');
});

test('inline math is rendered via KaTeX', () => {
  const html = renderMathText('force $F = ma$ here');
  assert.match(html, /class="katex"/);
  assert.ok(html.includes('here'));
  assert.ok(!html.includes('$'), 'dollar delimiters are consumed');
});

test('display math renders with katex-display', () => {
  const html = renderMathText('$$F = k \\frac{q_1 q_2}{r^2}$$');
  assert.match(html, /katex-display/);
});

test('multiple inline math segments', () => {
  const html = renderMathText('$a$ and $b$');
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
});

test('unclosed inline math stays as escaped text', () => {
  assert.equal(renderMathText('price $5'), 'price $5');
});

test('unclosed display math stays as escaped text', () => {
  assert.equal(renderMathText('a $$x'), 'a $$x');
});

test('invalid math falls back to escaped raw', () => {
  const html = renderMathText('$\\notacommand$');
  assert.ok(html.includes('notacommand'));
  assert.ok(!html.includes('$'), 'invalid math consumed by KaTeX fallback output');
});

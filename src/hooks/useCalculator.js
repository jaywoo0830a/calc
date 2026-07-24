import { useState, useCallback, useRef } from 'react';
import Decimal from 'decimal.js';

Decimal.set({ precision: 32, rounding: Decimal.ROUND_DOWN });

const OP_SYMBOL = { add: '+', sub: '−', mul: '×', div: '÷', pow: '^' };

function fmt(d) {
  let s = d.toFixed(32, Decimal.ROUND_DOWN);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}

// ── Scientific constants ──────────────────────────────────────────────────
const PI = new Decimal('3.1415926535897932384626433832795');
const E  = new Decimal('2.7182818284590452353602874713527');

// ── Trig helper: deg→rad ─────────────────────────────────────────────────
function toRad(d) { return d.times(PI).dividedBy(180); }

// ── Taylor-series trig for Decimal (high precision) ─────────────────────
function decimalSin(x) {
  // Reduce to [-π, π]
  const twoPi = PI.times(2);
  x = x.mod(twoPi);
  if (x.gt(PI)) x = x.minus(twoPi);
  if (x.lt(PI.negated())) x = x.plus(twoPi);

  let term = x;
  let sum = x;
  const xx = x.times(x);
  for (let n = 1; n < 20; n++) {
    term = term.times(xx).dividedBy((2 * n) * (2 * n + 1)).negated();
    sum = sum.plus(term);
    if (term.abs().lt('1e-30')) break;
  }
  return sum;
}

function decimalCos(x) {
  const twoPi = PI.times(2);
  x = x.mod(twoPi);
  if (x.gt(PI)) x = x.minus(twoPi);
  if (x.lt(PI.negated())) x = x.plus(twoPi);

  let term = new Decimal(1);
  let sum = new Decimal(1);
  const xx = x.times(x);
  for (let n = 1; n < 20; n++) {
    term = term.times(xx).dividedBy((2 * n - 1) * (2 * n)).negated();
    sum = sum.plus(term);
    if (term.abs().lt('1e-30')) break;
  }
  return sum;
}

function decimalTan(x) {
  const c = decimalCos(x);
  if (c.abs().lt('1e-30')) throw new Error('tan undefined');
  return decimalSin(x).dividedBy(c);
}

function decimalLn(x) {
  if (x.lte(0)) throw new Error('ln of non-positive');
  // Use Newton's method for ln
  let guess = new Decimal(Math.log(x.toNumber()));
  for (let i = 0; i < 15; i++) {
    const exp = decimalExp(guess);
    const diff = x.minus(exp).dividedBy(x.plus(exp));
    guess = guess.plus(diff.times(2));
    if (diff.abs().lt('1e-30')) break;
  }
  return guess;
}

function decimalExp(x) {
  // e^x via Taylor series
  if (x.abs().gt(100)) {
    if (x.isPos()) return new Decimal(Infinity);
    return new Decimal(0);
  }
  let term = new Decimal(1);
  let sum = new Decimal(1);
  for (let n = 1; n < 60; n++) {
    term = term.times(x).dividedBy(n);
    sum = sum.plus(term);
    if (term.abs().lt('1e-30')) break;
  }
  return sum;
}

function decimalFactorial(n) {
  if (!n.isInt() || n.isNeg()) throw new Error('factorial of non-integer');
  if (n.gt(1000)) throw new Error('factorial too large');
  let r = new Decimal(1);
  for (let i = 2; i <= n.toNumber(); i++) r = r.times(i);
  return r;
}

export function useCalculator() {
  const [display, setDisplay] = useState({ expression: '\u00A0', result: '0' });
  const [history, setHistory] = useState([]);
  const [sciMode, setSciMode] = useState(false);
  const state = useRef({ current: '', previous: '', operator: null, shouldReset: false });

  const update = useCallback((result, expression) => {
    setDisplay({ result: result ?? '0', expression: expression ?? '\u00A0' });
  }, []);

  const getExpr = useCallback((prev, op, cur) => {
    if (prev && op) return `${fmt(new Decimal(prev))} ${OP_SYMBOL[op]} ${cur || '0'}`;
    if (prev) return fmt(new Decimal(prev));
    return '\u00A0';
  }, []);

  const addHistory = useCallback((expr, res) => {
    setHistory((prev) => {
      const next = [{ id: Date.now(), expression: expr, result: res }, ...prev];
      return next.slice(0, 50); // keep last 50
    });
  }, []);

  const inputDigit = useCallback((value) => {
    const s = state.current;
    let cur = s.current;
    if (s.shouldReset) { cur = ''; s.shouldReset = false; }
    if (value === '.') {
      if (cur.includes('.')) return;
      if (cur === '') cur = '0';
    }
    cur = (cur === '0' && value !== '.') ? value : cur + value;
    s.current = cur;
    update(cur, getExpr(s.previous, s.operator, cur));
  }, [update, getExpr]);

  const compute = useCallback(() => {
    const s = state.current;
    if (!s.operator || !s.previous) return;
    const a = new Decimal(s.previous);
    const b = new Decimal(s.current || '0');
    let result;
    try {
      switch (s.operator) {
        case 'add': result = a.plus(b); break;
        case 'sub': result = a.minus(b); break;
        case 'mul': result = a.times(b); break;
        case 'div':
          if (b.isZero()) { update('Error', '\u00A0'); return; }
          result = a.dividedBy(b);
          break;
        case 'pow':
          result = decimalExp(decimalLn(a).times(b));
          break;
      }
      const out = fmt(result);
      const exprStr = `${fmt(a)} ${OP_SYMBOL[s.operator]} ${fmt(b)} =`;
      addHistory(exprStr, out);
      s.current = out;
      s.previous = '';
      s.operator = null;
      s.shouldReset = true;
      update(out, '\u00A0');
    } catch {
      update('Error', '\u00A0');
    }
  }, [update, addHistory]);

  const inputOperator = useCallback((op) => {
    const s = state.current;
    if (s.current === '' && s.previous === '') return;
    if (s.operator && s.current !== '' && !s.shouldReset) {
      const a = new Decimal(s.previous);
      const b = new Decimal(s.current || '0');
      let r;
      try {
        switch (s.operator) {
          case 'add': r = a.plus(b); break;
          case 'sub': r = a.minus(b); break;
          case 'mul': r = a.times(b); break;
          case 'div': if (b.isZero()) { update('Error', '\u00A0'); s.current = ''; s.previous = ''; s.operator = null; return; } r = a.dividedBy(b); break;
          case 'pow': r = decimalExp(decimalLn(a).times(b)); break;
        }
        s.current = '';
        s.previous = fmt(r);
      } catch { update('Error', '\u00A0'); return; }
    } else if (s.current !== '') {
      s.previous = s.current;
      s.current = '';
    }
    s.operator = op;
    s.shouldReset = false;
    update(fmt(new Decimal(s.previous)), getExpr(s.previous, op, ''));
  }, [update, getExpr]);

  // ── Scientific unary functions ──────────────────────────────────────────
  const applyUnary = useCallback((fn, fnName) => {
    const s = state.current;
    const val = s.current || s.previous || '0';
    const d = new Decimal(val);
    let result;
    try {
      switch (fn) {
        case 'sqrt':
          if (d.isNeg()) throw new Error('sqrt of negative');
          result = d.sqrt();
          break;
        case 'square': result = d.times(d); break;
        case 'sin': result = decimalSin(toRad(d)); break;
        case 'cos': result = decimalCos(toRad(d)); break;
        case 'tan': result = decimalTan(toRad(d)); break;
        case 'log': result = decimalLn(d).dividedBy(decimalLn(new Decimal(10))); break;
        case 'ln': result = decimalLn(d); break;
        case 'factorial': result = decimalFactorial(d); break;
        default: return;
      }
      const out = fmt(result);
      addHistory(`${fnName}(${fmt(d)}) =`, out);
      s.current = out;
      s.previous = '';
      s.operator = null;
      s.shouldReset = true;
      update(out, '\u00A0');
    } catch (e) {
      update('Error', '\u00A0');
    }
  }, [update, addHistory]);

  // ── Insert constant ─────────────────────────────────────────────────────
  const insertConstant = useCallback((constant) => {
    const s = state.current;
    const val = constant === 'pi' ? PI : E;
    const out = fmt(val);
    if (s.shouldReset) { s.shouldReset = false; }
    s.current = out;
    update(out, getExpr(s.previous, s.operator, out));
  }, [update, getExpr]);

  const clearAll = useCallback(() => {
    const s = state.current;
    s.current = ''; s.previous = ''; s.operator = null; s.shouldReset = false;
    update('0', '\u00A0');
  }, [update]);

  const negate = useCallback(() => {
    const s = state.current;
    if (s.current) {
      s.current = s.current.startsWith('-') ? s.current.slice(1) : '-' + s.current;
      update(s.current, getExpr(s.previous, s.operator, s.current));
    } else if (s.previous) {
      s.previous = s.previous.startsWith('-') ? s.previous.slice(1) : '-' + s.previous;
      update(fmt(new Decimal(s.previous)), getExpr(s.previous, s.operator, s.current));
    }
  }, [update, getExpr]);

  const backspace = useCallback(() => {
    const s = state.current;
    if (s.shouldReset) return;
    if (s.current.length > 0) {
      s.current = s.current.slice(0, -1);
      update(s.current || '0', getExpr(s.previous, s.operator, s.current));
    }
  }, [update, getExpr]);

  const clearHistory = useCallback(() => setHistory([]), []);

  const toggleSciMode = useCallback(() => setSciMode((p) => !p), []);

  return {
    expression: display.expression,
    result: display.result,
    history,
    sciMode,
    get current() { return state.current.current; },
    get operator() { return state.current.operator; },
    get shouldReset() { return state.current.shouldReset; },
    inputDigit, compute, inputOperator, clearAll, negate, backspace,
    applyUnary, insertConstant, clearHistory, toggleSciMode,
  };
}

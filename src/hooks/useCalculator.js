import { useState, useCallback, useRef } from 'react';
import Decimal from 'decimal.js';

// 내부 계산 정밀도는 높게 유지하고, 표시 자릿수만 사용자가 조절한다.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

const OP_SYMBOL = { add: '+', sub: '−', mul: '×', div: '÷', pow: '^' };

// 표시 포맷 — 유효숫자 sig 자리까지, 지나치게 크거나 작으면 지수 표기
function fmt(d, sig = 10) {
  if (!d || d.isNaN()) return 'NaN';
  if (d.isZero()) return '0';
  const sign = d.isNeg() ? '-' : '';
  const a = d.abs();
  const rounded = a.toSignificantDigits(sig);
  const exp = a.e; // Decimal 지수 (log10 내림)
  if (exp >= sig || exp < -6) return sign + rounded.toExponential();
  return sign + rounded.toFixed();
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

// atan — |x|≤1 급수, 그 외에는 atan(x)=sign·(π/2 − atan(1/|x|))
function decimalAtan(x) {
  const one = new Decimal(1);
  if (x.abs().lte(1)) {
    let term = x, sum = x;
    const xx = x.times(x);
    for (let n = 1; n < 60; n++) {
      term = term.times(xx).negated();
      const t = term.dividedBy(2 * n + 1);
      sum = sum.plus(t);
      if (t.abs().lt('1e-38')) break;
    }
    return sum;
  }
  const sign = x.isNeg() ? -1 : 1;
  return new Decimal(sign).times(PI.dividedBy(2).minus(decimalAtan(one.dividedBy(x.abs()))));
}

function decimalAsin(x) {
  const one = new Decimal(1);
  if (x.abs().gt(1)) throw new Error('asin out of range');
  if (x.abs().equals(1)) return PI.dividedBy(2).times(x.isNeg() ? -1 : 1);
  return decimalAtan(x.dividedBy(one.minus(x.times(x)).sqrt()));
}

function decimalAcos(x) {
  return PI.dividedBy(2).minus(decimalAsin(x));
}

export function useCalculator() {
  const [display, setDisplay] = useState({ expression: '\u00A0', result: '0' });
  const [history, setHistory] = useState([]);
  const [sciMode, setSciMode] = useState(false);       // false=일반 모드, true=공학용 모드
  const [degMode, setDegMode] = useState(true);        // true=DEG, false=RAD
  const [mem, setMem] = useState(null);                // 메모리 값 (문자열 또는 null)
  const [displayDigits, setDisplayDigitsState] = useState(() => {
    try { const s = Number(localStorage.getItem('calc_digits')); if (s >= 4 && s <= 16) return s; } catch {}
    return 10;
  });
  const state = useRef({ current: '', previous: '', operator: null, shouldReset: false });

  // 표시 자릿수 — 콜백이 재생성되지 않도록 ref로 동기화해 fmt에서 사용
  const digitsRef = useRef(displayDigits);
  digitsRef.current = displayDigits;
  const fmtD = useCallback((d) => fmt(d, digitsRef.current), []);

  const setDisplayDigits = useCallback((n) => {
    const v = Math.max(4, Math.min(16, Math.floor(Number(n)) || 10));
    setDisplayDigitsState(v);
    try { localStorage.setItem('calc_digits', String(v)); } catch {}
  }, []);

  const update = useCallback((result, expression) => {
    setDisplay({ result: result ?? '0', expression: expression ?? '\u00A0' });
  }, []);

  const getExpr = useCallback((prev, op, cur) => {
    if (prev && op) return `${fmtD(new Decimal(prev))} ${OP_SYMBOL[op]} ${cur || '0'}`;
    if (prev) return fmtD(new Decimal(prev));
    return '\u00A0';
  }, [fmtD]);

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
      const out = fmtD(result);
      const exprStr = `${fmtD(a)} ${OP_SYMBOL[s.operator]} ${fmtD(b)} =`;
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
        s.previous = fmtD(r);
      } catch { update('Error', '\u00A0'); return; }
    } else if (s.current !== '') {
      s.previous = s.current;
      s.current = '';
    }
    s.operator = op;
    s.shouldReset = false;
    update(fmtD(new Decimal(s.previous)), getExpr(s.previous, op, ''));
  }, [update, getExpr, fmtD]);

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
        case 'cube': result = d.times(d).times(d); break;
        case 'inv': result = new Decimal(1).dividedBy(d); break;
        case 'abs': result = d.abs(); break;
        case 'sin': result = decimalSin(degMode ? toRad(d) : d); break;
        case 'cos': result = decimalCos(degMode ? toRad(d) : d); break;
        case 'tan': result = decimalTan(degMode ? toRad(d) : d); break;
        // 역삼각 — 결과를 DEG면 도(°), RAD면 라디안으로
        case 'asin': result = decimalAsin(d); if (degMode) result = result.times(180).dividedBy(PI); break;
        case 'acos': result = decimalAcos(d); if (degMode) result = result.times(180).dividedBy(PI); break;
        case 'atan': result = decimalAtan(d); if (degMode) result = result.times(180).dividedBy(PI); break;
        case 'log': result = decimalLn(d).dividedBy(decimalLn(new Decimal(10))); break;
        case 'ln': result = decimalLn(d); break;
        case '10x': result = decimalExp(decimalLn(new Decimal(10)).times(d)); break;
        case 'ex': result = decimalExp(d); break;
        case 'factorial': result = decimalFactorial(d); break;
        default: return;
      }
      const out = fmtD(result);
      addHistory(`${fnName}(${fmtD(d)}) =`, out);
      s.current = out;
      s.previous = '';
      s.operator = null;
      s.shouldReset = true;
      update(out, '\u00A0');
    } catch (e) {
      update('Error', '\u00A0');
    }
  }, [update, addHistory, fmtD, degMode]);

  // ── Insert constant ─────────────────────────────────────────────────────
  const insertConstant = useCallback((constant) => {
    const s = state.current;
    const val = constant === 'pi' ? PI : E;
    const out = fmtD(val);
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
      update(fmtD(new Decimal(s.previous)), getExpr(s.previous, s.operator, s.current));
    }
  }, [update, getExpr, fmtD]);

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
  const toggleDegMode = useCallback(() => setDegMode((p) => !p), []);

  // ── 메모리 (MC / MR / M+) ──────────────────────────────────
  const memClear = useCallback(() => setMem(null), []);
  const memRecall = useCallback(() => {
    if (mem == null) return;
    const s = state.current;
    s.current = mem;
    s.shouldReset = false;
    update(mem, getExpr(s.previous, s.operator, mem));
  }, [mem, update, getExpr]);
  const memAdd = useCallback(() => {
    const s = state.current;
    const val = new Decimal(s.current || s.previous || '0');
    setMem((m) => (m == null ? fmtD(val) : fmtD(new Decimal(m).plus(val))));
  }, [fmtD]);

  return {
    expression: display.expression,
    result: display.result,
    history,
    sciMode,
    degMode,
    displayDigits,
    mem,
    get current() { return state.current.current; },
    get operator() { return state.current.operator; },
    get shouldReset() { return state.current.shouldReset; },
    inputDigit, compute, inputOperator, clearAll, negate, backspace,
    applyUnary, insertConstant, clearHistory, toggleSciMode,
    setDisplayDigits, toggleDegMode, memClear, memRecall, memAdd,
  };
}

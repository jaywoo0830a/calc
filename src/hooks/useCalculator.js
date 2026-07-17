import { useState, useCallback, useRef } from 'react';
import Decimal from 'decimal.js';

Decimal.set({ precision: 32, rounding: Decimal.ROUND_DOWN });

const OP_SYMBOL = { add: '+', sub: '−', mul: '×', div: '÷' };

function fmt(d) {
  let s = d.toFixed(32, Decimal.ROUND_DOWN);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s;
}

export function useCalculator() {
  const [display, setDisplay] = useState({ expression: '\u00A0', result: '0' });
  const state = useRef({ current: '', previous: '', operator: null, shouldReset: false });

  const update = useCallback((result, expression) => {
    setDisplay({ result: result ?? '0', expression: expression ?? '\u00A0' });
  }, []);

  const getExpr = useCallback((prev, op, cur) => {
    if (prev && op) return `${fmt(new Decimal(prev))} ${OP_SYMBOL[op]} ${cur || '0'}`;
    if (prev) return fmt(new Decimal(prev));
    return '\u00A0';
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
      }
      const out = fmt(result);
      s.current = out;
      s.previous = '';
      s.operator = null;
      s.shouldReset = true;
      update(out, '\u00A0');
    } catch {
      update('Error', '\u00A0');
    }
  }, [update]);

  const inputOperator = useCallback((op) => {
    const s = state.current;
    if (s.current === '' && s.previous === '') return;
    if (s.operator && s.current !== '' && !s.shouldReset) {
      // chain: compute previous first
      const a = new Decimal(s.previous);
      const b = new Decimal(s.current || '0');
      let r;
      try {
        switch (s.operator) {
          case 'add': r = a.plus(b); break;
          case 'sub': r = a.minus(b); break;
          case 'mul': r = a.times(b); break;
          case 'div': if (b.isZero()) { update('Error', '\u00A0'); s.current = ''; s.previous = ''; s.operator = null; return; } r = a.dividedBy(b); break;
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

  return {
    expression: display.expression,
    result: display.result,
    get current() { return state.current.current; },
    get operator() { return state.current.operator; },
    get shouldReset() { return state.current.shouldReset; },
    inputDigit, compute, inputOperator, clearAll, negate, backspace,
  };
}

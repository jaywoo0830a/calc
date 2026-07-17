/**
 * Calc — high-precision arithmetic calculator
 * decimal.js · 32-digit precision · truncated (PHP BCMATH style)
 */

Decimal.set({ precision: 32, rounding: Decimal.ROUND_DOWN });

// Block all multi-touch zoom gestures at the document level
document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// ============================================================
//  Sound engine — Web Audio API, zero-dependency
// ============================================================

const Sound = (() => {
    let ctx = null;
    let muted = false;

    function init() {
        if (ctx) return;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
    }

    /** Play a short oscillator beep */
    function beep(freq, duration, type = 'sine', vol = 0.08) {
        if (muted || !ctx) return;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + duration);
    }

    return {
        /** Lazy-init AudioContext on first user gesture */
        unlock() { init(); },

        digit()   { beep(800, 0.04, 'sine', 0.06); },
        decimal() { beep(600, 0.05, 'sine', 0.05); },
        operator(){ beep(1100, 0.06, 'sine', 0.07); },
        equals()  {
            beep(1200, 0.08, 'sine', 0.08);
            setTimeout(() => beep(1600, 0.10, 'sine', 0.07), 60);
        },
        func()    { beep(500, 0.03, 'triangle', 0.05); },
        clear()   {
            beep(400, 0.07, 'triangle', 0.06);
            setTimeout(() => beep(250, 0.10, 'triangle', 0.05), 50);
        },
        error()   { beep(200, 0.15, 'square', 0.06); },

        toggle() {
            muted = !muted;
            return muted;
        },
        get muted() { return muted; },
    };
})();

// ============================================================
//  Calculator state & logic
// ============================================================

const exprEl   = document.getElementById('expression');
const resultEl = document.getElementById('result');

// --- state ---
let current     = '';    // active input buffer
let previous    = '';    // stored operand
let operator    = null;  // pending operator
let shouldReset = false; // display reset after equals

const opSymbol = { add: '+', sub: '−', mul: '×', div: '÷' };

// --- helpers ---

/** Format a Decimal: 32-digit toFixed then trim trailing zeros */
function fmt(d) {
    let s = d.toFixed(32, Decimal.ROUND_DOWN);
    if (s.includes('.')) {
        s = s.replace(/0+$/, '');
        if (s.endsWith('.')) s = s.slice(0, -1);
    }
    return s;
}

/** Update result line; shrink font when text is long */
function updateResult(text) {
    resultEl.textContent = text;
    resultEl.classList.toggle('small', text.length > 15);
}

/** Update expression line (formula preview) */
function updateExpression() {
    if (previous && operator) {
        exprEl.textContent = `${fmt(new Decimal(previous))} ${opSymbol[operator]} ${current || '0'}`;
    } else if (previous) {
        exprEl.textContent = fmt(new Decimal(previous));
    } else {
        exprEl.textContent = '\u00A0';
    }
}

/** Highlight the active operator button */
function highlightOp(op) {
    document.querySelectorAll('.btn.op').forEach(b => b.classList.remove('active'));
    if (op) {
        const btn = document.querySelector(`.btn.op[data-value="${op}"]`);
        if (btn) btn.classList.add('active');
    }
}

// --- core logic ---

function compute() {
    if (!operator || !previous) return;
    const a = new Decimal(previous);
    const b = new Decimal(current || '0');
    let result;
    try {
        switch (operator) {
            case 'add': result = a.plus(b); break;
            case 'sub': result = a.minus(b); break;
            case 'mul': result = a.times(b); break;
            case 'div':
                if (b.isZero()) { updateResult('Error'); Sound.error(); return; }
                result = a.dividedBy(b);
                break;
        }
    } catch {
        updateResult('Error');
        Sound.error();
        return;
    }
    current = fmt(result);
    previous = '';
    operator = null;
    highlightOp(null);
    updateResult(current);
    updateExpression();
    shouldReset = true;
}

function inputDigit(value) {
    if (shouldReset) { current = ''; shouldReset = false; }
    if (value === '.') {
        if (current.includes('.')) return;
        if (current === '') current = '0';
    }
    if (current === '0' && value !== '.') { current = value; }
    else { current += value; }
    updateResult(current);
    updateExpression();
}

function inputOperator(op) {
    if (current === '' && previous === '') return;
    if (operator && current !== '' && !shouldReset) compute();
    if (current !== '') { previous = current; current = ''; }
    operator = op;
    shouldReset = false;
    highlightOp(op);
    updateResult(fmt(new Decimal(previous)));
    updateExpression();
}

function clearAll() {
    current = '';
    previous = '';
    operator = null;
    shouldReset = false;
    highlightOp(null);
    updateResult('0');
    updateExpression();
}

function negate() {
    const target = current || previous;
    if (!target || target === '0') return;
    if (current) {
        current = current.startsWith('-') ? current.slice(1) : '-' + current;
        updateResult(current);
    } else {
        previous = previous.startsWith('-') ? previous.slice(1) : '-' + previous;
        updateResult(fmt(new Decimal(previous)));
    }
    updateExpression();
}

function backspace() {
    if (shouldReset) return;
    if (current.length > 0) {
        current = current.slice(0, -1);
        updateResult(current || '0');
        updateExpression();
    }
}

// --- event delegation ---
document.querySelector('.keypad').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    Sound.unlock();
    const action = btn.dataset.action;

    switch (action) {
        case 'digit':     Sound.digit();    inputDigit(btn.dataset.value); break;
        case 'decimal':   Sound.decimal();  inputDigit('.'); break;
        case 'operator':  Sound.operator(); inputOperator(btn.dataset.value); break;
        case 'equals':
            if (operator && current !== '' && !shouldReset) { Sound.equals(); compute(); }
            break;
        case 'clear':     Sound.clear();    clearAll(); break;
        case 'negate':    Sound.func();     negate(); break;
        case 'backspace': Sound.func();     backspace(); break;
    }
});

// --- keyboard support ---
document.addEventListener('keydown', (e) => {
    Sound.unlock();
    if (e.key >= '0' && e.key <= '9') { Sound.digit();    inputDigit(e.key); return; }
    if (e.key === '.')  { Sound.decimal();  inputDigit('.'); return; }
    if (e.key === '+')  { Sound.operator(); inputOperator('add'); return; }
    if (e.key === '-')  { Sound.operator(); inputOperator('sub'); return; }
    if (e.key === '*')  { Sound.operator(); inputOperator('mul'); return; }
    if (e.key === '/')  { e.preventDefault(); Sound.operator(); inputOperator('div'); return; }
    if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        if (operator && current !== '' && !shouldReset) { Sound.equals(); compute(); }
        return;
    }
    if (e.key === 'Escape')    { Sound.clear(); clearAll(); return; }
    if (e.key === 'Backspace') { Sound.func();  backspace(); return; }
});

// --- mute toggle ---
const muteBtn = document.getElementById('muteBtn');
muteBtn.addEventListener('click', () => {
    Sound.unlock();
    const muted = Sound.toggle();
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.classList.toggle('muted', muted);
});

import { useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import Display from '../components/Display.jsx';
import Keypad from '../components/Keypad.jsx';
import { useCalculator, SI_PREFIX_KEYS } from '../hooks/useCalculator.js';
import { useSound } from '../hooks/useSound.js';

const UNARY_NAMES = { sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', ln: 'ln', sqrt: '\u221A', square: 'sqr', factorial: '!' };

export default function Calculator() {
  const calc = useCalculator();
  const sound = useSound();
  const [muted, setMuted] = useState(false);
  const [invMode, setInvMode] = useState(false);   // 공학용 2nd(INV)
  const [precOpen, setPrecOpen] = useState(false); // 정밀도 메뉴
  const [siOpen, setSiOpen] = useState(false);     // SI 접두사 팔레트
  const [siTop, setSiTop] = useState(0);           // 팔레트 고정 위치 (버튼 아래)
  const siBtnRef = useRef(null);

  const handleAction = useCallback((action, value) => {
    sound.unlock();
    if (document.activeElement) document.activeElement.blur();
    switch (action) {
      case 'digit':     sound.play('digit');    calc.inputDigit(value); break;
      case 'decimal':   sound.play('decimal');  calc.inputDigit('.'); break;
      case 'operator':  sound.play('operator'); calc.inputOperator(value); break;
      case 'equals':
        if (calc.operator && calc.current !== '' && !calc.shouldReset) { sound.play('equals'); calc.compute(); }
        break;
      case 'clear':     sound.play('clear');  calc.clearAll(); break;
      case 'negate':    sound.play('func');   calc.negate(); break;
      case 'backspace': sound.play('func');   calc.backspace(); break;
      case 'unary':     sound.play('func');   calc.applyUnary(value, UNARY_NAMES[value] || value); break;
      case 'const':     sound.play('digit');  calc.insertConstant(value); break;
      case 'prefix':    sound.play('func');
        if (value === 'SI') calc.toSI();
        else calc.inputPrefix(value);
        break;
      case 'sciToggle': sound.play('func');   calc.toggleSciMode(); break;
      case 'degToggle': sound.play('func');   calc.toggleDegMode(); break;
      case 'toggleInv': sound.play('func');   setInvMode((p) => !p); break;
      case 'mem':
        sound.play('func');
        if (value === 'clear') calc.memClear();
        else if (value === 'recall') calc.memRecall();
        else if (value === 'add') calc.memAdd();
        break;
      case 'temp':
        sound.play('func');
        if (value === 'store') calc.tempStore();
        else calc.tempRecall();
        break;
    }
  }, [sound, calc]);

  const toggleMute = () => { sound.unlock(); setMuted(sound.toggle()); };

  const handleKeyDown = useCallback((e) => {
    sound.unlock();
    if (e.key >= '0' && e.key <= '9') { sound.play('digit'); calc.inputDigit(e.key); return; }
    if (e.key === '.')  { sound.play('decimal');  calc.inputDigit('.'); return; }
    if (e.key === '+')  { sound.play('operator'); calc.inputOperator('add'); return; }
    if (e.key === '-')  { sound.play('operator'); calc.inputOperator('sub'); return; }
    if (e.key === '*')  { sound.play('operator'); calc.inputOperator('mul'); return; }
    if (e.key === '/')  { e.preventDefault(); sound.play('operator'); calc.inputOperator('div'); return; }
    if (e.key === '^')  { sound.play('operator'); calc.inputOperator('pow'); return; }
    if (e.key === 'Enter' || e.key === '=') {
      e.preventDefault();
      if (calc.operator && calc.current !== '' && !calc.shouldReset) { sound.play('equals'); calc.compute(); }
      return;
    }
    if (e.key === 'Escape')    { sound.play('clear'); calc.clearAll(); return; }
    if (e.key === 'Backspace') { sound.play('func');  calc.backspace(); return; }
  }, [sound, calc]);

  return (
    <main className={'calculator' + (calc.sciMode ? ' calculator--sci' : '')} onKeyDown={handleKeyDown} tabIndex={-1}>
      <nav className="calculator__nav">
        <span className="calculator__nav-tab calculator__nav-tab--active">Calc</span>
        <Link to="/viewer" className="calculator__nav-tab">Viewer</Link>
        <Link to="/playground" className="calculator__nav-tab">Three.js</Link>
        <Link to="/math" className="calculator__nav-tab">Math Space</Link>
        <Link to="/fields" className="calculator__nav-tab">Fields</Link>
        <Link to="/problems" className="calculator__nav-tab">Problems</Link>
        <Link to="/vocab" className="calculator__nav-tab">Vocab</Link>
      </nav>
      <Display expression={calc.expression} result={calc.result} temp={calc.temp} />
      <div className="calculator__toolbar">
        <div className="calculator__mode-switch" role="group" aria-label="Calculator mode">
          <button
            className={'calculator__mode-btn' + (!calc.sciMode ? ' calculator__mode-btn--active' : '')}
            onClick={() => { if (calc.sciMode) handleAction('sciToggle'); }}
          >Basic</button>
          <button
            className={'calculator__mode-btn' + (calc.sciMode ? ' calculator__mode-btn--active' : '')}
            onClick={() => { if (!calc.sciMode) handleAction('sciToggle'); }}
          >Scientific</button>
        </div>
        {calc.sciMode && (
          <button
            className={'calculator__deg' + (calc.degMode ? '' : ' calculator__deg--rad')}
            onClick={() => handleAction('degToggle')}
            title="Toggle DEG / RAD"
          >{calc.degMode ? 'DEG' : 'RAD'}</button>
        )}
        <div className="calculator__si-wrap">
          <button
            ref={siBtnRef}
            className="calculator__si"
            onClick={() => {
              const r = siBtnRef.current?.getBoundingClientRect();
              if (r) setSiTop(Math.min(r.bottom + 6, window.innerHeight - 230));
              setSiOpen((p) => !p);
            }}
            title="SI prefixes — multiply the value (µ, k, G, …) or auto-convert"
          >SI</button>
          {siOpen && (
            <div
              className="calculator__si-menu"
              style={{ position: 'fixed', top: siTop, left: '50%', transform: 'translateX(-50%)' }}
            >
              <div className="calculator__si-grid">
                {SI_PREFIX_KEYS.map((p) => (
                  <button
                    key={p.sym}
                    className="calculator__si-opt"
                    onClick={() => { setSiOpen(false); handleAction('prefix', p.sym); }}
                    title={`×10^${p.exp} — ${p.sym}`}
                  >{p.sym}</button>
                ))}
              </div>
              <button
                className="calculator__si-auto"
                onClick={() => { setSiOpen(false); handleAction('prefix', 'SI'); }}
                title="Convert to the most readable prefix"
              >⇄ Auto — best prefix</button>
            </div>
          )}
        </div>
        <div className="calculator__prec-wrap">
          <button className="calculator__prec" onClick={() => setPrecOpen((p) => !p)} title="Display precision">
            Digits {calc.displayDigits}
          </button>
          {precOpen && (
            <div className="calculator__prec-menu">
              {[6, 8, 10, 12, 16].map((n) => (
                <button
                  key={n}
                  className={'calculator__prec-opt' + (calc.displayDigits === n ? ' calculator__prec-opt--active' : '')}
                  onClick={() => { calc.setDisplayDigits(n); setPrecOpen(false); }}
                >{n} digits</button>
              ))}
            </div>
          )}
        </div>
      </div>
      {precOpen && <div className="calculator__prec-backdrop" onClick={() => setPrecOpen(false)} />}
      {siOpen && <div className="calculator__si-backdrop" onClick={() => setSiOpen(false)} />}
      <Keypad onAction={handleAction} sciMode={calc.sciMode} invMode={invMode} />
      <footer className="calculator__footer">
        <p className="calculator__info">32-digit precision &middot; truncated (PHP BCMATH style)</p>
        <button className={'calculator__mute' + (muted ? ' calculator__mute--muted' : '')} onClick={toggleMute} aria-label="Toggle sound">
          {muted ? '🔇' : '🔊'}
        </button>
      </footer>
    </main>
  );
}

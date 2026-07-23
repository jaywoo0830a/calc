import { useState, useCallback } from 'react';
import Display from '../components/Display.jsx';
import Keypad from '../components/Keypad.jsx';
import { useCalculator } from '../hooks/useCalculator.js';
import { useSound } from '../hooks/useSound.js';

export default function Calculator() {
  const calc = useCalculator();
  const sound = useSound();
  const [muted, setMuted] = useState(false);

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
    if (e.key === 'Enter' || e.key === '=') {
      e.preventDefault();
      if (calc.operator && calc.current !== '' && !calc.shouldReset) { sound.play('equals'); calc.compute(); }
      return;
    }
    if (e.key === 'Escape')    { sound.play('clear'); calc.clearAll(); return; }
    if (e.key === 'Backspace') { sound.play('func');  calc.backspace(); return; }
  }, [sound, calc]);

  const [hintVisible, setHintVisible] = useState(() => !navigator.standalone);

  return (
    <main className="calculator" onKeyDown={handleKeyDown} tabIndex={-1}>
      <nav className="calculator__nav">
        <span className="calculator__nav-tab calculator__nav-tab--active">Calc</span>
        <a href="/viewer" className="calculator__nav-tab">Viewer</a>
        <a href="/proxy" className="calculator__nav-tab">Proxy</a>
      </nav>
      <Display expression={calc.expression} result={calc.result} />
      <Keypad onAction={handleAction} />
      <footer className="calculator__footer">
        <p className="calculator__info">32-digit precision &middot; truncated (PHP BCMATH style)</p>
        <button className={'calculator__mute' + (muted ? ' calculator__mute--muted' : '')} onClick={toggleMute} aria-label="Toggle sound">
          {muted ? '🔇' : '🔊'}
        </button>
      </footer>
      {hintVisible && (
        <div className="calculator__hint">
          <span>Tap <strong>Share</strong> &rarr; <strong>Add to Home Screen</strong></span>
          <button className="calculator__hint-close" onClick={() => setHintVisible(false)}>&times;</button>
        </div>
      )}
    </main>
  );
}

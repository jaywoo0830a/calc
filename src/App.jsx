import { useState, useCallback } from 'react';
import Display from './components/Display.jsx';
import Keypad from './components/Keypad.jsx';
import { useCalculator } from './hooks/useCalculator.js';
import { useSound } from './hooks/useSound.js';

export default function App() {
  const calc = useCalculator();
  const sound = useSound();
  const [muted, setMuted] = useState(false);

  const handleAction = useCallback((action, value) => {
    sound.unlock();
    if (document.activeElement) document.activeElement.blur();

    switch (action) {
      case 'digit':    sound.play('digit');    calc.inputDigit(value); break;
      case 'decimal':  sound.play('decimal');  calc.inputDigit('.'); break;
      case 'operator': sound.play('operator'); calc.inputOperator(value); break;
      case 'equals':
        if (calc.operator && calc.current !== '' && !calc.shouldReset) {
          sound.play('equals');
          calc.compute();
        }
        break;
      case 'clear':    sound.play('clear');    calc.clearAll(); break;
      case 'negate':   sound.play('func');     calc.negate(); break;
      case 'backspace':sound.play('func');     calc.backspace(); break;
    }
  }, [sound, calc]);

  const toggleMute = () => {
    sound.unlock();
    const isMuted = sound.toggle();
    setMuted(isMuted);
  };

  // Keyboard support
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
      if (calc.operator && calc.current !== '' && !calc.shouldReset) {
        sound.play('equals');
        calc.compute();
      }
      return;
    }
    if (e.key === 'Escape')    { sound.play('clear'); calc.clearAll(); return; }
    if (e.key === 'Backspace') { sound.play('func');  calc.backspace(); return; }
  }, [sound, calc]);

  // iOS hint
  const [hintVisible, setHintVisible] = useState(
    () => !navigator.standalone
  );

  return (
    <div className="calculator" onKeyDown={handleKeyDown} tabIndex={-1}>
      <Display expression={calc.expression} result={calc.result} />
      <Keypad onAction={handleAction} />
      <div className="footer">
        <p className="info">32-digit precision &middot; truncated (PHP BCMATH style)</p>
        <button className={`mute-toggle${muted ? ' muted' : ''}`} onClick={toggleMute} aria-label="Toggle sound">
          {muted ? '🔇' : '🔊'}
        </button>
      </div>
      {hintVisible && (
        <div className="ios-hint">
          <span>📲 Tap <strong>Share</strong> → <strong>Add to Home Screen</strong> for the best experience</span>
          <button className="ios-hint-close" onClick={() => setHintVisible(false)}>&times;</button>
        </div>
      )}
    </div>
  );
}

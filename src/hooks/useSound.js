import { useRef, useCallback } from 'react';

export function useSound() {
  const ctxRef = useRef(null);
  const mutedRef = useRef(false);

  const unlock = useCallback(() => {
    if (!ctxRef.current) {
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
  }, []);

  const beep = useCallback((freq, duration, type = 'sine', vol = 0.08) => {
    if (mutedRef.current || !ctxRef.current) return;
    const ctx = ctxRef.current;
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
  }, []);

  const play = useCallback((type) => {
    switch (type) {
      case 'digit':    beep(800, 0.04, 'sine', 0.06); break;
      case 'decimal':  beep(600, 0.05, 'sine', 0.05); break;
      case 'operator': beep(1100, 0.06, 'sine', 0.07); break;
      case 'equals':
        beep(1200, 0.08, 'sine', 0.08);
        setTimeout(() => beep(1600, 0.10, 'sine', 0.07), 60);
        break;
      case 'func':     beep(500, 0.03, 'triangle', 0.05); break;
      case 'clear':
        beep(400, 0.07, 'triangle', 0.06);
        setTimeout(() => beep(250, 0.10, 'triangle', 0.05), 50);
        break;
      case 'timer':
        beep(880, 0.12, 'sine', 0.09);
        setTimeout(() => beep(880, 0.12, 'sine', 0.09), 180);
        setTimeout(() => beep(1320, 0.30, 'sine', 0.10), 360);
        break;
      case 'quick': // 30초 타이머 완료 — 짧은 두 번 알림
        beep(700, 0.10, 'sine', 0.09);
        setTimeout(() => beep(940, 0.12, 'sine', 0.08), 130);
        break;
    }
  }, [beep]);

  const toggle = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    return mutedRef.current;
  }, []);

  return { unlock, play, toggle };
}

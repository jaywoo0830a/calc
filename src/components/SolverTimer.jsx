import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSound } from '../hooks/useSound.js';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';

// 문제 풀이용 10분 카운트다운 타이머
const TOTAL_MS = 10 * 60 * 1000;

function formatTime(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SolverTimer() {
  const [remaining, setRemaining] = useState(TOTAL_MS);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const { unlock, play } = useSound();
  const portalTarget = useFullscreenPortal();

  // 1초 틱
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setRemaining((r) => r - 1000), 1000);
    return () => clearInterval(id);
  }, [running]);

  // 0:00 도달 → 정지 + 경고음
  useEffect(() => {
    if (running && remaining <= 0) {
      setRunning(false);
      setFinished(true);
      play('timer');
    }
  }, [remaining, running, play]);

  // 본체 탭: 시작 / 일시정지 / (종료 후) 리셋+재시작
  const toggle = useCallback(() => {
    unlock();
    if (finished) {
      setRemaining(TOTAL_MS);
      setFinished(false);
      setRunning(true);
      return;
    }
    setRunning((r) => !r);
  }, [finished, unlock]);

  // ↺: 정지하고 10:00으로 리셋
  const reset = useCallback(() => {
    unlock();
    setRunning(false);
    setFinished(false);
    setRemaining(TOTAL_MS);
  }, [unlock]);

  const icon = finished ? '⏰' : running ? '⏸' : '▶';
  const label = finished
    ? 'Time is up — tap to restart'
    : running
      ? 'Pause timer'
      : remaining === TOTAL_MS
        ? 'Start 10-minute timer'
        : 'Resume timer';

  // 첫 렌더에서는 포털 타깃(document.body)이 아직 준비되지 않으므로
  // null 가드가 없으면 createPortal(null 타깃) 런타임 에러로 앱이 깨진다.
  if (!portalTarget) return null;

  const timer = (
    <div
      className={
        'solver-timer' +
        (running ? ' solver-timer--running' : '') +
        (finished ? ' solver-timer--done' : '')
      }
    >
      <button className="solver-timer__main" onClick={toggle} aria-label={label} title={label}>
        <span className="solver-timer__icon" aria-hidden>{icon}</span>
        <span className="solver-timer__time">{formatTime(remaining)}</span>
      </button>
      <button
        className="solver-timer__reset"
        onClick={reset}
        aria-label="Reset timer to 10:00"
        title="Reset to 10:00"
      >↺</button>
    </div>
  );

  return createPortal(timer, portalTarget);
}

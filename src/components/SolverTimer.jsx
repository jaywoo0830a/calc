import { useState, useEffect, useCallback, useRef } from 'react';
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
  const finishedRef = useRef(false); // 재충전 직후 잔여 틱이 깎지 못하게 (레이스 방지)
  const { unlock, play } = useSound();
  const portalTarget = useFullscreenPortal();

  // 1초 틱 (완료 감지 후에는 decrement하지 않음)
  useEffect(() => {
    if (!running) return;
    finishedRef.current = false;
    const id = setInterval(() => {
      if (!finishedRef.current) setRemaining((r) => r - 1000);
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  // 0:00 도달 → 정지 + 경고음 + 자동으로 10:00 재충전 (0 상태 없음)
  useEffect(() => {
    if (running && remaining <= 0) {
      finishedRef.current = true; // 이후 틱이 재충전된 값을 깎지 않도록 즉시 차단
      setRunning(false);
      setFinished(true);
      setRemaining(TOTAL_MS); // 바로 다음 라운드 준비
      play('timer');
    }
  }, [remaining, running, play]);

  // 본체 탭: 시작 / 일시정지 / (종료 후) 바로 재시작 — remaining은 이미 재충전됨
  const toggle = useCallback(() => {
    unlock();
    if (finished) {
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

  // 완료 오버레이 닫기 (시간 완료 알림 확인)
  const dismiss = useCallback(() => { setFinished(false); }, []);

  // 완료 오버레이에서 Esc로도 닫기
  useEffect(() => {
    if (!finished) return;
    const onKey = (e) => { if (e.key === 'Escape') setFinished(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finished]);

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
    <>
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
        {/* 진행 중이거나 일부 경과했으면 ↺ 리셋 배지 (완료 시엔 탭 = 리셋+재시작) */}
        {!finished && (running || remaining < TOTAL_MS) && (
          <button
            className="solver-timer__reset"
            onClick={reset}
            aria-label="Reset timer to 10:00"
            title="Reset to 10:00"
          >↺</button>
        )}
      </div>

      {/* 시간 완료 → 화면 전체 오버레이 (소리와 함께 시각적으로 알림) */}
      {finished && (
        <div
          className="solver-timer__overlay"
          onClick={dismiss}
          role="alertdialog"
          aria-modal="true"
          aria-label="Timer finished"
        >
          <div className="solver-timer__overlay-card" onClick={(e) => e.stopPropagation()}>
            <div className="solver-timer__overlay-icon" aria-hidden>⏰</div>
            <div className="solver-timer__overlay-title">Time's up!</div>
            <div className="solver-timer__overlay-sub">Keep thinking, or check the solutions</div>
            <button className="solver-timer__overlay-btn" onClick={dismiss} autoFocus>OK</button>
          </div>
        </div>
      )}
    </>
  );

  return createPortal(timer, portalTarget);
}

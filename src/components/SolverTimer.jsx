import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSound } from '../hooks/useSound.js';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';

// 문제 풀이용 10분 카운트다운 타이머
const TOTAL_MS = 10 * 60 * 1000;
const EXTEND_MS = 5 * 60 * 1000; // 완료 시 1회만 가능한 +5분 연장
const QUICK_MS = 30 * 1000; // 한 문제 풀지 말지 결정하는 30초 타이머

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
  const [extended, setExtended] = useState(false); // 이번 라운드에 +5분 연장을 이미 썼는지
  const [quickRemaining, setQuickRemaining] = useState(QUICK_MS); // 30초 타이머
  const [quickRunning, setQuickRunning] = useState(false);
  const [quickDone, setQuickDone] = useState(false);
  const quickDoneRef = useRef(false); // 30초 완료 직후 잔여 틱 레이스 방지
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

  // ── 30초 타이머 틱 ──
  useEffect(() => {
    if (!quickRunning) return;
    quickDoneRef.current = false;
    const id = setInterval(() => {
      if (!quickDoneRef.current) setQuickRemaining((r) => r - 1000);
    }, 1000);
    return () => clearInterval(id);
  }, [quickRunning]);

  // 30초 완료 → 정지 + 짧은 알림음 + 0:00으로 리셋 (붉은 완료 상태, 오버레이 없음)
  useEffect(() => {
    if (quickRunning && quickRemaining <= 0) {
      quickDoneRef.current = true;
      setQuickRunning(false);
      setQuickDone(true);
      setQuickRemaining(0);
      play('quick');
    }
  }, [quickRemaining, quickRunning, play]);

  // ⚡ 30초 타이머 — 단순 3상태:
  //   초기(0:30) → 누름 → 카운트다운
  //   카운트다운 중 누름 → 정지 + 초기(0:30)로 초기화
  //   0:00 완료(빨간 펄스) → 누름 → 초기(0:30)로
  const toggleQuick = useCallback(() => {
    unlock();
    quickDoneRef.current = false;
    if (quickRunning) {
      setQuickRunning(false);
      setQuickDone(false);
      setQuickRemaining(QUICK_MS);
      return;
    }
    if (quickDone) {
      setQuickDone(false);
      setQuickRemaining(QUICK_MS);
      return;
    }
    setQuickRemaining(QUICK_MS);
    setQuickRunning(true);
  }, [unlock, quickRunning, quickDone]);

  // 본체 탭: 시작 / 일시정지 / (종료 후) 바로 재시작 — remaining은 이미 재충전됨
  const toggle = useCallback(() => {
    unlock();
    if (finished) {
      setFinished(false);
      setExtended(false); // 새 10분 라운드 시작 → 연장 다시 가능
      setRunning(true);
      return;
    }
    // 새 라운드를 10:00에서 시작하면 연장 기회 리셋 (일시정지 재개는 유지)
    if (!running && remaining === TOTAL_MS) setExtended(false);
    setRunning((r) => !r);
  }, [finished, running, remaining, unlock]);

  // ↺: 정지하고 10:00으로 리셋 (연장 기회도 리셋)
  const reset = useCallback(() => {
    unlock();
    setRunning(false);
    setFinished(false);
    setExtended(false);
    setRemaining(TOTAL_MS);
  }, [unlock]);

  // ⏱ +5분 연장 — 완료 오버레이에서 1회만 사용 가능
  const extendTimer = useCallback(() => {
    unlock();
    setFinished(false);
    setExtended(true);
    setRemaining(EXTEND_MS);
    setRunning(true);
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
      {/* ⚡ 30초 타이머 — 10분 타이머 왼쪽 (문제 풀지 말지 결정용) */}
      <div
        className={
          'solver-timer solver-timer--quick' +
          (quickRunning ? ' solver-timer--running' : '') +
          (quickDone ? ' solver-timer--done' : '')
        }
      >
        <button
          className="solver-timer__main"
          onClick={toggleQuick}
          aria-label={quickDone ? '30 seconds up — click to reset' : quickRunning ? 'Reset 30-second timer' : 'Start 30-second timer'}
          title={quickDone ? '⚡ 30 seconds up — click to reset' : '⚡ 30 seconds — decide whether to solve this problem'}
        >
          <span className="solver-timer__icon" aria-hidden>⚡</span>
          <span className="solver-timer__time">{formatTime(quickRemaining)}</span>
        </button>
      </div>

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
            <div className="solver-timer__overlay-sub">
              {extended
                ? 'No more extensions this round'
                : 'Add 5 more minutes — once per round'}
            </div>
            <div className="solver-timer__overlay-actions">
              {!extended && (
                <button
                  className="solver-timer__overlay-btn solver-timer__overlay-btn--extend"
                  onClick={extendTimer}
                >
                  ⏱ +5:00
                </button>
              )}
              <button className="solver-timer__overlay-btn" onClick={dismiss} autoFocus>OK</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return createPortal(timer, portalTarget);
}

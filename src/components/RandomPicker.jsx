import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';

const randInt = (n) => Math.floor(Math.random() * n) + 1;

// ═══════════════════════════════════════════════════════════════
// RandomPicker — 🎲 랜덤 숫자 뽑기 (좌하단 플로팅, ⏱ 타이머 옆)
// 여러 연습 문제 중 뭘 풀지 고민할 때 1~N 범위에서 숫자를 뽑아준다.
// 문서에 목차(문제 목록)가 있으면 N이 자동으로 문제 수로 설정되고,
// 뽑힌 번호에 해당하는 문제로 바로 이동할 수 있다.
// ═══════════════════════════════════════════════════════════════
export default function RandomPicker({ toc = [], onJumpHeading }) {
  const [open, setOpen] = useState(false);
  const [max, setMax] = useState(20);
  const maxTouched = useRef(false);
  const [result, setResult] = useState(null);
  const [rolling, setRolling] = useState(false);
  const rollTimer = useRef(null);
  const portalTarget = useFullscreenPortal();

  // 문서에 목차(문제 목록)가 있으면 기본 범위를 문제 수로 설정 (사용자가 안 건드렸을 때만)
  useEffect(() => {
    if (!maxTouched.current && toc.length > 0) setMax(toc.length);
  }, [toc]);

  // 언마운트 시 롤 타이머 정리
  useEffect(() => () => { if (rollTimer.current) clearTimeout(rollTimer.current); }, []);

  // 🔢 숫자 뽑기
  const rollNumber = useCallback(() => {
    const n = Math.max(1, Math.floor(Number(max)) || 1);
    setRolling(true);
    setResult(null);
    if (rollTimer.current) clearTimeout(rollTimer.current);
    rollTimer.current = setTimeout(() => {
      setResult(randInt(n));
      setRolling(false);
    }, 350);
  }, [max]);

  const jumpToNumber = useCallback(() => {
    if (result == null || !toc[result - 1]) return;
    setOpen(false);
    onJumpHeading(toc[result - 1].id);
  }, [result, toc, onJumpHeading]);

  // 바깥 클릭 / Esc → 패널 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => { if (!e.target.closest('.random-picker')) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
    };
  }, [open]);

  if (!portalTarget) return null;

  return createPortal(
    <div className="random-picker">
      <button
        className={'random-picker__btn' + (open ? ' random-picker__btn--open' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-pressed={open}
        aria-label="Random number picker"
        title="Random number picker — pick which problem to solve"
      >🎲</button>

      {open && (
        <div className="random-picker__panel">
          <div className="random-picker__header">
            <span>🎲 숫자 뽑기</span>
            <button className="random-picker__close" onClick={() => setOpen(false)}>×</button>
          </div>

          <div className="random-picker__body">
            <div className="random-picker__range">
              <label>범위</label>
              <span>1 –</span>
              <input
                type="number"
                min="1"
                max="999"
                value={max}
                onChange={(e) => { maxTouched.current = true; setMax(Number(e.target.value) || 1); }}
              />
            </div>
            <div className={'random-picker__result' + (rolling ? ' random-picker__result--rolling' : '')}>
              {rolling ? '🎲' : (result ?? '–')}
            </div>
            <button className="random-picker__roll" onClick={rollNumber} disabled={rolling}>
              {rolling ? '…' : '🎲 뽑기'}
            </button>
            {result != null && toc[result - 1] && (
              <button className="random-picker__action" onClick={jumpToNumber}>
                {result}번으로 이동 — {toc[result - 1].text}
              </button>
            )}
          </div>
        </div>
      )}
    </div>,
    portalTarget
  );
}

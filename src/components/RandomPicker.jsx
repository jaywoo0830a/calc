import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFullscreenPortal } from '../lib/fullscreenPortal.js';

// ZIP 트리에서 파일 노드만 모은다
function collectFiles(tree, out = []) {
  if (!tree) return out;
  if (tree.children) {
    for (const child of Object.values(tree.children)) collectFiles(child, out);
  } else if (tree.file && !tree.isDir) {
    out.push(tree);
  }
  return out;
}

const randInt = (n) => Math.floor(Math.random() * n) + 1;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ═══════════════════════════════════════════════════════════════
// RandomPicker — 🎲 랜덤 뽑기 (좌하단 플로팅, ⏱ 타이머 옆)
// 여러 연습 문제 중 뭘 풀지 고민할 때:
//   🔢 숫자   → 1~N 범위에서 랜덤 숫자 (문서 문제 수로 자동 설정, 문제로 이동 가능)
//   📚 문제  → 현재 문서의 목차(문제) 중 하나를 랜덤 선택 후 이동
//   🗂 파일  → 열린 ZIP에서 랜덤 파일 선택 후 열기
// ═══════════════════════════════════════════════════════════════
export default function RandomPicker({ toc = [], zipTree = null, onJumpHeading, onOpenPath }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('number'); // number | problem | file
  const [max, setMax] = useState(20);
  const maxTouched = useRef(false);
  const [result, setResult] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [pickedHeading, setPickedHeading] = useState(null);
  const [pickedFile, setPickedFile] = useState(null);
  const rollTimer = useRef(null);
  const portalTarget = useFullscreenPortal();

  // 문서에 목차(문제 목록)가 있으면 기본 범위를 문제 수로 설정 (사용자가 안 건드렸을 때만)
  useEffect(() => {
    if (!maxTouched.current && toc.length > 0) setMax(toc.length);
  }, [toc]);

  // 언마운트 시 롤 타이머 정리
  useEffect(() => () => { if (rollTimer.current) clearTimeout(rollTimer.current); }, []);

  const files = useCallback(() => collectFiles(zipTree), [zipTree]);

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

  // 📚 문서에서 문제 뽑기
  const pickProblem = useCallback(() => {
    if (toc.length === 0) return;
    setPickedHeading(pick(toc));
    setPickedFile(null);
    setResult(null);
  }, [toc]);

  const openPickedProblem = useCallback(() => {
    if (!pickedHeading) return;
    setOpen(false);
    onJumpHeading(pickedHeading.id);
  }, [pickedHeading, onJumpHeading]);

  // 🗂 ZIP에서 파일 뽑기
  const pickFile = useCallback(() => {
    const list = files();
    if (list.length === 0) return;
    setPickedFile(pick(list));
    setPickedHeading(null);
    setResult(null);
  }, [files]);

  const openPickedFile = useCallback(() => {
    if (!pickedFile) return;
    setOpen(false);
    onOpenPath(pickedFile.path);
  }, [pickedFile, onOpenPath]);

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
        aria-label="Random pick — number / problem / file"
        title="Random pick — number / problem / file"
      >🎲</button>

      {open && (
        <div className="random-picker__panel">
          <div className="random-picker__header">
            <span>🎲 Random Pick</span>
            <button className="random-picker__close" onClick={() => setOpen(false)}>×</button>
          </div>

          <div className="random-picker__tabs">
            <button
              className={'random-picker__tab' + (mode === 'number' ? ' random-picker__tab--active' : '')}
              onClick={() => setMode('number')}
            >🔢 숫자</button>
            <button
              className={'random-picker__tab' + (mode === 'problem' ? ' random-picker__tab--active' : '')}
              onClick={() => setMode('problem')}
            >📚 문제</button>
            <button
              className={'random-picker__tab' + (mode === 'file' ? ' random-picker__tab--active' : '')}
              onClick={() => setMode('file')}
            >🗂 파일</button>
          </div>

          {mode === 'number' && (
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
          )}

          {mode === 'problem' && (
            <div className="random-picker__body">
              {toc.length === 0 ? (
                <div className="random-picker__empty">이 문서에는 목차(문제 목록)가 없습니다.</div>
              ) : (
                <>
                  <button className="random-picker__action" onClick={pickProblem}>🎲 이 문서에서 문제 뽑기</button>
                  {pickedHeading && (
                    <div className="random-picker__picked">
                      <span className="random-picker__picked-text">{pickedHeading.text}</span>
                      <button className="random-picker__action random-picker__action--small" onClick={openPickedProblem}>이동</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'file' && (
            <div className="random-picker__body">
              {files().length === 0 ? (
                <div className="random-picker__empty">열린 ZIP이 없습니다.</div>
              ) : (
                <>
                  <button className="random-picker__action" onClick={pickFile}>🎲 ZIP에서 파일 뽑기</button>
                  {pickedFile && (
                    <div className="random-picker__picked">
                      <span className="random-picker__picked-text">{pickedFile.name}</span>
                      <button className="random-picker__action random-picker__action--small" onClick={openPickedFile}>열기</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>,
    portalTarget
  );
}

import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';

// ═══════════════════════════════════════════════════════════════
// ClearGate — 전체 삭제 같은 파괴적 작업 전 비밀번호 확인 모달
// server/config.js의 clearAllPassword와 대조 (서버 검증)
// ═══════════════════════════════════════════════════════════════
export default function ClearGate({ open, title = 'Confirm', onCancel, onConfirm }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPw('');
      setError(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const submit = () => {
    if (checking) return;
    setChecking(true);
    setError(false);
    api.verifyClearPassword(pw).then(() => {
      setChecking(false);
      onConfirm();
    }).catch(() => {
      setChecking(false);
      setError(true);
      setPw('');
      inputRef.current?.focus();
    });
  };

  return (
    <div className="clear-gate" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="clear-gate__card" onClick={(e) => e.stopPropagation()}>
        <div className="clear-gate__icon" aria-hidden>🔒</div>
        <div className="clear-gate__title">{title}</div>
        <input
          ref={inputRef}
          className="clear-gate__input"
          type="password"
          placeholder="Enter password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
        />
        {error && <div className="clear-gate__error">Wrong password</div>}
        <div className="clear-gate__actions">
          <button className="clear-gate__btn clear-gate__btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="clear-gate__btn" onClick={submit} disabled={checking}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

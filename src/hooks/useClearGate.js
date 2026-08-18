import { useState, useCallback } from 'react';
import { api } from '../lib/api.js';

// ═══════════════════════════════════════════════════════════════
// 파괴적 작업 게이트 — 비밀번호 검증으로 발급된 세션 토큰이
// 이미 있으면 바로 실행하고, 없으면 ClearGate 모달로 승인받는다.
// (한 번 입력하면 같은 세션 동안 다른 파괴적 작업도 재입력 없이 통과)
// ═══════════════════════════════════════════════════════════════
export function useClearGate() {
  const [gate, setGate] = useState(null); // { title, action }

  const requireClear = useCallback((title, action) => {
    if (api.hasClearToken()) {
      action();
      return;
    }
    setGate({ title, action });
  }, []);

  const gateProps = {
    open: !!gate,
    title: gate?.title || 'Confirm',
    onCancel: () => setGate(null),
    onConfirm: () => {
      const action = gate?.action;
      setGate(null);
      action();
    },
  };

  return { requireClear, gateProps };
}

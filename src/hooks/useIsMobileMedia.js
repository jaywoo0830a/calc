import { useEffect, useState } from 'react';

/**
 * useIsMobileMedia — matchMedia 기반 반응형 플래그 훅.
 * @param {string} query — 기본 '(max-width: 767px)'
 * @returns {boolean}
 */
export function useIsMobileMedia(query = '(max-width: 767px)') {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

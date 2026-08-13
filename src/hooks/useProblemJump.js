import { useState, useRef, useEffect, useCallback } from 'react';

// ── 마크다운 문제 점프 (locate + scroll + 재시도) ─────────────────────────────
// Viewer에서 분리한 커스텀 훅. 저장된 좌표(ref) 또는 텍스트 검색으로
// .viewer__content 안의 문제 위치를 찾아 정확한 Range 하이라이트와
// scrollIntoView 중심 정렬을 수행한다.

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const BLOCK_RE = /^(P|H[1-6]|LI|PRE|BLOCKQUOTE|TD|TH|TABLE|UL|OL|SECTION|DIV)$/i;

/** 텍스트 노드 → 점프 스크롤 타깃 블록 (루트 제외, 없으면 가장 가까운 요소) */
function closestBlock(node, root) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  let fallback = null;
  while (el && el !== document.body && el !== root) {
    if (!fallback) fallback = el;
    if (BLOCK_RE.test(el.tagName || '')) return el;
    el = el.parentElement;
  }
  return fallback;
}

/**
 * textContent 오프셋 → { node, offset }
 * ⚠️ 경계 조건 버그 수정: target이 노드 끝(current+len)에 정확히 걸리면
 *    다음 노드의 offset 0을 반환해야 한다. `>=`로 비교하면 직전 노드의 끝이
 *    반환되어 Range 시작점이 노드 경계의 "\n" 같은 루트 직속 텍스트 노드가 되고,
 *    블록 탐색이 루트로 올라가 null이 돼 점프가 실패했다.
 */
function nodeAtOffset(root, target) {
  let current = 0;
  let last = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (current + len > target) return { node, offset: target - current };
    last = { node, offset: len };
    current += len;
  }
  return target >= current ? last : null; // 문서 끝 = 마지막 노드 끝
}

/** raw 오프셋 범위 → Range (범위 텍스트가 기대값과 일치할 때만 반환 — 엉뚱한 곳 점프 차단) */
function buildRange(content, rawStart, rawEnd, expect) {
  const start = nodeAtOffset(content, rawStart);
  if (!start || start.offset > (start.node.textContent || '').length) return null;
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    if (rawEnd - rawStart <= (start.node.textContent || '').length - start.offset) {
      range.setEnd(start.node, start.offset + (rawEnd - rawStart));
    } else {
      const end = nodeAtOffset(content, rawEnd); // 여러 텍스트 노드에 걸친 선택
      if (!end) return null;
      range.setEnd(end.node, end.offset);
    }
    if (norm(range.toString()) === expect) {
      const el = closestBlock(start.node, content);
      return { range, el: el || start.node.parentElement || content };
    }
  } catch { /* ignore */ }
  return null;
}

/** 정규화된 전체 텍스트 + 각 정규화 문자의 원본 인덱스 매핑 (공백 연속 → 1칸) */
function normalizedMap(full) {
  let out = '';
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < full.length; i++) {
    const c = full[i];
    if (/\s/.test(c)) {
      if (!prevSpace) { out += ' '; map.push(i); prevSpace = true; }
    } else {
      out += c; map.push(i); prevSpace = false;
    }
  }
  return { norm: out, map };
}

/**
 * 문제 위치 탐색:
 * ① 저장된 좌표(ref) 그대로 — 검증 통과 시 즉시 반환 (빠르고 정확)
 * ② 좌표가 어긋나면 정규화 전체 검색 + 앞/뒤 컨텍스트로 같은 문구 구분
 * 반환: { range, el } 또는 null
 */
export function locateProblem(content, p) {
  if (!content) return null;
  const textNorm = norm(p.text);
  if (!textNorm) return null;

  let anchor = null;
  try { anchor = p.ref ? JSON.parse(p.ref) : null; } catch {}

  const full = content.textContent || '';

  // ① 정확 오프셋
  if (anchor && Number.isInteger(anchor.start) && Number.isInteger(anchor.end)
      && anchor.start >= 0 && anchor.end <= full.length && anchor.end > anchor.start) {
    const hit = buildRange(content, anchor.start, anchor.end, textNorm);
    if (hit) return hit;
  }

  // ② 정규화 전체 검색 + 컨텍스트 디스앰비규에이션
  const { norm: ntext, map } = normalizedMap(full);
  const before = anchor ? norm(anchor.before) : '';
  const after = anchor ? norm(anchor.after) : '';
  const occurrences = [];
  let pos = -1;
  while ((pos = ntext.indexOf(textNorm, pos + 1)) !== -1) occurrences.push(pos);
  if (!occurrences.length) return null;

  const ctxBefore = (pp) => ntext.slice(Math.max(0, pp - 30), pp);
  const ctxAfter = (pp) => ntext.slice(pp + textNorm.length, pp + textNorm.length + 30);
  const tryHits = (list) => {
    for (const pp of list) {
      const hit = buildRange(content, map[pp], map[pp + textNorm.length - 1] + 1, textNorm);
      if (hit) return hit;
    }
    return null;
  };

  // 앞+뒤 컨텍스트 일치 → 앞만 일치 → 저장 좌표에 가장 가까운 발생
  if (before || after) {
    const hit = tryHits(occurrences.filter((pp) =>
      (!before || ctxBefore(pp).includes(before)) && (!after || ctxAfter(pp).includes(after))));
    if (hit) return hit;
  }
  if (before) {
    const hit = tryHits(occurrences.filter((pp) => ctxBefore(pp).includes(before)));
    if (hit) return hit;
  }
  const list = anchor && Number.isInteger(anchor.start)
    ? [...occurrences].sort((a, b) => Math.abs(a - anchor.start) - Math.abs(b - anchor.start))
    : occurrences;
  return tryHits(list);
}

/**
 * 점프 전 레이아웃 안정 대기 — 웹폰트/이미지가 늦게 로드되면 좌표(rect)가 흔들려
 * 모바일/태블릿에서 이상한 곳으로 스크롤된다. 폰트/이미지 로딩 후 점프. (타임아웃 보장)
 */
function waitForLayoutReady(container, timeout = 800) {
  const waits = [];
  if (document.fonts && document.fonts.ready) {
    waits.push(Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, timeout))]));
  }
  const imgs = container ? Array.from(container.querySelectorAll('img')) : [];
  // ⚠️ img.naturalWidth는 레이아웃 읽기 → "Forced reflow" 발생.
  // complete 플래그만 확인하고, 대기 중 이미지는 비동기 decode()로 기다린다.
  for (const img of imgs) {
    if (img.complete) continue;
    const loaded = img.decode
      ? img.decode().catch(() => {})
      : new Promise((r) => {
          img.addEventListener('load', r, { once: true });
          img.addEventListener('error', r, { once: true });
        });
    waits.push(Promise.race([loaded, new Promise((r) => setTimeout(r, timeout))]));
  }
  return Promise.all(waits);
}

/**
 * 마크다운 문제 점프 훅.
 * - queueJump(p, seq): 점프 예약 (렌더 커밋 후 effect가 위치 탐색 실행)
 * - pendingJumpRef: 스크롤 복원 effect가 점프와 충돌하지 않도록 대기 여부 확인용
 */
export default function useProblemJump({ previewRef, navSeqRef, rendered, selectedPath, onToast }) {
  const pendingJumpRef = useRef(null);
  const [jumpTick, setJumpTick] = useState(0); // 같은 문서 점프 시 effect 재실행 트리거

  const queueJump = useCallback((p, seq) => {
    pendingJumpRef.current = { p, seq };
    setJumpTick((t) => t + 1);
  }, []);

  // 렌더링 완료 + 레이아웃 안정 후 위치 탐색. 실패해도 반드시 토스트로 알린다.
  useEffect(() => {
    if (!rendered || !pendingJumpRef.current) return;
    const { p, seq } = pendingJumpRef.current;
    pendingJumpRef.current = null;
    if (seq !== navSeqRef.current) return; // 더 새로운 탐색이 시작됨
    const container = previewRef.current;
    const content = container && container.querySelector('.viewer__content');
    if (!container || !content) return;

    let cancelled = false;
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t; };

    // 점프 실행 — 네이티브 scrollIntoView 중심 정렬 + 정확 범위 하이라이트.
    // (기하(rect) 읽기가 없어 Forced reflow를 유발하지 않는다.)
    const jump = () => {
      const located = locateProblem(content, p);
      if (!located) return false;
      const el = located.el;
      console.log('[problem-jump] located', (p.text || '').slice(0, 30), '→',
        el ? '<' + el.tagName.toLowerCase() + '>' : '');
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(located.range);
      } catch {
        // 하이라이트 실패 시 블록 플래시로 대체
        el?.classList.add('viewer__problem-flash');
        later(() => el?.classList.remove('viewer__problem-flash'), 2000);
      }
      later(() => window.getSelection()?.removeAllRanges(), 2500);
      return true;
    };

    // 2차 보정: 늦게 뜨는 요소(이미지/폰트)로 인한 잔여 어긋남 교정 (scrollIntoView만 사용)
    const correct = () => {
      if (cancelled) return;
      const located = locateProblem(content, p);
      const el = located && located.el;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    };

    // 폰트·이미지 로딩 + 새 콘텐츠의 자연 레이아웃(1프레임)을 마친 뒤 좌표로 점프.
    // ⚠️ 렌더 커밋 직후 같은 프레임에 기하를 읽으면 큰 문서에서 "Forced reflow"가
    //    발생한다. 이중 rAF로 브라우저가 한 번 레이아웃+페인트한 뒤 읽는다.
    waitForLayoutReady(container).then(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          if (jump()) {
            later(correct, 400);
            return;
          }
          // 렌더 직후 DOM이 아직 준비되지 않았을 수 있으니 한 번 더 재시도
          later(() => {
            if (cancelled) return;
            if (jump()) {
              later(correct, 400);
            } else {
              console.warn('[problem-jump] locate failed for', p.doc_path, '→', p.text);
              onToast("Couldn't find the problem: " + (p.text || '').slice(0, 40));
            }
          }, 250);
        });
      });
    });

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, [rendered, selectedPath, jumpTick, previewRef, navSeqRef, onToast]);

  return { queueJump, pendingJumpRef };
}

// ── 마크다운 문제 위치 앵커(ref) 계산 — textContent와 일관된 오프셋 ──
// 저장 시점(선택이 살아있을 때)과 점프 시점(content.textContent)이 같은 기준을
// 쓰지 않으면 좌표가 어긋나 점프가 실패한다.
// ⚠️ Range.toString()은 공백을 1칸으로 접으므로 오프셋 계산에 사용하지 말 것.
//    반드시 TreeWalker로 textContent(원본 유지) 기준 오프셋을 계산해야 한다.
// ⚠️ ✓/✗ 버튼 클릭 시 브라우저가 선택을 지우므로, ref는 "선택 확정 직후"에
//    RangeSelect가 미리 계산해 problems:mark 이벤트에 실어 보내야 정확하다.

const textLen = (n) => (n.textContent || '').length;

/** textContent 기준으로 노드+오프셋 위치를 계산 (nodeAtOffset과 역연산 일치) */
export function textOffsetOf(root, node, offset) {
  if (node.nodeType === Node.TEXT_NODE) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = 0;
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return current + Math.min(offset, textLen(n));
      current += textLen(n);
    }
    return -1;
  }
  // 요소 노드 — offset 0이면 요소 앞 텍스트 길이, 그 외엔 요소 끝까지
  const before = (() => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = 0;
    let seen = false;
    let n;
    while ((n = walker.nextNode())) {
      if (node.contains(n)) { seen = true; continue; }
      if (seen) break;
      current += textLen(n);
    }
    return current;
  })();
  return offset === 0 ? before : before + textLen(node);
}

/**
 * Range → 마크다운 앵커 JSON 문자열. .viewer__content 밖이면 '' 반환.
 * 선택이 아직 살아있는 시점(마크다운 선택 확정 직후)에 호출해 저장해야 정확하다.
 */
export function markdownRefFromRange(range) {
  const content = document.querySelector('.viewer__content');
  if (!content || !range || !range.commonAncestorContainer || !content.contains(range.commonAncestorContainer)) return '';
  const start = textOffsetOf(content, range.startContainer, range.startOffset);
  const end = textOffsetOf(content, range.endContainer, range.endOffset);
  const full = content.textContent || '';
  if (start < 0 || end < start || end > full.length) return '';
  const before = full.slice(Math.max(0, start - 30), start);
  const after = full.slice(end, end + 30);
  return JSON.stringify({ start, end, before, after });
}

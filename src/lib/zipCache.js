// ── ZIP 메모리 캐시 (모듈 레벨) ─────────────────────────────────────────────
// Viewer가 탭 전환으로 언마운트돼도 파싱된 ZIP(JSZip 객체 + 이미지 blob URL +
// 검색 인덱스 + 파일 트리)을 유지해, 돌아올 때 다시 다운로드/파싱하지 않고
// 즉시 복원한다. 최대 3개 유지 (현재 ZIP은 절대 제거하지 않음).

const cache = new Map();

export function getZipEntry(id) {
  return cache.get(id) || null;
}

/** 캐시 등록 — 초과 시 keepId(현재 ZIP)와 방금 등록한 id를 제외하고 1개 제거 */
export function setZipEntry(id, entry, keepId = '') {
  cache.set(id, entry);
  if (cache.size > 3) {
    for (const oldId of cache.keys()) {
      if (oldId !== id && oldId !== keepId) { cache.delete(oldId); break; }
    }
  }
}

export function deleteZipEntry(id) {
  cache.delete(id);
}

/** 캐시 전체 항목 — [id, entry] 배열 */
export function zipEntries() {
  return [...cache.entries()];
}

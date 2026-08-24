// ============================================================
// docScan — 문서/보드 자동 인식 크롭 (백엔드 Python OpenCV)
// 클라이언트는 이미지를 POST /api/scan으로 보내고 결과를 받는다.
// ============================================================

const BASE = '/api';

/**
 * dataUrl 이미지에서 문서/보드 영역을 자동 인식해 원근 보정 크롭
 * @param {object} [opts] { maxDim=1600, dewarp=1 (정류 강도 0~2), smooth=1 (블러 반경 0~5) }
 * @returns {Promise<{dataUrl: string, aspect: number, method: string} | {skipped: true}>}
 */
export async function autoCropDataUrl(dataUrl, { maxDim = 1600, dewarp = 1, smooth = 1 } = {}) {
  const res = await fetch(BASE + '/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, maxDim, dewarp, smooth }),
  });
  if (!res.ok) {
    let msg = `scan failed (${res.status})`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch { /* 무시 */ }
    // 422 = 문서 미탐지 → 원본 사용
    if (res.status === 422) return { skipped: true, reason: msg };
    throw new Error(msg);
  }
  const j = await res.json();
  if (!j || !j.dataUrl) return { skipped: true };
  return { dataUrl: j.dataUrl, aspect: Number(j.aspect) || 1, method: j.method || 'unknown' };
}

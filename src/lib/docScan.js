// ============================================================
// docScan — 문서/보드 자동 인식 크롭 (백엔드 Python OpenCV)
// 클라이언트는 이미지를 POST /api/scan으로 보내고 결과를 받는다.
// ============================================================

const BASE = '/api';

/**
 * dataUrl 이미지에서 문서/보드 영역을 자동 인식해 원근 보정 크롭
 * @returns {Promise<{ dataUrl: string, aspect: number } | null>} — 탐지 실패 시 null
 */
export async function autoCropDataUrl(dataUrl, { maxDim = 1600 } = {}) {
  const res = await fetch(BASE + '/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, maxDim }),
  });
  if (!res.ok) {
    let msg = `scan failed (${res.status})`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch { /* 무시 */ }
    // 422 = 문서 미탐지 → 원본 사용(null)으로 처리
    if (res.status === 422) return null;
    throw new Error(msg);
  }
  const j = await res.json();
  if (!j || !j.dataUrl) return null;
  return { dataUrl: j.dataUrl, aspect: Number(j.aspect) || 1 };
}

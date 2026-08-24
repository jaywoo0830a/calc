// ============================================================
// docScan — 문서/보드 자동 인식 크롭 (백엔드 Python OpenCV)
// 클라이언트는 이미지를 POST /api/scan으로 보내고 결과를 받는다.
// ============================================================

const BASE = '/api';

/**
 * dataUrl 이미지를 90° 단위로 회전 (캔버스 재인코딩, EXIF 정규화 포함)
 * @returns {Promise<string>} 회전된 dataUrl
 */
export function rotateImageDataUrl(dataUrl, deg) {
  if (![90, 180, 270].includes(deg)) return Promise.resolve(dataUrl);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('bad image'));
    img.onload = () => {
      const swap = deg === 90 || deg === 270;
      const w = swap ? img.naturalHeight : img.naturalWidth;
      const h = swap ? img.naturalWidth : img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      resolve(dataUrl.startsWith('data:image/png')
        ? canvas.toDataURL('image/png')
        : canvas.toDataURL('image/jpeg', 0.9));
    };
    img.src = dataUrl;
  });
}

/**
 * dataUrl 이미지에서 문서/보드 영역을 자동 인식해 원근 보정 크롭
 * @param {object} [opts] { maxDim=1600, rotate=0 (0|90|180|270) }
 * @returns {Promise<{dataUrl: string, aspect: number, method: string} | {skipped: true}>}
 */
export async function autoCropDataUrl(dataUrl, { maxDim = 1600, rotate = 0 } = {}) {
  const res = await fetch(BASE + '/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, maxDim, rotate }),
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

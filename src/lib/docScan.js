// ============================================================
// docScan — 문서 스캔 (scanic — 브라우저 WASM, 서버 왕복 불필요)
// 사진 → scanDocument로 모서리 감지 → 사용자가 코너 에디터로 영역 확정
// → extractDocument(원근 보정) → dataUrl 반환
// ============================================================
import { scanDocument, extractDocument } from 'scanic';

/**
 * dataUrl → HTMLImageElement (scanic 입력용)
 * @returns {Promise<HTMLImageElement>}
 */
export function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('bad image'));
    img.onload = () => resolve(img);
    img.src = dataUrl;
  });
}

/**
 * 문서 모서리 자동 감지 (classical — Canny+contour). 실패 시 null.
 * 코너 에디터의 초기값으로 사용 — null이면 에디터가 기본 인셋 사각형으로 시작.
 * @returns {Promise<CornerPoints|null>} { topLeft, topRight, bottomRight, bottomLeft }
 */
export async function detectCorners(image) {
  try {
    const res = await scanDocument(image, { mode: 'detect' });
    if (res.success && res.corners) return res.corners;
  } catch (err) {
    console.warn('[doc-scan] detection failed:', err);
  }
  return null;
}

/**
 * 지정된 모서리로 원근 보정 (사용자가 코너 에디터에서 확정한 4점)
 * @returns {Promise<{dataUrl: string, aspect: number}>}
 */
export async function scanWithCorners(image, corners, quality = 0.9) {
  const res = await extractDocument(image, corners, { output: 'canvas' });
  if (!res.success || !res.output) throw new Error(res.message || 'extract failed');
  const canvas = res.output;
  return {
    dataUrl: canvas.toDataURL('image/jpeg', quality),
    aspect: canvas.width / canvas.height,
  };
}

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

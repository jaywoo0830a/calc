// ============================================================
// docScan — 전자 메모보드/종이 사진 자동 인식·원근 보정 크롭
// (문서 스캐너 스타일)
// · OpenCV.js(WASM)를 지연 로드 — 서버/Docker 변경 불필요
// · 로컬 /opencv.js 우선, 실패 시 공식 CDN 폴백
// ============================================================

let cvPromise = null;

// ── 순수 함수 (TDD 대상) ─────────────────────────────────────

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 4개 꼭짓점을 [TL, TR, BR, BL] 순서로 정렬 (이미지 좌표계: y↓)
// · TL = x+y 최소, BR = x+y 최대, TR = y−x 최소, BL = y−x 최대
export function orderCorners(pts) {
  const p = pts.map((pt) => ({ x: pt[0], y: pt[1], s: pt[0] + pt[1], d: pt[1] - pt[0] }));
  const tl = p.reduce((a, b) => (b.s < a.s ? b : a));
  const br = p.reduce((a, b) => (b.s > a.s ? b : a));
  const rest = p.filter((pt) => pt !== tl && pt !== br);
  const tr = rest[0].d < rest[1].d ? rest[0] : rest[1];
  const bl = rest[0] === tr ? rest[1] : rest[0];
  return [tl, tr, br, bl].map((pt) => [pt.x, pt.y]);
}

// 사각형의 평균 가로·세로를 구해 maxDim 이하의 워프 타깃 크기 계산
export function sizeForQuad(corners, maxDim = 1600) {
  const [tl, tr, br, bl] = corners;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  const s = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(2, Math.round(w * s)), h: Math.max(2, Math.round(h * s)) };
}

// ── OpenCV.js 지연 로드 (로컬 → CDN 폴백) ────────────────────
export function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    if (typeof globalThis !== 'undefined' && globalThis.cv && globalThis.cv.Mat) {
      resolve(globalThis.cv);
      return;
    }
    const attach = (url) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => {
        const cv = globalThis.cv;
        if (cv && cv.Mat) {
          resolve(cv);
        } else if (cv && typeof cv.onRuntimeInitialized === 'function') {
          // WASM 초기화 완료 콜백 대기
          const prev = cv.onRuntimeInitialized;
          cv.onRuntimeInitialized = () => {
            try { prev && prev(); } catch { /* 무시 */ }
            resolve(cv);
          };
        } else {
          reject(new Error('opencv: runtime not initialized'));
        }
      };
      s.onerror = () => {
        if (url === '/opencv.js') attach('https://docs.opencv.org/4.x/opencv.js');
        else reject(new Error('opencv: failed to load from local or CDN'));
      };
      document.head.appendChild(s);
    };
    attach('/opencv.js');
  });
  return cvPromise;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

// 이미지 → 축소 ImageData (탐지용)
function toImageData(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(2, Math.round(img.naturalWidth * scale));
  const h = Math.max(2, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), scale };
}

// 이진화 결과에서 가장 큰 볼록 4각형 윤곽 탐색
function bestQuadFromBinary(cv, binary, minAreaRatio) {
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  const closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const imgArea = binary.rows * binary.cols;
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < imgArea * minAreaRatio || area <= bestArea) continue;
    const peri = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const pts = [];
      for (let r = 0; r < 4; r++) pts.push([approx.data32S[r * 2], approx.data32S[r * 2 + 1]]);
      best = pts;
      bestArea = area;
    }
    approx.delete();
  }
  contours.delete();
  hierarchy.delete();
  closed.delete();
  kernel.delete();
  return best;
}

// 문서(밝은 종이)와 보드(어두운 액정판) 양쪽 극성에서 탐지 후 더 큰 쪽 선택
function findDocQuad(cv, src, minAreaRatio) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  let best = null;
  let bestArea = 0;
  for (const threshType of [cv.THRESH_BINARY, cv.THRESH_BINARY_INV]) {
    const binary = new cv.Mat();
    cv.adaptiveThreshold(blurred, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, threshType, 41, 10);
    const quad = bestQuadFromBinary(cv, binary, minAreaRatio);
    binary.delete();
    if (quad) {
      const m = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flat());
      const area = cv.contourArea(m);
      m.delete();
      if (area > bestArea) {
        best = quad;
        bestArea = area;
      }
    }
  }
  blurred.delete();
  gray.delete();
  return best ? orderCorners(best) : null;
}

/**
 * dataUrl 이미지에서 문서/보드 영역을 자동 인식해 원근 보정 크롭
 * @returns {{ dataUrl: string, aspect: number } | null} — 탐지 실패 시 null
 */
export async function autoCropDataUrl(dataUrl, { maxDim = 1600, minAreaRatio = 0.18 } = {}) {
  const cv = await loadOpenCV();
  const img = await loadImage(dataUrl);

  // 1) 축소판(≤720px)에서 탐지
  const small = toImageData(img, 720);
  const srcSmall = cv.matFromImageData(small.data);
  let corners = findDocQuad(cv, srcSmall, minAreaRatio);
  srcSmall.delete();
  if (!corners) return null;

  // 2) 원본 해상도 좌표로 환산
  const k = 1 / small.scale;
  corners = corners.map(([x, y]) => [x * k, y * k]);
  const { w, h } = sizeForQuad(corners, maxDim);

  // 3) 원본 해상도에서 4점 원근 변환
  const full = toImageData(img, Math.max(img.naturalWidth, img.naturalHeight));
  const srcFull = cv.matFromImageData(full.data);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0][0], corners[0][1],
    corners[1][0], corners[1][1],
    corners[2][0], corners[2][1],
    corners[3][0], corners[3][1],
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(srcFull, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  cv.imshow(out, dst);
  dst.delete();
  M.delete();
  srcTri.delete();
  dstTri.delete();
  srcFull.delete();

  const outUrl = out.toDataURL('image/jpeg', 0.9);
  return { dataUrl: outUrl, aspect: w / h };
}

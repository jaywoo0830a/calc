// ═══════════════════════════════════════════════════════════════
// pdfAnnotator — PdfAnnotator에서 추출한 순수 유틸 (DOM/PDF.js 헬퍼)
// ═══════════════════════════════════════════════════════════════

export const MAX_IMAGE_MB = 10; // 🖼️ 이미지 업로드 상한

/** react-pdf 페이지의 실제 캔버스 rect (렌더 경로와 일치) */
export function getPageCanvasRect(pageEl) {
  if (!pageEl) return null;
  // The react-pdf Page wrapper maintains the correct PDF aspect ratio
  const pageDiv = pageEl.querySelector('.react-pdf__Page');
  if (pageDiv) return pageDiv.getBoundingClientRect();
  // Fallback: use the canvas element
  const canvas = pageEl.querySelector('canvas');
  if (canvas) return canvas.getBoundingClientRect();
  // Last resort: page-wrapper itself
  return pageEl.getBoundingClientRect();
}

/** 주석의 정규화 rect → 페이지 래퍼 내 픽셀 좌표 */
export function annoRect(a, pageEl) {
  if (!pageEl) return null;
  const canvasRect = getPageCanvasRect(pageEl);
  if (!canvasRect) return null;
  const wrapperRect = pageEl.getBoundingClientRect();  // Position within page-wrapper = canvas offset + normalized coords × canvas size
  return {
    left: (canvasRect.left - wrapperRect.left) + a.rect.x * canvasRect.width,
    top: (canvasRect.top - wrapperRect.top) + a.rect.y * canvasRect.height,
    width: a.rect.w * canvasRect.width,
    height: a.rect.h * canvasRect.height,
  };
}

// ── 🖼️ 이미지 압축 — 2MB 이하는 1000px, 그 이상은 1600px (JPEG 0.82, PNG 무손실) ──
export function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('bad image'));
      img.onload = () => {
        const MAX = file.size > 2 * 1024 * 1024 ? 1600 : 1000;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = file.type === 'image/png'
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', 0.82);
        resolve({ dataUrl, aspect: w / h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** destination 배열 → 1-based 페이지 번호 */
async function resolveDestToPage(destArray, pdfDoc) {
  if (!destArray || destArray.length === 0) return null;
  const first = destArray[0];
  try {
    if (typeof first === 'number') {
      // Page index (0-based) embedded directly
      return first + 1;
    }
    if (first && typeof first === 'object' && ('num' in first || 'gen' in first)) {
      // Page reference object { num, gen }
      const idx = await pdfDoc.getPageIndex(first);
      return idx + 1;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Resolve PDF outline: flatten first, then resolve all in parallel ──
export async function resolveOutlineItems(items, pdfDoc) {
  if (!items || !pdfDoc) return [];

  // 1. Flatten the tree (sync — no async calls)
  const flat = [];
  const walk = (list, depth) => {
    for (const item of list) {
      flat.push({ item, depth });
      if (item.items?.length > 0) walk(item.items, depth + 1);
    }
  };
  walk(items, 1);

  // 2. Resolve all destinations in parallel
  const resolved = await Promise.all(flat.map(async ({ item, depth }) => {
    let pageNumber = null;
    try {
      if (item.dest) {
        if (typeof item.dest === 'string') {
          const destArray = await pdfDoc.getDestination(item.dest);
          if (destArray?.length > 0) pageNumber = await resolveDestToPage(destArray, pdfDoc);
        } else if (Array.isArray(item.dest) && item.dest.length > 0) {
          pageNumber = await resolveDestToPage(item.dest, pdfDoc);
        }
      }
    } catch { /* leave null */ }
    return {
      title: item.title || '(Untitled)',
      pageNumber,
      depth,
      bold: !!item.bold,
      italic: !!item.italic,
    };
  }));

  return resolved;
}

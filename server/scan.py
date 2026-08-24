#!/usr/bin/env python3
"""scan — 문서 스캐너 (모델 없음 — 순수 이미지 처리)

파이프라인:
  1) 주 오브젝트(밝은 문서/화면·어두운 보드)를 명암 경계로 탐지
     — 적응형 이진화 3종(CLAHE 보정 포함) → 가장 큰 외곽 윤곽 → 4각형 근사
  2) 4각형 실패 시 최소 면적 회전 사각형, 그것도 안 되면 최대 영역 bbox 크롭
  3) PIL QUAD 원근 변환으로 펼치기 (사다리꼴 보정)
  ※ OCR/DocGeoNet 모델 미사용 — rapidocr·torch 불필요

사용: python3 scan.py <image_path> [maxDim=1600] [stretchX] [stretchY] [rotate]
출력: JSON {"ok": true, "dataUrl": ..., "aspect": ..., "method": "edge"|"rect"|"crop"}
"""
import base64
import io
import json
import sys

from PIL import Image

from scan_core import order_corners, quad_area, shrink_quad, size_for_quad


def _find_quad(img):
    """주 오브젝트(문서/화면) 4각형 탐지. 반환: (quad, kind) | None.

    kind: 'edge'=4각형 근사, 'rect'=최소 면적 회전 사각형.
    좌표는 입력 이미지 좌표계.
    """
    try:
        import cv2
        import numpy as np
    except Exception:
        return None
    arr = np.asarray(img.convert('RGB'))
    s = min(1.0, 1000.0 / max(arr.shape[0], arr.shape[1]))
    if s < 1.0:
        arr = cv2.resize(arr, (max(2, int(arr.shape[1] * s)), max(2, int(arr.shape[0] * s))),
                         interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    # 조명 보정 — 눈부심/그림자가 있는 사진 대비
    eq = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    H, W = gray.shape
    # 밝은 문서(INV) + 어두운 보드(BINARY) + Otsu — 3종 마스크
    masks = [
        cv2.adaptiveThreshold(eq, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                              cv2.THRESH_BINARY_INV, 41, 15),
        cv2.adaptiveThreshold(eq, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                              cv2.THRESH_BINARY, 41, 15),
    ]
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    masks.append(otsu)

    best = None
    best_kind = 'rect'
    best_score = -1.0
    for m in masks:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            area = cv2.contourArea(c)
            if area < W * H * 0.08 or area > W * H * 0.995:
                continue
            peri = cv2.arcLength(c, True)
            poly = None
            kind = 'rect'
            for eps in (0.02, 0.04, 0.06, 0.08):
                p = cv2.approxPolyDP(c, eps * peri, True)
                if len(p) == 4 and cv2.isContourConvex(p):
                    poly = p
                    kind = 'edge'
                    break
            if poly is None:
                poly = cv2.boxPoints(cv2.minAreaRect(c))
            # approxPolyDP는 (N,1,2), boxPoints는 (4,2) — reshape로 통일
            pts = [(float(pt[0]), float(pt[1])) for pt in np.asarray(poly).reshape(-1, 2)]
            try:
                q = order_corners(pts)
            except ValueError:
                continue
            # 점수: 면적 우선 + 중심 근접 가점 (주 오브젝트 선호)
            cx = sum(p[0] for p in q) / 4.0
            cy = sum(p[1] for p in q) / 4.0
            d = ((cx - W / 2.0) ** 2 + (cy - H / 2.0) ** 2) ** 0.5
            score = quad_area(q) - d * max(W, H) * 0.3
            if score > best_score:
                best_score = score
                best = q
                best_kind = kind
    if best is None:
        return None
    return ([[x / s, y / s] for x, y in best], best_kind)


def _fallback_bbox(img):
    """4각형 실패 시 — 가장 큰 밝은 영역의 축 정렬 bbox (크롭만). 실패 시 None."""
    try:
        import cv2
        import numpy as np
    except Exception:
        return None
    arr = np.asarray(img.convert('RGB'))
    s = min(1.0, 800.0 / max(arr.shape[0], arr.shape[1]))
    if s < 1.0:
        arr = cv2.resize(arr, (max(2, int(arr.shape[1] * s)), max(2, int(arr.shape[0] * s))),
                         interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    _, m = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    H, W = gray.shape
    best_box = None
    best_area = 0.0
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        area = float(bw * bh)
        if area < W * H * 0.06 or area > W * H * 0.995:
            continue
        if area > best_area:
            best_area = area
            best_box = (x, y, bw, bh)
    if best_box is None:
        return None
    x, y, bw, bh = best_box
    return [[x / s, y / s], [(x + bw) / s, y / s],
            [(x + bw) / s, (y + bh) / s], [x / s, (y + bh) / s]]


def warp_quad(img, corners, max_dim):
    corners = shrink_quad(corners, 0.012)
    ow, oh = size_for_quad(corners, max_dim)
    # ⚠️ PIL QUAD는 (TL, BL, BR, TR) 시계 방향 순서를 기대한다.
    #    (TL, TR, BR, BL)을 넣으면 좌우 반전된다. — 코너 색상 테스트로 확인함.
    tl, tr, br, bl = corners
    data = (round(tl[0]), round(tl[1]),
            round(bl[0]), round(bl[1]),
            round(br[0]), round(br[1]),
            round(tr[0]), round(tr[1]))
    out = img.transform((ow, oh), Image.QUAD, data,
                        resample=Image.BICUBIC, fillcolor=(255, 255, 255))
    return out


def _expand_quad(corners, factor, W, H):
    """경계 사각형을 중심 기준 바깥으로 살짝 확장.

    그림자·말린 가장자리 때문에 경계가 실제 문서보다 안쪽으로 잡혀
    테두리가 잘리는 것을 방지 (factor=0.03 → 각 축 3%).
    """
    cx = sum(p[0] for p in corners) / 4.0
    cy = sum(p[1] for p in corners) / 4.0
    out = []
    for x, y in corners:
        out.append((
            max(0.0, min(W - 1.0, cx + (x - cx) * (1.0 + factor))),
            max(0.0, min(H - 1.0, cy + (y - cy) * (1.0 + factor))),
        ))
    return out


def run(image_path, max_dim=1600, stretch_x=0.0, stretch_y=0.0, rotate=0):
    try:
        img = Image.open(image_path).convert('RGB')
    except Exception:
        return {"ok": False, "reason": "cannot read image"}

    # 1) 주 오브젝트 4각형 탐지 (명암 경계 기반 — 모델 없음)
    method = 'edge'
    try:
        found = _find_quad(img)
    except Exception as e:
        found = None
    if found is None:
        try:
            corners = _fallback_bbox(img)
            method = 'crop'
        except Exception as e:
            corners = None
        if corners is None:
            return {"ok": False, "reason": "no document detected"}
    else:
        corners, method = found

    # 2) 가장자리 잘림 방지 — 사각형을 바깥으로 3% 확장 (그림자·말림 대응)
    corners = _expand_quad(corners, 0.03, img.width, img.height)

    # 3) 원근 변환으로 펼치기
    out = warp_quad(img, corners, max_dim)

    m = max(out.width, out.height)
    if m > max_dim:
        s = max_dim / float(m)
        out = out.resize((max(2, int(out.width * s)), max(2, int(out.height * s))), Image.LANCZOS)

    # 5) 가로/세로 늘이기 — 처리된 이미지에 비율 적용 (0 = 순정 그대로)
    if stretch_x > 0.0 or stretch_y > 0.0:
        nw = max(2, int(round(out.width * (1.0 + stretch_x))))
        nh = max(2, int(round(out.height * (1.0 + stretch_y))))
        out = out.resize((nw, nh), Image.LANCZOS)

    # 6) 90° 단위 회전 — 처리된 이미지에 적용 (0 = 그대로)
    if rotate in (90, 180, 270):
        out = out.rotate(rotate, expand=True)

    buf = io.BytesIO()
    out.save(buf, format='JPEG', quality=90)
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    return {"ok": True, "dataUrl": data_url,
            "aspect": out.width / float(out.height), "method": method}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage: scan.py <image_path> [maxDim] [stretchX] [stretchY] [rotate]"}))
        return
    max_dim = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
    stretch_x = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    stretch_y = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
    rotate = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    print(json.dumps(run(sys.argv[1], max_dim, stretch_x, stretch_y, rotate)))


if __name__ == '__main__':
    main()

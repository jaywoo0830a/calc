#!/usr/bin/env python3
"""scan — 전자 메모보드/종이 사진 자동 인식·원근 보정 크롭 (문서 스캐너)

사용: python3 scan.py <image_path> [maxDim=1600]
출력(표준 출력): JSON
  성공: {"ok": true, "dataUrl": "data:image/jpeg;base64,...", "aspect": 1.41}
  실패: {"ok": false, "reason": "..."}

파이프라인:
  1) ≤720px 축소판에서 탐지 — 적응형 양극성 + Otsu 양극성 4종 이진화
  2) 가장 큰 볼록 4각형(사다리꼴 포함) → 원본 좌표 환산 → 4점 원근 변환
  3) 4각형 미탐지 시 가장 큰 윤곽의 회전 사각형(minAreaRect) 폴백
  4) 그것도 없으면 잉크(글자) 영역 bbox + 여백 크롭
"""
import base64
import json
import sys

import cv2
import numpy as np

from scan_core import order_corners, shrink_quad, size_for_quad, usable_bbox, with_margin

MIN_AREA_RATIO = 0.05


def contours_of(binary):
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    return cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]


def area_ok(area, img_area, min_ratio):
    """너무 작으면(잡음) 또는 거의 전체면(배경이 통째로 잡힌 경우) 배제."""
    return img_area * min_ratio <= area <= img_area * 0.98


def quad_from_contour(cnt, min_area_ratio, img_area):
    """윤곽 → 볼록 몹체 → 점진적 epsilon으로 4점(사다리꼴 포함) 근사.
    테이프·굴곡으로 점이 5~8개 나와도 점차 뭉개 4점을 만든다."""
    if not area_ok(cv2.contourArea(cnt), img_area, min_area_ratio):
        return None
    hull = cv2.convexHull(cnt)
    peri = cv2.arcLength(hull, True)
    if peri <= 0:
        return None
    for eps in (0.02, 0.03, 0.04, 0.05, 0.07):
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4:
            return approx.reshape(-1, 2).astype(np.int32).tolist()
    return None


def rect_from_contour(cnt, min_area_ratio, img_area):
    """회전 사각형(minAreaRect) 폴백 — 4각형이 안 잡혀도 기울어진 문서를 잡는다."""
    if not area_ok(cv2.contourArea(cnt), img_area, min_area_ratio):
        return None
    return cv2.boxPoints(cv2.minAreaRect(cnt)).astype(np.int32).tolist()


def detect_doc(src, min_area_ratio):
    """4종 이진화에서 문서 사각형 탐지.
    @return (corners, method) — method: 'quad' | 'rect' | None
    """
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    binaries = [
        cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 15),
        cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 15),
    ]
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binaries.append(otsu)
    binaries.append(cv2.bitwise_not(otsu))

    img_area = src.shape[0] * src.shape[1]
    best_quad = None
    best_quad_area = 0.0
    best_rect = None
    best_rect_area = 0.0

    for binary in binaries:
        contours = contours_of(binary)
        # 큰 것부터 — 면적 정렬
        contours = sorted(contours, key=cv2.contourArea, reverse=True)
        for cnt in contours[:8]:
            area = cv2.contourArea(cnt)
            quad = quad_from_contour(cnt, min_area_ratio, img_area)
            if quad and area > best_quad_area:
                best_quad = quad
                best_quad_area = area
            if area > best_rect_area:
                rect = rect_from_contour(cnt, min_area_ratio, img_area)
                if rect:
                    best_rect = rect
                    best_rect_area = area

    if best_quad:
        return order_corners(best_quad), 'quad'
    if best_rect:
        return order_corners(best_rect), 'rect'
    return None, None


def ink_bbox(src):
    """잉크(어두운 글자/표) 영역의 bounding box — 여백·테이프 제외 크롭용."""
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    pts = cv2.findNonZero(binary)
    if pts is None:
        return None
    x, y, w, h = cv2.boundingRect(pts)
    img_h, img_w = src.shape[:2]
    bbox = with_margin((x, y, w, h), img_w, img_h)
    if not usable_bbox(bbox, img_w, img_h):
        return None
    return bbox


def run(image_path, max_dim=1600):
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "reason": "cannot read image"}
    img_h, img_w = img.shape[:2]

    # 1) 축소판(≤720px)에서 탐지
    scale = min(1.0, 720.0 / max(img_h, img_w))
    if scale < 1.0:
        small = cv2.resize(img, (max(2, int(img_w * scale)), max(2, int(img_h * scale))),
                           interpolation=cv2.INTER_AREA)
    else:
        small = img

    corners, method = detect_doc(small, MIN_AREA_RATIO)
    if corners:
        # 2) 원본 해상도 좌표 환산 → 4점 원근 변환 (사다리꼴 포함)
        #    형태학 팽창으로 불어난 테두리를 살짝 안쪽으로 수축
        k = 1.0 / scale
        corners = [(x * k, y * k) for x, y in shrink_quad(corners, 0.01)]
        out_w, out_h = size_for_quad(corners, max_dim)
        src_tri = np.float32(corners)
        dst_tri = np.float32([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]])
        m = cv2.getPerspectiveTransform(src_tri, dst_tri)
        out = cv2.warpPerspective(img, m, (out_w, out_h), flags=cv2.INTER_LINEAR,
                                  borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    else:
        # 3) 폴백: 잉크 영역 bbox 크롭 (축 정렬, 원근 보정 없음)
        bbox = ink_bbox(small)
        if bbox is None:
            return {"ok": False, "reason": "no document detected"}
        method = 'ink'
        k = 1.0 / scale
        x, y, bw, bh = (int(v * k) for v in bbox)
        x = min(max(0, x), img_w - 2)
        y = min(max(0, y), img_h - 2)
        bw = min(bw, img_w - x)
        bh = min(bh, img_h - y)
        out = img[y:y + bh, x:x + bw]
        out_h, out_w = out.shape[:2]

    # 4) 출력 크기 상한
    m = max(out_w, out_h)
    if m > max_dim:
        s = max_dim / float(m)
        out = cv2.resize(out, (max(2, int(out_w * s)), max(2, int(out_h * s))),
                         interpolation=cv2.INTER_AREA)
        out_h, out_w = out.shape[:2]

    ok, buf = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        return {"ok": False, "reason": "encode failed"}
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.tobytes()).decode('ascii')
    return {"ok": True, "dataUrl": data_url, "aspect": out_w / float(out_h), "method": method}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage: scan.py <image_path> [maxDim]"}))
        return
    max_dim = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
    print(json.dumps(run(sys.argv[1], max_dim)))


if __name__ == '__main__':
    main()

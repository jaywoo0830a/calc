#!/usr/bin/env python3
"""scan — 전자 메모보드/종이 사진 자동 인식·원근 보정 크롭 (문서 스캐너)

사용: python3 scan.py <image_path> [maxDim=1600]
출력(표준 출력): JSON
  성공: {"ok": true, "dataUrl": "data:image/jpeg;base64,...", "aspect": 1.41}
  실패: {"ok": false, "reason": "..."}

파이프라인:
  1) ≤720px 축소판에서 탐지 — 적응형 양극성 + Otsu 양극성 4종 이진화
  2) 가장 큰 볼록 4각형 → 원본 해상도 좌표 환산 → 4점 원근 변환(워프)
  3) 4각형 미탐지 시 잉크(글자) 영역 bbox + 여백 크롭 폴백
"""
import base64
import json
import sys

import cv2
import numpy as np

from scan_core import order_corners, size_for_quad, usable_bbox, with_margin

MIN_AREA_RATIO = 0.12


def best_quad_from_binary(binary, min_area_ratio):
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = binary.shape[0] * binary.shape[1]
    best = None
    best_area = 0.0
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < img_area * min_area_ratio or area <= best_area:
            continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            best = approx.reshape(-1, 2).astype(np.int32).tolist()
            best_area = area
    return best


def find_doc_quad(src, min_area_ratio):
    """밝은 종이(THRESH_BINARY)와 어두운 액정 보드(THRESH_BINARY_INV)를
    적응형/Otsu 이진화 각각으로 시도해 가장 큰 4각형을 선택."""
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    binaries = [
        cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 10),
        cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 41, 10),
    ]
    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binaries.append(otsu)
    binaries.append(cv2.bitwise_not(otsu))

    best = None
    best_area = 0.0
    for binary in binaries:
        quad = best_quad_from_binary(binary, min_area_ratio)
        if quad:
            area = cv2.contourArea(np.array(quad, dtype=np.int32).reshape(-1, 1, 2))
            if area > best_area:
                best, best_area = quad, area
    return order_corners(best) if best else None


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

    corners = find_doc_quad(small, MIN_AREA_RATIO)
    if corners:
        # 2) 원본 해상도 좌표 환산 → 4점 원근 변환
        k = 1.0 / scale
        corners = [(x * k, y * k) for x, y in corners]
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
    return {"ok": True, "dataUrl": data_url, "aspect": out_w / float(out_h)}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage: scan.py <image_path> [maxDim]"}))
        return
    max_dim = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
    print(json.dumps(run(sys.argv[1], max_dim)))


if __name__ == '__main__':
    main()

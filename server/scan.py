#!/usr/bin/env python3
"""scan — 모델 기반 문서 스캐너 (OpenCV 의존성 없음)

파이프라인:
  1) RapidOCR(ONNX) 텍스트 탐지 — 배경·조명과 무관하게 글자 위치를 찾음
  2) 글자 상자들의 볼록 껍질 → 사각형 단순화(RDP) → 종이/보드 4각형
  3) PIL QUAD 원근 변환으로 워프 (자체 학습 YOLO 모델이 있으면 우선 사용)
  4) DocGeoNet(ECCV 2022) 정류 — 공식 inference 레시피 (가중치 존재 시)

사용: python3 scan.py <image_path> [maxDim=1600]
출력: JSON {"ok": true, "dataUrl": ..., "aspect": ..., "method": "dl"|"yolo"|"dl+geo"|"yolo+geo"}
"""
import base64
import io
import json
import os
import sys

from PIL import Image

from scan_core import (
    monotone_hull,
    order_corners,
    quad_area,
    shrink_quad,
    simplify_to_quad,
    size_for_quad,
    with_margin,
)

_ocr = None


def load_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


def text_quad(img):
    """RapidOCR 텍스트 상자 → 종이 4각형 (탐지 실패 시 None)."""
    try:
        result, _ = load_ocr()(img)
    except Exception:
        return None
    if not result:
        return None
    pts = []
    for item in result:
        for x, y in item[0]:
            pts.append((float(x), float(y)))
    if len(pts) < 3:
        return None
    w, h = img.size
    hull = monotone_hull(pts)
    quad = simplify_to_quad(hull)
    if quad:
        quad = order_corners(quad)
        # 텍스트가 너무 적으면 전체를 못 덮음 → bbox+여백으로 확장
        if quad_area(quad) < w * h * 0.04:
            quad = None
    if quad is None:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        if (x1 - x0) < 8 or (y1 - y0) < 8:
            return None
        bx, by, bw, bh = with_margin((int(x0), int(y0), int(x1 - x0), int(y1 - y0)), w, h, 0.05)
        return [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]]
    return quad


# ── 선택적 자가 학습 YOLO (server/models/document.pt 존재 시) ──
_yolo = None


def yolo_quad(img):
    global _yolo
    try:
        if _yolo is None:
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'document.pt')
            if not os.path.exists(path):
                _yolo = False
                return None
            from ultralytics import YOLO
            _yolo = YOLO(path)
        if _yolo is False:
            return None
        results = _yolo.predict(img, conf=0.25, verbose=False)
        best = None
        best_conf = 0.0
        for r in results:
            for i, box in enumerate(r.boxes):
                conf = float(r.boxes.conf[i])
                if conf > best_conf:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    best = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                    best_conf = conf
        return best
    except Exception:
        _yolo = False
        return None


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


def _try_rectify(img):
    """DocGeoNet 정류 — 가중치/모듈 없으면 None (조용히 폴백)."""
    try:
        from rectify import rectify
        return rectify(img)
    except Exception:
        return None


def run(image_path, max_dim=1600, stretch_x=0.0, stretch_y=0.0, rotate=0):
    try:
        img = Image.open(image_path).convert('RGB')
    except Exception:
        return {"ok": False, "reason": "cannot read image"}
    w, h = img.size
    scale = min(1.0, 720.0 / max(w, h))
    small = img.resize((max(2, int(w * scale)), max(2, int(h * scale))), Image.LANCZOS) if scale < 1.0 else img

    method = 'dl'
    quad = text_quad(small)
    if quad is None:
        quad = yolo_quad(small)
        method = 'yolo'
    if quad is None:
        return {"ok": False, "reason": "no document detected"}

    k = 1.0 / scale
    corners = [[x * k, y * k] for x, y in quad]
    out = warp_quad(img, corners, max_dim)

    # 4) DocGeoNet 정류 — 공식 레시피 (선택적)
    rect = _try_rectify(out)
    if rect is not None:
        out = rect
        method += '+geo'

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

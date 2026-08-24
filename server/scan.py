#!/usr/bin/env python3
"""scan — 모델 기반 문서 스캐너 (OpenCV 의존성 없음)

파이프라인:
  1) RapidOCR(ONNX) 텍스트 탐지 (960px, 실패 시 1440px/90°회전 재시도)
  2) 옆으로 눕힌 문서(주축 ±60° 초과)는 강제 회전 경로로
  3) 오탐 상자 제거(MAD) → 볼록 껍질 → 4각형(이분 탐색, 실패 시 극점 모서리)
  4) PIL QUAD 원근 변환 — 사다리꼴(원근) 보정 (휜 문서 정류는 비활성)

사용: python3 scan.py <image_path> [maxDim=1600] [stretchX] [stretchY] [rotate]
출력: JSON {"ok": true, "dataUrl": ..., "aspect": ..., "method": "dl"|"dl-rotNN"|"yolo"}
"""
import base64
import io
import json
import math
import os
import sys

from PIL import Image

from scan_core import (
    extreme_corners,
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


def _ocr_boxes(img):
    """RapidOCR → 텍스트 상자 목록 (각 상자 = 4점). 실패/미탐지 시 [] 또는 None."""
    try:
        result, _ = load_ocr()(img)
    except Exception:
        return None
    if not result:
        return []
    return [[(float(x), float(y)) for x, y in item[0]] for item in result]


def _median(vals):
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def _filter_outliers(boxes, img_w, img_h):
    """본문 클러스터에서 멀리 떨어진 오탐(간판·화면·배경 글자) 제거.

    상자 중심의 중앙값 + MAD(MAD × 4, 최소 이미지의 15%)를 벗어나면 제외.
    너무 많이 걸러지면(3개 미만) 원래 목록을 돌려준다.
    """
    if len(boxes) < 5:
        return boxes
    cxs, cys = [], []
    for b in boxes:
        xs = [p[0] for p in b]
        ys = [p[1] for p in b]
        cxs.append(sum(xs) / len(xs))
        cys.append(sum(ys) / len(ys))
    mx, my = _median(cxs), _median(cys)
    mad_x = _median([abs(c - mx) for c in cxs]) or 1.0
    mad_y = _median([abs(c - my) for c in cys]) or 1.0
    lim_x = max(4.0 * mad_x, img_w * 0.15)
    lim_y = max(4.0 * mad_y, img_h * 0.15)
    keep = [b for b, cx, cy in zip(boxes, cxs, cys)
            if abs(cx - mx) <= lim_x and abs(cy - my) <= lim_y]
    return keep if len(keep) >= 3 else boxes


def text_quad(img):
    """RapidOCR 텍스트 상자 → 종이 4각형 (탐지 실패 시 None)."""
    boxes = _ocr_boxes(img)
    if not boxes:
        return None
    w, h = img.size
    boxes = _filter_outliers(boxes, w, h)
    pts = []
    for b in boxes:
        pts.extend(b)
    if len(pts) < 3:
        return None
    hull = monotone_hull(pts)
    quad = simplify_to_quad(hull)
    if quad:
        quad = order_corners(quad)
        # 텍스트가 너무 적으면 전체를 못 덮음 → bbox+여백으로 확장
        if quad_area(quad) < w * h * 0.04:
            quad = None
    if quad is None:
        # 사다리꼴(원근) 보존 폴백 — 껍질 단순화가 축 정렬로 퇴화할 때
        quad = extreme_corners(pts)
        if quad is not None:
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            aabb = (max(xs) - min(xs)) * (max(ys) - min(ys))
            if quad_area(quad) < aabb * 0.3 or quad_area(quad) < w * h * 0.02:
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


def _dominant_angle(img):
    """텍스트 주축 각도(도, ±90 정규화 후 −45~45 범위).

    옆으로 눕힌 문서는 ≈±90° 근처 — 방향 판정용. 상자 <3개면 None.
    """
    boxes = _ocr_boxes(img)
    if not boxes or len(boxes) < 3:
        return None

    def edge_ang(a, b):
        d = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        if d > 90.0:
            d -= 180.0
        if d < -90.0:
            d += 180.0
        return d

    angles = [(edge_ang(b[0], b[1]) + edge_ang(b[3], b[2])) / 2.0 for b in boxes]
    return _median(angles)


def _unrotate_point(p, deg, W, H):
    """PIL rotate(deg, expand=True)는 반시계 회전 — 회전된 좌표를 원본으로 되돌린다."""
    x, y = p
    if deg == 90:
        return (W - 1.0 - y, x)
    if deg == 270:
        return (y, H - 1.0 - x)
    if deg == 180:
        return (W - 1.0 - x, H - 1.0 - y)
    return (x, y)


def run(image_path, max_dim=1600, stretch_x=0.0, stretch_y=0.0, rotate=0):
    try:
        img = Image.open(image_path).convert('RGB')
    except Exception:
        return {"ok": False, "reason": "cannot read image"}
    w, h = img.size

    # 1) 기본 탐지 — 960px (720보다 작은 글씨까지 잡음)
    scale = min(1.0, 960.0 / max(w, h))
    small = img.resize((max(2, int(w * scale)), max(2, int(h * scale))), Image.LANCZOS) if scale < 1.0 else img
    method = 'dl'
    quad = text_quad(small)
    # 옆으로 눕힌 문서 — 부분 탐지가 통과하는 것을 차단하고 회전 재시도로
    if quad is not None:
        ang = _dominant_angle(small)
        if ang is not None and abs(ang) > 60.0:
            quad = None

    # 2) 고해상도 재시도 — 먼 거리/작은 글씨 (실패 경로에서만)
    if quad is None:
        hs = min(1.0, 1440.0 / max(w, h))
        if hs > scale:
            big = img.resize((max(2, int(w * hs)), max(2, int(h * hs))), Image.LANCZOS)
            q = text_quad(big)
            if q is not None:
                ang = _dominant_angle(big)
                if ang is not None and abs(ang) > 60.0:
                    q = None
                else:
                    quad = q
                    scale = hs

    # 3) 회전 재시도 — 가로/세로로 잘못 찍힌 사진 자동 교정 (실패 경로에서만)
    if quad is None:
        Ws, Hs = small.size
        for deg in (90, 270, 180):
            rot = small.rotate(deg, expand=True)
            q = text_quad(rot)
            if q is not None:
                quad = [_unrotate_point(p, deg, Ws, Hs) for p in q]
                quad = order_corners(quad)
                method = 'dl-rot' + str(deg)
                break

    if quad is None:
        quad = yolo_quad(small)
        method = 'yolo'
    if quad is None:
        return {"ok": False, "reason": "no document detected"}

    k = 1.0 / scale
    corners = [[x * k, y * k] for x, y in quad]
    out = warp_quad(img, corners, max_dim)

    # 4) DocGeoNet 정류 — 사용자 요청으로 비활성 (휜 문서 보정 안 함).
    #    사다리꼴 원근 보정은 위 QUAD 워프로 충분.

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

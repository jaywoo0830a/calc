"""scan_core — 문서 스캔 순수 로직 (cv2 없이 단위 테스트 가능)

이미지 좌표계: y↓
"""
from math import hypot


def order_corners(pts):
    """4개 꼭짓점을 [TL, TR, BR, BL] 순서로 정렬.

    TL = x+y 최소, BR = x+y 최대, TR = y−x 최소, BL = y−x 최대.
    """
    p = [(float(px), float(py)) for px, py in pts]
    tl = min(p, key=lambda a: a[0] + a[1])
    br = max(p, key=lambda a: a[0] + a[1])
    rest = [pt for pt in p if pt != tl and pt != br]
    if len(rest) != 2:
        raise ValueError('order_corners needs 4 distinct points')
    tr, bl = sorted(rest, key=lambda a: a[1] - a[0])
    return [tl, tr, br, bl]


def _dist(a, b):
    return hypot(a[0] - b[0], a[1] - b[1])


def size_for_quad(corners, max_dim=1600):
    """평균 가로·세로 길이로 워프 타깃 크기 계산 (max_dim 이하)."""
    tl, tr, br, bl = corners
    w = (_dist(tl, tr) + _dist(bl, br)) / 2.0
    h = (_dist(tl, bl) + _dist(tr, br)) / 2.0
    s = min(1.0, max_dim / max(w, h))
    return (max(2, int(round(w * s))), max(2, int(round(h * s))))


def with_margin(bbox, img_w, img_h, ratio=0.03):
    """bbox에 주변 여백을 더하고 이미지 경계로 클램프."""
    x, y, bw, bh = bbox
    mx = int(round(img_w * ratio))
    my = int(round(img_h * ratio))
    x0 = max(0, x - mx)
    y0 = max(0, y - my)
    x1 = min(img_w, x + bw + mx)
    y1 = min(img_h, y + bh + my)
    return (x0, y0, x1 - x0, y1 - y0)


def usable_bbox(bbox, img_w, img_h):
    """크롭할 가치가 있는 bbox인지 (10% 미만이거나 97% 초과면 무의미)."""
    x, y, bw, bh = bbox
    area = bw * bh
    total = img_w * img_h
    if area < total * 0.10 or area > total * 0.97:
        return False
    return bw >= 8 and bh >= 8

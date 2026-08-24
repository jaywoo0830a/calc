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
    """크롭할 가치가 있는 bbox인지 (5% 미만이거나 99.5% 초과면 무의미)."""
    x, y, bw, bh = bbox
    area = bw * bh
    total = img_w * img_h
    if area < total * 0.05 or area > total * 0.995:
        return False
    return bw >= 8 and bh >= 8


def shrink_quad(corners, ratio=0.008):
    """형태학 팽창으로 불어난 윤곽 테두리를 제거하기 위해
    각 꼭짓점을 중심 방향으로 대각선의 ratio만큼 수축."""
    cx = sum(p[0] for p in corners) / len(corners)
    cy = sum(p[1] for p in corners) / len(corners)
    diag = max(
        hypot(corners[0][0] - corners[2][0], corners[0][1] - corners[2][1]),
        hypot(corners[1][0] - corners[3][0], corners[1][1] - corners[3][1]),
    )
    d = diag * ratio
    out = []
    for x, y in corners:
        l = hypot(x - cx, y - cy)
        if l < 1e-6:
            out.append((x, y))
            continue
        s = max(0.0, 1.0 - d / l)
        out.append((cx + (x - cx) * s, cy + (y - cy) * s))
    return out


# ── 모델 기반 스캐너용 기하 (OpenCV 없이) ─────────────────────

def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def monotone_hull(pts):
    """Andrew monotone chain — 점들의 볼록 껍질 (반시계 방향)."""
    pts = sorted(set((float(x), float(y)) for x, y in pts))
    if len(pts) <= 1:
        return pts
    lower = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _rdp(pts, eps):
    """Ramer–Douglas–Peucker 단순화 (재귀)."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = hypot(b[0] - a[0], b[1] - a[1])
    if ab < 1e-9:
        return [a, b]
    dmax, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        d = abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / ab
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = _rdp(pts[:idx + 1], eps)
        right = _rdp(pts[idx:], eps)
        return left[:-1] + right
    return [a, b]


def simplify_to_quad(hull, min_eps=1.0, max_eps=80.0, steps=10):
    """볼록 껍질을 점진적으로 단순화해 4점 사각형 근사.
    실패 시 None."""
    if len(hull) <= 4:
        return list(hull) if len(hull) == 4 else None
    for i in range(steps):
        eps = min_eps + (max_eps - min_eps) * i / max(1, steps - 1)
        poly = _rdp(hull, eps)
        if len(poly) == 4:
            return poly
        if len(poly) < 4:
            break
    return None


def quad_area(corners):
    """신발끈 공식 — 4각형(또는 다각형) 면적."""
    s = 0.0
    for i in range(len(corners)):
        x1, y1 = corners[i]
        x2, y2 = corners[(i + 1) % len(corners)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def expand_quad(corners, factor, w, h):
    """4각형을 중심 기준 factor배 확장 후 이미지 경계로 클램프.
    factor=1.0이면 원본. 정류 모델이 '여백 포함 문서'를 기대하므로 사용."""
    cx = sum(p[0] for p in corners) / 4.0
    cy = sum(p[1] for p in corners) / 4.0
    out = []
    for x, y in corners:
        out.append((
            max(0.0, min(w - 1.0, cx + (x - cx) * factor)),
            max(0.0, min(h - 1.0, cy + (y - cy) * factor)),
        ))
    return out

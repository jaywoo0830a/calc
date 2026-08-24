"""scan_core — 문서 스캔 순수 로직 (cv2 없이 단위 테스트 가능)

이미지 좌표계: y↓
"""
from math import hypot, sqrt


def extreme_corners(pts):
    """여러 점에서 사다리꼴/직사각형의 4 극점 모서리를 [TL, TR, BR, BL]로 추출.

    TL = x+y 최소, BR = x+y 최대, TR = y−x 최소, BL = y−x 최대 —
    OCR 라인 박스들의 꼭짓점을 넣으면 문서 블록의 실제 모서리가 나온다
    (볼록 껍질 RDP처럼 축 정렬 사각형으로 퇴화하지 않음).
    """
    if not pts:
        return None
    tl = min(pts, key=lambda p: p[0] + p[1])
    br = max(pts, key=lambda p: p[0] + p[1])
    tr = min(pts, key=lambda p: p[1] - p[0])
    bl = max(pts, key=lambda p: p[1] - p[0])
    out = [(float(x), float(y)) for x, y in (tl, tr, br, bl)]
    # 4개가 모두 달라야 유효한 사각형
    if len(set(out)) < 4:
        return None
    return out


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


# ── 3차원 벡터 연산 (소실점 종횡비 추정용) ──
def _v3(x, y, z):
    return (x, y, z)


def _dot3(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub3(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross3(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _len3(a):
    return sqrt(_dot3(a, a))


def _norm3(a):
    n = _len3(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-12 else (0.0, 0.0, 0.0)


def _scale3(s, a):
    return (s * a[0], s * a[1], s * a[2])


def _line_intersect(p1, p2, p3, p4):
    """두 직선 p1p2, p3p4의 교점 (거의 평행이면 None)."""
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(d) < 1e-9:
        return None
    n1 = x1 * y2 - y1 * x2
    n2 = x3 * y4 - y3 * x4
    return ((n1 * (x3 - x4) - (x1 - x2) * n2) / d,
            (n1 * (y3 - y4) - (y1 - y2) * n2) / d)


def aspect_for_quad(corners, img_w, img_h):
    """종이(직사각형)의 실제 가로/세로 비율(w/h) 추정.

    소실점 + 핀홀 카메라(주점=이미지 중심) 가정으로 원근 왜곡을 제거해 계산.
    평균 변 길이 휴리스틱의 '찌그러짐'(aspect 오차)을 교정한다.
    평행/퇴화 케이스는 변 길이 비로 폴백. 결과는 [0.2, 5.0]으로 클램프.
    """
    tl, tr, br, bl = corners
    vx = _line_intersect(tl, tr, bl, br)   # 가로 방향 소실점
    vy = _line_intersect(tl, bl, tr, br)   # 세로 방향 소실점
    limit = 1e6 * max(img_w, img_h)
    if (vx is None or vy is None
            or max(abs(vx[0]), abs(vx[1])) > limit
            or max(abs(vy[0]), abs(vy[1])) > limit):
        w = (_dist(tl, tr) + _dist(bl, br)) / 2.0
        h = (_dist(tl, bl) + _dist(tr, br)) / 2.0
        return min(max(w / max(1e-6, h), 0.2), 5.0)
    px, py = img_w / 2.0, img_h / 2.0
    ax, ay = vx[0] - px, vx[1] - py
    bx, by = vy[0] - px, vy[1] - py
    # 직교 방향 소실점: (vx-p)·(vy-p) = −f²  →  초점거리 f 복원
    f2 = -(ax * bx + ay * by)
    if f2 <= 0.0:
        f = 1.4 * hypot(img_w, img_h)
    else:
        f = sqrt(f2)
        f = min(max(f, 0.3 * hypot(img_w, img_h)), 5.0 * hypot(img_w, img_h))
    # 소실점 → 3D 방향 벡터 (z=f 성분 포함)
    def _dir2(q):
        x, y = q[0] - px, q[1] - py
        return _norm3(_v3(x, y, f))
    u = _norm3(_v3(ax, ay, f))   # 가로축 방향
    v = _norm3(_v3(bx, by, f))   # 세로축 방향
    n = _cross3(u, v)
    n = _norm3(n)
    d0, d1, d2, d3 = _dir2(tl), _dir2(tr), _dir2(br), _dir2(bl)
    if _dot3(n, d0) < 0.0:
        n = _scale3(-1.0, n)
    # 코너 광선을 문서 평면에 역투영해 변의 실제 길이비 계산
    def _side(da, db):
        na = _dot3(da, n)
        nb = _dot3(db, n)
        if abs(na) < 1e-6 or abs(nb) < 1e-6:
            return None
        return _sub3(_scale3(1.0 / nb, db), _scale3(1.0 / na, da))
    w_vec = _side(d0, d1)   # 가로 변 (q0→q1)
    h_vec = _side(d0, d3)   # 세로 변 (q0→q3)
    if w_vec is None or h_vec is None:
        w = (_dist(tl, tr) + _dist(bl, br)) / 2.0
        h = (_dist(tl, bl) + _dist(tr, br)) / 2.0
        return min(max(w / max(1e-6, h), 0.2), 5.0)
    t = _len3(w_vec) / max(1e-6, _len3(h_vec))
    t = min(max(t, 0.2), 5.0)
    # 안전 가드: 소실점 추정이 변 길이 비와 크게 어긋나면(퇴화 케이스) 폴백
    t_edges = ((_dist(tl, tr) + _dist(bl, br)) / 2.0) / max(1e-6, (_dist(tl, bl) + _dist(tr, br)) / 2.0)
    if t < t_edges * 0.5 or t > t_edges * 2.0:
        return min(max(t_edges, 0.2), 5.0)
    return t


def size_for_quad(corners, max_dim=1600, img_w=None, img_h=None):
    """워프 타깃 크기 계산 (max_dim 이하).

    img_w/img_h가 주어지면 소실점 기반의 실제 종횡비로 크기를 정해
    원근 왜곡으로 인한 '찌그러짐'을 방지한다.
    """
    tl, tr, br, bl = corners
    mean_w = (_dist(tl, tr) + _dist(bl, br)) / 2.0
    mean_h = (_dist(tl, bl) + _dist(tr, br)) / 2.0
    if img_w is not None and img_h is not None:
        t = aspect_for_quad(corners, img_w, img_h)
    else:
        t = mean_w / max(1e-6, mean_h)
    if t >= 1.0:
        w = mean_w
        h = w / t
    else:
        h = mean_h
        w = h * t
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

"""scan_core 순수 함수 테스트 — cv2 불필요.

실행: python3 -m unittest server/scan_core_test.py
"""
import unittest

from scan_core import (
    aspect_for_quad,
    expand_quad,
    monotone_hull,
    order_corners,
    quad_area,
    shrink_quad,
    simplify_to_quad,
    size_for_quad,
    usable_bbox,
    with_margin,
)


class OrderCornersTest(unittest.TestCase):
    def test_keeps_sorted(self):
        pts = [[10, 20], [200, 20], [200, 150], [10, 150]]
        self.assertEqual(order_corners(pts), [(10.0, 20.0), (200.0, 20.0), (200.0, 150.0), (10.0, 150.0)])

    def test_shuffled(self):
        pts = [[200, 150], [10, 20], [10, 150], [200, 20]]
        self.assertEqual(order_corners(pts), [(10.0, 20.0), (200.0, 20.0), (200.0, 150.0), (10.0, 150.0)])

    def test_tilted(self):
        pts = [[180, 130], [40, 170], [160, 40], [20, 50]]
        out = order_corners(pts)
        self.assertEqual(out[0], (20.0, 50.0))    # TL = x+y 최소
        self.assertEqual(out[2], (180.0, 130.0))  # BR = x+y 최대


class SizeForQuadTest(unittest.TestCase):
    def test_keep_small(self):
        self.assertEqual(size_for_quad([[0, 0], [800, 0], [800, 800], [0, 800]], 1600), (800, 800))

    def test_scale_down_keep_ratio(self):
        self.assertEqual(
            size_for_quad([[0, 0], [4000, 0], [4000, 3000], [0, 3000]], 1600), (1600, 1200))

    def test_parallelogram_avg_sides(self):
        self.assertEqual(
            size_for_quad([[0, 0], [600, 0], [700, 400], [100, 400]], 1600),
            (600, round((100**2 + 400**2) ** 0.5)))

    def test_frontoparallel_aspect(self):
        # 정면 200×280 — 소실점 무한대 → 폴백, aspect 유지
        self.assertEqual(
            size_for_quad([[0, 0], [200, 0], [200, 280], [0, 280]], 1600, 2000, 2000),
            (200, 280))


class AspectForQuadTest(unittest.TestCase):
    def test_affine_frontoparallel(self):
        quad = [[0, 0], [200, 0], [200, 280], [0, 280]]
        self.assertAlmostEqual(aspect_for_quad(quad, 2000, 2000), 200 / 280, places=3)

    def test_perspective_known_camera(self):
        # 핀홀 K(f=1000, 주점=(1000,1000)) — 두 축으로 기울어진 평면 위 12×17 직사각형
        import math
        W, H = 12.0, 17.0
        theta, phi = math.radians(25), math.radians(15)
        ct, st = math.cos(theta), math.sin(theta)
        cp, sp = math.cos(phi), math.sin(phi)
        z0, f = 600.0, 1000.0
        quad = []
        for x3, y3 in ((-W / 2, -H / 2), (W / 2, -H / 2), (W / 2, H / 2), (-W / 2, H / 2)):
            X = x3 * ct + z0 * st
            Z1 = -x3 * st + z0 * ct
            Y = y3 * cp + Z1 * sp
            Z = -y3 * sp + Z1 * cp
            quad.append([1000.0 + f * X / Z, 1000.0 + f * Y / Z])
        t = aspect_for_quad(quad, 2000, 2000)
        self.assertAlmostEqual(t, W / H, delta=0.03 * W / H)

    def test_trapezoid_parallel_sides(self):
        quad = [[0, 0], [600, 0], [700, 400], [100, 400]]
        t = aspect_for_quad(quad, 2000, 2000)
        self.assertAlmostEqual(t, 600 / (100**2 + 400**2) ** 0.5, places=3)


class MarginTest(unittest.TestCase):
    def test_clamps_to_bounds(self):
        bbox = (10, 10, 100, 100)
        self.assertEqual(with_margin(bbox, 200, 200, 0.03), (4, 4, 112, 112))

    def test_negative_margin_clamped(self):
        bbox = (0, 0, 50, 50)
        self.assertEqual(with_margin(bbox, 100, 100, 0.03), (0, 0, 53, 53))


class ShrinkQuadTest(unittest.TestCase):
    def test_moves_corners_toward_center(self):
        q = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]
        out = shrink_quad(q, 0.008)
        # 각 꼭짓점이 대각선의 ratio만큼 중심 쪽으로 이동
        self.assertAlmostEqual(out[0][0], 0.8, places=2)
        self.assertAlmostEqual(out[0][1], 0.8, places=2)
        self.assertAlmostEqual(out[2][0], 99.2, places=2)
        self.assertAlmostEqual(out[2][1], 99.2, places=2)

    def test_ratio_zero_unchanged(self):
        q = [(1.0, 2.0), (3.0, 2.0), (3.0, 5.0), (1.0, 5.0)]
        self.assertEqual(shrink_quad(q, 0.0), q)


class QuadAreaTest(unittest.TestCase):
    def test_rectangle(self):
        self.assertEqual(quad_area([(0, 0), (10, 0), (10, 5), (0, 5)]), 50.0)

    def test_parallelogram(self):
        self.assertEqual(quad_area([(0, 0), (4, 0), (5, 3), (1, 3)]), 12.0)


class ExpandQuadTest(unittest.TestCase):
    def test_identity(self):
        quad = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
        self.assertEqual(expand_quad(quad, 1.0, 100, 100), quad)

    def test_grow_from_center(self):
        quad = [(2.0, 2.0), (8.0, 2.0), (8.0, 8.0), (2.0, 8.0)]
        out = expand_quad(quad, 1.5, 100, 100)
        self.assertEqual(out, [(0.5, 0.5), (9.5, 0.5), (9.5, 9.5), (0.5, 9.5)])

    def test_clamp_to_bounds(self):
        quad = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
        out = expand_quad(quad, 3.0, 20, 20)
        self.assertTrue(all(0.0 <= x <= 19.0 and 0.0 <= y <= 19.0 for x, y in out))
        self.assertEqual(out[0], (0.0, 0.0))  # TL은 코너에 고정


class HullTest(unittest.TestCase):
    def test_square_hull(self):
        pts = [(0, 0), (10, 0), (10, 10), (0, 10), (5, 5)]
        hull = monotone_hull(pts)
        self.assertEqual(len(hull), 4)
        self.assertEqual(sorted(hull), sorted([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]))

    def test_trapezoid_hull(self):
        pts = [(180, 150), (1500, 300), (1400, 1080), (300, 1000), (800, 600)]
        hull = monotone_hull(pts)
        self.assertEqual(len(hull), 4)
        self.assertIn((180.0, 150.0), hull)


class SimplifyToQuadTest(unittest.TestCase):
    def test_quad_hull_returns_itself(self):
        hull = [(0.0, 0.0), (100.0, 0.0), (100.0, 80.0), (0.0, 80.0)]
        self.assertEqual(simplify_to_quad(hull), hull)

    def test_noisy_hull_simplifies_to_4(self):
        # 사각형 가장자리에 잔점이 섞인 껍질 → 4점으로 단순화
        hull = [
            (0.0, 0.0), (20.0, 1.0), (40.0, 0.5), (60.0, 0.0), (80.0, -0.5), (100.0, 0.0),
            (100.0, 30.0), (99.5, 60.0), (100.0, 80.0),
            (60.0, 79.5), (20.0, 80.5), (0.0, 80.0),
            (0.0, 50.0), (0.0, 20.0),
        ]
        quad = simplify_to_quad(hull)
        self.assertIsNotNone(quad)
        self.assertEqual(len(quad), 4)

    def test_triangle_returns_none(self):
        self.assertIsNone(simplify_to_quad([(0.0, 0.0), (10.0, 0.0), (5.0, 10.0)]))


class UsableBBoxTest(unittest.TestCase):
    def test_too_small_rejected(self):
        self.assertFalse(usable_bbox((0, 0, 5, 5), 1000, 1000))

    def test_nearly_whole_rejected(self):
        # 99.8% — 자르는 의미 없음
        self.assertFalse(usable_bbox((1, 1, 999, 999), 1000, 1000))

    def test_almost_whole_accepted(self):
        # 98% — 살짝이라도 트리밍 여지 있으면 허용
        self.assertTrue(usable_bbox((10, 10, 990, 990), 1000, 1000))

    def test_normal_accepted(self):
        self.assertTrue(usable_bbox((50, 50, 800, 900), 1000, 1000))


if __name__ == '__main__':
    unittest.main()

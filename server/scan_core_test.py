"""scan_core 순수 함수 테스트 — cv2 불필요.

실행: python3 -m unittest server/scan_core_test.py
"""
import unittest

from scan_core import order_corners, size_for_quad, usable_bbox, with_margin


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


class MarginTest(unittest.TestCase):
    def test_clamps_to_bounds(self):
        bbox = (10, 10, 100, 100)
        self.assertEqual(with_margin(bbox, 200, 200, 0.03), (4, 4, 112, 112))

    def test_negative_margin_clamped(self):
        bbox = (0, 0, 50, 50)
        self.assertEqual(with_margin(bbox, 100, 100, 0.03), (0, 0, 53, 53))


class UsableBBoxTest(unittest.TestCase):
    def test_too_small_rejected(self):
        self.assertFalse(usable_bbox((0, 0, 5, 5), 1000, 1000))

    def test_nearly_whole_rejected(self):
        self.assertFalse(usable_bbox((5, 5, 990, 990), 1000, 1000))

    def test_normal_accepted(self):
        self.assertTrue(usable_bbox((50, 50, 800, 900), 1000, 1000))


if __name__ == '__main__':
    unittest.main()

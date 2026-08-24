#!/usr/bin/env python3
"""scan — LiteObject/doc-scanner 기반 문서 스캐너

https://github.com/LiteObject/doc-scanner (opencv + numpy만 사용)

파이프라인 (lite_scanner.py = 원본 scanner.py 그대로 vendor):
  1) 높이 500으로 축소 → 회색조 → GaussianBlur(5,5) → Canny(75,200)
  2) 가장 큰 외곽선 5개에서 approxPolyDP 4각형 근사 (epsilon 후보 9종)
  3) 실패 시 Canny 임계값 8종 재시도, 그래도 안 되면 최소 면적 폴백
  4) four_point_transform으로 원근 펼치기 → 색상 그대로 반환

사용: python3 scan.py <image_path> [maxDim=1600] [rotate]
출력: JSON {"ok": true, "dataUrl": ..., "aspect": ..., "method": "lite"}
"""
import base64
import io
import json
import sys

import cv2
import numpy as np
from PIL import Image

from lite_scanner import four_point_transform

# lite_scanner.py(scanner.py)의 기본 파라미터와 동일
_EPSILON_CANDIDATES = [0.02, 0.03, 0.015, 0.025, 0.01, 0.035, 0.04, 0.045, 0.05]
_ALT_CANNY_PARAMS = [(50, 150), (100, 250), (30, 100), (150, 300),
                    (20, 80), (40, 120), (60, 180), (80, 240)]
_MIN_AREA = 1000          # 1차 채택 최소 면적 (축소 이미지 좌표, px)
_FALLBACK_MIN_AREA = 500  # 최종 폴백 최소 면적
_MIN_AREA_FRAC = 0.04     # 선택 영역이 전체의 4% 미만이면 폴백


def _quad_for(c):
    """외곽선을 4각형으로 근사 (epsilon 후보 순차 시도). 실패 시 None."""
    peri = cv2.arcLength(c, True)
    for eps in _EPSILON_CANDIDATES:
        approx = cv2.approxPolyDP(c, eps * peri, True)
        if len(approx) == 4:
            return approx
    return None


def _detect_quad(bgr):
    """BGR 이미지 → 문서 4각형 (원본 해상도 좌표, (4,2) float32) | None.

    scanner.py의 main() 탐지 흐름을 그대로 재현 (출력 없이 메모리에서만).
    """
    if bgr is None or bgr.shape[0] == 0 or bgr.shape[1] == 0:
        return None
    orig = bgr
    ratio = orig.shape[0] / 500.0
    img = cv2.resize(orig, (max(1, int(orig.shape[1] / ratio)), 500))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    screen_contour = None
    best_fallback = {'contour': None, 'area': 0}

    def consider(c, area):
        """면적 요건 + 4각형 근사를 검토. 채택되면 True.

        원본과 동일하게 최대 폴백 4각형도 동시에 갱신한다.
        """
        nonlocal screen_contour
        q = _quad_for(c)
        if q is not None and area > best_fallback['area']:
            best_fallback['contour'] = q
            best_fallback['area'] = area
        if area < _MIN_AREA:
            return False
        if q is not None:
            screen_contour = q
            return True
        return False

    def check_edges(edged):
        contours, _ = cv2.findContours(edged.copy(), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        if len(contours) == 0:
            return
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
            if consider(c, cv2.contourArea(c)):
                return

    # 1차: 기본 Canny(75, 200)
    check_edges(cv2.Canny(gray, 75, 200))

    # 2차: 임계값 8종 재시도
    if screen_contour is None:
        for low, high in _ALT_CANNY_PARAMS:
            check_edges(cv2.Canny(gray, low, high))
            if screen_contour is not None:
                break

    # 3차: 면적 요건 미달이지만 유효한 최대 4각형 폴백
    if screen_contour is None and best_fallback['contour'] is not None:
        if best_fallback['area'] >= _FALLBACK_MIN_AREA:
            screen_contour = best_fallback['contour']

    if screen_contour is None:
        return None

    # 선택 영역이 너무 작으면(노이즈) 원본과 동일하게 폴백 처리
    total = float(img.shape[0] * img.shape[1])
    frac = float(cv2.contourArea(screen_contour)) / (total + 1e-6)
    if frac < _MIN_AREA_FRAC:
        return None

    return screen_contour.reshape(4, 2).astype(np.float32) * ratio


def _scan_document(img):
    """PIL RGB 이미지 → 펼쳐진 PIL RGB 이미지. 프레임 미검출 시 None."""
    arr = np.asarray(img.convert('RGB'))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    pts = _detect_quad(bgr)
    if pts is None:
        return None
    warped = four_point_transform(bgr, pts)
    if warped is None or warped.shape[0] == 0 or warped.shape[1] == 0:
        return None
    return Image.fromarray(cv2.cvtColor(warped, cv2.COLOR_BGR2RGB))


def run(image_path, max_dim=1600, rotate=0):
    try:
        img = Image.open(image_path).convert('RGB')
    except Exception:
        return {"ok": False, "reason": "cannot read image"}

    # 1) LiteObject/doc-scanner — 프레임 탐지 + 원근 펼치기
    try:
        out = _scan_document(img)
    except Exception:
        out = None
    if out is None:
        return {"ok": False, "reason": "no document detected"}

    m = max(out.width, out.height)
    if m > max_dim:
        s = max_dim / float(m)
        out = out.resize((max(2, int(out.width * s)), max(2, int(out.height * s))), Image.LANCZOS)

    # 2) 90° 단위 회전 — 처리된 이미지에 적용 (0 = 그대로)
    if rotate in (90, 180, 270):
        out = out.rotate(rotate, expand=True)

    buf = io.BytesIO()
    out.save(buf, format='JPEG', quality=90)
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    return {"ok": True, "dataUrl": data_url,
            "aspect": out.width / float(out.height), "method": "lite"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "usage: scan.py <image_path> [maxDim] [rotate]"}))
        return
    max_dim = int(sys.argv[2]) if len(sys.argv) > 2 else 1600
    rotate = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    print(json.dumps(run(sys.argv[1], max_dim, rotate)))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""scan — fMeow/document-scanner 기반 문서 스캐너

파이프라인 (패키지 공식 README 그대로):
  1) HSV Value 채널 → scanner.scan() — 전처리(median blur·histogram eq·형태학)
     → Canny → Hough 라인 → 교차점 연결성 → 코너/프레임 탐지 → warp
  2) Value 채널에서 프레임을 못 찾으면 Saturation 채널로 동일 파이프라인 재시도

사용: python3 scan.py <image_path> [maxDim=1600] [stretchX] [stretchY] [rotate]
출력: JSON {"ok": true, "dataUrl": ..., "aspect": ..., "method": "scan"}
"""
import base64
import io
import json
import sys

import cv2
import numpy as np
from PIL import Image

from doc_scanner import scanner


def _scan_document(img):
    """PIL RGB 이미지 → 스캔된 PIL RGB 이미지. 프레임 미검출 시 None.

    공식 README 순서: Value(명도) 우선, 실패하면 Saturation(채도) 폴백.
    """
    arr = np.asarray(img.convert('RGB'))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    for channel in (2, 1):
        s = scanner(hsv[:, :, channel])
        try:
            s.scan()
        except Exception:
            continue
        if s.corners is None:
            continue
        try:
            warped = s.warp(bgr)
        except Exception:
            continue
        return Image.fromarray(cv2.cvtColor(warped, cv2.COLOR_BGR2RGB))
    return None


def run(image_path, max_dim=1600, stretch_x=0.0, stretch_y=0.0, rotate=0):
    try:
        img = Image.open(image_path).convert('RGB')
    except Exception:
        return {"ok": False, "reason": "cannot read image"}

    # 1) fMeow/document-scanner — 프레임 탐지 + 워프
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

    # 2) 가로/세로 늘이기 — 처리된 이미지에 비율 적용 (0 = 순정 그대로)
    if stretch_x > 0.0 or stretch_y > 0.0:
        nw = max(2, int(round(out.width * (1.0 + stretch_x))))
        nh = max(2, int(round(out.height * (1.0 + stretch_y))))
        out = out.resize((nw, nh), Image.LANCZOS)

    # 3) 90° 단위 회전 — 처리된 이미지에 적용 (0 = 그대로)
    if rotate in (90, 180, 270):
        out = out.rotate(rotate, expand=True)

    buf = io.BytesIO()
    out.save(buf, format='JPEG', quality=90)
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    return {"ok": True, "dataUrl": data_url,
            "aspect": out.width / float(out.height), "method": "scan"}


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

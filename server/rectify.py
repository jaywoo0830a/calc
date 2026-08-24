#!/usr/bin/env python3
"""rectify — DocGeoNet(ECCV 2022) 문서 정류(dewarp) 래퍼 (CPU 전용)

원저자: Hao Feng (fh2019ustc/DocGeoNet)
라이선스: 비상업용 (server/docgeonet/LICENSE.md) — 출처 표시 + 동일 조건.
이 파일은 원본 inference.py를 CPU에서 그대로 재현한 것이다.

동작 (공식 레시피 그대로):
  입력 → 256×256 리사이즈 → U2-Net-P 마스크 → DocGeoNet bm 플로우
  → 원본 해상도로 cv2.resize + cv2.blur(3×3) → F.grid_sample 워프
입력 PIL.Image → 출력 PIL.Image (같은 크기, RGB)
모델/가중치가 없으면 None (scan.py가 기존 크롭 결과로 폴백).
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'docgeonet'))
MODEL_DIR = os.path.join(HERE, 'models', 'docgeonet')

_net = None
_load_failed = False


class Net(nn.Module):
    def __init__(self):
        super().__init__()
        from seg import U2NETP
        from model import DocGeoNet
        self.msk = U2NETP(3, 1)
        self.DocTr = DocGeoNet()

    def forward(self, x):
        msk, _1, _2, _3, _4, _5, _6 = self.msk(x)
        msk = (msk > 0.5).float()
        x = msk * x
        _, _, bm = self.DocTr(x)
        bm = (2 * (bm / 255.0) - 1) * 0.99
        return bm


def _load_state(path, strip, target):
    """원본 reload 로직 그대로: prefix strip 후 겹치는 키만 갱신."""
    try:
        checkpoint = torch.load(path, map_location='cpu', weights_only=True)
    except Exception:
        checkpoint = torch.load(path, map_location='cpu')
    checkpoint = {k[strip:]: v for k, v in checkpoint.items() if k[strip:] in target}
    target.update(checkpoint)
    return target


def _load():
    global _net, _load_failed
    if _net is not None or _load_failed:
        return _net
    seg_p = os.path.join(MODEL_DIR, 'preprocess.pth')
    rec_p = os.path.join(MODEL_DIR, 'DocGeoNet.pth')
    if not (os.path.exists(seg_p) and os.path.exists(rec_p)):
        _load_failed = True
        return None
    try:
        net = Net().eval()
        net.msk.load_state_dict(_load_state(seg_p, 6, net.msk.state_dict()))
        net.DocTr.load_state_dict(_load_state(rec_p, 7, net.DocTr.state_dict()))
        _net = net
    except Exception:
        _load_failed = True
        return None
    return _net


def rectify_flow(img):
    """공식 레시피 정류 + 플로우 편차 크기.

    반환: (정류된 PIL 이미지 또는 None, 플로우 편차 mag)
      - None: 모델/가중치 없음, 실패, 또는 사실상 항등(mag < 0.003)
      - mag: 항등 그리드 대비 mean-abs 편차 (클수록 왜곡이 큼) — 판정용
    """
    net = _load()
    if net is None:
        return (None, 0.0)
    try:
        im_ori = np.array(img.convert('RGB'))[:, :, :3] / 255.0
        h, w, _ = im_ori.shape
        im = cv2.resize(im_ori, (256, 256))
        im = im.transpose(2, 0, 1)
        im = torch.from_numpy(im).float().unsqueeze(0)
        with torch.no_grad():
            bm = net(im)
            bm = bm.cpu()
        # 공식 그대로: bm을 원본 크기로 확대 후 3×3 블러
        bm0 = cv2.resize(bm[0, 0].numpy(), (w, h))
        bm1 = cv2.resize(bm[0, 1].numpy(), (w, h))
        bm0 = cv2.blur(bm0, (3, 3))
        bm1 = cv2.blur(bm1, (3, 3))
        # 평평한 문서: 플로우가 항등에 가까우면 정류 결과를 버린다 —
        # 불필요한 미세 왜곡을 만들지 않기 위해 (scan.py가 판정에 사용)
        id_x = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
        id_y = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
        mag = float(np.abs(bm0 - id_x).mean() + np.abs(bm1 - id_y).mean())
        if mag < 0.003:
            return (None, mag)
        lbl = torch.from_numpy(np.stack([bm0, bm1], axis=2)).unsqueeze(0)
        out = F.grid_sample(
            torch.from_numpy(im_ori).permute(2, 0, 1).unsqueeze(0).float(),
            lbl, align_corners=True)
        # 공식은 cv2.imwrite(BGR 저장)용 [:, :, ::-1] 변환 — 여기선 PIL(RGB)이라 생략
        out = (out[0] * 255.0).permute(1, 2, 0).numpy().clip(0, 255).astype(np.uint8)
        return (Image.fromarray(out, 'RGB'), mag)
    except Exception:
        return (None, 0.0)


def rectify(img):
    """PIL 이미지 → 정류된 PIL 이미지. 모델/가중치 없거나 실패/항등이면 None."""
    out, _ = rectify_flow(img)
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'reason': 'usage: rectify.py <image> [out]'}))
        return
    img = Image.open(sys.argv[1]).convert('RGB')
    out = rectify(img)
    if out is None:
        print(json.dumps({'ok': False, 'reason': 'model unavailable'}))
        return
    dst = sys.argv[2] if len(sys.argv) > 2 else '/tmp/rectified.jpg'
    out.save(dst, format='JPEG', quality=90)
    print(json.dumps({'ok': True, 'out': dst, 'size': list(out.size)}))


if __name__ == '__main__':
    main()

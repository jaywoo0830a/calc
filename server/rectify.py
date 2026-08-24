#!/usr/bin/env python3
"""rectify — DocGeoNet(ECCV 2022) 문서 정류(dewarp) 래퍼 (CPU 전용)

원저자: Hao Feng (fh2019ustc/DocGeoNet)
라이선스: 비상업용 (server/docgeonet/LICENSE.md) — 출처 표시 + 동일 조건.
이 파일은 원본 inference.py를 서버 통합용으로 수정한 것이다.

동작:
  U2-Net-P(문서 마스크) → DocGeoNet(역방향 플로우 bm) → F.grid_sample 워프
입력 PIL.Image → 출력 PIL.Image (같은 크기, RGB)
모델/가중치가 없으면 None (scan.py가 기존 크롭 결과로 폴백).
"""
import io
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

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


def _resize_blur(ch, w, h):
    """플로우 채널 [-1,1] → uint8 스케일 → 리사이즈(BILINEAR)+3×3 박스 블러 → 복원."""
    arr = (ch * 127.5 + 127.5).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr, 'L').resize((w, h), Image.BILINEAR).filter(ImageFilter.BoxBlur(1))
    return np.asarray(img, dtype=np.float32) / 127.5 - 1.0


def rectify(img, max_side=1600):
    """PIL 이미지 → 정류된 PIL 이미지. 모델/가중치 없거나 실패 시 None."""
    net = _load()
    if net is None:
        return None
    try:
        w0, h0 = img.size
        scale = min(1.0, max_side / float(max(w0, h0)))
        if scale < 1.0:
            img = img.resize((max(2, int(w0 * scale)), max(2, int(h0 * scale))), Image.LANCZOS)
        w, h = img.size
        im_ori = np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0
        im256 = np.asarray(img.resize((256, 256), Image.BILINEAR), dtype=np.float32) / 255.0
        im = torch.from_numpy(im256.transpose(2, 0, 1)).float().unsqueeze(0)
        with torch.no_grad():
            bm = net(im)[0].numpy()  # (2, 256, 256)
        # 플로우를 원본 해상도로 확대 + 3×3 박스 블러 (원본 cv2.blur 동일 효과)
        bm0 = _resize_blur(bm[0], w, h)
        bm1 = _resize_blur(bm[1], w, h)
        grid = torch.from_numpy(np.stack([bm0, bm1], axis=2)).unsqueeze(0).float()
        src = torch.from_numpy(im_ori.transpose(2, 0, 1)).unsqueeze(0).float()
        out = F.grid_sample(src, grid, align_corners=True)
        out = (out[0] * 255.0).permute(1, 2, 0).numpy().clip(0, 255).astype(np.uint8)
        return Image.fromarray(out, 'RGB')
    except Exception:
        return None


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

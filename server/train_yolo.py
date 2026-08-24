#!/usr/bin/env python3
"""train_yolo — 자가 학습 YOLO 문서 탐지 모델 스캐폴드

용법 (선택 사항):
  1. 사진을 server/train/images/ 에 넣는다 (30~50장 권장, 보드/종이가 온전히 보이는 것)
  2. 라벨링: 각 사진의 종이 영역을 YOLO 형식으로 server/train/labels/<파일명>.txt 에
     `class_id cx cy w h` (0~1 정규화, class_id=0) 한 줄로 기록
     (라벨링 도구: https://www.makesense.ai 등 무료 웹 도구)
  3. 실행: python3 train_yolo.py
  4. 생성된 server/models/document.pt 를 배포하면 scan.py가 자동으로 사용
"""
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / 'train' / 'images'
LABELS = ROOT / 'train' / 'labels'
OUT = ROOT / 'models' / 'document.pt'

DATASET_YAML = """
path: {root}
train: train/images
val: train/images
names:
  0: document
"""


def main():
    if not IMAGES.exists() or not any(IMAGES.glob('*')):
        print('❌ 사진이 없습니다: server/train/images/ 에 30~50장 넣고 라벨링 후 다시 실행하세요.')
        return
    try:
        from ultralytics import YOLO
    except ImportError:
        print('❌ ultralytics 미설치 — pip install ultralytics 후 실행하세요.')
        return

    (ROOT / 'dataset.yaml').write_text(DATASET_YAML.format(root=ROOT), encoding='utf-8')
    model = YOLO('yolo11n.pt')  # 사전학습 가중치에서 파인튜닝
    model.train(data=str(ROOT / 'dataset.yaml'), epochs=80, imgsz=640, batch=8, verbose=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    best = ROOT / 'runs' / 'detect' / 'train' / 'weights' / 'best.pt'
    if best.exists():
        shutil.copy(best, OUT)
        print(f'✅ 모델 저장: {OUT}')
    else:
        print('❌ best.pt 를 찾지 못했습니다 — 훈련 로그를 확인하세요.')


if __name__ == '__main__':
    main()

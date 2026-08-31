# ═══════════════════════════════════════════════════════════════
# calc-ocr — PaddleOCR-VL (0.9B) formula → LaTeX (CPU 최적화)
# transformers + CPU torch (float32). 모델 가중치는 첫 실행 시
# HF_HOME(/cache)으로 내려받는다 (볼륨 유지 권장).
# ═══════════════════════════════════════════════════════════════
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/cache \
    HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

WORKDIR /app

# transformers를 git에서 설치(모델 카드 권장) — slim 이미지에 git 없음
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# CPU torch 먼저 (PyPI CUDA 휠 대신) → 나머지 의존성은 PyPI에서
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py

EXPOSE 8080
CMD ["python", "main.py"]

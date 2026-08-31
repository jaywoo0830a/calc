#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# GLM-OCR GGUF 다운로드 → llama-server 실행 (CPU)
# GGUF는 볼륨(/models)에 내려받아 재배포 시 재다운로드 방지.
#   - GLM-OCR-Q8_0.gguf          : 본문(0.9B) Q8_0 양자화
#   - mmproj-GLM-OCR-Q8_0.gguf   : 비전 인코더(멀티모달 프로젝터) — 필수
# ═══════════════════════════════════════════════════════════════
set -e

MODELS_DIR="${MODELS_DIR:-/models}"
LLAMA_DIR="${LLAMA_DIR:-/opt/llama-b10621}"
HF_BASE="https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main"
MODEL_GGUF="${GLM_OCR_GGUF:-GLM-OCR-Q8_0.gguf}"
MMPROJ_GGUF="${GLM_OCR_MMPROJ:-mmproj-GLM-OCR-Q8_0.gguf}"

mkdir -p "$MODELS_DIR"

fetch() {
  f="$1"
  if [ -s "$MODELS_DIR/$f" ]; then
    echo "[ocr] $f already present"
    return 0
  fi
  echo "[ocr] downloading $f ..."
  # -C - : 이어받기, --retry : 일시적 네트워크 오류 재시도
  curl -L --fail --retry 8 --retry-delay 5 -C - \
    -o "$MODELS_DIR/$f.part" "$HF_BASE/$f"
  mv "$MODELS_DIR/$f.part" "$MODELS_DIR/$f"
  echo "[ocr] $f ready ($(du -h "$MODELS_DIR/$f" | cut -f1))"
}

fetch "$MODEL_GGUF"
fetch "$MMPROJ_GGUF"

# exec → 시그널/Docker stop이 llama-server로 전달됨
exec "$LLAMA_DIR/llama-server" \
  -m "$MODELS_DIR/$MODEL_GGUF" \
  -mm "$MODELS_DIR/$MMPROJ_GGUF" \
  --host 0.0.0.0 \
  --port "${PORT:-8080}" \
  -c "${LLAMA_CTX:-8192}" \
  --no-webui \
  -a "GLM-OCR"

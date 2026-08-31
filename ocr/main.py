# ═══════════════════════════════════════════════════════════════
# OCR service — PaddleOCR-VL (0.9B) formula → LaTeX, CPU-optimized
# ---------------------------------------------------------------
# Runs the PaddleOCR-VL VLM via `transformers` on CPU (float32) and
# exposes an OpenAI-compatible POST /v1/chat/completions so the Node
# proxy (server/index.js → /api/math-ocr) works unchanged.
#
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
#                  -f docker-compose.ocr.yml up -d --build
#
# Performance notes (CPU):
#   - float32 needs ~3.5 GB RAM for the 0.9B model.
#   - First request downloads the weights (HF_HOME) then loads (~1 min);
#     subsequent calls run inference (~5-30 s on a modern CPU).
#   - For a much faster CPU path, serve a GGUF quant via llama.cpp
#     (HF "quantized" community models) — the endpoint shape is identical.
# ═══════════════════════════════════════════════════════════════
import base64
import io
import re
import threading
from typing import List, Optional

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoProcessor
from PIL import Image

MODEL = "PaddlePaddle/PaddleOCR-VL"
DEFAULT_PROMPT = "Formula Recognition:"

app = FastAPI(title="calc-ocr", version="1.0.0")

_model = None
_processor = None
_lock = threading.Lock()


class ChatMessage(BaseModel):
    role: str
    content: object  # str | list[dict]


class ChatBody(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


def _load():
    """지연 로드 — 첫 요청에서만 가중치를 내려받아 CPU로 로드"""
    global _model, _processor
    with _lock:
        if _model is None:
            _processor = AutoProcessor.from_pretrained(MODEL, trust_remote_code=True)
            _model = AutoModelForCausalLM.from_pretrained(
                MODEL,
                trust_remote_code=True,
                torch_dtype=torch.float32,
            ).to("cpu").eval()
            print("ocr model loaded", flush=True)


def _extract_image(messages) -> Optional[Image.Image]:
    for m in messages:
        content = m.content
        if isinstance(content, str):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                if url.startswith("data:image"):
                    b64 = url.split("base64,", 1)[-1]
                    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    return None


def _extract_prompt(messages) -> str:
    for m in messages:
        content = m.content
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
                    return str(part["text"])
    return DEFAULT_PROMPT


def _clean(text: str) -> str:
    # 특수 토큰/프롬프트 반향/펜스/달러 제거 → 순수 LaTeX
    out = re.sub(r"<\|.*?\|>", "", text)
    out = re.sub(r"```(?:latex|tex)?", "", out)
    out = re.sub(r"```", "", out)
    out = out.replace(DEFAULT_PROMPT, "").strip()
    out = re.sub(r"^\$\$?", "", out).strip()
    out = re.sub(r"\$\$?$", "", out).strip()
    return out


@app.post("/v1/chat/completions")
def chat_completions(body: ChatBody):
    _load()
    image = _extract_image(body.messages)
    if image is None:
        raise HTTPException(status_code=400, detail="image_url is required")
    prompt = _extract_prompt(body.messages) or DEFAULT_PROMPT

    messages = [
        {"role": "user", "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": prompt},
        ]},
    ]
    inputs = _processor.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True,
        return_dict=True, return_tensors="pt",
    )
    inputs.pop("token_type_ids", None)

    with _lock:
        with torch.no_grad():
            outputs = _model.generate(
                **inputs,
                max_new_tokens=min(body.max_tokens or 512, 1024),
                do_sample=False,  # 결정적 — OCR은 샘플링 불필요
            )
    output = _processor.batch_decode(
        outputs[:, inputs["input_ids"].shape[1]:], skip_special_tokens=False
    )[0]
    latex = _clean(output)
    return {"choices": [{"message": {"content": latex}}]}


@app.get("/health")
def health():
    return {"ok": True, "loaded": _model is not None}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, workers=1)

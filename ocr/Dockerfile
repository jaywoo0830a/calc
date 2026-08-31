# ═══════════════════════════════════════════════════════════════
# calc-ocr — GLM-OCR (0.9B) formula → LaTeX, llama.cpp (CPU 최적화)
# ---------------------------------------------------------------
# transformers + torch 대신 **llama.cpp llama-server** 로 교체.
#   - 공식 사전 빌드 CPU 바이너리(OpenBLAS/llamafile) 사용 → 설치/빌드 불필요
#   - GGUF 양자화(Q8_0) → RAM ~1.5GB, CPU 추론 수 초 수준
#   - OpenAI 호환 /v1/chat/completions 제공 → Node 프록시 그대로 동작
#
# GLM-OCR 지원은 llama.cpp b10621(v0.3.0)에 병합됨(PR #19677).
# GGUF 가중치는 컨테이너 시작 시 /models(볼륨)로 내려받는다(재시도+이어받기).
# ═══════════════════════════════════════════════════════════════
FROM ubuntu:24.04

# 사전 빌드 tarball은 llama-b10621/ 한 디렉터리에 바이너리와 .so 를 함께 둠
# → 디렉터리 구조를 유지해야 RPATH($ORIGIN)로 라이브러리가 해석된다(바이너리 이동 금지)
ENV LLAMA_CPP_VERSION=b10621 \
    MODELS_DIR=/models \
    LLAMA_DIR=/opt/llama-b10621 \
    LD_LIBRARY_PATH=/opt/llama-b10621

# llama.cpp CPU 바이너리 런타임 의존성(libgomp1=OpenMP) + 다운로드 도구
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 공식 사전 빌드 CPU 바이너리 (GLM-OCR 지원 포함)
# llama-bXXXX-bin-ubuntu-x64.tar.gz = Ubuntu x64 CPU(OpenBLAS) 빌드
# ⚠️ tar가 디렉터리(llama-b10621/)를 만들어 해제하므로 -C /opt 로 풀면
#    /opt/llama-b10621/llama-server + 같은 디렉터리의 .so 들이 그대로 보존된다.
RUN curl -L --fail -o /tmp/llama.tar.gz \
      "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-ubuntu-x64.tar.gz" \
    && tar -xzf /tmp/llama.tar.gz -C /opt \
    && rm /tmp/llama.tar.gz \
    && test -x "$LLAMA_DIR/llama-server" \
    # 빌드 타임 스모크 테스트 — 공유 라이브러리 해석 문제를 여기서 잡는다
    && "$LLAMA_DIR/llama-server" --version \
    && echo "llama-server OK"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]

# Calc — High-Precision Calculator

32-digit decimal precision calculator. Truncates beyond 32 digits (PHP BCMATH style).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | React 19.2.7 |
| **Build** | Vite 8.1.5 |
| **Math** | decimal.js 10.4.3 |
| **Server** | Nginx (latest) |
| **HTTPS** | Caddy (auto Let's Encrypt) |
| **Container** | Docker multi-stage (node:24.18.0 → nginx:latest) |

## Quick Start

### Docker Compose (recommended)

```bash
# Production (HTTPS via Caddy)
bash run/up.sh prod       # https://calc.rlawjddn00.online

# Development (Vite HMR, port 3000 — 로컬호스트 전용)
bash run/up.sh dev        # 서버에서만 접근 가능

# 집/로컬 PC에서 dev 보기 (SSH 터널)
#   ssh -L 3000:localhost:3000 user@서버
#   → 브라우저에서 http://localhost:3000

# 종료 (dev|prod 각각)
bash run/down.sh prod
bash run/down.sh dev
```

### 1Gbps 전송 속도 최적화

이 저장소는 `calc`(정적 프론트 + API)와 `freedf`/`cloud`(별도 repo)가 **공유 Caddy(80/443 TLS)** 를 통해 배포되는 구조입니다. 1Gbps 라인을 최대한 활용하기 위한 설정이 아래에 이미 반영돼 있습니다.

| 레이어 | 적용 내용 | 파일 |
|--------|-----------|------|
| **HTTP/3 (QUIC)** | 최신 브라우저가 UDP 443 기반 H3로 낮은 지연·높은 처리량 | `Caddyfile`, `docker-compose.prod.yml` (443/udp) |
| **HTTP/2 + keepalive** | 연결 재사용으로 TLS/3-way 핸드셰이크 부하 감소 | `Caddyfile` |
| **전이중(full-duplex)** | 업로드·다운로드 동시 양방향 대역폭 처리 | `Caddyfile` (`enable_full_duplex`) |
| **스트리밍 프록시** | 대용량 미디어 다운/업로드 버퍼링 지연 제거 (`flush_interval`, 긴 `stream_timeout`) | `Caddyfile` |
| **정적 파일 전송** | `sendfile`, `tcp_nopush/nodelay`, keepalive | `nginx.conf` |
| **인코딩** | gzip 확대(텍스트·JS·JSON·wasm·ort 모델) + `gzip_static` | `nginx.conf` |
| **브라우저 캐시** | 불변(aassets/) 1년, 모델/scanic-ml 7일 → 재다운로드 방지 | `nginx.conf` |

> **커널 TCP 튜닝(가장 큰 효과, root 필요)** — 소켓 버퍼가 기본값(약 200KB)이라 1Gbps 대역폭을 못 채웁니다:
> ```bash
> sudo bash run/sysctl-net.sh            # 즉시 적용
> sudo bash run/sysctl-net.sh --persist  # 영속화(재부팅 유지)
> ```

**재배포/재적용 방법:**
```bash
# 1) nginx(calc) 재빌드 → 새 nginx.conf 반영
bash run/up.sh prod            # 빌드+기동 (FORCE=1 bash run/up.sh prod)

# 2) Caddy 설정 리로드 (Caddyfile은 read-only 마운트)
docker exec calc-caddy caddy reload

# 3) HTTP/3 UDP 포트 확인 후 방화벽에서 443/udp 개방 필요
sudo ufw allow 443/udp 2>/dev/null || true
curl -sI https://calc.rlawjddn00.online -H 'Alt-Used: :443'   # H3 응답 확인
```

> ⚠️ 계측상 "업로드/다운로드 속도"가 느리다면 일반적으로 **ISP 회선(비대칭 상·하한), 방화벽/MTU, 그리고 freedf·cloud 자체의 nginx 제한**이 원인인 경우가 많습니다. 위 커널·프록시 튜닝은 이를 최대한 끌어올리는 보완 수단입니다.

## Domains (Caddy가 관리하는 서브도메인 구성)

`Caddyfile`이 이 서버의 80/443(공인 포트)을 점유하며, 도메인명 기반 가상 호스팅으로 각 프로젝트에 배분합니다.

| 도메인 | 담당 프로젝트 | 대상 | TLS/라우팅 |
|--------|--------------|------|-----------|
| `calc.rlawjddn00.online` | calc (이 저장소) | `api:3001`, `calc:80` | Caddy(this) |
| `freedf.rlawjddn00.online` | freedf (별도 저장소) | 호스트 `127.0.0.1:8081` → nginx | Caddy(this), TLS만 |
| `cloud.rlawjddn00.online` | cloud (별도 저장소) | 호스트 `127.0.0.1:8082` → nginx | Caddy(this), TLS만 |

> freedf / cloud는 **별도 compose(호스트 네트워크)**로 독립 실행되고, 자체 nginx를 호스트의
> **로컬 포트(`127.0.0.1`)에만** 바인딩합니다. 외부 진입점(80/443)은 Caddy가 유일하며
> `host.docker.internal:host-gateway` 매핑으로 호스트의 해당 포트를 프록시합니다.
> 세부 경로(미디어/API/Sync) 분기는 각 프로젝트의 nginx가 처리합니다.

### Local Dev (without Docker)

```bash
npm install
npm run dev              # http://localhost:3000
```

## Project Structure

```
calc/
├── index.html           # Vite entry
├── vite.config.js
├── package.json
├── Dockerfile           # Multi-stage: node build → nginx serve
├── Caddyfile            # Reverse proxy + auto TLS
├── nginx.conf
├── docker-compose.yml
├── docker-compose.prod.yml  # + Caddy HTTPS
├── docker-compose.dev.yml   # + HMR port
├── public/              # Static assets (favicon, manifest, sw)
│   ├── favicon.ico
│   ├── manifest.json
│   └── sw.js
└── src/
    ├── main.jsx         # React entry
    ├── App.jsx
    ├── index.css        # @layer-based design tokens
    ├── components/
    │   ├── Display.jsx
    │   └── Keypad.jsx
    └── hooks/
        ├── useCalculator.js
        └── useSound.js
```

## How It Works

1. `decimal.js` precision set to 32, rounding mode `ROUND_DOWN`
2. Arithmetic: `+` `−` `×` `÷`
3. Results trimmed: trailing zeros removed, clean display
4. PWA: Add to iOS Home Screen for standalone mode (no browser zoom)
4. 결과에서 불필요한 후행 0은 제거하여 표시

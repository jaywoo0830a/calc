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

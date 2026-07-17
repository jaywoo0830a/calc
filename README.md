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
bash run/prod/up.sh      # https://calc.rlawjddn00.online

# Development (Vite HMR, port 3000)
bash run/dev/up.sh       # http://localhost:3000
```

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

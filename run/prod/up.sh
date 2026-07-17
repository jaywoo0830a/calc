#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "→ Building (no cache)..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml build --no-cache

echo "→ Starting..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

echo "✓ Prod running at https://calc.rlawjddn00.online"

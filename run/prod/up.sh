#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Force clean rebuild — no Docker layer cache, then prune old cache
docker compose -f docker-compose.yml -f docker-compose.prod.yml build --no-cache
docker builder prune -f
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

echo "✓ Prod running at https://calc.rlawjddn00.online"

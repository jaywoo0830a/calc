#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ "${1:-}" == "-http" ]]; then
  docker compose -f docker-compose.yml -f docker-compose.http.yml -f docker-compose.ocr.yml down
else
  docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.ocr.yml down
fi
echo "✓ Prod stopped"

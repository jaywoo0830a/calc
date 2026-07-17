#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ "${1:-}" == "-http" ]]; then
  docker compose -f docker-compose.yml -f docker-compose.http.yml up -d --build
  echo "✓ Prod running at http://calc.rlawjddn00.online"
else
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  echo "✓ Prod running at https://calc.rlawjddn00.online"
fi

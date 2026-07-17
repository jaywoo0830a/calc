#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
echo "✓ Prod running at https://calc.rlawjddn00.online"

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
echo "✓ Dev running at http://localhost:3000"

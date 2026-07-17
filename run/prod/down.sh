#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "→ Stopping containers..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml down --volumes --remove-orphans 2>/dev/null || true

echo "→ Removing project images..."
docker images --filter "label=com.docker.compose.project=calc" -q 2>/dev/null | xargs -r docker rmi -f 2>/dev/null || true

echo "→ Pruning build cache..."
docker builder prune -f 2>/dev/null || true

echo "→ Pruning dangling images..."
docker image prune -f 2>/dev/null || true

echo "✓ Clean slate — ready for fresh deploy"

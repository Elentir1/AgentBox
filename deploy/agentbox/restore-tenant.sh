#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 || "$3" != "--confirm" ]]; then
  echo "Usage: deploy/agentbox/restore-tenant.sh <render-dir> <backup-path> --confirm <tenant-id>" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDER_DIR="$(realpath "$1")"
ARCHIVE_PATH="$(realpath "$2")"
TENANT_ID="$4"

COMPOSE=(
  docker compose
  --env-file "$RENDER_DIR/.env"
  -f "$ROOT_DIR/docker-compose.yml"
  -f "$RENDER_DIR/docker-compose.override.yml"
)

"${COMPOSE[@]}" run --rm --no-deps \
  -v "$ARCHIVE_PATH:/tmp/agentbox-restore.tar.gz:ro" \
  openclaw-cli backup verify /tmp/agentbox-restore.tar.gz --json

"${COMPOSE[@]}" stop openclaw-gateway
restore_status=0
node "$ROOT_DIR/deploy/agentbox/restore-tenant.mjs" \
  "$ARCHIVE_PATH" "$RENDER_DIR/deployment.json" "$TENANT_ID" || restore_status=$?
"${COMPOSE[@]}" up -d openclaw-gateway

if [[ "$restore_status" -ne 0 ]]; then
  echo "Restore failed; the previous tenant data was rolled back." >&2
  exit "$restore_status"
fi
"$ROOT_DIR/deploy/agentbox/health-tenant.sh" "$RENDER_DIR"

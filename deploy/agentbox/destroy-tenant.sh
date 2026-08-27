#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 || "$2" != "--confirm" ]]; then
  echo "Usage: deploy/agentbox/destroy-tenant.sh <render-dir> --confirm <tenant-id>" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDER_DIR="$(realpath "$1")"
TENANT_ID="$3"

docker compose \
  --env-file "$RENDER_DIR/.env" \
  -f "$ROOT_DIR/docker-compose.yml" \
  -f "$RENDER_DIR/docker-compose.override.yml" \
  down --remove-orphans

node "$ROOT_DIR/deploy/agentbox/destroy-tenant.mjs" \
  "$RENDER_DIR/deployment.json" "$TENANT_ID"

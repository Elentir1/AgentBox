#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: deploy/agentbox/backup-tenant.sh <render-dir>" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDER_DIR="$(realpath "$1")"
read_deployment() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(value[process.argv[2]]));
  ' "$RENDER_DIR/deployment.json" "$1"
}

BACKUP_DIR="$(read_deployment backupDir)"
RETENTION_DAYS="$(
  awk -F= '$1 == "AGENTBOX_BACKUP_RETENTION_DAYS" { print $2 }' "$RENDER_DIR/.env"
)"
install -d -m 0750 "$BACKUP_DIR"

docker compose \
  --env-file "$RENDER_DIR/.env" \
  -f "$ROOT_DIR/docker-compose.yml" \
  -f "$RENDER_DIR/docker-compose.override.yml" \
  exec -T openclaw-gateway \
  node dist/index.js backup create --output /agentbox/backups --verify --json

find "$BACKUP_DIR" -maxdepth 1 -type f -name '*-openclaw-backup.tar.gz' \
  -mtime "+${RETENTION_DAYS:-30}" -delete

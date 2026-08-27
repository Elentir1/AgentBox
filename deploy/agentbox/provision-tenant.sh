#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: deploy/agentbox/provision-tenant.sh <tenant.yaml> <render-dir>" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST_PATH="$(realpath "$1")"
RENDER_DIR="$(realpath -m "$2")"

node "$ROOT_DIR/deploy/agentbox/render-tenant.mjs" "$MANIFEST_PATH" "$RENDER_DIR"

read_deployment() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const key = process.argv[2];
    if (typeof value[key] !== "string" && typeof value[key] !== "number") process.exit(2);
    process.stdout.write(String(value[key]));
  ' "$RENDER_DIR/deployment.json" "$1"
}

TENANT_ID="$(read_deployment id)"
HOST_ROOT="$(read_deployment hostRoot)"
STATE_DIR="$(read_deployment stateDir)"
WORKSPACE_DIR="$(read_deployment workspaceDir)"
SECRETS_DIR="$(read_deployment secretsDir)"
BACKUP_DIR="$(read_deployment backupDir)"

for directory in "$HOST_ROOT" "$STATE_DIR" "$WORKSPACE_DIR" "$SECRETS_DIR/auth-profiles" "$BACKUP_DIR"; do
  install -d -m 0750 "$directory"
done

RUNTIME_ENV="$SECRETS_DIR/runtime.env"
if [[ ! -f "$RUNTIME_ENV" ]]; then
  install -m 0600 "$RENDER_DIR/runtime.env.example" "$RUNTIME_ENV"
fi
if ! grep -q '^OPENCLAW_GATEWAY_TOKEN=.\+' "$RUNTIME_ENV"; then
  token="$(openssl rand -hex 32)"
  awk -v token="$token" '
    BEGIN { replaced = 0 }
    /^OPENCLAW_GATEWAY_TOKEN=/ { print "OPENCLAW_GATEWAY_TOKEN=" token; replaced = 1; next }
    { print }
    END { if (!replaced) print "OPENCLAW_GATEWAY_TOKEN=" token }
  ' "$RUNTIME_ENV" >"$RUNTIME_ENV.tmp"
  chmod 0600 "$RUNTIME_ENV.tmp"
  mv "$RUNTIME_ENV.tmp" "$RUNTIME_ENV"
fi

if awk -F= 'NF >= 1 && $1 !~ /^#/ && $2 == "" { print $1 }' "$RUNTIME_ENV" | grep -q .; then
  echo "AgentBox tenant $TENANT_ID still has empty secrets in $RUNTIME_ENV." >&2
  echo "Fill every required value, then rerun this command." >&2
  exit 3
fi

COMPOSE=(
  docker compose
  --env-file "$RENDER_DIR/.env"
  -f "$ROOT_DIR/docker-compose.yml"
  -f "$RENDER_DIR/docker-compose.override.yml"
)

"${COMPOSE[@]}" run --rm --no-deps openclaw-cli onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --gateway-bind lan \
  --no-install-daemon \
  --skip-channels \
  --skip-skills \
  --skip-health \
  --skip-ui \
  --suppress-gateway-token-output

"${COMPOSE[@]}" run --rm --no-deps \
  -v "$RENDER_DIR/openclaw.batch.json:/tmp/agentbox.batch.json:ro" \
  openclaw-cli config set --batch-file /tmp/agentbox.batch.json

"${COMPOSE[@]}" run --rm --no-deps openclaw-cli doctor --fix --non-interactive
"${COMPOSE[@]}" up -d openclaw-gateway

"$ROOT_DIR/deploy/agentbox/health-tenant.sh" "$RENDER_DIR"
echo "AgentBox tenant $TENANT_ID is ready."

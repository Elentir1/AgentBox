#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: deploy/agentbox/health-tenant.sh <render-dir>" >&2
  exit 2
fi

RENDER_DIR="$(realpath "$1")"
PORT="$(
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(value.gatewayPort));
  ' "$RENDER_DIR/deployment.json"
)"

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  if curl --fail --silent --show-error "http://127.0.0.1:${PORT}/healthz" >/dev/null &&
    curl --fail --silent --show-error "http://127.0.0.1:${PORT}/readyz" >/dev/null; then
    echo "AgentBox is live and ready on port $PORT."
    exit 0
  fi
  sleep 2
done

echo "AgentBox did not become ready on port $PORT within 120 seconds." >&2
exit 1

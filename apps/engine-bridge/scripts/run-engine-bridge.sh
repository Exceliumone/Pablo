#!/usr/bin/env bash
# Production launcher for the engine-bridge orchestrator, meant to run
# under PM2 (or systemd's ExecStart). The compiled binaries here don't
# auto-load a .env file the way apps/api does via `dotenv/config` — this
# sources apps/engine-bridge/.env explicitly so the same file-based config
# workflow works for this side too. See ../.env.example.
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BRIDGE_DIR/../.." && pwd)"
ENV_FILE="$BRIDGE_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

exec "$REPO_ROOT/target/release/engine-bridge"

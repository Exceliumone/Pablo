#!/usr/bin/env bash
# Production launcher for the scanner — the shared, singleton detection
# process. Never run more than one of these across the whole deployment
# (see Cargo.toml's [[bin]] comment for scanner and docs/ARCHITECTURE.md).
# Same .env-sourcing rationale as run-engine-bridge.sh.
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

exec "$REPO_ROOT/target/release/scanner"

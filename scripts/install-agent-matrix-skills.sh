#!/usr/bin/env bash
set -euo pipefail

AGENT_BIN="${AGENT_BIN:-agent}"
MATRIX_SKILLS_SOURCE="${1:-${MATRIX_SKILLS_SOURCE:-HamedMP/matrix-os}}"

skills=(
  app-builder
  design-system
  integrations
  dev-vps
  debug-app
)

if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
  echo "Agent binary not found: $AGENT_BIN" >&2
  echo "Set AGENT_BIN=/path/to/agent or install Agent first." >&2
  exit 127
fi

for skill in "${skills[@]}"; do
  "$AGENT_BIN" skills install "${MATRIX_SKILLS_SOURCE}/skills/matrix/${skill}"
done

echo "Installed Matrix Agent skills from ${MATRIX_SKILLS_SOURCE}."

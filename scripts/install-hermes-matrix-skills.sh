#!/usr/bin/env bash
set -euo pipefail

HERMES_BIN="${HERMES_BIN:-hermes}"
MATRIX_SKILLS_SOURCE="${1:-${MATRIX_SKILLS_SOURCE:-HamedMP/matrix-os}}"

skills=(
  app-builder
  design-system
  integrations
  dev-vps
  debug-app
)

if ! command -v "$HERMES_BIN" >/dev/null 2>&1; then
  echo "Hermes binary not found: $HERMES_BIN" >&2
  echo "Set HERMES_BIN=/path/to/hermes or install Hermes first." >&2
  exit 127
fi

for skill in "${skills[@]}"; do
  "$HERMES_BIN" skills install "${MATRIX_SKILLS_SOURCE}/skills/matrix/${skill}"
done

echo "Installed Matrix Hermes skills from ${MATRIX_SKILLS_SOURCE}."

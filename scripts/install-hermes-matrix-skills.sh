#!/usr/bin/env bash
set -euo pipefail

HERMES_BIN="${HERMES_BIN:-hermes}"
MATRIX_SKILLS_SOURCE="${1:-${MATRIX_SKILLS_SOURCE:-HamedMP/matrix-os}}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

if ! command -v "$HERMES_BIN" >/dev/null 2>&1; then
  echo "Hermes binary not found: $HERMES_BIN" >&2
  echo "Set HERMES_BIN=/path/to/hermes or install Hermes first." >&2
  exit 127
fi

if [ -d "${MATRIX_SKILLS_SOURCE}/skills/matrix" ]; then
  MATRIX_SKILL_TARGETS=hermes \
    MATRIX_SKILLS_SOURCE="${MATRIX_SKILLS_SOURCE}/skills/matrix" \
    HERMES_HOME="$HERMES_HOME" \
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-matrix-agent-skills.sh"
  exit 0
fi

if [ -d "${MATRIX_SKILLS_SOURCE}/app-builder" ]; then
  MATRIX_SKILL_TARGETS=hermes \
    MATRIX_SKILLS_SOURCE="$MATRIX_SKILLS_SOURCE" \
    HERMES_HOME="$HERMES_HOME" \
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-matrix-agent-skills.sh"
  exit 0
fi

for skill_dir in app-builder app-ui-patterns design-system integrations dev-vps debug-app landing-design; do
  "$HERMES_BIN" skills install --force --yes "${MATRIX_SKILLS_SOURCE}/skills/matrix/${skill_dir}"
done

echo "Installed Matrix Hermes skills from ${MATRIX_SKILLS_SOURCE}."

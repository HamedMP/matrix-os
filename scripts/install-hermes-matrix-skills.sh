#!/usr/bin/env bash
set -euo pipefail

HERMES_BIN="${HERMES_BIN:-hermes}"
MATRIX_SKILLS_SOURCE="${1:-${MATRIX_SKILLS_SOURCE:-HamedMP/matrix-os}}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

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

if [ -d "${MATRIX_SKILLS_SOURCE}/skills/matrix" ]; then
  install -d "$HERMES_HOME/skills"
  for skill in "${skills[@]}"; do
    src="${MATRIX_SKILLS_SOURCE}/skills/matrix/${skill}"
    [ -d "$src" ] || {
      echo "Matrix skill not found: $src" >&2
      exit 1
    }
    name="$(sed -n 's/^name:[[:space:]]*//p' "$src/SKILL.md" | head -1)"
    [ -n "$name" ] || name="matrix-${skill}"
    rm -rf "$HERMES_HOME/skills/$name"
    cp -a "$src" "$HERMES_HOME/skills/$name"
  done
  echo "Installed Matrix Hermes skills from ${MATRIX_SKILLS_SOURCE} into ${HERMES_HOME}/skills."
  exit 0
fi

for skill in "${skills[@]}"; do
  "$HERMES_BIN" skills install --force --yes "${MATRIX_SKILLS_SOURCE}/skills/matrix/${skill}"
done

echo "Installed Matrix Hermes skills from ${MATRIX_SKILLS_SOURCE}."

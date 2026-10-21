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

for skill_dir in animate animation-accessibility animation-performance animation-vocabulary app-builder app-ui-patterns apple-design chat-import css-animations debug-app design-system dev-vps emil-design-eng integrations jev-email-triage landing-design personal-daily-brief review-animations shadcn; do
  case "$skill_dir" in
    animate|animation-accessibility|animation-performance|animation-vocabulary|apple-design|css-animations|emil-design-eng|review-animations|shadcn)
      skill_name="$skill_dir" ;;
    *) skill_name="matrix-$skill_dir" ;;
  esac
  destination="$HERMES_HOME/skills/$skill_name"
  # Hermes can overwrite filesystem-only entries even without --force.
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "Preserved existing Hermes skill: $skill_name (use local Matrix skill sync for managed updates)."
    continue
  fi
  "$HERMES_BIN" skills install --yes "${MATRIX_SKILLS_SOURCE}/skills/matrix/${skill_dir}"
done

echo "Finished installing missing Matrix Hermes skills from ${MATRIX_SKILLS_SOURCE}."

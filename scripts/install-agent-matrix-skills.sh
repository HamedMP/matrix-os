#!/usr/bin/env bash
set -euo pipefail

AGENT_BIN="${AGENT_BIN:-agent}"
MATRIX_SKILLS_SOURCE="${1:-${MATRIX_SKILLS_SOURCE:-HamedMP/matrix-os}}"
MATRIX_AGENT_SKILLS_ROOT="${MATRIX_AGENT_SKILLS_ROOT:-${AGENT_HOME:-$HOME/.agent}/skills}"

if [ -d "${MATRIX_SKILLS_SOURCE}/skills/matrix" ]; then
  MATRIX_SKILLS_ROOT="${MATRIX_SKILLS_SOURCE}/skills/matrix"
elif [ -d "${MATRIX_SKILLS_SOURCE}/app-builder" ]; then
  MATRIX_SKILLS_ROOT="$MATRIX_SKILLS_SOURCE"
else
  MATRIX_SKILLS_ROOT="${MATRIX_SKILLS_SOURCE}/skills/matrix"
fi

skills=(
  animate
  animation-accessibility
  animation-performance
  animation-vocabulary
  app-builder
  app-ui-patterns
  apple-design
  chat-import
  css-animations
  debug-app
  design-system
  dev-vps
  emil-design-eng
  integrations
  jev-email-triage
  landing-design
  personal-daily-brief
  review-animations
  shadcn
)

# A real local source can refresh only Matrix-managed entries through the
# shared synchronizer, including copies from a previous release. A remote CLI
# install has no reliable ownership proof and remains fill-missing only.
if [ -e "$MATRIX_SKILLS_SOURCE" ] || [ -L "$MATRIX_SKILLS_SOURCE" ]; then
  builder_skill="$MATRIX_SKILLS_ROOT/app-builder/SKILL.md"
  if [ ! -f "$builder_skill" ] || [ -L "$builder_skill" ] || ! grep -q '^name:[[:space:]]*matrix-app-builder[[:space:]]*$' "$builder_skill"; then
    echo "Invalid local Matrix skills source; existing Agent skills were preserved." >&2
    exit 1
  fi
  MATRIX_SKILL_TARGETS=agent \
    MATRIX_SKILLS_SOURCE="$MATRIX_SKILLS_ROOT" \
    MATRIX_AGENT_SKILLS_ROOT="$MATRIX_AGENT_SKILLS_ROOT" \
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-matrix-agent-skills.sh"
  exit 0
fi

if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
  echo "Agent binary not found: $AGENT_BIN" >&2
  echo "Set AGENT_BIN=/path/to/agent or install Agent first." >&2
  exit 127
fi

for skill in "${skills[@]}"; do
  case "$skill" in
    animate|animation-accessibility|animation-performance|animation-vocabulary|apple-design|css-animations|emil-design-eng|review-animations|shadcn)
      skill_name="$skill" ;;
    *) skill_name="matrix-$skill" ;;
  esac
  if [ -f "${MATRIX_SKILLS_ROOT}/${skill}/SKILL.md" ]; then
    declared_name="$(sed -n 's/^name:[[:space:]]*//p' "${MATRIX_SKILLS_ROOT}/${skill}/SKILL.md" | head -1)"
    if [ -n "$declared_name" ]; then
      skill_name="$declared_name"
    fi
  fi
  destination="$MATRIX_AGENT_SKILLS_ROOT/$skill_name"
  # Protect directories, files and dangling owner links before invoking a CLI
  # whose replace behavior may vary by version. Repeat installs fill gaps only.
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "Preserved existing Agent skill: $skill_name."
    continue
  fi
  "$AGENT_BIN" skills install "${MATRIX_SKILLS_ROOT}/${skill}"
done

echo "Installed Matrix OS agent skills from ${MATRIX_SKILLS_SOURCE}."

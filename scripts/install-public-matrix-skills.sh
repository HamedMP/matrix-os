#!/usr/bin/env bash
set -euo pipefail

SKILLS_CLI_VERSION="${SKILLS_CLI_VERSION:-1.5.23}"
MATRIX_PUBLIC_SKILLS_SOURCE="${1:-https://github.com/HamedMP/matrix-os/tree/main/plugins/matrix-os/skills}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to run the pinned skills.sh installer." >&2
  exit 127
fi

pnpm dlx "skills@${SKILLS_CLI_VERSION}" add "$MATRIX_PUBLIC_SKILLS_SOURCE" --global --all

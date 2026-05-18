#!/usr/bin/env bash
# Focused local smoke tests for Matrix OS direct VPS SSH/Zellij support.

set -euo pipefail

MODE="default"

usage() {
  cat <<'USAGE'
Usage: scripts/test-ssh-local.sh [--fast|--full]

Modes:
  --fast  Run the fastest CLI SSH and authorized-keys syntax checks.
  --full  Run default checks, then add repository typecheck and pattern scan.

Run inside Flox when possible:
  flox activate -- bun run test:ssh
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fast)
      MODE="fast"
      ;;
    --full)
      MODE="full"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

section() {
  printf '\n==> %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Try: flox activate -- bun run test:ssh" >&2
    exit 127
  fi
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

require_cmd bash
require_cmd bun
require_cmd pnpm
require_cmd node

section "CLI SSH typecheck"
run pnpm --filter @finnaai/matrix exec tsc --noEmit

section "CLI SSH unit tests"
run pnpm --filter @finnaai/matrix exec vitest run tests/unit/ssh.test.ts

section "Authorized keys projection syntax"
run bash -n distro/customer-vps/host-bin/matrix-sync-authorized-keys

if [ "$MODE" != "fast" ]; then
  section "Platform SSH resolve and VPS setup tests"
  run bun run test tests/platform/device-routes.test.ts tests/platform/customer-vps-cloud-init.test.ts tests/platform/customer-vps-host-bundle.test.ts

  section "VPS routing tests"
  run bun run test tests/platform/profile-routing-vps.test.ts tests/platform/customer-vps.test.ts
fi

if [ "$MODE" = "full" ]; then
  section "Repository typecheck"
  run bun run typecheck

  section "Pattern scan"
  run bun run check:patterns
fi

section "SSH smoke passed"
echo "Next manual guide: docs/dev/sync-testing.md#ssh-local-acceptance"

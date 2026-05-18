#!/usr/bin/env bash
# Focused local smoke tests for Matrix OS file sync.

set -euo pipefail

MODE="default"

usage() {
  cat <<'USAGE'
Usage: scripts/test-sync-local.sh [--fast|--docker|--full]

Modes:
  --fast    Run the fastest CLI/profile and gateway sync contract checks.
  --docker  Run default checks, then verify the local Docker gateway is reachable.
  --full    Run default checks, then add broader typechecking.

Run inside Flox when possible:
  flox activate -- bun run test:sync
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fast)
      MODE="fast"
      ;;
    --docker)
      MODE="docker"
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

LOCK_DIR="${TMPDIR:-/tmp}/matrix-sync-local-test.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another sync smoke test is already running." >&2
  echo "Wait for it to finish, then rerun this command." >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

section() {
  printf '\n==> %s\n' "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Try: flox activate -- bun run test:sync" >&2
    exit 127
  fi
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

wait_for_url() {
  url="$1"
  label="$2"
  attempts="${3:-30}"

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$i" -eq "$attempts" ]; then
      break
    fi
    sleep 2
  done

  echo "$label is not reachable at $url." >&2
  return 1
}

fetch_url_retry() {
  url="$1"
  output_file="$2"
  label="$3"
  attempts="${4:-30}"

  printf '+ curl -fsS --max-time 5 %q\n' "$url"
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --max-time 5 "$url" >"$output_file" 2>/dev/null; then
      return 0
    fi
    if [ "$i" -eq "$attempts" ]; then
      break
    fi
    sleep 2
  done

  echo "$label is not reachable at $url." >&2
  curl -fsS --max-time 5 "$url" >/dev/null
  return 1
}

require_cmd bun
require_cmd pnpm
require_cmd node

if [ "$MODE" = "docker" ]; then
  require_cmd curl
  require_cmd docker

  section "Docker preflight"
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not reachable from this shell." >&2
    echo "Start Docker/OrbStack, then run: flox activate -- scripts/test-sync-local.sh --docker" >&2
    exit 1
  fi

  if ! wait_for_url http://localhost:4000/api/sync/status "Local gateway"; then
    echo "Start it with: bun run docker" >&2
    exit 1
  fi
fi

section "Sync CLI profile tests"
run bun run test tests/cli/profile-auth.test.ts tests/cli/profile.test.ts tests/cli/bare-command.test.ts

section "Gateway sync contract tests"
run bun run test tests/gateway/sync/ws-events.test.ts tests/gateway/sync/commit.test.ts tests/gateway/sync/manifest.test.ts

if [ "$MODE" != "fast" ]; then
  section "Gateway home mirror test"
  run bun run test tests/gateway/sync/home-mirror.test.ts

  section "In-memory two-peer sync test"
  run pnpm --filter @finnaai/matrix exec vitest run tests/integration/e2e-sync.test.ts
fi

if [ "$MODE" = "docker" ]; then
  section "Local Docker gateway sync smoke"
  status_file="$(mktemp -t matrix-sync-status.XXXXXX)"
  manifest_file="$(mktemp -t matrix-sync-manifest.XXXXXX)"
  trap 'rm -f "$status_file" "$manifest_file"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

  fetch_url_retry http://localhost:4000/api/sync/status "$status_file" "Local gateway sync status"
  fetch_url_retry http://localhost:4000/api/sync/manifest "$manifest_file" "Local gateway sync manifest"

  echo
  echo "Gateway sync status response:"
  cat "$status_file"
  echo

  echo
  echo "Gateway sync manifest response:"
  cat "$manifest_file"
  echo
fi

if [ "$MODE" = "full" ]; then
  section "Repository typecheck"
  run bun run typecheck
fi

section "Sync smoke passed"
echo "Next manual guide: docs/dev/sync-testing.md"

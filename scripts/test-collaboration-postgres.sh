#!/usr/bin/env bash
# Runs every Vitest suite that exercises a real PostgreSQL server through
# MATRIX_TEST_POSTGRES_URL. Those suites skip, or fall back to PGlite, when the
# variable is unset, so the unit shards never reach their lock and race paths.
# This runner selects all of them, runs them in one Vitest invocation against a
# dedicated test database, and fails if any selected test is skipped.
#
# Usage:
#   MATRIX_TEST_POSTGRES_URL=postgres://.../matrix_collaboration_test \
#     scripts/test-collaboration-postgres.sh [--shard <index>/<count>]
#   scripts/test-collaboration-postgres.sh --list [--shard <index>/<count>]
#
# --shard deals the sorted selection round-robin, so every file lands in
# exactly one shard. --list prints the selection without running it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIABLE=MATRIX_TEST_POSTGRES_URL

# Product bugs that real PostgreSQL exposes, one entry per test:
#   "<test file>|<full test name>|<issue URL>"
# The full test name is Vitest's, with suites joined by " > " as in its FAIL
# lines. A quarantined test still runs. Its failure is reported and counted in
# the job summary but does not fail the job. Remove the entry when the issue is
# fixed.
QUARANTINE=(
)

list_only=false
shard_index=1
shard_count=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --list)
      list_only=true
      shift
      ;;
    --shard)
      if [[ "${2:-}" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] && [ "${BASH_REMATCH[1]}" -le "${BASH_REMATCH[2]}" ]; then
        shard_index="${BASH_REMATCH[1]}"
        shard_count="${BASH_REMATCH[2]}"
        shift 2
      else
        echo "--shard expects <index>/<count>, for example 1/2" >&2
        exit 2
      fi
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

cd "$ROOT"

select_files() {
  if [ ! -d tests ]; then return 0; fi
  local status=0
  grep -rlF --include='*.test.ts' --include='*.test.tsx' --exclude-dir=node_modules "$VARIABLE" tests || status=$?
  # grep exits 1 when nothing matches; anything higher is a read error.
  if [ "$status" -gt 1 ]; then return "$status"; fi
}

listing="$(select_files)"
all_files=()
files=()
while IFS= read -r file; do
  if [ -z "$file" ]; then continue; fi
  if [ $(( ${#all_files[@]} % shard_count )) -eq $(( shard_index - 1 )) ]; then files+=("$file"); fi
  all_files+=("$file")
done < <(printf '%s' "$listing" | LC_ALL=C sort)

if [ "$list_only" = "true" ]; then
  if [ "${#files[@]}" -gt 0 ]; then printf '%s\n' "${files[@]}"; fi
  exit 0
fi

if [ -z "${MATRIX_TEST_POSTGRES_URL:-}" ]; then
  echo "$VARIABLE is required" >&2
  exit 1
fi
# Same guard as the test fixtures: never point these suites at a shared database.
if ! node -e 'process.exit(new URL(process.env.MATRIX_TEST_POSTGRES_URL).pathname.toLowerCase().includes("test") ? 0 : 1)' 2>/dev/null; then
  echo "$VARIABLE must name a dedicated test database" >&2
  exit 1
fi

if [ "${#all_files[@]}" -eq 0 ]; then
  echo "No test files reference $VARIABLE; refusing to report an empty run as green" >&2
  exit 1
fi
if [ "${#files[@]}" -eq 0 ]; then
  echo "Shard $shard_index/$shard_count selects no test files; lower the shard count" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/collaboration-postgres.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
printf '%s\n' "${files[@]}" > "$work_dir/selection.txt"
printf '%s\n' "${all_files[@]}" > "$work_dir/all-selected.txt"
printf '%s\n' ${QUARANTINE[@]+"${QUARANTINE[@]}"} > "$work_dir/quarantine.txt"

echo "Running ${#files[@]} of ${#all_files[@]} real-PostgreSQL test files (shard $shard_index/$shard_count)"
vitest_status=0
COLLABORATION_POSTGRES_REPORT="$work_dir/report.json" pnpm exec vitest run \
  --reporter=default --reporter=./scripts/ci/collaboration-postgres-vitest-reporter.mjs \
  "${files[@]}" || vitest_status=$?

node scripts/ci/collaboration-postgres-report.mjs \
  --report "$work_dir/report.json" \
  --selection "$work_dir/selection.txt" \
  --all-selected "$work_dir/all-selected.txt" \
  --quarantine "$work_dir/quarantine.txt" \
  --vitest-status "$vitest_status" \
  --shard "$shard_index/$shard_count"

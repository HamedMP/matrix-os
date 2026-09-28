#!/usr/bin/env bash
# Runs every Vitest suite that exercises a real PostgreSQL server through
# MATRIX_TEST_POSTGRES_URL. Those suites skip, or fall back to PGlite, when the
# variable is unset, so the unit shards never reach their lock and race paths.
# This runner selects all of them, runs them in one Vitest invocation against a
# dedicated test database, and fails if any selected test is skipped.
#
# Usage:
#   MATRIX_TEST_POSTGRES_URL=postgres://.../matrix_collaboration_test \
#     scripts/test-collaboration-postgres.sh
#   scripts/test-collaboration-postgres.sh --list   # print the selection only
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIABLE=MATRIX_TEST_POSTGRES_URL

# Product bugs that real PostgreSQL exposes, one entry per test:
#   "<test file>|<full test name>|<issue URL>"
# A quarantined test still runs. Its failure is reported and counted in the job
# summary but does not fail the job. Remove the entry when the issue is fixed.
QUARANTINE=(
)

cd "$ROOT"

select_files() {
  if [ ! -d tests ]; then return 0; fi
  local status=0
  grep -rlF --include='*.test.ts' --include='*.test.tsx' --exclude-dir=node_modules "$VARIABLE" tests || status=$?
  # grep exits 1 when nothing matches; anything higher is a read error.
  if [ "$status" -gt 1 ]; then return "$status"; fi
}

listing="$(select_files)"
files=()
while IFS= read -r file; do
  if [ -n "$file" ]; then files+=("$file"); fi
done < <(printf '%s' "$listing" | LC_ALL=C sort)

if [ "${1:-}" = "--list" ]; then
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

if [ "${#files[@]}" -eq 0 ]; then
  echo "No test files reference $VARIABLE; refusing to report an empty run as green" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/collaboration-postgres.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
printf '%s\n' "${files[@]}" > "$work_dir/selection.txt"
printf '%s\n' ${QUARANTINE[@]+"${QUARANTINE[@]}"} > "$work_dir/quarantine.txt"

echo "Running ${#files[@]} real-PostgreSQL test files (${#QUARANTINE[@]} quarantined tests)"
vitest_status=0
pnpm exec vitest run --reporter=default --reporter=json --outputFile.json="$work_dir/report.json" "${files[@]}" \
  2>&1 | tee "$work_dir/vitest.log" || vitest_status=$?

node scripts/ci/collaboration-postgres-report.mjs \
  --report "$work_dir/report.json" \
  --selection "$work_dir/selection.txt" \
  --quarantine "$work_dir/quarantine.txt" \
  --vitest-status "$vitest_status" \
  --vitest-log "$work_dir/vitest.log"

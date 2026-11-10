#!/usr/bin/env bash
# Runs inside the runner container before every job (ACTIONS_RUNNER_HOOK_JOB_STARTED). A fork PR
# can edit ci.yml to target this pool, so the host, not the workflow, decides which source may run:
# pushes, merge-queue runs and same-repository PRs only.
set -uo pipefail

case "${GITHUB_EVENT_NAME:-}" in
  push | merge_group) exit 0 ;;
  pull_request)
    head=$(jq -r '.pull_request.head.repo.full_name // ""' "${GITHUB_EVENT_PATH:-/nonexistent}" 2>/dev/null)
    if [ -n "$head" ] && [ "$head" = "${GITHUB_REPOSITORY:-}" ]; then exit 0; fi
    ;;
esac
echo "::error::The matrix-ci runner pool accepts only pushes, merge-queue runs and same-repository pull requests." >&2

# A failed hook only fails a pre-job step; steps with `if: always()` would still run. Kill the
# runner itself, outermost process first, so no workflow step can start. The parent is the process
# that would run those steps, so it always dies, even if the process table cannot be read. Above
# it, only the unbroken chain of runner processes is signalled, never an outer runner that merely
# hosts this one (as when the test suite runs the hook inside a CI job).
runners=("$PPID")
pid=$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')
while [ "${pid:-0}" -gt 1 ]; do
  read -r parent name < <(ps -o ppid=,comm= -p "$pid" 2>/dev/null) || break
  case "${name##*/}" in
    Runner.Worker | Runner.Listener | run-helper.sh | run.sh) runners=("$pid" "${runners[@]}") ;;
    *) break ;;
  esac
  pid=$parent
done
for pid in "${runners[@]}"; do builtin kill -KILL "$pid" 2>/dev/null; done
exit 1

#!/usr/bin/env bash
# Runs inside the runner container before every job (ACTIONS_RUNNER_HOOK_JOB_STARTED). A fork PR
# can edit ci.yml to target this pool, so the host, not the workflow, decides which source may run:
# pushes, merge-queue runs and same-repository PRs only.
set -euo pipefail

case "${GITHUB_EVENT_NAME:-}" in
  push | merge_group) exit 0 ;;
  pull_request)
    head=$(jq -r '.pull_request.head.repo.full_name // ""' "${GITHUB_EVENT_PATH:?}")
    if [ -n "$head" ] && [ "$head" = "${GITHUB_REPOSITORY:-}" ]; then exit 0; fi
    ;;
esac
echo "::error::The matrix-ci runner pool accepts only pushes, merge-queue runs and same-repository pull requests." >&2
exit 1

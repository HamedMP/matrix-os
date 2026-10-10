#!/bin/bash
set -euo pipefail
set +x
sha=${1:?Missing reviewed SHA}
suite=${2:?Missing suite}
workers=${3:?Missing worker count}
[[ $sha =~ ^[a-f0-9]{40}$ && $workers =~ ^([1-9]|1[0-6])$ ]] || exit 64
case "$suite" in unit|unit-shard-[1-4]|typecheck|shell|e2e) ;; *) exit 64 ;; esac
export MATRIX_TEST_WORKERS=$workers
mkdir -p /work/results
measure() {
  local label=$1 start end status=0
  shift
  start=$(date +%s)
  "$@" || status=$?
  end=$(date +%s)
  printf '%s\t%s\t%s\n' "$label" "$((end-start))" "$status" | tee -a /work/results/timing.tsv
  return "$status"
}
measure checkout timeout 120s bash -c '
  git init /work/repo
  cd /work/repo
  git remote add origin https://github.com/HamedMP/matrix-os.git
  git fetch --depth=1 origin "$1"
  git checkout --detach FETCH_HEAD
  test "$(git rev-parse HEAD)" = "$1"
' -- "$sha"
cd /work/repo
git config --global user.name CI
git config --global user.email ci@matrix-os.com
measure install pnpm install --frozen-lockfile
measure prerequisites pnpm --filter @matrix-os/observability --filter @matrix-os/kernel --filter @matrix-os/integrations-mcp build
shard=()
if [[ $suite == unit-shard-* ]]; then shard=("--shard=${suite##*-}/4"); fi
# Cold/warm passes are one admitted benchmark, then the whole container is
# destroyed. They share dependencies/build artifacts, never another job's data.
for pass in cold warm; do
  case "$suite" in
    unit|unit-shard-*)
      measure "unit-$pass" pnpm exec vitest run "${shard[@]}" --maxWorkers="$workers" \
        --reporter=default --reporter=json --outputFile="/work/results/unit-$pass.json"
      ;;
    typecheck) measure "typecheck-$pass" bun run typecheck ;;
    shell)
      export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_bWF0cml4LW9zLWNpLmNsZXJrLmFjY291bnRzLmRldiQ
      measure "shell-$pass" bun run build:shell:production
      ;;
    e2e)
      if [[ $pass == cold ]]; then
        measure browsers pnpm --filter @matrix-os/mcp-browser exec playwright install chromium
        measure shell-browsers pnpm --filter shell exec playwright install chromium
      fi
      measure "e2e-$pass" xvfb-run --auto-servernum bun run test:e2e
      ;;
  esac
done

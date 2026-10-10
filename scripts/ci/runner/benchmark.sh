#!/bin/bash
set -euo pipefail
set +x
sha=${1:?Missing reviewed SHA}
suite=${2:?Missing suite}
workers=${3:?Missing worker count}
[[ $sha =~ ^[a-f0-9]{40}$ && $workers =~ ^([1-9]|1[0-6])$ ]] || exit 64
case "$suite" in unit|unit-shard-[1-4]|typecheck|shell|checks|e2e|e2e-general|e2e-electron|full) ;; *) exit 64 ;; esac
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
# Historical baselines predate the no-emit helper; retain their existing wrapper.
# Inspect JSON only and emit one of two fixed script names.
typecheck_script=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { scripts = {} } = JSON.parse(readFileSync("package.json", "utf8"));
  process.stdout.write(Object.hasOwn(scripts, "typecheck:run") ? "typecheck:run" : "typecheck");
')
export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2ktc2FmZS5leGFtcGxlLmNvbSQ=
export NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
export NEXT_PUBLIC_POSTHOG_KEY=phc_ci_shell_build NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_ci_shell_build
export NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com NEXT_PUBLIC_POSTHOG_API_HOST=/relay
case "$suite" in
  e2e|e2e-general|e2e-electron|full)
    measure browsers pnpm --filter @matrix-os/mcp-browser exec playwright install chromium
    measure shell-browsers pnpm --filter shell exec playwright install chromium
    ;;
esac
# Hosted general CI runs before Desktop exists. Full benchmarks retain that
# scope even after a cold pass leaves Desktop build output for the warm pass.
# These exact files gate their entire native suite on the Desktop build; browser
# and flag-gated suites remain discoverable. The contract test verifies the list.
general_native_suites=(
  agents-providers-figma
  bot-visual
  canonical-input
  chat-dock-badge
  chat-onboarding
  chat-picker-responsive
  chat-provider-background-cache
  chat-status-quota
  chat-subagent-activity
  chat-title-layout
  chat-tool-details
  file-download
  files-handoff
  getting-started
  hermes-conversations-responsive
  hermes-conversations
  operator
  organization-management
  project-chat-inspector
  project-folder-picker-layout
  provider-auth-terminal
  provider-settings-idle
  release-alignment
  shared-chat
  signin-brand
  speech-input
  terminal-clipboard
  terminal-containment
  terminal-file-drop
  terminal-handoff
  terminal-links
  terminal-sessions
  terminal-snapshot
  update-experience
)
general_exclusions=()
for name in "${general_native_suites[@]}"; do
  general_exclusions+=("--exclude=tests/e2e/desktop/$name.e2e.test.ts")
done
run_suite() {
  local pass=$1 desktop_prepared=${2:-false} failure=0
  local shard=()
  if [[ $suite == unit-shard-* ]]; then shard=("--shard=${suite##*-}/4"); fi
  export MATRIX_TEST_WORKERS=$workers
  step() { measure "$@" || failure=1; }
  case "$suite" in
    unit|unit-shard-*)
      step "unit-$pass" pnpm exec vitest run "${shard[@]}" --maxWorkers="$workers" \
        --reporter=default --reporter=json --outputFile="/work/results/unit-$pass.json"
      ;;
    typecheck) step "typecheck-$pass" bun run "$typecheck_script" ;;
    shell) step "shell-$pass" bun run build:shell:production ;;
    checks)
      # Existing CI keeps typecheck diagnostic/nonblocking during baseline repair.
      measure "typecheck-$pass" bun run "$typecheck_script" || true
      step "sync-build-$pass" pnpm --filter @finnaai/matrix build
      step "sync-test-$pass" pnpm --filter @finnaai/matrix test --maxWorkers=2
      step "sync-publish-$pass" pnpm --filter @finnaai/matrix exec node ./scripts/check-publish.mjs
      if [[ $pass == cold ]]; then
        mkdir -p /work/sdk
        step sdk-install pnpm add --ignore-scripts --save-exact --dir /work/sdk @anthropic-ai/claude-agent-sdk@0.3.251
      fi
      export MATRIX_AGENT_SDK_PACKAGE_DIR=/work/sdk/node_modules/@anthropic-ai/claude-agent-sdk
      step "sdk-$pass" pnpm exec vitest run tests/scripts/agent-sdk-real-runtime-spike.test.ts --maxWorkers=2
      step "docs-parity-$pass" pnpm exec vitest run --maxWorkers=2 \
        tests/repository/site-extraction.test.ts tests/contracts/os-view.test.ts \
        tests/shell/desktop-mode-parity.test.ts tests/shell/desktop-launcher-mode.test.tsx \
        tests/shell/web-desktop-surface.test.tsx tests/shell/os-view-state-client.test.ts \
        tests/desktop/app-launcher.test.tsx tests/desktop/native-desktop-shell.test.tsx \
        tests/desktop/os-view-state-client.test.ts tests/desktop/native-os-view-persistence.test.ts \
        tests/gateway/os-view-state-repository.test.ts
      step "shell-$pass" bun run build:shell:production
      ;;
    e2e|e2e-general)
      step "e2e-general-$pass" xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=2 "${general_exclusions[@]}"
      ;;
    e2e-electron)
      if [[ $desktop_prepared != true ]]; then step "desktop-build-$pass" bun run build:desktop; fi
      step "terminal-grid-$pass" env MATRIX_GRID_ELECTRON=1 xvfb-run --auto-servernum \
        pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/terminal-soft-grid.e2e.test.ts --maxWorkers=1
      step "e2e-electron-$pass" env MATRIX_DESKTOP_E2E_REQUIRED=1 MATRIX_PROVIDER_AUTH_ELECTRON=1 \
        MATRIX_SETTINGS_EVIDENCE_DIR=output/playwright/settings-providers xvfb-run --auto-servernum \
        pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=2 \
        tests/e2e/desktop/file-download.e2e.test.ts tests/e2e/desktop/canonical-input.e2e.test.ts \
        tests/e2e/provider-authorization-electron.e2e.test.ts tests/e2e/desktop/provider-auth-terminal.e2e.test.ts \
        tests/e2e/desktop/agents-providers-figma.e2e.test.ts tests/e2e/desktop/agents-providers-button-contrast.e2e.test.ts \
        tests/e2e/desktop/provider-settings-idle.e2e.test.ts tests/e2e/desktop/project-folder-picker-layout.e2e.test.ts \
        tests/e2e/desktop/terminal-file-drop.e2e.test.ts \
        tests/e2e/desktop/terminal-snapshot.e2e.test.ts tests/e2e/desktop/release-alignment.e2e.test.ts \
        tests/e2e/desktop/chat-title-layout.e2e.test.ts
      # Hosted CI gives clipboard its own display. A different Electron window
      # can blur a held mouse drag and cancel its edge-scroll selection timer.
      step "e2e-clipboard-$pass" env MATRIX_DESKTOP_E2E_REQUIRED=1 xvfb-run --auto-servernum \
        pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 \
        tests/e2e/desktop/terminal-clipboard.e2e.test.ts
      ;;
  esac
  return "$failure"
}
# Cold/warm passes belong to one admitted benchmark. Continue on suite failures
# so both measurements are recorded, then propagate the failed result.
unit_workers=12
if (( workers <= 8 )); then unit_workers=4; fi
failed=0
for pass in cold warm; do
  if [[ $suite == full ]]; then
    pids=()
    suite=unit workers=$unit_workers run_suite "$pass" & pids+=("$!")
    suite=checks workers=2 run_suite "$pass" & pids+=("$!")
    (
      desktop_status=0 general_status=0 electron_status=0
      # Build once per pass for the required Electron lane. General explicitly
      # excludes build-gated native suites so both passes match hosted CI.
      measure "desktop-build-$pass" bun run build:desktop || desktop_status=$?
      suite=e2e-general workers=2 run_suite "$pass" || general_status=$?
      suite=e2e-electron workers=2 run_suite "$pass" true || electron_status=$?
      (( desktop_status == 0 && general_status == 0 && electron_status == 0 ))
    ) & pids+=("$!")
    for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
  else
    run_suite "$pass" || failed=1
  fi
done
exit "$failed"

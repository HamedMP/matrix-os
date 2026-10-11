#!/bin/bash
# Immutable-image qualification; caller supplies a root-verified public merge manifest.
set -euo pipefail
set +x
[[ $# == 3 && $1 =~ ^[a-f0-9]{40}$ && $2 == /work/qualification-input.json && $3 =~ ^[a-f0-9]{64}$ ]] || exit 64
source_sha=$1 manifest_file=$2 manifest_sha=$3
proof=(python3 -I /opt/matrix-ci/qualification/source.py "$source_sha" "$manifest_file" "$manifest_sha")
unset MATRIX_TEST_POSTGRES_URL MATRIX_PLATFORM_FIXTURE_POSTGRES_URL
export PYTHONDONTWRITEBYTECODE=1 PLAYWRIGHT_CHROMIUM_CHANNEL=chromium NEXT_TELEMETRY_DISABLED=1
export MATRIX_TEST_WORKERS=16 MATRIX_TEST_PROFILE_SORT=1
export npm_config_store_dir=/work/pnpm-store XDG_CACHE_HOME=/work/cache XDG_DATA_HOME=/work/share
export PLAYWRIGHT_BROWSERS_PATH=/work/browsers
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2ktc2FmZS5leGFtcGxlLmNvbSQ=
export NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
export NEXT_PUBLIC_POSTHOG_KEY=phc_ci_shell_build NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_ci_shell_build
export NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com NEXT_PUBLIC_POSTHOG_API_HOST=/relay
mkdir -p /work/results
measure() {
 local lane=$1 label=$2 start status=0
 shift 2;start=$(date +%s)
 "$@" || status=$?
 printf '%s\t%s\t%s\n' "$label" "$(( $(date +%s)-start ))" "$status" >>"/work/results/timing-$lane.tsv"
 return "$status"
}
measure setup checkout "${proof[@]}" --prepare
# Four independent Git checkouts; install mutations are checked before any app code.
for lane in unit mechanical web e2e;do
 cd "/work/$lane"
 export XDG_CACHE_HOME="/work/cache/$lane" XDG_DATA_HOME="/work/share/$lane" PYTHONPYCACHEPREFIX="/work/cache/$lane/python"
 git config user.name CI
 git config user.email ci@matrix-os.com
 install_status=0
 measure setup "install-$lane" pnpm install --frozen-lockfile || install_status=$?
 measure setup "source-$lane" "${proof[@]}" --source-check "$lane" postinstall
 (( install_status == 0 )) || exit "$install_status"
done
for lane in unit mechanical web e2e;do
 cd "/work/$lane"
 export XDG_CACHE_HOME="/work/cache/$lane" XDG_DATA_HOME="/work/share/$lane" PYTHONPYCACHEPREFIX="/work/cache/$lane/python"
 measure setup "prerequisites-$lane" pnpm --filter @matrix-os/observability --filter @matrix-os/kernel --filter @matrix-os/integrations-mcp build
 measure setup "brand-build-$lane" pnpm --filter @matrix-os/brand build
 measure setup "source-prerequisites-$lane" "${proof[@]}" --source-check "$lane" after-prerequisites
done
measure setup unit-source-immutability "${proof[@]}" --prepare-unit-source
cd /work/unit
node --input-type=module -e '
 import {execFileSync} from "node:child_process";import {createRequire} from "node:module";import {readFileSync,writeFileSync} from "node:fs";
 const require=createRequire(process.cwd()+"/package.json");
 const version=(binary)=>execFileSync(binary,["--version"],{timeout:10000,maxBuffer:65536,encoding:"utf8"}).trim();
 const nativeTypeScript=JSON.parse(readFileSync(require.resolve("@typescript/native/package.json"),"utf8")).version;
 writeFileSync("/work/results/tools.json",JSON.stringify({node:process.version,pnpm:version("pnpm"),bun:version("bun"),nativeTypeScript}),{flag:"wx"});
'
failed=0
step() { measure "$@" || failed=1; }
cd /work/e2e
step setup browsers pnpm --filter @matrix-os/mcp-browser exec playwright install chromium
step setup shell-browsers pnpm --filter shell exec playwright install chromium
source /opt/matrix-ci/fixture-postgres.sh
step setup postgres-start start_fixture_postgres
unit_lane() {
 local failed=0
 cd /work/unit
 export XDG_CACHE_HOME=/work/cache/unit XDG_DATA_HOME=/work/share/unit PYTHONPYCACHEPREFIX=/work/cache/unit/python
 step unit unit pnpm exec vitest run --maxWorkers=16 --reporter=default --reporter=json --outputFile=/work/results/unit.json
 step unit docs-parity-proof node scripts/ci/qualification-coverage.mjs /work/results/unit.json
 step unit source-coverage-proof "${proof[@]}" --coverage
 step unit source-after-unit "${proof[@]}" --source-check unit after-lane
 return "$failed"
}
mechanical_lane() {
 local failed=0
 cd /work/mechanical
 export XDG_CACHE_HOME=/work/cache/mechanical XDG_DATA_HOME=/work/share/mechanical PYTHONPYCACHEPREFIX=/work/cache/mechanical/python
 step mechanical typecheck bun run typecheck:run
 step mechanical sync-build pnpm --filter @finnaai/matrix build
 step mechanical sync-test pnpm --filter @finnaai/matrix test --maxWorkers=2
 step mechanical sync-publish pnpm --filter @finnaai/matrix exec node ./scripts/check-publish.mjs
 mkdir -p /work/sdk
 step mechanical sdk-install pnpm add --ignore-scripts --save-exact --dir /work/sdk @anthropic-ai/claude-agent-sdk@0.3.251
 step mechanical sdk env MATRIX_AGENT_SDK_PACKAGE_DIR=/work/sdk/node_modules/@anthropic-ai/claude-agent-sdk pnpm exec vitest run tests/scripts/agent-sdk-real-runtime-spike.test.ts --maxWorkers=2
 step mechanical source-after-mechanical "${proof[@]}" --source-check mechanical after-lane
 return "$failed"
}
web_lane() {
 local failed=0
 cd /work/web
 export XDG_CACHE_HOME=/work/cache/web XDG_DATA_HOME=/work/share/web PYTHONPYCACHEPREFIX=/work/cache/web/python
 step web shell bun run build:shell:production
 step web source-after-web "${proof[@]}" --source-check web after-lane
 return "$failed"
}
e2e_lane() {
 local failed=0
 cd /work/e2e
 export XDG_CACHE_HOME=/work/cache/e2e XDG_DATA_HOME=/work/share/e2e PYTHONPYCACHEPREFIX=/work/cache/e2e/python
  # Discovery and grid see the pristine source before ANY Desktop output.
  step e2e general xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/general.json
  step e2e grid env MATRIX_GRID_ELECTRON=1 xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/terminal-soft-grid.e2e.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=/work/results/grid.json
  if ! measure e2e source-before-desktop "${proof[@]}" --source-check e2e before-desktop;then
   measure e2e source-before-release "${proof[@]}" --source-check e2e before-release || true
   return 1
  fi
  step e2e desktop-build bun run build:desktop
  # Exact041 workflow order and separate displays, preserving required flags.
  export MATRIX_DESKTOP_E2E_REQUIRED=1
  step e2e electron-download xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/file-download.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-download.json
  step e2e electron-input xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/canonical-input.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-input.json
  step e2e electron-providers env MATRIX_PROVIDER_AUTH_ELECTRON=1 MATRIX_SETTINGS_EVIDENCE_DIR=output/playwright/settings-providers xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/provider-authorization-electron.e2e.test.ts tests/e2e/desktop/provider-auth-terminal.e2e.test.ts tests/e2e/desktop/agents-providers-figma.e2e.test.ts tests/e2e/desktop/agents-providers-button-contrast.e2e.test.ts tests/e2e/desktop/provider-settings-idle.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-providers.json
  step e2e electron-folder xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/project-folder-picker-layout.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-folder.json
  step e2e electron-clipboard xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/terminal-clipboard.e2e.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=/work/results/electron-clipboard.json
  step e2e electron-drop xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/terminal-file-drop.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-drop.json
  step e2e electron-snapshot xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/terminal-snapshot.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-snapshot.json
  if ! measure e2e source-before-release "${proof[@]}" --source-check e2e before-release;then return 1;fi
  step e2e electron-release xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/release-alignment.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-release.json
  step e2e electron-title xvfb-run --auto-servernum pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/desktop/chat-title-layout.e2e.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile=/work/results/electron-title.json

 step e2e source-after-e2e "${proof[@]}" --source-check e2e after-lane
 return "$failed"
}
pids=()
for lane in unit_lane mechanical_lane web_lane e2e_lane;do "$lane" & pids+=("$!");done
for pid in "${pids[@]}";do wait "$pid" || failed=1;done
# Stop native fixtures even after ordinary lane failures. Container cleanup owns
# timeout termination; no production or host database is ever contacted.
step cleanup postgres-stop stop_fixture_postgres
exit "$failed"

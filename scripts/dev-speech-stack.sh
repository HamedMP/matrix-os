#!/usr/bin/env bash
set -euo pipefail

if [[ "${PLATFORM_SPEECH_ENABLED:-}" != "true" ]]; then
  echo "PLATFORM_SPEECH_ENABLED=true is required; see docs/dev/platform-speech-local.md" >&2
  exit 1
fi

pnpm --filter '@matrix-os/observability' --filter '@matrix-os/brand' --filter '@matrix-os/kernel' build

child_pids=()
cleanup() {
  if (( ${#child_pids[@]} > 0 )); then
    kill -TERM "${child_pids[@]}" 2>/dev/null || true
    wait "${child_pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

pnpm --filter '@matrix-os/platform' dev &
child_pids+=("$!")
env -u PLATFORM_SPEECH_OPENAI_API_KEY -u PLATFORM_SPEECH_SECRET \
  pnpm --filter '@matrix-os/gateway' dev &
child_pids+=("$!")
env -u PLATFORM_SPEECH_OPENAI_API_KEY -u PLATFORM_SPEECH_SECRET \
  pnpm --filter './shell' dev &
child_pids+=("$!")

wait -n "${child_pids[@]}"

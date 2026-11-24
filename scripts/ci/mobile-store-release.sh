#!/usr/bin/env bash
# Run only from the reviewed main revision; credentials stay managed by EAS.
set -euo pipefail
umask 077

case "${1:-}" in
  ios) platform=ios; submit_profile=testflight; destination=TestFlight ;;
  android) platform=android; submit_profile=play-internal; destination='Google Play internal testing' ;;
  *) echo 'Expected ios or android.' >&2; exit 1 ;;
esac
if [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ] || [ "${GITHUB_REF:-}" != refs/heads/main ]; then
  echo 'Native beta releases require a manual workflow run from main.' >&2
  exit 1
fi
if [ -z "${EXPO_TOKEN:-}" ]; then
  echo 'Add EXPO_TOKEN to the workflow GitHub environment before releasing.' >&2
  exit 1
fi
: "${EAS_CLI_VERSION:?EAS CLI version is required}"
: "${GITHUB_SHA:?Source commit is required}"
: "${RUNNER_TEMP:?Runner temp directory is required}"
: "${GITHUB_STEP_SUMMARY:?Job summary path is required}"

cd "$(dirname "$0")/../../apps/mobile"
project_id="$(node -p "require('./app.json').expo.extra.eas.projectId")"
project_url=https://expo.dev/accounts/finnaai/projects/matrix-os-mobile
private_dir="$(mktemp -d "$RUNNER_TEMP/eas-store-XXXXXX")"
trap 'rm -rf -- "$private_dir"' EXIT
eas() { pnpm dlx "eas-cli@${EAS_CLI_VERSION}" "$@"; }

{
  echo "### Native beta release: $destination"
  echo "- Commit: \`$GITHUB_SHA\`"
  echo "- Build profile: \`production\`; submit profile: \`$submit_profile\`"
  echo "- Builds: $project_url/builds"
} >> "$GITHUB_STEP_SUMMARY"

# JSON and logs may contain signed URLs or account details; keep them private.
if ! eas build --platform "$platform" --profile production \
  --wait --non-interactive --freeze-credentials --json \
  > "$private_dir/build.json" 2> "$private_dir/build.log"; then
  echo "EAS build failed. Inspect this run's build on the EAS project dashboard." >&2
  exit 1
fi

# Submit only the single successful build returned by this invocation, with
# matching project, platform and source revision. Never choose --latest.
if ! build_id="$(jq -er --arg platform "$(printf '%s' "$platform" | tr '[:lower:]' '[:upper:]')" \
  --arg project "$project_id" --arg sha "$GITHUB_SHA" '
    if type == "array" and length == 1 then .[0] else error("Expected one build") end
    | select(.status == "FINISHED" and .platform == $platform
      and .app.id == $project and .gitCommitHash == $sha)
    | .id | select(type == "string")
    | select(test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))
  ' "$private_dir/build.json" 2> "$private_dir/validation.log")"; then
  echo 'Build result did not match the requested project, platform and commit; submission refused.' >&2
  exit 1
fi

echo "- Build: $project_url/builds/$build_id" >> "$GITHUB_STEP_SUMMARY"
submit_args=(--wait --non-interactive)
if [ "$platform" = ios ]; then
  # Preserve the store's existing tester groups instead of creating one in CI.
  submit_args+=(--no-auto-testflight-setup)
fi
if ! eas submit --platform "$platform" --profile "$submit_profile" --id "$build_id" \
  "${submit_args[@]}" > "$private_dir/submit.log" 2>&1; then
  echo "Submission failed for build $build_id. Check EAS Submissions; reuse this build after resolving the cause." >&2
  exit 1
fi
{
  echo "- EAS submission finished: $project_url/submissions"
  echo '- Verify store processing and tester availability in the store console.'
} >> "$GITHUB_STEP_SUMMARY"

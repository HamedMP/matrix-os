#!/usr/bin/env bash
set -euo pipefail

should_build=true
reason="host bundle build required"

is_metadata_only_change() {
  local saw_file=false
  local file

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    saw_file=true

    case "$file" in
      www/*|docs/*|specs/*|audit/*|README.md|README.*|AGENTS.md|CLAUDE.md)
        ;;
      *)
        return 1
        ;;
    esac
  done <<< "${CHANGED_FILES:-}"

  [ "$saw_file" = true ]
}

if [ "${SKIP_DEV_BUNDLE_INPUT:-false}" = "true" ]; then
  should_build=false
  reason="skip_dev_bundle workflow input was true"
elif [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  reason="tag releases always build by default"
elif [ "${GITHUB_EVENT_NAME:-}" = "push" ]; then
  case "${HEAD_COMMIT_MESSAGE:-}" in
    *"[skip dev-bundle]"*|*"[skip dev bundle]"*|*"Skip-Dev-Bundle: true"*|*"skip-dev-bundle: true"*|*"skip_dev_bundle: true"*)
      should_build=false
      reason="commit message requested dev bundle skip"
      ;;
  esac

  if [ "$should_build" = "true" ] && is_metadata_only_change; then
    should_build=false
    reason="only landing/docs/readme metadata changed"
  fi
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "should_build=$should_build"
    echo "reason=$reason"
  } >> "$GITHUB_OUTPUT"
fi

echo "Dev bundle gate: $reason"

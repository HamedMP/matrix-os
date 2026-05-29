#!/usr/bin/env bash
set -euo pipefail

should_build=true
reason="host bundle build required"

if [ "${SKIP_DEV_BUNDLE_INPUT:-false}" = "true" ]; then
  should_build=false
  reason="skip_dev_bundle workflow input was true"
elif [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  reason="tag releases always build by default"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "should_build=$should_build"
    echo "reason=$reason"
  } >> "$GITHUB_OUTPUT"
fi

echo "Dev bundle gate: $reason"

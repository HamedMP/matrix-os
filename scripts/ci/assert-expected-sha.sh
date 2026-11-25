#!/usr/bin/env bash
# Stops a manually dispatched release when the commit it would build is not the
# commit that was approved. `gh workflow run --ref main` runs whatever main is
# when the dispatch lands, so without this pin a commit nobody reviewed can be
# published or given traffic. Runs with no pin (pushes, tags) pass through.
set -euo pipefail

expected="${EXPECTED_SHA:-}"
actual="${GITHUB_SHA:-}"

if [ -z "$expected" ]; then
  echo "No approved commit was pinned for this run; building ${actual:-the checked-out commit}."
  exit 0
fi

expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "expected_sha must be a full 40-character commit SHA, got: $expected" >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "This run would build $actual, but the approved commit is $expected." >&2
  echo "main moved after approval. Nothing was built or published. Review the new commits and dispatch again." >&2
  exit 1
fi

echo "Building the approved commit $expected."

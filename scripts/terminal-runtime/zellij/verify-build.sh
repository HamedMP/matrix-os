#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: verify-build.sh BUILD_DIRECTORY" >&2
  exit 2
fi

build_dir="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
candidate_record="$script_dir/v0.44.3-matrix.1.build.json"

for required in zellij build.json build-id zellij.sha256; do
  if [ -L "$build_dir/$required" ]; then
    echo "zellij_production_build_unsafe" >&2
    exit 3
  fi
  if [ ! -f "$build_dir/$required" ]; then
    echo "zellij_production_build_missing" >&2
    exit 3
  fi
done
if [ ! -x "$build_dir/zellij" ]; then
  echo "zellij_production_build_missing" >&2
  exit 3
fi

if ! cmp -s -- "$candidate_record" "$build_dir/build.json"; then
  echo "zellij_production_build_metadata_mismatch" >&2
  exit 4
fi

expected_build_id="$(jq -er '.buildId' "$candidate_record")"
expected_binary_sha256="$(jq -er '.binarySha256' "$candidate_record")"
actual_build_id="$(tr -d '\n' <"$build_dir/build-id")"
recorded_binary_sha256="$(tr -d '\n' <"$build_dir/zellij.sha256")"
actual_binary_sha256="$(sha256sum "$build_dir/zellij" | awk '{print $1}')"

if [ "$actual_build_id" != "$expected_build_id" ]; then
  echo "zellij_production_build_id_mismatch" >&2
  exit 4
fi
if [ "$recorded_binary_sha256" != "$expected_binary_sha256" ] ||
   [ "$actual_binary_sha256" != "$expected_binary_sha256" ]; then
  echo "zellij_production_binary_digest_mismatch" >&2
  exit 5
fi

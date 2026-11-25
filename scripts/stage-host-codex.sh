#!/usr/bin/env bash
set -euo pipefail

archive="${1:?missing Codex release archive}"
expected_sha256="${2:?missing Codex release checksum}"
host_bin="${3:?missing host bundle bin directory}"

checksum="$(sha256sum < "$archive")"
if [ "${checksum%% *}" != "$expected_sha256" ]; then
  echo "Codex release archive checksum mismatch" >&2
  exit 1
fi

staged="$(mktemp "$host_bin/.matrix-codex.XXXXXX")"
trap 'rm -f -- "$staged"' EXIT
tar -xOzf "$archive" codex-x86_64-unknown-linux-musl > "$staged"
test -s "$staged"
chmod 0755 "$staged"
mv -f -- "$staged" "$host_bin/matrix-codex"

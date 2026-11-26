#!/usr/bin/env bash
set -euo pipefail

archive="${1:?missing Codex release archive}"
expected_sha256="${2:?missing Codex release checksum}"
host_archive="${3:?missing Codex code-mode host release archive}"
host_expected_sha256="${4:?missing Codex code-mode host release checksum}"
host_bin="${5:?missing host bundle bin directory}"

verify_checksum() {
  local checksum
  checksum="$(sha256sum < "$1")"
  if [ "${checksum%% *}" != "$2" ]; then
    echo "$3 checksum mismatch" >&2
    exit 1
  fi
}

# Verify both archives before writing either binary into the bundle.
verify_checksum "$archive" "$expected_sha256" "Codex release archive"
verify_checksum "$host_archive" "$host_expected_sha256" "Codex code-mode host release archive"

staged="$(mktemp "$host_bin/.matrix-codex.XXXXXX")"
staged_host="$(mktemp "$host_bin/.codex-code-mode-host.XXXXXX")"
trap 'rm -f -- "$staged" "$staged_host"' EXIT
tar -xOzf "$archive" codex-x86_64-unknown-linux-musl > "$staged"
tar -xOzf "$host_archive" codex-code-mode-host-x86_64-unknown-linux-musl > "$staged_host"
test -s "$staged"
test -s "$staged_host"
chmod 0755 "$staged" "$staged_host"
# Codex runs shell tools through this sidecar and resolves it next to its own executable.
mv -f -- "$staged_host" "$host_bin/codex-code-mode-host"
mv -f -- "$staged" "$host_bin/matrix-codex"

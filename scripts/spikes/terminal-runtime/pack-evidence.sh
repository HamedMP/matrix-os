#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "spike_pack_requires_root" >&2
  exit 2
fi

pr_head_sha="${1:-}"
if ! printf '%s' "$pr_head_sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "spike_pack_invalid_sha" >&2
  exit 2
fi

short_sha="${pr_head_sha:0:7}"
evidence_name="matrix-terminal-spike-evidence-${short_sha}"
evidence_root="/tmp/${evidence_name}"
archive="/tmp/matrix-terminal-spike-evidence-${short_sha}.tar.gz"
if [ ! -d "$evidence_root" ] || [ -L "$evidence_root" ]; then
  echo "spike_pack_evidence_unavailable" >&2
  exit 3
fi
if [ ! -f "$evidence_root/summary.json" ] || [ -L "$evidence_root/summary.json" ]; then
  echo "spike_pack_evidence_incomplete" >&2
  exit 3
fi

cleanup() {
  rm -f -- "$archive"
}
trap cleanup EXIT
rm -f -- "$archive"
tar --create --gzip --file "$archive" --directory /tmp "$evidence_name"
archive_bytes="$(stat -c '%s' "$archive")"
if [ "$archive_bytes" -gt 524288 ]; then
  echo "spike_pack_archive_oversized" >&2
  exit 4
fi
base64 --wrap=0 "$archive"

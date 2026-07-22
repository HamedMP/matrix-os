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
evidence_name="matrix-terminal-spike-evidence-${pr_head_sha}"
evidence_root="/tmp/${evidence_name}"
if [ ! -d "$evidence_root" ] || [ -L "$evidence_root" ]; then
  echo "spike_pack_evidence_unavailable" >&2
  exit 3
fi
if [ ! -f "$evidence_root/summary.json" ] || [ -L "$evidence_root/summary.json" ]; then
  echo "spike_pack_evidence_incomplete" >&2
  exit 3
fi
/opt/matrix/runtime/node/bin/node \
  /opt/matrix/app/scripts/spikes/terminal-runtime/verify-evidence.mjs \
  "$evidence_root" --pack "$pr_head_sha" | base64 --wrap=0

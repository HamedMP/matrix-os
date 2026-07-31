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
  stage="$(cat "$evidence_root/preflight-stage.txt" 2>/dev/null || true)"
  [[ "$stage" =~ ^[a-z0-9_]{1,32}$ ]] || stage=unknown
  state="$(systemctl is-active "matrix-terminal-runtime-spike-${pr_head_sha}.service" 2>/dev/null || true)"
  [[ "$state" =~ ^(active|activating|failed|inactive)$ ]] || state=unknown
  echo "spike_pack_evidence_incomplete_${stage}_${state}"
  exit 0
fi
/opt/matrix/runtime/node/bin/node \
  /opt/matrix/libexec/terminal-runtime/current/spikes/verify-evidence.mjs \
  "$evidence_root" --pack "$pr_head_sha" | base64 --wrap=0

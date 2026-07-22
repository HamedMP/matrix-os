#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "spike_launch_requires_root" >&2
  exit 2
fi
pr_head_sha="${1:-}"
if ! printf '%s' "$pr_head_sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "spike_launch_invalid_sha" >&2
  exit 2
fi
unit="matrix-terminal-runtime-spike-${pr_head_sha}.service"
runner="/opt/matrix/app/scripts/spikes/terminal-runtime/run-remote.sh"
summary="/tmp/matrix-terminal-spike-evidence-${pr_head_sha}/summary.json"
load_state="$(systemctl show "$unit" -p LoadState --value 2>/dev/null || true)"
active_state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
if [ "$active_state" = "active" ] || [ "$active_state" = "activating" ]; then
  echo "spike_launch_existing"
  exit 0
fi
if [ -f "$summary" ] && [ ! -L "$summary" ]; then
  echo "spike_launch_existing"
  exit 0
fi
if [ "$load_state" = "loaded" ]; then
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  systemctl start --no-block "$unit"
else
  systemd-run \
    --unit="$unit" \
    --collect \
    --no-block \
    --property=Type=exec \
    --property=KillMode=control-group \
    --property=StandardOutput=null \
    --property=StandardError=null \
    --property=TimeoutStopSec=30 \
    -- "$runner" "$pr_head_sha" >/dev/null
fi
echo "spike_launch_started"

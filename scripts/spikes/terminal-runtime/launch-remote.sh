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
run_nonce="${2:-}"
if [[ ! "$run_nonce" =~ ^([1-9][0-9]{0,19})-([1-9][0-9]{0,5})$ ]]; then
  echo "spike_launch_invalid_nonce" >&2
  exit 2
fi
printf -v run_id_padded '%020s' "${BASH_REMATCH[1]}"
printf -v run_attempt_padded '%06s' "${BASH_REMATCH[2]}"
run_id_padded="${run_id_padded// /0}"
run_attempt_padded="${run_attempt_padded// /0}"
run_namespace="${pr_head_sha:0:5}${run_id_padded}${run_attempt_padded}"
unit="matrix-terminal-runtime-spike-${run_namespace}.service"
runner="/opt/matrix/libexec/terminal-runtime/current/spikes/run-remote.sh"
summary="/tmp/matrix-terminal-spike-evidence-${pr_head_sha}-${run_nonce}/summary.json"
stale_units="$(/usr/bin/timeout --signal=TERM --kill-after=1s 5s \
  systemctl list-units --all --plain --no-legend 'matrix-terminal-runtime-spike-*.service' \
  2>/dev/null | awk '{print $1}' || true)"
for stale_unit in $stale_units; do
  if ! [[ "$stale_unit" =~ ^matrix-terminal-runtime-spike-[0-9a-f]{31}\.service$ ]] ||
    [ "$stale_unit" = "$unit" ]; then
    continue
  fi
  if ! /usr/bin/timeout --signal=TERM --kill-after=2s 35s systemctl stop "$stale_unit" \
    >/dev/null 2>&1; then
    /usr/bin/timeout --signal=KILL 5s systemctl kill --kill-whom=all \
      --signal=KILL "$stale_unit" >/dev/null 2>&1 || true
  fi
  stale_state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 5s \
    systemctl show "$stale_unit" -p ActiveState --value 2>/dev/null || true)"
  case "$stale_state" in
    ""|failed|inactive) ;;
    *) echo "spike_stale_cleanup_failed" >&2; exit 3 ;;
  esac
  /usr/bin/timeout --signal=TERM --kill-after=1s 5s \
    systemctl reset-failed "$stale_unit" >/dev/null 2>&1 || true
done
load_state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 5s \
  systemctl show "$unit" -p LoadState --value 2>/dev/null || true)"
active_state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 5s \
  systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
if [ "$active_state" = "active" ] || [ "$active_state" = "activating" ]; then
  echo "spike_launch_existing"
  exit 0
fi
if [ -f "$summary" ] && [ ! -L "$summary" ]; then
  echo "spike_launch_existing"
  exit 0
fi
if [ "$load_state" = "loaded" ]; then
  /usr/bin/timeout --signal=TERM --kill-after=1s 5s \
    systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  /usr/bin/timeout --signal=TERM --kill-after=1s 5s \
    systemctl start --no-block "$unit"
else
  /usr/bin/timeout --signal=TERM --kill-after=1s 10s systemd-run \
    --unit="$unit" \
    --collect \
    --no-block \
    --property=Type=exec \
    --property=KillMode=control-group \
    --property=RuntimeMaxSec=1800 \
    --property=StandardOutput=null \
    --property=StandardError=null \
    --property=TimeoutStopSec=30 \
    -- "$runner" "$pr_head_sha" "$run_nonce" >/dev/null
fi
echo "spike_launch_started"

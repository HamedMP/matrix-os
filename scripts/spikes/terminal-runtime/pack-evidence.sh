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
  state="$(systemctl is-active "matrix-terminal-runtime-spike-${pr_head_sha}.service" 2>/dev/null || true)"; [[ "$state" =~ ^(active|activating|failed|inactive)$ ]] || state=unknown
  echo "spike_pack_evidence_incomplete_no_root_${state}"; exit 0
fi
if [ ! -f "$evidence_root/summary.json" ] || [ -L "$evidence_root/summary.json" ]; then
  state="$(systemctl is-active "matrix-terminal-runtime-spike-${pr_head_sha}.service" 2>/dev/null || true)"; [[ "$state" =~ ^(active|activating|failed|inactive)$ ]] || state=unknown
  base_id="1${pr_head_sha:0:31}"; base_unit="matrix-terminal-spike@${base_id}.service"
  base_state="$(/usr/bin/timeout 2s systemctl show "$base_unit" -p ActiveState --value 2>/dev/null || true)"; [[ "$base_state" =~ ^(active|activating|failed|inactive)$ ]] || base_state=unknown
  base_substate="$(/usr/bin/timeout 2s systemctl show "$base_unit" -p SubState --value 2>/dev/null | tr - _ || true)"; [[ "$base_substate" =~ ^[a-z0-9_]{1,24}$ ]] || base_substate=unknown
  exec_status="$(/usr/bin/timeout 2s systemctl show "$base_unit" -p ExecMainStatus --value 2>/dev/null || true)"; [[ "$exec_status" =~ ^[0-9]{1,3}$ ]] || exec_status=999
  read -r failure_stage failure_code < <(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-z0-9_]{1,32}$/.test(v.stage)||!/^[a-z0-9_]{1,32}$/.test(v.code))process.exit(1);process.stdout.write(`${v.stage} ${v.code}\n`);
  ' "/run/matrix-terminal-runtime-spike/startup-failures/${base_id}.json" 2>/dev/null || printf 'unknown unknown\n')
  echo "spike_pack_evidence_incomplete_${state}_${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}"
  exit 0
fi
/opt/matrix/runtime/node/bin/node \
  /opt/matrix/libexec/terminal-runtime/current/spikes/verify-evidence.mjs \
  "$evidence_root" --pack "$pr_head_sha" | base64 --wrap=0

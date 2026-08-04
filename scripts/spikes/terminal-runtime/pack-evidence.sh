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
run_nonce="${2:-}"
if [[ ! "$run_nonce" =~ ^([1-9][0-9]{0,19})-([1-9][0-9]{0,5})$ ]]; then
  echo "spike_pack_invalid_nonce" >&2
  exit 2
fi
printf -v run_id_padded '%020s' "${BASH_REMATCH[1]}"
printf -v run_attempt_padded '%06s' "${BASH_REMATCH[2]}"
run_id_padded="${run_id_padded// /0}"
run_attempt_padded="${run_attempt_padded// /0}"
run_namespace="${pr_head_sha:0:5}${run_id_padded}${run_attempt_padded}"
evidence_name="matrix-terminal-spike-evidence-${pr_head_sha}-${run_nonce}"
evidence_root="/tmp/${evidence_name}"
base_id="1${run_namespace}"
runner_unit="matrix-terminal-runtime-spike-${run_namespace}.service"
base_unit="matrix-terminal-spike@${base_id}.service"
if [ ! -d "$evidence_root" ] || [ -L "$evidence_root" ]; then
  state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl is-active "$runner_unit" 2>/dev/null || true)"; [[ "$state" =~ ^(active|activating|failed|inactive)$ ]] || state=unknown
  echo "spike_pack_evidence_incomplete_no_root_${state}"; exit 0
fi
if [ ! -f "$evidence_root/summary.json" ] || [ -L "$evidence_root/summary.json" ]; then
  state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl is-active "$runner_unit" 2>/dev/null || true)"; [[ "$state" =~ ^(active|activating|failed|inactive)$ ]] || state=unknown
  base_state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p ActiveState --value 2>/dev/null || true)"; [[ "$base_state" =~ ^(active|activating|failed|inactive)$ ]] || base_state=unknown
  base_substate="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p SubState --value 2>/dev/null | tr - _ || true)"; [[ "$base_substate" =~ ^[a-z0-9_]{1,24}$ ]] || base_substate=unknown
  exec_status="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p ExecMainStatus --value 2>/dev/null || true)"; [[ "$exec_status" =~ ^[0-9]{1,3}$ ]] || exec_status=999
  read -r failure_stage failure_code < <(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-z0-9_]{1,32}$/.test(v.stage)||!/^[a-z0-9_]{1,32}$/.test(v.code))process.exit(1);process.stdout.write(`${v.stage} ${v.code}\n`);
  ' "/run/matrix-terminal-runtime-spikes/${run_namespace}/startup-failures/${base_id}.json" 2>/dev/null || printf 'unknown unknown\n')
  read -r keeper_stage keeper_responsive keeper_zellij keeper_shell keeper_agent keeper_gate keeper_release keeper_confirmation keeper_held < <(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(!/^(descriptor|launch|cgroup|readiness|notify)$/.test(v.stage)||typeof v.responsive!=="boolean"||
      !Number.isInteger(v.zellij)||v.zellij<0||v.zellij>999||typeof v.shell!=="boolean"||typeof v.agent!=="boolean"||
      typeof v.gateRecorded!=="boolean"||typeof v.paneReleased!=="boolean"||
      !/^(waiting|inventory|target|send|acceptance|accepted)$/.test(v.confirmationState)||
      !Number.isInteger(v.heldPaneCount)||v.heldPaneCount<0||v.heldPaneCount>16)process.exit(1);
    process.stdout.write(`${v.stage} ${v.responsive?1:0} ${v.zellij} ${v.shell?1:0} ${v.agent?1:0} ${v.gateRecorded?1:0} ${v.paneReleased?1:0} ${v.confirmationState} ${v.heldPaneCount}\n`);
  ' "/run/matrix-terminal-runtime-spikes/${run_namespace}/startup-stages/${base_id}.json" 2>/dev/null || printf 'unknown 0 0 0 0 0 0 waiting 0\n')
  timeout_start="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p TimeoutStartUSec --value 2>/dev/null || true)"
  [[ "$timeout_start" =~ ^([0-9]{1,12}(us|ms|s|min|h)?|infinity)$ ]] || timeout_start=unknown
  restart_count="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p NRestarts --value 2>/dev/null || true)"
  [[ "$restart_count" =~ ^[0-9]{1,6}$ ]] || restart_count=unknown
  base_pid="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p MainPID --value 2>/dev/null || true)"
  base_role=none
  base_wait=none
  if [[ "$base_pid" =~ ^[1-9][0-9]{0,9}$ ]]; then
    base_role="$(/usr/bin/timeout --signal=TERM --kill-after=1s 1s /usr/bin/cat "/proc/${base_pid}/comm" 2>/dev/null || true)"
    [[ "$base_role" =~ ^[a-zA-Z0-9_.-]{1,24}$ ]] || base_role=unknown
    base_role="${base_role,,}"
    base_wait="$(/usr/bin/timeout --signal=TERM --kill-after=1s 1s /usr/bin/cat "/proc/${base_pid}/wchan" 2>/dev/null || true)"
    [[ "$base_wait" =~ ^[a-zA-Z0-9_]{1,48}$ ]] || base_wait=unknown
    base_wait="${base_wait,,}"
  fi
  base_cgroup_count="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p TasksCurrent --value 2>/dev/null || true)"
  [[ "$base_cgroup_count" =~ ^[0-9]{1,6}$ ]] || base_cgroup_count=unknown
  runner_pid="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$runner_unit" -p MainPID --value 2>/dev/null || true)"
  runner_wait=unknown
  if [[ "$runner_pid" =~ ^[1-9][0-9]{0,9}$ ]]; then
    runner_wait="$(/usr/bin/timeout --signal=TERM --kill-after=1s 1s /usr/bin/cat "/proc/${runner_pid}/wchan" 2>/dev/null || true)"
    [[ "$runner_wait" =~ ^[a-zA-Z0-9_]{1,48}$ ]] || runner_wait=unknown
    runner_wait="${runner_wait,,}"
  fi
  progress_stage=unknown
  progress_path="$evidence_root/progress-stage.txt"
  if [ -f "$progress_path" ] && [ ! -L "$progress_path" ]; then
    progress_size="$(/usr/bin/stat -c %s "$progress_path" 2>/dev/null || true)"
    if [[ "$progress_size" =~ ^[0-9]{1,2}$ ]] && [ "$progress_size" -le 33 ]; then
      progress_candidate="$(<"$progress_path")"
      if [[ "$progress_candidate" =~ ^[a-z0-9_]{1,32}$ ]]; then
        progress_stage="$progress_candidate"
      fi
    fi
  fi
  if [[ "$progress_stage" =~ ^base_[a-z0-9_]{1,24}$ ]]; then
    progress_stalled=false
    progress_started="$(/usr/bin/awk 'NR == 1 && $1 ~ /^[0-9]+([.][0-9]+)?$/ { print int($1) }' "$evidence_root/progress-uptime.txt" 2>/dev/null || true)"
    progress_now="$(/usr/bin/awk 'NR == 1 && $1 ~ /^[0-9]+([.][0-9]+)?$/ { print int($1) }' /proc/uptime 2>/dev/null || true)"
    runner_started_usec="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$runner_unit" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || true)"
    if [[ "$runner_started_usec" =~ ^[1-9][0-9]{0,17}$ ]]; then
      runner_started=$((runner_started_usec / 1000000))
      if ! [[ "$progress_started" =~ ^[0-9]{1,12}$ ]] || [ "$runner_started" -lt "$progress_started" ]; then
        progress_started="$runner_started"
      fi
    fi
    if [[ "$progress_started" =~ ^[0-9]{1,12}$ ]] &&
      [[ "$progress_now" =~ ^[0-9]{1,12}$ ]] &&
      [ "$progress_now" -ge "$progress_started" ]; then
      progress_age=$((progress_now - progress_started))
      if [ "$progress_age" -ge 150 ]; then progress_stalled=true; fi
    fi
    progress_wall_started="$(/usr/bin/stat -c %Y "$progress_path" 2>/dev/null || true)"
    progress_wall_now="$(/usr/bin/date +%s 2>/dev/null || true)"
    if [[ "$progress_wall_started" =~ ^[0-9]{1,12}$ ]] &&
      [[ "$progress_wall_now" =~ ^[0-9]{1,12}$ ]] &&
      [ "$progress_wall_now" -ge "$progress_wall_started" ] &&
      [ $((progress_wall_now - progress_wall_started)) -ge 150 ]; then
      progress_stalled=true
    fi
    if [ "$progress_stalled" = true ]; then
      progress_stage="stalled_${progress_stage}_${keeper_stage}_${timeout_start}_${restart_count}_${runner_wait}_${base_role}_${base_wait}_${base_cgroup_count}"
      progress_stage="${progress_stage}_r${keeper_responsive}_z${keeper_zellij}_s${keeper_shell}_a${keeper_agent}_g${keeper_gate}_p${keeper_release}_c${keeper_confirmation}_h${keeper_held}"
    fi
  fi
  echo "spike_pack_evidence_incomplete_${state}_${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}_${progress_stage}_${keeper_stage}_${timeout_start}_${restart_count}_${runner_wait}_${base_role}_${base_wait}_${base_cgroup_count}_r${keeper_responsive}_z${keeper_zellij}_s${keeper_shell}_a${keeper_agent}_g${keeper_gate}_p${keeper_release}_c${keeper_confirmation}_h${keeper_held}"
  exit 0
fi
summary_status="$(/opt/matrix/runtime/node/bin/node -e '
  const fs=require("fs"),p=process.argv[1],s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>262144)process.exit(1);
  const v=JSON.parse(fs.readFileSync(p,"utf8"));if(!v||typeof v!=="object"||!v.s1||!v.s2||
    !/^(pass|fail)$/.test(v.s1.status)||!/^(pass|fail)$/.test(v.s2.status))process.exit(1);
  process.stdout.write(`${v.s1.status}_${v.s2.status}\n`);
' "$evidence_root/summary.json" 2>/dev/null || printf invalid)"
if [ "$summary_status" != pass_pass ]; then
  read -r failure_stage failure_code failure_responsive failure_zellij failure_shell failure_agent failure_gate failure_release failure_confirmation failure_held failure_sent < <(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(!/^(descriptor|launch|cgroup|readiness|notify)$/.test(v.stage)||!/^[a-z0-9_]{1,32}$/.test(v.code)||
      typeof v.responsive!=="boolean"||!Number.isInteger(v.zellij)||v.zellij<0||v.zellij>999||
      typeof v.shell!=="boolean"||typeof v.agent!=="boolean"||typeof v.gateRecorded!=="boolean"||
      typeof v.paneReleased!=="boolean"||!/^(waiting|inventory|target|send|acceptance|accepted)$/.test(v.confirmationState)||
      !Number.isInteger(v.heldPaneCount)||v.heldPaneCount<0||v.heldPaneCount>16||typeof v.confirmationSent!=="boolean")process.exit(1);
    process.stdout.write(`${v.stage} ${v.code} ${v.responsive?1:0} ${v.zellij} ${v.shell?1:0} ${v.agent?1:0} ${v.gateRecorded?1:0} ${v.paneReleased?1:0} ${v.confirmationState} ${v.heldPaneCount} ${v.confirmationSent?1:0}\n`);
  ' "/run/matrix-terminal-runtime-spikes/${run_namespace}/startup-failures/${base_id}.json" 2>/dev/null || printf 'unknown unknown 0 0 0 0 0 0 waiting 0 0\n')
  echo "spike_pack_evidence_failed_${failure_stage}_${failure_code}_r${failure_responsive}_z${failure_zellij}_s${failure_shell}_a${failure_agent}_g${failure_gate}_p${failure_release}_c${failure_confirmation}_h${failure_held}_x${failure_sent}"
  exit 0
fi
/opt/matrix/runtime/node/bin/node \
  /opt/matrix/libexec/terminal-runtime/current/spikes/verify-evidence.mjs \
  "$evidence_root" --pack "$pr_head_sha" | base64 --wrap=0

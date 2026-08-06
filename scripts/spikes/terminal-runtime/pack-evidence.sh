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
keeper_id="2${run_namespace}"
server_id="3${run_namespace}"
memory_ids=("4${run_namespace}" "5${run_namespace}" "6${run_namespace}")
recovery_id="7${run_namespace}"
runtime_ids=("$base_id" "$keeper_id" "$server_id" "${memory_ids[@]}" "$recovery_id")
runner_unit="matrix-terminal-runtime-spike-${run_namespace}.service"
base_unit="matrix-terminal-spike@${base_id}.service"
startup_failure_rollup() {
  local index runtime_id failure_path stage code unit unit_state exec_status rollup=""
  for index in "${!runtime_ids[@]}"; do
    runtime_id="${runtime_ids[$index]}"
    failure_path="/run/matrix-terminal-runtime-spikes/${run_namespace}/startup-failures/${runtime_id}.json"
    stage=none
    code=none
    if [ -f "$failure_path" ] && [ ! -L "$failure_path" ]; then
      read -r stage code < <(/opt/matrix/runtime/node/bin/node -e '
        const fs=require("fs"),path=process.argv[1],stat=fs.lstatSync(path);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536)process.exit(1);
        const value=JSON.parse(fs.readFileSync(path,"utf8"));
        if(!/^(descriptor|launch|cgroup|readiness|notify)$/.test(value.stage)||
          !/^[a-z0-9_]{1,32}$/.test(value.code))process.exit(1);
        process.stdout.write(`${value.stage} ${value.code}\n`);
      ' "$failure_path" 2>/dev/null || printf 'invalid invalid\n')
    fi
    unit="matrix-terminal-spike@${runtime_id}.service"
    unit_state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
    [[ "$unit_state" =~ ^(active|activating|failed|inactive)$ ]] || unit_state=unknown
    exec_status="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || true)"
    [[ "$exec_status" =~ ^[0-9]{1,3}$ ]] || exec_status=999
    rollup="${rollup}i${index}_${stage}_${code}_${unit_state}_${exec_status}_"
  done
  rollup="${rollup%_}"
  [[ "$rollup" =~ ^[a-z0-9_]{1,1024}$ ]] || rollup=invalid
  printf '%s\n' "$rollup"
}
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
  read -r keeper_stage keeper_responsive keeper_zellij keeper_shell keeper_agent keeper_gate keeper_release keeper_confirmation keeper_held keeper_helper keeper_helper_exit keeper_workload keeper_workload_exit < <(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(!/^(descriptor|launch|cgroup|readiness|notify)$/.test(v.stage)||typeof v.responsive!=="boolean"||
      !Number.isInteger(v.zellij)||v.zellij<0||v.zellij>999||typeof v.shell!=="boolean"||typeof v.agent!=="boolean"||
      typeof v.gateRecorded!=="boolean"||typeof v.paneReleased!=="boolean"||
      !/^(waiting|not_required|gated)$/.test(v.confirmationState)||
      !Number.isInteger(v.heldPaneCount)||v.heldPaneCount<0||v.heldPaneCount>16||
      !/^(not_checked|spawn_error|early_exit|running|cleanup_error|cleanup_timeout)$/.test(v.workloadHelperState)||
      (v.workloadHelperExitStatus!==null&&(!Number.isInteger(v.workloadHelperExitStatus)||v.workloadHelperExitStatus<0||v.workloadHelperExitStatus>255))||
      !/^(not_launched|missing|running|held_success|held_failure|other|ambiguous)$/.test(v.workloadPaneState)||
      (v.workloadPaneExitStatus!==null&&(!Number.isInteger(v.workloadPaneExitStatus)||v.workloadPaneExitStatus<0||v.workloadPaneExitStatus>255)))process.exit(1);
    process.stdout.write(`${v.stage} ${v.responsive?1:0} ${v.zellij} ${v.shell?1:0} ${v.agent?1:0} ${v.gateRecorded?1:0} ${v.paneReleased?1:0} ${v.confirmationState} ${v.heldPaneCount} ${v.workloadHelperState} ${v.workloadHelperExitStatus===null?"none":v.workloadHelperExitStatus} ${v.workloadPaneState} ${v.workloadPaneExitStatus===null?"none":v.workloadPaneExitStatus}\n`);
  ' "/run/matrix-terminal-runtime-spikes/${run_namespace}/startup-stages/${base_id}.json" 2>/dev/null || printf 'unknown 0 0 0 0 0 0 waiting 0 not_checked none not_launched none\n')
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
  progress_path="$evidence_root/last-work-stage.txt"
  progress_uptime_path="$evidence_root/last-work-uptime.txt"
  if [ ! -f "$progress_path" ] || [ -L "$progress_path" ]; then
    progress_path="$evidence_root/progress-stage.txt"
    progress_uptime_path="$evidence_root/progress-uptime.txt"
  fi
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
    progress_started="$(/usr/bin/awk 'NR == 1 && $1 ~ /^[0-9]+([.][0-9]+)?$/ { print int($1) }' "$progress_uptime_path" 2>/dev/null || true)"
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
      progress_stage="${progress_stage}_r${keeper_responsive}_z${keeper_zellij}_s${keeper_shell}_a${keeper_agent}_g${keeper_gate}_p${keeper_release}_c${keeper_confirmation}_h${keeper_held}_q${keeper_helper}_j${keeper_helper_exit}_w${keeper_workload}_e${keeper_workload_exit}"
    fi
  fi
  startup_rollup="$(startup_failure_rollup)"
  [[ "$startup_rollup" =~ ^[a-z0-9_]{1,1024}$ ]] || startup_rollup=invalid
  echo "spike_pack_evidence_incomplete_${state}_${base_state}_${base_substate}_${exec_status}_${failure_stage}_${failure_code}_${progress_stage}_${keeper_stage}_${timeout_start}_${restart_count}_${runner_wait}_${base_role}_${base_wait}_${base_cgroup_count}_f${startup_rollup}_r${keeper_responsive}_z${keeper_zellij}_s${keeper_shell}_a${keeper_agent}_g${keeper_gate}_p${keeper_release}_c${keeper_confirmation}_h${keeper_held}_q${keeper_helper}_j${keeper_helper_exit}_w${keeper_workload}_e${keeper_workload_exit}"
  exit 0
fi
summary_status="$(/opt/matrix/runtime/node/bin/node -e '
  const fs=require("fs"),p=process.argv[1],s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>262144)process.exit(1);
  const v=JSON.parse(fs.readFileSync(p,"utf8"));if(!v||typeof v!=="object"||!v.s1||!v.s2||
    !/^(pass|fail)$/.test(v.s1.status)||!/^(pass|fail)$/.test(v.s2.status))process.exit(1);
  process.stdout.write(`${v.s1.status}_${v.s2.status}\n`);
' "$evidence_root/summary.json" 2>/dev/null || printf invalid)"
if [ "$summary_status" != pass_pass ]; then
  gate_failures="$(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const allowed={s1:new Set([
      "keeperMainPid","runtimeCgroupMembers","gatewayOutsideCgroup","attachOutsideCgroup",
      "detachPreservesPids","gatewayRestartPreservesPids","gatewayCrashPreservesPids",
      "shellRestartPreservesPids","stopEmptiesCgroup","keeperLossDeterministic",
      "serverLossDeterministic","readinessGated","layeredMemoryHigh",
    ]),s2:new Set([
      "exactOptionSyntax","cacheMappedByRuntime","layoutRestored","viewportRestored",
      "scrollbackBounded","lossWindowBounded","commandsConfirmationGated","forceRunAbsent",
      "corruptionFallback","deletionComplete","diskAccountingBounded","liveSerializationDisableSafe",
    ])};
    const missing={s1:[],s2:[]};
    for(const gate of ["s1","s2"]){
      if(!v[gate]||typeof v[gate].checks!=="object"||v[gate].checks===null)process.exit(1);
      const entries=Object.entries(v[gate].checks);
      if(entries.length!==allowed[gate].size||entries.some(([name,value])=>!allowed[gate].has(name)||typeof value!=="boolean"))process.exit(1);
      for(const [name,value] of entries)if(!value)missing[gate].push(name.toLowerCase());
      missing[gate].sort();
    }
    process.stdout.write(`s1${missing.s1.join("_")||"none"}_s2${missing.s2.join("_")||"none"}`);
  ' "$evidence_root/summary.json" 2>/dev/null || printf 's1none_s2none')"
  read -r failure_stage failure_code failure_responsive failure_zellij failure_shell failure_agent failure_gate failure_release failure_confirmation failure_held failure_helper failure_helper_exit failure_workload failure_workload_exit failure_sent < <(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(!/^(descriptor|launch|cgroup|readiness|notify)$/.test(v.stage)||!/^[a-z0-9_]{1,32}$/.test(v.code)||
      typeof v.responsive!=="boolean"||!Number.isInteger(v.zellij)||v.zellij<0||v.zellij>999||
      typeof v.shell!=="boolean"||typeof v.agent!=="boolean"||typeof v.gateRecorded!=="boolean"||
      typeof v.paneReleased!=="boolean"||!/^(waiting|not_required|gated)$/.test(v.confirmationState)||
      !Number.isInteger(v.heldPaneCount)||v.heldPaneCount<0||v.heldPaneCount>16||
      !/^(not_checked|spawn_error|early_exit|running|cleanup_error|cleanup_timeout)$/.test(v.workloadHelperState)||
      (v.workloadHelperExitStatus!==null&&(!Number.isInteger(v.workloadHelperExitStatus)||v.workloadHelperExitStatus<0||v.workloadHelperExitStatus>255))||
      !/^(not_launched|missing|running|held_success|held_failure|other|ambiguous)$/.test(v.workloadPaneState)||
      (v.workloadPaneExitStatus!==null&&(!Number.isInteger(v.workloadPaneExitStatus)||v.workloadPaneExitStatus<0||v.workloadPaneExitStatus>255))||
      typeof v.confirmationSent!=="boolean")process.exit(1);
    process.stdout.write(`${v.stage} ${v.code} ${v.responsive?1:0} ${v.zellij} ${v.shell?1:0} ${v.agent?1:0} ${v.gateRecorded?1:0} ${v.paneReleased?1:0} ${v.confirmationState} ${v.heldPaneCount} ${v.workloadHelperState} ${v.workloadHelperExitStatus===null?"none":v.workloadHelperExitStatus} ${v.workloadPaneState} ${v.workloadPaneExitStatus===null?"none":v.workloadPaneExitStatus} ${v.confirmationSent?1:0}\n`);
  ' "/run/matrix-terminal-runtime-spikes/${run_namespace}/startup-failures/${base_id}.json" 2>/dev/null || printf 'unknown unknown 0 0 0 0 0 0 waiting 0 not_checked none not_launched none 0\n')
  failure_progress=unknown
  failure_progress_path="$evidence_root/last-work-stage.txt"
  if [ ! -f "$failure_progress_path" ] || [ -L "$failure_progress_path" ]; then
    failure_progress_path="$evidence_root/progress-stage.txt"
  fi
  if [ -f "$failure_progress_path" ] && [ ! -L "$failure_progress_path" ]; then
    failure_progress_size="$(/usr/bin/stat -c %s "$failure_progress_path" 2>/dev/null || true)"
    if [[ "$failure_progress_size" =~ ^[0-9]{1,2}$ ]] &&
      [ "$failure_progress_size" -le 33 ]; then
      failure_progress_candidate="$(<"$failure_progress_path")"
      if [[ "$failure_progress_candidate" =~ ^[a-z0-9_]{1,32}$ ]]; then
        failure_progress="$failure_progress_candidate"
      fi
    fi
  fi
  failure_runner_status="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$runner_unit" -p ExecMainStatus --value 2>/dev/null || true)"
  [[ "$failure_runner_status" =~ ^[0-9]{1,3}$ ]] || failure_runner_status=999
  failure_base_state="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p ActiveState --value 2>/dev/null || true)"
  [[ "$failure_base_state" =~ ^(active|activating|failed|inactive)$ ]] || failure_base_state=unknown
  failure_base_substate="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p SubState --value 2>/dev/null | tr - _ || true)"
  [[ "$failure_base_substate" =~ ^[a-z0-9_]{1,24}$ ]] || failure_base_substate=unknown
  failure_base_status="$(/usr/bin/timeout --signal=TERM --kill-after=1s 2s systemctl show "$base_unit" -p ExecMainStatus --value 2>/dev/null || true)"
  [[ "$failure_base_status" =~ ^[0-9]{1,3}$ ]] || failure_base_status=999
  startup_rollup="$(startup_failure_rollup)"
  [[ "$startup_rollup" =~ ^[a-z0-9_]{1,1024}$ ]] || startup_rollup=invalid
  echo "spike_pack_evidence_failed_${gate_failures}_${failure_stage}_${failure_code}_f${startup_rollup}_r${failure_responsive}_z${failure_zellij}_s${failure_shell}_a${failure_agent}_g${failure_gate}_p${failure_release}_c${failure_confirmation}_h${failure_held}_q${failure_helper}_j${failure_helper_exit}_w${failure_workload}_e${failure_workload_exit}_x${failure_sent}_d${failure_progress}_u${failure_runner_status}_b${failure_base_state}_${failure_base_substate}_${failure_base_status}"
  exit 0
fi
/opt/matrix/runtime/node/bin/node \
  /opt/matrix/libexec/terminal-runtime/current/spikes/verify-evidence.mjs \
  "$evidence_root" --pack "$pr_head_sha" | base64 --wrap=0

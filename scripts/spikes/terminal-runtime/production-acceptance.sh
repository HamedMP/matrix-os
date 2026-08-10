#!/usr/bin/env bash
set -euo pipefail
operation="${1:-}"; head_sha="${2:-}"; run_nonce="${3:-}"
if [ "$(id -u)" -ne 0 ] || [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "$run_nonce" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$ ]]; then
  echo "production_acceptance_invalid_request" >&2
  exit 2
fi
case "$operation" in
  launch|status|diagnose|reboot|resume|pack|cancel|phase1|phase2) ;;
  *) echo "production_acceptance_invalid_request" >&2; exit 2 ;;
esac
readonly root_parent=/var/lib/matrix-terminal-acceptance; readonly state_root="${root_parent}/${head_sha}-${run_nonce}"
readonly evidence_root="${state_root}/evidence"; readonly checks_root="${evidence_root}/checks"
readonly state_file="${state_root}/state"; readonly probe=/opt/matrix/libexec/terminal-runtime/current/spikes/production-probe.mjs
readonly verifier=/opt/matrix/libexec/terminal-runtime/current/spikes/verify-production-evidence.mjs; readonly version_a="v0.0.0-accept-${head_sha:0:7}-${run_nonce}-a"
readonly version_b="v0.0.0-accept-${head_sha:0:7}-${run_nonce}-b"; readonly unit_prefix=matrix-terminal-session@
readonly home=/home/matrix/home; readonly cache_root="${home}/system/terminal-runtime/zellij-cache"; readonly uid="$(id -u matrix)"
readonly pi=/opt/matrix/runtime/node/bin/pi; readonly update_wait_seconds=1800; current_phase=initializing; failure_hint=""
readonly -a zellij_env=(
  env HOME="$home" MATRIX_HOME="$home" LANG=C.UTF-8 TERM=xterm-256color
  PATH="$home/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin"
  XDG_RUNTIME_DIR="/run/user/${uid}" XDG_CACHE_HOME="$cache_root"
  XDG_CONFIG_HOME="$home/system/terminal-runtime/zellij-config-home" XDG_DATA_HOME="$home/system/terminal-runtime/zellij-data"
  ZELLIJ_CONFIG_DIR=/opt/matrix/libexec/terminal-runtime/current ZELLIJ_CONFIG_FILE=/opt/matrix/libexec/terminal-runtime/current/config.kdl
)
write_state() { install -d -o root -g root -m 0700 "$state_root"; local next="${state_file}.next"; printf '%s\n' "$1" >"$next"; chmod 0600 "$next"; mv -f -- "$next" "$state_file"; }
write_phase() { case "$1" in creating_runtime|waiting_runtime|seeding_output|starting_agent|waiting_roles|runtime_created|bundle_one|bundle_two|forced_failure|reapply_one|rollback_two|final_checks) ;; *) return 1 ;; esac; current_phase="$1"; write_state "phase1-running_${current_phase}"; }
command_bounded() {
  local timeout_seconds="$1" operation_pid deadline_pid completed_pid completed_status; shift
  [[ "$timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || return 2
  /usr/bin/setsid "$@" </dev/null & operation_pid=$!; /usr/bin/sleep "$timeout_seconds" & deadline_pid=$!
  completed_pid=""
  if wait -n -p completed_pid "$operation_pid" "$deadline_pid"; then completed_status=0; else completed_status=$?; fi
  if [ "$completed_pid" = "$operation_pid" ]; then
    kill "$deadline_pid" 2>/dev/null || true; wait "$deadline_pid" 2>/dev/null || true
    kill -TERM -- "-$operation_pid" 2>/dev/null || true; /usr/bin/sleep 0.05; kill -KILL -- "-$operation_pid" 2>/dev/null || true
    wait "$operation_pid" 2>/dev/null || true; return "$completed_status"
  fi
  kill -TERM -- "-$operation_pid" 2>/dev/null || true; /usr/bin/sleep 0.2; kill -KILL -- "-$operation_pid" 2>/dev/null || true
  wait "$operation_pid" 2>/dev/null || true; return 124
}
stop_process_group() { local operation_pid="$1"; kill -TERM -- "-$operation_pid" 2>/dev/null || true; /usr/bin/sleep 0.2; kill -KILL -- "-$operation_pid" 2>/dev/null || true; wait "$operation_pid" 2>/dev/null || true; }
systemctl_read() { command_bounded 8 /usr/bin/systemctl "$@"; }
systemctl_change() { command_bounded 40 /usr/bin/systemctl "$@"; }
systemctl_cancel() { command_bounded 20 /usr/bin/systemctl "$@"; }
mark() { install -m 0600 /dev/null "$checks_root/$1"; }
owner_probe() { command_bounded 70 runuser -u matrix -- /opt/matrix/runtime/node/bin/node "$probe" "$@"; }
json_field() { /opt/matrix/runtime/node/bin/node -e '
    let raw=""; process.stdin.on("data",d=>raw+=d); process.stdin.on("end",()=>{
      const value=JSON.parse(raw),keys=process.argv[1].split(".");let current=value;for(const key of keys)current=current?.[key];
      if(current===undefined||current===null)process.exit(1);process.stdout.write(String(current));});
  ' "$1"; }
wait_active() { local unit="$1"; for _ in $(seq 1 180); do [ "$(systemctl_read is-active "$unit" 2>/dev/null || true)" = active ] && return 0; sleep 1; done; return 1; }
wait_absent() { local unit="$1"; for _ in $(seq 1 60); do local state; state="$(systemctl_read is-active "$unit" 2>/dev/null || true)"; [ "$state" != active ] && [ "$state" != activating ] && return 0; sleep 1; done; return 1; }
roles() { command_bounded 8 /opt/matrix/runtime/node/bin/node "$probe" roles "$1"; }
role_values() { local raw="$1" key value joined=""; for key in processCount keeper zellijClient zellijServer pane shell agent output paneCandidates agentCandidates outputCandidates; do value="$(printf '%s' "$raw" | json_field "$key" 2>/dev/null || true)"; [[ "$value" =~ ^[0-9]{1,10}$ ]] || { printf unavailable; return; }; joined="${joined}${joined:+,}${value}"; done; printf '%s' "$joined"; }
roles_match() { local current; current="$(roles "$1")"; [ "$(role_values "$current")" = "$(cat "$2")" ]; }
both_roles_match() { roles_match "$1" "$state_root/roles.json" && roles_match "$2" "$state_root/agent-roles.json"; }
output_bytes() { local raw current; raw="$(roles "$1")" || return; current="$(printf '%s' "$raw" | json_field outputWriteBytes 2>/dev/null)" || return; [[ "$current" =~ ^[0-9]{1,15}$ ]] || return; printf '%s' "$current"; }; output_advanced() { local current; current="$(output_bytes "$1")" || return; (( current > last_output_bytes )) || return; last_output_bytes="$current"; }; runtime_continues() { for _ in $(seq 1 10); do if both_roles_match "$1" "$2" && output_advanced "$1"; then return; fi; sleep 1; done; return 1; }
request_update() { command_bounded 70 runuser -u matrix -- /opt/matrix/bin/matrix-update "$1" >/dev/null; }
wait_update() {
  local expected="$1"; for _ in $(seq 1 "$update_wait_seconds"); do
    if [ "$(cat /opt/matrix/app/BUNDLE_VERSION 2>/dev/null || true)" = "$expected" ] &&
      [ "$(cat /run/matrix-update-runtime/operation-state 2>/dev/null || true)" = idle ] &&
      systemctl_read is-active --quiet matrix-gateway.service; then return 0; fi
    [ "$(cat /run/matrix-update-runtime/operation-state 2>/dev/null || true)" != failed ] || return 1
    sleep 1
  done; return 1; }
wait_failed_update() { for _ in $(seq 1 "$update_wait_seconds"); do [ "$(cat /run/matrix-update-runtime/operation-state 2>/dev/null || true)" = failed ] && return 0; sleep 1; done; return 1; }
wait_pi_ready() {
  local installed=/var/lib/matrix-developer-tools/installed-tools; for _ in $(seq 1 "$update_wait_seconds"); do
    if grep -qxF pi "$installed" 2>/dev/null && [ -x "$pi" ] &&
      command_bounded 30 runuser -u matrix -- env HOME="$home" PATH="/opt/matrix/runtime/node/bin:/usr/bin:/bin" "$pi" --version >/dev/null 2>&1; then
      return 0; fi
    sleep 1
  done; return 1; }
zellij() { command_bounded 30 runuser -u matrix -- "${zellij_env[@]}" /opt/matrix/bin/zellij "$@"; }
fail_phase() {
  local exit_status="${1:-$?}" failure_code; trap - EXIT ERR TERM INT HUP
  if [ "$exit_status" -eq 124 ] || [ "$exit_status" -eq 137 ] || [ "$exit_status" -eq 143 ]; then failure_code=command_timeout
  elif [[ "$failure_hint" =~ ^[a-z0-9_]{1,64}$ ]]; then failure_code="$failure_hint"
  else
    failure_code="$(cat /run/matrix-update-runtime/last-failure-code 2>/dev/null || true)"; [[ "$failure_code" =~ ^[a-z0-9_]{1,64}$ ]] || failure_code=operation_failed
  fi
  write_state "failed_${current_phase}_${failure_code}"; rm -f -- /etc/systemd/system/matrix-gateway.service.d/zz-terminal-acceptance.conf
  systemctl_change daemon-reload >/dev/null 2>&1 || true; systemctl_change start matrix-gateway.service matrix-shell.service >/dev/null 2>&1 || true
  exit 1
}
phase1() {
  trap fail_phase ERR TERM INT HUP; trap 'status=$?; trap - EXIT; [ "$status" -eq 0 ] || fail_phase "$status"' EXIT
  install -d -o root -g root -m 0700 "$root_parent"
  find "$root_parent" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf -- {} +
  rm -rf -- "$state_root"
  install -d -o root -g root -m 0700 "$checks_root"
  write_state phase1-running
  local created runtime_id unit session_name agent_created agent_runtime_id agent_unit output_result last_output_bytes=0
  write_phase creating_runtime
  created="$(owner_probe create "$head_sha" "$run_nonce")"; runtime_id="$(printf '%s' "$created" | json_field runtimeId)"
  [[ "$runtime_id" =~ ^[0-9a-f]{32}$ ]]
  printf '%s\n' "$runtime_id" >"$state_root/runtime-id"; chmod 0600 "$state_root/runtime-id"
  unit="${unit_prefix}${runtime_id}.service"; session_name="matrix-t-${runtime_id}"
  write_phase waiting_runtime
  wait_active "$unit"; mark runtimeLive
  write_phase seeding_output
  output_result="$(zellij --session "$session_name" run --in-place --close-replaced-pane --name matrix-accept-output -- /bin/bash -lc 'counter=0; while true; do counter=$((counter + 1)); printf "MATRIX_ACCEPT_LOOP:%010d\n" "$counter"; read -r -t 1 _ || true; done')"; [ "${#output_result}" -le 64 ] && [[ "$output_result" =~ terminal_[0-9]{1,10} ]]
  write_phase starting_agent; wait_pi_ready
  agent_created="$(owner_probe create-agent "$head_sha" "$run_nonce")"
  agent_runtime_id="$(printf '%s' "$agent_created" | json_field runtimeId)"
  [[ "$agent_runtime_id" =~ ^[0-9a-f]{32}$ ]]
  printf '%s\n' "$agent_runtime_id" >"$state_root/agent-runtime-id"; chmod 0600 "$state_root/agent-runtime-id"
  agent_unit="${unit_prefix}${agent_runtime_id}.service"; wait_active "$agent_unit"
  write_phase waiting_roles; local baseline="" agent_baseline="" shell_pid="" output_pid="" output_candidates="" pane_pid="" agent_pid="" role_failure=roles_unavailable
  for _ in $(seq 1 120); do
    baseline="$(roles "$runtime_id" 2>/dev/null || true)"; agent_baseline="$(roles "$agent_runtime_id" 2>/dev/null || true)"
    shell_pid="$(printf '%s' "$baseline" | json_field shell 2>/dev/null || true)"; output_pid="$(printf '%s' "$baseline" | json_field output 2>/dev/null || true)"; output_candidates="$(printf '%s' "$baseline" | json_field outputCandidates 2>/dev/null || true)"
    pane_pid="$(printf '%s' "$agent_baseline" | json_field pane 2>/dev/null || true)"
    agent_pid="$(printf '%s' "$agent_baseline" | json_field agent 2>/dev/null || true)"
    if [[ "$shell_pid" =~ ^[1-9][0-9]*$ ]] && [[ "$output_pid" =~ ^[1-9][0-9]*$ ]] && [ "$output_candidates" = 1 ] && [[ "$pane_pid" =~ ^[1-9][0-9]*$ ]] &&
      [[ "$agent_pid" =~ ^[1-9][0-9]*$ ]] && output_advanced "$runtime_id"; then
      role_values "$baseline" >"$state_root/roles.json"; role_values "$agent_baseline" >"$state_root/agent-roles.json"
      chmod 0600 "$state_root/roles.json" "$state_root/agent-roles.json"
      role_failure=roles_unstable
      break
    fi
    if [[ ! "$shell_pid" =~ ^[1-9][0-9]*$ ]]; then role_failure=shell_unavailable; elif [[ ! "$output_pid" =~ ^[1-9][0-9]*$ ]] || [ "$output_candidates" != 1 ]; then role_failure=output_unavailable
    elif [[ ! "$pane_pid" =~ ^[1-9][0-9]*$ ]] || [[ ! "$agent_pid" =~ ^[1-9][0-9]*$ ]]; then role_failure=agent_unavailable
    else role_failure=output_unavailable; fi
    sleep 1
  done
  failure_hint="$role_failure"; runtime_continues "$runtime_id" "$agent_runtime_id"
  failure_hint=""
  mark continuousOutput; mark codingAgentPreserved
  write_phase runtime_created
  local runtime_cgroup; runtime_cgroup="$(systemctl_read show "$unit" -p ControlGroup --value)"
  local attach_one="/run/user/${uid}/matrix-terminal-accept-${head_sha}-1.json" attach_two="/run/user/${uid}/matrix-terminal-accept-${head_sha}-2.json"
  rm -f -- "$attach_one" "$attach_two"
  /usr/bin/setsid runuser -u matrix -- /opt/matrix/runtime/node/bin/node "$probe" attach "$runtime_id" "$head_sha" 1 &
  local attach_parent_one=$!
  /usr/bin/setsid runuser -u matrix -- /opt/matrix/runtime/node/bin/node "$probe" attach "$runtime_id" "$head_sha" 2 &
  local attach_parent_two=$!
  for _ in $(seq 1 30); do [ -f "$attach_one" ] && [ -f "$attach_two" ] && break; sleep 1; done
  local attach_cgroup_one attach_cgroup_two; attach_cgroup_one="$(cat "$attach_one" | json_field cgroup)"; attach_cgroup_two="$(cat "$attach_two" | json_field cgroup)"
  [ "$attach_cgroup_one" != "$runtime_cgroup" ]; [ "$attach_cgroup_two" != "$runtime_cgroup" ]
  runtime_continues "$runtime_id" "$agent_runtime_id"; mark twoDevicesOneRuntime
  stop_process_group "$attach_parent_one"; stop_process_group "$attach_parent_two"; rm -f -- "$attach_one" "$attach_two"
  runtime_continues "$runtime_id" "$agent_runtime_id"; mark detachPreservesRuntime
  local renamed; renamed="$(owner_probe rename "$runtime_id" "renamed-${head_sha:0:12}")"; [ "$(printf '%s' "$renamed" | json_field runtimeId)" = "$runtime_id" ]
  runtime_continues "$runtime_id" "$agent_runtime_id"; mark renamePreservesIdentity; local supervisor_pid; supervisor_pid="$(systemctl_read show matrix-terminal-runtime.service -p MainPID --value)"; printf '%s\n' "$supervisor_pid" >"$state_root/supervisor-pid"
  write_phase bundle_one
  request_update "$version_a"; wait_update "$version_a"; runtime_continues "$runtime_id" "$agent_runtime_id"; mark bundleOnePreservesRuntime
  write_phase bundle_two
  request_update "$version_b"; wait_update "$version_b"; runtime_continues "$runtime_id" "$agent_runtime_id"; mark bundleTwoPreservesRuntime
  [ "$(systemctl_read show matrix-terminal-runtime.service -p MainPID --value)" = "$supervisor_pid" ]
  mark supervisorPreserved
  install -d -o root -g root -m 0755 /etc/systemd/system/matrix-gateway.service.d
  cat >/etc/systemd/system/matrix-gateway.service.d/zz-terminal-acceptance.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/bin/false
EOF
  systemctl_change daemon-reload
  write_phase forced_failure
  request_update "$version_a"
  wait_failed_update
  rm -f -- /etc/systemd/system/matrix-gateway.service.d/zz-terminal-acceptance.conf
  systemctl_change daemon-reload
  systemctl_change start matrix-gateway.service matrix-shell.service
  [ "$(cat /opt/matrix/app/BUNDLE_VERSION)" = "$version_b" ]
  runtime_continues "$runtime_id" "$agent_runtime_id"; mark failedUpdatePreservesRuntime
  write_phase reapply_one
  request_update "$version_a"; wait_update "$version_a"
  write_phase rollback_two
  request_update rollback; wait_update "$version_b"
  runtime_continues "$runtime_id" "$agent_runtime_id"; mark explicitRollbackPreservesRuntime
  write_phase final_checks
  systemctl_change daemon-reload; runtime_continues "$runtime_id" "$agent_runtime_id"; mark daemonReloadPreservesRuntime
  if ! pgrep -a zellij | grep -F -- '--force-run-commands' >/dev/null; then
    mark forceRunAbsent
  fi
  if ! journalctl -u "$unit" -u "$agent_unit" --no-pager 2>/dev/null |
    grep -E 'MATRIX_ACCEPT_LOOP|accept-(agent-)?[0-9a-f]{7}|/home/matrix/home' >/dev/null; then
    mark journalPrivacy
  fi
  write_state phase1-ready
}
phase2() {
  current_phase=phase2
  trap fail_phase ERR TERM INT HUP; trap 'status=$?; trap - EXIT; [ "$status" -eq 0 ] || fail_phase "$status"' EXIT
  [ "$(cat "$state_file")" = reboot-scheduled ]
  write_state phase2-running
  local runtime_id unit agent_runtime_id agent_unit inspected agent_inspected recovered recovery_mode
  runtime_id="$(cat "$state_root/runtime-id")"
  [[ "$runtime_id" =~ ^[0-9a-f]{32}$ ]]
  unit="${unit_prefix}${runtime_id}.service"
  agent_runtime_id="$(cat "$state_root/agent-runtime-id")"
  [[ "$agent_runtime_id" =~ ^[0-9a-f]{32}$ ]]
  agent_unit="${unit_prefix}${agent_runtime_id}.service"
  wait_absent "$unit"; wait_absent "$agent_unit"
  if ! systemctl_read list-units "${unit_prefix}*.service" --state=active --no-legend |
    grep -q .; then mark rebootStartsNoRuntime; fi
  inspected="$(owner_probe inspect "$runtime_id")"; agent_inspected="$(owner_probe inspect "$agent_runtime_id")"
  case "$(printf '%s' "$inspected" | json_field lifecycleState):$(printf '%s' "$agent_inspected" | json_field lifecycleState)" in
    interrupted:interrupted|interrupted:recoverable|recoverable:interrupted|recoverable:recoverable) mark rebootShowsInterrupted ;;
    *) return 1 ;;
  esac
  recovered="$(owner_probe concurrent-recover "$runtime_id")"
  wait_active "$unit"
  [ "$(systemctl_read list-units "$unit" --state=active --no-legend | wc -l)" -eq 1 ]
  recovery_mode="$(printf '%s' "$recovered" |
    /opt/matrix/runtime/node/bin/node -e '
      let r="";process.stdin.on("data",d=>r+=d);process.stdin.on("end",()=>{
        const v=JSON.parse(r);const modes=v.map(x=>x.recoveryMode).filter(Boolean);
        process.stdout.write(modes.includes("serialized")?"serialized":"");
      });')"
  [ "$recovery_mode" = serialized ]
  mark explicitRecoverRestoresRuntime; mark concurrentRecoverSingleUnit
  wait_absent "$agent_unit"; mark recoveryDoesNotResumeAgent
  systemctl_change stop "$unit"
  wait_absent "$unit"
  local corrupt_target
  corrupt_target="$(find "$cache_root" -type f \
    -path "*/matrix-t-${runtime_id}/session-layout.kdl" -print -quit)"
  [ "$corrupt_target" = \
    "$cache_root/zellij/contract_version_1/session_info/matrix-t-${runtime_id}/session-layout.kdl" ]
  printf 'layout {\n  pane {\n' >"$corrupt_target"
  recovered="$(owner_probe recover "$runtime_id")"
  [ "$(printf '%s' "$recovered" | json_field recoveryMode)" = fresh-shell ]
  [ "$(printf '%s' "$recovered" | json_field recoveryReason)" = history_unavailable ]
  wait_active "$unit"; mark corruptionFallsBackFresh
  local race_created race_id race_unit
  race_created="$(owner_probe create-race "$head_sha" "$run_nonce")"
  race_id="$(printf '%s' "$race_created" | json_field runtimeId)"
  race_unit="${unit_prefix}${race_id}.service"
  wait_active "$race_unit"
  systemctl_change stop "$race_unit"
  wait_absent "$race_unit"
  owner_probe recover-delete "$race_id" >/dev/null || true
  owner_probe delete "$race_id" >/dev/null || true
  wait_absent "$race_unit"
  [ ! -e "$home/system/terminal-runtime/receipts/${race_id}.json" ]
  sleep 2
  wait_absent "$race_unit"; mark recoverDeleteCannotResurrect
  local control_group cgroup_path
  control_group="$(systemctl_read show "$unit" -p ControlGroup --value)"
  cgroup_path="/sys/fs/cgroup${control_group}"
  exec {events_fd}<"$cgroup_path/cgroup.events"
  owner_probe delete "$runtime_id" >/dev/null
  for _ in $(seq 1 60); do
    if [ ! -e "$cgroup_path/cgroup.events" ] ||
      grep -q '^populated 0$' "/proc/self/fd/${events_fd}"; then break; fi
    sleep 1
  done
  if [ ! -e "$cgroup_path/cgroup.events" ] ||
    grep -q '^populated 0$' "/proc/self/fd/${events_fd}"; then
    mark deleteWaitsForEmptyCgroup
  fi
  exec {events_fd}<&-
  [ ! -e "$home/system/terminal-runtime/receipts/${runtime_id}.json" ]
  if ! find "$cache_root" -type d -name "matrix-t-${runtime_id}" -print -quit |
    grep -q .; then mark deleteRemovesRecoveryState; fi
  owner_probe delete "$agent_runtime_id" >/dev/null
  wait_absent "$agent_unit"
  [ ! -e "$home/system/terminal-runtime/receipts/${agent_runtime_id}.json" ]
  write_state complete
  /opt/matrix/runtime/node/bin/node "$verifier" \
    --write-summary "$evidence_root" "$head_sha"
}
case "$operation" in
  launch)
    install -d -o root -g root -m 0700 "$root_parent"
    systemd-run --unit="matrix-terminal-production-${head_sha}-${run_nonce}-phase1" \
      --collect --no-block --property=Type=exec --property=KillMode=control-group \
      --property=RuntimeMaxSec=10800 \
      --property=TimeoutStopSec=45 \
      --property=StandardOutput=null --property=StandardError=null \
      -- "$0" phase1 "$head_sha" "$run_nonce" >/dev/null
    echo production_acceptance_started
    ;;
  status)
    [ -f "$state_file" ] || { echo unavailable; exit 3; }; cat "$state_file"
    ;;
  diagnose)
    diagnostic="$(owner_probe find-shell "$head_sha" "$run_nonce" 2>/dev/null || true)"
    runtime_id="$(printf '%s' "$diagnostic" | json_field runtimeId 2>/dev/null || true)"
    lifecycle="$(printf '%s' "$diagnostic" | json_field lifecycleState 2>/dev/null || true)"
    result=unavailable; main_code=unavailable; main_status=unavailable; keeper_code=unavailable
    if [[ "$runtime_id" =~ ^[0-9a-f]{32}$ ]]; then
      unit="${unit_prefix}${runtime_id}.service"
      show="$(systemctl_read show "$unit" -p Result -p ExecMainCode -p ExecMainStatus --value 2>/dev/null || true)"
      mapfile -t values <<<"$show"
      [[ "${values[0]:-}" =~ ^[a-z-]{1,32}$ ]] && result="${values[0]}"
      [[ "${values[1]:-}" =~ ^[a-z-]{1,32}$ ]] && main_code="${values[1]}"
      [[ "${values[2]:-}" =~ ^[0-9]{1,3}$ ]] && main_status="${values[2]}"
      keeper_code="$(journalctl -u "$unit" --since=-10min --no-pager --output=cat 2>/dev/null |
        grep -E '^terminal_keeper_[a-z0-9_]{1,96}$' | tail -n 1 || true)"
      [[ "$keeper_code" =~ ^terminal_keeper_[a-z0-9_]{1,96}$ ]] || keeper_code=unavailable
    fi
    [[ "$lifecycle" =~ ^[a-z_]{1,32}$ ]] || lifecycle=unavailable
    printf 'production_acceptance_diagnostic=%s,%s,%s,%s,%s\n' "$lifecycle" "$result" "$main_code" "$main_status" "$keeper_code"
    agent_result=unavailable; agent_main_code=unavailable; agent_main_status=unavailable; agent_keeper_code=unavailable; agent_pane_code=unavailable; agent_runtime_id=""; agent_active=unavailable; agent_populated=unavailable; agent_processes=unavailable
    if [ -f "$state_root/agent-runtime-id" ] &&
      [ ! -L "$state_root/agent-runtime-id" ] &&
      [ "$(stat -c %s "$state_root/agent-runtime-id" 2>/dev/null || true)" = 33 ]; then
      IFS= read -r agent_runtime_id <"$state_root/agent-runtime-id" || true
    fi
    if [[ ! "$agent_runtime_id" =~ ^[0-9a-f]{32}$ ]]; then agent_diagnostic="$(owner_probe find-agent "$head_sha" "$run_nonce" 2>/dev/null || true)"; agent_runtime_id="$(printf '%s' "$agent_diagnostic" | json_field runtimeId 2>/dev/null || true)"
    fi
    if [[ "$agent_runtime_id" =~ ^[0-9a-f]{32}$ ]]; then
      agent_unit="${unit_prefix}${agent_runtime_id}.service"; agent_active="$(systemctl_read is-active "$agent_unit" 2>/dev/null || true)"; [[ "$agent_active" =~ ^[a-z-]{1,32}$ ]] || agent_active=unavailable
      mapfile -t agent_values < <(systemctl_read show "$agent_unit" -p Result -p ExecMainCode -p ExecMainStatus --value 2>/dev/null || true)
      [[ "${agent_values[0]:-}" =~ ^[a-z-]{1,32}$ ]] && agent_result="${agent_values[0]}"
      [[ "${agent_values[1]:-}" =~ ^[a-z-]{1,32}$ ]] && agent_main_code="${agent_values[1]}"
      [[ "${agent_values[2]:-}" =~ ^[0-9]{1,3}$ ]] && agent_main_status="${agent_values[2]}"
      agent_journal="$(journalctl -u "$agent_unit" --since=-10min --no-pager --output=cat 2>/dev/null || true)"
      agent_keeper_code="$(printf '%s\n' "$agent_journal" | grep -E '^terminal_keeper_[a-z0-9_]{1,96}$' | tail -n 1 || true)"
      [[ "$agent_keeper_code" =~ ^terminal_keeper_[a-z0-9_]{1,96}$ ]] || agent_keeper_code=unavailable
      agent_pane_code="$(printf '%s\n' "$agent_journal" | grep -E '^terminal_pane_agent_exit_[0-9]{1,3}$' | tail -n 1 || true)"
      [[ "$agent_pane_code" =~ ^terminal_pane_agent_exit_[0-9]{1,3}$ ]] || agent_pane_code=unavailable; agent_control_group="$(systemctl_read show "$agent_unit" -p ControlGroup --value 2>/dev/null || true)"; agent_cgroup="/sys/fs/cgroup${agent_control_group}"
      if [ "$agent_control_group" = "/matrix.slice/matrix-terminal.slice/${agent_unit}" ] && [ -f "$agent_cgroup/cgroup.events" ] && [ ! -L "$agent_cgroup/cgroup.events" ] && [ -f "$agent_cgroup/cgroup.procs" ] && [ ! -L "$agent_cgroup/cgroup.procs" ]; then
        agent_populated="$(awk '$1 == "populated" { print $2 }' "$agent_cgroup/cgroup.events")"; agent_processes="$(wc -w <"$agent_cgroup/cgroup.procs")"; [[ "$agent_populated" =~ ^[01]$ ]] || agent_populated=unavailable; [[ "$agent_processes" =~ ^([0-9]|[1-9][0-9]{1,2})$ ]] || agent_processes=unavailable; fi
    fi
    printf 'production_acceptance_agent_diagnostic=%s,%s,%s,%s,%s\n' "$agent_result" "$agent_main_code" "$agent_main_status" "$agent_keeper_code" "$agent_pane_code"
    agent_roles_status=0; agent_roles="$(roles "$agent_runtime_id" 2>/dev/null)" || agent_roles_status=$?; agent_roles_bytes=${#agent_roles}; agent_role_values="$(role_values "$agent_roles")"; agent_roles_error="$(printf '%s' "$agent_roles" | json_field error 2>/dev/null || true)"
    if [ "$agent_role_values" != unavailable ]; then agent_roles_error=none; elif [[ ! "$agent_roles_error" =~ ^probe_roles_((systemd|cgroup|proc|classify)_(eacces|eperm|enoent|esrch|enotdir|etimedout|invalid|unknown)|global_unknown)$ ]]; then agent_roles_error=unavailable; fi; agent_roles=unavailable
    shell_roles="$(roles "$runtime_id" 2>/dev/null || true)"; shell_role_values="$(role_values "$shell_roles")"
    [[ "$agent_roles_status" =~ ^([0-9]|[1-9][0-9]{1,2})$ ]] || agent_roles_status=unavailable; [[ "$agent_roles_bytes" =~ ^([0-9]|[1-9][0-9]{1,5})$ ]] || agent_roles_bytes=unavailable; printf 'production_acceptance_agent_roles=%s\n' "$agent_roles"; printf 'production_acceptance_agent_role_values=%s\n' "$agent_role_values"; printf 'production_acceptance_agent_roles_error=%s\n' "$agent_roles_error"; printf 'production_acceptance_agent_roles_command=%s,%s\n' "$agent_roles_status" "$agent_roles_bytes"; printf 'production_acceptance_shell_role_values=%s\n' "$shell_role_values"; printf 'production_acceptance_agent_cgroup=%s,%s,%s\n' "$agent_active" "$agent_populated" "$agent_processes"
    ;;
  reboot)
    [ "$(cat "$state_file")" = phase1-ready ]
    write_state reboot-scheduled
    systemd-run --unit="matrix-terminal-production-${head_sha}-${run_nonce}-reboot" \
      --collect --on-active=5 -- /usr/bin/systemctl reboot >/dev/null
    echo production_acceptance_reboot_scheduled
    ;;
  resume)
    [ "$(cat "$state_file")" = reboot-scheduled ]
    systemd-run --unit="matrix-terminal-production-${head_sha}-${run_nonce}-phase2" \
      --collect --no-block --property=Type=exec --property=KillMode=control-group \
      --property=RuntimeMaxSec=600 \
      --property=TimeoutStopSec=45 \
      --property=StandardOutput=null --property=StandardError=null \
      -- "$0" phase2 "$head_sha" "$run_nonce" >/dev/null
    echo production_acceptance_resumed
    ;;
  pack)
    [ "$(cat "$state_file")" = complete ]
    payload="$(/opt/matrix/runtime/node/bin/node "$verifier" \
      --pack "$evidence_root" "$head_sha")"
    rm -rf -- "$state_root"
    printf '%s' "$payload" | base64 --wrap=0
    ;;
  cancel)
    write_state failed_cancelled_operation_failed
    systemctl_cancel stop \
      "matrix-terminal-production-${head_sha}-${run_nonce}-phase1.service" \
      "matrix-terminal-production-${head_sha}-${run_nonce}-phase2.service" \
      >/dev/null 2>&1 || true
    echo production_acceptance_cancelled
    ;;
  phase1) phase1 ;;
  phase2) phase2 ;;
esac

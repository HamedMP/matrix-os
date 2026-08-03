#!/usr/bin/env bash
set -uo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "spike_requires_root" >&2
  exit 2
fi
pr_head_sha="${1:-}"
if ! printf '%s' "$pr_head_sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "spike_invalid_sha" >&2
  exit 2
fi
run_nonce="${2:-}"
if [[ ! "$run_nonce" =~ ^([1-9][0-9]{0,19})-([1-9][0-9]{0,5})$ ]]; then
  echo "spike_invalid_nonce" >&2
  exit 2
fi
printf -v run_id_padded '%020s' "${BASH_REMATCH[1]}"
printf -v run_attempt_padded '%06s' "${BASH_REMATCH[2]}"
run_id_padded="${run_id_padded// /0}"
run_attempt_padded="${run_attempt_padded// /0}"
source_dir="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
run_key="$pr_head_sha"
run_namespace="${pr_head_sha:0:5}${run_id_padded}${run_attempt_padded}"
evidence_root="/tmp/matrix-terminal-spike-evidence-${run_key}-${run_nonce}"
runtime_root="/run/matrix-terminal-runtime-spikes/$run_namespace"
support_root="$source_dir"
zellij_delete_ops_root="/tmp/matrix-terminal-spike-zellij-delete-${run_key}-${run_nonce}"
owner_home="/home/matrix/home"
state_root="$owner_home/system/terminal-runtime-spikes/$run_namespace"
cache_root="$state_root/cache"
config_root="$state_root/config"
config_home_root="$state_root/config-home"
data_root="$state_root/data"
unit_prefix="matrix-terminal-spike@"
base_id="1${run_namespace}"
keeper_id="2${run_namespace}"
server_id="3${run_namespace}"
memory_ids=("4${run_namespace}" "5${run_namespace}" "6${run_namespace}")
recovery_id="7${run_namespace}"
memory_restore_slice_path=""
memory_restore_slice_high=""
memory_restore_unit_paths=()
memory_restore_unit_highs=()
restore_memory_high() {
  local restore_index restore_path restore_value
  for restore_index in "${!memory_restore_unit_paths[@]}"; do
    restore_path="${memory_restore_unit_paths[$restore_index]}"
    restore_value="${memory_restore_unit_highs[$restore_index]:-}"
    if [[ "$restore_path" =~ ^/sys/fs/cgroup/[-A-Za-z0-9_.@/]+/memory\.high$ ]] &&
      [[ "$restore_value" =~ ^([0-9]+|max)$ ]] &&
      [ -e "$restore_path" ]; then
      printf '%s\n' "$restore_value" >"$restore_path" 2>/dev/null || true
    fi
  done
  if [[ "$memory_restore_slice_path" =~ ^/sys/fs/cgroup/[-A-Za-z0-9_.@/]+/memory\.high$ ]] &&
    [[ "$memory_restore_slice_high" =~ ^([0-9]+|max)$ ]] &&
    [ -e "$memory_restore_slice_path" ]; then
    printf '%s\n' "$memory_restore_slice_high" >"$memory_restore_slice_path" 2>/dev/null || true
  fi
  memory_restore_slice_path=""
  memory_restore_slice_high=""
  memory_restore_unit_paths=()
  memory_restore_unit_highs=()
}
cleanup() {
  local runtime_ids=("$base_id" "$keeper_id" "$server_id" "${memory_ids[@]}" "$recovery_id")
  local cleanup_stages=(cleanup_session_0 cleanup_session_1 cleanup_session_2 cleanup_session_3 cleanup_session_4 cleanup_session_5 cleanup_session_6)
  local units=() cleanup_index runtime_id session_inventory
  for runtime_id in "${runtime_ids[@]}"; do units+=("${unit_prefix}${runtime_id}.service"); done
  restore_memory_high
  write_progress cleanup_units
  systemctl_bounded stop "${units[@]}" >/dev/null 2>&1 || true
  write_progress cleanup_sessions
  session_inventory="$(zellij_list_bounded 2>/dev/null || true)"
  for cleanup_index in "${!runtime_ids[@]}"; do
    write_progress "${cleanup_stages[$cleanup_index]}"
    if printf '%s\n' "$session_inventory" |
      awk '{print $1}' |
      grep -Fxq "matrix-t-${runtime_ids[$cleanup_index]}"; then
      zellij_delete_bounded "${runtime_ids[$cleanup_index]}" >/dev/null 2>&1 || true
    fi
  done
  write_progress cleanup_attach
  /usr/bin/timeout --signal=TERM --kill-after=1s 5s pkill -f 'zellij attach matrix-t-[0-9a-f]{32}' >/dev/null 2>&1 || true
}
build_summary() {
  /opt/matrix/runtime/node/bin/node "$source_dir/build-evidence.mjs" "$evidence_root" "$pr_head_sha" || true
}
write_progress() {
  local progress_stage="$1"
  local progress_tmp="$evidence_root/.progress-stage.$$"
  case "$progress_stage" in
    startup_cleanup|runtime_setup|runtime_dirs|unit_check|binary_check|binary_version|binary_manifest|binary_digest|binary_metadata|config_dump|config_check|cleanup_units|cleanup_sessions|cleanup_session_[0-6]|cleanup_attach|base_start|base_start_requested|base_release|base_wait_ready|keeper_loss|server_loss|memory_pressure|recovery_restore|corruption_fallback|summary_build) ;;
    *) return 2 ;;
  esac
  printf '%s\n' "$progress_stage" >"$progress_tmp"
  chmod 0600 "$progress_tmp"
  mv -f -- "$progress_tmp" "$evidence_root/progress-stage.txt"
}
systemctl_bounded() {
  command_bounded 35 /usr/bin/systemctl "$@"
}
systemctl_value_bounded() {
  local unit="$1" property="$2"
  command_bounded 5 /usr/bin/systemctl show "$unit" -p "$property" --value
}
terminate_detached_client() {
  local client_pid="$1"
  kill -TERM -- "-$client_pid" 2>/dev/null || true
  sleep 0.2
  kill -KILL -- "-$client_pid" 2>/dev/null || true
}
zellij_client_bounded() {
  local timeout_seconds="$1" operation="$2"
  local operation_dir output_path client_pid_path status
  operation_dir="$(mktemp -d "$zellij_delete_ops_root/op.XXXXXX")" || return 127
  output_path="$operation_dir/result"
  client_pid_path="$operation_dir/client.pid"
  /usr/bin/timeout --signal=TERM --kill-after=1s "$((timeout_seconds + 10))s" \
    /opt/matrix/runtime/node/bin/node \
    "$source_dir/zellij-delete-client.mjs" \
    --request "$timeout_seconds" \
    "$client_pid_path" \
    "$output_path" \
    "$operation"
  status=$?
  setup_fs_bounded 5 /usr/bin/rm -rf -- "$operation_dir" || return 127
  return "$status"
}
zellij_delete_bounded() {
  zellij_client_bounded 15 "$1" >/dev/null
}
zellij_list_bounded() {
  zellij_client_bounded 5 --list
}
zellij_setup_bounded() {
  command_bounded 15 runuser -u matrix -- env \
    HOME="$owner_home" XDG_CACHE_HOME="$cache_root" ZELLIJ_CONFIG_DIR="$config_root" \
    /opt/matrix/bin/zellij "$@"
}
setup_fs_bounded() {
  command_bounded "$@" >/dev/null 2>&1
}
command_bounded() {
  local timeout_seconds="$1"
  local operation_pid deadline_pid completed_pid completed_status
  shift
  [[ "$timeout_seconds" =~ ^[1-9][0-9]?$ ]] || return 2
  /usr/bin/setsid /usr/bin/timeout --signal=TERM --kill-after=1s "$timeout_seconds" \
    "$@" </dev/null &
  operation_pid=$!
  /usr/bin/sleep "$((timeout_seconds + 5))" &
  deadline_pid=$!
  completed_pid=""
  wait -n -p completed_pid "$operation_pid" "$deadline_pid"
  completed_status=$?
  if [ "$completed_pid" = "$operation_pid" ]; then
    kill "$deadline_pid" 2>/dev/null || true
    wait "$deadline_pid" 2>/dev/null || true
    return "$completed_status"
  fi
  kill -TERM -- "-$operation_pid" 2>/dev/null || true
  sleep 0.2
  kill -KILL -- "-$operation_pid" 2>/dev/null || true
  wait "$operation_pid" 2>/dev/null || true
  return 124
}
zellij_delete_if_present() {
  local runtime_id="$1" session_inventory
  session_inventory="$(zellij_list_bounded 2>/dev/null || true)"
  if printf '%s\n' "$session_inventory" |
    awk '{print $1}' |
    grep -Fxq "matrix-t-${runtime_id}"; then
    zellij_delete_bounded "$runtime_id"
  fi
}
request_runtime_start() {
  local unit="$1" state
  local deadline=$((SECONDS + 10))
  systemctl_bounded start --no-block "$unit" >/dev/null 2>&1 || true
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(systemctl_value_bounded "$unit" ActiveState 2>/dev/null || true)"
    case "$state" in
      active|activating)
        return 0
        ;;
      failed)
        break
        ;;
    esac
    sleep 0.1
  done
  return 1
}
rm -rf -- "$zellij_delete_ops_root"
install -d -o root -g root -m 0700 "$zellij_delete_ops_root"
rm -rf -- "$evidence_root"
install -d -o root -g root -m 0700 "$evidence_root"
write_progress startup_cleanup
trap 'status=$?; build_summary; cleanup; exit $status' EXIT
rm -rf -- "$evidence_root"
install -d -o root -g root -m 0700 "$evidence_root" "$evidence_root/s1" "$evidence_root/s1/checks" "$evidence_root/s2" "$evidence_root/s2/checks"
write_progress runtime_setup
if [[ -e "$runtime_root" || -L "$runtime_root" || -e "$state_root" || -L "$state_root" ]]; then
  echo "spike_attempt_state_exists" >&2
  exit 3
fi
write_progress runtime_dirs
if ! setup_fs_bounded 15 /usr/bin/install -d -o matrix -g matrix -m 0700 "$runtime_root" "$runtime_root/descriptors" "$runtime_root/readiness" "$runtime_root/outcomes" "$runtime_root/startup-failures" "$runtime_root/confirmations" "$runtime_root/pane-release" ||
  ! setup_fs_bounded 15 /usr/bin/install -d -o matrix -g matrix -m 0700 "$owner_home/system/terminal-runtime-spikes" "$state_root" "$cache_root" "$config_root" "$config_home_root" "$data_root" ||
  ! setup_fs_bounded 15 /usr/bin/install -d -o matrix -g matrix -m 0700 "/run/user/$(id -u matrix)"; then
  echo "spike_runtime_dirs_failed" >&2
  exit 3
fi
write_progress unit_check
if ! systemctl_bounded cat matrix-terminal-spike.slice matrix-terminal-spike@.service >/dev/null; then echo "spike_units_unavailable" >&2; exit 3; fi
if ! systemctl_bounded start matrix-terminal-spike.slice >/dev/null 2>&1; then
  echo "spike_slice_start_failed" >&2
  exit 3
fi
slice_state="$(systemctl_value_bounded matrix-terminal-spike.slice ActiveState 2>/dev/null || true)"
if [ "$slice_state" != active ]; then
  echo "spike_slice_not_active" >&2
  exit 3
fi
write_progress binary_check
write_progress binary_version
zellij_version="$(command_bounded 15 /opt/matrix/bin/zellij --version 2>/dev/null || true)"
if [ "$zellij_version" != "zellij 0.44.3" ]; then
  echo "spike_wrong_zellij" >&2
  exit 3
fi
zellij_build_metadata="/opt/matrix/bin/zellij.build.json"
candidate_build_record="$source_dir/v0.44.3-matrix.1.build.json"
expected_digest_file="$evidence_root/s2/expected-digest.txt"
write_progress binary_manifest
if ! command_bounded 5 /usr/bin/sed \
  -nE 's/^[[:space:]]*"binarySha256":[[:space:]]*"([0-9a-f]{64})"[[:space:]]*$/\1/p' \
  "$candidate_build_record" >"$expected_digest_file"; then
  echo "spike_invalid_zellij_manifest" >&2; exit 3
fi
exec 9<"$expected_digest_file"
IFS= read -r expected_zellij_binary_sha256 <&9 || expected_zellij_binary_sha256=""
if IFS= read -r unexpected_digest <&9 ||
  ! [[ "$expected_zellij_binary_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  exec 9<&-
  echo "spike_invalid_zellij_manifest" >&2
  exit 3
fi
exec 9<&-
actual_digest_file="$evidence_root/s2/actual-digest.txt"
write_progress binary_digest
if ! command_bounded 5 /usr/bin/sha256sum /opt/matrix/bin/zellij \
  >"$actual_digest_file"; then
  echo "spike_zellij_digest_failed" >&2
  exit 3
fi
IFS=' ' read -r zellij_binary_sha256 digest_path digest_extra <"$actual_digest_file" ||
  zellij_binary_sha256=""
printf 'expected=%s\nactual=%s\n' "$expected_zellij_binary_sha256" "$zellij_binary_sha256" >"$evidence_root/s2/binary-digest.txt"
if [ "$zellij_binary_sha256" != "$expected_zellij_binary_sha256" ] ||
  [ "$digest_path" != "/opt/matrix/bin/zellij" ] || [ -n "${digest_extra:-}" ]; then
  echo "spike_wrong_zellij_binary" >&2
  exit 3
fi
write_progress binary_metadata
if ! command_bounded 5 /usr/bin/cmp --silent \
  "$zellij_build_metadata" "$candidate_build_record"; then
  echo "spike_wrong_zellij_build" >&2
  exit 3
fi
install -m 0600 "$zellij_build_metadata" "$evidence_root/s2/zellij-build.json"
default_config_tmp="/tmp/matrix-terminal-default-config-${run_key}.kdl"
write_progress config_dump
zellij_setup_bounded setup --dump-config >"$default_config_tmp"
viewport_option=""
if grep -Eq '^[[:space:]]*(//[[:space:]]*)?serialize_pane_viewport[[:space:]]' "$default_config_tmp"; then
  viewport_option="serialize_pane_viewport"
elif grep -Eq '^[[:space:]]*(//[[:space:]]*)?pane_viewport_serialization[[:space:]]' "$default_config_tmp"; then
  viewport_option="pane_viewport_serialization"
fi
if [ -n "$viewport_option" ]; then
  printf '%s\n' "$viewport_option" >"$evidence_root/s2/viewport-option.txt"
fi
grep -E '^[[:space:]]*(//[[:space:]]*)?(session_serialization|serialize_pane_viewport|pane_viewport_serialization|scrollback_lines_to_serialize|serialization_interval)[[:space:]]' "$default_config_tmp" >"$evidence_root/s2/default-options.txt" || true
rm -f -- "$default_config_tmp"
cat >"$config_root/config.kdl" <<EOF
session_serialization true
${viewport_option:-serialize_pane_viewport} true
scrollback_lines_to_serialize 10000
serialization_interval 5
pane_frames false
default_shell "/bin/bash"
EOF
chown matrix:matrix "$config_root/config.kdl"
chmod 0600 "$config_root/config.kdl"
write_progress config_check
if [ -n "$viewport_option" ] && zellij_setup_bounded setup --check >/dev/null 2>&1; then
  printf 'pass\n' >"$evidence_root/s2/checks/exactOptionSyntax.pass"
fi
mark_pass() {
  printf 'pass\n' >"$evidence_root/$1/checks/$2.pass"
  echo "$1:$2=pass"
}
descriptor() {
  runtime_id="$1"
  intent="$2"
  descriptor_tmp="/tmp/matrix-terminal-descriptor-${runtime_id}"
  printf '{"runtimeId":"%s","cwd":"/home/matrix/home","intent":"%s"}\n' "$runtime_id" "$intent" >"$descriptor_tmp"
  install -o matrix -g matrix -m 0600 "$descriptor_tmp" "$runtime_root/descriptors/${runtime_id}.json"
  rm -f -- "$descriptor_tmp"
}
start_runtime() {
  runtime_id="$1"
  intent="${2:-create}"
  session_name="matrix-t-${runtime_id}"
  rm -f -- "$runtime_root/readiness/${runtime_id}.json" "$runtime_root/outcomes/${runtime_id}.json" "$runtime_root/startup-failures/${runtime_id}.json" "$runtime_root/confirmations/${runtime_id}.pass" "$runtime_root/confirmations/${runtime_id}.gated" "$runtime_root/pane-release/${session_name}"
  descriptor "$runtime_id" "$intent"
  request_runtime_start "${unit_prefix}${runtime_id}.service"
}
release_pane() {
  setup_fs_bounded 5 /usr/bin/install -o root -g root -m 0644 /dev/null \
    "$runtime_root/pane-release/matrix-t-$1"
}
wait_state() {
  unit="$1"
  desired="$2"
  limit="${3:-300}"
  runtime_id="${unit#${unit_prefix}}"
  runtime_id="${runtime_id%.service}"
  readiness_path="$runtime_root/readiness/${runtime_id}.json"
  deadline=$((SECONDS + (limit + 9) / 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$desired" = active ] && [ -f "$readiness_path" ]; then return 0; fi
    if [ -f "$runtime_root/startup-failures/${runtime_id}.json" ]; then return 1; fi
    sleep 0.1
  done
  return 1
}
wait_not_active() {
  unit="$1"
  runtime_id="${unit#${unit_prefix}}"
  runtime_id="${runtime_id%.service}"
  deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$runtime_root/outcomes/${runtime_id}.json" ] ||
      [ -f "$runtime_root/startup-failures/${runtime_id}.json" ]; then return 0; fi
    sleep 0.1
  done
  return 1
}
wait_file() {
  for _ in $(seq 1 300); do [ -f "$1" ] && return 0; sleep 0.1; done
  return 1
}
bounded_wait_child() {
  child="$1"
  if /usr/bin/timeout 10s tail --pid="$child" -f /dev/null; then wait "$child" 2>/dev/null || true; return; fi
  kill -TERM "$child" 2>/dev/null || true
  if /usr/bin/timeout 5s tail --pid="$child" -f /dev/null; then wait "$child" 2>/dev/null || true; return; fi
  kill -KILL "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
}
roles_alive() {
  readiness_path="$runtime_root/readiness/$1.json"; readiness=""; readiness_regex="^\\{\"runtimeId\":\"$1\",\"sessionName\":\"matrix-t-$1\",\"cgroup\":\"/[-A-Za-z0-9_.@/]+\",\"roles\":\\{\"keeper\":([1-9][0-9]*),\"zellij\":\\[([1-9][0-9]*(,[1-9][0-9]*)+)\\],\"shell\":([0-9]+),\"agent\":([0-9]+)\\}\\}$"; IFS= read -r readiness <"$readiness_path" || return 1
  [[ "$readiness" =~ $readiness_regex ]] || return 1; pids=("${BASH_REMATCH[1]}" "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}"); IFS=, read -r -a zellij_pids <<<"${BASH_REMATCH[2]}"
  for pid in "${pids[@]}" "${zellij_pids[@]}"; do [ "$pid" -eq 0 ] || [ -d "/proc/$pid" ] || return 1; done
}
record_pid_cgroup() {
  label="$1"
  pid="$2"
  output="$3"
  if ! printf '%s' "$pid" | grep -Eq '^[1-9][0-9]*$'; then return 1; fi
  membership="$(sed -n 's/^0:://p' "/proc/${pid}/cgroup" 2>/dev/null || true)"
  if [ -z "$membership" ]; then return 1; fi
  printf '%s\t%s\t%s\n' "$label" "$pid" "$membership" >>"$output"
}
wait_main_pid_changed() {
  unit="$1"
  previous="$2"
  for _ in $(seq 1 600); do
    current="$(systemctl_value_bounded "$unit" MainPID 2>/dev/null || true)"
    if printf '%s' "$current" | grep -Eq '^[1-9][0-9]*$' &&
      [ "$current" != "$previous" ] && { [ "$unit" != matrix-gateway.service ] ||
      curl --fail --silent --max-time 1 http://127.0.0.1:4000/health >/dev/null; }; then
      printf '%s' "$current"
      return 0
    fi
    sleep 0.1
  done
  return 1
}
runtime_cgroup() {
  /opt/matrix/runtime/node/bin/node -e '
    const fs = require("fs");
    process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).cgroup);
  ' "$runtime_root/readiness/$1.json"
}
zellij_env=(env HOME="$owner_home" MATRIX_HOME="$owner_home" PATH="/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin" LANG=C.UTF-8 TERM=xterm-256color XDG_CACHE_HOME="$cache_root" XDG_CONFIG_HOME="$config_home_root" XDG_DATA_HOME="$data_root" XDG_RUNTIME_DIR="/run/user/$(id -u matrix)" ZELLIJ_CONFIG_DIR="$config_root" ZELLIJ_CONFIG_FILE="$config_root/config.kdl")
zellij_cmd() {
  /usr/bin/timeout 15s runuser -u matrix -- "${zellij_env[@]}" /opt/matrix/bin/zellij "$@"
}
wait_cgroup_empty() {
  events_fd="$1"
  cgroup_path="$2"
  for _ in $(seq 1 300); do
    if grep -Eq '^populated 0$' "/proc/self/fd/${events_fd}" 2>/dev/null; then return 0; fi
    if [ ! -e "$cgroup_path/cgroup.events" ]; then return 0; fi
    sleep 0.1
  done
  return 1
}
# S1: readiness and stable ownership.
write_progress base_start
start_runtime "$base_id"
write_progress base_start_requested
base_unit="${unit_prefix}${base_id}.service"
sleep 0.3
if [ ! -e "$runtime_root/readiness/${base_id}.json" ]; then
  mark_pass s1 readinessGated
fi
write_progress base_release
if ! release_pane "$base_id"; then
  echo "spike_pane_release_failed" >&2
  exit 10
fi
write_progress base_wait_ready
if ! wait_state "$base_unit" active; then
  wait_not_active "$base_unit" || true
  systemctl_bounded show "$base_unit" -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus >"$evidence_root/s1/base-startup-unit.txt" || true
  if [ -f "$runtime_root/startup-failures/${base_id}.json" ]; then
    cp "$runtime_root/startup-failures/${base_id}.json" "$evidence_root/s1/base-startup-failure.json"
  fi
  exit 10
fi
cp "$runtime_root/readiness/${base_id}.json" "$evidence_root/s1/base-readiness.json"
systemctl_bounded show "$base_unit" -p MainPID -p ControlGroup -p ActiveState -p SubState -p MemoryHigh -p TasksMax >"$evidence_root/s1/base-unit.txt"
pid_cgroups="$evidence_root/s1/pid-cgroups.tsv"
: >"$pid_cgroups"
main_pid="$(systemctl_value_bounded "$base_unit" MainPID)"
readiness_main="$(/opt/matrix/runtime/node/bin/node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).roles.keeper))' "$runtime_root/readiness/${base_id}.json")"
if [ "$main_pid" = "$readiness_main" ] && kill -0 "$main_pid" 2>/dev/null; then mark_pass s1 keeperMainPid; fi
base_cgroup="$(runtime_cgroup "$base_id")"
record_pid_cgroup runtime-main-before "$main_pid" "$pid_cgroups" || true
/opt/matrix/runtime/node/bin/node -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const entries=[...value.roles.zellij.map((pid,index)=>[`zellij-${index}`,pid]),["shell",value.roles.shell],["agent",value.roles.agent]];
  for(const [label,pid] of entries){
    const membership=fs.readFileSync(`/proc/${pid}/cgroup`,"utf8").split(/\r?\n/).find((line)=>line.startsWith("0::"));
    if(!membership) process.exit(1);
    process.stdout.write(`${label}-before\t${pid}\t${membership.slice(3)}\n`);
  }
' "$runtime_root/readiness/${base_id}.json" >>"$pid_cgroups"
if roles_alive "$base_id"; then
  all_in_group=true
  while read -r pid; do
    [ -n "$pid" ] || continue
    if ! grep -Fqx "0::${base_cgroup}" "/proc/${pid}/cgroup" 2>/dev/null; then all_in_group=false; fi
  done <"/sys/fs/cgroup${base_cgroup}/cgroup.procs"
  if [ "$all_in_group" = true ]; then mark_pass s1 runtimeCgroupMembers; fi
else
  /opt/matrix/runtime/node/bin/node "$support_root/record-runtime-roles.mjs" "$base_id" initial || true
fi
gateway_before_pid="$(systemctl_value_bounded matrix-gateway.service MainPID 2>/dev/null || true)"
gateway_before_cgroup="$(sed -n 's/^0:://p' "/proc/${gateway_before_pid}/cgroup" 2>/dev/null || true)"
if [ -n "$gateway_before_cgroup" ] && [ "$gateway_before_cgroup" != "$base_cgroup" ]; then
  record_pid_cgroup gateway-before "$gateway_before_pid" "$pid_cgroups" || true
  mark_pass s1 gatewayOutsideCgroup
fi
attach_receipt="$runtime_root/attach-${base_id}.json"
rm -f -- "$attach_receipt"
runuser -u matrix -- "${zellij_env[@]}" /opt/matrix/runtime/node/bin/node "$support_root/attach-probe.mjs" "$base_id" &
attach_parent=$!
for _ in $(seq 1 100); do
  [ -f "$attach_receipt" ] && break
  sleep 0.1
done
attach_pid="$(/opt/matrix/runtime/node/bin/node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).client))' "$attach_receipt")"
attach_helper="$(/opt/matrix/runtime/node/bin/node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).helper))' "$attach_receipt")"
membership="$(/opt/matrix/runtime/node/bin/node -e '
  const fs=require("fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(typeof value.clientCgroup!=="string" || value.clientCgroup.length>512 || !/^\/[A-Za-z0-9_.@\/-]+$/.test(value.clientCgroup)) process.exit(1);
  process.stdout.write(value.clientCgroup);
' "$attach_receipt" 2>/dev/null || true)"
if [ -n "$membership" ] && [ "$membership" != "$base_cgroup" ]; then
  printf 'attach-client\t%s\t%s\n' "$attach_pid" "$membership" >>"$pid_cgroups"
  mark_pass s1 attachOutsideCgroup
fi
kill "$attach_helper" 2>/dev/null || true
bounded_wait_child "$attach_parent"
sleep 0.5
if roles_alive "$base_id"; then mark_pass s1 detachPreservesPids; else
  /opt/matrix/runtime/node/bin/node "$support_root/record-runtime-roles.mjs" "$base_id" detach || true
fi
if systemctl_bounded restart matrix-gateway.service >/dev/null 2>&1; then
  gateway_restart_pid="$(wait_main_pid_changed matrix-gateway.service "$gateway_before_pid" || true)"
  if [ -n "$gateway_restart_pid" ] && roles_alive "$base_id"; then
    record_pid_cgroup gateway-after-restart "$gateway_restart_pid" "$pid_cgroups" || true
    mark_pass s1 gatewayRestartPreservesPids
  fi
fi
gateway_pid="$(systemctl_value_bounded matrix-gateway.service MainPID 2>/dev/null || true)"
if printf '%s' "$gateway_pid" | grep -Eq '^[1-9][0-9]*$'; then
  kill -KILL "$gateway_pid" 2>/dev/null || true
  gateway_crash_pid="$(wait_main_pid_changed matrix-gateway.service "$gateway_pid" || true)"
  if [ -n "$gateway_crash_pid" ] && roles_alive "$base_id"; then
    record_pid_cgroup gateway-after-crash "$gateway_crash_pid" "$pid_cgroups" || true
    mark_pass s1 gatewayCrashPreservesPids
  fi
fi
shell_before_pid="$(systemctl_value_bounded matrix-shell.service MainPID 2>/dev/null || true)"
record_pid_cgroup shell-service-before "$shell_before_pid" "$pid_cgroups" || true
if systemctl_bounded restart matrix-shell.service >/dev/null 2>&1; then
  shell_after_pid="$(wait_main_pid_changed matrix-shell.service "$shell_before_pid" || true)"
  if [ -n "$shell_after_pid" ] && roles_alive "$base_id"; then
    record_pid_cgroup shell-service-after "$shell_after_pid" "$pid_cgroups" || true
    mark_pass s1 shellRestartPreservesPids
  fi
fi
record_pid_cgroup runtime-main-after-events "$main_pid" "$pid_cgroups" || true
if [ -f "$runtime_root/role-diagnostic-${base_id}.json" ]; then
  cp "$runtime_root/role-diagnostic-${base_id}.json" "$evidence_root/s1/base-runtime-roles.json"
fi
exec {base_events_fd}<"/sys/fs/cgroup${base_cgroup}/cgroup.events"
systemctl_bounded stop --no-block "$base_unit" >/dev/null 2>&1 || true
if wait_cgroup_empty "$base_events_fd" "/sys/fs/cgroup${base_cgroup}" "$base_unit"; then
  if [ -e "/sys/fs/cgroup${base_cgroup}/cgroup.events" ]; then cat "/proc/self/fd/${base_events_fd}" >"$evidence_root/s1/stopped-cgroup.events"; else printf 'cgroup_removed\n' >"$evidence_root/s1/stopped-cgroup.events"; fi
  mark_pass s1 stopEmptiesCgroup
fi
exec {base_events_fd}<&-
# S1: deterministic keeper and server failures.
write_progress keeper_loss
start_runtime "$keeper_id"
release_pane "$keeper_id"
keeper_unit="${unit_prefix}${keeper_id}.service"
if wait_state "$keeper_unit" active; then
  keeper_cgroup="$(runtime_cgroup "$keeper_id")"
  exec {keeper_events_fd}<"/sys/fs/cgroup${keeper_cgroup}/cgroup.events"
  kill -KILL "$(systemctl_value_bounded "$keeper_unit" MainPID)" 2>/dev/null || true
  if wait_not_active "$keeper_unit" && wait_file "$runtime_root/outcomes/${keeper_id}.json" && wait_cgroup_empty "$keeper_events_fd" "/sys/fs/cgroup${keeper_cgroup}" "$keeper_unit"; then
    mark_pass s1 keeperLossDeterministic
    cp "$runtime_root/outcomes/${keeper_id}.json" "$evidence_root/s1/keeper-loss.json"
  fi
  exec {keeper_events_fd}<&-
fi
write_progress server_loss
start_runtime "$server_id"
release_pane "$server_id"
server_unit="${unit_prefix}${server_id}.service"
if wait_state "$server_unit" active; then
  server_cgroup="$(runtime_cgroup "$server_id")"
  exec {server_events_fd}<"/sys/fs/cgroup${server_cgroup}/cgroup.events"
  server_pid="$(/opt/matrix/runtime/node/bin/node -e '
    const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const selected=v.roles.zellij.find((pid)=>{try{return Number(fs.readFileSync(`/proc/${pid}/stat`,"utf8").split(" ")[3])!==v.roles.keeper}catch(error){return false}});
    if(selected) process.stdout.write(String(selected));
  ' "$runtime_root/readiness/${server_id}.json")"
  if printf '%s' "$server_pid" | grep -Eq '^[1-9][0-9]*$'; then kill -KILL "$server_pid" 2>/dev/null || true; fi
  if wait_not_active "$server_unit" && wait_file "$runtime_root/outcomes/${server_id}.json" && wait_cgroup_empty "$server_events_fd" "/sys/fs/cgroup${server_cgroup}" "$server_unit"; then
    mark_pass s1 serverLossDeterministic
    cp "$runtime_root/outcomes/${server_id}.json" "$evidence_root/s1/server-loss.json"
  fi
  exec {server_events_fd}<&-
fi
# S1: layered percentage controls and pressure events.
write_progress memory_pressure
memory_ready=true
memory_stage=not_ready
for runtime_id in "${memory_ids[@]}"; do
  start_runtime "$runtime_id"
  release_pane "$runtime_id"
  if ! wait_state "${unit_prefix}${runtime_id}.service" active; then memory_ready=false; fi
done
if [ "$memory_ready" = true ]; then
  memory_stage=limits_invalid
  first_cgroup="$(runtime_cgroup "${memory_ids[0]}")"
  slice_cgroup="${first_cgroup%/*}"
  first_high_path="/sys/fs/cgroup${first_cgroup}/memory.high"
  slice_high_path="/sys/fs/cgroup${slice_cgroup}/memory.high"
  unit_high=""
  slice_high=""
  if [[ "$first_high_path" =~ ^/sys/fs/cgroup/[-A-Za-z0-9_.@/]+/memory\.high$ ]] &&
    [[ "$slice_high_path" =~ ^/sys/fs/cgroup/[-A-Za-z0-9_.@/]+/memory\.high$ ]]; then
    unit_high="$(cat "$first_high_path" 2>/dev/null || true)"
    slice_high="$(cat "$slice_high_path" 2>/dev/null || true)"
  fi
  printf 'unit_memory_high=%s\nslice_memory_high=%s\n' "$unit_high" "$slice_high" >"$evidence_root/s1/memory-limits.txt"
  if printf '%s' "$unit_high" | grep -Eq '^[0-9]+$' && printf '%s' "$slice_high" | grep -Eq '^[0-9]+$' && [ "$slice_high" -gt "$unit_high" ]; then
    memory_restore_slice_path="$slice_high_path"
    memory_restore_slice_high="$slice_high"
    memory_limits_lowered=true
    if ! printf '%s\n' 268435456 >"$slice_high_path"; then
      memory_limits_lowered=false
    fi
    for runtime_id in "${memory_ids[@]}"; do
      runtime_cgroup_path="$(runtime_cgroup "$runtime_id")"
      runtime_high_path="/sys/fs/cgroup${runtime_cgroup_path}/memory.high"
      runtime_original_high="$(cat "$runtime_high_path" 2>/dev/null || true)"
      if ! [[ "$runtime_high_path" =~ ^/sys/fs/cgroup/[-A-Za-z0-9_.@/]+/memory\.high$ ]] ||
        ! [[ "$runtime_original_high" =~ ^[0-9]+$ ]]; then
        memory_limits_lowered=false
        continue
      fi
      memory_restore_unit_paths+=("$runtime_high_path")
      memory_restore_unit_highs+=("$runtime_original_high")
      if ! printf '%s\n' 134217728 >"$runtime_high_path"; then
        memory_limits_lowered=false
      fi
    done
    if [ "$memory_limits_lowered" = true ]; then
      unit_high="$(cat "$first_high_path")"
      slice_high="$(cat "$slice_high_path")"
      memory_stage=unit_no_pressure
      unit_before="$(awk '$1=="high"{print $2}' "/sys/fs/cgroup${first_cgroup}/memory.events")"
      unit_target=$((unit_high + 67108864))
      zellij_cmd --session "matrix-t-${memory_ids[0]}" action new-pane -- /opt/matrix/runtime/node/bin/node "$support_root/memory-hog.mjs" "$unit_target" >/dev/null 2>&1 || true
      for _ in $(seq 1 120); do
        unit_after="$(awk '$1=="high"{print $2}' "/sys/fs/cgroup${first_cgroup}/memory.events")"
        [ "$unit_after" -gt "$unit_before" ] && break
        sleep 0.5
      done
      if [ "${unit_after:-0}" -gt "$unit_before" ]; then memory_stage=slice_no_pressure; fi
      pkill -f -x "/opt/matrix/runtime/node/bin/node $support_root/memory-hog.mjs $unit_target" >/dev/null 2>&1 || true
      for _ in $(seq 1 60); do
        [ "$(cat "/sys/fs/cgroup${first_cgroup}/memory.current")" -lt $((unit_high / 2)) ] && break
        sleep 0.5
      done
      slice_before="$(awk '$1=="high"{print $2}' "/sys/fs/cgroup${slice_cgroup}/memory.events")"
      aggregate_each=$((slice_high / 3 + 33554432))
      for runtime_id in "${memory_ids[@]}"; do
        zellij_cmd --session "matrix-t-${runtime_id}" action new-pane -- /opt/matrix/runtime/node/bin/node "$support_root/memory-hog.mjs" "$aggregate_each" >/dev/null 2>&1 || true
      done
      for _ in $(seq 1 120); do
        slice_after="$(awk '$1=="high"{print $2}' "/sys/fs/cgroup${slice_cgroup}/memory.events")"
        [ "$slice_after" -gt "$slice_before" ] && break
        sleep 0.5
      done
      if [ "${unit_after:-0}" -gt "$unit_before" ] && [ "${slice_after:-0}" -gt "$slice_before" ]; then memory_stage=pass; mark_pass s1 layeredMemoryHigh; fi
    fi
  fi
fi
printf '%s\n' "$memory_stage" >"$evidence_root/s1/memory-stage.txt"
restore_memory_high
for runtime_id in "${memory_ids[@]}"; do systemctl_bounded stop "${unit_prefix}${runtime_id}.service" >/dev/null 2>&1 || true; done
# S2: bounded serialized state and explicit resurrection.
write_progress recovery_restore
start_runtime "$recovery_id"
release_pane "$recovery_id"
recovery_unit="${unit_prefix}${recovery_id}.service"
if wait_state "$recovery_unit" active; then
  recovery_session="matrix-t-${recovery_id}"
  zellij_cmd --session "$recovery_session" action new-pane --direction right -- /usr/bin/bash "$support_root/pane-probe.sh" >/dev/null 2>&1 || true
  output_command='for i in $(seq 1 10050); do printf "MATRIX_SCROLL_%05d\n" "$i"; done; printf "MATRIX_VIEWPORT_MARKER\n"'
  zellij_cmd --session "$recovery_session" action write-chars -- "$output_command" >/dev/null 2>&1 || true
  zellij_cmd --session "$recovery_session" action send-keys Enter >/dev/null 2>&1 || true
  sleep 2
  zellij_cmd --session "$recovery_session" action scroll-up >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do zellij_cmd --session "$recovery_session" action scroll-up >/dev/null 2>&1 || true; done
  viewport_before="/tmp/matrix-terminal-viewport-before-${run_key}.txt"
  pane_ids="$(zellij_cmd --session "$recovery_session" action list-panes --all --json 2>/dev/null | /opt/matrix/runtime/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{for(const p of JSON.parse(s))if(!p.is_plugin)console.log(p.id)}catch(error){}})' || true)"
  serialized_pane_id=""
  for pane_id in $pane_ids; do
    zellij_cmd --session "$recovery_session" action dump-screen --pane-id "$pane_id" --path "$viewport_before" --full >/dev/null 2>&1 || true
    if grep -q '^MATRIX_SCROLL_' "$viewport_before" 2>/dev/null; then serialized_pane_id="$pane_id"; break; fi
  done
  if [ -n "$serialized_pane_id" ]; then
    zellij_cmd --session "$recovery_session" action rename-pane --pane-id "$serialized_pane_id" MATRIX_SCROLL_PROBE >/dev/null 2>&1 || true
  fi
  zellij_cmd --session "$recovery_session" action dump-screen --pane-id "$serialized_pane_id" --path "$viewport_before" >/dev/null 2>&1 || true
  viewport_anchor="$(grep -m1 '^MATRIX_SCROLL_' "$viewport_before" 2>/dev/null || true)"
  rm -f -- "$viewport_before"
  before_save="$(date +%s)"
  zellij_cmd --session "$recovery_session" action save-session >/dev/null 2>&1 || true
  for _ in $(seq 1 14); do
    newest="$(find "$cache_root" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1 | cut -d. -f1)"
    if printf '%s' "$newest" | grep -Eq '^[0-9]+$' && [ $((newest - before_save)) -le 6 ] && [ "$newest" -ge "$before_save" ]; then
      mark_pass s2 lossWindowBounded
      break
    fi
    sleep 0.5
  done
  find "$cache_root" -type f -printf '%P %s\n' | sort >"$evidence_root/s2/cache-inventory.txt"
  recovery_cache_dir="$(find "$cache_root" -type d -name "$recovery_session" -print -quit 2>/dev/null)"
  mapped_count="$(find "$recovery_cache_dir" -type f 2>/dev/null | wc -l)"
  mapped_bytes="$(find "$recovery_cache_dir" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')"
  find "$recovery_cache_dir" -type f 2>/dev/null >"/tmp/matrix-terminal-mapped-${run_key}.txt" || true
  printf 'runtime_files=%s\nruntime_bytes=%s\n' "$mapped_count" "$mapped_bytes" >"$evidence_root/s2/runtime-accounting.txt"
  if [ "$mapped_count" -gt 0 ]; then mark_pass s2 cacheMappedByRuntime; fi
  if [ "$mapped_bytes" -le 67108864 ]; then mark_pass s2 diskAccountingBounded; fi
  systemctl_bounded stop "$recovery_unit" >/dev/null 2>&1 || true
  start_runtime "$recovery_id" recover
  if wait_file "$runtime_root/confirmations/${recovery_id}.gated"; then mark_pass s2 commandsConfirmationGated; fi
  if ! pgrep -a zellij | grep -F -- '--force-run-commands' >/dev/null 2>&1; then mark_pass s2 forceRunAbsent; fi
  if wait_state "$recovery_unit" active 300; then
    panes_json="$(zellij_cmd --session "$recovery_session" action list-panes --all --json 2>/dev/null || true)"
    pane_count="$(printf '%s' "$panes_json" | /opt/matrix/runtime/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.stdout.write(String(Array.isArray(v)?v.filter(p=>!p.is_plugin).length:0))}catch(error){process.stdout.write("0")}})' )"
    if [ "$pane_count" -ge 2 ]; then mark_pass s2 layoutRestored; fi
    dump_file="/tmp/matrix-terminal-dump-${run_key}.txt"
    viewport_after="/tmp/matrix-terminal-viewport-after-${run_key}.txt"
    original_serialized_pane_id="$serialized_pane_id"
    serialized_pane_id="$(printf '%s' "$panes_json" | /opt/matrix/runtime/node/bin/node -e '
      let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
        try {
          const panes=JSON.parse(s).filter((p)=>!p.is_plugin && p.title==="MATRIX_SCROLL_PROBE");
          if(panes.length===1) process.stdout.write(String(panes[0].id));
        } catch(error) {}
      });
    ')"
    held_pane_count="$(printf '%s' "$panes_json" | /opt/matrix/runtime/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.stdout.write(String(Array.isArray(v)?v.filter(p=>!p.is_plugin&&p.is_held).length:0))}catch(error){process.stdout.write("0")}})' )"
    safe_drop_status=1
    post_drop_markers=0
    if [ -n "$serialized_pane_id" ]; then
      zellij_cmd --session "$recovery_session" action dump-screen --pane-id "$serialized_pane_id" --path "$viewport_after" >/dev/null 2>&1 || true
      held_viewport_anchor="$(grep -m1 '^MATRIX_SCROLL_' "$viewport_after" 2>/dev/null || true)"
      if [ -n "$viewport_anchor" ] && [ "$held_viewport_anchor" = "$viewport_anchor" ]; then mark_pass s2 viewportRestored; fi
      rm -f -- "$viewport_after"
      if zellij_cmd --session "$recovery_session" action write --pane-id "$serialized_pane_id" 27 >/dev/null 2>&1; then safe_drop_status=0; fi
      for _ in $(seq 1 100); do
        zellij_cmd --session "$recovery_session" action dump-screen --pane-id "$serialized_pane_id" --path "$dump_file" --full >/dev/null 2>&1 || true
        grep -q '^MATRIX_SCROLL_' "$dump_file" 2>/dev/null && break
        sleep 0.1
      done
      post_drop_markers="$(grep -c '^MATRIX_SCROLL_' "$dump_file" 2>/dev/null || true)"
    fi
    printf 'original_pane_id=%s\nrecovered_pane_id=%s\nrecovered_pane_count=%s\nheld_pane_count=%s\nsafe_drop_status=%s\npost_drop_markers=%s\n' \
      "${original_serialized_pane_id:-none}" "${serialized_pane_id:-none}" "$pane_count" "$held_pane_count" "$safe_drop_status" "$post_drop_markers" \
      >"$evidence_root/s2/recovery-resolution.txt"
    restored_pane_id=""
    for pane_id in $(printf '%s' "$panes_json" | /opt/matrix/runtime/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{for(const p of JSON.parse(s))if(!p.is_plugin)console.log(p.id)}catch(error){}})'); do
      zellij_cmd --session "$recovery_session" action dump-screen --pane-id "$pane_id" --path "$dump_file" --full >/dev/null 2>&1 || true
      if grep -q '^MATRIX_SCROLL_' "$dump_file" 2>/dev/null; then restored_pane_id="$pane_id"; break; fi
    done
    zellij_cmd --session "$recovery_session" action dump-screen --pane-id "$restored_pane_id" --path "$dump_file" --full >/dev/null 2>&1 || true
    scroll_count="$(grep -c '^MATRIX_SCROLL_' "$dump_file" 2>/dev/null || true)"
    printf 'serialized_probe_lines=%s\n' "$scroll_count" >"$evidence_root/s2/restored-counts.txt"
    if [ "$scroll_count" -gt 0 ] && [ "$scroll_count" -le 10000 ]; then mark_pass s2 scrollbackBounded; fi
    rm -f -- "$dump_file"
    corrupt_target="$recovery_cache_dir/session-layout.kdl"
    if [ -n "$corrupt_target" ] && [[ "$recovery_cache_dir" == "$cache_root"/* ]] && [ "$(basename "$recovery_cache_dir")" = "$recovery_session" ]; then
      recovery_cache_parent="$(dirname "$recovery_cache_dir")"
      chown root:root "$recovery_cache_parent" && chmod 0755 "$recovery_cache_parent"
      chown -R root:root "$recovery_cache_dir"
      find "$recovery_cache_dir" -type d -exec chmod 0500 {} + && find "$recovery_cache_dir" -type f -exec chmod 0400 {} +
      freeze_before="$(find "$recovery_cache_dir" -type f -printf '%P %s %T@\n' | sort | sha256sum)"
      zellij_cmd --session "$recovery_session" action save-session >/dev/null 2>&1 || true
      sleep 6
      freeze_after="$(find "$recovery_cache_dir" -type f -printf '%P %s %T@\n' | sort | sha256sum)"
      if [ "$freeze_before" = "$freeze_after" ] && roles_alive "$recovery_id" && ! runuser -u matrix -- mv "$recovery_cache_dir" "${recovery_cache_dir}.replaced" 2>/dev/null; then mark_pass s2 liveSerializationDisableSafe; fi
      chown -R matrix:matrix "$recovery_cache_dir"
      find "$recovery_cache_dir" -type d -exec chmod 0700 {} + && find "$recovery_cache_dir" -type f -exec chmod 0600 {} +
    fi
    systemctl_bounded stop "$recovery_unit" >/dev/null 2>&1 || true
  else
    if [ -f "$runtime_root/startup-failures/${recovery_id}.json" ]; then
      cp "$runtime_root/startup-failures/${recovery_id}.json" "$evidence_root/s2/recovery-startup-failure.json"
    fi
  fi
  if [ -n "$corrupt_target" ] && [[ "$corrupt_target" == "$cache_root"/* ]]; then
    write_progress corruption_fallback
    # Leave nested nodes unclosed so the parser must reject the cache.
    printf 'layout {\n  pane {\n' >"$corrupt_target"
    start_runtime "$recovery_id" recover
    if wait_not_active "$recovery_unit"; then
      rm -rf -- "$recovery_cache_dir"
      install -d -o matrix -g matrix -m 0700 "$recovery_cache_dir"
      zellij_delete_if_present "$recovery_id" >/dev/null 2>&1 || true
      start_runtime "$recovery_id" create
      release_pane "$recovery_id"
      if wait_state "$recovery_unit" active; then mark_pass s2 corruptionFallback; fi
    fi
  fi
  systemctl_bounded stop "$recovery_unit" >/dev/null 2>&1 || true
  zellij_delete_if_present "$recovery_id" >/dev/null 2>&1 || true
  rm -rf -- "$recovery_cache_dir"
  remaining="$(find "$recovery_cache_dir" -type f 2>/dev/null | wc -l)"
  if [ "$remaining" -eq 0 ]; then mark_pass s2 deletionComplete; fi
  rm -f -- "/tmp/matrix-terminal-mapped-${run_key}.txt"
fi
write_progress summary_build
build_summary
summary_status="$(/opt/matrix/runtime/node/bin/node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(`${v.s1.status}:${v.s2.status}`)' "$evidence_root/summary.json")"
if [ "$summary_status" != 'pass:pass' ]; then
  echo "spike_gate_failed" >&2
  trap - EXIT
  cleanup
  exit 20
fi
trap - EXIT
cleanup
exit 0

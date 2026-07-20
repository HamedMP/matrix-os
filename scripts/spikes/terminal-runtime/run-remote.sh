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

source_dir="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
short_sha="${pr_head_sha:0:7}"
evidence_root="/tmp/matrix-terminal-spike-evidence-${short_sha}"
runtime_root="/run/matrix-terminal-runtime-spike"
support_root="/opt/matrix/libexec/terminal-runtime-spike"
owner_home="/home/matrix/home"
cache_root="$owner_home/system/terminal-runtime-spike/cache"
config_root="$owner_home/system/terminal-runtime-spike/config"
unit_prefix="matrix-terminal-spike@"
base_id="1${pr_head_sha:0:31}"
keeper_id="2${pr_head_sha:0:31}"
server_id="3${pr_head_sha:0:31}"
memory_ids=("4${pr_head_sha:0:31}" "5${pr_head_sha:0:31}" "6${pr_head_sha:0:31}")
recovery_id="7${pr_head_sha:0:31}"

cleanup() {
  for runtime_id in "$base_id" "$keeper_id" "$server_id" "${memory_ids[@]}" "$recovery_id"; do
    systemctl stop "${unit_prefix}${runtime_id}.service" >/dev/null 2>&1 || true
    runuser -u matrix -- env \
      HOME="$owner_home" MATRIX_HOME="$owner_home" PATH="/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin" \
      XDG_CACHE_HOME="$cache_root" XDG_CONFIG_HOME="$owner_home/system/terminal-runtime-spike/config-home" \
      XDG_DATA_HOME="$owner_home/system/terminal-runtime-spike/data" XDG_RUNTIME_DIR="/run/user/$(id -u matrix)" \
      ZELLIJ_CONFIG_DIR="$config_root" ZELLIJ_CONFIG_FILE="$config_root/config.kdl" \
      /opt/matrix/bin/zellij delete-session "matrix-t-${runtime_id}" --force >/dev/null 2>&1 || true
    systemctl reset-failed "${unit_prefix}${runtime_id}.service" >/dev/null 2>&1 || true
  done
  pkill -f 'zellij attach matrix-t-[0-9a-f]{32}' >/dev/null 2>&1 || true
}

build_summary() {
  /opt/matrix/runtime/node/bin/node "$source_dir/build-evidence.mjs" "$evidence_root" "$pr_head_sha" || true
}

cleanup
trap 'status=$?; cleanup; build_summary; exit $status' EXIT

rm -rf -- "$evidence_root" "$runtime_root"
install -d -o root -g root -m 0700 "$evidence_root" "$evidence_root/s1" "$evidence_root/s1/checks" "$evidence_root/s2" "$evidence_root/s2/checks"
install -d -o matrix -g matrix -m 0700 "$runtime_root" "$runtime_root/descriptors" "$runtime_root/readiness" "$runtime_root/outcomes" "$runtime_root/startup-failures" "$runtime_root/confirmations" "$runtime_root/pane-release"
install -d -o matrix -g matrix -m 0700 "$owner_home/system/terminal-runtime-spike" "$cache_root" "$config_root" "$owner_home/system/terminal-runtime-spike/config-home" "$owner_home/system/terminal-runtime-spike/data"
install -d -o matrix -g matrix -m 0700 "/run/user/$(id -u matrix)"

rm -rf -- "$support_root.next"
install -d -o root -g root -m 0755 "$support_root.next" "$support_root.next/node_modules"
for file in attach-probe.mjs keeper.mjs record-outcome.mjs record-runtime-roles.mjs pane-probe.sh memory-hog.mjs layout.kdl; do
  install -o root -g root -m 0755 "$source_dir/$file" "$support_root.next/$file"
done
cp -aL /opt/matrix/app/node_modules/node-pty "$support_root.next/node_modules/node-pty"
chown -R root:root "$support_root.next"
rm -rf -- "$support_root.previous"
if [ -d "$support_root" ]; then mv "$support_root" "$support_root.previous"; fi
mv "$support_root.next" "$support_root"

install -o root -g root -m 0644 "$source_dir/matrix-terminal-spike.slice" /etc/systemd/system/matrix-terminal-spike.slice
install -o root -g root -m 0644 "$source_dir/matrix-terminal-spike@.service" /etc/systemd/system/matrix-terminal-spike@.service
systemctl daemon-reload

zellij_version="$(/opt/matrix/bin/zellij --version 2>/dev/null || true)"
if [ "$zellij_version" != "zellij 0.44.1" ]; then
  echo "spike_wrong_zellij" >&2
  exit 3
fi

default_config_tmp="/tmp/matrix-terminal-default-config-${short_sha}.kdl"
runuser -u matrix -- env \
  HOME="$owner_home" XDG_CACHE_HOME="$cache_root" ZELLIJ_CONFIG_DIR="$config_root" \
  /opt/matrix/bin/zellij setup --dump-config >"$default_config_tmp"

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
if [ -n "$viewport_option" ] && runuser -u matrix -- env HOME="$owner_home" XDG_CACHE_HOME="$cache_root" ZELLIJ_CONFIG_DIR="$config_root" /opt/matrix/bin/zellij setup --check >/dev/null 2>&1; then
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
  rm -f -- "$runtime_root/readiness/${runtime_id}.json" "$runtime_root/outcomes/${runtime_id}.json" "$runtime_root/startup-failures/${runtime_id}.json" "$runtime_root/confirmations/${runtime_id}.pass" "$runtime_root/pane-release/${session_name}"
  descriptor "$runtime_id" "$intent"
  systemctl reset-failed "${unit_prefix}${runtime_id}.service" >/dev/null 2>&1 || true
  systemctl start --no-block "${unit_prefix}${runtime_id}.service"
}

release_pane() {
  install -o root -g root -m 0644 /dev/null "$runtime_root/pane-release/matrix-t-$1"
}

wait_state() {
  unit="$1"
  desired="$2"
  limit="${3:-300}"
  for _ in $(seq 1 "$limit"); do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    [ "$state" = "$desired" ] && return 0
    sleep 0.1
  done
  return 1
}

wait_not_active() {
  unit="$1"
  for _ in $(seq 1 300); do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    [ "$state" != "active" ] && [ "$state" != "activating" ] && return 0
    sleep 0.1
  done
  return 1
}

wait_file() {
  for _ in $(seq 1 300); do [ -f "$1" ] && return 0; sleep 0.1; done
  return 1
}

roles_alive() {
  readiness_path="$runtime_root/readiness/$1.json"
  /opt/matrix/runtime/node/bin/node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pids = [value.roles.keeper, ...value.roles.zellij, value.roles.shell, value.roles.agent];
    process.exit(pids.every((pid) => Number.isInteger(pid) && fs.existsSync(`/proc/${pid}`)) ? 0 : 1);
  ' "$readiness_path"
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
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    current="$(systemctl show "$unit" -p MainPID --value 2>/dev/null || true)"
    if [ "$state" = active ] && printf '%s' "$current" | grep -Eq '^[1-9][0-9]*$' && [ "$current" != "$previous" ]; then
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

zellij_env=(env HOME="$owner_home" MATRIX_HOME="$owner_home" PATH="/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin" LANG=C.UTF-8 TERM=xterm-256color XDG_CACHE_HOME="$cache_root" XDG_CONFIG_HOME="$owner_home/system/terminal-runtime-spike/config-home" XDG_DATA_HOME="$owner_home/system/terminal-runtime-spike/data" XDG_RUNTIME_DIR="/run/user/$(id -u matrix)" ZELLIJ_CONFIG_DIR="$config_root" ZELLIJ_CONFIG_FILE="$config_root/config.kdl")
zellij_cmd() {
  runuser -u matrix -- "${zellij_env[@]}" /opt/matrix/bin/zellij "$@"
}

wait_cgroup_empty() {
  events_fd="$1"
  cgroup_path="$2"
  unit="$3"
  for _ in $(seq 1 300); do
    if grep -Eq '^populated 0$' "/proc/self/fd/${events_fd}" 2>/dev/null; then return 0; fi
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    if [ ! -e "$cgroup_path/cgroup.events" ] && [ "$state" != active ] && [ "$state" != activating ] && [ "$state" != deactivating ]; then return 0; fi
    sleep 0.1
  done
  return 1
}

# S1: readiness and stable ownership.
start_runtime "$base_id"
base_unit="${unit_prefix}${base_id}.service"
sleep 0.3
if [ "$(systemctl is-active "$base_unit" 2>/dev/null || true)" = "activating" ] && [ ! -e "$runtime_root/readiness/${base_id}.json" ]; then
  mark_pass s1 readinessGated
fi
release_pane "$base_id"
if ! wait_state "$base_unit" active; then
  wait_not_active "$base_unit" || true
  systemctl show "$base_unit" -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus >"$evidence_root/s1/base-startup-unit.txt" || true
  if [ -f "$runtime_root/startup-failures/${base_id}.json" ]; then
    cp "$runtime_root/startup-failures/${base_id}.json" "$evidence_root/s1/base-startup-failure.json"
  fi
  exit 10
fi
cp "$runtime_root/readiness/${base_id}.json" "$evidence_root/s1/base-readiness.json"
systemctl show "$base_unit" -p MainPID -p ControlGroup -p ActiveState -p SubState -p MemoryHigh -p TasksMax >"$evidence_root/s1/base-unit.txt"
pid_cgroups="$evidence_root/s1/pid-cgroups.tsv"
: >"$pid_cgroups"
main_pid="$(systemctl show "$base_unit" -p MainPID --value)"
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

gateway_before_pid="$(systemctl show matrix-gateway.service -p MainPID --value 2>/dev/null || true)"
gateway_before_cgroup="$(sed -n 's/^0:://p' "/proc/${gateway_before_pid}/cgroup" 2>/dev/null || true)"
if [ -n "$gateway_before_cgroup" ] && [ "$gateway_before_cgroup" != "$base_cgroup" ]; then
  record_pid_cgroup gateway-before "$gateway_before_pid" "$pid_cgroups" || true
  mark_pass s1 gatewayOutsideCgroup
fi

runuser -u matrix -- "${zellij_env[@]}" /opt/matrix/runtime/node/bin/node "$support_root/attach-probe.mjs" "$base_id" &
attach_parent=$!
attach_receipt="$runtime_root/attach-${base_id}.json"
for _ in $(seq 1 100); do
  [ -f "$attach_receipt" ] && break
  sleep 0.1
done
attach_pid="$(/opt/matrix/runtime/node/bin/node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).client))' "$attach_receipt")"
attach_helper="$(/opt/matrix/runtime/node/bin/node -e 'const fs=require("fs");process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).helper))' "$attach_receipt")"
membership="$(sed -n 's/^0:://p' "/proc/${attach_pid}/cgroup" 2>/dev/null || true)"
if [ -n "$membership" ] && [ "$membership" != "$base_cgroup" ]; then
  record_pid_cgroup attach-client "$attach_pid" "$pid_cgroups" || true
  mark_pass s1 attachOutsideCgroup
fi
kill "$attach_helper" 2>/dev/null || true
wait "$attach_parent" 2>/dev/null || true
sleep 0.5
if roles_alive "$base_id"; then mark_pass s1 detachPreservesPids; else
  /opt/matrix/runtime/node/bin/node "$support_root/record-runtime-roles.mjs" "$base_id" detach || true
fi

if systemctl restart matrix-gateway.service >/dev/null 2>&1; then
  gateway_restart_pid="$(wait_main_pid_changed matrix-gateway.service "$gateway_before_pid" || true)"
  if [ -n "$gateway_restart_pid" ] && roles_alive "$base_id"; then
    record_pid_cgroup gateway-after-restart "$gateway_restart_pid" "$pid_cgroups" || true
    mark_pass s1 gatewayRestartPreservesPids
  fi
fi
gateway_pid="$(systemctl show matrix-gateway.service -p MainPID --value 2>/dev/null || true)"
if printf '%s' "$gateway_pid" | grep -Eq '^[1-9][0-9]*$'; then
  kill -KILL "$gateway_pid" 2>/dev/null || true
  gateway_crash_pid="$(wait_main_pid_changed matrix-gateway.service "$gateway_pid" || true)"
  if [ -n "$gateway_crash_pid" ] && roles_alive "$base_id"; then
    record_pid_cgroup gateway-after-crash "$gateway_crash_pid" "$pid_cgroups" || true
    mark_pass s1 gatewayCrashPreservesPids
  fi
fi
shell_before_pid="$(systemctl show matrix-shell.service -p MainPID --value 2>/dev/null || true)"
record_pid_cgroup shell-service-before "$shell_before_pid" "$pid_cgroups" || true
if systemctl restart matrix-shell.service >/dev/null 2>&1; then
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
systemctl stop --no-block "$base_unit" >/dev/null 2>&1 || true
if wait_cgroup_empty "$base_events_fd" "/sys/fs/cgroup${base_cgroup}" "$base_unit"; then
  if [ -e "/sys/fs/cgroup${base_cgroup}/cgroup.events" ]; then cat "/proc/self/fd/${base_events_fd}" >"$evidence_root/s1/stopped-cgroup.events"; else printf 'cgroup_removed\n' >"$evidence_root/s1/stopped-cgroup.events"; fi
  mark_pass s1 stopEmptiesCgroup
fi
exec {base_events_fd}<&-

# S1: deterministic keeper and server failures.
start_runtime "$keeper_id"
release_pane "$keeper_id"
keeper_unit="${unit_prefix}${keeper_id}.service"
if wait_state "$keeper_unit" active; then
  keeper_cgroup="$(runtime_cgroup "$keeper_id")"
  exec {keeper_events_fd}<"/sys/fs/cgroup${keeper_cgroup}/cgroup.events"
  kill -KILL "$(systemctl show "$keeper_unit" -p MainPID --value)" 2>/dev/null || true
  if wait_not_active "$keeper_unit" && wait_file "$runtime_root/outcomes/${keeper_id}.json" && wait_cgroup_empty "$keeper_events_fd" "/sys/fs/cgroup${keeper_cgroup}" "$keeper_unit"; then
    mark_pass s1 keeperLossDeterministic
    cp "$runtime_root/outcomes/${keeper_id}.json" "$evidence_root/s1/keeper-loss.json"
  fi
  exec {keeper_events_fd}<&-
fi

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
  if wait_not_active "$server_unit" && [ -f "$runtime_root/outcomes/${server_id}.json" ] && wait_cgroup_empty "$server_events_fd" "/sys/fs/cgroup${server_cgroup}" "$server_unit"; then
    mark_pass s1 serverLossDeterministic
    cp "$runtime_root/outcomes/${server_id}.json" "$evidence_root/s1/server-loss.json"
  fi
  exec {server_events_fd}<&-
fi

# S1: layered percentage controls and pressure events.
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
  unit_high="$(cat "/sys/fs/cgroup${first_cgroup}/memory.high")"
  slice_high="$(cat "/sys/fs/cgroup${slice_cgroup}/memory.high")"
  printf 'unit_memory_high=%s\nslice_memory_high=%s\n' "$unit_high" "$slice_high" >"$evidence_root/s1/memory-limits.txt"
  if printf '%s' "$unit_high" | grep -Eq '^[0-9]+$' && printf '%s' "$slice_high" | grep -Eq '^[0-9]+$' && [ "$slice_high" -gt "$unit_high" ]; then
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
if [ "$memory_stage" = slice_no_pressure ]; then
  slice_current="$(cat "/sys/fs/cgroup${slice_cgroup}/memory.current")"
  hog_count="$(pgrep -f -c -- "$support_root/memory-hog.mjs" || true)"
  printf '%s unit=%s slice=%s current=%s high=%s hogs=%s\n' "$memory_stage" "$unit_after" "$slice_after" "$slice_current" "$slice_high" "$hog_count" >"$evidence_root/s1/memory-stage.txt"
else printf '%s\n' "$memory_stage" >"$evidence_root/s1/memory-stage.txt"; fi
for runtime_id in "${memory_ids[@]}"; do systemctl stop "${unit_prefix}${runtime_id}.service" >/dev/null 2>&1 || true; done

# S2: bounded serialized state and explicit resurrection.
start_runtime "$recovery_id"
release_pane "$recovery_id"
recovery_unit="${unit_prefix}${recovery_id}.service"
if wait_state "$recovery_unit" active; then
  recovery_session="matrix-t-${recovery_id}"
  zellij_cmd --session "$recovery_session" action new-pane --direction right -- "$support_root/pane-probe.sh" >/dev/null 2>&1 || true
  output_command='for i in $(seq 1 10050); do printf "MATRIX_SCROLL_%05d\n" "$i"; done; printf "MATRIX_VIEWPORT_MARKER\n"'
  zellij_cmd --session "$recovery_session" action write-chars -- "$output_command" >/dev/null 2>&1 || true
  zellij_cmd --session "$recovery_session" action send-keys Enter >/dev/null 2>&1 || true
  sleep 2
  zellij_cmd --session "$recovery_session" action scroll-up >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do zellij_cmd --session "$recovery_session" action scroll-up >/dev/null 2>&1 || true; done
  viewport_before="/tmp/matrix-terminal-viewport-before-${short_sha}.txt"
  zellij_cmd --session "$recovery_session" action dump-screen --path "$viewport_before" >/dev/null 2>&1 || true
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
  mapped_count="$(grep -RIl -- "$recovery_session" "$cache_root" 2>/dev/null | wc -l)"
  mapped_bytes="$(grep -RIl -- "$recovery_session" "$cache_root" 2>/dev/null | xargs -r stat -c '%s' | awk '{s+=$1} END{print s+0}')"
  grep -RIl -- "$recovery_session" "$cache_root" 2>/dev/null >"/tmp/matrix-terminal-mapped-${short_sha}.txt" || true
  printf 'runtime_files=%s\nruntime_bytes=%s\n' "$mapped_count" "$mapped_bytes" >"$evidence_root/s2/runtime-accounting.txt"
  if [ "$mapped_count" -gt 0 ]; then mark_pass s2 cacheMappedByRuntime; fi
  if [ "$mapped_bytes" -le 67108864 ]; then mark_pass s2 diskAccountingBounded; fi
  systemctl stop "$recovery_unit" >/dev/null 2>&1 || true

  start_runtime "$recovery_id" recover
  confirmation_dump="/tmp/matrix-terminal-confirmation-${short_sha}.txt"
  for _ in $(seq 1 150); do
    zellij_cmd --session "$recovery_session" action dump-screen --path "$confirmation_dump" >/dev/null 2>&1 || true
    if grep -Fq '<ENTER> run' "$confirmation_dump" 2>/dev/null; then mark_pass s2 commandsConfirmationGated; break; fi
    sleep 0.1
  done
  rm -f -- "$confirmation_dump"
  if ! pgrep -a zellij | grep -F -- '--force-run-commands' >/dev/null 2>&1; then mark_pass s2 forceRunAbsent; fi
  panes_json="$(zellij_cmd --session "$recovery_session" action list-panes --all --json 2>/dev/null || true)"
  while read -r pane_id; do
    zellij_cmd --session "$recovery_session" action write --pane-id "$pane_id" 13 >/dev/null 2>&1 || true
  done < <(printf '%s' "$panes_json" | /opt/matrix/runtime/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{for(const p of JSON.parse(s))if(!p.is_plugin)console.log(p.id)}catch(error){}})')
  release_pane "$recovery_id"
  if wait_state "$recovery_unit" active 300; then
    panes_json="$(zellij_cmd --session "$recovery_session" action list-panes --all --json 2>/dev/null || true)"
    pane_count="$(printf '%s' "$panes_json" | /opt/matrix/runtime/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s);process.stdout.write(String(Array.isArray(v)?v.filter(p=>!p.is_plugin).length:0))}catch(error){process.stdout.write("0")}})' )"
    if [ "$pane_count" -ge 2 ]; then mark_pass s2 layoutRestored; fi
    dump_file="/tmp/matrix-terminal-dump-${short_sha}.txt"
    viewport_after="/tmp/matrix-terminal-viewport-after-${short_sha}.txt"
    zellij_cmd --session "$recovery_session" action dump-screen --path "$viewport_after" >/dev/null 2>&1 || true
    restored_viewport_anchor="$(grep -m1 '^MATRIX_SCROLL_' "$viewport_after" 2>/dev/null || true)"
    if [ -n "$viewport_anchor" ] && [ "$restored_viewport_anchor" = "$viewport_anchor" ]; then mark_pass s2 viewportRestored; fi
    rm -f -- "$viewport_after"
    zellij_cmd --session "$recovery_session" action dump-screen --path "$dump_file" --full >/dev/null 2>&1 || true
    scroll_count="$(grep -c '^MATRIX_SCROLL_' "$dump_file" 2>/dev/null || true)"
    printf 'serialized_probe_lines=%s\n' "$scroll_count" >"$evidence_root/s2/restored-counts.txt"
    if [ "$scroll_count" -gt 0 ] && [ "$scroll_count" -le 10000 ]; then mark_pass s2 scrollbackBounded; fi
    rm -f -- "$dump_file"

    newest_before_disable="$(find "$cache_root" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1)"
    if zellij_cmd --session "$recovery_session" options --session-serialization false >/dev/null 2>&1; then
      sleep 6
      newest_after_disable="$(find "$cache_root" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1)"
      if [ "$newest_before_disable" = "$newest_after_disable" ]; then mark_pass s2 liveSerializationDisableSafe; fi
    fi
    systemctl stop "$recovery_unit" >/dev/null 2>&1 || true
  else
    if [ -f "$runtime_root/startup-failures/${recovery_id}.json" ]; then
      cp "$runtime_root/startup-failures/${recovery_id}.json" "$evidence_root/s2/recovery-startup-failure.json"
    fi
  fi

  corrupt_target="$(head -1 "/tmp/matrix-terminal-mapped-${short_sha}.txt" 2>/dev/null || true)"
  if [ -n "$corrupt_target" ] && [[ "$corrupt_target" == "$cache_root"/* ]]; then
    printf 'MATRIX_CORRUPT_STATE\n' >"$corrupt_target"
    start_runtime "$recovery_id" recover
    if wait_not_active "$recovery_unit"; then
      while IFS= read -r mapped; do
        if [ -n "$mapped" ] && [[ "$mapped" == "$cache_root"/* ]]; then rm -f -- "$mapped"; fi
      done <"/tmp/matrix-terminal-mapped-${short_sha}.txt"
      zellij_cmd delete-session "$recovery_session" --force >/dev/null 2>&1 || true
      start_runtime "$recovery_id" create
      release_pane "$recovery_id"
      if wait_state "$recovery_unit" active; then mark_pass s2 corruptionFallback; fi
    fi
  fi
  systemctl stop "$recovery_unit" >/dev/null 2>&1 || true
  zellij_cmd delete-session "$recovery_session" --force >/dev/null 2>&1 || true
  remaining="$(grep -RIl -- "$recovery_session" "$cache_root" 2>/dev/null | wc -l)"
  if [ "$remaining" -eq 0 ]; then mark_pass s2 deletionComplete; fi
  rm -f -- "/tmp/matrix-terminal-mapped-${short_sha}.txt"
fi

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

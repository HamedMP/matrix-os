#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
head_sha="${2:-}"
run_nonce="${3:-}"
if [ "$(id -u)" -ne 0 ] || [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "$run_nonce" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$ ]]; then
  echo "user_systemd_acceptance_invalid_request" >&2
  exit 2
fi
case "$operation" in
  prepare|launch|status|reboot|resume|pack|phase1|phase2) ;;
  *) echo "user_systemd_acceptance_invalid_request" >&2; exit 2 ;;
esac

readonly root_parent=/var/lib/matrix-user-systemd-terminal-acceptance
readonly state_root="${root_parent}/${head_sha}-${run_nonce}"
readonly checks_root="${state_root}/checks"
readonly state_file="${state_root}/state"
readonly helper_path="$0"
readonly probe_path="${helper_path%.sh}-probe.mjs"
readonly home=/home/matrix/home
readonly descriptor_root="${home}/system/terminal-runtimes"
readonly runtime_root=/opt/matrix/terminal-runtime
readonly gateway_dropin=/etc/systemd/system/matrix-gateway.service.d/zz-user-systemd-acceptance.conf
readonly version_a="v0.0.0-user-systemd-accept-${head_sha:0:7}-${run_nonce}-a"
readonly version_b="v0.0.0-user-systemd-accept-${head_sha:0:7}-${run_nonce}-b"
readonly shell_name="u-s-${run_nonce}"
readonly agent_name="u-a-${run_nonce}"
readonly delete_name="u-d-${run_nonce}"
readonly limit_name="u-l-${run_nonce}"
readonly post_rollback_name="u-p-${run_nonce}"
readonly current_generation_name="u-c-${run_nonce}"
readonly conflict_id=rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly owner_uid="$(id -u matrix)"
readonly loop_root="${home}/system/terminal-acceptance/${head_sha:0:7}-${run_nonce}"
readonly loop_script="${loop_root}/production-loop.mjs"
readonly output_file="${loop_root}/output"
readonly corrupt_id=rt_cccccccccccccccccccccccccccccccc
readonly symlink_id=rt_dddddddddddddddddddddddddddddddd
readonly generation_symlink="${runtime_root}/generations/gen_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
readonly generation_sentinel="${state_root}/generation-sentinel"

write_state() {
  install -d -o root -g root -m 0700 "$state_root"
  local next="${state_file}.next"
  printf '%s\n' "$1" >"$next"
  chmod 0600 "$next"
  mv -f -- "$next" "$state_file"
}

mark() {
  install -d -o root -g root -m 0700 "$checks_root"
  install -m 0600 /dev/null "$checks_root/$1"
}

owner_systemctl() {
  runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    systemctl --user "$@"
}

load_host_auth() {
  local line token
  line="$(grep -m1 '^MATRIX_AUTH_TOKEN=' /opt/matrix/env/host.env)"
  token="${line#MATRIX_AUTH_TOKEN=}"
  [[ "$token" =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]]
  export MATRIX_AUTH_TOKEN="$token"
}

api_call() {
  local method="$1" path="$2" body="${3:-}" expected="${4:-200}"
  local response="${state_root}/api-response.json" code
  load_host_auth
  if [ -n "$body" ]; then
    code="$(curl --silent --show-error --max-time 45 -o "$response" -w '%{http_code}' \
      -X "$method" "http://127.0.0.1:4000${path}" \
      -H "authorization: Bearer ${MATRIX_AUTH_TOKEN}" \
      -H 'content-type: application/json' --data-binary "$body")"
  else
    code="$(curl --silent --show-error --max-time 45 -o "$response" -w '%{http_code}' \
      -X "$method" "http://127.0.0.1:4000${path}" \
      -H "authorization: Bearer ${MATRIX_AUTH_TOKEN}")"
  fi
  if [ "$code" != "$expected" ]; then
    echo "user_systemd_acceptance_api_failed" >&2
    return 1
  fi
}

wait_gateway() {
  for _ in $(seq 1 180); do
    if systemctl is-active --quiet matrix-gateway.service &&
      curl --fail --silent --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

create_session() {
  local name="$1" command="$2" agent="${3:-}"
  local body
  if [ -n "$agent" ]; then
    body="$(jq -cn --arg name "$name" --arg cmd "$command" --arg agent "$agent" \
      '{name:$name,cmd:$cmd,agent:$agent}')"
  else
    body="$(jq -cn --arg name "$name" --arg cmd "$command" '{name:$name,cmd:$cmd}')"
  fi
  api_call POST /api/terminal/sessions "$body" 201
}

delete_session() {
  api_call DELETE "/api/terminal/sessions/$1?force=1" "" 200
}

snapshot() {
  /opt/matrix/runtime/node/bin/node "$probe_path" snapshot "$1" "$2"
}

wait_snapshot() {
  local name="$1" kind="$2" target="$3" current=""
  for _ in $(seq 1 90); do
    if current="$(snapshot "$name" "$kind" 2>/dev/null)"; then
      printf '%s\n' "$current" >"$target"
      chmod 0600 "$target"
      return 0
    fi
    sleep 1
  done
  return 1
}

roles_match() {
  local name="$1" kind="$2" baseline="$3" current
  current="$(snapshot "$name" "$kind")"
  jq -e --argjson before "$(cat "$baseline")" --argjson after "$current" '
    $before.runtimeId == $after.runtimeId and
    $before.generation == $after.generation and
    $before.unit == $after.unit and
    $before.cgroup == $after.cgroup and
    $before.mainPid == $after.mainPid and
    $before.zellijServerPid == $after.zellijServerPid and
    $before.workloadPid == $after.workloadPid
  ' >/dev/null
}

websocket_attach_owned_by_gateway() {
  local name="$1" snapshot_file="$2" runtime_id session_name gateway_cgroup ready client_pid found=0
  runtime_id="$(jq -r .runtimeId "$snapshot_file")"
  session_name="$(jq -r .sessionName "$snapshot_file")"
  gateway_cgroup="$(systemctl show matrix-gateway.service -p ControlGroup --value)"
  ready="${loop_root}/ws-${runtime_id}.ready"
  rm -f -- "$ready"
  load_host_auth
  runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" MATRIX_AUTH_TOKEN="$MATRIX_AUTH_TOKEN" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    /opt/matrix/runtime/node/bin/node "$probe_path" attach "$name" unused "$ready" \
    >/dev/null 2>&1 &
  client_pid=$!
  for _ in $(seq 1 30); do [ -f "$ready" ] && break; sleep 1; done
  [ -f "$ready" ]
  local proc pid cmdline cgroup
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    cmdline="$(tr '\0' ' ' <"$proc/cmdline")"
    [[ "$cmdline" == *"/zellij attach ${session_name}"* ]] || continue
    pid="${proc#/proc/}"
    cgroup="$(awk -F: '$1 == "0" { print $3 }' "$proc/cgroup")"
    [ "$cgroup" = "$gateway_cgroup" ]
    [ "$cgroup" != "$(jq -r .cgroup "$snapshot_file")" ]
    found=$((found + 1))
  done
  [ "$found" -ge 1 ]
  wait "$client_pid"
  rm -f -- "$ready"
  roles_match "$name" "$(jq -r .workloadKind "$snapshot_file")" "$snapshot_file"
}

verify_gateway_memory_isolation() {
  local shell_baseline="$1" agent_baseline="$2" gateway_cgroup memory_max memory_current memory_high target_high body pressure_status=0
  gateway_cgroup="$(systemctl show matrix-gateway.service -p ControlGroup --value)"
  memory_max="$(systemctl show matrix-gateway.service -p MemoryMax --value)"
  memory_current="$(systemctl show matrix-gateway.service -p MemoryCurrent --value)"
  memory_high="$(systemctl show matrix-gateway.service -p MemoryHigh --value)"
  [[ "$memory_max" =~ ^[1-9][0-9]*$ ]]
  [[ "$memory_current" =~ ^[0-9]+$ ]]
  [ "$(jq -r .cgroup "$shell_baseline")" != "$gateway_cgroup" ]
  [ "$(jq -r .cgroup "$agent_baseline")" != "$gateway_cgroup" ]
  grep -qw memory "/sys/fs/cgroup${gateway_cgroup%/*}/cgroup.controllers"
  target_high=$((memory_current + 16 * 1024 * 1024))
  systemctl set-property --runtime matrix-gateway.service "MemoryHigh=${target_high}"
  body="$(jq -cn '{command:["/opt/matrix/runtime/node/bin/node","-e","const b=Buffer.alloc(32*1024*1024,1);setTimeout(()=>{},1000)"],timeoutMs:5000}')"
  api_call POST /api/terminal/run "$body" 200 || pressure_status=$?
  systemctl set-property --runtime matrix-gateway.service "MemoryHigh=${memory_high}"
  [ "$pressure_status" -eq 0 ]
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  wait_gateway
}

verify_resource_controls() {
  local baseline cgroup slice_cgroup memory_max tasks_max slice_memory_max slice_tasks_max
  for baseline in "$@"; do
    cgroup="$(jq -r .cgroup "$baseline")"
    memory_max="$(jq -r .memoryMax "$baseline")"
    tasks_max="$(jq -r .tasksMax "$baseline")"
    [ "$(cat "/sys/fs/cgroup${cgroup}/memory.max")" = "$memory_max" ]
    [ "$(cat "/sys/fs/cgroup${cgroup}/pids.max")" = "$tasks_max" ]
  done
  slice_cgroup="$(jq -r .sliceCgroup "$1")"
  slice_memory_max="$(jq -r .sliceMemoryMax "$1")"
  slice_tasks_max="$(jq -r .sliceTasksMax "$1")"
  [ "$(cat "/sys/fs/cgroup${slice_cgroup}/memory.max")" = "$slice_memory_max" ]
  [ "$(cat "/sys/fs/cgroup${slice_cgroup}/pids.max")" = "$slice_tasks_max" ]
  grep -qw memory "/sys/fs/cgroup${slice_cgroup}/cgroup.controllers"
  grep -qw pids "/sys/fs/cgroup${slice_cgroup}/cgroup.controllers"
}

run_controller_adversarial_checks() {
  local layout_path="${home}/system/zellij/layouts/default.kdl"
  runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    /opt/matrix/runtime/node/bin/node --input-type=module - \
    "$home" "$conflict_id" "$layout_path" <<'NODE'
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createUserSystemdTerminalRuntime,
  loadInstalledTerminalRuntimeGeneration,
} from "/opt/matrix/app/packages/gateway/dist/shell/user-systemd-terminal-runtime.js";

const execFileAsync = promisify(execFile);
const [homePath, runtimeId, layoutPath] = process.argv.slice(2);
const generation = await loadInstalledTerminalRuntimeGeneration("/opt/matrix/app");
const runtime = createUserSystemdTerminalRuntime({ homePath, generation });
const base = {
  runtimeId,
  scope: "terminal",
  kind: "shell",
  displayName: "acceptance-conflict-a",
  cwd: homePath,
  layoutPath,
};
async function mustReject(operation) {
  let rejected = false;
  try { await operation(); } catch (error) {
    if (!(error instanceof Error)) throw error;
    rejected = true;
  }
  if (!rejected) process.exit(1);
}
await mustReject(() => runtime.create({ ...base, runtimeId: "../../matrix-gateway" }));
await mustReject(() => runtime.create({ ...base, cwd: "/etc" }));
const created = await runtime.create(base);
await mustReject(() => runtime.create({ ...base, displayName: "acceptance-conflict-b" }));
await execFileAsync("systemctl", ["--user", "stop", `matrix-zellij@${runtimeId}.service`]);
const restarted = await runtime.start(runtimeId);
if (restarted.runtimeId !== created.runtimeId || restarted.sessionName !== created.sessionName) process.exit(1);
await execFileAsync("systemctl", ["--user", "stop", `matrix-zellij@${runtimeId}.service`]);
const descriptorPath = `${homePath}/system/terminal-runtimes/${runtimeId}.json`;
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
await writeFile(descriptorPath, `${JSON.stringify({
  ...descriptor,
  command: "/bin/sh",
  unit: "matrix-gateway.service",
  url: "file:///etc/passwd",
  environment: { PATH: "/tmp" },
})}\n`, { mode: 0o600 });
await mustReject(() => runtime.start(runtimeId));
try {
  await execFileAsync("systemctl", ["--user", "start", `matrix-zellij@${runtimeId}.service`]);
} catch (error) {
  if (!(error instanceof Error)) throw error;
}
await new Promise((resolve) => setTimeout(resolve, 500));
await mustReject(() => execFileAsync("systemctl", ["--user", "is-active", `matrix-zellij@${runtimeId}.service`]));
await execFileAsync("systemctl", ["--user", "reset-failed", `matrix-zellij@${runtimeId}.service`]);
const environmentPath = `${homePath}/system/terminal-runtimes/hostile-environment.json`;
await writeFile(environmentPath, `${JSON.stringify({ LD_PRELOAD: "/tmp/hostile.so" })}\n`, { mode: 0o600 });
await writeFile(descriptorPath, `${JSON.stringify({ ...descriptor, environmentPath })}\n`, { mode: 0o600 });
try {
  await execFileAsync("systemctl", ["--user", "start", `matrix-zellij@${runtimeId}.service`]);
} catch (error) {
  if (!(error instanceof Error)) throw error;
}
await new Promise((resolve) => setTimeout(resolve, 500));
await mustReject(() => execFileAsync("systemctl", ["--user", "is-active", `matrix-zellij@${runtimeId}.service`]));
await rm(environmentPath, { force: true });
await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
await runtime.delete(runtimeId);
await runtime.delete(runtimeId);
NODE
}

request_update() {
  runuser -u matrix -- /opt/matrix/bin/matrix-update --no-tail "$1" >/dev/null
}

wait_update() {
  local expected="$1"
  for _ in $(seq 1 1800); do
    if [ "$(cat /opt/matrix/app/BUNDLE_VERSION 2>/dev/null || true)" = "$expected" ] &&
      [ ! -e /opt/matrix/app/.update-now ] &&
      systemctl is-active --quiet matrix-gateway.service &&
      curl --fail --silent --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

create_hostile_state() {
  install -d -o matrix -g matrix -m 0700 "$descriptor_root"
  printf '{not-json\n' >"${descriptor_root}/${corrupt_id}.json"
  chown matrix:matrix "${descriptor_root}/${corrupt_id}.json"
  chmod 0600 "${descriptor_root}/${corrupt_id}.json"
  ln -s /etc/passwd "${descriptor_root}/${symlink_id}.json"
  chown -h matrix:matrix "${descriptor_root}/${symlink_id}.json"

  install -d -o root -g root -m 0700 "$generation_sentinel"
  install -m 0600 /dev/null "${generation_sentinel}/sentinel"
  ln -s "$generation_sentinel" "$generation_symlink"
  local digit generation
  for digit in 1 2 3 4 5 6 7 8; do
    generation="${runtime_root}/generations/gen_$(printf '%064d' "$digit")"
    [ ! -e "$generation" ] || return 1
    install -d -o root -g root -m 0755 "$generation"
    touch -d "2020-01-0${digit} 00:00:00 UTC" "$generation"
  done
}

hostile_state_fails_closed() {
  api_call GET /api/terminal/sessions "" 200
  ! owner_systemctl is-active --quiet "matrix-zellij@${corrupt_id}.service"
  ! owner_systemctl is-active --quiet "matrix-zellij@${symlink_id}.service"
  [ -L "${descriptor_root}/${symlink_id}.json" ]
  [ "$(readlink "${descriptor_root}/${symlink_id}.json")" = /etc/passwd ]
}

generation_gc_safe() {
  local initial_generation="$1" removed=0 digit generation installed_count current_generation referenced_generation descriptor
  [ -d "${runtime_root}/generations/${initial_generation}" ]
  current_generation="$(basename "$(readlink "${runtime_root}/current")")"
  [ -d "${runtime_root}/generations/${current_generation}" ]
  [ -d "${runtime_root}/generations/$(cat /opt/matrix/app/TERMINAL_RUNTIME_GENERATION)" ]
  [ -d "${runtime_root}/generations/$(cat /opt/matrix/app.rollback/TERMINAL_RUNTIME_GENERATION)" ]
  for descriptor in "$descriptor_root"/rt_*.json; do
    [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || continue
    referenced_generation="$(jq -er .generation "$descriptor" 2>/dev/null || true)"
    [[ "$referenced_generation" =~ ^gen_[0-9a-f]{64}$ ]] || continue
    [ -d "${runtime_root}/generations/${referenced_generation}" ]
  done
  [ -L "$generation_symlink" ]
  [ -f "${generation_sentinel}/sentinel" ]
  for digit in 1 2 3 4 5 6 7 8; do
    generation="${runtime_root}/generations/gen_$(printf '%064d' "$digit")"
    [ ! -e "$generation" ] && removed=$((removed + 1))
  done
  [ "$removed" -ge 1 ]
  installed_count="$(find "${runtime_root}/generations" -mindepth 1 -maxdepth 1 -type d -name 'gen_*' | wc -l)"
  [ "$installed_count" -le 8 ]
}

remove_hostile_state() {
  rm -f -- "${descriptor_root}/${corrupt_id}.json" "${descriptor_root}/${symlink_id}.json"
  rm -f -- "$generation_symlink"
  local digit generation
  for digit in 1 2 3 4 5 6 7 8; do
    generation="${runtime_root}/generations/gen_$(printf '%064d' "$digit")"
    if [ -d "$generation" ] && [ ! -L "$generation" ]; then rm -rf -- "$generation"; fi
  done
  rm -rf -- "$generation_sentinel"
}

verify_deleted() {
  local snapshot_file="$1" runtime_id unit cgroup pid generation session_name layout_path environment_path sessions
  runtime_id="$(jq -r .runtimeId "$snapshot_file")"
  unit="$(jq -r .unit "$snapshot_file")"
  cgroup="$(jq -r .cgroup "$snapshot_file")"
  generation="$(jq -r .generation "$snapshot_file")"
  session_name="$(jq -r .sessionName "$snapshot_file")"
  layout_path="$(jq -r .layoutPath "$snapshot_file")"
  environment_path="$(jq -r '.environmentPath // ""' "$snapshot_file")"
  for _ in $(seq 1 60); do
    if ! owner_systemctl is-active --quiet "$unit" && [ ! -e "/sys/fs/cgroup${cgroup}/cgroup.procs" ]; then break; fi
    sleep 1
  done
  ! owner_systemctl is-active --quiet "$unit"
  [ ! -e "${descriptor_root}/${runtime_id}.json" ]
  [ ! -e "/sys/fs/cgroup${cgroup}/cgroup.procs" ]
  sessions="$(runuser -u matrix -- env HOME="$home" MATRIX_HOME="$home" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    "${runtime_root}/generations/${generation}/zellij" list-sessions --no-formatting 2>/dev/null || true)"
  ! grep -Eq "^${session_name}([[:space:]]|$)" <<<"$sessions"
  if [[ "$layout_path" == "${home}/system/zellij/runtime-layouts/${runtime_id}"* ]]; then
    [ ! -e "$layout_path" ]
  fi
  [ -z "$environment_path" ] || [ ! -e "$environment_path" ]
  if [ -d "/run/user/${owner_uid}/zellij" ]; then
    ! find "/run/user/${owner_uid}/zellij" -maxdepth 1 -type s -name "${session_name}*" | grep -q .
  fi
  for pid in "$(jq -r .mainPid "$snapshot_file")" \
    "$(jq -r .zellijServerPid "$snapshot_file")" \
    "$(jq -r .workloadPid "$snapshot_file")"; do
    if [ -r "/proc/${pid}/cgroup" ]; then
      ! grep -F -- "$cgroup" "/proc/${pid}/cgroup" >/dev/null
    fi
  done
}

cleanup_runtime_sessions() {
  wait_gateway || return 0
  for name in "$shell_name" "$agent_name" "$delete_name" "$limit_name" "$post_rollback_name" "$current_generation_name"; do
    delete_session "$name" >/dev/null 2>&1 || true
  done
}

disable_acceptance_runtime() {
  rm -f -- "$gateway_dropin"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart matrix-gateway.service >/dev/null 2>&1 || true
}

fail_phase() {
  local status=$?
  trap - ERR
  cleanup_runtime_sessions || true
  remove_hostile_state || true
  disable_acceptance_runtime || true
  write_state failed
  exit "$status"
}

phase1() {
  trap fail_phase ERR
  write_state phase1-running
  install -d -o matrix -g matrix -m 0700 "$loop_root"
  cat >"$loop_script" <<'EOF'
import { appendFileSync } from "node:fs";
const output = process.argv[2];
if (!output) process.exit(2);
setInterval(() => appendFileSync(output, "x"), 250);
EOF
  chown matrix:matrix "$loop_script"
  chmod 0600 "$loop_script"
  install -o matrix -g matrix -m 0600 /dev/null "$output_file"

  create_session "$shell_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  create_session "$agent_name" codex codex
  local shell_baseline="${state_root}/shell-baseline.json"
  local agent_baseline="${state_root}/agent-baseline.json"
  wait_snapshot "$shell_name" shell "$shell_baseline"
  wait_snapshot "$agent_name" agent "$agent_baseline"
  mark ordinaryShellRuntime
  mark realCodingAgentRuntime

  local gateway_cgroup shell_cgroup agent_cgroup
  gateway_cgroup="$(systemctl show matrix-gateway.service -p ControlGroup --value)"
  shell_cgroup="$(jq -r .cgroup "$shell_baseline")"
  agent_cgroup="$(jq -r .cgroup "$agent_baseline")"
  [ "$shell_cgroup" != "$agent_cgroup" ]
  [ "$shell_cgroup" != "$gateway_cgroup" ]
  [ "$agent_cgroup" != "$gateway_cgroup" ]
  mark independentRuntimeCgroups
  verify_resource_controls "$shell_baseline" "$agent_baseline"
  mark resourceControlsPresent
  mark resourceControlsEffective

  websocket_attach_owned_by_gateway "$shell_name" "$shell_baseline"
  websocket_attach_owned_by_gateway "$agent_name" "$agent_baseline"
  mark browserAttachmentPtysRemainGatewayOwned
  mark detachPreservesRuntimes

  systemctl restart matrix-gateway.service
  wait_gateway
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  mark gatewayRestartPreservesRuntimes

  local old_gateway_pid
  old_gateway_pid="$(systemctl show matrix-gateway.service -p MainPID --value)"
  kill -KILL "$old_gateway_pid"
  wait_gateway
  [ "$(systemctl show matrix-gateway.service -p MainPID --value)" != "$old_gateway_pid" ]
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  mark gatewaySigkillPreservesRuntimes
  verify_gateway_memory_isolation "$shell_baseline" "$agent_baseline"
  mark gatewayMemoryIsolation

  run_controller_adversarial_checks
  mark invalidRuntimeIdsFailClosed
  mark conflictingDescriptorReuseFailsClosed
  mark staleInactiveStateIsRecoverable
  mark hostileDescriptorFieldsFailClosed
  mark deleteIsIdempotent

  create_hostile_state
  hostile_state_fails_closed
  mark corruptAndSymlinkStateFailsClosed

  request_update "$version_a"
  wait_update "$version_a"
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  websocket_attach_owned_by_gateway "$shell_name" "$shell_baseline"
  mark bundleOnePreservesRuntimes

  request_update "$version_b"
  wait_update "$version_b"
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  websocket_attach_owned_by_gateway "$agent_name" "$agent_baseline"
  mark bundleTwoPreservesRuntimes

  create_session "$current_generation_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  local current_snapshot="${state_root}/current-generation.json"
  wait_snapshot "$current_generation_name" shell "$current_snapshot"
  [ "$(jq -r .generation "$current_snapshot")" = "$(cat /opt/matrix/app/TERMINAL_RUNTIME_GENERATION)" ]
  mark newRuntimesUseCurrentGeneration
  delete_session "$current_generation_name"
  verify_deleted "$current_snapshot"
  delete_session "$current_generation_name"
  mark deleteRemovesExactRuntime
  mark deleteRemovesSocketAndSnapshots
  generation_gc_safe "$(jq -r .generation "$shell_baseline")"
  mark generationGcIsReferenceAndSymlinkSafe
  mark generationRetentionIsBounded

  request_update rollback
  wait_update "$version_a"
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  websocket_attach_owned_by_gateway "$shell_name" "$shell_baseline"
  mark rollbackPreservesRuntimes

  create_session "$post_rollback_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  local post_snapshot="${state_root}/post-rollback.json"
  wait_snapshot "$post_rollback_name" shell "$post_snapshot"
  [ "$(jq -r .generation "$post_snapshot")" = "$(cat /opt/matrix/app/TERMINAL_RUNTIME_GENERATION)" ]
  mark postRollbackRuntimeUsesCompatibleGeneration
  delete_session "$post_rollback_name"
  verify_deleted "$post_snapshot"

  create_session "$limit_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  local limit_snapshot="${state_root}/limit.json" limit_unit
  wait_snapshot "$limit_name" shell "$limit_snapshot"
  limit_unit="$(jq -r .unit "$limit_snapshot")"
  owner_systemctl set-property --runtime "$limit_unit" MemoryMax=1M
  for _ in $(seq 1 60); do
    owner_systemctl is-active --quiet "$limit_unit" || break
    sleep 1
  done
  ! owner_systemctl is-active --quiet "$limit_unit"
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  wait_gateway
  delete_session "$limit_name"
  owner_systemctl reset-failed "$limit_unit" >/dev/null 2>&1 || true
  mark resourceLimitIsolatesFailure

  write_state phase1-ready
}

phase2() {
  trap fail_phase ERR
  [ "$(cat "$state_file")" = reboot-scheduled ]
  write_state phase2-running
  local baseline unit pid old_cgroup
  for baseline in "${state_root}/shell-baseline.json" "${state_root}/agent-baseline.json"; do
    unit="$(jq -r .unit "$baseline")"
    old_cgroup="$(jq -r .cgroup "$baseline")"
    ! owner_systemctl is-active --quiet "$unit"
    [ ! -e "/sys/fs/cgroup${old_cgroup}/cgroup.procs" ]
    [ -f "${descriptor_root}/$(jq -r .runtimeId "$baseline").json" ]
    for pid in "$(jq -r .mainPid "$baseline")" \
      "$(jq -r .zellijServerPid "$baseline")" \
      "$(jq -r .workloadPid "$baseline")"; do
      if [ -r "/proc/${pid}/cgroup" ]; then
        ! grep -F -- "$old_cgroup" "/proc/${pid}/cgroup" >/dev/null
      fi
    done
  done
  if owner_systemctl list-units 'matrix-zellij@*.service' --state=active --no-legend | grep -q .; then
    return 1
  fi
  mark rebootStartsNoRuntime
  ! pgrep -f -- "$loop_script" >/dev/null
  mark rebootCreatesNoReplacementPids

  local size_before size_after
  size_before="$(stat -c %s "$output_file")"
  sleep 3
  size_after="$(stat -c %s "$output_file")"
  [ "$size_after" = "$size_before" ]
  mark rebootProducesNoOutput

  delete_session "$shell_name"
  delete_session "$agent_name"
  remove_hostile_state
  rm -rf -- "$loop_root"
  disable_acceptance_runtime
  wait_gateway
  write_state complete
}

case "$operation" in
  prepare)
    install -d -o root -g root -m 0700 "$root_parent"
    find "$root_parent" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf -- {} +
    rm -rf -- "$state_root"
    install -d -o root -g root -m 0700 "$checks_root"
    install -d -o root -g root -m 0755 "$(dirname "$gateway_dropin")"
    cat >"$gateway_dropin" <<'EOF'
[Service]
Environment=MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=1
EOF
    chmod 0644 "$gateway_dropin"
    systemctl daemon-reload
    write_state prepared
    systemd-run --unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-prepare" \
      --collect --on-active=2 -- /usr/bin/systemctl restart matrix-gateway.service >/dev/null
    echo user_systemd_acceptance_prepare_scheduled
    ;;
  launch)
    [ "$(cat "$state_file")" = prepared ]
    systemd-run --unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-phase1" \
      --collect --no-block --property=Type=exec --property=KillMode=control-group \
      --property=StandardOutput=null --property=StandardError=null \
      -- "$helper_path" phase1 "$head_sha" "$run_nonce" >/dev/null
    echo user_systemd_acceptance_started
    ;;
  status)
    [ -f "$state_file" ] || { echo unavailable; exit 3; }
    cat "$state_file"
    ;;
  reboot)
    [ "$(cat "$state_file")" = phase1-ready ]
    write_state reboot-scheduled
    systemd-run --unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-reboot" \
      --collect --on-active=5 -- /usr/bin/systemctl reboot >/dev/null
    echo user_systemd_acceptance_reboot_scheduled
    ;;
  resume)
    [ "$(cat "$state_file")" = reboot-scheduled ]
    systemd-run --unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-phase2" \
      --collect --no-block --property=Type=exec --property=KillMode=control-group \
      --property=StandardOutput=null --property=StandardError=null \
      -- "$helper_path" phase2 "$head_sha" "$run_nonce" >/dev/null
    echo user_systemd_acceptance_resumed
    ;;
  pack)
    [ "$(cat "$state_file")" = complete ]
    summary="$(/opt/matrix/runtime/node/bin/node --input-type=module - "$checks_root" "$head_sha" <<'NODE'
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
const [root, headSha] = process.argv.slice(2);
const checks = (await readdir(root)).filter((name) => /^[A-Za-z][A-Za-z0-9]+$/.test(name)).sort();
const payload = { schemaVersion: 1, headSha, checks };
payload.summarySha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
process.stdout.write(JSON.stringify(payload));
NODE
    )"
    rm -rf -- "$state_root"
    rm -f -- "$helper_path" "$probe_path"
    printf '%s\n' "$summary"
    ;;
  phase1) phase1 ;;
  phase2) phase2 ;;
esac

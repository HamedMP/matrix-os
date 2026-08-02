#!/usr/bin/env bash
set -Eeuo pipefail

operation="${1:-}"
head_sha="${2:-}"
run_nonce="${3:-}"
preview_version="${4:-}"
if [ "$(id -u)" -ne 0 ] || [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "$run_nonce" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$ ]]; then
  echo "user_systemd_acceptance_invalid_request" >&2
  exit 2
fi
case "$operation" in
  prepare|prepare-worker|launch|status|reboot|resume|pack|phase1|phase2) ;;
  *) echo "user_systemd_acceptance_invalid_request" >&2; exit 2 ;;
esac
if [[ "$operation" == prepare* ]] &&
  { [[ ! "$preview_version" =~ ^v[0-9][A-Za-z0-9._-]{0,126}$ ]] ||
    [[ "$preview_version" != *"-${head_sha:0:7}" ]]; }; then
  echo "user_systemd_acceptance_invalid_request" >&2
  exit 2
fi

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
readonly conflict_id="rt_$(printf '%s\0%s' "$head_sha" "$run_nonce" | sha256sum | cut -c1-32)"
readonly legacy_conflict_id=rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
readonly owner_uid="$(id -u matrix)"
readonly loop_root="${home}/system/terminal-acceptance/${head_sha:0:7}-${run_nonce}"
readonly loop_script="${loop_root}/production-loop.mjs"
readonly output_file="${loop_root}/output"
readonly corrupt_id=rt_cccccccccccccccccccccccccccccccc
readonly symlink_id=rt_dddddddddddddddddddddddddddddddd
readonly generation_symlink="${runtime_root}/generations/gen_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
readonly generation_sentinel="${state_root}/generation-sentinel"
readonly controller_environment_path="${descriptor_root}/hostile-environment-${conflict_id}.json"
readonly legacy_controller_environment_path="${descriptor_root}/hostile-environment.json"
readonly phase1_unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-phase1.service"
readonly prepare_unit="matrix-user-systemd-accept-${head_sha:0:7}-${run_nonce}-prepare.service"
current_progress=initializing
current_state_prefix=phase1-running
current_failure=assertion

write_state() {
  install -d -o root -g root -m 0700 "$state_root"
  local next="${state_file}.next"
  printf '%s\n' "$1" >"$next"
  chmod 0600 "$next"
  mv -f -- "$next" "$state_file"
}

write_progress() {
  local progress="$1"
  [[ "$progress" =~ ^[a-z][a-z0-9-]{0,63}$ ]]
  current_progress="$progress"
  current_failure=assertion
  write_state "${current_state_prefix}:${current_progress}"
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

cleanup_controller_runtime() {
  local runtime_id
  for runtime_id in "$conflict_id" "$legacy_conflict_id"; do
    owner_systemctl stop "matrix-zellij@${runtime_id}.service" >/dev/null 2>&1 || true
    owner_systemctl reset-failed "matrix-zellij@${runtime_id}.service" >/dev/null 2>&1 || true
    rm -f -- "${descriptor_root}/${runtime_id}.json"
  done
  rm -f -- "$controller_environment_path" "$legacy_controller_environment_path"
}

list_stale_acceptance_runtimes() {
  python3 - "$descriptor_root" <<'PY'
import errno
import json
import os
import re
import stat
import sys

root = sys.argv[1]
try:
    with os.scandir(root) as scanner:
        entries = sorted(scanner, key=lambda entry: entry.name)
except FileNotFoundError:
    raise SystemExit(0)
if len(entries) > 512:
    raise SystemExit(1)
runtime_pattern = re.compile(r"rt_[0-9a-f]{32}")
for entry in entries:
    if runtime_pattern.fullmatch(entry.name.removesuffix(".json")) is None or not entry.name.endswith(".json"):
        continue
    try:
        descriptor_fd = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ELOOP):
            continue
        raise
    descriptor_stat = os.fstat(descriptor_fd)
    if not stat.S_ISREG(descriptor_stat.st_mode) or descriptor_stat.st_size > 64 * 1024:
        os.close(descriptor_fd)
        continue
    try:
        with os.fdopen(descriptor_fd, encoding="utf-8") as source:
            descriptor = json.load(source)
    except (json.JSONDecodeError, UnicodeDecodeError):
        continue
    runtime_id = descriptor.get("runtimeId") if isinstance(descriptor, dict) else None
    display_name = descriptor.get("displayName") if isinstance(descriptor, dict) else None
    if runtime_id != entry.name.removesuffix(".json") or not isinstance(display_name, str):
        continue
    if (
        re.fullmatch(r"u-[sadlpc]-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}", display_name) is None
        and display_name != "acceptance-conflict-a"
    ):
        continue
    if descriptor.get("scope") != "terminal" or descriptor.get("sessionName") != f"matrix-{runtime_id}":
        continue
    print(f"{runtime_id}\t{display_name}")
PY
}

cleanup_stale_acceptance_runtimes() {
  local inventory="${state_root}/stale-acceptance-runtimes" runtime_id display_name unit
  install -m 0600 /dev/null "$inventory"
  list_stale_acceptance_runtimes >"$inventory"
  while IFS=$'\t' read -r runtime_id display_name; do
    [ -n "$runtime_id" ] && [ -n "$display_name" ] || continue
    unit="matrix-zellij@${runtime_id}.service"
    delete_session "$display_name" >/dev/null 2>&1 || true
    owner_systemctl stop "$unit" >/dev/null 2>&1 || true
    owner_systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    rm -f -- "${descriptor_root}/${runtime_id}.json"
    rm -f -- "${home}/system/zellij/runtime-layouts/${runtime_id}.kdl"
    if [ -d "/run/user/${owner_uid}/zellij" ]; then
      find "/run/user/${owner_uid}/zellij" -maxdepth 1 -type s -name "matrix-${runtime_id}*" -delete
    fi
    ! owner_systemctl is-active --quiet "$unit"
    [ ! -e "${descriptor_root}/${runtime_id}.json" ]
  done <"$inventory"
  rm -f -- "$inventory"
}

diagnose_controller_failure() {
  local controller_status="$1" descriptor_path="${descriptor_root}/${conflict_id}.json"
  local descriptor_state=missing unit="matrix-zellij@${conflict_id}.service"
  local unit_result exec_status keeper_code
  if [ -L "$descriptor_path" ]; then
    descriptor_state=symlink
  elif [ -f "$descriptor_path" ]; then
    descriptor_state=present
  elif [ -e "$descriptor_path" ]; then
    descriptor_state=invalid
  fi
  unit_result="$(owner_systemctl show "$unit" -p Result --value 2>/dev/null || true)"
  exec_status="$(owner_systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || true)"
  keeper_code="$({
    runuser -u matrix -- env \
      HOME="$home" MATRIX_HOME="$home" \
      XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
      journalctl --user -u "$unit" --no-pager -n 20 -o cat 2>/dev/null || true
  } | sed -n 's/^matrix-terminal-user-keeper: \([a-z][a-z_]*\)$/\1/p' | tail -n 1)"
  [[ "$unit_result" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || unit_result=unknown
  [[ "$exec_status" =~ ^[0-9]{1,3}$ ]] || exec_status=unknown
  [[ "$keeper_code" =~ ^[a-z][a-z_]{0,63}$ ]] || keeper_code=unknown
  keeper_code="${keeper_code//_/-}"
  current_failure="${controller_status}-descriptor-${descriptor_state}-unit-${unit_result}-exit-${exec_status}-keeper-${keeper_code}"
}

json_field() {
  python3 - "$1" "$2" <<'PY'
import json
import os
import stat
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(descriptor).st_mode):
    os.close(descriptor)
    raise SystemExit(1)
with os.fdopen(descriptor, encoding="utf-8") as source:
    value = json.load(source).get(sys.argv[2])
if value is None:
    value = ""
if not isinstance(value, (str, int)):
    raise SystemExit(1)
print(value)
PY
}

json_error_code() {
  python3 - "$1" <<'PY'
import json
import os
import stat
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(descriptor).st_mode):
    os.close(descriptor)
    raise SystemExit(1)
with os.fdopen(descriptor, encoding="utf-8") as source:
    payload = json.load(source)
value = payload.get("error", {}).get("code", "")
if not isinstance(value, str):
    raise SystemExit(1)
print(value)
PY
}

json_session_body() {
  python3 - "$@" <<'PY'
import json
import sys

name, command, *agent = sys.argv[1:]
payload = {"name": name, "cmd": command}
if agent:
    payload["agent"] = agent[0]
print(json.dumps(payload, separators=(",", ":")))
PY
}

json_pressure_body() {
  python3 - <<'PY'
import json

payload = {
    "command": [
        "/opt/matrix/runtime/node/bin/node",
        "-e",
        "const b=Buffer.alloc(32*1024*1024,1);setTimeout(()=>{},1000)",
    ],
    "timeoutMs": 5000,
}
print(json.dumps(payload, separators=(",", ":")))
PY
}

json_roles_match() {
  python3 - "$1" "$2" <<'PY'
import json
import os
import stat
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(descriptor).st_mode):
    os.close(descriptor)
    raise SystemExit(1)
with os.fdopen(descriptor, encoding="utf-8") as source:
    before = json.load(source)
after = json.loads(sys.argv[2])
fields = (
    "runtimeId", "generation", "unit", "cgroup", "mainPid",
    "zellijServerPid", "workloadPid",
)
if any(before.get(field) != after.get(field) for field in fields):
    raise SystemExit(1)
PY
}

json_runtime_id_for_name() {
  python3 - "$1" "$2" <<'PY'
import json
import os
import re
import stat
import sys

descriptor_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
if not stat.S_ISREG(os.fstat(descriptor_fd).st_mode):
    os.close(descriptor_fd)
    raise SystemExit(1)
with os.fdopen(descriptor_fd, encoding="utf-8") as source:
    descriptor = json.load(source)
runtime_id = descriptor.get("runtimeId")
if descriptor.get("displayName") != sys.argv[2] or not isinstance(runtime_id, str):
    raise SystemExit(1)
if re.fullmatch(r"rt_[0-9a-f]{32}", runtime_id) is None:
    raise SystemExit(1)
print(runtime_id)
PY
}

read_probe_status() {
  python3 - "$1" <<'PY'
import os
import re
import stat
import sys

status_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
status_stat = os.fstat(status_fd)
if not stat.S_ISREG(status_stat.st_mode) or status_stat.st_size > 128:
    os.close(status_fd)
    raise SystemExit(1)
with os.fdopen(status_fd, encoding="utf-8") as source:
    value = source.read().strip()
if re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value) is None:
    raise SystemExit(1)
print(value.replace("_", "-"))
PY
}

read_probe_diagnostic() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

diagnostic_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
diagnostic_stat = os.fstat(diagnostic_fd)
if not stat.S_ISREG(diagnostic_stat.st_mode) or diagnostic_stat.st_size > 512:
    os.close(diagnostic_fd)
    raise SystemExit(1)
with os.fdopen(diagnostic_fd, encoding="utf-8") as source:
    lines = set(source.read().splitlines())
allowed = (
    "production_probe_status_write_failed",
    "production_probe_ready_write_failed",
    "production_probe_invalid_request",
    "production_probe_runtime_unavailable",
    "production_probe_attach_failed",
    "production_probe_status_write_non_error",
    "production_probe_ready_write_non_error",
    "production_probe_message_parse_non_syntax_error",
    "production_probe_uncaught_non_error",
    "production_probe_rejection_non_error",
)
for candidate in allowed:
    if candidate in lines:
        print(candidate.replace("_", "-"))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

read_controller_diagnostic() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

diagnostic_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
diagnostic_stat = os.fstat(diagnostic_fd)
if not stat.S_ISREG(diagnostic_stat.st_mode) or diagnostic_stat.st_size > 2048:
    os.close(diagnostic_fd)
    raise SystemExit(1)
with os.fdopen(diagnostic_fd, encoding="utf-8") as source:
    lines = source.read().splitlines()
allowed = {
    "hostile-controller-invalid-runtime-id",
    "hostile-controller-invalid-cwd",
    "hostile-controller-create",
    "hostile-controller-create-invalid-request",
    "hostile-controller-create-identity-exists",
    "hostile-controller-create-unavailable",
    "hostile-controller-create-unexpected-error",
    "hostile-controller-conflicting-descriptor-reuse",
    "hostile-controller-inactive-restart",
    "hostile-controller-inactive-stop",
    "hostile-controller-inactive-start",
    "hostile-controller-inactive-identity",
    "hostile-controller-inactive-restop",
    "hostile-controller-descriptor-reject",
    "hostile-controller-unit-descriptor-reject",
    "hostile-controller-unit-environment-reject",
    "hostile-controller-idempotent-delete",
    "hostile-controller-non-error",
}
for candidate in reversed(lines):
    if candidate in allowed:
        print(candidate)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

load_host_auth() {
  local line token
  current_failure=auth-env-missing
  if ! line="$(grep -m1 '^MATRIX_AUTH_TOKEN=' /opt/matrix/env/host.env)"; then
    return 1
  fi
  token="${line#MATRIX_AUTH_TOKEN=}"
  current_failure=auth-token-invalid
  if [[ ! "$token" =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]]; then
    return 1
  fi
  export MATRIX_AUTH_TOKEN="$token"
}

diagnose_api_transport() {
  local curl_status="$1" gateway_pid_before="$2" curl_state=other
  local gateway_pid_after pid_state=unknown gateway_state=inactive health_state=failed
  local gateway_result gateway_exec_status gateway_restarts
  case "$curl_status" in
    5) curl_state=proxy-dns ;;
    6) curl_state=dns ;;
    7) curl_state=connect ;;
    23) curl_state=write ;;
    28) curl_state=timeout ;;
    52) curl_state=empty-reply ;;
    55) curl_state=send ;;
    56) curl_state=receive ;;
  esac
  gateway_pid_after="$(systemctl show matrix-gateway.service -p MainPID --value 2>/dev/null || true)"
  if [[ "$gateway_pid_before" =~ ^[1-9][0-9]*$ ]] && [[ "$gateway_pid_after" =~ ^[1-9][0-9]*$ ]]; then
    if [ "$gateway_pid_before" = "$gateway_pid_after" ]; then
      pid_state=same
    else
      pid_state=changed
    fi
  fi
  if systemctl is-active --quiet matrix-gateway.service; then
    gateway_state=active
  elif systemctl is-failed --quiet matrix-gateway.service; then
    gateway_state=failed
  fi
  if curl --fail --silent --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1; then
    health_state=ok
  fi
  gateway_result="$(systemctl show matrix-gateway.service -p Result --value 2>/dev/null || true)"
  case "$gateway_result" in
    success|resources|protocol|timeout|exit-code|signal|core-dump|watchdog|start-limit-hit|oom-kill|exec-condition) ;;
    *) gateway_result=unknown ;;
  esac
  gateway_exec_status="$(systemctl show matrix-gateway.service -p ExecMainStatus --value 2>/dev/null || true)"
  [[ "$gateway_exec_status" =~ ^[0-9]{1,3}$ ]] || gateway_exec_status=unknown
  gateway_restarts="$(systemctl show matrix-gateway.service -p NRestarts --value 2>/dev/null || true)"
  [[ "$gateway_restarts" =~ ^[0-9]{1,6}$ ]] || gateway_restarts=unknown
  current_failure="api-transport-${curl_state}-gateway-pid-${pid_state}-gateway-${gateway_state}-health-${health_state}-result-${gateway_result}-exit-${gateway_exec_status}-restarts-${gateway_restarts}"
}

api_call() {
  local method="$1" path="$2" body="${3:-}" expected="${4:-200}"
  local response="${state_root}/api-response.json" code safe_code curl_status gateway_pid_before
  load_host_auth
  current_failure=api-transport
  gateway_pid_before="$(systemctl show matrix-gateway.service -p MainPID --value 2>/dev/null || true)"
  if [ -n "$body" ]; then
    if code="$(curl --silent --show-error --max-time 45 -o "$response" -w '%{http_code}' \
      -X "$method" "http://127.0.0.1:4000${path}" \
      -H "authorization: Bearer ${MATRIX_AUTH_TOKEN}" \
      -H 'content-type: application/json' --data-binary "$body")"; then
      :
    else
      curl_status=$?
      diagnose_api_transport "$curl_status" "$gateway_pid_before"
      return 1
    fi
  else
    if code="$(curl --silent --show-error --max-time 45 -o "$response" -w '%{http_code}' \
      -X "$method" "http://127.0.0.1:4000${path}" \
      -H "authorization: Bearer ${MATRIX_AUTH_TOKEN}")"; then
      :
    else
      curl_status=$?
      diagnose_api_transport "$curl_status" "$gateway_pid_before"
      return 1
    fi
  fi
  if [ "$code" != "$expected" ]; then
    safe_code="$(json_error_code "$response" 2>/dev/null || true)"
    if [[ ! "$safe_code" =~ ^[a-z][a-z0-9_]{0,63}$ ]]; then safe_code=unknown; fi
    safe_code="${safe_code//_/-}"
    current_failure="api-http-${code}-${safe_code}"
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
  current_failure=request-body-invalid
  if [ -n "$agent" ]; then
    if ! body="$(json_session_body "$name" "$command" "$agent")"; then
      return 1
    fi
  else
    if ! body="$(json_session_body "$name" "$command")"; then
      return 1
    fi
  fi
  api_call POST /api/terminal/sessions "$body" 201
}

delete_session() {
  api_call DELETE "/api/terminal/sessions/$1?force=1" "" 200
}

snapshot() {
  local snapshot_status="${3:-/dev/null}"
  /usr/bin/timeout --signal=KILL 15 \
    /opt/matrix/runtime/node/bin/node "$probe_path" snapshot "$1" "$2" 2>"$snapshot_status"
}

wait_snapshot() {
  local name="$1" kind="$2" target="$3" current="" probe_status=unknown
  local snapshot_status="${target}.status"
  for _ in $(seq 1 30); do
    rm -f -- "$snapshot_status"
    if current="$(snapshot "$name" "$kind" "$snapshot_status")"; then
      printf '%s\n' "$current" >"$target"
      chmod 0600 "$target"
      rm -f -- "$snapshot_status"
      return 0
    fi
    sleep 1
  done
  probe_status="$(read_probe_status "$snapshot_status" 2>/dev/null || true)"
  [ -n "$probe_status" ] || probe_status=timeout
  [[ "$probe_status" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || probe_status=unknown
  current_failure="snapshot-${probe_status}"
  rm -f -- "$snapshot_status"
  return 1
}

roles_match() {
  local name="$1" kind="$2" baseline="$3" current
  current="$(snapshot "$name" "$kind")"
  json_roles_match "$baseline" "$current"
}

websocket_attach_owned_by_gateway() {
  local name="$1" snapshot_file="$2" runtime_id session_name gateway_cgroup ready status client_pid found=0
  local attach_status=unknown attach_diagnostic
  runtime_id="$(json_field "$snapshot_file" runtimeId)"
  session_name="$(json_field "$snapshot_file" sessionName)"
  gateway_cgroup="$(systemctl show matrix-gateway.service -p ControlGroup --value)"
  ready="${loop_root}/ws-${runtime_id}.ready"
  status="${ready}.status"
  attach_diagnostic="${state_root}/attach-${runtime_id}.diagnostic"
  rm -f -- "$ready" "$status"
  install -m 0600 /dev/null "$attach_diagnostic"
  load_host_auth
  runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" MATRIX_AUTH_TOKEN="$MATRIX_AUTH_TOKEN" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    /opt/matrix/runtime/node/bin/node "$probe_path" attach "$name" unused "$ready" \
    >/dev/null 2>"$attach_diagnostic" &
  client_pid=$!
  current_failure=attachment-ready-timeout
  for _ in $(seq 1 30); do
    [ -f "$ready" ] && break
    kill -0 "$client_pid" >/dev/null 2>&1 || break
    sleep 1
  done
  if [ ! -f "$ready" ]; then
    kill "$client_pid" >/dev/null 2>&1 || true
    wait "$client_pid" >/dev/null 2>&1 || true
    attach_status="$(read_probe_status "$status" 2>/dev/null || true)"
    if [[ ! "$attach_status" =~ ^[a-z][a-z0-9-]{0,63}$ ]]; then
      attach_status="$(read_probe_diagnostic "$attach_diagnostic" 2>/dev/null || true)"
    fi
    [[ "$attach_status" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || attach_status=unknown
    current_failure="attachment-ready-${attach_status}"
    rm -f -- "$ready" "$status" "$attach_diagnostic"
    return 1
  fi
  local proc pid cmdline cgroup
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    cmdline="$(tr '\0' ' ' <"$proc/cmdline")"
    [[ "$cmdline" == *"/zellij attach ${session_name}"* ]] || continue
    pid="${proc#/proc/}"
    cgroup="$(awk -F: '$1 == "0" { print $3 }' "$proc/cgroup")"
    current_failure=attachment-cgroup-mismatch
    if [ "$cgroup" != "$gateway_cgroup" ] ||
      [ "$cgroup" = "$(json_field "$snapshot_file" cgroup)" ]; then
      kill "$client_pid" >/dev/null 2>&1 || true
      wait "$client_pid" >/dev/null 2>&1 || true
      rm -f -- "$ready" "$status" "$attach_diagnostic"
      return 1
    fi
    found=$((found + 1))
  done
  current_failure=attachment-process-missing
  if [ "$found" -lt 1 ]; then
    kill "$client_pid" >/dev/null 2>&1 || true
    wait "$client_pid" >/dev/null 2>&1 || true
    rm -f -- "$ready" "$status" "$attach_diagnostic"
    return 1
  fi
  current_failure=attachment-client-exit
  if ! wait "$client_pid"; then return 1; fi
  rm -f -- "$ready" "$status" "$attach_diagnostic"
  current_failure=attachment-runtime-continuity
  roles_match "$name" "$(json_field "$snapshot_file" workloadKind)" "$snapshot_file"
}

verify_gateway_memory_isolation() {
  local shell_baseline="$1" agent_baseline="$2" gateway_cgroup memory_max memory_current memory_high target_high body pressure_status=0
  gateway_cgroup="$(systemctl show matrix-gateway.service -p ControlGroup --value)"
  memory_max="$(systemctl show matrix-gateway.service -p MemoryMax --value)"
  memory_current="$(systemctl show matrix-gateway.service -p MemoryCurrent --value)"
  memory_high="$(systemctl show matrix-gateway.service -p MemoryHigh --value)"
  [[ "$memory_max" =~ ^[1-9][0-9]*$ ]]
  [[ "$memory_current" =~ ^[0-9]+$ ]]
  [ "$(json_field "$shell_baseline" cgroup)" != "$gateway_cgroup" ]
  [ "$(json_field "$agent_baseline" cgroup)" != "$gateway_cgroup" ]
  grep -qw memory "/sys/fs/cgroup${gateway_cgroup%/*}/cgroup.controllers"
  target_high=$((memory_current + 16 * 1024 * 1024))
  systemctl set-property --runtime matrix-gateway.service "MemoryHigh=${target_high}"
  body="$(json_pressure_body)"
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
    cgroup="$(json_field "$baseline" cgroup)"
    memory_max="$(json_field "$baseline" memoryMax)"
    tasks_max="$(json_field "$baseline" tasksMax)"
    [ "$(cat "/sys/fs/cgroup${cgroup}/memory.max")" = "$memory_max" ]
    [ "$(cat "/sys/fs/cgroup${cgroup}/pids.max")" = "$tasks_max" ]
  done
  slice_cgroup="$(json_field "$1" sliceCgroup)"
  slice_memory_max="$(json_field "$1" sliceMemoryMax)"
  slice_tasks_max="$(json_field "$1" sliceTasksMax)"
  [ "$(cat "/sys/fs/cgroup${slice_cgroup}/memory.max")" = "$slice_memory_max" ]
  [ "$(cat "/sys/fs/cgroup${slice_cgroup}/pids.max")" = "$slice_tasks_max" ]
  grep -qw memory "/sys/fs/cgroup${slice_cgroup}/cgroup.controllers"
  grep -qw pids "/sys/fs/cgroup${slice_cgroup}/cgroup.controllers"
}

run_controller_adversarial_checks() {
  local layout_path="${home}/system/zellij/layouts/matrix.kdl"
  local controller_diagnostic="${state_root}/hostile-controller.diagnostic" controller_status
  cleanup_controller_runtime
  install -m 0600 /dev/null "$controller_diagnostic"
  if ! runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    /opt/matrix/runtime/node/bin/node --input-type=module - \
    "$home" "$conflict_id" "$layout_path" "$controller_environment_path" \
    2>"$controller_diagnostic" <<'NODE'
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  createUserSystemdTerminalRuntime,
  loadInstalledTerminalRuntimeGeneration,
} from "/opt/matrix/app/packages/gateway/dist/shell/user-systemd-terminal-runtime.js";

const execFileAsync = promisify(execFile);
const [homePath, runtimeId, layoutPath, environmentPath] = process.argv.slice(2);
const progress = (stage) => process.stderr.write(`${stage}\n`);
async function mustReject(operation) {
  let rejected = false;
  try { await operation(); } catch (error) {
    if (!(error instanceof Error)) throw error;
    rejected = true;
  }
  if (!rejected) process.exit(1);
}
try {
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
  progress("hostile-controller-invalid-runtime-id");
  await mustReject(() => runtime.create({ ...base, runtimeId: "../../matrix-gateway" }));
  progress("hostile-controller-invalid-cwd");
  await mustReject(() => runtime.create({ ...base, cwd: "/etc" }));
  progress("hostile-controller-create");
  let created;
  try {
    created = await runtime.create(base);
  } catch (error) {
    const safeCreateFailures = new Map([
      ["InvalidTerminalRuntimeRequestError", "invalid-request"],
      ["TerminalRuntimeIdentityExistsError", "identity-exists"],
      ["TerminalRuntimeUnavailableError", "unavailable"],
    ]);
    const safeCreateFailure = error instanceof Error
      ? (safeCreateFailures.get(error.name) ?? "unexpected-error")
      : "unexpected-error";
    progress(`hostile-controller-create-${safeCreateFailure}`);
    throw error;
  }
  progress("hostile-controller-conflicting-descriptor-reuse");
  await mustReject(() => runtime.create({ ...base, displayName: "acceptance-conflict-b" }));
  progress("hostile-controller-inactive-restart");
  progress("hostile-controller-inactive-stop");
  await execFileAsync("systemctl", ["--user", "stop", `matrix-zellij@${runtimeId}.service`]);
  progress("hostile-controller-inactive-start");
  const restarted = await runtime.start(runtimeId);
  progress("hostile-controller-inactive-identity");
  if (restarted.runtimeId !== created.runtimeId || restarted.sessionName !== created.sessionName) process.exit(1);
  progress("hostile-controller-inactive-restop");
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
  progress("hostile-controller-descriptor-reject");
  await mustReject(() => runtime.start(runtimeId));
  progress("hostile-controller-unit-descriptor-reject");
  try {
    await execFileAsync("systemctl", ["--user", "start", `matrix-zellij@${runtimeId}.service`]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await mustReject(() => execFileAsync("systemctl", ["--user", "is-active", `matrix-zellij@${runtimeId}.service`]));
  await execFileAsync("systemctl", ["--user", "reset-failed", `matrix-zellij@${runtimeId}.service`]);
  await writeFile(environmentPath, `${JSON.stringify({ LD_PRELOAD: "/tmp/hostile.so" })}\n`, { mode: 0o600 });
  await writeFile(descriptorPath, `${JSON.stringify({ ...descriptor, environmentPath })}\n`, { mode: 0o600 });
  progress("hostile-controller-unit-environment-reject");
  try {
    await execFileAsync("systemctl", ["--user", "start", `matrix-zellij@${runtimeId}.service`]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await mustReject(() => execFileAsync("systemctl", ["--user", "is-active", `matrix-zellij@${runtimeId}.service`]));
  await rm(environmentPath, { force: true });
  await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  progress("hostile-controller-idempotent-delete");
  await runtime.delete(runtimeId);
  await runtime.delete(runtimeId);
} catch (error) {
  if (!(error instanceof Error)) progress("hostile-controller-non-error");
  process.exit(1);
}
NODE
  then
    controller_status="$(read_controller_diagnostic "$controller_diagnostic" 2>/dev/null || true)"
    current_failure="${controller_status:-hostile-controller-runtime-unavailable}"
    diagnose_controller_failure "$current_failure"
    rm -f -- "$controller_diagnostic"
    return 1
  fi
  rm -f -- "$controller_diagnostic"
}

request_update() {
  rm -f -- /opt/matrix/app/.update-error.json
  runuser -u matrix -- /opt/matrix/bin/matrix-update --no-tail "$1" >/dev/null
}

read_update_error_code() {
  python3 - /opt/matrix/app/.update-error.json <<'PY'
import json
import os
import re
import stat
import sys

error_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
error_stat = os.fstat(error_fd)
if not stat.S_ISREG(error_stat.st_mode) or error_stat.st_size > 2048:
    os.close(error_fd)
    raise SystemExit(1)
with os.fdopen(error_fd, encoding="utf-8") as source:
    code = json.load(source).get("code")
if not isinstance(code, str) or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) is None:
    raise SystemExit(1)
print(code)
PY
}

read_update_phase() {
  python3 - /opt/matrix/staging/update-phase <<'PY'
import os
import stat
import sys

phase_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
phase_stat = os.fstat(phase_fd)
if not stat.S_ISREG(phase_stat.st_mode) or phase_stat.st_size > 64:
    os.close(phase_fd)
    raise SystemExit(1)
with os.fdopen(phase_fd, encoding="utf-8") as source:
    phase = source.read().strip()
allowed = {"prepare", "download", "verify", "extract", "terminal-runtime", "app-install", "host-bin", "health"}
if phase not in allowed:
    raise SystemExit(1)
print(phase)
PY
}

read_update_target() {
  python3 - /opt/matrix/app/.update-version <<'PY'
import os, re, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_size > 128:
    os.close(fd); raise SystemExit(1)
with os.fdopen(fd, encoding="utf-8") as source:
    value = source.read().strip()
if re.fullmatch(r"v[0-9][A-Za-z0-9._-]{0,126}", value) is None:
    raise SystemExit(1)
print(value)
PY
}

read_update_manifest_version() {
  python3 - /opt/matrix/app/.update-available.json <<'PY'
import json, os, re, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
    os.close(fd); raise SystemExit(1)
with os.fdopen(fd, encoding="utf-8") as source:
    value = json.load(source).get("version")
if not isinstance(value, str) or re.fullmatch(r"v[0-9][A-Za-z0-9._-]{0,126}", value) is None:
    raise SystemExit(1)
print(value)
PY
}

path_state() {
  local path="$1"
  if [ -L "$path" ]; then
    echo symlink
  elif [ -f "$path" ]; then
    echo present
  elif [ -e "$path" ]; then
    echo invalid
  else
    echo missing
  fi
}

installed_bounded_updater_is_ready() {
  local updater=/opt/matrix/bin/matrix-sync-agent
  [ -f "$updater" ] && [ ! -L "$updater" ] && [ -x "$updater" ] &&
    grep -Fq '/usr/bin/timeout --signal=KILL 1800 curl' "$updater"
}

classify_installed_updater_protocol() {
  local updater=/opt/matrix/bin/matrix-sync-agent
  if ! installed_bounded_updater_is_ready; then
    echo invalid
  elif grep -Fq 'run_apply_update explicit' "$updater" &&
    grep -Fq 'if [ "$trigger_source" = explicit ]; then' "$updater" &&
    grep -Fq 'write_update_error "update_target_mismatch"' "$updater"; then
    echo durable
  else
    echo legacy
  fi
}

classify_updater_phase() {
  local updater_state=other phase=idle main_pid current child comm index=0 inspected=0
  local -a queue
  if installed_bounded_updater_is_ready; then updater_state=bounded; fi
  main_pid="$(systemctl show matrix-sync-agent.service -p MainPID --value 2>/dev/null || true)"
  if [[ ! "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "${updater_state}-inactive"
    return 0
  fi
  queue=("$main_pid")
  while [ "$index" -lt "${#queue[@]}" ] && [ "$inspected" -lt 64 ]; do
    current="${queue[$index]}"
    index=$((index + 1))
    inspected=$((inspected + 1))
    comm="$(cat "/proc/${current}/comm" 2>/dev/null || true)"
    case "$comm" in
      timeout|curl) [ "$phase" != idle ] || phase=download ;;
      sha256sum) phase=verify ;;
      gzip|tar) phase=extract ;;
      chown|cp|install|mv) phase=install ;;
    esac
    while IFS= read -r child; do
      [[ "$child" =~ ^[1-9][0-9]*$ ]] && queue+=("$child")
    done < <(pgrep -P "$current" 2>/dev/null || true)
  done
  echo "${updater_state}-${phase}"
}

classify_update_bundle() {
  local expected="$1" bundle="/opt/matrix/staging/bundle-${expected}.tar.gz"
  local extracted="/opt/matrix/staging/bundle-${expected}" state
  state="$(path_state "$bundle")"
  if [ -L "$extracted" ]; then
    state="${state}-extract-symlink"
  elif [ -d "$extracted" ]; then
    state="${state}-extract-present"
  elif [ -e "$extracted" ]; then
    state="${state}-extract-invalid"
  fi
  echo "$state"
}

diagnose_update_failure() {
  local expected="$1" version_state=missing trigger_state manifest_state error_code=none update_phase=missing
  local target_state target updater_protocol updater_state bundle_state sync_state=inactive gateway_state=inactive health_state=failed installed
  local manifest_version sync_result sync_exit sync_restarts
  if [ -f /opt/matrix/app/BUNDLE_VERSION ] && [ ! -L /opt/matrix/app/BUNDLE_VERSION ]; then
    installed="$(cat /opt/matrix/app/BUNDLE_VERSION 2>/dev/null || true)"
    if [ "$installed" = "$expected" ]; then
      version_state=expected
    elif [[ "$installed" =~ ^v[0-9][A-Za-z0-9._-]{0,126}$ ]]; then
      version_state=other
    else
      version_state=invalid
    fi
  elif [ -e /opt/matrix/app/BUNDLE_VERSION ] || [ -L /opt/matrix/app/BUNDLE_VERSION ]; then
    version_state=invalid
  fi
  trigger_state="$(path_state /opt/matrix/app/.update-now)"
  manifest_state="$(path_state /opt/matrix/app/.update-available.json)"
  target_state="$(path_state /opt/matrix/app/.update-version)"
  if [ "$target_state" = present ]; then
    target="$(read_update_target 2>/dev/null || true)"
    if [ "$target" = "$expected" ]; then target_state=expected
    elif [ -n "$target" ]; then target_state=other
    else target_state=invalid
    fi
  fi
  if [ "$manifest_state" = present ]; then
    manifest_version="$(read_update_manifest_version 2>/dev/null || true)"
    if [ "$manifest_version" = "$expected" ]; then manifest_state=expected
    elif [ -n "$manifest_version" ]; then manifest_state=other
    else manifest_state=invalid
    fi
  fi
  if [ -e /opt/matrix/app/.update-error.json ] || [ -L /opt/matrix/app/.update-error.json ]; then
    error_code="$(read_update_error_code 2>/dev/null || true)"
    case "$error_code" in
      download_failed|download_metadata_changed|update_target_mismatch|insufficient_disk_space|checksum_mismatch|bundle_extract_failed|bundle_layout_invalid|terminal_runtime_install_failed|post_install_host_bin_failed|post_install_service_start_failed|post_install_health_failed|post_install_rollback_failed|apply_failed|apply_interrupted|unknown) ;;
      *) error_code=unknown ;;
    esac
  fi
  if [ -e /opt/matrix/staging/update-phase ] || [ -L /opt/matrix/staging/update-phase ]; then
    update_phase="$(read_update_phase 2>/dev/null || true)"
    [ -n "$update_phase" ] || update_phase=invalid
  fi
  if systemctl is-active --quiet matrix-sync-agent.service; then
    sync_state=active
  elif systemctl is-failed --quiet matrix-sync-agent.service; then
    sync_state=failed
  fi
  if systemctl is-active --quiet matrix-gateway.service; then gateway_state=active; fi
  if curl --fail --silent --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1; then
    health_state=ok
  fi
  updater_state="$(classify_updater_phase)"
  updater_protocol="$(classify_installed_updater_protocol)"
  bundle_state="$(classify_update_bundle "$expected")"
  sync_result="$(systemctl show matrix-sync-agent.service -p Result --value 2>/dev/null || true)"
  case "$sync_result" in success|resources|protocol|timeout|exit-code|signal|core-dump|watchdog|start-limit-hit|oom-kill|exec-condition) ;; *) sync_result=unknown ;; esac
  sync_exit="$(systemctl show matrix-sync-agent.service -p ExecMainStatus --value 2>/dev/null || true)"
  [[ "$sync_exit" =~ ^[0-9]{1,3}$ ]] || sync_exit=unknown
  sync_restarts="$(systemctl show matrix-sync-agent.service -p NRestarts --value 2>/dev/null || true)"
  [[ "$sync_restarts" =~ ^[0-9]{1,6}$ ]] || sync_restarts=unknown
  current_failure="update-${version_state}-target-${target_state}-trigger-${trigger_state}-manifest-${manifest_state}-error-${error_code}-phase-${update_phase}-protocol-${updater_protocol}-updater-${updater_state}-bundle-${bundle_state}-sync-${sync_state}-result-${sync_result}-exit-${sync_exit}-restarts-${sync_restarts}-gateway-${gateway_state}-health-${health_state}"
}

wait_update() {
  local expected="$1" update_mode="${2:-explicit}" deadline=$((SECONDS + 5400)) error_code=none
  local explicit_update_idle_ticks=0 updater_state
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(cat /opt/matrix/app/BUNDLE_VERSION 2>/dev/null || true)" = "$expected" ] &&
      [ ! -e /opt/matrix/app/.update-now ] &&
      systemctl is-active --quiet matrix-gateway.service &&
      curl --fail --silent --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1; then
      return 0
    fi
    if [ ! -e /opt/matrix/app/.update-now ] && [ ! -L /opt/matrix/app/.update-now ] &&
      { [ -e /opt/matrix/app/.update-error.json ] || [ -L /opt/matrix/app/.update-error.json ]; }; then
      error_code="$(read_update_error_code 2>/dev/null || true)"
      case "$error_code" in
        download_failed|download_metadata_changed|update_target_mismatch|insufficient_disk_space|checksum_mismatch|bundle_extract_failed|bundle_layout_invalid|terminal_runtime_install_failed|post_install_host_bin_failed|post_install_service_start_failed|post_install_health_failed|post_install_rollback_failed|apply_failed|apply_interrupted|unknown) ;;
        *) error_code=unknown ;;
      esac
      if [ "$error_code" != none ]; then
        diagnose_update_failure "$expected"
        return 1
      fi
    fi
    if [ "$update_mode" = explicit ] &&
      [ "$(path_state /opt/matrix/app/.update-now)" = missing ] &&
      [ "$(path_state /opt/matrix/staging/update-phase)" = missing ] &&
      [ "$(path_state /opt/matrix/app/.update-error.json)" = missing ]; then
      updater_state="$(classify_updater_phase)"
      if [[ "$updater_state" == *-idle ]]; then
        explicit_update_idle_ticks=$((explicit_update_idle_ticks + 1))
        if [ "$explicit_update_idle_ticks" -ge 60 ]; then
          diagnose_update_failure "$expected"
          return 1
        fi
      else
        explicit_update_idle_ticks=0
      fi
    else
      explicit_update_idle_ticks=0
    fi
    sleep 1
  done
  diagnose_update_failure "$expected"
  return 1
}

installed_terminal_runtime_is_ready() {
  local marker=/opt/matrix/app/TERMINAL_RUNTIME_GENERATION generation generation_dir
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  generation="$(cat "$marker")"
  [[ "$generation" =~ ^gen_[0-9a-f]{64}$ ]] || return 1
  generation_dir="${runtime_root}/generations/${generation}"
  [ -d "$generation_dir" ] && [ ! -L "$generation_dir" ] || return 1
  [ "$(/opt/matrix/bin/matrix-terminal-generation-id \
    "$generation_dir/zellij" \
    "$generation_dir/matrix-terminal-user-keeper.mjs" \
    "$generation_dir/matrix-terminal-attach.mjs")" = "$generation" ] || return 1
  runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    "$generation_dir/zellij" --version >/dev/null 2>&1
}

fail_prepare() {
  local status=$?
  trap - ERR
  write_state "failed:prepare-exact-head-runtime:${current_failure}"
  disable_acceptance_runtime || true
  exit "$status"
}

prepare_exact_head_runtime() {
  trap fail_prepare ERR
  current_progress=prepare-exact-head-runtime
  current_failure=sync-agent-restart
  write_state "preparing:${current_progress}"
  systemctl restart matrix-sync-agent.service
  for _ in $(seq 1 60); do
    systemctl is-active --quiet matrix-sync-agent.service && break
    sleep 1
  done
  systemctl is-active --quiet matrix-sync-agent.service
  installed_bounded_updater_is_ready

  current_failure=exact-head-reapply
  local deadline=$((SECONDS + 1800)) reapply_sync_pid
  reapply_sync_pid="$(systemctl show matrix-sync-agent.service -p MainPID --value)"
  [[ "$reapply_sync_pid" =~ ^[1-9][0-9]*$ ]]
  runuser -u matrix -- /opt/matrix/bin/matrix-update --no-tail "$preview_version" >/dev/null
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(cat /opt/matrix/app/BUNDLE_VERSION 2>/dev/null || true)" = "$preview_version" ] &&
      [ ! -e /opt/matrix/app/.update-now ] &&
      [ "$(path_state /opt/matrix/staging/update-phase)" = missing ] &&
      [ "$(path_state /opt/matrix/app/.update-error.json)" = missing ] &&
      [ "$(systemctl show matrix-sync-agent.service -p MainPID --value)" != "$reapply_sync_pid" ] &&
      installed_terminal_runtime_is_ready && wait_gateway; then
      break
    fi
    if [ ! -e /opt/matrix/app/.update-now ] && [ -e /opt/matrix/app/.update-error.json ]; then
      return 1
    fi
    sleep 2
  done
  [ "$SECONDS" -lt "$deadline" ]
  installed_terminal_runtime_is_ready

  current_failure=gateway-activation
  install -d -o root -g root -m 0755 "$(dirname "$gateway_dropin")"
  cat >"$gateway_dropin" <<'EOF'
[Service]
Environment=MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=1
EOF
  chmod 0644 "$gateway_dropin"
  systemctl daemon-reload
  systemctl restart matrix-gateway.service
  wait_gateway
  current_failure=stale-acceptance-cleanup
  cleanup_stale_acceptance_runtimes
  write_state prepared
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
    referenced_generation="$(json_field "$descriptor" generation 2>/dev/null || true)"
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
  runtime_id="$(json_field "$snapshot_file" runtimeId)"
  unit="$(json_field "$snapshot_file" unit)"
  cgroup="$(json_field "$snapshot_file" cgroup)"
  generation="$(json_field "$snapshot_file" generation)"
  session_name="$(json_field "$snapshot_file" sessionName)"
  layout_path="$(json_field "$snapshot_file" layoutPath)"
  environment_path="$(json_field "$snapshot_file" environmentPath)"
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
  for pid in "$(json_field "$snapshot_file" mainPid)" \
    "$(json_field "$snapshot_file" zellijServerPid)" \
    "$(json_field "$snapshot_file" workloadPid)"; do
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

diagnose_runtime_failure() {
  local target_name descriptor runtime_id="" unit unit_result exec_status keeper_code
  local generation="" generation_dir="" zellij_path="" zellij_state=failed user_bus_state=failed
  case "$current_progress" in
    runtime-shell-create) target_name="$shell_name" ;;
    runtime-agent-create) target_name="$agent_name" ;;
    *) return 0 ;;
  esac
  if [ -f /opt/matrix/app/TERMINAL_RUNTIME_GENERATION ] &&
    [ ! -L /opt/matrix/app/TERMINAL_RUNTIME_GENERATION ] &&
    generation="$(cat /opt/matrix/app/TERMINAL_RUNTIME_GENERATION 2>/dev/null)" &&
    [[ "$generation" =~ ^gen_[0-9a-f]{64}$ ]]; then
    generation_dir="${runtime_root}/generations/${generation}"
    zellij_path="${generation_dir}/zellij"
    if [ -d "$generation_dir" ] && [ ! -L "$generation_dir" ] &&
      [ -f "$zellij_path" ] && [ ! -L "$zellij_path" ] && [ -x "$zellij_path" ] &&
      runuser -u matrix -- env \
        HOME="$home" MATRIX_HOME="$home" \
        XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
        "$zellij_path" --version >/dev/null 2>&1; then
      zellij_state=ok
    fi
  fi
  if owner_systemctl show-environment >/dev/null 2>&1; then
    user_bus_state=ok
  fi
  current_failure="${current_failure}-preflight-zellij-${zellij_state}-preflight-user-bus-${user_bus_state}"
  for descriptor in "$descriptor_root"/rt_*.json; do
    [ -f "$descriptor" ] && [ ! -L "$descriptor" ] || continue
    if runtime_id="$(json_runtime_id_for_name "$descriptor" "$target_name" 2>/dev/null)"; then
      break
    fi
  done
  [ -n "$runtime_id" ] || return 0
  unit="matrix-zellij@${runtime_id}.service"
  unit_result="$(owner_systemctl show "$unit" -p Result --value 2>/dev/null || true)"
  exec_status="$(owner_systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || true)"
  keeper_code="$(runuser -u matrix -- env \
    HOME="$home" MATRIX_HOME="$home" \
    XDG_RUNTIME_DIR="/run/user/${owner_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${owner_uid}/bus" \
    journalctl --user -u "$unit" --no-pager -n 20 -o cat 2>/dev/null |
    sed -n 's/^matrix-terminal-user-keeper: \([a-z][a-z_]*\)$/\1/p' | tail -n 1)"
  [[ "$unit_result" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || unit_result=unknown
  [[ "$exec_status" =~ ^[0-9]{1,3}$ ]] || exec_status=unknown
  [[ "$keeper_code" =~ ^[a-z][a-z_]{0,63}$ ]] || keeper_code=unknown
  keeper_code="${keeper_code//_/-}"
  current_failure="${current_failure}-unit-${unit_result}-exit-${exec_status}-keeper-${keeper_code}"
}

fail_phase() {
  local status=$?
  trap - ERR
  diagnose_runtime_failure || true
  write_state "failed:${current_progress}:${current_failure}"
  cleanup_runtime_sessions || true
  cleanup_controller_runtime || true
  remove_hostile_state || true
  disable_acceptance_runtime || true
  exit "$status"
}

phase1() {
  trap fail_phase ERR
  write_progress runtime-creation
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

  write_progress runtime-shell-create
  create_session "$shell_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  write_progress runtime-agent-create
  create_session "$agent_name" codex codex
  local shell_baseline="${state_root}/shell-baseline.json"
  local agent_baseline="${state_root}/agent-baseline.json"
  write_progress runtime-shell-snapshot
  wait_snapshot "$shell_name" shell "$shell_baseline"
  write_progress runtime-agent-snapshot
  wait_snapshot "$agent_name" agent "$agent_baseline"
  mark ordinaryShellRuntime
  mark realCodingAgentRuntime

  write_progress resource-controls
  local gateway_cgroup shell_cgroup agent_cgroup
  gateway_cgroup="$(systemctl show matrix-gateway.service -p ControlGroup --value)"
  shell_cgroup="$(json_field "$shell_baseline" cgroup)"
  agent_cgroup="$(json_field "$agent_baseline" cgroup)"
  [ "$shell_cgroup" != "$agent_cgroup" ]
  [ "$shell_cgroup" != "$gateway_cgroup" ]
  [ "$agent_cgroup" != "$gateway_cgroup" ]
  mark independentRuntimeCgroups
  verify_resource_controls "$shell_baseline" "$agent_baseline"
  mark resourceControlsPresent
  mark resourceControlsEffective

  write_progress browser-attachments
  websocket_attach_owned_by_gateway "$shell_name" "$shell_baseline"
  websocket_attach_owned_by_gateway "$agent_name" "$agent_baseline"
  mark browserAttachmentPtysRemainGatewayOwned
  mark detachPreservesRuntimes

  write_progress gateway-restart
  systemctl restart matrix-gateway.service
  wait_gateway
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  mark gatewayRestartPreservesRuntimes

  write_progress gateway-crash
  local old_gateway_pid
  old_gateway_pid="$(systemctl show matrix-gateway.service -p MainPID --value)"
  kill -KILL "$old_gateway_pid"
  wait_gateway
  [ "$(systemctl show matrix-gateway.service -p MainPID --value)" != "$old_gateway_pid" ]
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  mark gatewaySigkillPreservesRuntimes
  write_progress gateway-memory
  verify_gateway_memory_isolation "$shell_baseline" "$agent_baseline"
  mark gatewayMemoryIsolation

  write_progress hostile-controller
  run_controller_adversarial_checks
  mark invalidRuntimeIdsFailClosed
  mark conflictingDescriptorReuseFailsClosed
  mark staleInactiveStateIsRecoverable
  mark hostileDescriptorFieldsFailClosed
  mark deleteIsIdempotent

  write_progress hostile-state-create
  create_hostile_state
  write_progress hostile-state-pre-api
  wait_gateway
  write_progress hostile-state-api
  hostile_state_fails_closed
  mark corruptAndSymlinkStateFailsClosed

  write_progress bundle-a-update
  request_update "$version_a"
  wait_update "$version_a" explicit
  write_progress bundle-a-continuity
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  websocket_attach_owned_by_gateway "$shell_name" "$shell_baseline"
  mark bundleOnePreservesRuntimes

  write_progress bundle-b-update
  request_update "$version_b"
  wait_update "$version_b" explicit
  write_progress bundle-b-continuity
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  websocket_attach_owned_by_gateway "$agent_name" "$agent_baseline"
  mark bundleTwoPreservesRuntimes

  write_progress new-generation
  create_session "$current_generation_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  local current_snapshot="${state_root}/current-generation.json"
  wait_snapshot "$current_generation_name" shell "$current_snapshot"
  [ "$(json_field "$current_snapshot" generation)" = "$(cat /opt/matrix/app/TERMINAL_RUNTIME_GENERATION)" ]
  mark newRuntimesUseCurrentGeneration
  delete_session "$current_generation_name"
  verify_deleted "$current_snapshot"
  delete_session "$current_generation_name"
  mark deleteRemovesExactRuntime
  mark deleteRemovesSocketAndSnapshots
  write_progress generation-gc
  generation_gc_safe "$(json_field "$shell_baseline" generation)"
  mark generationGcIsReferenceAndSymlinkSafe
  mark generationRetentionIsBounded

  write_progress rollback-update
  request_update rollback
  wait_update "$version_a" rollback
  write_progress rollback-continuity
  roles_match "$shell_name" shell "$shell_baseline"
  roles_match "$agent_name" agent "$agent_baseline"
  websocket_attach_owned_by_gateway "$shell_name" "$shell_baseline"
  mark rollbackPreservesRuntimes

  write_progress post-rollback-runtime
  create_session "$post_rollback_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  local post_snapshot="${state_root}/post-rollback.json"
  wait_snapshot "$post_rollback_name" shell "$post_snapshot"
  [ "$(json_field "$post_snapshot" generation)" = "$(cat /opt/matrix/app/TERMINAL_RUNTIME_GENERATION)" ]
  mark postRollbackRuntimeUsesCompatibleGeneration
  delete_session "$post_rollback_name"
  verify_deleted "$post_snapshot"

  write_progress resource-limit-breach
  create_session "$limit_name" "/opt/matrix/runtime/node/bin/node $loop_script $output_file"
  local limit_snapshot="${state_root}/limit.json" limit_unit
  wait_snapshot "$limit_name" shell "$limit_snapshot"
  limit_unit="$(json_field "$limit_snapshot" unit)"
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
  current_state_prefix=phase2-running
  write_progress reboot-verification
  local baseline unit pid old_cgroup
  for baseline in "${state_root}/shell-baseline.json" "${state_root}/agent-baseline.json"; do
    unit="$(json_field "$baseline" unit)"
    old_cgroup="$(json_field "$baseline" cgroup)"
    ! owner_systemctl is-active --quiet "$unit"
    [ ! -e "/sys/fs/cgroup${old_cgroup}/cgroup.procs" ]
    [ -f "${descriptor_root}/$(json_field "$baseline" runtimeId).json" ]
    for pid in "$(json_field "$baseline" mainPid)" \
      "$(json_field "$baseline" zellijServerPid)" \
      "$(json_field "$baseline" workloadPid)"; do
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
    cleanup_controller_runtime || true
    remove_hostile_state || true
    find "$root_parent" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf -- {} +
    rm -rf -- "$state_root"
    install -d -o root -g root -m 0700 "$checks_root"
    write_state preparing:prepare-exact-head-runtime
    systemd-run --unit="${prepare_unit%.service}" \
      --collect --no-block --property=Type=exec --property=KillMode=control-group \
      --property=StandardOutput=null --property=StandardError=null \
      -- "$helper_path" prepare-worker "$head_sha" "$run_nonce" "$preview_version" >/dev/null
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
    state="$(cat "$state_file")"
    if [[ "$state" == preparing:* ]] && ! systemctl is-active --quiet "$prepare_unit"; then
      echo "failed:prepare-worker-exited:${state#preparing:}"
    elif [[ "$state" == phase1-running:* ]] && ! systemctl is-active --quiet "$phase1_unit"; then
      echo "failed:phase-worker-exited:${state#phase1-running:}"
    else
      printf '%s\n' "$state"
    fi
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
  prepare-worker) prepare_exact_head_runtime ;;
  phase1) phase1 ;;
  phase2) phase2 ;;
esac

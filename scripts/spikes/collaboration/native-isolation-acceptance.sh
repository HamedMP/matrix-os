#!/usr/bin/env bash
set -euo pipefail

if [ "${MATRIX_SCOPE_PROBE_DISPOSABLE:-}" != "1" ]; then
  printf 'scope_runtime_acceptance_requires_disposable_host\n' >&2
  exit 2
fi

if [ "$(id -u)" != "0" ]; then
  printf 'scope_runtime_acceptance_requires_root\n' >&2
  exit 2
fi

readonly node_bin=/opt/matrix/runtime/node/bin/node
readonly probe_source=/var/tmp/matrix-scope-runtime-probe.ts
readonly broker_socket=/run/matrix-scope/broker.sock
readonly supervisor_socket=/run/matrix-scope-runtime/supervisor.sock
readonly scope_uid=62000
readonly scope_gid=62000

for executable in "$node_bin" /usr/bin/setpriv /usr/bin/systemd-run /usr/bin/systemctl; do
  if [ ! -x "$executable" ]; then
    printf 'scope_runtime_acceptance_dependency_unavailable\n' >&2
    exit 2
  fi
done
if [ ! -f "$probe_source" ] || [ -L "$probe_source" ]; then
  printf 'scope_runtime_acceptance_probe_unavailable\n' >&2
  exit 2
fi
if [ -e "$broker_socket" ] || [ -L "$broker_socket" ] ||
  [ -e "$supervisor_socket" ] || [ -L "$supervisor_socket" ]; then
  printf 'scope_runtime_acceptance_socket_collision\n' >&2
  exit 2
fi

probe_root="$(mktemp -d /var/tmp/matrix-scope-accept.XXXXXX)"
readonly probe_root
readonly candidate_unit="matrix-scope-probe-${probe_root##*.}.service"
broker_pid=
supervisor_pid=

cleanup() {
  /usr/bin/systemctl stop "$candidate_unit" >/dev/null 2>&1 || true
  /usr/bin/systemctl reset-failed "$candidate_unit" >/dev/null 2>&1 || true
  if [ -n "$broker_pid" ]; then
    kill "$broker_pid" >/dev/null 2>&1 || true
    wait "$broker_pid" 2>/dev/null || true
  fi
  if [ -n "$supervisor_pid" ]; then
    kill "$supervisor_pid" >/dev/null 2>&1 || true
    wait "$supervisor_pid" 2>/dev/null || true
  fi
  rm -f -- "$broker_socket" "$supervisor_socket"
  rmdir /run/matrix-scope /run/matrix-scope-runtime >/dev/null 2>&1 || true
  rm -rf -- "$probe_root"
}
trap cleanup EXIT INT TERM

mkdir -p /run/matrix-scope /run/matrix-scope-runtime
chmod 0755 /run/matrix-scope /run/matrix-scope-runtime

start_sentinel() {
  local socket_path="$1"
  local log_path="$2"
  "$node_bin" --input-type=module -e '
    import { chmod } from "node:fs/promises";
    import { createServer } from "node:net";
    const socketPath = process.argv[1];
    const server = createServer((socket) => socket.end("ok\n"));
    server.on("error", (error) => {
      process.stderr.write(`sentinel_error:${error instanceof Error ? error.name : "UnknownError"}\n`);
      process.exit(1);
    });
    server.listen(socketPath, async () => {
      await chmod(socketPath, 0o666);
      process.stdout.write("ready\n");
    });
  ' "$socket_path" >"$log_path" 2>&1 &
  SENTINEL_PID=$!
}

start_sentinel "$broker_socket" "$probe_root/broker.log"
broker_pid="$SENTINEL_PID"
start_sentinel "$supervisor_socket" "$probe_root/supervisor.log"
supervisor_pid="$SENTINEL_PID"

for _ in $(seq 1 50); do
  if [ -S "$broker_socket" ] && [ -S "$supervisor_socket" ]; then
    break
  fi
  sleep 0.1
done
if [ ! -S "$broker_socket" ] || [ ! -S "$supervisor_socket" ]; then
  printf 'scope_runtime_acceptance_sentinel_unavailable\n' >&2
  exit 2
fi

run_unrestricted_baseline() {
  /usr/bin/setpriv \
    --reuid="$scope_uid" \
    --regid="$scope_gid" \
    --clear-groups \
    --inh-caps=-all \
    --ambient-caps=-all \
    --bounding-set=-all \
    /usr/bin/env -i \
      HOME=/tmp \
      PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin \
      MATRIX_SCOPE_PROBE_DISPOSABLE=1 \
      MATRIX_SCOPE_PROBE_OWNER_SECRET=baseline-leak \
      "$node_bin" "$probe_source"
}

baseline_status=0
if run_unrestricted_baseline >"$probe_root/baseline.json" 2>"$probe_root/baseline.err"; then
  baseline_status=0
else
  baseline_status=$?
fi
if [ "$baseline_status" = "0" ]; then
  printf 'scope_runtime_acceptance_baseline unexpectedly passed\n' >&2
  exit 1
fi
if ! "$node_bin" --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const report = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (report?.probe !== "matrix-scope-runtime" || report?.isolated !== false) process.exit(1);
' "$probe_root/baseline.json"; then
  printf 'scope_runtime_acceptance_baseline_report_invalid\n' >&2
  exit 1
fi

mkdir -p \
  "$probe_root/root/dev" \
  "$probe_root/root/lib" \
  "$probe_root/root/lib64" \
  "$probe_root/root/opt/matrix/runtime" \
  "$probe_root/root/proc" \
  "$probe_root/root/run/matrix-scope" \
  "$probe_root/root/run/matrix-scope-runtime" \
  "$probe_root/root/run/matrix-scope-probe" \
  "$probe_root/root/sys" \
  "$probe_root/root/tmp" \
  "$probe_root/root/usr/lib" \
  "$probe_root/root/workspace"
: >"$probe_root/root/run/matrix-scope/broker.sock"
: >"$probe_root/root/run/matrix-scope-probe/scope-runtime-probe.ts"

run_fixed_profile_candidate() {
  /usr/bin/systemd-run \
    --unit="$candidate_unit" \
    --wait \
    --pipe \
    --collect \
    --quiet \
    --property=Type=exec \
    --property=User=62000 \
    --property=Group=62000 \
    --property=PrivateUsers=yes \
    --property="RootDirectory=$probe_root/root" \
    --property=MountAPIVFS=yes \
    --property=PrivateNetwork=yes \
    --property=PrivateIPC=yes \
    --property=PrivateTmp=yes \
    --property=PrivateDevices=yes \
    --property=ProtectProc=invisible \
    --property=ProcSubset=pid \
    --property=ProtectSystem=strict \
    --property=ProtectHome=yes \
    --property=ProtectKernelTunables=yes \
    --property=ProtectKernelModules=yes \
    --property=ProtectKernelLogs=yes \
    --property=ProtectControlGroups=yes \
    --property=ProtectClock=yes \
    --property=ProtectHostname=yes \
    --property=NoNewPrivileges=yes \
    --property=CapabilityBoundingSet= \
    --property=AmbientCapabilities= \
    --property=RestrictAddressFamilies=AF_UNIX \
    --property=RestrictNamespaces=yes \
    --property=RestrictRealtime=yes \
    --property=RestrictSUIDSGID=yes \
    --property=SystemCallArchitectures=native \
    --property=MemoryMax=1073741824 \
    --property=CPUQuota=200% \
    --property=TasksMax=256 \
    --property="TemporaryFileSystem=/workspace:rw,size=10G,mode=0700,uid=62000,gid=62000" \
    --property="TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=64M,mode=1777" \
    --property="BindReadOnlyPaths=/lib" \
    --property="BindReadOnlyPaths=/lib64" \
    --property="BindReadOnlyPaths=/usr/lib" \
    --property="BindReadOnlyPaths=/opt/matrix/runtime/node" \
    --property="BindReadOnlyPaths=$probe_source:/run/matrix-scope-probe/scope-runtime-probe.ts" \
    --property="BindPaths=$broker_socket:/run/matrix-scope/broker.sock" \
    --property=WorkingDirectory=/workspace \
    --property=UMask=0077 \
    --property=RuntimeMaxSec=60 \
    --property=TimeoutStopSec=10 \
    --setenv=HOME=/workspace \
    --setenv=PATH=/opt/matrix/runtime/node/bin \
    --setenv=MATRIX_SCOPE_PROBE_DISPOSABLE=1 \
    -- \
    /opt/matrix/runtime/node/bin/node \
    /run/matrix-scope-probe/scope-runtime-probe.ts
}

candidate_status=0
if run_fixed_profile_candidate >"$probe_root/candidate.json" 2>"$probe_root/candidate.err"; then
  candidate_status=0
else
  candidate_status=$?
fi
if [ "$candidate_status" != "0" ]; then
  printf 'scope_runtime_acceptance_candidate_failed\n' >&2
  sed -n '1,40p' "$probe_root/candidate.err" >&2
  exit 1
fi
if ! "$node_bin" --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const report = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (report?.probe !== "matrix-scope-runtime" || report?.isolated !== true) process.exit(1);
' "$probe_root/candidate.json"; then
  printf 'scope_runtime_acceptance_candidate_report_invalid\n' >&2
  exit 1
fi

printf 'scope_runtime_acceptance=passed\n'
printf 'baseline_status=%s\n' "$baseline_status"
printf 'scope_uid=%s\n' "$scope_uid"
printf 'memory_max_bytes=1073741824\n'
printf 'cpu_quota_percent=200\n'
printf 'tasks_max=256\n'
printf 'storage_max_bytes=10737418240\n'
printf '%s\n' 'baseline_report_begin'
sed -n '1,240p' "$probe_root/baseline.json"
printf '%s\n' 'baseline_report_end'
printf '%s\n' 'candidate_report_begin'
sed -n '1,240p' "$probe_root/candidate.json"
printf '%s\n' 'candidate_report_end'

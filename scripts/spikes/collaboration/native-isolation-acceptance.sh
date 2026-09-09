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
readonly asset_root="${MATRIX_SCOPE_ASSET_ROOT:-}"
if [ "$asset_root" != "/var/lib/matrix-scope-runtime/acceptance" ]; then
  printf 'scope_runtime_acceptance_asset_root_invalid\n' >&2
  exit 2
fi
readonly probe_source="$asset_root/matrix-scope-runtime-probe.ts"
readonly sdk_probe_source="$asset_root/matrix-scope-runtime-sdk-probe.mjs"
readonly broker_fixture_source="$asset_root/matrix-scope-runtime-broker-fixture.mjs"
readonly broker_socket=/run/matrix-scope/broker.sock
readonly supervisor_socket=/run/matrix-scope-runtime/supervisor.sock
readonly sdk_manifest=/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json
readonly native_manifest=/opt/matrix/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json

for executable in "$node_bin" /usr/bin/chmod /usr/bin/install /usr/bin/readlink /usr/bin/setpriv /usr/bin/sha256sum /usr/bin/systemd-run /usr/bin/systemctl /usr/bin/uname; do
  if [ ! -x "$executable" ]; then
    printf 'scope_runtime_acceptance_dependency_unavailable\n' >&2
    exit 2
  fi
done
for source_file in "$probe_source" "$sdk_probe_source" "$broker_fixture_source"; do
  if [ ! -f "$source_file" ] || [ -L "$source_file" ]; then
    printf 'scope_runtime_acceptance_probe_unavailable\n' >&2
    exit 2
  fi
done
if [ ! -f "$sdk_manifest" ] || [ ! -f "$native_manifest" ]; then
  printf 'scope_runtime_acceptance_sdk_unavailable\n' >&2
  exit 2
fi
if [ "$(uname -m)" != "x86_64" ]; then
  printf 'scope_runtime_acceptance_architecture_unsupported\n' >&2
  exit 2
fi
sdk_directory="$(/usr/bin/readlink -f "${sdk_manifest%/*}")"
native_directory="$(/usr/bin/readlink -f "${native_manifest%/*}")"
if [ -z "$sdk_directory" ] || [ -z "$native_directory" ] ||
  [ ! -f "$sdk_directory/sdk.mjs" ] || [ ! -x "$native_directory/claude" ]; then
  printf 'scope_runtime_acceptance_sdk_unavailable\n' >&2
  exit 2
fi
sdk_facts="$($node_bin --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const [sdkPath, nativePath] = process.argv.slice(1);
  const sdk = JSON.parse(await readFile(sdkPath, "utf8"));
  const native = JSON.parse(await readFile(nativePath, "utf8"));
  if (!/^0\.[0-9]+\.[0-9]+$/.test(sdk.version) || sdk.version !== native.version ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(sdk.claudeCodeVersion)) process.exit(1);
  process.stdout.write(`${sdk.version}\t${sdk.claudeCodeVersion}`);
' "$sdk_manifest" "$native_manifest")" || {
  printf 'scope_runtime_acceptance_sdk_unsupported\n' >&2
  exit 2
}
IFS=$'\t' read -r sdk_version native_harness_version <<<"$sdk_facts"
if [ -z "$sdk_version" ] || [ -z "$native_harness_version" ]; then
  printf 'scope_runtime_acceptance_sdk_unsupported\n' >&2
  exit 2
fi
readonly sdk_directory native_directory sdk_version native_harness_version
if [ -e "$broker_socket" ] || [ -L "$broker_socket" ] ||
  [ -e "$supervisor_socket" ] || [ -L "$supervisor_socket" ]; then
  printf 'scope_runtime_acceptance_socket_collision\n' >&2
  exit 2
fi

probe_root="$(mktemp -d /var/tmp/matrix-scope-accept.XXXXXX)"
readonly probe_root
baseline_root="$(mktemp -d /var/tmp/matrix-scope-baseline.XXXXXX)"
if [ ! -d "$baseline_root" ] || [ -L "$baseline_root" ]; then
  printf 'scope_runtime_acceptance_baseline_staging_invalid\n' >&2
  exit 2
fi
readonly baseline_root
readonly baseline_probe_source="$baseline_root/scope-runtime-probe.ts"
readonly candidate_unit="matrix-scope-probe-${probe_root##*.}.service"
readonly sdk_candidate_unit="matrix-scope-sdk-probe-${probe_root##*.}.service"
broker_pid=
supervisor_pid=

cleanup() {
  /usr/bin/systemctl stop "$candidate_unit" >/dev/null 2>&1 || true
  /usr/bin/systemctl reset-failed "$candidate_unit" >/dev/null 2>&1 || true
  /usr/bin/systemctl stop "$sdk_candidate_unit" >/dev/null 2>&1 || true
  /usr/bin/systemctl reset-failed "$sdk_candidate_unit" >/dev/null 2>&1 || true
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
  rm -rf -- "$probe_root" "$baseline_root"
}
trap cleanup EXIT INT TERM

/usr/bin/chmod 0755 -- "$baseline_root"
/usr/bin/install --owner=root --group=root --mode=0644 -- "$probe_source" "$baseline_probe_source"

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

MATRIX_SCOPE_PROBE_DISPOSABLE=1 "$node_bin" "$broker_fixture_source" \
  >"$probe_root/broker.log" 2>&1 &
broker_pid=$!
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

run_unrestricted_baseline() (
  cd /tmp
  exec /usr/bin/setpriv \
    --reuid=matrix \
    --regid=matrix \
    --init-groups \
    --inh-caps=-all \
    --ambient-caps=-all \
    --bounding-set=-all \
    /usr/bin/env -i \
      HOME=/tmp \
      PATH=/opt/matrix/runtime/node/bin:/usr/bin:/bin \
      MATRIX_SCOPE_PROBE_DISPOSABLE=1 \
      MATRIX_SCOPE_PROBE_OWNER_SECRET=baseline-leak \
      "$node_bin" "$baseline_probe_source"
)

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
  const expected_baseline_results = Object.freeze({
    "filesystem:/home/matrix/home": false,
    "filesystem:/root": true,
    "filesystem:/run/postgresql": true,
    "filesystem:/run/containerd/containerd.sock": true,
    "filesystem:/var/run/docker.sock": true,
    "filesystem:/run/systemd/private": true,
    "filesystem:scope-root": false,
    "environment:allowlist": false,
    "process:namespace": false,
    "descriptor:inheritance": true,
    "network:loopback": false,
    "network:metadata": false,
    "network:private": true,
    "network:public": false,
    "network:dns": false,
    "broker:socket": true,
    "supervisor:injection": false,
    "child:boundary-inheritance": false,
  });
  const expected_names = Object.keys(expected_baseline_results);
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const seen = [];
  const validChecks = checks.length === expected_names.length && checks.every((check) => {
    if (typeof check?.name !== "string" || seen.includes(check.name)) return false;
    seen.push(check.name);
    return Object.prototype.hasOwnProperty.call(expected_baseline_results, check.name) &&
      check.passed === expected_baseline_results[check.name];
  });
  if (report?.probe !== "matrix-scope-runtime" || report?.isolated !== false || !validChecks) {
    process.stderr.write("baseline_check_mismatch\n");
    process.exit(1);
  }
' "$probe_root/baseline.json"; then
  printf 'scope_runtime_acceptance_baseline_report_invalid\n' >&2
  exit 1
fi

mkdir -p \
  "$probe_root/root/dev" \
  "$probe_root/root/lib" \
  "$probe_root/root/lib64" \
  "$probe_root/root/opt/matrix/runtime" \
  "$probe_root/root/opt/matrix/scope-sdk/native" \
  "$probe_root/root/opt/matrix/scope-sdk/sdk" \
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
: >"$probe_root/root/run/matrix-scope-probe/scope-runtime-sdk-probe.mjs"

readonly -a fixed_profile=(
  --property=Type=exec
  --property=User=matrix-scope-probe
  --property=DynamicUser=yes
  --property=PrivateUsers=yes
  "--property=RootDirectory=$probe_root/root"
  --property=MountAPIVFS=yes
  --property=PrivateNetwork=yes
  --property=PrivateIPC=yes
  --property=PrivateTmp=yes
  --property=PrivateDevices=yes
  --property=ProtectProc=invisible
  --property=ProcSubset=pid
  --property=ProtectSystem=strict
  --property=ProtectHome=yes
  --property=ProtectKernelTunables=yes
  --property=ProtectKernelModules=yes
  --property=ProtectKernelLogs=yes
  --property=ProtectControlGroups=yes
  --property=ProtectClock=yes
  --property=ProtectHostname=yes
  --property=NoNewPrivileges=yes
  --property=CapabilityBoundingSet=
  --property=AmbientCapabilities=
  "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"
  --property=RestrictNamespaces=yes
  --property=RestrictRealtime=yes
  --property=RestrictSUIDSGID=yes
  --property=SystemCallArchitectures=native
  --property=MemoryMax=1073741824
  --property=CPUQuota=200%
  --property=TasksMax=256
  "--property=TemporaryFileSystem=/workspace:rw,nosuid,nodev,size=10G,mode=1777"
  "--property=TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=64M,mode=1777"
  "--property=BindReadOnlyPaths=/lib"
  "--property=BindReadOnlyPaths=/lib64"
  "--property=BindReadOnlyPaths=/usr/lib"
  "--property=BindReadOnlyPaths=/opt/matrix/runtime/node"
  "--property=BindReadOnlyPaths=$sdk_directory:/opt/matrix/scope-sdk/sdk"
  "--property=BindReadOnlyPaths=$native_directory:/opt/matrix/scope-sdk/native"
  "--property=BindReadOnlyPaths=$probe_source:/run/matrix-scope-probe/scope-runtime-probe.ts"
  "--property=BindReadOnlyPaths=$sdk_probe_source:/run/matrix-scope-probe/scope-runtime-sdk-probe.mjs"
  "--property=BindPaths=$broker_socket:/run/matrix-scope/broker.sock"
  --property=WorkingDirectory=/workspace
  --property=UMask=0077
  --property=RuntimeMaxSec=90
  --property=TimeoutStopSec=10
  --setenv=HOME=/workspace
  --setenv=PATH=/opt/matrix/runtime/node/bin
  --setenv=MATRIX_SCOPE_PROBE_DISPOSABLE=1
)
profile_material="$(printf '%s\n' "${fixed_profile[@]}" |
  sed \
    -e "s#${probe_root}/root#<scope-root>#g" \
    -e "s#${sdk_directory}#<sdk-directory>#g" \
    -e "s#${native_directory}#<native-directory>#g" \
    -e "s#${probe_source}#<probe-source>#g" \
    -e "s#${sdk_probe_source}#<sdk-probe-source>#g" \
    -e "s#${broker_socket}#<broker-socket>#g")"
fixed_profile_sha256="$(printf '%s\n' "$profile_material" | /usr/bin/sha256sum | cut -d ' ' -f 1)"
readonly fixed_profile_sha256

emit_unit_failure() {
  local unit="$1"
  /usr/bin/systemctl show "$unit" --no-pager \
    --property=LoadState \
    --property=ActiveState \
    --property=SubState \
    --property=Result \
    --property=ExecMainCode \
    --property=ExecMainStatus 2>/dev/null |
    sed -n -E '/^(LoadState|ActiveState|SubState|Result)=[a-z-]{0,32}$/p; /^(ExecMainCode|ExecMainStatus)=[0-9]{0,6}$/p'
}

run_fixed_profile_candidate() {
  /usr/bin/systemd-run \
    --unit="$candidate_unit" \
    --wait \
    --pipe \
    --quiet \
    "${fixed_profile[@]}" \
    -- \
    /opt/matrix/runtime/node/bin/node \
    /run/matrix-scope-probe/scope-runtime-probe.ts
}

run_agent_sdk_candidate() {
  /usr/bin/systemd-run \
    --unit="$sdk_candidate_unit" \
    --wait \
    --pipe \
    --quiet \
    "${fixed_profile[@]}" \
    -- \
    /opt/matrix/runtime/node/bin/node \
    /run/matrix-scope-probe/scope-runtime-sdk-probe.mjs
}

candidate_status=0
if run_fixed_profile_candidate >"$probe_root/candidate.json" 2>"$probe_root/candidate.err"; then
  candidate_status=0
else
  candidate_status=$?
fi
if [ "$candidate_status" != "0" ]; then
  printf 'scope_runtime_acceptance_candidate_failed\n' >&2
  printf 'failed_candidate_report_begin\n' >&2
  sed -n '1,240p' "$probe_root/candidate.json" >&2
  emit_unit_failure "$candidate_unit" >&2
  printf 'failed_candidate_report_end\n' >&2
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
scope_uid="$("$node_bin" --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const report = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (!Number.isInteger(report?.runtime?.uid) || report.runtime.uid < 61184 ||
    report.runtime.uid > 65519) process.exit(1);
  process.stdout.write(String(report.runtime.uid));
' "$probe_root/candidate.json")" || {
  printf 'scope_runtime_acceptance_dynamic_identity_invalid\n' >&2
  exit 1
}
readonly scope_uid

sdk_candidate_status=0
if run_agent_sdk_candidate >"$probe_root/sdk-candidate.json" 2>"$probe_root/sdk-candidate.err"; then
  sdk_candidate_status=0
else
  sdk_candidate_status=$?
fi
if [ "$sdk_candidate_status" != "0" ]; then
  printf 'scope_runtime_acceptance_sdk_candidate_failed\n' >&2
  printf 'failed_sdk_candidate_report_begin\n' >&2
  sed -n '1,120p' "$probe_root/sdk-candidate.json" >&2
  sed -n '/^scope_runtime_sdk_/p' "$probe_root/sdk-candidate.err" >&2
  emit_unit_failure "$sdk_candidate_unit" >&2
  printf 'failed_sdk_candidate_report_end\n' >&2
  exit 1
fi
if ! "$node_bin" --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const report = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (report?.status !== "sdk_query:passed" ||
    report?.brokerActionBoundary !== "passed" ||
    report?.brokerTransport !== "unix_socket") process.exit(1);
' "$probe_root/sdk-candidate.json"; then
  printf 'scope_runtime_acceptance_sdk_candidate_report_invalid\n' >&2
  exit 1
fi

host_os_facts="$("$node_bin" --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const text = await readFile("/etc/os-release", "utf8");
  if (text.length > 4096) process.exit(1);
  let id = "";
  let version = "";
  for (const line of text.split("\n").slice(0, 128)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    if (match[1] === "ID") id = value;
    if (match[1] === "VERSION_ID") version = value;
  }
  if (!/^[a-z0-9._-]{1,32}$/.test(id) || !/^[0-9][0-9.]{0,15}$/.test(version)) {
    process.exit(1);
  }
  process.stdout.write(`${id}\t${version}`);
')" || {
  printf 'scope_runtime_acceptance_host_facts_unavailable\n' >&2
  exit 2
}
IFS=$'\t' read -r host_os_id host_os_version <<<"$host_os_facts"
kernel_release="$(/usr/bin/uname -r)"
architecture="$(/usr/bin/uname -m)"
systemd_version="$(/usr/bin/systemctl --version | sed -n '1s/^systemd \([0-9][0-9]*\).*$/\1/p')"
node_version="$($node_bin --version)"
if ! printf '%s' "$kernel_release" | grep -Eq '^[A-Za-z0-9._+-]{1,128}$' ||
  [ "$architecture" != x86_64 ] ||
  ! printf '%s' "$systemd_version" | grep -Eq '^[0-9]{1,6}$' ||
  ! printf '%s' "$node_version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf 'scope_runtime_acceptance_host_facts_unavailable\n' >&2
  exit 2
fi
readonly host_os_id host_os_version kernel_release architecture systemd_version node_version

printf 'scope_runtime_acceptance=passed\n'
printf 'baseline_status=%s\n' "$baseline_status"
printf 'host_os_id=%s\n' "$host_os_id"
printf 'host_os_version=%s\n' "$host_os_version"
printf 'kernel_release=%s\n' "$kernel_release"
printf 'architecture=%s\n' "$architecture"
printf 'systemd_version=%s\n' "$systemd_version"
printf 'node_version=%s\n' "$node_version"
printf 'fixed_profile_sha256=%s\n' "$fixed_profile_sha256"
printf 'scope_uid=%s\n' "$scope_uid"
printf 'memory_max_bytes=1073741824\n'
printf 'cpu_quota_percent=200\n'
printf 'tasks_max=256\n'
printf 'storage_max_bytes=10737418240\n'
printf 'agent_sdk_version=%s\n' "$sdk_version"
printf 'native_harness_version=%s\n' "$native_harness_version"
printf 'sdk_broker_result=passed\n'
printf 'scope_identity=dynamic\n'
printf 'scope_runtime_eligibility=passed\n'
printf '%s\n' 'baseline_report_begin'
sed -n '1,240p' "$probe_root/baseline.json"
printf '%s\n' 'baseline_report_end'
printf '%s\n' 'candidate_report_begin'
sed -n '1,240p' "$probe_root/candidate.json"
printf '%s\n' 'candidate_report_end'

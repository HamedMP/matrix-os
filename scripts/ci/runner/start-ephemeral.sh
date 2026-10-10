#!/bin/bash
# Manual reviewed-SHA admission; intentionally no GitHub Actions registration.
set -euo pipefail
set +x
if [[ $# != 3 || ! $1 =~ ^[a-f0-9]{40}$ || ! $3 =~ ^([1-9]|1[0-6])$ ]]; then
  echo 'Usage: start-ephemeral.sh <reviewed-40-char-sha> <allowlisted-suite> <workers-1..16>' >&2
  exit 64
fi
case "$2" in unit|unit-shard-[1-4]|typecheck|shell|checks|e2e|e2e-general|e2e-electron|full|qualification) ;; *) echo 'Unsupported suite' >&2; exit 64 ;; esac
iptables -C DOCKER-USER -i matrix-ci0 -j MATRIX-CI-EGRESS >/dev/null
iptables -C INPUT -i matrix-ci0 -j REJECT >/dev/null

host_cpus=$(nproc)
host_memory_kib=$(awk '/^MemTotal:/ {print $2}' "${MATRIX_CI_MEMINFO_PATH:-/proc/meminfo}")
[[ $host_memory_kib =~ ^[0-9]+$ ]] || exit 64
if (( host_cpus >= 32 && host_memory_kib >= 120000000 )); then
  cpu_limit=30 memory_limit=112g work_limit=64g
elif (( host_cpus >= 16 && host_memory_kib >= 60000000 )); then
  cpu_limit=16 memory_limit=56g work_limit=32g
elif (( host_cpus >= 8 && host_memory_kib >= 30000000 )); then
  cpu_limit=8 memory_limit=28g work_limit=16g
else
  echo 'Requires at least eight host CPUs' >&2
  exit 64
fi
state_dir=${MATRIX_CI_STATE_DIR:-/var/lib/matrix-ci}
mkdir -p "$state_dir/results"
# One benchmark at a time; keep memory available for the host.
exec 9>"$state_dir/benchmark.lock"
flock -w 1800 9 || { echo 'A benchmark is already running' >&2; exit 75; }
result_dir=$(mktemp -d "$state_dir/results/run.XXXXXXXX")
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# Resolve the root-managed image exactly once; test code cannot access Docker
# or replace this image. Record its immutable digest alongside accepted evidence.
image_id=$(docker image inspect --format '{{.Id}}' matrix-ci-benchmark:1)
[[ $image_id =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid benchmark image digest' >&2; exit 70; }
printf '%s\n' "$image_id" >"$result_dir/image-id"
container=''
cleanup() {
  if [[ -n "$container" ]]; then docker rm --force "$container" >/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# No volumes, bind mounts, host networking, host credentials, or Docker socket.
# bootstrap-host.sh installs the matrix-ci network and private-egress firewall.
container=$(docker create --init --name "matrix-ci-$(basename "$result_dir")" \
  --label matrix-ci.disposable=true \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
  --cpus "$cpu_limit" --memory "$memory_limit" --memory-swap "$memory_limit" --pids-limit 4096 --shm-size 2g \
  --read-only \
  --tmpfs /work:rw,exec,nosuid,nodev,size="$work_limit",uid=10001,gid=10001,mode=0755 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=8g,mode=1777 \
  --tmpfs /home/runner:rw,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0755 \
  --network matrix-ci --dns 1.1.1.1 --dns 1.0.0.1 \
  --log-opt max-size=10m --log-opt max-file=2 \
  "$image_id")
status=0
# A fixed idle PID1 keeps tmpfs alive through artifact collection. The trusted
# Docker exec result supplies the benchmark status; no writable result marker.
docker start "$container" >/dev/null
(ulimit -f 20480; timeout --signal=TERM --kill-after=15s 1800s \
  docker exec --user 10001:10001 "$container" /opt/matrix-ci/benchmark.sh "$1" "$2" "$3") \
  >"$result_dir/output.log" 2>&1 || status=$?
printf '%s\n' "$status" >"$result_dir/exit-code"
if [[ $status == 124 || $status == 137 ]]; then
  # Stopping the exec client alone leaves its processes alive inside Docker.
  # Kill the container immediately at the execution deadline; tmpfs evidence
  # is deliberately discarded, while the bounded host log remains available.
  cleanup
  container=''
  cat "$result_dir/output.log"
  exit "$status"
fi
cat "$result_dir/output.log"
# Stream only bounded, named regular files; never extract container paths/links.
for file in unit-cold.json unit-warm.json timing.tsv; do
  if [[ $2 == qualification && $file == unit-warm.json ]]; then continue; fi
  timeout --signal=TERM --kill-after=5s 30s docker exec --user 10001:10001 "$container" /usr/bin/tar -cf - -C /work/results -- "$file" 2>/dev/null \
    | python3 "$script_dir/copy-artifact.py" "$result_dir/$file" "$file" 2>/dev/null || true
done
# Successful execution without accepted evidence is not a usable benchmark.
if [[ $status == 0 ]]; then
  required=(timing.tsv)
  case "$2" in qualification) required+=(unit-cold.json) ;; unit|unit-shard-*|full) required+=(unit-cold.json unit-warm.json) ;; esac
  for file in "${required[@]}"; do
    if [[ ! -s "$result_dir/$file" ]]; then
      echo 'Benchmark evidence missing or rejected' >&2
      status=70
    fi
  done
fi
printf '%s\n' "$status" >"$result_dir/exit-code"
printf 'Benchmark exit: %s; host evidence: %s\n' "$status" "$result_dir"
exit "$status"

#!/bin/bash
# Manual reviewed-SHA admission; intentionally no GitHub Actions registration.
set -euo pipefail
set +x
if [[ $# != 3 || ! $1 =~ ^[a-f0-9]{40}$ || ! $3 =~ ^([1-9]|1[0-6])$ ]]; then
  echo 'Usage: start-ephemeral.sh <reviewed-40-char-sha> <unit|unit-shard-{1..4}|typecheck|shell|e2e> <workers-1..16>' >&2
  exit 64
fi
case "$2" in unit|unit-shard-[1-4]|typecheck|shell|e2e) ;; *) echo 'Unsupported suite' >&2; exit 64 ;; esac

state_dir=${MATRIX_CI_STATE_DIR:-/var/lib/matrix-ci}
mkdir -p "$state_dir/results"
# One 16-core/56-GB benchmark at a time; leave memory for the host.
exec 9>"$state_dir/benchmark.lock"
flock -n 9 || { echo 'A benchmark is already running' >&2; exit 75; }
result_dir=$(mktemp -d "$state_dir/results/run.XXXXXXXX")
container=''
cleanup() {
  if [[ -n "$container" ]]; then docker rm --force "$container" >/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# No volumes, bind mounts, host networking, host credentials, or Docker socket.
# bootstrap-host.sh installs the matrix-ci network and private-egress firewall.
container=$(docker create --name "matrix-ci-$(basename "$result_dir")" \
  --label matrix-ci.disposable=true \
  --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
  --cpus 16 --memory 56g --memory-swap 56g --pids-limit 4096 --shm-size 2g \
  --network matrix-ci --dns 1.1.1.1 --dns 1.0.0.1 \
  --log-opt max-size=10m --log-opt max-file=2 \
  matrix-ci-benchmark:1 "$1" "$2" "$3")
status=0
# A hard host-side deadline also stops a modified repository script that hangs.
docker start "$container" >/dev/null
timeout --signal=TERM --kill-after=15s 1800s docker wait "$container" >"$result_dir/exit-code" || status=$?
if [[ $status == 0 ]]; then
  read -r status <"$result_dir/exit-code"
  [[ $status =~ ^[0-9]{1,3}$ && $status -le 255 ]] || status=70
fi
docker logs --tail 10000 "$container" >"$result_dir/output.log" 2>&1 || true
cat "$result_dir/output.log"
# Copy only bounded, named benchmark evidence, without following symlinks.
for file in unit-cold.json unit-warm.json timing.tsv; do
  (ulimit -f 102400; docker cp "$container:/work/results/$file" "$result_dir/$file") 2>/dev/null || rm -f "$result_dir/$file"
done
printf 'Benchmark exit: %s; host evidence: %s\n' "$status" "$result_dir"
exit "$status"

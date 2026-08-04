#!/usr/bin/env bash
set -euo pipefail
read -r cgroup_line </proc/self/cgroup || exit 22
[[ "$cgroup_line" == 0::* ]] || exit 22
cgroup_path="${cgroup_line#0::}"
[[ "$cgroup_path" =~ /matrix-terminal-spike@([0-9a-f]{32})[.]service$ ]] || exit 22
runtime_id="${BASH_REMATCH[1]}"
session_name="matrix-t-$runtime_id"
release_file="/run/matrix-terminal-runtime-spikes/${runtime_id:1}/pane-release/$session_name"
for _ in $(seq 1 100); do
  [ -f "$release_file" ] && break
  sleep 0.1
done
[ -f "$release_file" ] || exit 23
bash -c 'exec -a matrix-agent-probe sleep 86400' &
agent_pid=$!
cleanup() {
  kill "$agent_pid" 2>/dev/null || true
  wait "$agent_pid" 2>/dev/null || true
}
trap cleanup EXIT
exec bash --noprofile --norc -i

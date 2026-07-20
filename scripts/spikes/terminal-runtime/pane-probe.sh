#!/usr/bin/env bash
set -euo pipefail

release_file="/run/matrix-terminal-runtime-spike/pane-release/${ZELLIJ_SESSION_NAME:-missing}"
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

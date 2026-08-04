#!/usr/bin/env bash
set -euo pipefail
bash -c 'exec -a matrix-agent-probe sleep 86400' &
agent_pid=$!
cleanup() {
  kill "$agent_pid" 2>/dev/null || true
  wait "$agent_pid" 2>/dev/null || true
}
trap cleanup EXIT
exec bash --noprofile --norc -i

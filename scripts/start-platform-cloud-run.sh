#!/bin/sh
set -eu

auth_shell_port="${AUTH_SHELL_PORT:-3200}"
auth_shell_pid=""

if [ "${AUTH_SHELL_ENABLED:-true}" = "true" ]; then
  HOSTNAME=127.0.0.1 \
    node node_modules/next/dist/bin/next start shell -p "$auth_shell_port" -H 127.0.0.1 &
  auth_shell_pid="$!"
fi

node packages/platform/dist/main.js &
platform_pid="$!"

shutdown() {
  if [ -n "$auth_shell_pid" ]; then
    kill "$auth_shell_pid" 2>/dev/null || true
  fi
  kill "$platform_pid" 2>/dev/null || true
  wait "$platform_pid" 2>/dev/null || true
  if [ -n "$auth_shell_pid" ]; then
    wait "$auth_shell_pid" 2>/dev/null || true
  fi
}

trap shutdown INT TERM

wait "$platform_pid"
status="$?"

if [ -n "$auth_shell_pid" ]; then
  kill "$auth_shell_pid" 2>/dev/null || true
  wait "$auth_shell_pid" 2>/dev/null || true
fi

exit "$status"

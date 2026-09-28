#!/bin/sh
set -eu

auth_shell_port="${AUTH_SHELL_PORT:-3200}"
auth_shell_ready_path="${AUTH_SHELL_READY_PATH:-/icon-192.png}"
auth_shell_ready_timeout_sec="${AUTH_SHELL_READY_TIMEOUT_SEC:-60}"
auth_shell_pid=""
platform_pid=""

shutdown() {
  if [ -n "$auth_shell_pid" ]; then
    kill "$auth_shell_pid" 2>/dev/null || true
  fi
  if [ -n "$platform_pid" ]; then
    kill "$platform_pid" 2>/dev/null || true
  fi
  if [ -n "$platform_pid" ]; then
    wait "$platform_pid" 2>/dev/null || true
  fi
  if [ -n "$auth_shell_pid" ]; then
    wait "$auth_shell_pid" 2>/dev/null || true
  fi
}

trap 'shutdown; exit 143' INT TERM

wait_for_auth_shell() {
  deadline="$(( $(date +%s) + auth_shell_ready_timeout_sec ))"
  case "$auth_shell_ready_path" in
    /*) ;;
    *) auth_shell_ready_path="/$auth_shell_ready_path" ;;
  esac
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$auth_shell_port$auth_shell_ready_path" >/dev/null 2>&1; then
      echo "Auth shell is ready"
      return 0
    fi
    if ! kill -0 "$auth_shell_pid" 2>/dev/null; then
      echo "Auth shell exited before readiness" >&2
      return 1
    fi
    sleep 1
  done
  echo "Auth shell did not become ready" >&2
  return 1
}

if [ "${AUTH_SHELL_ENABLED:-true}" = "true" ]; then
  CLERK_SECRET_KEY="${AUTH_SHELL_CLERK_SECRET_KEY:-${CLERK_SECRET_KEY:-}}" \
    HOSTNAME=127.0.0.1 \
    node node_modules/next/dist/bin/next start shell -p "$auth_shell_port" -H 127.0.0.1 &
  auth_shell_pid="$!"

  if ! wait_for_auth_shell; then
    shutdown
    exit 1
  fi
fi

# A local production-parity run can give the bundled auth shell the Clerk
# server credential while keeping platform token verification networkless via
# CLERK_JWT_KEY. Production continues to use the ordinary CLERK_SECRET_KEY.
if [ -n "${AUTH_SHELL_CLERK_SECRET_KEY:-}" ]; then
  unset CLERK_SECRET_KEY
fi

node --import=tsx packages/platform/dist/main.js &
platform_pid="$!"

while :; do
  if ! kill -0 "$platform_pid" 2>/dev/null; then
    set +e
    wait "$platform_pid"
    status="$?"
    set -e
    echo "Platform server exited unexpectedly with status $status" >&2
    shutdown
    if [ "$status" -eq 0 ]; then
      exit 1
    fi
    exit "$status"
  fi

  if [ -n "$auth_shell_pid" ] && ! kill -0 "$auth_shell_pid" 2>/dev/null; then
    set +e
    wait "$auth_shell_pid"
    status="$?"
    set -e
    echo "Auth shell exited unexpectedly with status $status" >&2
    shutdown
    exit 1
  fi

  sleep 1
done

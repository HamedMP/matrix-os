#!/usr/bin/env bash
# Coarse health of the shared messaging bridge host as one JSON line.
#
#   {"status":"ok|degraded","services":{"<service>":"<state>",...},"client_api":true|false|null}
#
# States: healthy, running (no healthcheck), starting, unhealthy, stopped,
# missing. client_api is an HTTPS probe of /_matrix/client/versions through
# the public proxy (null when the hostname is unknown or
# MBH_HEALTH_PUBLIC_PROBE=0). Exit status 0 when ok, 1 when degraded.
# Nothing beyond these coarse values is printed.

set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="${MBH_BUNDLE_DIR:-$SCRIPT_DIR}"
STATE_DIR="${MBH_STATE_DIR:-/var/lib/matrix-bridge-host}"
SERVICES="postgres synapse mautrix-whatsapp mautrix-telegram mautrix-linkedin caddy"

compose() {
  set -- -f "$BUNDLE_DIR/docker-compose.yml" "$@"
  if [ -f "$STATE_DIR/compose.env" ]; then
    set -- --env-file "$STATE_DIR/compose.env" "$@"
  fi
  docker compose --project-directory "$BUNDLE_DIR" "$@"
}

service_state() {
  local id raw status health
  id="$(compose ps -a -q "$1" 2> /dev/null || true)"
  if [ -z "$id" ]; then
    printf 'missing'
    return 0
  fi
  raw="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2> /dev/null || true)"
  status="${raw%% *}"
  health="${raw#* }"
  if [ "$status" != "running" ]; then
    printf 'stopped'
    return 0
  fi
  case "$health" in
    healthy) printf 'healthy' ;;
    none) printf 'running' ;;
    starting) printf 'starting' ;;
    *) printf 'unhealthy' ;;
  esac
}

public_hostname() {
  local file="$STATE_DIR/host.env" line
  [ -f "$file" ] && [ ! -L "$file" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      MBH_PUBLIC_HOSTNAME=*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done < "$file"
}

overall="ok"
entries=""
for service in $SERVICES; do
  state="$(service_state "$service")"
  case "$state" in
    healthy | running) ;;
    *) overall="degraded" ;;
  esac
  entries="$entries${entries:+,}\"$service\":\"$state\""
done

client_api="null"
host="$(public_hostname)"
if [ -n "$host" ] && [ "${MBH_HEALTH_PUBLIC_PROBE:-1}" != "0" ]; then
  if curl -fsS -o /dev/null --max-time 10 --proto '=https' --max-redirs 0 "https://$host/_matrix/client/versions" 2> /dev/null; then
    client_api="true"
  else
    client_api="false"
    overall="degraded"
  fi
fi

printf '{"status":"%s","services":{%s},"client_api":%s}\n' "$overall" "$entries" "$client_api"
[ "$overall" = "ok" ]

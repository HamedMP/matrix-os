#!/usr/bin/env bash
# Query centralized logs for any Matrix OS preview/staging/fleet environment.
# The one log interface coding agents should use (see docs/dev/preview-environments.md).
#
# Usage:
#   ./scripts/preview-logs.sh --handle pr-123 [--unit matrix-gateway] [--since 15m] [--grep ERROR] [--limit 200]
#   ./scripts/preview-logs.sh --slot 2 [--since 1h]
#   ./scripts/preview-logs.sh --selector '{env="preview"}' --since 30m
#
# Runs against the ops-VPS Loki (loopback) by default; override with LOKI_URL.
set -euo pipefail

LOKI_URL="${LOKI_URL:-http://127.0.0.1:3100}"
SINCE="15m"
LIMIT="200"
GREP=""
SELECTOR=""
HANDLE=""
SLOT=""
UNIT=""

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --handle)
      HANDLE="${2:?}"
      shift 2
      ;;
    --slot)
      SLOT="${2:?}"
      shift 2
      ;;
    --unit)
      UNIT="${2:?}"
      shift 2
      ;;
    --selector)
      SELECTOR="${2:?}"
      shift 2
      ;;
    --since)
      SINCE="${2:?}"
      shift 2
      ;;
    --grep)
      GREP="${2:?}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:?}"
      shift 2
      ;;
    -h | --help) usage ;;
    *)
      echo "preview-logs: unknown flag $1" >&2
      usage
      ;;
  esac
done

if [ -z "$SELECTOR" ]; then
  if [ -n "$HANDLE" ]; then
    if ! printf '%s' "$HANDLE" | grep -Eq '^[a-z0-9][a-z0-9-]{1,62}$'; then
      echo "preview-logs: invalid handle" >&2
      exit 64
    fi
    SELECTOR="{handle=\"${HANDLE}\"}"
    if [ -n "$UNIT" ]; then
      SELECTOR="{handle=\"${HANDLE}\", unit=\"${UNIT}.service\"}"
    fi
  elif [ -n "$SLOT" ]; then
    case "$SLOT" in
      1 | 2 | 3 | 4) ;;
      *)
        echo "preview-logs: slot must be 1-4" >&2
        exit 64
        ;;
    esac
    SELECTOR="{container=~\".*matrixos-staging-${SLOT}.*\"}"
  else
    echo "preview-logs: one of --handle, --slot, --selector is required" >&2
    usage
  fi
fi

QUERY="$SELECTOR"
if [ -n "$GREP" ]; then
  QUERY="${SELECTOR} |~ \"$(printf '%s' "$GREP" | sed 's/[\\"]/\\&/g')\""
fi

case "$SINCE" in
  *m) START_SECS=$((${SINCE%m} * 60)) ;;
  *h) START_SECS=$((${SINCE%h} * 3600)) ;;
  *d) START_SECS=$((${SINCE%d} * 86400)) ;;
  *)
    echo "preview-logs: --since must end in m, h, or d" >&2
    exit 64
    ;;
esac
NOW_NS="$(date +%s)000000000"
START_NS="$(($(date +%s) - START_SECS))000000000"

curl -fsS --max-time 30 -G "${LOKI_URL}/loki/api/v1/query_range" \
  ${LOKI_AUTH:+-u "$LOKI_AUTH"} \
  --data-urlencode "query=${QUERY}" \
  --data-urlencode "start=${START_NS}" \
  --data-urlencode "end=${NOW_NS}" \
  --data-urlencode "limit=${LIMIT}" \
  --data-urlencode "direction=backward" |
  jq -r '.data.result[] as $s | $s.values[] | "\(. [0] | tonumber / 1e9 | strftime("%Y-%m-%dT%H:%M:%SZ")) [\($s.stream.unit // $s.stream.container // $s.stream.source // "-")] \(.[1])"' |
  sort

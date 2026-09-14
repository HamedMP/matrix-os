#!/usr/bin/env bash
set -euo pipefail

: "${PLATFORM_PUBLIC_URL:?PLATFORM_PUBLIC_URL is required}"
: "${PLATFORM_SECRET:?PLATFORM_SECRET is required}"
: "${HANDLE:?HANDLE is required}"
: "${PREVIEW_MACHINE_ID:?PREVIEW_MACHINE_ID is required}"
: "${PREVIEW_PROVISION_TIMEOUT_SECONDS:?PREVIEW_PROVISION_TIMEOUT_SECONDS is required}"

poll_seconds="${PREVIEW_PROVISION_POLL_SECONDS:-15}"
if ! [[ "$HANDLE" =~ ^pr-[1-9][0-9]{0,9}$ ]]; then
  echo "Preview handle is invalid." >&2
  exit 64
fi
if ! [[ "$PREVIEW_MACHINE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  echo "Preview machine ID is invalid." >&2
  exit 64
fi
if ! [[ "$PREVIEW_PROVISION_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$PREVIEW_PROVISION_TIMEOUT_SECONDS" -gt 7200 ]; then
  echo "Preview provisioning timeout is invalid." >&2
  exit 64
fi
if ! [[ "$poll_seconds" =~ ^[0-9]+$ ]] || [ "$poll_seconds" -gt 60 ]; then
  echo "Preview provisioning poll interval is invalid." >&2
  exit 64
fi

deadline=$((SECONDS + PREVIEW_PROVISION_TIMEOUT_SECONDS))
status=unknown
rate_limit_count=0
while true; do
  if ! fleet_response="$(curl -sS --max-time 30 -H "authorization: Bearer ${PLATFORM_SECRET}" --write-out $'\n%{http_code}' "${PLATFORM_PUBLIC_URL}/vps/fleet" 2>/dev/null)"; then
    echo "Preview fleet status request failed." >&2
    exit 1
  fi
  http_code="${fleet_response##*$'\n'}"
  fleet_body="${fleet_response%$'\n'*}"

  if [ "$http_code" = 429 ]; then
    rate_limit_count=$((rate_limit_count + 1))
    backoff_seconds=$((poll_seconds * (rate_limit_count + 1)))
    if [ "$backoff_seconds" -gt 60 ]; then
      backoff_seconds=60
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Timed out waiting for ${HANDLE} to reach running (last: ${status})" >&2
      exit 1
    fi
    echo "Preview fleet status is throttled; retrying in ${backoff_seconds}s." >&2
    sleep "$backoff_seconds"
    continue
  fi
  if [ "$http_code" != 200 ]; then
    echo "Preview fleet status request failed." >&2
    exit 1
  fi
  rate_limit_count=0

  if ! machine="$(jq -c --arg h "$HANDLE" --arg id "$PREVIEW_MACHINE_ID" '[.machines[] | select(.handle == $h and .machineId == $id and .deletedAt == null)] | (.[0] // {status: "absent", failureCode: null})' <<< "$fleet_body")"; then
    echo "Preview fleet status response was invalid." >&2
    exit 1
  fi
  status="$(jq -r '.status' <<< "$machine")"
  case "$status" in
    running)
      exit 0
      ;;
    failed)
      failure_code="$(jq -r '.failureCode // "unknown"' <<< "$machine")"
      if ! printf '%s' "$failure_code" | grep -Eq '^[a-z][a-z0-9_]{0,63}$'; then
        failure_code=unknown
      fi
      echo "Provisioning failed for ${HANDLE} (code: ${failure_code})" >&2
      exit 1
      ;;
    provisioning|absent)
      ;;
    *)
      echo "Preview ${HANDLE} entered an unsupported provisioning state." >&2
      exit 1
      ;;
  esac

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Timed out waiting for ${HANDLE} to reach running (last: ${status})" >&2
    exit 1
  fi
  sleep "$poll_seconds"
done

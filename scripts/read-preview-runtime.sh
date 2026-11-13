#!/usr/bin/env bash
set -euo pipefail

: "${PLATFORM_PUBLIC_URL:?PLATFORM_PUBLIC_URL is required}"
: "${PLATFORM_SECRET:?PLATFORM_SECRET is required}"
: "${HANDLE:?HANDLE is required}"

max_attempts="${PREVIEW_FLEET_MAX_ATTEMPTS:-3}"
retry_seconds="${PREVIEW_FLEET_RETRY_SECONDS:-5}"

if ! [[ "$HANDLE" =~ ^pr-[1-9][0-9]{0,9}$ ]]; then
  echo "Preview handle is invalid." >&2
  exit 64
fi
if ! [[ "$max_attempts" =~ ^[1-5]$ ]]; then
  echo "Preview fleet attempt limit is invalid." >&2
  exit 64
fi
if ! [[ "$retry_seconds" =~ ^([0-9]|[12][0-9]|30)$ ]]; then
  echo "Preview fleet retry interval is invalid." >&2
  exit 64
fi

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  fleet_body=""
  runtime=""
  if fleet_body="$(curl -fsS --max-time 30 \
    -H "authorization: Bearer ${PLATFORM_SECRET}" \
    "${PLATFORM_PUBLIC_URL}/vps/fleet" 2>/dev/null)" &&
    runtime="$(jq -ce --arg h "$HANDLE" '
      [.machines[]
        | select(.handle == $h and .runtimeSlot == $h and .status != "deleted" and .deletedAt == null)
        | . + { _preview_rank:
            (if .status == "running" then 0
             elif .status == "provisioning" then 1
             elif .status == "failed" then 2
             else 3 end) }]
       | sort_by(._preview_rank, .provisionedAt)
       | (.[0] // {status: "absent", healthy: false, runtimeVersion: null})
       | del(._preview_rank)' <<< "$fleet_body" 2>/dev/null)"; then
    printf '%s\n' "$runtime"
    exit 0
  fi

  if [ "$attempt" -lt "$max_attempts" ]; then
    echo "Preview fleet status unavailable; retrying." >&2
    sleep "$retry_seconds"
  fi
done

echo "Preview fleet status unavailable." >&2
exit 1

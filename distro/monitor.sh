#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [[ -f "$ENV_FILE" ]]; then
  PLATFORM_SECRET=$(grep '^PLATFORM_SECRET=' "$ENV_FILE" | cut -d= -f2-)
fi

PLATFORM_SECRET="${PLATFORM_SECRET:-}"
PLATFORM_URL="${PLATFORM_URL:-http://localhost:9000}"

if [[ -z "$PLATFORM_SECRET" ]]; then
  echo "Error: PLATFORM_SECRET not found in .env or environment" >&2
  exit 1
fi

RAW=$(curl -sf -H "Authorization: Bearer ${PLATFORM_SECRET}" "${PLATFORM_URL}/admin/dashboard")

if [[ $? -ne 0 || -z "$RAW" ]]; then
  echo "Error: failed to reach platform at ${PLATFORM_URL}/admin/dashboard" >&2
  exit 1
fi

if [[ "${1:-}" == "--json" ]]; then
  echo "$RAW" | jq .
  exit 0
fi

TOTAL=$(echo "$RAW" | jq -r '.summary.total')
RUNNING=$(echo "$RAW" | jq -r '.summary.running')
STOPPED=$(echo "$RAW" | jq -r '.summary.stopped')
TIMESTAMP=$(echo "$RAW" | jq -r '.timestamp')

echo "Matrix OS Platform Dashboard"
echo "Time: ${TIMESTAMP}"
echo "Containers: ${RUNNING} running / ${STOPPED} stopped / ${TOTAL} total"
echo ""

printf "%-16s %-10s %-8s %-8s %-10s %-20s\n" "HANDLE" "STATUS" "MODULES" "CONVOS" "COST" "LAST ACTIVE"
printf "%-16s %-10s %-8s %-8s %-10s %-20s\n" "------" "------" "-------" "------" "----" "-----------"

echo "$RAW" | jq -c '.containers[]' 2>/dev/null | while IFS= read -r row; do
  handle=$(echo "$row" | jq -r '.handle')
  status=$(echo "$row" | jq -r '.status')
  modules=$(echo "$row" | jq -r '.systemInfo.modules // "-"')
  convos=$(echo "$row" | jq -r '.conversationCount // "-"')
  cost=$(echo "$row" | jq -r 'if .systemInfo.todayCost then (.systemInfo.todayCost | tostring | .[0:6]) else "-" end')
  lastActive=$(echo "$row" | jq -r '.lastActive // "-" | .[0:19]')

  printf "%-16s %-10s %-8s %-8s %-10s %-20s\n" "$handle" "$status" "$modules" "$convos" "\$${cost}" "$lastActive"
done

if echo "$RAW" | jq -e '.stoppedContainers | length > 0' >/dev/null 2>&1; then
  echo ""
  echo "Stopped:"
  echo "$RAW" | jq -c '.stoppedContainers[]' 2>/dev/null | while IFS= read -r row; do
    handle=$(echo "$row" | jq -r '.handle')
    lastActive=$(echo "$row" | jq -r '.lastActive // "-" | .[0:19]')
    printf "  %-16s last active: %s\n" "$handle" "$lastActive"
  done
fi

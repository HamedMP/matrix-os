#!/usr/bin/env bash
# Enroll a Matrix OS VPS in centralized log shipping from the ops box.
#
# Usage:
#   PLATFORM_SECRET=... LOGS_INGEST_USER=... LOGS_INGEST_PASSWORD=... \
#     ./scripts/enable-vps-logship.sh <handle> <env>
#
#   handle  matrix handle of the VPS (looked up in /vps/fleet)
#   env     preview | prod | staging
#
# Optional env:
#   PLATFORM_PUBLIC_URL  (default https://app.matrix-os.com)
#   LOGS_INGEST_URL      (default https://logs.matrix-os.com)
#   VPS_SSH_KEY          (default ~/.ssh/customer_vps_smoke)
#
# Looks up the VPS public IP via the platform fleet API, then runs the
# bundled matrix-install-logship on the VPS over SSH. v1 enrollment is
# explicit per-VPS; platform-side auto-enrollment is deferred (spec 093).
set -euo pipefail

HANDLE="${1:?usage: enable-vps-logship.sh <handle> <env>}"
MATRIX_ENV="${2:?usage: enable-vps-logship.sh <handle> <env>}"
PLATFORM_PUBLIC_URL="${PLATFORM_PUBLIC_URL:-https://app.matrix-os.com}"
LOGS_INGEST_URL="${LOGS_INGEST_URL:-https://logs.matrix-os.com}"
VPS_SSH_KEY="${VPS_SSH_KEY:-$HOME/.ssh/customer_vps_smoke}"

: "${PLATFORM_SECRET:?PLATFORM_SECRET must be set}"
: "${LOGS_INGEST_USER:?LOGS_INGEST_USER must be set}"
: "${LOGS_INGEST_PASSWORD:?LOGS_INGEST_PASSWORD must be set}"

if ! printf '%s' "$HANDLE" | grep -Eq '^[a-z0-9][a-z0-9-]{1,62}$'; then
  echo "enable-vps-logship: invalid handle" >&2
  exit 64
fi
case "$MATRIX_ENV" in
  preview | prod | staging) ;;
  *)
    echo "enable-vps-logship: env must be preview|prod|staging" >&2
    exit 64
    ;;
esac

ip="$(curl -fsS --max-time 10 \
  -H "authorization: Bearer ${PLATFORM_SECRET}" \
  "${PLATFORM_PUBLIC_URL}/vps/fleet" |
  jq -r --arg h "$HANDLE" \
    '.machines[] | select(.handle == $h and .status == "running") | .publicIPv4' |
  head -1)"

if [ -z "$ip" ] || [ "$ip" = "null" ]; then
  echo "enable-vps-logship: no running VPS found for handle ${HANDLE}" >&2
  exit 1
fi

echo "enable-vps-logship: enrolling ${HANDLE} (${ip}) as env=${MATRIX_ENV}"
# Credentials go via stdin, not argv, so they never appear in remote ps output.
printf '%s\n%s\n' "$LOGS_INGEST_USER" "$LOGS_INGEST_PASSWORD" |
  ssh -i "$VPS_SSH_KEY" -o StrictHostKeyChecking=accept-new "root@${ip}" \
    "IFS= read -r u && IFS= read -r p && /opt/matrix/app/bin/matrix-install-logship '${LOGS_INGEST_URL}' \"\$u\" \"\$p\" '${HANDLE}' '${MATRIX_ENV}'"

echo "enable-vps-logship: done. Verify with: ./scripts/preview-logs.sh --handle ${HANDLE} --since 5m"

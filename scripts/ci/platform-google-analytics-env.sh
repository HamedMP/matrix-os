#!/usr/bin/env bash
# The public destination and private server credential must be deployed together.
set -euo pipefail
mode="${1:-validate}"
container="${GOOGLE_TAG_MANAGER_ID:-GTM-5D8ZT4HF}"
measurement="${GOOGLE_ANALYTICS_MEASUREMENT_ID:-}"
version="${GOOGLE_ANALYTICS_API_SECRET_VERSION:-1}"
if ! [[ "$container" =~ ^GTM-[A-Z0-9]+$ ]]; then
  echo "GOOGLE_TAG_MANAGER_ID must be a GTM container ID." >&2; exit 1
fi
if [ -n "$measurement" ]; then
  if ! [[ "$measurement" =~ ^G-[A-Z0-9]+$ ]] || ! [[ "$version" =~ ^[1-9][0-9]{0,9}$ ]]; then
    echo "Google Analytics requires a valid measurement ID and pinned numeric secret version." >&2; exit 1
  fi
fi
case "$mode" in
  validate) ;;
  env-bindings) printf '|GOOGLE_TAG_MANAGER_ID=%s|GOOGLE_ANALYTICS_MEASUREMENT_ID=%s' "$container" "$measurement" ;;
  secret-bindings)
    if [ -n "$measurement" ]; then printf ',GOOGLE_ANALYTICS_API_SECRET=google-analytics-billing-api-secret:%s' "$version"; fi
    ;;
  *) echo "Unknown Google Analytics configuration command." >&2; exit 1 ;;
esac

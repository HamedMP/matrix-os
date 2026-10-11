#!/usr/bin/env bash
# Read-only OIDC preflight. A missing/inaccessible service must never bootstrap.
set -euo pipefail

for setting in GCP_PROJECT_ID GCP_REGION CLOUD_RUN_PREVIEW_SERVICE; do
  if [ -z "${!setting:-}" ]; then
    echo "Existing preview service configuration is required." >&2
    exit 1
  fi
done

if ! metadata="$(gcloud run services describe "$CLOUD_RUN_PREVIEW_SERVICE" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
  --format='json(metadata.name,status.url)' --quiet)"; then
  echo "Existing preview service could not be verified; refusing to continue." >&2
  exit 1
fi
if ! service_url="$(jq -er --arg service "$CLOUD_RUN_PREVIEW_SERVICE" '
  select(.metadata.name == $service)
  | .status.url
  | select(type == "string")
  | select(test("^https://[a-z0-9-]+\\.a\\.run\\.app$"))
' <<< "$metadata")"; then
  echo "Existing preview service metadata is invalid; refusing to continue." >&2
  exit 1
fi
printf '%s\n' "$service_url"

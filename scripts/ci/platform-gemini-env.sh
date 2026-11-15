#!/usr/bin/env bash
# Optional, pinned Gemini key binding. Credential bytes never pass through CI.
set -euo pipefail
mode="${1:?Deployment mode is required}"
binding="${GEMINI_API_KEY_SECRET_BINDING:-}"
if [ -n "$binding" ] && ! [[ "$binding" =~ ^[a-zA-Z0-9_-]{1,255}:[1-9][0-9]{0,9}$ ]]; then
  echo 'Gemini requires a secret name and pinned numeric version.' >&2
  exit 1
fi
secret_name="${binding%:*}"
version="${binding##*:}"
case "$mode" in
  secret-bindings)
    if [ -n "$binding" ]; then printf ',GEMINI_API_KEY=%s' "$binding"; fi
    ;;
  preflight-secrets)
    if [ -z "$binding" ]; then exit 0; fi
    : "${GCP_PROJECT_ID:?}" "${CLOUD_RUN_SERVICE_ACCOUNT:?}"
    state="$(gcloud secrets versions describe "$version" --secret "$secret_name" --project "$GCP_PROJECT_ID" --format='value(state)')"
    if [ "$state" != ENABLED ]; then echo 'Gemini secret version is unavailable.' >&2; exit 1; fi
    member="serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}"
    validate_policy() {
      jq -e 'type == "object" and ((.bindings // []) | type) == "array"
        and all(.bindings[]?; (.role | type) == "string" and (.members | type) == "array"
          and all(.members[]; type == "string"))' >/dev/null
    }
    has_access() {
      jq -e --arg member "$member" 'any(.bindings[]?;
        .role == "roles/secretmanager.secretAccessor" and .condition == null
          and (.members | index($member)) != null)' >/dev/null
    }
    policy="$(gcloud secrets get-iam-policy "$secret_name" --project "$GCP_PROJECT_ID" --format=json)"
    # Reject malformed metadata before considering inherited project access.
    printf '%s' "$policy" | validate_policy
    if ! printf '%s' "$policy" | has_access; then
      policy="$(gcloud projects get-iam-policy "$GCP_PROJECT_ID" --format=json)"
      printf '%s' "$policy" | validate_policy
      if ! printf '%s' "$policy" | has_access; then
        echo 'Gemini runtime secret access is unavailable.' >&2; exit 1
      fi
    fi
    ;;
  verify-revision)
    : "${GCP_PROJECT_ID:?}" "${GCP_REGION:?}"
    revision="${2:?A reviewed revision is required}"
    gcloud run revisions describe "$revision" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json |
      jq -e --arg binding "$binding" --arg secret "$secret_name" --arg version "$version" '
        .spec.containers as $containers |
        if ($containers | type) != "array" or ($containers | length) != 1 then false
        else [$containers[0].env[]? | select(.name == "GEMINI_API_KEY")] as $keys |
          if $binding == "" then ($keys | length) == 0
          else ($keys | length) == 1 and $keys[0].value == null
            and $keys[0].valueFrom.secretKeyRef.name == $secret
            and ($keys[0].valueFrom.secretKeyRef.key | tostring) == $version end end' >/dev/null
    ;;
  *) echo 'Unknown Gemini deployment mode.' >&2; exit 1 ;;
esac

#!/usr/bin/env bash
set -euo pipefail

boolean() { case "${!1:-}" in true|false) ;; *) echo "$1 must be true or false." >&2; exit 1;; esac; }

case "${1:-}" in
  validate)
    for name in PLATFORM_SPEECH_ENABLED MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED MATRIX_FUNDED_AI_RUNTIME_ENABLED; do boolean "$name"; done
    for name in PLATFORM_SPEECH_PROVIDER PLATFORM_SPEECH_MODEL PLATFORM_SPEECH_POLICY_REVISION PLATFORM_SPEECH_MICROUSD_PER_MINUTE PLATFORM_SPEECH_FUNDING_SOURCES PLATFORM_SPEECH_OWNER_AUDIO_ENABLED MATRIX_FUNDED_AI_RELAY_URL; do
      [[ "${!name:-}" != *'|'* && "${!name:-}" != *$'\n'* && "${!name:-}" != *$'\r'* ]] || { echo "$name contains an invalid deployment delimiter." >&2; exit 1; }
    done
    if [ "$MATRIX_FUNDED_AI_RUNTIME_ENABLED" = true ] && ! [[ "${MATRIX_FUNDED_AI_RELAY_URL:-}" =~ ^https://[^/?#]+/?$ ]]; then
      echo 'MATRIX_FUNDED_AI_RELAY_URL must be an HTTPS origin when the text relay is enabled.' >&2
      exit 1
    fi
    [ "$PLATFORM_SPEECH_ENABLED" = true ] || exit 0
    [ "${PLATFORM_SPEECH_PROVIDER:-}" = openai ] || { echo 'PLATFORM_SPEECH_PROVIDER must be openai.' >&2; exit 1; }
    for name in PLATFORM_SPEECH_MODEL PLATFORM_SPEECH_POLICY_REVISION PLATFORM_SPEECH_MICROUSD_PER_MINUTE PLATFORM_SPEECH_FUNDING_SOURCES PLATFORM_SPEECH_OWNER_AUDIO_ENABLED; do
      [ -n "${!name:-}" ] || { echo "$name is required when platform speech is enabled." >&2; exit 1; }
    done
    [[ "$PLATFORM_SPEECH_MICROUSD_PER_MINUTE" =~ ^[1-9][0-9]{0,8}$ ]] || { echo 'PLATFORM_SPEECH_MICROUSD_PER_MINUTE must be a positive bounded integer.' >&2; exit 1; }
    case "$PLATFORM_SPEECH_FUNDING_SOURCES" in addon|promotional|addon,promotional|promotional,addon) ;; *) echo 'PLATFORM_SPEECH_FUNDING_SOURCES is invalid.' >&2; exit 1;; esac
    boolean PLATFORM_SPEECH_OWNER_AUDIO_ENABLED
    [[ "$PLATFORM_SPEECH_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$ ]] || { echo 'PLATFORM_SPEECH_MODEL is invalid.' >&2; exit 1; }
    [[ "$PLATFORM_SPEECH_POLICY_REVISION" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$ ]] || { echo 'PLATFORM_SPEECH_POLICY_REVISION is invalid.' >&2; exit 1; }
    ;;
  preflight-secrets)
    [ "$PLATFORM_SPEECH_ENABLED" = true ] || exit 0
    for secret_name in platform-speech-openai-api-key platform-speech-secret; do
      gcloud secrets versions describe latest --secret "$secret_name" --project "$GCP_PROJECT_ID" >/dev/null
      member="$(gcloud secrets get-iam-policy "$secret_name" --project "$GCP_PROJECT_ID" --flatten='bindings[].members' --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" --format='value(bindings.members)' | head -1)"
      [ "$member" = "serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" ] || { echo "$secret_name must be readable by the platform runtime service account." >&2; exit 1; }
    done
    ;;
  verify-revision)
    revision_json="$(gcloud run revisions describe "$CANDIDATE_REVISION" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json)"
    for name in PLATFORM_SPEECH_ENABLED MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED MATRIX_FUNDED_AI_RUNTIME_ENABLED PLATFORM_SPEECH_PROVIDER PLATFORM_SPEECH_MODEL PLATFORM_SPEECH_POLICY_REVISION PLATFORM_SPEECH_MICROUSD_PER_MINUTE PLATFORM_SPEECH_FUNDING_SOURCES PLATFORM_SPEECH_OWNER_AUDIO_ENABLED; do
      actual="$(printf '%s\n' "$revision_json" | jq -r --arg name "$name" '.spec.containers[0].env[]? | select(.name == $name) | .value // empty')"
      [ "$actual" = "${!name}" ] || { echo "candidate speech contract is incorrect for $name" >&2; exit 1; }
    done
    if [ "$PLATFORM_SPEECH_ENABLED" = true ]; then
      for binding in PLATFORM_SPEECH_OPENAI_API_KEY=platform-speech-openai-api-key:latest PLATFORM_SPEECH_SECRET=platform-speech-secret:latest; do
        name="${binding%%=*}"; expected="${binding#*=}"; secret="${expected%%:*}"; version="${expected##*:}"
        actual_secret="$(printf '%s\n' "$revision_json" | jq -r --arg name "$name" '.spec.containers[0].env[]? | select(.name == $name) | .valueFrom.secretKeyRef.name // empty')"
        actual_version="$(printf '%s\n' "$revision_json" | jq -r --arg name "$name" '.spec.containers[0].env[]? | select(.name == $name) | .valueFrom.secretKeyRef.key // empty')"
        [ "$actual_secret:$actual_version" = "$secret:$version" ] || { echo "candidate speech secret binding is incorrect for $name" >&2; exit 1; }
      done
    else
      for name in PLATFORM_SPEECH_OPENAI_API_KEY PLATFORM_SPEECH_SECRET; do
        ! printf '%s\n' "$revision_json" | jq -e --arg name "$name" 'any(.spec.containers[0].env[]?; .name == $name)' >/dev/null || { echo "disabled speech service retained secret $name" >&2; exit 1; }
      done
    fi
    for name in PLATFORM_SPEECH_PREVIEW_NO_CHARGE PLATFORM_SPEECH_PREVIEW_NOT_AFTER PLATFORM_SPEECH_PREVIEW_MAX_OPERATIONS_PER_RUNTIME; do
      ! printf '%s\n' "$revision_json" | jq -e --arg name "$name" 'any(.spec.containers[0].env[]?; .name == $name)' >/dev/null || { echo "preview-only setting $name reached production" >&2; exit 1; }
    done
    ;;
  *) echo 'usage: platform-speech-production-env.sh <validate|preflight-secrets|verify-revision>' >&2; exit 2;;
esac

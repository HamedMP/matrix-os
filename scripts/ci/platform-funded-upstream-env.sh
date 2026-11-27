#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
target="${2:-}"
if [[ "$mode" != "env-bindings" && "$mode" != "secret-bindings" && "$mode" != "verify-revision" ]] \
  || [[ "$target" != "production" && "$target" != "preview" ]]; then
  echo "Usage: platform-funded-upstream-env.sh <env-bindings|secret-bindings|verify-revision> <production|preview>" >&2
  exit 2
fi

revision_json=""
if [[ "$mode" == "verify-revision" ]]; then
  revision_json="$(head -c 1048577)"
  if (( ${#revision_json} > 1048576 )); then
    echo "Deployed revision contract is too large to verify." >&2
    exit 1
  fi
fi

enabled="${AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED:-false}"
case "$enabled" in
  true|false) ;;
  *)
    echo "AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED must be true or false." >&2
    exit 1
    ;;
esac

if [[ "$enabled" == "false" ]]; then
  if [[ "$mode" == "env-bindings" ]]; then
    printf '|AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED=false'
  elif [[ "$mode" == "verify-revision" ]]; then
    if ! jq -e '
      [.spec.containers[0].env[]?] as $env
      | ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED") | .value] == ["false"])
      and ([$env[] | select(.name == "AI_FUNDED_BEDROCK_MODEL_IDS")] | length == 0)
      and ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH")] | length == 0)
      and ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS")] | length == 0)
      and ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_SELECTION_SECRET")] | length == 0)
    ' <<< "$revision_json" >/dev/null; then
      echo "Deployed funded upstream preference contract is missing or incorrect." >&2
      exit 1
    fi
  fi
  exit 0
fi

if [[ "${MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED:-false}" != "true" ]]; then
  echo "Funded upstream preference requires the funded AI control plane." >&2
  exit 1
fi

canonical_bedrock_models="$(jq -ce '
  select(type == "array" and length >= 1 and length <= 8)
  | select(length == (unique | length))
  | select(all(.[]; type == "string" and test("^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,255}$")))
' <<< "${AI_FUNDED_BEDROCK_MODEL_IDS:-}")" || {
  echo "AI_FUNDED_BEDROCK_MODEL_IDS is invalid." >&2
  exit 1
}

if ! node -e '
  const value = process.argv[1];
  const parsed = Date.parse(value);
  const now = Date.now();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(parsed) || parsed <= now || parsed - now > 30 * 24 * 60 * 60 * 1000) process.exit(1);
' "${AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH:-}"; then
  echo "AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH must be a future UTC instant within 30 days." >&2
  exit 1
fi

if [[ "$mode" == "env-bindings" ]]; then
  printf '|AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED=true|AI_FUNDED_BEDROCK_MODEL_IDS=%s|AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH=%s' \
    "$canonical_bedrock_models" "$AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH"
  exit 0
fi

suffix=""
if [[ "$target" == "preview" ]]; then suffix="-preview"; fi
if [[ "$mode" == "verify-revision" ]]; then
  owner_secret="ai-funded-upstream-preference-owner-ids${suffix}"
  selection_secret="ai-funded-upstream-selection-secret${suffix}"
  if ! jq -e \
    --arg models "$canonical_bedrock_models" \
    --arg valid_through "$AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH" \
    --arg owner_secret "$owner_secret" \
    --arg selection_secret "$selection_secret" '
      [.spec.containers[0].env[]?] as $env
      | ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_PREFERENCE_ENABLED") | .value] == ["true"])
      and ([$env[] | select(.name == "AI_FUNDED_BEDROCK_MODEL_IDS") | .value] == [$models])
      and ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_PREFERENCE_VALID_THROUGH") | .value] == [$valid_through])
      and ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS")
             | "\(.valueFrom.secretKeyRef.name):\(.valueFrom.secretKeyRef.key)"] == [($owner_secret + ":latest")])
      and ([$env[] | select(.name == "AI_FUNDED_UPSTREAM_SELECTION_SECRET")
             | "\(.valueFrom.secretKeyRef.name):\(.valueFrom.secretKeyRef.key)"] == [($selection_secret + ":latest")])
    ' <<< "$revision_json" >/dev/null; then
    echo "Deployed funded upstream preference contract is missing or incorrect." >&2
    exit 1
  fi
  exit 0
fi

printf ',AI_FUNDED_UPSTREAM_PREFERENCE_OWNER_IDS=ai-funded-upstream-preference-owner-ids%s:latest,AI_FUNDED_UPSTREAM_SELECTION_SECRET=ai-funded-upstream-selection-secret%s:latest' \
  "$suffix" "$suffix"

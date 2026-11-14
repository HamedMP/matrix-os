#!/usr/bin/env bash
set -euo pipefail

registry="${MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED:-false}"
job="${MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED:-false}"
env_bindings=""
secret_bindings=""

fail() {
  echo "Funded AI pricing review rollout configuration is invalid." >&2
  exit 1
}

[[ "$registry" =~ ^(true|false)$ && "$job" =~ ^(true|false)$ ]] || fail
if [[ "$registry" == true ]]; then
  [[ "$job" == true ]] || fail
  env_bindings="|MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED=true"
fi

if [[ "$job" == true ]]; then
  [[ "${MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED:-false}" == true ]] || fail
  team="${MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID:-}"
  open_state="${MATRIX_FUNDED_AI_PRICING_LINEAR_OPEN_STATE_ID:-}"
  completed_state="${MATRIX_FUNDED_AI_PRICING_LINEAR_COMPLETED_STATE_ID:-}"
  version="${MATRIX_FUNDED_AI_PRICING_LINEAR_TOKEN_VERSION:-}"
  uuid='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  [[ "$team" =~ $uuid && "$open_state" =~ $uuid && "$completed_state" =~ $uuid ]] || fail
  [[ "$open_state" != "$completed_state" && "$version" =~ ^[1-9][0-9]{0,9}$ ]] || fail
  env_bindings="$env_bindings|MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED=true"
  env_bindings="$env_bindings|MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID=$team"
  env_bindings="$env_bindings|MATRIX_FUNDED_AI_PRICING_LINEAR_OPEN_STATE_ID=$open_state"
  env_bindings="$env_bindings|MATRIX_FUNDED_AI_PRICING_LINEAR_COMPLETED_STATE_ID=$completed_state"
  secret_bindings=",MATRIX_FUNDED_AI_PRICING_LINEAR_API_KEY=funded-ai-pricing-linear-token:$version"
fi

printf 'FUNDED_PRICING_ENV_BINDINGS=%s\nFUNDED_PRICING_SECRET_BINDINGS=%s\n' "$env_bindings" "$secret_bindings"

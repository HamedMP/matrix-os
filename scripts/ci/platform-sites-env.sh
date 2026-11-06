#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
revision="${2:-${CANDIDATE_REVISION:-}}"
enabled="${MATRIX_PUBLIC_SITES_ENABLED:-false}"
edge_version="${SITES_EDGE_SECRET_VERSION:-}"
edge_previous_version="${SITES_EDGE_SECRET_PREVIOUS_VERSION:-}"

secret_names=(
  sites-edge-secret
  sites-edge-secret
  r2-sites-account-id
  r2-sites-bucket
  r2-sites-endpoint
  r2-sites-access-key-id
  r2-sites-secret-access-key
)
env_names=(
  SITES_EDGE_SECRET
  SITES_EDGE_SECRET_PREVIOUS
  R2_SITES_ACCOUNT_ID
  R2_SITES_BUCKET
  R2_SITES_ENDPOINT
  R2_SITES_ACCESS_KEY_ID
  R2_SITES_SECRET_ACCESS_KEY
)
secret_versions=(
  "$edge_version"
  "$edge_previous_version"
  latest
  latest
  latest
  latest
  latest
)

validate_config() {
  case "$enabled" in
    true|false) ;;
    *) echo "MATRIX_PUBLIC_SITES_ENABLED must be true or false." >&2; return 1 ;;
  esac
  if [ "$enabled" = "true" ] && ! [[ "${PLATFORM_PUBLIC_URL:-}" =~ ^https://[^/?#[:space:]]+/?$ ]]; then
    echo "Public Sites require PLATFORM_PUBLIC_URL to be one HTTPS origin." >&2
    return 1
  fi
  if [ "$enabled" = "true" ]; then
    for name in SITES_EDGE_SECRET_VERSION SITES_EDGE_SECRET_PREVIOUS_VERSION; do
      if ! [[ "${!name:-}" =~ ^[1-9][0-9]*$ ]]; then
        echo "$name must be a pinned numeric Secret Manager version." >&2
        return 1
      fi
    done
  fi
}

secret_bindings() {
  [ "$enabled" = "true" ] || return 0
  local result=""
  for index in "${!secret_names[@]}"; do
    result+=",${env_names[$index]}=${secret_names[$index]}:${secret_versions[$index]}"
  done
  printf '%s' "$result"
}

preflight_secrets() {
  [ "$enabled" = "true" ] || return 0
  local directory runtime_member
  directory="$(mktemp -d)"
  runtime_member="serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}"
  local cleanup_command
  printf -v cleanup_command 'rm -rf -- %q' "$directory"
  trap "$cleanup_command" EXIT
  chmod 700 "$directory"

  for index in "${!secret_names[@]}"; do
    local name version env_name state path
    name="${secret_names[$index]}"
    version="${secret_versions[$index]}"
    env_name="${env_names[$index]}"
    state="$(gcloud secrets versions describe "$version" --secret "$name" \
      --project "$GCP_PROJECT_ID" --quiet --format='value(state)')"
    if [ "$state" != "ENABLED" ]; then
      echo "$name must have enabled version $version." >&2
      return 1
    fi
    path="$directory/$env_name"
    if ! gcloud secrets versions access "$version" --secret "$name" \
      --project "$GCP_PROJECT_ID" --quiet --out-file="$path"; then
      echo "$name version $version must be accessible to the deployer." >&2
      return 1
    fi
    chmod 600 "$path"
  done
  for name in r2-bucket r2-bundles-bucket; do
    local state path
    state="$(gcloud secrets versions describe latest --secret "$name" \
      --project "$GCP_PROJECT_ID" --quiet --format='value(state)')"
    if [ "$state" != "ENABLED" ]; then
      echo "$name must have an enabled latest version." >&2
      return 1
    fi
    path="$directory/$name"
    gcloud secrets versions access latest --secret "$name" \
      --project "$GCP_PROJECT_ID" --quiet --out-file="$path"
    chmod 600 "$path"
  done

  if ! node - "$directory" <<'NODE'
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.argv[2];
const read = (name) => readFileSync(join(directory, name), 'utf8');
const edge = read('SITES_EDGE_SECRET');
const previousEdge = read('SITES_EDGE_SECRET_PREVIOUS');
const account = read('R2_SITES_ACCOUNT_ID');
const bucket = read('R2_SITES_BUCKET');
const endpoint = read('R2_SITES_ENDPOINT');
const accessKey = read('R2_SITES_ACCESS_KEY_ID');
const secretKey = read('R2_SITES_SECRET_ACCESS_KEY');
const syncBucket = read('r2-bucket');
const bundleBucket = read('r2-bundles-bucket');
const exact = (value) => value.length > 0 && value === value.trim() && !/[\r\n]/.test(value);
let valid = edge.length >= 32 && previousEdge.length >= 32 && exact(edge) && exact(previousEdge)
  && /^[a-f0-9]{32}$/.test(account)
  && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
  && bucket !== syncBucket && bucket !== bundleBucket
  && exact(account) && exact(bucket) && exact(endpoint)
  && exact(accessKey) && exact(secretKey) && exact(syncBucket) && exact(bundleBucket);
try {
  const parsed = new URL(endpoint);
  valid &&= parsed.protocol === 'https:'
    && (parsed.hostname === `${account}.r2.cloudflarestorage.com`
      || parsed.hostname === `${account}.eu.r2.cloudflarestorage.com`)
    && parsed.port === '' && parsed.pathname === '/'
    && parsed.username === '' && parsed.password === ''
    && parsed.search === '' && parsed.hash === '';
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
  console.error('Sites endpoint URL is invalid.');
  valid = false;
}
if (!valid) process.exit(1);
NODE
  then
    echo "Dedicated Sites edge/storage configuration is invalid." >&2
    return 1
  fi

  for name in "${secret_names[@]}"; do
    local accessor_member
    accessor_member="$(gcloud secrets get-iam-policy "$name" \
      --project "$GCP_PROJECT_ID" --quiet \
      --flatten='bindings[].members' \
      --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:${runtime_member}" \
      --format='value(bindings.members)' | head -1)"
    if [ "$accessor_member" != "$runtime_member" ]; then
      echo "$name must grant secretAccessor directly to the Cloud Run runtime identity." >&2
      return 1
    fi
  done

  rm -rf "$directory"
  trap - EXIT
}

verify_transition() {
  [ "$enabled" = "true" ] || return 0
  local existing_service service_json live_revision revision_json live_version
  existing_service="$(gcloud run services list \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
    --filter="metadata.name=${CLOUD_RUN_SERVICE}" --limit=1 \
    --format='value(metadata.name)')"
  # An empty, successful list is the one-time bootstrap path. List failures
  # still stop the release so permission and connectivity errors are not hidden.
  [ -n "$existing_service" ] || return 0
  service_json="$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json)"
  live_revision="$(printf '%s\n' "$service_json" | jq -r \
    '(.status.traffic[]? | select((.percent // 0) > 0) | .revisionName) // empty' | head -1)"
  if [ -z "$live_revision" ]; then
    echo "Could not resolve the live platform revision for the Sites edge-secret transition." >&2
    return 1
  fi
  revision_json="$(gcloud run revisions describe "$live_revision" \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json)"
  live_version="$(printf '%s\n' "$revision_json" | jq -r \
    '.spec.containers[0].env[]? | select(.name == "SITES_EDGE_SECRET") | .valueFrom.secretKeyRef.key // empty')"
  # No binding is the one-time bootstrap from the pre-Sites production state.
  [ -n "$live_version" ] || return 0
  if [ "$live_version" != "$edge_version" ] && [ "$live_version" != "$edge_previous_version" ]; then
    echo "SITES_EDGE_SECRET_PREVIOUS_VERSION must match the currently active edge-secret version before rotation." >&2
    return 1
  fi
}

verify_revision() {
  if [ -z "$revision" ]; then
    echo "Expected a Cloud Run revision to verify." >&2
    return 1
  fi
  local revision_json actual_enabled
  revision_json="$(gcloud run revisions describe "$revision" \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json)"
  actual_enabled="$(printf '%s\n' "$revision_json" | jq -r \
    '.spec.containers[0].env[]? | select(.name == "MATRIX_PUBLIC_SITES_ENABLED") | .value // empty')"
  if [ "$actual_enabled" != "$enabled" ]; then
    echo "Public Sites configuration flag is missing or incorrect on $revision." >&2
    return 1
  fi
  for index in "${!secret_names[@]}"; do
    local env_name expected_name expected_version actual
    env_name="${env_names[$index]}"
    expected_name="${secret_names[$index]}"
    expected_version="${secret_versions[$index]}"
    actual="$(printf '%s\n' "$revision_json" | jq -r --arg env_name "$env_name" \
      '.spec.containers[0].env[]? | select(.name == $env_name) | "\(.valueFrom.secretKeyRef.name // ""):\(.valueFrom.secretKeyRef.key // "")"')"
    if [ "$enabled" = "true" ] && [ "$actual" != "${expected_name}:${expected_version}" ]; then
      echo "$env_name is missing or not bound to the reviewed secret on $revision." >&2
      return 1
    fi
    if [ "$enabled" = "false" ] && [ -n "$actual" ]; then
      echo "$env_name must not be bound while public Sites are disabled on $revision." >&2
      return 1
    fi
  done
}

validate_config
case "$mode" in
  validate) ;;
  secret-bindings) secret_bindings ;;
  preflight-secrets) preflight_secrets ;;
  verify-transition) verify_transition ;;
  verify-revision) verify_revision ;;
  *) echo "Usage: $0 <validate|secret-bindings|preflight-secrets|verify-transition|verify-revision> [revision]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
revision="${2:-${CANDIDATE_REVISION:-}}"
role="${3:-api}"
configured="${ACCOUNT_DELETION_CONFIGURED:-false}"
enabled="${ACCOUNT_DELETION_ENABLED:-false}"
deletion_version="${ACCOUNT_DELETION_SECRET_VERSION:-1}"
webhook_version="${CLERK_USER_WEBHOOK_SECRET_VERSION:-1}"
apple_version="${APPLE_SIGN_IN_SECRET_VERSION:-1}"

secret_names=(
  account-deletion-secret
  clerk-user-webhook-signing-secret
  apple-team-id
  apple-sign-in-key-id
  apple-sign-in-private-key
  apple-services-id
  apple-native-client-id
)
secret_versions=(
  "$deletion_version"
  "$webhook_version"
  "$apple_version"
  "$apple_version"
  "$apple_version"
  "$apple_version"
  "$apple_version"
)
env_names=(
  ACCOUNT_DELETION_SECRET
  CLERK_USER_WEBHOOK_SIGNING_SECRET
  APPLE_TEAM_ID
  APPLE_KEY_ID
  APPLE_PRIVATE_KEY
  APPLE_SERVICES_ID
  APPLE_NATIVE_CLIENT_ID
)

validate_config() {
  case "$configured" in
    true|false) ;;
    *) echo "ACCOUNT_DELETION_CONFIGURED must be true or false." >&2; return 1 ;;
  esac
  case "$enabled" in
    true|false) ;;
    *) echo "ACCOUNT_DELETION_ENABLED must be true or false." >&2; return 1 ;;
  esac
  if [ "$configured" = "false" ] && [ "$enabled" = "true" ]; then
    echo "ACCOUNT_DELETION_ENABLED cannot be true until account deletion is configured." >&2
    return 1
  fi
  if [ "$configured" = "false" ]; then
    return
  fi
  for version_name in ACCOUNT_DELETION_SECRET_VERSION CLERK_USER_WEBHOOK_SECRET_VERSION APPLE_SIGN_IN_SECRET_VERSION; do
    if ! [[ "${!version_name:-}" =~ ^[1-9][0-9]*$ ]]; then
      echo "$version_name must be a pinned numeric Secret Manager version." >&2
      return 1
    fi
  done
}

secret_bindings() {
  [ "$configured" = "true" ] || return 0
  local result=""
  for index in "${!secret_names[@]}"; do
    result+=",${env_names[$index]}=${secret_names[$index]}:${secret_versions[$index]}"
  done
  printf '%s' "$result"
}

validate_secret_value() {
  local name="$1"
  local path="$2"
  case "$name" in
    account-deletion-secret)
      node -e '
        const value = require("node:fs").readFileSync(process.argv[1], "utf8");
        if (Buffer.byteLength(value) < 32 || /[\r\n]/.test(value)) process.exit(1);
      ' "$path"
      ;;
    clerk-user-webhook-signing-secret)
      jq -Rse 'test("\\Awhsec_[A-Za-z0-9+/=]{16,}\\z") and ((((ltrimstr("whsec_") | gsub("="; "") | length) * 3 / 4) | floor) >= 16)' "$path" >/dev/null
      ;;
    apple-team-id|apple-sign-in-key-id)
      node -e '
        const value = require("node:fs").readFileSync(process.argv[1], "utf8");
        if (value.length !== 10 || /[^A-Z0-9]/.test(value)) process.exit(1);
      ' "$path"
      ;;
    apple-sign-in-private-key)
      node -e '
        const { createPrivateKey, createPublicKey, sign, verify } = require("node:crypto");
        const { readFileSync } = require("node:fs");
        const value = readFileSync(process.argv[1], "utf8");
        if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\r?\n?$/.test(value)) process.exit(1);
        try {
          const key = createPrivateKey(value);
          if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") process.exit(1);
          const probe = Buffer.from("matrix-account-deletion-preflight", "utf8");
          const signature = sign("sha256", probe, key);
          if (!verify("sha256", probe, createPublicKey(key), signature)) process.exit(1);
        } catch {
          process.exit(1);
        }
      ' "$path"
      ;;
    apple-services-id)
      node -e '
        const value = require("node:fs").readFileSync(process.argv[1], "utf8");
        if (value.length < 3 || value.length > 255 || !/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9.-]/.test(value)) process.exit(1);
      ' "$path"
      ;;
    apple-native-client-id)
      node -e '
        const value = require("node:fs").readFileSync(process.argv[1], "utf8");
        if (value !== "com.matrixos.mobile") process.exit(1);
      ' "$path"
      ;;
  esac
}

preflight_secrets() {
  [ "$configured" = "true" ] || return 0
  local runtime_member="serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}"
  local value_file
  value_file="$(mktemp)"
  local cleanup_command
  printf -v cleanup_command 'rm -f -- %q' "$value_file"
  trap "$cleanup_command" EXIT
  chmod 600 "$value_file"
  for index in "${!secret_names[@]}"; do
    local name="${secret_names[$index]}"
    local version="${secret_versions[$index]}"
    local state
    state="$(gcloud secrets versions describe "$version" --secret "$name" \
      --project "$GCP_PROJECT_ID" --quiet --format='value(state)')"
    if [ "$state" != "ENABLED" ]; then
      echo "$name must have an enabled pinned version $version." >&2
      return 1
    fi
    if ! gcloud secrets versions access "$version" --secret "$name" \
      --project "$GCP_PROJECT_ID" --quiet >"$value_file"; then
      echo "$name version $version must be accessible to the deployer." >&2
      return 1
    fi
    if ! validate_secret_value "$name" "$value_file"; then
      echo "$name version $version is invalid." >&2
      return 1
    fi
    : >"$value_file"
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
  rm -f "$value_file"
  trap - EXIT
}

verify_revision() {
  if [ -z "$revision" ]; then
    echo "Expected a Cloud Run revision to verify." >&2
    return 1
  fi
  local revision_json
  revision_json="$(gcloud run revisions describe "$revision" \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json)"
  local actual_configured actual_enabled expected_enabled
  actual_configured="$(printf '%s\n' "$revision_json" | jq -r \
    '.spec.containers[0].env[]? | select(.name == "ACCOUNT_DELETION_CONFIGURED") | .value // empty')"
  actual_enabled="$(printf '%s\n' "$revision_json" | jq -r \
    '.spec.containers[0].env[]? | select(.name == "ACCOUNT_DELETION_ENABLED") | .value // empty')"
  if [ "$actual_configured" != "$configured" ]; then
    echo "Account deletion configuration flag is missing or incorrect on $revision." >&2
    return 1
  fi
  case "$role" in
    api) expected_enabled="$enabled" ;;
    worker)
      expected_enabled="$enabled"
      [ "$configured" = "false" ] || expected_enabled="true"
      ;;
    *) echo "Expected revision role api or worker." >&2; return 1 ;;
  esac
  if [ "$actual_enabled" != "$expected_enabled" ]; then
    echo "Account deletion flag is missing or incorrect on $revision." >&2
    return 1
  fi
  for index in "${!secret_names[@]}"; do
    local env_name="${env_names[$index]}"
    local expected_name="${secret_names[$index]}"
    local expected_version="${secret_versions[$index]}"
    local actual
    actual="$(printf '%s\n' "$revision_json" | jq -r --arg env_name "$env_name" \
      '.spec.containers[0].env[]? | select(.name == $env_name) | "\(.valueFrom.secretKeyRef.name // ""):\(.valueFrom.secretKeyRef.key // "")"')"
    if [ "$configured" = "true" ] && [ "$actual" != "${expected_name}:${expected_version}" ]; then
      echo "$env_name is missing or not pinned to the reviewed secret version on $revision." >&2
      return 1
    fi
    if [ "$configured" = "false" ] && [ -n "$actual" ]; then
      echo "$env_name must not be bound before account deletion is configured on $revision." >&2
      return 1
    fi
  done
}

validate_config
case "$mode" in
  validate) ;;
  secret-bindings) secret_bindings ;;
  preflight-secrets) preflight_secrets ;;
  verify-revision) verify_revision ;;
  *) echo "Usage: $0 <validate|secret-bindings|preflight-secrets|verify-revision> [revision] [api|worker]" >&2; exit 2 ;;
esac

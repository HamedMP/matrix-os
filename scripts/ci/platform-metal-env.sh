#!/usr/bin/env bash
# Metal hosts and the free tier (spec 2691, ENG-520): off unless explicitly enabled.
# Settings come from GitHub environment variables; hostd credentials stay in Secret Manager.
set -euo pipefail

mode="${1:-validate}"
metal="${METAL_HOSTS_ENABLED:-0}"
ca_enabled="${METAL_HOSTD_CA_PEM_ENABLED:-true}"
golden="${METAL_GOLDEN_VERSION:-}"
pool_data="${METAL_POOL_MAX_DATA_PERCENT:-}"
pool_metadata="${METAL_POOL_MAX_METADATA_PERCENT:-}"
free="${MATRIX_FREE_TIER_ENABLED:-0}"
max_runtimes="${MATRIX_FREE_TIER_MAX_RUNTIMES:-}"
invite="${MATRIX_FREE_TIER_INVITE_REQUIRED:-true}"
daily_spend="${MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD:-}"
sleep_enabled="${MATRIX_FREE_TIER_SLEEP_ENABLED:-0}"

fail() { echo "$1" >&2; exit 1; }
for flag in METAL_HOSTS_ENABLED MATRIX_FREE_TIER_ENABLED MATRIX_FREE_TIER_SLEEP_ENABLED; do
  case "${!flag:-0}" in 0|1) ;; *) fail "$flag must be 0 or 1." ;; esac
done
if [ "$metal" = "0" ] && { [ "$free" = "1" ] || [ "$sleep_enabled" = "1" ]; }; then
  fail "MATRIX_FREE_TIER_ENABLED and MATRIX_FREE_TIER_SLEEP_ENABLED require METAL_HOSTS_ENABLED=1."
fi
# Every value below is spliced into a '|'-delimited gcloud list, so each one is a strict pattern.
if [ "$metal" = "1" ]; then
  case "$ca_enabled" in true|false) ;; *) fail "METAL_HOSTD_CA_PEM_ENABLED must be true or false." ;; esac
  # Same rule as the platform's metal config and hostd's create contract.
  [[ "$golden" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    fail "METAL_GOLDEN_VERSION must be a golden disk version ([A-Za-z0-9][A-Za-z0-9._-]{0,63})."
  for name in METAL_POOL_MAX_DATA_PERCENT METAL_POOL_MAX_METADATA_PERCENT; do
    if [ -n "${!name:-}" ] && ! [[ "${!name}" =~ ^([1-9]|[1-9][0-9]|100)$ ]]; then
      fail "$name must be an integer from 1 to 100 when set."
    fi
  done
fi
if [ "$free" = "1" ]; then
  case "$invite" in true|false) ;; *) fail "MATRIX_FREE_TIER_INVITE_REQUIRED must be true or false." ;; esac
  [[ "$max_runtimes" =~ ^[1-9][0-9]{0,5}$ ]] || fail "MATRIX_FREE_TIER_MAX_RUNTIMES must be an integer from 1 to 999999."
  if [ -n "$daily_spend" ] && ! [[ "$daily_spend" =~ ^[1-9][0-9]{0,14}$ ]]; then
    fail "MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD must be a positive integer of at most 15 digits (micro-USD)."
  fi
fi

# NAME=absent | NAME=plain:<value> | NAME=secret:<secret>:<version>. Every managed name is listed,
# so verify-revision also proves a disabled revision carries none of them.
expected=()
add_plain() { if [ -n "$2" ]; then expected+=("$1=plain:$2"); else expected+=("$1=absent"); fi; }
if [ "$metal" = "1" ]; then
  expected+=("METAL_HOSTS_ENABLED=plain:1" "METAL_GOLDEN_VERSION=plain:${golden}")
  add_plain METAL_POOL_MAX_DATA_PERCENT "$pool_data"
  add_plain METAL_POOL_MAX_METADATA_PERCENT "$pool_metadata"
  expected+=(
    METAL_HOSTD_API_TOKEN=secret:metal-hostd-api-token:latest
    METAL_HOSTD_INGRESS_TOKEN=secret:metal-hostd-ingress-token:latest
  )
  if [ "$ca_enabled" = "true" ]; then
    expected+=(METAL_HOSTD_CA_PEM=secret:metal-hostd-ca-pem:latest)
  else
    expected+=(METAL_HOSTD_CA_PEM=absent)
  fi
else
  expected+=(METAL_HOSTS_ENABLED=absent METAL_GOLDEN_VERSION=absent METAL_POOL_MAX_DATA_PERCENT=absent
    METAL_POOL_MAX_METADATA_PERCENT=absent METAL_HOSTD_API_TOKEN=absent METAL_HOSTD_INGRESS_TOKEN=absent
    METAL_HOSTD_CA_PEM=absent)
fi
if [ "$free" = "1" ]; then
  expected+=("MATRIX_FREE_TIER_ENABLED=plain:1" "MATRIX_FREE_TIER_MAX_RUNTIMES=plain:${max_runtimes}"
    "MATRIX_FREE_TIER_INVITE_REQUIRED=plain:${invite}")
  add_plain MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD "$daily_spend"
else
  expected+=(MATRIX_FREE_TIER_ENABLED=absent MATRIX_FREE_TIER_MAX_RUNTIMES=absent
    MATRIX_FREE_TIER_INVITE_REQUIRED=absent MATRIX_FREE_TIER_DAILY_FUNDED_SPEND_MICROUSD=absent)
fi
if [ "$sleep_enabled" = "1" ]; then
  expected+=(MATRIX_FREE_TIER_SLEEP_ENABLED=plain:1)
else
  expected+=(MATRIX_FREE_TIER_SLEEP_ENABLED=absent)
fi

case "$mode" in
  validate) ;;
  env-bindings)
    for entry in "${expected[@]}"; do
      name="${entry%%=*}"; spec="${entry#*=}"
      if [[ "$spec" == plain:* ]]; then printf '|%s=%s' "$name" "${spec#plain:}"; fi
    done
    ;;
  secret-bindings)
    for entry in "${expected[@]}"; do
      name="${entry%%=*}"; spec="${entry#*=}"
      if [[ "$spec" == secret:* ]]; then reference="${spec#secret:}"; printf ',%s=%s' "$name" "$reference"; fi
    done
    ;;
  preflight-secrets)
    if [ "$metal" = "0" ]; then exit 0; fi
    : "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
    : "${CLOUD_RUN_SERVICE_ACCOUNT:?CLOUD_RUN_SERVICE_ACCOUNT is required}"
    umask 077
    secret_dir="$(mktemp -d)"
    trap 'rm -rf "$secret_dir"' EXIT
    for entry in "${expected[@]}"; do
      name="${entry%%=*}"; spec="${entry#*=}"
      [[ "$spec" == secret:* ]] || continue
      reference="${spec#secret:}"
      secret_name="${reference%%:*}"
      version="${reference##*:}"
      state="$(gcloud secrets versions describe "$version" --secret "$secret_name" --project "$GCP_PROJECT_ID" --format='value(state)')"
      if [ "$state" != "ENABLED" ]; then fail "Metal hosts require an enabled secret version for $name."; fi
      gcloud secrets versions access "$version" --secret "$secret_name" --project "$GCP_PROJECT_ID" > "$secret_dir/$name"
      if [ ! -s "$secret_dir/$name" ] || [ "$(wc -c < "$secret_dir/$name")" -gt 65536 ]; then
        fail "Metal host configuration is invalid for $name."
      fi
      accessor="$(gcloud secrets get-iam-policy "$secret_name" --project "$GCP_PROJECT_ID" --flatten='bindings[].members' \
        --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" --format='value(bindings.members)' | head -1)"
      if [ "$accessor" != "serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" ]; then fail "Metal host runtime secret access is unavailable for $name."; fi
    done
    node - "$secret_dir" "$ca_enabled" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
class MetalConfigurationError extends Error {}
try {
  const read = name => fs.readFileSync(path.join(process.argv[2], name), 'utf8');
  // The platform reads tokens untrimmed: 32-512 printable ASCII, no whitespace or trailing newline.
  for (const name of ['METAL_HOSTD_API_TOKEN', 'METAL_HOSTD_INGRESS_TOKEN']) {
    if (!/^[\x21-\x7e]{32,512}$/.test(read(name))) throw new MetalConfigurationError();
  }
  if (read('METAL_HOSTD_API_TOKEN') === read('METAL_HOSTD_INGRESS_TOKEN')) throw new MetalConfigurationError();
  if (process.argv[3] === 'true') {
    const pem = read('METAL_HOSTD_CA_PEM').trim().replace(/\\n/g, '\n');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) throw new MetalConfigurationError();
    try { new X509Certificate(pem); } catch (error) { if (error instanceof Error) throw new MetalConfigurationError(); throw error; }
  }
} catch (error) {
  const type = error instanceof MetalConfigurationError ? 'invalid_configuration'
    : error instanceof Error && 'code' in error ? 'file_unavailable'
    : error instanceof Error ? 'unexpected_error' : 'unknown_error';
  process.stderr.write(`Metal host secret validation failed (${type}).\n`); process.exit(1);
}
NODE
    ;;
  verify-revision)
    revision="${2:?A reviewed revision is required}"
    : "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
    : "${GCP_REGION:?GCP_REGION is required}"
    revision_file="$(mktemp)"
    trap 'rm -f "$revision_file"' EXIT
    gcloud run revisions describe "$revision" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=json > "$revision_file"
    node - "$revision_file" "${expected[@]}" <<'NODE'
const fs = require('node:fs');
class MetalConfigurationError extends Error {}
try {
  const containers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(containers[0].env)) throw new MetalConfigurationError();
  for (const entry of process.argv.slice(3)) {
    const separator = entry.indexOf('=');
    const name = entry.slice(0, separator);
    const spec = entry.slice(separator + 1);
    const matches = containers[0].env.filter(item => item.name === name);
    if (spec === 'absent') { if (matches.length !== 0) throw new MetalConfigurationError(); continue; }
    if (matches.length !== 1) throw new MetalConfigurationError();
    const [match] = matches;
    if (spec.startsWith('plain:')) {
      if (match.value !== spec.slice('plain:'.length) || match.valueFrom !== undefined) throw new MetalConfigurationError();
    } else {
      const [, secret, version] = spec.split(':');
      if (match.value !== undefined || match.valueFrom?.secretKeyRef?.name !== secret
        || String(match.valueFrom?.secretKeyRef?.key) !== version) throw new MetalConfigurationError();
    }
  }
} catch (error) {
  const type = error instanceof MetalConfigurationError ? 'invalid_configuration'
    : error instanceof SyntaxError ? 'invalid_json'
    : error instanceof Error && 'code' in error ? 'file_unavailable'
    : error instanceof Error ? 'unexpected_error' : 'unknown_error';
  process.stderr.write(`Metal host revision validation failed (${type}).\n`); process.exit(1);
}
NODE
    ;;
  *) fail "Unknown metal deployment mode." ;;
esac

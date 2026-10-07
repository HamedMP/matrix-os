#!/usr/bin/env bash
# Native Slack is explicitly enabled; installation credentials stay secret-backed.
set -euo pipefail
mode="${1:-validate}"
enabled="${SLACK_ENABLED:-false}"
key_version="${SLACK_TOKEN_ENCRYPTION_KEY_VERSION:-1}"
case "$enabled" in true|false) ;; *) echo "SLACK_ENABLED must be true or false." >&2; exit 1 ;; esac
if [ "$enabled" = "true" ] && ! [[ "$key_version" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Slack encryption requires a pinned numeric secret version." >&2; exit 1
fi
bindings=(
  SLACK_APP_ID=slack-app-id:latest
  SLACK_CLIENT_ID=slack-client-id:latest
  SLACK_CLIENT_SECRET=slack-client-secret:latest
  SLACK_SIGNING_SECRET=slack-signing-secret:latest
  "SLACK_TOKEN_ENCRYPTION_KEY=slack-token-encryption-key:${key_version}"
  SLACK_PUBLIC_BASE_URL=slack-public-base-url:latest
)
case "$mode" in
  validate) ;;
  secret-bindings)
    if [ "$enabled" = "true" ]; then printf ',%s' "${bindings[@]}"; fi
    ;;
  preflight-secrets)
    if [ "$enabled" = "false" ]; then exit 0; fi
    : "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
    : "${CLOUD_RUN_SERVICE_ACCOUNT:?CLOUD_RUN_SERVICE_ACCOUNT is required}"
    umask 077
    secret_dir="$(mktemp -d)"
    trap 'rm -rf "$secret_dir"' EXIT
    for binding in "${bindings[@]}"; do
      name="${binding%%=*}"
      reference="${binding#*=}"
      secret_name="${reference%%:*}"
      version="${reference##*:}"
      state="$(gcloud secrets versions describe "$version" --secret "$secret_name" --project "$GCP_PROJECT_ID" --format='value(state)')"
      if [ "$state" != "ENABLED" ]; then echo "Slack requires an enabled version for $name." >&2; exit 1; fi
      gcloud secrets versions access "$version" --secret "$secret_name" --project "$GCP_PROJECT_ID" > "$secret_dir/$name"
      if [ ! -s "$secret_dir/$name" ] || [ "$(wc -c < "$secret_dir/$name")" -gt 4096 ]; then
        echo "Slack configuration is invalid for $name." >&2; exit 1
      fi
      accessor="$(gcloud secrets get-iam-policy "$secret_name" --project "$GCP_PROJECT_ID" --flatten='bindings[].members' \
        --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" --format='value(bindings.members)' | head -1)"
      if [ "$accessor" != "serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" ]; then echo "Slack runtime secret access is unavailable for $name." >&2; exit 1; fi
    done
    node - "$secret_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
try {
  const read = name => fs.readFileSync(path.join(process.argv[2], name), 'utf8');
  if (!/^A[A-Z0-9]{2,63}$/.test(read('SLACK_APP_ID')) || !/^\d+\.\d+$/.test(read('SLACK_CLIENT_ID'))) throw new Error();
  for (const name of ['SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET']) {
    const value = read(name);
    if (value.length < 16 || value.length > 256) throw new Error();
  }
  const encoded = read('SLACK_TOKEN_ENCRYPTION_KEY');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error();
  const url = new URL(read('SLACK_PUBLIC_BASE_URL'));
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error();
} catch {
  process.stderr.write('Slack secret configuration is invalid.\n'); process.exit(1);
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
    node - "$revision_file" "$enabled" "${bindings[@]}" <<'NODE'
const fs = require('node:fs');
try {
  const containers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(containers[0].env)) throw new Error();
  for (const binding of process.argv.slice(4)) {
    const [name, reference] = binding.split('=');
    const [secret, version] = reference.split(':');
    const matches = containers[0].env.filter(entry => entry.name === name);
    if (process.argv[3] === 'false') { if (matches.length !== 0) throw new Error(); }
    else if (matches.length !== 1 || matches[0].value !== undefined
      || matches[0].valueFrom?.secretKeyRef?.name !== secret || String(matches[0].valueFrom?.secretKeyRef?.key) !== version) throw new Error();
  }
} catch {
  process.stderr.write('Slack revision does not match the reviewed deployment contract.\n'); process.exit(1);
}
NODE
    ;;
  *) echo "Unknown Slack deployment mode." >&2; exit 1 ;;
esac

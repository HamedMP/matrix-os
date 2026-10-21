#!/usr/bin/env bash
# Opt-in deployment contract; values stay in Secret Manager and private temp files.
set -euo pipefail

mode="${1:-validate}"
enabled="${WHATSAPP_ENABLED:-false}"
key_version="${WHATSAPP_ENCRYPTION_KEY_VERSION:-1}"
case "$enabled" in
  true|false) ;;
  *) echo "WHATSAPP_ENABLED must be true or false." >&2; exit 1 ;;
esac
if [ "$enabled" = "true" ] && ! [[ "$key_version" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "WHATSAPP_ENCRYPTION_KEY_VERSION must be a pinned numeric secret version." >&2
  exit 1
fi

bindings=(
  WHATSAPP_APP_SECRET=whatsapp-app-secret:latest
  WHATSAPP_VERIFY_TOKEN=whatsapp-verify-token:latest
  WHATSAPP_ACCESS_TOKEN=whatsapp-access-token:latest
  WHATSAPP_PHONE_NUMBER_ID=whatsapp-phone-number-id:latest
  WHATSAPP_GRAPH_API_VERSION=whatsapp-graph-api-version:latest
  "WHATSAPP_ENCRYPTION_KEY=whatsapp-encryption-key:${key_version}"
  WHATSAPP_PUBLIC_URL=whatsapp-public-url:latest
  WHATSAPP_ALLOWED_SENDERS=whatsapp-allowed-senders:latest
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
      state="$(gcloud secrets versions describe "$version" --secret "$secret_name" \
        --project "$GCP_PROJECT_ID" --format='value(state)')"
      if [ "$state" != "ENABLED" ]; then
        echo "WhatsApp requires an enabled version for $name." >&2; exit 1
      fi
      if ! gcloud secrets versions access "$version" --secret "$secret_name" \
        --project "$GCP_PROJECT_ID" > "$secret_dir/$name"; then
        echo "WhatsApp requires an accessible secret version for $name." >&2; exit 1
      fi
      if [ ! -s "$secret_dir/$name" ] || [ "$(wc -c < "$secret_dir/$name")" -gt 65536 ]; then
        echo "WhatsApp configuration is invalid for $name." >&2; exit 1
      fi
      accessor="$(gcloud secrets get-iam-policy "$secret_name" --project "$GCP_PROJECT_ID" \
        --flatten='bindings[].members' \
        --filter="bindings.role:roles/secretmanager.secretAccessor AND bindings.members:serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" \
        --format='value(bindings.members)' | head -1)"
      if [ "$accessor" != "serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" ]; then
        echo "WhatsApp requires runtime secretAccessor access for $name." >&2; exit 1
      fi
    done
    # Mirror config.ts's boundary validation without installing application dependencies.
    # No secret is passed in command arguments or printed on a validation failure.
    node - "$secret_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
try {
  const read = name => fs.readFileSync(path.join(process.argv[2], name), 'utf8');
  const names = ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN'];
  for (const name of names) {
    const value = read(name);
    if (value.length < 8 || value.length > 4096 || /[\r\n]/.test(value)) throw new Error();
  }
  if (!/^\d{5,30}$/.test(read('WHATSAPP_PHONE_NUMBER_ID'))) throw new Error();
  if (!/^v[1-9]\d?\.\d{1,2}$/.test(read('WHATSAPP_GRAPH_API_VERSION'))) throw new Error();
  if (!/^[a-fA-F0-9]{64}$/.test(read('WHATSAPP_ENCRYPTION_KEY'))) throw new Error();
  const publicValue = read('WHATSAPP_PUBLIC_URL');
  const url = new URL(publicValue);
  if (publicValue.length > 2048 || url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error();
  const eeaCodes = ['30','31','32','33','34','36','39','40','43','45','46','47','48','49',
    '351','352','353','354','356','357','358','359','370','371','372','385','386','420','421','423'];
  const eeaCountries = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
    'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO'];
  const senders = read('WHATSAPP_ALLOWED_SENDERS').split(',');
  if (senders.length < 1 || senders.length > 100) throw new Error();
  for (const raw of senders) {
    const sender = raw.trim().replace(/^\+/, '');
    const bsuid = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(sender) && eeaCountries.includes(sender.slice(0,2));
    const phone = /^[1-9]\d{6,14}$/.test(sender) && eeaCodes.some(code => sender.startsWith(code))
      && !sender.startsWith('3906698') && !sender.startsWith('4779');
    if (!bsuid && !phone) throw new Error();
  }
} catch {
  process.stderr.write('WhatsApp secret configuration is invalid.\n');
  process.exit(1);
}
NODE
    ;;
  verify-revision)
    revision="${2:?A reviewed revision name is required}"
    : "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
    : "${GCP_REGION:?GCP_REGION is required}"
    revision_file="$(mktemp)"
    trap 'rm -f "$revision_file"' EXIT
    gcloud run revisions describe "$revision" --project "$GCP_PROJECT_ID" \
      --region "$GCP_REGION" --format=json > "$revision_file"
    node - "$revision_file" "$enabled" "${bindings[@]}" <<'NODE'
const fs = require('node:fs');
try {
  const revision = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const containers = revision.spec?.containers;
  if (!Array.isArray(containers) || containers.length !== 1 || !Array.isArray(containers[0].env)) throw new Error();
  for (const binding of process.argv.slice(4)) {
    const [name, reference] = binding.split('=');
    const [secret, version] = reference.split(':');
    const matches = containers[0].env.filter(entry => entry.name === name);
    if (process.argv[3] === 'false') {
      if (matches.length !== 0) throw new Error();
    } else if (matches.length !== 1 || matches[0].value !== undefined
      || matches[0].valueFrom?.secretKeyRef?.name !== secret
      || String(matches[0].valueFrom?.secretKeyRef?.key) !== version) throw new Error();
  }
} catch {
  process.stderr.write('WhatsApp revision configuration does not match the reviewed deployment contract.\n');
  process.exit(1);
}
NODE
    ;;
  *) echo "Unknown WhatsApp deployment mode." >&2; exit 1 ;;
esac

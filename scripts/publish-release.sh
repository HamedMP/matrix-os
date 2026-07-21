#!/usr/bin/env bash
set -euo pipefail

# Publish an immutable host bundle to R2 and register its metadata in platform DB.
#
# Usage:
#   ./scripts/publish-release.sh v0.9.1
#   ./scripts/publish-release.sh v0.9.1 --dry-run
#   ./scripts/publish-release.sh v0.9.1 --channel canary --severity security --changelog "Fix auth bypass"
#
# Flags:
#   --dry-run              Print what would happen without uploading
#   --channel <name>       Promote channel after registering: dev, canary, beta, stable
#   --severity <level>     Update severity: normal (default) or security
#   --changelog <text>     One-line changelog entry for the manifest
#
# Expects build-host-bundle.sh to have already run (tarball at dist/host-bundle/).
# Env: R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_BUCKET
#      PLATFORM_PUBLIC_URL, PLATFORM_SECRET

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${HOST_BUNDLE_DIST_DIR:-$ROOT_DIR/dist/host-bundle}"
BUNDLE="$DIST_DIR/matrix-host-bundle.tar.gz"
INCREMENTAL_MANIFEST="$DIST_DIR/incremental-manifest.json"
CHANNEL="${HOST_BUNDLE_CHANNEL:-${MATRIX_IMAGE_VERSION:-dev}}"
VERSION=""
DRY_RUN=""
SEVERITY="normal"
CHANGELOG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --severity)
      SEVERITY="${2:-normal}"; shift 2 ;;
    --channel)
      CHANNEL="${2:-dev}"; shift 2 ;;
    --changelog)
      CHANGELOG="${2:-}"; shift 2 ;;
    *)
      if [ -z "$VERSION" ]; then
        VERSION="$1"
      fi
      shift ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "Usage: publish-release.sh <version> [--dry-run] [--channel <name>] [--severity <level>] [--changelog <text>]" >&2; exit 1
fi

case "$CHANNEL" in
  dev|canary|beta|stable) ;;
  none) ;; # register-only: no channel promotion (preview/PR bundles)
  *) echo "Invalid channel: $CHANNEL" >&2; exit 1 ;;
esac

# Derive updateType from severity: security triggers auto-update
if [ "$SEVERITY" = "security" ]; then
  UPDATE_TYPE="auto"
else
  UPDATE_TYPE="manual"
fi

if [ ! -f "$BUNDLE" ]; then
  echo "Bundle not found at $BUNDLE — run build-host-bundle.sh first" >&2
  exit 1
fi
if [ ! -f "$INCREMENTAL_MANIFEST" ]; then
  echo "Incremental manifest not found at $INCREMENTAL_MANIFEST — run build-host-bundle.sh first" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found; publishing through scripts/publish-release-r2.mjs"
  NODE_PUBLISH_ARGS=("$VERSION" "--channel" "$CHANNEL" "--severity" "$SEVERITY")
  if [ -n "$CHANGELOG" ]; then
    NODE_PUBLISH_ARGS+=("--changelog" "$CHANGELOG")
  fi
  if [ "$DRY_RUN" = "1" ]; then
    NODE_PUBLISH_ARGS+=("--dry-run")
  fi
  exec node "$ROOT_DIR/scripts/publish-release-r2.mjs" "${NODE_PUBLISH_ARGS[@]}"
fi

: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
R2_BUCKET="${R2_BUCKET:-matrixos-sync}"
if [ -z "${R2_ENDPOINT:-}" ]; then
  : "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID or R2_ENDPOINT}"
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi
PLATFORM_PUBLIC_URL="${PLATFORM_PUBLIC_URL:-https://app.matrix-os.com}"
INCREMENTAL_UPLOAD_CONCURRENCY="${HOST_BUNDLE_INCREMENTAL_UPLOAD_CONCURRENCY:-16}"
if ! [[ "$INCREMENTAL_UPLOAD_CONCURRENCY" =~ ^[0-9]+$ ]] || [ "$INCREMENTAL_UPLOAD_CONCURRENCY" -lt 1 ] || [ "$INCREMENTAL_UPLOAD_CONCURRENCY" -gt 64 ]; then
  echo "HOST_BUNDLE_INCREMENTAL_UPLOAD_CONCURRENCY must be an integer from 1 to 64" >&2
  exit 1
fi

SHA256="$(sha256sum "$BUNDLE" | awk '{print $1}')"
SIZE="$(stat --printf='%s' "$BUNDLE")"
INCREMENTAL_MANIFEST_SHA256="$(sha256sum "$INCREMENTAL_MANIFEST" | awk '{print $1}')"
INCREMENTAL_MANIFEST_SIZE="$(stat --printf='%s' "$INCREMENTAL_MANIFEST")"
PUBLISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GIT_COMMIT="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('gitCommit',''))" "$DIST_DIR/manifest.json" 2>/dev/null || true)"
GIT_REF="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('gitRef',''))" "$DIST_DIR/manifest.json" 2>/dev/null || true)"
BUILD_TIME="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('buildTime',''))" "$DIST_DIR/manifest.json" 2>/dev/null || true)"
GIT_COMMIT="${GIT_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
GIT_REF="${GIT_REF:-$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)}"
BUILD_TIME="${BUILD_TIME:-$PUBLISHED}"
BUNDLE_KEY="system-bundles/$VERSION/matrix-host-bundle.tar.gz"
CHECKSUM_KEY="system-bundles/$VERSION/matrix-host-bundle.tar.gz.sha256"
INCREMENTAL_MANIFEST_KEY="system-bundles/$VERSION/incremental-manifest.json"
if [ "${GOLDEN_SNAPSHOT_ELIGIBLE+x}" = "x" ]; then
  SNAPSHOT_ELIGIBLE="$GOLDEN_SNAPSHOT_ELIGIBLE"
else
  case "$CHANNEL" in
    dev|canary|beta|stable) SNAPSHOT_ELIGIBLE="true" ;;
    *) SNAPSHOT_ELIGIBLE="false" ;;
  esac
fi
if [ "$SNAPSHOT_ELIGIBLE" != "true" ] && [ "$SNAPSHOT_ELIGIBLE" != "false" ]; then
  echo "GOLDEN_SNAPSHOT_ELIGIBLE must be true or false" >&2
  exit 1
fi

REGISTRATION_BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'version': sys.argv[1],
    'gitCommit': sys.argv[2],
    'gitRef': sys.argv[3] or None,
    'buildTime': sys.argv[4],
    'bundleKey': sys.argv[5],
    'checksumKey': sys.argv[6],
    'incrementalManifestKey': sys.argv[7],
    'incrementalManifestSha256': sys.argv[8],
    'sha256': sys.argv[9],
    'size': int(sys.argv[10]),
    'severity': sys.argv[11],
    'updateType': sys.argv[12],
    'changelog': sys.argv[13] or None,
    'snapshotEligible': sys.argv[15] == 'true',
    **({} if sys.argv[14] == 'none' else {'channel': sys.argv[14]}),
}, indent=2))
" "$VERSION" "$GIT_COMMIT" "$GIT_REF" "$BUILD_TIME" "$BUNDLE_KEY" "$CHECKSUM_KEY" "$INCREMENTAL_MANIFEST_KEY" "$INCREMENTAL_MANIFEST_SHA256" "$SHA256" "$SIZE" "$SEVERITY" "$UPDATE_TYPE" "$CHANGELOG" "$CHANNEL" "$SNAPSHOT_ELIGIBLE")

incremental_object_count() {
  python3 -c "import json,sys; print(len(json.load(open(sys.argv[1])).get('files', [])))" "$INCREMENTAL_MANIFEST"
}

incremental_requires_full_bundle() {
  python3 -c "import json,sys; manifest=json.load(open(sys.argv[1])); sys.exit(0 if manifest.get('requiresFullBundle', True) is not False else 1)" "$INCREMENTAL_MANIFEST"
}

write_incremental_object_list() {
  python3 -c "
import json, re, sys
manifest = json.load(open(sys.argv[1]))
for entry in manifest.get('files', []):
    sha = entry.get('sha256')
    key = entry.get('url')
    size = entry.get('size')
    if (
        entry.get('type') != 'file'
        or not isinstance(sha, str)
        or not re.fullmatch(r'[a-f0-9]{64}', sha)
        or key != f'system-bundles/objects/sha256/{sha}'
        or not isinstance(size, int)
        or size < 0
    ):
        raise SystemExit('incremental manifest contains an invalid file object entry')
    print(f'{sha}\t{size}\t{key}')
" "$INCREMENTAL_MANIFEST"
}

validate_incremental_object_list() {
  local object_sha256 object_size object_key object_file actual_size actual_sha256
  while IFS=$'\t' read -r object_sha256 object_size object_key; do
    object_file="$DIST_DIR/objects/sha256/$object_sha256"
    if [ ! -f "$object_file" ]; then
      echo "ERROR: missing incremental object file $object_file" >&2
      exit 1
    fi
    actual_size="$(stat --printf='%s' "$object_file")"
    if [ "$actual_size" != "$object_size" ]; then
      echo "ERROR: incremental object size mismatch for $object_file" >&2
      exit 1
    fi
    actual_sha256="$(sha256sum "$object_file" | awk '{print $1}')"
    if [ "$actual_sha256" != "$object_sha256" ]; then
      echo "ERROR: incremental object checksum mismatch for $object_file" >&2
      exit 1
    fi
  done < "$INCREMENTAL_OBJECTS_FILE"
}

AWS_ARGS=(--endpoint-url "$R2_ENDPOINT" --region auto)

object_exists() {
  local key="$1"
  aws s3api head-object --bucket "$R2_BUCKET" --key "$key" "${AWS_ARGS[@]}" >/dev/null 2>&1
}

object_size() {
  local key="$1"
  aws s3api head-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --query ContentLength \
    --output text \
    "${AWS_ARGS[@]}"
}

checksum_object_sha256() {
  local key="$1"
  aws s3 cp "s3://$R2_BUCKET/$key" - "${AWS_ARGS[@]}" 2>/dev/null | awk '{print $1}'
}

bundle_object_sha256() {
  local key="$1"
  aws s3 cp "s3://$R2_BUCKET/$key" - "${AWS_ARGS[@]}" 2>/dev/null | sha256sum | awk '{print $1}'
}

verify_existing_incremental_manifest() {
  local existing_size existing_sha256
  existing_size="$(object_size "$INCREMENTAL_MANIFEST_KEY")"
  if [ "$existing_size" != "$INCREMENTAL_MANIFEST_SIZE" ]; then
    echo "ERROR: existing immutable incremental manifest size mismatch for s3://$R2_BUCKET/$INCREMENTAL_MANIFEST_KEY" >&2
    exit 1
  fi
  existing_sha256="$(bundle_object_sha256 "$INCREMENTAL_MANIFEST_KEY")"
  if [ "$existing_sha256" != "$INCREMENTAL_MANIFEST_SHA256" ]; then
    echo "ERROR: existing immutable incremental manifest content mismatch for s3://$R2_BUCKET/$INCREMENTAL_MANIFEST_KEY" >&2
    exit 1
  fi
}

verify_existing_bundle() {
  local existing_size existing_sha256 existing_bundle_sha256
  existing_size="$(object_size "$BUNDLE_KEY")"
  if [ "$existing_size" != "$SIZE" ]; then
    echo "ERROR: existing immutable bundle size mismatch for s3://$R2_BUCKET/$BUNDLE_KEY" >&2
    exit 1
  fi
  existing_bundle_sha256="$(bundle_object_sha256 "$BUNDLE_KEY")"
  if [ "$existing_bundle_sha256" != "$SHA256" ]; then
    echo "ERROR: existing immutable bundle content mismatch for s3://$R2_BUCKET/$BUNDLE_KEY" >&2
    exit 1
  fi
  if object_exists "$CHECKSUM_KEY"; then
    existing_sha256="$(checksum_object_sha256 "$CHECKSUM_KEY")"
    if [ "$existing_sha256" != "$SHA256" ]; then
      echo "ERROR: existing immutable bundle checksum mismatch for s3://$R2_BUCKET/$BUNDLE_KEY" >&2
      exit 1
    fi
  fi
}

verify_existing_checksum() {
  local existing_sha256
  existing_sha256="$(checksum_object_sha256 "$CHECKSUM_KEY")"
  if [ "$existing_sha256" != "$SHA256" ]; then
    echo "ERROR: existing immutable checksum mismatch for s3://$R2_BUCKET/$CHECKSUM_KEY" >&2
    exit 1
  fi
}

upload_immutable_object() {
  local source_file="$1"
  local key="$2"
  local content_type="$3"
  local metadata_sha256="${4:-$SHA256}"

  if object_exists "$key"; then
    echo "  Immutable object already exists: s3://$R2_BUCKET/$key"
    return 0
  fi

  aws s3api put-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --body "$source_file" \
    --content-type "$content_type" \
    --metadata "sha256=$metadata_sha256" \
    --if-none-match '*' \
    "${AWS_ARGS[@]}" >/dev/null
}

upload_content_addressed_object() {
  local source_file="$1"
  local key="$2"
  local content_type="$3"
  local metadata_sha256="$4"
  local error_file
  error_file="$(mktemp)"

  if aws s3api put-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --body "$source_file" \
    --content-type "$content_type" \
    --metadata "sha256=$metadata_sha256" \
    --if-none-match '*' \
    "${AWS_ARGS[@]}" > /dev/null 2>"$error_file"; then
    rm -f "$error_file"
    return 0
  fi

  local status=$?
  if grep -Eq 'PreconditionFailed|Precondition Failed|pre-condition|status code: 412|\(412\)|(^|[^0-9])412([^0-9]|$)' "$error_file"; then
    rm -f "$error_file"
    return 0
  fi

  cat "$error_file" >&2
  rm -f "$error_file"
  return "$status"
}

incremental_upload_pids=()

wait_for_incremental_upload_slot() {
  local first_pid
  while [ "${#incremental_upload_pids[@]}" -ge "$INCREMENTAL_UPLOAD_CONCURRENCY" ]; do
    first_pid="${incremental_upload_pids[0]}"
    incremental_upload_pids=("${incremental_upload_pids[@]:1}")
    wait "$first_pid" || return
  done
}

wait_for_incremental_uploads() {
  local failed=0 upload_pid
  for upload_pid in "${incremental_upload_pids[@]}"; do
    if ! wait "$upload_pid"; then
      failed=1
    fi
  done
  incremental_upload_pids=()
  return "$failed"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "=== DRY RUN ==="
  echo "Bundle: $BUNDLE ($SIZE bytes, sha256: $SHA256)"
  echo "Channel: $CHANNEL"
  echo "Version: $VERSION"
  echo "Severity: $SEVERITY"
  echo "UpdateType: $UPDATE_TYPE"
  echo "Changelog: $CHANGELOG"
  echo ""
  echo "Would upload immutable artifacts:"
  echo "  $BUNDLE → s3://$R2_BUCKET/$BUNDLE_KEY"
  echo "  sha256 → s3://$R2_BUCKET/$CHECKSUM_KEY"
  if incremental_requires_full_bundle; then
    echo "  Incremental manifest requires full bundle; would skip incremental file object uploads."
  else
    echo "  $(incremental_object_count) incremental file objects"
  fi
  echo "  incremental manifest → s3://$R2_BUCKET/$INCREMENTAL_MANIFEST_KEY"
  echo ""
  echo "Would register release in platform DB:"
  echo "$REGISTRATION_BODY"
  exit 0
fi

echo "Publishing $VERSION to channel $CHANNEL..."
echo "  Bundle: $SIZE bytes, sha256: $SHA256"

AUTH_HEADER_FILE=""
CHECKSUM_FILE="$(mktemp)"
INCREMENTAL_OBJECTS_FILE="$(mktemp)"
cleanup_temp_files() { rm -f "$AUTH_HEADER_FILE" "$CHECKSUM_FILE" "$INCREMENTAL_OBJECTS_FILE"; }
trap cleanup_temp_files EXIT
printf '%s  matrix-host-bundle.tar.gz\n' "$SHA256" > "$CHECKSUM_FILE"
if ! incremental_requires_full_bundle; then
  write_incremental_object_list > "$INCREMENTAL_OBJECTS_FILE"
  validate_incremental_object_list
fi

echo "  Uploading versioned archive..."
if object_exists "$BUNDLE_KEY"; then
  echo "  Verifying existing immutable archive..."
  verify_existing_bundle
else
  upload_immutable_object "$BUNDLE" "$BUNDLE_KEY" "application/gzip"
fi
if object_exists "$CHECKSUM_KEY"; then
  echo "  Verifying existing immutable checksum..."
  verify_existing_checksum
else
  upload_immutable_object "$CHECKSUM_FILE" "$CHECKSUM_KEY" "text/plain; charset=utf-8"
fi

if incremental_requires_full_bundle; then
  echo "  Incremental manifest requires full bundle; skipping incremental file object uploads."
else
  echo "  Uploading incremental file objects with concurrency $INCREMENTAL_UPLOAD_CONCURRENCY..."
  incremental_upload_failed=0
  while IFS=$'\t' read -r object_sha256 object_size object_key; do
    object_file="$DIST_DIR/objects/sha256/$object_sha256"
    if ! wait_for_incremental_upload_slot; then
      incremental_upload_failed=1
    fi
    upload_content_addressed_object "$object_file" "$object_key" "application/octet-stream" "$object_sha256" &
    incremental_upload_pids+=("$!")
  done < "$INCREMENTAL_OBJECTS_FILE"
  if ! wait_for_incremental_uploads; then
    incremental_upload_failed=1
  fi
  if [ "$incremental_upload_failed" -ne 0 ]; then
    echo "ERROR: one or more incremental file object uploads failed" >&2
    exit 1
  fi
fi
if object_exists "$INCREMENTAL_MANIFEST_KEY"; then
  echo "  Verifying existing immutable incremental manifest..."
  verify_existing_incremental_manifest
else
  upload_immutable_object "$INCREMENTAL_MANIFEST" "$INCREMENTAL_MANIFEST_KEY" "application/json; charset=utf-8" "$INCREMENTAL_MANIFEST_SHA256"
fi

echo "  Registering release in platform DB..."
: "${PLATFORM_SECRET:?set PLATFORM_SECRET}"
AUTH_HEADER_FILE="$(mktemp)"
chmod 0600 "$AUTH_HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$PLATFORM_SECRET" > "$AUTH_HEADER_FILE"
printf '%s' "$REGISTRATION_BODY" | curl --fail --silent --show-error --max-time 30 \
  -X POST "${PLATFORM_PUBLIC_URL%/}/system-bundles/releases" \
  -H "@$AUTH_HEADER_FILE" \
  -H "Content-Type: application/json" \
  --data-binary @-

echo ""
if [ "$CHANNEL" = "none" ]; then
  echo "Registered $VERSION (no channel promotion; deploy is version-pinned only)"
  echo "  Release metadata: ${PLATFORM_PUBLIC_URL%/}/system-bundles/releases/$VERSION.json"
  echo "  To deploy to one handle: curl -X POST https://app.matrix-os.com/vps/deploy -H 'Authorization: Bearer \$PLATFORM_SECRET' -d '{\"version\":\"$VERSION\",\"handle\":\"<handle>\"}'"
else
  echo "Published $VERSION to $CHANNEL"
  echo "  Release metadata: ${PLATFORM_PUBLIC_URL%/}/system-bundles/releases/$VERSION.json"
  echo "  Sync agents will discover this within 5 minutes."
  echo "  To deploy now: curl -X POST https://app.matrix-os.com/vps/deploy -H 'Authorization: Bearer \$PLATFORM_SECRET' -d '{\"version\":\"$VERSION\"}'"
fi

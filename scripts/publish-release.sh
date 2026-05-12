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

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
R2_BUCKET="${R2_BUCKET:-matrixos-sync}"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
PLATFORM_PUBLIC_URL="${PLATFORM_PUBLIC_URL:-https://app.matrix-os.com}"

SHA256="$(sha256sum "$BUNDLE" | awk '{print $1}')"
SIZE="$(stat --printf='%s' "$BUNDLE")"
PUBLISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GIT_COMMIT="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('gitCommit',''))" "$DIST_DIR/manifest.json" 2>/dev/null || true)"
GIT_REF="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('gitRef',''))" "$DIST_DIR/manifest.json" 2>/dev/null || true)"
BUILD_TIME="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('buildTime',''))" "$DIST_DIR/manifest.json" 2>/dev/null || true)"
GIT_COMMIT="${GIT_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
GIT_REF="${GIT_REF:-$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)}"
BUILD_TIME="${BUILD_TIME:-$PUBLISHED}"
BUNDLE_KEY="system-bundles/$VERSION/matrix-host-bundle.tar.gz"
CHECKSUM_KEY="system-bundles/$VERSION/matrix-host-bundle.tar.gz.sha256"

REGISTRATION_BODY=$(python3 -c "
import json, sys
print(json.dumps({
    'version': sys.argv[1],
    'gitCommit': sys.argv[2],
    'gitRef': sys.argv[3] or None,
    'buildTime': sys.argv[4],
    'bundleKey': sys.argv[5],
    'checksumKey': sys.argv[6],
    'sha256': sys.argv[7],
    'size': int(sys.argv[8]),
    'severity': sys.argv[9],
    'updateType': sys.argv[10],
    'changelog': sys.argv[11] or None,
    'channel': sys.argv[12],
}, indent=2))
" "$VERSION" "$GIT_COMMIT" "$GIT_REF" "$BUILD_TIME" "$BUNDLE_KEY" "$CHECKSUM_KEY" "$SHA256" "$SIZE" "$SEVERITY" "$UPDATE_TYPE" "$CHANGELOG" "$CHANNEL")

AWS_ARGS=(--endpoint-url "$R2_ENDPOINT" --region auto)

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
  echo ""
  echo "Would register release in platform DB:"
  echo "$REGISTRATION_BODY"
  exit 0
fi

echo "Publishing $VERSION to channel $CHANNEL..."
echo "  Bundle: $SIZE bytes, sha256: $SHA256"

echo "  Uploading versioned archive..."
aws s3 cp "$BUNDLE" "s3://$R2_BUCKET/$BUNDLE_KEY" "${AWS_ARGS[@]}"
echo "$SHA256  matrix-host-bundle.tar.gz" | aws s3 cp - "s3://$R2_BUCKET/$CHECKSUM_KEY" "${AWS_ARGS[@]}"

echo "  Registering release in platform DB..."
: "${PLATFORM_SECRET:?set PLATFORM_SECRET}"
AUTH_HEADER_FILE="$(mktemp)"
cleanup_auth_header() { rm -f "$AUTH_HEADER_FILE"; }
trap cleanup_auth_header EXIT
chmod 0600 "$AUTH_HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$PLATFORM_SECRET" > "$AUTH_HEADER_FILE"
printf '%s' "$REGISTRATION_BODY" | curl --fail --silent --show-error --max-time 30 \
  -X POST "${PLATFORM_PUBLIC_URL%/}/system-bundles/releases" \
  -H "@$AUTH_HEADER_FILE" \
  -H "Content-Type: application/json" \
  --data-binary @-

echo ""
echo "Published $VERSION to $CHANNEL"
echo "  Release metadata: ${PLATFORM_PUBLIC_URL%/}/system-bundles/releases/$VERSION.json"
echo "  Sync agents will discover this within 5 minutes."
echo "  To deploy now: curl -X POST https://app.matrix-os.com/vps/deploy -H 'Authorization: Bearer \$PLATFORM_SECRET' -d '{\"version\":\"$VERSION\"}'"

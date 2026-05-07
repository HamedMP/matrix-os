#!/usr/bin/env bash
set -euo pipefail

# Publish a host bundle to R2 so VPS sync-agents can discover and apply it.
#
# Usage:
#   ./scripts/publish-release.sh v0.9.1
#   ./scripts/publish-release.sh v0.9.1 --dry-run
#
# Expects build-host-bundle.sh to have already run (tarball at dist/host-bundle/).
# Env: R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_BUCKET
#      (source /opt/matrix/env/r2.env for VPS-local runs)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${HOST_BUNDLE_DIST_DIR:-$ROOT_DIR/dist/host-bundle}"
BUNDLE="$DIST_DIR/matrix-host-bundle.tar.gz"
CHANNEL="${MATRIX_IMAGE_VERSION:-matrix-os-host-dev}"
VERSION="${1:?Usage: publish-release.sh <version> [--dry-run]}"
DRY_RUN="${2:-}"

if [ ! -f "$BUNDLE" ]; then
  echo "Bundle not found at $BUNDLE — run build-host-bundle.sh first" >&2
  exit 1
fi

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
R2_BUCKET="${R2_BUCKET:-matrixos-sync}"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

SHA256="$(sha256sum "$BUNDLE" | awk '{print $1}')"
SIZE="$(stat --printf='%s' "$BUNDLE")"
PUBLISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUNDLE_URL="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/system-bundles/${CHANNEL}/matrix-host-bundle.tar.gz"

MANIFEST=$(printf '{
  "version": "%s",
  "sha256": "%s",
  "url": "%s",
  "size": %s,
  "published": "%s",
  "channel": "%s"
}' "$VERSION" "$SHA256" "$BUNDLE_URL" "$SIZE" "$PUBLISHED" "$CHANNEL")

AWS_ARGS=(--endpoint-url "$R2_ENDPOINT" --region auto)

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "=== DRY RUN ==="
  echo "Bundle: $BUNDLE ($SIZE bytes, sha256: $SHA256)"
  echo "Channel: $CHANNEL"
  echo "Version: $VERSION"
  echo ""
  echo "Would upload:"
  echo "  $BUNDLE → s3://$R2_BUCKET/system-bundles/$VERSION/matrix-host-bundle.tar.gz"
  echo "  $BUNDLE → s3://$R2_BUCKET/system-bundles/$CHANNEL/matrix-host-bundle.tar.gz"
  echo "  manifest → s3://$R2_BUCKET/system-bundles/$CHANNEL/manifest.json"
  echo ""
  echo "Manifest:"
  echo "$MANIFEST"
  exit 0
fi

echo "Publishing $VERSION to channel $CHANNEL..."
echo "  Bundle: $SIZE bytes, sha256: $SHA256"

echo "  Uploading versioned archive..."
aws s3 cp "$BUNDLE" "s3://$R2_BUCKET/system-bundles/$VERSION/matrix-host-bundle.tar.gz" "${AWS_ARGS[@]}"
echo "$SHA256  matrix-host-bundle.tar.gz" | aws s3 cp - "s3://$R2_BUCKET/system-bundles/$VERSION/matrix-host-bundle.tar.gz.sha256" "${AWS_ARGS[@]}"

echo "  Uploading channel latest..."
aws s3 cp "$BUNDLE" "s3://$R2_BUCKET/system-bundles/$CHANNEL/matrix-host-bundle.tar.gz" "${AWS_ARGS[@]}"

echo "  Writing manifest..."
echo "$MANIFEST" | aws s3 cp - "s3://$R2_BUCKET/system-bundles/$CHANNEL/manifest.json" --content-type application/json "${AWS_ARGS[@]}"

echo ""
echo "Published $VERSION to $CHANNEL"
echo "  Manifest URL: s3://$R2_BUCKET/system-bundles/$CHANNEL/manifest.json"
echo "  Sync agents will discover this within 5 minutes."
echo "  To deploy now: curl -X POST https://app.matrix-os.com/vps/deploy -H 'Authorization: Bearer \$PLATFORM_SECRET' -d '{\"version\":\"$VERSION\"}'"

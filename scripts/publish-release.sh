#!/usr/bin/env bash
set -euo pipefail

# Publish a host bundle to R2 so VPS sync-agents can discover and apply it.
#
# Usage:
#   ./scripts/publish-release.sh v0.9.1
#   ./scripts/publish-release.sh v0.9.1 --dry-run
#   ./scripts/publish-release.sh v0.9.1 --severity security --changelog "Fix auth bypass"
#
# Flags:
#   --dry-run              Print what would happen without uploading
#   --severity <level>     Update severity: normal (default), important, security
#   --changelog <text>     One-line changelog entry for the manifest
#
# Expects build-host-bundle.sh to have already run (tarball at dist/host-bundle/).
# Env: R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_BUCKET
#      (source /opt/matrix/env/r2.env for VPS-local runs)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${HOST_BUNDLE_DIST_DIR:-$ROOT_DIR/dist/host-bundle}"
BUNDLE="$DIST_DIR/matrix-host-bundle.tar.gz"
CHANNEL="${MATRIX_IMAGE_VERSION:-matrix-os-host-dev}"
VERSION=""
DRY_RUN=""
SEVERITY="normal"
CHANGELOG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --severity)
      SEVERITY="${2:-normal}"; shift 2 ;;
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
  echo "Usage: publish-release.sh <version> [--dry-run] [--severity <level>] [--changelog <text>]" >&2; exit 1
fi

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

SHA256="$(sha256sum "$BUNDLE" | awk '{print $1}')"
SIZE="$(stat --printf='%s' "$BUNDLE")"
PUBLISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build manifest JSON with optional severity/changelog/updateType fields
MANIFEST=$(printf '{
  "version": "%s",
  "sha256": "%s",
  "size": %s,
  "published": "%s",
  "channel": "%s",
  "severity": "%s",
  "updateType": "%s",
  "changelog": "%s"
}' "$VERSION" "$SHA256" "$SIZE" "$PUBLISHED" "$CHANNEL" "$SEVERITY" "$UPDATE_TYPE" "$CHANGELOG")

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

#!/usr/bin/env bash
# Builds a signed macOS .pkg installer bundling:
#   - the matrix CLI (npm package @finnaai/matrix)
#   - MatrixSync.app (menu bar + FinderSync extension)
#
# The .pkg is signed with a Developer ID Installer certificate and is
# intended to be notarised by scripts/notarise-macos.sh before release.
#
# Required environment:
#   APPLE_DEV_ID_APP         e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_DEV_ID_INSTALLER   e.g. "Developer ID Installer: Your Name (TEAMID)"
#   APPLE_TEAM_ID            10-char team id
#
# Optional:
#   VERSION                  Version string stamped into the pkg (default: git describe)
#   OUTPUT_DIR               Where to drop the .pkg (default: dist/macos)
#
# Usage:
#   scripts/build-macos-pkg.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${APPLE_DEV_ID_APP:?APPLE_DEV_ID_APP must be set (Developer ID Application identity)}"
: "${APPLE_DEV_ID_INSTALLER:?APPLE_DEV_ID_INSTALLER must be set (Developer ID Installer identity)}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID must be set}"

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo '0.0.0-dev')}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/dist/macos}"
BUILD_DIR="$REPO_ROOT/dist/macos-build"
PKG_ROOT="$BUILD_DIR/pkg-root"
SCRIPTS_DIR="$BUILD_DIR/scripts"
APP_NAME="MatrixSync.app"
APP_ID="com.matrixos.MatrixSync"
PKG_IDENTIFIER="com.matrixos.MatrixSync.pkg"
CLI_PKG_DIR="$REPO_ROOT/packages/sync-client"

echo "==> Building MatrixSync installer v$VERSION"

rm -rf "$BUILD_DIR"
mkdir -p "$PKG_ROOT/Applications" \
         "$PKG_ROOT/usr/local/bin" \
         "$PKG_ROOT/usr/local/lib/matrix-os" \
         "$SCRIPTS_DIR" \
         "$OUTPUT_DIR"

# -----------------------------------------------------------------------------
# Step 1: build the menu bar app + FinderSync extension.
# -----------------------------------------------------------------------------
echo "==> Building MatrixSync.app via xcodebuild"
XCODE_PROJECT="$CLI_PKG_DIR/macos/MatrixSync.xcodeproj"
XCODE_BUILD_DIR="$BUILD_DIR/xcode"

xcodebuild \
  -project "$XCODE_PROJECT" \
  -scheme MatrixSync \
  -configuration Release \
  -derivedDataPath "$XCODE_BUILD_DIR" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$APPLE_DEV_ID_APP" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  MARKETING_VERSION="$VERSION" \
  clean build

APP_BUILD_PATH="$XCODE_BUILD_DIR/Build/Products/Release/$APP_NAME"
if [ ! -d "$APP_BUILD_PATH" ]; then
  echo "error: expected $APP_BUILD_PATH to exist after xcodebuild" >&2
  exit 1
fi

cp -R "$APP_BUILD_PATH" "$PKG_ROOT/Applications/$APP_NAME"

# Verify the app + extension are signed. `codesign --verify` exits non-zero
# when the signature is missing or broken.
codesign --verify --strict --deep "$PKG_ROOT/Applications/$APP_NAME"

# -----------------------------------------------------------------------------
# Step 2: stage the CLI. Bundles the sync-client package contents under
# /usr/local/lib/matrix-os and creates a launcher symlink in /usr/local/bin.
# -----------------------------------------------------------------------------
echo "==> Staging matrix CLI"
CLI_STAGE_DIR="$PKG_ROOT/usr/local/lib/matrix-os/cli"
mkdir -p "$CLI_STAGE_DIR"

# Copy only what `files` in package.json declares — bin/, src/, README, LICENSE,
# package.json. Using rsync so we can exclude node_modules/dist cleanly.
rsync -a \
  --include='bin/***' \
  --include='src/***' \
  --include='package.json' \
  --include='README.md' \
  --include='LICENSE' \
  --exclude='*' \
  "$CLI_PKG_DIR/" "$CLI_STAGE_DIR/"

# Install production deps into the staged CLI so it runs without the monorepo.
(
  cd "$CLI_STAGE_DIR"
  # `npm install --omit=dev` is the cross-platform way to get production deps.
  # We prefer npm over pnpm here so the staged tree is fully self-contained
  # (no pnpm-lock / symlinks into a workspace).
  npm install --omit=dev --no-audit --no-fund --ignore-scripts
)

# Launcher symlink that puts `matrix` and `matrixos` on PATH.
ln -sf "/usr/local/lib/matrix-os/cli/bin/matrix.mjs" "$PKG_ROOT/usr/local/bin/matrix"
ln -sf "/usr/local/lib/matrix-os/cli/bin/matrix.mjs" "$PKG_ROOT/usr/local/bin/matrixos"

# -----------------------------------------------------------------------------
# Step 3: postinstall script — register Finder extension with pluginkit.
# -----------------------------------------------------------------------------
cat >"$SCRIPTS_DIR/postinstall" <<'POST'
#!/bin/bash
set -euo pipefail

APP_PATH="/Applications/MatrixSync.app"
EXT_BUNDLE_ID="com.matrixos.MatrixSync.MatrixSyncFinderSync"

if [ -d "$APP_PATH" ]; then
  # Register and enable the FinderSync extension for every logged-in user.
  # `pluginkit -a` adds the bundle; `-e use` marks it as user-enabled.
  /usr/bin/pluginkit -a "$APP_PATH/Contents/PlugIns/MatrixSyncFinderSync.appex" || true
  /usr/bin/pluginkit -e use -i "$EXT_BUNDLE_ID" || true
fi

exit 0
POST
chmod +x "$SCRIPTS_DIR/postinstall"

# -----------------------------------------------------------------------------
# Step 4: build the flat .pkg.
# -----------------------------------------------------------------------------
UNSIGNED_PKG="$BUILD_DIR/MatrixSync-unsigned.pkg"
SIGNED_PKG="$OUTPUT_DIR/MatrixSync-$VERSION.pkg"

echo "==> Running pkgbuild"
pkgbuild \
  --root "$PKG_ROOT" \
  --identifier "$PKG_IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location "/" \
  "$UNSIGNED_PKG"

echo "==> Signing .pkg with $APPLE_DEV_ID_INSTALLER"
productsign \
  --sign "$APPLE_DEV_ID_INSTALLER" \
  --timestamp \
  "$UNSIGNED_PKG" \
  "$SIGNED_PKG"

pkgutil --check-signature "$SIGNED_PKG"

echo "==> Wrote $SIGNED_PKG"
echo "Next: run scripts/notarise-macos.sh \"$SIGNED_PKG\""

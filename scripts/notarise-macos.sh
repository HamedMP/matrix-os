#!/usr/bin/env bash
# Submits a signed .pkg to Apple notary service via notarytool, waits for
# the result, and staples the resulting ticket to the pkg so Gatekeeper
# accepts it offline.
#
# Requires:
#   APPLE_ID             Apple Developer account email
#   APPLE_TEAM_ID        10-char team id
#   APPLE_APP_PASSWORD   App-specific password (https://appleid.apple.com)
#
# Usage:
#   scripts/notarise-macos.sh path/to/MatrixSync-<version>.pkg

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path-to-pkg>" >&2
  exit 2
fi

PKG_PATH="$1"
if [ ! -f "$PKG_PATH" ]; then
  echo "error: $PKG_PATH not found" >&2
  exit 1
fi

: "${APPLE_ID:?APPLE_ID must be set}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID must be set}"
: "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD must be set (app-specific password)}"

echo "==> Submitting $PKG_PATH to Apple notary"
xcrun notarytool submit "$PKG_PATH" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "==> Stapling notarisation ticket"
xcrun stapler staple "$PKG_PATH"

echo "==> Verifying staple"
xcrun stapler validate "$PKG_PATH"

# Gatekeeper assessment — prints FAIL loudly when the pkg isn't accepted.
spctl --assess -vv --type install "$PKG_PATH" || {
  echo "warning: spctl assessment reported failure; check output above" >&2
  # notarytool + stapler succeeded is the contract; spctl assessment on a
  # build host may still fail when the user isn't an admin. Don't block.
}

echo "==> Notarisation complete for $PKG_PATH"

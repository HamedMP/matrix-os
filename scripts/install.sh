#!/bin/sh
# Matrix OS installer. Intended for the hosted CLI install endpoint once DNS is
# configured. Until then, prefer Homebrew or npm in public docs.
#
# Platform detection:
#   macOS   -> downloads the signed .pkg from the GitHub release and runs
#              `installer -pkg`. Needs sudo for /Applications + /usr/local.
#   Linux   -> `npm i -g @finnaai/matrix` (stop-gap until a standalone binary).
#   Windows -> print a PowerShell install hint.
#
# Usage:
#   sh scripts/install.sh
#
# Env overrides:
#   MATRIX_VERSION   pin to a CLI version or release tag (default: latest)
#   MATRIX_CHANNEL   "stable" (default). Reserved for future pre-release lanes.

set -eu

MATRIX_VERSION="${MATRIX_VERSION:-latest}"
MATRIX_CHANNEL="${MATRIX_CHANNEL:-stable}"
MATRIX_REPO="${MATRIX_REPO:-HamedMP/matrix-os}"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# Validate env overrides before they reach URLs or sudo commands.
case "$MATRIX_REPO" in
  *[!A-Za-z0-9._/-]*) die "MATRIX_REPO contains invalid characters (expected owner/repo)" ;;
esac
case "$MATRIX_VERSION" in
  latest) ;; # ok
  *[!A-Za-z0-9._-]*) die "MATRIX_VERSION contains invalid characters (expected semver tag)" ;;
esac

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found"
}

fetch() {
  # fetch <url> <output>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=300 -O "$2" "$1"
  else
    die "need curl or wget"
  fi
}

resolve_version() {
  # Turn "latest" into an actual tag so all downstream URLs are deterministic.
  if [ "$MATRIX_VERSION" != "latest" ]; then
    case "$MATRIX_VERSION" in
      cli-v*) printf '%s' "$MATRIX_VERSION" ;;
      v*)     printf 'cli-v%s' "${MATRIX_VERSION#v}" ;;
      *)      printf 'cli-v%s' "$MATRIX_VERSION" ;;
    esac
    return
  fi
  # GitHub's /releases/latest endpoint 302s to /releases/tag/<tag>.
  # We curl -sI and pull the Location header.
  if command -v curl >/dev/null 2>&1; then
    location="$(curl -sI --max-time 30 "https://github.com/$MATRIX_REPO/releases/latest" \
      | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r\n' | tail -1)"
    [ -n "$location" ] || die "could not resolve latest release"
    printf '%s' "${location##*/}"
  else
    die "need curl to resolve latest version"
  fi
}

version_from_tag() {
  # Accept cli-v0.3.0, v0.3.0, or 0.3.0 and return 0.3.0.
  case "$1" in
    cli-v*) printf '%s' "${1#cli-v}" ;;
    v*)     printf '%s' "${1#v}" ;;
    *)      printf '%s' "$1" ;;
  esac
}

install_macos() {
  echo "==> Matrix OS installer (macOS)"
  need sudo
  TAG="$(resolve_version)"
  # CLI release tags are cli-v-prefixed (cli-v0.3.0), but the .pkg asset strips
  # the prefix (MatrixSync-0.3.0.pkg). Normalize both for URL construction.
  VERSION="$(version_from_tag "$TAG")"
  echo "    version: $VERSION"

  INSTALL_TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$INSTALL_TMPDIR"' EXIT

  PKG_URL="https://github.com/$MATRIX_REPO/releases/download/$TAG/MatrixSync-$VERSION.pkg"
  PKG_PATH="$INSTALL_TMPDIR/MatrixSync.pkg"

  echo "==> Downloading $PKG_URL"
  fetch "$PKG_URL" "$PKG_PATH" || die "download failed. Check that $VERSION has a .pkg artefact."

  # Gatekeeper sanity: verify the downloaded pkg is signed + notarised before
  # asking the user for their sudo password.
  echo "==> Verifying signature"
  pkgutil --check-signature "$PKG_PATH" >/dev/null \
    || die "downloaded pkg failed signature check"
  spctl --assess --type install "$PKG_PATH" >/dev/null 2>&1 \
    || echo "    (warning: spctl assess returned non-zero; continuing)"

  echo "==> Installing (you'll be prompted for your password)"
  sudo installer -pkg "$PKG_PATH" -target /

  if command -v matrix >/dev/null 2>&1; then
    echo "==> Installed: $(matrix --version 2>/dev/null || echo 'matrix')"
    echo "Next: run 'matrix login' to sign in."
  else
    echo "    matrix CLI not on PATH. You may need to open a new shell."
  fi
}

install_linux() {
  echo "==> Matrix OS installer (Linux)"
  if ! command -v npm >/dev/null 2>&1; then
    die "npm not found. Install Node.js 24+ from https://nodejs.org then re-run this script."
  fi
  # Check Node version. The CLI requires Node 24+.
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) die "could not determine Node.js version. Ensure 'node' is on PATH." ;;
  esac
  if [ "$NODE_MAJOR" -lt 24 ]; then
    die "Node.js 24 or newer required (detected $NODE_MAJOR). Upgrade at https://nodejs.org"
  fi

  VERSION="$(version_from_tag "$MATRIX_VERSION")"
  case "$MATRIX_VERSION" in
    latest) NPM_SPEC="@finnaai/matrix" ;;
    *)      NPM_SPEC="@finnaai/matrix@$VERSION" ;;
  esac

  # Prefer an unprivileged install when the user has npm prefix configured for
  # it; otherwise fall back to sudo.
  if [ -w "$(npm config get prefix 2>/dev/null)/lib/node_modules" ] 2>/dev/null; then
    npm install -g "$NPM_SPEC"
  else
    echo "==> Installing globally (may prompt for sudo)"
    sudo npm install -g "$NPM_SPEC"
  fi

  if command -v matrix >/dev/null 2>&1; then
    echo "==> Installed: $(matrix --version 2>/dev/null || echo 'matrix')"
    echo "Next: run 'matrix login' to sign in."
  else
    echo "    matrix not on PATH yet. Check your npm global prefix."
  fi
}

install_windows() {
  cat <<'WIN'
Windows installer is not available yet.

Temporary workaround (PowerShell):
  npm install -g @finnaai/matrix

Requires Node.js 24+ from https://nodejs.org.
WIN
  exit 1
}

main() {
  OS="$(uname -s 2>/dev/null || echo unknown)"
  case "$OS" in
    Darwin)                install_macos ;;
    Linux)                 install_linux ;;
    MINGW*|MSYS*|CYGWIN*)  install_windows ;;
    *)                     die "unsupported OS: $OS" ;;
  esac
}

main "$@"

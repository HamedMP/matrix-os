#!/bin/sh
# Matrix OS installer. Served at https://get.matrix-os.com.
#
# Platform detection:
#   macOS/Linux -> downloads the standalone `matrix` CLI binary from the
#                  matching GitHub release and installs it on PATH.
#   Windows     -> print a PowerShell install hint.
#
# Usage:
#   curl -sL https://get.matrix-os.com | sh
#
# Env overrides:
#   MATRIX_VERSION   pin to a specific release tag (default: latest)
#   MATRIX_CHANNEL   "stable" (default). Reserved for future pre-release lanes.
#   MATRIX_INSTALL_DIR  override install directory (default: $HOME/.local/bin or /usr/local/bin)

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
      v*)     printf '%s' "$MATRIX_VERSION" ;;
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

cli_version_from_tag() {
  case "$1" in
    cli-v*) printf '%s' "${1#cli-v}" ;;
    v*)     printf '%s' "${1#v}" ;;
    *)      printf '%s' "$1" ;;
  esac
}

detect_asset_arch() {
  ARCH="$(uname -m 2>/dev/null || echo unknown)"
  case "$ARCH" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) die "unsupported CPU architecture: $ARCH" ;;
  esac
}

verify_checksum() {
  FILE="$1"
  SHA_FILE="$2"
  EXPECTED="$(awk '{print $1}' "$SHA_FILE" | head -1)"
  [ -n "$EXPECTED" ] || die "checksum file is empty"

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$FILE" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$FILE" | awk '{print $1}')"
  else
    die "need sha256sum or shasum to verify download"
  fi

  [ "$ACTUAL" = "$EXPECTED" ] || die "download checksum mismatch"
}

install_binary_unprivileged() {
  INSTALL_DIR="$1"
  if { [ -d "$INSTALL_DIR" ] || mkdir -p "$INSTALL_DIR" 2>/dev/null; } && [ -w "$INSTALL_DIR" ]; then
    echo "==> Installing to $INSTALL_DIR/matrix"
    TMP_BIN="$INSTALL_DIR/.matrix.tmp.$$"
    rm -f "$TMP_BIN"
    if cp "$BIN_PATH" "$TMP_BIN" && chmod 0755 "$TMP_BIN" && mv -f "$TMP_BIN" "$INSTALL_DIR/matrix"; then
      ln -sf matrix "$INSTALL_DIR/matrixos"
      ln -sf matrix "$INSTALL_DIR/mos"
      return 0
    fi
    rm -f "$TMP_BIN"
  fi
  return 1
}

install_binary_with_sudo() {
  INSTALL_DIR="$1"
  need sudo
  echo "==> Installing to $INSTALL_DIR/matrix"
  sudo mkdir -p "$INSTALL_DIR"
  TMP_BIN="$INSTALL_DIR/.matrix.tmp.$$"
  sudo rm -f "$TMP_BIN"
  if ! sudo install -m 0755 "$BIN_PATH" "$TMP_BIN"; then
    sudo rm -f "$TMP_BIN"
    return 1
  fi
  if ! sudo mv -f "$TMP_BIN" "$INSTALL_DIR/matrix"; then
    sudo rm -f "$TMP_BIN"
    return 1
  fi
  sudo ln -sf matrix "$INSTALL_DIR/matrixos"
  sudo ln -sf matrix "$INSTALL_DIR/mos"
}

existing_matrix_install_dir() {
  EXISTING_MATRIX="$(command -v matrix 2>/dev/null || true)"
  case "$EXISTING_MATRIX" in
    */matrix) dirname "$EXISTING_MATRIX" ;;
    *)        printf '' ;;
  esac
}

install_cli_binary() {
  ASSET_OS="$1"
  TAG="${2:-$(resolve_version)}"
  VERSION="$(cli_version_from_tag "$TAG")"
  ASSET_ARCH="$(detect_asset_arch)"
  ASSET="matrix-$VERSION-$ASSET_OS-$ASSET_ARCH"
  BASE_URL="https://github.com/$MATRIX_REPO/releases/download/$TAG"

  echo "==> Matrix OS CLI installer ($ASSET_OS/$ASSET_ARCH)"
  echo "    version: $VERSION"

  INSTALL_TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$INSTALL_TMPDIR"' EXIT

  BIN_PATH="$INSTALL_TMPDIR/matrix"
  SHA_PATH="$INSTALL_TMPDIR/$ASSET.sha256"

  echo "==> Downloading $BASE_URL/$ASSET"
  fetch "$BASE_URL/$ASSET" "$BIN_PATH" || die "download failed. Check that $TAG has a $ASSET release asset."
  fetch "$BASE_URL/$ASSET.sha256" "$SHA_PATH" || die "checksum download failed for $ASSET"
  verify_checksum "$BIN_PATH" "$SHA_PATH"
  chmod 0755 "$BIN_PATH"

  if [ -n "${MATRIX_INSTALL_DIR:-}" ]; then
    INSTALL_DIR="$MATRIX_INSTALL_DIR"
    install_binary_unprivileged "$INSTALL_DIR" || install_binary_with_sudo "$INSTALL_DIR"
  elif EXISTING_DIR="$(existing_matrix_install_dir)" && [ -n "$EXISTING_DIR" ]; then
    INSTALL_DIR="$EXISTING_DIR"
    install_binary_unprivileged "$INSTALL_DIR" || install_binary_with_sudo "$INSTALL_DIR"
  elif [ -n "${HOME:-}" ] && install_binary_unprivileged "$HOME/.local/bin"; then
    INSTALL_DIR="$HOME/.local/bin"
  else
    INSTALL_DIR="/usr/local/bin"
    install_binary_unprivileged "$INSTALL_DIR" || install_binary_with_sudo "$INSTALL_DIR"
  fi

  if "$INSTALL_DIR/matrix" --version >/dev/null 2>&1; then
    echo "==> Installed: $("$INSTALL_DIR/matrix" --version 2>/dev/null)"
  else
    echo "==> Installed: $INSTALL_DIR/matrix"
  fi
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "    Add $INSTALL_DIR to PATH or run '$INSTALL_DIR/matrix' directly." ;;
  esac
  PATH_MATRIX="$(command -v matrix 2>/dev/null || true)"
  if [ -n "$PATH_MATRIX" ] && [ "$PATH_MATRIX" != "$INSTALL_DIR/matrix" ]; then
    echo "    Warning: current shell resolves 'matrix' to $PATH_MATRIX before $INSTALL_DIR/matrix."
  fi
  echo "Next: run 'matrix login' to sign in."
}

install_macos() {
  TAG="$(resolve_version)"
  VERSION="$(cli_version_from_tag "$TAG")"
  PKG_NAME="MatrixSync-$VERSION.pkg"
  BASE_URL="https://github.com/$MATRIX_REPO/releases/download/$TAG"

  echo "==> Matrix OS installer (macOS)"
  echo "    version: $VERSION"

  if [ -n "${MATRIX_INSTALL_DIR:-}" ]; then
    echo "==> MATRIX_INSTALL_DIR set; installing CLI-only standalone binary"
    install_cli_binary "darwin" "$TAG"
    return
  fi

  INSTALL_TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$INSTALL_TMPDIR"' EXIT

  PKG_PATH="$INSTALL_TMPDIR/$PKG_NAME"
  echo "==> Checking for $BASE_URL/$PKG_NAME"
  if fetch "$BASE_URL/$PKG_NAME" "$PKG_PATH"; then
    need sudo
    echo "==> Verifying package signature"
    pkgutil --check-signature "$PKG_PATH" >/dev/null || die "downloaded pkg failed signature check"
    spctl --assess --type install "$PKG_PATH" >/dev/null 2>&1 \
      || echo "    (warning: spctl assess returned non-zero; continuing)"

    echo "==> Installing MatrixSync.app and matrix CLI (you may be prompted for your password)"
    sudo installer -pkg "$PKG_PATH" -target /

    if command -v matrix >/dev/null 2>&1; then
      echo "==> Installed: $(matrix --version 2>/dev/null || echo 'matrix')"
    else
      echo "==> Installed MatrixSync.app. Open a new shell if 'matrix' is not on PATH yet."
    fi
    echo "Next: run 'matrix login' to sign in."
    return
  fi

  echo "==> macOS package not available for $TAG; installing CLI-only standalone binary"
  rm -rf "$INSTALL_TMPDIR"
  install_cli_binary "darwin" "$TAG"
}

install_linux() {
  install_cli_binary "linux"
}

install_windows() {
  cat <<'WIN'
Windows installer is not available yet.

Temporary workaround (PowerShell):
  npm install -g @finnaai/matrix

Requires Node.js 20+ from https://nodejs.org.
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

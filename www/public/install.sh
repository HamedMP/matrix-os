#!/bin/sh
# Matrix OS CLI installer.
# Usage:
#   curl -fsSL https://matrix-os.com/install | sh
#   curl -fsSL https://matrix-os.com/install | VERSION=v0.9.0 sh
#
# Downloads the latest (or pinned) CLI release tarball from GitHub, extracts
# it under $PREFIX, and symlinks `matrix`, `matrixos`, `mos` into $BIN_DIR.

set -eu

REPO="${REPO:-hamedmp/matrix-os}"
PREFIX="${PREFIX:-$HOME/.finnaai/matrix}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
VERSION="${VERSION:-latest}"

RED="$(printf '\033[31m')"
GREEN="$(printf '\033[32m')"
YELLOW="$(printf '\033[33m')"
DIM="$(printf '\033[2m')"
RESET="$(printf '\033[0m')"

log() { printf '%s\n' "$*"; }
err() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; }
warn() { printf '%s%s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
ok() { printf '%s%s%s\n' "$GREEN" "$*" "$RESET"; }

need() {
  command -v "$1" >/dev/null 2>&1 || { err "missing required tool: $1"; exit 1; }
}

need curl
need tar
need uname

if ! command -v node >/dev/null 2>&1; then
  err "node is required (>= 20). Install from https://nodejs.org or via your package manager, then re-run."
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${node_major:-0}" -lt 20 ]; then
  err "node >= 20 required; found $(node -v)"
  exit 1
fi

api_base="https://api.github.com/repos/$REPO/releases"
if [ "$VERSION" = "latest" ]; then
  resolved="$(curl -fsSL "$api_base/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "${resolved:-}" ]; then
    err "could not resolve latest release from $api_base/latest"
    exit 1
  fi
  VERSION="$resolved"
fi

ver_no_v="${VERSION#v}"
asset="matrix-cli-${ver_no_v}.tar.gz"
url="https://github.com/$REPO/releases/download/$VERSION/$asset"

log "Downloading $asset from $VERSION"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ! curl -fsSL "$url" -o "$tmp/$asset"; then
  err "download failed: $url"
  exit 1
fi

if curl -fsSL "$url.sha256" -o "$tmp/$asset.sha256" 2>/dev/null; then
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    err "checksum mismatch: expected $expected, got $actual"
    exit 1
  fi
fi

mkdir -p "$PREFIX" "$BIN_DIR"
rm -rf "$PREFIX"/stage "$PREFIX"/bin "$PREFIX"/package.json "$PREFIX"/README.md
tar -xzf "$tmp/$asset" -C "$PREFIX"
# Tarball has a `stage/` top dir. Flatten.
if [ -d "$PREFIX/stage" ]; then
  for f in "$PREFIX"/stage/* "$PREFIX"/stage/.[!.]*; do
    [ -e "$f" ] || continue
    mv "$f" "$PREFIX/"
  done
  rmdir "$PREFIX/stage"
fi

for name in matrix matrixos mos; do
  ln -sf "$PREFIX/bin/$name" "$BIN_DIR/$name"
done

ok "Matrix OS CLI ${VERSION} installed."
log "${DIM}Prefix: ${PREFIX}${RESET}"
log "${DIM}Aliases: matrix, matrixos, mos → ${BIN_DIR}${RESET}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "add $BIN_DIR to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

log ""
log "Try: matrix --help"

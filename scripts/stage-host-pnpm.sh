#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="${1:?pass the host bundle stage directory}"
PACKAGE_MANAGER="$(node -p 'require(process.argv[1]).packageManager' "$ROOT_DIR/package.json")"
if [[ ! "$PACKAGE_MANAGER" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "The host bundle requires a pinned pnpm packageManager" >&2
  exit 1
fi
PNPM_VERSION="${PACKAGE_MANAGER#pnpm@}"
NODE_PREFIX="$STAGE_DIR/runtime/node"
APP_DIR="$STAGE_DIR/app"
test -x "$NODE_PREFIX/bin/node"
test -d "$APP_DIR"

# Resolve the pinned package during release packaging, never during a user's
# app readiness request. The updater replaces app/ but deliberately keeps the
# installed Node runtime, so both locations need the same executable.
TEMP_DIR="$(mktemp -d "$STAGE_DIR/.pnpm-stage.XXXXXXXX")"
trap 'rm -rf -- "$TEMP_DIR"' EXIT
corepack pack "$PACKAGE_MANAGER" -o "$TEMP_DIR/pnpm.tgz"
mkdir -p "$TEMP_DIR/package"
tar -xzf "$TEMP_DIR/pnpm.tgz" -C "$TEMP_DIR/package" --strip-components=2
ACTUAL_VERSION="$(node -p 'require(process.argv[1]).version' "$TEMP_DIR/package/package.json")"
if [ "$ACTUAL_VERSION" != "$PNPM_VERSION" ] || [ ! -x "$TEMP_DIR/package/bin/pnpm.cjs" ]; then
  echo "Staged pnpm package does not match $PACKAGE_MANAGER" >&2
  exit 1
fi

cp -a "$TEMP_DIR/package" "$NODE_PREFIX/lib/node_modules/pnpm"
mkdir -p "$APP_DIR/tools" "$APP_DIR/bin"
cp -a "$TEMP_DIR/package" "$APP_DIR/tools/pnpm"
ln -s ../lib/node_modules/pnpm/bin/pnpm.cjs "$NODE_PREFIX/bin/pnpm"
ln -s ../tools/pnpm/bin/pnpm.cjs "$APP_DIR/bin/pnpm"
chmod -R g+rwX "$NODE_PREFIX/lib/node_modules/pnpm"
find "$NODE_PREFIX/lib/node_modules/pnpm" -type d -exec chmod g+s {} +

RUNTIME_VERSION="$(PATH="$NODE_PREFIX/bin:/usr/bin:/bin" "$NODE_PREFIX/bin/pnpm" --version)"
APP_VERSION="$(PATH="$APP_DIR/bin:$NODE_PREFIX/bin:/usr/bin:/bin" sh -c 'pnpm --version')"
if [ "$RUNTIME_VERSION" != "$PNPM_VERSION" ] || [ "$APP_VERSION" != "$PNPM_VERSION" ]; then
  echo "Staged pnpm executable does not match $PACKAGE_MANAGER" >&2
  exit 1
fi

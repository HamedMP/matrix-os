#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${HOST_BUNDLE_DIST_DIR:-$ROOT_DIR/dist/host-bundle}"
STAGE_DIR="$DIST_DIR/stage"
BUNDLE_NAME="matrix-host-bundle.tar.gz"
NODE_VERSION="${HOST_BUNDLE_NODE_VERSION:-$(node -p 'process.versions.node')}"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
NODE_ARCHIVE="${NODE_DIST}.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_URL="${NODE_BASE_URL}/${NODE_ARCHIVE}"

rm -rf "$DIST_DIR"
mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/app" "$STAGE_DIR/runtime"

pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3 node-pty
pnpm --filter '@matrix-os/gateway' build
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-pk_test_Y2xlcmsuZXhhbXBsZS5jb20k}"
pnpm --filter './shell' build
pnpm --filter '@finnaai/matrix' build

curl --fail --location --max-time 120 "$NODE_URL" -o "$DIST_DIR/$NODE_ARCHIVE"
curl --fail --location --max-time 30 "$NODE_BASE_URL/SHASUMS256.txt" -o "$DIST_DIR/SHASUMS256.txt"
grep "  ${NODE_ARCHIVE}$" "$DIST_DIR/SHASUMS256.txt" > "$DIST_DIR/${NODE_ARCHIVE}.sha256"
(cd "$DIST_DIR" && sha256sum -c "${NODE_ARCHIVE}.sha256")
tar -xJf "$DIST_DIR/$NODE_ARCHIVE" -C "$STAGE_DIR/runtime"
mv "$STAGE_DIR/runtime/$NODE_DIST" "$STAGE_DIR/runtime/node"
"$STAGE_DIR/runtime/node/bin/npm" install -g --prefix "$STAGE_DIR/runtime/node" \
  @anthropic-ai/claude-code@2.1.91 \
  @openai/codex@0.118.0 \
  opencode-ai@1.14.25 \
  @mariozechner/pi-coding-agent@0.70.2

cp -a "$ROOT_DIR/distro/customer-vps/host-bin/." "$STAGE_DIR/bin/"
chmod 0750 "$STAGE_DIR/bin/matrix-gateway" "$STAGE_DIR/bin/matrix-shell" "$STAGE_DIR/bin/matrix-sync-agent"

cp -a "$ROOT_DIR/node_modules" "$STAGE_DIR/app/node_modules"
cp -a "$ROOT_DIR/packages" "$STAGE_DIR/app/packages"
cp -a "$ROOT_DIR/shell" "$STAGE_DIR/app/shell"
cp -a "$ROOT_DIR/home" "$STAGE_DIR/app/home"
cp -a "$ROOT_DIR/package.json" "$ROOT_DIR/pnpm-workspace.yaml" "$ROOT_DIR/pnpm-lock.yaml" "$STAGE_DIR/app/"
if [ -f "$ROOT_DIR/.npmrc" ]; then
  cp -a "$ROOT_DIR/.npmrc" "$STAGE_DIR/app/.npmrc"
fi

tar -C "$STAGE_DIR" -czf "$DIST_DIR/$BUNDLE_NAME" bin app runtime
(
  cd "$DIST_DIR"
  sha256sum "$BUNDLE_NAME" > "$BUNDLE_NAME.sha256"
)

printf '%s\n' "$DIST_DIR/$BUNDLE_NAME"

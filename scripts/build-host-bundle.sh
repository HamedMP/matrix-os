#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${HOST_BUNDLE_DIST_DIR:-$ROOT_DIR/dist/host-bundle}"
STAGE_DIR="$DIST_DIR/stage"
BUNDLE_NAME="matrix-host-bundle.tar.gz"
NODE_VERSION="${HOST_BUNDLE_NODE_VERSION:-24.18.0}"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
NODE_ARCHIVE="${NODE_DIST}.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
NODE_URL="${NODE_BASE_URL}/${NODE_ARCHIVE}"
ZELLIJ_VERSION="${HOST_BUNDLE_ZELLIJ_VERSION:-0.44.1}"
ZELLIJ_ARCHIVE="zellij-x86_64-unknown-linux-musl.tar.gz"
ZELLIJ_URL="https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/${ZELLIJ_ARCHIVE}"
GH_VERSION="${HOST_BUNDLE_GH_VERSION:-2.86.0}"
GH_DIST="gh_${GH_VERSION}_linux_amd64"
GH_ARCHIVE="${GH_DIST}.tar.gz"
GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ARCHIVE}"
UV_INSTALLER_URL="${HOST_BUNDLE_UV_INSTALLER_URL:-https://astral.sh/uv/install.sh}"

rm -rf "$DIST_DIR"
mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/app" "$STAGE_DIR/runtime" "$STAGE_DIR/systemd"

pnpm install --frozen-lockfile
pnpm rebuild node-pty
pnpm --filter '@matrix-os/observability' build
pnpm --filter '@matrix-os/brand' build
pnpm --filter '@matrix-os/kernel' build
pnpm --filter '@matrix-os/gateway' build
mkdir -p "$ROOT_DIR/packages/gateway/dist/app-runtime"
cp -a "$ROOT_DIR/packages/gateway/src/app-runtime/"*.html "$ROOT_DIR/packages/gateway/dist/app-runtime/"
: "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY before building the customer host bundle}"
# In-app auth routes; defaults keep Clerk cross-links off the hosted Account
# Portal (accounts.matrix-os.com) on every VPS shell.
export NEXT_PUBLIC_CLERK_SIGN_IN_URL="${NEXT_PUBLIC_CLERK_SIGN_IN_URL:-/sign-in}"
export NEXT_PUBLIC_CLERK_SIGN_UP_URL="${NEXT_PUBLIC_CLERK_SIGN_UP_URL:-/sign-up}"
export NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY:-}"
export NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN="${NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN:-}"
export NEXT_PUBLIC_POSTHOG_HOST="${NEXT_PUBLIC_POSTHOG_HOST:-}"
export NEXT_PUBLIC_POSTHOG_API_HOST="${NEXT_PUBLIC_POSTHOG_API_HOST:-}"
if [ "${HOST_BUNDLE_SKIP_SHELL_BUILD:-false}" = "true" ]; then
  test -d "$ROOT_DIR/shell/.next" || {
    echo "HOST_BUNDLE_SKIP_SHELL_BUILD=true but shell/.next is missing" >&2
    exit 1
  }
else
  pnpm --filter './shell' exec next build --webpack
  if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ROOT_DIR" restore -- shell/next-env.d.ts 2>/dev/null || true
  fi
fi
pnpm --filter '@finnaai/matrix' build
node "$ROOT_DIR/scripts/build-default-apps.mjs" "$ROOT_DIR/home/apps"
pnpm exec tsx -e 'import { writeFileSync } from "node:fs"; import { generateTemplateManifest } from "./packages/kernel/src/boot.ts"; writeFileSync("home/.template-manifest.json", JSON.stringify(generateTemplateManifest("home"), null, 2) + "\n");'
(cd "$ROOT_DIR/packages/symphony-elixir" && \
  MIX_DEPS_PATH="$DIST_DIR/symphony-deps" MIX_BUILD_PATH="$DIST_DIR/symphony-build" MIX_ENV=prod mix deps.get --only prod && \
  MIX_DEPS_PATH="$DIST_DIR/symphony-deps" MIX_BUILD_PATH="$DIST_DIR/symphony-build" MIX_ENV=prod mix release symphony --path "$DIST_DIR/symphony-release" --overwrite)

curl --fail --location --max-time 120 "$NODE_URL" -o "$DIST_DIR/$NODE_ARCHIVE"
curl --fail --location --max-time 30 "$NODE_BASE_URL/SHASUMS256.txt" -o "$DIST_DIR/SHASUMS256.txt"
grep "  ${NODE_ARCHIVE}$" "$DIST_DIR/SHASUMS256.txt" > "$DIST_DIR/${NODE_ARCHIVE}.sha256"
(cd "$DIST_DIR" && sha256sum -c "${NODE_ARCHIVE}.sha256")
tar -xJf "$DIST_DIR/$NODE_ARCHIVE" -C "$STAGE_DIR/runtime"
mv "$STAGE_DIR/runtime/$NODE_DIST" "$STAGE_DIR/runtime/node"

curl --fail --location --max-time 180 "$ZELLIJ_URL" -o "$DIST_DIR/$ZELLIJ_ARCHIVE"
tar -xzf "$DIST_DIR/$ZELLIJ_ARCHIVE" -C "$STAGE_DIR/bin" zellij
chmod 0755 "$STAGE_DIR/bin/zellij"
test -x "$STAGE_DIR/bin/zellij"
curl --fail --location --max-time 180 "$GH_URL" -o "$DIST_DIR/$GH_ARCHIVE"
tar -xzf "$DIST_DIR/$GH_ARCHIVE" -C "$DIST_DIR"
install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/runtime/node/bin/gh"
curl --fail --location --max-time 120 "$UV_INSTALLER_URL" -o "$DIST_DIR/uv-install.sh"
INSTALLER_NO_MODIFY_PATH=1 UV_INSTALL_DIR="$STAGE_DIR/runtime/node/bin" sh "$DIST_DIR/uv-install.sh"
# Customer VPS terminals run as the matrix user. Keep the runtime prefix
# group-writable so selectable boot-time tool packs can install in place.
chmod -R g+rwX "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin"
find "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin" -type d -exec chmod g+s {} +

cp -a "$ROOT_DIR/distro/customer-vps/host-bin/." "$STAGE_DIR/bin/"
cp -a "$ROOT_DIR/distro/customer-vps/systemd/." "$STAGE_DIR/systemd/"
# The bundle is usually extracted as root:root during in-place upgrades, while
# the systemd units execute these wrappers as the matrix user.
chmod 0755 "$STAGE_DIR/bin/matrix-owner-env" "$STAGE_DIR/bin/matrix-gateway" "$STAGE_DIR/bin/matrix-sync-bundled-home-assets" "$STAGE_DIR/bin/matrix-shell" "$STAGE_DIR/bin/matrix-code" "$STAGE_DIR/bin/matrix-sync-agent" "$STAGE_DIR/bin/matrix-symphony" "$STAGE_DIR/bin/matrix-symphony-control" "$STAGE_DIR/bin/matrix-update" "$STAGE_DIR/bin/matrix-ensure-swap" "$STAGE_DIR/bin/matrix-install-hermes" "$STAGE_DIR/bin/matrix-hermes-dashboard" "$STAGE_DIR/bin/matrix-install-openclaw" "$STAGE_DIR/bin/matrix-openclaw-gateway" "$STAGE_DIR/bin/matrix-agent-runtime-control" "$STAGE_DIR/bin/matrix-install-linux-tools" "$STAGE_DIR/bin/matrix-install-tool-pack" "$STAGE_DIR/bin/matrix-install-developer-tools" "$STAGE_DIR/bin/matrix-messaging-health" "$STAGE_DIR/bin/matrix-messaging-backup" "$STAGE_DIR/bin/matrix-messaging-restore" "$STAGE_DIR/bin/zellij" "$STAGE_DIR/runtime/node/bin/gh"

cp -a "$ROOT_DIR/node_modules" "$STAGE_DIR/app/node_modules"
install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/app/node_modules/.bin/gh"
cp -a "$ROOT_DIR/packages" "$STAGE_DIR/app/packages"
mkdir -p "$STAGE_DIR/app/packages/symphony-elixir/release"
cp -a "$DIST_DIR/symphony-release/." "$STAGE_DIR/app/packages/symphony-elixir/release/"
cp -a "$ROOT_DIR/shell" "$STAGE_DIR/app/shell"
cp -a "$ROOT_DIR/home" "$STAGE_DIR/app/home"
mkdir -p "$STAGE_DIR/app/scripts"
cp -a "$ROOT_DIR/scripts/build-default-apps.mjs" "$STAGE_DIR/app/scripts/build-default-apps.mjs"
cp -a "$ROOT_DIR/scripts/reset-shipped-icons.mjs" "$STAGE_DIR/app/scripts/reset-shipped-icons.mjs"
cp -a "$ROOT_DIR/scripts/install-hermes-matrix-skills.sh" "$STAGE_DIR/app/scripts/install-hermes-matrix-skills.sh"
cp -a "$ROOT_DIR/scripts/sync-matrix-agent-skills.sh" "$STAGE_DIR/app/scripts/sync-matrix-agent-skills.sh"
cp -a "$ROOT_DIR/skills" "$STAGE_DIR/app/skills"
cp -a "$ROOT_DIR/package.json" "$ROOT_DIR/pnpm-workspace.yaml" "$ROOT_DIR/pnpm-lock.yaml" "$STAGE_DIR/app/"
if [ -f "$ROOT_DIR/.npmrc" ]; then
  cp -a "$ROOT_DIR/.npmrc" "$STAGE_DIR/app/.npmrc"
fi

# Keep the host bundle runtime-only. These directories are generated or
# build-time dependency stores; carrying them to every VPS bloats R2 artifacts
# and slows upgrades without changing runtime behavior.
rm -rf "$STAGE_DIR/app/shell/.next/cache" "$STAGE_DIR/app/shell/e2e" "$STAGE_DIR/app/shell/node_modules"
find "$STAGE_DIR/app/home/apps" -type d -name node_modules -prune -exec rm -rf {} +

# Writes release.json plus the incremental app manifest before packaging, then
# writes the bundle manifest beside the tarball.
node "$ROOT_DIR/scripts/host-bundle-release.mjs" write-release
HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES="${HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES:-node_modules/}" \
  node "$ROOT_DIR/scripts/host-bundle-incremental-manifest.mjs" "$STAGE_DIR/app" "$STAGE_DIR/incremental-manifest.json" "$DIST_DIR/objects"
cp -a "$STAGE_DIR/incremental-manifest.json" "$DIST_DIR/incremental-manifest.json"
tar -C "$STAGE_DIR" -czf "$DIST_DIR/$BUNDLE_NAME" bin app runtime systemd release.json incremental-manifest.json
node "$ROOT_DIR/scripts/host-bundle-release.mjs" write-manifest

printf '%s\n' "$DIST_DIR/$BUNDLE_NAME"

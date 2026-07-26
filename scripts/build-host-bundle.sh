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
ZELLIJ_BUILD_DIR="${HOST_BUNDLE_ZELLIJ_BUILD_DIR:-$DIST_DIR/zellij-production}"
GH_VERSION="${HOST_BUNDLE_GH_VERSION:-2.86.0}"
GH_DIST="gh_${GH_VERSION}_linux_amd64"
GH_ARCHIVE="${GH_DIST}.tar.gz"
GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ARCHIVE}"
UV_INSTALLER_URL="${HOST_BUNDLE_UV_INSTALLER_URL:-https://astral.sh/uv/install.sh}"

rm -rf "$DIST_DIR"
mkdir -p \
  "$STAGE_DIR/bin" \
  "$STAGE_DIR/app" \
  "$STAGE_DIR/runtime" \
  "$STAGE_DIR/systemd" \
  "$STAGE_DIR/libexec/terminal-runtime/v1"

pnpm install --frozen-lockfile
pnpm rebuild node-pty
pnpm --filter '@matrix-os/observability' build
pnpm --filter '@matrix-os/brand' build
pnpm --filter '@matrix-os/kernel' build
pnpm --filter '@matrix-os/gateway' build
pnpm --filter '@matrix-os/terminal-runtime' build
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

if [ -z "${HOST_BUNDLE_ZELLIJ_BUILD_DIR:-}" ]; then
  "$ROOT_DIR/scripts/terminal-runtime/zellij/build.sh" "$ZELLIJ_BUILD_DIR"
fi
"$ROOT_DIR/scripts/terminal-runtime/zellij/verify-build.sh" "$ZELLIJ_BUILD_DIR"
zellij_snapshot_dir="$(mktemp -d "$DIST_DIR/zellij-snapshot.XXXXXX")"
for zellij_input in zellij build.json build-id zellij.sha256; do
  cp --no-dereference -- \
    "$ZELLIJ_BUILD_DIR/$zellij_input" \
    "$zellij_snapshot_dir/$zellij_input"
done
"$ROOT_DIR/scripts/terminal-runtime/zellij/verify-build.sh" "$zellij_snapshot_dir"
install -m 0755 "$zellij_snapshot_dir/zellij" "$STAGE_DIR/bin/zellij"
install -m 0644 "$zellij_snapshot_dir/build.json" "$STAGE_DIR/bin/zellij.build.json"
expected_zellij_sha256="$(jq -er '.binarySha256' "$STAGE_DIR/bin/zellij.build.json")"
actual_zellij_sha256="$(sha256sum "$STAGE_DIR/bin/zellij" | awk '{print $1}')"
if [ "$actual_zellij_sha256" != "$expected_zellij_sha256" ]; then
  echo "zellij_staged_binary_digest_mismatch" >&2
  exit 1
fi
curl --fail --location --max-time 180 "$GH_URL" -o "$DIST_DIR/$GH_ARCHIVE"
tar -xzf "$DIST_DIR/$GH_ARCHIVE" -C "$DIST_DIR"
install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/runtime/node/bin/gh"
curl --fail --location --max-time 120 "$UV_INSTALLER_URL" -o "$DIST_DIR/uv-install.sh"
INSTALLER_NO_MODIFY_PATH=1 UV_INSTALL_DIR="$STAGE_DIR/runtime/node/bin" sh "$DIST_DIR/uv-install.sh"
# Customer VPS terminals run as the matrix user. Keep the runtime prefix
# group-writable so selectable boot-time tool packs can install in place.
chmod -R g+rwX "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin"

terminal_generation_build="$STAGE_DIR/libexec/terminal-runtime/v1/payload"
install -d -m 0755 \
  "$terminal_generation_build/node_modules/node-pty/build/Release" \
  "$terminal_generation_build/node_modules/node-pty/lib" \
  "$terminal_generation_build/node_modules/zod"
install -m 0755 \
  "$ROOT_DIR/packages/terminal-runtime/dist/"*.js \
  "$terminal_generation_build/"
install -m 0644 \
  "$ROOT_DIR/packages/terminal-runtime/package.json" \
  "$terminal_generation_build/package.json"
install -m 0644 \
  "$ROOT_DIR/packages/terminal-runtime/assets/config.kdl" \
  "$terminal_generation_build/config.kdl"
install -m 0644 \
  "$ROOT_DIR/packages/terminal-runtime/assets/layout.kdl" \
  "$terminal_generation_build/layout.kdl"
install -m 0644 \
  "$ROOT_DIR/packages/terminal-runtime/assets/agent-layout.kdl" \
  "$terminal_generation_build/agent-layout.kdl"
install -m 0755 \
  "$ROOT_DIR/packages/gateway/src/coding-agents/codex-app-server-runner.mjs" \
  "$ROOT_DIR/packages/gateway/src/coding-agents/codex-provider-version-check.mjs" \
  "$terminal_generation_build/"
cc -std=c11 -Wall -Wextra -Werror -O2 \
  "$ROOT_DIR/packages/terminal-runtime/native/supervisor-acceptor.c" \
  -o "$terminal_generation_build/supervisor-acceptor"
install -m 0644 \
  "$(readlink -f "$ROOT_DIR/node_modules/node-pty")/package.json" \
  "$terminal_generation_build/node_modules/node-pty/package.json"
cp -aL --no-preserve=links \
  "$(readlink -f "$ROOT_DIR/node_modules/node-pty")/lib/." \
  "$terminal_generation_build/node_modules/node-pty/lib/"
install -m 0755 \
  "$(readlink -f "$ROOT_DIR/node_modules/node-pty")/build/Release/pty.node" \
  "$terminal_generation_build/node_modules/node-pty/build/Release/pty.node"
install -m 0644 \
  "$(readlink -f "$ROOT_DIR/node_modules/zod")/package.json" \
  "$terminal_generation_build/node_modules/zod/package.json"
cp -aL --no-preserve=links \
  "$(readlink -f "$ROOT_DIR/node_modules/zod")/v4" \
  "$terminal_generation_build/node_modules/zod/v4"
if [ "${MATRIX_TERMINAL_RUNTIME_SPIKE:-0}" = "1" ]; then
  install -d -m 0755 "$terminal_generation_build/spikes"
  cp -a --no-preserve=links \
    "$ROOT_DIR/scripts/spikes/terminal-runtime/." \
    "$terminal_generation_build/spikes/"
  install -m 0644 \
    "$ROOT_DIR/scripts/terminal-runtime/zellij/v0.44.3-matrix.1.build.json" \
    "$terminal_generation_build/spikes/v0.44.3-matrix.1.build.json"
fi
if find "$terminal_generation_build" -type l -print -quit | grep -q .; then
  echo "terminal_runtime_generation_contains_symlink" >&2
  exit 1
fi
if find "$terminal_generation_build" -type f -links +1 -print -quit |
  grep -q .; then
  echo "terminal_runtime_generation_contains_hardlink" >&2
  exit 1
fi
(
  cd "$terminal_generation_build"
  LC_ALL=C find . -type f ! -name runtime-manifest.sha256 -printf '%P\n' |
    LC_ALL=C sort |
    while IFS= read -r runtime_file; do
      if [[ ! "$runtime_file" =~ ^[A-Za-z0-9._/-]+$ ]]; then
        echo "terminal_runtime_manifest_path_invalid" >&2
        exit 1
      fi
      sha256sum "$runtime_file"
    done >runtime-manifest.sha256
)
terminal_generation_id="$(
  sha256sum "$terminal_generation_build/runtime-manifest.sha256" |
    awk '{print $1}'
)"
mv \
  "$terminal_generation_build" \
  "$STAGE_DIR/libexec/terminal-runtime/v1/$terminal_generation_id"
ln -s \
  "v1/$terminal_generation_id" \
  "$STAGE_DIR/libexec/terminal-runtime/current"

cp -a "$ROOT_DIR/distro/customer-vps/host-bin/." "$STAGE_DIR/bin/"
cp -a "$ROOT_DIR/distro/customer-vps/systemd/." "$STAGE_DIR/systemd/"
if [ "${MATRIX_TERMINAL_RUNTIME_SPIKE:-0}" = "1" ]; then
  chmod 0755 "$STAGE_DIR/bin/matrix-terminal-spike-control"
else
  rm -f -- "$STAGE_DIR/bin/matrix-terminal-spike-control"
fi
# The bundle is usually extracted as root:root during in-place upgrades, while
# the systemd units execute these wrappers as the matrix user.
chmod 0755 "$STAGE_DIR/bin/matrix-owner-env" "$STAGE_DIR/bin/matrix-gateway" "$STAGE_DIR/bin/matrix-agent-bridge" "$STAGE_DIR/bin/matrix-sync-bundled-home-assets" "$STAGE_DIR/bin/matrix-shell" "$STAGE_DIR/bin/matrix-code" "$STAGE_DIR/bin/matrix-sync-agent" "$STAGE_DIR/bin/matrix-update-service" "$STAGE_DIR/bin/matrix-validate-host-bundle" "$STAGE_DIR/bin/matrix-symphony" "$STAGE_DIR/bin/matrix-symphony-control" "$STAGE_DIR/bin/matrix-tool-pack-control" "$STAGE_DIR/bin/matrix-update" "$STAGE_DIR/bin/matrix-ensure-swap" "$STAGE_DIR/bin/matrix-install-hermes" "$STAGE_DIR/bin/matrix-hermes-dashboard" "$STAGE_DIR/bin/matrix-install-linux-tools" "$STAGE_DIR/bin/matrix-install-tool-pack" "$STAGE_DIR/bin/matrix-install-developer-tools" "$STAGE_DIR/bin/matrix-prepare-gateway-runtime" "$STAGE_DIR/bin/matrix-messaging-health" "$STAGE_DIR/bin/matrix-messaging-backup" "$STAGE_DIR/bin/matrix-messaging-restore" "$STAGE_DIR/bin/matrix-terminal-supervisor" "$STAGE_DIR/bin/matrix-terminal-keeper" "$STAGE_DIR/bin/matrix-terminal-pane" "$STAGE_DIR/bin/matrix-terminal-runtime-op" "$STAGE_DIR/bin/zellij" "$STAGE_DIR/runtime/node/bin/gh"

cp -a "$ROOT_DIR/packages" "$STAGE_DIR/app/packages"
node --input-type=module -e 'import { readFile, writeFile } from "node:fs/promises"; const path = process.argv[1]; const manifest = JSON.parse(await readFile(path, "utf8")); if (manifest.exports?.["."] !== "./src/index.ts" || manifest.main !== "src/index.ts" || manifest.types !== "src/index.ts") throw new Error("terminal_runtime_package_manifest_invalid"); manifest.exports["."] = "./dist/index.js"; manifest.main = "dist/index.js"; manifest.types = "dist/index.d.ts"; await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);' "$STAGE_DIR/app/packages/terminal-runtime/package.json"
mkdir -p "$STAGE_DIR/app/packages/symphony-elixir/release"
cp -a "$DIST_DIR/symphony-release/." "$STAGE_DIR/app/packages/symphony-elixir/release/"
cp -a "$ROOT_DIR/shell" "$STAGE_DIR/app/shell"
cp -a "$ROOT_DIR/home" "$STAGE_DIR/app/home"
mkdir -p "$STAGE_DIR/app/scripts"
cp -a "$ROOT_DIR/scripts/fix-node-pty-perms.mjs" "$STAGE_DIR/app/scripts/fix-node-pty-perms.mjs"
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
find "$STAGE_DIR/app" -name node_modules -prune -exec rm -rf -- {} +
rm -rf "$STAGE_DIR/app/shell/.next/cache" "$STAGE_DIR/app/shell/e2e"
pnpm --dir "$STAGE_DIR/app" --config.enable-global-virtual-store=false --filter '@matrix-os/gateway...' --filter 'shell...' install --prod --frozen-lockfile
pnpm --dir "$STAGE_DIR/app" rebuild node-pty better-sqlite3
(cd "$STAGE_DIR/app" && "$STAGE_DIR/runtime/node/bin/node" --input-type=module -e 'await import("@matrix-os/terminal-runtime")')
install -d -m 0755 "$STAGE_DIR/app/node_modules/.bin"
install -m 0755 "$DIST_DIR/$GH_DIST/bin/gh" "$STAGE_DIR/app/node_modules/.bin/gh"

# Writes release.json plus the incremental app manifest before packaging, then
# writes the bundle manifest beside the tarball.
node "$ROOT_DIR/scripts/host-bundle-release.mjs" write-release
HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES="${HOST_BUNDLE_INCREMENTAL_EXCLUDE_PREFIXES:-node_modules/}" \
  node "$ROOT_DIR/scripts/host-bundle-incremental-manifest.mjs" "$STAGE_DIR/app" "$STAGE_DIR/incremental-manifest.json" "$DIST_DIR/objects"
cp -a "$STAGE_DIR/incremental-manifest.json" "$DIST_DIR/incremental-manifest.json"
bundle_members=(bin app runtime systemd libexec release.json incremental-manifest.json)
activation_source="$ROOT_DIR/distro/customer-vps/terminal-runtime-activation"
if [ -e "$activation_source" ] || [ -L "$activation_source" ]; then
  [ -f "$activation_source" ] && [ ! -L "$activation_source" ] || {
    echo "terminal_runtime_activation_invalid" >&2
    exit 1
  }
  [ "$(stat -c %s "$activation_source")" -eq 14 ] &&
    [ "$(cat "$activation_source")" = "supervised-v1" ] || {
    echo "terminal_runtime_activation_invalid" >&2
    exit 1
  }
  install -m 0644 "$activation_source" "$STAGE_DIR/terminal-runtime-activation"
  bundle_members+=(terminal-runtime-activation)
fi
tar -C "$STAGE_DIR" -czf "$DIST_DIR/$BUNDLE_NAME" "${bundle_members[@]}"
MATRIX_HOST_BUNDLE_VALIDATION_DIAGNOSTICS=1 \
  "$STAGE_DIR/bin/matrix-validate-host-bundle" "$DIST_DIR/$BUNDLE_NAME"
node "$ROOT_DIR/scripts/host-bundle-release.mjs" write-manifest

printf '%s\n' "$DIST_DIR/$BUNDLE_NAME"

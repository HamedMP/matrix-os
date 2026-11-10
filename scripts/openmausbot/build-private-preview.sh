#!/usr/bin/env bash
set -euo pipefail

readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly revision=5491874882378603aef2536790650a192e63d56d
readonly digest=2c09d9776f5502ac73cdcb5dd8a2e82dc4c9efd7d881e40f81a8ecdaedd8b8f8
readonly stage="${1:?usage: build-private-preview.sh <host bundle stage>}"
readonly build_sha="${MATRIX_BUILD_SHA:-$(git -C "$root" rev-parse HEAD)}"
[[ "$build_sha" =~ ^[0-9a-f]{40}$ ]]
readonly image="matrix-openmausbot-oss:matrix-$build_sha"
readonly work="$(mktemp -d)"
trap 'node -e '\''require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })'\'' "$work"' EXIT
mkdir -p "$work/source" "$stage/bin" "$stage/app"

curl --fail --silent --show-error --location --max-time 180 \
  "https://codeload.github.com/milind-soni/OpenMausBot/tar.gz/$revision" -o "$work/source.tar.gz"
printf '%s  %s\n' "$digest" "$work/source.tar.gz" | shasum -a 256 --check -
tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$work/source/enterprise"
node "$root/scripts/openmausbot/apply-private-host.mjs" "$work/source"
node "$root/scripts/openmausbot/apply-matrix-theme.mjs" "$work/source"

(
  cd "$work/source"
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1
  pnpm install --frozen-lockfile --ignore-scripts --config.enableGlobalVirtualStore=false
  pnpm run build:server
  pnpm exec vite build
  node scripts/prepare-browser.mjs --target linux-x64
  node scripts/build-npm-package.mjs
)
package="$work/source/release/npm"
test ! -e "$package/enterprise" && test ! -e "$package/dist-server/enterprise"
install -m 0644 "$work/source/NOTICE" "$package/NOTICE"
install -m 0644 "$root/scripts/openmausbot/runtime-pnpm-lock.yaml" "$package/pnpm-lock.yaml"
cp -a "$work/source/third_party" "$package/third_party"
cp -a "$work/source/dist-native/browser/linux-x64" "$package/browser-engine"
docker build --platform linux/amd64 --tag "$image" --label "org.matrix-os.openmausbot.bundle-sha=$build_sha" \
  --file "$root/scripts/openmausbot/Dockerfile" "$package"
# Save the tag; BuildKit's image ID can be an index digest the host Docker
# image store does not retain after importing the archive.
docker save --output "$stage/bin/matrix-openmausbot.image.tar" "$image"
printf '%s\n' "$image" > "$stage/bin/matrix-openmausbot.image-ref"
printf '%s\n' "$image" > "$stage/app/MATRIX_OPENMAUSBOT_PREVIEW"

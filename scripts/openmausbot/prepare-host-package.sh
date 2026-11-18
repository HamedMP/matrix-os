#!/usr/bin/env bash
set -euo pipefail

readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly revision=5491874882378603aef2536790650a192e63d56d
readonly digest=2c09d9776f5502ac73cdcb5dd8a2e82dc4c9efd7d881e40f81a8ecdaedd8b8f8
readonly destination="${1:?usage: prepare-host-package.sh <package directory>}"
readonly work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/source"

curl --fail --silent --show-error --location --max-time 180 \
  "https://codeload.github.com/milind-soni/OpenMausBot/tar.gz/$revision" -o "$work/source.tar.gz"
printf '%s  %s\n' "$digest" "$work/source.tar.gz" | sha256sum --check -
tar -xzf "$work/source.tar.gz" -C "$work/source" --strip-components=1
node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$work/source/enterprise"
node "$root/apply-private-host.mjs" "$work/source"
node "$root/apply-matrix-theme.mjs" "$work/source" "$root/bots.svg"

(
  cd "$work/source"
  export ELECTRON_SKIP_BINARY_DOWNLOAD=1
  corepack pnpm@10.33.4 install --frozen-lockfile --ignore-scripts --config.enableGlobalVirtualStore=false
  corepack pnpm@10.33.4 run build:server
  corepack pnpm@10.33.4 exec vite build
  node scripts/prepare-browser.mjs --target linux-x64
  node scripts/build-npm-package.mjs
)
package="$work/source/release/npm"
test ! -e "$package/enterprise" && test ! -e "$package/dist-server/enterprise"
install -m 0644 "$work/source/NOTICE" "$package/NOTICE"
install -m 0644 "$root/runtime-pnpm-lock.yaml" "$package/pnpm-lock.yaml"
install -m 0644 "$root/matrix-drive-mcp.mjs" "$package/matrix-drive-mcp.mjs"
cp -a "$work/source/third_party" "$package/third_party"
cp -a "$work/source/dist-native/browser/linux-x64" "$package/browser-engine"
mv "$package" "$destination"

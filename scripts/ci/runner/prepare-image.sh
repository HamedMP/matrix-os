#!/bin/bash
# Runs at reviewed image build time. Fetch immutable package content, never
# checkout/execute repository scripts or npm lifecycle hooks as image-builder root.
set -euo pipefail
source_sha=${1:?Exact public source SHA required}
[[ $source_sha =~ ^[a-f0-9]{40}$ ]] || exit 64
prepare_dir=$(mktemp -d)
trap 'rm -rf "$prepare_dir"' EXIT
curl --fail --location --retry 3 --connect-timeout 10 --max-time 120 --max-filesize 20971520 \
  "https://raw.githubusercontent.com/HamedMP/matrix-os/$source_sha/pnpm-lock.yaml" -o "$prepare_dir/pnpm-lock.yaml"
printf '{"private":true,"packageManager":"pnpm@10.33.4"}\n' >"$prepare_dir/package.json"
printf 'minimumReleaseAge: 10080\n' >"$prepare_dir/pnpm-workspace.yaml"
cd "$prepare_dir"
node /opt/matrix-ci/prepared-patches.mjs "$prepare_dir/pnpm-lock.yaml" "$source_sha" "$prepare_dir"
pnpm fetch --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /opt/matrix-ci/pnpm-store
sha256sum pnpm-lock.yaml | cut -d ' ' -f 1 >/opt/matrix-ci/prepared-lock.sha256
printf '%s\n' "$source_sha" >/opt/matrix-ci/prepared-source-sha
# Playwright's verified npm packages select the exact upstream Chromium revision.
# Install every distinct version in the lockfile (shell and browser MCP differ).
mapfile -t browser_versions < <(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const versions=[...new Set([...readFileSync("pnpm-lock.yaml","utf8").matchAll(/^  playwright@([0-9]+\.[0-9]+\.[0-9]+):$/gm)].map(match=>match[1]))];
  if(!versions.length || versions.length>4) process.exit(64);
  process.stdout.write(versions.join("\n"));
')
(( ${#browser_versions[@]} >= 1 && ${#browser_versions[@]} <= 4 )) || exit 64
for version in "${browser_versions[@]}"; do
  tool_dir="$prepare_dir/playwright-$version"
  mkdir "$tool_dir"
  printf '{"private":true}\n' >"$tool_dir/package.json"
  printf 'minimumReleaseAge: 10080\n' >"$tool_dir/pnpm-workspace.yaml"
  pnpm --dir "$tool_dir" add --ignore-scripts --ignore-pnpmfile --save-exact "playwright@$version"
  PLAYWRIGHT_BROWSERS_PATH=/opt/matrix-ci/browsers pnpm --dir "$tool_dir" exec playwright install chromium
 done
# Image root filesystem is read-only at runtime; readable cache content belongs
# to root and is never mutated by submitted code or mounted into another run.
chmod -R a+rX /opt/matrix-ci/pnpm-store /opt/matrix-ci/browsers

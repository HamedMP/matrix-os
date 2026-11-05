#!/usr/bin/env bash
# Explicit Linux UID/permissions regression. Uses only a local dev image and
# disposable container storage; no network, host source writes or service data.
set -euo pipefail
: "${MATRIX_DOCKER_DEV_TEST_IMAGE:?set to a locally available Matrix development image}"
root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture"/{scripts,distro}
cp "$root"/scripts/{build-typescript,typescript-build-output}.mjs "$fixture/scripts"
cp "$root/distro/docker-dev-entrypoint.sh" "$fixture/distro"
ts="$(node -p "require('fs').realpathSync('node_modules/typescript')")"
docker run --rm --pull never --network none --entrypoint bash \
  -v "$fixture:/fixture:ro" -v "$ts:/compiler:ro" "$MATRIX_DOCKER_DEV_TEST_IMAGE" -euc '
cp -r /fixture /test
chmod 755 /test
cd /test
mkdir -p node_modules/.bin node_modules/.pnpm
ln -s /compiler node_modules/typescript
touch pnpm-lock.yaml
md5sum pnpm-lock.yaml > node_modules/.pnpm-lock-hash
for pkg in brand observability terminal-runtime kernel; do
  dir=packages/$pkg
  mkdir -p "$dir"/{src,dist,.matrix-build-output}
  chmod 700 "$dir/.matrix-build-output"
  chown matrixos:matrixos "$dir/.matrix-build-output"
  echo "{\"type\":\"module\"}" > "$dir/package.json"
  echo "{\"compilerOptions\":{\"outDir\":\"dist\",\"rootDir\":\"src\",\"target\":\"ES2022\",\"types\":[]},\"include\":[\"src\"]}" > "$dir/tsconfig.json"
done
cat > node_modules/.bin/pnpm << "SH"
#!/bin/sh
set -eu
echo "build $2 uid=$(id -u)"
test "$(id -u)" = "$(id -u matrixos)"
cd "/test/packages/${2#@matrix-os/}"
if [ "$2" = "@matrix-os/kernel" ]; then exec node ../../scripts/build-typescript.mjs --notify-gateway; fi
exec node ../../scripts/build-typescript.mjs
SH
chmod 755 node_modules/.bin/pnpm
marker=packages/kernel/matrix-kernel-published.tsbuildinfo
printf "%064d" 0 > "$marker"
chown 501:501 "$marker"
chmod 0644 "$marker"
for revision in 1 2; do
  for pkg in brand observability terminal-runtime kernel; do
    echo "export const revision = $revision;" > "packages/$pkg/src/index.ts"
  done
  bash distro/docker-dev-entrypoint.sh --build-dev-packages
  for pkg in brand observability terminal-runtime kernel; do
    base="packages/$pkg"
    test "$(stat -c %u "$base/src")" = 0
    test "$(stat -c %u "$base/.matrix-build-output")" = "$(id -u matrixos)"
    test "$(stat -c %a "$base/.matrix-build-output")" = 700
    su-exec nobody node --input-type=module -e "import {revision} from \"./$base/dist/index.js\"; if (revision !== $revision) process.exit(1)"
  done
done
rm "$marker"
echo "owner sentinel" > /test/owner
chown 501:501 /test/owner
for kind in symlink hardlink invalid fifo; do
  case "$kind" in
    symlink) ln -s /test/owner "$marker" ;;
    hardlink) ln /test/owner "$marker" ;;
    invalid) cp -p /test/owner "$marker" ;;
    fifo) mkfifo "$marker" ;;
  esac
  if bash distro/docker-dev-entrypoint.sh --build-dev-packages >/dev/null 2>&1; then exit 1; fi
  if [ "$kind" = invalid ]; then
    test "$(cat "$marker")" = "owner sentinel"
    test "$(stat -c %u "$marker")" = 501
  fi
  test "$(cat /test/owner)" = "owner sentinel"
  test "$(stat -c %u /test/owner)" = 501
  rm "$marker"
done
'

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$(node -p '`${process.platform}-${process.arch}-${process.report.getReport().header.glibcVersionRuntime ? "glibc" : "other"}`')"
OUTPUT_DIR="$ROOT_DIR/packages/gateway/dist/native/linux-x64-glibc"

if [ "$TARGET" != "linux-x64-glibc" ]; then
  rm -rf "$OUTPUT_DIR"
  echo "Gateway native filesystem capability: unsupported build target $TARGET (fail-closed runtime retained)"
  exit 0
fi

NODE_PREFIX="$(node -p 'require("node:path").resolve(process.execPath, "../..")')"
NODE_INCLUDE_DIR="${NODE_INCLUDE_DIR:-$NODE_PREFIX/include/node}"
test -f "$NODE_INCLUDE_DIR/node_api.h" || {
  echo "Node-API headers not found at $NODE_INCLUDE_DIR" >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
"${CXX:-c++}" \
  -std=c++17 \
  -O2 \
  -fPIC \
  -fvisibility=hidden \
  -shared \
  -DNAPI_VERSION=8 \
  -DNODE_GYP_MODULE_NAME=matrix_fs \
  -I "$NODE_INCLUDE_DIR" \
  "$ROOT_DIR/packages/gateway/native/linux-x64-glibc/addon.cc" \
  "$ROOT_DIR/packages/gateway/native/linux-x64-glibc/copy-staging.cc" \
  "$ROOT_DIR/packages/gateway/native/linux-x64-glibc/copy-test-hooks.cc" \
  "$ROOT_DIR/packages/gateway/native/linux-x64-glibc/fs-ops.cc" \
  -o "$OUTPUT_DIR/matrix-fs.node"

node -e 'const addon = require(process.argv[1]); if (typeof addon.create !== "function" || typeof addon.copy !== "function" || typeof addon.move !== "function") process.exit(1)' "$OUTPUT_DIR/matrix-fs.node"
echo "$OUTPUT_DIR/matrix-fs.node"

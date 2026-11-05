#!/usr/bin/env bash
# Flatten only the canonical Docker-dev aliases inside a newly copied bundle
# staging tree. Native checkout outputs are already ordinary directories.
set -euo pipefail
packages="${1:?staged packages directory required}"
for name in brand observability terminal-runtime kernel; do
  pkg="$packages/$name"
  peer="$packages/.matrix-publish-$name"
  if [[ -L "$pkg" || -L "$peer" || -L "$peer/dist" ]]; then
    echo 'Unsafe staged package path' >&2; exit 1
  fi
  if [[ -L "$pkg/dist" ]]; then
    if [[ "$(readlink "$pkg/dist")" != "../.matrix-publish-$name/dist" || ! -d "$peer/dist" ]]; then
      echo 'Invalid staged build output link' >&2; exit 1
    fi
    rm "$pkg/dist"
    mv "$peer/dist" "$pkg/dist"
  fi
  rm -rf "$peer"
done
rm -f "$packages/kernel/matrix-kernel-published.tsbuildinfo"

#!/usr/bin/env bash
set -euo pipefail

SOURCE_HOME="${1:?source home directory is required}"
DEST_HOME="${2:?destination home directory is required}"
test -d "$SOURCE_HOME"
mkdir -p "$DEST_HOME"

# Home dependency stores are build inputs, removed from every runtime bundle.
# Prune them before copying: unreadable or transient build-only links must not
# abort a valid release. Default find traversal and tar both preserve symlinks.
# NUL-delimited, non-recursive archive entries retain all other files and dirs.
(
  cd "$SOURCE_HOME"
  find . -type d -name node_modules -prune -o -print0 |
    tar --no-recursion --null -cf - -T -
) | tar -xpf - -C "$DEST_HOME"

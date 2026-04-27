#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

printf '%-28s %-28s %-14s %-24s %-24s %-20s\n' \
  "CONTAINER" "IMAGE" "BUILD_SHA" "BUILD_REF" "BUILD_DATE" "IMAGE_ID"

docker ps --filter 'name=matrixos-' --format '{{.Names}}' | sort | while IFS= read -r name; do
  [ -n "$name" ] || continue
  inspect="$(docker inspect "$name")"
  image_ref="$(printf '%s' "$inspect" | jq -r '.[0].Config.Image // "unknown"')"
  image_id="$(printf '%s' "$inspect" | jq -r '.[0].Image // "unknown"' | cut -c1-20)"
  env_json="$(printf '%s' "$inspect" | jq -r '.[0].Config.Env // []')"
  sha="$(printf '%s' "$env_json" | jq -r 'map(select(startswith("MATRIX_BUILD_SHA=")))[0] // "MATRIX_BUILD_SHA=unknown"' | cut -d= -f2-)"
  ref="$(printf '%s' "$env_json" | jq -r 'map(select(startswith("MATRIX_BUILD_REF=")))[0] // "MATRIX_BUILD_REF=unknown"' | cut -d= -f2-)"
  date="$(printf '%s' "$env_json" | jq -r 'map(select(startswith("MATRIX_BUILD_DATE=")))[0] // "MATRIX_BUILD_DATE=unknown"' | cut -d= -f2-)"

  printf '%-28s %-28s %-14s %-24s %-24s %-20s\n' \
    "$name" "$image_ref" "$sha" "$ref" "$date" "$image_id"
done

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY before building the user image}"

sha="$(git rev-parse --short=12 HEAD)"
ref="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git describe --tags --always)"
version="${MATRIX_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || printf '%s' "$sha")}"
build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tag="${MATRIX_IMAGE_TAG:-matrixos-user:$version}"

docker build \
  --build-arg "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" \
  --build-arg "VERSION=$version" \
  --build-arg "MATRIX_BUILD_SHA=$sha" \
  --build-arg "MATRIX_BUILD_REF=$ref" \
  --build-arg "MATRIX_BUILD_DATE=$build_date" \
  -t "$tag" \
  -f Dockerfile .

if [ "${MATRIX_TAG_LOCAL:-1}" != "0" ]; then
  docker tag "$tag" matrixos-user:local
fi

echo "Built $tag"
echo "  ref:  $ref"
echo "  sha:  $sha"
echo "  date: $build_date"
if [ "${MATRIX_TAG_LOCAL:-1}" != "0" ]; then
  echo "  also tagged: matrixos-user:local"
fi

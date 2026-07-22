#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: build-zellij.sh OUTPUT_DIRECTORY" >&2
  exit 2
fi

output_dir="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
candidate_record="$script_dir/zellij-v0.44.3-matrix.1.build.json"
if ! jq -e '
  (keys | sort) == (["binarySha256", "buildId", "builder", "patchSha256", "pathRemap",
    "rustVersion", "sourceDateEpoch", "sourceSha256", "sourceVersion", "target", "workRoot"] | sort) and
  (.buildId == "v0.44.3-matrix.1") and
  (.sourceVersion == "0.44.3") and
  (.sourceSha256 | test("^[0-9a-f]{64}$")) and
  (.patchSha256 | test("^[0-9a-f]{64}$")) and
  (.rustVersion == "1.92.0") and
  (.target == "x86_64-unknown-linux-musl") and
  (.sourceDateEpoch == 1735689600) and
  (.pathRemap == "/usr/src/matrix-zellij") and
  (.builder == "github-actions-ubuntu-24.04") and
  (.workRoot == "/tmp/matrix-zellij-build-v0.44.3-matrix.1") and
  (.binarySha256 | test("^[0-9a-f]{64}$"))
' "$candidate_record" >/dev/null; then
  echo "zellij_candidate_record_invalid" >&2
  exit 3
fi
ZELLIJ_SOURCE_VERSION="$(jq -er .sourceVersion "$candidate_record")"
ZELLIJ_BUILD_ID="$(jq -er .buildId "$candidate_record")"
ZELLIJ_SOURCE_SHA256="$(jq -er .sourceSha256 "$candidate_record")"
ZELLIJ_PATCH_SHA256="$(jq -er .patchSha256 "$candidate_record")"
ZELLIJ_RUST_VERSION="$(jq -er .rustVersion "$candidate_record")"
ZELLIJ_TARGET="$(jq -er .target "$candidate_record")"
ZELLIJ_SOURCE_DATE_EPOCH="$(jq -er .sourceDateEpoch "$candidate_record")"
ZELLIJ_PATH_REMAP="$(jq -er .pathRemap "$candidate_record")"
ZELLIJ_WORK_ROOT="$(jq -er .workRoot "$candidate_record")"
ZELLIJ_BINARY_SHA256="$(jq -er .binarySha256 "$candidate_record")"
patch_path="$script_dir/zellij-${ZELLIJ_BUILD_ID}.patch"
source_url="https://github.com/zellij-org/zellij/archive/refs/tags/v${ZELLIJ_SOURCE_VERSION}.tar.gz"
work_dir="$ZELLIJ_WORK_ROOT"
if ! mkdir -m 0700 -- "$work_dir"; then
  echo "zellij_build_root_unavailable" >&2
  exit 3
fi
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

if [ "$(sha256sum "$patch_path" | awk '{print $1}')" != "$ZELLIJ_PATCH_SHA256" ]; then
  echo "zellij_patch_digest_mismatch" >&2
  exit 3
fi
if [ "$(rustc --version | awk '{print $2}')" != "$ZELLIJ_RUST_VERSION" ]; then
  echo "zellij_rust_version_mismatch" >&2
  exit 4
fi

archive="$work_dir/zellij-v${ZELLIJ_SOURCE_VERSION}.tar.gz"
source_dir="$work_dir/source"
curl --fail --location --max-time 180 "$source_url" --output "$archive"
printf '%s  %s\n' "$ZELLIJ_SOURCE_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$source_dir"
tar -xzf "$archive" --strip-components=1 -C "$source_dir"
patch --batch --forward --strip=1 --directory="$source_dir" <"$patch_path"

export CARGO_HOME="$work_dir/cargo-home"
export CARGO_TARGET_DIR="$work_dir/target"
export CARGO_INCREMENTAL=0
export SOURCE_DATE_EPOCH="$ZELLIJ_SOURCE_DATE_EPOCH"
export TZ=UTC
export LC_ALL=C.UTF-8
export RUSTFLAGS="--remap-path-prefix=$work_dir=$ZELLIJ_PATH_REMAP"
(
  cd "$source_dir"
  cargo test -p zellij-server --locked --features zellij-utils/vendored_curl \
    --target "$ZELLIJ_TARGET" \
    held_resurrected_pane_preserves_viewport_and_history_across_reflow
  cargo test -p zellij-server --locked --features zellij-utils/vendored_curl \
    --target "$ZELLIJ_TARGET" \
    serialized_pane_content_is_bounded_including_the_viewport
  cargo test -p zellij-utils --locked --features vendored_curl \
    --target "$ZELLIJ_TARGET" \
    command_panes_serialize_initial_contents_for_gated_resurrection
  cargo build --release --locked --target "$ZELLIJ_TARGET" --bin zellij
)

built_binary="$CARGO_TARGET_DIR/$ZELLIJ_TARGET/release/zellij"
binary_sha256="$(sha256sum "$built_binary" | awk '{print $1}')"
if [ "$binary_sha256" != "$ZELLIJ_BINARY_SHA256" ]; then
  echo "zellij_binary_digest_mismatch expected=$ZELLIJ_BINARY_SHA256 actual=$binary_sha256" >&2
  exit 5
fi
mkdir -p "$output_dir"
install -m 0755 "$built_binary" "$output_dir/zellij"
printf '%s\n' "$ZELLIJ_BUILD_ID" >"$output_dir/build-id"
printf '%s\n' "$ZELLIJ_BINARY_SHA256" >"$output_dir/zellij.sha256"
cp -- "$candidate_record" "$output_dir/build.json"

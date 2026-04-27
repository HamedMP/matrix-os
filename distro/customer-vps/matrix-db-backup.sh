#!/usr/bin/env bash
set -euo pipefail

if [ -f /opt/matrix/env/postgres.env ]; then
  # shellcheck disable=SC1091
  source /opt/matrix/env/postgres.env
fi

snapshot_dir="/var/lib/matrix/db/snapshots"
mkdir -p "$snapshot_dir"

ts="$(date -u +%Y-%m-%dT%H%MZ)"
snapshot_name="${ts}.dump"
snapshot_path="${snapshot_dir}/${snapshot_name}"
snapshot_key="system/db/snapshots/${snapshot_name}"

export PGPASSWORD="${POSTGRES_PASSWORD:?postgres password missing}"

if ! timeout 300 pg_dump \
  --host=127.0.0.1 \
  --username="${POSTGRES_USER:-matrix}" \
  --dbname="${POSTGRES_DB:-matrix}" \
  --format=custom \
  --file="$snapshot_path"; then
  rm -f "$snapshot_path"
  echo "matrix-db-backup: dump failed" >&2
  exit 1
fi

if [ ! -s "$snapshot_path" ]; then
  rm -f "$snapshot_path"
  echo "matrix-db-backup: empty snapshot" >&2
  exit 1
fi

matrixctl r2 put "$snapshot_path" "$snapshot_key"
matrixctl r2 put-latest "$snapshot_key"

find "$snapshot_dir" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' \
  | sort -rn \
  | awk 'NR>24 {print $2}' \
  | xargs -r rm -f

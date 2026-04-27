#!/usr/bin/env bash
set -euo pipefail

if [ -f /opt/matrix/env/postgres.env ]; then
  # shellcheck disable=SC1091
  source /opt/matrix/env/postgres.env
fi

restore_flag="/opt/matrix/restore-complete"
latest_file="/var/lib/matrix/db/latest"
snapshot_path="/var/lib/matrix/db/latest.sql.gz"

mkdir -p /home/matrix/home /home/matrix/projects /var/lib/matrix/db
rm -f "$restore_flag"

if ! matrixctl r2 exists system/vps-meta.json; then
  touch "$restore_flag"
  exit 0
fi

if ! matrixctl r2 exists system/db/latest; then
  touch "$restore_flag"
  exit 0
fi

if ! matrixctl r2 get system/db/latest "$latest_file"; then
  echo "matrix-restore: failed to fetch latest pointer" >&2
  exit 1
fi

latest_key="$(tr -d '\r\n' < "$latest_file")"
case "$latest_key" in
  system/db/snapshots/*.sql.gz) ;;
  *)
    echo "matrix-restore: invalid latest pointer" >&2
    exit 1
    ;;
esac

if ! matrixctl r2 get "$latest_key" "$snapshot_path"; then
  echo "matrix-restore: failed to fetch snapshot" >&2
  exit 1
fi

if [ ! -s "$snapshot_path" ]; then
  echo "matrix-restore: empty snapshot" >&2
  exit 1
fi

export PGPASSWORD="${POSTGRES_PASSWORD:?postgres password missing}"

docker compose -f /opt/matrix/postgres-compose.yml up -d postgres

if ! gzip -dc "$snapshot_path" | timeout 300 pg_restore \
  --host=127.0.0.1 \
  --username="${POSTGRES_USER:-matrix}" \
  --dbname="${POSTGRES_DB:-matrix}" \
  --clean \
  --if-exists; then
  echo "matrix-restore: database restore failed" >&2
  exit 1
fi

touch "$restore_flag"

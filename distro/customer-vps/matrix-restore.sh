#!/usr/bin/env bash
set -euo pipefail

if [ -f /opt/matrix/env/postgres.env ]; then
  # shellcheck disable=SC1091
  source /opt/matrix/env/postgres.env
fi

restore_flag="/opt/matrix/restore-complete"
latest_file="/var/lib/matrix/db/latest"
snapshot_path="/var/lib/matrix/db/latest.dump"

mkdir -p /home/matrix/home /home/matrix/projects /var/lib/matrix/db
rm -f "$restore_flag"

if ! /opt/matrix/bin/matrixctl r2 exists system/vps-meta.json; then
  touch "$restore_flag"
  exit 0
fi

if ! /opt/matrix/bin/matrixctl r2 exists system/db/latest; then
  touch "$restore_flag"
  exit 0
fi

if ! /opt/matrix/bin/matrixctl r2 get system/db/latest "$latest_file"; then
  echo "matrix-restore: failed to fetch latest pointer" >&2
  exit 1
fi

latest_key="$(tr -d '\r\n' < "$latest_file")"
case "$latest_key" in
  system/db/snapshots/*.dump) ;;
  *)
    echo "matrix-restore: invalid latest pointer" >&2
    exit 1
    ;;
esac

if ! /opt/matrix/bin/matrixctl r2 get "$latest_key" "$snapshot_path"; then
  echo "matrix-restore: failed to fetch snapshot" >&2
  exit 1
fi

if [ ! -s "$snapshot_path" ]; then
  echo "matrix-restore: empty snapshot" >&2
  exit 1
fi

export PGPASSWORD="${POSTGRES_PASSWORD:?postgres password missing}"

if docker ps --format '{{.Names}}' | grep -qx matrix-postgres; then
  :
elif docker ps -a --format '{{.Names}}' | grep -qx matrix-postgres; then
  docker start matrix-postgres >/dev/null
else
  docker volume create matrix-postgres >/dev/null
  docker run -d \
    --name matrix-postgres \
    --restart unless-stopped \
    --env-file /opt/matrix/env/postgres.env \
    -v matrix-postgres:/var/lib/postgresql/data \
    -p 127.0.0.1:5432:5432 \
    postgres:16 >/dev/null
fi

echo "matrix-restore: waiting for postgres..."
for _ in $(seq 1 30); do
  if pg_isready --host=127.0.0.1 --username="${POSTGRES_USER:-matrix}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! pg_isready --host=127.0.0.1 --username="${POSTGRES_USER:-matrix}" >/dev/null 2>&1; then
  echo "matrix-restore: postgres did not become ready" >&2
  exit 1
fi

if ! timeout 300 pg_restore \
  --host=127.0.0.1 \
  --username="${POSTGRES_USER:-matrix}" \
  --dbname="${POSTGRES_DB:-matrix}" \
  --clean \
  --if-exists \
  "$snapshot_path"; then
  echo "matrix-restore: database restore failed" >&2
  exit 1
fi

touch "$restore_flag"

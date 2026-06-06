#!/usr/bin/env bash
set -euo pipefail

if [ -f /opt/matrix/env/postgres.env ]; then
  # shellcheck disable=SC1091
  source /opt/matrix/env/postgres.env
fi

restore_flag="/opt/matrix/restore-complete"
latest_file="/var/lib/matrix/db/latest"
snapshot_path="/var/lib/matrix/db/latest.dump"
runtime_slot="${MATRIX_RUNTIME_SLOT:-primary}"
case "$runtime_slot" in
  ""|[!a-z0-9]*|*[^a-z0-9-]*|*-) echo "matrix-restore: invalid runtime slot" >&2; exit 1 ;;
esac
if [ "$runtime_slot" = "primary" ]; then
  latest_pointer_key="system/db/latest"
  snapshot_key_pattern="system/db/snapshots/*.dump"
else
  latest_pointer_key="system/runtime-slots/${runtime_slot}/db/latest"
  snapshot_key_pattern="system/runtime-slots/${runtime_slot}/db/snapshots/*.dump"
fi

mkdir -p /home/matrix/home /home/matrix/projects /var/lib/matrix/db
rm -f "$restore_flag"

check_r2_exists_or_skip_restore() {
  local key="$1"
  local label="$2"
  if /opt/matrix/bin/matrixctl r2 exists "$key"; then
    return 0
  fi
  local status="$?"
  if [ "$status" -eq 1 ]; then
    touch "$restore_flag"
    exit 0
  fi
  echo "matrix-restore: failed to check ${label}" >&2
  exit 1
}

check_r2_exists_or_skip_restore system/vps-meta.json "VPS metadata"
check_r2_exists_or_skip_restore "$latest_pointer_key" "latest snapshot pointer"

if ! /opt/matrix/bin/matrixctl r2 get "$latest_pointer_key" "$latest_file"; then
  echo "matrix-restore: failed to fetch latest pointer" >&2
  exit 1
fi

snapshot_key="$(tr -d '\r\n' < "$latest_file")"
case "$snapshot_key" in
  $snapshot_key_pattern) ;;
  *)
    echo "matrix-restore: invalid latest pointer" >&2
    exit 1
    ;;
esac

if ! /opt/matrix/bin/matrixctl r2 get "$snapshot_key" "$snapshot_path"; then
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

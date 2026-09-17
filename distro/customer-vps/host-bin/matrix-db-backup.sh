#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

postgres_env_file="${MATRIX_POSTGRES_ENV_FILE:-/opt/matrix/env/postgres.env}"
if [ -f "$postgres_env_file" ]; then
  # shellcheck disable=SC1091
  source "$postgres_env_file"
fi

snapshot_dir="${MATRIX_DB_SNAPSHOT_DIR:-/var/lib/matrix/db/snapshots}"
status_dir="${MATRIX_DB_BACKUP_STATUS_DIR:-/var/lib/matrix/db/backup-status}"
lock_file="${MATRIX_DB_BACKUP_LOCK_FILE:-/var/lib/matrix/db/backup.lock}"
matrixctl_bin="${MATRIXCTL_BIN:-/opt/matrix/bin/matrixctl}"
pg_dump_bin="${PG_DUMP_BIN:-pg_dump}"
mkdir -p "$snapshot_dir" "$status_dir" "$(dirname "$lock_file")"

exec 9>"$lock_file"
if ! flock -n 9; then
  echo "matrix-db-backup: another backup is active" >&2
  exit 0
fi

runtime_slot="${MATRIX_RUNTIME_SLOT:-primary}"
case "$runtime_slot" in
  ""|[!a-z0-9]*|*[^a-z0-9-]*|*-) echo "matrix-db-backup: invalid runtime slot" >&2; exit 1 ;;
esac

attempted_at="$(( $(date +%s) * 1000 ))"
failure_code="unexpected_failure"

atomic_json() {
  local target="$1"
  local value="$2"
  local temp="${target}.tmp.$$"
  printf '%s\n' "$value" > "$temp"
  chmod 0600 "$temp"
  mv -Tf -- "$temp" "$target"
}

write_attempt() {
  local outcome="$1"
  local error_code="$2"
  atomic_json "$status_dir/last-attempt.json" \
    "{\"attemptedAt\":${attempted_at},\"outcome\":\"${outcome}\",\"errorCode\":${error_code}}"
}

on_error() {
  local status="$?"
  trap - ERR
  write_attempt "failed" "\"${failure_code}\"" || true
  exit "$status"
}
trap on_error ERR
write_attempt "running" "null"

minimum_free_kb="${MATRIX_DB_BACKUP_MIN_FREE_KB:-524288}"
case "$minimum_free_kb" in
  ""|*[!0-9]*) failure_code="disk_check_failed"; false ;;
esac
available_kb="$(df -Pk "$snapshot_dir" | awk 'NR==2 {print $4}')"
case "$available_kb" in
  ""|*[!0-9]*) failure_code="disk_check_failed"; false ;;
esac
if [ "$available_kb" -lt "$minimum_free_kb" ]; then
  failure_code="disk_space_low"
  false
fi

ts="$(date -u +%Y-%m-%dT%H%M%SZ)"
snapshot_name="${ts}.dump"
snapshot_path="${snapshot_dir}/${snapshot_name}"
receipt_name="${ts}.json"
receipt_path="${status_dir}/${receipt_name}"
if [ "$runtime_slot" = "primary" ]; then
  snapshot_key="system/db/snapshots/${snapshot_name}"
  receipt_key="system/db/receipts/${receipt_name}"
  latest_key="system/db/latest"
else
  snapshot_key="system/runtime-slots/${runtime_slot}/db/snapshots/${snapshot_name}"
  receipt_key="system/runtime-slots/${runtime_slot}/db/receipts/${receipt_name}"
  latest_key="system/runtime-slots/${runtime_slot}/db/latest"
fi

export PGPASSWORD="${POSTGRES_PASSWORD:?postgres password missing}"

failure_code="dump_failed"
if ! timeout --kill-after=10 300 "$pg_dump_bin" \
  --host=127.0.0.1 \
  --username="${POSTGRES_USER:-matrix}" \
  --dbname="${POSTGRES_DB:-matrix}" \
  --format=custom \
  --file="$snapshot_path"; then
  rm -f "$snapshot_path"
  echo "matrix-db-backup: dump failed" >&2
  false
fi

if [ ! -s "$snapshot_path" ]; then
  rm -f "$snapshot_path"
  echo "matrix-db-backup: empty snapshot" >&2
  false
fi

snapshot_hash="$(sha256sum "$snapshot_path" | awk '{print $1}')"
snapshot_size="$(stat -c %s "$snapshot_path")"
completed_at="$(( $(date +%s) * 1000 ))"
atomic_json "$receipt_path" \
  "{\"snapshotKey\":\"${snapshot_key}\",\"receiptKey\":\"${receipt_key}\",\"sha256\":\"${snapshot_hash}\",\"size\":${snapshot_size},\"runtimeSlot\":\"${runtime_slot}\",\"completedAt\":${completed_at},\"restoreVerifiedAt\":null}"

failure_code="storage_upload_failed"
timeout --kill-after=10 330 "$matrixctl_bin" r2 put "$snapshot_path" "$snapshot_key"
failure_code="storage_snapshot_verify_failed"
timeout --kill-after=10 30 "$matrixctl_bin" r2 exists "$snapshot_key"
failure_code="storage_receipt_upload_failed"
timeout --kill-after=10 330 "$matrixctl_bin" r2 put "$receipt_path" "$receipt_key"
failure_code="storage_receipt_verify_failed"
timeout --kill-after=10 30 "$matrixctl_bin" r2 exists "$receipt_key"
failure_code="storage_pointer_update_failed"
timeout --kill-after=10 30 "$matrixctl_bin" r2 put-latest "$snapshot_key"

latest_check="${status_dir}/.latest-check.$$"
trap 'rm -f "${latest_check:-}"' EXIT
failure_code="storage_pointer_verify_failed"
timeout --kill-after=10 30 "$matrixctl_bin" r2 get "$latest_key" "$latest_check"
if [ "$(tr -d '\r\n' < "$latest_check")" != "$snapshot_key" ]; then
  false
fi
rm -f "$latest_check"
trap - EXIT

atomic_json "$status_dir/last-success.json" "$(cat "$receipt_path")"
write_attempt "success" "null"
trap - ERR

find "$snapshot_dir" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' \
  | sort -rn \
  | awk 'NR>24 {print $2}' \
  | xargs -r rm -f

find "$status_dir" -maxdepth 1 -type f -name '????-??-??T??????Z.json' -printf '%T@ %p\n' \
  | sort -rn \
  | awk 'NR>24 {print $2}' \
  | xargs -r rm -f

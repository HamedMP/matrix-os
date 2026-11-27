#!/usr/bin/env bash
# Nightly backup of the shared messaging bridge host (spec 2701, ENG-535).
#
# Writes one directory per run under MBH_BACKUP_ROOT:
#   <UTC stamp>/<database>.dump   pg_dump custom format, one per database
#   <UTC stamp>/state.tar.gz      secrets, rendered configs, bridge dirs and
#                                 TLS state; excludes live Postgres files and
#                                 the 7-day Synapse media relay buffer
# and deletes backup directories older than MBH_BACKUP_RETENTION_DAYS.
#
# Symlink safety: the root and lock file must not be symlinks, tar never
# follows symlinks, and rotation only removes real directories whose names
# look like backup stamps.
#
# Environment:
#   MBH_STATE_DIR              default /var/lib/matrix-bridge-host
#   MBH_BUNDLE_DIR             default: the directory holding this script
#   MBH_BACKUP_ROOT            default /var/backups/matrix-bridge-host
#   MBH_BACKUP_RETENTION_DAYS  default 7
#   MBH_BACKUP_DATABASES       default "synapse whatsapp telegram linkedin"
#
# Backups contain every bridge-host secret. Copy them off the host only to
# encrypted storage (see README.md, "Backups").

set -eu
set -o pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="${MBH_BUNDLE_DIR:-$SCRIPT_DIR}"
STATE_DIR="${MBH_STATE_DIR:-/var/lib/matrix-bridge-host}"
BACKUP_ROOT="${MBH_BACKUP_ROOT:-/var/backups/matrix-bridge-host}"
RETENTION_DAYS="${MBH_BACKUP_RETENTION_DAYS:-7}"
DATABASES="${MBH_BACKUP_DATABASES-synapse whatsapp telegram linkedin}"

die() {
  printf 'backup: error: %s\n' "$*" >&2
  exit 1
}

compose() {
  set -- -f "$BUNDLE_DIR/docker-compose.yml" "$@"
  if [ -f "$STATE_DIR/compose.env" ]; then
    set -- --env-file "$STATE_DIR/compose.env" "$@"
  fi
  docker compose --project-directory "$BUNDLE_DIR" "$@"
}

[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,2}$ ]] || die "MBH_BACKUP_RETENTION_DAYS must be a positive integer"
case "$BACKUP_ROOT" in
  /*) ;;
  *) die "MBH_BACKUP_ROOT must be an absolute path" ;;
esac
[ -L "$BACKUP_ROOT" ] && die "refusing symlinked backup root: $BACKUP_ROOT"
[ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || die "state directory missing or symlinked: $STATE_DIR"
for db in $DATABASES; do
  [[ "$db" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "invalid database name in MBH_BACKUP_DATABASES"
done

mkdir -p "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
[ -L "$BACKUP_ROOT/.lock" ] && die "refusing symlinked lock file"
exec 9> "$BACKUP_ROOT/.lock"
flock -n 9 || die "another backup is already running"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
[ -e "$DEST" ] && die "backup $STAMP already exists"
WORK="$(mktemp -d "$BACKUP_ROOT/.partial.XXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT

dumped=""
for db in $DATABASES; do
  compose exec -T postgres pg_dump -U postgres --format=custom "$db" > "$WORK/$db.dump"
  dumped="$dumped${dumped:+,}\"$db\""
done

tar -C "$STATE_DIR" \
  --exclude=./postgres/data \
  --exclude=./synapse/media_store \
  -czf "$WORK/state.tar.gz" .

find "$WORK" -type f -exec chmod 0600 {} +
chmod 0700 "$WORK"
mv -- "$WORK" "$DEST"
trap - EXIT

# Rotation: real directories only (find -type d never matches a symlink),
# named like a stamp, older than the retention window.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z' \
  -mtime +"$((RETENTION_DAYS - 1))" -print0 \
  | while IFS= read -r -d '' old; do
    rm -rf -- "$old"
  done
# Leftovers from interrupted runs.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.partial.*' -mtime +0 -print0 \
  | while IFS= read -r -d '' old; do
    rm -rf -- "$old"
  done

printf '{"backup":"ok","path":"%s","databases":[%s]}\n' "$DEST" "$dumped"

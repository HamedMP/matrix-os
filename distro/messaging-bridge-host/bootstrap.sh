#!/usr/bin/env bash
# Bootstrap the shared messaging bridge host (spec 2701, ENG-535).
#
# Idempotent. Generates every secret once (exclusive create, never
# overwritten), renders the Synapse, bridge, appservice and Caddy configs
# into the state directory, creates the databases and the platform admin
# account, starts the stack, and writes the platform env block to a
# root-only file. Secrets never appear in argv, stdout or stderr.
#
# Inputs (environment). Required on the first run; later runs reuse the
# values saved in the state directory.
#   MBH_PUBLIC_HOSTNAME     DNS name that serves HTTPS, e.g. bridge.matrix-os.com
#   MBH_SERVER_NAME         Matrix server name (default: MBH_PUBLIC_HOSTNAME)
#   MBH_ACME_EMAIL          Let's Encrypt account email
#   MBH_TELEGRAM_API_ID     from https://my.telegram.org/apps
#   MBH_TELEGRAM_API_HASH   from https://my.telegram.org/apps
# Optional:
#   MBH_STATE_DIR           default /var/lib/matrix-bridge-host
#   MBH_BUNDLE_DIR          default: the directory holding this script
#   MBH_RENDER_ONLY=1       render secrets and configs only; no Docker, no root

set -eu
set -o pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="${MBH_BUNDLE_DIR:-$SCRIPT_DIR}"
STATE_DIR="${MBH_STATE_DIR:-/var/lib/matrix-bridge-host}"
RENDER_ONLY="${MBH_RENDER_ONLY:-0}"
SECRETS_DIR="$STATE_DIR/secrets"

NETWORKS="whatsapp telegram linkedin"
DATABASES="synapse whatsapp telegram linkedin"
# Owner Matrix IDs are @mxo_<keyed-hash>:<server>; the platform derives them.
OWNER_LOCALPART_REGEX='mxo_[a-z0-9]+'
ADMIN_LOCALPART="mxadmin"
SYNAPSE_UID=991
BRIDGE_UID=1337
POSTGRES_UID=70

CHANGED=""

die() {
  printf 'bootstrap: error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'bootstrap: %s\n' "$*"
}

is_root() {
  [ "$(id -u)" = "0" ]
}

bridge_port() {
  case "$1" in
    whatsapp) printf '29318' ;;
    telegram) printf '29317' ;;
    linkedin) printf '29341' ;;
    *) die "unknown network: $1" ;;
  esac
}

bridge_label() {
  case "$1" in
    whatsapp) printf 'WhatsApp' ;;
    telegram) printf 'Telegram' ;;
    linkedin) printf 'LinkedIn' ;;
    *) die "unknown network: $1" ;;
  esac
}

upper() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]'
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

saved_value() {
  # saved_value KEY -> value from host.env, without sourcing the file.
  local file="$STATE_DIR/host.env" line
  [ -f "$file" ] && [ ! -L "$file" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      "$1="*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done < "$file"
}

saved_secret() {
  local path="$SECRETS_DIR/$1" value=""
  if [ -f "$path" ] && [ ! -L "$path" ]; then
    IFS= read -r value < "$path" || true
  fi
  printf '%s' "$value"
}

HOSTNAME_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'

resolve_inputs() {
  PUBLIC_HOSTNAME="${MBH_PUBLIC_HOSTNAME:-$(saved_value MBH_PUBLIC_HOSTNAME)}"
  [ -n "$PUBLIC_HOSTNAME" ] || die "MBH_PUBLIC_HOSTNAME is required on the first run"
  SERVER_NAME="${MBH_SERVER_NAME:-$(saved_value MBH_SERVER_NAME)}"
  SERVER_NAME="${SERVER_NAME:-$PUBLIC_HOSTNAME}"
  ACME_EMAIL="${MBH_ACME_EMAIL:-$(saved_value MBH_ACME_EMAIL)}"
  [ -n "$ACME_EMAIL" ] || die "MBH_ACME_EMAIL is required on the first run"
  TELEGRAM_API_ID="${MBH_TELEGRAM_API_ID:-$(saved_secret telegram-api-id)}"
  [ -n "$TELEGRAM_API_ID" ] || die "MBH_TELEGRAM_API_ID is required on the first run"
  TELEGRAM_API_HASH="${MBH_TELEGRAM_API_HASH:-$(saved_secret telegram-api-hash)}"
  [ -n "$TELEGRAM_API_HASH" ] || die "MBH_TELEGRAM_API_HASH is required on the first run"

  [ "${#PUBLIC_HOSTNAME}" -le 253 ] && [[ "$PUBLIC_HOSTNAME" =~ $HOSTNAME_RE ]] \
    || die "MBH_PUBLIC_HOSTNAME must be a lowercase DNS name"
  [ "${#SERVER_NAME}" -le 253 ] && [[ "$SERVER_NAME" =~ $HOSTNAME_RE ]] \
    || die "MBH_SERVER_NAME must be a lowercase DNS name"
  [[ "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] \
    || die "MBH_ACME_EMAIL must be an email address"
  [[ "$TELEGRAM_API_ID" =~ ^[0-9]{1,12}$ ]] || die "MBH_TELEGRAM_API_ID must be numeric"
  [[ "$TELEGRAM_API_HASH" =~ ^[0-9a-f]{32}$ ]] || die "MBH_TELEGRAM_API_HASH must be 32 lowercase hex characters"
  case "$STATE_DIR" in
    /*) ;;
    *) die "MBH_STATE_DIR must be an absolute path" ;;
  esac
}

# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------

ensure_dir() {
  # ensure_dir PATH [UID]
  [ -L "$1" ] && die "refusing symlinked directory: $1"
  mkdir -p "$1"
  chmod 0700 "$1"
  if [ -n "${2:-}" ] && is_root; then
    chown "$2:$2" "$1"
  fi
}

write_secret_once() {
  # write_secret_once NAME < value. Exclusive create: an existing secret wins.
  local path="$SECRETS_DIR/$1" tmp
  [ -L "$path" ] && die "refusing symlinked secret: $1"
  if [ -e "$path" ]; then
    cat > /dev/null
    return 0
  fi
  tmp="$(mktemp "$SECRETS_DIR/.new.XXXXXX")"
  cat > "$tmp"
  chmod 0600 "$tmp"
  # link(2) fails if the target exists, so a concurrent run cannot clobber it.
  ln "$tmp" "$path" 2> /dev/null || true
  rm -f "$tmp"
}

generate_secret() {
  # generate_secret NAME [BYTES]
  if [ ! -e "$SECRETS_DIR/$1" ]; then
    openssl rand -hex "${2:-32}" | write_secret_once "$1"
  fi
}

secret() {
  local path="$SECRETS_DIR/$1" value
  [ -f "$path" ] && [ ! -L "$path" ] || die "missing secret: $1"
  IFS= read -r value < "$path" || true
  [ -n "$value" ] || die "empty secret: $1"
  printf '%s' "$value"
}

install_rendered() {
  # install_rendered TMP DEST SERVICE [UID]: replace DEST only when content changed.
  local tmp="$1" dest="$2" service="$3" owner="${4:-}"
  [ -L "$dest" ] && die "refusing symlinked config: $dest"
  chmod 0600 "$tmp"
  if [ -n "$owner" ] && is_root; then
    chown "$owner:$owner" "$tmp"
  fi
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    return 0
  fi
  mv -f "$tmp" "$dest"
  case " $CHANGED " in
    *" $service "*) ;;
    *) CHANGED="$CHANGED $service" ;;
  esac
}

render_to() {
  # render_to DEST SERVICE UID FUNCTION [ARGS...]
  local dest="$1" service="$2" owner="$3" tmp
  shift 3
  tmp="$(mktemp "$(dirname "$dest")/.render.XXXXXX")"
  "$@" > "$tmp"
  install_rendered "$tmp" "$dest" "$service" "$owner"
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

generate_secrets() {
  local name version seed
  generate_secret postgres-superuser-password
  for name in $DATABASES; do
    generate_secret "db-$name-password"
  done
  generate_secret synapse-registration-shared-secret
  generate_secret synapse-macaroon-secret-key
  generate_secret synapse-form-secret
  generate_secret admin-password
  generate_secret gate-secret
  # Platform-side key for deriving owner Matrix IDs. Generated here so the
  # env block is complete and the key is backed up with the host.
  generate_secret platform-user-id-key
  if [ ! -e "$SECRETS_DIR/synapse-signing-key" ]; then
    version="$(openssl rand -hex 3)"
    seed="$(openssl rand -base64 32 | tr -d '=\n')"
    printf 'ed25519 a_%s %s\n' "$version" "$seed" | write_secret_once synapse-signing-key
  fi
  for name in $NETWORKS doublepuppet; do
    generate_secret "$name-as-token"
    generate_secret "$name-hs-token"
    generate_secret "$name-sender-localpart" 16
  done
  for name in $NETWORKS; do
    generate_secret "$name-provisioning-secret"
    generate_secret "$name-pickle-key"
    generate_secret "$name-public-media-key"
  done
  printf '%s\n' "$TELEGRAM_API_ID" | write_secret_once telegram-api-id
  printf '%s\n' "$TELEGRAM_API_HASH" | write_secret_once telegram-api-hash
}

# Config templates live in lib/templates.sh.
# shellcheck source=lib/templates.sh
. "$SCRIPT_DIR/lib/templates.sh"

render_all() {
  local network
  ensure_dir "$STATE_DIR"
  ensure_dir "$SECRETS_DIR"
  generate_secrets

  render_to "$STATE_DIR/host.env" host "" render_host_env
  render_to "$STATE_DIR/compose.env" host "" render_compose_env

  ensure_dir "$STATE_DIR/postgres"
  ensure_dir "$STATE_DIR/postgres/data" "$POSTGRES_UID"
  render_to "$STATE_DIR/postgres/superuser-password" postgres "$POSTGRES_UID" render_postgres_password

  ensure_dir "$STATE_DIR/synapse" "$SYNAPSE_UID"
  ensure_dir "$STATE_DIR/synapse/appservices" "$SYNAPSE_UID"
  ensure_dir "$STATE_DIR/synapse/media_store" "$SYNAPSE_UID"
  render_to "$STATE_DIR/synapse/homeserver.yaml" synapse "$SYNAPSE_UID" render_homeserver
  render_to "$STATE_DIR/synapse/log.config" synapse "$SYNAPSE_UID" render_synapse_log_config
  render_to "$STATE_DIR/synapse/signing.key" synapse "$SYNAPSE_UID" render_signing_key
  render_to "$STATE_DIR/synapse/appservices/doublepuppet.yaml" synapse "$SYNAPSE_UID" render_doublepuppet_registration

  ensure_dir "$STATE_DIR/bridges"
  for network in $NETWORKS; do
    ensure_dir "$STATE_DIR/bridges/$network" "$BRIDGE_UID"
    render_to "$STATE_DIR/synapse/appservices/$network.yaml" synapse "$SYNAPSE_UID" render_registration "$network"
    render_to "$STATE_DIR/bridges/$network/registration.yaml" "mautrix-$network" "$BRIDGE_UID" render_registration "$network"
    render_to "$STATE_DIR/bridges/$network/config.yaml" "mautrix-$network" "$BRIDGE_UID" render_bridge_config "$network"
  done

  ensure_dir "$STATE_DIR/caddy"
  ensure_dir "$STATE_DIR/caddy/data"
  ensure_dir "$STATE_DIR/caddy/config"
  render_to "$STATE_DIR/caddy/Caddyfile" caddy "" render_caddyfile
}

# ---------------------------------------------------------------------------
# Runtime (skipped with MBH_RENDER_ONLY=1)
# ---------------------------------------------------------------------------

compose() {
  docker compose \
    --project-directory "$BUNDLE_DIR" \
    --env-file "$STATE_DIR/compose.env" \
    -f "$BUNDLE_DIR/docker-compose.yml" \
    "$@"
}

container_health() {
  local id
  id="$(compose ps -q "$1")"
  [ -n "$id" ] || { printf 'missing'; return 0; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

wait_healthy() {
  # wait_healthy SERVICE TIMEOUT_SECONDS
  local deadline=$((SECONDS + $2)) state
  while :; do
    state="$(container_health "$1")"
    case "$state" in
      healthy | running) return 0 ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || die "$1 did not become healthy (last state: $state); see: docker compose logs $1"
    sleep 3
  done
}

start_service() {
  # start_service SERVICE: create or update the container. A container that
  # was already running before this run is restarted when its rendered
  # config changed; a new container is never restarted mid-initialization.
  local before
  before="$(container_health "$1")"
  compose up -d "$1" > /dev/null
  case " $CHANGED " in
    *" $1 "*)
      if [ "$before" != "missing" ]; then
        log "configuration for $1 changed; restarting it"
        compose restart "$1" > /dev/null
      fi
      ;;
  esac
}

ensure_databases() {
  local name
  {
    printf '\\set ON_ERROR_STOP on\n'
    for name in $DATABASES; do
      printf "SELECT format('CREATE ROLE %%I LOGIN', '%s') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s')\\\\gexec\n" "$name" "$name"
      printf "ALTER ROLE %s WITH LOGIN PASSWORD '%s';\n" "$name" "$(secret "db-$name-password")"
      printf "SELECT format('CREATE DATABASE %%I OWNER %%I ENCODING %%L LC_COLLATE %%L LC_CTYPE %%L TEMPLATE template0', '%s', '%s', 'UTF8', 'C', 'C') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '%s')\\\\gexec\n" "$name" "$name" "$name"
      printf 'REVOKE ALL ON DATABASE %s FROM PUBLIC;\n' "$name"
      printf 'GRANT CONNECT, TEMPORARY ON DATABASE %s TO %s;\n' "$name" "$name"
    done
  } | compose exec -T postgres psql -q -U postgres -d postgres > /dev/null
}


ensure_admin() {
  local tmp
  [ -e "$SECRETS_DIR/admin-access-token" ] && return 0
  log "creating the platform admin account @$ADMIN_LOCALPART:$SERVER_NAME"
  tmp="$(mktemp "$SECRETS_DIR/.admin.XXXXXX")"
  printf '{"localpart":"%s","password":"%s","shared_secret":"%s"}' \
    "$ADMIN_LOCALPART" "$(secret admin-password)" "$(secret synapse-registration-shared-secret)" \
    | compose exec -T synapse python -c "$(cat "$SCRIPT_DIR/lib/create-admin.py")" > "$tmp" \
    || { rm -f "$tmp"; die "could not create the admin account"; }
  [ -s "$tmp" ] || { rm -f "$tmp"; die "admin account returned no token"; }
  write_secret_once admin-access-token < "$tmp"
  rm -f "$tmp"
}

start_stack() {
  local network
  command -v docker > /dev/null || die "docker is not installed"
  docker compose version > /dev/null 2>&1 || die "the docker compose plugin is not installed"

  log "starting postgres"
  start_service postgres
  wait_healthy postgres 120
  ensure_databases

  log "starting synapse"
  start_service synapse
  wait_healthy synapse 300
  ensure_admin

  log "starting bridges and proxy"
  for network in $NETWORKS; do
    start_service "mautrix-$network"
  done
  start_service caddy
  for network in $NETWORKS; do
    wait_healthy "mautrix-$network" 180
  done
  wait_healthy caddy 60
}

write_platform_env() {
  if [ ! -e "$SECRETS_DIR/admin-access-token" ]; then
    log "render-only run: platform env not written yet (no admin token)"
    return 0
  fi
  render_to "$STATE_DIR/platform.env" platform "" render_platform_env
  log "platform env block written to $STATE_DIR/platform.env (root-only); copy it into the platform secret store"
}

main() {
  resolve_inputs
  if [ "$RENDER_ONLY" != "1" ]; then
    is_root || die "run as root (or set MBH_RENDER_ONLY=1 to render configs only)"
  fi
  command -v openssl > /dev/null || die "openssl is required"

  render_all
  log "rendered configuration into $STATE_DIR"

  if [ "$RENDER_ONLY" != "1" ]; then
    start_stack
  fi
  write_platform_env
  log "done"
}

main "$@"

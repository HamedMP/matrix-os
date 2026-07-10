#!/usr/bin/env bash
set -Eeuo pipefail

# Matrix OS standalone server installer.
# Public copy is served from https://matrix-os.com/install-server.sh.

DEFAULT_CHANNEL="${MATRIX_CHANNEL:-dev}"
DEFAULT_BUNDLE_BASE="https://app.matrix-os.com/system-bundles/${DEFAULT_CHANNEL}"
MATRIX_HOST_BUNDLE_URL="${MATRIX_HOST_BUNDLE_URL:-${DEFAULT_BUNDLE_BASE}/matrix-host-bundle.tar.gz}"
MATRIX_INSTALL_HANDLE="${MATRIX_INSTALL_HANDLE:-matrix}"
MATRIX_DOMAIN="${MATRIX_DOMAIN:-_}"
MATRIX_HOME_DIR="${MATRIX_HOME:-/home/matrix/home}"
MATRIX_DEVELOPER_TOOLS="${MATRIX_DEVELOPER_TOOLS:-codex claude-code opencode pi}"
MATRIX_INSTALL_TELEMETRY_URL="${MATRIX_INSTALL_TELEMETRY_URL:-https://matrix-os.com/api/install-telemetry}"
MATRIX_INSTALL_TELEMETRY_ID="${MATRIX_INSTALL_TELEMETRY_ID:-}"
MATRIX_INSTALL_LOG="${MATRIX_INSTALL_LOG:-/tmp/matrix-server-install.log}"
INSTALL_TMP_BUNDLE=""
INSTALL_TMP_SUM=""
INSTALL_PHASE="init"
INSTALL_COMPLETED=0
INSTALL_FAILURE_CAPTURED=0

cleanup_install_tmp() {
  [ -z "$INSTALL_TMP_BUNDLE" ] || rm -f "$INSTALL_TMP_BUNDLE"
  [ -z "$INSTALL_TMP_SUM" ] || rm -f "$INSTALL_TMP_SUM"
}
trap cleanup_install_tmp EXIT
trap 'capture_install_failure $? $LINENO' ERR

if [ "${MATRIX_INSTALL_COLOR:-auto}" = "always" ] || { [ "${MATRIX_INSTALL_COLOR:-auto}" = "auto" ] && [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; }; then
  COLOR_RESET="$(printf '\033[0m')"
  COLOR_BOLD="$(printf '\033[1m')"
  COLOR_DIM="$(printf '\033[2m')"
  COLOR_BLUE="$(printf '\033[34m')"
  COLOR_GREEN="$(printf '\033[32m')"
  COLOR_YELLOW="$(printf '\033[33m')"
  COLOR_RED="$(printf '\033[31m')"
else
  COLOR_RESET=""
  COLOR_BOLD=""
  COLOR_DIM=""
  COLOR_BLUE=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_RED=""
fi

section() {
  printf '\n%s%s==> %s%s\n' "$COLOR_BLUE" "$COLOR_BOLD" "$*" "$COLOR_RESET"
}

banner() {
  cat <<EOF

${COLOR_BLUE}${COLOR_BOLD}███╗   ███╗ █████╗ ████████╗██████╗ ██╗██╗  ██╗     ██████╗ ███████╗
████╗ ████║██╔══██╗╚══██╔══╝██╔══██╗██║╚██╗██╔╝    ██╔═══██╗██╔════╝
██╔████╔██║███████║   ██║   ██████╔╝██║ ╚███╔╝     ██║   ██║███████╗
██║╚██╔╝██║██╔══██║   ██║   ██╔══██╗██║ ██╔██╗     ██║   ██║╚════██║
██║ ╚═╝ ██║██║  ██║   ██║   ██║  ██║██║██╔╝ ██╗    ╚██████╔╝███████║
╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝     ╚═════╝ ╚══════╝${COLOR_RESET}

        ${COLOR_BOLD}Matrix OS server installer${COLOR_RESET}
        ${COLOR_DIM}Browser shell + gateway + code-server + agents${COLOR_RESET}

EOF
}

log() {
  printf '%s    %s%s\n' "$COLOR_DIM" "$*" "$COLOR_RESET"
}

ok() {
  printf '%s%sOK%s  %s\n' "$COLOR_GREEN" "$COLOR_BOLD" "$COLOR_RESET" "$*"
}

warn() {
  printf '%s%sWARN%s  %s\n' "$COLOR_YELLOW" "$COLOR_BOLD" "$COLOR_RESET" "$*" >&2
}

run_required() {
  local description
  description="$1"
  shift
  "$@" >>"$MATRIX_INSTALL_LOG" 2>&1 || fail "${description} failed"
}

restart_required_service() {
  local unit
  unit="$1"
  run_required "starting ${unit}" systemctl restart "$unit"
  ok "${unit} started"
}

restart_optional_service() {
  local unit label
  unit="$1"
  label="$2"
  if systemctl restart "$unit" >>"$MATRIX_INSTALL_LOG" 2>&1; then
    ok "${unit} started"
  else
    warn "${label} failed; Matrix OS core is still installed. Details: journalctl -u ${unit} -n 100 --no-pager"
  fi
}

wait_http_ok() {
  local description url log_hint attempt code
  description="$1"
  url="$2"
  log_hint="$3"
  for attempt in $(seq 1 30); do
    code="$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 5 "$url" 2>>"$MATRIX_INSTALL_LOG" || true)"
    if [ "$code" = "200" ]; then
      ok "${description} is reachable"
      return 0
    fi
    if [ "$code" = "500" ]; then
      fail "${description} returned HTTP 500. ${log_hint}"
    fi
    sleep 2
  done
  fail "${description} did not become reachable. ${log_hint}"
}

wait_http_ok_auth() {
  local description url password log_hint attempt code
  description="$1"
  url="$2"
  password="$3"
  log_hint="$4"
  for attempt in $(seq 1 30); do
    code="$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 5 --user "matrix:${password}" "$url" 2>>"$MATRIX_INSTALL_LOG" || true)"
    if [ "$code" = "200" ]; then
      ok "${description} is reachable"
      return 0
    fi
    if [ "$code" = "401" ] || [ "$code" = "500" ]; then
      fail "${description} returned HTTP ${code}. ${log_hint}"
    fi
    sleep 2
  done
  fail "${description} did not become reachable. ${log_hint}"
}

fail() {
  local failed_phase
  failed_phase="${INSTALL_PHASE:-unknown}"
  printf '\n%s%sERROR%s %s\n' "$COLOR_RED" "$COLOR_BOLD" "$COLOR_RESET" "$*" >&2
  if declare -F capture_install_failure >/dev/null 2>&1; then
    capture_install_failure 1 "${BASH_LINENO[0]:-0}" || true
  fi
  printf '%s\n' "Installer phase: ${failed_phase}" >&2
  printf '%s\n\n' "Detailed log: ${MATRIX_INSTALL_LOG}" >&2
  exit 1
}

telemetry_enabled() {
  [ -z "${MATRIX_NO_TELEMETRY:-}" ] || return 1
  [ "${MATRIX_INSTALL_TELEMETRY:-1}" != "0" ] || return 1
  [ -n "$MATRIX_INSTALL_TELEMETRY_URL" ] || return 1
}

telemetry_id() {
  if [ -n "$MATRIX_INSTALL_TELEMETRY_ID" ]; then
    printf '%s\n' "$MATRIX_INSTALL_TELEMETRY_ID"
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    MATRIX_INSTALL_TELEMETRY_ID="$(openssl rand -hex 16 2>/dev/null || true)"
  fi
  if [ -z "$MATRIX_INSTALL_TELEMETRY_ID" ]; then
    MATRIX_INSTALL_TELEMETRY_ID="$(date -u +%Y%m%d%H%M%S)-$$"
  fi
  printf '%s\n' "$MATRIX_INSTALL_TELEMETRY_ID"
}

telemetry_value() {
  printf '%s' "${1:-unknown}" | tr -c 'A-Za-z0-9._:/@+-' '_' | cut -c1-120
}

developer_tool_count() {
  local count tool
  count=0
  for tool in $MATRIX_DEVELOPER_TOOLS; do
    [ -n "$tool" ] || continue
    count=$((count + 1))
  done
  printf '%s\n' "$count"
}

bundle_source() {
  case "$MATRIX_HOST_BUNDLE_URL" in
    "${DEFAULT_BUNDLE_BASE}/matrix-host-bundle.tar.gz") printf 'default\n' ;;
    *) printf 'custom\n' ;;
  esac
}

domain_mode() {
  if [ "$MATRIX_DOMAIN" = "_" ]; then
    printf 'ip\n'
  else
    printf 'dns\n'
  fi
}

installed_version() {
  if [ -f /opt/matrix/app/BUNDLE_VERSION ]; then
    head -n1 /opt/matrix/app/BUNDLE_VERSION
    return
  fi
  if [ -f /opt/matrix/BUNDLE_VERSION ]; then
    head -n1 /opt/matrix/BUNDLE_VERSION
    return
  fi
  if [ -f /opt/matrix/release.json ]; then
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /opt/matrix/release.json | head -n1
    return
  fi
  printf 'unknown\n'
}

capture_install_telemetry() {
  local event status exit_code payload version
  event="$1"
  status="$2"
  exit_code="${3:-0}"
  telemetry_enabled || return 0
  version="$(telemetry_value "$(installed_version 2>/dev/null || printf 'unknown')")"
  payload="$(printf '{"event":"%s","installId":"%s","channel":"%s","version":"%s","domainMode":"%s","bundleSource":"%s","developerToolsCount":%s,"phase":"%s","status":"%s","exitCode":%s}\n' \
    "$(telemetry_value "$event")" \
    "$(telemetry_value "$(telemetry_id)")" \
    "$(telemetry_value "$DEFAULT_CHANNEL")" \
    "$version" \
    "$(telemetry_value "$(domain_mode)")" \
    "$(telemetry_value "$(bundle_source)")" \
    "$(developer_tool_count)" \
    "$(telemetry_value "$INSTALL_PHASE")" \
    "$(telemetry_value "$status")" \
    "$exit_code")"
  curl --fail --silent --show-error --connect-timeout 2 --max-time 3 \
    -H 'content-type: application/json' \
    -X POST \
    --data "$payload" \
    "$MATRIX_INSTALL_TELEMETRY_URL" >/dev/null 2>&1 || true
}

capture_install_failure() {
  local exit_code line
  exit_code="$1"
  line="$2"
  [ "$INSTALL_COMPLETED" = "0" ] || return 0
  [ "$INSTALL_FAILURE_CAPTURED" = "0" ] || return 0
  INSTALL_FAILURE_CAPTURED=1
  INSTALL_PHASE="${INSTALL_PHASE:-failed}-line-${line}"
  capture_install_telemetry "matrix_manual_install_failed" "failed" "$exit_code"
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    fail "run as root, for example: curl -fsSL https://matrix-os.com/install-server.sh | sudo bash"
  fi
}

require_linux_systemd() {
  [ "$(uname -s)" = "Linux" ] || fail "Linux is required"
  command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
}

validate_config() {
  case "$DEFAULT_CHANNEL" in
    ""|*[!A-Za-z0-9._-]*) fail "MATRIX_CHANNEL contains unsupported characters" ;;
  esac
  case "$MATRIX_INSTALL_HANDLE" in
    ""|*[!A-Za-z0-9_-]*) fail "MATRIX_INSTALL_HANDLE may only contain letters, numbers, underscore, and dash" ;;
  esac
  if [ "$MATRIX_DOMAIN" != "_" ]; then
    [ "${#MATRIX_DOMAIN}" -le 253 ] || fail "MATRIX_DOMAIN may only be '_' or a DNS name"
    [[ "$MATRIX_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]] \
      || fail "MATRIX_DOMAIN may only be '_' or a DNS name"
  fi
  case "$MATRIX_HOME_DIR" in
    /home/matrix/*|/home/matrix) ;;
    *) fail "MATRIX_HOME must stay under /home/matrix for standalone installs" ;;
  esac
  case "$MATRIX_HOST_BUNDLE_URL" in
    https://*) ;;
    *) fail "MATRIX_HOST_BUNDLE_URL must be https" ;;
  esac
  case "$MATRIX_DEVELOPER_TOOLS" in
    *[!A-Za-z0-9._\ -]*) fail "MATRIX_DEVELOPER_TOOLS contains unsupported characters" ;;
  esac
}

preflight_bundle_url() {
  [ "${MATRIX_SKIP_BUNDLE_PREFLIGHT:-0}" != "1" ] || return 0

  section "Checking Matrix OS host bundle"
  log "Channel: ${DEFAULT_CHANNEL}"
  log "Bundle: ${MATRIX_HOST_BUNDLE_URL}"

  # Do not follow this HEAD redirect: the platform returns a signed R2 GET URL,
  # and R2 rejects following that signature as a HEAD request.
  if ! curl --fail --silent --show-error --head \
    --connect-timeout 10 --max-time 30 \
    "$MATRIX_HOST_BUNDLE_URL" >/dev/null; then
    fail "host bundle is not reachable: ${MATRIX_HOST_BUNDLE_URL}. Use a published MATRIX_CHANNEL or pass MATRIX_HOST_BUNDLE_URL to a published bundle."
  fi

  if ! curl --fail --silent --show-error --location --head \
    --connect-timeout 10 --max-time 30 \
    "${MATRIX_HOST_BUNDLE_URL}.sha256" >/dev/null; then
    fail "host bundle checksum is not reachable: ${MATRIX_HOST_BUNDLE_URL}.sha256"
  fi

  ok "Host bundle is reachable"
}

apt_get_update() {
  apt-get update \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=20 \
    -o Acquire::https::Timeout=20
}

enable_ubuntu_universe() {
  [ -r /etc/os-release ] || return 0
  # shellcheck disable=SC1091 -- the host-owned OS metadata is the distro source of truth.
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || return 0
  timeout 300 apt-get install -y software-properties-common >>"$MATRIX_INSTALL_LOG" 2>&1 \
    || fail "Ubuntu repository tooling install failed"
  timeout 60 add-apt-repository -y universe >>"$MATRIX_INSTALL_LOG" 2>&1 \
    || fail "Ubuntu universe repository setup failed"
  apt_get_update >>"$MATRIX_INSTALL_LOG" 2>&1 || fail "apt-get update failed after enabling Ubuntu universe"
}

configure_bwrap_apparmor() {
  [ -r /etc/os-release ] || return 0
  # shellcheck disable=SC1091 -- the host-owned OS metadata is the distro source of truth.
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || return 0
  dpkg --compare-versions "$VERSION_ID" ge 24.04 || return 0

  install -d -o root -g root -m 0755 /etc/apparmor.d || fail "AppArmor profile directory setup failed"
  cat >/etc/apparmor.d/bwrap <<'EOF' || fail "AppArmor bubblewrap profile write failed"
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  if systemctl is-active --quiet apparmor; then
    run_required "reloading AppArmor for bubblewrap" systemctl reload apparmor
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    section "Installing OS packages"
    : >"$MATRIX_INSTALL_LOG"
    log "Writing apt output to ${MATRIX_INSTALL_LOG}"
    apt_get_update >>"$MATRIX_INSTALL_LOG" 2>&1 || fail "apt-get update failed"
    enable_ubuntu_universe
    apt-get install -y bubblewrap ca-certificates curl docker.io git nginx openssl postgresql-client procps socat sudo tar >>"$MATRIX_INSTALL_LOG" 2>&1 \
      || fail "apt-get install failed"
    configure_bwrap_apparmor
    ok "OS packages installed"
    return
  fi
  fail "only apt-based Linux distributions are supported in this preview"
}

ensure_matrix_user() {
  section "Preparing Matrix OS user"
  if ! getent group matrix >/dev/null 2>&1; then
    run_required "creating matrix group" groupadd --system matrix
  fi
  if ! getent group docker >/dev/null 2>&1; then
    run_required "creating docker group" groupadd --system docker
  fi
  if ! id matrix >/dev/null 2>&1; then
    run_required "creating matrix user" useradd --system --gid matrix --groups docker --home-dir /home/matrix --shell /bin/bash matrix
  else
    run_required "updating matrix user groups" usermod -aG docker matrix
  fi

  install -d -o root -g matrix -m 0770 /opt/matrix
  install -d -o root -g matrix -m 0750 /opt/matrix/env /opt/matrix/bin /opt/matrix/tls
  install -d -o matrix -g matrix -m 0755 /home/matrix "$MATRIX_HOME_DIR" "$MATRIX_HOME_DIR/projects"
  install -d -o matrix -g matrix -m 0755 "$MATRIX_HOME_DIR/.local" "$MATRIX_HOME_DIR/.local/bin" "$MATRIX_HOME_DIR/.local/share"
  install -d -o matrix -g matrix -m 0755 "$MATRIX_HOME_DIR/.cache" "$MATRIX_HOME_DIR/.config"
  run_required "setting matrix home directory" usermod -d "$MATRIX_HOME_DIR" matrix
  ok "Matrix OS user ready"
}

random_secret() {
  openssl rand -hex 32 | tr -d '\n'
}

read_env_value() {
  local file key value
  file="$1"
  key="$2"
  [ -f "$file" ] || return 1
  value="$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$file")"
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

write_env() {
  local auth_token code_token postgres_password
  auth_token="$(read_env_value /opt/matrix/env/host.env MATRIX_AUTH_TOKEN || random_secret)"
  code_token="$(read_env_value /opt/matrix/env/host.env MATRIX_CODE_PROXY_TOKEN || random_secret)"
  postgres_password="$(read_env_value /opt/matrix/env/postgres.env POSTGRES_PASSWORD || random_secret | tr '/+' 'ab')"

  cat >/opt/matrix/env/postgres.env <<EOF
POSTGRES_DB=matrix
POSTGRES_USER=matrix
POSTGRES_PASSWORD=${postgres_password}
EOF
  chmod 0640 /opt/matrix/env/postgres.env
  chown root:matrix /opt/matrix/env/postgres.env

  cat >/opt/matrix/env/host.env <<EOF
MATRIX_SELF_HOSTED=1
MATRIX_MACHINE_ID=self-host-${MATRIX_INSTALL_HANDLE}
MATRIX_CLERK_USER_ID=self-host-${MATRIX_INSTALL_HANDLE}
MATRIX_USER_ID=self-host-${MATRIX_INSTALL_HANDLE}
MATRIX_HANDLE=${MATRIX_INSTALL_HANDLE}
MATRIX_RUNTIME_SLOT=primary
MATRIX_DEVELOPER_TOOLS='${MATRIX_DEVELOPER_TOOLS}'
MATRIX_IMAGE_VERSION=${DEFAULT_CHANNEL}
MATRIX_UPDATE_CHANNEL=${DEFAULT_CHANNEL}
MATRIX_AUTH_TOKEN=${auth_token}
MATRIX_CODE_PROXY_TOKEN=${code_token}
MATRIX_HOST_BUNDLE_URL=${MATRIX_HOST_BUNDLE_URL}
MATRIX_HOME=${MATRIX_HOME_DIR}
DATABASE_URL=postgresql://matrix:${postgres_password}@127.0.0.1:5432/matrix
GATEWAY_URL=http://127.0.0.1:4000
NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:4000
NEXT_PUBLIC_GATEWAY_WS=/ws
EOF
  chmod 0640 /opt/matrix/env/host.env
  chown root:matrix /opt/matrix/env/host.env
}

install_bundle() {
  local tmp_bundle tmp_sum expected actual
  tmp_bundle="$(mktemp /tmp/matrix-host-bundle.XXXXXX.tar.gz)"
  tmp_sum="$(mktemp /tmp/matrix-host-bundle.XXXXXX.tar.gz.sha256)"
  INSTALL_TMP_BUNDLE="$tmp_bundle"
  INSTALL_TMP_SUM="$tmp_sum"

  section "Downloading Matrix OS"
  log "Bundle: ${MATRIX_HOST_BUNDLE_URL}"
  if [ -t 1 ]; then
    curl --fail --location --progress-bar --retry 3 --retry-delay 5 --retry-all-errors \
      --connect-timeout 10 --max-time 900 \
      "$MATRIX_HOST_BUNDLE_URL" -o "$tmp_bundle"
  else
    curl --fail --silent --show-error --location --retry 3 --retry-delay 5 --retry-all-errors \
      --connect-timeout 10 --max-time 900 \
      "$MATRIX_HOST_BUNDLE_URL" -o "$tmp_bundle"
  fi
  curl --fail --silent --show-error --location --retry 3 --retry-delay 5 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    "${MATRIX_HOST_BUNDLE_URL}.sha256" -o "$tmp_sum"

  expected="$(awk '{print $1}' "$tmp_sum")"
  actual="$(sha256sum "$tmp_bundle" | awk '{print $1}')"
  [ -n "$expected" ] || fail "empty bundle checksum"
  [ "$expected" = "$actual" ] || fail "bundle checksum mismatch"

  ok "Host bundle checksum verified"
  section "Extracting Matrix OS"
  tar -xzf "$tmp_bundle" -C /opt/matrix
  chmod 0755 /opt/matrix/bin/matrix-* /opt/matrix/bin/zellij 2>/dev/null || true
  cleanup_install_tmp
  INSTALL_TMP_BUNDLE=""
  INSTALL_TMP_SUM=""
}

prepare_runtime_permissions() {
  section "Preparing runtime permissions"
  if [ -d /opt/matrix/runtime/node ]; then
    run_required "setting Node runtime owner group" chown -R root:matrix /opt/matrix/runtime/node
    run_required "allowing matrix user Node runtime writes" chmod -R g+rwX /opt/matrix/runtime/node
    if find /opt/matrix/runtime/node -type d -exec chmod g+s {} + >>"$MATRIX_INSTALL_LOG" 2>&1; then
      ok "Runtime permissions ready"
      return
    fi
    warn "could not set setgid bit on all Node runtime directories; agent installs may need sudo"
    return
  fi
  warn "Node runtime prefix not found at /opt/matrix/runtime/node; skipping agent install permissions"
}

write_self_host_restore_service() {
  cat >/etc/systemd/system/matrix-restore.service <<'EOF'
[Unit]
Description=Matrix OS standalone database gate
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=matrix
Group=matrix
EnvironmentFile=/opt/matrix/env/host.env
EnvironmentFile=/opt/matrix/env/postgres.env
ExecStart=/bin/bash -lc 'set -euo pipefail; if docker ps --format "{{.Names}}" | grep -qx matrix-postgres; then :; elif docker ps -a --format "{{.Names}}" | grep -qx matrix-postgres; then docker start matrix-postgres >/dev/null; else docker volume create matrix-postgres >/dev/null; docker run -d --name matrix-postgres --restart unless-stopped --env-file /opt/matrix/env/postgres.env -v matrix-postgres:/var/lib/postgresql/data -p 127.0.0.1:5432:5432 postgres:16 >/dev/null; fi; for _ in $(seq 1 60); do pg_isready --host=127.0.0.1 --username="${POSTGRES_USER:-matrix}" --dbname="${POSTGRES_DB:-matrix}" >/dev/null 2>&1 && break; sleep 2; done; pg_isready --host=127.0.0.1 --username="${POSTGRES_USER:-matrix}" --dbname="${POSTGRES_DB:-matrix}" >/dev/null 2>&1; touch /opt/matrix/restore-complete'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
}

install_systemd_units() {
  section "Installing systemd units"
  install -m 0644 /opt/matrix/systemd/matrix-gateway.service /etc/systemd/system/matrix-gateway.service
  install -m 0644 /opt/matrix/systemd/matrix-shell.service /etc/systemd/system/matrix-shell.service
  install -m 0644 /opt/matrix/systemd/matrix-code.service /etc/systemd/system/matrix-code.service
  install -m 0644 /opt/matrix/systemd/matrix-code-server.service /etc/systemd/system/matrix-code-server.service
  if [ -f /opt/matrix/systemd/matrix-developer-tools.service ]; then
    install -m 0644 /opt/matrix/systemd/matrix-developer-tools.service /etc/systemd/system/matrix-developer-tools.service
  fi
  write_self_host_restore_service
  run_required "reloading systemd" systemctl daemon-reload
  run_required "enabling Matrix OS services" systemctl enable docker matrix-restore matrix-gateway matrix-shell matrix-code matrix-code-server
  if [ -f /etc/systemd/system/matrix-developer-tools.service ] && [ -n "$MATRIX_DEVELOPER_TOOLS" ]; then
    run_required "enabling optional developer tools service" systemctl enable matrix-developer-tools
  fi
  ok "Systemd units installed"
}

configure_nginx() {
  local auth_token code_proxy_token password hash server_name htpasswd_file legacy_htpasswd_file
  auth_token="$(read_env_value /opt/matrix/env/host.env MATRIX_AUTH_TOKEN)" || fail "MATRIX_AUTH_TOKEN is missing from host.env"
  code_proxy_token="$(read_env_value /opt/matrix/env/host.env MATRIX_CODE_PROXY_TOKEN)" || fail "MATRIX_CODE_PROXY_TOKEN is missing from host.env"
  server_name="$MATRIX_DOMAIN"
  htpasswd_file="/etc/nginx/matrix-self-host.htpasswd"
  legacy_htpasswd_file="/opt/matrix/env/nginx.htpasswd"

  if [ ! -f "$htpasswd_file" ] && [ -f "$legacy_htpasswd_file" ]; then
    install -m 0640 -o root -g www-data "$legacy_htpasswd_file" "$htpasswd_file"
  fi
  if [ ! -f "$htpasswd_file" ]; then
    password="$(openssl rand -base64 18 | tr -d '\n')"
    hash="$(openssl passwd -apr1 "$password")"
    printf 'matrix:%s\n' "$hash" >"$htpasswd_file"
    printf '%s\n' "$password" >/opt/matrix/env/initial-ui-password
    chmod 0600 /opt/matrix/env/initial-ui-password
  fi
  chmod 0640 "$htpasswd_file"
  chown root:www-data "$htpasswd_file"
  printf 'proxy_set_header Authorization "Bearer %s";\n' "$auth_token" >/opt/matrix/env/gateway-auth-token.conf
  chmod 0600 /opt/matrix/env/gateway-auth-token.conf
  chown root:root /opt/matrix/env/gateway-auth-token.conf
  printf 'proxy_set_header X-Matrix-Code-Proxy-Token "%s";\n' "$code_proxy_token" >/opt/matrix/env/code-proxy-token.conf
  chmod 0600 /opt/matrix/env/code-proxy-token.conf
  chown root:root /opt/matrix/env/code-proxy-token.conf

  cat >/etc/nginx/sites-available/matrix-self-host <<EOF
server {
  listen 80 default_server;
  server_name ${server_name};

  client_max_body_size 10m;
  auth_basic "Matrix OS";
  auth_basic_user_file ${htpasswd_file};

  proxy_set_header Host \$host;
  proxy_set_header X-Forwarded-Host \$host;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Real-IP \$remote_addr;

  location /api/ {
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }
  location /files/ {
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }
  location /icons/ {
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }
  location /apps/ {
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }
  location = /health {
    auth_basic off;
    access_log off;
    default_type application/json;
    return 200 '{"ok":true}';
  }
  location /gateway/ {
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000/;
  }

  location /cli/ {
    auth_basic off;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    rewrite ^/cli/?(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:4000;
  }

  location /ws {
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }

  location /code/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_set_header Authorization "";
    proxy_set_header X-Forwarded-Prefix /code;
    rewrite ^/code/?(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:8788;
  }

  location @matrix_code_root_ws {
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_set_header Authorization "";
    proxy_pass http://127.0.0.1:8788;
  }

  location / {
    if (\$arg_reconnectionToken != "") {
      return 418;
    }
    error_page 418 = @matrix_code_root_ws;
    proxy_set_header Authorization "";
    proxy_pass http://127.0.0.1:3000;
  }
}
EOF

  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/matrix-self-host /etc/nginx/sites-enabled/matrix-self-host
  run_required "testing nginx configuration" nginx -t
  run_required "enabling nginx" systemctl enable nginx
  ok "nginx configured"
}

start_services() {
  section "Starting Matrix OS services"
  run_required "starting docker" systemctl enable --now docker
  restart_required_service matrix-restore
  restart_required_service matrix-gateway
  restart_required_service matrix-shell
  restart_optional_service matrix-code-server "code-server proxy"
  restart_optional_service matrix-code "code service"
  if systemctl list-unit-files matrix-developer-tools.service >/dev/null 2>&1; then
    restart_optional_service matrix-developer-tools "optional developer tools installer"
  fi
  restart_required_service nginx
}

verify_services() {
  local password status
  section "Verifying Matrix OS"
  wait_http_ok "Matrix gateway" "http://127.0.0.1:4000/health" "Check: journalctl -u matrix-gateway -n 200 --no-pager"
  wait_http_ok "Matrix shell" "http://127.0.0.1:3000/" "Check: journalctl -u matrix-shell -n 200 --no-pager"
  if [ -f /opt/matrix/env/initial-ui-password ]; then
    password="$(cat /opt/matrix/env/initial-ui-password)"
    wait_http_ok_auth "nginx shell" "http://127.0.0.1/" "$password" "Check: tail -120 /var/log/nginx/error.log; journalctl -u matrix-shell -n 200 --no-pager"
    wait_http_ok_auth "nginx gateway API" "http://127.0.0.1/api/identity" "$password" "Check: tail -120 /var/log/nginx/error.log; journalctl -u matrix-gateway -n 200 --no-pager"
  else
    status="$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1/" || true)"
    [ "$status" = "401" ] || fail "nginx Basic Auth challenge returned HTTP ${status}, expected 401"
    ok "nginx Basic Auth is configured"
  fi
}

print_summary() {
  local ip password_line ui_url
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "${MATRIX_PUBLIC_URL:-}" ]; then
    ui_url="$MATRIX_PUBLIC_URL"
  elif [ "$MATRIX_DOMAIN" != "_" ]; then
    ui_url="http://${MATRIX_DOMAIN}"
  elif [ -n "$ip" ]; then
    ui_url="http://${ip}"
  else
    ui_url="http://<server-ip>"
  fi
  if [ -f /opt/matrix/env/initial-ui-password ]; then
    password_line="Password: $(cat /opt/matrix/env/initial-ui-password)"
  else
    password_line="Password: existing nginx Basic Auth credentials"
  fi

  cat <<EOF

${COLOR_GREEN}${COLOR_BOLD}Matrix OS standalone install complete.${COLOR_RESET}

Open: ${ui_url}
User: matrix
${password_line}

Code editor: ${ui_url%/}/code/
CLI gateway: ${ui_url%/}/cli
Home: ${MATRIX_HOME_DIR}

Useful commands:
  systemctl status matrix-gateway matrix-shell matrix-code nginx --no-pager
  journalctl -u matrix-gateway -u matrix-shell -u matrix-code -n 200 --no-pager
  sudo -iu matrix
  MATRIX_TOKEN=\$(sudo sed -n 's/^MATRIX_AUTH_TOKEN=//p' /opt/matrix/env/host.env)
  matrix shell ls --gateway ${ui_url%/}/cli --token "\$MATRIX_TOKEN"

This preview protects the web UI with nginx Basic Auth. Put the host behind
HTTPS, Tailscale, Cloudflare Access, or another trusted edge before long-term use.
EOF
}

main() {
  INSTALL_PHASE="preflight"
  banner
  require_root
  require_linux_systemd
  validate_config
  capture_install_telemetry "matrix_manual_install_started" "started" 0
  preflight_bundle_url
  INSTALL_PHASE="packages"
  install_packages
  INSTALL_PHASE="user"
  ensure_matrix_user
  INSTALL_PHASE="env"
  write_env
  INSTALL_PHASE="bundle"
  install_bundle
  INSTALL_PHASE="runtime_permissions"
  prepare_runtime_permissions
  INSTALL_PHASE="systemd"
  install_systemd_units
  INSTALL_PHASE="nginx"
  configure_nginx
  INSTALL_PHASE="services"
  start_services
  INSTALL_PHASE="verify"
  verify_services
  INSTALL_PHASE="complete"
  INSTALL_COMPLETED=1
  capture_install_telemetry "matrix_manual_install_completed" "completed" 0
  print_summary
}

main "$@"

#!/usr/bin/env bash
set -Eeuo pipefail

# Matrix OS standalone server installer.
# Public copy is served from https://matrix-os.com/install-server.sh.

DEFAULT_CHANNEL="${MATRIX_CHANNEL:-stable}"
DEFAULT_BUNDLE_BASE="https://app.matrix-os.com/system-bundles/${DEFAULT_CHANNEL}"
MATRIX_HOST_BUNDLE_URL="${MATRIX_HOST_BUNDLE_URL:-${DEFAULT_BUNDLE_BASE}/matrix-host-bundle.tar.gz}"
MATRIX_INSTALL_HANDLE="${MATRIX_INSTALL_HANDLE:-matrix}"
MATRIX_DOMAIN="${MATRIX_DOMAIN:-_}"
MATRIX_HOME_DIR="${MATRIX_HOME:-/home/matrix/home}"
MATRIX_DEVELOPER_TOOLS="${MATRIX_DEVELOPER_TOOLS:-codex claude-code opencode pi}"
MATRIX_INSTALL_TELEMETRY_URL="${MATRIX_INSTALL_TELEMETRY_URL:-https://matrix-os.com/api/install-telemetry}"
MATRIX_INSTALL_TELEMETRY_ID="${MATRIX_INSTALL_TELEMETRY_ID:-}"
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

log() {
  printf 'matrix-server-install: %s\n' "$*"
}

fail() {
  printf 'matrix-server-install: %s\n' "$*" >&2
  if declare -F capture_install_failure >/dev/null 2>&1; then
    capture_install_failure 1 "${BASH_LINENO[0]:-0}" || true
  fi
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

apt_get_update() {
  apt-get update \
    -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=20 \
    -o Acquire::https::Timeout=20
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    log "installing OS packages"
    apt_get_update
    apt-get install -y ca-certificates curl docker.io git nginx openssl postgresql-client procps sudo tar
    return
  fi
  fail "only apt-based Linux distributions are supported in this preview"
}

ensure_matrix_user() {
  if ! getent group matrix >/dev/null 2>&1; then
    groupadd --system matrix
  fi
  if ! getent group docker >/dev/null 2>&1; then
    groupadd --system docker
  fi
  if ! id matrix >/dev/null 2>&1; then
    useradd --system --gid matrix --groups docker --home-dir /home/matrix --shell /bin/bash matrix
  else
    usermod -aG docker matrix
  fi

  install -d -o root -g matrix -m 0770 /opt/matrix
  install -d -o root -g matrix -m 0750 /opt/matrix/env /opt/matrix/bin /opt/matrix/tls
  install -d -o matrix -g matrix -m 0755 /home/matrix "$MATRIX_HOME_DIR" "$MATRIX_HOME_DIR/projects"
  install -d -o matrix -g matrix -m 0755 "$MATRIX_HOME_DIR/.local" "$MATRIX_HOME_DIR/.local/bin" "$MATRIX_HOME_DIR/.local/share"
  install -d -o matrix -g matrix -m 0755 "$MATRIX_HOME_DIR/.cache" "$MATRIX_HOME_DIR/.config"
  usermod -d "$MATRIX_HOME_DIR" matrix
}

random_secret() {
  openssl rand -base64 32 | tr -d '\n'
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

  log "downloading host bundle"
  curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors \
    --connect-timeout 10 --max-time 900 \
    "$MATRIX_HOST_BUNDLE_URL" -o "$tmp_bundle"
  curl --fail --location --retry 3 --retry-delay 5 --retry-all-errors \
    --connect-timeout 10 --max-time 30 \
    "${MATRIX_HOST_BUNDLE_URL}.sha256" -o "$tmp_sum"

  expected="$(awk '{print $1}' "$tmp_sum")"
  actual="$(sha256sum "$tmp_bundle" | awk '{print $1}')"
  [ -n "$expected" ] || fail "empty bundle checksum"
  [ "$expected" = "$actual" ] || fail "bundle checksum mismatch"

  log "extracting host bundle"
  tar -xzf "$tmp_bundle" -C /opt/matrix
  chmod 0755 /opt/matrix/bin/matrix-* /opt/matrix/bin/zellij 2>/dev/null || true
  cleanup_install_tmp
  INSTALL_TMP_BUNDLE=""
  INSTALL_TMP_SUM=""
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
  log "installing systemd units"
  install -m 0644 /opt/matrix/systemd/matrix-gateway.service /etc/systemd/system/matrix-gateway.service
  install -m 0644 /opt/matrix/systemd/matrix-shell.service /etc/systemd/system/matrix-shell.service
  install -m 0644 /opt/matrix/systemd/matrix-code.service /etc/systemd/system/matrix-code.service
  install -m 0644 /opt/matrix/systemd/matrix-code-server.service /etc/systemd/system/matrix-code-server.service
  if [ -f /opt/matrix/systemd/matrix-developer-tools.service ]; then
    install -m 0644 /opt/matrix/systemd/matrix-developer-tools.service /etc/systemd/system/matrix-developer-tools.service
  fi
  write_self_host_restore_service
  systemctl daemon-reload
  systemctl enable docker matrix-restore matrix-gateway matrix-shell matrix-code matrix-code-server >/dev/null
  if [ -f /etc/systemd/system/matrix-developer-tools.service ] && [ -n "$MATRIX_DEVELOPER_TOOLS" ]; then
    systemctl enable matrix-developer-tools >/dev/null
  fi
}

configure_nginx() {
  local code_proxy_token password hash server_name
  code_proxy_token="$(read_env_value /opt/matrix/env/host.env MATRIX_CODE_PROXY_TOKEN)" || fail "MATRIX_CODE_PROXY_TOKEN is missing from host.env"
  server_name="$MATRIX_DOMAIN"

  if [ ! -f /opt/matrix/env/nginx.htpasswd ]; then
    password="$(openssl rand -base64 18 | tr -d '\n')"
    hash="$(openssl passwd -apr1 "$password")"
    printf 'matrix:%s\n' "$hash" >/opt/matrix/env/nginx.htpasswd
    printf '%s\n' "$password" >/opt/matrix/env/initial-ui-password
    chmod 0600 /opt/matrix/env/initial-ui-password
  fi
  chmod 0640 /opt/matrix/env/nginx.htpasswd
  chown root:www-data /opt/matrix/env/nginx.htpasswd
  printf 'proxy_set_header X-Matrix-Code-Proxy-Token "%s";\n' "$code_proxy_token" >/opt/matrix/env/code-proxy-token.conf
  chmod 0600 /opt/matrix/env/code-proxy-token.conf
  chown root:root /opt/matrix/env/code-proxy-token.conf

  cat >/etc/nginx/sites-available/matrix-self-host <<EOF
server {
  listen 80 default_server;
  server_name ${server_name};

  client_max_body_size 10m;
  auth_basic "Matrix OS";
  auth_basic_user_file /opt/matrix/env/nginx.htpasswd;

  proxy_set_header Host \$host;
  proxy_set_header X-Forwarded-Host \$host;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Real-IP \$remote_addr;

  location /api/ { proxy_pass http://127.0.0.1:4000; }
  location /files/ { proxy_pass http://127.0.0.1:4000; }
  location /icons/ { proxy_pass http://127.0.0.1:4000; }
  location /apps/ { proxy_pass http://127.0.0.1:4000; }
  location /health { proxy_pass http://127.0.0.1:4000; }
  location /gateway/ { proxy_pass http://127.0.0.1:4000/; }

  location /ws {
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_pass http://127.0.0.1:4000;
  }

  location /code/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    include /opt/matrix/env/code-proxy-token.conf;
    rewrite ^/code/?(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:8787;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
  }
}
EOF

  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/matrix-self-host /etc/nginx/sites-enabled/matrix-self-host
  nginx -t
  systemctl enable nginx >/dev/null
}

start_services() {
  log "starting services"
  systemctl enable --now docker >/dev/null
  systemctl restart matrix-restore
  systemctl restart matrix-gateway
  systemctl restart matrix-shell
  systemctl restart matrix-code-server || true
  systemctl restart matrix-code || true
  if systemctl list-unit-files matrix-developer-tools.service >/dev/null 2>&1; then
    systemctl restart matrix-developer-tools || true
  fi
  systemctl restart nginx
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

Matrix OS standalone install complete.

Open: ${ui_url}
User: matrix
${password_line}

Code editor: ${ui_url%/}/code/
Home: ${MATRIX_HOME_DIR}

Useful commands:
  systemctl status matrix-gateway matrix-shell matrix-code nginx --no-pager
  journalctl -u matrix-gateway -u matrix-shell -u matrix-code -n 200 --no-pager
  sudo -u matrix bash

This preview protects the web UI with nginx Basic Auth. Put the host behind
HTTPS, Tailscale, Cloudflare Access, or another trusted edge before long-term use.
EOF
}

main() {
  INSTALL_PHASE="preflight"
  require_root
  require_linux_systemd
  validate_config
  capture_install_telemetry "matrix_manual_install_started" "started" 0
  INSTALL_PHASE="packages"
  install_packages
  INSTALL_PHASE="user"
  ensure_matrix_user
  INSTALL_PHASE="env"
  write_env
  INSTALL_PHASE="bundle"
  install_bundle
  INSTALL_PHASE="systemd"
  install_systemd_units
  INSTALL_PHASE="nginx"
  configure_nginx
  INSTALL_PHASE="services"
  start_services
  INSTALL_PHASE="complete"
  INSTALL_COMPLETED=1
  capture_install_telemetry "matrix_manual_install_completed" "completed" 0
  print_summary
}

main "$@"

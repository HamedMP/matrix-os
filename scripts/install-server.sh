#!/usr/bin/env bash
set -Eeuo pipefail

# Matrix OS standalone server installer.
# Public copy is served from https://matrix-os.com/install-server.sh.
# pattern-allow large-file: single-file curl|bash installer (expires 2026-12-31, approved-by hamed)

DEFAULT_CHANNEL="${MATRIX_CHANNEL:-dev}"
DEFAULT_BUNDLE_BASE="https://app.matrix-os.com/system-bundles/${DEFAULT_CHANNEL}"
MATRIX_HOST_BUNDLE_URL="${MATRIX_HOST_BUNDLE_URL:-${DEFAULT_BUNDLE_BASE}/matrix-host-bundle.tar.gz}"
MATRIX_INSTALL_HANDLE="${MATRIX_INSTALL_HANDLE:-matrix}"
MATRIX_DOMAIN="${MATRIX_DOMAIN:-_}"
MATRIX_HOME_DIR="${MATRIX_HOME:-}"
MATRIX_EXISTING_HOST_ENV="${MATRIX_EXISTING_HOST_ENV:-/opt/matrix/env/host.env}"
MATRIX_RUN_USER=""
MATRIX_RUN_GROUP=""
MATRIX_RUN_USER_HOME=""
MATRIX_HERDR_CORE_BIN=""
MATRIX_TAILSCALE_OWNER_LOGIN=""
MATRIX_TAILNET_URL=""
# The account the browser desktop runs as (spec 2701): no matrix or docker group.
MATRIX_BROWSER_ACCOUNT=matrix-browser
# Install choices (spec 2701). Flags win over env; with no TTY the defaults apply.
OPT_RUN_USER="${MATRIX_RUN_USER_REQUEST:-}"
OPT_HERDR="${MATRIX_HERDR_CHOICE:-}"
OPT_BROWSER="${MATRIX_BROWSER_CHOICE:-}"
OPT_ACCESS="${MATRIX_ACCESS:-}"
OPT_LOGIN_SERVER="${MATRIX_LOGIN_SERVER:-}"
OPT_AUTHKEY_FILE="${MATRIX_TAILSCALE_AUTHKEY_FILE:-}"
OPT_JOIN_URL="${MATRIX_JOIN_URL:-}"
OPT_JOIN_CODE="${MATRIX_JOIN_CODE:-}"
OPT_ACCESS_EXPLICIT=0
BROWSER_FLAG_GIVEN=0
MATRIX_DEVELOPER_TOOLS="${MATRIX_DEVELOPER_TOOLS:-codex claude-code opencode pi}"
MATRIX_INSTALL_TELEMETRY_URL="${MATRIX_INSTALL_TELEMETRY_URL:-https://matrix-os.com/api/install-telemetry}"
MATRIX_INSTALL_TELEMETRY_ID="${MATRIX_INSTALL_TELEMETRY_ID:-}"
MATRIX_INSTALL_LOG="${MATRIX_INSTALL_LOG:-/tmp/matrix-server-install.log}"
INSTALL_TMP_BUNDLE=""
INSTALL_TMP_SUM=""
INSTALL_PHASE="init"
INSTALL_COMPLETED=0
INSTALL_FAILURE_CAPTURED=0
# 0: no public-to-private switch running; 1: switching (a failed exit restores
# public); 2: private access verified.
PRIVATE_CUTOVER=0
PRIVATE_CUTOVER_BACKUP=""

cleanup_install_tmp() {
  local status=$?
  # A public install switching to private gets its public listener back on any failed exit.
  ! declare -F rollback_failed_private_cutover >/dev/null || rollback_failed_private_cutover "$status"
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

wait_terminal_runtime_ready() {
  local attempt
  for attempt in $(seq 1 30); do
    if timeout 10 /opt/matrix/bin/matrix-terminal-runtime --health-check >>"$MATRIX_INSTALL_LOG" 2>&1; then
      ok "matrix-terminal-runtime socket is ready"
      return 0
    fi
    systemctl is-active --quiet matrix-terminal-runtime \
      || fail "matrix-terminal-runtime stopped before its socket became ready. Check: journalctl -u matrix-terminal-runtime -n 200 --no-pager"
    sleep 2
  done
  fail "matrix-terminal-runtime socket did not become ready. Check: journalctl -u matrix-terminal-runtime -n 200 --no-pager"
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
  # Only the chosen options: never hostnames, accounts, logins or keys.
  payload="$(printf '{"event":"%s","installId":"%s","channel":"%s","version":"%s","domainMode":"%s","accessMode":"%s","browser":"%s","herdr":"%s","bundleSource":"%s","developerToolsCount":%s,"phase":"%s","status":"%s","exitCode":%s}\n' \
    "$(telemetry_value "$event")" \
    "$(telemetry_value "$(telemetry_id)")" \
    "$(telemetry_value "$DEFAULT_CHANNEL")" \
    "$version" \
    "$(telemetry_value "$(domain_mode)")" \
    "$(telemetry_value "${OPT_ACCESS:-unknown}")" \
    "$(telemetry_value "${OPT_BROWSER:-unknown}")" \
    "$(telemetry_value "${OPT_HERDR:-unknown}")" \
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

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://matrix-os.com/install-server.sh | sudo bash -s -- [options]

  --user <name>            Run Matrix as this account (default: the sudo user; never root)
  --herdr | --no-herdr     Show existing Herdr sessions (asked only when herdr-core is found)
  --browser | --no-browser Enable browser use (default: yes)
  --access <mode>          tailscale (default), headscale, or public (password page, not recommended)
  --login-server <url>     Headscale server URL (implies --access headscale)
  --authkey-file <path>    Root-only file with a Tailscale/Headscale auth key; deleted after use
  --join <url>             Pair with an existing Matrix computer (from Settings > System > Add a machine)
  --join-code <code>       One-time join code shown next to --join
  -h, --help               Show this help

With no terminal attached the defaults apply and nothing waits for input.
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --user) [ "$#" -ge 2 ] || fail "--user needs a value"; OPT_RUN_USER="$2"; shift 2 ;;
      --user=*) OPT_RUN_USER="${1#*=}"; shift ;;
      --herdr) OPT_HERDR=on; shift ;;
      --no-herdr) OPT_HERDR=off; shift ;;
      --browser) OPT_BROWSER=on; BROWSER_FLAG_GIVEN=1; shift ;;
      --no-browser) OPT_BROWSER=off; BROWSER_FLAG_GIVEN=1; shift ;;
      --access) [ "$#" -ge 2 ] || fail "--access needs a value"; OPT_ACCESS="$2"; OPT_ACCESS_EXPLICIT=1; shift 2 ;;
      --access=*) OPT_ACCESS="${1#*=}"; OPT_ACCESS_EXPLICIT=1; shift ;;
      --login-server) [ "$#" -ge 2 ] || fail "--login-server needs a value"; OPT_LOGIN_SERVER="$2"; shift 2 ;;
      --login-server=*) OPT_LOGIN_SERVER="${1#*=}"; shift ;;
      --authkey-file) [ "$#" -ge 2 ] || fail "--authkey-file needs a value"; OPT_AUTHKEY_FILE="$2"; shift 2 ;;
      --authkey-file=*) OPT_AUTHKEY_FILE="${1#*=}"; shift ;;
      --join) [ "$#" -ge 2 ] || fail "--join needs a value"; OPT_JOIN_URL="$2"; shift 2 ;;
      --join=*) OPT_JOIN_URL="${1#*=}"; shift ;;
      --join-code) [ "$#" -ge 2 ] || fail "--join-code needs a value"; OPT_JOIN_CODE="$2"; shift 2 ;;
      --join-code=*) OPT_JOIN_CODE="${1#*=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "unknown option: $1 (see --help)" ;;
    esac
  done
  [ -z "${MATRIX_ACCESS:-}" ] || OPT_ACCESS_EXPLICIT=1
  [ -z "${MATRIX_BROWSER_CHOICE:-}" ] || BROWSER_FLAG_GIVEN=1
  case "$OPT_HERDR" in ""|on|off) ;; *) fail "MATRIX_HERDR_CHOICE must be on or off" ;; esac
  case "${OPT_BROWSER:-on}" in on|off) OPT_BROWSER="${OPT_BROWSER:-on}" ;; *) fail "MATRIX_BROWSER_CHOICE must be on or off" ;; esac
  OPT_ACCESS="${OPT_ACCESS:-tailscale}"
  case "$OPT_ACCESS" in
    tailscale|headscale|public) ;;
    *) fail "--access must be tailscale, headscale or public" ;;
  esac
}

has_tty() {
  [ "${MATRIX_INSTALL_NONINTERACTIVE:-0}" != "1" ] || return 1
  { : </dev/tty; } 2>/dev/null
}

# ask_yes_no <question> <default on|off>; prints on/off. Without a TTY the default wins.
ask_yes_no() {
  local question default answer hint
  question="$1"
  default="$2"
  if ! has_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  if [ "$default" = "on" ]; then hint="Y/n"; else hint="y/N"; fi
  printf '%s [%s] ' "$question" "$hint" >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  case "$answer" in
    [Yy]|[Yy][Ee][Ss]) printf 'on\n' ;;
    [Nn]|[Nn][Oo]) printf 'off\n' ;;
    *) printf '%s\n' "$default" ;;
  esac
}

ask_access_mode() {
  local answer
  if [ "$OPT_ACCESS_EXPLICIT" = "1" ] || [ -n "$OPT_LOGIN_SERVER" ] || ! has_tty; then
    return 0
  fi
  printf '%s\n' "How will you reach Matrix?" "  1) Tailscale (private network, recommended)" "  2) Headscale (your own Tailscale-compatible server)" "  3) Public address with a password page (not recommended)" >/dev/tty
  printf 'Choose [1] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  case "$answer" in
    2) OPT_ACCESS=headscale
       printf 'Headscale server URL: ' >/dev/tty
       IFS= read -r OPT_LOGIN_SERVER </dev/tty || OPT_LOGIN_SERVER="" ;;
    3) OPT_ACCESS=public ;;
    *) OPT_ACCESS=tailscale ;;
  esac
  OPT_ACCESS_EXPLICIT=1
}

finalize_access_choice() {
  if [ -n "$OPT_LOGIN_SERVER" ] && [ "$OPT_ACCESS_EXPLICIT" != "1" ]; then
    OPT_ACCESS=headscale
  fi
  if [ "$OPT_ACCESS" = "headscale" ]; then
    [ -n "$OPT_LOGIN_SERVER" ] || fail "--access headscale needs --login-server <https-url>"
    [ "${#OPT_LOGIN_SERVER}" -le 2048 ] || fail "--login-server must be an https URL"
    [[ "$OPT_LOGIN_SERVER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] \
      || fail "--login-server must be an https URL"
  elif [ -n "$OPT_LOGIN_SERVER" ]; then
    fail "--login-server is only used with --access headscale"
  fi
  if [ -n "$OPT_JOIN_URL" ] || [ -n "$OPT_JOIN_CODE" ]; then
    [ "$OPT_ACCESS" != "public" ] || fail "--join needs --access tailscale or headscale"
    [ -n "$OPT_JOIN_URL" ] && [ -n "$OPT_JOIN_CODE" ] || fail "--join and --join-code go together"
    [[ "$OPT_JOIN_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]] || fail "--join must be the Matrix computer URL shown in Settings"
    [[ "$OPT_JOIN_CODE" =~ ^mxj_[A-Za-z0-9_-]{20,64}$ ]] || fail "--join-code is not a Matrix join code"
  fi
}

passwd_entry() {
  # A missing account is normal here (ensure_matrix_user creates it later); getent
  # exits 2 for it, which would otherwise end the installer under pipefail.
  { getent passwd "$1" 2>/dev/null || true; } | head -n1
}

# Resolves MATRIX_RUN_USER, its group and home, and MATRIX_HOME_DIR (S1, spec 2701).
resolve_run_user() {
  local existing_user existing_home candidate entry uid home
  existing_user=""
  existing_home=""
  if [ -f "$MATRIX_EXISTING_HOST_ENV" ]; then
    existing_user="$(read_env_value "$MATRIX_EXISTING_HOST_ENV" MATRIX_RUNTIME_USER || printf 'matrix')"
    existing_home="$(read_env_value "$MATRIX_EXISTING_HOST_ENV" MATRIX_HOME || true)"
  fi

  candidate="$OPT_RUN_USER"
  if [ -n "$existing_user" ]; then
    if [ -n "$candidate" ] && [ "$candidate" != "$existing_user" ]; then
      fail "this computer already runs Matrix as ${existing_user}; re-run with --user ${existing_user} (owner data is never moved automatically)"
    fi
    candidate="$existing_user"
  fi
  if [ -z "$candidate" ]; then
    candidate="${SUDO_USER:-}"
  fi
  if [ -z "$candidate" ] && has_tty; then
    printf 'Run Matrix as which account? [matrix] ' >/dev/tty
    IFS= read -r candidate </dev/tty || candidate=""
  fi
  candidate="${candidate:-matrix}"

  [ "$candidate" != "root" ] || fail "Matrix must not run as root; pass --user <name> or run the installer with sudo from your own account"
  [[ "$candidate" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "--user must be a Unix account name"

  entry="$(passwd_entry "$candidate")"
  if [ -n "$entry" ]; then
    uid="$(printf '%s' "$entry" | cut -d: -f3)"
    [ "$uid" != "0" ] || fail "Matrix must not run as root; pass --user <name>"
    home="$(printf '%s' "$entry" | cut -d: -f6)"
  else
    home="/home/${candidate}"
  fi
  if [ "$candidate" = "matrix" ]; then
    # Legacy layout: the matrix account's home is its Matrix home.
    home="/home/matrix"
  fi

  MATRIX_RUN_USER="$candidate"
  MATRIX_RUN_USER_HOME="$home"
  if [ -n "$entry" ]; then
    MATRIX_RUN_GROUP="$(id -gn "$candidate" 2>/dev/null || printf '%s' "$candidate")"
  else
    MATRIX_RUN_GROUP="$candidate"
  fi

  if [ -z "$MATRIX_HOME_DIR" ]; then
    if [ -n "$existing_home" ]; then
      MATRIX_HOME_DIR="$existing_home"
    elif [ "$candidate" = "matrix" ]; then
      MATRIX_HOME_DIR="/home/matrix/home"
    else
      MATRIX_HOME_DIR="${home}/matrix"
    fi
  fi
  case "$MATRIX_HOME_DIR" in
    "$MATRIX_RUN_USER_HOME"/*) ;;
    *) fail "MATRIX_HOME must stay under ${MATRIX_RUN_USER_HOME} for standalone installs" ;;
  esac
  case "$MATRIX_HOME_DIR" in
    *..*|*[!A-Za-z0-9._/-]*) fail "MATRIX_HOME must be a plain path" ;;
  esac
}

render_run_user_dropin() {
  printf '# Written by install-server.sh: run Matrix as the person who installed it (spec 2701 S1).\n'
  printf '[Service]\nUser=%s\nGroup=%s\nSupplementaryGroups=matrix docker\n' "$1" "$2"
}

render_zellij_home_dropin() {
  printf '# Written by install-server.sh: self-host Matrix home (spec 2701 S1).\n'
  printf '[Unit]\nConditionPathExists=\nConditionPathExists=%s/system/terminal-runtimes/%%i.json\n\n[Service]\nEnvironment=MATRIX_HOME=%s\n' "$1" "$1"
}

# The scope runtime supervisor runs root:matrix on every host (as on managed
# VPSes). Self-host only moves its Matrix home and the read-only workload roots
# it can see behind ProtectHome=tmpfs.
SCOPE_RUNTIME_ROOTS=(bots agent-workspaces projects worktrees)

render_scope_runtime_home_dropin() {
  local root
  printf '# Written by install-server.sh: self-host Matrix home (spec 2701 S1).\n'
  printf '[Service]\nEnvironment=MATRIX_HOME=%s\n' "$1"
  for root in "${SCOPE_RUNTIME_ROOTS[@]}"; do
    printf 'BindReadOnlyPaths=-%s/%s\n' "$1" "$root"
  done
}

# prepare_scope_runtime_roots <matrix home> <owner>: prepares workload roots before
# the supervisor's read-only namespace exists. The capability-free root:matrix
# supervisor reads them through group matrix, and the gateway later creates 0750
# children as the owner (agent-workspaces/<owner>/<chat>), so the roots are setgid:
# those children inherit group matrix instead of the owner's own group. An existing
# root the owner holds gets the same group, setgid and no access for other accounts
# on the directory itself only; its contents, other owners' roots and symlinks are
# never touched. Nothing else reads these roots: nginx only proxies to loopback,
# code-server and the gateway run as the owner, and scope workloads get their one
# workspace by bind mount. The legacy
# matrix account's primary group is already matrix, so its layout stays as it was.
prepare_scope_runtime_roots() {
  local root path
  for root in "${SCOPE_RUNTIME_ROOTS[@]}"; do
    path="$1/${root}"
    if [ "$2" = "matrix" ]; then
      [ -d "$path" ] || install -d -o matrix -g matrix -m 0750 "$path"
    elif [ ! -e "$path" ] && [ ! -L "$path" ]; then
      install -d -o "$2" -g matrix -m 2750 "$path"
    elif [ -d "$path" ] && [ ! -L "$path" ] && [ "$(stat -c %U -- "$path")" = "$2" ]; then
      chgrp matrix "$path"
      chmod g+s,o-rwx "$path"
      [ "$root" != "agent-workspaces" ] || adopt_managed_pi_workspaces "$path" "$2"
    fi
  done
}

# adopt_managed_pi_workspaces <agent-workspaces> <owner>: an earlier install left the
# gateway's agent-workspaces/<owner key>/<chat id> directories in the owner's own
# group, which the supervisor cannot traverse even under a setgid root. Moves just
# those two gateway-managed levels (sha256 owner key, chat_ id) into setgid group
# matrix. Chat contents, other names, other owners' directories and symlinks stay.
adopt_managed_pi_workspaces() {
  local key chat
  for key in "$1"/*; do
    [[ "${key##*/}" =~ ^[0-9a-f]{64}$ ]] && [ -d "$key" ] && [ ! -L "$key" ] || continue
    [ "$(stat -c %U -- "$key")" = "$2" ] || continue
    chgrp matrix "$key"
    chmod g+s "$key"
    for chat in "$key"/*; do
      [[ "${chat##*/}" =~ ^chat_[A-Za-z0-9_-]{1,128}$ ]] && [ -d "$chat" ] && [ ! -L "$chat" ] || continue
      [ "$(stat -c %U -- "$chat")" = "$2" ] || continue
      chgrp matrix "$chat"
      chmod g+s "$chat"
    done
  done
  return 0
}

render_browser_sudoers() {
  printf '# Written by install-server.sh: browser use lifecycle for %s only.\n' "$1"
  printf '%s ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/matrix-browser-runtime.py --status\n' "$1"
  printf '%s ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/matrix-browser-runtime.py --retry\n' "$1"
}

# check_authkey_file <path>: must be a regular file owned by the installing user (root) and private.
check_authkey_file() {
  local path meta owner mode
  path="$1"
  [ -f "$path" ] && [ ! -L "$path" ] || fail "--authkey-file must be a regular file"
  meta="$(stat -c '%u %a' -- "$path" 2>/dev/null)" || fail "--authkey-file is not readable"
  owner="${meta%% *}"
  mode="${meta##* }"
  [ "$owner" = "$(id -u)" ] || fail "--authkey-file must be owned by root"
  case "$mode" in
    400|600) ;;
    *) fail "--authkey-file must not be readable by group or others (chmod 600)" ;;
  esac
}

delete_authkey_file() {
  if command -v shred >/dev/null 2>&1; then
    shred -u -- "$1" 2>/dev/null || rm -f -- "$1"
  else
    rm -f -- "$1"
  fi
}

tailscale_login_args() {
  if [ "$OPT_ACCESS" = "headscale" ]; then
    printf -- '--login-server=%s\n' "$OPT_LOGIN_SERVER"
  fi
}

# The key never enters argv, logs or telemetry: tailscale reads it from the file.
tailscale_login_with_authkey() {
  local path status login_args
  path="$1"
  check_authkey_file "$path"
  login_args="$(tailscale_login_args)"
  status=0
  # shellcheck disable=SC2086 -- login_args is a single validated flag or empty.
  timeout 120 tailscale up "--auth-key=file:${path}" $login_args >>"$MATRIX_INSTALL_LOG" 2>&1 || status=$?
  delete_authkey_file "$path"
  return "$status"
}

nginx_identity_block() {
  cat <<'EOF'
  # Spec 2701: only the owner's Tailscale identity, checked by the gateway.
  location = /_matrix_private_network_identity {
    internal;
    auth_request off;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000/api/system/private-network/identity;
  }
EOF
}

nginx_browser_viewer_block() {
  cat <<'EOF'
  location = /apps/browser-lab/viewer/websockify {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 600s;
    proxy_pass http://127.0.0.1:4000;
  }

EOF
}

# Public mode only: Basic Auth credentials a browser has cached are sent on
# every request to this site, including a WebSocket opened by another site's
# page, and CORS does not stop upgrades. So a browser WebSocket upgrade, on any
# path, must come from a page on this same host (Origin host[:port] = the Host header). Requests
# without an Origin are not browser pages. Private modes leave this to the
# gateway, which checks the exact tailnet origin.
nginx_public_origin_map() {
  cat <<'EOF'
map "$http_upgrade|$http_origin|$http_host" $matrix_ws_origin_ok {
  default 0;
  "~*^(?!websocket\|)" 1;
  "~*^websocket\|\|" 1;
  "~*^websocket\|https?://([^/|]+)\|\1$" 1;
}

EOF
}

# Private modes: only Tailscale Serve (root) reaches nginx's root-only unix socket, so
# only it presents a tailnet identity; the loopback listener refuses one before auth.
TAILNET_SOCKET=/run/matrix-nginx/tailnet.sock
TAILNET_SERVE_PORT=""
nginx_private_identity_map() {
  cat <<'EOF'
map "$remote_addr|$http_tailscale_user_login" $matrix_forged_identity {
  default 0;
  "~^unix:\|" 0;
  "~\|.+$" 1;
}

EOF
}

# prepare_tailnet_socket_dir: the root-only directory holding nginx's Tailscale
# Serve socket, recreated on every boot.
prepare_tailnet_socket_dir() {
  install -d -o root -g root -m 0700 /run/matrix-nginx
  printf 'd /run/matrix-nginx 0700 root root -\n' >/etc/tmpfiles.d/matrix-nginx.conf
}

# render_nginx_site <access> <server_name> <htpasswd_file> <browser on|off>
render_nginx_site() {
  local access server_name htpasswd_file browser listen auth_lines exempt
  access="$1"
  server_name="$2"
  htpasswd_file="$3"
  browser="$4"
  if [ "$access" = "public" ]; then
    listen="listen 80 default_server;"
    auth_lines="  auth_basic \"Matrix OS\";
  auth_basic_user_file ${htpasswd_file};
  if (\$matrix_ws_origin_ok = 0) { return 403; }"
    exempt="auth_basic off;"
  else
    listen="listen 127.0.0.1:80 default_server;
  listen unix:${TAILNET_SOCKET};"
    auth_lines="  if (\$matrix_forged_identity) { return 403; }
  auth_request /_matrix_private_network_identity;"
    exempt="auth_request off;"
  fi
  if [ "$access" = "public" ]; then nginx_public_origin_map; else nginx_private_identity_map; fi
  cat <<EOF
server {
  ${listen}
  server_name ${server_name};

  client_max_body_size 10m;
${auth_lines}

  proxy_set_header Host \$host;
  proxy_set_header X-Forwarded-Host \$host;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header X-Real-IP \$remote_addr;

EOF
  [ "$access" = "public" ] || nginx_identity_block
  [ "$browser" != "on" ] || nginx_browser_viewer_block
  cat <<EOF
  # matrix-app-file-upload-limit-v1
  location = /api/bridge/files {
    client_max_body_size 15m;
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }

  # matrix-speech-upload-limit-v1
  location = /api/speech/transcriptions {
    client_max_body_size 21m;
    proxy_read_timeout 90s;
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }

  # matrix-sites-publish-timeout-v1
  location ~ "^/api/apps/[a-z0-9][a-z0-9-]{0,63}/site\$" {
    proxy_read_timeout 300s;
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000;
  }

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
    ${exempt}
    access_log off;
    default_type application/json;
    return 200 '{"ok":true}';
  }
  location /gateway/ {
    include /opt/matrix/env/gateway-auth-token.conf;
    proxy_pass http://127.0.0.1:4000/;
  }

  location /cli/ {
    ${exempt}
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
}

# run_user_login_shell: the run user's own login shell, so its PATH setup
# (~/.zprofile, ~/.bash_profile, fish config) applies; Bash when the entry is
# missing, not an executable absolute path, or a no-login shell.
run_user_login_shell() {
  local shell
  shell="$(getent passwd "$MATRIX_RUN_USER" 2>/dev/null | cut -d: -f7 || true)"
  case "$shell" in
    */nologin | */false | "") printf 'bash\n' ;;
    /*) if [ -x "$shell" ]; then printf '%s\n' "$shell"; else printf 'bash\n'; fi ;;
    *) printf 'bash\n' ;;
  esac
}

detect_herdr() {
  local found shell
  MATRIX_HERDR_CORE_BIN=""
  shell="$(run_user_login_shell)"
  found="$(timeout 15 runuser -u "$MATRIX_RUN_USER" -- "$shell" -lc 'command -v herdr-core' 2>/dev/null | head -n1 || true)"
  if [[ "$found" =~ ^/[A-Za-z0-9._/+-]{1,240}$ ]] && [ -x "$found" ]; then
    MATRIX_HERDR_CORE_BIN="$found"
  fi
  if [ -z "$MATRIX_HERDR_CORE_BIN" ]; then
    if [ "$OPT_HERDR" = "on" ]; then
      warn "herdr-core is not on ${MATRIX_RUN_USER}'s PATH; Herdr sessions stay off"
    fi
    OPT_HERDR=off
    return 0
  fi
  if [ -z "$OPT_HERDR" ]; then
    OPT_HERDR="$(ask_yes_no "Show your existing Herdr sessions in Matrix?" on)"
  fi
  ok "herdr-core found; Herdr sessions: ${OPT_HERDR}"
}

# restore_saved_access_mode: a rerun without --access keeps the installed mode
# (and its Headscale server), so an unattended reinstall never switches a working
# public install to a private network nobody has signed in to.
restore_saved_access_mode() {
  local env="${MATRIX_HOST_ENV_FILE:-/opt/matrix/env/host.env}" mode server
  PREVIOUS_ACCESS_MODE="$(read_env_value "$env" MATRIX_ACCESS_MODE 2>/dev/null || true)"
  PREVIOUS_SHELL_ORIGIN="$(read_env_value "$env" SHELL_ORIGIN 2>/dev/null || true)"
  if [ -z "$PREVIOUS_ACCESS_MODE" ] && legacy_public_install "$env"; then
    PREVIOUS_ACCESS_MODE=public
  fi
  [ "$OPT_ACCESS_EXPLICIT" != "1" ] && [ -z "$OPT_LOGIN_SERVER" ] || return 0
  mode="$PREVIOUS_ACCESS_MODE"
  case "$mode" in tailscale|headscale|public) ;; *) return 0 ;; esac
  OPT_ACCESS="$mode"
  OPT_ACCESS_EXPLICIT=1
  if [ "$mode" = "headscale" ]; then
    server="$(read_env_value "$env" MATRIX_TAILSCALE_LOGIN_SERVER 2>/dev/null || true)"
    OPT_LOGIN_SERVER="$server"
  fi
  log "Keeping access mode ${mode}; pass --access to change it"
}

# legacy_public_install <host.env>: the public-only installer before access modes
# wrote no MATRIX_ACCESS_MODE. Its install is a self-host host.env plus an nginx
# site listening on port 80 on every address; a private site listens only on
# loopback and the tailnet socket.
legacy_public_install() {
  local site="${MATRIX_NGINX_SITE_FILE:-/etc/nginx/sites-available/matrix-self-host}"
  [ "$(read_env_value "$1" MATRIX_SELF_HOSTED 2>/dev/null || true)" = "1" ] || return 1
  [ -f "$site" ] && [ ! -L "$site" ] || return 1
  grep -Eq '^[[:space:]]*listen[[:space:]]+(\[::\]:)?80([[:space:]]|;)' "$site"
}

# require_private_access_ready: before a public install's listener is replaced by
# private-only nginx, the private network must be signed in with a recorded
# owner and address. Otherwise the saved mode stays public and nothing changes.
require_private_access_ready() {
  local line
  [ "$PREVIOUS_ACCESS_MODE" = "public" ] && [ "$OPT_ACCESS" != "public" ] || return 0
  local requested="$OPT_ACCESS"
  line="$(tailscale_status_line)"
  if [ "${line%%$'\t'*}" = "Running" ] && [ -n "$MATRIX_TAILSCALE_OWNER_LOGIN" ] && [ -n "$MATRIX_TAILNET_URL" ]; then
    [ -n "$TAILNET_SERVE_PORT" ] && return 0
    # Signed in, but nothing on the tailnet reaches Matrix yet: replacing the
    # public site now would leave no way in.
    restore_previous_listener || fail "Tailscale Serve did not publish Matrix on your private network, and public access did not come back. Check: journalctl -u matrix-gateway -n 200 --no-pager"
    fail "Tailscale Serve did not publish Matrix on your private network; keeping your public listener. Check: sudo tailscale serve status, then rerun the installer with --access ${requested}"
  fi
  restore_previous_listener || fail "private access is not ready (sign-in did not finish), and public access did not come back. Check: journalctl -u matrix-gateway -n 200 --no-pager"
  fail "private access is not ready (sign-in did not finish); keeping your public listener. Sign in with: sudo tailscale up, then rerun the installer with --access ${requested}"
}

ask_install_choices() {
  if ! browser_flag_given; then
    OPT_BROWSER="$(ask_yes_no "Enable browser use (a private Chrome your agents can drive)?" on)"
  fi
  restore_saved_access_mode
  ask_access_mode
  finalize_access_choice
}

browser_flag_given() {
  [ "$BROWSER_FLAG_GIVEN" = "1" ]
}

node_bin() {
  printf '%s\n' "${MATRIX_INSTALL_NODE_BIN:-/opt/matrix/runtime/node/bin/node}"
}

# Prints "<state>\t<dnsName>\t<ownerLogin>\t<tailnet>" from `tailscale status --json`.
tailscale_status_line() {
  timeout 15 tailscale status --json 2>/dev/null | "$(node_bin)" -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 4 * 1024 * 1024) process.exit(1); });
process.stdin.on("end", () => {
  try {
    const status = JSON.parse(input);
    const self = status.Self || {};
    const user = (status.User || {})[String(self.UserID)] || {};
    const clean = (value) => (typeof value === "string" ? value.replace(/[^A-Za-z0-9._%+@:-]/g, "").slice(0, 254) : "");
    process.stdout.write([clean(status.BackendState), clean(self.DNSName).replace(/\.$/, ""), clean(user.LoginName), clean((status.CurrentTailnet || {}).Name)].join("\t") + "\n");
  } catch { process.exit(1); }
});' 2>/dev/null || true
}

# Prints the control server this machine is signed in to (empty when tailscaled
# keeps its default); fails when the preferences cannot be read.
tailscale_control_url() {
  timeout 15 tailscale debug prefs 2>/dev/null | "$(node_bin)" -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 1024 * 1024) process.exit(1); });
process.stdin.on("end", () => {
  try {
    const url = JSON.parse(input).ControlURL;
    if (url !== undefined && typeof url !== "string") process.exit(1);
    process.stdout.write((url || "").replace(/[^A-Za-z0-9._:\/-]/g, "").slice(0, 2048) + "\n");
  } catch { process.exit(1); }
});' 2>/dev/null
}

# normalize_control_url <url>: "tailscale" for Tailscale's own servers, else the
# URL with a lowercase scheme/host and no trailing slash.
normalize_control_url() {
  local url="${1%/}" rest
  case "${url,,}" in
    ""|https://controlplane.tailscale.com|https://login.tailscale.com) printf 'tailscale\n'; return 0 ;;
  esac
  if [[ "$url" =~ ^([A-Za-z][A-Za-z0-9+.-]*://)([^/]*)(.*)$ ]]; then
    rest="${BASH_REMATCH[3]}"
    printf '%s%s%s\n' "${BASH_REMATCH[1],,}" "${BASH_REMATCH[2],,}" "$rest"
  else
    printf '%s\n' "$url"
  fi
}

# A running connection is reused only when it is on the requested network; the
# installer never switches networks itself, because that drops the person's
# other devices from this machine.
require_requested_control_server() {
  local raw current requested switch
  raw="$(tailscale_control_url)" \
    || fail "this machine is on a private network, but the installer could not tell which private network (tailscale debug prefs failed). Check with: sudo tailscale debug prefs"
  current="$(normalize_control_url "$raw")"
  if [ "$OPT_ACCESS" = "headscale" ]; then
    requested="$(normalize_control_url "$OPT_LOGIN_SERVER")"
  else
    requested=tailscale
  fi
  [ "$current" != "$requested" ] || return 0
  if [ "$current" = "tailscale" ]; then
    switch="To keep Tailscale, rerun the installer without --login-server."
    fail "this machine is already on Tailscale, not ${OPT_LOGIN_SERVER}. Matrix does not switch networks for you. To use ${OPT_LOGIN_SERVER}, run: sudo tailscale logout, then rerun the installer. ${switch}"
  fi
  if [ "$requested" = "tailscale" ]; then
    switch="To keep it, rerun the installer with --access headscale --login-server ${current}."
  else
    switch="To keep it, rerun the installer with --login-server ${current}."
  fi
  fail "this machine is already on the private network at ${current}, not $( [ "$requested" = tailscale ] && printf 'Tailscale' || printf '%s' "$OPT_LOGIN_SERVER" ). Matrix does not switch networks for you. To move it, run: sudo tailscale logout, then rerun the installer. ${switch}"
}

install_tailscale() {
  local codename distro
  if command -v tailscale >/dev/null 2>&1; then
    ok "Tailscale is installed"
    return 0
  fi
  [ -r /etc/os-release ] || fail "cannot detect the distribution for the Tailscale package repository"
  # shellcheck disable=SC1091 -- host-owned OS metadata.
  . /etc/os-release
  distro="${ID:-}"
  codename="${VERSION_CODENAME:-}"
  case "$distro" in ubuntu|debian) ;; *) fail "Tailscale setup supports Ubuntu and Debian; use --access public or install Tailscale first" ;; esac
  [[ "$codename" =~ ^[a-z]+$ ]] || fail "cannot detect the distribution codename for Tailscale"
  log "Adding the signed Tailscale package repository"
  install -d -m 0755 /usr/share/keyrings
  curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 \
    "https://pkgs.tailscale.com/stable/${distro}/${codename}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg >>"$MATRIX_INSTALL_LOG" 2>&1 \
    || fail "downloading the Tailscale signing key failed"
  curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 \
    "https://pkgs.tailscale.com/stable/${distro}/${codename}.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list >>"$MATRIX_INSTALL_LOG" 2>&1 \
    || fail "downloading the Tailscale repository list failed"
  grep -q 'signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg' /etc/apt/sources.list.d/tailscale.list \
    || fail "the Tailscale repository list is not pinned to its signing key"
  apt_get_update >>"$MATRIX_INSTALL_LOG" 2>&1 || fail "apt-get update failed after adding Tailscale"
  timeout 300 apt-get install -y tailscale >>"$MATRIX_INSTALL_LOG" 2>&1 || fail "installing Tailscale failed"
  ok "Tailscale installed"
}

tailscale_wait_running() {
  local seconds line
  seconds="$1"
  for _ in $(seq 1 "$seconds"); do
    line="$(tailscale_status_line)"
    [ "${line%%$'\t'*}" != "Running" ] || return 0
    sleep 1
  done
  return 1
}

print_first_login_link() {
  local line url shown=""
  while IFS= read -r line; do
    [ -z "$shown" ] || continue
    url="$(printf '%s\n' "$line" | grep -Eo 'https://[A-Za-z0-9./?=_%:-]+' | head -n1 || true)"
    [ -n "$url" ] || continue
    printf 'Login: %s\n' "$url"
    shown=1
  done
}

tailscale_login() {
  local line wait login_args
  line="$(tailscale_status_line)"
  if [ "${line%%$'\t'*}" = "Running" ]; then
    require_requested_control_server
    ok "This machine is already on your private network"
    return 0
  fi
  if [ -n "$OPT_AUTHKEY_FILE" ]; then
    log "Joining the private network with the auth key file"
    tailscale_login_with_authkey "$OPT_AUTHKEY_FILE" || fail "joining the private network with the auth key failed"
    tailscale_wait_running 30 || fail "the private network did not come up after login"
    return 0
  fi
  login_args="$(tailscale_login_args)"
  if has_tty; then
    wait="${MATRIX_TAILSCALE_LOGIN_WAIT:-900}"
    printf '\n%s\n' "Open the link below (or scan the code) and sign in to connect this machine:" >/dev/tty
    # shellcheck disable=SC2086 -- login_args is a single validated flag or empty.
    timeout "$((wait + 10))" tailscale up --qr "--timeout=${wait}s" $login_args </dev/tty >/dev/tty 2>&1 || true
  else
    wait="${MATRIX_TAILSCALE_LOGIN_WAIT:-120}"
    log "No terminal attached: waiting up to ${wait}s for the login below"
    # shellcheck disable=SC2086 -- login_args is a single validated flag or empty.
    # Print the link the moment it appears and keep reading, so tailscale is
    # never cut off mid-login by a closed pipe.
    timeout "$((wait + 10))" tailscale up "--timeout=${wait}s" $login_args 2>&1 | print_first_login_link || true
  fi
  if tailscale_wait_running 5; then
    ok "This machine joined your private network"
    return 0
  fi
  # Signing in later is not enough: serving, the tailnet address and the
  # browser origin are recorded by the installer after login.
  warn "Not signed in to the private network yet. Sign in with: sudo tailscale up$( [ -z "$login_args" ] || printf ' %s' "$login_args"), then rerun this installer with the same options to finish private-network setup"
  return 0
}

record_tailscale_owner() {
  local line state dns login
  line="$(tailscale_status_line)"
  IFS=$'\t' read -r state dns login _ <<<"$line"
  [ "$state" = "Running" ] || return 0
  if [[ "$login" =~ ^[A-Za-z0-9._%+@:-]{1,254}$ ]]; then
    MATRIX_TAILSCALE_OWNER_LOGIN="$login"
  fi
  if [[ "$dns" =~ ^[A-Za-z0-9.-]{1,253}$ ]]; then
    if [ "$OPT_ACCESS" = "headscale" ]; then
      MATRIX_TAILNET_URL="http://${dns}"
    else
      MATRIX_TAILNET_URL="https://${dns}"
    fi
  fi
}

# tailnet_serve_published <port>: Tailscale Serve reports a handler on <port>
# that proxies to Matrix's tailnet socket. A zero exit from `tailscale serve`
# alone is not trusted.
tailnet_serve_published() {
  local port
  for port in $(timeout 30 tailscale serve status --json 2>>"$MATRIX_INSTALL_LOG" | matrix_serve_ports); do
    [ "$port" != "$1" ] || return 0
  done
  return 1
}

# Sets TAILNET_SERVE_PORT only once Serve publishes Matrix's socket; a public
# install is never switched away from without it (require_private_access_ready).
configure_tailscale_serve() {
  TAILNET_SERVE_PORT=""
  if [ "$OPT_ACCESS" = "headscale" ]; then
    timeout 60 tailscale serve --bg --yes --http=80 unix:${TAILNET_SOCKET} >>"$MATRIX_INSTALL_LOG" 2>&1 \
      || { warn "tailscale serve failed; Matrix is not yet reachable on your private network. Retry: sudo tailscale serve --bg --http=80 unix:${TAILNET_SOCKET}"; return 0; }
    tailnet_serve_published 80 && TAILNET_SERVE_PORT=80
  else
    if ! timeout 60 tailscale serve --bg --yes --https=443 unix:${TAILNET_SOCKET} >>"$MATRIX_INSTALL_LOG" 2>&1; then
      # Certificates are off for this tailnet. Tailnet traffic is already
      # encrypted end to end, so serve plain HTTP there instead of nothing.
      timeout 60 tailscale serve --bg --yes --http=80 unix:${TAILNET_SOCKET} >>"$MATRIX_INSTALL_LOG" 2>&1 \
        || { warn "tailscale serve failed; Matrix is not yet reachable on your private network. Retry: sudo tailscale serve --bg --http=80 unix:${TAILNET_SOCKET}"; return 0; }
      MATRIX_TAILNET_URL="${MATRIX_TAILNET_URL/#https:/http:}"
      warn "HTTPS certificates are off for your tailnet, so Matrix is served over tailnet-only HTTP. For an https link, enable HTTPS in the Tailscale admin console, then run: sudo tailscale serve --bg --https=443 unix:${TAILNET_SOCKET}"
      tailnet_serve_published 80 && TAILNET_SERVE_PORT=80
    else
      tailnet_serve_published 443 && TAILNET_SERVE_PORT=443
    fi
  fi
  if [ -z "$TAILNET_SERVE_PORT" ]; then
    warn "Tailscale Serve did not report Matrix on your private network. Check: sudo tailscale serve status"
    return 0
  fi
  ok "Matrix is served on your private network only"
}

# stop_matrix_tailscale_serve: after a private install, Tailscale Serve holds port 80
# (and 443) on the tailnet address, so public nginx cannot bind 0.0.0.0:80. Only
# a port whose handler points at Matrix's socket is turned off; other apps' ports stay.
stop_matrix_tailscale_serve() {
  local port
  command -v tailscale >/dev/null 2>&1 || return 0
  for port in $(timeout 30 tailscale serve status --json 2>>"$MATRIX_INSTALL_LOG" | matrix_serve_ports); do
    case "$port" in
      80) timeout 30 tailscale serve --http=80 off >>"$MATRIX_INSTALL_LOG" 2>&1 || warn "could not turn off Tailscale Serve on port 80" ;;
      443) timeout 30 tailscale serve --https=443 off >>"$MATRIX_INSTALL_LOG" 2>&1 || warn "could not turn off Tailscale Serve on port 443" ;;
    esac
  done
}

# matrix_serve_ports: reads `tailscale serve status --json`; prints each port
# whose handlers proxy to Matrix's tailnet socket.
matrix_serve_ports() {
  SOCKET="unix:${TAILNET_SOCKET}" python3 -I -c '
import json, os, sys
try:
    web = json.load(sys.stdin).get("Web") or {}
except ValueError:
    sys.exit(0)
for host, conf in web.items():
    handlers = (conf or {}).get("Handlers") or {}
    if any((h or {}).get("Proxy") == os.environ["SOCKET"] for h in handlers.values()):
        print(host.rsplit(":", 1)[-1])
'
}

configure_private_network() {
  [ "$OPT_ACCESS" != "public" ] || return 0
  section "Connecting your private network (${OPT_ACCESS})"
  install_tailscale
  run_required "starting tailscaled" systemctl enable --now tailscaled
  # Lets the Matrix gateway (running as the owner) show status and start logins without root.
  run_required "letting ${MATRIX_RUN_USER} manage Tailscale" timeout 30 tailscale set "--operator=${MATRIX_RUN_USER}"
  tailscale_login
  record_tailscale_owner
}

# Native units the browser lifecycle enables (matrix-browser-runtime.py service_names).
BROWSER_NATIVE_UNITS=(matrix-browser-lab-vnc.service matrix-browser-lab-wm.service matrix-browser-lab-desktop.service matrix-browser-lab-panel.service matrix-browser-lab-chrome.service matrix-browser-lab.service)

# browser_lab_value <on|off> <saved MATRIX_BROWSER_LAB>: the value write_env records.
# Opting out writes false, which the gateway and lifecycle both honor. Opting back in
# clears a saved false; the lifecycle writes true once Chrome passes its health check.
browser_lab_value() {
  if [ "$1" != "on" ]; then
    printf 'false\n'
  elif [ -n "$2" ] && [ "$2" != "false" ]; then
    printf '%s\n' "$2"
  fi
  return 0
}

# Stops a previous browser install on --no-browser. Keeps /opt/matrix-browser-lab,
# the Chrome profile and the viewer credentials, so opting back in resumes signed in.
stop_browser_use() {
  local unit_dir="${MATRIX_SYSTEMD_UNIT_DIR:-/etc/systemd/system}" unit
  # The lifecycle goes first so it cannot restart Chrome behind the opt-out.
  for unit in matrix-browser-runtime.service "${BROWSER_NATIVE_UNITS[@]}"; do
    [ -e "${unit_dir}/${unit}" ] || continue
    timeout 120 systemctl disable --now "$unit" >>"$MATRIX_INSTALL_LOG" 2>&1 \
      || warn "could not stop ${unit}; run: sudo systemctl disable --now ${unit}"
  done
  return 0
}

# The browser desktop runs as a dedicated account. It is in neither the matrix
# group (host.env and postgres.env hold MATRIX_AUTH_TOKEN and DATABASE_URL) nor
# the docker group (root), so a compromised browser reaches no owner secret. It
# gets its own lingering user manager (the desktop's Files/Terminal buttons need
# its user bus) and a private home; it never gains access to the owner's home.
# migrate_browser_profile <account> <home>: keep saved logins from a matrix-run browser.
# Root never writes in the account's (link-swappable) home: it stages and chowns the
# profile in a root-owned directory; the account itself moves it into place.
migrate_browser_profile() {
  local account="$1" home="$2" root="${MATRIX_LEGACY_BROWSER_ROOT:-/home/matrix}" user="${MATRIX_LEGACY_BROWSER_USER:-matrix}"
  local stage="${MATRIX_BROWSER_PROFILE_STAGE:-/var/lib/matrix-browser-profile-move}" old new staged group
  new="${home}/.local/share/matrix-browser-lab/chrome"
  old="${root}/.local/share/matrix-browser-lab/chrome"
  staged="${stage}/${account}/chrome"
  group="$(id -gn "$account")"
  if [ -e "$new" ] || [ -L "$new" ]; then
    # A boot after staging may have created a fresh profile; the staged one is the
    # owner's saved sessions, so it wins and the fresh one is kept aside.
    [ -d "$staged" ] && [ ! -L "$staged" ] && [ ! -L "${stage}/${account}" ] && [ ! -L "$stage" ] || return 0
    systemctl stop matrix-browser-lab-chrome.service >>"$MATRIX_INSTALL_LOG" 2>&1 || true
    run_required "keeping the fresh browser profile aside" runuser -u "$account" -- mv -T "$new" "${new}.replaced-$(date +%s)"
  fi
  # A move that stopped after staging resumes; a staged profile is never deleted.
  if [ ! -d "$staged" ] || [ -L "$staged" ] || [ -L "${stage}/${account}" ] || [ -L "$stage" ]; then
    [ -d "$old" ] || return 0
    old="$(readlink -f "$old")"
    case "$old" in
      "$root"/*) ;;
      *) warn "the saved browser profile is outside ${root}; starting a new one"; return 0 ;;
    esac
    [ "$(stat -c %U "$old")" = "$user" ] || { warn "the saved browser profile is not owned by ${user}; starting a new one"; return 0; }
    systemctl stop matrix-browser-lab-chrome.service >>"$MATRIX_INSTALL_LOG" 2>&1 || true
    install -d -o root -g root -m 0711 "$stage"
    install -d -o "$account" -g "$group" -m 0700 "${stage}/${account}"
    run_required "moving the saved browser profile" mv -T "$old" "$staged"
  fi
  run_required "giving the saved browser profile to the browser account" chown -R --no-dereference "${account}:${group}" "$staged"
  run_required "preparing the browser account's profile folder" runuser -u "$account" -- mkdir -p "${home}/.local/share/matrix-browser-lab"
  run_required "placing the saved browser profile" runuser -u "$account" -- mv -T "$staged" "$new"
  rmdir "${stage}/${account}" "$stage" 2>>"$MATRIX_INSTALL_LOG" || warn "could not remove the empty staging folder ${stage}"
  ok "Kept your saved browser sessions"
}

prepare_browser_account() {
  local home="${MATRIX_BROWSER_ACCOUNT_HOME:-/var/lib/matrix-browser}" account="$MATRIX_BROWSER_ACCOUNT" group primary
  if ! id "$account" >/dev/null 2>&1; then
    run_required "creating the browser account" useradd --system --user-group --home-dir "$home" --shell /usr/sbin/nologin "$account"
  fi
  for group in $(id -nG "$account"); do
    case "$group" in
      matrix | docker) run_required "removing the browser account from the ${group} group" gpasswd -d "$account" "$group" ;;
    esac
  done
  primary="$(id -gn "$account")"
  case "$primary" in
    matrix | docker) fail "the browser account ${account} has primary group ${primary}; give it its own group" ;;
  esac
  [ -d "$home" ] || install -d -o "$account" -g "$primary" -m 0700 "$home"
  migrate_browser_profile "$account" "$home"
  run_required "keeping the browser account's session" loginctl enable-linger "$account"
  run_required "starting the browser account's session" systemctl start "user@$(id -u "$account").service"
}

# render_browser_isolation <account>: the browser account shares loopback with
# owner services (code-server runs as the owner with --auth none; the shell proxy
# adds the gateway bearer) and could reach this machine's own tailnet name. An
# owner-matched nftables table refuses its new connections to loopback and the
# tailnet, except DNS (the systemd-resolved stub and Tailscale/Headscale's
# MagicDNS resolver, port 53 only) and the browser stack's own ports (Xvnc 6901, supervisor
# 8730, Chrome CDP 9222); replies on connections others opened stay allowed.
render_browser_isolation() {
  cat <<EOF
table inet matrix_browser_isolation {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid != "$1" accept
    ct state established,related accept
    ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept
    ip daddr 100.100.100.100 meta l4proto { tcp, udp } th dport 53 accept
    ip6 daddr fd7a:115c:a1e0::53 meta l4proto { tcp, udp } th dport 53 accept
    ip daddr 127.0.0.1 tcp dport { 6901, 8730, 9222 } accept
    ip daddr 127.0.0.0/8 reject
    ip6 daddr ::1 reject
    ip daddr 100.64.0.0/10 reject
    ip6 daddr fd7a:115c:a1e0::/48 reject
  }
}
EOF
}

# Each browser unit, its lifecycle and the account's user manager are bound to
# the table: none starts without it, and all stop if it stops.
render_browser_isolation_dropin() {
  printf '[Unit]\nBindsTo=matrix-browser-isolation.service\nAfter=matrix-browser-isolation.service\n'
}

render_browser_isolation_unit() {
  cat <<'EOF'
[Unit]
Description=Matrix browser account network isolation
Before=matrix-browser-runtime.service matrix-browser-lab-vnc.service matrix-browser-lab-wm.service matrix-browser-lab-desktop.service matrix-browser-lab-panel.service matrix-browser-lab-chrome.service matrix-browser-lab.service
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet matrix_browser_isolation
ExecStart=/usr/sbin/nft -f /etc/matrix/browser-isolation.nft
ExecStop=/usr/sbin/nft delete table inet matrix_browser_isolation
[Install]
WantedBy=multi-user.target
EOF
}

# install_browser_isolation: applied now and at every boot before the browser units.
install_browser_isolation() {
  local unit_dir="${MATRIX_SYSTEMD_UNIT_DIR:-/etc/systemd/system}" uid unit
  # Tests point this elsewhere; matrix-browser-isolation.service loads the default.
  local table="${MATRIX_BROWSER_ISOLATION_FILE:-/etc/matrix/browser-isolation.nft}"
  uid="$(id -u "$MATRIX_BROWSER_ACCOUNT")" || return 1
  for unit in matrix-browser-runtime.service "${BROWSER_NATIVE_UNITS[@]}" "user@${uid}.service"; do
    install -d -m 0755 "${unit_dir}/${unit}.d" || return 1
    render_browser_isolation_dropin >"${unit_dir}/${unit}.d/matrix-isolation.conf" || return 1
  done
  install -d -o root -g root -m 0755 "${table%/*}"
  render_browser_isolation "$MATRIX_BROWSER_ACCOUNT" >"$table" || return 1
  render_browser_isolation_unit >"${unit_dir}/matrix-browser-isolation.service" || return 1
  systemctl daemon-reload >>"$MATRIX_INSTALL_LOG" 2>&1 || return 1
  systemctl enable matrix-browser-isolation.service >>"$MATRIX_INSTALL_LOG" 2>&1 || return 1
  systemctl restart matrix-browser-isolation.service >>"$MATRIX_INSTALL_LOG" 2>&1 || return 1
  nft list table inet matrix_browser_isolation >/dev/null 2>&1 || return 1
  # user@<uid> is BindsTo= the table, so the restart above stopped the browser
  # account's user manager; the desktop's Files/Terminal buttons need its bus.
  systemctl start "user@${uid}.service" >>"$MATRIX_INSTALL_LOG" 2>&1 || return 1
  systemctl is-active --quiet "user@${uid}.service"
}

configure_browser() {
  if [ "$OPT_BROWSER" != "on" ]; then
    rm -f /etc/sudoers.d/matrix-browser-runtime
    stop_browser_use
    return 0
  fi
  section "Setting up browser use"
  if [ ! -f /opt/matrix/bin/matrix-browser-runtime.py ] || [ ! -f /opt/matrix/systemd/matrix-browser-runtime.service ]; then
    warn "this Matrix bundle has no browser runtime; browser use stays off"
    return 0
  fi
  install -d -o root -g root -m 0755 /usr/local/libexec
  install -o root -g root -m 0644 /opt/matrix/bin/matrix-browser-runtime.py /usr/local/libexec/matrix-browser-runtime.py
  install -m 0644 /opt/matrix/systemd/matrix-browser-runtime.service /etc/systemd/system/matrix-browser-runtime.service
  render_browser_sudoers "$MATRIX_RUN_USER" >/etc/sudoers.d/.matrix-browser-runtime.tmp
  chmod 0440 /etc/sudoers.d/.matrix-browser-runtime.tmp
  if visudo -cf /etc/sudoers.d/.matrix-browser-runtime.tmp >>"$MATRIX_INSTALL_LOG" 2>&1; then
    mv -f /etc/sudoers.d/.matrix-browser-runtime.tmp /etc/sudoers.d/matrix-browser-runtime
  else
    rm -f /etc/sudoers.d/.matrix-browser-runtime.tmp
    warn "browser use sudoers rule failed validation; Settings cannot show browser setup status"
  fi
  run_required "reloading systemd" systemctl daemon-reload
  # The lifecycle stays off until the profile move has finished, so a reboot
  # mid-move cannot start Chrome on a fresh profile.
  systemctl disable --now matrix-browser-runtime >>"$MATRIX_INSTALL_LOG" 2>&1 || true
  prepare_browser_account
  install_browser_isolation || { warn "could not isolate the browser account from this computer's services; browser use stays off"; stop_browser_use; return 0; }
  systemctl enable matrix-browser-runtime >>"$MATRIX_INSTALL_LOG" 2>&1 || true
  log "Installing Chrome and the browser desktop (this can take several minutes)"
  if timeout 1800 /opt/matrix/bin/matrix-install-browser >>"$MATRIX_INSTALL_LOG" 2>&1 \
    && timeout 60 /opt/matrix/bin/matrix-install-browser --health-check >>"$MATRIX_INSTALL_LOG" 2>&1; then
    ok "Browser use is ready"
  else
    warn "browser use setup failed; Matrix OS core is still installed. It retries at boot; details: journalctl -u matrix-browser-runtime -n 100 --no-pager"
  fi
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
    apt-get install -y acl bubblewrap ca-certificates curl docker.io git nftables nginx openssl postgresql-client procps socat sudo tar zsh >>"$MATRIX_INSTALL_LOG" 2>&1 \
      || fail "apt-get install failed"
    configure_bwrap_apparmor
    ok "OS packages installed"
    return
  fi
  fail "only apt-based Linux distributions are supported in this preview"
}

ensure_matrix_user() {
  local service_shell
  section "Preparing the Matrix OS account (${MATRIX_RUN_USER})"
  if ! getent group matrix >/dev/null 2>&1; then
    run_required "creating matrix group" groupadd --system matrix
  fi
  if ! getent group docker >/dev/null 2>&1; then
    run_required "creating docker group" groupadd --system docker
  fi
  # The matrix account runs Matrix on legacy installs; the browser desktop has its own account.
  service_shell=/usr/sbin/nologin
  [ "$MATRIX_RUN_USER" != "matrix" ] || service_shell=/bin/bash
  if ! id matrix >/dev/null 2>&1; then
    run_required "creating matrix user" useradd --system --gid matrix --groups docker --home-dir /home/matrix --shell "$service_shell" matrix
  else
    run_required "updating matrix user groups" usermod -aG docker matrix
  fi
  if [ "$MATRIX_RUN_USER" != "matrix" ]; then
    if ! id "$MATRIX_RUN_USER" >/dev/null 2>&1; then
      run_required "creating ${MATRIX_RUN_USER}" useradd --create-home --shell /bin/bash "$MATRIX_RUN_USER"
      MATRIX_RUN_GROUP="$(id -gn "$MATRIX_RUN_USER")"
      MATRIX_RUN_USER_HOME="$(passwd_entry "$MATRIX_RUN_USER" | cut -d: -f6)"
    fi
    run_required "adding ${MATRIX_RUN_USER} to the matrix and docker groups" usermod -aG matrix,docker "$MATRIX_RUN_USER"
  fi

  install -d -o root -g matrix -m 0770 /opt/matrix
  install -d -o root -g matrix -m 0750 /opt/matrix/env /opt/matrix/bin /opt/matrix/tls
  install -d -o matrix -g matrix -m 0755 /home/matrix
  install -d -o "$MATRIX_RUN_USER" -g "$MATRIX_RUN_GROUP" -m 0755 "$MATRIX_HOME_DIR"
  # A separate owner's projects are private to them and the matrix group;
  # prepare_scope_runtime_roots creates them 2750 before any service starts.
  if [ "$MATRIX_RUN_USER" = "matrix" ]; then
    install -d -o "$MATRIX_RUN_USER" -g "$MATRIX_RUN_GROUP" -m 0755 "$MATRIX_HOME_DIR/projects"
  fi
  install -d -o "$MATRIX_RUN_USER" -g "$MATRIX_RUN_GROUP" -m 0755 "$MATRIX_HOME_DIR/.local" "$MATRIX_HOME_DIR/.local/bin" "$MATRIX_HOME_DIR/.local/share"
  install -d -o "$MATRIX_RUN_USER" -g "$MATRIX_RUN_GROUP" -m 0755 "$MATRIX_HOME_DIR/.cache" "$MATRIX_HOME_DIR/.config"
  if [ "$MATRIX_RUN_USER" = "matrix" ]; then
    run_required "setting matrix home directory" usermod -d "$MATRIX_HOME_DIR" matrix
  fi
  ok "Matrix OS account ready"
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

# self_host_shell_origin <access> <tailnet url> <saved SHELL_ORIGIN>: the browser
# origin the gateway trusts. Without it a self-host gateway trusts only
# app.matrix-os.com, so pages opened at the printed tailnet link are refused.
self_host_shell_origin() {
  local pattern='^https?://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?$'
  if [ "$1" != "public" ] && [[ "$2" =~ $pattern ]]; then
    printf '%s\n' "$2"
  elif [[ "$3" =~ $pattern ]]; then
    printf '%s\n' "$3"
  elif [ "$1" = "public" ] && [[ "${4:-}" =~ $pattern ]]; then
    # The public address the install summary prints (MATRIX_DOMAIN, else this server's address).
    printf '%s\n' "$4"
  fi
  return 0
}

# public_ui_origin: the address a public install's summary prints.
public_ui_origin() {
  local ip
  if [ "$MATRIX_DOMAIN" != "_" ]; then
    printf 'http://%s\n' "$MATRIX_DOMAIN"
    return 0
  fi
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$ip" ] || printf 'http://%s\n' "$ip"
}

write_env() {
  local access
  access="$(env_access_mode)"
  local OPT_ACCESS="$access"
  local auth_token code_token postgres_password funded_ai_enabled funded_ai_relay_url funded_ai_runtime_token platform_internal_url
  local platform_speech_enabled platform_speech_origin platform_speech_runtime_token
  local browser_lab browser_viewer_auth skip_legacy_migration shell_origin saved_origin
  auth_token="$(read_env_value /opt/matrix/env/host.env MATRIX_AUTH_TOKEN || random_secret)"
  code_token="$(read_env_value /opt/matrix/env/host.env MATRIX_CODE_PROXY_TOKEN || random_secret)"
  postgres_password="$(read_env_value /opt/matrix/env/postgres.env POSTGRES_PASSWORD || random_secret | tr '/+' 'ab')"
  funded_ai_enabled="$(read_env_value /opt/matrix/env/host.env MATRIX_FUNDED_AI_ENABLED || printf 'false')"
  funded_ai_relay_url="$(read_env_value /opt/matrix/env/host.env MATRIX_FUNDED_AI_RELAY_URL || true)"
  funded_ai_runtime_token="$(read_env_value /opt/matrix/env/host.env MATRIX_FUNDED_AI_RUNTIME_TOKEN || true)"
  platform_internal_url="$(read_env_value /opt/matrix/env/host.env PLATFORM_INTERNAL_URL || true)"
  platform_speech_enabled="$(read_env_value /opt/matrix/env/host.env MATRIX_PLATFORM_SPEECH_ENABLED || printf 'false')"
  platform_speech_origin="$(read_env_value /opt/matrix/env/host.env MATRIX_PLATFORM_SPEECH_ORIGIN || true)"
  platform_speech_runtime_token="$(read_env_value /opt/matrix/env/host.env MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN || true)"
  # Written by the browser lifecycle; dropping them would break its credential pair.
  browser_lab="$(read_env_value /opt/matrix/env/host.env MATRIX_BROWSER_LAB || true)"
  browser_viewer_auth="$(read_env_value /opt/matrix/env/host.env MATRIX_BROWSER_LAB_VIEWER_AUTH || true)"
  if [ -z "$MATRIX_TAILSCALE_OWNER_LOGIN" ]; then
    MATRIX_TAILSCALE_OWNER_LOGIN="$(read_env_value /opt/matrix/env/host.env MATRIX_TAILSCALE_OWNER_LOGIN || true)"
  fi
  if [ -z "$MATRIX_TAILNET_URL" ]; then
    MATRIX_TAILNET_URL="$(read_env_value /opt/matrix/env/host.env MATRIX_TAILNET_URL || true)"
  fi
  browser_lab="$(browser_lab_value "$OPT_BROWSER" "$browser_lab")"
  saved_origin="$(read_env_value /opt/matrix/env/host.env SHELL_ORIGIN || true)"
  if [ "$OPT_ACCESS" = "public" ]; then
    # A rollback to public restores the public origin, never the tailnet one.
    [ "$PREVIOUS_ACCESS_MODE" != "public" ] || saved_origin="${PREVIOUS_SHELL_ORIGIN:-$saved_origin}"
    [ -z "$MATRIX_TAILNET_URL" ] || [ "$saved_origin" != "$MATRIX_TAILNET_URL" ] || saved_origin=""
  fi
  shell_origin="$(self_host_shell_origin "$OPT_ACCESS" "$MATRIX_TAILNET_URL" "$saved_origin" "$(public_ui_origin)")"
  skip_legacy_migration=0
  [ "$MATRIX_RUN_USER" = "matrix" ] || skip_legacy_migration=1

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
MATRIX_NODE_PREFIX=/opt/matrix/runtime/node
MATRIX_DEVELOPER_TOOLS='${MATRIX_DEVELOPER_TOOLS}'
MATRIX_IMAGE_VERSION=${DEFAULT_CHANNEL}
MATRIX_UPDATE_CHANNEL=${DEFAULT_CHANNEL}
MATRIX_AUTH_TOKEN=${auth_token}
MATRIX_CODE_PROXY_TOKEN=${code_token}
MATRIX_FUNDED_AI_ENABLED=${funded_ai_enabled}
MATRIX_FUNDED_AI_RELAY_URL=${funded_ai_relay_url}
MATRIX_FUNDED_AI_RUNTIME_TOKEN=${funded_ai_runtime_token}
MATRIX_PLATFORM_SPEECH_ENABLED=${platform_speech_enabled}
MATRIX_PLATFORM_SPEECH_ORIGIN=${platform_speech_origin}
MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN=${platform_speech_runtime_token}
PLATFORM_INTERNAL_URL=${platform_internal_url}
MATRIX_HOST_BUNDLE_URL=${MATRIX_HOST_BUNDLE_URL}
MATRIX_HOME=${MATRIX_HOME_DIR}
DATABASE_URL=postgresql://matrix:${postgres_password}@127.0.0.1:5432/matrix
GATEWAY_URL=http://127.0.0.1:4000
NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:4000
NEXT_PUBLIC_GATEWAY_WS=/ws
MATRIX_BIND_HOST=127.0.0.1
MATRIX_RUNTIME_USER=${MATRIX_RUN_USER}
MATRIX_RUNTIME_GROUP=${MATRIX_RUN_GROUP}
MATRIX_SKIP_LEGACY_HOME_MIGRATION=${skip_legacy_migration}
MATRIX_ACCESS_MODE=${OPT_ACCESS}
MATRIX_TAILSCALE_LOGIN_SERVER=${OPT_LOGIN_SERVER}
MATRIX_TAILSCALE_OWNER_LOGIN=${MATRIX_TAILSCALE_OWNER_LOGIN}
MATRIX_TAILNET_URL=${MATRIX_TAILNET_URL}
MATRIX_HERDR=${OPT_HERDR:-off}
MATRIX_HERDR_CORE_BIN=${MATRIX_HERDR_CORE_BIN}
MATRIX_BROWSER_ACCOUNT=${MATRIX_BROWSER_ACCOUNT}
EOF
  if [ -n "$browser_lab" ]; then
    printf 'MATRIX_BROWSER_LAB=%s\n' "$browser_lab" >>/opt/matrix/env/host.env
  fi
  if [ -n "$browser_viewer_auth" ]; then
    printf 'MATRIX_BROWSER_LAB_VIEWER_AUTH=%s\n' "$browser_viewer_auth" >>/opt/matrix/env/host.env
  fi
  if [ -n "$shell_origin" ]; then
    printf 'SHELL_ORIGIN=%s\n' "$shell_origin" >>/opt/matrix/env/host.env
  fi
  chmod 0640 /opt/matrix/env/host.env
  chown root:matrix /opt/matrix/env/host.env
}

# As root, tar keeps the build machine's numeric owner and modes; the terminal
# runtime and browser lifecycle trust only root-owned files that no group or other
# account can write. A fixed umask keeps that true under a permissive sudo umask.
extract_bundle() {
  (umask 022 && tar --no-same-owner --no-same-permissions -xzf "$1" -C "$2")
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
  extract_bundle "$tmp_bundle" /opt/matrix
  chmod 0755 /opt/matrix/bin/matrix-* /opt/matrix/bin/zellij 2>/dev/null || true
  if [ -f /opt/matrix/bin/matrix-claude-native-recovery.py ] && [ ! -L /opt/matrix/bin/matrix-claude-native-recovery.py ]; then
    install -d -o root -g root -m 0755 /usr/local/libexec/matrix-claude-native-recovery
    install -o root -g root -m 0644 /opt/matrix/bin/matrix-claude-native-recovery.py /usr/local/libexec/matrix-claude-native-recovery/launch.py
  fi
  cleanup_install_tmp
  INSTALL_TMP_BUNDLE=""
  INSTALL_TMP_SUM=""
}

# Managed computers write app/BUNDLE_VERSION at first boot (cloud-init); browser
# use and Settings > Updates read it. release.json stays the root-owned record.
write_bundle_version() {
  local root="${1:-/opt/matrix}" owner="${2:-$MATRIX_RUN_USER}" version
  version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]\{1,128\}\)".*/\1/p' "$root/release.json" | head -n 1)"
  # Builder formats: a v-tag, or `git describe --always --dirty` (bare hash, maybe
  # -dirty). The value becomes a file's contents and a path component elsewhere,
  # so keep it a bounded, slash-free name that cannot start a flag or a dotfile.
  { [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$ ]] && [[ "$version" != *..* ]]; } \
    || fail "the host bundle has no valid version"
  printf '%s\n' "$version" >"$root/app/BUNDLE_VERSION"
  chown "$owner:" "$root/app/BUNDLE_VERSION"
  chmod 0644 "$root/app/BUNDLE_VERSION"
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
  {
    cat <<'EOF'
[Unit]
Description=Matrix OS standalone database gate
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
EOF
    printf 'User=%s\nGroup=%s\nSupplementaryGroups=matrix docker\n' "$MATRIX_RUN_USER" "$MATRIX_RUN_GROUP"
    cat <<'EOF'
EnvironmentFile=/opt/matrix/env/host.env
EnvironmentFile=/opt/matrix/env/postgres.env
ExecStart=/bin/bash -lc 'set -euo pipefail; if docker ps --format "{{.Names}}" | grep -qx matrix-postgres; then :; elif docker ps -a --format "{{.Names}}" | grep -qx matrix-postgres; then docker start matrix-postgres >/dev/null; else docker volume create matrix-postgres >/dev/null; docker run -d --name matrix-postgres --restart unless-stopped --env-file /opt/matrix/env/postgres.env -v matrix-postgres:/var/lib/postgresql/data -p 127.0.0.1:5432:5432 postgres:16 >/dev/null; fi; for _ in $(seq 1 60); do pg_isready --host=127.0.0.1 --username="${POSTGRES_USER:-matrix}" --dbname="${POSTGRES_DB:-matrix}" >/dev/null 2>&1 && break; sleep 2; done; pg_isready --host=127.0.0.1 --username="${POSTGRES_USER:-matrix}" --dbname="${POSTGRES_DB:-matrix}" >/dev/null 2>&1; touch /opt/matrix/restore-complete'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  } >/etc/systemd/system/matrix-restore.service
}

# Shipped units keep their managed defaults; self-host overrides only the account (spec 2701 S1).
write_run_user_dropins() {
  local unit dir
  for unit in matrix-terminal-runtime matrix-gateway matrix-shell matrix-code; do
    dir="/etc/systemd/system/${unit}.service.d"
    if [ "$MATRIX_RUN_USER" = "matrix" ]; then
      rm -f "${dir}/10-self-host-run-user.conf"
      continue
    fi
    install -d -o root -g root -m 0755 "$dir"
    render_run_user_dropin "$MATRIX_RUN_USER" "$MATRIX_RUN_GROUP" >"${dir}/10-self-host-run-user.conf"
    chmod 0644 "${dir}/10-self-host-run-user.conf"
  done
  dir=/etc/systemd/user/matrix-zellij@.service.d
  if [ "$MATRIX_HOME_DIR" = "/home/matrix/home" ]; then
    rm -f "${dir}/10-self-host-home.conf"
  else
    install -d -o root -g root -m 0755 "$dir"
    render_zellij_home_dropin "$MATRIX_HOME_DIR" >"${dir}/10-self-host-home.conf"
    chmod 0644 "${dir}/10-self-host-home.conf"
  fi
}

write_scope_runtime_dropin() {
  local dir=/etc/systemd/system/matrix-scope-runtime.service.d
  prepare_scope_runtime_roots "$MATRIX_HOME_DIR" "$MATRIX_RUN_USER"
  if [ "$MATRIX_HOME_DIR" = "/home/matrix/home" ]; then
    rm -f "${dir}/10-self-host-home.conf"
    return 0
  fi
  install -d -o root -g root -m 0755 "$dir"
  render_scope_runtime_home_dropin "$MATRIX_HOME_DIR" >"${dir}/10-self-host-home.conf"
  chmod 0644 "${dir}/10-self-host-home.conf"
}

install_terminal_user_units() {
  local run_uid
  run_uid="$(id -u "$MATRIX_RUN_USER")"
  install -d -o root -g root -m 0755 /etc/systemd/user
  install -m 0644 /opt/matrix/user-systemd/matrix-zellij@.service /etc/systemd/user/matrix-zellij@.service
  install -m 0644 /opt/matrix/user-systemd/matrix-terminal.slice /etc/systemd/user/matrix-terminal.slice
  write_run_user_dropins
  run_required "enabling ${MATRIX_RUN_USER} user manager persistence" loginctl enable-linger "$MATRIX_RUN_USER"
  run_required "starting ${MATRIX_RUN_USER} user manager" systemctl start "user@${run_uid}.service"
  run_required "reloading ${MATRIX_RUN_USER} user systemd" runuser -u "$MATRIX_RUN_USER" -- env \
    HOME="$MATRIX_HOME_DIR" \
    XDG_RUNTIME_DIR="/run/user/${run_uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${run_uid}/bus" \
    systemctl --user daemon-reload
}

install_systemd_units() {
  section "Installing systemd units"
  install -m 0644 /opt/matrix/systemd/matrix-gateway.service /etc/systemd/system/matrix-gateway.service
  install -m 0644 /opt/matrix/systemd/matrix-terminal-runtime.service /etc/systemd/system/matrix-terminal-runtime.service
  install -m 0644 /opt/matrix/systemd/matrix-scope-runtime.service /etc/systemd/system/matrix-scope-runtime.service
  write_scope_runtime_dropin
  install -m 0644 /opt/matrix/systemd/matrix-shell.service /etc/systemd/system/matrix-shell.service
  install -m 0644 /opt/matrix/systemd/matrix-code.service /etc/systemd/system/matrix-code.service
  install -m 0644 /opt/matrix/systemd/matrix-code-server.service /etc/systemd/system/matrix-code-server.service
  if [ -f /opt/matrix/systemd/matrix-developer-tools.service ]; then
    install -m 0644 /opt/matrix/systemd/matrix-developer-tools.service /etc/systemd/system/matrix-developer-tools.service
  fi
  install_terminal_user_units
  write_self_host_restore_service
  run_required "reloading systemd" systemctl daemon-reload
  run_required "enabling Matrix OS services" systemctl enable docker matrix-restore matrix-terminal-runtime matrix-scope-runtime matrix-gateway matrix-shell matrix-code matrix-code-server
  if [ -f /etc/systemd/system/matrix-developer-tools.service ] && [ -n "$MATRIX_DEVELOPER_TOOLS" ]; then
    run_required "enabling optional developer tools service" systemctl enable matrix-developer-tools
  fi
  ok "Systemd units installed"
}

configure_nginx() {
  local auth_token code_proxy_token password hash server_name htpasswd_file legacy_htpasswd_file browser_viewer site next
  auth_token="$(read_env_value /opt/matrix/env/host.env MATRIX_AUTH_TOKEN)" || fail "MATRIX_AUTH_TOKEN is missing from host.env"
  code_proxy_token="$(read_env_value /opt/matrix/env/host.env MATRIX_CODE_PROXY_TOKEN)" || fail "MATRIX_CODE_PROXY_TOKEN is missing from host.env"
  server_name="$MATRIX_DOMAIN"
  htpasswd_file="/etc/nginx/matrix-self-host.htpasswd"
  legacy_htpasswd_file="/opt/matrix/env/nginx.htpasswd"

  if [ "$OPT_ACCESS" = "public" ]; then
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
  fi
  [ "$OPT_ACCESS" = "public" ] || prepare_tailnet_socket_dir
  printf 'proxy_set_header Authorization "Bearer %s";\n' "$auth_token" >/opt/matrix/env/gateway-auth-token.conf
  chmod 0600 /opt/matrix/env/gateway-auth-token.conf
  chown root:root /opt/matrix/env/gateway-auth-token.conf
  printf 'proxy_set_header X-Matrix-Code-Proxy-Token "%s";\n' "$code_proxy_token" >/opt/matrix/env/code-proxy-token.conf
  chmod 0600 /opt/matrix/env/code-proxy-token.conf
  chown root:root /opt/matrix/env/code-proxy-token.conf

  browser_viewer=off
  [ "$OPT_BROWSER" != "on" ] || browser_viewer=on
  # Rendered beside the live site and swapped in with one rename; a public site
  # being replaced was saved by begin_private_cutover and comes back on failure.
  site=/etc/nginx/sites-available/matrix-self-host
  next="${site}.next"
  render_nginx_site "$OPT_ACCESS" "$server_name" "$htpasswd_file" "$browser_viewer" >"${next}" || { rm -f "${next}"; fail "could not write the nginx site"; }
  mv -f "${next}" "${site}"

  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/matrix-self-host /etc/nginx/sites-enabled/matrix-self-host
  run_required "testing nginx configuration" nginx -t
  run_required "enabling nginx" systemctl enable nginx
  ok "nginx configured"
}

# The person is usually logged in while installing. Their systemd --user
# manager (which also runs their Herdr core) keeps the groups it started with,
# so the new matrix group cannot open /opt/matrix until it restarts, and
# restarting it would end their Herdr terminals. ACL entries for the run user
# take effect at once. Default entries let files written later inherit them.
grant_run_user_access() {
  local user="$1" root="${2:-/opt/matrix}" setfacl_bin="${MATRIX_SETFACL:-setfacl}"
  [ "$user" != "matrix" ] || return 0
  # A named-user ACL entry is checked before any group, so it must carry the
  # same rights the matrix group has here (rwx), or the run user loses write.
  run_required "granting ${user} access to ${root}" "$setfacl_bin" -m "u:${user}:rwx" "$root"
  run_required "granting ${user} access to Matrix files" "$setfacl_bin" -R -m "u:${user}:rX" "$root/env" "$root/bin" "$root/tls"
  run_required "granting ${user} access to new Matrix files" "$setfacl_bin" -d -m "u:${user}:rX" "$root/env" "$root/tls"
}

start_services() {
  section "Starting Matrix OS services"
  run_required "starting docker" systemctl enable --now docker
  restart_required_service matrix-restore
  restart_required_service matrix-terminal-runtime
  restart_optional_service matrix-scope-runtime "collaboration scope runtime"
  restart_required_service matrix-gateway
  restart_required_service matrix-shell
  restart_optional_service matrix-code-server "code-server proxy"
  restart_optional_service matrix-code "code service"
  if systemctl list-unit-files matrix-developer-tools.service >/dev/null 2>&1; then
    restart_optional_service matrix-developer-tools "optional developer tools installer"
  fi
  restart_required_service nginx
}

wait_private_identity_ok() {
  local description url login log_hint code
  description="$1"
  url="$2"
  login="$3"
  log_hint="$4"
  for _ in $(seq 1 30); do
    # Through the Tailscale Serve socket, the only place nginx accepts an identity.
    code="$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" --max-time 5 --unix-socket "$TAILNET_SOCKET" -H "Tailscale-User-Login: ${login}" "$url" 2>>"$MATRIX_INSTALL_LOG" || true)"
    if [ "$code" = "200" ]; then
      ok "${description} is reachable"
      return 0
    fi
    if [ "$code" = "403" ] || [ "$code" = "500" ]; then
      private_access_failed "${description} returned HTTP ${code}. ${log_hint}"
    fi
    sleep 2
  done
  private_access_failed "${description} did not become reachable. ${log_hint}"
}

# Private modes: the web surface must not listen on a public interface.
verify_loopback_listeners() {
  local line address port
  command -v ss >/dev/null 2>&1 || { warn "ss is unavailable; could not confirm Matrix listens on loopback only"; return 0; }
  while IFS= read -r line; do
    address="$(printf '%s' "$line" | awk '{print $4}')"
    port="${address##*:}"
    address="${address%:*}"
    case "$port" in 80|3000|4000|8788) ;; *) continue ;; esac
    case "$address" in
      127.0.0.1|\[::1\]|100.*|\[fd7a:115c:a1e0:*) ;;
      *) fail "port ${port} listens on ${address}; with --access ${OPT_ACCESS} Matrix must only listen on loopback" ;;
    esac
  done < <(ss -H -ltn 2>/dev/null)
  ok "Matrix listens on loopback and your private network only"
}

# private_access_failed <message>: a switch from public restores the public
# listener before failing, so the owner keeps a reachable UI.
private_access_failed() {
  if [ "$PREVIOUS_ACCESS_MODE" = "public" ] && [ "$OPT_ACCESS" != "public" ]; then
    restore_previous_listener || fail "$1 Restoring public access failed: a WebSocket through nginx did not upgrade. Check: journalctl -u matrix-gateway -n 200 --no-pager"
    fail "$1 Kept your public listener; finish private-network sign-in, then rerun the installer."
  fi
  fail "$1"
}

# env_access_mode: the access mode host.env records. A public install switching
# to private stays recorded as public until the cutover begins, so a failure
# before it, or a flagless retry, keeps the public guard.
env_access_mode() {
  if [ "${PREVIOUS_ACCESS_MODE:-}" = "public" ] && [ "$OPT_ACCESS" != "public" ] && [ "$PRIVATE_CUTOVER" = "0" ]; then
    printf 'public\n'
  else
    printf '%s\n' "$OPT_ACCESS"
  fi
}

# begin_private_cutover: from here until private access is verified, a public
# install switching to private restores its public listener on any failed exit
# (fail, run_required, or set -e). Saves the live public site now, never an
# older run's copy.
begin_private_cutover() {
  local site="${MATRIX_NGINX_SITE_FILE:-/etc/nginx/sites-available/matrix-self-host}"
  local backup="${MATRIX_NGINX_SITE_BACKUP:-/etc/nginx/matrix-self-host.previous-site}"
  [ "$PREVIOUS_ACCESS_MODE" = "public" ] && [ "$OPT_ACCESS" != "public" ] || return 0
  rm -f "$backup"
  if [ -f "$site" ]; then
    run_required "saving the public nginx site" cp -f "$site" "$backup"
    PRIVATE_CUTOVER_BACKUP="$backup"
  fi
  PRIVATE_CUTOVER=1
}

end_private_cutover() {
  [ "$PRIVATE_CUTOVER" = "1" ] || return 0
  PRIVATE_CUTOVER=2
  [ -z "$PRIVATE_CUTOVER_BACKUP" ] || rm -f "$PRIVATE_CUTOVER_BACKUP"
  PRIVATE_CUTOVER_BACKUP=""
}

# rollback_failed_private_cutover <exit status>: run by the EXIT trap.
rollback_failed_private_cutover() {
  [ "$1" != "0" ] && [ "$PRIVATE_CUTOVER" = "1" ] || return 0
  warn "switching to private access failed; restoring your public listener"
  if restore_previous_listener; then
    ok "Kept your public listener; fix the error above, then rerun the installer."
  else
    warn "public access did not come back. Check: journalctl -u matrix-gateway -n 200 --no-pager; tail -120 /var/log/nginx/error.log"
  fi
}

# restore_previous_listener: the public site this run's begin_private_cutover
# saved (before the cutover the live site is still public and is left alone), the
# public mode and origin in host.env, and a gateway and shell running with them.
# Succeeds only once a WebSocket through public nginx upgrades (HTTP 101).
restore_previous_listener() {
  local site="${MATRIX_NGINX_SITE_FILE:-/etc/nginx/sites-available/matrix-self-host}"
  local backup="$PRIVATE_CUTOVER_BACKUP"
  # Restoring ends the cutover, so a failure after it does not restore again.
  PRIVATE_CUTOVER=0
  PRIVATE_CUTOVER_BACKUP=""
  stop_matrix_tailscale_serve
  if [ -n "$backup" ] && [ -f "$backup" ]; then
    cp -f "$backup" "$site"
    rm -f "$backup"
    # A restart, not a reload: a reload cannot trade 127.0.0.1:80 for 0.0.0.0:80.
    nginx -t >>"$MATRIX_INSTALL_LOG" 2>&1 && systemctl restart nginx >>"$MATRIX_INSTALL_LOG" 2>&1 \
      || warn "could not restore the public nginx site; see /var/log/nginx/error.log"
  fi
  OPT_ACCESS=public
  write_env
  systemctl restart matrix-gateway.service matrix-shell.service >>"$MATRIX_INSTALL_LOG" 2>&1 \
    || warn "could not restart matrix-gateway and matrix-shell"
  verify_public_websocket
}

# verify_public_websocket: a /ws upgrade through public nginx, with the UI
# password and the recorded browser origin, returns HTTP 101.
verify_public_websocket() {
  local password origin code attempt
  local -a page=()
  password="$(cat /opt/matrix/env/initial-ui-password 2>/dev/null || true)"
  origin="$(read_env_value /opt/matrix/env/host.env SHELL_ORIGIN || true)"
  [ -n "$password" ] || { warn "cannot check public WebSockets: no saved UI password"; return 1; }
  # Public nginx accepts a page's socket only when the Origin host[:port] is the Host.
  [ -z "$origin" ] || page=(-H "Origin: ${origin}" -H "Host: ${origin#*://}")
  for attempt in $(seq 1 30); do
    code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 --http1.1 --user "matrix:${password}" \
      -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
      -H "Sec-WebSocket-Key: bWF0cml4LW9zLWNoZWNrIQ==" "${page[@]}" \
      "http://127.0.0.1/ws" 2>>"$MATRIX_INSTALL_LOG" || true)"
    if [ "$code" = "101" ]; then
      ok "public access works: a WebSocket through nginx upgraded"
      return 0
    fi
    sleep 2
  done
  return 1
}

# verify_private_access: reports private access verified only after an
# authenticated request through Tailscale Serve.
verify_private_access() {
  local status
  status="$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1/" || true)"
  [ "$status" = "403" ] || private_access_failed "nginx private-network identity check returned HTTP ${status}, expected 403 without an owner identity."
  ok "nginx refuses requests without your private-network identity"
  status="$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" -H "Tailscale-User-Login: ${MATRIX_TAILSCALE_OWNER_LOGIN:-owner@example.com}" "http://127.0.0.1/" || true)"
  [ "$status" = "403" ] || private_access_failed "nginx accepted a private-network identity on its loopback listener (HTTP ${status}); only Tailscale Serve may present one."
  ok "nginx refuses a private-network identity on its loopback listener"
  if [ -z "$MATRIX_TAILSCALE_OWNER_LOGIN" ]; then
    [ "$PREVIOUS_ACCESS_MODE" != "public" ] || private_access_failed "no private-network owner has signed in."
    warn "private access is not verified: no owner has signed in yet. Sign in with: sudo tailscale up, then rerun the installer"
    return 0
  fi
  wait_private_identity_ok "nginx shell" "http://127.0.0.1/" "$MATRIX_TAILSCALE_OWNER_LOGIN" "Check: tail -120 /var/log/nginx/error.log; journalctl -u matrix-shell -n 200 --no-pager"
  wait_private_identity_ok "nginx gateway API" "http://127.0.0.1/api/identity" "$MATRIX_TAILSCALE_OWNER_LOGIN" "Check: tail -120 /var/log/nginx/error.log; journalctl -u matrix-gateway -n 200 --no-pager"
  ok "nginx accepts your private-network identity only through Tailscale Serve"
  verify_loopback_listeners
}

verify_services() {
  local password status
  section "Verifying Matrix OS"
  run_required "verifying matrix-terminal-runtime" systemctl is-active --quiet matrix-terminal-runtime
  ok "matrix-terminal-runtime is active"
  wait_terminal_runtime_ready
  wait_http_ok "Matrix gateway" "http://127.0.0.1:4000/health" "Check: journalctl -u matrix-gateway -n 200 --no-pager"
  wait_http_ok "Matrix shell" "http://127.0.0.1:3000/" "Check: journalctl -u matrix-shell -n 200 --no-pager"
  if [ "$OPT_ACCESS" != "public" ]; then
    verify_private_access
    return 0
  fi
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
  local ip password_line ui_url access_note cli_url
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "${MATRIX_PUBLIC_URL:-}" ]; then
    ui_url="$MATRIX_PUBLIC_URL"
  elif [ "$OPT_ACCESS" != "public" ] && [ -n "$MATRIX_TAILNET_URL" ]; then
    ui_url="$MATRIX_TAILNET_URL"
  elif [ "$OPT_ACCESS" != "public" ]; then
    ui_url="(finish the private-network login, then run: tailscale status)"
  elif [ "$MATRIX_DOMAIN" != "_" ]; then
    ui_url="http://${MATRIX_DOMAIN}"
  elif [ -n "$ip" ]; then
    ui_url="http://${ip}"
  else
    ui_url="http://<server-ip>"
  fi
  cli_url="${ui_url%/}/cli"
  if [ "$OPT_ACCESS" != "public" ]; then
    password_line="Sign-in: your ${OPT_ACCESS} account (${MATRIX_TAILSCALE_OWNER_LOGIN:-not connected yet})"
    access_note="Matrix is reachable only from devices on your private network signed in as you.
nginx listens on 127.0.0.1 only. Add devices or machines from Settings > System > Private network."
  else
    if [ -f /opt/matrix/env/initial-ui-password ]; then
      password_line="User: matrix
Password: $(cat /opt/matrix/env/initial-ui-password)"
    else
      password_line="User: matrix
Password: existing nginx Basic Auth credentials"
    fi
    access_note="${COLOR_YELLOW}${COLOR_BOLD}WARNING${COLOR_RESET} This install is reachable from the internet behind a password page
(nginx Basic Auth). Prefer --access tailscale or --access headscale; see
https://matrix-os.com/docs/self-host for the private-network setup."
  fi

  cat <<EOF

${COLOR_GREEN}${COLOR_BOLD}Matrix OS standalone install complete.${COLOR_RESET}

Open: ${ui_url}
${password_line}
Runs as: ${MATRIX_RUN_USER}
Browser use: ${OPT_BROWSER}
Herdr sessions: ${OPT_HERDR:-off}

Code editor: ${ui_url%/}/code/
CLI gateway: ${cli_url}
Home: ${MATRIX_HOME_DIR}

Useful commands:
  systemctl status matrix-terminal-runtime matrix-gateway matrix-shell matrix-code nginx --no-pager
  journalctl -u matrix-terminal-runtime -u matrix-gateway -u matrix-shell -u matrix-code -n 200 --no-pager
  sudo -iu ${MATRIX_RUN_USER}
  MATRIX_TOKEN=\$(sudo sed -n 's/^MATRIX_AUTH_TOKEN=//p' /opt/matrix/env/host.env)
  matrix shell ls --gateway ${cli_url} --token "\$MATRIX_TOKEN"

${access_note}
EOF
}

# Pairs this machine with an existing Matrix computer over the private network
# (spec 2701 "Private network and pairing"). The join code travels in the
# environment, never in a child's argv.
pair_with_primary() {
  local line state dns name identity_dir result
  [ -n "$OPT_JOIN_URL" ] || return 0
  section "Pairing with your Matrix computer"
  line="$(tailscale_status_line)"
  IFS=$'\t' read -r state dns _ _ <<<"$line"
  if [ "$state" != "Running" ] || ! [[ "$dns" =~ ^[A-Za-z0-9.-]{1,253}$ ]]; then
    warn "this machine is not on your private network yet, so it could not pair. Sign in (sudo tailscale up), then re-run the command from Settings > System > Add a machine"
    return 0
  fi
  name="${dns%%.*}"
  identity_dir="${MATRIX_HOME_DIR}/system/machine-identity"
  install -d -o "$MATRIX_RUN_USER" -g "$MATRIX_RUN_GROUP" -m 0700 "$identity_dir"
  if result="$(MATRIX_JOIN_URL="${OPT_JOIN_URL%/}" MATRIX_JOIN_CODE="$OPT_JOIN_CODE" MATRIX_JOIN_IDENTITY_DIR="$identity_dir" \
    MATRIX_JOIN_NAME="$name" MATRIX_JOIN_DNS_NAME="$dns" \
    timeout 60 runuser -u "$MATRIX_RUN_USER" --whitelist-environment=MATRIX_JOIN_URL,MATRIX_JOIN_CODE,MATRIX_JOIN_IDENTITY_DIR,MATRIX_JOIN_NAME,MATRIX_JOIN_DNS_NAME -- \
    "$(node_bin)" --input-type=module -e "$(pair_client_source)" 2>>"$MATRIX_INSTALL_LOG")"; then
    ok "Paired with ${result}"
  else
    warn "pairing failed; the join code may have expired. Create a new one in Settings > System > Add a machine and re-run the installer with it"
  fi
}

pair_client_source() {
  cat <<'EOF'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
const env = process.env;
const parsed = new URL(env.MATRIX_JOIN_URL ?? "");
// Plain HTTP is only for Headscale tailnets: the address must be loopback or on
// the tailnet, and both requests connect to that checked address (no second DNS
// answer can redirect the join code).
let pinned = null;
if (parsed.protocol === "http:") {
  const { address, family } = await lookup(parsed.hostname);
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^fd7a:115c:a1e0:/i.test(address);
  if (!tailnet && address !== "127.0.0.1" && address !== "::1") throw new Error("join URL is not on the private network");
  pinned = { address, family };
} else if (parsed.protocol !== "https:") {
  throw new Error("join URL");
}
const dir = env.MATRIX_JOIN_IDENTITY_DIR ?? "";
const keyPath = join(dir, "machine-ed25519.pem");
let privateKey;
try {
  privateKey = createPrivateKey(await readFile(keyPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const pair = generateKeyPairSync("ed25519");
  await writeFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  privateKey = pair.privateKey;
}
const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
function postPinned(url, payload) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      lookup: (_host, options, callback) => (options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)),
      timeout: 10_000,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; if (text.length > 16_384) req.destroy(new Error("pairing response too large")); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("timeout", () => req.destroy(new Error("pairing timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
async function call(path, body) {
  const url = `${parsed.origin}/api/system/private-network/pairing/${path}`;
  const payload = JSON.stringify(body);
  let status, text;
  if (pinned) {
    // A redirect is a non-2xx status here and fails like any other.
    ({ status, text } = await postPinned(url, payload));
  } else {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: payload,
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    text = await response.text();
  }
  if (status < 200 || status >= 300) throw new Error(`pairing ${path} ${status}`);
  if (text.length > 16_384) throw new Error("pairing response too large");
  return JSON.parse(text);
}
const joinCode = env.MATRIX_JOIN_CODE ?? "";
const name = env.MATRIX_JOIN_NAME ?? "";
const dnsName = env.MATRIX_JOIN_DNS_NAME ?? "";
const challenge = await call("challenge", { joinCode });
const message = ["matrix-machine-pair-v1", challenge.primaryMachineId, challenge.ownerId, challenge.challengeId, challenge.nonce, String(challenge.revision), publicKey, name, dnsName].join("\n");
const signature = sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
const result = await call("complete", { joinCode, challengeId: challenge.challengeId, publicKey, signature, name, dnsName });
const primary = { name: String(result.primary?.name ?? "").slice(0, 63), dnsName: String(result.primary?.dnsName ?? "").slice(0, 253), url: parsed.origin, pairedAt: new Date().toISOString() };
const target = join(dir, "paired-primary.json");
await writeFile(`${target}.tmp`, JSON.stringify(primary, null, 2) + "\n", { mode: 0o600 });
await rename(`${target}.tmp`, target);
process.stdout.write(`${primary.name || parsed.hostname}\n`);
EOF
}

main() {
  INSTALL_PHASE="preflight"
  parse_args "$@"
  banner
  require_root
  require_linux_systemd
  validate_config
  resolve_run_user
  ask_install_choices
  capture_install_telemetry "matrix_manual_install_started" "started" 0
  preflight_bundle_url
  INSTALL_PHASE="packages"
  install_packages
  INSTALL_PHASE="user"
  ensure_matrix_user
  detect_herdr
  INSTALL_PHASE="env"
  write_env
  INSTALL_PHASE="bundle"
  install_bundle
  INSTALL_PHASE="runtime_permissions"
  write_bundle_version /opt/matrix "$MATRIX_RUN_USER"
  prepare_runtime_permissions
  INSTALL_PHASE="systemd"
  install_systemd_units
  INSTALL_PHASE="private_network"
  configure_private_network
  # First: an HTTP fallback changes the tailnet address recorded for the gateway.
  [ "$OPT_ACCESS" = "public" ] || configure_tailscale_serve
  require_private_access_ready
  begin_private_cutover
  write_env
  INSTALL_PHASE="nginx"
  [ "$OPT_ACCESS" != "public" ] || stop_matrix_tailscale_serve
  configure_nginx
  grant_run_user_access "$MATRIX_RUN_USER"
  INSTALL_PHASE="services"
  start_services
  INSTALL_PHASE="browser"
  configure_browser
  INSTALL_PHASE="verify"
  verify_services
  end_private_cutover
  INSTALL_PHASE="pairing"
  pair_with_primary
  INSTALL_PHASE="complete"
  INSTALL_COMPLETED=1
  capture_install_telemetry "matrix_manual_install_completed" "completed" 0
  print_summary
}

# Tests source the functions without running an install.
[ "${MATRIX_INSTALL_SOURCE_ONLY:-0}" = "1" ] || main "$@"

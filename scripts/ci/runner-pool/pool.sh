#!/usr/bin/env bash
# Ephemeral GitHub Actions runner pool for the dedicated CI host (specs/633-ci-runner-pool).
#   pool.sh slot <n>    run one fresh runner container per job on CPU slot n, forever
#   pool.sh heartbeat   publish MATRIX_CI_POOL_HEARTBEAT while slots are active
# The GitHub App key never leaves the host; containers get only a single-use JIT config.
set -euo pipefail

if [ -z "${MATRIX_CI_POOL_SKIP_CONFIG:-}" ]; then
  # shellcheck source=/dev/null
  . "${MATRIX_CI_POOL_CONFIG:-/etc/matrix-ci-pool/pool.env}"
fi
REPOSITORY=${REPOSITORY:-HamedMP/matrix-os}
IMAGE=${IMAGE:-matrix-ci-runner:current}
LABEL=${LABEL:-matrix-ci}
SLOT_CPUS=${SLOT_CPUS:-8}
SLOT_MEMORY=${SLOT_MEMORY:-28g}
JOB_TIMEOUT_SECONDS=${JOB_TIMEOUT_SECONDS:-7200}
HEARTBEAT_VARIABLE=MATRIX_CI_POOL_HEARTBEAT
API=${GITHUB_API_URL:-https://api.github.com}
TOKEN=""
TOKEN_EXPIRES=0

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

app_jwt() {
  local now header payload signature
  now=$(date +%s)
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  # GitHub accepts at most 10 minutes; backdate for clock skew.
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "${APP_ID:?}" | b64url)
  signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "${APP_KEY_FILE:?}" | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

refresh_token() {
  # Installation tokens last an hour; reuse one for 50 minutes.
  if [ -n "$TOKEN" ] && [ "$(date +%s)" -lt "$TOKEN_EXPIRES" ]; then return 0; fi
  TOKEN=$(curl -fsS --max-time 30 -X POST \
    -H "Authorization: Bearer $(app_jwt)" -H "Accept: application/vnd.github+json" \
    "$API/app/installations/${INSTALLATION_ID:?}/access_tokens" | jq -er .token) || { TOKEN=""; return 1; }
  TOKEN_EXPIRES=$(( $(date +%s) + 3000 ))
}

gh_api() {
  local method=$1 path=$2
  shift 2
  curl -fsS --max-time 30 -X "$method" \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@" "$API$path"
}

slot_prefix() { printf 'matrix-ci-%s-%s-' "$(hostname -s)" "$1"; }

cpuset_for() {
  local first=$(( ($1 - 1) * SLOT_CPUS ))
  printf '%d-%d' "$first" $((first + SLOT_CPUS - 1))
}

jit_config() {
  local name
  name="$(slot_prefix "$1")$(date +%s)"
  jq -nc --arg name "$name" --arg label "$LABEL" \
    '{name: $name, runner_group_id: 1, labels: [$label], work_folder: "_work"}' \
    | gh_api POST "/repos/$REPOSITORY/actions/runners/generate-jitconfig" --data-binary @- \
    | jq -er .encoded_jit_config
}

remove_offline_runners() {
  # A container that died before taking a job leaves an offline registration behind.
  local prefix ids
  prefix=$(slot_prefix "$1")
  ids=$(gh_api GET "/repos/$REPOSITORY/actions/runners?per_page=100" \
    | jq -r --arg prefix "$prefix" '.runners[] | select(.status == "offline" and (.name | startswith($prefix))) | .id')
  for id in $ids; do gh_api DELETE "/repos/$REPOSITORY/actions/runners/$id" >/dev/null || true; done
}

# Returns non-zero on API, Docker or runner failures so the slot backs off. errexit does not
# apply inside functions called from `if`, so every step checks its own result.
run_one_job() {
  local slot=$1 name="matrix-ci-slot-$1" jit status=0
  docker rm -f "$name" >/dev/null 2>&1 || true
  refresh_token || return 1
  remove_offline_runners "$slot" || true
  jit=$(jit_config "$slot") && [ -n "$jit" ] || return 1
  # Default capabilities keep in-container sudo for apt; no privileged mode, host mounts or Docker socket.
  # The matrix-ci-pool network's firewall allows only public egress (firewall.sh).
  timeout --kill-after=60 "$JOB_TIMEOUT_SECONDS" docker run --rm --name "$name" --network matrix-ci-pool \
    --cpuset-cpus "$(cpuset_for "$slot")" --memory "$SLOT_MEMORY" --memory-swap "$SLOT_MEMORY" \
    --pids-limit 8192 --shm-size 2g --env "RUNNER_JIT=$jit" \
    "$IMAGE" bash -c 'exec ./run.sh --jitconfig "$RUNNER_JIT"' || status=$?
  docker rm -f "$name" >/dev/null 2>&1 || true
  # A failed job still exits the runner with 0; non-zero means Docker, timeout or runner setup failed.
  return "$status"
}

run_slot() {
  local slot=$1 failures=0
  while true; do
    if run_one_job "$slot"; then failures=0; else failures=$((failures + 1)); fi
    # Back off on API or Docker failures instead of hammering GitHub.
    sleep $(( failures == 0 ? 2 : (failures < 6 ? failures * 30 : 300) ))
  done
}

slots_active() {
  docker info >/dev/null 2>&1 && systemctl list-units 'matrix-ci-pool-slot@*' --state=active --no-legend | grep -q .
}

publish_heartbeat() {
  local body
  body=$(jq -nc --arg name "$HEARTBEAT_VARIABLE" --arg value "$(date +%s)" '{name: $name, value: $value}')
  refresh_token || return 1
  gh_api PATCH "/repos/$REPOSITORY/actions/variables/$HEARTBEAT_VARIABLE" --data "$body" >/dev/null \
    || gh_api POST "/repos/$REPOSITORY/actions/variables" --data "$body" >/dev/null
}

run_heartbeat() {
  while true; do
    if slots_active; then publish_heartbeat || echo "heartbeat publish failed" >&2; fi
    sleep 60
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    slot) [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { echo "usage: pool.sh slot <n>" >&2; exit 64; }; run_slot "$2" ;;
    heartbeat) run_heartbeat ;;
    *) echo "usage: pool.sh slot <n> | heartbeat" >&2; exit 64 ;;
  esac
fi

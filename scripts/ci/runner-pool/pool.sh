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
SLOT_TMP_SIZE=${SLOT_TMP_SIZE:-12g}
JOB_TIMEOUT_SECONDS=${JOB_TIMEOUT_SECONDS:-7200}
# A runner still waiting for a job after this long is deregistered and restarted, so the
# container limit (idle wait plus JOB_TIMEOUT_SECONDS) always leaves a job its full timeout.
IDLE_RECYCLE_SECONDS=${IDLE_RECYCLE_SECONDS:-1800}
RECYCLE_POLL_SECONDS=${RECYCLE_POLL_SECONDS:-60}
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
  # Ask only for this repository and the two permissions the pool uses, whatever else the app holds.
  local scope
  scope=$(jq -nc --arg repo "${REPOSITORY#*/}" \
    '{repositories: [$repo], permissions: {administration: "write", actions_variables: "write"}}')
  TOKEN=$(curl -fsS --max-time 30 -X POST \
    -H "Authorization: Bearer $(app_jwt)" -H "Accept: application/vnd.github+json" \
    --data "$scope" "$API/app/installations/${INSTALLATION_ID:?}/access_tokens" | jq -er .token) || { TOKEN=""; return 1; }
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
  jq -nc --arg name "$1" --arg label "$LABEL" \
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

# Deregisters the runner and stops its container if it is still waiting for a job. Returns 0 when
# recycled, 2 when the runner took a job (leave it alone) and 1 on API failure (try again later).
# Deregistering first means GitHub can no longer hand the runner a job while it is being stopped.
recycle_if_idle() {
  local runner=$1 container=$2 state id
  refresh_token || return 1
  state=$(gh_api GET "/repos/$REPOSITORY/actions/runners?per_page=100" \
    | jq -er --arg name "$runner" '[.runners[] | select(.name == $name)][0] // {} | if .busy then "busy" elif .id then "idle \(.id)" else "absent" end') \
    || return 1
  case "$state" in
    busy) return 2 ;;
    absent) return 1 ;;
  esac
  id=${state#idle }
  gh_api DELETE "/repos/$REPOSITORY/actions/runners/$id" >/dev/null || return 1
  docker stop -t 10 "$container" >/dev/null 2>&1 || true
}

# Runs beside one container: after IDLE_RECYCLE_SECONDS, recycles its runner unless it took a job.
# Writes "recycled" to $4 so the slot does not treat the stopped container as a failure.
watch_idle() {
  local runner=$1 container=$2 pid=$3 marker=$4 waited=0 result sleeper=""
  # Stopped by the slot once the container exits; take the pending sleep down with it.
  trap '[ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null; exit 0' TERM
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= IDLE_RECYCLE_SECONDS )); then
      recycle_if_idle "$runner" "$container" && result=0 || result=$?
      case "$result" in
        0) echo recycled > "$marker"; return 0 ;;
        2) return 0 ;;
      esac
    fi
    sleep "$RECYCLE_POLL_SECONDS" &
    sleeper=$!
    wait "$sleeper" || true
    sleeper=""
    waited=$((waited + RECYCLE_POLL_SECONDS))
  done
}

# Returns non-zero on API, Docker or runner failures so the slot backs off. errexit does not
# apply inside functions called from `if`, so every step checks its own result.
run_one_job() {
  local slot=$1 name="matrix-ci-slot-$1" runner jit status=0 pid watcher marker
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  refresh_token || return 1
  remove_offline_runners "$slot" || true
  runner="$(slot_prefix "$slot")$(date +%s)"
  jit=$(jit_config "$runner") && [ -n "$jit" ] || return 1
  # The work directory is a fresh anonymous ext4 volume, removed with the container; the
  # container's own overlayfs root is slower. /tmp is a tmpfs: the collaboration identity code
  # accepts ext4 only from a process without a seccomp filter, which a container always has, and
  # accepts tmpfs as is. tmpfs pages count against the slot's memory limit.
  # No privileged mode, host mounts or Docker socket. In-container sudo stays for apt, so
  # no-new-privileges is not set; NET_RAW is dropped so a job cannot spoof ARP at other slots.
  # The matrix-ci-pool network's firewall allows only public IPv4 egress (firewall.sh); IPv6 is off.
  timeout --kill-after=60 $((IDLE_RECYCLE_SECONDS + JOB_TIMEOUT_SECONDS)) docker run --rm --name "$name" --network matrix-ci-pool \
    --cpuset-cpus "$(cpuset_for "$slot")" --memory "$SLOT_MEMORY" --memory-swap "$SLOT_MEMORY" \
    --pids-limit 8192 --shm-size 2g --cap-drop NET_RAW --sysctl net.ipv6.conf.all.disable_ipv6=1 \
    --mount type=volume,dst=/home/runner/_work --tmpfs "/tmp:rw,exec,nosuid,size=$SLOT_TMP_SIZE,mode=1777" \
    --env "RUNNER_JIT=$jit" \
    "$IMAGE" bash -c 'jit=$RUNNER_JIT; unset RUNNER_JIT; exec ./run.sh --jitconfig "$jit"' &
  pid=$!
  marker=$(mktemp) || { kill "$pid" 2>/dev/null; wait "$pid"; return 1; }
  watch_idle "$runner" "$name" "$pid" "$marker" &
  watcher=$!
  wait "$pid" || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  [ "$(cat "$marker")" != recycled ] || status=0
  rm -f "$marker"
  docker rm -f -v "$name" >/dev/null 2>&1 || true
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

idle_slots() {
  gh_api GET "/repos/$REPOSITORY/actions/runners?per_page=100" \
    | jq -r --arg prefix "matrix-ci-$(hostname -s)-" \
      '[.runners[] | select((.name | startswith($prefix)) and .status == "online" and (.busy | not))] | length'
}

# The value is "<unix seconds> <idle slots>"; CI routes only when it is fresh and enough slots are idle.
publish_heartbeat() {
  local body idle
  refresh_token || return 1
  idle=$(idle_slots) || return 1
  body=$(jq -nc --arg name "$HEARTBEAT_VARIABLE" --arg value "$(date +%s) $idle" '{name: $name, value: $value}')
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

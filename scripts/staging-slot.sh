#!/usr/bin/env bash
# Per-worktree HMR staging slots on the ops VPS (spec 093).
#
# Usage:
#   ./scripts/staging-slot.sh up <worktree-path>   # claim lowest free slot, start HMR container
#   ./scripts/staging-slot.sh down <slot>          # stop and release a slot
#   ./scripts/staging-slot.sh status [--reap]      # list slots; --reap frees slots idle > TTL
#   ./scripts/staging-slot.sh logs <slot> [args]   # follow container logs (docker compose logs)
#
# Four fixed slots map to staging-<n>.matrix-os.com / api-staging-<n>.matrix-os.com
# through the cloudflared tunnel. Slot state lives in ~/.matrixos/staging-slots/:
# claim files are created with O_EXCL so two concurrent `up` calls cannot win
# the same slot. Slot containers are named matrixos-staging-<n>, which the
# observability promtail's docker discovery ships to Loki automatically.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${STAGING_SLOT_STATE_DIR:-$HOME/.matrixos/staging-slots}"
COMPOSE_FILE="$REPO_ROOT/docker-compose.staging-slot.yml"
ENV_FILE="${STAGING_SLOT_ENV_FILE:-$REPO_ROOT/.env}"
MAX_SLOTS=4
IDLE_TTL_HOURS="${STAGING_SLOT_TTL_HOURS:-72}"

mkdir -p "$STATE_DIR"

compose() {
  local slot="$1" project_dir="$2"
  shift 2
  SLOT="$slot" docker compose \
    -f "$COMPOSE_FILE" \
    --project-name "mx-staging-${slot}" \
    --project-directory "$project_dir" \
    --env-file "$ENV_FILE" \
    "$@"
}

validate_slot() {
  case "$1" in
    1 | 2 | 3 | 4) ;;
    *)
      echo "staging-slot: slot must be 1-$MAX_SLOTS" >&2
      exit 64
      ;;
  esac
}

slot_file() { echo "$STATE_DIR/slot-$1.json"; }

cmd_up() {
  local worktree="${1:?usage: staging-slot.sh up <worktree-path>}"
  worktree="$(cd "$worktree" && pwd)" || {
    echo "staging-slot: worktree path does not exist" >&2
    exit 64
  }
  if ! git -C "$worktree" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "staging-slot: $worktree is not a git worktree" >&2
    exit 64
  fi
  if [ ! -f "$worktree/Dockerfile.dev" ]; then
    echo "staging-slot: $worktree does not look like a matrix-os checkout" >&2
    exit 64
  fi

  local slot="" f branch
  for i in $(seq 1 "$MAX_SLOTS"); do
    f="$(slot_file "$i")"
    # O_EXCL claim: loser of a race moves on to the next slot.
    if (set -o noclobber && : > "$f") 2> /dev/null; then
      slot="$i"
      break
    fi
  done
  if [ -z "$slot" ]; then
    echo "staging-slot: no free slots. Current owners:" >&2
    cmd_status >&2
    exit 1
  fi

  branch="$(git -C "$worktree" rev-parse --abbrev-ref HEAD)"
  jq -n --arg worktree "$worktree" --arg branch "$branch" \
    --arg claimedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{worktree: $worktree, branch: $branch, claimedAt: $claimedAt}' > "$(slot_file "$slot")"

  echo "staging-slot: claimed slot $slot for $branch"
  if ! compose "$slot" "$worktree" up -d --build; then
    rm -f "$(slot_file "$slot")"
    echo "staging-slot: start failed; slot $slot released" >&2
    exit 1
  fi
  echo "staging-slot: slot $slot up"
  echo "  shell: https://staging-${slot}.matrix-os.com"
  echo "  api:   https://api-staging-${slot}.matrix-os.com"
  echo "  logs:  ./scripts/preview-logs.sh --slot ${slot}   (or: staging-slot.sh logs ${slot} -f)"
}

cmd_down() {
  local slot="${1:?usage: staging-slot.sh down <slot>}"
  validate_slot "$slot"
  local f worktree
  f="$(slot_file "$slot")"
  if [ ! -f "$f" ]; then
    echo "staging-slot: slot $slot is not claimed" >&2
    exit 1
  fi
  worktree="$(jq -r .worktree "$f")"
  # The worktree may already be deleted; fall back to repo root so compose
  # can still resolve the project by name and remove containers.
  [ -d "$worktree" ] || worktree="$REPO_ROOT"
  compose "$slot" "$worktree" down --remove-orphans
  rm -f "$f"
  echo "staging-slot: slot $slot released"
}

cmd_status() {
  local reap="${1:-}" f worktree branch claimed age_hours
  for i in $(seq 1 "$MAX_SLOTS"); do
    f="$(slot_file "$i")"
    if [ ! -f "$f" ]; then
      echo "slot $i: free"
      continue
    fi
    worktree="$(jq -r .worktree "$f")"
    branch="$(jq -r .branch "$f")"
    claimed="$(jq -r .claimedAt "$f")"
    age_hours=$((($(date +%s) - $(date -d "$claimed" +%s)) / 3600))
    echo "slot $i: $branch ($worktree) claimed ${claimed} (${age_hours}h ago)"
    if [ "$reap" = "--reap" ] && [ "$age_hours" -ge "$IDLE_TTL_HOURS" ]; then
      echo "slot $i: idle past ${IDLE_TTL_HOURS}h TTL, reaping"
      cmd_down "$i"
    fi
  done
}

cmd_logs() {
  local slot="${1:?usage: staging-slot.sh logs <slot> [compose-logs-args]}"
  validate_slot "$slot"
  shift
  local f worktree
  f="$(slot_file "$slot")"
  if [ ! -f "$f" ]; then
    echo "staging-slot: slot $slot is not claimed" >&2
    exit 1
  fi
  worktree="$(jq -r .worktree "$f")"
  [ -d "$worktree" ] || worktree="$REPO_ROOT"
  compose "$slot" "$worktree" logs "$@"
}

case "${1:-}" in
  up)
    shift
    cmd_up "$@"
    ;;
  down)
    shift
    cmd_down "$@"
    ;;
  status)
    shift || true
    cmd_status "${1:-}"
    ;;
  logs)
    shift
    cmd_logs "$@"
    ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    exit 64
    ;;
esac

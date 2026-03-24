#!/usr/bin/env bash
# Start a per-branch Docker dev environment with unique ports.
#
# Usage:
#   ./scripts/branch-dev.sh          # start
#   ./scripts/branch-dev.sh stop     # stop (preserves volumes)
#   ./scripts/branch-dev.sh logs     # tail logs
#   ./scripts/branch-dev.sh shell    # shell into container
#   ./scripts/branch-dev.sh ps       # show running containers
#   ./scripts/branch-dev.sh down     # stop and remove containers (keeps volumes)
#
# Port assignment: deterministic hash of branch name -> offset 10-99
# Main (default compose) keeps 3000/4000/5432, branches get 30xx/40xx/54xx.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH=$(git branch --show-current)
if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ]; then
  echo "On main -- use 'bun run docker' instead."
  exit 1
fi

# Deterministic port offset from branch name (10-99)
HASH=$(echo -n "$BRANCH" | cksum | awk '{print $1}')
OFFSET=$(( (HASH % 90) + 10 ))

export SHELL_PORT=$((3000 + OFFSET))
export GW_PORT=$((4000 + OFFSET))
export PG_PORT=$((5432 + OFFSET))

# Sanitize branch name for Docker project name
PROJECT="mos-$(echo "$BRANCH" | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-30)"

COMPOSE="docker compose -f docker-compose.dev.yml -f docker-compose.branch.yml -p $PROJECT"

ACTION="${1:-up}"

case "$ACTION" in
  up|start)
    echo "Branch:  $BRANCH"
    echo "Project: $PROJECT"
    echo "Shell:   http://localhost:$SHELL_PORT"
    echo "Gateway: http://localhost:$GW_PORT"
    echo "Postgres: localhost:$PG_PORT"
    echo ""
    $COMPOSE up --build -d
    echo ""
    echo "Tailing logs... (Ctrl+C to detach, containers keep running)"
    $COMPOSE logs -f dev
    ;;
  stop)
    $COMPOSE stop
    ;;
  down)
    $COMPOSE down
    ;;
  logs)
    $COMPOSE logs -f dev
    ;;
  shell)
    $COMPOSE exec dev bash
    ;;
  ps)
    $COMPOSE ps
    ;;
  restart)
    $COMPOSE restart dev
    ;;
  *)
    echo "Unknown action: $ACTION"
    echo "Usage: $0 [up|stop|down|logs|shell|ps|restart]"
    exit 1
    ;;
esac

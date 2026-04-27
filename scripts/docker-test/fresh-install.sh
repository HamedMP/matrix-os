#!/bin/bash
# Scenario 1: Fresh Install
# Tests that a brand new user gets a fully initialized home directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap cleanup EXIT

begin_test "Fresh Install"

# Clean slate
echo -e "${YELLOW}[SETUP]${NC} Removing existing containers and volumes..."
$COMPOSE down -v --timeout 5 2>/dev/null || true

# Start fresh
echo -e "${YELLOW}[SETUP]${NC} Starting dev container..."
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Verify home directory structure
assert_file_exists "dev" "/home/matrixos/home/system/soul.md" \
  "soul.md exists (SOUL identity)"

assert_file_exists "dev" "/home/matrixos/home/system/config.json" \
  "config.json exists (system config)"

assert_dir_exists "dev" "/home/matrixos/home/.git" \
  ".git directory exists (git initialized)"

assert_file_exists "dev" "/home/matrixos/home/system/bootstrap.md" \
  "bootstrap.md exists (onboarding ready)"

assert_file_exists "dev" "/home/matrixos/home/.matrix-version" \
  ".matrix-version exists (version tracking)"

assert_file_exists "dev" "/home/matrixos/home/system/handle.json" \
  "handle.json exists (identity)"

# Verify API endpoints
assert_status "$GATEWAY_URL/health" "200" \
  "GET /health returns 200"

assert_json "$GATEWAY_URL/health" ".status" "ok" \
  "Health check status is ok"

assert_status "$GATEWAY_URL/api/apps" "200" \
  "GET /api/apps returns 200"

assert_json_not_empty "$GATEWAY_URL/api/system/info" ".templateVersion" \
  "GET /api/system/info returns templateVersion"

assert_json_not_empty "$GATEWAY_URL/api/system/info" ".installedVersion" \
  "GET /api/system/info returns installedVersion"

summary

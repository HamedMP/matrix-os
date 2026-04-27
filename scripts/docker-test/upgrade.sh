#!/bin/bash
# Scenario 2: Upgrade / Template Sync
# Tests that upgrading from v0.3.0 to current version triggers smart sync.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap cleanup EXIT

begin_test "Upgrade (Template Sync)"

# Clean slate and start
echo -e "${YELLOW}[SETUP]${NC} Starting fresh container..."
$COMPOSE down -v --timeout 5 2>/dev/null || true
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Simulate old version: downgrade .matrix-version to 0.3.0
echo -e "${YELLOW}[SETUP]${NC} Simulating v0.3.0 state..."
$COMPOSE exec -T dev sh -c 'echo "0.3.0" > /home/matrixos/home/.matrix-version'

# Remove template manifest (old versions didn't have it)
$COMPOSE exec -T dev rm -f /home/matrixos/home/.template-manifest.json

# Remove sync log from previous boot
$COMPOSE exec -T dev rm -f /home/matrixos/home/system/logs/template-sync.log

# Stop container (preserves volume)
echo -e "${YELLOW}[SETUP]${NC} Restarting container to trigger sync..."
$COMPOSE stop dev
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Verify upgrade happened
# The template version should be the current version (0.4.0)
assert_file_contains "dev" "/home/matrixos/home/.matrix-version" "0.4.0" \
  ".matrix-version updated to current version"

assert_file_exists "dev" "/home/matrixos/home/.template-manifest.json" \
  ".template-manifest.json created by sync"

assert_file_exists "dev" "/home/matrixos/home/system/logs/template-sync.log" \
  "template-sync.log exists with sync entries"

# Verify API reports correct versions
assert_json "$GATEWAY_URL/api/system/info" ".templateVersion" "0.4.0" \
  "API reports correct templateVersion"

assert_status "$GATEWAY_URL/health" "200" \
  "Gateway healthy after upgrade"

summary

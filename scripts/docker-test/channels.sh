#!/bin/bash
# Scenario 5: Channel Adapter Lifecycle
# Tests that channel configuration is read and adapters are reported.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap cleanup EXIT

begin_test "Channel Adapter Lifecycle"

# Clean slate and start
echo -e "${YELLOW}[SETUP]${NC} Starting fresh container..."
$COMPOSE down -v --timeout 5 2>/dev/null || true
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Write channel config with a telegram entry (disabled, since we have no real token)
echo -e "${YELLOW}[SETUP]${NC} Writing channel config..."
$COMPOSE exec -T dev sh -c 'cat > /home/matrixos/home/system/config.json << INNEREOF
{
  "channels": {
    "telegram": {
      "enabled": false,
      "token": "fake-token-for-testing",
      "allowFrom": ["123456"]
    }
  },
  "heartbeat": {},
  "plugins": {}
}
INNEREOF'

# Restart to pick up channel config
echo -e "${YELLOW}[SETUP]${NC} Restarting to load channel config..."
$COMPOSE stop dev
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Verify channel status endpoint works
assert_status "$GATEWAY_URL/api/channels/status" "200" \
  "GET /api/channels/status returns 200"

# The system info should reflect channel configuration
assert_status "$GATEWAY_URL/api/system/info" "200" \
  "GET /api/system/info returns 200"

# Health endpoint should still work
assert_json "$GATEWAY_URL/health" ".status" "ok" \
  "Health check still reports ok"

summary

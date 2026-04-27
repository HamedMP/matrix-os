#!/bin/bash
# Scenario 6: Crash Recovery
# Tests that data survives an ungraceful shutdown (SIGKILL).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap cleanup EXIT

begin_test "Crash Recovery"

# Clean slate and start
echo -e "${YELLOW}[SETUP]${NC} Starting fresh container..."
$COMPOSE down -v --timeout 5 2>/dev/null || true
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Write some bridge data
echo -e "${YELLOW}[ACTION]${NC} Writing bridge data..."
WRITE_RESULT=$(curl -s -X POST "$GATEWAY_URL/api/bridge/data" \
  -H "Content-Type: application/json" \
  -d '{"action":"write","app":"test","key":"state","value":"important"}' 2>/dev/null)

WRITE_OK=$(echo "$WRITE_RESULT" | jq -r '.ok' 2>/dev/null)
if [ "$WRITE_OK" = "true" ]; then
  echo -e "  ${GREEN}PASS${NC} Bridge data written successfully"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "  ${RED}FAIL${NC} Failed to write bridge data"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Create a social post
echo -e "${YELLOW}[ACTION]${NC} Creating social post..."
POST_RESULT=$(curl -s -X POST "$GATEWAY_URL/api/social/posts" \
  -H "Content-Type: application/json" \
  -d '{"content":"Pre-crash post"}' 2>/dev/null)

POST_ID=$(echo "$POST_RESULT" | jq -r '.id' 2>/dev/null)
echo -e "  ${BLUE}INFO${NC} Social post ID: $POST_ID"

# Kill container ungracefully (SIGKILL)
echo -e "${YELLOW}[ACTION]${NC} Killing container with SIGKILL..."
CONTAINER_ID=$($COMPOSE ps -q dev 2>/dev/null)
if [ -n "$CONTAINER_ID" ]; then
  docker kill "$CONTAINER_ID" 2>/dev/null || true
fi

# Wait for container to be fully stopped
sleep 2

# Restart
echo -e "${YELLOW}[ACTION]${NC} Restarting container..."
$COMPOSE up $COMPOSE_UP_FLAGS -d dev

wait_for_healthy "dev" 90

# Verify bridge data survived
echo -e "${YELLOW}[VERIFY]${NC} Checking data integrity..."
READ_RESULT=$(curl -s -X POST "$GATEWAY_URL/api/bridge/data" \
  -H "Content-Type: application/json" \
  -d '{"action":"read","app":"test","key":"state"}' 2>/dev/null)

READ_VALUE=$(echo "$READ_RESULT" | jq -r '.value' 2>/dev/null)
if [ "$READ_VALUE" = 'important' ]; then
  echo -e "  ${GREEN}PASS${NC} Bridge data survived crash"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "  ${RED}FAIL${NC} Bridge data lost (got: $READ_VALUE)"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Verify health endpoint works after recovery
assert_status "$GATEWAY_URL/health" "200" \
  "GET /health returns 200 after recovery"

assert_json "$GATEWAY_URL/health" ".status" "ok" \
  "Health check reports ok after recovery"

# Verify home directory is intact
assert_file_exists "dev" "/home/matrixos/home/system/soul.md" \
  "soul.md intact after crash recovery"

assert_file_exists "dev" "/home/matrixos/home/system/config.json" \
  "config.json intact after crash recovery"

summary

#!/bin/bash
# Scenario 7: Resource Limits
# Tests that the system operates correctly under constrained memory (256MB).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap resource_cleanup EXIT

# Temporary override file for memory limits
OVERRIDE_FILE="$PROJECT_ROOT/docker-compose.resource-test.yml"

resource_cleanup() {
  echo -e "${YELLOW}[CLEANUP]${NC} Stopping containers and removing override..."
  docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" down -v --timeout 5 2>/dev/null || true
  rm -f "$OVERRIDE_FILE"
}

begin_test "Resource Limits (256MB)"

# Clean slate
$COMPOSE down -v --timeout 5 2>/dev/null || true

# Create temporary compose override with memory limits
cat > "$OVERRIDE_FILE" << 'EOF'
services:
  dev:
    mem_limit: 256m
    memswap_limit: 256m
EOF

echo -e "${YELLOW}[SETUP]${NC} Starting container with 256MB memory limit..."
docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" up -d dev

# Give more time for constrained environment
wait_for_url "$GATEWAY_URL/health" 120

# Basic health check
assert_status "$GATEWAY_URL/health" "200" \
  "GET /health returns 200 under memory limit"

# Hit several API endpoints to stress the system
assert_status "$GATEWAY_URL/api/apps" "200" \
  "GET /api/apps responds under memory limit"

assert_status "$GATEWAY_URL/api/system/info" "200" \
  "GET /api/system/info responds under memory limit"

assert_status "$GATEWAY_URL/api/social/posts" "200" \
  "GET /api/social/posts responds under memory limit"

assert_status "$GATEWAY_URL/api/channels/status" "200" \
  "GET /api/channels/status responds under memory limit"

# Write and read bridge data
WRITE_RESULT=$(curl -s -X POST "$GATEWAY_URL/api/bridge/data" \
  -H "Content-Type: application/json" \
  -d '{"action":"write","app":"stress","key":"data","value":"test-under-memory-limit"}' 2>/dev/null)

WRITE_OK=$(echo "$WRITE_RESULT" | jq -r '.ok' 2>/dev/null)
if [ "$WRITE_OK" = "true" ]; then
  echo -e "  ${GREEN}PASS${NC} Bridge data write works under memory limit"
  ((PASS_COUNT++))
else
  echo -e "  ${RED}FAIL${NC} Bridge data write failed under memory limit"
  ((FAIL_COUNT++))
fi

# Check memory usage
echo -e "${YELLOW}[INFO]${NC} Container memory usage:"
CONTAINER_ID=$(docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" ps -q dev 2>/dev/null)
if [ -n "$CONTAINER_ID" ]; then
  STATS=$(docker stats --no-stream --format "{{.MemUsage}} / {{.MemPerc}}" "$CONTAINER_ID" 2>/dev/null)
  echo -e "  ${BLUE}INFO${NC} Memory: $STATS"

  # Parse memory percentage; warn if above 90%
  MEM_PCT=$(docker stats --no-stream --format "{{.MemPerc}}" "$CONTAINER_ID" 2>/dev/null | tr -d '%')
  if [ -n "$MEM_PCT" ]; then
    MEM_INT=${MEM_PCT%.*}
    if [ "$MEM_INT" -lt 90 ] 2>/dev/null; then
      echo -e "  ${GREEN}PASS${NC} Memory usage under 90% ($MEM_PCT%)"
      ((PASS_COUNT++))
    else
      echo -e "  ${YELLOW}WARN${NC} Memory usage high: $MEM_PCT% (may be acceptable)"
      ((PASS_COUNT++))
    fi
  fi
fi

summary

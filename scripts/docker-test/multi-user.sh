#!/bin/bash
# Scenario 4: Multi-User
# Tests two independent user containers with social features.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap 'multi_cleanup' EXIT

ALICE_URL="http://localhost:4001"
BOB_URL="http://localhost:4002"

multi_cleanup() {
  echo -e "${YELLOW}[CLEANUP]${NC} Stopping multi-user containers..."
  $COMPOSE --profile multi --profile full down -v --timeout 5 2>/dev/null || true
}

begin_test "Multi-User (Alice + Bob)"

# Clean slate
echo -e "${YELLOW}[SETUP]${NC} Starting multi-user containers..."
$COMPOSE --profile multi --profile full down -v --timeout 5 2>/dev/null || true
$COMPOSE --profile multi --profile full up $COMPOSE_UP_FLAGS -d alice bob

# Wait for both instances
wait_for_url "$ALICE_URL/health" 90
wait_for_url "$BOB_URL/health" 90

# Basic health checks
assert_status "$ALICE_URL/health" "200" \
  "Alice: GET /health returns 200"

assert_status "$BOB_URL/health" "200" \
  "Bob: GET /health returns 200"

# Create posts on each instance
echo -e "${YELLOW}[ACTION]${NC} Creating posts..."

ALICE_POST=$(curl -s -X POST "$ALICE_URL/api/social/posts" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello from Alice"}' 2>/dev/null)

ALICE_POST_ID=$(echo "$ALICE_POST" | jq -r '.id' 2>/dev/null)
echo -e "  ${BLUE}INFO${NC} Alice post ID: $ALICE_POST_ID"

BOB_POST=$(curl -s -X POST "$BOB_URL/api/social/posts" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello from Bob"}' 2>/dev/null)

BOB_POST_ID=$(echo "$BOB_POST" | jq -r '.id' 2>/dev/null)
echo -e "  ${BLUE}INFO${NC} Bob post ID: $BOB_POST_ID"

# Verify posts exist on their respective instances
if [ -n "$ALICE_POST_ID" ] && [ "$ALICE_POST_ID" != "null" ]; then
  echo -e "  ${GREEN}PASS${NC} Alice's post created successfully"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "  ${RED}FAIL${NC} Alice's post creation failed"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

if [ -n "$BOB_POST_ID" ] && [ "$BOB_POST_ID" != "null" ]; then
  echo -e "  ${GREEN}PASS${NC} Bob's post created successfully"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "  ${RED}FAIL${NC} Bob's post creation failed"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Verify alice's posts appear on alice's instance
ALICE_POSTS=$(curl -s "$ALICE_URL/api/social/posts" 2>/dev/null)
ALICE_HAS_POST=$(echo "$ALICE_POSTS" | jq -r '.posts[] | select(.content == "Hello from Alice") | .id' 2>/dev/null)

if [ -n "$ALICE_HAS_POST" ]; then
  echo -e "  ${GREEN}PASS${NC} Alice's post appears on her instance"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "  ${RED}FAIL${NC} Alice's post not found on her instance"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Verify bob's posts appear on bob's instance
BOB_POSTS=$(curl -s "$BOB_URL/api/social/posts" 2>/dev/null)
BOB_HAS_POST=$(echo "$BOB_POSTS" | jq -r '.posts[] | select(.content == "Hello from Bob") | .id' 2>/dev/null)

if [ -n "$BOB_HAS_POST" ]; then
  echo -e "  ${GREEN}PASS${NC} Bob's post appears on his instance"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "  ${RED}FAIL${NC} Bob's post not found on his instance"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Each instance is independent (local SQLite)
assert_status "$ALICE_URL/api/apps" "200" \
  "Alice: GET /api/apps returns 200"

assert_status "$BOB_URL/api/apps" "200" \
  "Bob: GET /api/apps returns 200"

summary

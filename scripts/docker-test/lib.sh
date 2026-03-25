#!/bin/bash
# Matrix OS Docker Test Harness

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TEST_NAME=""

# Project root (where docker-compose.dev.yml lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.dev.yml"
COMPOSE="docker compose -f $COMPOSE_FILE"

# Gateway base URL for the default dev container
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"

begin_test() {
  TEST_NAME="$1"
  echo -e "${BLUE}[TEST]${NC} $TEST_NAME"
}

assert_status() {
  local url="$1"
  local expected="$2"
  local desc="$3"
  local actual
  actual=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null) || actual="000"
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${NC} $desc (HTTP $actual)"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (expected HTTP $expected, got $actual)"
    ((++FAIL_COUNT))
  fi
}

assert_json() {
  local url="$1"
  local jq_expr="$2"
  local expected="$3"
  local desc="$4"
  local actual
  actual=$(curl -s --max-time 10 "$url" | jq -r "$jq_expr" 2>/dev/null) || actual="<error>"
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (expected '$expected', got '$actual')"
    ((++FAIL_COUNT))
  fi
}

assert_json_not_empty() {
  local url="$1"
  local jq_expr="$2"
  local desc="$3"
  local actual
  actual=$(curl -s --max-time 10 "$url" | jq -r "$jq_expr" 2>/dev/null) || actual=""
  if [ -n "$actual" ] && [ "$actual" != "null" ] && [ "$actual" != "" ]; then
    echo -e "  ${GREEN}PASS${NC} $desc (got: $actual)"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (value was empty or null)"
    ((++FAIL_COUNT))
  fi
}

assert_file_exists() {
  local container="$1"
  local path="$2"
  local desc="$3"
  if $COMPOSE exec -T "$container" test -f "$path" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (file not found: $path)"
    ((++FAIL_COUNT))
  fi
}

assert_dir_exists() {
  local container="$1"
  local path="$2"
  local desc="$3"
  if $COMPOSE exec -T "$container" test -d "$path" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (directory not found: $path)"
    ((++FAIL_COUNT))
  fi
}

assert_file_not_exists() {
  local container="$1"
  local path="$2"
  local desc="$3"
  if $COMPOSE exec -T "$container" test -f "$path" 2>/dev/null; then
    echo -e "  ${RED}FAIL${NC} $desc (file exists: $path)"
    ((++FAIL_COUNT))
  else
    echo -e "  ${GREEN}PASS${NC} $desc"
    ((++PASS_COUNT))
  fi
}

assert_file_contains() {
  local container="$1"
  local path="$2"
  local pattern="$3"
  local desc="$4"
  if $COMPOSE exec -T "$container" grep -q "$pattern" "$path" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (pattern '$pattern' not found in $path)"
    ((++FAIL_COUNT))
  fi
}

assert_container_running() {
  local service="$1"
  local desc="$2"
  if $COMPOSE ps --status running "$service" 2>/dev/null | grep -q "$service"; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    ((++PASS_COUNT))
  else
    echo -e "  ${RED}FAIL${NC} $desc (container not running)"
    ((++FAIL_COUNT))
  fi
}

wait_for_healthy() {
  local service="$1"
  local timeout="${2:-60}"
  local elapsed=0
  echo -e "  ${YELLOW}WAIT${NC} Waiting for $service to be healthy (timeout: ${timeout}s)..."
  while [ $elapsed -lt $timeout ]; do
    # Check if container is running and healthy
    local health
    health=$($COMPOSE ps "$service" --format json 2>/dev/null | jq -r '.[0].Health // .Health // "unknown"' 2>/dev/null) || health="unknown"
    if [ "$health" = "healthy" ]; then
      echo -e "  ${GREEN}READY${NC} $service is healthy (${elapsed}s)"
      return 0
    fi
    # Fallback: try the health endpoint directly
    if curl -sf --max-time 2 "${GATEWAY_URL}/health" >/dev/null 2>&1; then
      echo -e "  ${GREEN}READY${NC} $service responding to health check (${elapsed}s)"
      return 0
    fi
    sleep 2
    ((elapsed+=2))
  done
  echo -e "  ${RED}TIMEOUT${NC} $service not healthy after ${timeout}s"
  # Print container logs for debugging
  echo -e "  ${YELLOW}DEBUG${NC} Container logs (last 20 lines):"
  $COMPOSE logs --tail 20 "$service" 2>/dev/null || true
  return 1
}

wait_for_url() {
  local url="$1"
  local timeout="${2:-60}"
  local elapsed=0
  echo -e "  ${YELLOW}WAIT${NC} Waiting for $url (timeout: ${timeout}s)..."
  while [ $elapsed -lt $timeout ]; do
    if curl -sf --max-time 2 "$url" >/dev/null 2>&1; then
      echo -e "  ${GREEN}READY${NC} $url responding (${elapsed}s)"
      return 0
    fi
    sleep 2
    ((elapsed+=2))
  done
  echo -e "  ${RED}TIMEOUT${NC} $url not responding after ${timeout}s"
  return 1
}

cleanup() {
  echo -e "${YELLOW}[CLEANUP]${NC} Stopping containers..."
  $COMPOSE down -v --timeout 5 2>/dev/null || true
}

summary() {
  echo ""
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE} Test Summary: $TEST_NAME${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo -e "  ${GREEN}Passed: $PASS_COUNT${NC}"
  echo -e "  ${RED}Failed: $FAIL_COUNT${NC}"
  if [ $SKIP_COUNT -gt 0 ]; then
    echo -e "  ${YELLOW}Skipped: $SKIP_COUNT${NC}"
  fi
  echo ""
  if [ $FAIL_COUNT -gt 0 ]; then
    echo -e "  ${RED}RESULT: FAILED${NC}"
    return 1
  else
    echo -e "  ${GREEN}RESULT: PASSED${NC}"
    return 0
  fi
}

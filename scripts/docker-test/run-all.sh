#!/bin/bash
# Run all Docker test scenarios sequentially and report results.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCENARIOS=(
  "fresh-install"
  "upgrade"
  "customized-files"
  "multi-user"
  "channels"
  "recovery"
  "resource-limits"
)

TOTAL=0
PASSED=0
FAILED=0
RESULTS=()
SKIP_SCENARIOS="${SKIP_SCENARIOS:-}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE} Matrix OS Docker Test Suite${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

for scenario in "${SCENARIOS[@]}"; do
  # Check if scenario should be skipped
  if echo "$SKIP_SCENARIOS" | grep -q "$scenario"; then
    echo -e "${YELLOW}[SKIP]${NC} $scenario (in SKIP_SCENARIOS)"
    RESULTS+=("SKIP:$scenario")
    continue
  fi

  SCRIPT="$SCRIPT_DIR/$scenario.sh"
  if [ ! -x "$SCRIPT" ]; then
    echo -e "${RED}[ERROR]${NC} $SCRIPT not found or not executable"
    RESULTS+=("FAIL:$scenario")
    ((++FAILED))
    ((++TOTAL))
    continue
  fi

  echo -e "${BLUE}----------------------------------------${NC}"
  echo -e "${BLUE} Running: $scenario${NC}"
  echo -e "${BLUE}----------------------------------------${NC}"

  START_TIME=$(date +%s)

  if "$SCRIPT"; then
    RESULTS+=("PASS:$scenario")
    ((++PASSED))
  else
    RESULTS+=("FAIL:$scenario")
    ((++FAILED))
  fi

  ((++TOTAL))

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo -e "  ${BLUE}Duration: ${DURATION}s${NC}"
  echo ""
done

# Print summary table
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE} Final Results${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

for result in "${RESULTS[@]}"; do
  STATUS="${result%%:*}"
  NAME="${result#*:}"
  case "$STATUS" in
    PASS)
      echo -e "  ${GREEN}PASS${NC}  $NAME"
      ;;
    FAIL)
      echo -e "  ${RED}FAIL${NC}  $NAME"
      ;;
    SKIP)
      echo -e "  ${YELLOW}SKIP${NC}  $NAME"
      ;;
  esac
done

echo ""
echo -e "  Total:  $TOTAL"
echo -e "  ${GREEN}Passed: $PASSED${NC}"
echo -e "  ${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -gt 0 ]; then
  echo -e "  ${RED}SUITE FAILED${NC}"
  exit 1
else
  echo -e "  ${GREEN}SUITE PASSED${NC}"
  exit 0
fi

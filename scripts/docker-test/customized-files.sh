#!/bin/bash
# Scenario 3: Customized Files Survive Sync
# Tests that user modifications to soul.md and skills are not overwritten.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

trap cleanup EXIT

begin_test "Customized Files Survive Sync"

# Clean slate and start
echo -e "${YELLOW}[SETUP]${NC} Starting fresh container..."
$COMPOSE down -v --timeout 5 2>/dev/null || true
$COMPOSE up -d dev

wait_for_healthy "dev" 90

# Add custom line to soul.md
CUSTOM_SOUL_LINE="I am a customized soul for testing purposes."
echo -e "${YELLOW}[SETUP]${NC} Customizing soul.md..."
$COMPOSE exec -T dev sh -c "echo '$CUSTOM_SOUL_LINE' >> /home/matrixos/home/system/soul.md"

# Modify an agent skill description
CUSTOM_SKILL_LINE="# CUSTOM: This skill has been modified by the user."
echo -e "${YELLOW}[SETUP]${NC} Customizing agent skill..."
$COMPOSE exec -T dev sh -c "echo '$CUSTOM_SKILL_LINE' >> /home/matrixos/home/agents/skills/calculator.md"

# Verify customizations are in place before restart
assert_file_contains "dev" "/home/matrixos/home/system/soul.md" \
  "customized soul" "soul.md has custom content before restart"

assert_file_contains "dev" "/home/matrixos/home/agents/skills/calculator.md" \
  "CUSTOM" "skill has custom content before restart"

# Remove sync log to get fresh entries
$COMPOSE exec -T dev rm -f /home/matrixos/home/system/logs/template-sync.log

# Restart container (triggers template sync)
echo -e "${YELLOW}[SETUP]${NC} Restarting container to trigger sync..."
$COMPOSE stop dev
$COMPOSE up -d dev

wait_for_healthy "dev" 90

# Verify customizations survived
assert_file_contains "dev" "/home/matrixos/home/system/soul.md" \
  "customized soul" "soul.md still has custom content after sync"

assert_file_contains "dev" "/home/matrixos/home/agents/skills/calculator.md" \
  "CUSTOM" "skill still has custom content after sync"

# Verify sync log shows files were skipped
assert_file_exists "dev" "/home/matrixos/home/system/logs/template-sync.log" \
  "template-sync.log exists"

assert_file_contains "dev" "/home/matrixos/home/system/logs/template-sync.log" \
  "Skipped" "sync log contains Skipped entries for customized files"

summary

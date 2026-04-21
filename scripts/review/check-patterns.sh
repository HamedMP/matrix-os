#!/usr/bin/env bash
# CLAUDE.md Mandatory Pattern Scanner
#
# Runs mechanical sweeps against source files to catch recurring defect
# patterns documented in CLAUDE.md § Mandatory Code Patterns.
#
# Exit codes:
#   0 — no violations found
#   1 — violations found (details on stdout)
#   2 — script error
#
# Usage:
#   ./scripts/review/check-patterns.sh              # scan all packages
#   ./scripts/review/check-patterns.sh --diff main   # scan only files changed vs main
#   ./scripts/review/check-patterns.sh --strict       # treat warnings as errors

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

SCAN_PATHS="packages shell"
DIFF_BASE=""
STRICT=false
VIOLATIONS=0
WARNINGS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --diff)  DIFF_BASE="$2"; shift 2 ;;
    --strict) STRICT=true; shift ;;
    --help)
      echo "Usage: $0 [--diff <base-branch>] [--strict]"
      echo "  --diff <branch>  Only scan files changed vs <branch>"
      echo "  --strict         Treat warnings as errors"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

if ! command -v rg &>/dev/null; then
  echo "Error: ripgrep (rg) is required. Install via: brew install ripgrep" >&2
  exit 2
fi

# Build file list
if [[ -n "$DIFF_BASE" ]]; then
  FILES=$(git diff --name-only --diff-filter=ACMR "$DIFF_BASE"...HEAD -- $SCAN_PATHS 2>/dev/null | grep -E '\.(ts|tsx)$' || true)
  if [[ -z "$FILES" ]]; then
    echo "No TypeScript files changed vs $DIFF_BASE."
    exit 0
  fi
  FILE_ARGS="$FILES"
  SCAN_MODE="changed files vs $DIFF_BASE"
else
  FILE_ARGS=""
  SCAN_MODE="all files in: $SCAN_PATHS"
fi

header() {
  echo ""
  echo -e "${BOLD}${CYAN}── $1 ──${RESET}"
}

violation() {
  echo -e "  ${RED}VIOLATION${RESET} $1"
  VIOLATIONS=$((VIOLATIONS + 1))
}

warning() {
  echo -e "  ${YELLOW}WARNING${RESET} $1"
  WARNINGS=$((WARNINGS + 1))
}

rg_scan() {
  local pattern="$1"
  shift
  if [[ -n "$FILE_ARGS" ]]; then
    echo "$FILE_ARGS" | xargs rg -n "$pattern" "$@" 2>/dev/null || true
  else
    rg -n "$pattern" "$@" $SCAN_PATHS 2>/dev/null || true
  fi
}

echo -e "${BOLD}CLAUDE.md Pattern Scanner${RESET}"
echo "Scanning: $SCAN_MODE"
echo ""

# ═══════════════════════════════════════════════════════════════
# PASS 1: Mechanical CLAUDE.md sweeps (Category 3 from review)
# ═══════════════════════════════════════════════════════════════

header "1. Error Handling — bare/empty catch blocks"

MATCHES=$(rg_scan 'catch\s*\{' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  violation "Bare catch {} blocks (CLAUDE.md: every catch must check error type)"
  echo "$MATCHES" | head -20
fi

MATCHES=$(rg_scan '\.catch\(\s*\(\s*\)\s*=>' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  violation "Empty .catch(() => ...) — error param ignored (CLAUDE.md: no bare catch)"
  echo "$MATCHES" | head -20
fi

MATCHES=$(rg_scan '\.catch\(\s*\(\s*_\w*\s*\)\s*=>' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Catch with explicitly unused param (_err) — verify error is logged"
  echo "$MATCHES" | head -10
fi

header "2. External Calls — fetch() without AbortSignal.timeout"

MATCHES=$(rg_scan 'fetch\(' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  # Check each fetch call for a signal
  MISSING_SIGNAL=""
  while IFS= read -r line; do
    file_line=$(echo "$line" | cut -d: -f1-2)
    if ! echo "$line" | grep -q 'signal'; then
      MISSING_SIGNAL+="$line"$'\n'
    fi
  done <<< "$MATCHES"
  if [[ -n "$MISSING_SIGNAL" ]]; then
    violation "fetch() without signal: (CLAUDE.md: every fetch MUST have AbortSignal.timeout)"
    echo "$MISSING_SIGNAL" | head -20
  fi
fi

header "3. Input Validation — missing bodyLimit on mutating endpoints"

MATCHES=$(rg_scan 'c\.req\.(json|text|blob|arrayBuffer)\(' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Body consumption calls — verify bodyLimit middleware is applied to each route"
  echo "$MATCHES" | head -20
fi

header "4. Resource Management — unbounded in-memory structures"

MATCHES=$(rg_scan 'new (Map|Set)\(' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Map/Set creation — verify each has a size cap and eviction policy"
  echo "$MATCHES" | head -20
fi

MATCHES=$(rg_scan 'buffer \+=' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Buffer concatenation — verify bounded with a size cap"
  echo "$MATCHES" | head -10
fi

header "5. Resource Management — writeFileSync/appendFileSync in handlers"

MATCHES=$(rg_scan '(writeFileSync|appendFileSync)' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  violation "Sync file I/O (CLAUDE.md: banned in request handlers, use fs/promises)"
  echo "$MATCHES" | head -10
fi

# ═══════════════════════════════════════════════════════════════
# PASS 2: Trust-boundary sweep (Category 2 from review)
# ═══════════════════════════════════════════════════════════════

header "6. Trust Boundaries — path operations on external input"

MATCHES=$(rg_scan '(join|resolve|realpath|rename|unlink)\(' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Path operations — verify input is validated via resolveWithinPrefix or equivalent"
  echo "$MATCHES" | head -30
fi

header "7. Trust Boundaries — headers and identifiers from external sources"

MATCHES=$(rg_scan '(X-Forwarded-For|X-Peer-Id|X-Real-Ip|peerId|userId)' --glob '*.ts' --glob '!*.test.ts' --glob '!*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**' -i)
if [[ -n "$MATCHES" ]]; then
  warning "External headers/identifiers — verify validated before use in keys, paths, or SQL"
  echo "$MATCHES" | head -20
fi

# ═══════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}════════════════════════════════════════${RESET}"
if [[ $VIOLATIONS -gt 0 ]]; then
  echo -e "${RED}${BOLD}FAIL${RESET}: $VIOLATIONS violation(s), $WARNINGS warning(s)"
  if $STRICT; then
    exit 1
  else
    exit 1
  fi
elif [[ $WARNINGS -gt 0 ]]; then
  echo -e "${YELLOW}${BOLD}WARN${RESET}: $WARNINGS warning(s), 0 violations"
  if $STRICT; then
    echo "(--strict mode: treating warnings as errors)"
    exit 1
  fi
  exit 0
else
  echo -e "${CYAN}${BOLD}PASS${RESET}: no violations or warnings"
  exit 0
fi

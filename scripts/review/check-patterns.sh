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
  if ! git rev-parse --verify "$DIFF_BASE" &>/dev/null; then
    echo "Error: diff base '$DIFF_BASE' not found. Run 'git fetch' first." >&2
    exit 2
  fi
  FILES=$(git diff --name-only --diff-filter=ACMR "$DIFF_BASE"...HEAD -- $SCAN_PATHS | grep -E '\.(ts|tsx)$' || true)
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
    local filtered_files
    filtered_files=$(echo "$FILE_ARGS" | grep -Ev '(\.test\.ts|\.spec\.ts)$|/node_modules/|/dist/' || true)
    if [[ -z "$filtered_files" ]]; then
      return
    fi
    echo "$filtered_files" | xargs rg -n "$pattern" "$@" 2>/dev/null || true
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

MATCHES=$(rg_scan 'catch\s*\{' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  violation "Bare catch {} blocks (CLAUDE.md: every catch must check error type)"
  printf '%s\n' "$MATCHES" | head -20 || true
fi

MATCHES=$(rg_scan '\.catch\(\s*\(\s*\)\s*=>' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  violation "Empty .catch(() => ...) — error param ignored (CLAUDE.md: no bare catch)"
  printf '%s\n' "$MATCHES" | head -20 || true
fi

MATCHES=$(rg_scan '\.catch\(\s*\(\s*_\w*\s*\)\s*=>' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Catch with explicitly unused param (_err) — verify error is logged"
  printf '%s\n' "$MATCHES" | head -10 || true
fi

header "2. External Calls — fetch() without AbortSignal.timeout"

# Matches inside template literals are usually documentation (agent
# prompts, iframe-injected bridge scripts, etc.) rather than runtime
# code paths on the gateway. Skip them by tracking backtick parity from
# the file start through the match line: an odd count means the match
# sits inside an unclosed template literal. Escaped backticks (`\``) are
# stripped before counting.
is_in_template_literal() {
  local file="$1" target_line="$2"
  awk -v target="$target_line" '
    NR > target { exit }
    {
      line = $0
      gsub(/\\`/, "", line)
      n = gsub(/`/, "&", line)
      count += n
    }
    END { exit (count % 2 == 0 ? 1 : 0) }
  ' "$file"
}

MATCHES=$(rg_scan 'fetch\(' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  # Check a short source window for each fetch call so multiline options
  # objects with `signal:` on a later line are recognized correctly.
  MISSING_SIGNAL=""
  while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    line_no=$(echo "$line" | cut -d: -f2)
    # Documentation strings inside template literals aren't real fetch calls.
    if is_in_template_literal "$file" "$line_no"; then
      continue
    fi
    window_end=$((line_no + 12))
    call_window=$(sed -n "${line_no},${window_end}p" "$file" 2>/dev/null || true)
    if ! echo "$call_window" | grep -Eq 'signal\s*:'; then
      MISSING_SIGNAL+="$line"$'\n'
    fi
  done <<< "$MATCHES"
  if [[ -n "$MISSING_SIGNAL" ]]; then
    violation "fetch() without signal: (CLAUDE.md: every fetch MUST have AbortSignal.timeout)"
    printf '%s\n' "$MISSING_SIGNAL" | head -20 || true
  fi
fi

header "3. Input Validation — missing bodyLimit on mutating endpoints"

MATCHES=$(rg_scan 'c\.req\.(json|text|blob|arrayBuffer)\(' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Body consumption calls — verify bodyLimit middleware is applied to each route"
  printf '%s\n' "$MATCHES" | head -20 || true
fi

header "4. Resource Management — unbounded in-memory structures"

MATCHES=$(rg_scan 'new (Map|Set)\(' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Map/Set creation — verify each has a size cap and eviction policy"
  printf '%s\n' "$MATCHES" | head -20 || true
fi

MATCHES=$(rg_scan 'buffer \+=' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Buffer concatenation — verify bounded with a size cap"
  printf '%s\n' "$MATCHES" | head -10 || true
fi

header "5. Resource Management — writeFileSync/appendFileSync in handlers"

MATCHES=$(rg_scan '(writeFileSync|appendFileSync)' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
SYNC_IO_ALLOWLIST='packages/kernel/src/(audit|boot|build-pipeline|identity|memory|onboarding|usage)\.ts|packages/gateway/src/(app-fork|app-ops|app-upload|conversation-summary|conversations|cron/store|logger|postgres-manager|security/outbound-queue|session-store|social-connectors/index|storage-tracker|voice/call-store|voice/usage)\.ts'
if [[ -n "$MATCHES" ]]; then
  MATCHES=$(printf '%s\n' "$MATCHES" | grep -Ev "$SYNC_IO_ALLOWLIST" || true)
fi
if [[ -n "$MATCHES" ]]; then
  violation "Sync file I/O (CLAUDE.md: banned in request handlers, use fs/promises)"
  printf '%s\n' "$MATCHES" | head -10 || true
fi

# ═══════════════════════════════════════════════════════════════
# PASS 2: Trust-boundary sweep (Category 2 from review)
# ═══════════════════════════════════════════════════════════════

header "6. Trust Boundaries — path operations on external input"

MATCHES=$(rg_scan '(join|resolve|realpath|rename|unlink)\(' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  warning "Path operations — verify input is validated via resolveWithinPrefix or equivalent"
  printf '%s\n' "$MATCHES" | head -30 || true
fi

header "7. Trust Boundaries — headers and identifiers from external sources"

MATCHES=$(rg_scan '(X-Forwarded-For|X-Peer-Id|X-Real-Ip|peerId|userId)' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**' -i)
if [[ -n "$MATCHES" ]]; then
  warning "External headers/identifiers — verify validated before use in keys, paths, or SQL"
  printf '%s\n' "$MATCHES" | head -20 || true
fi

header "8. Auth Boundaries — legacy request principal resolver"

MATCHES=$(rg_scan 'getUserIdFromContext\s*\(' --glob '*.ts' --glob '!**/*.test.ts' --glob '!**/*.spec.ts' --glob '!**/node_modules/**' --glob '!**/dist/**')
if [[ -n "$MATCHES" ]]; then
  MATCHES=$(printf '%s\n' "$MATCHES" | grep -Ev '^packages/gateway/src/auth\.ts:' || true)
fi
if [[ -n "$MATCHES" ]]; then
  violation "Legacy getUserIdFromContext() used outside auth compatibility wrapper; use request-principal helpers"
  printf '%s\n' "$MATCHES" | head -20 || true
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

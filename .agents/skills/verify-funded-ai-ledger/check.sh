#!/usr/bin/env bash
# Check the funded AI ledger model. Usage:
#   check.sh            the rules (about 1 minute)
#   check.sh --mutants  also prove that each rule can fail
#   check.sh --drift    only list covered files changed since the sync commit
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"

sync="$(sed -n 's/^Sync commit: `\([0-9a-f]\{40\}\)`.*/\1/p' "$here/SKILL.md")"
covered=(
  packages/platform/src/ai-funded-authorization.ts
  packages/platform/src/ai-funded-metering-repository.ts
  packages/platform/src/ai-funded-metering-helpers.ts
  packages/platform/src/ai-funded-reservation-sources.ts
  packages/platform/src/ai-funded-customer-charge-release.ts
  packages/platform/src/ai-funded-customer-credit-cleanup.ts
  packages/platform/src/ai-funded-postpaid-settlement.ts
  packages/platform/src/ai-funded-priority-claims.ts
  packages/platform/src/ai-funded-reservation-indexes.ts
  packages/platform/src/database/migrations/ai-funded.ts
  packages/platform/src/speech/funding.ts
  packages/platform/src/speech/funding-postpaid.ts
)
drift() {
  echo "Covered files changed since sync commit ${sync:0:9}:"
  if ! git -C "$repo" cat-file -e "$sync^{commit}" 2>/dev/null; then
    echo "  sync commit is not in this clone; fetch origin main first"; return 1
  fi
  local changed
  changed="$(git -C "$repo" diff --stat "$sync" -- "${covered[@]}")"
  if [ -z "$changed" ]; then echo "  none"; else echo "$changed"; echo "  -> read SKILL.md, 'When the covered code changed'"; fi
}
if [ "${1:-}" = "--drift" ]; then drift; exit 0; fi

command -v java >/dev/null || { echo "Java 11 or newer is required to run TLC (apt install openjdk-17-jre-headless)"; exit 2; }
cache="${XDG_CACHE_HOME:-$HOME/.cache}/matrix-os-tla"
tlc="$cache/tla2tools-1.7.4.jar"
tlc_sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
if command -v sha256sum >/dev/null; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else echo "sha256sum or shasum is required to check the TLC download"; exit 2; fi
if [ ! -f "$tlc" ] || [ "$(sha256 "$tlc")" != "$tlc_sha" ]; then
  mkdir -p "$cache"
  curl -fsSL --max-time 120 -o "$tlc" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
  [ "$(sha256 "$tlc")" = "$tlc_sha" ] || { echo "TLC download does not match its pinned checksum"; exit 2; }
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
run() { # config -> prints TLC output to $out/<config>.out, returns 0 when no rule breaks
  ( cd "$here/model" && java -XX:+UseParallelGC -cp "$tlc" tlc2.TLC -workers auto \
      -config "$1.cfg" -metadir "$out/states-$1" FundedLedger.tla ) > "$out/$1.out" 2>&1 || true
  grep -q "Model checking completed. No error has been found." "$out/$1.out"
}
status=0
for config in OneRuntime TwoRuntimes; do
  if run "$config"; then
    echo "PASS  $config  ($(grep -o '[0-9]* distinct states found' "$out/$config.out" | tail -1))"
  else
    status=1
    echo "FAIL  $config"
    mkdir -p "$cache/last-failure" && cp "$out/$config.out" "$cache/last-failure/$config.out"
    grep -m1 '^Error:' "$out/$config.out" || tail -5 "$out/$config.out"
    echo "      full TLC output: $cache/last-failure/$config.out"
  fi
done

if [[ " $* " == *" --mutants "* ]]; then python3 "$here/mutants.py" "$tlc" || status=1; fi
drift || true
exit $status

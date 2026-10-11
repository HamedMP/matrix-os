#!/bin/bash
# OpenSSH ForceCommand. The SSH account has no Docker group or generic sudo.
set -euo pipefail
set +x
request=${SSH_ORIGINAL_COMMAND:-}
if [[ ${#request} -gt 100 || ! $request =~ ^run\ ([a-f0-9]{40})\ (unit|unit-shard-[1-4]|typecheck|shell|checks|e2e-general|e2e-electron|full)$ ]]; then
  echo 'Denied: expected run <40-character-sha> <allowlisted-suite>' >&2
  exit 64
fi
sha=${BASH_REMATCH[1]}
suite=${BASH_REMATCH[2]}
workers=2
case "$suite" in unit|unit-shard-*|full) workers=8; if (( $(nproc) >= 16 )); then workers=12; fi ;; esac
exec sudo --non-interactive -- /usr/local/libexec/matrix-ci/start-ephemeral.sh "$sha" "$suite" "$workers"

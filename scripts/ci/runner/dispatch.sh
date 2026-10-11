#!/bin/bash
# Fixed OpenSSH entry; capability is exclusively stdin, never shell arguments.
set -euo pipefail
set +x
request=${SSH_ORIGINAL_COMMAND:-}
if [[ ${#request} -gt 100 || ! $request =~ ^lease-v1\ (run|cancel)\ ([a-f0-9]{32})$ ]]; then
  echo 'Denied: expected lease-v1 run|cancel <32-character-lease>' >&2
  exit 64
fi
action=${BASH_REMATCH[1]}
lease=${BASH_REMATCH[2]}
exec sudo --non-interactive -- /usr/local/libexec/matrix-ci/lease.py "$action" "$lease"

#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$EUID" == 0 ]]; then
  echo "Native stdout qualification requires an unprivileged Linux process." >&2
  exit 1
fi
if ! awk '
  /^Cap(Inh|Prm|Eff):/ { seen++; if ($2 !~ /^0+$/) active=1 }
  END { exit seen != 3 || active }
' /proc/self/status; then
  echo "Native stdout qualification requires empty inheritable, permitted and effective capabilities." >&2
  exit 1
fi

node_path="$(node -p 'process.execPath')"
node_headers="$(dirname "$node_path")/../include/node"
if [[ ! -r "$node_headers/node_api.h" ]]; then
  echo "Native stdout qualification requires the active Node distribution's N-API headers." >&2
  exit 1
fi

temp="$(mktemp -d)"
trap 'rm -rf -- "$temp"' EXIT
c_flags=(-std=c11 -O2 -Wall -Wextra -Werror)
addon_flags=(-fPIC -shared -DNAPI_VERSION=8 "-I$node_headers")
writer=packages/gateway/native/terminal-writer.c
fixtures=tests/gateway/native-stdout-fixtures

cc "${c_flags[@]}" "${addon_flags[@]}" "$writer" -o "$temp/writer.node"
cc "${c_flags[@]}" "${addon_flags[@]}" "$writer" "$fixtures/recv-fault.c" -Wl,--wrap=recvmsg -o "$temp/fault.node"
cc "${c_flags[@]}" "$fixtures/actor.c" -o "$temp/actor"
node --expose-gc tests/gateway/native-stdout-runtime.mjs \
  --addon "$temp/writer.node" --fault-addon "$temp/fault.node" --actor "$temp/actor"

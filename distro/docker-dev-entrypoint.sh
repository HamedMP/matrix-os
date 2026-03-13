#!/bin/bash
set -e

cd /app

# Install deps as root (volume may be root-owned)
if [ ! -d "node_modules/.pnpm" ] || [ "pnpm-lock.yaml" -nt "node_modules/.pnpm-lock-hash" ]; then
  echo "[matrix-os-dev] Installing dependencies..."
  pnpm install --frozen-lockfile
  md5sum pnpm-lock.yaml > node_modules/.pnpm-lock-hash 2>/dev/null || true
fi

# Ensure home directory exists and is owned by matrixos
if [ ! -d "$MATRIX_HOME" ]; then
  echo "[matrix-os-dev] Initializing home directory..."
  mkdir -p "$MATRIX_HOME"
fi
chown -R matrixos:matrixos "$MATRIX_HOME"

# Fix .next cache ownership (bind-mounted volume)
mkdir -p /app/shell/.next
chown -R matrixos:matrixos /app/shell/.next

echo "[matrix-os-dev] Starting gateway + shell as matrixos user..."

# Drop to matrixos user for services (Agent SDK refuses bypassPermissions as root)
exec su-exec matrixos bash -c '
  cd /app

  pnpm --filter shell exec next dev -p 3000 &
  SHELL_PID=$!

  node --import=tsx --watch packages/gateway/src/main.ts &
  GATEWAY_PID=$!

  trap "kill $SHELL_PID $GATEWAY_PID 2>/dev/null; exit 0" SIGTERM SIGINT

  wait -n $SHELL_PID $GATEWAY_PID
  EXIT_CODE=$?
  kill $SHELL_PID $GATEWAY_PID 2>/dev/null
  exit $EXIT_CODE
'

#!/bin/bash
set -e

cd /app

# Install deps if node_modules is empty or lockfile changed
if [ ! -d "node_modules/.pnpm" ] || [ "pnpm-lock.yaml" -nt "node_modules/.pnpm-lock-hash" ]; then
  echo "[matrix-os-dev] Installing dependencies..."
  pnpm install
  # Store hash to detect future lockfile changes
  md5sum pnpm-lock.yaml > node_modules/.pnpm-lock-hash 2>/dev/null || true
fi

# Ensure home directory exists
if [ ! -d "$MATRIX_HOME" ]; then
  echo "[matrix-os-dev] Initializing home directory..."
  mkdir -p "$MATRIX_HOME"
fi

echo "[matrix-os-dev] Starting gateway (tsx watch) + shell (next dev)..."

# Start Next.js dev server in background
cd /app/shell
npx next dev -p 3000 &
SHELL_PID=$!

# Start gateway with tsx watch in foreground
cd /app
npx tsx watch packages/gateway/src/main.ts &
GATEWAY_PID=$!

# Trap signals for clean shutdown
trap "kill $SHELL_PID $GATEWAY_PID 2>/dev/null; exit 0" SIGTERM SIGINT

# Wait for either process to exit
wait -n $SHELL_PID $GATEWAY_PID
EXIT_CODE=$?

# If one exits, kill the other
kill $SHELL_PID $GATEWAY_PID 2>/dev/null
exit $EXIT_CODE

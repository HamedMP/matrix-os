#!/bin/bash
set -e

MATRIX_HOME="${MATRIX_HOME:-/home/user/matrixos}"
echo "Matrix OS starting..."
echo "Home directory: $MATRIX_HOME"

# Docker volumes create empty dirs that trick ensureHome() into skipping setup.
# If the home directory exists but has no system/ folder, copy the template in.
if [ -d "$MATRIX_HOME" ] && [ ! -d "$MATRIX_HOME/system" ]; then
  echo "First boot: initializing home directory from template..."
  cp -r /app/home/* "$MATRIX_HOME/"
  cd "$MATRIX_HOME"
  git init && git add . && git commit -m "Matrix OS: initial state" 2>/dev/null || true
  cd /app
fi

# Start Next.js shell in background (next is hoisted to root node_modules)
cd /app/shell
node ../node_modules/next/dist/bin/next start -p 3000 &
SHELL_PID=$!

# Start gateway (foreground -- main process)
cd /app
exec node --import=tsx packages/gateway/src/main.ts

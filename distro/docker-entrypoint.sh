#!/bin/bash
set -e

MATRIX_HOME="${MATRIX_HOME:-/home/matrixos/home}"
echo "Matrix OS starting..."
echo "Home directory: $MATRIX_HOME"

# Ensure volume is owned by non-root user
chown -R matrixos:matrixos "$MATRIX_HOME" 2>/dev/null || true
chown -R matrixos:matrixos /app 2>/dev/null || true

# First boot: copy template into empty volume
if [ -d "$MATRIX_HOME" ] && [ ! -d "$MATRIX_HOME/system" ]; then
  echo "First boot: initializing home directory from template..."
  su-exec matrixos cp -r /app/home/* "$MATRIX_HOME/"
  cd "$MATRIX_HOME"
  su-exec matrixos git init
  su-exec matrixos git add .
  su-exec matrixos git commit -m "Matrix OS: initial state" 2>/dev/null || true
  cd /app
fi

# Start Next.js shell in background as non-root user
cd /app/shell
su-exec matrixos node ../node_modules/next/dist/bin/next start -p 3000 &
SHELL_PID=$!

# Start gateway as non-root user (foreground -- main process)
cd /app
exec su-exec matrixos node --import=tsx packages/gateway/src/main.ts

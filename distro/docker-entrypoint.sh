#!/bin/bash
set -e

echo "Matrix OS starting..."
echo "Home directory: ${MATRIX_HOME:-/home/user/matrixos}"

# Start Next.js shell in background
cd /app/shell
node node_modules/.bin/next start -p 3000 &
SHELL_PID=$!

# Start gateway (foreground -- main process)
cd /app
exec node --import=tsx packages/gateway/src/main.ts

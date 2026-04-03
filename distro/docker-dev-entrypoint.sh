#!/bin/bash
set -e

cd /app

# Install deps as root (volume may be root-owned)
if [ ! -d "node_modules/.pnpm" ] || [ "pnpm-lock.yaml" -nt "node_modules/.pnpm-lock-hash" ]; then
  echo "[matrix-os-dev] Installing dependencies..."
  pnpm install --frozen-lockfile
  md5sum pnpm-lock.yaml > node_modules/.pnpm-lock-hash 2>/dev/null || true
fi

# Ensure home directory exists
if [ ! -d "$MATRIX_HOME" ]; then
  echo "[matrix-os-dev] Initializing home directory..."
  mkdir -p "$MATRIX_HOME"
fi

# Sync default apps, agents, and system config from source to home volume
# This ensures new/updated system apps and skills propagate to the running OS
echo "[matrix-os-dev] Syncing default apps and skills..."
for dir in apps agents system; do
  if [ -d "/app/home/$dir" ]; then
    mkdir -p "$MATRIX_HOME/$dir"
    cp -a "/app/home/$dir/." "$MATRIX_HOME/$dir/"
  fi
done

# Expose Matrix OS skills as Claude Code skills
# Creates .claude/skills/<name>/SKILL.md symlinks so /skills works in Claude sessions
CLAUDE_SKILLS_DIR="/home/matrixos/.claude/skills"
mkdir -p "$CLAUDE_SKILLS_DIR"
for skill in "$MATRIX_HOME/agents/skills/"*.md; do
  [ -f "$skill" ] || continue
  name=$(basename "$skill" .md)
  mkdir -p "$CLAUDE_SKILLS_DIR/$name"
  ln -sf "$skill" "$CLAUDE_SKILLS_DIR/$name/SKILL.md"
done

# Clear stale Turbopack cache (source files are volume-mounted so cache
# from a previous run often references outdated AST — causes SyntaxErrors)
rm -rf /app/shell/.next/cache
mkdir -p /app/shell/.next
chown -R matrixos:matrixos /app/shell/.next

# QMD: index user home for semantic search (best-effort)
if command -v qmd >/dev/null 2>&1 && [ -d "$MATRIX_HOME" ]; then
  echo "[matrix-os-dev] Setting up QMD search index..."
  mkdir -p "$MATRIX_HOME/system/qmd"
fi

# Fix ownership of everything created as root before dropping to matrixos
chown -R matrixos:matrixos "$MATRIX_HOME"

# Set zsh as default shell for matrixos user (for PTY sessions)
if command -v zsh >/dev/null 2>&1; then
  export SHELL=/bin/zsh
fi

echo "[matrix-os-dev] Starting gateway + shell as matrixos user..."

# Drop to matrixos user for services (Agent SDK refuses bypassPermissions as root)
exec su-exec matrixos bash -c '
  export SHELL=/bin/zsh
  cd /app

  # QMD: register collections + start MCP server (best-effort, background)
  if command -v qmd >/dev/null 2>&1 && [ -d "$MATRIX_HOME" ]; then
    export XDG_CACHE_HOME="$MATRIX_HOME/system/qmd"
    export XDG_CONFIG_HOME="$MATRIX_HOME/system/qmd"

    qmd_add() {
      dir="$1"; name="$2"; mask="$3"
      [ -d "$dir" ] && qmd collection add "$dir" --name "$name" --mask "$mask" 2>/dev/null || true
    }

    qmd_add "$MATRIX_HOME/agents/knowledge"     knowledge     "**/*.md"
    qmd_add "$MATRIX_HOME/agents/skills"         skills        "**/*.md"
    qmd_add "$MATRIX_HOME/system/summaries"      summaries     "**/*.md"
    qmd_add "$MATRIX_HOME/system/conversations"  conversations "**/*.json"
    qmd_add "$MATRIX_HOME/apps"                  apps          "**/*.html"

    qmd update 2>/dev/null || true
    qmd mcp --http --port 8182 --daemon 2>/dev/null || true
    echo "[matrix-os-dev] QMD search ready (BM25)"
  fi

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

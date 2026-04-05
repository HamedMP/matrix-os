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
echo "[matrix-os-dev] Syncing default apps and skills..."
for dir in apps agents system; do
  if [ -d "/app/home/$dir" ]; then
    rm -rf "$MATRIX_HOME/$dir"
    cp -r "/app/home/$dir" "$MATRIX_HOME/$dir"
  fi
done

# Expose Matrix OS skills to Claude Code and Codex
# Clean stale copies from previous runs, then create fresh ones.
# Both tools discover skills in project-level and user-level directories.
rm -rf "$MATRIX_HOME/.claude/skills" "$MATRIX_HOME/.codex/skills" \
       "/home/matrixos/.claude/skills" "/home/matrixos/.codex/skills"

for skills_root in "/home/matrixos/.claude/skills" "$MATRIX_HOME/.claude/skills"; do
  mkdir -p "$skills_root"
  for skill in "$MATRIX_HOME/agents/skills/"*.md; do
    [ -f "$skill" ] || continue
    name=$(basename "$skill" .md)
    mkdir -p "$skills_root/$name"
    sed "s/^name: .*/name: matrix-$name/" "$skill" > "$skills_root/$name/SKILL.md"
  done
done

# Codex ignores symlinks and needs agents/openai.yaml for discovery
for skills_root in "/home/matrixos/.codex/skills" "$MATRIX_HOME/.codex/skills"; do
  mkdir -p "$skills_root"
  for skill in "$MATRIX_HOME/agents/skills/"*.md; do
    [ -f "$skill" ] || continue
    name=$(basename "$skill" .md)
    mkdir -p "$skills_root/$name/agents"
    cp -f "$skill" "$skills_root/$name/SKILL.md"
    display=$(echo "$name" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')
    desc=$(sed -n 's/^description: *//p' "$skill" | head -1)
    cat > "$skills_root/$name/agents/openai.yaml" <<EOYAML
interface:
  display_name: "Matrix: $display"
  short_description: "${desc:-$display skill}"
  default_prompt: "Use \$$name for ${desc:-this task}."
EOYAML
  done
done

# AI CLI auth persistence via shared external volume (matrixos-ai-auth)
# Survives container rebuilds and is shared across feature branch containers.
AI_AUTH="/home/matrixos/.ai-auth"
if [ -d "$AI_AUTH" ]; then
  mkdir -p "$AI_AUTH/claude" "$AI_AUTH/codex"
  # Restore auth into project-level dirs if not already present
  [ -f "$AI_AUTH/claude/.credentials.json" ] && [ ! -f "$MATRIX_HOME/.claude/.credentials.json" ] && \
    mkdir -p "$MATRIX_HOME/.claude" && cp "$AI_AUTH/claude/.credentials.json" "$MATRIX_HOME/.claude/.credentials.json" && \
    echo "[matrix-os-dev] Restored Claude auth from shared volume"
  [ -f "$AI_AUTH/codex/auth.json" ] && [ ! -f "$MATRIX_HOME/.codex/auth.json" ] && \
    mkdir -p "$MATRIX_HOME/.codex" && cp "$AI_AUTH/codex/auth.json" "$MATRIX_HOME/.codex/auth.json" && \
    echo "[matrix-os-dev] Restored Codex auth from shared volume"
  # Save current auth back (in case user logged in during previous session)
  [ -f "$MATRIX_HOME/.claude/.credentials.json" ] && cp "$MATRIX_HOME/.claude/.credentials.json" "$AI_AUTH/claude/.credentials.json" 2>/dev/null || true
  [ -f "$MATRIX_HOME/.codex/auth.json" ] && cp "$MATRIX_HOME/.codex/auth.json" "$AI_AUTH/codex/auth.json" 2>/dev/null || true
fi

# Clear stale Turbopack cache (source files are volume-mounted so cache
# from a previous run often references outdated AST -- causes SyntaxErrors)
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

  trap "
    # Save auth to shared volume before exit
    AI_AUTH=/home/matrixos/.ai-auth
    if [ -d \"\$AI_AUTH\" ]; then
      mkdir -p \"\$AI_AUTH/claude\" \"\$AI_AUTH/codex\"
      [ -f \"$MATRIX_HOME/.claude/.credentials.json\" ] && cp \"$MATRIX_HOME/.claude/.credentials.json\" \"\$AI_AUTH/claude/.credentials.json\" 2>/dev/null
      [ -f \"$MATRIX_HOME/.codex/auth.json\" ] && cp \"$MATRIX_HOME/.codex/auth.json\" \"\$AI_AUTH/codex/auth.json\" 2>/dev/null
    fi
    kill \$SHELL_PID \$GATEWAY_PID 2>/dev/null; exit 0
  " SIGTERM SIGINT

  wait -n $SHELL_PID $GATEWAY_PID
  EXIT_CODE=$?
  kill $SHELL_PID $GATEWAY_PID 2>/dev/null
  exit $EXIT_CODE
'

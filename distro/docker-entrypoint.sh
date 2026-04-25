#!/bin/bash
set -e

MATRIX_HOME="${MATRIX_HOME:-/home/matrixos/home}"
echo "Matrix OS starting..."
echo "Home directory: $MATRIX_HOME"

# Ensure volume mount is owned by non-root user (skip /app -- already correct from build)
chown -R matrixos:matrixos "$MATRIX_HOME" 2>/dev/null || true

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

# Unify SSH config: terminal panes run with HOME=$MATRIX_HOME, so `ssh-keygen`
# / `gh auth login` write into $MATRIX_HOME/.ssh, but `ssh` itself uses the
# passwd-derived $HOME (/home/matrixos), so it never finds the key. Symlink
# the canonical $MATRIX_HOME/.ssh into the user home — same pattern the dev
# entrypoint uses for .claude and .codex.
mkdir -p "$MATRIX_HOME/.ssh"
chown matrixos:matrixos "$MATRIX_HOME/.ssh"
chmod 700 "$MATRIX_HOME/.ssh"
if [ -d /home/matrixos/.ssh ] && [ ! -L /home/matrixos/.ssh ]; then
  # Migrate any pre-existing keys/known_hosts (no-clobber) before replacing.
  cp -an /home/matrixos/.ssh/. "$MATRIX_HOME/.ssh/" 2>/dev/null || true
  rm -rf /home/matrixos/.ssh
fi
ln -sfn "$MATRIX_HOME/.ssh" /home/matrixos/.ssh

# Expose Matrix OS skills to Claude Code (and Codex). Both tools discover
# skills in $HOME/.claude/skills and $HOME/.codex/skills. Without this sync
# the user sees "No skills found" inside Claude Code even though skills
# live at $MATRIX_HOME/agents/skills/. Re-runs every boot so deletions and
# updates flow through.
echo "Syncing Matrix skills into ~/.claude/skills and ~/.codex/skills..."
cleanup_matrix_skills() {
  skills_root="$1"
  mkdir -p "$skills_root"
  for generated in "$skills_root"/matrix-*; do
    [ -e "$generated" ] || continue
    [ -f "$generated/.matrix-os-managed" ] && rm -rf "$generated"
  done
  for skill in "$MATRIX_HOME/agents/skills/"*.md; do
    [ -f "$skill" ] || continue
    name=$(basename "$skill" .md)
    legacy="$skills_root/$name"
    if [ -f "$legacy/SKILL.md" ] && grep -q "^name: matrix-$name\$" "$legacy/SKILL.md"; then
      rm -rf "$legacy"
    elif [ -f "$legacy/agents/openai.yaml" ] && grep -q 'display_name: "Matrix:' "$legacy/agents/openai.yaml"; then
      rm -rf "$legacy"
    fi
  done
}
for skills_root in "/home/matrixos/.claude/skills" "/home/matrixos/.codex/skills" \
                   "$MATRIX_HOME/.claude/skills" "$MATRIX_HOME/.codex/skills"; do
  cleanup_matrix_skills "$skills_root"
done
for skills_root in "/home/matrixos/.claude/skills" "$MATRIX_HOME/.claude/skills"; do
  mkdir -p "$skills_root"
  for skill in "$MATRIX_HOME/agents/skills/"*.md; do
    [ -f "$skill" ] || continue
    name=$(basename "$skill" .md)
    out="$skills_root/matrix-$name"
    mkdir -p "$out"
    sed "s/^name: .*/name: matrix-$name/" "$skill" > "$out/SKILL.md"
    touch "$out/.matrix-os-managed"
  done
done
for skills_root in "/home/matrixos/.codex/skills" "$MATRIX_HOME/.codex/skills"; do
  mkdir -p "$skills_root"
  for skill in "$MATRIX_HOME/agents/skills/"*.md; do
    [ -f "$skill" ] || continue
    name=$(basename "$skill" .md)
    out="$skills_root/matrix-$name"
    mkdir -p "$out/agents"
    sed "s/^name: .*/name: matrix-$name/" "$skill" > "$out/SKILL.md"
    touch "$out/.matrix-os-managed"
    display=$(echo "$name" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')
    desc=$(sed -n 's/^description: *//p' "$skill" | head -1)
    short_desc=$(printf '%s' "${desc:-$display skill}" | sed 's/\\/\\\\/g; s/"/\\"/g')
    prompt_desc=$(printf '%s' "${desc:-this task}" | sed 's/\\/\\\\/g; s/"/\\"/g')
    cat > "$out/agents/openai.yaml" <<EOYAML
interface:
  display_name: "Matrix: $display"
  short_description: "$short_desc"
  default_prompt: "Use \$matrix-$name for $prompt_desc."
EOYAML
  done
done
chown -R matrixos:matrixos /home/matrixos/.claude /home/matrixos/.codex 2>/dev/null || true

# Start Next.js shell in background as non-root user
cd /app/shell
su-exec matrixos node ../node_modules/next/dist/bin/next start -p 3000 &
SHELL_PID=$!

# Start gateway as non-root user (foreground -- main process)
cd /app
exec su-exec matrixos node --import=tsx packages/gateway/src/main.ts

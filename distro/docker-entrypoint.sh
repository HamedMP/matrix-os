#!/bin/bash
set -e

MATRIX_HOME="${MATRIX_HOME:-/home/matrixos/home}"
echo "Matrix OS starting..."
echo "Home directory: $MATRIX_HOME"
echo "Image: ${MATRIX_IMAGE:-unknown}"
echo "Build: ref=${MATRIX_BUILD_REF:-unknown} sha=${MATRIX_BUILD_SHA:-unknown} date=${MATRIX_BUILD_DATE:-unknown}"

# Ensure volume mount is owned by non-root user (skip /app -- already correct from build)
chown -R matrixos:matrixos "$MATRIX_HOME" 2>/dev/null || true

install_shell_config() {
  target_home="$1"
  mkdir -p "$target_home"

  # zsh runs its first-use installer when no startup files exist. Seed the
  # Matrix defaults into both the persistent Matrix home and passwd home, but
  # do not overwrite a user's customized shell files.
  if [ -f /app/distro/zshrc ] && [ ! -e "$target_home/.zshrc" ]; then
    cp /app/distro/zshrc "$target_home/.zshrc"
  fi
  if [ -f /app/distro/p10k.zsh ] && [ ! -e "$target_home/.p10k.zsh" ]; then
    cp /app/distro/p10k.zsh "$target_home/.p10k.zsh"
  fi
  chown matrixos:matrixos "$target_home/.zshrc" "$target_home/.p10k.zsh" 2>/dev/null || true
}

install_shell_config "$MATRIX_HOME"
install_shell_config "/home/matrixos"

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

start_matrix_code_server() {
  if ! command -v code-server >/dev/null 2>&1; then
    echo "code-server is not installed; code.matrix-os.com editor disabled"
    return
  fi

  code_server_port="${MATRIX_CODE_SERVER_PORT:-8787}"
  code_server_root="$MATRIX_HOME/system/code-server"
  mkdir -p "$code_server_root/user-data" "$code_server_root/extensions"
  chown -R matrixos:matrixos "$code_server_root"

  echo "Starting Matrix Code editor on :$code_server_port"
  su-exec matrixos env -u PORT -u HOST code-server \
    --auth none \
    --bind-addr "0.0.0.0:$code_server_port" \
    --disable-telemetry \
    --disable-update-check \
    --user-data-dir "$code_server_root/user-data" \
    --extensions-dir "$code_server_root/extensions" \
    "$MATRIX_HOME" &
  CODE_SERVER_PID=$!
}

start_matrix_code_server

# Start Next.js shell in background as non-root user
cd /app/shell
su-exec matrixos node ../node_modules/next/dist/bin/next start -p 3000 &
SHELL_PID=$!

# Start gateway as non-root user (foreground -- main process)
cd /app
exec su-exec matrixos node --import=tsx packages/gateway/src/main.ts

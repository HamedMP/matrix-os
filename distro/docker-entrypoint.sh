#!/bin/bash
set -e

MATRIX_HOME="${MATRIX_HOME:-/home/matrixos/home}"
export PATH="/app/node_modules/.bin:$PATH"
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

# Unify AI CLI auth directories. Terminal panes use HOME=$MATRIX_HOME, while
# gateway/kernel processes run with HOME=/home/matrixos. Without this, a
# `claude login` completed in the web terminal can write credentials to a
# different directory than the process that later invokes Claude Code.
mkdir -p /home/matrixos/.agents /home/matrixos/.claude /home/matrixos/.codex "$MATRIX_HOME"
for tool in .agents .claude .codex; do
  if [ -e "$MATRIX_HOME/$tool" ] && [ ! -L "$MATRIX_HOME/$tool" ]; then
    cp -an "$MATRIX_HOME/$tool/." "/home/matrixos/$tool/" 2>/dev/null || true
    rm -rf "$MATRIX_HOME/$tool"
  fi
  ln -sfn "/home/matrixos/$tool" "$MATRIX_HOME/$tool"
done

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

echo "Ensuring bundled default app builds..."
find /app/home/apps -path '*/dist/index.html' -type f 2>/dev/null | while read -r built_index; do
  built_app=$(dirname "$(dirname "$built_index")")
  app_rel=${built_app#/app/home/apps/}
  target_app="$MATRIX_HOME/apps/$app_rel"
  [ -d "$target_app" ] || continue
  if [ ! -d "$target_app/dist" ]; then
    mkdir -p "$target_app"
    cp -R "$built_app/dist" "$target_app/dist"
    if [ -f "$built_app/.build-stamp" ]; then
      cp "$built_app/.build-stamp" "$target_app/.build-stamp"
    fi
    chown -R matrixos:matrixos "$target_app/dist" "$target_app/.build-stamp" 2>/dev/null || true
  fi
done

echo "Ensuring cloud workspace runtime directories..."
mkdir -p \
  "$MATRIX_HOME/projects" \
  "$MATRIX_HOME/system/sessions" \
  "$MATRIX_HOME/system/session-output" \
  "$MATRIX_HOME/system/reviews" \
  "$MATRIX_HOME/system/ops" \
  "$MATRIX_HOME/system/zellij/layouts" \
  "$MATRIX_HOME/system/agent-scratch" \
  "$MATRIX_HOME/system/code-server"
chown -R matrixos:matrixos \
  "$MATRIX_HOME/projects" \
  "$MATRIX_HOME/system/sessions" \
  "$MATRIX_HOME/system/session-output" \
  "$MATRIX_HOME/system/reviews" \
  "$MATRIX_HOME/system/ops" \
  "$MATRIX_HOME/system/zellij" \
  "$MATRIX_HOME/system/agent-scratch" \
  "$MATRIX_HOME/system/code-server"

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

# Expose the canonical Hermes-format Matrix skill pack to Matrix, Claude Code,
# and Codex. Codex reads ~/.agents/skills; Claude reads ~/.claude/skills.
echo "Syncing Matrix skills into .agents and .claude skill directories..."
MATRIX_SKILL_TARGETS=matrix,claude,codex \
  MATRIX_SKILLS_SOURCE=/app/skills/matrix \
  HOME=/home/matrixos \
  MATRIX_HOME="$MATRIX_HOME" \
  bash /app/scripts/sync-matrix-agent-skills.sh
chown -R matrixos:matrixos /home/matrixos/.agents /home/matrixos/.claude /home/matrixos/.codex 2>/dev/null || true

start_matrix_code_server() {
  if ! command -v code-server >/dev/null 2>&1; then
    echo "code-server is not installed; code.matrix-os.com editor disabled"
    return
  fi
  if [ -z "${MATRIX_CODE_PROXY_TOKEN:-}" ]; then
    echo "MATRIX_CODE_PROXY_TOKEN is not set; code.matrix-os.com editor disabled"
    return
  fi

  code_server_port="${MATRIX_CODE_SERVER_PORT:-8787}"
  code_server_upstream_port="${MATRIX_CODE_SERVER_UPSTREAM_PORT:-8788}"
  code_server_root="$MATRIX_HOME/system/code-server"
  mkdir -p "$code_server_root/user-data" "$code_server_root/extensions"
  chown -R matrixos:matrixos "$code_server_root"

  echo "Starting Matrix Code editor on 127.0.0.1:$code_server_upstream_port behind authenticated proxy :$code_server_port"
  su-exec matrixos env -u PORT -u HOST code-server \
    --auth none \
    --bind-addr "127.0.0.1:$code_server_upstream_port" \
    --disable-telemetry \
    --disable-update-check \
    --user-data-dir "$code_server_root/user-data" \
    --extensions-dir "$code_server_root/extensions" \
    "$MATRIX_HOME" &
  CODE_SERVER_PID=$!

  MATRIX_CODE_PROXY_LISTEN="$code_server_port" MATRIX_CODE_PROXY_UPSTREAM="$code_server_upstream_port" node <<'EOF' &
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");

const token = process.env.MATRIX_CODE_PROXY_TOKEN || "";
const listenPort = Number(process.env.MATRIX_CODE_PROXY_LISTEN || "8787");
const upstreamPort = Number(process.env.MATRIX_CODE_PROXY_UPSTREAM || "8788");

function authorized(req) {
  const value = String(req.headers["x-matrix-code-proxy-token"] || "");
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function scrubHeaders(headers) {
  const next = { ...headers };
  delete next["x-matrix-code-proxy-token"];
  return next;
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { "cache-control": "no-store" });
    res.end("Unauthorized");
    return;
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: scrubHeaders(req.headers),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    res.writeHead(502, { "cache-control": "no-store" });
    res.end("Editor unavailable");
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.connect(upstreamPort, "127.0.0.1", () => {
    const headers = scrubHeaders(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

server.listen(listenPort, "0.0.0.0");
EOF
  CODE_PROXY_PID=$!
}

start_matrix_code_server

# Start Next.js shell in background as non-root user
cd /app/shell
su-exec matrixos node ../node_modules/next/dist/bin/next start -p 3000 &
SHELL_PID=$!

# Start gateway as non-root user (foreground -- main process)
cd /app
exec su-exec matrixos node --import=tsx packages/gateway/src/main.ts

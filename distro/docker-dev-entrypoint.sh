#!/bin/bash
set -e

ENTRYPOINT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$ENTRYPOINT_DIR/.." && pwd)"

cd "$APP_ROOT"
export PATH="$APP_ROOT/node_modules/.bin:$PATH"

prepare_build_outputs() {
  local package base output peer alias link
  for package in brand observability terminal-runtime kernel; do
    base="$APP_ROOT/packages/$package"
    peer="$APP_ROOT/packages/.matrix-publish-$package"
    alias="../.matrix-publish-$package/dist"
    for output in "$APP_ROOT/packages" "$base" "$base/.matrix-build-cache" "$base/.matrix-build-output" "$peer" "$peer/dist"; do
      if [ -L "$output" ]; then
        echo "[matrix-os-dev] Refusing symlinked build output: $output" >&2
        return 1
      fi
    done
    if [ -L "$base/dist" ] && [ "$(readlink "$base/dist")" != "$alias" ]; then
      echo "[matrix-os-dev] Refusing symlinked build output: $base/dist" >&2
      return 1
    fi
    mkdir -p "$base/.matrix-build-cache" "$base/.matrix-build-output" "$peer"
    chmod 700 "$base/.matrix-build-output"
    # Only the generated peer is writable. A same-depth location preserves
    # package-relative template and map paths, even for realpath-based imports.
    if [ -d "$base/dist" ] && [ ! -L "$base/dist" ]; then
      if [ -e "$peer/dist" ]; then echo "Ambiguous retained dev build output" >&2; return 1; fi
      mv "$base/dist" "$peer/dist"
    fi
    mkdir -p "$peer/dist"
    if [ ! -L "$base/dist" ]; then ln -s "$alias" "$base/dist"; fi
    for link in package.json node_modules src; do
      if [ ! -L "$peer/$link" ]; then ln -s "../$package/$link" "$peer/$link"; fi
      if [ "$(readlink "$peer/$link")" != "../$package/$link" ]; then echo "Invalid build peer link" >&2; return 1; fi
    done
    chmod 755 "$peer"
    chown -hR matrixos:matrixos "$peer" "$base/.matrix-build-cache" "$base/.matrix-build-output"
  done
}

prepare_kernel_marker() {
  # A preceding host build may own the marker. Work only on the opened inode;
  # validate a generated digest before changing ownership or permissions.
  python3 -I - "$APP_ROOT/packages/kernel/matrix-kernel-published.tsbuildinfo" <<'PY_MARKER'
import os, pwd, re, stat, sys

fd = os.open(sys.argv[1], os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o644)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size not in (0, 64):
        raise ValueError("Invalid Kernel publication marker")
    if info.st_size and not re.fullmatch(b"[0-9a-f]{64}", os.read(fd, 65)):
        raise ValueError("Invalid Kernel publication marker contents")
    owner = pwd.getpwnam("matrixos")
    os.fchown(fd, owner.pw_uid, owner.pw_gid)
    os.fchmod(fd, 0o644)
finally:
    os.close(fd)
PY_MARKER
}

build_dev_packages() {
  prepare_build_outputs
  prepare_kernel_marker
  su-exec matrixos pnpm --filter @matrix-os/observability build
  su-exec matrixos pnpm --filter @matrix-os/brand build
  su-exec matrixos "$ENTRYPOINT_DIR/docker-dev-entrypoint.sh" --prepare-gateway
  su-exec matrixos pnpm --filter @matrix-os/kernel build
}

prepare_gateway() {
  echo "[matrix-os-dev] Building terminal runtime package..."
  # The gateway imports @matrix-os/terminal-runtime through package exports that
  # point at emitted dist files, which are absent from a clean Docker bind mount.
  pnpm --filter @matrix-os/terminal-runtime build
}

launch_gateway() {
  exec node scripts/dev-gateway.mjs
}

case "${1:-}" in
  --build-dev-packages)
    build_dev_packages
    exit 0
    ;;
  --prepare-build-outputs)
    prepare_build_outputs
    exit 0
    ;;
  --prepare-gateway)
    prepare_gateway
    exit 0
    ;;
  --launch-gateway)
    launch_gateway
    ;;
esac

# Install deps as root (volume may be root-owned).
#
# Content-hash based, NOT mtime based: git operations (checkout/cherry-pick/
# rebase/pull) don't reliably bump pnpm-lock.yaml's mtime, so an mtime check
# (`-nt`) can silently skip a reinstall after deps actually changed — the shell
# then breaks with "Module not found" even after a restart. md5sum -c compares
# the real content, so a restart always reinstalls iff the lockfile changed.
ensure_deps() {
  if [ -d "node_modules/.pnpm" ] && md5sum -c node_modules/.pnpm-lock-hash >/dev/null 2>&1; then
    return 0
  fi
  echo "[matrix-os-dev] Installing dependencies (lockfile changed)..."
  # Host worktrees share pnpm's global virtual store, but this container
  # installs as root before dropping to matrixos. Keep the Docker dependency
  # volume self-contained so its links remain readable after the user switch.
  pnpm install --frozen-lockfile --config.enableGlobalVirtualStore=false
  md5sum pnpm-lock.yaml > node_modules/.pnpm-lock-hash 2>/dev/null || true
}
ensure_deps

build_dev_packages

# Ensure home directory exists
if [ ! -d "$MATRIX_HOME" ]; then
  echo "[matrix-os-dev] Initializing home directory..."
  mkdir -p "$MATRIX_HOME"
fi

# First-boot only: seed agents/system/apps from the template so the skills-to-
# Claude/Codex adapter below has files to read. On subsequent boots the kernel's
# smartSyncTemplate (packages/kernel/src/boot.ts) takes over -- it respects user
# customizations via .template-manifest.json hash compare, adds new template
# files, and skips files the user has touched. The previous version of this
# block did `rm -rf` + `cp -r` on every boot, which clobbered user
# customizations and broke the docker-test customized-files scenario.
for dir in agents system apps; do
  if [ -d "/app/home/$dir" ] && [ ! -d "$MATRIX_HOME/$dir" ]; then
    cp -r "/app/home/$dir" "$MATRIX_HOME/$dir"
  fi
done

if [ "${MATRIX_SKIP_DEFAULT_APP_BUILD:-}" = "true" ]; then
  echo "[matrix-os-dev] Skipping bundled default app builds (MATRIX_SKIP_DEFAULT_APP_BUILD=true)"
else
  echo "[matrix-os-dev] Building bundled default apps..."
  node /app/scripts/build-default-apps.mjs /app/home/apps
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
    fi
  done
fi

# Unify $HOME/.agents/.claude/.codex and matching $MATRIX_HOME paths into a
# single directory. The gateway runs with HOME=/home/matrixos and reads
# $HOME/.claude/.credentials.json, but the in-app terminal opens with
# HOME=$MATRIX_HOME -- so `claude login` from inside Matrix OS used to write
# to a file the gateway never read. Symlinking $MATRIX_HOME/.claude to the
# canonical /home/matrixos/.claude makes both paths the same on disk.
mkdir -p /home/matrixos/.agents /home/matrixos/.claude /home/matrixos/.codex "$MATRIX_HOME"
for tool in .agents .claude .codex; do
  if [ -e "$MATRIX_HOME/$tool" ] && [ ! -L "$MATRIX_HOME/$tool" ]; then
    # First-run migration: move any pre-existing files into the canonical
    # location (-n = no clobber, so a fresher token there always wins).
    cp -an "$MATRIX_HOME/$tool/." "/home/matrixos/$tool/" 2>/dev/null || true
    rm -rf "$MATRIX_HOME/$tool"
  fi
  ln -sfn "/home/matrixos/$tool" "$MATRIX_HOME/$tool"
done

# Expose the canonical Hermes-format Matrix skill pack to Matrix, Claude Code,
# and Codex. Codex reads ~/.agents/skills; Claude reads ~/.claude/skills.
MATRIX_SKILL_TARGETS=matrix,claude,codex \
  MATRIX_SKILLS_SOURCE=/app/skills/matrix \
  HOME=/home/matrixos \
  MATRIX_HOME="$MATRIX_HOME" \
  bash /app/scripts/sync-matrix-agent-skills.sh
chown -R matrixos:matrixos /home/matrixos/.agents /home/matrixos/.claude /home/matrixos/.codex 2>/dev/null || true

# AI CLI auth persistence via shared external volume (matrixos-ai-auth)
# Survives container rebuilds and is shared across feature branch containers.
AI_AUTH="/home/matrixos/.ai-auth"
USER_CLAUDE="/home/matrixos/.claude"
USER_CODEX="/home/matrixos/.codex"
if [ -d "$AI_AUTH" ]; then
  mkdir -p "$AI_AUTH/claude" "$AI_AUTH/codex"
  # Restore auth into both $HOME/.claude/ and $MATRIX_HOME/.claude/
  # The kernel's query() spawns claude from /app, so it needs $HOME/.claude/
  for dest in "$USER_CLAUDE" "$MATRIX_HOME/.claude"; do
    if [ -f "$AI_AUTH/claude/.credentials.json" ] && [ ! -f "$dest/.credentials.json" ]; then
      mkdir -p "$dest"
      cp "$AI_AUTH/claude/.credentials.json" "$dest/.credentials.json"
      echo "[matrix-os-dev] Restored Claude auth to $dest"
    fi
  done
  for dest in "$USER_CODEX" "$MATRIX_HOME/.codex"; do
    if [ -f "$AI_AUTH/codex/auth.json" ] && [ ! -f "$dest/auth.json" ]; then
      mkdir -p "$dest"
      cp "$AI_AUTH/codex/auth.json" "$dest/auth.json"
      echo "[matrix-os-dev] Restored Codex auth to $dest"
    fi
  done
  # Save current auth back (check both locations)
  for src in "$USER_CLAUDE" "$MATRIX_HOME/.claude"; do
    [ -f "$src/.credentials.json" ] && cp "$src/.credentials.json" "$AI_AUTH/claude/.credentials.json" 2>/dev/null && break || true
  done
  for src in "$USER_CODEX" "$MATRIX_HOME/.codex"; do
    [ -f "$src/auth.json" ] && cp "$src/auth.json" "$AI_AUTH/codex/auth.json" 2>/dev/null && break || true
  done
fi

# Clear stale Turbopack cache (source files are volume-mounted so cache
# from a previous run often references outdated AST -- causes SyntaxErrors)
rm -rf /app/shell/.next/cache
mkdir -p /app/shell/.next
chown -R matrixos:matrixos /app/shell/.next
if [ "${MATRIX_DOCKER_CHOWN_SOURCE:-}" = "true" ]; then
  # Next dev rewrites next-env.d.ts during startup. The source tree is bind
  # mounted from the host, so make this one generated type file writable before
  # dropping to the non-root matrixos user.
  if [ -e /app/shell/next-env.d.ts ]; then
    chmod ug+rw /app/shell/next-env.d.ts 2>/dev/null || true
  else
    install -m 0664 /dev/null /app/shell/next-env.d.ts 2>/dev/null || true
  fi
  chown matrixos:matrixos /app/shell/next-env.d.ts 2>/dev/null || true
fi

# QMD: index user home for semantic search (best-effort)
if command -v qmd >/dev/null 2>&1 && [ -d "$MATRIX_HOME" ]; then
  echo "[matrix-os-dev] Setting up QMD search index..."
  mkdir -p "$MATRIX_HOME/system/qmd"
fi

# Sync shell config into the Matrix home volume so terminal sessions whose HOME
# points at $MATRIX_HOME load the same config and user-local PATH entries.
cp /app/distro/zshrc "$MATRIX_HOME/.zshrc" 2>/dev/null || true
cp /app/distro/p10k.zsh "$MATRIX_HOME/.p10k.zsh" 2>/dev/null || true

# Fix ownership of everything created as root before dropping to matrixos
chown -R matrixos:matrixos "$MATRIX_HOME"
chown -R matrixos:matrixos /home/matrixos/.claude 2>/dev/null || true
chown -R matrixos:matrixos /home/matrixos/.codex 2>/dev/null || true
chown matrixos:matrixos "$MATRIX_HOME/.zshrc" "$MATRIX_HOME/.p10k.zsh" 2>/dev/null || true

# Set zsh as default shell for matrixos user (for PTY sessions)
if command -v zsh >/dev/null 2>&1; then
  export SHELL=/bin/zsh
fi

# Auto-heal dependencies while the stack is running. Without this, changing deps
# on a running container (branch switch, cherry-pick, git pull, adding a package)
# leaves the named-volume node_modules stale and the shell breaks with "Module
# not found" until a manual restart. Poll the lockfile and reinstall in the
# background so HMR just picks up new modules. Disable with MATRIX_DEV_DEP_WATCH=0.
if [ "${MATRIX_DEV_DEP_WATCH:-1}" != "0" ]; then
  (
    while true; do
      sleep 5
      md5sum -c node_modules/.pnpm-lock-hash >/dev/null 2>&1 && continue
      echo "[matrix-os-dev] Lockfile changed -- reinstalling dependencies..."
      if pnpm install --frozen-lockfile --config.enableGlobalVirtualStore=false; then
        md5sum pnpm-lock.yaml > node_modules/.pnpm-lock-hash 2>/dev/null || true
        echo "[matrix-os-dev] Dependencies synced; HMR will pick up changes."
      else
        echo "[matrix-os-dev] pnpm install failed; will retry on next lockfile change."
      fi
    done
  ) &
  echo "[matrix-os-dev] Dependency watcher running (auto-reinstall on lockfile change)."
fi

echo "[matrix-os-dev] Starting gateway + shell as matrixos user..."

# Drop to matrixos user for services (Agent SDK refuses bypassPermissions as root)
exec su-exec matrixos bash -c '
  export SHELL=/bin/zsh
  export PATH="/app/node_modules/.bin:$PATH"
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
    qmd_add "$MATRIX_HOME/.agents/skills"        skills        "**/SKILL.md"
    qmd_add "$MATRIX_HOME/system/summaries"      summaries     "**/*.md"
    qmd_add "$MATRIX_HOME/system/conversations"  conversations "**/*.json"
    qmd_add "$MATRIX_HOME/apps"                  apps          "**/*.html"

    qmd update 2>/dev/null || true
    qmd mcp --http --port 8182 --daemon 2>/dev/null || true
    echo "[matrix-os-dev] QMD search ready (BM25)"
  fi

  if command -v code-server >/dev/null 2>&1; then
    CODE_SERVER_PORT="${MATRIX_CODE_SERVER_PORT:-8787}"
    CODE_SERVER_UPSTREAM_PORT="${MATRIX_CODE_SERVER_UPSTREAM_PORT:-8788}"
    CODE_SERVER_ROOT="$MATRIX_HOME/system/code-server"
    mkdir -p "$CODE_SERVER_ROOT/user-data" "$CODE_SERVER_ROOT/extensions"
    if [ -n "${MATRIX_CODE_PROXY_TOKEN:-}" ]; then
      echo "[matrix-os-dev] Starting Matrix Code editor on 127.0.0.1:$CODE_SERVER_UPSTREAM_PORT behind authenticated proxy :$CODE_SERVER_PORT"
      env -u PORT -u HOST code-server \
        --auth none \
        --bind-addr "127.0.0.1:$CODE_SERVER_UPSTREAM_PORT" \
        --disable-telemetry \
        --disable-update-check \
        --user-data-dir "$CODE_SERVER_ROOT/user-data" \
        --extensions-dir "$CODE_SERVER_ROOT/extensions" \
        "$MATRIX_HOME" &
      CODE_SERVER_PID=$!
      MATRIX_CODE_PROXY_LISTEN="$CODE_SERVER_PORT" MATRIX_CODE_PROXY_UPSTREAM="$CODE_SERVER_UPSTREAM_PORT" node <<\CODE_PROXY_EOF &
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
CODE_PROXY_EOF
      CODE_PROXY_PID=$!
    else
      echo "[matrix-os-dev] MATRIX_CODE_PROXY_TOKEN is not set; code.matrix-os.com editor disabled"
      CODE_SERVER_PID=
      CODE_PROXY_PID=
    fi
  else
    echo "[matrix-os-dev] code-server is not installed; code.matrix-os.com editor disabled"
    CODE_SERVER_PID=
    CODE_PROXY_PID=
  fi

  pnpm --filter shell exec next dev -p 3000 &
  SHELL_PID=$!

  /app/distro/docker-dev-entrypoint.sh --launch-gateway &
  GATEWAY_PID=$!

  trap "
    # Save auth to shared volume before exit (check both $HOME and $MATRIX_HOME)
    AI_AUTH=/home/matrixos/.ai-auth
    if [ -d \"\$AI_AUTH\" ]; then
      mkdir -p \"\$AI_AUTH/claude\" \"\$AI_AUTH/codex\"
      for src in /home/matrixos/.claude \"$MATRIX_HOME/.claude\"; do
        [ -f \"\$src/.credentials.json\" ] && cp \"\$src/.credentials.json\" \"\$AI_AUTH/claude/.credentials.json\" 2>/dev/null && break
      done
      for src in /home/matrixos/.codex \"$MATRIX_HOME/.codex\"; do
        [ -f \"\$src/auth.json\" ] && cp \"\$src/auth.json\" \"\$AI_AUTH/codex/auth.json\" 2>/dev/null && break
      done
    fi
    [ -n \"\$CODE_PROXY_PID\" ] && kill \$CODE_PROXY_PID 2>/dev/null || true
    [ -n \"\$CODE_SERVER_PID\" ] && kill \$CODE_SERVER_PID 2>/dev/null || true
    kill \$SHELL_PID \$GATEWAY_PID 2>/dev/null; exit 0
  " SIGTERM SIGINT

  if [ -n "$CODE_SERVER_PID" ] && [ -n "$CODE_PROXY_PID" ]; then
    wait -n $SHELL_PID $GATEWAY_PID $CODE_SERVER_PID $CODE_PROXY_PID
  else
    wait -n $SHELL_PID $GATEWAY_PID
  fi
  EXIT_CODE=$?
  [ -n "$CODE_PROXY_PID" ] && kill $CODE_PROXY_PID 2>/dev/null || true
  [ -n "$CODE_SERVER_PID" ] && kill $CODE_SERVER_PID 2>/dev/null || true
  kill $SHELL_PID $GATEWAY_PID 2>/dev/null
  exit $EXIT_CODE
'

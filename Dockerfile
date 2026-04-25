# Matrix OS -- Multi-stage Docker build
# Produces a container running gateway (port 4000) + shell (port 3000)

# --------------------------------------------------
# Stage 1: Build (deps + source + Next.js build in one stage)
# --------------------------------------------------
FROM node:24-alpine AS builder

# Native addon build tools (node-pty, better-sqlite3)
RUN apk add --no-cache python3 make g++ linux-headers

# pnpm
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

WORKDIR /app

# Copy only dependency manifests -- changes here bust the install cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/
COPY packages/gateway/package.json packages/gateway/
COPY packages/platform/package.json packages/platform/
COPY packages/proxy/package.json packages/proxy/
COPY shell/package.json shell/

# Hoist packages so next binary is accessible from shell/
RUN echo "shamefully-hoist=true" > .npmrc

# Copy postinstall helper before install (package.json postinstall references it)
COPY scripts/fix-node-pty-perms.mjs scripts/fix-node-pty-perms.mjs

RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY shell/ shell/
COPY home/ home/

# Build shell (Next.js) -- Clerk key is baked in at build time (NEXT_PUBLIC_*)
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN cd shell && node ../node_modules/next/dist/bin/next build

# --------------------------------------------------
# Stage 2: Runtime base (cached -- only changes when base image or system deps change)
# --------------------------------------------------
FROM node:24-alpine AS runtime

# Runtime: git (home dir init + self-healing), build tools (node-pty native addon),
# bubblewrap (bwrap) for codex's per-command sandbox
RUN apk add --no-cache git python3 make g++ linux-headers bash su-exec bubblewrap openssh-client curl

RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

# AI coding CLIs -- pin versions so this layer caches
RUN npm install -g \
    @anthropic-ai/claude-code@2.1.91 \
    @openai/codex@0.118.0 \
    opencode-ai@1.14.25 \
    @mariozechner/pi-coding-agent@0.70.2

# GitHub CLI (release binary; alpine's github-cli package trails a few versions).
# GH_SHA256 must match the upstream gh_${GH_VERSION}_checksums.txt entry for
# gh_${GH_VERSION}_linux_amd64.tar.gz -- bump both values together.
ARG GH_VERSION=2.86.0
ARG GH_SHA256=f3b08bd6a28420cc2229b0a1a687fa25f2b838d3f04b297414c1041ca68103c7
RUN set -eux; \
    wget -qO /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

# Zellij terminal multiplexer (static musl binary).
# ZELLIJ_SHA256 must be the SHA-256 of the published .tar.gz (compute with
# `curl -sL <url> | sha256sum`). The upstream `.sha256sum` file in the
# release assets refers to the *binary*, not the archive.
ARG ZELLIJ_VERSION=0.44.1
ARG ZELLIJ_SHA256=669825021d529fca5d939888263c9d2a90762145191fa07581a15250e8af2b49
RUN set -eux; \
    wget -qO /tmp/zellij.tgz "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz"; \
    echo "${ZELLIJ_SHA256}  /tmp/zellij.tgz" | sha256sum -c -; \
    tar -xzf /tmp/zellij.tgz -C /usr/local/bin zellij; \
    chmod +x /usr/local/bin/zellij; \
    rm /tmp/zellij.tgz

# Non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN adduser -D -u 1001 -h /home/matrixos matrixos && \
    su-exec matrixos git config --global user.name "Matrix OS" && \
    su-exec matrixos git config --global user.email "os@matrix-os.com"

# Give matrixos write access to global npm so claude/codex/opencode
# can auto-update themselves from inside the container.
RUN chown -R matrixos:matrixos /usr/local/lib/node_modules /usr/local/bin

WORKDIR /app

# --------------------------------------------------
# Stage 3: Final image
# --------------------------------------------------
FROM runtime

# Copy node_modules (large, changes only when deps change)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.npmrc ./

# Copy built source + Next.js output
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/shell ./shell
COPY --from=builder /app/home ./home
COPY --from=builder /app/package.json ./

# Next.js needs writable cache dirs at runtime
RUN chown -R matrixos:matrixos /app/shell/.next/cache /app/shell/.next/server

ARG VERSION=dev
RUN echo "$VERSION" > /app/VERSION

# Default environment
ENV NODE_ENV=production
ENV PORT=4000
ENV MATRIX_HOME=/home/matrixos/home
ENV NEXT_PUBLIC_GATEWAY_WS=ws://localhost:4000/ws
ENV NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000
ENV GATEWAY_URL=http://localhost:4000

# Ports: gateway (4000) + shell (3000)
EXPOSE 3000 4000

# Persistent home directory
VOLUME ["/home/matrixos/home"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:4000/health || exit 1

# Start both gateway and shell
COPY distro/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

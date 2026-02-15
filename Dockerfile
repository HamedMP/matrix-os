# Matrix OS -- Multi-stage Docker build
# Produces a container running gateway (port 4000) + shell (port 3000)

# --------------------------------------------------
# Stage 1: Build
# --------------------------------------------------
FROM node:22-alpine AS builder

# Native addon build tools (node-pty, better-sqlite3)
RUN apk add --no-cache python3 make g++ linux-headers

# pnpm
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kernel/package.json packages/kernel/
COPY packages/gateway/package.json packages/gateway/
COPY packages/platform/package.json packages/platform/
COPY packages/proxy/package.json packages/proxy/
COPY shell/package.json shell/

# Hoist packages so next binary is accessible from shell/
RUN echo "shamefully-hoist=true" > .npmrc

RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY shell/ shell/
COPY home/ home/

# Build shell (Next.js)
RUN cd shell && node ../node_modules/next/dist/bin/next build

# --------------------------------------------------
# Stage 2: Production
# --------------------------------------------------
FROM node:22-alpine

# Runtime: git (home dir init + self-healing), build tools (node-pty native addon)
RUN apk add --no-cache git python3 make g++ linux-headers bash su-exec

RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

# Claude Code CLI (required by Agent SDK -- it spawns claude as a subprocess)
RUN npm install -g @anthropic-ai/claude-code

# Non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN adduser -D -u 1001 -h /home/matrixos matrixos && \
    su-exec matrixos git config --global user.name "Matrix OS" && \
    su-exec matrixos git config --global user.email "os@matrix-os.com"

WORKDIR /app

# Copy entire built workspace from builder (includes node_modules with native addons)
COPY --from=builder /app/ ./

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

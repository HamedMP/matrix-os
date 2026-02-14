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
COPY shell/package.json shell/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY shell/ shell/
COPY home/ home/

# Build shell (Next.js)
RUN pnpm --filter shell build

# --------------------------------------------------
# Stage 2: Production
# --------------------------------------------------
FROM node:22-alpine

# Runtime dependencies: git (for home dir init + self-healing),
# native build tools (node-pty needs them at runtime on Alpine)
RUN apk add --no-cache git python3 make g++ linux-headers bash

RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

WORKDIR /app

# Copy built application
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/shell/ shell/
COPY --from=builder /app/home/ home/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Re-install dev deps for packages that need tsx at runtime
# (gateway uses tsx watch in dev, but we run with --import=tsx in prod)
RUN pnpm --filter @matrix-os/gateway add -D tsx
RUN pnpm --filter @matrix-os/kernel add -D tsx

# Default environment
ENV NODE_ENV=production
ENV PORT=4000
ENV MATRIX_HOME=/home/user/matrixos
ENV NEXT_PUBLIC_GATEWAY_WS=ws://localhost:4000/ws
ENV NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000
ENV GATEWAY_URL=http://localhost:4000

# Ports: gateway (4000) + shell (3000)
EXPOSE 3000 4000

# Persistent home directory
VOLUME ["/home/user/matrixos"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:4000/health || exit 1

# Start both gateway and shell
COPY distro/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

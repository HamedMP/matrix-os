# Matrix OS -- Multi-stage Docker build
# Produces a container running gateway (port 4000) + shell (port 3000)

# --------------------------------------------------
# Stage 1: Dependencies (cached unless lockfile changes)
# --------------------------------------------------
FROM node:22-alpine AS deps

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

RUN pnpm install --frozen-lockfile

# --------------------------------------------------
# Stage 2: Build (source changes bust this, but deps are cached above)
# --------------------------------------------------
FROM deps AS builder

# Copy source
COPY packages/ packages/
COPY shell/ shell/
COPY home/ home/

# Build shell (Next.js) -- Clerk key is baked in at build time (NEXT_PUBLIC_*)
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN cd shell && node ../node_modules/next/dist/bin/next build

# --------------------------------------------------
# Stage 3: Runtime base (cached -- only changes when base image or system deps change)
# --------------------------------------------------
FROM node:22-alpine AS runtime

# Runtime: git (home dir init + self-healing), build tools (node-pty native addon)
RUN apk add --no-cache git python3 make g++ linux-headers bash su-exec

RUN corepack enable && corepack prepare pnpm@10.6.2 --activate

# Claude Code CLI -- pin version so this layer caches
RUN npm install -g @anthropic-ai/claude-code@2.1.42

# Non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN adduser -D -u 1001 -h /home/matrixos matrixos && \
    su-exec matrixos git config --global user.name "Matrix OS" && \
    su-exec matrixos git config --global user.email "os@matrix-os.com"

WORKDIR /app

# --------------------------------------------------
# Stage 4: Final image
# --------------------------------------------------
FROM runtime

# Copy node_modules first (large, changes only when deps change)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.npmrc ./

# Copy built source + Next.js output (changes every code push)
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/shell ./shell
COPY --from=builder /app/home ./home
COPY --from=builder /app/package.json ./

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

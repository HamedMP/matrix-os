# Build with repository root context. No credentials or customer homes are copied.
FROM node:24-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ ripgrep procps \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /opt/matrix
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/gateway/package.json packages/gateway/
COPY packages/kernel/package.json packages/kernel/
COPY packages/contracts/package.json packages/contracts/
COPY packages/observability/package.json packages/observability/
COPY packages/terminal-runtime/package.json packages/terminal-runtime/
COPY packages/scope-runtime/package.json packages/scope-runtime/
COPY packages/sync-client/package.json packages/sync-client/
COPY packages/mcp-browser/package.json packages/mcp-browser/
COPY scripts/fix-node-pty-perms.mjs scripts/fix-node-pty-perms.mjs
COPY patches/ patches/
RUN pnpm install --frozen-lockfile --config.enableGlobalVirtualStore=false --filter '@matrix-os/gateway...'
COPY packages/gateway/ packages/gateway/
COPY packages/kernel/ packages/kernel/
COPY packages/contracts/ packages/contracts/
COPY packages/observability/ packages/observability/
COPY packages/terminal-runtime/ packages/terminal-runtime/
COPY packages/scope-runtime/ packages/scope-runtime/
COPY packages/sync-client/ packages/sync-client/
COPY packages/mcp-browser/ packages/mcp-browser/
COPY scripts/ scripts/
COPY home/ home/
COPY skills/ skills/
# The gateway needs source-compatible workspace imports; this intentionally uses
# tsx for the spike while building kernel/observability's published JS exports.
RUN pnpm --filter '@matrix-os/observability' build \
    && pnpm --filter '@matrix-os/kernel' build \
    && pnpm --filter '@matrix-os/terminal-runtime' build
# Spike harness edits do not invalidate dependency or production library builds.
COPY packages/workspace-worker/runtime/ packages/workspace-worker/runtime/
RUN mkdir -p /workspace /run/sandbox && chown node:node /workspace /run/sandbox
USER node
CMD ["sleep", "infinity"]

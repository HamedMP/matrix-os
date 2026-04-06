# Developer Onboarding

Get Matrix OS running locally and make your first contribution.

## Prerequisites

- **Docker**: [OrbStack](https://orbstack.dev) on macOS, Docker Engine on Linux
- **[Flox](https://flox.dev)** (recommended) -- or manually install Node.js 24+, pnpm 10, bun, git

## Quick Start (Docker -- recommended)

Docker is the fastest path. You only need one API key.

```bash
git clone https://github.com/hamedmp/matrix-os.git
cd matrix-os

# Option A: Flox (installs Node 24, pnpm, bun, git + runs pnpm install)
flox activate

# Option B: Manual
pnpm install

# Add your Anthropic key (flox activate creates .env.docker automatically)
# Edit .env.docker -- set ANTHROPIC_API_KEY

bun run docker
```

First start takes ~30s (dependency install). After that, starts are instant.

| Service | URL |
|---------|-----|
| Shell (desktop) | http://localhost:3000 |
| Gateway (API) | http://localhost:4000 |

Verify it works:

```bash
curl http://localhost:4000/health
```

## API Keys

### Required

| Key | Where to get it | Used by |
|-----|-----------------|---------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Kernel AI (Claude Agent SDK) |

### Required for local shell/www development (outside Docker)

| Key | Where to get it | Used by |
|-----|-----------------|---------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | [clerk.com](https://clerk.com) -- create a dev instance | Shell + www auth |
| `CLERK_SECRET_KEY` | Same Clerk dashboard | Shell + www server-side auth |

The Docker image has Clerk baked in at build time, so you don't need Clerk keys for Docker-based development. You only need these if you run the shell or www locally with `bun run dev:shell` or `bun run dev:www`.

### Optional

| Key | Where to get it | Used by |
|-----|-----------------|---------|
| `GEMINI_API_KEY` | [aistudio.google.dev](https://aistudio.google.dev) | Image generation |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) on Telegram | Telegram channel testing |
| `DISCORD_BOT_TOKEN` | [discord.com/developers](https://discord.com/developers) | Discord channel testing |

### Env file locations

| File | Purpose |
|------|---------|
| `.env.docker` | Docker dev (copy from `.env.docker.example`) |
| `.env` | Local dev without Docker (copy from `.env.example`) |
| `shell/.env` | Shell-specific (Clerk keys, copy from `shell/.env.example`) |
| `www/.env` | Website (Clerk keys, copy from `www/.env.example`) |

## Local Dev Without Docker

For working on the shell frontend or website directly:

```bash
cp .env.example .env
cp shell/.env.example shell/.env
# Fill in ANTHROPIC_API_KEY in .env
# Fill in Clerk keys in shell/.env

pnpm install
bun run dev
```

This starts the gateway (:4000) and shell (:3000) with HMR.

## Project Structure

| Directory | What it is |
|-----------|------------|
| `packages/kernel/` | AI kernel -- Agent SDK, agents, hooks, SOUL, skills |
| `packages/gateway/` | Hono HTTP/WS gateway, channel adapters, cron |
| `packages/platform/` | Multi-tenant orchestrator (Clerk auth, Docker provisioning) |
| `packages/proxy/` | Shared API proxy, usage tracking |
| `packages/ui/` | Shared UI components |
| `shell/` | Next.js 16 desktop shell frontend |
| `www/` | matrix-os.com website (Vercel) |
| `home/` | File system template (copied to `~/matrixos/` on first boot) |
| `specs/` | Architecture and feature specs |
| `tests/` | Vitest test suites |

## Testing

TDD is non-negotiable. Write failing tests first.

```bash
bun run test              # Unit tests (Vitest)
bun run test:watch        # Watch mode
bun run test:integration  # Integration tests (needs ANTHROPIC_API_KEY, uses haiku)
bun run test:coverage     # Coverage report (target: 99-100%)
bun run test:e2e          # End-to-end tests
```

### Playwright (visual regression)

```bash
cd shell
pnpm exec playwright install chromium
pnpm exec playwright test
```

## Testing a Feature

1. Read the relevant spec in `specs/`
2. Write failing tests first (red)
3. Implement until tests pass (green)
4. Refactor
5. Run the full test suite: `bun run test`
6. Test in Docker: `bun run docker` and verify manually in the shell
7. Open a PR with a conventional commit title

## PR Workflow

PR titles must follow conventional commits:

```
feat: add new channel adapter
fix: resolve WebSocket reconnection bug
test: add kernel integration tests
```

When your PR changes `shell/` files, the Screenshots CI runs Playwright and commits updated snapshots to your branch. Review the image diffs.

## Docker Commands

```bash
bun run docker          # Dev (gateway + shell)
bun run docker:full     # + proxy, platform, conduit
bun run docker:stop     # Stop containers (preserves data)
bun run docker:logs     # Tail logs
bun run docker:shell    # Shell into container
bun run docker:build    # Full rebuild (no cache)
```

Never run `docker compose down -v` unless you want to destroy all data.

## Useful Links

- [Docker Development Guide](docker-development.md) -- volumes, HMR, troubleshooting, branch isolation
- [Release Process](releases.md) -- versioning and tagging
- [VPS Deployment](vps-deployment.md) -- production server
- [CONTRIBUTING.md](../../CONTRIBUTING.md) -- code style, CI/CD, PR process
- [CLAUDE.md](../../CLAUDE.md) -- development rules, mandatory code patterns

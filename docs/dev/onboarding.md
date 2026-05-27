# Developer Onboarding

Get productive in the Matrix cloud development flow and make your first
contribution. Local setup is supported for special cases, but the main workflow
is a personal Matrix dev VPS.

## Prerequisites

1. **Matrix dev VPS** -- primary workspace for Matrix development, previews,
   coding agents, Zellij, and code-server.
2. **Graphite CLI** -- required for stacked PRs on multi-phase work.
3. **GitHub CLI** -- required for issue/PR work and CI inspection.
4. **Node.js 24+, pnpm 10, bun** -- installed on the dev VPS; also install
   locally only when needed.
5. **Docker/OrbStack** -- optional local path for Docker-specific debugging or
   local infra that cannot run on a dev VPS.
6. **Flox** -- optional convenience path if an engineer wants reproducible local
   toolchain setup.

## Team Access Checklist

Minimum access for every Matrix engineer:

| System | Needed for |
| --- | --- |
| GitHub `HamedMP/matrix-os` | Code, issues, PRs, Actions logs |
| Linear | Product tickets and Symphony ticket rules |
| Graphite | Stacked PR workflow |
| Matrix dev VPS | Cloud coding, HMR, realistic shell/gateway preview |
| Anthropic | Local integration tests and agent work |
| Inngest | Signup/provisioning workflow debugging when working on user operations |

Feature-specific access:

| System | Needed for |
| --- | --- |
| Hetzner | Customer VPS provisioning, recovery, fleet operations |
| Cloudflare | DNS, tunnels, R2, cache behavior |
| Clerk | Auth, sessions, routing, user provisioning |
| Vercel | `www/` and public docs deployments |
| npm/pnpm registry | Package ownership or publishing work |
| Pipedream | Platform-owned integrations |
| Stripe | Billing and entitlements |
| PostHog/Grafana | Analytics, metrics, production debugging |
| Telegram/WhatsApp/Discord/Slack consoles | Channel adapter work |

Do not copy Clerk, Pipedream, provider, billing, or platform secrets into
customer VPS env files, coding-agent config, transcripts, PR comments, or
screenshots.

## Cloud Dev Quick Start

Use this as the default setup.

1. Open the assigned Matrix dev VPS through Matrix shell/code or SSH.
2. Clone the repo in the dev VPS:

   ```bash
   git clone https://github.com/hamedmp/matrix-os.git
   cd matrix-os
   pnpm install
   ```

3. Add the required dev env in the VPS checkout. Keep platform-owned secrets in
   platform/Vercel, not customer VPS env files or agent configs.
4. Start hot reload:

   ```bash
   docker compose -f docker-compose.dev-vps.yml up -d --build
   docker compose -f docker-compose.dev-vps.yml logs -f dev
   ```

5. Verify:

   ```bash
   curl -fsS http://127.0.0.1:4000/health
   ```

6. Preview through authenticated Matrix routes or private SSH forwarding:

   ```bash
   ssh -L 3000:127.0.0.1:3000 -L 4000:127.0.0.1:4000 matrix@<dev-vps>
   ```

See [Dev VPS](dev-vps.md) for the shared `dev.matrix-os.com` setup and personal
VPS rules.

## Local Quick Start

Use local development when the ticket needs mobile/desktop/native tooling,
hardware access, offline work, Docker internals, or a tight unit-test loop.

Manual local setup:

```bash
git clone https://github.com/hamedmp/matrix-os.git
cd matrix-os
pnpm install
cp .env.example .env
```

Optional Flox setup:

```bash
flox activate
```

Start local source dev:

```bash
bun run dev
```

Or start local Docker dev:

```bash
cp .env.docker.example .env.docker
# Edit .env.docker -- set ANTHROPIC_API_KEY
bun run docker
```

| Service | URL |
|---------|-----|
| Shell (desktop) | http://localhost:3000 |
| Gateway (API) | http://localhost:4000 |

Verify it works:

```bash
curl http://localhost:4000/health
```

## First Week

Day 1:

1. Read `AGENTS.md`, `.specify/memory/constitution.md`, `CONTEXT.md`, and
   [Engineering Practices](engineering-practices.md).
2. Open the assigned Matrix dev VPS and confirm shell, gateway, code, Zellij,
   and app preview access.
3. Run local setup only if your first ticket needs local infra.
4. Make a small docs or test-only PR through Graphite.

Week 1:

1. Pair on one Spec Kit feature.
2. Ship one small code PR with tests.
3. Run the review pipeline and fix automated review comments.
4. Preview one user-visible change on a dev VPS.

### Optional Flox

If you prefer Flox for local setup:

```bash
flox activate
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
| `.env.docker` | Local Docker dev (copy from `.env.docker.example`; Flox can also create it) |
| `.env` | Local dev without Docker (copy from `.env.example`) |
| `shell/.env` | Shell-specific (Clerk keys, copy from `shell/.env.example`) |
| `www/.env` | Website (Clerk keys, copy from `www/.env.example`) |

## Local Dev Without Docker

For working on the shell frontend or website directly on your own machine:

```bash
cp .env.example .env
cp shell/.env.example shell/.env
# Fill in ANTHROPIC_API_KEY in .env
# Fill in Clerk keys in shell/.env

bun run dev
```

This starts the gateway (:4000) and shell (:3000) with HMR. Prefer the dev VPS
for normal shell/runtime preview, then use local only when the ticket benefits
from local tooling.

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

1. Classify the ticket type using [Engineering Practices](engineering-practices.md).
2. Ask to run Spec Kit before large, cross-package, persistence, endpoint,
   WebSocket, IPC, provider, auth, billing, VPS, or release work.
3. Read the relevant spec in `specs/`.
4. Write failing tests first (red).
5. Implement until tests pass (green).
6. Refactor.
7. Run the focused tests, then the appropriate pre-PR gates.
8. Preview shell/default-app/runtime changes in Canvas first. Use a Matrix dev
   VPS when local source mode does not represent the customer VPS runtime.
9. Open a PR with a Conventional Commit title.

## PR Workflow

PR titles must follow conventional commits:

```
feat: add new channel adapter
fix: resolve WebSocket reconnection bug
test: add kernel integration tests
```

Use Graphite stacked PRs for multi-slice work that would otherwise exceed the
normal review size. See [Stacked PR Workflow](stacked-prs.md) for the `gt`
commands and Matrix OS stack rules.

When your PR changes `shell/` files, the Screenshots CI runs Playwright and commits updated snapshots to your branch. Review the image diffs.

Before deep review, run:

```bash
bun run typecheck
bun run check:patterns:diff
bun run check:patterns
bun run test
bun run test:e2e
```

Fix automated review comments until Greptile reports 5/5 or every remaining
finding is explicitly deferred in the PR body with a follow-up issue.

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
- [Engineering Practices](engineering-practices.md) -- ticket types, Spec Kit, Graphite, dev VPS, Symphony, review loops
- [Release Process](releases.md) -- host-bundle versioning and tagging
- [CLI Release Process](cli-release.md) -- npm, Homebrew, and MatrixSync installer releases
- [Stacked PR Workflow](stacked-prs.md) -- Graphite stacks for multi-slice features
- [Dev VPS](dev-vps.md) -- shared/personal VPS preview workflow
- [Matrix Symphony](symphony.md) -- Linear-connected coding-agent runner
- [VPS Deployment](vps-deployment.md) -- production server
- [CONTRIBUTING.md](../../CONTRIBUTING.md) -- code style, CI/CD, PR process
- [CLAUDE.md](../../CLAUDE.md) -- development rules, mandatory code patterns

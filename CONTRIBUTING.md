# Contributing to Matrix OS

## Prerequisites

**Recommended**: Install [Flox](https://flox.dev) and run `flox activate` in the repo root. This provisions Node.js 24, pnpm, bun, and git automatically.

**Manual setup** (if not using Flox):

- Node.js 24+
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`)
- bun (for running scripts)
- git

## Getting Started

```bash
git clone https://github.com/hamedmp/matrix-os.git
cd matrix-os

# With Flox:
flox activate

# Or manually ensure Node 24, pnpm, and bun are installed

pnpm install
```

### Dev Servers

```bash
bun run dev            # Start gateway + shell together
bun run dev:gateway    # Gateway only (http://localhost:4000)
bun run dev:shell      # Shell only (http://localhost:3000)
```

The gateway creates `~/matrixos/` on first boot (copied from the `home/` template).

Set `ANTHROPIC_API_KEY` in your environment for kernel AI features.

## Project Structure

| Directory | Description |
|---|---|
| `packages/kernel/` | AI kernel (Agent SDK, agents, IPC, hooks, SOUL, skills) |
| `packages/gateway/` | Hono HTTP/WebSocket gateway, channel adapters, cron, heartbeat |
| `packages/platform/` | Multi-tenant orchestrator (Hono :9000, Drizzle, dockerode) |
| `packages/proxy/` | Shared API proxy (Hono :8080, usage tracking) |
| `shell/` | Next.js 16 frontend (desktop shell) |
| `www/` | matrix-os.com (Next.js on Vercel, Clerk auth) |
| `home/` | File system template (copied on first boot) |
| `tests/` | Vitest test suites |
| `specs/` | Architecture and feature specs |
| `distro/` | Docker and deployment configs |

## Testing

TDD is non-negotiable. Write failing tests first, then implement (red-green-refactor).

### Commands

```bash
bun run test              # Unit tests (~993 tests, Vitest)
bun run test:watch        # Watch mode
bun run test:integration  # Integration tests (requires ANTHROPIC_API_KEY, uses haiku)
bun run test:coverage     # Coverage report (target: 99-100%)
```

### Visual Regression (Playwright)

```bash
cd shell
pnpm exec playwright install chromium
pnpm exec playwright test
```

Screenshots are stored in `shell/e2e/__screenshots__/`. See the Screenshots CI workflow for how updates are committed automatically.

### Writing Tests

- Use **Vitest** for unit and integration tests
- Use **Playwright** for visual regression in the shell
- Place test files in `tests/` or co-locate as `*.test.ts` next to source
- Integration tests use haiku to keep costs under $0.10 per run

## CI/CD Pipeline

| Workflow | File | Trigger | What it does |
|---|---|---|---|
| CI | `ci.yml` | Push/PR to main | Runs unit tests |
| PR Title | `pr-title.yml` | PR opened/edited | Validates conventional commit format |
| Screenshots | `screenshots.yml` | PR changing `shell/**` | Runs Playwright, commits updated snapshots |
| Docker | `docker.yml` | Tag push (`v*`) | Builds and pushes Docker image, deploys to VPS |
| Claude Code Review | `claude-code-review.yml` | PR opened/synced | AI-powered code review |
| Claude Code | `claude.yml` | `@claude` mention in issues/PRs | On-demand AI assistance |

## Pull Requests

### Conventional Commits

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new channel adapter
fix: resolve WebSocket reconnection bug
chore: update dependencies
docs: add API documentation
test: add kernel integration tests
refactor: simplify dispatcher logic
ci: add visual regression workflow
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `style`, `perf`, `ci`, `build`, `revert`. Scopes are optional.

### Screenshot Review

When a PR changes files in `shell/`, the Screenshots workflow runs Playwright tests. If screenshots change:

1. The bot commits updated snapshots to your PR branch
2. A comment is posted with the count of changed files
3. Review the image diffs in the PR to verify visual changes are intentional

## Code Style

- TypeScript strict mode, ES modules
- No emojis in code or docs
- Minimal comments -- code should be self-documenting
- No over-engineering -- solve the current problem
- Use pnpm for installing packages, bun for running scripts
- Never use npm

See `CLAUDE.md` for the full development rules and architecture details.

## Deployment

- **Website** (`www/`): Deployed on Vercel
- **Self-hosted**: Docker image via `distro/docker-compose.platform.yml`
- **Releases**: SemVer tags (`v0.X.0`), see `docs/dev/releases.md`
- **VPS deployment**: see `docs/dev/vps-deployment.md`

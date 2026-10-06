# Developer Onboarding

Get Matrix OS running locally and make your first contribution.

## Prerequisites

1. **[Flox](https://flox.dev)** -- provisions Node 24, pnpm 10, bun, git in one command
2. **Docker**: [OrbStack](https://orbstack.dev) on macOS, Docker Engine on Linux

## Quick Start

```bash
git clone https://github.com/hamedmp/matrix-os.git
cd matrix-os
flox activate
```

`flox activate` handles everything: installs toolchain, runs `pnpm install`, and creates `.env.docker` from the template. You'll see:

```
Matrix OS dev environment ready
  bun run docker    -- start dev (Docker)
  bun run dev       -- start dev (local)
  bun run test      -- run tests
```

Next, add your API key and start:

```bash
# Edit .env.docker -- set ANTHROPIC_API_KEY
bun run docker
```

First Docker start takes ~30s. After that, starts are instant.

| Service | URL |
|---------|-----|
| Shell (desktop) | http://localhost:3000 |
| Gateway (API) | http://localhost:4000 |

Verify it works:

```bash
curl http://localhost:4000/health
```

### Without Flox

If you prefer manual setup, install Node.js 24+, pnpm 10, bun, and git yourself:

```bash
pnpm install
cp .env.docker.example .env.docker
# Edit .env.docker -- set ANTHROPIC_API_KEY
bun run docker
```

## API Keys

### Required

| Key | Where to get it | Used by |
|-----|-----------------|---------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Kernel AI (Claude Agent SDK) |

### Required for local shell development (outside Docker)

| Key | Where to get it | Used by |
|-----|-----------------|---------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | [clerk.com](https://clerk.com) -- create a dev instance | Shell auth |
| `CLERK_SECRET_KEY` | Same Clerk dashboard | Shell server-side auth |

The Docker image has Clerk baked in at build time, so you don't need Clerk keys for Docker-based development. You only need these if you run the shell locally with `bun run dev:shell`.

### Optional

| Key | Where to get it | Used by |
|-----|-----------------|---------|
| `GEMINI_API_KEY` | [aistudio.google.dev](https://aistudio.google.dev) | Image generation |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) on Telegram | Telegram channel testing |
| `DISCORD_BOT_TOKEN` | [discord.com/developers](https://discord.com/developers) | Discord channel testing |

### Env file locations

| File | Purpose |
|------|---------|
| `.env.docker` | Docker dev (created by `flox activate`, or copy from `.env.docker.example`) |
| `.env` | Local dev without Docker (copy from `.env.example`) |
| `shell/.env` | Shell-specific (Clerk keys, copy from `shell/.env.example`) |

## Production-parity development

`bun run dev:full` is the canonical local setup. On Apple Silicon it creates a
disposable **Ubuntu 24.04 amd64 QEMU VM**, builds the real host bundle inside a
faster OrbStack/Rosetta Linux builder, and boots the runtime from the production
cloud-init configuration via a NoCloud seed. A real VM is required because
OrbStack Linux machines share a host kernel and cannot load the production
AppArmor profile. Lima documents the same [Intel-on-ARM QEMU requirement](https://lima-vm.io/docs/config/multi-arch/).
This is the path for reproducing VPS failures, including Files, Terminal/Zellij
generations, restart behavior, AppArmor, nginx TLS/WebSockets, the local owner
Postgres container, restore gate, code services, and updater wiring.

Prerequisites on macOS:

- OrbStack with Linux machines enabled for the disposable bundle builder and
  Docker dependencies.
- QEMU (`brew install qemu`). The runtime deliberately uses slower TCG system
  emulation rather than Rosetta userspace emulation so the kernel architecture
  and security facilities match production.
- OpenSSL (`brew install openssl`) for the local TLS-wrapped object-store
  endpoint used by the unchanged production backup broker.
- A 6 GiB OrbStack shared memory limit (`orb config set memory_mib 6144`, then
  `orb stop` to apply it). The bundle builder uses 4 GiB; the remainder is for
  platform PostgreSQL and object storage. The QEMU runtime separately uses 4 GiB.
- Rosetta 2 (`softwareupdate --install-rosetta --agree-to-license`). Production
  bundles contain x86_64 Node/Zellij assets; an arm64 guest is not parity.
- A `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `.env` so the bundled shell matches
  the selected Clerk instance. The launcher fetches that instance's public JWKS
  for local token verification, so a personal Clerk development instance can be
  used when production workspace access is unavailable. A matching, valid
  `CLERK_SECRET_KEY` is optional: without it browser auth returns a bounded
  unavailable response while the VM, Files synchronization, Terminal runtime,
  and other credential-free services start.
- `MATRIX_LOCAL_CLERK_USER_ID` in `.env`, set to the Clerk user that will sign
  in. The local platform database maps that identity to the disposable machine.
- One explicitly approved host-network setup step. Add the RFC 5737 fixture
  address once with
  `sudo ifconfig lo0 alias 192.0.2.2 netmask 255.255.255.255`. The launcher
  verifies but never takes ownership of that host setting. It does own and
  remove the Docker bridge process on `dev:parity:down`. Production registration
  still validates a public-style address and all HTTPS/WebSocket traffic still
  uses port 443.

```bash
bun run dev:full               # build bundle, provision machine, run platform
bun run dev:parity:resume      # recover a saved VM and dependencies without reprovisioning
bun run dev:parity:restart     # also restart gateway/shell and owned platform/proxies
bun run dev:preflight          # read-only service, TLS and owner-authenticated API checks
bun run dev:parity:status       # production units and failed-unit summary
bun run dev:parity:logs         # cloud-init and Matrix service logs
bun run dev:parity:down         # delete the disposable machine; preserve infra volumes
```

The command starts platform Postgres and object storage as external local
dependencies. Presigned backup traffic reaches that object store through a
loopback-only, launcher-owned TLS endpoint trusted only by the disposable guest;
the production broker's HTTPS requirement is unchanged. `dev:parity:down` removes
only QEMU and labeled bridge containers owned by this checkout. It deliberately
leaves the shared PostgreSQL and object-storage containers running for source
development; stop those separately with `bun run dev:infra:stop` when they are no
longer needed. The platform uses normal customer-VPS routing and registration
path; it does **not** enable legacy container routing. Keep the foreground command
running because it serves the working-tree bundle and local provider-metadata
adapter during provisioning and updates. Provider-backed AI, billing, speech,
and integrations still require their normal credentials and should fail with
their bounded unavailable states when those credentials are absent.

Open `https://192.0.2.2` after provisioning. New environments keep generated
credentials, VM disks and bundles under ignored `.local/production-parity/`,
outside coding-harness storage. Existing `.amp/in/local-production-parity/`
environments stay in place to preserve absolute disk backing paths, container
mounts and the existing launcher lock. Both paths are excluded from Git and
build inputs. Two saved directories are ambiguous and fail closed; do not move
a live VM's files or delete credentials to make the launcher proceed.

Use `resume` after closing the provisioning launcher or restarting your computer.
It reuses the saved disk, identity, SSH/TLS keys, dependency volumes and platform
image. It refuses missing retained files/volumes, foreign containers, occupied VM
ports and duplicate QEMU processes. It never reseeds the database, rotates
credentials, rebuilds images or installs source changes. `restart` additionally
interrupts active runs and connections; close browser tabs first. Both commands
return after service and platform-to-VM health checks, leave saved data intact on
failure, and use the same checkout lock as `up` and `down`. They do not restart the
foreground bundle/metadata server needed for provisioning or bundle updates.

Preflight makes no paid provider calls and requires neither Codex nor an existing
Chat or speech configuration. Missing optional integrations warn; failed required
service, TLS or owner-authenticated checks exit nonzero. A successful preflight
does not establish browser sign-in, microphone or complete AI-turn correctness.
Public docs in `FinnaAI/matrix-os-site` should receive this command reference in a
separate documentation PR when this workflow is adopted.

Use `--reuse-bundle` only when the working tree has not changed:

```bash
pnpm node scripts/dev-production-parity.mjs up --reuse-bundle
```

## Source/HMR development (non-parity)

Use this path when changing the application and you want host-side watchers and
HMR, with PostgreSQL and object storage in Docker. The narrower `bun run dev`
command does not start platform or either stateful dependency.

```bash
cp .env.example .env
cp shell/.env.example shell/.env
# Fill in ANTHROPIC_API_KEY in .env
# Optional: add provider keys to .env for AI-backed features

bun run dev:source
```

`bun run dev:source` starts PostgreSQL and the local S3-compatible object store in
Docker, waits for both to be ready, initializes the sync bucket, and then starts
gateway (`:4000`), proxy (`:8080`), platform (`:9000`), and shell (`:3000`) from
source. Local auth bypass is enabled explicitly, so this path does not require
Clerk credentials or initialize Clerk. Press Ctrl-C to stop the source processes; infrastructure
continues in Docker and can be stopped with `bun run dev:infra:stop`.

Use `bun run dev:infra` when you only need ready PostgreSQL and object storage.
The narrower `bun run dev` command still starts exactly three source processes:
gateway, proxy, and shell; it assumes any required infrastructure is already
running. The shell uses Next.js's default Turbopack development server. pnpm's
content-addressed package cache remains shared, while each checkout
keeps its own virtual store and builds approved native addons locally so a
project running another Node ABI cannot replace them.

Host source development does not launch the production Linux user-systemd
terminal runtime and therefore cannot reproduce production Terminal lifecycle,
cgroup, generation, restart, or upgrade behavior. Use `bun run dev:full` for
those checks; a portable supervisor is deliberately not an acceptance target.

The source proxy uses an in-memory usage database unless `PROXY_DB_PATH` is
set. To run platform separately, first start a PostgreSQL instance containing
`matrixos_platform`, set `PLATFORM_DATABASE_URL` in `.env`, then run:

```bash
bun run dev:platform
curl --fail http://localhost:9000/health
```

Source health checks:

```bash
curl --fail http://localhost:3000/
curl --fail http://localhost:4000/health
curl --fail http://localhost:8080/health
```

Docker and source-HMR modes are convenience loops, not production topology.

## Project Structure

| Directory | What it is |
|-----------|------------|
| `packages/kernel/` | AI kernel -- Agent SDK, agents, hooks, SOUL, skills |
| `packages/gateway/` | Hono HTTP/WS gateway, channel adapters, cron |
| `packages/platform/` | Multi-tenant orchestrator (Clerk auth, Docker provisioning) |
| `packages/proxy/` | Shared API proxy, usage tracking |
| `packages/ui/` | Shared UI components |
| `shell/` | Next.js 16 desktop shell frontend |
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
NEXT_PUBLIC_E2E_TEST_BYPASS=1 pnpm build
pnpm exec playwright test
```

`NEXT_PUBLIC_E2E_TEST_BYPASS` is read by the browser bundle, so it must be set
when the shell is built. Setting it only on `pnpm start` will not bypass Clerk
Billing in the compiled app.

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

Use Graphite stacked PRs for multi-slice work that would otherwise exceed the
normal review size. See [Stacked PR Workflow](stacked-prs.md) for the `gt`
commands and Matrix OS stack rules.

When your PR changes `shell/` files, the Screenshots CI runs Playwright and commits updated snapshots to your branch. Review the image diffs.

## Docker Commands

```bash
bun run dev:infra       # Ready PostgreSQL + object storage in Docker
bun run dev:infra:stop  # Stop local infrastructure without deleting data
bun run dev:full        # Production host bundle in an amd64 Ubuntu QEMU VM
bun run dev:source      # Non-parity infra + HTTP services from source with HMR
bun run docker          # Dev (gateway + shell)
bun run docker:full     # + proxy and platform
bun run docker:full:smoke # build, health-check the full stack, then stop it
bun run docker:stop     # Stop containers (preserves data)
bun run docker:logs     # Tail logs
bun run docker:shell    # Shell into container
bun run docker:build    # Full rebuild (no cache)
```

Never run `docker compose down -v` unless you want to destroy all data.

## Useful Links

- [Docker Development Guide](docker-development.md) -- volumes, HMR, troubleshooting, branch isolation
- [Release Process](releases.md) -- host-bundle versioning and tagging
- [CLI Release Process](cli-release.md) -- npm, Homebrew, and MatrixSync installer releases
- [Stacked PR Workflow](stacked-prs.md) -- Graphite stacks for multi-slice features
- [VPS Deployment](vps-deployment.md) -- production server
- [CONTRIBUTING.md](../../CONTRIBUTING.md) -- code style, CI/CD, PR process
- [CLAUDE.md](../../CLAUDE.md) -- development rules, mandatory code patterns

Repository docs cover contributor setup in this checkout. A separate public
documentation PR is still required in the private `FinnaAI/matrix-os-site`
repository under `content/docs/`; this repository cannot create that PR.

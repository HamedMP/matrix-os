# Docker Development Guide

Matrix OS uses Docker as the primary local development environment via OrbStack on macOS. This ensures dev/prod parity.

## Prerequisites

- **macOS**: [OrbStack](https://orbstack.dev) (required -- Docker Desktop is not supported)
- **Linux/CI**: Standard Docker Engine + Docker Compose v2
- Copy `.env.docker.example` to `.env.docker` and fill in your keys

## Setup

```bash
# Copy env file and add your API key
cp .env.docker.example .env.docker
# Edit .env.docker with your ANTHROPIC_API_KEY

# Start dev environment
bun run docker
```

First start takes ~30s (installs dependencies). Subsequent starts are instant (deps cached in volume).

## Convenience Scripts

All Docker commands have `bun run` shortcuts in `package.json`:

```bash
bun run docker          # Dev only (gateway + shell with HMR)
bun run docker:full     # + proxy, platform, conduit
bun run docker:all      # + observability (Grafana, Prometheus, Loki)
bun run docker:multi    # + alice & bob multi-user
bun run docker:stop     # Stop all containers (preserves data)
bun run docker:restart  # Restart dev container
bun run docker:logs     # Tail dev container logs
bun run docker:shell    # Shell into container as matrixos user
bun run docker:build    # Full rebuild (no cache)
```

These map to `docker compose -f docker-compose.dev.yml` with the appropriate profiles.

## Service URLs

| Service | URL | Port | Profile |
|---------|-----|------|---------|
| Shell (desktop) | http://localhost:3000 | 3000 | default |
| Gateway (API) | http://localhost:4000 | 4000 | default |
| Proxy | http://localhost:8080 | 8080 | full |
| Platform | http://localhost:9000 | 9000 | full |
| Conduit (Matrix) | http://localhost:6167 | 6167 | full |
| Prometheus | http://localhost:9090 | 9090 | obs |
| Grafana | http://localhost:3200 | 3200 | obs |
| Loki | http://localhost:3100 | 3100 | obs |
| Alice (shell) | http://localhost:3001 | 3001 | multi |
| Alice (gateway) | http://localhost:4001 | 4001 | multi |
| Bob (shell) | http://localhost:3002 | 3002 | multi |
| Bob (gateway) | http://localhost:4002 | 4002 | multi |

Grafana default credentials: `admin` / `matrixos`

## Common Operations

### Stop containers (preserves data)

```bash
docker compose -f docker-compose.dev.yml down
```

### Rebuild after Dockerfile changes

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### Restart a single service

```bash
docker compose -f docker-compose.dev.yml restart dev
```

### View logs

```bash
# All services
docker compose -f docker-compose.dev.yml logs -f

# Single service
docker compose -f docker-compose.dev.yml logs -f dev

# Last 50 lines
docker compose -f docker-compose.dev.yml logs --tail 50
```

### Run tests inside container

```bash
docker compose -f docker-compose.dev.yml exec dev bun run test
```

### Shell into container

```bash
docker compose -f docker-compose.dev.yml exec dev sh
```

### Check health

```bash
curl http://localhost:4000/health
```

## Volume Management

Volumes persist data across container restarts:

| Volume | Purpose |
|--------|---------|
| `dev-node-modules` | pnpm dependencies (cached, ~30s first install) |
| `dev-home` | Matrix OS home directory (`~/matrixos/`) |
| `dev-next-cache` | Next.js build cache |
| `pgdata` | PostgreSQL data (app data layer) |
| `conduit-data` | Matrix homeserver database |
| `prometheus-data` | Metrics history |
| `grafana-data` | Dashboard configs |

**IMPORTANT**: Never use `docker compose down -v` unless you explicitly want to destroy all data and start fresh. This removes all volumes including your OS home directory and installed dependencies.

### Reset to clean state (destructive)

```bash
# Only when you explicitly want a fresh start
docker compose -f docker-compose.dev.yml down -v
```

### Reset only node_modules (force dependency reinstall)

```bash
docker volume rm matrix-os_dev-node-modules
docker compose -f docker-compose.dev.yml up
```

## Environment Variables

All env vars are loaded from `.env.docker` (via `env_file` in compose). The compose file also sets some defaults in the `environment` section.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Claude API key for kernel |
| `MATRIX_HANDLE` | No | `dev` | User handle (set by platform in prod) |
| `MATRIX_DISPLAY_NAME` | No | `Developer` | Display name (from Clerk signup in prod) |
| `FAL_API_KEY` | No | - | Fal.ai key for image generation |
| `PLATFORM_SECRET` | No | `dev-secret` | Platform JWT secret |
| `DATABASE_URL` | No | auto-set | PostgreSQL connection string for app data layer |
| `GRAFANA_ADMIN_PASSWORD` | No | `matrixos` | Grafana admin password |

## Architecture Notes

**Non-root user**: The container runs services as the `matrixos` user (not root). The entrypoint runs setup tasks (pnpm install, chown) as root, then drops to `matrixos` via `su-exec`. This is required because the Agent SDK refuses `bypassPermissions` when running as root.

**Identity from environment**: On boot, the gateway writes `handle.json` from `MATRIX_HANDLE` and `MATRIX_DISPLAY_NAME` env vars. In production, these are set by the platform orchestrator from Clerk signup data. In local dev, they default to `dev`/`Developer`.

## HMR (Hot Module Replacement)

Source code is bind-mounted into the container:
- `packages/` -- gateway code changes trigger `tsx --watch` restart
- `shell/` -- Next.js Turbopack HMR (instant)
- `home/` -- template files

File watching works automatically with OrbStack on macOS.

## Switching Between Local and Production

Any service can point at a production endpoint:

```bash
# Use production proxy instead of local
ANTHROPIC_BASE_URL=https://api.matrix-os.com:8080 docker compose -f docker-compose.dev.yml up

# Use production platform
PLATFORM_URL=https://api.matrix-os.com:9000 docker compose -f docker-compose.dev.yml up
```

## Scenario Tests

Seven test scripts in `scripts/docker-test/` validate Docker workflows:

1. **fresh-install.sh** -- Empty volume, verify onboarding
2. **upgrade.sh** -- Seed old state, boot new version, verify sync
3. **customized-files.sh** -- Modified files survive sync
4. **multi-user.sh** -- Alice + bob independent instances
5. **channels.sh** -- Channel adapter lifecycle
6. **recovery.sh** -- Kill -9, restart, verify data intact
7. **resource-limits.sh** -- 256MB limit, verify stability

```bash
# Run all
./scripts/docker-test/run-all.sh

# Run single
./scripts/docker-test/fresh-install.sh
```

## Per-Branch Testing

When working on multiple features in parallel (e.g., git worktrees), each branch can run its own isolated Docker environment with unique ports. Main keeps 3000/4000/5432.

### Quick start

```bash
./scripts/branch-dev.sh          # build + start + tail logs
./scripts/branch-dev.sh stop     # stop (preserves volumes)
./scripts/branch-dev.sh logs     # tail logs
./scripts/branch-dev.sh shell    # shell into container
./scripts/branch-dev.sh ps       # show containers
./scripts/branch-dev.sh down     # remove containers (keep volumes)
./scripts/branch-dev.sh restart  # restart dev container
```

### How it works

- Ports are derived deterministically from the branch name (hash mod 90 + 10), giving each branch a unique offset: shell on 30xx, gateway on 40xx, postgres on 54xx
- Uses `docker-compose.branch.yml` as an override file that remaps ports via env vars
- Each branch gets its own Docker Compose project (`mos-<branch-name>`), so containers, networks, and volumes are fully isolated
- The script refuses to run on `main` -- use `bun run docker` for that

### Manual usage (without the script)

```bash
SHELL_PORT=3050 GW_PORT=4050 PG_PORT=5482 \
  docker compose -f docker-compose.dev.yml -f docker-compose.branch.yml \
  -p mos-my-feature up --build -d
```

### Notes

- Bind mounts mean source code changes are live -- restart the dev container to pick up server-side changes (`./scripts/branch-dev.sh restart`)
- Next.js shell changes are picked up by Turbopack HMR automatically
- Each branch project has independent volumes (node_modules, home dir, postgres data)

## Troubleshooting

### Container fails to start

```bash
docker compose -f docker-compose.dev.yml logs dev --tail 50
```

### Port already in use

```bash
lsof -i :3000
lsof -i :4000
```

### Dependencies out of date

After changing `package.json` or `pnpm-lock.yaml` on host:

```bash
# Run pnpm install on host first to update lockfile
pnpm install

# Then restart container (it auto-detects lockfile changes)
docker compose -f docker-compose.dev.yml restart dev
```

### HMR not working on Linux

```bash
echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches
```

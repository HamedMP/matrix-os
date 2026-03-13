# Spec 044: Docker-Primary Local Development

## Problem

1. **Dev/prod divergence**: Local dev runs natively on macOS. Production runs in Alpine Linux Docker containers. Bugs slip through.
2. **No state simulation**: Can't easily test fresh install, upgrade, customized files, recovery, or multi-user scenarios locally.
3. **Partial stack locally**: Can't run the full prod stack (platform, proxy, Grafana, Conduit) on your laptop.
4. **No CI testing**: Docker scenarios should run in GitHub Actions for regression catching.
5. **Template sync untestable**: The new smart sync (T2091) can't be tested without simulating upgrade scenarios.

## Goals

- Docker as primary local dev environment (OrbStack on macOS)
- Full production stack runnable locally (platform, proxy, observability, user containers)
- Any service switchable between local dev and production
- HMR for gateway (tsx watch) and shell (next dev + Turbopack)
- 7 test scenarios as executable scripts
- CI-ready: same scripts run in GitHub Actions
- One-command startup: `docker compose -f docker-compose.dev.yml up`

## Non-Goals

- Docker Desktop support (OrbStack only for macOS, standard Docker on Linux/CI)
- Flox integration (evaluated, not needed)
- Production deployment changes (existing Dockerfile/compose unchanged)

## Architecture

### Compose Profiles

Single `docker-compose.dev.yml` with profiles for modular startup:

```
docker compose -f docker-compose.dev.yml up                    # dev container only
docker compose -f docker-compose.dev.yml --profile full up     # full stack
docker compose -f docker-compose.dev.yml --profile obs up      # + observability
docker compose -f docker-compose.dev.yml --profile multi up    # alice + bob
```

### Services

```
OrbStack (macOS) / Docker (CI)
  |
  docker-compose.dev.yml
  |
  +-- dev (default, always starts)
  |     |-- Bind mounts: ./packages/, ./shell/, ./home/, ./tests/
  |     |-- Volume: dev-home (persistent ~/matrixos/)
  |     |-- Volume: dev-node-modules (cached deps)
  |     |-- Ports: 3000 (shell), 4000 (gateway)
  |     |-- Entrypoint: pnpm install + tsx watch + next dev
  |
  +-- proxy (profile: full)
  |     |-- Port: 8080
  |     |-- Shared API key + cost tracking
  |
  +-- platform (profile: full)
  |     |-- Port: 9000
  |     |-- Docker socket mounted (orchestrates user containers)
  |     |-- Subdomain routing to user containers
  |
  +-- conduit (profile: full)
  |     |-- Port: 6167
  |     |-- Matrix homeserver (federated identity)
  |
  +-- prometheus (profile: obs)
  |     |-- Port: 9090
  |
  +-- grafana (profile: obs)
  |     |-- Port: 3200
  |     |-- Pre-provisioned dashboards
  |
  +-- loki (profile: obs)
  |     |-- Port: 3100
  |
  +-- promtail (profile: obs)
  |
  +-- alice (profile: multi)
  |     |-- Ports: 3001, 4001
  |
  +-- bob (profile: multi)
        |-- Ports: 3002, 4002
```

### Switching to Production

Any service can be pointed at prod instead of local:
- Set `ANTHROPIC_BASE_URL=https://api.matrix-os.com:8080` to use prod proxy
- Set `PLATFORM_URL=https://api.matrix-os.com:9000` to use prod platform
- Or run the service locally and point prod at it (via Cloudflare Tunnel)

### Test Scenarios

7 scripts in `scripts/docker-test/`, using a shared test harness:

1. **fresh-install.sh**: Empty volume -> verify onboarding, git init, bootstrap.md
2. **upgrade.sh**: Seed v0.3.0 state -> boot v0.4.0 -> verify template sync
3. **customized-files.sh**: Modified soul.md + skills -> sync -> verify skip + log
4. **multi-user.sh**: Alice + bob containers -> social API cross-user
5. **channels.sh**: Channel config with mock endpoint -> verify adapter lifecycle
6. **recovery.sh**: Write data -> docker kill -9 -> restart -> verify integrity
7. **resource-limits.sh**: 256MB memory -> heavy ops -> verify stability

### CI Integration

GitHub Actions workflow (`.github/workflows/docker-test.yml`):
- Trigger: push to main, PR
- Steps: build dev image, run `scripts/docker-test/run-all.sh`
- Uses standard Docker (not OrbStack) in CI
- Caches Docker layers for speed

### Dev Workflow

```bash
# Daily development (full HMR)
docker compose -f docker-compose.dev.yml up

# Full stack (platform + proxy + observability)
docker compose -f docker-compose.dev.yml --profile full --profile obs up

# Run unit tests
docker compose -f docker-compose.dev.yml exec dev bun run test

# Run scenario tests
./scripts/docker-test/run-all.sh

# Reset to clean state
docker compose -f docker-compose.dev.yml down -v

# Multi-user testing
docker compose -f docker-compose.dev.yml --profile multi up
```

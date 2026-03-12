# Docker Development Guide

Matrix OS uses Docker as the primary local development environment. This ensures parity between development and production.

## Prerequisites

- **macOS**: [OrbStack](https://orbstack.dev) (recommended over Docker Desktop)
- **Linux/CI**: Standard Docker Engine + Docker Compose v2
- **All platforms**: `jq` and `curl` for running test scripts

## Quick Start

```bash
# Start dev environment (gateway + shell with HMR)
docker compose -f docker-compose.dev.yml up

# Open in browser
open http://localhost:3000   # Shell UI
open http://localhost:4000   # Gateway API
```

The dev container bind-mounts source code and runs `tsx watch` (gateway) + `next dev` (shell), so changes are reflected immediately without rebuilding.

## Compose Profiles

The `docker-compose.dev.yml` file uses profiles for modular startup:

| Command | Services |
|---------|----------|
| `docker compose -f docker-compose.dev.yml up` | Dev container only (gateway + shell) |
| `--profile full` | + platform, proxy, Matrix homeserver |
| `--profile obs` | + Prometheus, Grafana, Loki, Promtail |
| `--profile multi` | + alice (4001) and bob (4002) user containers |

### Examples

```bash
# Full stack (platform + proxy + Matrix)
docker compose -f docker-compose.dev.yml --profile full up

# Full stack + observability dashboards
docker compose -f docker-compose.dev.yml --profile full --profile obs up

# Multi-user testing (alice + bob on separate ports)
docker compose -f docker-compose.dev.yml --profile multi --profile full up

# Run tests inside the dev container
docker compose -f docker-compose.dev.yml exec dev bun run test

# Reset to clean state (removes volumes)
docker compose -f docker-compose.dev.yml down -v
```

### Service Ports

| Service | Port | Description |
|---------|------|-------------|
| dev (shell) | 3000 | Next.js desktop shell |
| dev (gateway) | 4000 | Hono HTTP/WS gateway |
| proxy | 8080 | Shared API proxy |
| platform | 9000 | Multi-tenant orchestrator |
| conduit | 6167 | Matrix homeserver |
| prometheus | 9090 | Metrics collection |
| grafana | 3200 | Dashboards |
| loki | 3100 | Log aggregation |
| alice | 3001/4001 | Test user 1 |
| bob | 3002/4002 | Test user 2 |

## Scenario Tests

Seven test scripts in `scripts/docker-test/` validate Docker-based workflows:

### 1. Fresh Install (`fresh-install.sh`)

Starts with an empty volume and verifies the full onboarding experience: home directory initialization, git init, soul.md, bootstrap.md, config.json, and all API endpoints.

### 2. Upgrade (`upgrade.sh`)

Simulates upgrading from v0.3.0 to the current version. Seeds old state, restarts the container, and verifies that smart template sync runs, updates `.matrix-version`, creates `.template-manifest.json`, and logs the sync.

### 3. Customized Files (`customized-files.sh`)

Modifies `soul.md` and a skill file, then restarts. Verifies that user customizations survive the template sync (files are skipped, not overwritten).

### 4. Multi-User (`multi-user.sh`)

Starts alice and bob containers, creates social posts on each, and verifies that each instance works independently. Tests the multi-user profile.

### 5. Channels (`channels.sh`)

Writes a channel configuration to `config.json`, restarts, and verifies the channel status endpoint reports the adapter.

### 6. Recovery (`recovery.sh`)

Writes bridge data and a social post, then kills the container with SIGKILL (ungraceful shutdown). Restarts and verifies that data persisted on the Docker volume survives.

### 7. Resource Limits (`resource-limits.sh`)

Starts the container with a 256MB memory limit and verifies that all endpoints respond correctly. Reports memory usage statistics.

### Running Tests

```bash
# Run all scenarios
./scripts/docker-test/run-all.sh

# Run a single scenario
./scripts/docker-test/fresh-install.sh

# Skip specific scenarios (space-separated)
SKIP_SCENARIOS="multi-user resource-limits" ./scripts/docker-test/run-all.sh
```

Each script is standalone, handles its own setup/cleanup, and can be run independently.

## Switching Between Local and Production

Any service can be pointed at a production endpoint instead of the local container:

```bash
# Use production API proxy instead of local
ANTHROPIC_BASE_URL=https://api.matrix-os.com:8080 docker compose -f docker-compose.dev.yml up

# Use production platform
PLATFORM_URL=https://api.matrix-os.com:9000 docker compose -f docker-compose.dev.yml up
```

## Troubleshooting

### Container fails to start

```bash
# Check logs
docker compose -f docker-compose.dev.yml logs dev

# Check if ports are in use
lsof -i :3000
lsof -i :4000
```

### Dependencies not installing

```bash
# Force rebuild with no cache
docker compose -f docker-compose.dev.yml build --no-cache dev

# Or remove the node_modules volume
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up
```

### Home directory issues

```bash
# Reset home directory volume
docker compose -f docker-compose.dev.yml down -v

# Inspect home directory contents
docker compose -f docker-compose.dev.yml exec dev ls -la /home/matrixos/home/
```

### HMR not working

- Verify bind mounts are correct in `docker-compose.dev.yml`
- On macOS with OrbStack, file watching should work out of the box
- On Linux, you may need to increase inotify limits: `echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches`

### Memory issues

If the container is OOM-killed under resource limits:

```bash
# Check memory usage
docker stats --no-stream

# Increase the limit in docker-compose override
# Or remove the mem_limit constraint
```

## CI Integration

The GitHub Actions workflow (`.github/workflows/docker-test.yml`) runs scenario tests on every push to main and on pull requests. It skips `multi-user` and `resource-limits` scenarios in CI to save time. Test logs are uploaded as artifacts on failure.

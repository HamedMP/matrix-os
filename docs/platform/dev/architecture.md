# Platform Architecture

## Overview

The platform service (`packages/platform/`) is the multi-tenant orchestrator for Matrix OS. It manages user containers, handles authentication via Clerk, and routes traffic through Cloudflare Tunnels.

```
Vercel (www/)
  |-- matrix-os.com (landing, signup/login, dashboard, admin)
  |-- Clerk auth + Inngest provisioning
  |
Cloudflare Edge
  |-- *.matrix-os.com (wildcard DNS + TLS)
  |
  +-- Cloudflare Tunnel (outbound only from VPS)
      |-- api.matrix-os.com -> localhost:9000 (platform API)
      |-- *.matrix-os.com  -> localhost:9000 (subdomain routing)

VPS (no public ports)
  |-- cloudflared (tunnel daemon)
  |-- platform :9000 (orchestrator + reverse proxy)
  |-- proxy :8080 (shared API key, cost tracking)
  +-- Docker containers (per-user Matrix OS instances)
      |-- matrixos-alice (gateway:4000 -> :4001, shell:3000 -> :3001)
      |-- matrixos-bob   (gateway:4000 -> :4002, shell:3000 -> :3002)
```

## Components

### Database (`src/db.ts` + `src/schema.ts`)

Drizzle ORM with better-sqlite3. Two tables:

- **containers** -- one row per user. PK is `handle`, stores clerk_user_id, container_id, port mappings, status, timestamps.
- **port_assignments** -- tracks which host ports are allocated. Sequential allocation starting from base ports (4001 for gateway, 3001 for shell).

Factory: `createPlatformDb(path)` returns a Drizzle instance. All query functions take `db` as their first argument for testability.

### Orchestrator (`src/orchestrator.ts`)

Wraps dockerode with a clean interface. Factory: `createOrchestrator(config)`.

Methods:
- `provision(handle, clerkUserId)` -- allocate ports, create container, start, insert DB record
- `start(handle)` -- start a stopped container
- `stop(handle)` -- stop a running container
- `destroy(handle)` -- stop, remove container, release ports, delete DB record
- `getInfo(handle)` / `listAll(status?)` -- read from DB

Container config:
- Image: `ghcr.io/hamedmp/matrix-os:latest`
- Network: `matrixos-net` (bridge, created if missing)
- Resources: 256MB memory, 0.5 CPU
- Restart: `unless-stopped`
- Volume: `/data/users/{handle}/matrixos` -> `/home/matrixos/home`
- Env: MATRIX_HANDLE, PROXY_URL, ANTHROPIC_BASE_URL, PORT, SHELL_PORT

### Lifecycle Manager (`src/lifecycle.ts`)

Interval-based idle checker. Factory: `createLifecycleManager(config)`.

- Checks every 5 minutes (configurable)
- Stops containers idle > 30 minutes (configurable)
- `touchActivity(handle)` -- called on every proxied request
- `ensureRunning(handle)` -- lazy wake for stopped containers

### Social API (`src/social.ts`)

Cross-instance social features. Factory: `createSocialApi(db, proxyUrl?)`.

- `listUsers()` -- all users with online status
- `getProfile(handle)` / `getAiProfile(handle)` -- fetch from container's gateway
- `sendMessage(handle, text, from)` -- route via proxy or direct

### API Routes (`src/main.ts`)

Hono app created via `createApp({ db, orchestrator })`. Routes:

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /containers/provision | Create new container |
| POST | /containers/:handle/start | Wake container |
| POST | /containers/:handle/stop | Sleep container |
| DELETE | /containers/:handle | Destroy container |
| GET | /containers | List all containers |
| GET | /containers/:handle | Get container info |
| GET | /social/users | List users with status |
| GET | /social/profiles/:handle | Get user profile |
| GET | /social/profiles/:handle/ai | Get AI profile |
| POST | /social/send/:handle | Send cross-instance message |
| ALL | /proxy/:handle/* | Reverse proxy to container |

## Data Flow

### User Signup

```
1. User visits matrix-os.com/signup
2. Clerk handles registration (choose username = handle)
3. Clerk fires user.created webhook -> Inngest
4. Inngest function calls POST /containers/provision
5. Platform: allocate ports -> create container -> start -> insert DB
6. User redirected to dashboard -> link to {handle}.matrix-os.com
```

### Request Routing

```
1. Browser: https://alice.matrix-os.com/some/path
2. Cloudflare: resolve DNS -> tunnel to VPS
3. cloudflared: forward to localhost:9000
4. Platform: extract handle from Host header -> lookup container
5. If stopped: wake container (lazy start)
6. Reverse proxy to http://localhost:{shell_port}/some/path
7. Touch last_active timestamp
```

### Idle Shutdown

```
1. Lifecycle manager checks every 5 min
2. For each running container: compare last_active to now
3. If idle > 30 min: orchestrator.stop(handle)
4. Container stays in DB, can be woken on next request
```

## Testing

All components are designed for testability:
- DB functions take `db` as first arg (inject test DB)
- Orchestrator takes `docker` in config (inject mock)
- Lifecycle takes `orchestrator` in config (inject mock)
- API uses `createApp()` factory (test with Hono's built-in test client)

```bash
bun run test -- tests/platform/     # 40 tests, ~400ms
```

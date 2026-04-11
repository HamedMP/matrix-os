# Spec 063: React App Runtime

**Status**: Draft
**Created**: 2026-04-12
**Depends on**: 038 (App Platform foundation — process manager stubs), 050 (App Data Layer)
**Blocks**: 060 (Default Apps — all new apps built against this runtime)
**Constitution alignment**: I (Everything Is a File — source code on disk), III (Headless Core), IV (Defense in Depth), VI (App ecosystem)

## Problem

The current app runtime is iframe-only and serves a single `index.html` per app (`shell/src/components/AppViewer.tsx:149-158`, `home/apps/*/index.html`). There is no build step, no server-side apps, no TSX, no React component ecosystem access. The 11 default apps total ~12K lines of hand-written inline HTML/CSS/JS. The quality ceiling is capped because:

- Every app reinvents routing, state, layout, and design primitives
- No access to the React library ecosystem (@tanstack/react-query, framer-motion, recharts, @dnd-kit, etc.)
- No TypeScript type safety inside apps
- No way to build full-stack apps with API routes, server actions, or SSR
- AI authoring is stuck emitting a single HTML blob per app instead of idiomatic component code

Spec 038 declared support for `runtime: "node"` apps with process management and reverse proxy, but Phase A (T1400-T1409) was never implemented. This spec owns that work and extends it with a dedicated Vite mode optimized for static React builds.

## Goals

1. Three app runtimes coexist: `static` (raw HTML, current), `vite` (React SPA, built to `dist/`, statically served), `node` (long-running process, reverse-proxied — Next.js is the blessed framework but anything speaking HTTP on `$PORT` works)
2. AI agents author Vite + React apps as standard projects (`pnpm create vite`, `src/App.tsx`, `pnpm build`)
3. Gateway process manager handles spawn, idle shutdown, crash recovery, port allocation
4. Build orchestrator runs `pnpm install && pnpm build` on install and on source change, caches by lockfile + source hash
5. Shared pnpm store keeps disk usage bounded (content-addressable dedupe)
6. App store publishing ships source + pre-built `dist/`; install supports trusted (copy pre-built) and verified (rebuild + hash compare) paths
7. Resource limits per app (memory, CPU shares, file handles)
8. Compatible with existing `runtime: "static"` apps — nothing breaks

## Non-Goals

- Python/Rust/Docker runtimes (spec 038 listed them; this spec focuses on JS/TS)
- Auto-upgrade of existing default apps — quality pass happens under spec 060
- HMR/dev mode for end users (dev mode is a developer flag only, not a default; scoped out to a follow-up spec)
- Sandboxing beyond container-level limits — see spec 025 for stronger isolation
- WebAssembly runtime — future work
- Cross-origin app isolation — apps still run under the shell origin for bridge access

## Architecture Overview

### Runtime modes

| Mode | matrix.json `runtime` | Build output | Runtime process | Gateway route |
|---|---|---|---|---|
| Static | `"static"` | — (source is output) | none | serves `index.html` directly from `~/apps/{slug}/` |
| Vite SPA | `"vite"` | `~/apps/{slug}/dist/` | none | serves `dist/` as static files |
| Node server | `"node"` | `~/apps/{slug}/.next/` or `dist/` | long-running child process | reverse-proxy HTTP + WS to child port |

Next.js is a `runtime: "node"` app with conventional `build` + `start` commands. The runtime does not hardcode Next; it is just the blessed template (see `home/agents/skills/build-next-app.md`).

### Request flow

**Static + Vite (no process):**
```
Browser -> AppViewer iframe -> /files/apps/{slug}/[dist/]index.html
                             -> gateway static file route
                             -> filesystem
```

**Node (proxied):**
```
Browser -> AppViewer iframe -> /apps/{slug}/  (proxied URL)
                             -> gateway reverse proxy (Hono)
                             -> child process on 127.0.0.1:{assigned_port}
                             -> Next.js / Hono / Express / whatever
```

WebSocket upgrades (`/apps/{slug}/ws`, `/_next/webpack-hmr` in dev mode) are forwarded transparently by the proxy.

## matrix.json Schema Extension

```json
{
  "name": "Fancy Chart",
  "slug": "fancy-chart",
  "description": "Sales dashboard with live charts",
  "category": "productivity",
  "icon": "bar-chart",
  "author": "hamed",
  "version": "1.2.0",

  "runtime": "vite",
  "runtimeVersion": "^1.0.0",
  "scope": "personal",

  "build": {
    "install": "pnpm install --frozen-lockfile",
    "command": "pnpm build",
    "output": "dist",
    "timeout": 120,
    "sourceGlobs": ["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]
  },

  "serve": {
    "start": "pnpm start",
    "healthCheck": "/api/health",
    "startTimeout": 10,
    "idleShutdown": 300
  },

  "resources": {
    "memoryMb": 256,
    "cpuShares": 512,
    "maxFileHandles": 128
  },

  "permissions": ["network", "data:read", "data:write"],
  "storage": { "tables": { /* spec 050 */ } }
}
```

Rules:
- `build` required for `vite` and `node`, absent for `static`
- `serve` required for `node`, absent for `static` and `vite`
- `runtimeVersion` is a semver range; platform refuses apps requesting a runtime it cannot provide
- `resources` has platform defaults (256 MB / 512 shares / 128 FDs) if omitted
- `scope` defaults to `"personal"`; forward-compat for spec 062 shared apps
- Zod schema lives in `packages/gateway/src/app-runtime/manifest-schema.ts`, validated at install and on every load

## Process Manager

**Location**: `packages/gateway/src/app-runtime/process-manager.ts`

**Responsibilities:**
- Maintain a bounded `Map<appSlug, ProcessRecord>` of running child processes (cap = 10, LRU eviction)
- Allocate ports from a pool (range: 40000-49999)
- Spawn child processes via `child_process.spawn` with a restricted env whitelist
- Health check by polling `http://127.0.0.1:{port}{healthCheck}` on startup (up to `startTimeout` seconds)
- Track `lastUsedAt` per app, shut down idle apps after `idleShutdown` seconds
- Crash detection (exit with nonzero while `state === "running"`): restart with exponential backoff (1s / 4s / 16s), max 3 retries, then mark `failed`
- Graceful shutdown on gateway stop (SIGTERM with 5s grace → SIGKILL)

**Lifecycle states:**
```
idle -> starting -> healthy -> running -> idle_timeout -> stopping -> idle
                 \-> startup_failed
                      running -> crashed -> restarting -> healthy
                                         \-> failed (after max retries)
```

**ProcessRecord:**
```typescript
interface ProcessRecord {
  slug: string;
  state: "starting" | "healthy" | "running" | "stopping" | "crashed" | "failed";
  pid: number | null;
  port: number;
  startedAt: number;
  lastUsedAt: number;
  restartCount: number;
  lastError?: { code: string; stderrTail: string };
  child: ChildProcess | null;
  startupPromise: Promise<void> | null;  // shared across concurrent callers during starting
}
```

**Atomic spawn:**
1. Acquire process slot (LRU evict if at cap)
2. Allocate port from pool
3. Insert `ProcessRecord` in `state: "starting"` BEFORE spawning (prevents race between two concurrent `ensureRunning` callers)
4. Spawn child with `{ cwd: ~/apps/{slug}, env: safeEnv(slug, port) }` (env whitelist below)
5. Poll health check with `AbortSignal.timeout(startTimeout * 1000)`; fail if no 2xx within budget
6. On healthy: transition to `healthy` → `running`, resolve `startupPromise`
7. On any failure: stop child, release port, transition to `startup_failed` or `failed`, reject `startupPromise`

**Env whitelist (`safeEnv`):**
```typescript
{
  PORT: String(port),
  NODE_ENV: "production",
  HOME: `~/apps/${slug}`,
  PATH: minimalPath,
  MATRIX_APP_SLUG: slug,
  MATRIX_APP_DATA_DIR: `~/data/${slug}`,
  MATRIX_GATEWAY_URL: "http://127.0.0.1:4000",
  // NO CLAUDE_API_KEY, NO CLERK_SECRET, NO DB_URL beyond per-app
}
```

Child processes MUST NOT inherit gateway secrets. Per-app DB credentials are fetched from spec 050 app data layer.

## Gateway Reverse Proxy

**Location**: `packages/gateway/src/app-runtime/reverse-proxy.ts`

**Responsibilities:**
- Hono middleware matching routes `/apps/{slug}/*`
- Look up `ProcessRecord` by slug; if missing or not running, `await processManager.ensureRunning(slug)`
- Forward HTTP request to `http://127.0.0.1:{port}/*` preserving method, headers, body
- Forward response status, headers, body to the caller
- Handle WebSocket upgrades: on `Upgrade: websocket`, pipe the socket to `ws://127.0.0.1:{port}/*`
- Update `lastUsedAt` on every request
- Apply `AbortSignal.timeout(30000)` to backend fetches — no hang-forever (per CLAUDE.md external-call rule)
- On backend error: log server-side with full detail, return generic 502 with correlation ID (per CLAUDE.md error-exposure rule)
- Strip backend `Server:`, `X-Powered-By:` headers to avoid leaking provider info
- Enforce Hono `bodyLimit` (10 MB default) before forwarding

**Request rewriting:**
- Client request: `GET /apps/fancy-chart/api/posts`
- Forwarded as `GET /api/posts` to `http://127.0.0.1:{port}`
- Next.js apps set `basePath: "/apps/fancy-chart"` in their generated `next.config.js` so absolute asset URLs match

## Build Orchestrator

**Location**: `packages/gateway/src/app-runtime/build-orchestrator.ts`

**Responsibilities:**
- Detect when an app needs a build (no `dist/`, stale `dist/`, lockfile changed, any source file mtime newer than `.build-stamp`)
- Run `pnpm install` if `node_modules/` is missing or `pnpm-lock.yaml` is newer than `node_modules/.pnpm-lock-stamp`
- Run the `build.command` from matrix.json
- Capture stdout/stderr, stream to a per-app build log at `~/apps/{slug}/.build.log` (capped at 10 MB, LRU-truncated)
- Enforce `build.timeout` (default 120s) via AbortSignal on the child process
- Write `.build-stamp` JSON with `{ lockfile_hash, source_hash, built_at, exit_code }` on success
- On failure: leave stamp absent, surface typed `BuildError` to gateway, emit `app:build_failed` event
- Serialize concurrent builds for the same slug via a per-slug mutex
- Run multiple builds in parallel across different slugs, capped at 4 concurrent worker processes to bound CPU

**Cache invalidation rules:**
- `pnpm-lock.yaml` changed since `.pnpm-lock-stamp` → full `pnpm install` + `pnpm build`
- Any file matching `build.sourceGlobs` has mtime > `.build-stamp.built_at` → `pnpm build` only
- `.build-stamp` absent → full rebuild

## Install Flow

**First install of an app from the store:**
1. Installer downloads `{source.tar.gz, dist.tar.gz, manifest.json, publisher_signature}`
2. Validates publisher signature against store public key
3. Extracts source to `~/apps/{slug}/`
4. Validates `matrix.json` against the runtime version contract (semver match)
5. **Trusted path** (first-party or signed): extracts `dist.tar.gz` to `~/apps/{slug}/dist/`, writes `.build-stamp` with publisher's source hash
6. **Verified path** (community, untrusted): runs full `pnpm install && pnpm build`, hashes `dist/`, compares to publisher's declared hash, fails install on mismatch
7. Registers in the app catalog
8. For `runtime: "node"`: does NOT auto-start; waits for first user open

**Reinstall (upgrade):**
- Stop any running process (graceful SIGTERM)
- Delete `~/apps/{slug}/` except `data/` and `config/`
- Run fresh install flow
- Restart the process if it was running before

**Removal:**
- Stop the process
- Delete `~/apps/{slug}/` entirely (preserving `~/data/{slug}/` unless explicitly requested)
- Emit `app:removed` event

## pnpm Store Configuration

- Global store at `~/.pnpm-store` (container default)
- `~/apps/{slug}/node_modules` uses hard links into the store; each app adds a few MB at most
- `.npmrc` in every app directory: `store-dir=~/.pnpm-store\nlink-workspace-packages=false`
- Build orchestrator runs `pnpm install --frozen-lockfile` (CI mode — no lockfile writes)

## Shell Changes (AppViewer)

**File**: `shell/src/components/AppViewer.tsx`

**Current behavior**: iframe src = `/files/{path}` where `path` is the raw file path in the home dir.

**New behavior** (decision based on matrix.json `runtime`):
- `static` → `/files/apps/{slug}/index.html` (unchanged path shape)
- `vite` → `/files/apps/{slug}/dist/index.html`
- `node` → `/apps/{slug}/` (gateway reverse-proxy route)

The bridge script injection (theme, data subscriptions, sendToKernel) works identically for all three modes because they all render in same-origin iframes under the shell origin.

**Runtime detection**: AppViewer calls `fetchAppManifest(slug)` on mount to get the runtime mode, then sets the iframe src accordingly. Manifests are cached client-side for 60s via `shell/src/lib/app-manifest-cache.ts` to avoid an extra round-trip per re-render.

**Failure display**: if the manifest call returns `build_failed` or `process_failed`, the iframe is replaced with an error card showing the build log tail and a "Retry build" action.

## Security

Per CLAUDE.md Mandatory Code Patterns:

**External calls (proxy → child process):**
- Every proxied fetch has `AbortSignal.timeout(30000)` for HTTP, 60s idle for WebSocket
- Backend errors never leak to client (generic 502 with correlation ID; full error in server log only)

**Input validation:**
- Hono `bodyLimit(10 * 1024 * 1024)` on proxied routes
- Slug validated with `SAFE_SLUG` regex (`^[a-z0-9][a-z0-9-]{0,63}$`) before any filesystem path construction
- Manifest path passed through `resolveWithinHome()` before read
- Port allocation validates range; rejects ports outside 40000-49999

**Resource management:**
- Process slot map capped at 10, LRU eviction
- Port pool capped at 100 slots, released on process stop or crash
- Build log files capped at 10 MB, oldest lines truncated first
- `ProcessRecord` entries cleaned up on `removed` state
- Graceful shutdown on gateway stop drains all processes

**Child process isolation (first pass):**
- Run as the same user as the gateway (container is the security boundary)
- Env vars whitelisted via `safeEnv()` — no inherited secrets
- Memory limit via Node `--max-old-space-size={memoryMb}` flag injected into `start` command
- File descriptor limit via `prlimit --nofile={maxFileHandles}` wrapper on Linux; best-effort on macOS dev
- No egress network restrictions in this spec — covered by future spec 025 (outbound proxy)
- `NODE_OPTIONS` stripped from inherited env to prevent debugger injection

**Error handling:**
- No bare `catch { return null }` anywhere in process manager or proxy
- Typed error classes: `BuildError`, `SpawnError`, `HealthCheckError`, `ProxyError`, `ManifestError`
- Every `catch` distinguishes connection failures, timeouts, and application errors
- Build failures surface with `{ stage: "install" | "build", exitCode, stderrTail }`

## Failure Modes

| Failure | Detection | Response |
|---|---|---|
| `pnpm install` fails | Non-zero exit | `build_failed` event, UI shows "Install failed: {stderr tail}", app not runnable |
| `pnpm build` fails | Non-zero exit | Same, `dist/` left in previous state if it existed |
| Build exceeds timeout | AbortSignal fires | Kill process group, mark `build_failed` with `reason: "timeout"` |
| Child process fails health check | Poll timeout | Mark `startup_failed`, shut down process, release port |
| Child process crashes after healthy | `exit` with nonzero code | Restart with backoff (1s / 4s / 16s), max 3 retries, then `failed` |
| Child process OOM | `exit` with signal `SIGKILL` or code 137 | Same as crash, log memory limit hit, surface to UI |
| Port collision | `EADDRINUSE` on bind | Release port, re-allocate from pool, retry once |
| Gateway restart (process manager lost) | N/A | On startup scan `~/apps/*/matrix.json`, do NOT auto-start, empty ProcessRecord map |
| Disk full during install | `ENOSPC` | Abort, clean up partial `node_modules`, surface typed error to UI |
| Malformed `matrix.json` | Zod parse fails | Reject app load, log, surface to UI |
| App imports missing dep | Runtime error in child | Reported via child stderr → build log → UI |
| Request while process is `starting` | State check in proxy | Await `startupPromise` (with timeout), then forward |
| Request while process is `failed` | State check in proxy | Return 503 "App failed to start", include correlation ID |
| Concurrent `ensureRunning` calls | State check before spawn | Return the existing `startupPromise` so only one spawn happens |
| `pnpm-lock.yaml` tampered post-install | Hash mismatch on next build | Fail build with `BuildError.code = "lockfile_tampered"` |

## Testing

**Unit tests** (`tests/gateway/app-runtime/`):
- `manifest-schema.test.ts` — valid/invalid parses, runtime enum, semver ranges, default values
- `process-manager.test.ts` — spawn, health check, idle shutdown, LRU eviction, crash retry backoff, port allocation, slot exhaustion, concurrent `ensureRunning` dedup
- `port-pool.test.ts` — allocation/release, exhaustion, cleanup on crash
- `reverse-proxy.test.ts` — HTTP forwarding, WebSocket upgrade, error pass-through, timeout behavior, header sanitization, bodyLimit enforcement
- `build-orchestrator.test.ts` — cache hit, cache miss, lockfile invalidation, concurrent build serialization, timeout handling
- `install-flow.test.ts` — trusted path, verified path hash comparison, rollback on failure, signature verification

**Integration tests** (`tests/gateway/app-runtime-integration.test.ts`):
- Install a real Vite template app from `tests/fixtures/apps/hello-vite`, run build, serve dist, validate response
- Install a real Next.js fixture from `tests/fixtures/apps/hello-next`, spawn process, proxy a request, receive SSR HTML, validate graceful shutdown
- Concurrent requests to a starting process (should serialize on `startupPromise`)
- Crash-restart loop with a fixture that crashes on first request; verify `failed` after max retries
- Idle shutdown after clock advance (`vi.useFakeTimers`)

**E2E test** (`tests/e2e/app-runtime.spec.ts`, Playwright):
- Sign in, open a Vite default app, interact, close, reopen, verify state persistence
- Open a Node default app, verify it cold-starts, interact, idle 5 min (fake clock), verify it shuts down, reopen verifies cold-start again
- Screenshot the "build failed" error card

## File Structure

```
packages/gateway/src/app-runtime/
  manifest-schema.ts          # Zod schema for matrix.json runtime fields
  process-manager.ts          # ProcessRecord lifecycle + port pool
  port-pool.ts                # 40000-49999 allocation/release
  reverse-proxy.ts            # Hono middleware for /apps/{slug}/*
  build-orchestrator.ts       # pnpm install + build + cache
  build-cache.ts              # .build-stamp read/write, hash computation
  install-flow.ts             # Trusted + verified install paths
  safe-env.ts                 # Env whitelist builder
  errors.ts                   # Typed error classes
  index.ts                    # Public API

shell/src/components/
  AppViewer.tsx               # Updated for three runtime modes

shell/src/lib/
  app-manifest-cache.ts       # Client-side manifest cache (60s TTL)

tests/gateway/app-runtime/
  manifest-schema.test.ts
  process-manager.test.ts
  port-pool.test.ts
  reverse-proxy.test.ts
  build-orchestrator.test.ts
  install-flow.test.ts
tests/gateway/app-runtime-integration.test.ts
tests/e2e/app-runtime.spec.ts

tests/fixtures/apps/
  hello-vite/                 # minimal Vite React app for tests
  hello-next/                 # minimal Next.js app for tests
  crash-on-request/           # fixture that crashes on first HTTP request

home/apps/_template-vite/     # Vite React scaffold for AI authoring
  package.json
  vite.config.ts
  tsconfig.json
  src/App.tsx
  src/main.tsx
  src/matrix-os.d.ts          # types for the bridge
  index.html
  matrix.json
home/apps/_template-next/     # Next.js scaffold for AI authoring
  package.json
  next.config.ts              # basePath pre-wired from MATRIX_APP_SLUG
  tsconfig.json
  app/page.tsx
  app/layout.tsx
  app/api/health/route.ts
  matrix.json

home/agents/skills/
  build-vite-app.md           # AI skill: scaffold + edit + build Vite app
  build-next-app.md           # AI skill: scaffold + edit + build Next.js app
  pick-app-runtime.md         # AI decision tree: static vs vite vs node
```

## AI Authoring Flow

When the AI is asked to build a new app:

```bash
# Vite SPA (most common)
cd ~/apps
cp -r _template-vite my-grocery-list
cd my-grocery-list
# edit src/App.tsx, matrix.json
pnpm install
pnpm build
# platform file watcher picks up the new dir and registers it
```

For Next.js:
```bash
cd ~/apps
cp -r _template-next my-dashboard
cd my-dashboard
# edit app/page.tsx, app/api/*, matrix.json
pnpm install
pnpm build
# platform will spawn the process on first open
```

Templates are pre-lockfile-resolved so the first build is fast (pnpm store already contains every pinned version). Skills teach the AI:
- Scaffold commands
- How to read/update matrix.json
- Where to put assets
- How to use `matrix-os/client` (typed wrapper over the postMessage bridge) for kernel communication, theme, and data subscriptions
- How to wire up per-app Postgres (spec 050)

## App Store Implications

**Publish flow:**
1. Publisher runs `matrix app publish` from the app directory
2. CLI validates matrix.json against the runtime version contract
3. CLI runs `pnpm install --frozen-lockfile && pnpm build` and hashes `dist/`
4. Uploads `{source.tar.gz, dist.tar.gz, manifest.json, dist_hash, publisher_signature}` to the store
5. Store signs the bundle with its own key and stores the artifact

**Install flow (trusted, first-party or signed):**
1. User clicks Install
2. Store serves the bundle
3. Installer validates the store signature, extracts source + dist, writes `.build-stamp` with the declared hash
4. Ready in under 5 seconds

**Install flow (verified, community):**
1. Installer extracts source only
2. Runs `pnpm install && pnpm build`
3. Hashes the result, compares to the publisher's declared hash
4. Fails install on mismatch — reproducible builds catch tampering

**Runtime version contract:**
- Each shell ships a `runtime` version (semver, e.g. `1.0.0`)
- An app's `runtimeVersion: "^1.0.0"` is checked at install time
- Shell refuses to install apps needing a newer runtime than it has
- Backward-compatible additions bump minor; breaking changes bump major

## Quality Gates Checklist

- [x] **Security architecture**: auth via container user, Zod manifest validation, slug regex, bodyLimit, env whitelist, typed errors, generic 502 responses, secrets never inherited by children
- [x] **Integration wiring**: process manager is a gateway singleton, reverse proxy is Hono middleware, build orchestrator is invoked by install-flow and a file watcher, manifest cache is shell-side with explicit TTL
- [x] **Failure modes**: table above covers build fail, process crash, OOM, port collision, gateway restart, disk full, malformed manifest, concurrent spawn
- [x] **Resource management**: process slot cap (10), port pool cap (100), build log cap (10 MB), memory/CPU/FD limits per process, graceful shutdown on gateway stop, LRU eviction when slot-exhausted

## Open Questions

1. **Should build output live in `~/apps/{slug}/dist/` or a separate `~/apps-built/{slug}/`?** Leaning separate to enable atomic swap on rebuild and keep source dirs clean for git.
2. **Do `static` apps support `dependencies` for consistency?** Probably yes — expose the shared runtime import map via a `/runtime.json` endpoint so static apps can opt into ESM imports.
3. **Next.js basePath** — generate a wrapper `next.config.js` that injects `basePath` from `MATRIX_APP_SLUG`, or require publishers to configure it manually? Leaning generated wrapper for safety.
4. **Dev mode HMR** — out of scope here, but the eventual flag lives on `matrix.json` as `dev: true` and runs `pnpm dev` instead of serving `dist/`. Separate follow-up spec.
5. **Per-app secrets** — how do Mail/Inbox access Pipedream tokens? Via gateway-provided `MATRIX_GATEWAY_URL` and a per-app auth token injected at spawn time. Detail owned by spec 049 integration plumbing.

## Implementation Phases

**Phase 1 — Static + Vite (no process)**: manifest schema, build orchestrator, install flow (trusted path), AppViewer mode switch. No process manager needed. Unblocks spec 060 for Vite apps immediately.

**Phase 2 — Node runtime**: process manager, port pool, reverse proxy, `ensureRunning` semantics, crash recovery, idle shutdown. Required for any Next.js app.

**Phase 3 — App store integration**: publish CLI, verified install path, reproducible build hashing, runtime version negotiation.

**Phase 4 — Dev mode**: `pnpm dev` with HMR WebSocket proxy. Developer-only behind a flag.

Spec 060 depends on Phase 1. Phases 2-4 can land independently without blocking app development.

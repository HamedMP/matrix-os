# VPS Optimization & Fleet Deploy

Spec for two related initiatives: fixing the gateway memory/CPU crisis on customer VPS instances, and building a deliberate fleet deployment system.

## Problem

The gateway process consumes 3.5-6.4 GB RSS on a 7.6 GB VPS due to:

1. **tsx runtime transpilation** — 181+ source files compiled at startup, cached in V8 heap (~300-800 MB overhead)
2. **19 zombie terminal sessions** restored on every restart, each spawning a bash process + 1 MB buffer
3. **`--max-old-space-size=4096`** letting V8 fill 4 GB on a 7.6 GB machine
4. **No swap** — any spike OOM-kills the gateway
5. **Chokidar polling** 4,078 files every 1s on Linux (where inotify is available)

The gateway crashes every ~7 minutes, restarting 80-100+ times per day. Running a dev instance alongside production is impossible.

There is also no mechanism to deploy updates to VPS instances — the `matrix-sync-agent` is a stub.

## Goal

1. Gateway RSS under 1 GB in production (from 3.5-6.4 GB)
2. Prod + dev + Claude Code running simultaneously on 4 vCPU / 8 GB
3. One-command fleet deploy with automatic rollback

## Decisions Made

### A. Pre-compile TypeScript for production

**Decision**: Run `tsc` at build time for both `@matrix-os/kernel` and `@matrix-os/gateway`. Production launcher uses `dist/main.js`; falls back to `tsx src/main.ts` if dist is missing.

**Why tsx exists**: Developer convenience — `tsx watch` gives hot reload during development. The `"dev"` script uses tsx, the `"build"` script uses tsc. Both already exist in package.json. The build-host-bundle script already calls `pnpm --filter '@matrix-os/gateway' build`, but the launcher ignores the output.

**What changes**:
- Kernel: add `pnpm --filter '@matrix-os/kernel' build` to bundle script, update `exports` in package.json to point at `dist/`
- Gateway: copy `src/app-runtime/*.html` to dist post-build
- Launcher: `if [ -f dist/main.js ]; then node dist/main.js; else node --import=tsx src/main.ts; fi`
- Dev workflow: **unchanged** — `bun run dev` still uses `tsx watch`

**Estimated savings**: 300-800 MB RSS (tsx transpilation cache eliminated)

### B. Chokidar: inotify on Linux, polling on macOS

**Decision**: `usePolling: process.platform === "darwin"` in `watcher.ts`.

**Why polling exists**: Chokidar v4 dropped FSEvents, macOS kqueue opens one FD per path and hits EMFILE on large directories. This doesn't apply to Linux (inotify watches directories, not individual files).

**What changes**: One-line edit in `packages/gateway/src/watcher.ts`.

### C. Infrastructure fixes (already applied)

Applied to this VPS (`matrix-arian`) on 2026-05-06:

- 4 GB swap (`/swapfile`, in `/etc/fstab`)
- Zombie terminal sessions cleared (`terminal-sessions.json` = `[]`)
- V8 heap cap: 4096 → 3072 (`/etc/systemd/system/matrix-gateway.service.d/memory-limit.conf`)
- systemd `MemoryHigh=3.5G`, `MemoryMax=4G`
- `vm.swappiness=10`

These are stopgaps — the tsc pre-compilation (A) is the real fix.

### D. Fleet deployment via R2 manifest + operator trigger

**Decision**: No auto-updates. Operator runs `matrix-update` (single VPS) or `matrixctl deploy` (all VPS) when ready.

**Architecture**:

```
Merge PR → CI → build-host-bundle.sh → publish-release.sh → R2
                                                               |
              manifest.json (version, sha256, url)             |
                                                               v
  +--- VPS-1 -----+    +--- VPS-2 -----+    +--- VPS-N -----+
  | sync-agent     |    | sync-agent     |    | sync-agent     |
  | polls manifest |    | polls manifest |    | polls manifest |
  | every 5 min    |    | every 5 min    |    | every 5 min    |
  +----------------+    +----------------+    +----------------+
         |                                           |
   "update available"                          "update available"
   (does NOT auto-apply)                       (does NOT auto-apply)
         |                                           |
   matrix-update  ←── operator triggers ──→   matrix-update
         |                                           |
   download → verify sha256 → stop services → swap → start → health check
         |                                           |
   if unhealthy → automatic rollback          if unhealthy → automatic rollback
```

**Trigger mechanisms**:
- `matrix-update` — CLI on a single VPS, touches `/opt/matrix/app/.update-now`
- `matrix-update rollback` — rollback on a single VPS
- `matrixctl deploy v0.4.2` — calls platform API, fans out to all registered VPS
- `SIGUSR1` to sync-agent PID — alternative programmatic trigger

**Update flow on a single VPS**:
1. Download bundle to `/opt/matrix/staging/`
2. Verify sha256 against manifest
3. `systemctl stop matrix-gateway matrix-shell`
4. `mv /opt/matrix/app → /opt/matrix/app.rollback`
5. Extract new bundle to `/opt/matrix/app`
6. Update bin scripts
7. `systemctl start matrix-gateway matrix-shell`
8. Health check (6 attempts, 5s apart, 30s timeout each)
9. If healthy: clean up staging + rollback dir
10. If unhealthy: swap back rollback, restart

**Manifest format** (`releases/manifest.json` in R2):
```json
{
  "version": "0.9.1",
  "sha256": "a1b2c3...",
  "url": "https://<r2>/releases/v0.9.1/matrix-host-bundle.tar.gz",
  "published": "2026-05-07T10:00:00Z",
  "changelog": "Pre-compile gateway, fix terminal session leak"
}
```

### E. Memory reality (measured 2026-05-07)

Module imports cost ~300 MB total. The remaining ~3.2 GB comes from
`createGateway()` assembling 3,500 lines of route handlers, closures,
middleware, and subsystems (Postgres, app-db, canvas, sync, plugins,
workspace routes, watchers). This is V8 heap overhead from the
application's architecture — not fixable by lazy-loading individual
modules.

| Component | Measured RAM |
|---|---|
| Gateway (prod, compiled, no tsx) | ~3.5 GB |
| Shell (Next.js prod) | ~200 MB |
| Dev gateway | ~3.5 GB |
| Dev shell (Turbopack) | ~600 MB |
| code-server + Postgres + sync-agent | ~120 MB |
| Claude Code (1 session) | ~400 MB |
| OS | ~500 MB |

**Customer VPS (8 GB, prod only):** 3.5 + 0.2 + 0.1 + 0.5 = ~4.3 GB used, ~3.5 GB free. Works.

**Dev VPS (8 GB, prod + dev):** Would need ~8.4 GB. Does not fit.

**Dev VPS (16 GB, prod + dev):** ~8.4 GB used, ~7.6 GB free. Comfortable.

### F. VPS tier recommendation

| Tier | RAM | Use case | Hetzner plan | ~Price |
|---|---|---|---|---|
| Customer | 8 GB | Production only | CPX32 | €13/mo |
| Developer | 16 GB | Production + dev + Claude Code | CPX42 | €25/mo |

## Implementation plan

### Phase 1: Gateway memory fix (priority)

- [ ] Pre-compile `@matrix-os/kernel` — add build to bundle script, update exports
- [ ] Gateway build: copy HTML asset to dist
- [ ] Switch watcher to inotify on Linux
- [ ] Reduce terminal session TTL from 7 days to 24 hours
- [ ] Lower maxSessions from 20 to 10

### Phase 2: Fleet deploy system

- [ ] Write `scripts/publish-release.sh` (upload bundle + manifest to R2)
- [ ] CI pipeline: on merge to main → build → publish
- [ ] Platform API: `POST /api/fleet/deploy` (fan out to all VPS)
- [ ] Gateway: `POST /api/internal/upgrade` endpoint
- [ ] Health endpoint: include `updateAvailable` field

### Phase 3: Future improvements

- [ ] Lazy PTY spawning (only spawn bash on attach, not on restore)
- [ ] Add eviction to `ConversationRunRegistry.runs` Map
- [ ] Add eviction to dispatcher `activeSessions` Map
- [ ] Shell UI "update available" banner
- [ ] `matrixctl deploy` CLI with streaming progress

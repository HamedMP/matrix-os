# 066 File Sync — Follow-Ups

State at end of session 2026-04-18 evening. Phase 9 (OAuth) is complete and merged into the working branch. Three-way sync (container ↔ R2 ↔ peer) is implemented behind `MATRIX_HOME_MIRROR=true` (default on in `docker-compose.dev.yml`), but several rough edges remain. Each item below is independently shippable.

## What works today

- `matrix login --dev` + `matrix sync ~/somewhere` — daemon installed via launchd, CLI + Mac app IPC.
- Local file create/edit → debounce → presign → upload → commit → manifest version bumps.
- Container side (gateway) auto-mirrors `/home/matrixos/home/` to R2 on startup and watches for changes.
- Local daemon now does an **initial pull** on startup: walks the manifest, downloads every entry that's missing locally or has a stale hash.
- Serial commit chain (both daemon and container mirror) — no more 13-files-racing-on-optimistic-concurrency timeouts.
- Mac menu bar app shows daemon status (after the IPCResponse envelope fix).

## P0 — Things blocking everyday usage

### F1. Replace basename-as-prefix with explicit `gatewayFolder` config

**Problem**: today `matrix sync ~/foo` uses the basename `foo` as a gateway prefix. So `matrix sync ~/matrixos-mirror` filters out everything from the gateway that isn't already under `matrixos-mirror/...` — and the container mirror pushes to NO prefix, so the local daemon sees an empty intersection.

**Fix**:
- `SyncConfigSchema.gatewayFolder` already added (`packages/sync-client/src/lib/config.ts`). Default `""` = "mirror everything".
- Daemon (`packages/sync-client/src/daemon/index.ts`) currently computes `remotePrefix = basename(config.syncPath)`. Replace with `config.gatewayFolder ?? ""`.
- When `gatewayFolder === ""`: `toRemote(rel) = rel`, `toLocal(remote) = remote`, no filter.
- When `gatewayFolder === "audit"`: same logic as today's basename, but explicit.
- Add `--folder <name>` flag to `matrix sync` so users can opt into scoped mode.
- Update `matrix login --dev` to write `gatewayFolder: ""` so first-run is full-mirror.

**Acceptance**: after `matrix login --dev` + `matrix sync ~/matrixos-mirror`, the local folder mirrors the entire container home (`.claude/`, `system/`, `agents/`, etc).

### F2. Container mirror doesn't sync container ← R2 changes

`packages/gateway/src/sync/home-mirror.ts` only does an initial pull at startup. Files uploaded to R2 by another peer (i.e. the user's laptop) never appear in `/home/matrixos/home/` on the container — there's no WebSocket subscriber on the container side.

**Fix**: have `home-mirror.ts` open a self-WS to `ws://localhost:4000/ws` (or skip WS entirely and use the in-process `peerRegistry` event stream) and download files on `sync:change` events. Suppress the resulting `add`/`change` watcher event with the existing `recentlyWritten` map.

### F3. The watcher's "skip if same hash" check has a subtle bug

In `packages/sync-client/src/daemon/index.ts`, the on-change handler checks `existing?.lastSyncedHash === event.hash` to skip re-uploads. But `existing` is keyed by `remotePath` (post my prefix change), and chokidar emits the local rel path — fixed for the daemon, but verify after F1 lands. The home-mirror has the same shape; verify against `manifest.files[relPath]?.hash`.

## P1 — UX gaps

### F4. Mac menu bar app: settings panel

Add a Settings/Preferences view showing:

- Current `syncPath` (with "Open in Finder" button)
- Current `gatewayUrl`, `platformUrl`, `peerId`
- Pause/Resume toggle (already in main view but should also live in settings)
- Folder picker to change `syncPath` (writes `~/.matrixos/config.json`, then asks daemon to restart by sending an IPC `restart` command)
- Account section: handle, "Log out" button (calls `clearAuth` and stops the daemon)

Files to touch:
- `packages/sync-client/macos/MatrixSync/MenuBarView.swift` — add a "Settings…" menu item that opens a window
- New `SettingsView.swift` — SwiftUI form binding to `SyncStatusModel` (extend the model to expose config fields, not just status)
- New IPC commands in `packages/sync-client/src/daemon/ipc-server.ts`: `getConfig`, `setSyncPath`, `restart`

### F5. `matrix sync status` race after `matrix sync <path>`

Already partly fixed — sync now skips the launchctl bounce when daemon is running on the same path. But the FIRST install still shows "not running" for a second. Add a small "wait until socket appears" loop in the CLI's `runStart` after `startService()` so the success message lines up with reality.

### F6. Initial-pull is slow + noisy

For a fresh container (~2k+ files in `system/qmd/`, `.claude/skills/`, etc), the initial pull is sequential and logs every file. Add:

- Concurrency limit (e.g. 8 parallel downloads) — the AWS SDK already pools connections.
- Progress aggregation — log "pulled N/M files" every 100 files instead of every file.
- A `.syncignore` walker on the local side that mirrors what `home-mirror.ts` already filters (node_modules, .next, .git, .matrixos, *.log, .env*) — saves bandwidth and disk.

### F7. Daemon reads `~/.matrixos` only — no per-target config

Multi-folder usage (one daemon for `~/audit`, another for `~/notes`) requires distinct config dirs. Today both daemons collide on `~/.matrixos/{config.json,daemon.sock,daemon.pid,sync-state.json}`. Plumb a `MATRIXOS_CONFIG_DIR` env var that the daemon, IPC server, and CLI all respect.

## P2 — Reliability and security

### F8. Stale manifest references after MinIO bucket reset

If R2/MinIO is wiped but the Postgres `sync_manifests` table isn't, the gateway's manifest contains entries with no R2 backing → home-mirror logs `pull failed: NoSuchKey` for every stale entry. Either:
- Have the gateway self-heal on startup: list R2 prefix, drop manifest entries with no matching object.
- Add a `matrix sync reset` CLI command that calls a new gateway endpoint to clear both.

### F9. Excluding secrets from container mirror

`home-mirror.ts` ignores `.env*`, but `~/.claude/.credentials.json` got pushed in the earlier test. Audit the `DEFAULT_IGNORE_PATTERNS` list:
- Add: `.credentials.json`, `*.key`, `*.pem`, `id_rsa*`, `*.token`
- Better: a deny-by-default list for known-secret filenames + a `.syncignore` parser in the gateway (mirror the daemon's `loadSyncIgnore`).

### F10. Three-way conflict story

Current behavior: container and laptop both edit the same file → whoever commits last wins (the gateway uses optimistic concurrency, but conflicts at the manifest level just retry in the serial chain). For text files we have `node-diff3` already wired into `packages/gateway/src/sync/conflict.ts` — but the home-mirror and daemon don't invoke it. Wire conflict detection in the commit path: if the manifest's current entry has a different hash than `lastSyncedHash`, treat as conflict and either 3-way-merge or write a conflict copy.

### F11. Tests

No tests yet for `home-mirror.ts`, the initial-pull path, or the prefix logic. At minimum:

- `tests/gateway/sync/home-mirror.test.ts` — initial-pull writes files, change events upload, ignored paths are skipped, suppression of just-pulled files works.
- `packages/sync-client/tests/unit/initial-pull.test.ts` — daemon downloads only files matching `gatewayFolder`, skips files with matching local hash.
- Round-trip integration test: container creates `agents/foo.md` → MinIO has it → daemon pulls it → local file matches.

## P3 — Polish

### F12. `matrix doctor` should check sync state

Extend `bin/cli.ts` `runDoctor` to also report:
- Daemon running? (PID/socket check)
- Last successful sync timestamp (from sync-state.json)
- Number of pending changes
- Connected peers (via gateway)

### F13. `matrix logs` CLI command

Today logs land in `~/.matrixos/logs/sync.log` (pino JSON). Add `matrix logs [--follow] [--level error]` that pretty-prints them via `pino-pretty`-style formatting.

### F14. Document the three-way architecture

Add a "How sync actually works" section to `docs/dev/sync-testing.md` showing the three actors (container home-mirror, R2 bucket, local daemon) and the data flow. Most of the confusion in this session came from users (and Claude) assuming `matrix sync` was a full mirror by default.

## Reference: files touched this session

- `packages/gateway/src/sync/home-mirror.ts` (NEW)
- `packages/gateway/src/server.ts` (wire home-mirror behind `MATRIX_HOME_MIRROR=true`)
- `packages/gateway/src/auth.ts` + `auth-jwt.ts` (Phase 9: hybrid bearer + JWT)
- `packages/platform/src/{auth-routes,device-flow,sync-jwt,schema,db,main,package.json}.ts` (Phase 9 endpoints)
- `packages/sync-client/src/daemon/{index.ts,launcher.mjs,service.ts,watcher.ts}` (initial-pull, .mjs launcher, plist WorkingDirectory, ignoreInitial=false)
- `packages/sync-client/src/cli/commands/{login.ts,sync.ts}` (`--dev` writes localhost endpoints, sync skips bounce, positional path works alongside subcommands)
- `packages/sync-client/src/lib/config.ts` (added `platformUrl`, `gatewayFolder`)
- `packages/sync-client/macos/MatrixSync/SyncStatusModel.swift` (IPC envelope fix)
- `bin/{matrixos.mjs,matrixos.ts,cli.ts}` + `package.json` (`matrix` bin alias, auto-loads JWT)
- `docker-compose.dev.yml` (`PLATFORM_JWT_SECRET`, `MATRIX_HOME_MIRROR=true`, dev defaults)
- `docs/dev/{docker-development,sync-testing}.md` + `specs/066-file-sync/{contracts/auth-api,phase9-decisions,follow-ups}.md`

## Recommended next-session order

1. **F1 (`gatewayFolder` plumbing)** — unblocks "see container files locally" UX. ~30 lines.
2. **F2 (container subscribes to R2 changes)** — closes the three-way loop. ~80 lines.
3. **F4 (Mac app settings)** — user-facing polish that surfaces the new config field.
4. **F11 (tests)** — lock in F1/F2 before they regress.
5. Everything else is opportunistic.

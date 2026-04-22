# 066 File Sync — Follow-Ups

State at end of session 2026-04-18 evening. Phase 9 (OAuth) is complete and merged into the working branch. Three-way sync (container ↔ R2 ↔ peer) is implemented behind `MATRIX_HOME_MIRROR=true` (default on in `docker-compose.dev.yml`), but several rough edges remain. Each item below is independently shippable.

## What works today

- `matrix login --dev` + `matrix sync ~/somewhere` — daemon installed via launchd, CLI + Mac app IPC.
- Local file create/edit → debounce → presign → upload → commit → manifest version bumps.
- Container side (gateway) auto-mirrors `/home/matrixos/home/` to R2 on startup and watches for changes.
- Local daemon now does an **initial pull** on startup: walks the manifest, downloads every entry that's missing locally or has a stale hash.
- Serial commit chain (both daemon and container mirror) — no more 13-files-racing-on-optimistic-concurrency timeouts.
- Mac menu bar app shows daemon status (after the IPCResponse envelope fix).

## Done in this session (2026-04-18, evening+2)

### F1. Replace basename-as-prefix with explicit `gatewayFolder` — DONE

Extracted `packages/sync-client/src/daemon/remote-prefix.ts` (`createRemotePrefixMapper(folder)` returning identity maps when folder is empty, prefix-guarded maps otherwise). Wired into the daemon; added `--folder <name>` flag on `matrix sync`; `matrix login --dev` now explicitly writes `gatewayFolder: ""`. First-run = full mirror. Covered by `packages/sync-client/tests/unit/remote-prefix.test.ts`.

### F2. Container mirror subscribes to sync:change — DONE

`packages/gateway/src/sync/home-mirror.ts` now accepts an optional `peerRegistry` and registers itself as a virtual peer (`gateway-${userId}`) with a shim `SyncPeerConnection`. The shim's `send()` parses incoming broadcasts, and for each file either pulls via `r2.getObject` + `writeFile` or unlinks locally. `recentlyWritten` guards the chokidar echo. Wired into `packages/gateway/src/server.ts`. Covered by `tests/gateway/sync/home-mirror.test.ts` (download, delete, ignored paths, no-echo).

### Menu bar app surfaces sync scope — DONE

Daemon IPC `status` response gained `syncPath` / `gatewayFolder` / `gatewayUrl` / `peerId`. Swift `DaemonStatus` struct adds those (optional for backwards compat with older daemons). `MenuBarView` displays the local folder, "Full mirror" vs "Folder: <name>", peer id, and an Open-in-Finder button.

## P1 — Finder UX polish (Option A shipped; Option B open)

### F17. File Provider Extension for true "Locations" placement

Option A (FIFinderSync) gives badges + a Favorites sidebar pin. It does NOT put the folder in the "Locations" section of Finder's sidebar like Google Drive/Dropbox — that section is owned by the File Provider system and only populated by registered providers.

To match Drive/Dropbox UX exactly:
- New `.appex` target using `NSFileProviderReplicatedExtension`
- Sync folder relocates to `~/Library/CloudStorage/MatrixSync/` (system-managed)
- Daemon becomes the provider's data source (replaces chokidar watcher + direct writes)
- Full on-demand materialization and built-in system badges

Multi-day refactor. Write a dedicated spec before starting so we don't collide with the daemon's current architecture.

### F18. Auto-enable Finder Sync extension on first launch

macOS requires the user to turn on the Finder extension manually in System Settings → Extensions → Added Extensions (or via `pluginkit -e use`). On first launch, show a one-time prompt with a "Open Extensions Preferences" button that calls `NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preferences.extensions?FinderExtensions")!)`. Currently the user has to find it themselves.

## P0 — Things still blocking everyday usage

### F19. Shared-folder data plane still fail-closed

Share CRUD/listing landed, but the actual presign/commit path for a grantee syncing an owner's folder is not wired yet. The current routes still operate on the caller's own namespace only; `checkSharePermission()` exists, but owner-scoped JWTs and daemon-side shared-folder plumbing have not shipped.

Before enabling shared-folder sync:

- Add owner-scoped sync auth so the gateway can distinguish "caller" from "target owner" on presign/commit.
- Wire `checkSharePermission()` into those presign/commit paths using the owner scope from the auth context.
- Finish daemon shared-folder handling (`sync:share-invite` / `sync:access-revoked`) so accepted shares mount under `~/matrixos/shared/{owner}/...`.

Until then, shared-folder access remains intentionally fail-closed instead of silently granting the wrong namespace.

### F16. Coalesce commits instead of one-per-file

Every single file change today is its own commit: `home-mirror.pushFile` and the daemon's `onEvent` each call `writeManifest(newVersion = existing + 1)`. Saving 30 files in a burst = 30 commits = 30 manifest rewrites in R2 and 30 `sync_manifests` row updates in Postgres.

This is why the manifestVersion inflates fast (e.g. 172 after a single session). It's not a correctness bug, but:

- Manifest size grows linearly with writes, not with file count (more writes → more `version` churn, which on re-pulls means more diffing work).
- R2 costs 1 PUT per commit.
- Large folder pastes / `pnpm install` outputs / git operations create commit storms that pressure the serial chain.

**Fix**: batch window (~200–500ms). Collect `pushFile`/`onEvent` events into a pending map, and every tick commit all pending as one `writeManifest` call with one broadcast. Retry the whole batch on optimistic-concurrency conflict. Preserves per-file hashes; just drops the per-commit overhead.

### F15. Bucket prefix should be Clerk `userId`, not `handle`

Today `buildFileKey(userId, ...)` uses `MATRIX_HANDLE` from env (see `server.ts:320`, `349`). A handle is a display name the user can change; a Clerk userId (e.g. `user_2abc...`) is immutable. Using handle as the bucket prefix means that:

- Renaming a handle orphans every R2 key + `sync_manifests` row under the old prefix.
- Handle collisions on re-registration could let a new user read a prior user's files.

**Fix**:
- Thread Clerk userId through the JWT and make the gateway's `getUserId` return `claims.sub`, not the handle env var.
- Update `home-mirror.ts` to use the same.
- Keep handle as a purely cosmetic field (logs, menu bar display).
- Migration: for any existing data, add a one-shot script that copies `matrixos-sync/<handle>/...` → `matrixos-sync/<clerk_user_id>/...` and rewrites the `sync_manifests` row. In dev (where `MATRIX_HANDLE=dev` today) we can just wipe MinIO.

Do this BEFORE the first real user data lands to avoid the migration pain.

### F3. The watcher's "skip if same hash" check has a subtle bug

In `packages/sync-client/src/daemon/index.ts`, the on-change handler checks `existing?.lastSyncedHash === event.hash` to skip re-uploads. Post-F1 the daemon keys `syncState.files` by the REMOTE path (which equals the local rel path in full-mirror mode, or is prefixed with `gatewayFolder/` in scoped mode). Verify no off-by-one when comparing against `manifest.files[relPath]?.hash` after the first sync after F1.

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

1. **F3 (hash-skip verification)** — smoke-test the daemon now that F1 rebased the key shape. Low effort but high-value regression gate.
2. **F4 (Mac app settings panel)** — IPC scaffolding (`getConfig` / `setSyncPath` / `restart`) + SwiftUI form. Daemon IPC `status` already exposes the fields; F1/F2 menu-bar surfacing is live. Next step is a writable settings view.
3. **F6 (initial-pull concurrency + progress)** — currently 2k+ file initial pulls are sequential and noisy. Biggest UX complaint after F1/F2 land.
4. **F11 tail (daemon initial-pull test)** — F11 is partly done; still owe `packages/sync-client/tests/unit/initial-pull.test.ts` before refactoring the initial-pull loop.
5. Everything else is opportunistic.

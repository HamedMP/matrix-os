# Tasks: File Sync

**Input**: Design documents from `/specs/066-file-sync/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/sync-api.md, contracts/sync-ws.md, quickstart.md

**Tests**: Included (TDD is NON-NEGOTIABLE per constitution)

**Organization**: Tasks grouped by subsystem (user story), mapped to spec implementation phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US5)
- Exact file paths included in every task

## Path Conventions

- **Gateway extensions**: `packages/gateway/src/sync/`
- **Sync client (new)**: `packages/sync-client/src/`
- **Sync client tests**: `packages/sync-client/tests/`
- **Mac menu bar app**: `apps/menu-bar/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, new package scaffolding, shared dependencies

- [x] T001 Create `packages/sync-client/` directory with `package.json` (name: `@matrixos/sync-client`, type: module, dependencies: citty, chokidar, pino, pino-roll, node-diff3, zod, ws)
- [x] T002 Create `packages/sync-client/tsconfig.json` extending root config (strict, ES2024 target, NodeNext module)
- [x] T003 [P] Add dependencies to `packages/gateway/package.json`: `@aws-sdk/s3-request-presigner`, `node-diff3`
- [x] T004 [P] Create shared Zod schemas and TypeScript types in `packages/gateway/src/sync/types.ts` (ManifestSchema, ManifestEntrySchema, PeerInfoSchema, ConflictRecordSchema, SyncConfigSchema, LocalFileStateSchema, SyncStateSchema per data-model.md)
- [x] T005 [P] Create `packages/sync-client/src/lib/hash.ts` with SHA-256 file hashing utility (streaming hash via `crypto.createHash`, returns `sha256:${hex}` format)
- [x] T006 [P] Create `packages/sync-client/src/lib/syncignore.ts` with `.syncignore` parser (`.gitignore` syntax, default patterns from spec section 1)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database migrations, R2 client, path validation, route mounting, metrics -- MUST complete before any user story

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Create Postgres migration for `sync_manifests` table in `packages/gateway/src/sync/sharing-db.ts` (Kysely table definition per data-model.md: user_id PK, version, file_count, total_size, etag, updated_at) -- migration auto-runs on gateway boot via `migrateSyncTables()`
- [x] T008 Create Postgres migration for `sync_shares` table in `packages/gateway/src/sync/sharing-db.ts` (Kysely table definition per data-model.md: UUID PK, owner_id, path, grantee_id, role enum, accepted, created_at, expires_at, UNIQUE constraint, CHECK owner != grantee)
- [x] T009 [P] Create R2 S3 client factory in `packages/gateway/src/sync/r2-client.ts` (S3Client with region "auto", R2 endpoint from env, presigned URL generation for GET and PUT using `@aws-sdk/s3-request-presigner`, `AbortSignal.timeout(10_000)` on all operations) -- supports MinIO via `endpoint`/`publicEndpoint`/`forcePathStyle`
- [x] T010 [P] Create path validation utility `resolveWithinPrefix` in `packages/gateway/src/sync/path-validation.ts` (validate relative paths, reject `..` segments, reject leading `/`, max 1024 chars, resolve within `matrixos-sync/{userId}/files/`)
- [x] T011 [P] Register Prometheus metrics in `packages/gateway/src/sync/metrics.ts` (sync_files_synced_total counter, sync_presign_requests_total counter, sync_presign_duration_seconds histogram, sync_commit_duration_seconds histogram, sync_conflicts_total counter, sync_manifest_entries gauge, sync_manifest_bytes gauge, sync_connected_peers gauge -- per spec section 2)
- [x] T012 Add `sync:subscribe` to `MainWsClientMessageSchema` discriminated union in `packages/gateway/src/ws-message-schema.ts` (peerId, hostname, platform, clientVersion fields per contracts/sync-ws.md)
- [x] T013 Mount sync routes at `/api/sync` in `packages/gateway/src/server.ts` (import from `sync/routes.ts`, apply `authMiddleware`, apply `bodyLimit({ maxSize: 65536 })` on mutating endpoints) -- `createSyncRoutes(deps)` now wired with R2/MinIO client, ManifestDb, PeerRegistry, and SharingService; `sync:subscribe` WS handler registered (2026-04-18)

**Checkpoint**: Foundation ready -- user story implementation can now begin

---

## Phase 3: User Story 1 -- Sync Engine Core (Priority: P1) MVP

**Goal**: Complete gateway-side sync API: manifest read/write with Postgres-backed concurrency, presigned URL generation, commit flow, conflict detection + 3-way merge, WebSocket event broadcasting. A client can upload/download files to R2 via presigned URLs and receive real-time notifications.

**Independent Test**: Call `POST /api/sync/presign` to get upload URLs, upload a file to R2, call `POST /api/sync/commit`, verify manifest updated. Connect a second WS client, verify it receives `sync:change`. Trigger a conflict, verify 3-way merge or conflict copy.

### Tests for US1

> Write these tests FIRST, ensure they FAIL before implementation

- [x] T014 [P] [US1] Unit tests for manifest read/write/merge in `tests/gateway/sync/manifest.test.ts` (read from R2, write with version increment, optimistic concurrency rejection on version mismatch, Postgres advisory lock behavior, file count/size tracking)
- [x] T015 [P] [US1] Unit tests for presigned URL generation in `tests/gateway/sync/presign.test.ts` (PUT URL for upload, GET URL for download, path validation rejects traversal, batch up to 100, reject >100MB without multipart, 15-min expiry)
- [x] T016 [P] [US1] Unit tests for commit flow in `tests/gateway/sync/commit.test.ts` (update manifest entries, version conflict returns 409, broadcast sync:change after commit, tombstone on delete action, file count limits at 50K)
- [x] T017 [P] [US1] Unit tests for conflict detection + 3-way merge in `tests/gateway/sync/conflict.test.ts` (detect conflict when both sides changed, auto-merge text files with node-diff3, create conflict copy for binary files, conflict copy naming convention, delete-edit conflict resolves in favor of edit)
- [x] T018 [P] [US1] Unit tests for WebSocket event broadcasting in `tests/gateway/sync/ws-events.test.ts` (sync:change broadcast to other peers only, sync:conflict sent to affected peer, sync:peer-join/leave on subscribe/disconnect, peer map bounded at 100 with LRU eviction)

### Implementation for US1

- [x] T019 [US1] Implement manifest service in `packages/gateway/src/sync/manifest.ts` (readManifest: fetch from R2 with ETag caching, writeManifest: Postgres advisory lock + version check + R2 write + version increment, applyChanges: update/add/delete entries, tombstone handling with 30-day GC, entry count enforcement soft 8K/hard 50K)
- [x] T020 [US1] Implement presigned URL service in `packages/gateway/src/sync/presign.ts` (generatePresignedUrls: batch up to 100, PUT for upload, GET for download, scoped to `matrixos-sync/{userId}/files/{path}`, 900s expiry, validate all paths with resolveWithinPrefix, AbortSignal.timeout(30_000) for large batches)
- [x] T021 [US1] Implement conflict detection + 3-way merge in `packages/gateway/src/sync/conflict.ts` (detectConflict: compare local hash vs manifest hash vs lastSyncedHash, mergeText: fetch base from R2 + diff3Merge from node-diff3, createConflictCopy: `filename (conflict - peerId - YYYY-MM-DD).ext`, isTextFile: check against extension allowlist from spec)
- [x] T022 [US1] Implement WebSocket sync event broadcasting in `packages/gateway/src/sync/ws-events.ts` (handleSyncSubscribe: register peer in bounded Map per user max 100, broadcastSyncChange: send to all peers except sender, broadcastSyncConflict: send to affected peer, handlePeerDisconnect: remove from map + broadcast sync:peer-leave, export ServerMessage types for sync events per contracts/sync-ws.md) -- now wired into main gateway WS handler in server.ts (2026-04-18)
- [x] T023 [US1] Implement sync REST routes in `packages/gateway/src/sync/routes.ts` (GET /manifest with ETag/304, POST /presign with PresignRequestSchema validation, POST /commit with CommitRequestSchema + optimistic concurrency, GET /status with peer count + manifest stats + conflict count, POST /resolve-conflict with ResolveConflictSchema -- all per contracts/sync-api.md, rate limit presign at 100 req/min per user) -- `createSyncRoutes()` now actually mounted in server.ts with real R2/MinIO + Postgres dependencies (2026-04-18)

**Checkpoint**: Gateway sync API is functional. Can be tested with curl/httpie against running gateway. Upload via presigned URL, commit, see manifest update, receive WS events.

---

## Phase 4: User Story 2 -- CLI + Local Daemon (Priority: P2)

**Goal**: `matrixos` CLI with `login`, `sync`, `sync status`, `sync pause/resume`, `peers` commands. Background daemon with chokidar file watching, sync engine (hash-compare-upload/download), WebSocket client for real-time notifications, manifest cache, and Unix socket IPC for CLI-daemon communication.

**Independent Test**: Run `matrixos login` (OAuth flow), `matrixos sync ~/matrixos` (starts daemon), create a file locally, verify it uploads to R2 via gateway. Run `matrixos sync status` to see file count and connected peers.

**Depends on**: Phase 3 (US1) -- gateway sync API must exist

### Tests for US2

- [x] T024 [P] [US2] Unit tests for SHA-256 file hashing in `packages/sync-client/tests/unit/hash.test.ts` (streaming hash of small file, large file, returns sha256: prefix format, handles missing file gracefully)
- [x] T025 [P] [US2] Unit tests for syncignore parsing in `packages/sync-client/tests/unit/syncignore.test.ts` (parse default patterns, glob matching, negation patterns, directory patterns with trailing slash, comment lines)
- [x] T026 [P] [US2] Unit tests for manifest cache in `packages/sync-client/tests/unit/manifest-cache.test.ts` (load/save to ~/.matrixos/sync-state.json, compare local vs remote manifest, detect local-newer/remote-newer/conflict/deleted, version tracking)
- [x] T027 [P] [US2] Unit tests for client-side conflict resolver in `packages/sync-client/tests/unit/conflict-resolver.test.ts` (text file 3-way merge, binary conflict copy creation, conflict copy naming convention, delete-edit resolution)
- [x] T028 [P] [US2] Unit tests for sync engine in `packages/sync-client/tests/unit/sync-engine.test.ts` (detect local changes via hash comparison, queue upload for local-newer files, queue download for remote-newer files, detect conflict state, skip ignored files, batch presign requests up to 100)
- [x] T029 [P] [US2] Integration tests for full sync cycle in `packages/sync-client/tests/integration/e2e-sync.test.ts` (daemon detects file create -> presign -> upload -> commit -> WS notification to second client, daemon receives sync:change -> presign GET -> download -> write locally)

### Implementation for US2

- [~] T030 [US2] Implement OAuth device flow in `packages/sync-client/src/auth/oauth.ts` (generate device code, open browser to matrix-os.com, poll for token, handle timeout/denial) -- **CLIENT SIDE ONLY**: file exists but server-side endpoints `/api/auth/device/code` and `/api/auth/device/token` were never implemented. `matrixos login` returns HTTP 404. See **Phase 9** for the platform-side implementation that closes this gap.
- [x] T031 [US2] Implement token store in `packages/sync-client/src/auth/token-store.ts` (read/write ~/.matrixos/auth.json with 0600 permissions, JWT + refresh token storage, auto-refresh on expiry, validate token structure)
- [x] T032 [US2] Implement config manager in `packages/sync-client/src/lib/config.ts` (read/write ~/.matrixos/config.json, SyncConfigSchema validation, default values: syncPath ~/matrixos/, gatewayUrl from env)
- [x] T033 [US2] Implement manifest cache in `packages/sync-client/src/daemon/manifest-cache.ts` (load/save sync-state.json, track manifestVersion + lastSyncAt + per-file LocalFileState, diff against remote manifest to determine sync actions)
- [x] T034 [US2] Implement WebSocket client in `packages/sync-client/src/daemon/ws-client.ts` (connect to gateway WS, send sync:subscribe on connect, handle sync:change/sync:conflict/sync:peer-join/sync:peer-leave events, auto-reconnect with exponential backoff, auth via Bearer token)
- [x] T035 [US2] Implement R2 presigned upload/download client in `packages/sync-client/src/daemon/r2-client.ts` (upload file via presigned PUT URL, download file via presigned GET URL, parallel batch processing, AbortSignal.timeout per file, retry with backoff on transient failures)
- [x] T036 [US2] Implement chokidar file watcher in `packages/sync-client/src/daemon/watcher.ts` (watch sync folder with chokidar v4, debounce rapid changes per file 500ms, filter through syncignore + selective sync config, emit add/change/unlink events to sync engine)
- [x] T037 [US2] Implement client-side conflict resolver in `packages/sync-client/src/daemon/conflict-resolver.ts` (isTextFile check, 3-way merge using node-diff3 for text files, conflict copy creation for binary files, notify via sync:conflict event)
- [x] T038 [US2] Implement core sync engine in `packages/sync-client/src/daemon/sync-engine.ts` (on local change: hash -> compare with manifest cache -> presign -> upload -> commit, on remote change: presign GET -> download -> write locally -> update cache, on reconnect: full manifest diff reconciliation, batch operations, conflict detection delegation)
- [x] T039 [US2] Implement IPC server in `packages/sync-client/src/daemon/ipc-server.ts` (Unix socket at ~/.matrixos/daemon.sock, newline-delimited JSON protocol, handle status/pause/resume/peers commands from CLI, PID file at ~/.matrixos/daemon.pid)
- [x] T040 [US2] Implement daemon entry point in `packages/sync-client/src/daemon/index.ts` (initialize pino logger with pino-roll rotation 10MB/5 files to ~/.matrixos/logs/sync.log, start IPC server, start WS client, start file watcher, initial sync: fetch manifest -> download all files -> begin watching, graceful shutdown on SIGTERM/SIGINT)
- [x] T041 [US2] Implement launchd/systemd service file generation in `packages/sync-client/src/daemon/service.ts` (macOS: write plist to ~/Library/LaunchAgents/com.matrixos.sync.plist with KeepAlive, Linux: write unit to ~/.config/systemd/user/matrixos-sync.service with Restart=on-failure, start/stop/enable commands)
- [x] T042 [US2] Implement CLI entry point with citty in `packages/sync-client/src/cli/index.ts` (main command: matrixos, subcommands: login, logout, sync, peers, keys, ssh)
- [~] T043 [P] [US2] Implement `matrixos login` command in `packages/sync-client/src/cli/commands/login.ts` (invoke OAuth device flow, store token, print success) -- file exists but fails at runtime; needs Phase 9 server endpoints. Workaround: stub `~/.matrixos/auth.json` per `docs/dev/sync-testing.md`.
- [x] T044 [P] [US2] Implement `matrixos logout` command in `packages/sync-client/src/cli/commands/logout.ts` (clear auth.json, stop daemon if running)
- [x] T045 [US2] Implement `matrixos sync` command in `packages/sync-client/src/cli/commands/sync.ts` (positional path arg default ~/matrixos, subcommands: status/pause/resume, start daemon or send IPC command, write service file + enable on first run) -- citty subcommand routing fix applied (parent `run` guards against subcommand names)
- [x] T046 [P] [US2] Implement `matrixos peers` command in `packages/sync-client/src/cli/commands/peers.ts` (IPC query to daemon or GET /api/sync/status, display peer list with hostname/platform/connected time)
- [x] T047 [US2] Implement daemon IPC client in `packages/sync-client/src/cli/daemon-client.ts` (connect to Unix socket, send JSON command, read JSON response, detect if daemon is running via PID file)

**Checkpoint**: Full local sync works. Create a file -> daemon uploads to R2 -> second daemon downloads it. CLI shows sync status and peers.

---

## Phase 5: User Story 3 -- Sharing & Collaboration (Priority: P3)

**Goal**: Folder-level sharing with role-based access control (viewer/editor/admin). Owner shares a folder path, grantee accepts and syncs the shared subtree. Scoped R2 tokens per share. Revocation with real-time notification.

**Independent Test**: Owner runs `matrixos share projects/startup/ @colleague:matrix-os.com --role editor`. Colleague receives share-invite WS event, accepts via `POST /api/sync/share/accept`. Colleague's daemon syncs the shared folder. Owner revokes, colleague's daemon stops syncing.

**Depends on**: Phase 3 (US1) + Phase 4 (US2)

### Tests for US3

- [x] T048 [P] [US3] Unit tests for sharing CRUD in `tests/gateway/sync/sharing.test.ts` (create share, accept share, revoke share, list shares, reject self-share, enforce UNIQUE constraint, check expiry, role enforcement for presign/commit)
- [x] T049 [P] [US3] Contract tests for sharing endpoints in `tests/gateway/sync/routes.test.ts` (POST /share returns 201, POST /share/accept returns 200, DELETE /share revokes + sends WS event, GET /shares lists owned and received, 403 on insufficient role, 404 on unknown grantee, 409 on duplicate share)

### Implementation for US3

- [x] T050 [US3] Implement sharing service in `packages/gateway/src/sync/sharing.ts` (createShare: insert into sync_shares + generate scoped R2 token + broadcast sync:share-invite WS event, acceptShare: update accepted=true, revokeShare: delete row + invalidate token + broadcast sync:access-revoked, listShares: query owned + received, checkSharePermission: validate grantee has required role for path)
- [x] T051 [US3] Implement sharing REST routes in `packages/gateway/src/sync/routes.ts` (add POST /share, DELETE /share, POST /share/accept, GET /shares routes -- all per contracts/sync-api.md, integrate checkSharePermission into presign/commit routes for shared path access)
- [ ] T052 [US3] Implement `matrixos share` command in `packages/sync-client/src/cli/commands/share.ts` (positional path + handle args, --role flag default editor, call POST /api/sync/share) -- **NOT STARTED**: file does not exist
- [ ] T053 [US3] Implement `matrixos unshare` command in `packages/sync-client/src/cli/commands/share.ts` (positional path + handle args, call DELETE /api/sync/share) -- **NOT STARTED**
- [ ] T054 [US3] Handle share events in daemon in `packages/sync-client/src/daemon/sync-engine.ts` (on sync:share-invite: prompt user or auto-accept per config, add shared folder to sync tree at ~/matrixos/shared/{owner}/{path}/, on sync:access-revoked: stop syncing shared folder, keep local copy) -- **NOT STARTED**: daemon doesn't handle share WS events yet

**Checkpoint**: Sharing works end-to-end. Share a folder, colleague syncs it, edits propagate bidirectionally, revocation stops sync.

---

## Phase 6: User Story 4 -- Remote Access / SSH (Priority: P4)

**Goal**: SSH into cloud Matrix OS instances. SSH key management via CLI. Shared tmux sessions between web terminal and SSH.

**Independent Test**: Run `matrixos keys add ~/.ssh/id_ed25519.pub`, then `matrixos ssh` connects to cloud instance. Open web shell, start tmux -- SSH session attaches to same tmux.

**Depends on**: Phase 4 (US2) for auth

### Tests for US4

- [x] T055 [P] [US4] Unit tests for SSH key management in `packages/sync-client/tests/unit/keys.test.ts` (parse public key, validate key format, write to ~/system/authorized_keys, reject invalid keys)

### Implementation for US4

- [x] T056 [US4] Implement `matrixos keys add` command in `packages/sync-client/src/cli/commands/keys.ts` (read public key file, validate format, POST to gateway or write to ~/system/authorized_keys via sync)
- [x] T057 [US4] Implement `matrixos ssh` command in `packages/sync-client/src/cli/commands/ssh.ts` (resolve handle to container host:port via platform API, spawn ssh process to ssh.matrix-os.com:2222, pass through stdio, optional handle argument for shared instances)
- [x] T058 [US4] Document container-side sshd setup in `specs/066-file-sync/ssh-setup.md` (OpenSSH config for port 2222, authorized_keys sync from ~/system/authorized_keys, tmux auto-attach, platform proxy routing)

**Checkpoint**: SSH into cloud instance works. Keys managed via CLI. tmux sessions shared.

---

## Phase 7: User Story 5 -- Mac Menu Bar App (Priority: P5)

**Goal**: Native macOS SwiftUI menu bar app showing sync status, recent activity, pending conflicts, share invitations. Communicates with the TypeScript daemon via local HTTP or Unix socket.

**Independent Test**: Start daemon, open menu bar app. Tray icon shows sync status. Activity feed shows recent file changes. Trigger a conflict, see it in the dropdown.

**Depends on**: Phase 4 (US2) -- daemon must exist

### Implementation for US5

- [x] T059 [US5] Create Xcode project at `packages/sync-client/macos/MatrixSync.xcodeproj` with SwiftUI lifecycle, menu bar extra target -- relocated from `apps/menu-bar/` per repo layout
- [x] T060 [US5] Implement daemon communication client in `packages/sync-client/macos/MatrixSync/SyncStatusModel.swift` (connect to ~/.matrixos/daemon.sock via Unix socket, send status/pause/resume queries, parse JSON responses) -- combined with status model
- [x] T061 [US5] Implement menu bar tray icon in `packages/sync-client/macos/MatrixSync/MatrixSyncApp.swift` (MenuBarExtra with dynamic SF Symbol: arrow.triangle.2.circlepath.circle for paused, .fill for syncing, checkmark.circle.fill for synced, dashed circle for daemon-down)
- [x] T062 [US5] Implement dropdown menu view in `packages/sync-client/macos/MatrixSync/MenuBarView.swift` (sync status, file count, manifest version, last-sync relative timestamp, pause/resume button, refresh + quit) -- activity feed, conflicts, share invites NOT yet shown (deferred to follow-up)
- [ ] T063 [US5] Implement macOS Notification Center integration in `packages/sync-client/macos/MatrixSync/NotificationManager.swift` (post notifications for share invites and conflicts, UNUserNotificationCenter) -- **NOT STARTED**

**Checkpoint**: Menu bar app shows real-time sync status, activity, and conflicts. Quick actions work.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, documentation, observability, and cross-cutting improvements

- [~] T064 [P] Tombstone garbage collection: function `garbageCollectTombstones()` in `packages/gateway/src/sync/manifest.ts` exists and is tested -- but the **scheduled job** that calls it on an interval is NOT wired into gateway startup. Needs: cron entry or `setInterval` in `server.ts` that runs daily.
- [x] T065 [P] Manifest entry count warnings: client-side `detectChanges()` returns warnings at 8K and 50K thresholds (`packages/sync-client/src/daemon/sync-engine.ts`). Server-side `sync:warning` WS event emission still pending wiring.
- [x] T066 [P] Multipart upload support in `packages/gateway/src/sync/r2-client.ts` for files 100MB-1GB (CreateMultipartUploadCommand + per-part presigned URLs) -- functions exist; client-side use-when-needed logic in daemon still pending
- [x] T067 [P] Rate limiting middleware for presign endpoint (100 req/min per user) in `packages/gateway/src/sync/rate-limiter.ts` + integrated in `routes.ts`
- [x] T068 Run quickstart.md validation: test full dev setup flow per `docs/dev/sync-testing.md` -- end-to-end upload/commit/download cycle verified against MinIO + Postgres on 2026-04-18
- [x] T069 End-to-end smoke test: two-peer sync cycle with conflict resolution in `packages/sync-client/tests/integration/e2e-sync.test.ts`
- [~] T070 Security audit: path validation on all endpoints (done), error leakage check (done -- no provider names exposed), scoped R2 tokens (done -- per-user prefix), body limits (done -- 64KB on mutating endpoints), timeouts (done -- 10s on R2 ops). **Pending**: penetration test, SSRF check on presigned URLs, formal review writeup

---

## Phase 9: OAuth Device Flow on Platform (Follow-up)

**Status**: NOT STARTED -- discovered as a real spec gap during initial wiring (2026-04-18). Client side (`packages/sync-client/src/auth/oauth.ts`) was built in T030 but the matching server endpoints were never added. CLI `matrixos login` currently fails with HTTP 404 against `/api/auth/device/code`.

**Goal**: Implement OAuth 2.0 Device Authorization Grant (RFC 8628) on the **platform** service (`packages/platform/`), not the gateway. The platform owns cross-user identity via Clerk; per-user gateways are single-tenant and shouldn't know about cross-user OAuth.

**Independent test**: `matrixos login` → opens browser → user signs into Clerk → CLI receives token → daemon authenticates against the user's gateway with that token. No more stub `auth.json` needed.

**Depends on**: Phase 4 (US2) -- the client-side OAuth code already exists.

### Architecture Decision

Three actors:

1. **CLI (sync-client)** -- runs `matrixos login`, polls for token
2. **Platform (`packages/platform/`, port 9000)** -- owns Clerk integration, issues device codes, exchanges them for tokens, knows user→gateway routing
3. **Gateway (per-user, port 4000)** -- accepts the token issued by the platform

Token format: signed JWT issued by the platform with `{sub: clerkUserId, handle, gatewayUrl, iat, exp}`. Gateway validates against the platform's public key (or shared secret in dev).

The platform already has Clerk wired (`packages/platform/src/clerk-auth.ts`) and a Drizzle schema with `clerkUserId` → container mapping. We extend that schema with a `device_codes` table.

### Tests for Phase 9

- [x] T071 [P] Unit tests for device code generation in `packages/platform/tests/unit/device-flow.test.ts` (generate user_code as 8-char A-Z2-9 -- excluding I/O/0/1, generate device_code as 32-byte base64url, expiresIn=900s, interval=5s, polling rate-limit 1 req per 5s per device_code, slow_down response on too-fast polling)
- [x] T072 [P] Integration tests for device endpoints in `packages/platform/tests/integration/device-routes.test.ts` (POST /api/auth/device/code returns codes, POST /api/auth/device/token returns 428 authorization_pending before user approval, returns 200 with JWT after approval, returns 410 expired_token after expiresIn, returns 429 slow_down on rapid polling)
- [x] T073 [P] Unit tests for JWT issuance/validation in `packages/platform/tests/unit/sync-jwt.test.ts` (issue with claims, validate signature, reject expired, reject wrong-issuer, reject tampered payload)
- [x] T074 [P] Contract test for gateway accepting platform-issued JWTs in `tests/gateway/auth-jwt.test.ts` (gateway accepts valid JWT, rejects expired, rejects unknown signer, falls back to bearer token if MATRIX_AUTH_TOKEN is set)
- [x] T075 [P] Update sync-client OAuth tests in `packages/sync-client/tests/unit/oauth.test.ts` (poll respects retry interval, handles slow_down, handles expired_token, stores returned JWT correctly)

### Implementation for Phase 9

#### Platform service (`packages/platform/`)

- [x] T076 Drizzle schema: add `device_codes` table to `packages/platform/src/schema.ts` with columns `device_code` (PK, text), `user_code` (text, unique), `clerk_user_id` (nullable, set on approval), `expires_at` (timestamptz), `last_polled_at` (nullable timestamptz), `created_at`. Index on `user_code`.
- [x] T077 Migration script: add migration in `packages/platform/src/db.ts` (or wherever the existing schema is bootstrapped) to create `device_codes` table on platform startup.
- [x] T078 Device flow service in `packages/platform/src/device-flow.ts`: `createDeviceCode()`, `pollDeviceCode(deviceCode)` returning `{status: "pending"|"slow_down"|"approved"|"expired", token?}`, `approveDeviceCode(userCode, clerkUserId)`. Generate user_code from RFC 8628 alphabet `BCDFGHJKLMNPQRSTVWXZ` (no vowels, no ambiguous chars).
- [x] T079 JWT issuer in `packages/platform/src/sync-jwt.ts`: `issueSyncJwt({clerkUserId, handle, gatewayUrl})` using `jose` (already in repo) signing with `PLATFORM_JWT_SECRET` env var (HS256 in dev, prep for RS256 swap). 30-day expiry. Claims: `sub`, `handle`, `gateway_url`, `iat`, `exp`, `iss: "matrix-os-platform"`.
- [x] T080 REST endpoints in `packages/platform/src/main.ts` (or new `packages/platform/src/auth-routes.ts`):
  - `POST /api/auth/device/code` (public) -- accepts `{clientId}`, returns `{deviceCode, userCode, verificationUri, expiresIn, interval}`. `verificationUri` = `${PLATFORM_URL}/auth/device?user_code=${userCode}`.
  - `POST /api/auth/device/token` (public) -- accepts `{deviceCode, clientId}`, returns 428 `authorization_pending`, 429 `slow_down`, 410 `expired_token`, or 200 `{accessToken, expiresAt, userId, handle}`.
  - `bodyLimit({maxSize: 4096})` on both. Rate limit: 100 req/min per IP.
- [x] T081 Approval page in `packages/platform/src/main.ts`: `GET /auth/device?user_code=ABCD-1234` returns minimal HTML with Clerk SignIn widget. After Clerk auth, page POSTs `{userCode}` to `POST /auth/device/approve` (Clerk-protected -- uses existing `clerkAuth.requireUser()` middleware), which calls `approveDeviceCode(userCode, clerkUserId)` and renders a "Login successful, return to your terminal" message.
- [x] T082 [P] Wire `POST /auth/device/approve` route + Clerk middleware in `packages/platform/src/main.ts` (uses existing `createClerkAuth` -- no new auth code needed).

#### Gateway (per-user, accepts platform-issued JWTs)

- [x] T083 JWT validator in `packages/gateway/src/auth-jwt.ts`: `validateSyncJwt(token, {publicKey, expectedHandle})`. Uses same `jose` library. Verifies signature, expiry, `iss: "matrix-os-platform"`, and `handle` claim matches `MATRIX_HANDLE` env var (so a token issued for @alice cannot be used against @bob's gateway).
- [x] T084 Update `packages/gateway/src/auth.ts` middleware: if `Authorization: Bearer <jwt>` looks like a JWT (3 base64 segments separated by `.`), validate via `validateSyncJwt`. Otherwise fall back to existing `MATRIX_AUTH_TOKEN` shared-secret check. Both paths can coexist -- shared secret for service-to-service, JWT for user CLI/Mac app.
- [x] T085 Add `PLATFORM_JWT_PUBLIC_KEY` env var support to gateway. In dev with HS256, set `PLATFORM_JWT_SECRET` on both platform and gateway (same value). In prod with RS256, gateway gets the platform's public key.
- [x] T086 Update gateway docs: `docs/dev/docker-development.md` env var table -- add `PLATFORM_JWT_SECRET` (dev) / `PLATFORM_JWT_PUBLIC_KEY` (prod).

#### Sync client (CLI)

- [x] T087 Update `packages/sync-client/src/auth/oauth.ts` to use `${platformUrl}` (not `${gatewayUrl}`). Today the OAuth client passes `config.gatewayUrl` as `platformUrl` -- they happen to be different concepts. Add a `platformUrl` field to `SyncConfig` and default it to `https://platform.matrix-os.com` (prod) or `http://localhost:9000` (dev).
- [x] T088 Update `packages/sync-client/src/lib/config.ts`: add `platformUrl` to `SyncConfigSchema` (required url), update `defaultSyncPath()` and config bootstrap.
- [x] T089 Update `packages/sync-client/src/cli/commands/login.ts`: read `platformUrl` from config (with sensible default), call `login({platformUrl, clientId: "matrixos-cli"})`. After successful login, call `GET ${platformUrl}/api/me` to fetch the user's `gatewayUrl` and persist it to config.
- [x] T090 Add `matrixos login --dev` shortcut in `packages/sync-client/src/cli/commands/login.ts`: when `--dev` is passed, skip the device flow entirely and write a stub `auth.json` with `accessToken: "dev-token"`. Documented as dev-only; gateway in dev mode (no `MATRIX_AUTH_TOKEN`) accepts any token.

#### Documentation

- [x] T091 Update `docs/dev/sync-testing.md`: replace the "stub auth file" workaround with `matrixos login --dev` once T090 lands. Document `matrixos login` for production use.
- [x] T092 Update `specs/066-file-sync/contracts/`: add `auth-api.md` documenting `POST /api/auth/device/code`, `POST /api/auth/device/token`, `POST /auth/device/approve` request/response/error formats per RFC 8628.

**Checkpoint**: `matrixos login` opens a browser, user signs into Clerk, CLI receives a JWT, daemon connects to gateway with that JWT, sync works end-to-end without any manual auth file editing.

### Phase 9 Dependencies

```
T076 (schema) → T077 (migration) → T078 (service) → T080 (REST endpoints)
                                 → T079 (JWT issuer) → T080
T078 → T081 (approval page) → T082 (approve route)
T079 → T083 (gateway JWT validator) → T084 (gateway middleware)
T080 → T087 (CLI uses platformUrl) → T088 (config schema) → T089 (login flow)
T080 → T090 (--dev shortcut, can be done in parallel)
All implementation → T091, T092 (docs)
```

### Phase 9 Open Questions to Resolve First

Before starting T076, decide:

1. **Where does the gateway URL come from for the user?** Platform must know `clerkUserId → gatewayUrl` mapping. Options: (a) embedded in JWT claim, (b) fetched via `GET /api/me` after login. Spec recommends (b) so users can have multiple gateways (laptop dev gateway vs. cloud production gateway).

2. **JWT key strategy**: HS256 with shared secret (simpler, both services trust each other) or RS256 with public/private key pair (better isolation, lets gateway validate offline)? Spec recommends HS256 for Phase 9, RS256 in a follow-up.

3. **Token revocation**: device tokens get a 30-day expiry. Do we need explicit revocation? Spec recommends NO for Phase 9 -- short-lived tokens + Clerk session revocation cascades are good enough.

4. **CSRF on `/auth/device/approve`**: the user-code form needs CSRF protection since it's a state-changing GET-then-POST flow. Use Clerk's built-in CSRF token from the SignIn widget, or add a hidden input + cookie pair?

---

## Phase 10: Three-Way Sync (Container ↔ R2 ↔ Peer) (in flight)

**Status**: Implementation landed 2026-04-18; rough edges and missing pieces tracked in `specs/066-file-sync/follow-ups.md`. The container-side `home-mirror` watches `/home/matrixos/home/` and pushes to R2; the local daemon now does an initial pull. End-to-end "I see my container files locally" is one fix away (F1 below).

**Architecture**: gateway (in container) runs `createHomeMirror()` from `packages/gateway/src/sync/home-mirror.ts` behind `MATRIX_HOME_MIRROR=true` (default on in dev). It uses the same R2 + Postgres manifest store the existing `/api/sync/*` routes use, so two storage layers are no longer separate.

### Done in Phase 10

- [x] T093 Container home mirror service in `packages/gateway/src/sync/home-mirror.ts` (chokidar watcher, internal manifest+R2 writes, serial commit chain, `recentlyWritten` suppression for round-trip avoidance, default ignore list for node_modules/.git/.next/.env*)
- [x] T094 Wire home mirror into `packages/gateway/src/server.ts` startup behind `MATRIX_HOME_MIRROR` env flag
- [x] T095 Add initial-pull pass to local daemon in `packages/sync-client/src/daemon/index.ts` (walk remote manifest → presign GET → write each file, skip files with matching local hash)
- [x] T096 Serialize daemon onEvent + WS handler via promise chain to avoid optimistic-concurrency races
- [x] T097 Daemon launcher `packages/sync-client/src/daemon/launcher.mjs` so launchd/systemd can run `.ts` daemon entry via `node --import tsx`
- [x] T098 launchd plist `WorkingDirectory` so the spawned daemon can resolve `tsx` from the repo
- [x] T099 `matrix sync` skip launchctl bounce when daemon already running on same path
- [x] T100 Mac menu bar `IPCResponse` envelope decoder so `{result: ...}` from the daemon parses correctly
- [x] T101 `matrix` bin alias + `bin/matrixos.mjs` launcher (re-execs node with `--import tsx` so pnpm-link works)
- [x] T102 `matrix` top-level CLI auto-loads JWT from `~/.matrixos/auth.json` (no need for `--token` on `matrix status`)
- [x] T103 `matrix login --dev` writes localhost `gatewayUrl`/`platformUrl` so the daemon points at the local docker stack on first run

### NOT STARTED in Phase 10

- [x] T104 [P0] Replace basename-as-prefix heuristic with explicit `gatewayFolder` config field. Extracted `packages/sync-client/src/daemon/remote-prefix.ts`; wired into daemon, `matrix sync --folder`, and `matrix login --dev` defaults. Empty = full mirror, non-empty = scoped subtree. Closes F1.
- [x] T105 [P0] Container-side WS subscriber in `home-mirror.ts` via virtual peer on `PeerRegistry`. Mirror registers a shim `SyncPeerConnection` whose `send()` pulls files on `sync:change` broadcasts (or deletes on action=delete); `recentlyWritten` suppresses the chokidar echo. Closes F2.
- [x] T106 [P1] Mac menu bar Settings view (`SettingsView.swift`) with identity (peer/gateway URL, Log Out), sync folder (text field + NSOpenPanel picker + Reveal in Finder), gateway scope (text field with full-mirror explainer). Daemon IPC gained `getConfig`, `setSyncPath`, `setGatewayFolder`, `restart`, `logout`. Opened via SettingsLink + ⌘,. Closes F4.
- [ ] T107 [P1] Per-target config dir support via `MATRIXOS_CONFIG_DIR` so users can run multiple daemons (one per folder) without colliding on `~/.matrixos/{config,sock,pid}` -- F7.
- [ ] T108 [P1] Initial-pull concurrency limit + progress aggregation; `.syncignore` filter on local side -- F6.
- [ ] T109 [P2] Self-heal stale manifest entries when R2 objects are missing (logs `pull failed: NoSuchKey` after a bucket reset) -- F8.
- [ ] T110 [P2] Audit + extend ignore list for known-secret filenames (`.credentials.json`, `*.pem`, `id_rsa*`); add `.syncignore` parsing in the gateway -- F9.
- [ ] T111 [P2] Wire conflict detection (existing `node-diff3` infra in `sync/conflict.ts`) into the home-mirror and daemon commit paths -- F10.
- [~] T112 [P2] Tests for home-mirror, initial-pull, and the new prefix logic. DONE: `packages/sync-client/tests/unit/remote-prefix.test.ts` + `tests/gateway/sync/home-mirror.test.ts` (subscribe path, delete, ignored paths, no-echo). TODO: daemon initial-pull unit test in `packages/sync-client/tests/unit/initial-pull.test.ts` -- F11.
- [ ] T113 [P3] `matrix doctor` extended with sync diagnostics (daemon up?, last sync, peer count) -- F12.
- [ ] T114 [P3] `matrix logs [--follow]` pretty-prints the pino daemon log -- F13.
- [x] T115 [P3] Document the three-way architecture in `docs/dev/sync-testing.md` -- F14. Added "How Three-Way Sync Actually Works" section covering the three actors, `gatewayFolder` modes, echo-loop suppression, and `MATRIX_HOME_MIRROR`.

Full notes: `specs/066-file-sync/follow-ups.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies -- can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 -- BLOCKS all user stories
- **US1 Sync Engine (Phase 3)**: Depends on Phase 2
- **US2 CLI + Daemon (Phase 4)**: Depends on Phase 3 (needs gateway API)
- **US3 Sharing (Phase 5)**: Depends on Phase 3 + Phase 4
- **US4 Remote Access (Phase 6)**: Depends on Phase 4 (needs auth)
- **US5 Menu Bar App (Phase 7)**: Depends on Phase 4 (needs daemon)
- **Polish (Phase 8)**: Depends on Phase 3 minimum, ideally all phases

### User Story Dependencies

```
Phase 1: Setup
    |
Phase 2: Foundational
    |
Phase 3: US1 - Sync Engine Core (MVP)
    |
    +---> Phase 4: US2 - CLI + Daemon
    |         |
    |         +---> Phase 5: US3 - Sharing
    |         |
    |         +---> Phase 6: US4 - Remote Access (independent of US3)
    |         |
    |         +---> Phase 7: US5 - Menu Bar App (independent of US3/US4)
    |
Phase 8: Polish (after desired phases complete)
```

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD)
- Types/schemas before services
- Services before routes
- Core implementation before CLI commands
- Story complete before moving to next priority

### Parallel Opportunities

- Phase 1: T003, T004, T005, T006 can all run in parallel
- Phase 2: T009, T010, T011 can run in parallel (after T007/T008 migrations)
- Phase 3: All test tasks (T014-T018) can run in parallel, then implementation is sequential
- Phase 4: All test tasks (T024-T029) in parallel; T043, T044, T046 CLI commands in parallel
- Phase 5: Test tasks T048, T049 in parallel
- Phase 6: T056 and T057 can be partially parallel (different files)
- Phase 7: T060, T061, T062, T063 are somewhat sequential (app structure first)
- Phases 6 + 7 can run in parallel with each other (both depend on Phase 4 only)

---

## Parallel Example: US1 -- Sync Engine Core

```bash
# Launch all tests for US1 together (TDD: write failing tests first):
Task: T014 "Unit tests for manifest in packages/gateway/src/sync/__tests__/manifest.test.ts"
Task: T015 "Unit tests for presign in packages/gateway/src/sync/__tests__/presign.test.ts"
Task: T016 "Unit tests for commit in packages/gateway/src/sync/__tests__/commit.test.ts"
Task: T017 "Unit tests for conflict in packages/gateway/src/sync/__tests__/conflict.test.ts"
Task: T018 "Unit tests for WS events in packages/gateway/src/sync/__tests__/ws-events.test.ts"

# Then implement sequentially (each builds on previous):
Task: T019 "Manifest service" -> T020 "Presign service" -> T021 "Conflict detection" -> T022 "WS events" -> T023 "Routes"
```

## Parallel Example: US2 -- CLI + Daemon

```bash
# Launch all tests together:
Task: T024 "hash tests"
Task: T025 "syncignore tests"
Task: T026 "manifest cache tests"
Task: T027 "conflict resolver tests"
Task: T028 "sync engine tests"
Task: T029 "integration sync cycle tests"

# Then implement: auth first, then daemon internals, then CLI
# Auth (sequential):
Task: T030 "OAuth" -> T031 "Token store"

# Daemon internals (some parallel after auth):
Task: T032 "Config" -> T033 "Manifest cache" (parallel with T034, T035)
Task: T034 "WS client"
Task: T035 "R2 client"
# Then sequential: T036 "Watcher" -> T037 "Conflict resolver" -> T038 "Sync engine" -> T039 "IPC" -> T040 "Daemon entry"

# CLI commands (parallel after daemon):
Task: T042 "CLI entry" -> T043 "login" + T044 "logout" + T046 "peers" (parallel) -> T045 "sync" -> T047 "IPC client"
```

---

## Implementation Strategy

### MVP First (US1 Only -- Phase 3)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL -- blocks all stories)
3. Complete Phase 3: US1 -- Sync Engine Core
4. **STOP and VALIDATE**: Test gateway sync API with curl -- presign, upload to R2, commit, manifest update, WS events
5. This is testable without a CLI -- raw HTTP calls prove the engine works

### Incremental Delivery

1. Phase 1 + 2: Foundation ready
2. Phase 3 (US1): Gateway sync API works (MVP!)
3. Phase 4 (US2): CLI + daemon make it usable for real sync workflows
4. Phase 5 (US3): Sharing adds collaboration
5. Phase 6 (US4): SSH adds remote access
6. Phase 7 (US5): Menu bar app adds native macOS UX
7. Each phase adds value without breaking previous phases

### Parallel Team Strategy

With multiple agents:

1. All agents complete Phase 1 + 2 together (setup + foundation)
2. Once Phase 2 is done:
   - Agent A: US1 (gateway sync engine) -- MUST complete first
3. Once US1 is done:
   - Agent A: US2 (CLI + daemon)
   - Agent B: US3 tests (can write failing tests against US1 API)
4. Once US2 is done:
   - Agent A: US3 implementation
   - Agent B: US4 (remote access)
   - Agent C: US5 (menu bar app)

---

## Summary

| Phase | Done | Partial | Not Started | Total |
|-------|------|---------|-------------|-------|
| Phase 1: Setup | 6 | 0 | 0 | 6 |
| Phase 2: Foundational | 7 | 0 | 0 | 7 |
| Phase 3: US1 Sync Engine (P1 MVP) | 10 | 0 | 0 | 10 |
| Phase 4: US2 CLI + Daemon (P2) | 22 | 2 | 0 | 24 |
| Phase 5: US3 Sharing (P3) | 4 | 0 | 3 | 7 |
| Phase 6: US4 Remote Access (P4) | 4 | 0 | 0 | 4 |
| Phase 7: US5 Menu Bar App (P5) | 4 | 0 | 1 | 5 |
| Phase 8: Polish | 4 | 3 | 0 | 7 |
| Phase 9: OAuth Device Flow | 22 | 0 | 0 | 22 |
| Phase 10: Three-way sync (in flight) | 11 | 0 | 12 | 23 |
| **Total** | **94** | **5** | **16** | **115** |

**Status legend**: `[x]` done, `[~]` partial (notes inline), `[ ]` not started.

**Critical follow-ups for next session** (in priority order):

1. ~~**T104 (`gatewayFolder` plumbing)**~~ -- DONE (see `remote-prefix.ts`).
2. ~~**T105 (container WS subscriber)**~~ -- DONE (home-mirror virtual peer).
3. **T106 (Mac app settings panel)** -- folder picker, gateway URL display, log-out. Partially addressed: daemon IPC status already exposes the fields and MenuBarView renders them. Next step: writable settings view + new IPC commands (`getConfig` / `setSyncPath` / `restart`). See follow-ups F4.
4. **T112 tail** -- home-mirror tests landed; still owe `packages/sync-client/tests/unit/initial-pull.test.ts` for the daemon's initial-pull path.
5. **T052/T053 (share CLI)** -- gateway endpoints work; CLI commands missing.
6. **T054 (share events in daemon)** -- daemon ignores `sync:share-invite` and `sync:access-revoked` WS events.
7. **T064 (tombstone GC scheduler)** -- function exists but never called periodically.
8. **T063 (Mac app notifications)** -- menu bar app shows status but doesn't post Notification Center alerts.

## Notes

- [P] tasks = different files, no dependencies -- can run in parallel
- [Story] label maps task to specific user story for traceability
- TDD is NON-NEGOTIABLE: test tasks before implementation in each phase
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- R2 limitation: gateway owns all manifest writes (Postgres-backed concurrency)
- Max presigned URL batch: 100 per request
- Max file size: 1GB (multipart for 100MB-1GB is in Polish phase)

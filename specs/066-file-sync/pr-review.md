# PR 30 Review Tracker

**PR**: `#30` — `feat(066): PR 1 — file sync backend + identity + Cloudflare R2 wiring`
**Branch**: `066-file-sync`
**Status owner**: local worktree
**Last updated**: 2026-04-20

This file tracks the actionable review comments on PR 30 and their implementation
status in this worktree. Update the checkbox only when the code and covering test
for that item both exist locally.

## Legend

- `[ ]` open
- `[~]` in progress
- `[x]` resolved in worktree
- `[-]` declined / comment inaccurate (include rationale)

## Build / Wiring

- [x] `packages/gateway/src/sync/db-impl.ts` must be tracked by git so the `server.ts` import resolves on CI.
- [x] `R2ClientConfig` must support the `endpoint` / `publicEndpoint` / `forcePathStyle` fields used by `server.ts`, and reject invalid config.

## Sync Security / Data Integrity

- [x] Home-mirror must reject path traversal on remote pull writes.
- [x] Home-mirror must reject path traversal on remote pull deletes.
- [x] Manifest advisory locks must keep manifest metadata reads/writes on the locked transaction executor.
- [x] HTTP sync commits must sanitize `X-Peer-Id` before writing it into the manifest.
- [x] Share permission checks must use path-boundary matching, not raw `startsWith`.
- [x] Share permission checks must enforce `expires_at`.
- [x] Share creation must validate and normalize the stored shared path before DB insert.
- [x] `handleCommit()` must not delete file blobs before the new manifest is durably written.
- [x] Tombstone garbage collection must run from a real write path, not sit unused.
- [-] WebSocket `sync:subscribe` payloads must be schema-validated before peer registration. Already true in `server.ts`: `MainWsClientMessageSchema.safeParse(...)` runs before the `sync:subscribe` branch.
- [x] WebSocket peer lifecycle must unregister peers on socket close and stop reporting a permanent open `readyState`.
- [x] Peer registry must cap the outer user map, not only the per-user peer map.
- [x] `DELETE /api/sync/share` must use `bodyLimit` like the other mutating sync routes.
- [x] Sync Prometheus metrics must not use unbounded `user_id` labels.
- [x] Home-mirror delete cleanup paths must log failures instead of silently swallowing them.

## Platform / Auth Security

- [x] Platform admin middleware must fail closed when `PLATFORM_SECRET` is unset.
- [x] Platform admin bearer-token comparison must be constant-time.
- [x] `/containers/provision` must validate `handle` before it reaches Docker bind mounts.
- [x] `/containers/:handle/start|stop|upgrade|self-upgrade|DELETE` must validate `handle` before it reaches orchestrator or token derivation.
- [x] Device-flow rate limiting must stop trusting spoofable `X-Forwarded-For`.
- [x] Platform proxy fetches must use `AbortSignal.timeout(...)`.
- [x] Platform admin/container routes must not echo raw internal exception text back to clients.
- [x] Orchestrator cleanup paths must log stop/remove failures instead of using empty `catch {}` blocks.
- [x] Gateway JWT verification must pin allowed algorithms.
- [x] Gateway auth must treat JWT validation failure as terminal when a JWT-looking bearer token is presented and JWT auth is configured.
- [x] Gateway sync user identity must fail closed when auth is enabled and neither JWT claims nor `MATRIX_HANDLE` is available.
- [x] Platform admin rate-limit eviction must refresh hot keys instead of pure FIFO eviction.
- [x] Device-flow approval polling must consume the approved device code before awaiting token issuance.
- [x] Platform port allocation must reserve ports transactionally to avoid duplicate allocations under concurrent provision calls.
- [x] Orchestrator `provision()` must release reserved ports and remove partially started containers on failure.
- [x] `/containers/provision`, `/containers/:handle/self-upgrade`, and `/social/send/:handle` must enforce `bodyLimit`.

## Sync Client Follow-up Review Wave

- [x] Daemon remote `sync:change` download writes must reject path traversal outside the sync root.
- [x] Daemon remote `sync:change` delete handling must reject path traversal outside the sync root.
- [x] Daemon initial pull must reject path traversal outside the sync root.
- [x] Daemon pid file acquisition must use exclusive create semantics and reject a live competing process.
- [x] Daemon pause/resume IPC must persist `pauseSync` to config.
- [x] Daemon local delete handling must not silently swallow unlink failures.
- [x] Manifest cache writes must use temp-file + rename atomic persistence.
- [x] launchd plist generation must XML-escape interpolated paths.
- [x] Daemon liveness probing must connect to the IPC socket instead of checking path existence only.
- [x] WebSocket client malformed-message handling must report the parse failure instead of empty-catching it.
- [x] Auth token-store writes must create the file with `0o600` permissions immediately.

## Latest Gateway Follow-up Wave

- [x] Gateway WebSocket peer lifecycle wiring must hold a real socket reference in scope instead of closing over an undefined `ws`.
- [x] Manifest reads must support AWS SDK stream bodies that expose `transformToString()` instead of assuming `.text()`.
- [x] HTTP file writes in request handlers must use async `fs/promises`, not `mkdirSync` / `writeFileSync`.
- [x] Commit-time blob cleanup failures after manifest persistence must log and continue instead of surfacing a partial-success error.
- [x] Home-mirror initial pull must skip tombstoned manifest entries instead of resurrecting deleted files.
- [x] Home-mirror uploads must hash the exact bytes they send to R2, not hash before the queued read/upload path.
- [x] Home-mirror local-write suppression must cover large initial pulls instead of evicting entries after 1000 files.
- [x] Home-mirror local push/delete manifest updates must use the same advisory lock discipline as HTTP commits.
- [x] Device-flow approval must run under a transaction and reject re-approval by a different user.
- [x] Home-mirror serial commit queue must log task failures instead of silently swallowing them.
- [x] Sync-client daemon serial commit queue must report task failures instead of silently swallowing them.
- [x] Presign route must classify validation failures with a typed error instead of matching strings in `err.message`.

## Verification Notes

- [x] Targeted sync/gateway regression suite passes locally: `tests/gateway/sync/r2-client.test.ts`, `home-mirror.test.ts`, `sharing.test.ts`, `commit.test.ts`, `routes.test.ts`, `metrics.test.ts`, `ws-events.test.ts`, `ws-peer-lifecycle.test.ts` (`8 files`, `100 tests`).
- [x] Second-wave gateway/sync-client regression suite passes locally: `tests/gateway/sync/commit.test.ts`, `routes.test.ts`, `home-mirror.test.ts`, `sharing.test.ts`, `peer-id.test.ts`, `packages/sync-client/tests/unit/oauth.test.ts`, `ipc-server.test.ts` (`5 files`, `76 tests`).
- [x] Docker dev-container verification passes for `tests/platform/api.test.ts`, `tests/platform/device-routes.test.ts`, `tests/platform/sync-jwt.test.ts`, `tests/platform/proxy-routing.test.ts`, and `tests/gateway/auth-jwt.test.ts` (`5 files`, `44 tests`).
- [x] Docker dev-container verification passes for the latest platform follow-up fixes: `tests/platform/api.test.ts`, `tests/platform/orchestrator.test.ts` (`2 files`, `34 tests`).
- [x] Root-level JWT tests no longer rely on hoisted `jose` resolution from `/app/node_modules`; the HS256 negative-case tokens are generated with `node:crypto` inside the tests.
- [x] Latest gateway identity regression passes locally: `tests/gateway/sync/user-id-from-jwt.test.ts` (`1 file`, `9 tests`).
- [x] Latest sync-client regression suite passes locally via package config: `tests/unit/manifest-cache.test.ts`, `daemon-runtime-guards.test.ts`, `daemon-client.test.ts`, `service.test.ts`, `token-store.test.ts`, `ws-client.test.ts` (`6 files`, `30 tests`).
- [x] Latest platform route-validation regression passes in Docker dev container: `tests/platform/api.test.ts` (`1 file`, `18 tests`).
- [x] Latest gateway blocker regression passes locally: `tests/gateway/sync/manifest.test.ts`, `commit.test.ts`, `ws-peer-lifecycle.test.ts` (`3 files`, `29 tests`).
- [x] Latest platform blocker regression passes in Docker dev container: `tests/platform/api.test.ts`, `orchestrator.test.ts`, `device-flow.test.ts`, `db.test.ts` (`4 files`, `71 tests`).
- [x] Host-side `tests/platform/db.test.ts` remains non-signal in this worktree because the local `better-sqlite3` native module is built for a different Node ABI; Docker dev-container results are authoritative for that suite.
- [x] Latest home-mirror regression passes locally: `tests/gateway/sync/home-mirror.test.ts` (`1 file`, `13 tests`).
- [x] Shell theme regression passes locally: `tests/shell/useTheme.test.ts`, `theme-presets.test.ts` (`2 files`, `39 tests`).
- [ ] Local Playwright verification for `shell/e2e/screenshots.spec.ts` is currently blocked on this machine because the Chromium test binary is not installed (`pnpm exec playwright install` required). CI remains the source of truth for the screenshot path.
- [x] Latest presign/routes/home-mirror regression passes locally: `tests/gateway/sync/presign.test.ts`, `routes.test.ts`, `home-mirror.test.ts` (`3 files`, `56 tests`).
- [x] Latest sync-client queue guard regression passes locally: `packages/sync-client/tests/unit/daemon-runtime-guards.test.ts` (`1 file`, `7 tests`).
- [x] Latest device-flow regression passes in Docker dev container: `tests/platform/device-flow.test.ts` (`1 file`, `20 tests`).

## Lower-Priority Follow-ups From Review

- [ ] Review whether sync route error payloads leak internal details and tighten where needed.
- [x] Review token-store file permissions for create-time mode safety.
- [ ] Review home-mirror default ignores for obvious secret material.
- [ ] Review whether orchestrator `provision()` / `destroy()` DB-write sequences should be bundled more transactionally.
- [ ] Review manifest R2-vs-DB metadata ordering if DB upsert fails after an R2 manifest write.
- [ ] Review share-listing query shape for avoidable N+1 behavior.
- [ ] Review JWT lifetime / revocation strategy in platform-issued sync tokens.

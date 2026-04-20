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
- [x] Device-flow rate limiting must stop trusting spoofable `X-Forwarded-For`.
- [x] Platform proxy fetches must use `AbortSignal.timeout(...)`.
- [x] Platform admin/container routes must not echo raw internal exception text back to clients.
- [x] Orchestrator cleanup paths must log stop/remove failures instead of using empty `catch {}` blocks.
- [x] Gateway JWT verification must pin allowed algorithms.
- [x] Gateway auth must treat JWT validation failure as terminal when a JWT-looking bearer token is presented and JWT auth is configured.

## Verification Notes

- [x] Targeted sync/gateway regression suite passes locally: `tests/gateway/sync/r2-client.test.ts`, `home-mirror.test.ts`, `sharing.test.ts`, `commit.test.ts`, `routes.test.ts`, `metrics.test.ts`, `ws-events.test.ts`, `ws-peer-lifecycle.test.ts` (`8 files`, `100 tests`).
- [x] Second-wave gateway/sync-client regression suite passes locally: `tests/gateway/sync/commit.test.ts`, `routes.test.ts`, `home-mirror.test.ts`, `sharing.test.ts`, `peer-id.test.ts`, `packages/sync-client/tests/unit/oauth.test.ts`, `ipc-server.test.ts` (`5 files`, `76 tests`).
- [x] Docker dev-container verification passes for `tests/platform/api.test.ts`, `tests/platform/device-routes.test.ts`, `tests/platform/sync-jwt.test.ts`, `tests/platform/proxy-routing.test.ts`, and `tests/gateway/auth-jwt.test.ts` (`5 files`, `44 tests`).
- [x] Docker dev-container verification passes for the latest platform follow-up fixes: `tests/platform/api.test.ts`, `tests/platform/orchestrator.test.ts` (`2 files`, `34 tests`).
- [x] Root-level JWT tests no longer rely on hoisted `jose` resolution from `/app/node_modules`; the HS256 negative-case tokens are generated with `node:crypto` inside the tests.

## Lower-Priority Follow-ups From Review

- [ ] Review whether sync route error payloads leak internal details and tighten where needed.
- [ ] Review token-store file permissions for create-time mode safety.
- [ ] Review home-mirror default ignores for obvious secret material.
- [ ] Review whether orchestrator `provision()` / `destroy()` DB-write sequences should be bundled more transactionally.
- [ ] Review manifest R2-vs-DB metadata ordering if DB upsert fails after an R2 manifest write.
- [ ] Review share-listing query shape for avoidable N+1 behavior.
- [ ] Review JWT lifetime / revocation strategy in platform-issued sync tokens.

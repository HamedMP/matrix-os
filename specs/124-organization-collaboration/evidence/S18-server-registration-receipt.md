# S18 receipt — owner collaboration registration extraction

**Packet:** S18 / issue #1799. **Date:** 2026-09-21. **Branch:** `124/s18-server-extraction`. **Base:** `a5eaec1b5`. **Test commit:** `41f51a192`. **Refactor commit:** `936055512`.

The integrated base already initialized owner database services through `startup/owner-database.ts` and constructed the collaboration runtime through `startup/collaboration.ts`. This layer completes the remaining registration extraction: the same ready/fail-closed route choice now lives in `registerOwnerCollaborationRoutes`, and the existing shared AI enablement call now lives in `enableOwnerSharedAi`. Both calls remain at the original startup positions. `server.ts` is 1,875 lines after this layer. This is a behavior-preserving refactor; the separate production shared-terminal enablement correction is tracked in a later commit.

## RED → GREEN

- RED: `pnpm exec vitest run tests/gateway/collaboration-startup-registration.test.ts --maxWorkers=2` — 3 failed/3 tests. The three failures were missing `registerOwnerCollaborationRoutes` and `enableOwnerSharedAi` exports.
- GREEN: `pnpm exec vitest run tests/gateway/collaboration-startup-registration.test.ts tests/gateway/owner-database-startup.test.ts --maxWorkers=2` — 2 files, 6/6 passed. Ready registration forwards the exact Hono app and WebSocket upgrader; owner database failure mounts 503 HTTP/WS routes; shared AI receives the canonical inputs once and skips a missing runtime.
- `pnpm --filter @matrix-os/gateway exec tsc --noEmit -p tsconfig.json` — exit 0.
- `/home/nima/.bun/bin/bun run check:patterns` — exit 0, zero violations and five existing warnings.
- `git diff --check` — clean before refactor commit.

No migration, PostgreSQL write, host probe, or provider call is part of this extraction. The existing `owner-database-startup.test.ts` exercises injected failure after Chat handoff and verifies reverse-order cleanup plus fail-closed routes. This layer did not run a live owner startup or claim Web Canvas, Web Desktop, or Electron Desktop evidence.

## Invariants and gates

- **Source of truth:** owner Postgres and canonical Chat remain unchanged.
- **Lock/transaction scope:** no database operation moved across a transaction boundary.
- **Acceptable orphan states:** none introduced.
- **Auth source of truth:** existing collaboration route registration and fail-closed middleware are called unchanged.
- **Remaining:** integrate above the corrected S18 ancestry, validate with T090 route retirement, obtain current-head review and CI. No push, merge, or deployment was performed here.

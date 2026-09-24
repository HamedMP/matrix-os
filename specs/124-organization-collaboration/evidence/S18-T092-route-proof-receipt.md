# S18 / T092 route-boundary proof receipt

**Date:** 2026-09-21. **Base:** disposable corrected-ancestry probe `8f573b8a6`. **Branch:** `124/s18-t092-proof`. **RED test commit:** `ee8fc959a`. **GREEN fix commit:** `20cd64fd1`. Local commits only; no push, PR, merge or deployment.

## Scope and invariants

- `tests/platform/collaboration-two-home-relay-postgres.test.ts` exercises two distinct Hono owner-home route apps backed by separate real-Postgres schemas, with the platform `CollaborationRelay` forwarding exact HTTP bytes to each app. It is a local two-home simulation, not two installed computers.
- Each owner home admits its own valid direct ticket and rejects a forged platform signature, expired ticket, wrong authority generation and ticket addressed to the other home. A signed protocol V1 ticket and an explicit top-level V1 request receive `426 upgrade_required`; `DirectSessionService` now checks both version locations before ordinary schema validation.
- The relay strips stale `x-matrix-collaboration-proof`. A proof-only owner-runtime request is rejected with 401 by the owner route. An old home without the direct-session route returns 404; the relay does not try that home's unrelated legacy route. Existing legacy serving routes were not removed.
- Test transport compares every forwarded body byte with its original JSON bytes and checks metadata lacks signed ticket, possession key, proof and payload. The relay source forwards opaque bodies, emits only bounded metadata, and logs error class names. This test does not prove the behavior of a deployed TLS relay or every future logger.
- No migration, data write outside isolated fixtures, cutover journal or rollback state changed. There is no dual-writer claim from this route test.

## RED → GREEN

| Gate | Observed result |
| --- | --- |
| RED `set -a; source /tmp/matrix-os-124-postgres.env; set +a; pnpm exec vitest run tests/platform/collaboration-two-home-relay-postgres.test.ts --maxWorkers=2` | 1 failed: explicit top-level `protocolVersion: 1` returned 401 instead of expected 426. Valid two-home routing and the preceding negative signed-ticket assertions reached their expected results. |
| GREEN, same real-Postgres command after fix | 1 file, 1/1 passed, 8.08 s. After adding the stale V1 proof-only owner-runtime assertion, the same command again passed 1/1, 8.14 s. |
| Adjacent `pnpm exec vitest run tests/platform/collaboration-relay.test.ts tests/gateway/collaboration-direct-sessions.test.ts --maxWorkers=2` | 2 files, 23/23 passed, 33.18 s. |
| Static gates | Gateway `pnpm exec tsc --noEmit -p packages/gateway/tsconfig.json`: exit 0. Platform `pnpm --filter @matrix-os/platform exec tsc --noEmit -p tsconfig.typecheck.json`: exit 0. `/home/nima/.bun/bin/bun run check:patterns`: 0 violations, 5 existing warnings. `git diff --check`: exit 0. |

## Remaining release gates

- T092's installed two-computer journey, multiple members/one owner source, shared group Chat, member commit/push/PR under owner identity, root inventory, dirty worktrees, network partition, TLS relay and live old-client/old-home compatibility remain **unrun** here. No production or provider probe was performed.
- This branch predates the separately committed S19 relay streamed-byte accounting fix and the later direct-owner route correction. Both must be included in final ancestry and retested together; this receipt does not claim that integration.
- Existing CLI collaboration uses legacy serving routes. Its direct-protocol compatibility migration is separately in progress; legacy route removal remains gated on that coverage. The local old-home 404 is a fail-closed direct-route result, not proof of CLI continuity.
- No live cutover or rollback was exercised. The S18 journal and compatible-direct rollback evidence are in their separate receipts; release approval still requires the runbook's live-host proof.

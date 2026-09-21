# S08 receipt — single owner source and run funding (T040–T044)

**Branch:** `124/s08` (parent `124/s05`, restacked once onto S05 @ 71818cc83 with S03 @ 1d4b09a42 and S04 @ f2e196f72 underneath; a second restack onto the final S20/S02/S03/S04 tips is pending the coordinator's go). **Base at start:** 124/s05 @ 6c4c06e19 (= S04 tip at the time).

| Commit | Content |
| --- | --- |
| `b9fa6eabd` | T040 RED: `tests/gateway/collaboration-owner-source.test.ts` (module not found) |
| `16785c5a5` | T041–T043: execution policy, account eligibility, run bindings, execution-policy routes, gateway migration 10, S01 characterization updates |
| `43d23a80e` | T044 + wiring: shared-run owner source, `shared-ai-runtime.ts` hunks, `wiring.ts` construction, wiring test |
| (this commit) | receipt |

## Changed files

- New: `packages/gateway/src/collaboration/{execution-policy,account-eligibility,run-account-binding,execution-policy-routes,shared-run-owner-source}.ts`
- Edited: `database.ts` (two table types), `database-migrations.ts` (version 10 registered; 9 reserved for S05), `routes.ts` (registrar composed after the baseline), `route-support.ts` (`executionPolicies?` option), `shared-ai-runtime.ts` (see hunks), `wiring.ts` (options `providerSnapshotReader?`, `organizationAiSubmission?`; constructs eligibility/policies/bindings/owner source; passes `ownerSource` to the runtime and `executionPolicies` to the routes; returns `executionPolicies`, `runBindings`, `ownerSource`)
- Tests: `tests/gateway/collaboration-owner-source.test.ts` (36), `collaboration-foundation.test.ts` (route baseline + migration lists include the two S08 routes and version 10), `collaboration-wiring.test.ts` (migration list 1–8, 10; S08 wiring test)

### `shared-ai-runtime.ts` hunks (additive, #1765 also edits this file)

1. Import: `import type { SharedRunOwnerSource } from "./shared-run-owner-source.js";`
2. `createSharedAiRuntime` options: `ownerSource?: SharedRunOwnerSource;` after `resolveAccessSource?`.
3. Dispatch callback, just before `providerIdentity`: `const ownerDecision = options.ownerSource ? await options.ownerSource.prepare({ scopeId, chatId, ownerId: context.ownerId, requestingActorId: execution.requestingActorId, driverKind: execution.driverKind }) : null;` and the Claude identity now uses `accessSourceId: ownerDecision?.accessSourceId ?? await resolveAccessSource()`.

## Observed results

- RED (`b9fa6eabd`): `Cannot find module '../../packages/gateway/src/collaboration/account-eligibility.js'`.
- GREEN: `pnpm exec vitest run tests/gateway/collaboration-owner-source.test.ts` → 36/36 on PGlite and 36/36 with `MATRIX_TEST_POSTGRES_URL`/`CHAT_TEST_DATABASE_URL` → `matrixos_test_124` (real PostgreSQL 16).
- Regression: `shared-ai-runtime`, `collaboration-chat-scope`, `collaboration-routes`, `collaboration-wiring`, `collaboration-foundation`, `collaboration-org-precondition`, `collaboration-authority`, `collaboration-readiness` → 7 files / 84 tests pass (one listed file has no tests). `collaboration-capabilities-postgres` (S04) → 27/28 on PGlite: "serializes concurrent accepts of different grants on one scope on the scope lock" fails identically on the parent commit 71818cc83 without S08 changes (PGlite single-connection race), so it is pre-existing here, not S08's.
- `bun run typecheck` → exit 0 (all packages). `./scripts/review/check-patterns.sh` → 0 violations (5 pre-existing warnings). `git diff --check` clean. Full `bun run test` not run (shared-host load rule); CI covers it after retarget.

## Migration

Gateway `COLLABORATION_VERSIONED_MIGRATIONS` gains `{ version: 10, run: migrateExecutionPoliciesV10 }` (tables `collaboration_execution_policies`, `collaboration_run_bindings`, index on bindings by scope; records version 10). Version 9 is reserved for S05; if S05 lands 9 after this, the list must stay ordered 8, 9, 10. Rollback: drop both tables; no existing rows are affected on customer VPSes (no policy exists until an owner sets one).

## Seams and open gates

- **Organization AI submission projection**: `OrganizationAiSubmissionSource.resolve(organizationId)` (`execution-policy.ts`) defaults to `unknown` → owner-only. S03's internal membership assertion does not carry `collaboration.aiSubmission`; the platform needs to expose it (or extend the assertion frame) and gateway wiring must pass it as `organizationAiSubmission`. Until then member submission is owner-only by construction (fail-closed, spec-conformant).
- **Provider snapshot reader**: `createGatewayCollaboration({ providerSnapshotReader })` must receive the gateway's `CanonicalProviderSnapshotReader` (server.ts owns that wiring; coordinator patch).
- **Run binding admission**: the shared dispatch context (`ClaimedQueuedTurn.sharedExecution`) has no run id, request id or execution root, so `runBindings.admit(...)` is exposed on `ownerSource.bindings` for S09 T047/T048 to call from the coordinator with `runId`, `requestId`, `executionRoot`, `rootFingerprint`, `audienceGeneration`, `expectedPolicyRevision`. `CollaborationRunBindingRepository.list/get` serve the S15 run-queue attribution.
- **Readiness**: `createOwnerSourceReadinessProbes({ policies, eligibility })` supplies `aiSource`/`submitMode` to S04's `evaluateCollaborationReadiness`; S10 supplies Git identity/forge/inventory.
- No PR opened yet: coordinator asked to hold submission until S05's new head is known (restack pending).

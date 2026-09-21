# S04 receipt — whole-project presets and readiness (T020–T024)

**Branch:** `124/s04` (parent `124/s02` @ `762c76bb2`, which contains main `fb8b21346`). Worktree `/home/nima/matrix-os-124-s04`.

| Task | Status | Evidence |
| --- | --- | --- |
| T020 | done | `tests/gateway/collaboration-capabilities-postgres.test.ts` — RED at `1d6135174` (module not found), GREEN 28/28 on PGlite and on real PostgreSQL (`MATRIX_TEST_POSTGRES_URL`, database `matrixos_test_124`) |
| T021 | done | `capability-repository.ts`, `capability-records.ts`, `capability-evaluator.ts`, `policy-migrations.ts` (gateway migration 8: `collaboration_grants`, `collaboration_grant_activations`), `authority.ts` grant→role hook |
| T022 | deferred | Chat audience ceilings and publication policy stay out of V1 (spec) |
| T023 | done | `readiness-evaluator.ts` over injected probes; validated against `CollaborationReadinessSchema` |
| T024 | done | grant mutations: scope + grant `FOR UPDATE`, `WHERE revision = expected`, replay by client request id + payload hash, audit + directory outbox + operation in one transaction; lookup failure → `unavailable`; no permissive fallback |

## Migration

- Version **8** appended to `COLLABORATION_VERSIONED_MIGRATIONS` (S20 uses 7). Additive only: two new tables and four indexes; no existing column changes. Rollback: drop the two tables (no other table references them).
- Legacy `collaboration_members` rows are never auto-converted; `dispositionLegacyMembers` is the explicit owner/S18 conversion and records the exact old ceiling.

## Gates observed on `124/s04`

- `pnpm exec vitest run tests/gateway/collaboration-capabilities-postgres.test.ts` → 28 passed (PGlite) and 28 passed (real PostgreSQL).
- Neighbouring suites (`collaboration-foundation`, `collaboration-org-precondition`, `collaboration-repository-postgres`, `collaboration-membership-races`, `collaboration-chat-discussion-postgres`, `collaboration-authority`, `collaboration-routes`) → pass. `collaboration-chat-scope-postgres` › "does not strand a scope when activation races capability reconciliation" fails identically with this packet stashed: pre-existing on the parent branch, not introduced here.
- `bun run check:patterns` → 0 violations (5 pre-existing warnings).
- `bun run typecheck` → every package clean except `desktop`, which fails on the S20 layer-3 files `DesktopProjectSharing.tsx` / `DesktopTerminalSharing.tsx` (missing `organizationId` prop; owned by S20, already reported to the coordinator). Gateway `tsc --noEmit` clean.
- Full `bun run test` not run on this host (load rule); CI covers it after retarget to `main`.

## Ownership for later packets

- S12/S15 mount the grant routes (`/scopes/:scopeId/grants*`, invitation accept/decline for organization shares) on `CollaborationCapabilityEvaluator`; `listPendingForActor` backs `Shared with me`.
- S08 supplies `aiSource` / `submitMode` probes, S10 supplies `gitIdentity` / `forgeCredential` / `chatRootInventory`, transport supplies `hostOnline`.
- S18 executes `dispositionLegacyMembers` as part of the recorded disposition.

## Review fixes (2026-09-21)

- **F5 departure cleanup (P2), S04 part.** `endActorGrants` (transactional per scope with the scope row locked; revokes member grants and deletes activations of organization-wide grants) was implemented here but called from nowhere; the S05 gateway control client now calls it on a pushed denial (see the S05 receipt). This layer adds the membership-cache half: RED `50ef4e5b1` (`evict is not a function`), GREEN `ab36fb67f`: `OrganizationMembershipClient.evict({ organizationId, actorId? })` drops cached evidence for one actor or for every actor of an organization, and marks in-flight lookups so their result is delivered but never cached (bounded by the in-flight cap). `organization-membership-client.ts` lives on `124/s03-gateway`; the change is committed on `124/s04` for the coordinator to move down if wanted.
- Gates: `organization-membership-client` + `collaboration-org-precondition` + `collaboration-precondition-unavailable` + `collaboration-membership-races` → 26 passed / 4 skipped; gateway `tsc` clean; full `bun run typecheck` exit 0; patterns 0 violations / 5 inherited warnings.

# S18 receipt — reject revived legacy roles after direct cutover

**Packet:** S18 / T091 partial. **Date:** 2026-09-21. **Branch:** `124/s18-secondary-reader`, based on the corrected pre-T090 integration head `e5392e052`. **Code head:** `f8d3fb131`. This is a local, unpushed child until the release ancestry is final.

## RED → GREEN

- A new real-Postgres test inserted an accepted non-owner legacy member after direct activation. `CollaborationAuthority.authorize(read)` incorrectly returned an editor context; the test failed before the fix.
- A second real-Postgres test exercised the locked shared Chat transaction fence with a current-generation context. `fenceSharedChatAuthority(request_ai)` incorrectly returned `editor`; the test failed before the fix.
- Both paths now consult the durable cutover journal before honoring a non-owner legacy row. Active, compatible-rolled-back, and blocked cutovers retire that row as an authority source; owner access remains anchored to the owner row. Direct grants remain the V1 non-owner authority after activation.
- `tests/gateway/collaboration-cutover-postgres.test.ts` and `tests/gateway/collaboration-authority.test.ts` passed **21/21** against the real test Postgres. A focused rerun of the first regression, extended to verify denial after compatible rollback, passed **1/1**. Gateway `tsc --noEmit` passed. `bun run check:patterns:diff` reported **0 violations and 4 warnings** on the inherited branch. `git diff --check` passed.

## Invariants and limits

- **Source of truth:** before cutover, accepted legacy members may authorize; after activation, the owner-home cutover journal determines that non-owner access comes from direct grants. A newly inserted or revived old row cannot bypass the migrated ceiling.
- **Lock/transaction scope:** shared Chat rechecks the journal inside its existing scope-locked transaction. The ordinary authority path reads the same durable journal; no write transaction changed.
- **Acceptable orphan states:** old rows remain retained for audit and rollback proof, but cannot grant access after direct activation. Compatible rollback keeps the direct generation and the same denial rule.
- **Auth source of truth:** the organization precondition still runs before any authorization; this change only removes the stale legacy allow path.
- **Deferred scope:** T090 platform proxy retirement, live owner-host cutover and rollback, full T091 secondary-reader audit, and S19 final acceptance remain open. No live host or credential probe was run.

This branch is below the 3,000-addition/50-file review limits. Current-head Greptile and CI remain unrun until it is restacked and submitted as a release PR.

# S15 directory grant pointer appendix

**Packet:** S15, organization pending discovery seam for T075/T076. **Date:** 2026-09-21. **Base:** `124/s15-gateway` `e68fe3a9f`. **Branch:** `124/s15-directory`. **Head:** recorded in the branch after the test, feature, and receipt commits.

## Behavior and ownership

The owner outbox claim transaction selects the active, unexpired organization grant for the scope and its organization. It sends only that grant's UUID as `organizationGrantId`, alongside the existing content-free directory metadata. Revoked and expired grants produce no organization audience. The platform's locked directory migration adds a nullable UUID pointer; the directory event transaction stores or clears it with the metadata revision. Pending discovery requires the pointer and the actor's current organization membership, then exposes it as `grantId` for the explicit home accept call. The pointer is opaque directory metadata; the home grant and membership checks remain the authorization source.

Changed paths: `packages/gateway/src/collaboration/directory-outbox.ts`; `packages/platform/src/collaboration/{database,repository,routes}.ts`; `tests/gateway/collaboration-directory-outbox.test.ts`; `tests/platform/{collaboration-repository,collaboration-routes}.test.ts`; this receipt.

## RED → GREEN

With tests committed before implementation, the focused real-Postgres run failed as expected: owner event `organizationGrantId` was `undefined`; the platform repository returned a pending entry without `grantId`; the discovery route returned 503 after its required pending schema rejected the entry. A first version of the expired-grant fixture also hit the intentional one-active-organization-grant unique index; the fixture was corrected to exercise one expired active grant and one revoked grant.

Final command: source the private test env, then `pnpm exec vitest run tests/gateway/collaboration-directory-outbox.test.ts tests/platform/collaboration-repository.test.ts tests/platform/collaboration-routes.test.ts --maxWorkers=2`. **3 files, 23/23 passed on real Postgres.** This covers live versus expired/revoked owner grants, opaque pointer delivery, authenticated member-only pending discovery, exclusion of an audience-only legacy row, stale revision rejection, revocation clearing, historical directory migration, and concurrent revision projection. The Postgres fixtures used isolated temporary schemas in the dedicated `matrixos_test_124` database; no provider or live host probe was run.

`bun run check:patterns`: 0 violations, 5 existing repository warnings. `bun run typecheck`: exit 0 across the full repository. The new worktree initially lacked `desktop/node_modules`, causing an unrelated Vite 6/7 type mismatch; copying the existing worktree's dependency links restored the installed graph and the full rerun passed. No React files changed.

## Migration and rollback

The migration was exercised against a table with the new column removed and then rerun under the platform migration lock; projection succeeded after upgrade. The migration is additive and nullable. A down migration and rollback deployment were not run. Older directory events without a grant pointer remain valid but cannot produce `organization_pending` entries.

## Gates

This child layer must be reparented onto the coordinator's current `124/s15-gateway` head before submission. The owner needs to verify the home activation route consumes `grantId` with fresh grant and membership checks; directory results alone do not authorize a join. Authenticated Web Canvas, Web Desktop, and Electron journeys remain in the S15 surface packet.

# S18 receipt — retire the secondary sync share authorization reader

**Packet:** S18 / T091 partial. **Date:** 2026-09-21. **Branch:** `124/s18-secondary-reader`, based on corrected pre-T090 S18 integration head `e5392e052`. **Scope:** remove the unused `SharingService.checkSharePermission` API, its Kysely `listSharesByGranteeAndOwner` lookup, and obsolete permission-matrix code. Keep personal sync share creation, acceptance, revocation and listing as separate non-collaboration operations under T063's V1 limitation.

## RED → GREEN

- New public-surface regression test `SharingService > exposes only personal sync grant management, not a secondary file authorization reader` failed before implementation: `Object.keys(service)` contained `checkSharePermission` beyond the four grant-management methods (1 failed, 25 skipped).
- After implementation, `tests/gateway/sync/sharing.test.ts`, `routes.test.ts`, and `user-id-from-jwt.test.ts` passed **82/82**. The remaining grant-management and HTTP route tests cover the personal sync behavior that this layer retains.
- Gateway `tsc --noEmit` passed after building the kernel prerequisite. `bun run check:patterns` reported 0 violations and 5 existing warnings. `git diff --check` passed. No migration, race, lease or transaction changed, so no real-Postgres run was needed for this narrow API removal.

## Invariants

- **Source of truth:** personal sync grants remain in the owner's `sync_shares` table; organization collaboration authorization remains the owner-home collaboration grant/evaluator path. The removed reader was not called by production routes before this change, and it can no longer be called through the sync sharing service.
- **Lock/transaction scope:** unchanged for personal sync grant writes; no transaction or lock moved.
- **Acceptable orphan states:** none introduced. Existing personal sync grants remain intact and listable.
- **Auth source of truth:** collaboration resource reads cannot use the removed sync share permission service as a secondary allow decision. Personal sync HTTP authentication and grant-management routes are unchanged.
- **Deferred scope:** S11 direct-capable connector delegation/custody and T063 shared sync transfer/CLI mounts are deferred; this layer does not migrate or delete the owner's existing integration connections or personal sync grants. T102's live sync-grant inventory/disposition evidence, T090 legacy collaboration proxy retirement, and T091 audit of any other secondary readers remain open.

This branch is local and unpushed until S18 ancestry is final. Current-head Greptile, CI, live owner-host migration and release approval remain unrun.
